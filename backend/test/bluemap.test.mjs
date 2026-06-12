// Tests for src/servers/bluemap.js — the merged BlueMap module (live player
// markers + render-status parsing + CPU tuner + the shared poller). Replaces
// bluemap-players.test.mjs / bluemap-resources.test.mjs / bluemap-status.test.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDockerClient } from './harness.mjs';
import {
  blueMapPlayersOptions,
  blueMapResourceOptions,
  buildPlayersJson,
  createBlueMapPlayersController,
  createBlueMapResourceController,
  makePoller,
  normalizeUuid,
  parseBlueMapStatus,
  targetBlueMapCpus,
} from '../src/servers/bluemap.js';

// ── poller ──────────────────────────────────────────────────────────────────────

test('makePoller runs the tick immediately on start and stop cancels the chain', async () => {
  let ticks = 0;
  const poller = makePoller(async () => { ticks++; }, 10);
  assert.equal(poller.start(), true);
  assert.equal(ticks, 1);              // first tick fires immediately, not after delayMs
  assert.equal(poller.start(), false); // already running
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(ticks >= 2);               // rescheduled at least once
  poller.stop();
  const after = ticks;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ticks, after);          // nothing fires after stop
});

test('makePoller accepts a function delayMs, re-evaluated per schedule', async () => {
  let ticks = 0;
  let delayCalls = 0;
  const poller = makePoller(async () => { ticks++; }, () => { delayCalls++; return 10; });
  poller.start();
  await new Promise((r) => setTimeout(r, 50));
  poller.stop();
  assert.ok(ticks >= 2);
  assert.ok(delayCalls >= ticks - 1); // consulted for every reschedule
});

// ── render status ───────────────────────────────────────────────────────────────

test('parseBlueMapStatus reports latest render percent and ETA', () => {
  const status = parseBlueMapStatus(`
[21:58:58 INFO] updating map 'nether': 44.996% (ETA: 47 minutes)
[21:59:08 INFO] updating map 'nether': 45.11% (ETA: 49 minutes)
`);
  assert.equal(status.state, 'rendering');
  assert.equal(status.map, 'nether');
  assert.equal(status.percent, 45.1);
  assert.equal(status.eta, '49 minutes');
  assert.equal(status.message, 'Nether rendering 45.1% - ETA 49 minutes');
});

test('parseBlueMapStatus reports complete after up-to-date or waiting messages', () => {
  const status = parseBlueMapStatus(`
[18:42:56 INFO] updating map 'overworld': 99.9% (ETA: 1 seconds)
[18:42:56 INFO] Your maps are now all up-to-date!
[18:43:06 INFO] Waiting for changes on the world-files...
`);
  assert.equal(status.state, 'complete');
  assert.equal(status.percent, 100);
  assert.equal(status.message, 'Render complete');
});

test('parseBlueMapStatus reports startup before progress exists', () => {
  const status = parseBlueMapStatus(`
[21:53:47 INFO] Loading resources...
[21:53:48 INFO] Start updating 3 maps ...
`);
  assert.equal(status.state, 'starting');
  assert.equal(status.percent, null);
});

// ── live player markers ─────────────────────────────────────────────────────────

const UUID = '11111111-2222-3333-4444-555555555555';

test('normalizeUuid dashes bare hex and lowercases', () => {
  assert.equal(normalizeUuid('1111111122223333444455555555555 5'.replace(/\s/g, '')), UUID);
  assert.equal(normalizeUuid('11111111222233334444555555555555'), UUID);
  assert.equal(normalizeUuid(UUID.toUpperCase()), UUID);
  assert.equal(normalizeUuid(''), null);
});

test('normalizeUuid fails closed on anything that is not 32 hex (no raw passthrough)', () => {
  assert.equal(normalizeUuid('../../etc/passwd'), null);
  assert.equal(normalizeUuid('not-a-uuid'), null);
  assert.equal(normalizeUuid('@evil.host/x'), null);
  assert.equal(normalizeUuid('1111111122223333444455555555555'), null); // 31 hex
});

