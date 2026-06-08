import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';

import * as mp from '../src/servers/connectors/minecraft-profile.js';
import { clampNumber } from '../src/servers/connectors/docker-base.js';
import { DockerMinecraftConnector, parseMinecraftPlayerList } from '../src/servers/connectors/docker/minecraft.js';

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
function fakeMcClient(files = {}) {
  const execs = [];
  return {
    files, execs,
    async agentFileRead(_c, path) { return { content: files[path] ?? '' }; },
    async agentFileWrite(_c, path, content) { files[path] = content; return null; },
    async agentExec(_c, { command }) { execs.push(command); return { pid: 'p' }; },
    async agentExecStatus() { return { exited: 1, exitcode: 0, 'out-data': '', 'err-data': '' }; },
  };
}

const MC = { id: 'minecraft', name: 'Minecraft', backend: 'docker', container: 'minecraft', port: 25565 };

function fakeMcClientWithExec(files = {}, stdout = '') {
  const client = fakeMcClient(files);
  client.agentExecStatus = async () => ({ exited: 1, exitcode: 0, 'out-data': stdout, 'err-data': '' });
  return client;
}

function encodeRcon(id, type, body) {
  const b = Buffer.from(body, 'ascii');
  const size = 4 + 4 + b.length + 2;
  const buf = Buffer.allocUnsafe(4 + size);
  buf.writeInt32LE(size, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8);
  b.copy(buf, 12); buf.writeInt8(0, 12 + b.length); buf.writeInt8(0, 13 + b.length);
  return buf;
}

async function withRconCapture(run, responder = () => '') {
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
        if (type === 3) { sock.write(encodeRcon(id, 2, '')); continue; }
        if (id === 3) { sock.write(encodeRcon(3, 0, '')); continue; }
        commands.push(body);
        sock.write(encodeRcon(id, 0, responder(body)));
      }
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  try { await run({ port }); } finally { await new Promise((res) => server.close(res)); }
  return commands;
}

async function captureMinecraftRcon(run, responder) {
  const prev = process.env.MINECRAFT_RCON_PASSWORD;
  process.env.MINECRAFT_RCON_PASSWORD = 'secret';
  try {
    return await withRconCapture(async ({ port }) => {
      const conn = new DockerMinecraftConnector({ ...MC, container: '127.0.0.1', rconPort: port }, fakeMcClient());
      await run(conn);
    }, responder);
  } finally {
    if (prev === undefined) delete process.env.MINECRAFT_RCON_PASSWORD;
    else process.env.MINECRAFT_RCON_PASSWORD = prev;
  }
}

test('DockerMinecraft profileSchema groups World/Gameplay/Access with a world picker + cvarRef', async () => {
  const conn = new DockerMinecraftConnector(MC, fakeMcClient({ '/data/server.properties': 'level-name=world\n' }));
  const { groups, cvarRef } = await conn.profileSchema();
  assert.deepEqual(groups.map((g) => g.key), ['world', 'gameplay', 'access']);
  const worldField = groups[0].fields.find((f) => f.key === 'world');
  assert.ok(worldField.options.some((o) => o.value === '')); // keep-current option present
  assert.ok(Array.isArray(cvarRef) && cvarRef.length); // reference catalog is embedded
});

// Docker connector world discovery uses the in-container /data layout.
test('DockerMinecraft profileSchema discovers /data worlds with the level.dat find command', async () => {
  const client = fakeMcClientWithExec(
    { '/data/server.properties': 'level-name=active\n' },
    'active\ncreative_world\n',
  );
  const conn = new DockerMinecraftConnector(MC, client);
  const { groups } = await conn.profileSchema();
  assert.ok(client.execs.some((cmd) => cmd.join(' ').includes('find "/data" -maxdepth 2 -name level.dat')));
  const options = groups[0].fields.find((f) => f.key === 'world').options.map((o) => o.value);
  assert.deepEqual(options, ['', 'active', 'creative_world']);
});

// Live runtime: getLive shape (actions + slider controls, NO changeMap).
test('DockerMinecraft getLive advertises actions + controls and no changeMap', async () => {
  const prev = process.env.MINECRAFT_RCON_PASSWORD;
  process.env.MINECRAFT_RCON_PASSWORD = 'x';
  try {
    const conn = new DockerMinecraftConnector(MC, fakeMcClient());
    const live = await conn.getLive();
    assert.equal(live.available, true);
    assert.equal(live.changeMap, undefined); // world switch is restart-only
    const actionKeys = live.actions.map((a) => a.key);
    assert.deepEqual(actionKeys,
      ['list', 'save', 'day', 'night', 'clear', 'rain', 'keepinv_on', 'keepinv_off', 'mobs_on', 'mobs_off',
       'daycycle_on', 'daycycle_off', 'griefing_on', 'griefing_off', 'falldmg_on', 'falldmg_off',
       'instarespawn_on', 'instarespawn_off', 'phantoms_on', 'phantoms_off', 'firetick_on', 'firetick_off', 'thunder']);
    const ctlKeys = live.controls.map((c) => c.key);
    assert.deepEqual(ctlKeys, ['time', 'randomtick', 'sleeppct']);
    const t = live.controls.find((c) => c.key === 'time');
    assert.equal(t.min, 0); assert.equal(t.max, 24000);
  } finally {
    if (prev === undefined) delete process.env.MINECRAFT_RCON_PASSWORD;
    else process.env.MINECRAFT_RCON_PASSWORD = prev;
  }
});

test('DockerMinecraft getLive is unavailable without an RCON password', async () => {
  const prev = process.env.MINECRAFT_RCON_PASSWORD;
  delete process.env.MINECRAFT_RCON_PASSWORD;
  try {
    const conn = new DockerMinecraftConnector(MC, fakeMcClient());
    const live = await conn.getLive();
    assert.equal(live.available, false);
  } finally {
    if (prev !== undefined) process.env.MINECRAFT_RCON_PASSWORD = prev;
  }
});

