import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { runMigrations } from '../src/db.js';
import { createServerStore } from '../src/servers/store.js';
import { GmodConnector } from '../src/servers/connectors/gmod.js';
import { FactorioConnector } from '../src/servers/connectors/factorio.js';

// In-memory DB with all migrations applied. Deliberately does NOT set the
// foreign_keys pragma (mirrors store.test.mjs) so the active-pointer cleanup is
// exercised via the store's explicit DELETE, not FK cascade.
function testDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  );`);
  runMigrations(db);
  return db;
}

// Fake ProxmoxClient: an in-memory file map for agentFileRead/Write. agentExec
// throws so GmodConnector.#listMaps degrades to [] (no live box in tests).
function fakeClient(files = {}) {
  return {
    files,
    async agentFileRead(_vmid, path) { return { content: files[path] ?? '' }; },
    async agentFileWrite(_vmid, path, content) { files[path] = content; return { ok: true }; },
    async agentExec() { throw new Error('no guest agent in tests'); },
  };
}

const GMOD = { id: 'gmod', name: "Garry's Mod (TTT)", vmid: 104, port: 27066, connect: 'cs' };
const INSTANCE_CFG = '/home/miles/gmodserver/lgsm/config-lgsm/gmodserver/gmodserver.cfg';
const SERVER_CFG   = '/home/miles/gmodserver/serverfiles/garrysmod/cfg/gmodserver.cfg';
const MAPCYCLE     = '/home/miles/gmodserver/serverfiles/garrysmod/mapcycle.txt';

function gmod(files) {
  const store = createServerStore(testDb());
  const client = fakeClient(files);
  return { conn: new GmodConnector(GMOD, client, store), store, client };
}

const FACTORIO = { id: 'factorio', name: 'Factorio', vmid: 101, port: 34197, connect: 'address' };
const F_LGSM     = '/home/miles/fctrserver/lgsm/config-lgsm/fctrserver/fctrserver.cfg';
const F_SETTINGS = '/home/miles/fctrserver/serverfiles/data/server-settings.json';

function factorio(files) {
  const store = createServerStore(testDb());
  const client = fakeClient(files);
  return { conn: new FactorioConnector(FACTORIO, client, store), store, client };
}

// ── store: profile CRUD + active pointer ─────────────────────────────────────────
test('profiles: create/get/update/list/delete with JSON round-trip + isolation', () => {
  const store = createServerStore(testDb());

  const p = store.createProfile('gmod', { name: 'Comp', settings: { map: 'ttt_a', maxPlayers: 12 } });
  assert.ok(p.id > 0);
  assert.deepEqual(p.settings, { map: 'ttt_a', maxPlayers: 12 }); // parsed back to an object

  // partial update keeps the name, swaps settings
  const up = store.updateProfile('gmod', p.id, { settings: { map: 'ttt_b', maxPlayers: 24 } });
  assert.equal(up.name, 'Comp');
  assert.equal(up.settings.map, 'ttt_b');

  // list omits the settings body; getProfile includes it
  const list = store.listProfiles('gmod');
  assert.deepEqual(list.map((r) => r.name), ['Comp']);
  assert.equal('settings' in list[0], false);

  // another server sees nothing
  assert.equal(store.getProfile('factorio', p.id), null);

  assert.equal(store.deleteProfile('gmod', p.id), true);
  assert.equal(store.deleteProfile('gmod', p.id), false);
});

test('profiles: names are unique per server', () => {
  const store = createServerStore(testDb());
  store.createProfile('gmod', { name: 'dup', settings: {} });
  assert.throws(() => store.createProfile('gmod', { name: 'dup', settings: {} }));
  assert.ok(store.createProfile('minecraft', { name: 'dup', settings: {} }).id > 0); // different server is fine
});

test('profiles: active pointer set, read, and cleared on delete', () => {
  const store = createServerStore(testDb());
  const a = store.createProfile('gmod', { name: 'A', settings: {} });
  const b = store.createProfile('gmod', { name: 'B', settings: {} });

  assert.equal(store.getActiveProfileId('gmod'), null);
  store.setActiveProfile('gmod', a.id);
  assert.equal(store.getActiveProfileId('gmod'), a.id);
  store.setActiveProfile('gmod', b.id); // upsert switches it
  assert.equal(store.getActiveProfileId('gmod'), b.id);

  store.deleteProfile('gmod', b.id);     // deleting the active profile clears the pointer
  assert.equal(store.getActiveProfileId('gmod'), null);
});

// ── GMOD connector: schema / validate / apply / capture ──────────────────────────
test('gmod: listProfiles seeds a Default the first time', () => {
  const { conn, store } = gmod();
  const { profiles, activeId } = conn.listProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'Default');
  assert.equal(activeId, null);
  // idempotent — a second list doesn't seed a duplicate
  assert.equal(conn.listProfiles().profiles.length, 1);
  assert.equal(store.countProfiles('gmod'), 1);
});

test('gmod: validateProfileSettings rejects bad values', () => {
  const { conn } = gmod();
  const base = conn.defaultProfileSettings();
  assert.throws(() => conn.validateProfileSettings({ ...base, maxPlayers: 999 }), /maxPlayers/);
  assert.throws(() => conn.validateProfileSettings({ ...base, traitorPct: 5 }), /Traitor Ratio/);
  assert.throws(() => conn.validateProfileSettings({ ...base, workshopCollection: 'abc' }), /collection id/);
  assert.throws(() => conn.validateProfileSettings({ ...base, mapcycle: ['ok_map', 'bad map'] }), /invalid map in cycle/);
});

test('gmod: applyProfileSettings writes the right keys across the three files', async () => {
  const { conn, client } = gmod();
  // workshop maps are allowed once a collection is set (GMOD mounts it at boot)
  const settings = { ...conn.defaultProfileSettings(), workshopCollection: '12345',
                     maxPlayers: 20, roundLimit: 8,
                     mapcycle: ['ttt_rooftops', 'ttt_minecraft_b5'] };
  await conn.applyProfileSettings(settings, 7);

  const inst = client.files[INSTANCE_CFG];
  assert.match(inst, /defaultmap="ttt_rooftops"/); // boots into the first rotation map
  assert.match(inst, /maxplayers="20"/);
  assert.match(inst, /wscollectionid="12345"/);
  assert.match(inst, /gt_active_profile="7"/);   // on-box active-profile mirror

  const game = client.files[SERVER_CFG];
  assert.match(game, /ttt_round_limit "8"/);
  assert.match(game, /ttt_always_use_mapcycle "1"/);

  assert.equal(client.files[MAPCYCLE], 'ttt_rooftops\nttt_minecraft_b5\n');
});

test('gmod: applyProfileSettings blocks a workshop boot map when no collection is set', async () => {
  const { conn } = gmod();
  const settings = { ...conn.defaultProfileSettings(), workshopCollection: '',
                     mapcycle: ['ttt_minecraft_b5'] };
  await assert.rejects(() => conn.applyProfileSettings(settings, 1), /no Workshop Collection/);
});

test('gmod: applyProfileSettings allows stock maps with no collection', async () => {
  const { conn, client } = gmod();
  await conn.applyProfileSettings(conn.defaultProfileSettings(), 1); // gm_construct, no collection
  assert.match(client.files[INSTANCE_CFG], /defaultmap="gm_construct"/);
});

test('gmod: capture → apply → capture round-trips the settings', async () => {
  // Apply a known profile, then capture the resulting files back into a doc.
  const { conn } = gmod();
  const original = { ...conn.defaultProfileSettings(), workshopCollection: '777',
                     maxPlayers: 18, detectiveMax: 4,
                     mapcycle: ['ttt_clue', 'ttt_minecraft_b5'] };
  await conn.applyProfileSettings(original, 3);

  const captured = await conn.captureProfileSettings();
  assert.equal(captured.workshopCollection, '777');
  assert.equal(captured.maxPlayers, 18);
  assert.equal(captured.detectiveMax, 4);
  assert.equal(captured.roundLimit, 6); // default carried through
  assert.deepEqual(captured.mapcycle, ['ttt_clue', 'ttt_minecraft_b5']);
});

test('gmod: applyProfile loads a saved profile and marks it active', async () => {
  const { conn, store } = gmod();
  const p = conn.createProfile({ name: 'Chaos', settings: { ...conn.defaultProfileSettings(), maxPlayers: 32 } });
  const res = await conn.applyProfile(p.id);
  assert.equal(res.ok, true);
  assert.equal(store.getActiveProfileId('gmod'), p.id);
});

test('gmod: profileSchema groups Maps/Gameplay with collection-driven fields', async () => {
  const { conn } = gmod();
  const schema = await conn.profileSchema();
  assert.deepEqual(schema.groups.map((g) => g.key), ['map', 'gameplay']);
  const mapGroup = schema.groups[0];
  assert.ok(mapGroup.fields.some((f) => f.key === 'workshopCollection' && f.type === 'text'));
  assert.ok(mapGroup.fields.some((f) => f.key === 'mapcycle' && f.type === 'maplist' && f.custom));
  assert.ok(!mapGroup.fields.some((f) => f.key === 'map')); // no separate start-map field
  assert.ok(mapGroup.fields.some((f) => f.key === 'useMapcycle' && f.type === 'bool'));
});

// ── Factorio connector: schema / validate / apply / capture ──────────────────────
test('factorio: validateProfileSettings normalizes + rejects bad values', () => {
  const { conn } = factorio();
  const base = conn.defaultProfileSettings();
  assert.equal(conn.validateProfileSettings(base).visibility, 'lan');
  assert.throws(() => conn.validateProfileSettings({ ...base, maxPlayers: 999 }), /max players/);
  assert.throws(() => conn.validateProfileSettings({ ...base, autosaveInterval: 0 }), /autosave/);
  assert.throws(() => conn.validateProfileSettings({ ...base, saveName: 'bad name!' }), /invalid world/);
});

test('factorio: applyProfileSettings edits server-settings.json + switches the active save', async () => {
  const { conn, client } = factorio({
    [F_SETTINGS]: JSON.stringify({ name: 'old', max_players: 5, tags: ['keepme'] }),
    [F_LGSM]: 'savename="old"\nstartparameters="--start-server x"\n',
  });
  await conn.applyProfileSettings({
    saveName: 'WileyWorld', serverName: 'GT', description: 'hi', maxPlayers: 12,
    visibility: 'public', password: 'pw', autosaveInterval: 7,
  }, 4);

  const json = JSON.parse(client.files[F_SETTINGS]);
  assert.equal(json.name, 'GT');
  assert.equal(json.max_players, 12);
  assert.deepEqual(json.visibility, { public: true, lan: true });
  assert.equal(json.game_password, 'pw');
  assert.equal(json.autosave_interval, 7);
  assert.deepEqual(json.tags, ['keepme']); // untouched keys preserved

  const lgsm = client.files[F_LGSM];
  assert.match(lgsm, /savename="WileyWorld"/);
  assert.match(lgsm, /start-server \$\{serverfiles\}\/saves\/WileyWorld\.zip/);
  assert.match(lgsm, /gt_active_profile="4"/);
});

test('factorio: empty saveName keeps the current active world', async () => {
  const { conn, client } = factorio({
    [F_SETTINGS]: '{}',
    [F_LGSM]: 'savename="keepme"\nstartparameters="--start-server ${serverfiles}/saves/keepme.zip"\n',
  });
  await conn.applyProfileSettings({ ...conn.defaultProfileSettings(), saveName: '' }, 1);
  assert.match(client.files[F_LGSM], /savename="keepme"/); // unchanged
});

test('factorio: capture round-trips server-settings + active save', async () => {
  const { conn } = factorio({
    [F_SETTINGS]: JSON.stringify({ name: 'Srv', description: 'd', max_players: 8,
      visibility: { public: false, lan: true }, game_password: 'p', autosave_interval: 15 }),
    [F_LGSM]: 'savename="w"\nstartparameters="--bind x --start-server ${serverfiles}/saves/MyWorld.zip --port 34197"\n',
  });
  const c = await conn.captureProfileSettings();
  assert.equal(c.saveName, 'MyWorld');
  assert.equal(c.serverName, 'Srv');
  assert.equal(c.maxPlayers, 8);
  assert.equal(c.visibility, 'lan');
  assert.equal(c.password, 'p');
  assert.equal(c.autosaveInterval, 15);
});

test('factorio: profileSchema groups World + Server Settings; getSettings is operations-only', async () => {
  const { conn } = factorio();
  const schema = await conn.profileSchema();
  assert.deepEqual(schema.groups.map((g) => g.key), ['world', 'server']);
  assert.ok(schema.groups[1].fields.some((f) => f.key === 'visibility' && f.type === 'select'));
  // active world moved to the profile; getSettings now exposes only operations
  const ops = await conn.getSettings();
  assert.deepEqual(ops.sections.map((s) => s.key), ['saveAs', 'newWorld']);
});