test('buildPlayersJson sets the foreign flag per map and the rotation shape', () => {
  const players = [{ uuid: UUID, name: 'Steve', x: 10, y: 64, z: -5, yaw: 90, pitch: 4, mapId: 'overworld' }];
  const ow = JSON.parse(buildPlayersJson(players, 'overworld'));
  const nether = JSON.parse(buildPlayersJson(players, 'nether'));
  assert.equal(ow.players[0].foreign, false);
  assert.equal(nether.players[0].foreign, true);
  assert.deepEqual(ow.players[0].position, { x: 10, y: 64, z: -5 });
  assert.deepEqual(ow.players[0].rotation, { pitch: 4, yaw: 90, roll: 0 });
  assert.equal(buildPlayersJson([], 'overworld'), '{"players":[]}');
});

test('blueMapPlayersOptions reads env toggles and defaults', () => {
  const off = blueMapPlayersOptions({ BLUEMAP_PLAYERS_AUTOWRITE: 'false', BLUEMAP_SKIN_BASE: 'https://x/y/' });
  assert.equal(off.enabled, false);
  assert.equal(off.skinBase, 'https://x/y'); // trailing slash trimmed
  const def = blueMapPlayersOptions({});
  assert.equal(def.enabled, true);
  assert.equal(def.pollMs, 2000);
  assert.equal(def.idlePollMs, 10_000); // idle backoff cadence
  assert.equal(def.container, 'bluemap');
  assert.equal(blueMapPlayersOptions({ BLUEMAP_PLAYERS_POLL_MS: '10' }).pollMs, 1000); // clamped
  assert.equal(blueMapPlayersOptions({ BLUEMAP_PLAYERS_IDLE_POLL_MS: '4000' }).idlePollMs, 4000);
  assert.equal(blueMapPlayersOptions({ BLUEMAP_PLAYERS_IDLE_POLL_MS: '10' }).idlePollMs, 1000); // clamped
});

const POS = { x: 10, y: 64, z: -5, dimension: 'minecraft:overworld', mapId: 'overworld', yaw: 90, pitch: 0 };

test('controller writes players.json for all three maps + one skin, reusing cached skins and dirs', async () => {
  const dockerClient = fakeDockerClient();
  const online = [{ name: 'Steve', uid: UUID, identityKind: 'minecraft', position: POS }];
  const serverService = {
    liveOnlineWithPositions: async () => online,
  };
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
  const ctl = createBlueMapPlayersController({
    dockerClient, serverService, logger: { error() {}, debug() {} }, env: {}, fetchImpl,
  });

  const r = await ctl.tick();
  assert.equal(r.players, 1);
  assert.equal(dockerClient.writes.length, 3);
  assert.equal(dockerClient.execCalls.length, 1); // the one mkdir
  // Head PNG written under EACH map's own asset root (that's where BlueMap v5
  // loads it from), fetched only once and reused across maps.
  assert.equal(fetches, 1);
  assert.deepEqual(dockerClient.bytes.map((b) => b[0]).sort(), [
    `/app/web/maps/end/assets/playerheads/${UUID}.png`,
    `/app/web/maps/nether/assets/playerheads/${UUID}.png`,
    `/app/web/maps/overworld/assets/playerheads/${UUID}.png`,
  ]);
  const nether = JSON.parse(dockerClient.writes.find((w) => w[0].includes('/nether/'))[1]);
  assert.equal(nether.players[0].foreign, true);

  // Second tick: position re-written, skin NOT re-fetched (cached this process),
  // and the mkdir NOT re-run (dirs are created once and only re-checked after a
  // failed tick).
  dockerClient.writes.length = 0;
  dockerClient.bytes.length = 0;
  await ctl.tick();
  assert.equal(dockerClient.writes.length, 3);
  assert.equal(dockerClient.bytes.length, 0);
  assert.equal(fetches, 1);
  assert.equal(dockerClient.execCalls.length, 1); // still just the first mkdir
});

test('controller clears markers once when empty, then idles with zero docker calls', async () => {
  const dockerClient = fakeDockerClient();
  const serverService = { liveOnlineWithPositions: async () => [] };
  const ctl = createBlueMapPlayersController({ dockerClient, serverService, logger: { error() {} }, env: {} });

  assert.deepEqual(await ctl.tick(), { players: 0 });
  assert.equal(dockerClient.writes.length, 3);
  assert.equal(dockerClient.writes[0][1], '{"players":[]}');
  assert.equal(dockerClient.execCalls.length, 1); // mkdir for the clear write

  dockerClient.writes.length = 0;
  assert.deepEqual(await ctl.tick(), { players: 0 }); // already empty → early out
  assert.equal(dockerClient.writes.length, 0);
  assert.equal(dockerClient.execCalls.length, 1);    // no mkdir, no writes — nothing
});