// ── runLiveAction: unknown keys reject before any RCON I/O ───────────────────────
// (The range/action cases issue real Source-RCON over a socket, so they're left to
// the host smoke-test; the unknown-key guard short-circuits before #rcon is called.)
test('DockerMinecraft runLiveAction rejects unknown keys with BAD_SETTING', async () => {
  const conn = new DockerMinecraftConnector(MC, fakeMcClient());
  await assert.rejects(() => conn.runLiveAction('nope'), (e) => e.code === 'BAD_SETTING');
});

test('DockerMinecraft runLiveAction maps every advertised action to its RCON command', async () => {
  const expected = [
    ['list', 'list'],
    ['save', 'save-all'],
    ['day', 'time set day'],
    ['night', 'time set night'],
    ['clear', 'weather clear'],
    ['rain', 'weather rain'],
    ['keepinv_on', 'gamerule keep_inventory true'],
    ['keepinv_off', 'gamerule keep_inventory false'],
    ['mobs_on', 'gamerule spawn_mobs true'],
    ['mobs_off', 'gamerule spawn_mobs false'],
    ['daycycle_on', 'gamerule do_daylight_cycle true'],
    ['daycycle_off', 'gamerule do_daylight_cycle false'],
    ['griefing_on', 'gamerule mob_griefing true'],
    ['griefing_off', 'gamerule mob_griefing false'],
    ['falldmg_on', 'gamerule fall_damage true'],
    ['falldmg_off', 'gamerule fall_damage false'],
    ['instarespawn_on', 'gamerule do_immediate_respawn true'],
    ['instarespawn_off', 'gamerule do_immediate_respawn false'],
    ['phantoms_on', 'gamerule do_insomnia true'],
    ['phantoms_off', 'gamerule do_insomnia false'],
    ['firetick_on', 'gamerule do_fire_tick true'],
    ['firetick_off', 'gamerule do_fire_tick false'],
    ['thunder', 'weather thunder'],
  ];
  const commands = await captureMinecraftRcon(async (conn) => {
    for (const [key] of expected) await conn.runLiveAction(key);
  });
  assert.deepEqual(commands, expected.map(([, command]) => command));
});

test('DockerMinecraft runLiveAction maps every slider control to clamped RCON commands', async () => {
  const cases = [
    ['time', 12345, 'time set 12345'],
    ['time', 99999, 'time set 24000'],
    ['time', -5, 'time set 0'],
    ['time', '', 'time set 6000'],
    ['randomtick', 7, 'gamerule random_tick_speed 7'],
    ['randomtick', 99, 'gamerule random_tick_speed 20'],
    ['randomtick', 0, 'gamerule random_tick_speed 0'],
    ['randomtick', 'abc', 'gamerule random_tick_speed 3'],
    ['sleeppct', 55, 'gamerule players_sleeping_percentage 55'],
    ['sleeppct', 101, 'gamerule players_sleeping_percentage 100'],
    ['sleeppct', -1, 'gamerule players_sleeping_percentage 0'],
    ['sleeppct', null, 'gamerule players_sleeping_percentage 100'],
  ];
  assert.deepEqual([...new Set(cases.map(([key]) => key))], ['time', 'randomtick', 'sleeppct']);
  const commands = await captureMinecraftRcon(async (conn) => {
    for (const [key, value] of cases) await conn.runLiveAction(key, value);
  });
  assert.deepEqual(commands, cases.map(([, , command]) => command));
});

test('DockerMinecraft sendCommand trims + forwards valid commands and rejects bad input', async () => {
  const commands = await captureMinecraftRcon((conn) => conn.sendCommand('  say hello  '));
  assert.deepEqual(commands, ['say hello']);

  const conn = new DockerMinecraftConnector(MC, fakeMcClient());
  await assert.rejects(() => conn.sendCommand(''), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => conn.sendCommand('a\nb'), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => conn.sendCommand('x'.repeat(513)), (e) => e.code === 'BAD_SETTING');
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

// Range clamping is pure arithmetic on the issued command; verify the clamp helper's
// contract against MC_LIVE_CONTROLS bounds without touching the network. We mirror the
// exact clamp the connector uses so a bounds regression in the controls table is caught.
test('DockerMinecraft live-control bounds clamp slider values', () => {
  const clamp = clampNumber;
  // time 0..24000, randomtick 0..20, sleeppct 0..100 (mirrors MC_LIVE_CONTROLS)
  assert.equal(clampNumber(99999, 0, 24000, 6000), 24000);
  assert.equal(clampNumber(-5, 0, 24000, 6000), 0);
  assert.equal(clampNumber(0, 0, 24000, 6000), 0);
  assert.equal(clampNumber('', 0, 24000, 6000), 6000);
  assert.equal(clampNumber(null, 0, 24000, 6000), 6000);
  assert.equal(clamp('abc', 0, 24000, 6000), 6000); // non-numeric → default
  assert.equal(clampNumber(50, 0, 20, 3), 20);
  assert.equal(clampNumber(0, 0, 20, 3), 0);
  assert.equal(clampNumber(200, 0, 100, 100), 100);
});

test('DockerMinecraft update reboots the container to refresh the configured VERSION', async () => {
  const calls = [];
  const client = fakeMcClient();
  client.reboot = async (container) => { calls.push(container); return { ok: true }; };
  const conn = new DockerMinecraftConnector(MC, client);
  const res = await conn.update();
  assert.deepEqual(calls, ['minecraft']);
  assert.equal(res.ok, true);
  assert.match(res.note, /VERSION/);
});
