import assert from 'node:assert/strict';
import test from 'node:test';

import { DockerGmodConnector } from '../src/servers/connectors/docker/gmod.js';
import { DockerPropHuntConnector } from '../src/servers/connectors/docker/prophunt.js';

// In-container LinuxGSM paths (gsmDir = /data), derived by GmodConnector.paths.
const INST  = '/data/lgsm/config-lgsm/gmodserver/gmodserver.cfg';
const GAME  = '/data/serverfiles/garrysmod/cfg/gmodserver.cfg';
const CYCLE = '/data/serverfiles/garrysmod/mapcycle.txt';
const ACTIVE = '/data/serverfiles/garrysmod/cfg/gamertown/active.cfg';

const GMOD = { id: 'gmod', name: 'TTT', backend: 'docker', container: 'gmod', port: 27066 };
const PH   = { id: 'prophunt', name: 'Prop Hunt', backend: 'docker', container: 'prophunt', port: 27067 };

function fakeDockerClient(files = {}) {
  return {
    files,
    async statusCurrent() { return { status: 'running', uptime: 9, cpu: 0.05, mem: 100, maxmem: 2000 }; },
    async agentFileRead(_c, path) { return { content: files[path] ?? '' }; },
    async agentFileWrite(_c, path, content) { files[path] = content; return null; },
    async agentExec() { return { pid: 'p' }; },
    async agentExecStatus() { return { exited: 1, exitcode: 0, 'out-data': '', 'err-data': '' }; },
    start() {}, shutdown() {}, reboot() {},
  };
}

// ── locator + container-is-game ─────────────────────────────────────────────────
test('DockerGmod uses the container as locator and treats running == hosting', async () => {
  const conn = new DockerGmodConnector(GMOD, fakeDockerClient());
  assert.equal(conn.vmid, 'gmod');
  const s = await conn.status();
  assert.equal(s.status, 'running');
  assert.equal(s.gameStatus, 'hosting');
});

// ── TTT profile apply -> capture round-trip through the container cfgs ───────────
test('DockerGmod applyProfileSettings -> captureProfileSettings round-trips', async () => {
  const files = { [INST]: '', [GAME]: '', [CYCLE]: '' };
  const conn = new DockerGmodConnector(GMOD, fakeDockerClient(files));
  const profile = {
    maxPlayers: 24, workshopCollection: '12345',          // collection set -> boot-map guard is skipped
    useMapcycle: '1', mapcycle: ['ttt_clue', 'ttt_minecraft_b5'],
    roundLimit: 8, timeLimit: 60, traitorPct: 0.25, traitorMax: 30,
    detectivePct: 0.13, detectiveMax: 20, minPlayers: 3,
  };
  await conn.applyProfileSettings(profile);

  // mapcycle.txt is written verbatim (boot map first)
  assert.equal(files[CYCLE].trim(), 'ttt_clue\nttt_minecraft_b5');

  const cap = await conn.captureProfileSettings();
  assert.equal(cap.maxPlayers, 24);
  assert.equal(cap.workshopCollection, '12345');
  assert.deepEqual(cap.mapcycle, ['ttt_clue', 'ttt_minecraft_b5']);
  assert.equal(cap.useMapcycle, '1');
  assert.equal(cap.roundLimit, 8);
  assert.equal(cap.minPlayers, 3);
  assert.equal(cap.traitorMax, 30);
  assert.equal(cap.detectiveMax, 20);
});

// ── live RCON gated on the env password (TCP transport, not in-guest python) ─────
test('DockerGmod live control is gated on GMOD_RCON_PASSWORD', async () => {
  delete process.env.GMOD_RCON_PASSWORD;
  const conn = new DockerGmodConnector(GMOD, fakeDockerClient());
  assert.equal((await conn.getLive()).available, false);
  // sendCommand without a password fails fast (no socket opened)
  await assert.rejects(() => conn.sendCommand('status'), (e) => e.code === 'NO_RCON');

  process.env.GMOD_RCON_PASSWORD = 'secret';
  assert.equal((await conn.getLive()).available, true);
  delete process.env.GMOD_RCON_PASSWORD;
});

// ── Prop Hunt: capture the PH profile + gate RCON on its own env key ─────────────
test('DockerPropHunt captures the X2Z profile and gates RCON on PROPHUNT_RCON_PASSWORD', async () => {
  const files = {
    [INST]: 'gamemode="prop_hunt"\ndefaultmap="ph_office"\nmaxplayers="20"\nwscollectionid="3737190377"\n',
    [GAME]: 'phx_verbose 1\n',
    [ACTIVE]: 'sv_gravity 600\n',
  };
  const conn = new DockerPropHuntConnector(PH, fakeDockerClient(files));
  assert.equal(conn.vmid, 'prophunt');

  const cap = await conn.captureProfileSettings();
  assert.equal(cap.propHuntMap, 'ph_office');
  assert.equal(cap.maxPlayers, 20);
  assert.equal(cap.workshopCollection, '3737190377');
  assert.equal(cap.verboseLog, '1');
  assert.equal(cap.rawConfig.trim(), 'sv_gravity 600');

  delete process.env.PROPHUNT_RCON_PASSWORD;
  assert.equal((await conn.getLive()).available, false);
  process.env.PROPHUNT_RCON_PASSWORD = 'pw';
  assert.equal((await conn.getLive()).available, true);
  delete process.env.PROPHUNT_RCON_PASSWORD;
});

// ── writeConfig has no chown-back (the in-container exec already runs as the user) ─
test('DockerPropHunt.writeConfig writes the file without a chown step', async () => {
  const files = { [ACTIVE]: '' };
  const execs = [];
  const client = fakeDockerClient(files);
  const origExec = client.agentExec;
  client.agentExec = async (c, args) => { execs.push(args.command); return origExec(c, args); };
  const conn = new DockerPropHuntConnector(PH, client);
  await conn.writeConfig('active.cfg', 'phx_verbose 1');
  assert.equal(files[ACTIVE], 'phx_verbose 1');
  assert.ok(!execs.some((cmd) => String(cmd).includes('chown')), 'no chown exec should run');
});