test('controller skips live rows without a resolvable Mojang UUID', async () => {
  const dockerClient = fakeDockerClient();
  const serverService = {
    liveOnlineWithPositions: async () => [
      { name: 'NoUuid', uid: null, identityKind: 'minecraft', position: POS },        // unresolved uid → skipped
      { name: 'BadUuid', uid: '../../etc', identityKind: 'minecraft', position: POS }, // not 32-hex → skipped
      { name: 'Steve', uid: UUID, identityKind: 'minecraft', position: POS },          // ok
    ],
  };
  const ctl = createBlueMapPlayersController({
    dockerClient, serverService, logger: { error() {}, debug() {} }, env: {}, fetchImpl: async () => ({ ok: false }),
  });
  const r = await ctl.tick();
  assert.equal(r.players, 1);               // only Steve has a valid UUID
  const ow = JSON.parse(dockerClient.writes.find((w) => w[0].includes('/overworld/'))[1]);
  assert.equal(ow.players.length, 1);
  assert.equal(ow.players[0].name, 'Steve');
});

test('tick degrades quietly: a persistent docker failure logs error once, then debug', async () => {
  const errs = [], dbgs = [];
  const dockerClient = fakeDockerClient({}, {
    exec: async () => { throw new Error('bluemap container down'); }, // ensureDirs fails
  });
  const serverService = {
    liveOnlineWithPositions: async () => [{ name: 'Steve', uid: UUID, identityKind: 'minecraft', position: POS }],
  };
  const ctl = createBlueMapPlayersController({
    dockerClient, serverService, env: {}, fetchImpl: async () => ({ ok: false }),
    logger: { error: (...a) => errs.push(a), debug: (...a) => dbgs.push(a), warn() {} },
  });
  assert.ok((await ctl.tick()).error);
  assert.ok((await ctl.tick()).error);
  assert.equal(errs.length, 1);   // first failure at error level
  assert.ok(dbgs.length >= 1);    // subsequent failures dropped to debug (no 2s spam)
});

test('a failed tick re-arms ensureDirs: the next tick re-runs mkdir, then caches again', async () => {
  let execCount = 0;
  let failing = true;
  const dockerClient = fakeDockerClient({}, {
    exec: async () => {
      execCount++;
      if (failing) throw new Error('docker-proxy blip');
      return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false };
    },
  });
  const serverService = {
    liveOnlineWithPositions: async () => [{ name: 'Steve', uid: UUID, identityKind: 'minecraft', position: POS }],
  };
  const ctl = createBlueMapPlayersController({
    dockerClient, serverService, env: {}, fetchImpl: async () => ({ ok: false }),
    logger: { error() {}, debug() {} },
  });
  assert.ok((await ctl.tick()).error);          // mkdir threw → tick fails
  failing = false;
  assert.equal((await ctl.tick()).players, 1);  // mkdir retried (recreated container case)
  assert.equal(execCount, 2);
  assert.equal((await ctl.tick()).players, 1);  // and cached once it succeeded
  assert.equal(execCount, 2);
});

test('tick surfaces a non-zero mkdir exit (ensureDirs reads exitCode/stderr)', async () => {
  const errs = [];
  const dockerClient = fakeDockerClient({}, {
    exec: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'mkdir: read-only file system', truncated: false }),
  });
  const serverService = {
    liveOnlineWithPositions: async () => [{ name: 'Steve', uid: UUID, identityKind: 'minecraft', position: POS }],
  };
  const ctl = createBlueMapPlayersController({
    dockerClient, serverService, env: {}, fetchImpl: async () => ({ ok: false }),
    logger: { error: (...a) => errs.push(a), debug() {}, warn() {} },
  });
  const r = await ctl.tick();
  assert.ok(r.error);
  assert.match(r.error.message, /bluemap mkdir failed/);
  assert.match(r.error.message, /read-only file system/);
  assert.equal(dockerClient.writes.length, 0); // no players.json written after a failed mkdir
});

test('disabled players controller does nothing', async () => {
  const dockerClient = fakeDockerClient();
  const ctl = createBlueMapPlayersController({
    dockerClient,
    serverService: { liveOnlineWithPositions: async () => [] },
    env: { BLUEMAP_PLAYERS_AUTOWRITE: '0' },
  });
  assert.equal(await ctl.tick(), null);
  assert.equal(ctl.start(), false);
  assert.equal(dockerClient.writes.length, 0);
});

