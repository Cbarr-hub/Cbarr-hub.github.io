import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';

import { DockerGmodConnector } from '../src/servers/connectors/docker/gmod.js';
import { DockerPropHuntConnector } from '../src/servers/connectors/docker/prophunt.js';
import {
  GMOD_LIVE_ACTIONS, GMOD_ACTION_CMDS, GMOD_LIVE_CONTROLS,
  GMOD_SHARED_LIVE_CONTROLS, TTT_LIVE_CONTROLS, gmodRangeCmd,
} from '../src/servers/connectors/gmod.js';

// In-container LinuxGSM paths (gsmDir = /data), derived by GmodConnector.paths.
const INST  = '/data/lgsm/config-lgsm/gmodserver/gmodserver.cfg';
const GAME  = '/data/serverfiles/garrysmod/cfg/gmodserver.cfg';
const CYCLE = '/data/serverfiles/garrysmod/mapcycle.txt';
const ACTIVE = '/data/serverfiles/garrysmod/cfg/gamertown/active.cfg';

const GMOD = { id: 'gmod', name: 'TTT', backend: 'docker', container: 'gmod', port: 27066 };
const PH   = { id: 'prophunt', name: 'Prop Hunt', backend: 'docker', container: 'prophunt', port: 27067 };

function fakeDockerClient(files = {}) {
  const execs = [];
  return {
    files, execs,
    async statusCurrent() { return { status: 'running', uptime: 9, cpu: 0.05, mem: 100, maxmem: 2000 }; },
    async agentFileRead(_c, path) { return { content: files[path] ?? '' }; },
    async agentFileWrite(_c, path, content) { files[path] = content; return null; },
    async agentExec(_c, { command }) { execs.push(command); return { pid: 'p' }; },
    async agentExecStatus() { return { exited: 1, exitcode: 0, 'out-data': '', 'err-data': '' }; },
    start() {}, shutdown() {}, reboot() {},
  };
}

function encodeRcon(id, type, body) {
  const b = Buffer.from(body, 'ascii');
  const size = 4 + 4 + b.length + 2;
  const buf = Buffer.allocUnsafe(4 + size);
  buf.writeInt32LE(size, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8);
  b.copy(buf, 12); buf.writeInt8(0, 12 + b.length); buf.writeInt8(0, 13 + b.length);
  return buf;
}

async function withRconCapture(run) {
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
      }
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  try { await run({ port }); } finally { await new Promise((res) => server.close(res)); }
  return { command: commands[0] ?? null, commands };
}

async function captureGmodRcon(run) {
  const prev = process.env.GMOD_RCON_PASSWORD;
  try {
    process.env.GMOD_RCON_PASSWORD = 'secret';
    return await withRconCapture(async ({ port }) => {
      const conn = new DockerGmodConnector({ ...GMOD, container: '127.0.0.1', port }, fakeDockerClient());
      await run(conn);
    });
  } finally {
    if (prev === undefined) delete process.env.GMOD_RCON_PASSWORD;
    else process.env.GMOD_RCON_PASSWORD = prev;
  }
}

