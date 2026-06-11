import assert from 'node:assert/strict';
import test from 'node:test';

import { testDb } from './test-db.js';
import { fakeDockerClient } from './harness.mjs';
import { createServerStore } from '../src/servers/store.js';
import { GmodConnector } from '../src/servers/connectors/gmod.js';
import { PropHuntConnector } from '../src/servers/connectors/prophunt.js';

// CS / Factorio / Minecraft profile logic is covered by the docker-*.test.mjs
// files (the live Docker connectors + their shared *-profile.js modules). This
// file covers the store + the GMOD-family connectors (GMOD/Prop Hunt) directly.
// The live RCON action/control command canon lives in connector-goldens.test.mjs
// (the VM-era base classes no longer carry an RCON transport of their own).
//
// The transport fake is the shared harness client: an in-memory file map behind
// fileRead/fileWrite plus a benign-success exec. Map-listing helpers that grep
// see empty stdout → [].

const GMOD = { id: 'gmod', name: "Garry's Mod (TTT)", vmid: 104, port: 27066, connect: 'cs' };
const INSTANCE_CFG = '/home/miles/gmodserver/lgsm/config-lgsm/gmodserver/gmodserver.cfg';
const SERVER_CFG   = '/home/miles/gmodserver/serverfiles/garrysmod/cfg/gmodserver.cfg';
const MAPCYCLE     = '/home/miles/gmodserver/serverfiles/garrysmod/mapcycle.txt';

function gmod(files) {
  const store = createServerStore(testDb());
  const client = fakeDockerClient(files);
  return { conn: new GmodConnector(GMOD, client, store), store, client };
}

const PROPHUNT = { id: 'prophunt', name: 'Prop Hunt', vmid: 105, port: 27067, connect: 'cs' };
const PH_INST   = '/home/miles/phserver/lgsm/config-lgsm/gmodserver/gmodserver.cfg';
const PH_GAME   = '/home/miles/phserver/serverfiles/garrysmod/cfg/gmodserver.cfg';
const PH_ACTIVE = '/home/miles/phserver/serverfiles/garrysmod/cfg/gamertown/active.cfg';

function prophunt(files) {
  const store = createServerStore(testDb());
  const client = fakeDockerClient(files);
  return { conn: new PropHuntConnector(PROPHUNT, client, store), store, client };
}

function prophuntNoStore(files) {
  const client = fakeDockerClient(files);
  return { conn: new PropHuntConnector(PROPHUNT, client), client };
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
  await conn.applyProfileSettings({ ...conn.defaultProfileSettings(), workshopCollection: '', mapcycle: ['gm_construct'] }, 1);
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
  assert.ok(mapGroup.fields.find((f) => f.key === 'mapcycle').options.some((o) => o.value === 'ttt_clue_se'));
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

test('prophunt: applyProfileSettings writes gamemode + map + cvars + active.cfg (NOT the collection)', async () => {
  const { conn, client } = prophunt({ [PH_GAME]: 'rcon_password "x"\n', [PH_INST]: 'gamemode="terrortown"\n' });
  await conn.applyProfileSettings({ ...conn.defaultProfileSettings(), propHuntMap: 'ph_office_fsg_v2',
    maxPlayers: 24, kickNonAdmin: '1', rawConfig: 'phx_verbose 1\n' }, 9);

  const inst = client.files[PH_INST];
  assert.match(inst, /gamemode="prop_hunt"/);
  assert.match(inst, /defaultmap="ph_office_fsg_v2"/);
  assert.match(inst, /maxplayers="24"/);
  // Apply must NOT write wscollectionid — the X2Z gamemode + maps mount from the
  // collection only at boot; touching it here can brick the mount (managed via
  // importCollection / Raw Config instead). See docker-gmod.test.mjs bug-fix test.
  assert.ok(!/wscollectionid/.test(inst), 'apply must not write wscollectionid');
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

test('prophunt: capture lowercases a mixed-case defaultmap (matches GMOD)', async () => {
  // A defaultmap set out-of-band can carry a mixed-case Workshop title; without the
  // toLowerCase() capture would fail validate's lowercase-only MAP_NAME_RE (BAD_SETTING).
  const { conn } = prophunt({ [PH_INST]: 'defaultmap="ph_Office"\n' });
  let result;
  await assert.doesNotReject(async () => { result = await conn.captureProfileSettings(); });
  assert.equal(result.propHuntMap, 'ph_office');
});

test('prophunt: profileSchema groups Map/X2Z/Controls/Advanced', async () => {
  const { conn } = prophunt();
  const schema = await conn.profileSchema();
  assert.deepEqual(schema.groups.map((g) => g.key), ['map', 'x2z', 'controls', 'advanced']);
  const [mapG, x2zG, ctrlG, advG] = schema.groups;
  assert.ok(mapG.fields.some((f) => f.key === 'propHuntMap' && f.type === 'select'));
  assert.ok(mapG.fields.some((f) => f.key === 'workshopCollection' && f.type === 'text' && f.readOnly === true));
  assert.ok(mapG.fields.some((f) => f.type === 'mapsync'));
  // X2Z group now mixes bool toggles + numeric cvars (round time, hide time, …).
  assert.ok(x2zG.fields.every((f) => f.type === 'bool' || f.type === 'number') && x2zG.fields.length >= 3);
  assert.ok(x2zG.fields.some((f) => f.type === 'number')); // the new numeric X2Z cvars
  assert.ok(ctrlG.fields.length >= 4 && ctrlG.fields.every((f) => f.type === 'info' && f.help));
  assert.ok(advG.fields.some((f) => f.key === 'rawConfig' && f.type === 'textarea'));
});

test('prophunt: writeConfig writes the file and returns ok (no chown-back exec)', async () => {
  const { conn, client } = prophuntNoStore({ [PH_ACTIVE]: '' });
  assert.deepEqual(await conn.writeConfig('active.cfg', 'phx_verbose 1\n'), { name: 'active.cfg', ok: true });
  assert.equal(client.files[PH_ACTIVE], 'phx_verbose 1\n');
  assert.ok(!client.execCalls.some((c) => c.command.some((a) => String(a).includes('chown'))), 'no chown exec should run');
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
