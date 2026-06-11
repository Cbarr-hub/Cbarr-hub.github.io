import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDockerClient } from './harness.mjs';
import {
  blueMapPlayersOptions,
  buildPlayersJson,
  createBlueMapPlayersController,
  normalizeUuid,
} from '../src/servers/bluemap-players.js';

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
  assert.equal(def.container, 'bluemap');
  assert.equal(blueMapPlayersOptions({ BLUEMAP_PLAYERS_POLL_MS: '10' }).pollMs, 1000); // clamped
});

const POS = { x: 10, y: 64, z: -5, dimension: 'minecraft:overworld', mapId: 'overworld', yaw: 90, pitch: 0 };

test('controller writes players.json for all three maps + one skin, reusing cached skins', async () => {
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

  // Second tick: position re-written, skin NOT re-fetched (cached this process).
  dockerClient.writes.length = 0;
  dockerClient.bytes.length = 0;
  await ctl.tick();
  assert.equal(dockerClient.writes.length, 3);
  assert.equal(dockerClient.bytes.length, 0);
  assert.equal(fetches, 1);
});

test('controller clears markers once when empty, then idles', async () => {
  const dockerClient = fakeDockerClient();
  const serverService = { liveOnlineWithPositions: async () => [] };
  const ctl = createBlueMapPlayersController({ dockerClient, serverService, logger: { error() {} }, env: {} });

  assert.deepEqual(await ctl.tick(), { players: 0 });
  assert.equal(dockerClient.writes.length, 3);
  assert.equal(dockerClient.writes[0][1], '{"players":[]}');

  dockerClient.writes.length = 0;
  assert.deepEqual(await ctl.tick(), { players: 0 }); // already empty → no writes
  assert.equal(dockerClient.writes.length, 0);
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

test('disabled controller does nothing', async () => {
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