async function capturePhRcon(run) {
  const prev = process.env.PROPHUNT_RCON_PASSWORD;
  try {
    process.env.PROPHUNT_RCON_PASSWORD = 'secret';
    return await withRconCapture(async ({ port }) => {
      const conn = new DockerPropHuntConnector({ ...PH, container: '127.0.0.1', port }, fakeDockerClient());
      await run(conn);
    });
  } finally {
    if (prev === undefined) delete process.env.PROPHUNT_RCON_PASSWORD;
    else process.env.PROPHUNT_RCON_PASSWORD = prev;
  }
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

// ── capture tolerates a mixed-case mapcycle.txt (lowercases boot map AND rotation) ─
test('DockerGmod captureProfileSettings lowercases a mixed-case mapcycle.txt', async () => {
  // A defaultmap/mapcycle set out-of-band can carry a mixed-case Workshop title; the
  // rotation lines (not just the boot map) must be lowercased or validate's
  // lowercase-only MAP_NAME_RE makes capture throw (HTTP 400).
  const files = {
    [INST]: 'defaultmap="ttt_clue_se"\nmaxplayers="16"\n',
    [GAME]: '',
    [CYCLE]: 'Ttt_Clue_SE\nttt_dolls\n',
  };
  const conn = new DockerGmodConnector(GMOD, fakeDockerClient(files));
  let cap;
  await assert.doesNotReject(async () => { cap = await conn.captureProfileSettings(); });
  assert.deepEqual(cap.mapcycle, ['ttt_clue_se', 'ttt_dolls']);
});

// ── live RCON gated on the env password (TCP transport, not in-guest python) ─────
test('DockerGmod live control is gated on GMOD_RCON_PASSWORD', async () => {
  const prev = process.env.GMOD_RCON_PASSWORD;
  try {
    delete process.env.GMOD_RCON_PASSWORD;
    const conn = new DockerGmodConnector(GMOD, fakeDockerClient());
    assert.equal((await conn.getLive()).available, false);
    // sendCommand without a password fails fast (no socket opened)
    await assert.rejects(() => conn.sendCommand('status'), (e) => e.code === 'NO_RCON');

    process.env.GMOD_RCON_PASSWORD = 'secret';
    assert.equal((await conn.getLive()).available, true);
  } finally {
    if (prev === undefined) delete process.env.GMOD_RCON_PASSWORD;
    else process.env.GMOD_RCON_PASSWORD = prev;
  }
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
  assert.deepEqual(GMOD_SHARED_LIVE_CONTROLS.map((c) => c.key), ['gravity', 'timescale']);
  assert.ok(TTT_LIVE_CONTROLS.map((c) => c.key).includes('traitor_pct'));
  assert.equal(gmodRangeCmd('traitor_pct', 0.25, GMOD_SHARED_LIVE_CONTROLS), null);
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
test('DockerGmod getLive advertises the exact TTT runtime inventory', async () => {
  const prev = process.env.GMOD_RCON_PASSWORD;
  try {
    process.env.GMOD_RCON_PASSWORD = 'secret';
    const conn = new DockerGmodConnector(GMOD, fakeDockerClient());
    const live = await conn.getLive();
    assert.equal(live.available, true);
    assert.deepEqual(live.actions.map((a) => a.key),
      ['restart_round', 'cleanup', 'bhop_on', 'bhop_off', 'alltalk_on', 'alltalk_off',
       'cheats_on', 'cheats_off', 'players']);
    assert.deepEqual(live.controls.map((c) => c.key), ['gravity', 'timescale', 'traitor_pct', 'round_limit']);
    assert.equal(live.changeMap, true);
    assert.match(live.commandHint, /ttt_round_limit/);
  } finally {
    if (prev === undefined) delete process.env.GMOD_RCON_PASSWORD;
    else process.env.GMOD_RCON_PASSWORD = prev;
  }
});

test('DockerGmod runLiveAction sends every advertised TTT button action', async () => {
  const expected = {
    restart_round: 'ttt_roundrestart',
    cleanup: 'gmod_admin_cleanup',
    bhop_on: 'sv_cheats 1; sv_airaccelerate 1000',
    bhop_off: 'sv_airaccelerate 12',
    alltalk_on: 'sv_alltalk 1',
    alltalk_off: 'sv_alltalk 0',
    cheats_on: 'sv_cheats 1',
    cheats_off: 'sv_cheats 0',
    players: 'status',
  };
  assert.deepEqual(GMOD_LIVE_ACTIONS.map((a) => a.key), Object.keys(expected));
  assert.deepEqual(Object.keys(GMOD_ACTION_CMDS), Object.keys(expected));
  for (const [key, commandText] of Object.entries(expected)) {
    const { command } = await captureGmodRcon((conn) => conn.runLiveAction(key));
    assert.equal(command, commandText, key);
  }
});

test('DockerGmod runLiveAction sends every advertised TTT slider control', async () => {
  const expected = {
    gravity: ['sv_gravity 600', 600],
    timescale: ['sv_cheats 1; host_timescale 1', 1],
    traitor_pct: ['ttt_traitor_pct 0.25', 0.25],
    round_limit: ['ttt_round_limit 6', 6],
  };
  assert.deepEqual(GMOD_LIVE_CONTROLS.map((c) => c.key), Object.keys(expected));
  for (const control of GMOD_LIVE_CONTROLS) {
    assert.equal(control.default, expected[control.key][1], control.key);
    const { command } = await captureGmodRcon((conn) => conn.runLiveAction(control.key, control.default));
    assert.equal(command, expected[control.key][0], control.key);
  }
});

test('DockerGmod runLiveAction clamps TTT slider commands to bounds', async () => {
  const cases = [
    ['gravity', 99999, 'sv_gravity 1000'],
    ['gravity', -1, 'sv_gravity 0'],
    ['timescale', 99, 'sv_cheats 1; host_timescale 3'],
    ['timescale', 0, 'sv_cheats 1; host_timescale 0.25'],
    ['traitor_pct', 99, 'ttt_traitor_pct 0.5'],
    ['traitor_pct', 0, 'ttt_traitor_pct 0.05'],
    ['round_limit', 99, 'ttt_round_limit 15'],
    ['round_limit', 0, 'ttt_round_limit 1'],
  ];
  for (const [key, value, commandText] of cases) {
    const { command } = await captureGmodRcon((conn) => conn.runLiveAction(key, value));
    assert.equal(command, commandText, key);
  }
});

test('DockerGmod runLiveAction changes maps and rejects invalid live keys', async () => {
  assert.equal((await captureGmodRcon((conn) => conn.runLiveAction('change_map', 'ttt_minecraft_b5'))).command,
    'changelevel ttt_minecraft_b5');
  assert.equal((await captureGmodRcon((conn) => conn.runLiveAction('change_map', 'gm_construct'))).command,
    'changelevel gm_construct');

  const conn = new DockerGmodConnector(GMOD, fakeDockerClient());
  await assert.rejects(() => conn.runLiveAction('change_map', 'bad map!'), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => conn.runLiveAction('bogus_action'), (e) => e.code === 'BAD_SETTING');
});

test('DockerGmod sendCommand trims, forwards, and rejects bad console input', async () => {
  const { command } = await captureGmodRcon((conn) => conn.sendCommand('  status  '));
  assert.equal(command, 'status');

  const conn = new DockerGmodConnector(GMOD, fakeDockerClient());
  await assert.rejects(() => conn.sendCommand(''), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => conn.sendCommand('status\nquit'), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => conn.sendCommand('x'.repeat(513)), (e) => e.code === 'BAD_SETTING');
});

test('DockerGmod update runs the LinuxGSM gmodserver update command in-container', async () => {
  const client = fakeDockerClient();
  client.agentExecStatus = async () => ({ exited: 1, exitcode: 0, 'out-data': 'updated', 'err-data': '' });
  const conn = new DockerGmodConnector(GMOD, client);
  const res = await conn.update();
  assert.equal(res.ok, true);
  assert.deepEqual(client.execs.at(-1), ['/bin/bash', '-lc', '/data/gmodserver update']);
  assert.equal(res.steps[0].name, 'gmodserver update');
  assert.match(res.note, /LinuxGSM/);
});

test('DockerGmod syncMaps extracts workshop maps with the in-container GMOD paths', async () => {
  const client = fakeDockerClient();
  const conn = new DockerGmodConnector(GMOD, client);
  const res = await conn.syncMaps();
  assert.deepEqual(res, { ok: true, maps: [] });

  assert.equal(client.execs[0][0], '/bin/bash');
  assert.equal(client.execs[0][1], '-lc');
  const syncScript = client.execs[0][2];
  assert.match(syncScript, /\/data\/serverfiles\/garrysmod\/cache\/srcds\/\*\.gma/);
  assert.match(syncScript, /\/data\/serverfiles\/steam_cache\/content\/4000\/\*\/\*\.gma/);
  assert.match(syncScript, /"\/data\/serverfiles\/bin\/gmad_linux" extract/);
  assert.match(syncScript, /cp -n \{\} \/data\/serverfiles\/garrysmod\/maps\//);

  assert.equal(client.execs[1][0], '/bin/bash');
  assert.equal(client.execs[1][1], '-lc');
  assert.match(client.execs[1][2], /ls -1 \/data\/serverfiles\/garrysmod\/maps\/\*\.bsp/);
});

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
  assert.ok(!ctlKeys.includes('traitor_pct'));
  assert.ok(!ctlKeys.includes('round_limit'));
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

// ── PH sliders clamp via clampNumber: a literal 0 hits the MIN, not the default ────
test('DockerPropHunt ph_round_time/ph_blind_time sliders clamp (0 → min, not default)', async () => {
  // ph_round_time: bounds 60–600, default 250.
  assert.equal((await capturePhRcon((c) => c.runLiveAction('ph_round_time', '0'))).command, 'ph_round_time 60');
  assert.equal((await capturePhRcon((c) => c.runLiveAction('ph_round_time', ''))).command, 'ph_round_time 250');
  assert.equal((await capturePhRcon((c) => c.runLiveAction('ph_round_time', '9999'))).command, 'ph_round_time 600');
  // ph_blind_time: bounds 10–60, default 30.
  assert.equal((await capturePhRcon((c) => c.runLiveAction('ph_blind_time', '0'))).command, 'ph_hunter_blindlock_time 10');
  assert.equal((await capturePhRcon((c) => c.runLiveAction('ph_blind_time', ''))).command, 'ph_hunter_blindlock_time 30');
});

// ── container model: gameRunning is true via the mixin, never an `ss` port-grep ────
test('DockerGmod gameRunning resolves via the container model, not the ss port-grep', async () => {
  const client = fakeDockerClient();
  const conn = new DockerGmodConnector(GMOD, client);
  assert.equal(await conn.gameRunning(), true);
  // no `ss -tuln` (or any ss invocation) is ever execed — the container IS the game.
  assert.ok(!client.execs.some((argv) => argv.some((a) => /\bss\s+-tuln\b/.test(String(a)))),
    'gameRunning must not shell out to ss -tuln');
});

test('DockerPropHunt gameRunning resolves via the container model, not the ss port-grep', async () => {
  const client = fakeDockerClient();
  const conn = new DockerPropHuntConnector(PH, client);
  assert.equal(await conn.gameRunning(), true);
  assert.ok(!client.execs.some((argv) => argv.some((a) => /\bss\s+-tuln\b/.test(String(a)))),
    'gameRunning must not shell out to ss -tuln');
});
