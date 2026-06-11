import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDockerClient } from './harness.mjs';
import { buildConnector } from '../src/servers/connectors/engine.js';
import { gmodSpec } from '../src/servers/connectors/specs/gmod.js';
import { prophuntSpec } from '../src/servers/connectors/specs/prophunt.js';

// The live-action/control/sendCommand/update command canon for both GMOD-family
// connectors is pinned in connector-goldens.test.mjs; this file keeps only the
// per-game QUIRK tests (profile round-trips, boot-map/collection invariants,
// validation bounds, map sync).

// In-container LinuxGSM paths (the shared /data layout in specs/gmod.js).
const INST  = '/data/lgsm/config-lgsm/gmodserver/gmodserver.cfg';
const GAME  = '/data/serverfiles/garrysmod/cfg/gmodserver.cfg';
const CYCLE = '/data/serverfiles/garrysmod/mapcycle.txt';
const ACTIVE = '/data/serverfiles/garrysmod/cfg/gamertown/active.cfg';

const GMOD = { id: 'gmod', name: 'TTT', backend: 'docker', container: 'gmod', port: 27066 };
const PH   = { id: 'prophunt', name: 'Prop Hunt', backend: 'docker', container: 'prophunt', port: 27067 };

const gmod = (clientOrFiles) => buildConnector(GMOD, gmodSpec,
  clientOrFiles?.exec ? clientOrFiles : fakeDockerClient(clientOrFiles));
const prophunt = (clientOrFiles) => buildConnector(PH, prophuntSpec,
  clientOrFiles?.exec ? clientOrFiles : fakeDockerClient(clientOrFiles));

// ── locator + container-is-game ─────────────────────────────────────────────────
test('gmod spec uses the container as locator and treats running == hosting', async () => {
  const conn = gmod();
  assert.equal(conn.vmid, 'gmod');
  const s = await conn.status();
  assert.equal(s.status, 'running');
  assert.equal(s.gameStatus, 'hosting');
});

