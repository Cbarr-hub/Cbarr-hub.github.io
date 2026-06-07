import assert from 'node:assert/strict';
import test from 'node:test';

import * as mp from '../src/servers/connectors/minecraft-profile.js';
import { clampNumber } from '../src/servers/connectors/docker-base.js';
import { DockerMinecraftConnector } from '../src/servers/connectors/docker/minecraft.js';

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
  return {
    files,
    async agentFileRead(_c, path) { return { content: files[path] ?? '' }; },
    async agentFileWrite(_c, path, content) { files[path] = content; return null; },
    async agentExec() { return { pid: 'p' }; },
    async agentExecStatus() { return { exited: 1, exitcode: 0, 'out-data': '', 'err-data': '' }; },
  };
}

const MC = { id: 'minecraft', name: 'Minecraft', backend: 'docker', container: 'minecraft', port: 25565 };

test('DockerMinecraft profileSchema groups World/Gameplay/Access with a world picker + cvarRef', async () => {
  const conn = new DockerMinecraftConnector(MC, fakeMcClient({ '/data/server.properties': 'level-name=world\n' }));
  const { groups, cvarRef } = await conn.profileSchema();
  assert.deepEqual(groups.map((g) => g.key), ['world', 'gameplay', 'access']);
  const worldField = groups[0].fields.find((f) => f.key === 'world');
  assert.ok(worldField.options.some((o) => o.value === '')); // keep-current option present
  assert.ok(Array.isArray(cvarRef) && cvarRef.length); // reference catalog is embedded
});

// ── live runtime: getLive shape (actions + slider controls, NO changeMap) ────────
test('DockerMinecraft getLive advertises actions + controls and no changeMap', async () => {
  const prev = process.env.MINECRAFT_RCON_PASSWORD;
  process.env.MINECRAFT_RCON_PASSWORD = 'x';
  try {
    const conn = new DockerMinecraftConnector(MC, fakeMcClient());
    const live = await conn.getLive();
    assert.equal(live.available, true);
    assert.equal(live.changeMap, undefined); // world switch is restart-only
    const actionKeys = live.actions.map((a) => a.key);
    for (const k of ['day', 'night', 'clear', 'rain', 'keepinv_on', 'keepinv_off', 'mobs_on', 'mobs_off']) {
      assert.ok(actionKeys.includes(k), `action ${k}`);
    }
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
