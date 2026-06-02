import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { runMigrations } from '../src/db.js';
import { createServerStore } from '../src/servers/store.js';
import { GmodConnector } from '../src/servers/connectors/gmod.js';
import { FactorioConnector } from '../src/servers/connectors/factorio.js';
import { CounterStrikeConnector } from '../src/servers/connectors/counterstrike.js';
import { MinecraftConnector } from '../src/servers/connectors/minecraft.js';
import { PropHuntConnector } from '../src/servers/connectors/prophunt.js';

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

// Fake ProxmoxClient: an in-memory file map for agentFileRead/Write, plus a
// benign-success agentExec so runShell calls (e.g. CS's `mkdir`) work. Map-listing
// helpers that grep see empty stdout → [] (no live box in tests).
function fakeClient(files = {}) {
  return {
    files,
    async agentFileRead(_vmid, path) { return { content: files[path] ?? '' }; },
    async agentFileWrite(_vmid, path, content) { files[path] = content; return { ok: true }; },
    async agentExec() { return { pid: 1 }; },
    async agentExecStatus() { return { exited: true, exitcode: 0, 'out-data': '', 'err-data': '' }; },
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

const PROPHUNT = { id: 'prophunt', name: 'Prop Hunt', vmid: 105, port: 27067, connect: 'cs' };
const PH_INST   = '/home/miles/phserver/lgsm/config-lgsm/gmodserver/gmodserver.cfg';
const PH_GAME   = '/home/miles/phserver/serverfiles/garrysmod/cfg/gmodserver.cfg';
const PH_ACTIVE = '/home/miles/phserver/serverfiles/garrysmod/cfg/gamertown/active.cfg';

function prophunt(files) {
  const store = createServerStore(testDb());
  const client = fakeClient(files);
  return { conn: new PropHuntConnector(PROPHUNT, client, store), store, client };
}

const FACTORIO = { id: 'factorio', name: 'Factorio', vmid: 101, port: 34197, connect: 'address' };
const F_LGSM     = '/home/miles/fctrserver/lgsm/config-lgsm/fctrserver/fctrserver.cfg';
const F_SETTINGS = '/home/miles/fctrserver/serverfiles/data/server-settings.json';

function factorio(files) {
  const store = createServerStore(testDb());
  const client = fakeClient(files);
  return { conn: new FactorioConnector(FACTORIO, client, store), store, client };
}

const CS = { id: 'counterstrike', name: 'Counter-Strike', vmid: 100, port: 27015, connect: 'cs' };
const CS_GAME   = '/home/miles/csserver/serverfiles/game/csgo/cfg/cs2server.cfg';
const CS_INST   = '/home/miles/csserver/lgsm/config-lgsm/cs2server/cs2server.cfg';
const CS_ACTIVE = '/home/miles/csserver/serverfiles/game/csgo/cfg/gamertown/active.cfg';

function cs(files) {
  const store = createServerStore(testDb());
  const client = fakeClient(files);
  return { conn: new CounterStrikeConnector(CS, client, store), store, client };
}

const MC = { id: 'minecraft', name: 'Minecraft', vmid: 102, port: 25565, connect: 'address' };
const MC_PROPS = '/home/miles/MinecraftServer/server.properties';

function mc(files) {
  const store = createServerStore(testDb());
  const client = fakeClient(files);
  return { conn: new MinecraftConnector(MC, client, store), store, client };
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
  assert.ok(mapGroup.fields.some((f) => f.type === 'mapsync')); // the Sync-from-collection action
});

test('gmod: syncMaps runs the extract and returns the installed map list', async () => {
  const { conn } = gmod();
  const r = await conn.syncMaps();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.maps));
});

// ── Prop Hunt connector: schema / validate / apply / capture / live ──────────────
test('prophunt: validateProfileSettings rejects bad values + normalizes cvars', () => {
  const { conn } = prophunt();
  const base = conn.defaultProfileSettings();
  assert.throws(() => conn.validateProfileSettings({ ...base, maxPlayers: 999 }), /maxPlayers/);
  assert.throws(() => conn.validateProfileSettings({ ...base, propHuntMap: 'Bad Map!' }), /Prop Hunt map/);
  assert.throws(() => conn.validateProfileSettings({ ...base, workshopCollection: 'abc' }), /collection id/);
  // bool cvars normalize to '1'/'0'
  const v = conn.validateProfileSettings({ ...base, kickNonAdmin: true, verboseLog: 0 });
  assert.equal(v.kickNonAdmin, '1');
  assert.equal(v.verboseLog, '0');
  assert.equal(v.workshopCollection, '3737190377'); // default collection carried
});

