// Pure transport layer for the Docker Engine API.
//
// It deliberately DUCK-TYPES the small transport surface that BaseConnector
// consumes (statusCurrent / start / stop / shutdown / reboot / agentExec /
// agentExecStatus / agentFileRead / agentFileWrite) and returns the SAME payload
// shapes (a qemu-status-shaped status object), so every connector, profile,
// config and RCON path works unchanged with a container locator in the `vmid`
// argument position.
//
// It knows nothing about games or Fastify, takes an injectable `fetchImpl` for
// tests, and reaches the engine over the scoped socket-proxy
// (DOCKER_HOST=tcp://docker-proxy:2375) — never the raw /var/run/docker.sock.

import { Agent } from 'undici';

export class DockerError extends Error {
  constructor(message, { status, code, cause } = {}) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
    if (code) this.code = code;
    if (cause) this.cause = cause;
  }
}

const MAX_OUTPUT = 1_000_000; // cap captured stdout/stderr, mirroring the agent's truncation
const EXEC_RESULTS_CAP = 256; // bound the stashed-exec-result map (evict oldest on overflow)

export class DockerClient {
  /**
   * @param {object} opts
   * @param {string} opts.host       DOCKER_HOST, e.g. "tcp://docker-proxy:2375"
   *                                  (also accepts http(s)://… or unix:///path)
   * @param {string} [opts.apiVersion]  pin the Engine API version, e.g. "1.45"
   * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
   */
  constructor({ host, apiVersion, fetchImpl } = {}) {
    if (!host) throw new Error('DockerClient: host is required');

    const { base, socketPath } = parseHost(host);
    this.base = base + (apiVersion ? `/v${apiVersion}` : '');
    this.fetch = fetchImpl ?? globalThis.fetch;

    // Unix-socket engines need a dispatcher with a socketPath; the tcp proxy and
    // tests (fetchImpl) don't. Scoped to this client, never global.
    this.dispatcher = (socketPath && !fetchImpl)
      ? new Agent({ connect: { socketPath } })
      : undefined;

    // agentExec runs to completion and stashes the result here under a synthetic
    // pid (the exec id); agentExecStatus then returns it as already-exited.
    //
    // Reads are NON-destructive (idempotent): a repeat poll for the same pid —
    // which the normal single-poll runCommand loop never does, but a retry or a
    // future caller might — returns the SAME real result instead of a misleading
    // unknown-pid failure. To stop the map growing without bound when a pid is
    // never read (e.g. a command that times out before its first poll), insertion
    // evicts the oldest entries past EXEC_RESULTS_CAP (Map preserves insertion
    // order, so the first key is the oldest).
    this.execResults = new Map();
  }

