import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDockerClient, withRconCapture, withEnv } from './harness.mjs';
import * as mp from '../src/servers/connectors/minecraft-profile.js';
import { DockerMinecraftConnector, parseMinecraftPlayerList } from '../src/servers/connectors/docker/minecraft.js';

// The live-action/control/sendCommand/update command canon for the Minecraft
// connector is pinned in connector-goldens.test.mjs; this file keeps the pure
// minecraft-profile module tests plus the per-game quirks (world discovery,
// online-player parsing, BlueMap positions).

// ── pure profile module (shared server.properties logic) ─────────────────────────
test('mc-profile validate normalizes enums + rejects bad values', () => {
  const base = mp.defaultProfileSettings();
  assert.equal(mp.validateProfileSettings({ ...base, gamemode: 'nope' }).gamemode, 'survival'); // falls back
  assert.equal(mp.validateProfileSettings({ ...base, difficulty: 'x' }).difficulty, 'normal');
  assert.throws(() => mp.validateProfileSettings({ ...base, maxPlayers: 0 }), /max players/);
  assert.throws(() => mp.validateProfileSettings({ ...base, viewDistance: 99 }), /view distance/);
  assert.throws(() => mp.validateProfileSettings({ ...base, world: 'bad name!' }), /invalid world/);
});

