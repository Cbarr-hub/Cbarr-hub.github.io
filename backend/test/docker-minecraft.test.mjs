import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDockerClient, withRconCapture, withEnv } from './harness.mjs';
import { buildConnector } from '../src/servers/connectors/engine.js';
import { minecraftSpec, parseMinecraftPlayerList } from '../src/servers/connectors/specs/minecraft.js';

// The live-action/control/sendCommand/update command canon for the Minecraft
// connector is pinned in connector-goldens.test.mjs; this file keeps the
// server.properties profile-logic tests plus the per-game quirks (world
// discovery, online-player parsing, BlueMap positions) — all driven through the
// spec surface (engine buildConnector + minecraftSpec).

const MC = { id: 'minecraft', name: 'Minecraft', backend: 'docker', container: 'minecraft', port: 25565 };
const PROPS = '/data/server.properties';

const mcConn = (files = {}) => buildConnector(MC, minecraftSpec, fakeDockerClient(files));
const defaults = () => minecraftSpec.profile.defaults();
const validate = (s) => minecraftSpec.profile.validate(null, s);

// applyProps/captureProps equivalents: round-trip the server.properties text
// through a built connector over the harness fake (the spec reads/writes PROPS).
async function applyProps(text, settings) {
  const client = fakeDockerClient({ [PROPS]: text });
  await buildConnector(MC, minecraftSpec, client).applyProfileSettings(settings);
  return client.files[PROPS];
}
const captureProps = (text) => mcConn({ [PROPS]: text }).captureProfileSettings();

// ── server.properties profile logic (via the spec surface) ───────────────────────
test('mc-profile validate normalizes enums + rejects bad values', () => {
  const base = defaults();
  assert.equal(validate({ ...base, gamemode: 'nope' }).gamemode, 'survival'); // falls back
  assert.equal(validate({ ...base, difficulty: 'x' }).difficulty, 'normal');
  assert.throws(() => validate({ ...base, maxPlayers: 0 }), /max players/);
  assert.throws(() => validate({ ...base, viewDistance: 99 }), /view distance/);
  assert.throws(() => validate({ ...base, world: 'bad name!' }), /invalid world/);
});

test('mc-profile applyProps writes the server.properties keys', async () => {
  const text = 'level-name=world\nmax-players=20\nmotd=old\n';
  const out = await applyProps(text, {
    world: 'world_GTown', gamemode: 'creative', difficulty: 'hard', maxPlayers: 8, motd: 'Hi',
    pvp: '0', hardcore: '1', whitelist: '1', onlineMode: '0', viewDistance: 16, spawnProtection: 0,
  });
  assert.match(out, /level-name=world_GTown/);
  assert.match(out, /gamemode=creative/);
  assert.match(out, /difficulty=hard/);
  assert.match(out, /max-players=8/);
  assert.match(out, /pvp=false/);
  assert.match(out, /hardcore=true/);
  assert.match(out, /white-list=true/);
  assert.match(out, /online-mode=false/);
  assert.match(out, /view-distance=16/);
  assert.match(out, /spawn-protection=0/);
});

test('mc-profile empty world keeps the current level-name', async () => {
  const out = await applyProps('level-name=keepme\n', { ...defaults(), world: '' });
  assert.match(out, /level-name=keepme/);
});

test('mc-profile captureProps round-trips server.properties (bools as 1/0)', async () => {
  const c = await captureProps(
    'level-name=W\ngamemode=adventure\ndifficulty=peaceful\nmax-players=5\nmotd=Srv\n' +
    'pvp=false\nhardcore=true\nwhite-list=true\nonline-mode=false\nview-distance=12\nspawn-protection=4\n');
  assert.equal(c.world, 'W');
  assert.equal(c.gamemode, 'adventure');
  assert.equal(c.difficulty, 'peaceful');
  assert.equal(c.maxPlayers, 5);
  assert.equal(c.pvp, '0');
  assert.equal(c.hardcore, '1');
  assert.equal(c.whitelist, '1');
  assert.equal(c.onlineMode, '0');
  assert.equal(c.viewDistance, 12);
});

test('mc-profile groups are World / Gameplay / Access', async () => {
  const { groups: g } = await mcConn().profileSchema();
  assert.deepEqual(g.map((x) => x.key), ['world', 'gameplay', 'access']);
  assert.ok(g[1].fields.some((f) => f.key === 'gamemode' && f.type === 'select'));
  assert.ok(g[2].fields.some((f) => f.key === 'whitelist' && f.type === 'bool'));
});