  // ── low-level request ───────────────────────────────────────────────────────
  // The one engine round-trip. `body` (if set) is JSON-encoded; `raw:true` returns
  // the response as a Uint8Array (the demux'd exec attach stream) instead of parsed
  // JSON. A timeout `signal` aborts the request, and EACH await that can observe the
  // abort (the fetch, plus the body read — arrayBuffer/text — which can resolve after
  // the fetch but still get cancelled mid-stream) maps the abort to a DockerError with
  // code DOCKER_TIMEOUT; any other failure (including a non-abort body-read fault like
  // a mid-stream socket reset) becomes a generic DockerError so routes map it to 502
  // rather than a 500, and a non-2xx status throws with the engine's `message` (or the
  // raw body / status text) as the detail — see errorDetail.
  async #request(method, path, { body, raw = false, signal } = {}) {
    const headers = { Accept: raw ? 'application/vnd.docker.raw-stream' : 'application/json' };
    const init = { method, headers };
    if (signal) init.signal = signal;
    if (this.dispatcher) init.dispatcher = this.dispatcher;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await this.fetch(`${this.base}${path}`, init);
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        throw new DockerError(`docker ${method} ${path} timed out`, { code: 'DOCKER_TIMEOUT', cause: err });
      }
      throw new DockerError(`docker request failed: ${err.message}`, { cause: err });
    }

    if (raw) {
      let buf;
      try {
        buf = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') {
          throw new DockerError(`docker ${method} ${path} timed out`, { code: 'DOCKER_TIMEOUT', cause: err });
        }
        // A mid-stream read failure (e.g. a socket reset) is an upstream-engine
        // fault, not a 500 — wrap it as a DockerError so routes map it to 502.
        throw new DockerError(`docker ${method} ${path} body read failed: ${err.message}`, { cause: err });
      }
      if (!res.ok) {
        // The error body was already read into `buf` — decode it so the engine's
        // detail (e.g. "No such container") survives, matching the JSON branch.
        const text = Buffer.from(buf).toString('utf8');
        throw new DockerError(`docker ${method} ${path} -> ${res.status}: ${errorDetail(text, res.statusText)}`, { status: res.status });
      }
      return buf;
    }

    let text;
    try {
      text = await res.text();
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        throw new DockerError(`docker ${method} ${path} timed out`, { code: 'DOCKER_TIMEOUT', cause: err });
      }
      // As in the raw branch: a body-read failure is an upstream fault → 502.
      throw new DockerError(`docker ${method} ${path} body read failed: ${err.message}`, { cause: err });
    }
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { /* non-JSON body */ } }

    if (!res.ok) {
      throw new DockerError(`docker ${method} ${path} -> ${res.status}: ${errorDetail(text, res.statusText)}`, { status: res.status });
    }
    return parsed;
  }

  #c(container, suffix = '') {
    return `/containers/${encodeURIComponent(container)}${suffix}`;
  }

  // ── status ──────────────────────────────────────────────────────────────────
  // Returns the qemu-shaped payload normalizeStatus() expects:
  //   { status: 'running'|'stopped', uptime, cpu, mem, maxmem }
  async statusCurrent(container, { stats = true } = {}) {
    const info = await this.#request('GET', this.#c(container, '/json'));
    const running = Boolean(info?.State?.Running);
    const startedAt = info?.State?.StartedAt;
    const uptime = running && startedAt ? secondsSince(startedAt) : 0;

    // cpu/mem are best-effort: a single stats sample is comparatively slow and
    // non-essential (normalizeStatus defaults them to null), so never let it fail
    // the status call.
    let cpu = null, mem = null, maxmem = info?.HostConfig?.Memory || null;
    if (stats) {
      try {
        const s = await this.#request('GET', this.#c(container, '/stats?stream=false'));
        mem = s?.memory_stats?.usage ?? mem;
        maxmem = s?.memory_stats?.limit ?? maxmem;
        cpu = cpuFraction(s);
      } catch { /* stats unavailable — leave nulls */ }
    }

    return { status: running ? 'running' : 'stopped', uptime, cpu, mem, maxmem };
  }

  // ── power ───────────────────────────────────────────────────────────────────
  start(container)    { return this.#power(container, '/start',   [304]); }
  shutdown(container) { return this.#power(container, '/stop',    [304]); }      // graceful (SIGTERM→SIGKILL)
  stop(container)     { return this.#power(container, '/kill',    [304, 409]); } // hard (SIGKILL) — force off (409 = already stopped)
  reboot(container)   { return this.#power(container, '/restart', [304]); }       // 409 (engine refused restart) must surface, not no-op

  updateContainer(container, body = {}) {
    return this.#request('POST', this.#c(container, '/update'), { body });
  }

  setNanoCpus(container, nanoCpus) {
    const n = Math.max(0, Math.floor(Number(nanoCpus) || 0));
    return this.updateContainer(container, { NanoCpus: n });
  }

  async #power(container, suffix, noopStatuses) {
    try {
      const result = await this.#request('POST', this.#c(container, suffix));
      return result ?? { ok: true };
    } catch (err) {
      if (err instanceof DockerError && noopStatuses.includes(err.status)) {
        return { ok: true, noop: true, status: err.status };
      }
      throw err;
    }
  }

  // ── host/engine info (container dashboard) ──────────────────────────────────
  // Docker has no single "node status" equivalent; /info gives static host facts (engine,
  // OS, core count, total RAM, container counts) — no live host CPU%. The service
  // pairs this with the per-container stats the UI already pulls from /api/servers.
  async nodeStatus() {
    const info = await this.#request('GET', '/info');
    return {
      name: info?.Name ?? null,
      engineVersion: info?.ServerVersion ?? null,
      os: info?.OperatingSystem ?? null,
      kernel: info?.KernelVersion ?? null,
      ncpu: info?.NCPU ?? null,
      memTotal: info?.MemTotal ?? null,
      containers: info?.Containers ?? null,
      containersRunning: info?.ContainersRunning ?? null,
    };
  }

  async containerLogs(container, { tail = 240 } = {}) {
    const n = Math.max(1, Math.min(1000, Number.isFinite(Number(tail)) ? Math.floor(Number(tail)) : 240));
    const stream = await this.#request('GET', this.#c(container, `/logs?stdout=1&stderr=1&tail=${n}&timestamps=0`), { raw: true });
    const { stdout, stderr, combined } = demux(stream);
    // `combined` keeps stdout/stderr frames in arrival (chronological) order, which
    // is what a log tail wants; fall back to the split blocks if there were no frames.
    return combined || [stdout, stderr].filter(Boolean).join('\n');
  }

  // ── command execution (emulated guest-agent two-step) ───────────────────────
  // agentExec runs the command to completion and stashes the result; the matching
  // agentExecStatus then reports it as exited. This keeps BaseConnector.runCommand's
  // exec→poll loop intact. `command` is an argv array (e.g. ['/bin/sh','-lc', …]).
  //
  // NOTE: interactive stdin is NOT supported over the Engine exec API without a
  // raw socket hijack, so Docker game connectors do live/RCON I/O over TCP
  // instead (see the Docker Minecraft connector). Passing `input` throws.
  async agentExec(container, { command, input, timeoutMs = 120_000 } = {}) {
    if (!command) throw new Error('agentExec: command is required');
    if (input !== undefined) {
      const e = new Error('docker exec does not support stdin input; use direct TCP for interactive I/O');
      e.code = 'NO_STDIN';
      throw e;
    }
    const argv = Array.isArray(command) ? command : ['/bin/sh', '-lc', String(command)];

    const timeout = timeoutSignal(timeoutMs);
    try {
      const created = await this.#request('POST', this.#c(container, '/exec'), {
        body: { Cmd: argv, AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false },
        signal: timeout.signal,
      });
      const id = created?.Id;
      if (!id) throw new DockerError('docker exec create returned no Id');

      const stream = await this.#request('POST', `/exec/${id}/start`, {
        body: { Detach: false, Tty: false }, raw: true, signal: timeout.signal,
      });
      let { stdout, stderr } = demux(stream);

      const truncated = stdout.length > MAX_OUTPUT || stderr.length > MAX_OUTPUT;
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);

      const inspect = await this.#request('GET', `/exec/${id}/json`, { signal: timeout.signal });
      // Evict the oldest entries before stashing, so a never-polled pid can't grow
      // the map without bound (Map iterates in insertion order → first key is oldest).
      while (this.execResults.size >= EXEC_RESULTS_CAP) {
        this.execResults.delete(this.execResults.keys().next().value);
      }
      this.execResults.set(id, {
        exitcode: inspect?.ExitCode ?? null,
        stdout, stderr, truncated,
      });
      return { pid: id };
    } finally {
      timeout.cancel();
    }
  }

  // Report a stashed exec result as already-exited. Idempotent: the result is NOT
  // removed on read, so a repeat poll for the same pid returns the same data (a
  // destructive read would make a second poll masquerade as an unknown-pid failure
  // with a null exitcode). Stale entries are reclaimed by the insertion-time cap in
  // agentExec, not by reads.
  async agentExecStatus(container, pid) {
    const r = this.execResults.get(pid);
    if (!r) {
      // Unknown pid → report a clean non-zero exit rather than hanging the poll.
      return { exited: 1, exitcode: null, 'out-data': '', 'err-data': '' };
    }
    return {
      exited: 1,
      exitcode: r.exitcode,
      signal: null,
      'out-data': r.stdout,
      'err-data': r.stderr,
      'out-truncated': r.truncated,
      'err-truncated': false,
    };
  }

  // ── config files ────────────────────────────────────────────────────────────
  // Mirror agentFileRead/Write via exec (`cat` / `tee`), returning the same
  // { content, truncated } shape.
  async agentFileRead(container, file) {
    const { pid } = await this.agentExec(container, { command: ['/bin/sh', '-c', `cat -- "${shq(file)}"`] });
    const r = await this.agentExecStatus(container, pid);
    if (r.exitcode !== 0) {
      throw new DockerError(`docker file-read ${file} failed: ${r['err-data'] || `exit ${r.exitcode}`}`);
    }
    return { content: r['out-data'] ?? '', truncated: Boolean(r['out-truncated']) };
  }

  async agentFileWrite(container, file, content) {
    // Write via a base64 round-trip so arbitrary bytes/newlines survive the argv.
    const b64 = Buffer.from(String(content), 'utf8').toString('base64');
    const { pid } = await this.agentExec(container, {
      command: ['/bin/sh', '-c', `printf %s "${b64}" | base64 -d > "${shq(file)}"`],
    });
    const r = await this.agentExecStatus(container, pid);
    if (r.exitcode !== 0) {
      throw new DockerError(`docker file-write ${file} failed: ${r['err-data'] || `exit ${r.exitcode}`}`);
    }
    return null;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

// Build the detail suffix for a non-2xx error from a (possibly JSON) body text:
// prefer the engine's `{ message }`, else the raw body, else the status text.
// Shared by both the JSON and raw request branches.
function errorDetail(text, statusText) {
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { /* non-JSON body */ } }
  return parsed?.message ?? (text || statusText);
}