test('mc-profile applyProps writes the server.properties keys', () => {
  const text = 'level-name=world\nmax-players=20\nmotd=old\n';
  const out = mp.applyProps(text, {
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

test('mc-profile empty world keeps the current level-name', () => {
  const out = mp.applyProps('level-name=keepme\n', { ...mp.defaultProfileSettings(), world: '' });
  assert.match(out, /level-name=keepme/);
});

test('mc-profile captureProps round-trips server.properties (bools as 1/0)', () => {
  const c = mp.captureProps(
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

test('mc-profile groups are World / Gameplay / Access', () => {
  const g = mp.profileGroups([{ value: '', label: '(keep current world)' }]);
  assert.deepEqual(g.map((x) => x.key), ['world', 'gameplay', 'access']);
  assert.ok(g[1].fields.some((f) => f.key === 'gamemode' && f.type === 'select'));
  assert.ok(g[2].fields.some((f) => f.key === 'whitelist' && f.type === 'bool'));
});

// ── expanded server.properties fields (allow-nether / monsters / cmd blocks / sim / idle) ──
test('mc-profile defaults seed the new server.properties fields', () => {
  const d = mp.defaultProfileSettings();
  assert.equal(d.allowNether, '1');
  assert.equal(d.spawnMonsters, '1');
  assert.equal(d.commandBlocks, '0');
  assert.equal(d.simulationDistance, 10);
  assert.equal(d.playerIdleTimeout, 0);
});

test('mc-profile validate bounds simulationDistance + playerIdleTimeout, coerces bools', () => {
  const base = mp.defaultProfileSettings();
  assert.throws(() => mp.validateProfileSettings({ ...base, simulationDistance: 2 }), /simulation distance/);
  assert.throws(() => mp.validateProfileSettings({ ...base, simulationDistance: 33 }), /simulation distance/);
  assert.throws(() => mp.validateProfileSettings({ ...base, playerIdleTimeout: -1 }), /idle timeout/);
  assert.throws(() => mp.validateProfileSettings({ ...base, playerIdleTimeout: 1441 }), /idle timeout/);
  const ok = mp.validateProfileSettings({ ...base, simulationDistance: 32, playerIdleTimeout: 30, allowNether: true, spawnMonsters: '0', commandBlocks: '1' });
  assert.equal(ok.simulationDistance, 32);
  assert.equal(ok.playerIdleTimeout, 30);
  assert.equal(ok.allowNether, '1');
  assert.equal(ok.spawnMonsters, '0');
  assert.equal(ok.commandBlocks, '1');
});

test('mc-profile applyProps + captureProps round-trip the new keys', () => {
  const out = mp.applyProps('level-name=world\n', {
    ...mp.defaultProfileSettings(),
    allowNether: '0', spawnMonsters: '0', commandBlocks: '1',
    simulationDistance: 12, playerIdleTimeout: 15,
  });
  assert.match(out, /allow-nether=false/);
  assert.match(out, /spawn-monsters=false/);
  assert.match(out, /enable-command-block=true/);
  assert.match(out, /simulation-distance=12/);
  assert.match(out, /player-idle-timeout=15/);
  const c = mp.captureProps(out);
  assert.equal(c.allowNether, '0');
  assert.equal(c.spawnMonsters, '0');
  assert.equal(c.commandBlocks, '1');
  assert.equal(c.simulationDistance, 12);
  assert.equal(c.playerIdleTimeout, 15);
});

test('mc-profile Gameplay group exposes the new structured fields', () => {
  const g = mp.profileGroups([]);
  const gameplay = g.find((x) => x.key === 'gameplay').fields;
  for (const k of ['allowNether', 'spawnMonsters', 'commandBlocks']) {
    assert.ok(gameplay.some((f) => f.key === k && f.type === 'bool'), `${k} bool`);
  }
  for (const k of ['simulationDistance', 'playerIdleTimeout']) {
    assert.ok(gameplay.some((f) => f.key === k && f.type === 'number'), `${k} number`);
  }
});

test('mc-profile CVAR_REF catalogs on-disk keys with bounds', () => {
  const byName = Object.fromEntries(mp.CVAR_REF.map((c) => [c.name, c]));
  assert.equal(byName['simulation-distance'].min, 3);
  assert.equal(byName['simulation-distance'].max, 32);
  assert.equal(byName['player-idle-timeout'].max, 1440);
  assert.equal(byName['allow-nether'].type, 'bool');
  assert.equal(byName['enable-command-block'].default, 'false');
});

// ── Docker connector wires the shared groups + a world picker ────────────────────
const MC = { id: 'minecraft', name: 'Minecraft', backend: 'docker', container: 'minecraft', port: 25565 };

function captureMinecraftRcon(run, responder) {
  return withEnv('MINECRAFT_RCON_PASSWORD', 'secret', () =>
    withRconCapture({ responder: responder ?? (() => '') }, async ({ port }) => {
      const conn = new DockerMinecraftConnector({ ...MC, container: '127.0.0.1', rconPort: port }, fakeDockerClient());
      await run(conn);
    })).then((r) => r.commands);
}

test('DockerMinecraft profileSchema groups World/Gameplay/Access with a world picker + cvarRef', async () => {
  const conn = new DockerMinecraftConnector(MC, fakeDockerClient({ '/data/server.properties': 'level-name=world\n' }));
  const { groups, cvarRef } = await conn.profileSchema();
  assert.deepEqual(groups.map((g) => g.key), ['world', 'gameplay', 'access']);
  const worldField = groups[0].fields.find((f) => f.key === 'world');
  assert.ok(worldField.options.some((o) => o.value === '')); // keep-current option present
  assert.ok(Array.isArray(cvarRef) && cvarRef.length); // reference catalog is embedded
});

// Docker connector world discovery uses the in-container /data layout.
test('DockerMinecraft profileSchema discovers /data worlds with the level.dat find command', async () => {
  const client = fakeDockerClient({ '/data/server.properties': 'level-name=active\n' });
  client.execStdout = 'active\ncreative_world\n';
  const conn = new DockerMinecraftConnector(MC, client);
  const { groups } = await conn.profileSchema();
  assert.ok(client.execCalls.some((c) => c.command.join(' ').includes('find "/data" -maxdepth 2 -name level.dat')));
  const options = groups[0].fields.find((f) => f.key === 'world').options.map((o) => o.value);
  assert.deepEqual(options, ['', 'active', 'creative_world']);
});

test('DockerMinecraft listOnlinePlayers parses the RCON list output', async () => {
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
        const conn = new DockerMinecraftConnector({ ...MC, container: '127.0.0.1', rconPort: port }, fakeDockerClient());
        assert.deepEqual(await conn.listOnlinePlayers(), []);
      });
    assert.deepEqual(commands, []);
  });
});

test('DockerMinecraft getPlayerPosition parses position, dimension, and BlueMap anchor', async () => {
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
test('DockerMinecraft getPlayerPosition returns offline shape when the player has no entity', async () => {
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

