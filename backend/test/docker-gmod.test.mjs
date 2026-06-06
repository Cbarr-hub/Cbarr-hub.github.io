import assert from 'node:assert/strict';
import test from 'node:test';

import { DockerGmodConnector } from '../src/servers/connectors/docker/gmod.js';
import { DockerPropHuntConnector } from '../src/servers/connectors/docker/prophunt.js';
import {
  GMOD_LIVE_ACTIONS, GMOD_ACTION_CMDS, GMOD_LIVE_CONTROLS, gmodRangeCmd,
} from '../src/servers/connectors/gmod.js';

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
    // expanded TTT_FIELDS (round + roles groups)
    prepTime: 45, haste: '0', hasteStart: 6, postroundDm: '1', allTalk: '0',
    detMinPlayers: 4, creditsStart: 3, karma: '1', karmaAutokick: '1', karmaBan: '0',
  };
  await conn.applyProfileSettings(profile);

  // mapcycle.txt is written verbatim (boot map first)
  assert.equal(files[CYCLE].trim(), 'ttt_clue\nttt_minecraft_b5');
  // bool cvars serialize to quoted 0/1 in the game cfg
  assert.match(files[GAME], /sv_alltalk\s+"0"/);
  assert.match(files[GAME], /ttt_karma_low_autokick\s+"1"/);

  const cap = await conn.captureProfileSettings();
  assert.equal(cap.maxPlayers, 24);
  assert.equal(cap.workshopCollection, '12345');
  assert.deepEqual(cap.mapcycle, ['ttt_clue', 'ttt_minecraft_b5']);
  assert.equal(cap.useMapcycle, '1');
  assert.equal(cap.roundLimit, 8);
  assert.equal(cap.minPlayers, 3);
  assert.equal(cap.traitorMax, 30);
  assert.equal(cap.detectiveMax, 20);
  // expanded fields round-trip (bool stays '1'/'0'-derived number, numeric stays number)
  assert.equal(cap.prepTime, 45);
  assert.equal(cap.allTalk, 0);
  assert.equal(cap.karmaAutokick, 1);
  assert.equal(cap.creditsStart, 3);
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
  // typed PH_CVARS: bools stay '1'/'0' strings, numerics default when absent
  assert.equal(cap.luckyBalls, '1');
  assert.equal(cap.roundTime, 250);
  assert.equal(cap.blindTime, 30);
  assert.equal(cap.propJump, 1.4);

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

// ── expanded TTT validation enforces the new field bounds ────────────────────────
test('Gmod validateProfileSettings enforces expanded TTT_FIELDS bounds', async () => {
  const conn = new DockerGmodConnector(GMOD, fakeDockerClient());
  const base = conn.defaultProfileSettings();
  // a fully-defaulted doc validates
  assert.doesNotThrow(() => conn.validateProfileSettings(base));
  // prepTime out of bounds (5–120) rejected
  assert.throws(() => conn.validateProfileSettings({ ...base, prepTime: 1 }), /Prep Time/);
  // detMinPlayers above its max (32) rejected
  assert.throws(() => conn.validateProfileSettings({ ...base, detMinPlayers: 99 }), /Min Players for Det/);
  // bool field accepts 0/1 (the UI sends '1'/'0')
  const ok = conn.validateProfileSettings({ ...base, haste: '0', allTalk: '1' });
  assert.equal(ok.haste, 0);
  assert.equal(ok.allTalk, 1);
});

// ── new live actions/cmds present + range cvars clamp to bounds ───────────────────
test('Gmod live actions cover restart_round/cleanup/alltalk and ranges clamp', () => {
  const keys = GMOD_LIVE_ACTIONS.map((a) => a.key);
  for (const k of ['restart_round', 'cleanup', 'alltalk_on', 'alltalk_off']) assert.ok(keys.includes(k), k);
  assert.equal(GMOD_ACTION_CMDS.restart_round, 'ttt_roundrestart');
  assert.equal(GMOD_ACTION_CMDS.cleanup, 'gmod_admin_cleanup');

  // new range controls exist
  const ctlKeys = GMOD_LIVE_CONTROLS.map((c) => c.key);
  assert.ok(ctlKeys.includes('traitor_pct'));
  assert.ok(ctlKeys.includes('round_limit'));
  // traitor_pct clamps to 0.05–0.5
  assert.equal(gmodRangeCmd('traitor_pct', 99), 'ttt_traitor_pct 0.5');
  assert.equal(gmodRangeCmd('traitor_pct', 0), 'ttt_traitor_pct 0.05');
  // round_limit clamps + rounds (1–15)
  assert.equal(gmodRangeCmd('round_limit', 99), 'ttt_round_limit 15');
  assert.equal(gmodRangeCmd('round_limit', 0), 'ttt_round_limit 1');
  // unknown key → null (falls through to the action map)
  assert.equal(gmodRangeCmd('nope', 1), null);
});

