import assert from 'node:assert/strict';
import test from 'node:test';

import * as mp from '../src/servers/connectors/minecraft-profile.js';
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

test('DockerMinecraft profileSchema groups World/Gameplay/Access with a world picker', async () => {
  const conn = new DockerMinecraftConnector(MC, fakeMcClient({ '/data/server.properties': 'level-name=world\n' }));
  const { groups } = await conn.profileSchema();
  assert.deepEqual(groups.map((g) => g.key), ['world', 'gameplay', 'access']);
  const worldField = groups[0].fields.find((f) => f.key === 'world');
  assert.ok(worldField.options.some((o) => o.value === '')); // keep-current option present
});