// Split DOCKER_HOST into an HTTP base URL (+ optional unix socketPath).
function parseHost(host) {
  if (/^https?:\/\//.test(host)) return { base: host.replace(/\/+$/, ''), socketPath: null };
  if (host.startsWith('tcp://')) return { base: 'http://' + host.slice(6).replace(/\/+$/, ''), socketPath: null };
  if (host.startsWith('unix://')) return { base: 'http://localhost', socketPath: host.slice(7) || '/var/run/docker.sock' };
  return { base: host, socketPath: null };
}

// Docker StartedAt can carry nanosecond precision Date.parse() chokes on — clamp
// the fraction to milliseconds before parsing.
function secondsSince(iso) {
  const t = Date.parse(String(iso).replace(/\.(\d{3})\d*Z$/, '.$1Z'));
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

// CPU as cores'-worth (0..ncpu) — one full core = 1.0; can exceed 1 on multi-core
// — from a stats sample (delta vs the previous sample). Returns null when it can't
// be computed. (The frontend converts this to a percent for display.)
function cpuFraction(s) {
  // A one-shot /stats?stream=false can return a zeroed precpu_stats (no prior
  // sample). Differencing against that yields a cumulative-since-boot ratio, not a
  // live %, so treat a missing previous system sample as "can't compute".
  const preSys = s?.precpu_stats?.system_cpu_usage ?? 0;
  if (!preSys) return null;
  const cpuDelta = (s?.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s?.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s?.cpu_stats?.system_cpu_usage ?? 0) - preSys;
  if (cpuDelta <= 0 || sysDelta <= 0) return null;
  const cpus = s?.cpu_stats?.online_cpus
    || s?.cpu_stats?.cpu_usage?.percpu_usage?.length
    || 1;
  return (cpuDelta / sysDelta) * cpus;
}

// Demultiplex a Docker (Tty:false) attach stream: repeated frames of an 8-byte
// header [streamType(1), 0,0,0, size(4 BE)] followed by `size` payload bytes.
// streamType 1 = stdout, 2 = stderr.
function demux(buf) {
  let stdout = '', stderr = '', combined = '';
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const size = dv.getUint32(i + 4, false);
    const start = i + 8;
    const end = start + size;
    if (end > buf.length) break; // partial trailing frame
    const chunk = Buffer.from(buf.subarray(start, end)).toString('utf8');
    if (type === 2) stderr += chunk; else stdout += chunk;
    combined += chunk; // frames are in chronological order — preserve interleaving
    i = end;
  }
  return { stdout, stderr, combined };
}

function timeoutSignal(timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return { signal: undefined, cancel() {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return {
    signal: ctrl.signal,
    cancel() { clearTimeout(timer); },
  };
}

// Minimal shell-quote-escape for a value going inside double quotes.
function shq(s) {
  return String(s).replace(/(["$`\\])/g, '\\$1');
}