// ── CPU tuner ───────────────────────────────────────────────────────────────────

test('targetBlueMapCpus gives idle most cores while reserving host capacity', () => {
  assert.equal(targetBlueMapCpus({ onlineCount: 0, hostCpus: 32, reservedCpus: 4 }), 28);
  assert.equal(targetBlueMapCpus({ onlineCount: 1, hostCpus: 32, activeCpus: 2 }), 2);
  assert.equal(targetBlueMapCpus({ onlineCount: 0, hostCpus: 4, reservedCpus: 4 }), 1);
  assert.equal(targetBlueMapCpus({ onlineCount: 0, hostCpus: 8, idleCpus: 6 }), 6);
});

test('blueMapResourceOptions reads env toggles and defaults', () => {
  const opts = blueMapResourceOptions({
    BLUEMAP_RESOURCE_AUTOTUNE: 'false',
    BLUEMAP_CONTAINER: 'map',
    BLUEMAP_RESOURCE_POLL_SECONDS: '15',
    BLUEMAP_ACTIVE_CPUS: '3',
  });
  assert.equal(opts.enabled, false);
  assert.equal(opts.container, 'map');
  assert.equal(opts.pollMs, 15_000);
  assert.equal(opts.activeCpus, 3);
  assert.equal(opts.idleCpus, 0);
});

test('resource controller applies idle and active cpu caps, fetching host NCPU once', async () => {
  const calls = [];
  let nodeStatusCalls = 0;
  let online = 0;
  const dockerClient = {
    nodeStatus: async () => { nodeStatusCalls++; return { ncpu: 32 }; },
    setNanoCpus: async (container, nanoCpus) => { calls.push([container, nanoCpus]); return { ok: true }; },
  };
  const logger = { info() {}, error() {} };
  const ctl = createBlueMapResourceController({
    dockerClient,
    countOnline: () => online,
    logger,
    env: { BLUEMAP_IDLE_DELAY_SECONDS: '0' },
  });

  assert.deepEqual(await ctl.tick(), {
    container: 'bluemap', mode: 'idle', onlineCount: 0, cpus: 28, hostCpus: 32,
  });
  online = 1;
  assert.deepEqual(await ctl.tick(), {
    container: 'bluemap', mode: 'active', onlineCount: 1, cpus: 2, hostCpus: 32,
  });
  assert.deepEqual(calls, [
    ['bluemap', 28_000_000_000],
    ['bluemap', 2_000_000_000],
  ]);
  assert.equal(nodeStatusCalls, 1); // NCPU is static — fetched once, then cached
});

test('resource controller waits before ramping back up after players leave', async () => {
  let t = 1_000;
  let online = 1;
  const calls = [];
  const ctl = createBlueMapResourceController({
    dockerClient: {
      nodeStatus: async () => ({ ncpu: 16 }),
      setNanoCpus: async (_container, nanoCpus) => { calls.push(nanoCpus); },
    },
    countOnline: () => online,
    logger: { info() {}, error() {} },
    env: { BLUEMAP_IDLE_DELAY_SECONDS: '300' },
    now: () => t,
  });

  assert.equal((await ctl.tick()).mode, 'active');
  online = 0;
  assert.equal((await ctl.tick()).mode, 'active');
  t += 301_000;
  assert.equal((await ctl.tick()).mode, 'idle');
  assert.deepEqual(calls, [2_000_000_000, 12_000_000_000]);
});

test('a throwing countOnline fails safe to the active cap (assume someone is online)', async () => {
  const calls = [];
  const ctl = createBlueMapResourceController({
    dockerClient: {
      nodeStatus: async () => ({ ncpu: 16 }),
      setNanoCpus: async (_container, nanoCpus) => { calls.push(nanoCpus); },
    },
    countOnline: () => { throw new Error('sqlite unavailable'); },
    logger: { info() {}, error() {}, debug() {} },
    env: {},
  });
  const r = await ctl.tick();
  assert.equal(r.mode, 'active');
  assert.equal(r.onlineCount, 1);            // presumed-online, not 0
  assert.equal(r.cpus, 2);                   // default activeCpus — renderer stays capped low
  assert.deepEqual(calls, [2_000_000_000]);
});