// ── expanded server.properties fields (allow-nether / monsters / cmd blocks / sim / idle) ──
test('mc-profile defaults seed the new server.properties fields', () => {
  const d = defaults();
  assert.equal(d.allowNether, '1');
  assert.equal(d.spawnMonsters, '1');
  assert.equal(d.commandBlocks, '0');
  assert.equal(d.simulationDistance, 10);
  assert.equal(d.playerIdleTimeout, 0);
});

test('mc-profile validate bounds simulationDistance + playerIdleTimeout, coerces bools', () => {
  const base = defaults();
  assert.throws(() => validate({ ...base, simulationDistance: 2 }), /simulation distance/);
  assert.throws(() => validate({ ...base, simulationDistance: 33 }), /simulation distance/);
  assert.throws(() => validate({ ...base, playerIdleTimeout: -1 }), /idle timeout/);
  assert.throws(() => validate({ ...base, playerIdleTimeout: 1441 }), /idle timeout/);
  const ok = validate({ ...base, simulationDistance: 32, playerIdleTimeout: 30, allowNether: true, spawnMonsters: '0', commandBlocks: '1' });
  assert.equal(ok.simulationDistance, 32);
  assert.equal(ok.playerIdleTimeout, 30);
  assert.equal(ok.allowNether, '1');
  assert.equal(ok.spawnMonsters, '0');
  assert.equal(ok.commandBlocks, '1');
});

test('mc-profile applyProps + captureProps round-trip the new keys', async () => {
  const out = await applyProps('level-name=world\n', {
    ...defaults(),
    allowNether: '0', spawnMonsters: '0', commandBlocks: '1',
    simulationDistance: 12, playerIdleTimeout: 15,
  });
  assert.match(out, /allow-nether=false/);
  assert.match(out, /spawn-monsters=false/);
  assert.match(out, /enable-command-block=true/);
  assert.match(out, /simulation-distance=12/);
  assert.match(out, /player-idle-timeout=15/);
  const c = await captureProps(out);
  assert.equal(c.allowNether, '0');
  assert.equal(c.spawnMonsters, '0');
  assert.equal(c.commandBlocks, '1');
  assert.equal(c.simulationDistance, 12);
  assert.equal(c.playerIdleTimeout, 15);
});

test('mc-profile Gameplay group exposes the new structured fields', async () => {
  const { groups: g } = await mcConn().profileSchema();
  const gameplay = g.find((x) => x.key === 'gameplay').fields;
  for (const k of ['allowNether', 'spawnMonsters', 'commandBlocks']) {
    assert.ok(gameplay.some((f) => f.key === k && f.type === 'bool'), `${k} bool`);
  }
  for (const k of ['simulationDistance', 'playerIdleTimeout']) {
    assert.ok(gameplay.some((f) => f.key === k && f.type === 'number'), `${k} number`);
  }
});

test('mc-profile cvarRef catalogs on-disk keys with bounds', async () => {
  const { cvarRef } = await mcConn().profileSchema();
  const byName = Object.fromEntries(cvarRef.map((c) => [c.name, c]));
  assert.equal(byName['simulation-distance'].min, 3);
  assert.equal(byName['simulation-distance'].max, 32);
  assert.equal(byName['player-idle-timeout'].max, 1440);
  assert.equal(byName['allow-nether'].type, 'bool');
  assert.equal(byName['enable-command-block'].default, 'false');
});

// ── built connector wires the shared groups + a world picker ─────────────────────
function captureMinecraftRcon(run, responder) {
  return withEnv('MINECRAFT_RCON_PASSWORD', 'secret', () =>
    withRconCapture({ responder: responder ?? (() => '') }, async ({ port }) => {
      const conn = buildConnector({ ...MC, container: '127.0.0.1', rconPort: port }, minecraftSpec, fakeDockerClient());
      await run(conn);
    })).then((r) => r.commands);
}

test('Minecraft profileSchema groups World/Gameplay/Access with a world picker + cvarRef', async () => {
  const conn = mcConn({ [PROPS]: 'level-name=world\n' });
  const { groups, cvarRef } = await conn.profileSchema();
  assert.deepEqual(groups.map((g) => g.key), ['world', 'gameplay', 'access']);
  const worldField = groups[0].fields.find((f) => f.key === 'world');
  assert.ok(worldField.options.some((o) => o.value === '')); // keep-current option present
  assert.ok(Array.isArray(cvarRef) && cvarRef.length); // reference catalog is embedded
});