// ── getLive advertises the expanded actions + controls ───────────────────────────
test('Gmod getLive shape exposes new actions + controls when RCON is set', async () => {
  process.env.GMOD_RCON_PASSWORD = 'secret';
  const conn = new DockerGmodConnector(GMOD, fakeDockerClient());
  const live = await conn.getLive();
  assert.equal(live.available, true);
  assert.ok(live.actions.some((a) => a.key === 'restart_round'));
  assert.ok(live.controls.some((c) => c.key === 'traitor_pct'));
  assert.equal(live.changeMap, true);
  delete process.env.GMOD_RCON_PASSWORD;
});

// ── unified importCollection writes wscollectionid + returns the unified shape ────
test('Gmod importCollection writes wscollectionid and returns requiresRestart:true', async () => {
  const files = { [INST]: 'defaultmap="gm_construct"\n' };
  const conn = new DockerGmodConnector(GMOD, fakeDockerClient(files));
  const res = await conn.importCollection('  3736674438  ');
  assert.match(files[INST], /wscollectionid="3736674438"/);
  assert.equal(res.ok, true);
  assert.equal(res.requiresRestart, true);
  assert.ok(Array.isArray(res.maps));
  assert.ok(Array.isArray(res.members));
  assert.match(res.note, /3736674438/);
  // non-digit collection ids are rejected
  await assert.rejects(() => conn.importCollection('not-an-id'), (e) => e.code === 'BAD_SETTING');
});

// PropHunt inherits importCollection unchanged, writing ITS instance cfg.
test('DockerPropHunt inherits importCollection (same route, requiresRestart:true)', async () => {
  const files = { [INST]: 'gamemode="prop_hunt"\n' };
  const conn = new DockerPropHuntConnector(PH, fakeDockerClient(files));
  const res = await conn.importCollection('3737190377');
  assert.match(files[INST], /wscollectionid="3737190377"/);
  assert.equal(res.requiresRestart, true);
});

// ── PH apply must NOT write wscollectionid (X2Z mount bug fix) ────────────────────
test('PropHunt applyProfileSettings does not write wscollectionid', async () => {
  const files = {
    [INST]: 'gamemode="prop_hunt"\ndefaultmap="ph_office"\nmaxplayers="16"\n', // no wscollectionid line
    [GAME]: '', [ACTIVE]: '',
  };
  const conn = new DockerPropHuntConnector(PH, fakeDockerClient(files));
  const profile = { ...conn.defaultProfileSettings(), propHuntMap: 'ph_restaurant', workshopCollection: '999999' };
  await conn.applyProfileSettings(profile);
  // defaultmap + maxplayers are written, wscollectionid is left untouched (absent)
  assert.match(files[INST], /defaultmap="ph_restaurant"/);
  assert.ok(!/wscollectionid/.test(files[INST]), 'apply must not introduce wscollectionid');
});

// ── PH typed cvars: numeric bounds enforced + getLive merges PH sliders ──────────
test('PropHunt validates numeric PH_CVARS bounds and exposes PH sliders', async () => {
  process.env.PROPHUNT_RCON_PASSWORD = 'pw';
  const conn = new DockerPropHuntConnector(PH, fakeDockerClient());
  const base = conn.defaultProfileSettings();
  assert.doesNotThrow(() => conn.validateProfileSettings(base));
  assert.throws(() => conn.validateProfileSettings({ ...base, roundTime: 10 }), /Round Time/);   // min 60
  assert.throws(() => conn.validateProfileSettings({ ...base, blindTime: 99 }), /Hide Time/);    // max 60
  assert.throws(() => conn.validateProfileSettings({ ...base, roundsPerMap: 1.5 }), /whole number/);

  const live = await conn.getLive();
  const ctlKeys = live.controls.map((c) => c.key);
  assert.ok(ctlKeys.includes('gravity'));        // shared GMOD slider
  assert.ok(ctlKeys.includes('ph_round_time'));  // PH-specific slider
  assert.ok(ctlKeys.includes('ph_blind_time'));
  assert.ok(live.actions.some((a) => a.key === 'luckyballs_on'));
  delete process.env.PROPHUNT_RCON_PASSWORD;
});

// ── cvarRef is embedded in both schemas (Raw Config autocomplete source) ─────────
test('Gmod + PropHunt profileSchema embeds a cvarRef built from their field tables', async () => {
  const gmod = new DockerGmodConnector(GMOD, fakeDockerClient());
  const gs = await gmod.profileSchema();
  assert.ok(Array.isArray(gs.cvarRef) && gs.cvarRef.length);
  assert.ok(gs.cvarRef.some((c) => c.name === 'ttt_traitor_pct' && c.type === 'number'));
  assert.ok(gs.cvarRef.some((c) => c.name === 'sv_alltalk' && c.type === 'bool'));

  const ph = new DockerPropHuntConnector(PH, fakeDockerClient());
  const ps = await ph.profileSchema();
  assert.ok(Array.isArray(ps.cvarRef) && ps.cvarRef.length);
  assert.ok(ps.cvarRef.some((c) => c.name === 'ph_round_time' && c.type === 'number'));
  assert.ok(ps.cvarRef.some((c) => c.name === 'ph_enable_lucky_balls' && c.type === 'bool'));
});