test('prophunt: applyProfileSettings writes gamemode + map + collection + cvars + active.cfg', async () => {
  const { conn, client } = prophunt({ [PH_GAME]: 'rcon_password "x"\n', [PH_INST]: 'gamemode="terrortown"\n' });
  await conn.applyProfileSettings({ ...conn.defaultProfileSettings(), propHuntMap: 'ph_office_fsg_v2',
    maxPlayers: 24, kickNonAdmin: '1', rawConfig: 'phx_verbose 1\n' }, 9);

  const inst = client.files[PH_INST];
  assert.match(inst, /gamemode="prop_hunt"/);
  assert.match(inst, /defaultmap="ph_office_fsg_v2"/);
  assert.match(inst, /maxplayers="24"/);
  assert.match(inst, /wscollectionid="3737190377"/); // collection mounted at boot
  assert.match(inst, /gt_active_profile="9"/);

  const game = client.files[PH_GAME];
  assert.match(game, /ph_kick_non_admin_access "1"/);   // bool cvar applied
  assert.match(game, /fretta_waitforplayers "1"/);      // default carried
  assert.match(game, /exec gamertown\/active/);         // escape-hatch exec ensured
  assert.equal(client.files[PH_ACTIVE], 'phx_verbose 1\n');
});

test('prophunt: applyProfileSettings requires a starting map', async () => {
  const { conn } = prophunt();
  await assert.rejects(() => conn.applyProfileSettings({ ...conn.defaultProfileSettings(), propHuntMap: '' }, 1),
    /starting map/);
});

test('prophunt: capture round-trips map/collection/players/cvars/rawConfig', async () => {
  const { conn } = prophunt({
    [PH_INST]: 'gamemode="prop_hunt"\ndefaultmap="ph_islandhouse"\nmaxplayers="20"\nwscollectionid="3737190377"\n',
    [PH_GAME]: 'ph_kick_non_admin_access "1"\n',
    [PH_ACTIVE]: 'sv_gravity 300\n',
  });
  const c = await conn.captureProfileSettings();
  assert.equal(c.propHuntMap, 'ph_islandhouse');
  assert.equal(c.workshopCollection, '3737190377');
  assert.equal(c.maxPlayers, 20);
  assert.equal(c.kickNonAdmin, '1');
  assert.equal(c.waitForPlayers, '1');      // default carried through
  assert.equal(c.rawConfig, 'sv_gravity 300\n');
});

test('prophunt: profileSchema groups Map/X2Z/Controls/Advanced', async () => {
  const { conn } = prophunt();
  const schema = await conn.profileSchema();
  assert.deepEqual(schema.groups.map((g) => g.key), ['map', 'x2z', 'controls', 'advanced']);
  const [mapG, x2zG, ctrlG, advG] = schema.groups;
  assert.ok(mapG.fields.some((f) => f.key === 'propHuntMap' && f.type === 'select' && f.custom));
  assert.ok(mapG.fields.some((f) => f.key === 'workshopCollection' && f.type === 'text'));
  assert.ok(mapG.fields.some((f) => f.type === 'mapsync'));
  assert.ok(x2zG.fields.every((f) => f.type === 'bool') && x2zG.fields.length >= 3);
  assert.ok(ctrlG.fields.length >= 4 && ctrlG.fields.every((f) => f.type === 'info' && f.help));
  assert.ok(advG.fields.some((f) => f.key === 'rawConfig' && f.type === 'textarea'));
});

