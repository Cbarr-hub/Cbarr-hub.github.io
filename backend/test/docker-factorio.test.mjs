import assert from 'node:assert/strict';
import test from 'node:test';

import * as fp from '../src/servers/connectors/factorio-profile.js';
import { DockerFactorioConnector } from '../src/servers/connectors/docker/factorio.js';

// ── pure profile module ─────────────────────────────────────────────────────────
test('factorio-profile validate normalizes + rejects bad values', () => {
  const base = fp.defaultProfileSettings();
  assert.equal(fp.validateProfileSettings({ ...base, visibility: 'nope' }).visibility, 'lan');
  assert.throws(() => fp.validateProfileSettings({ ...base, maxPlayers: 999 }), /max players/);
  assert.throws(() => fp.validateProfileSettings({ ...base, autosaveInterval: 0 }), /autosave/);
  assert.throws(() => fp.validateProfileSettings({ ...base, saveName: 'bad name!' }), /invalid world/);
});

test('factorio-profile applyServerSettings + captureServerSettings round-trip', () => {
  const v = fp.validateProfileSettings({
    ...fp.defaultProfileSettings(), serverName: 'GT', description: 'd',
    maxPlayers: 12, visibility: 'public', password: 'pw', autosaveInterval: 7,
  });
  const json = fp.applyServerSettings({}, v);
  assert.equal(json.name, 'GT');
  assert.equal(json.max_players, 12);
  assert.deepEqual(json.visibility, { public: true, lan: true });
  assert.equal(json.game_password, 'pw');
  assert.equal(json.autosave_interval, 7);

  const c = fp.captureServerSettings(json);
  assert.equal(c.serverName, 'GT');
  assert.equal(c.visibility, 'public');
  assert.equal(c.maxPlayers, 12);
});

test('factorio-profile groups are World + Server Settings', () => {
  const g = fp.profileGroups([{ value: '', label: 'x' }]);
  assert.deepEqual(g.map((x) => x.key), ['world', 'server']);
});

// ── Docker connector ────────────────────────────────────────────────────────────
function fakeFctrClient(files = {}) {
  const execs = [];
  return {
    files, execs,
    async statusCurrent() { return { status: 'running', uptime: 1 }; },
    async agentFileRead(_c, path) { return { content: files[path] ?? '' }; },
    async agentFileWrite(_c, path, content) { files[path] = content; return null; },
    async agentExec(_c, { command }) { execs.push(command); return { pid: 'p' }; },
    async agentExecStatus() { return { exited: 1, exitcode: 0, 'out-data': '', 'err-data': '' }; },
  };
}

const FCTR = { id: 'factorio', name: 'Factorio', backend: 'docker', container: 'factorio', port: 34197 };
const SS = '/factorio/config/server-settings.json';

test('DockerFactorio applyProfileSettings writes server-settings.json + stages the active world', async () => {
  const client = fakeFctrClient({ [SS]: '{}' });
  const conn = new DockerFactorioConnector(FCTR, client);
  await conn.applyProfileSettings({
    saveName: 'myworld', serverName: 'GTown', description: 'hi',
    maxPlayers: 5, visibility: 'public', password: 'p', autosaveInterval: 7,
  });
  const json = JSON.parse(client.files[SS]);
  assert.equal(json.name, 'GTown');
  assert.equal(json.max_players, 5);
  assert.equal(json.game_password, 'p');
  // active world staged as _active.zip via cp
  assert.ok(client.execs.some((c) => c.join(' ').includes('myworld.zip') && c.join(' ').includes('_active.zip')));
});

test('DockerFactorio captureProfileSettings reads server-settings (world = keep current)', async () => {
  const client = fakeFctrClient({ [SS]: JSON.stringify({
    name: 'Srv', max_players: 8, visibility: { public: false, lan: true },
    game_password: '', autosave_interval: 15,
  }) });
  const conn = new DockerFactorioConnector(FCTR, client);
  const c = await conn.captureProfileSettings();
  assert.equal(c.serverName, 'Srv');
  assert.equal(c.maxPlayers, 8);
  assert.equal(c.visibility, 'lan');
  assert.equal(c.saveName, ''); // container loads _active.zip; original name not recoverable
});

test('DockerFactorio getLive is unavailable without an rconpw file', async () => {
  const conn = new DockerFactorioConnector(FCTR, fakeFctrClient());
  assert.equal((await conn.getLive()).available, false);
});

test('DockerFactorio getLive is available once rconpw is readable', async () => {
  const conn = new DockerFactorioConnector(FCTR, fakeFctrClient({ '/factorio/config/rconpw': 'secret\n' }));
  const live = await conn.getLive();
  assert.equal(live.available, true);
  assert.deepEqual(live.actions.map((a) => a.key), ['players', 'time']);
});
