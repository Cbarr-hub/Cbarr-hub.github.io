// Shared test helpers for the servers/docker suite.
//
// One copy of the fakes that used to be duplicated across docker.test.mjs,
// docker-{gmod,minecraft,factorio,counterstrike}.test.mjs, profiles.test.mjs and
// bluemap.test.mjs:
//   fakeDockerClient  — in-memory DockerClient speaking the post-halving surface
//                       (exec / fileRead / fileWrite / fileWriteBytes / power)
//   encodeRcon        — Source-RCON packet encoder
//   withRconCapture   — throwaway RCON server that auths, captures commands, and
//                       optionally answers via a per-command responder
//   withEnv(Many)     — env-var scoping (RCON password gates)

import net from 'node:net';

// ── fake transport client ─────────────────────────────────────────────────────
// Duck-types the connector-facing DockerClient surface. `files` backs
// fileRead/fileWrite by absolute path. Every call is recorded:
//   execCalls  — [{ container, command, input, timeoutMs }]
//   powerCalls — [['reboot', container], …]
//   writes     — [[path, content], …]   (fileWrite, also lands in `files`)
//   bytes      — [[path, byteLength], …] (fileWriteBytes, buffer lands in `files`)
// exec() resolves to a benign success; script its stdout by setting
// `client.execStdout`, or replace it wholesale via `overrides`/reassignment.
// NOTE: unlike the real client, exec ACCEPTS `input` (no NO_STDIN) — the
// VM-class GMOD-family connectors still drive the in-guest python RCON argv
// through it (those tests go away in a later step).
export function fakeDockerClient(files = {}, overrides = {}) {
  const execCalls = [];
  const powerCalls = [];
  const writes = [];
  const bytes = [];
  const client = {
    files, execCalls, powerCalls, writes, bytes,
    execStdout: '',
    async statusCurrent() { return { status: 'running', uptime: 10, cpu: 0.1, mem: 100, maxmem: 2000 }; },
    async exec(container, command, { input, timeoutMs } = {}) {
      execCalls.push({ container, command, input, timeoutMs });
      return { exitCode: 0, signal: null, stdout: client.execStdout, stderr: '', truncated: false };
    },
    async fileRead(_c, path) { return { content: files[path] ?? '', truncated: false }; },
    async fileWrite(_c, path, content) { files[path] = content; writes.push([path, content]); return null; },
    async fileWriteBytes(_c, path, buf) { files[path] = buf; bytes.push([path, buf.length]); return null; },
    async start(c)    { powerCalls.push(['start', c]);    return { ok: true }; },
    async shutdown(c) { powerCalls.push(['shutdown', c]); return { ok: true }; },
    async reboot(c)   { powerCalls.push(['reboot', c]);   return { ok: true }; },
    async stop(c)     { powerCalls.push(['stop', c]);     return { ok: true }; },
  };
  return Object.assign(client, overrides);
}

// ── Source-RCON test server ───────────────────────────────────────────────────
// Packet: int32 size | int32 id | int32 type | body + NUL | NUL (little-endian).
export function encodeRcon(id, type, body) {
  const b = Buffer.from(body, 'ascii');
  const size = 4 + 4 + b.length + 2;
  const buf = Buffer.allocUnsafe(4 + size);
  buf.writeInt32LE(size, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8);
  b.copy(buf, 12); buf.writeInt8(0, 12 + b.length); buf.writeInt8(0, 13 + b.length);
  return buf;
}

// Loopback RCON server matching rconExchange's protocol: replies to auth
// (type 3 → auth-ok, or id -1 with `authOk:false`), echoes the END sentinel
// (id 3) so the exchange resolves, and records every real command body.
//
//   withRconCapture(run)                          — capture only, no replies
//   withRconCapture({ responder }, run)           — reply encodeRcon(id, 0,
//                                                   responder(body)) per command
//
// `run({ port })` does the client work; resolves { command, commands } —
// the first captured command and the full list.
export async function withRconCapture(optsOrRun, maybeRun) {
  const opts = typeof optsOrRun === 'function' ? {} : (optsOrRun ?? {});
  const run = typeof optsOrRun === 'function' ? optsOrRun : maybeRun;
  const { responder = null, authOk = true } = opts;

  const commands = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0);
        if (buf.length < 4 + size) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.toString('ascii', 12, 4 + size - 2);
        buf = buf.subarray(4 + size);
        if (type === 3) { sock.write(encodeRcon(authOk ? id : -1, 2, '')); continue; } // auth
        if (id === 3) { sock.write(encodeRcon(3, 0, '')); continue; }                  // END sentinel echo
        commands.push(body);
        if (responder) sock.write(encodeRcon(id, 0, responder(body)));
      }
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  try { await run({ port }); } finally { await new Promise((res) => server.close(res)); }
  return { command: commands[0] ?? null, commands };
}

// ── env scoping ───────────────────────────────────────────────────────────────
// Set (or, with value === undefined, unset) an env var for the duration of fn,
// restoring the previous value afterwards.
export async function withEnv(key, value, fn) {
  return withEnvMany({ [key]: value }, fn);
}

export async function withEnvMany(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, p] of Object.entries(prev)) {
      if (p === undefined) delete process.env[k]; else process.env[k] = p;
    }
  }
}