test('prophunt: getLive + runLiveAction — change_map, next round, movement on 27067', async () => {
  const off = prophunt({ [PH_GAME]: '' });
  assert.equal((await off.conn.getLive()).available, false);

  const calls = [];
  const on = prophunt({ [PH_GAME]: 'rcon_password "ph-secret"\n' });
  on.client.agentExec = (_v, { command, input }) => { calls.push({ command, input }); return Promise.resolve({ pid: 1 }); };
  on.client.agentExecStatus = () => Promise.resolve({ exited: true, exitcode: 0, 'out-data': 'players: 2' });
  const live = await on.conn.getLive();
  assert.equal(live.available, true);
  assert.ok(live.actions.some((a) => a.key === 'next_round'));
  assert.ok(live.actions.some((a) => a.key === 'lowgrav_on'));

  const res = await on.conn.runLiveAction('change_map', 'ph_restaurant');
  assert.equal(res.output, 'players: 2');
  const c = calls.at(-1);
  assert.ok(c.command.includes('27067'));
  assert.equal(c.command.at(-1), 'changelevel ph_restaurant');
  assert.equal(c.input, 'ph-secret');

  await on.conn.runLiveAction('next_round');
  assert.equal(calls.at(-1).command.at(-1), 'ph_force_end_round');   // real X2Z command
  await on.conn.runLiveAction('lowgrav_on');
  assert.equal(calls.at(-1).command.at(-1), 'sv_gravity 200');

  await assert.rejects(() => on.conn.runLiveAction('change_map', 'bad map!'), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => on.conn.runLiveAction('bogus_action'), /unknown live action/);
});

test('prophunt: syncMaps runs and returns the installed map list', async () => {
  const { conn } = prophunt();
  const r = await conn.syncMaps();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.maps));
});

