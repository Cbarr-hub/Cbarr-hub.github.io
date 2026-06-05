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
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

const MAX_OUTPUT = 1_000_000; // cap captured stdout/stderr, mirroring the agent's truncation

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
    this.execResults = new Map();
  }

  // ── low-level request ───────────────────────────────────────────────────────
  async #request(method, path, { body, raw = false } = {}) {
    const headers = { Accept: raw ? 'application/vnd.docker.raw-stream' : 'application/json' };
    const init = { method, headers };
    if (this.dispatcher) init.dispatcher = this.dispatcher;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await this.fetch(`${this.base}${path}`, init);
    } catch (err) {
      throw new DockerError(`docker request failed: ${err.message}`, { cause: err });
    }

    if (raw) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!res.ok) {
        throw new DockerError(`docker ${method} ${path} -> ${res.status}`, { status: res.status });
      }
      return buf;
    }

    const text = await res.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { /* non-JSON body */ } }

    if (!res.ok) {
      const detail = parsed?.message ?? (text || res.statusText);
      throw new DockerError(`docker ${method} ${path} -> ${res.status}: ${detail}`, { status: res.status });
    }
    return parsed;
  }

  #c(container, suffix = '') {
    return `/containers/${encodeURIComponent(container)}${suffix}`;
  }

  // ── status ──────────────────────────────────────────────────────────────────
  // Returns the qemu-shaped payload normalizeStatus() expects:
  //   { status: 'running'|'stopped', uptime, cpu, mem, maxmem }
  async statusCurrent(container) {
    const info = await this.#request('GET', this.#c(container, '/json'));
    const running = Boolean(info?.State?.Running);
    const startedAt = info?.State?.StartedAt;
    const uptime = running && startedAt ? secondsSince(startedAt) : 0;

    // cpu/mem are best-effort: a single stats sample is comparatively slow and
    // non-essential (normalizeStatus defaults them to null), so never let it fail
    // the status call.
    let cpu = null, mem = null, maxmem = info?.HostConfig?.Memory || null;
    try {
      const s = await this.#request('GET', this.#c(container, '/stats?stream=false'));
      mem = s?.memory_stats?.usage ?? mem;
      maxmem = s?.memory_stats?.limit ?? maxmem;
      cpu = cpuFraction(s);
    } catch { /* stats unavailable — leave nulls */ }

    return { status: running ? 'running' : 'stopped', uptime, cpu, mem, maxmem };
  }

  // ── power ───────────────────────────────────────────────────────────────────
  start(container)    { return this.#request('POST', this.#c(container, '/start')); }
  shutdown(container) { return this.#request('POST', this.#c(container, '/stop')); }    // graceful (SIGTERM→SIGKILL)
  stop(container)     { return this.#request('POST', this.#c(container, '/kill')); }    // hard (SIGKILL) — force off
  reboot(container)   { return this.#request('POST', this.#c(container, '/restart')); }

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

  // ── command execution (emulated guest-agent two-step) ───────────────────────
  // agentExec runs the command to completion and stashes the result; the matching
  // agentExecStatus then reports it as exited. This keeps BaseConnector.runCommand's
  // exec→poll loop intact. `command` is an argv array (e.g. ['/bin/sh','-lc', …]).
  //
  // NOTE: interactive stdin is NOT supported over the Engine exec API without a
  // raw socket hijack, so Docker game connectors do live/RCON I/O over TCP
  // instead (see the Docker Minecraft connector). Passing `input` throws.
  async agentExec(container, { command, input } = {}) {
    if (!command) throw new Error('agentExec: command is required');
    if (input !== undefined) {
      const e = new Error('docker exec does not support stdin input; use direct TCP for interactive I/O');
      e.code = 'NO_STDIN';
      throw e;
    }
    const argv = Array.isArray(command) ? command : ['/bin/sh', '-lc', String(command)];

    const created = await this.#request('POST', this.#c(container, '/exec'), {
      body: { Cmd: argv, AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false },
    });
    const id = created?.Id;
    if (!id) throw new DockerError('docker exec create returned no Id');

    const stream = await this.#request('POST', `/exec/${id}/start`, {
      body: { Detach: false, Tty: false }, raw: true,
    });
    let { stdout, stderr } = demux(stream);

    const truncated = stdout.length > MAX_OUTPUT || stderr.length > MAX_OUTPUT;
    if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
    if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);

    const inspect = await this.#request('GET', `/exec/${id}/json`);
    this.execResults.set(id, {
      exitcode: inspect?.ExitCode ?? null,
      stdout, stderr, truncated,
    });
    return { pid: id };
  }

  async agentExecStatus(container, pid) {
    const r = this.execResults.get(pid);
    if (!r) {
      // Unknown pid → report a clean non-zero exit rather than hanging the poll.
      return { exited: 1, exitcode: null, 'out-data': '', 'err-data': '' };
    }
    this.execResults.delete(pid);
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

// CPU as a 0..1 fraction from a stats sample (delta vs the previous sample),
// matching the qemu cpu field. Returns null when it can't be computed.
function cpuFraction(s) {
  const cpuDelta = (s?.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s?.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s?.cpu_stats?.system_cpu_usage ?? 0) - (s?.precpu_stats?.system_cpu_usage ?? 0);
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
  let stdout = '', stderr = '';
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
    i = end;
  }
  return { stdout, stderr };
}

// Minimal shell-quote-escape for a value going inside double quotes.
function shq(s) {
  return String(s).replace(/(["$`\\])/g, '\\$1');
}
