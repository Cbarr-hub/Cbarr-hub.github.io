import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import Database from 'better-sqlite3';

import { runMigrations } from '../src/db.js';
import { createServerStore } from '../src/servers/store.js';
import * as cs from '../src/servers/connectors/counterstrike-profile.js';
import { DockerCounterStrikeConnector } from '../src/servers/connectors/docker/counterstrike.js';

function testDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));`);
  runMigrations(db);
  return db;
}

const CS = { id: 'counterstrike', name: 'Counter-Strike', backend: 'docker', container: 'cs2', port: 27015 };

// Minimal Source-RCON server that captures the first exec command body, replies to
// auth, then echoes the END sentinel so rconExchange resolves. Lets us assert the
// exact command string applyProfileSettings sends over the real wire.
function encodeRcon(id, type, body) {
  const b = Buffer.from(body, 'ascii');
  const size = 4 + 4 + b.length + 2;
  const buf = Buffer.allocUnsafe(4 + size);
  buf.writeInt32LE(size, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8);
  b.copy(buf, 12); buf.writeInt8(0, 12 + b.length); buf.writeInt8(0, 13 + b.length);
  return buf;
}
async function withRconCapture(run) {
  let command = null;
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
        if (type === 3) { sock.write(encodeRcon(id, 2, '')); continue; } // auth ok
        if (id === 3) { sock.write(encodeRcon(3, 0, '')); continue; }    // END sentinel echo
        if (command === null) command = body;                            // first real exec
      }
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  try { await run({ port }); } finally { await new Promise((res) => server.close(res)); }
  return { command };
}

// ── shared pure module ──────────────────────────────────────────────────────────
test('cs-profile validate: map (stock/ws), mode, hostname (no maxPlayers — env-only)', () => {
  const base = cs.defaultProfileSettings();
  assert.equal(base.maxPlayers, undefined); // maxPlayers is NOT a profile field (compose env)
  assert.equal(cs.validateProfileSettings({ ...base, map: 'ws:3071005299' }).map, 'ws:3071005299');
  assert.throws(() => cs.validateProfileSettings({ ...base, map: 'ws:abc' }), /workshop id/);
  assert.throws(() => cs.validateProfileSettings({ ...base, map: 'Bad Map!' }), /invalid map/);
  assert.throws(() => cs.validateProfileSettings({ ...base, gameMode: 'nope' }), /game mode/);
  assert.throws(() => cs.validateProfileSettings({ ...base, hostname: 'a"b' }), /server name/);
  // a stray maxPlayers is ignored, not persisted
  assert.equal(cs.validateProfileSettings({ ...base, maxPlayers: 99 }).maxPlayers, undefined);
});

test('cs-profile schema applies LIVE over RCON (no restart) and drops maxPlayers', () => {
  const { groups, apply } = cs.profileGroups([{ value: 'de_dust2', label: 'de_dust2' }], 'note');
  assert.equal(apply?.mode, 'live');
  assert.ok(apply.label && apply.note);
  assert.ok(!groups[0].fields.some((f) => f.key === 'maxPlayers'));
});

test('cs-profile CS_CVAR_FIELDS: seeded as defaults, validated within bounds', () => {
  const base = cs.defaultProfileSettings();
  // every cvar field is seeded to its default
  for (const f of cs.CS_CVAR_FIELDS) assert.equal(base[f.key], f.def);
  // round-trip leaves valid values untouched (coerced to number)
  assert.equal(cs.validateProfileSettings({ ...base, maxRounds: 30 }).maxRounds, 30);
  assert.equal(cs.validateProfileSettings({ ...base, friendlyFire: '0' }).friendlyFire, 0);
  // out-of-bounds and non-integer rejected
  assert.throws(() => cs.validateProfileSettings({ ...base, maxRounds: 999 }), /Max Rounds must be 0–60/);
  assert.throws(() => cs.validateProfileSettings({ ...base, botQuota: -1 }), /Bots must be 0–64/);
  assert.throws(() => cs.validateProfileSettings({ ...base, freezeTime: 'x' }), /must be a number/);
  assert.throws(() => cs.validateProfileSettings({ ...base, buyTime: 2.5 }), /whole number/);
  // a float cvar (roundTime) accepts fractional values
  assert.equal(cs.validateProfileSettings({ ...base, roundTime: 1.92 }).roundTime, 1.92);
});

test('cs-profile schema: Match Rules group + embedded cvarRef', () => {
  const { groups, cvarRef } = cs.profileGroups([{ value: 'de_dust2', label: 'de_dust2' }], 'note');
  const rules = groups.find((g) => g.key === 'rules');
  assert.ok(rules && rules.title === 'Match Rules');
  // bools render as bool, numbers carry bounds
  assert.equal(rules.fields.find((f) => f.key === 'friendlyFire').type, 'bool');
  const mr = rules.fields.find((f) => f.key === 'maxRounds');
  assert.deepEqual([mr.type, mr.min, mr.max], ['number', 0, 60]);
  // cvarRef is embedded and covers every CS_CVAR_FIELDS cvar
  assert.ok(Array.isArray(cvarRef));
  for (const f of cs.CS_CVAR_FIELDS) assert.ok(cvarRef.some((r) => r.name === f.cvar));
  assert.ok(cvarRef.some((r) => r.name === 'sv_gravity' && r.help));
});

test('cs-profile csRangeCmd: clamps to bounds, gravity gates cheats, unknown → null', () => {
  assert.equal(cs.csRangeCmd('gravity', 99999), 'sv_cheats 1; sv_gravity 2000'); // clamp high
  assert.equal(cs.csRangeCmd('gravity', 0), 'sv_cheats 1; sv_gravity 100');      // clamp low
  assert.equal(cs.csRangeCmd('startmoney', 800), 'mp_startmoney 800; mp_maxmoney 16000');
  assert.equal(cs.csRangeCmd('roundtime', 5), 'mp_roundtime_defuse 5; mp_roundtime 5');
  assert.equal(cs.csRangeCmd('bots', 99), 'bot_quota 10');
  assert.equal(cs.csRangeCmd('nope', 1), null);
  assert.throws(() => cs.csRangeCmd('gravity', 'NaN'), /invalid value/);
});

test('cs-profile buildChangeMapCmd: stock vs workshop vs invalid', () => {
  assert.equal(cs.buildChangeMapCmd('de_dust2'), 'changelevel de_dust2');
  assert.equal(cs.buildChangeMapCmd('ws:123'), 'host_workshop_map 123');
  assert.throws(() => cs.buildChangeMapCmd('ws:bad'), /workshop id/);
  assert.throws(() => cs.buildChangeMapCmd('bad map!'), /invalid map/);
});

test('cs-profile groups are Map & Mode / Match Rules / Advanced', () => {
  const { groups } = cs.profileGroups([{ value: 'de_dust2', label: 'de_dust2' }], 'note');
  assert.deepEqual(groups.map((g) => g.key), ['map', 'rules', 'advanced']);
});

// ── Docker connector ────────────────────────────────────────────────────────────
test('DockerCS profileSchema includes stock + saved workshop maps', async () => {
  const store = createServerStore(testDb());
  store.addWorkshopMap('counterstrike', { workshopId: '777', name: 'My WS Map' });
  const conn = new DockerCounterStrikeConnector(CS, {}, store);
  const { groups } = await conn.profileSchema();
  const mapField = groups[0].fields.find((f) => f.key === 'map');
  assert.ok(mapField.options.some((o) => o.value === 'de_dust2'));
  assert.ok(mapField.options.some((o) => o.value === 'ws:777' && o.label === 'My WS Map'));
});

test('DockerCS reuses the DB-backed workshop catalog + config library', () => {
  const store = createServerStore(testDb());
  const conn = new DockerCounterStrikeConnector(CS, {}, store);
  conn.addMap({ workshopId: '42', name: 'Aim Map' });
  assert.ok(conn.listMaps().some((m) => m.workshopId === '42' && m.name === 'Aim Map'));
  const cfg = conn.createConfig({ name: 'comp', body: 'mp_maxrounds 24' });
  assert.equal(conn.getConfig(cfg.id).body, 'mp_maxrounds 24');
});

test('DockerCS addMap auto-fetches the Workshop title when name is omitted', async () => {
  const store = createServerStore(testDb());
  const conn = new DockerCounterStrikeConnector(CS, {}, store);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ response: { publishedfiledetails: [{ publishedfileid: '999', result: 1, title: 'Cobblestone Redux' }] } }),
  });
  try {
    const row = await conn.addMap({ workshopId: '999' });          // no name → auto
    assert.equal(row.name, 'Cobblestone Redux');
    const provided = await conn.addMap({ workshopId: '1000', name: 'Hand Named' });
    assert.equal(provided.name, 'Hand Named');                     // explicit name wins
  } finally { globalThis.fetch = realFetch; }
});

test('DockerCS importCollection imports every child with fetched names', async () => {
  const store = createServerStore(testDb());
  const conn = new DockerCounterStrikeConnector(CS, {}, store);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => String(url).includes('GetCollectionDetails')
      ? { response: { collectiondetails: [{ result: 1, children: [{ publishedfileid: '11' }, { publishedfileid: '22' }] }] } }
      : { response: { publishedfiledetails: [
          { publishedfileid: '11', result: 1, title: 'Map One' },
          { publishedfileid: '22', result: 1, title: 'Map Two' },
        ] } },
  });
  try {
    const r = await conn.importCollection('123');
    assert.equal(r.imported, 2);
    // unified shape: selectable {value,label} options, live (no restart)
    assert.equal(r.requiresRestart, false);
    assert.ok(r.maps.some((m) => m.value === 'ws:11' && m.label === 'Map One'));
    assert.ok(r.maps.some((m) => m.value === 'ws:22' && m.label === 'Map Two'));
    assert.ok(typeof r.note === 'string');
    const names = store.listWorkshopMaps('counterstrike').map((m) => m.name);
    assert.ok(names.includes('Map One') && names.includes('Map Two'));
  } finally { globalThis.fetch = realFetch; }
});

test('DockerCS update runs SteamCMD app_update 730 in-container', async () => {
  const calls = [];
  const client = { async agentExec(_c, { command }) { calls.push(command.join(' ')); return { pid: 'p' }; },
    async agentExecStatus() { return { exited: 1, exitcode: 0, 'out-data': 'ok', 'err-data': '' }; } };
  const conn = new DockerCounterStrikeConnector(CS, client, createServerStore(testDb()));
  const res = await conn.update();
  assert.equal(res.ok, true);
  assert.ok(calls.some((c) => c.includes('app_update 730')), 'steamcmd app_update 730 issued');
});

test('DockerCS live control is gated on CS2_RCON_PASSWORD', async () => {
  delete process.env.CS2_RCON_PASSWORD;
  const conn = new DockerCounterStrikeConnector(CS, {}, createServerStore(testDb()));
  assert.equal((await conn.getLive()).available, false);
  // apply pushes via RCON → without a password it fails fast (no socket opened)
  await assert.rejects(() => conn.applyProfileSettings(cs.defaultProfileSettings()), (e) => e.code === 'NO_RCON');

  process.env.CS2_RCON_PASSWORD = 'x';
  const live = await conn.getLive();
  assert.equal(live.available, true);
  // getLive now advertises range sliders alongside the button actions
  assert.ok(Array.isArray(live.controls) && live.controls.some((c) => c.key === 'gravity'));
  delete process.env.CS2_RCON_PASSWORD;
});

test('DockerCS applyProfileSettings pushes Match-Rules cvars in the live RCON batch', async () => {
  // Stand up a throwaway RCON server that captures the command the connector sends,
  // so we assert the REAL applyProfileSettings batch (not a reimplementation).
  const { command } = await withRconCapture(async (server) => {
    process.env.CS2_RCON_PASSWORD = 'x';
    const conn = new DockerCounterStrikeConnector(
      { ...CS, container: '127.0.0.1', rconPort: server.port }, {}, createServerStore(testDb()));
    try {
      await conn.applyProfileSettings({ ...cs.defaultProfileSettings(), maxRounds: 30, friendlyFire: 0, overtime: 1 });
    } finally { delete process.env.CS2_RCON_PASSWORD; }
  });
  assert.ok(command.includes('mp_maxrounds 30'), 'maxRounds pushed');
  assert.ok(command.includes('mp_friendlyfire 0'), 'bool friendlyFire pushed as 0');
  assert.ok(command.includes('mp_overtime_enable 1'), 'bool overtime pushed as 1');
  assert.ok(command.includes('bot_quota 0'), 'bot_quota pushed');
  assert.ok(command.includes('game_alias competitive') && command.includes('changelevel de_dust2'),
    'map + mode still in the batch');
});