test('prophunt: listProfiles seeds a Default the first time', () => {
  const { conn } = prophunt();
  const { profiles } = conn.listProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'Default');
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

// ── Counter-Strike connector: schema / validate / apply / capture ────────────────
test('cs: validateProfileSettings handles stock + ws maps, rejects bad values', () => {
  const { conn } = cs();
  const base = conn.defaultProfileSettings();
  assert.equal(conn.validateProfileSettings({ ...base, map: 'de_nuke' }).map, 'de_nuke');
  assert.equal(conn.validateProfileSettings({ ...base, map: 'ws:123' }).map, 'ws:123');
  assert.throws(() => conn.validateProfileSettings({ ...base, map: 'ws:abc' }), /workshop id/);
  assert.throws(() => conn.validateProfileSettings({ ...base, map: 'Bad Map!' }), /invalid map/);
  assert.throws(() => conn.validateProfileSettings({ ...base, gameMode: 'nope' }), /game mode/);
  assert.throws(() => conn.validateProfileSettings({ ...base, maxPlayers: 99 }), /maxPlayers/);
  assert.throws(() => conn.validateProfileSettings({ ...base, hostname: 'a"b' }), /server name/);
});

test('cs: applyProfileSettings — stock map clears workshop, deploys rawConfig', async () => {
  const { conn, client } = cs({ [CS_GAME]: 'exec gamertown/active\n', [CS_INST]: 'maxplayers="10"\n' });
  await conn.applyProfileSettings(
    { map: 'de_nuke', gameMode: 'deathmatch', maxPlayers: 12, hostname: 'GT', rawConfig: 'sv_cheats 1\n' }, 5);
  const game = client.files[CS_GAME];
  assert.match(game, /map "de_nuke"/);
  assert.match(game, /host_workshop_map ""/);     // workshop override cleared for a stock map
  assert.match(game, /game_alias "deathmatch"/);
  assert.match(game, /hostname "GT"/);
  assert.equal(client.files[CS_ACTIVE], 'sv_cheats 1\n');   // extra cvars deployed
  assert.match(client.files[CS_INST], /maxplayers="12"/);
  assert.match(client.files[CS_INST], /gt_active_profile="5"/);
});

test('cs: applyProfileSettings — ws map sets host_workshop_map', async () => {
  const { conn, client } = cs({ [CS_GAME]: 'exec gamertown/active\n', [CS_INST]: '' });
  await conn.applyProfileSettings({ ...conn.defaultProfileSettings(), map: 'ws:3071005299' }, 1);
  assert.match(client.files[CS_GAME], /host_workshop_map "3071005299"/);
});

test('cs: capture round-trips map/mode/players/hostname/rawConfig', async () => {
  const { conn } = cs({
    [CS_GAME]: 'host_workshop_map "999"\ngame_alias "wingman"\nhostname "Srv"\nexec gamertown/active\n',
    [CS_INST]: 'maxplayers="8"\n',
    [CS_ACTIVE]: 'sv_gravity 200\n',
  });
  const c = await conn.captureProfileSettings();
  assert.equal(c.map, 'ws:999');
  assert.equal(c.gameMode, 'wingman');
  assert.equal(c.maxPlayers, 8);
  assert.equal(c.hostname, 'Srv');
  assert.equal(c.rawConfig, 'sv_gravity 200\n');
});

test('cs: profileSchema groups Map&Mode + Advanced; seeded Assembly is a ws: option', async () => {
  const { conn } = cs();
  const schema = await conn.profileSchema();
  assert.deepEqual(schema.groups.map((g) => g.key), ['map', 'advanced']);
  const mapField = schema.groups[0].fields.find((f) => f.key === 'map');
  assert.ok(mapField.addWorkshop); // inline "add workshop map" form (no ws: typing)
  // the migration-seeded Assembly shows BY NAME, value carries the ws: id
  assert.ok(mapField.options.some((o) => o.value === 'ws:3071005299' && o.label === 'Assembly'));
  assert.ok(schema.groups[1].fields.some((f) => f.key === 'rawConfig' && f.type === 'textarea'));
});

// ── Minecraft connector: schema / validate / apply / capture ─────────────────────
test('mc: validateProfileSettings normalizes enums + rejects bad values', () => {
  const { conn } = mc();
  const base = conn.defaultProfileSettings();
  assert.equal(conn.validateProfileSettings({ ...base, gamemode: 'nope' }).gamemode, 'survival'); // falls back
  assert.equal(conn.validateProfileSettings({ ...base, difficulty: 'x' }).difficulty, 'normal');
  assert.throws(() => conn.validateProfileSettings({ ...base, maxPlayers: 0 }), /max players/);
  assert.throws(() => conn.validateProfileSettings({ ...base, viewDistance: 99 }), /view distance/);
  assert.throws(() => conn.validateProfileSettings({ ...base, world: 'bad name!' }), /invalid world/);
});

test('mc: applyProfileSettings writes the server.properties keys', async () => {
  const { conn, client } = mc({ [MC_PROPS]: 'level-name=world\nmax-players=20\nmotd=old\n' });
  await conn.applyProfileSettings({
    world: 'world_GTown', gamemode: 'creative', difficulty: 'hard', maxPlayers: 8, motd: 'Hi',
    pvp: '0', hardcore: '1', whitelist: '1', onlineMode: '0', viewDistance: 16, spawnProtection: 0,
  });
  const p = client.files[MC_PROPS];
  assert.match(p, /level-name=world_GTown/);
  assert.match(p, /gamemode=creative/);
  assert.match(p, /difficulty=hard/);
  assert.match(p, /max-players=8/);
  assert.match(p, /pvp=false/);
  assert.match(p, /hardcore=true/);
  assert.match(p, /white-list=true/);
  assert.match(p, /online-mode=false/);
  assert.match(p, /view-distance=16/);
  assert.match(p, /spawn-protection=0/);
});

test('mc: empty world keeps the current level-name', async () => {
  const { conn, client } = mc({ [MC_PROPS]: 'level-name=keepme\n' });
  await conn.applyProfileSettings({ ...conn.defaultProfileSettings(), world: '' });
  assert.match(client.files[MC_PROPS], /level-name=keepme/);
});

test('mc: capture round-trips server.properties (bools as 1/0)', async () => {
  const { conn } = mc({ [MC_PROPS]:
    'level-name=W\ngamemode=adventure\ndifficulty=peaceful\nmax-players=5\nmotd=Srv\n' +
    'pvp=false\nhardcore=true\nwhite-list=true\nonline-mode=false\nview-distance=12\nspawn-protection=4\n' });
  const c = await conn.captureProfileSettings();
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

test('mc: profileSchema groups World/Gameplay/Access; getSettings is ops-only', async () => {
  const { conn } = mc({ [MC_PROPS]: 'level-name=world\n' });
  const schema = await conn.profileSchema();
  assert.deepEqual(schema.groups.map((g) => g.key), ['world', 'gameplay', 'access']);
  assert.ok(schema.groups[1].fields.some((f) => f.key === 'gamemode' && f.type === 'select'));
  assert.ok(schema.groups[2].fields.some((f) => f.key === 'whitelist' && f.type === 'bool'));
  const ops = await conn.getSettings();
  assert.deepEqual(ops.sections.map((s) => s.key), ['saveAs']);
});
