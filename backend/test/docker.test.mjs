import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDockerClient, withEnv } from './harness.mjs';
import { DockerClient } from '../src/docker/client.js';
import { GameConnector, buildConnector } from '../src/servers/connectors/engine.js';
import { minecraftSpec } from '../src/servers/connectors/specs/minecraft.js';
import { counterstrikeSpec } from '../src/servers/connectors/specs/counterstrike.js';
import { gmodSpec } from '../src/servers/connectors/specs/gmod.js';
import { buildConnectors } from '../src/servers/connectors/index.js';
import { createServerService } from '../src/servers/service.js';
import { listServers } from '../src/servers/registry.js';

// ── a fake fetch that records calls and returns canned Engine responses ─────────
function res({ ok = true, status = 200, json, bytes, text } = {}) {
  return {
    ok, status, statusText: String(status),
    async text() { return text ?? (json !== undefined ? JSON.stringify(json) : ''); },
    async arrayBuffer() { return (bytes ?? new Uint8Array()).buffer; },
  };
}

// Build a Docker (Tty:false) multiplexed frame: [type,0,0,0, size BE] + payload.
function frame(type, str) {
  const payload = Buffer.from(str, 'utf8');
  const head = Buffer.alloc(8);
  head[0] = type;
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method, path, body: init.body });
    for (const [re, handler] of routes) {
      if (re.test(`${method} ${path}`)) return handler(`${method} ${path}`, init);
    }
    return res({ ok: false, status: 404 });
  };
  return { fetchImpl, calls };
}