// ── TTT profile apply -> capture round-trip through the container cfgs ───────────
test('gmod spec applyProfileSettings -> captureProfileSettings round-trips', async () => {
  const files = { [INST]: '', [GAME]: '', [CYCLE]: '' };
  const conn = gmod(files);
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
test('gmod spec captureProfileSettings lowercases a mixed-case mapcycle.txt', async () => {
  // A defaultmap/mapcycle set out-of-band can carry a mixed-case Workshop title; the
  // rotation lines (not just the boot map) must be lowercased or validate's
  // lowercase-only MAP_NAME_RE makes capture throw (HTTP 400).
  const files = {
    [INST]: 'defaultmap="ttt_clue_se"\nmaxplayers="16"\n',
    [GAME]: '',
    [CYCLE]: 'Ttt_Clue_SE\nttt_dolls\n',
  };
  const conn = gmod(files);
  let cap;
  await assert.doesNotReject(async () => { cap = await conn.captureProfileSettings(); });
  assert.deepEqual(cap.mapcycle, ['ttt_clue_se', 'ttt_dolls']);
});

// ── Prop Hunt: capture the PH profile through the container cfgs ─────────────────
test('prophunt spec captures the X2Z profile', async () => {
  const files = {
    [INST]: 'gamemode="prop_hunt"\ndefaultmap="ph_office"\nmaxplayers="20"\nwscollectionid="3737190377"\n',
    [GAME]: 'phx_verbose 1\n',
    [ACTIVE]: 'sv_gravity 600\n',
  };
  const conn = prophunt(files);
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
});

// ── writeConfig has no chown-back (the in-container exec already runs as the user) ─
test('prophunt spec writeConfig writes the file without a chown step', async () => {
  const files = { [ACTIVE]: '' };
  const client = fakeDockerClient(files);
  const conn = prophunt(client);
  await conn.writeConfig('active.cfg', 'phx_verbose 1');
  assert.equal(files[ACTIVE], 'phx_verbose 1');
  assert.ok(!client.execCalls.some((c) => JSON.stringify(c.command).includes('chown')), 'no chown exec should run');
});

// ── expanded TTT validation enforces the new field bounds ────────────────────────
test('gmod spec validateProfileSettings enforces expanded TTT_FIELDS bounds', async () => {
  const conn = gmod();
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

test('gmod spec syncMaps extracts workshop maps with the in-container GMOD paths', async () => {
  const client = fakeDockerClient();
  const conn = gmod(client);
  const res = await conn.syncMaps();
  assert.deepEqual(res, { ok: true, maps: [] });

  assert.equal(client.execCalls[0].command[0], '/bin/bash');
  assert.equal(client.execCalls[0].command[1], '-lc');
  const syncScript = client.execCalls[0].command[2];
  assert.match(syncScript, /\/data\/serverfiles\/garrysmod\/cache\/srcds\/\*\.gma/);
  assert.match(syncScript, /\/data\/serverfiles\/steam_cache\/content\/4000\/\*\/\*\.gma/);
  assert.match(syncScript, /"\/data\/serverfiles\/bin\/gmad_linux" extract/);
  assert.match(syncScript, /cp -n \{\} \/data\/serverfiles\/garrysmod\/maps\//);

  assert.equal(client.execCalls[1].command[0], '/bin/bash');
  assert.equal(client.execCalls[1].command[1], '-lc');
  assert.match(client.execCalls[1].command[2], /ls -1 \/data\/serverfiles\/garrysmod\/maps\/\*\.bsp/);
});

test('gmod spec importCollection writes wscollectionid and returns requiresRestart:true', async () => {
  const files = { [INST]: 'defaultmap="gm_construct"\n' };
  const conn = gmod(files);
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

// PropHunt shares importCollection (same route, same /data instance cfg).
test('prophunt spec shares importCollection (same route, requiresRestart:true)', async () => {
  const files = { [INST]: 'gamemode="prop_hunt"\n' };
  const conn = prophunt(files);
  const res = await conn.importCollection('3737190377');
  assert.match(files[INST], /wscollectionid="3737190377"/);
  assert.equal(res.requiresRestart, true);
});

// ── PH apply must NOT write wscollectionid (X2Z mount bug fix) ────────────────────
test('prophunt spec applyProfileSettings does not write wscollectionid', async () => {
  const files = {
    [INST]: 'gamemode="prop_hunt"\ndefaultmap="ph_office"\nmaxplayers="16"\n', // no wscollectionid line
    [GAME]: '', [ACTIVE]: '',
  };
  const conn = prophunt(files);
  const profile = { ...conn.defaultProfileSettings(), propHuntMap: 'ph_restaurant', workshopCollection: '999999' };
  await conn.applyProfileSettings(profile);
  // defaultmap + maxplayers are written, wscollectionid is left untouched (absent)
  assert.match(files[INST], /defaultmap="ph_restaurant"/);
  assert.ok(!/wscollectionid/.test(files[INST]), 'apply must not introduce wscollectionid');
});

// ── PH typed cvars: numeric bounds enforced ──────────────────────────────────────
test('prophunt spec validates numeric PH_CVARS bounds', () => {
  const conn = prophunt();
  const base = conn.defaultProfileSettings();
  assert.doesNotThrow(() => conn.validateProfileSettings(base));
  assert.throws(() => conn.validateProfileSettings({ ...base, roundTime: 10 }), /Round Time/);   // min 60
  assert.throws(() => conn.validateProfileSettings({ ...base, blindTime: 99 }), /Hide Time/);    // max 60
  assert.throws(() => conn.validateProfileSettings({ ...base, roundsPerMap: 1.5 }), /whole number/);
});

// ── cvarRef is embedded in both schemas (Raw Config autocomplete source) ─────────
test('gmod + prophunt specs profileSchema embeds a cvarRef built from their field tables', async () => {
  const g = gmod();
  const gs = await g.profileSchema();
  assert.ok(Array.isArray(gs.cvarRef) && gs.cvarRef.length);
  assert.ok(gs.cvarRef.some((c) => c.name === 'ttt_traitor_pct' && c.type === 'number'));
  assert.ok(gs.cvarRef.some((c) => c.name === 'sv_alltalk' && c.type === 'bool'));

  const ph = prophunt();
  const ps = await ph.profileSchema();
  assert.ok(Array.isArray(ps.cvarRef) && ps.cvarRef.length);
  assert.ok(ps.cvarRef.some((c) => c.name === 'ph_round_time' && c.type === 'number'));
  assert.ok(ps.cvarRef.some((c) => c.name === 'ph_enable_lucky_balls' && c.type === 'bool'));
});

// ── container model: the container IS the game (status drives gameStatus directly) ─
test('gmod + prophunt specs status() maps running → hosting, stopped → down', async () => {
  for (const [build, server] of [[gmod, GMOD], [prophunt, PH]]) {
    const up = await build(fakeDockerClient()).status();
    assert.equal(up.status, 'running', server.id);
    assert.equal(up.gameStatus, 'hosting', server.id);

    const stoppedClient = fakeDockerClient({}, {
      statusCurrent: async () => ({ status: 'stopped', uptime: 0 }),
    });
    const down = await build(stoppedClient).status();
    assert.equal(down.status, 'stopped', server.id);
    assert.equal(down.gameStatus, 'down', server.id);
  }
});