// World discovery uses the in-container /data layout.
test('Minecraft profileSchema discovers /data worlds with the level.dat find command', async () => {
  const client = fakeDockerClient({ [PROPS]: 'level-name=active\n' });
  client.execStdout = 'active\ncreative_world\n';
  const conn = buildConnector(MC, minecraftSpec, client);
  const { groups } = await conn.profileSchema();
  assert.ok(client.execCalls.some((c) => c.command.join(' ').includes('find "/data" -maxdepth 2 -name level.dat')));
  const options = groups[0].fields.find((f) => f.key === 'world').options.map((o) => o.value);
  assert.deepEqual(options, ['', 'active', 'creative_world']);
});

test('Minecraft listOnlinePlayers parses the RCON list output', async () => {
  assert.deepEqual(parseMinecraftPlayerList('There are 0 of a max of 20 players online:'), []);
  assert.deepEqual(
    parseMinecraftPlayerList('There are 2 of a max of 20 players online: dheagman, Alex_2'),
    ['dheagman', 'Alex_2'],
  );
  assert.deepEqual(parseMinecraftPlayerList('There are 1 of a max of 20 players online: bad name'), []);

  let players;
  const commands = await captureMinecraftRcon(async (conn) => {
    players = await conn.listOnlinePlayers();
  }, () => 'There are 1 of a max of 20 players online: dheagman');
  assert.deepEqual(commands, ['list']);
  assert.deepEqual(players, [{ name: 'dheagman', uid: null, identityKind: 'minecraft' }]);
});

test('listOnlinePlayers short-circuits without MINECRAFT_RCON_PASSWORD', async () => {
  await withEnv('MINECRAFT_RCON_PASSWORD', undefined, async () => {
    // Spy RCON server: every issued command lands in `commands`. With no password set,
    // listOnlinePlayers must return [] AND never touch the socket (zero commands).
    const { commands } = await withRconCapture(
      { responder: () => 'There are 1 of a max of 20 players online: dheagman' },
      async ({ port }) => {
        const conn = buildConnector({ ...MC, container: '127.0.0.1', rconPort: port }, minecraftSpec, fakeDockerClient());
        assert.deepEqual(await conn.listOnlinePlayers(), []);
      });
    assert.deepEqual(commands, []);
  });
});

test('Minecraft getPlayerPosition parses position, dimension, and BlueMap anchor', async () => {
  let position;
  const commands = await captureMinecraftRcon(async (conn) => {
    position = await conn.getPlayerPosition('Notch');
  }, (command) => {
    if (command.endsWith(' Pos')) return 'Notch has the following entity data: [12.5d, 65.0d, -30.25d]';
    if (command.endsWith(' Dimension')) return 'Notch has the following entity data: "minecraft:the_nether"';
    if (command.endsWith(' Rotation')) return 'Notch has the following entity data: [90.0f, 10.0f]';
    return '';
  });
  assert.deepEqual(commands.sort(), [
    'data get entity Notch Dimension',
    'data get entity Notch Pos',
    'data get entity Notch Rotation',
  ]);
  assert.equal(position.mapId, 'nether');
  assert.equal(position.dimension, 'minecraft:the_nether');
  assert.equal(position.x, 12.5);
  assert.equal(position.y, 65);
  assert.equal(position.z, -30.25);
  assert.equal(position.yaw, 90);
  assert.equal(position.pitch, 10);
  assert.equal(position.anchor, 'nether:13:65:-30:390:0.1:0.19:0:0:perspective');
});

// An offline / just-left player has no entity to query — RCON answers "No entity was
// found" (no vector), so getPlayerPosition must RESOLVE to the graceful offline shape
// (mirroring Factorio) rather than throwing BAD_SETTING → HTTP 400 at the map UI.
test('Minecraft getPlayerPosition returns offline shape when the player has no entity', async () => {
  let position;
  await captureMinecraftRcon(async (conn) => {
    position = await conn.getPlayerPosition('Notch');
  }, (command) => {
    if (command.endsWith(' Pos')) return 'No entity was found';
    if (command.endsWith(' Dimension')) return 'No entity was found';
    return '';
  });
  assert.equal(position.connected, false);
  assert.equal(typeof position.reason, 'string');
  assert.ok(position.reason.length);
  assert.equal(position.name, 'Notch');

  // The vector path is unaffected: a real Pos reply still parses to a position.
  let online;
  await captureMinecraftRcon(async (conn) => {
    online = await conn.getPlayerPosition('Notch');
  }, (command) => {
    if (command.endsWith(' Pos')) return '[12.5d, 65.0d, -30.25d]';
    if (command.endsWith(' Dimension')) return '"minecraft:overworld"';
    return '';
  });
  assert.equal(online.connected, undefined); // online result carries no `connected` flag
  assert.equal(online.x, 12.5);
  assert.equal(online.y, 65);
  assert.equal(online.z, -30.25);
});