// ── DockerClient: status maps inspect (+stats) to the normalizeStatus shape ─────
test('DockerClient.statusCurrent maps a running container to normalizeStatus shape', async () => {
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const { fetchImpl } = fakeFetch([
    [/^GET \/containers\/mc\/json$/, () => res({ json: {
      State: { Running: true, StartedAt: startedAt }, HostConfig: { Memory: 0 },
    } })],
    [/^GET \/containers\/mc\/stats/, () => res({ json: {
      memory_stats: { usage: 500, limit: 2000 },
      cpu_stats:    { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 600 },
    } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const s = await c.statusCurrent('mc');
  assert.equal(s.status, 'running');
  assert.ok(s.uptime >= 59 && s.uptime <= 61);
  assert.equal(s.mem, 500);
  assert.equal(s.maxmem, 2000);
  assert.ok(s.cpu > 0); // (100/400)*2 = 0.5
});

// cpu is cores'-worth (0..ncpu), NOT a 0..1 fraction: when the container's CPU
// delta equals the system delta (every cycle on every core), a 2-core host reads
// 2.0. Pins the cores'-worth contract the frontend unit-converts for display.
test('DockerClient.statusCurrent reports cpu as cores\'-worth (can exceed 1 on multi-core)', async () => {
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const { fetchImpl } = fakeFetch([
    [/^GET \/containers\/mc\/json$/, () => res({ json: {
      State: { Running: true, StartedAt: startedAt }, HostConfig: { Memory: 0 },
    } })],
    [/^GET \/containers\/mc\/stats/, () => res({ json: {
      memory_stats: { usage: 500, limit: 2000 },
      // cpuDelta (1000-600=400) == sysDelta (1000-600=400) → all cores busy.
      cpu_stats:    { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 1000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 600 }, system_cpu_usage: 600 },
    } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const s = await c.statusCurrent('mc');
  assert.equal(s.cpu, 2); // (400/400)*2 — two full cores
});

test('DockerClient.statusCurrent can skip the slow stats sample', async () => {
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const { fetchImpl, calls } = fakeFetch([
    [/^GET \/containers\/mc\/json$/, () => res({ json: {
      State: { Running: true, StartedAt: startedAt }, HostConfig: { Memory: 1234 },
    } })],
    [/^GET \/containers\/mc\/stats/, () => res({ ok: false, status: 500 })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const s = await c.statusCurrent('mc', { stats: false });
  assert.equal(s.status, 'running');
  assert.equal(s.cpu, null);
  assert.equal(s.mem, null);
  assert.equal(s.maxmem, 1234);
  assert.deepEqual(calls.map((x) => x.path), ['/containers/mc/json']);
});

test('DockerClient.statusCurrent reports stopped, and tolerates missing stats', async () => {
  const { fetchImpl } = fakeFetch([
    [/^GET \/containers\/mc\/json$/, () => res({ json: { State: { Running: false } } })],
    [/^GET \/containers\/mc\/stats/, () => res({ ok: false, status: 500 })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const s = await c.statusCurrent('mc');
  assert.equal(s.status, 'stopped');
  assert.equal(s.uptime, 0);
  assert.equal(s.cpu, null);
});

test('DockerClient.containerLogs tails and demuxes container logs', async () => {
  const { fetchImpl, calls } = fakeFetch([
    [/^GET \/containers\/bluemap\/logs\?stdout=1&stderr=1&tail=50&timestamps=0$/, () => res({ bytes: new Uint8Array(
      Buffer.concat([frame(1, 'line one\n'), frame(2, 'line two\n')]),
    ) })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const logs = await c.containerLogs('bluemap', { tail: 50 });
  assert.match(logs, /line one/);
  assert.match(logs, /line two/);
  assert.deepEqual(calls.map((x) => x.path), ['/containers/bluemap/logs?stdout=1&stderr=1&tail=50&timestamps=0']);
});

// FINDING A: the raw branch reads the error body too — its detail (the engine's
// `{ message }`) must survive into the thrown DockerError, like the JSON branch.
test('DockerClient raw request surfaces the engine error body on non-2xx', async () => {
  const { fetchImpl } = fakeFetch([
    [/^GET \/containers\/missing\/logs/, () => res({
      ok: false, status: 404,
      bytes: new Uint8Array(Buffer.from(JSON.stringify({ message: 'No such container: missing' }))),
    })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  await assert.rejects(
    () => c.containerLogs('missing', { tail: 50 }),
    (e) => e.name === 'DockerError' && e.status === 404
      && /No such container/.test(e.message) && /-> 404/.test(e.message),
  );
});

// FINDING B: a non-abort body-read failure (e.g. a mid-stream socket reset) must
// become a DockerError (→ 502), not a raw Error (→ 500). Both branches: raw
// (arrayBuffer) and non-raw (text). It carries NO DOCKER_TIMEOUT code (that's for
// genuine aborts only).
test('DockerClient raw body-read failure wraps as a DockerError (not a 500)', async () => {
  const { fetchImpl } = fakeFetch([
    [/^GET \/containers\/mc\/logs/, () => ({
      ok: true, status: 200, statusText: '200',
      arrayBuffer: async () => { throw new Error('socket reset'); },
      text: async () => '',
    })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  await assert.rejects(
    () => c.containerLogs('mc', { tail: 50 }),
    (e) => e.name === 'DockerError' && e.code === undefined && /body read failed/.test(e.message),
  );
});

test('DockerClient non-raw body-read failure wraps as a DockerError (not a 500)', async () => {
  const { fetchImpl } = fakeFetch([
    [/^GET \/containers\/mc\/json$/, () => ({
      ok: true, status: 200, statusText: '200',
      text: async () => { throw new Error('socket reset'); },
      arrayBuffer: async () => new ArrayBuffer(0),
    })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  await assert.rejects(
    () => c.statusCurrent('mc'),
    (e) => e.name === 'DockerError' && e.code === undefined && /body read failed/.test(e.message),
  );
});

test('DockerClient.setNanoCpus updates live container cpu quota', async () => {
  const { fetchImpl, calls } = fakeFetch([
    [/^POST \/containers\/bluemap\/update$/, () => res({ json: { Warnings: null } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  assert.deepEqual(await c.setNanoCpus('bluemap', 4_000_000_000), { Warnings: null });
  assert.deepEqual(calls.map((x) => [x.path, JSON.parse(x.body)]), [
    ['/containers/bluemap/update', { NanoCpus: 4_000_000_000 }],
  ]);
});

test('DockerClient power actions hit the right endpoints (stop=kill, shutdown=stop)', async () => {
  const { fetchImpl, calls } = fakeFetch([[/^POST /, () => res({ status: 204 })]]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  await c.start('mc'); await c.shutdown('mc'); await c.stop('mc'); await c.reboot('mc');
  assert.deepEqual(calls.map((x) => x.path), [
    '/containers/mc/start', '/containers/mc/stop', '/containers/mc/kill', '/containers/mc/restart',
  ]);
});

test('DockerClient power actions treat expected already-state responses as no-ops (reboot still surfaces 409)', async () => {
  const { fetchImpl } = fakeFetch([
    [/^POST \/containers\/mc\/start$/, () => res({ ok: false, status: 304, text: 'already started' })],
    [/^POST \/containers\/mc\/stop$/, () => res({ ok: false, status: 304, text: 'already stopped' })],
    [/^POST \/containers\/mc\/kill$/, () => res({ ok: false, status: 409, text: 'not running' })],
    [/^POST \/containers\/mc\/restart$/, () => res({ ok: false, status: 409, text: 'engine refused restart' })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  assert.deepEqual(await c.start('mc'), { ok: true, noop: true, status: 304 });
  assert.deepEqual(await c.shutdown('mc'), { ok: true, noop: true, status: 304 });
  assert.deepEqual(await c.stop('mc'), { ok: true, noop: true, status: 409 });
  // reboot does NOT swallow 409: a genuine restart refusal must surface as an error.
  await assert.rejects(() => c.reboot('mc'), (e) => e.name === 'DockerError' && e.status === 409);
});

test('DockerClient.nodeStatus maps /info to the host/engine facts', async () => {
  const { fetchImpl } = fakeFetch([
    [/^GET \/info$/, () => res({ json: {
      Name: 'keeper', ServerVersion: '26.0', OperatingSystem: 'Debian', KernelVersion: '6.x',
      NCPU: 4, MemTotal: 12e9, Containers: 8, ContainersRunning: 7,
    } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  assert.deepEqual(await c.nodeStatus(), {
    name: 'keeper', engineVersion: '26.0', os: 'Debian', kernel: '6.x',
    ncpu: 4, memTotal: 12e9, containers: 8, containersRunning: 7,
  });
});

// ── DockerClient.exec: one-shot create → start → inspect ────────────────────────
test('DockerClient.exec runs create → start → inspect and demuxes stdout/stderr', async () => {
  const { fetchImpl, calls } = fakeFetch([
    [/^POST \/containers\/mc\/exec$/, () => res({ json: { Id: 'exec123' } })],
    [/^POST \/exec\/exec123\/start$/, () => res({ bytes: new Uint8Array(
      Buffer.concat([frame(1, 'hello\n'), frame(2, 'oops\n')]),
    ) })],
    [/^GET \/exec\/exec123\/json$/, () => res({ json: { ExitCode: 0, Running: false } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const r = await c.exec('mc', ['/bin/sh', '-lc', 'echo hello']);
  assert.equal(r.exitCode, 0);
  assert.equal(r.signal, null);
  assert.equal(r.stdout, 'hello\n');   // stdout (type 1)
  assert.equal(r.stderr, 'oops\n');    // stderr (type 2)
  assert.equal(r.truncated, false);
  // the create body advertised the argv (attach stdout+stderr, never stdin)
  const create = calls.find((x) => x.path === '/containers/mc/exec');
  const body = JSON.parse(create.body);
  assert.deepEqual(body.Cmd, ['/bin/sh', '-lc', 'echo hello']);
  assert.equal(body.AttachStdout, true);
  assert.equal(body.AttachStderr, true);
  assert.equal(body.AttachStdin, false);
  assert.deepEqual(calls.map((x) => x.path),
    ['/containers/mc/exec', '/exec/exec123/start', '/exec/exec123/json']);
});

test('DockerClient.exec wraps a string command as /bin/sh -lc', async () => {
  const { fetchImpl, calls } = fakeFetch([
    [/^POST \/containers\/mc\/exec$/, () => res({ json: { Id: 'e' } })],
    [/^POST \/exec\/e\/start$/, () => res({ bytes: new Uint8Array() })],
    [/^GET \/exec\/e\/json$/, () => res({ json: { ExitCode: 0 } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  await c.exec('mc', 'echo hi');
  const create = calls.find((x) => x.path === '/containers/mc/exec');
  assert.deepEqual(JSON.parse(create.body).Cmd, ['/bin/sh', '-lc', 'echo hi']);
});

test('DockerClient.exec surfaces a non-zero exit code without throwing', async () => {
  const { fetchImpl } = fakeFetch([
    [/^POST \/containers\/mc\/exec$/, () => res({ json: { Id: 'e' } })],
    [/^POST \/exec\/e\/start$/, () => res({ bytes: new Uint8Array(frame(2, 'boom\n')) })],
    [/^GET \/exec\/e\/json$/, () => res({ json: { ExitCode: 7 } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const r = await c.exec('mc', ['false']);
  assert.equal(r.exitCode, 7);
  assert.equal(r.stderr, 'boom\n');
});

test('DockerClient.exec caps each stream at 1MB and sets the truncated flag', async () => {
  const big = 'x'.repeat(1_000_001); // one byte over MAX_OUTPUT
  const { fetchImpl } = fakeFetch([
    [/^POST \/containers\/mc\/exec$/, () => res({ json: { Id: 'e' } })],
    [/^POST \/exec\/e\/start$/, () => res({ bytes: new Uint8Array(frame(1, big)) })],
    [/^GET \/exec\/e\/json$/, () => res({ json: { ExitCode: 0 } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const r = await c.exec('mc', ['big']);
  assert.equal(r.truncated, true);
  assert.equal(r.stdout.length, 1_000_000);
  assert.equal(r.stderr, '');
});

test('DockerClient.exec aborts the exec start stream at timeoutMs', async () => {
  const { fetchImpl } = fakeFetch([
    [/^POST \/containers\/mc\/exec$/, () => res({ json: { Id: 'slow' } })],
    [/^POST \/exec\/slow\/start$/, (_l, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  await assert.rejects(
    () => c.exec('mc', ['/bin/sh', '-lc', 'sleep 999'], { timeoutMs: 10 }),
    (e) => e.name === 'DockerError' && e.code === 'DOCKER_TIMEOUT',
  );
});

test('DockerClient.exec aborts exec create response reads at timeoutMs', async () => {
  const { fetchImpl } = fakeFetch([
    [/^POST \/containers\/mc\/exec$/, (_l, init) => ({
      ok: true,
      status: 200,
      statusText: '200',
      text: () => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  await assert.rejects(
    () => c.exec('mc', ['/bin/sh', '-lc', 'sleep 999'], { timeoutMs: 10 }),
    (e) => e.name === 'DockerError' && e.code === 'DOCKER_TIMEOUT',
  );
});

test('DockerClient.exec rejects stdin input (use TCP for interactive I/O)', async () => {
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl: async () => res({}) });
  await assert.rejects(() => c.exec('mc', ['x'], { input: 'hi' }), (e) => e.code === 'NO_STDIN');
});

// ── DockerClient file ops (exec-backed: cat / atomic tmp+rename write) ──────────
test('DockerClient.fileRead/fileWrite round-trip via exec', async () => {
  let written = null;
  let lastCmd = '';
  const { fetchImpl } = fakeFetch([
    [/^POST \/containers\/mc\/exec$/, (_l, init) => {
      const cmd = JSON.parse(init.body).Cmd.join(' ');
      // stash which kind of exec this is so start can return the right stream
      lastCmd = cmd;
      return res({ json: { Id: cmd.includes('base64 -d') ? 'w' : 'r' } });
    }],
    [/^POST \/exec\/r\/start$/, () => res({ bytes: new Uint8Array(frame(1, 'level-name=world\n')) })],
    [/^POST \/exec\/w\/start$/, () => {
      // capture the base64 payload that file-write pipes in
      const m = lastCmd.match(/printf %s "([^"]+)"/);
      written = Buffer.from(m[1], 'base64').toString('utf8');
      return res({ bytes: new Uint8Array() });
    }],
    [/^GET \/exec\/[rw]\/json$/, () => res({ json: { ExitCode: 0 } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const read = await c.fileRead('mc', '/data/server.properties');
  assert.equal(read.content, 'level-name=world\n');
  assert.equal(read.truncated, false);
  await c.fileWrite('mc', '/data/server.properties', 'level-name=new\n');
  assert.equal(written, 'level-name=new\n');
  // atomic write: decode into a same-dir temp file, then rename over the target
  assert.match(lastCmd, /base64 -d > "\/data\/server\.properties\.tmp\.\$\$"/);
  assert.match(lastCmd, /mv -f "\/data\/server\.properties\.tmp\.\$\$" "\/data\/server\.properties"/);
});

test('DockerClient.fileWriteBytes round-trips arbitrary bytes via base64', async () => {
  let written = null;
  let lastCmd = '';
  const { fetchImpl } = fakeFetch([
    [/^POST \/containers\/mc\/exec$/, (_l, init) => {
      lastCmd = JSON.parse(init.body).Cmd.join(' ');
      return res({ json: { Id: 'w' } });
    }],
    [/^POST \/exec\/w\/start$/, () => {
      const m = lastCmd.match(/printf %s "([^"]+)"/);
      written = Buffer.from(m[1], 'base64');
      return res({ bytes: new Uint8Array() });
    }],
    [/^GET \/exec\/w\/json$/, () => res({ json: { ExitCode: 0 } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  assert.equal(await c.fileWriteBytes('mc', '/app/web/head.png', png), null);
  assert.deepEqual(written, png);
});

test('DockerClient file ops throw a DockerError with the stderr detail on non-zero exit', async () => {
  const { fetchImpl } = fakeFetch([
    [/^POST \/containers\/mc\/exec$/, () => res({ json: { Id: 'e' } })],
    [/^POST \/exec\/e\/start$/, () => res({ bytes: new Uint8Array(frame(2, 'cat: /nope: No such file or directory')) })],
    [/^GET \/exec\/e\/json$/, () => res({ json: { ExitCode: 1 } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  await assert.rejects(
    () => c.fileRead('mc', '/nope'),
    (e) => e.name === 'DockerError' && /file-read \/nope/.test(e.message) && /No such file/.test(e.message),
  );
});

// ── Docker connectors: locator + container-is-game + shared profile logic ───────
const MC_DOCKER = { id: 'minecraft', name: 'Minecraft', backend: 'docker', container: 'minecraft', port: 25565 };

test('a spec-less GameConnector uses the container as its locator and treats running == hosting', async () => {
  const conn = new GameConnector({ id: 'x', container: 'box' }, {}, fakeDockerClient());
  assert.equal(conn.vmid, 'box');
  const s = await conn.status();
  assert.equal(s.status, 'running');
  assert.equal(s.gameStatus, 'hosting');
});

test('minecraft spec apply/capture round-trips /data/server.properties', async () => {
  const PROPS = '/data/server.properties';
  const client = fakeDockerClient({ [PROPS]: 'level-name=world\nmax-players=20\n' });
  const conn = buildConnector(MC_DOCKER, minecraftSpec, client);
  await conn.applyProfileSettings({
    world: 'GTown', gamemode: 'creative', difficulty: 'hard', maxPlayers: 8, motd: 'Hi',
    pvp: '0', hardcore: '1', whitelist: '1', onlineMode: '0', viewDistance: 16, spawnProtection: 0,
  });
  assert.match(client.files[PROPS], /level-name=GTown/);
  assert.match(client.files[PROPS], /gamemode=creative/);
  assert.match(client.files[PROPS], /white-list=true/);

  const captured = await conn.captureProfileSettings();
  assert.equal(captured.world, 'GTown');
  assert.equal(captured.gamemode, 'creative');
  assert.equal(captured.whitelist, '1');
});

test('minecraft spec getLive is unavailable without an RCON password', async () => {
  await withEnv('MINECRAFT_RCON_PASSWORD', undefined, async () => {
    const conn = buildConnector(MC_DOCKER, minecraftSpec, fakeDockerClient());
    const live = await conn.getLive();
    assert.equal(live.available, false);
  });
});

// ── factory wiring: backend selection ───────────────────────────────────────────
test('buildConnectors builds every docker-backed entry, and skips when no client', () => {
  const docker = fakeDockerClient();
  // A docker client → all five (docker-backed) registry entries build, EACH wired
  // to its spec (engine GameConnector) or its concrete legacy class (a missing
  // spec/class would now throw, not fall back).
  const built = buildConnectors({ docker });
  assert.equal(built.size, 5);
  for (const id of ['minecraft', 'factorio', 'counterstrike', 'gmod', 'prophunt']) {
    assert.ok(built.get(id) instanceof GameConnector, `${id} builds on the engine`);
  }

  // No docker client → every entry is skipped (nothing to build).
  const none = buildConnectors({ docker: null });
  assert.equal(none.size, 0);
});

// ── action surface the control panel relies on (container == game) ──────────────
// The panel collapsed the old Game-Service / Virtual-Machine split into one
// container-power model (Start/Restart/Stop). The contract now lives at the
// SERVICE boundary: the legacy game-service action names (startGame/stopGame/
// restartGame) alias onto container power for EVERY server — never BAD_ACTION —
// and the response echoes the ORIGINAL action name so older clients keep working.
// (Each image's update() recipe is pinned in its own docker-*.test.mjs file.)
test('service maps the legacy game-service actions onto container power for every server', async () => {
  const stubs = new Map(listServers().map((s) => {
    const calls = [];
    return [s.id, {
      calls,
      async start()    { calls.push('start'); },
      async shutdown() { calls.push('shutdown'); },
      async reboot()   { calls.push('reboot'); },
      async stop()     { calls.push('stop'); },
    }];
  }));
  const svc = createServerService({ db: null, connectorsOverride: stubs });
  for (const { id } of listServers()) {
    const stub = stubs.get(id);
    // legacy aliases map to container start/shutdown/reboot (never BAD_ACTION)…
    assert.deepEqual(await svc.doAction(id, 'startGame'), { ok: true, action: 'startGame' }, id);
    assert.deepEqual(await svc.doAction(id, 'stopGame'), { ok: true, action: 'stopGame' }, id);
    assert.deepEqual(await svc.doAction(id, 'restartGame'), { ok: true, action: 'restartGame' }, id);
    assert.deepEqual(stub.calls, ['start', 'shutdown', 'reboot'], id);
    // …while a genuinely bogus action still rejects with BAD_ACTION.
    await assert.rejects(() => svc.doAction(id, 'explode'), (e) => e.code === 'BAD_ACTION');
  }
});

// The Runtime panel's live change-map dropdown reads getSettings().map. CS uses the
// generic Profiles panel for startup config, so its getSettings returns ONLY the map
// block (stock + the saved workshop catalog) — no fields/sections (which would
// double-render a Quick Settings panel).
test('DockerCounterStrike.getSettings feeds the live change-map dropdown (stock + workshop)', async () => {
  const CS = { id: 'counterstrike', name: 'CS', backend: 'docker', container: 'counterstrike', port: 27015 };
  const store = {
    listWorkshopMaps: () => [{ workshopId: '123', name: 'Assembly' }],
    getActiveProfileId: () => 7,
    getProfile: () => ({ id: 7, name: 'p', settings: { map: 'ws:123' } }),
  };
  const conn = buildConnector(CS, counterstrikeSpec, fakeDockerClient(), store);
  const s = await conn.getSettings();
  assert.ok(Array.isArray(s.map.stock) && s.map.stock.length > 0); // stock maps present
  assert.deepEqual(s.map.workshop, [{ id: '123', name: 'Assembly' }]); // saved workshop maps, by name
  assert.equal(s.map.current, 'ws:123'); // current reflects the active profile's map
  assert.equal(s.fields, undefined); // no Quick Settings double-render
  assert.equal(s.sections, undefined);
});

// TTT exposes the genuinely-binary toggles as buttons (bhop/cheats + list players)
// and the continuous cvars (gravity/speed/timescale) as slider CONTROLS, not the
// old on/off button pairs.
test('DockerGmod (TTT) getLive: binary toggles as buttons, ranges as slider controls', async () => {
  const GMOD = { id: 'gmod', name: 'TTT', backend: 'docker', container: 'gmod', port: 27066 };
  await withEnv('GMOD_RCON_PASSWORD', 'secret', async () => {
    const conn = buildConnector(GMOD, gmodSpec, fakeDockerClient());
    const live = await conn.getLive();
    assert.equal(live.available, true);
    assert.equal(live.changeMap, true);
    const keys = live.actions.map((a) => a.key);
    for (const k of ['bhop_on', 'bhop_off', 'cheats_on', 'cheats_off', 'players']) {
      assert.ok(keys.includes(k), `expected runtime action ${k}`);
    }
    // the old on/off range pairs are gone from the buttons…
    for (const k of ['lowgrav_on', 'speed_on', 'slowmo_on']) {
      assert.ok(!keys.includes(k), `range action ${k} should be a slider now`);
    }
    // …and present as range controls instead. gravity + timescale are the honest
    // GMOD movement sliders (there's no working player-speed cvar — validated live),
    // plus the redesign's traitor_pct/round_limit. Assert inclusion, not an exact list.
    const ctlKeys = (live.controls || []).map((c) => c.key);
    for (const k of ['gravity', 'timescale']) assert.ok(ctlKeys.includes(k), `expected slider ${k}`);
    assert.ok(!ctlKeys.includes('speed'), 'player-speed slider removed (no GMOD cvar for it)');
    const gravity = live.controls.find((c) => c.key === 'gravity');
    assert.ok(gravity.min != null && gravity.max != null && gravity.step != null && gravity.default != null);
  });
});

// The range sliders push a single value → an RCON command via runLiveAction(key, value).
test('DockerGmod runLiveAction maps range keys to clamped cvar commands', async () => {
  const GMOD = { id: 'gmod', name: 'TTT', backend: 'docker', container: 'gmod', port: 27066 };
  await withEnv('GMOD_RCON_PASSWORD', 'secret', async () => {
    const sent = [];
    const conn = buildConnector(GMOD, gmodSpec, fakeDockerClient());
    conn.runRcon = async (command) => { sent.push(command); return { output: '' }; };
    await conn.runLiveAction('gravity', '250');
    await conn.runLiveAction('timescale', '0.5');
    await conn.runLiveAction('gravity', '99999'); // clamps to max 1000
    assert.equal(sent[0], 'sv_gravity 250');
    assert.equal(sent[1], 'sv_cheats 1; host_timescale 0.5');
    assert.equal(sent[2], 'sv_gravity 1000');
  });
});
