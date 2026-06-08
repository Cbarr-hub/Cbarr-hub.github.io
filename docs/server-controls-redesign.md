# Server-Controls Redesign — Implementation Spec

> Generated from the Phase-1 ultracode research+design workflow (run wf_da0bf12a-18b), then
> reconciled against the live code. This is the build contract for the feature/server-controls-redesign branch.

> **UPDATE (2026-06-07, `feature/servers-intent-switch`):** the detail slide-over's flat tab
> strip (`DTABS` / `gateTabs` / one-pane-at-a-time `activatePane`) was reorganized into a
> **persona "Intent Switch"** — a 3-way mode control (`MODES`: **Connect · Tweak · Full**) in
> `detailShell`, dispatched by `applyMode()`. **Connect** (`renderConnect`) = Joiner: join +
> Steam launch + live tiles + trimmed power. **Tweak** (`renderTweak` + the `TWEAK` per-game
> copy map) = Tinkerer: the schema's `basic:true` fields with a game-native header + a fenced
> "Live Now" group (`getLive` actions/controls). **Full** = the original tab surface unchanged
> (it still calls `gateTabs()`), where Force Stop + Update live. The fleet tiles are untouched.
> Unsaved edits survive mode/refresh via `snapshotFormIfDirty()`. The capability-organized IA
> below is the *Full* surface; the persona layering is purely additive on top of it.

## Goal
All-new servers.html layout; far more per-game configurable surface (gameplay cvars, live
runtime controls, presets/sharing, raw-config power-tools); and a UNIFIED Steam Workshop
collection -> selectable-maps ingestion shared identically by CS2, TTT, and Prop Hunt.

## Reconciliation decisions (where the two specs differed or could simplify)
1. **Presets (clone/export/import) = client-side only.** db.js already exposes dbCreateProfile(id,name,settings),
   which runs validateProfileSettings server-side. So Export = download JSON of the profile settings; Import =
   file-pick -> dbCreateProfile; Clone = dbCreateProfile with the current form values. **No new backend routes,
   no base.js clone/export/import methods.** (Supersedes backend spec section 4.)
2. **Cvar reference / power-tools = embedded in profileSchema().** Each connector returns an optional
   schema.cvarRef:[{name,type,default,min,max,help,group}] built from its existing *_FIELDS tables. The Raw-Config
   tab reads schema.cvarRef for autocomplete/validation. **No /config-reference endpoint, no service wiring.**
   (Simplifies backend spec section 5; drops 5b.)
3. **Validate-before-apply = client-side lint only.** Apply already validates server-side and returns BAD_SETTING
   with a human message the UI surfaces. No dedicated /profiles/validate endpoint. (Drops backend spec 5c.)
4. **No DB migration.** Every change lives in existing tables or the settings JSON blob.
5. **Net effect: ALL backend changes live in per-game files** (counterstrike-profile.js, docker/counterstrike.js,
   gmod.js, prophunt.js, factorio-profile.js, docker/factorio.js, minecraft-profile.js, docker/minecraft.js).
   base.js / service.js / routes/servers.js need at most a widened comment -> clean parallel fan-out by game.

## Flagged for HOST VALIDATION (cannot verify from the repo)
- CS2: new mp_*/sv_*/bot_* cvars + host_workshop_map/ds_workshop_changelevel apply over RCON on joedwards32/cs2.
- GMOD/PH: wscollectionid is the live instance-cfg var; writable pre-restart without breaking the running mount;
  ttt_roundrestart / gmod_admin_cleanup over RCON.
- **PH latent bug:** prophunt.js applyProfileSettings currently writes wscollectionid (CLAUDE.md says it must NOT,
  so Apply cannot break the X2Z mount). Spec removes it; verify X2Z still boots after Apply.
- Factorio: map-settings.json path read by the image; RCON /sc works regardless of allow_commands (disables achievements).
- Minecraft: gamerule name casing (camelCase vs snake_case) for the deployed VERSION.

---

# PART A — BACKEND SPEC

I now have a complete and precise picture of every interface. Here is the implementation spec.

---

# Gamertown Backend Redesign — Implementation Spec

This spec extends the existing connector/service/route/store architecture without breaking any current interface. Every change is additive at the contract level (the panel already renders whatever `profileSchema()` + `getLive()` declare). New field types introduced: `group-header` (visual only) and reuse of existing `info`. No new field renderer is strictly required except an optional `cvarref` autocomplete hint (§5), which degrades to `text`.

Naming convention for new shared modules: one pure, transport-agnostic helper per game already exists (`counterstrike-profile.js`, `factorio-profile.js`, `minecraft-profile.js`). TTT/PH cvars currently live inline in `gmod.js`/`prophunt.js`; this spec keeps that pattern (inline `*_FIELDS` arrays) to minimize churn.

---

## 1. UNIFIED Steam Workshop collection ingestion (CS2 + TTT + Prop Hunt)

### Problem reconciliation

Two existing models must be driven by ONE call:

- **CS2 (DB-catalog):** `importCollection(id)` already exists — fetches members keylessly, upserts each into `server_workshop_maps`, maps are referenced live as `host_workshop_map <id>` / `ds_workshop_changelevel <name>`. No filesystem step.
- **GMOD/PH (mount-at-boot + gmad-sync):** maps mount only at boot from `wscollectionid`; `syncMaps()` extracts `.bsp` into `garrysmod/maps/`. There is no per-map DB catalog and the collection id is a single profile field.

The unifying insight: **both flows are "given a collection id, make its maps selectable."** We expose ONE connector hook and ONE route that each game maps onto its own model.

### 1a. New BaseConnector hook — `importCollection(collectionId)` already exists; formalize the contract

**File:** `backend/src/servers/connectors/base.js`

The base already declares `importCollection() { throw notSupported(...) }`. Keep it, but document the unified return shape so the panel can render identically:

```js
// base.js — replace the stub with a documented contract (still throws by default)
// importCollection(collectionId) → {
//   ok: true,
//   imported: <number of maps now selectable>,
//   maps: [{ value, label }],   // selectable map options (ws:<id> for CS, bsp name for GMOD)
//   note?: string,              // e.g. "Restart to download + mount the collection."
//   requiresRestart?: boolean,  // true for GMOD/PH (mount-at-boot), false for CS (live)
// }
importCollection() { throw notSupported('workshop collection import'); }
```

The route + service already pass `collectionId` straight through (`svc.importCollection(id, body.collectionId)` in `service.js:145`). **No route change needed for CS** — the existing `POST /:id/maps/collection` (`servers.js:139`) is the unified endpoint. We make GMOD/PH implement the same method so the SAME route works for all three.

### 1b. CS2 — already conformant, adjust return shape

**File:** `backend/src/servers/connectors/docker/counterstrike.js` — `importCollection()` (currently line 124)

Change the return to the unified shape:

```js
async importCollection(collectionId) {
  this.requireStore();
  const maps = await fetchCollectionMaps(collectionId);
  if (!maps.length) throw badSetting('that Workshop collection has no items.');
  for (const m of maps) {
    this.store.addWorkshopMap(this.server.id, { workshopId: m.workshopId, name: sanitizeAutoName(m.name, m.workshopId) });
  }
  const catalog = this.store.listWorkshopMaps(this.server.id);
  return {
    ok: true,
    imported: maps.length,
    maps: catalog.map((w) => ({ value: `ws:${w.workshopId}`, label: w.name })),
    requiresRestart: false,
    note: 'Imported into the live catalog — selectable immediately; Apply changes the running map over RCON.',
  };
}
```

### 1c. GMOD/TTT + Prop Hunt — implement `importCollection` to drive their mount-at-boot model

**File:** `backend/src/servers/connectors/gmod.js` — add method on `GmodConnector`

The GMOD model can't fetch arbitrary collections into a DB catalog and live-mount them (mount is boot-only). The unified call therefore: (1) **writes the collection id into the profile's instance cfg field** so the next restart mounts it, and (2) returns the member names (keyless, for display) plus `requiresRestart:true`. The actual install into `garrysmod/maps/` still happens via the existing `syncMaps()` after restart — but we make `importCollection` set the collection id AND run a sync attempt so a single button works.

```js
import { fetchCollectionMaps } from '../steam-workshop.js'; // add to existing imports

// On GmodConnector:
async importCollection(collectionId) {
  const id = String(collectionId ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) throw badSetting('workshop collection id must be digits');

  // 1) Persist the collection id into the instance cfg so the NEXT boot mounts it.
  const P = this.paths;
  let inst = (await this.client.agentFileRead(this.vmid, P.instanceCfg)).content ?? '';
  inst = setVars(inst, { wscollectionid: id });
  await this.client.agentFileWrite(this.vmid, P.instanceCfg, inst);

  // 2) Best-effort: extract any already-downloaded .gma into maps/ (no-op pre-restart).
  await this.syncMaps().catch(() => {});

  // 3) Member names for display (keyless). Names are titles, not bsp names — informational.
  let members = [];
  try { members = await fetchCollectionMaps(id); } catch { /* private/empty → skip */ }
  const installed = await this.installedMaps();

  return {
    ok: true,
    imported: installed.length,
    maps: installed.map((m) => ({ value: m, label: m })),
    members: members.map((m) => ({ id: m.workshopId, title: m.name })), // advisory
    requiresRestart: true,
    note: `Collection ${id} set. Restart Hosting so Steam downloads + mounts it, then “Sync from Collection” to install its maps.`,
  };
}
```

**File:** `backend/src/servers/connectors/prophunt.js` — `PropHuntConnector` inherits this unchanged (it already extends `GmodConnector`, has its own `paths`/`installedMaps` with `ph_` prefixes). No override needed; the inherited method writes the PH instance cfg correctly because `this.paths` is subclass-derived.

> ⚠ **Host validation:** confirm `wscollectionid` is the live variable name in the container's instance cfg (it is per CLAUDE.md), and that writing it pre-restart doesn't break the currently-mounted session (it shouldn't — it's read only at boot).

### 1d. Frontend contract (for the frontend agent)

The single button "Import Collection" calls `POST /:id/maps/collection { collectionId }` for ALL THREE games. The response's `requiresRestart` flag tells the panel whether to prompt "Restart Hosting now?" (GMOD/PH) or just refresh the map dropdown (CS). `maps` is the new selectable option list; `members` (GMOD/PH only) can be shown as an advisory "what's in the collection" list.

**Service/route:** unchanged — `service.js:145` and `servers.js:139` already wire it. The CS-only comment in `servers.js:137-138` should be widened to "CS / GMOD / PH".

---

## 2. Expanded profile schemas per game

All additions are new fields in `defaultProfileSettings()` + `validateProfileSettings()` + the schema groups + apply/capture. Boot-vs-live semantics preserved (CS = live RCON; everyone else = restart).

### 2a. Counter-Strike 2

**File:** `backend/src/servers/connectors/counterstrike-profile.js`

Add structured cvar fields (live-applied). Define a data table mirroring the GMOD pattern:

```js
// New: live-settable mp_/sv_ cvars (pushed in applyProfileSettings; revert on restart).
export const CS_CVAR_FIELDS = [
  { cvar: 'mp_maxrounds',         key: 'maxRounds',     label: 'Max Rounds',          def: 24,   min: 0,  max: 60,    int: true },
  { cvar: 'mp_roundtime_defuse',  key: 'roundTime',     label: 'Round Time (min)',    def: 1.92, min: 0.25, max: 60 },
  { cvar: 'mp_freezetime',        key: 'freezeTime',    label: 'Freeze Time (s)',     def: 15,   min: 0,  max: 60,    int: true },
  { cvar: 'mp_buytime',           key: 'buyTime',       label: 'Buy Time (s)',        def: 20,   min: 0,  max: 120,   int: true },
  { cvar: 'mp_startmoney',        key: 'startMoney',    label: 'Start Money',         def: 800,  min: 0,  max: 16000, int: true },
  { cvar: 'mp_friendlyfire',      key: 'friendlyFire',  label: 'Friendly Fire',       def: 1,    min: 0,  max: 1,     int: true, bool: true },
  { cvar: 'mp_autoteambalance',   key: 'autoBalance',   label: 'Auto Team Balance',   def: 1,    min: 0,  max: 1,     int: true, bool: true },
  { cvar: 'mp_overtime_enable',   key: 'overtime',      label: 'Overtime',            def: 0,    min: 0,  max: 1,     int: true, bool: true },
  { cvar: 'mp_warmuptime',        key: 'warmupTime',    label: 'Warmup Time (s)',     def: 60,   min: 0,  max: 600,   int: true },
  { cvar: 'bot_quota',            key: 'botQuota',      label: 'Bots',                def: 0,    min: 0,  max: 64,    int: true },
  { cvar: 'bot_difficulty',       key: 'botDifficulty', label: 'Bot Difficulty',      def: 2,    min: 0,  max: 3,     int: true },
];
```

`defaultProfileSettings()` — fold these in:

```js
export function defaultProfileSettings() {
  const d = { map: 'de_dust2', gameMode: 'competitive', hostname: '', rawConfig: '' };
  for (const f of CS_CVAR_FIELDS) d[f.key] = f.def;
  return d;
}
```

`validateProfileSettings()` — after the existing rawConfig block, before `return out`:

```js
for (const f of CS_CVAR_FIELDS) {
  const n = Number(s[f.key]);
  if (Number.isNaN(n)) throw badSetting(`${f.label} must be a number`);
  if (n < f.min || n > f.max) throw badSetting(`${f.label} must be ${f.min}–${f.max}`);
  if (f.int && !Number.isInteger(n)) throw badSetting(`${f.label} must be a whole number`);
  out[f.key] = n;
}
```

`profileGroups()` — add a third group:

```js
{
  key: 'rules', title: 'Match Rules',
  fields: CS_CVAR_FIELDS.map((f) =>
    f.bool
      ? { key: f.key, label: f.label, type: 'bool' }
      : { key: f.key, label: f.label, type: 'number', min: f.min, max: f.max, step: f.int ? 1 : 0.01 }),
},
```

**File:** `backend/src/servers/connectors/docker/counterstrike.js` — `applyProfileSettings()` (line 87). Append cvar commands to the live RCON batch:

```js
for (const f of csProfile.CS_CVAR_FIELDS) {
  parts.push(`${f.cvar} ${f.bool ? (s[f.key] ? 1 : 0) : s[f.key]}`);
}
```

Bool fields validate as 0/1 numbers already; the `type:'bool'` renderer sends `'1'`/`'0'`, and `Number()` accepts those — keep validation as numeric. `captureProfileSettings()` stays returning defaults (env-driven, unreadable).

> Note: `apply.mode:'live'` is unchanged — these all push over RCON. `mp_roundtime_defuse` needs a map reload to fully bite, but Apply already issues `changelevel`/`host_workshop_map` after, so it lands.

### 2b. GMOD / TTT

**File:** `backend/src/servers/connectors/gmod.js` — extend `TTT_FIELDS` (line 97). Add high-value rows:

```js
// Append to TTT_FIELDS:
{ cvar: 'ttt_preptime_seconds',      key: 'prepTime',      label: 'Prep Time (s)',        def: 30,  min: 5,  max: 120, int: true },
{ cvar: 'ttt_haste',                 key: 'haste',         label: 'Haste Mode',           def: 1,   min: 0,  max: 1,   int: true, bool: true },
{ cvar: 'ttt_haste_starting_minutes',key: 'hasteStart',    label: 'Haste Start (min)',    def: 5,   min: 1,  max: 20,  int: true },
{ cvar: 'ttt_karma',                 key: 'karma',         label: 'Karma System',         def: 1,   min: 0,  max: 1,   int: true, bool: true },
{ cvar: 'ttt_karma_low_autokick',    key: 'karmaAutokick', label: 'Karma Autokick',       def: 0,   min: 0,  max: 1,   int: true, bool: true },
{ cvar: 'ttt_karma_low_ban',         key: 'karmaBan',      label: 'Karma Auto-ban',       def: 0,   min: 0,  max: 1,   int: true, bool: true },
{ cvar: 'ttt_credits_starting',      key: 'creditsStart',  label: 'Starting Credits',     def: 2,   min: 0,  max: 8,   int: true },
{ cvar: 'ttt_detective_min_players', key: 'detMinPlayers', label: 'Min Players for Det.', def: 5,   min: 0,  max: 32,  int: true },
{ cvar: 'ttt_postround_dm',          key: 'postroundDm',   label: 'Post-round Deathmatch',def: 0,   min: 0,  max: 1,   int: true, bool: true },
{ cvar: 'sv_alltalk',                key: 'allTalk',        label: 'All-talk Voice',       def: 1,   min: 0,  max: 1,   int: true, bool: true },
```

`numField` in `profileSchema()` (line 267) must now branch on `f.bool`:

```js
const numField = (f) => f.bool
  ? { key: f.key, label: f.label, type: 'bool' }
  : { key: f.key, label: f.label, type: 'number', min: f.min, max: f.max, step: f.int ? 1 : 0.01 };
```

`validateProfileSettings()` (line 240 loop) already validates every `TTT_FIELDS` entry generically — bool fields pass as 0/1 numbers; the `type:'bool'` UI sends `'1'`/`'0'` which `Number()` accepts. **One fix:** the loop uses `Number(s[f.key])`; a bool checkbox sends `'1'`/`'0'` strings → fine. No change needed. `applyProfileSettings()` (line 332) already writes `for (const f of TTT_FIELDS) cvars[f.cvar] = String(s[f.key])` — works for the new rows. `captureProfileSettings()` (line 362) likewise iterates `TTT_FIELDS` — works. **The data-table pattern means TTT needs ZERO logic changes beyond the `numField` bool branch.**

> Split into two visual groups for readability: in `profileSchema()`, partition `TTT_FIELDS` into "Round & Roles" and "Karma & Economy" by adding an optional `group` tag per row and grouping in the schema builder. Optional polish; not required for correctness.

### 2c. Prop Hunt — X2Z

**File:** `backend/src/servers/connectors/prophunt.js` — extend `PH_CVARS` (line 38). The research confirms many real `ph_*` cvars exist (the old "menu-only" claim was overcautious). Add numeric + bool rows; switch `PH_CVARS` to the typed table shape used by TTT:

```js
const PH_CVARS = [
  // existing booleans, now typed:
  { cvar: 'fretta_waitforplayers',      key: 'waitForPlayers',  label: 'Wait for players',          def: 1, bool: true },
  { cvar: 'ph_enable_team_itemspawner', key: 'teamItemSpawner', label: 'Team item spawners',        def: 1, bool: true },
  { cvar: 'ph_swap_teams_every_round',  key: 'swapTeams',       label: 'Swap teams each round',     def: 1, bool: true },
  { cvar: 'ph_enable_lucky_balls',      key: 'luckyBalls',      label: 'Lucky balls',               def: 1, bool: true },
  { cvar: 'ph_freezecam',               key: 'freezecam',       label: 'Freeze-cam on death',       def: 1, bool: true },
  { cvar: 'phx_integrity_check',        key: 'integrityCheck',  label: 'Integrity check (keep on)', def: 1, bool: true },
  { cvar: 'phx_verbose',                key: 'verboseLog',      label: 'Verbose logging',           def: 0, bool: true },
  // new numerics:
  { cvar: 'ph_round_time',              key: 'roundTime',       label: 'Round Time (s)',  def: 250, min: 60,  max: 600, int: true },
  { cvar: 'ph_hunter_blindlock_time',  key: 'blindTime',        label: 'Hide Time (s)',   def: 30,  min: 10,  max: 60,  int: true },
  { cvar: 'ph_rounds_per_map',          key: 'roundsPerMap',    label: 'Rounds per Map',  def: 10,  min: 1,   max: 20,  int: true },
  { cvar: 'ph_prop_jumppower',          key: 'propJump',        label: 'Prop Jump Power', def: 1.4, min: 1,   max: 3 },
  { cvar: 'ph_hunter_fire_penalty',     key: 'firePenalty',     label: 'Hunter Fire Penalty', def: 10, min: 0, max: 25, int: true },
];
```

`defaultProfileSettings()` (line 115) — the `asBool` seed must become type-aware:

```js
defaultProfileSettings() {
  const d = { propHuntMap: DEFAULT_MAP, workshopCollection: COLLECTION, maxPlayers: 16, rawConfig: '' };
  for (const f of PH_CVARS) d[f.key] = f.bool ? asBool(f.def) : f.def;
  return d;
}
```

`validateProfileSettings()` (line 136) — replace the `asBool`-only loop:

```js
for (const f of PH_CVARS) {
  if (f.bool) { out[f.key] = asBool(s[f.key] === undefined ? f.def : s[f.key]); continue; }
  const n = Number(s[f.key] === undefined ? f.def : s[f.key]);
  if (Number.isNaN(n) || n < f.min || n > f.max) throw badSetting(`${f.label} must be ${f.min}–${f.max}`);
  if (f.int && !Number.isInteger(n)) throw badSetting(`${f.label} must be a whole number`);
  out[f.key] = n;
}
```

`profileSchema()` (line 150) — `boolField` becomes type-aware:

```js
const cvarField = (f) => f.bool
  ? { key: f.key, label: f.label, type: 'bool' }
  : { key: f.key, label: f.label, type: 'number', min: f.min, max: f.max, step: f.int ? 1 : 0.1 };
// X2Z group fields: PH_CVARS.map(cvarField)
```

`applyProfileSettings()` (line 205) — writes `for (const f of PH_CVARS) cvars[f.cvar] = s[f.key]` — already correct for both shapes (bool stored as `'1'`/`'0'`, numbers as numbers; `setCvars` stringifies). `captureProfileSettings()` (line 229) — make type-aware:

```js
for (const f of PH_CVARS) {
  const v = getCvar(game, f.cvar);
  if (f.bool) { doc[f.key] = asBool(v === undefined || v === '' ? f.def : v); }
  else { doc[f.key] = v === undefined || v === '' ? f.def : Number(v); }
}
```

> PH still must **NOT** write `wscollectionid` in `applyProfileSettings` — confirmed it doesn't (it writes it in `applyProfileSettings`? — re-check: line 199 DOES write `wscollectionid: s.workshopCollection`). ⚠ **The research says PH apply must NOT touch wscollectionid.** This is an existing latent bug. **Fix:** remove `wscollectionid` from the `setVars` call in `prophunt.js applyProfileSettings()` (line 195-201) so Apply can't break the X2Z mount; the collection id is managed only via `importCollection` / Raw Config. Host-validate this.

### 2d. Factorio

**File:** `backend/src/servers/connectors/factorio-profile.js`

Add map-settings (live-mutable but stored as boot defaults too) — `enemy_evolution`, `pollution`, `enemy_expansion` toggles + autosave already present. Add fields:

```js
export function defaultProfileSettings() {
  return {
    saveName: '', serverName: 'Gamertown Factorio', description: '',
    maxPlayers: 0, visibility: 'lan', password: '', autosaveInterval: 10,
    // new:
    autoPause: '1', evolutionEnabled: '1', pollutionEnabled: '1',
    expansionEnabled: '1', techPriceMultiplier: 1,
  };
}
```

`validateProfileSettings()` add (before return):

```js
const bool = (v) => (String(v) === '1' || v === true ? '1' : '0');
out.autoPause = bool(s.autoPause);
out.evolutionEnabled = bool(s.evolutionEnabled);
out.pollutionEnabled = bool(s.pollutionEnabled);
out.expansionEnabled = bool(s.expansionEnabled);
const tpm = Number(s.techPriceMultiplier);
if (!(tpm >= 0.25 && tpm <= 10)) throw badSetting('tech price multiplier must be 0.25–10');
out.techPriceMultiplier = tpm;
```

`applyServerSettings(json, v)` — `auto_pause` lives in server-settings.json:

```js
json.auto_pause = validated.autoPause === '1';
```

The evolution/pollution/expansion/tech knobs live in **map-settings.json**, not server-settings.json, AND are best applied live via RCON `/sc game.map_settings.*`. Add a connector-side apply path:

**File:** `backend/src/servers/connectors/docker/factorio.js` — `applyProfileSettings()` (line 61). After writing server-settings.json, also write map-settings.json AND (if running) push live:

```js
// map-settings.json (boot truth)
const mtext = (await this.client.agentFileRead(this.vmid, `${CONFIG}/map-settings.json`)).content ?? '';
let mjson; try { mjson = JSON.parse(mtext || '{}'); } catch { mjson = {}; }
mjson.enemy_evolution = { ...(mjson.enemy_evolution||{}), enabled: s.evolutionEnabled === '1' };
mjson.pollution       = { ...(mjson.pollution||{}),       enabled: s.pollutionEnabled === '1' };
mjson.enemy_expansion = { ...(mjson.enemy_expansion||{}), enabled: s.expansionEnabled === '1' };
mjson.difficulty_settings = { ...(mjson.difficulty_settings||{}), technology_price_multiplier: s.techPriceMultiplier };
await this.client.agentFileWrite(this.vmid, `${CONFIG}/map-settings.json`,
  JSON.stringify(mjson, null, 2) + '\n');
```

> map-settings.json is baked into the save at generation; editing it only affects a NEW world. For the existing world the live RCON `/sc game.map_settings.*` route (added in §3d) is how a running change takes effect. Document this in `PROFILE_NOTE`. ⚠ **Host validation:** confirm map-settings.json path + that the factoriotools image reads it.

`profileGroups(saveOpts)` — add a "Rules" group:

```js
{
  key: 'rules', title: 'World Rules',
  fields: [
    { key: 'autoPause',        label: 'Auto-pause when empty', type: 'bool' },
    { key: 'evolutionEnabled', label: 'Biter Evolution',       type: 'bool' },
    { key: 'pollutionEnabled', label: 'Pollution',             type: 'bool' },
    { key: 'expansionEnabled', label: 'Biter Expansion',       type: 'bool' },
    { key: 'techPriceMultiplier', label: 'Research Cost ×', type: 'number', min: 0.25, max: 10, step: 0.25 },
  ],
},
```

`captureServerSettings(json)` — add `autoPause: json.auto_pause === false ? '0' : '1'`; the map-settings fields capture defaults (the connector reads map-settings.json in capture — optional; safe to default).

### 2e. Minecraft

**File:** `backend/src/servers/connectors/minecraft-profile.js`

`defaultProfileSettings()` add: `allowNether:'1', spawnMonsters:'1', simulationDistance:10, playerIdleTimeout:0, commandBlocks:'0'`.

`validateProfileSettings()` add:

```js
out.allowNether = bool(s.allowNether ?? '1');
out.spawnMonsters = bool(s.spawnMonsters ?? '1');
out.commandBlocks = bool(s.commandBlocks ?? '0');
out.simulationDistance = intIn(s.simulationDistance ?? 10, 3, 32, 'simulation distance');
out.playerIdleTimeout  = intIn(s.playerIdleTimeout ?? 0, 0, 1440, 'idle timeout');
```

`applyProps(text, settings)` add:

```js
set('allow-nether', s.allowNether === '1' ? 'true' : 'false');
set('spawn-monsters', s.spawnMonsters === '1' ? 'true' : 'false');
set('enable-command-block', s.commandBlocks === '1' ? 'true' : 'false');
set('simulation-distance', String(s.simulationDistance));
set('player-idle-timeout', String(s.playerIdleTimeout));
```

`captureProps(text)` add the mirror reads. `profileGroups()` — add to the Gameplay group:

```js
{ key: 'allowNether',   label: 'Allow Nether',        type: 'bool' },
{ key: 'spawnMonsters', label: 'Spawn Monsters',      type: 'bool' },
{ key: 'commandBlocks', label: 'Command Blocks',      type: 'bool' },
{ key: 'simulationDistance', label: 'Simulation Distance', type: 'number', min: 3, max: 32, step: 1 },
{ key: 'playerIdleTimeout',  label: 'Idle Kick (min, 0=off)', type: 'number', min: 0, max: 1440, step: 1 },
```

> All Minecraft profile fields are restart-only (server.properties is regenerated on start; itzg env mapping). Gamerules (keepInventory etc.) are world data — those belong in §3e (live RCON), NOT the profile.

---

## 3. More live runtime controls (`getLive` actions + controls)

`getLive` shape is fixed: `{ available, actions:[{key,label}], controls:[{key,label,min,max,step,default,suffix?}], changeMap, commandHint }`. `runLiveAction(key, value)` dispatches. All commands below are exact.

### 3a. CS2

**File:** `backend/src/servers/connectors/counterstrike-profile.js` — extend `CS_LIVE_ACTIONS` + `CS_ACTION_CMDS` and add `CS_LIVE_CONTROLS`:

```js
export const CS_LIVE_ACTIONS = [
  { key: 'restart_round', label: 'Restart Round' },
  { key: 'warmup_end',    label: 'End Warmup' },
  { key: 'swap_teams',    label: 'Swap Teams' },
  { key: 'pause',         label: 'Pause Match' },
  { key: 'unpause',       label: 'Unpause' },
  { key: 'bot_add',       label: 'Add Bot' },
  { key: 'bot_kick',      label: 'Kick Bots' },
  { key: 'apply_config',  label: 'Apply Config' },
  { key: 'cheats_on',     label: 'Cheats On' },
  { key: 'cheats_off',    label: 'Cheats Off' },
  { key: 'bunnyhop_on',   label: 'Bunnyhop On' },
  { key: 'bunnyhop_off',  label: 'Bunnyhop Off' },
];
export const CS_ACTION_CMDS = {
  restart_round: 'mp_restartgame 1',
  warmup_end:    'mp_warmup_end',
  swap_teams:    'mp_swapteams',
  pause:         'mp_pause_match',
  unpause:       'mp_unpause_match',
  bot_add:       'bot_add',
  bot_kick:      'bot_kick',
  apply_config:  'exec gamertown/active',
  cheats_on:     'sv_cheats 1',
  cheats_off:    'sv_cheats 0',
  bunnyhop_on:   'sv_cheats 1; sv_autobunnyhopping 1; sv_enablebunnyhopping 1; sv_staminamax 0; sv_airaccelerate 1000',
  bunnyhop_off:  'sv_autobunnyhopping 0; sv_enablebunnyhopping 0; sv_staminamax 14; sv_airaccelerate 12',
};
// Sliders (cheats-gated ones auto-prefix sv_cheats 1):
export const CS_LIVE_CONTROLS = [
  { key: 'gravity',    label: 'Gravity',     min: 100, max: 2000, step: 50,  default: 800 },
  { key: 'roundtime',  label: 'Round Time',  min: 1,   max: 60,   step: 1,   default: 2, suffix: 'min' },
  { key: 'startmoney', label: 'Start Money', min: 0,   max: 16000,step: 500, default: 800 },
  { key: 'bots',       label: 'Bot Count',   min: 0,   max: 10,   step: 1,   default: 0 },
];
export function csRangeCmd(key, value) {
  const ctl = CS_LIVE_CONTROLS.find((c) => c.key === key);
  if (!ctl) return null;
  let n = Number(value);
  if (!Number.isFinite(n)) throw badSetting(`invalid value for ${ctl.label}`);
  n = Math.min(ctl.max, Math.max(ctl.min, n));
  switch (key) {
    case 'gravity':    return `sv_cheats 1; sv_gravity ${Math.round(n)}`;
    case 'roundtime':  return `mp_roundtime_defuse ${n}; mp_roundtime ${n}`;
    case 'startmoney': return `mp_startmoney ${Math.round(n)}; mp_maxmoney 16000`;
    case 'bots':       return `bot_quota ${Math.round(n)}`;
    default:           return null;
  }
}
```

**File:** `backend/src/servers/connectors/docker/counterstrike.js` — `getLive()` add `controls`; `runLiveAction()` (line 204) try `csRangeCmd` first:

```js
async getLive() {
  if (!this.#password()) return { available: false, reason: 'CS2_RCON_PASSWORD is not set' };
  return { available: true, actions: csProfile.CS_LIVE_ACTIONS, controls: csProfile.CS_LIVE_CONTROLS,
           changeMap: true, commandHint: 'any CS2 console command, e.g. bot_add, mp_warmup_end' };
}
async runLiveAction(key, value) {
  if (key === 'change_map') return { output: await this.#rcon(csProfile.buildChangeMapCmd(value)) };
  const range = csProfile.csRangeCmd(key, value);
  if (range) return { output: await this.#rcon(range) };
  const cmd = csProfile.CS_ACTION_CMDS[key];
  if (!cmd) throw badSetting(`unknown live action: ${key}`);
  return { output: await this.#rcon(cmd) };
}
```

### 3b. GMOD / TTT

**File:** `backend/src/servers/connectors/gmod.js` — extend `GMOD_LIVE_ACTIONS` + `GMOD_ACTION_CMDS`:

```js
export const GMOD_LIVE_ACTIONS = [
  { key: 'restart_round', label: 'Restart Round' },
  { key: 'cleanup',       label: 'Clean Up Props' },
  { key: 'bhop_on',       label: 'Bunnyhop On' },
  { key: 'bhop_off',      label: 'Bunnyhop Off' },
  { key: 'alltalk_on',    label: 'All-talk On' },
  { key: 'alltalk_off',   label: 'All-talk Off' },
  { key: 'cheats_on',     label: 'Cheats On' },
  { key: 'cheats_off',    label: 'Cheats Off' },
  { key: 'players',       label: 'List Players' },
];
export const GMOD_ACTION_CMDS = {
  restart_round: 'ttt_roundrestart',
  cleanup:       'gmod_admin_cleanup',
  bhop_on:       'sv_cheats 1; sv_autobunnyhopping 1; sv_enablebunnyhopping 1; sv_airaccelerate 1000',
  bhop_off:      'sv_autobunnyhopping 0; sv_enablebunnyhopping 0; sv_airaccelerate 12',
  alltalk_on:    'sv_alltalk 1',
  alltalk_off:   'sv_alltalk 0',
  cheats_on:     'sv_cheats 1',
  cheats_off:    'sv_cheats 0',
  players:       'status',
};
```

Add to `GMOD_LIVE_CONTROLS` (line 71) — TTT-tunable next-round cvars:

```js
{ key: 'traitor_pct', label: 'Traitor Ratio', min: 0.05, max: 0.5, step: 0.01, default: 0.25 },
{ key: 'round_limit', label: 'Rounds/Map',    min: 1,    max: 15,  step: 1,    default: 6 },
```

`gmodRangeCmd()` (line 80) — add cases:

```js
case 'traitor_pct': return `ttt_traitor_pct ${n}`;
case 'round_limit': return `ttt_round_limit ${Math.round(n)}`;
```

`restart_round` requires admin/cheats — `ttt_roundrestart` works over RCON (RCON is implicit admin). No `getLive` change needed (TTT already advertises `controls: GMOD_LIVE_CONTROLS`).

### 3c. Prop Hunt

**File:** `backend/src/servers/connectors/prophunt.js` — extend `PH_LIVE_ACTIONS` + `PH_ACTION_CMDS`:

```js
const PH_LIVE_ACTIONS = [
  { key: 'next_round',  label: 'Next Round' },
  { key: 'map_vote',    label: 'Start Map Vote' },
  { key: 'luckyballs_on',  label: 'Lucky Balls On' },
  { key: 'luckyballs_off', label: 'Lucky Balls Off' },
  { key: 'autotaunt_on',   label: 'Auto-taunt On' },
  { key: 'autotaunt_off',  label: 'Auto-taunt Off' },
  { key: 'bhop_on',     label: 'Bunnyhop On' },
  { key: 'bhop_off',    label: 'Bunnyhop Off' },
  { key: 'cheats_on',   label: 'Cheats On' },
  { key: 'cheats_off',  label: 'Cheats Off' },
  { key: 'apply_config',label: 'Apply Config' },
  { key: 'players',     label: 'List Players' },
];
const PH_ACTION_CMDS = {
  next_round:     'ph_force_end_round',
  map_vote:       'mv_start',
  luckyballs_on:  'ph_enable_lucky_balls 1',
  luckyballs_off: 'ph_enable_lucky_balls 0',
  autotaunt_on:   'ph_autotaunt_enabled 1',
  autotaunt_off:  'ph_autotaunt_enabled 0',
  bhop_on:        'sv_cheats 1; sv_autobunnyhopping 1; sv_enablebunnyhopping 1; sv_airaccelerate 1000',
  bhop_off:       'sv_autobunnyhopping 0; sv_enablebunnyhopping 0; sv_airaccelerate 12',
  cheats_on:      'sv_cheats 1',
  cheats_off:     'sv_cheats 0',
  apply_config:   `exec ${ACTIVE_EXEC}`,
  players:        'status',
};
```

Add PH-specific sliders. PH's `getLive` advertises shared `GMOD_LIVE_CONTROLS`; add a PH-local controls list and merge:

```js
const PH_LIVE_CONTROLS = [
  ...GMOD_LIVE_CONTROLS, // gravity / speed / timescale
  { key: 'ph_round_time', label: 'Round Time', min: 60, max: 600, step: 10, default: 250, suffix: 's' },
  { key: 'ph_blind_time', label: 'Hide Time',  min: 10, max: 60,  step: 5,  default: 30,  suffix: 's' },
];
```

`runLiveAction()` (line 249) — handle PH sliders before falling to `gmodRangeCmd`:

```js
async runLiveAction(key, value) {
  if (key === 'change_map') { /* unchanged */ }
  if (key === 'ph_round_time') return this.runRcon(`ph_round_time ${Math.max(60, Math.min(600, Number(value)||250))}`);
  if (key === 'ph_blind_time') return this.runRcon(`ph_hunter_blindlock_time ${Math.max(10, Math.min(60, Number(value)||30))}`);
  const range = gmodRangeCmd(key, value);
  if (range) return this.runRcon(range);
  const cmd = PH_ACTION_CMDS[key];
  if (!cmd) throw badSetting(`unknown live action: ${key}`);
  return this.runRcon(cmd);
}
```

`getLive()` — `controls: PH_LIVE_CONTROLS`.

### 3d. Factorio

**File:** `backend/src/servers/connectors/docker/factorio.js` — extend actions + add controls. Live changes use `/silent-command` (RCON runs as admin):

```js
const FACTORIO_LIVE_ACTIONS = [
  { key: 'players',  label: 'List Players' },
  { key: 'time',     label: 'Map Time' },
  { key: 'evolution',label: 'Evolution %' },
  { key: 'save',     label: 'Save Now' },
  { key: 'peaceful_on',  label: 'Peaceful On' },
  { key: 'peaceful_off', label: 'Peaceful Off' },
  { key: 'alwaysday_on', label: 'Always Day On' },
  { key: 'alwaysday_off',label: 'Always Day Off' },
];
const FACTORIO_ACTION_CMDS = {
  players: '/players', time: '/time', evolution: '/evolution', save: '/server-save',
  peaceful_on:  '/sc game.surfaces[1].peaceful_mode=true',
  peaceful_off: '/sc game.surfaces[1].peaceful_mode=false',
  alwaysday_on: '/sc game.surfaces[1].always_day=true',
  alwaysday_off:'/sc game.surfaces[1].always_day=false',
};
const FACTORIO_LIVE_CONTROLS = [
  { key: 'game_speed', label: 'Game Speed', min: 0.25, max: 4, step: 0.25, default: 1, suffix: '×' },
  { key: 'evolution',  label: 'Evolution',  min: 0, max: 1, step: 0.05, default: 0 },
];
```

Add `getLive` controls + a `runLiveAction(key, value)` that handles ranges:

```js
async getLive() {
  const { password } = await this.#rconCreds();
  if (!password) return { available: false, reason: 'RCON password file (/factorio/config/rconpw) not readable' };
  return { available: true, actions: FACTORIO_LIVE_ACTIONS, controls: FACTORIO_LIVE_CONTROLS,
           commandHint: 'Factorio console, e.g. /players, /time, /server-save, /c game.speed=1' };
}
async runLiveAction(key, value) {
  const { password, port } = await this.#rconCreds();
  const exec = (command) => rconExchange({ host: this.server.container, port, password, command });
  if (key === 'game_speed') {
    const n = Math.max(0.25, Math.min(4, Number(value) || 1));
    return { output: await exec(`/sc game.speed=${n}`) };
  }
  if (key === 'evolution') {
    const n = Math.max(0, Math.min(1, Number(value) || 0));
    return { output: await exec(`/sc game.forces["enemy"].set_evolution_factor(${n})`) };
  }
  const cmd = FACTORIO_ACTION_CMDS[key];
  if (!cmd) { const e = new Error(`unknown live action: ${key}`); e.code = 'BAD_SETTING'; throw e; }
  return { output: await exec(cmd) };
}
```

> ⚠ `/sc` (silent-command) **disables achievements** for the save — fine for a private server, note it in the panel hint. Host-validate that RCON-issued `/sc` works regardless of `allow_commands`.

### 3e. Minecraft

**File:** `backend/src/servers/connectors/docker/minecraft.js` — actions, controls, changeMap is NOT applicable (world switch is restart-only) so leave `changeMap` off. Add gamerule/time/weather:

```js
const MC_LIVE_ACTIONS = [
  { key: 'list', label: 'List Players' },
  { key: 'save', label: 'Save World' },
  { key: 'day',   label: 'Set Day' },
  { key: 'night', label: 'Set Night' },
  { key: 'clear', label: 'Clear Weather' },
  { key: 'rain',  label: 'Rain' },
  { key: 'keepinv_on',  label: 'Keep Inventory On' },
  { key: 'keepinv_off', label: 'Keep Inventory Off' },
  { key: 'mobs_on',  label: 'Mob Spawning On' },
  { key: 'mobs_off', label: 'Mob Spawning Off' },
];
const MC_ACTION_CMDS = {
  list: 'list', save: 'save-all',
  day: 'time set day', night: 'time set night',
  clear: 'weather clear', rain: 'weather rain',
  keepinv_on:  'gamerule keepInventory true',
  keepinv_off: 'gamerule keepInventory false',
  mobs_on:  'gamerule doMobSpawning true',
  mobs_off: 'gamerule doMobSpawning false',
};
const MC_LIVE_CONTROLS = [
  { key: 'time',         label: 'Time of Day', min: 0, max: 24000, step: 1000, default: 6000 },
  { key: 'randomtick',   label: 'Random Tick Speed', min: 0, max: 20, step: 1, default: 3 },
  { key: 'sleeppct',     label: 'Sleep %', min: 0, max: 100, step: 5, default: 100 },
];
```

`getLive()` add `controls: MC_LIVE_CONTROLS`; new `runLiveAction(key, value)`:

```js
async runLiveAction(key, value) {
  if (key === 'time')       return { output: await this.#rcon(`time set ${Math.max(0,Math.min(24000,Number(value)||0))}`) };
  if (key === 'randomtick') return { output: await this.#rcon(`gamerule randomTickSpeed ${Math.max(0,Math.min(20,Number(value)||3))}`) };
  if (key === 'sleeppct')   return { output: await this.#rcon(`gamerule playersSleepingPercentage ${Math.max(0,Math.min(100,Number(value)||100))}`) };
  const cmd = MC_ACTION_CMDS[key];
  if (!cmd) { const e = new Error(`unknown live action: ${key}`); e.code = 'BAD_SETTING'; throw e; }
  return { output: await this.#rcon(cmd) };
}
```

> camelCase gamerule names are safe on current stable; if targeting 1.21.11+ snapshots they become snake_case. Host-validate against the deployed `VERSION`.

---

## 4. Presets & sharing — clone / export / import

Boot-vs-live semantics are unaffected: import/clone only create a stored profile; the existing `applyProfile` honors each connector's apply mode. Clone is purely a store/connector op.

### 4a. Clone (duplicate a profile)

The frontend already does clone via `createProfile(name, currentValues)` — **no backend change needed for the common case.** Add a first-class server-side clone for robustness (copies the stored settings, not the editor's possibly-stale form):

**File:** `backend/src/servers/connectors/base.js` — new method on BaseConnector:

```js
cloneProfile(id, name) {
  const store = this.requireStore();
  const src = store.getProfile(this.server.id, id);
  if (!src) throw notFound('profile not found');
  const nm = validProfileName(name);
  const settings = this.validateProfileSettings(src.settings);
  try { return store.createProfile(this.server.id, { name: nm, settings }); }
  catch (e) { throw duplicateError(e, nm, 'profile'); }
}
```

### 4b. Export (profile → JSON)

A profile is already plain JSON in the DB; export = `getProfile` + wrap with a version/game tag so import can validate provenance:

**File:** `backend/src/servers/connectors/base.js`:

```js
exportProfile(id) {
  const p = this.getProfile(id); // throws notFound
  return {
    gamertownProfile: 1,
    game: this.server.id,
    name: p.name,
    settings: p.settings,
    exportedAt: Math.floor(Date.now() / 1000),
  };
}
```

### 4c. Import (JSON → new profile)

**File:** `backend/src/servers/connectors/base.js`:

```js
importProfile(doc = {}, nameOverride) {
  const store = this.requireStore();
  if (doc.gamertownProfile !== 1) throw badSetting('not a Gamertown profile export');
  if (doc.game && doc.game !== this.server.id) {
    throw badSetting(`this profile is for "${doc.game}", not "${this.server.id}"`);
  }
  const nm = validProfileName(nameOverride || doc.name || 'Imported');
  const settings = this.validateProfileSettings(doc.settings ?? {}); // rejects foreign/garbage fields
  try { return store.createProfile(this.server.id, { name: nm, settings }); }
  catch (e) { throw duplicateError(e, nm, 'profile'); }
}
```

`validateProfileSettings` is the security boundary — it whitelists and bounds every field, so a malicious import can't inject arbitrary cvars beyond `rawConfig` (which is already length/null-byte guarded per game).

### 4d. Service wiring

**File:** `backend/src/servers/service.js` — add to the profiles section (after `captureProfile`, line 195):

```js
cloneProfile(id, profileId, name)   { return connectorFor(id).cloneProfile(profileId, name); },
exportProfile(id, profileId)        { return connectorFor(id).exportProfile(profileId); },
importProfile(id, doc, name)        { return connectorFor(id).importProfile(doc, name); },
```

### 4e. Routes

**File:** `backend/src/routes/servers.js` — add after the apply route (line 232). Static sub-paths before `/:profileId` already established; `/import` is static:

```js
route('post', '/:id/profiles/:profileId/clone',
  (req) => svc.cloneProfile(req.params.id, req.params.profileId, req.body.name), {
  csrf: true,
  schema: { ...P({ id: ID_PARAM, profileId: CONFIG_ID_PARAM }),
    body: { type: 'object', properties: { name: { type:'string', minLength:1, maxLength:48 } }, required:['name'], additionalProperties:false } },
});
route('get', '/:id/profiles/:profileId/export',
  (req) => svc.exportProfile(req.params.id, req.params.profileId),
  { schema: P({ id: ID_PARAM, profileId: CONFIG_ID_PARAM }) });
route('post', '/:id/profiles/import',
  (req) => svc.importProfile(req.params.id, req.body.profile, req.body.name), {
  csrf: true,
  schema: { ...P({ id: ID_PARAM }),
    body: { type: 'object',
      properties: { profile: { type:'object' }, name: { type:'string', maxLength:48 } },
      required: ['profile'], additionalProperties: false } },
});
```

> The `/import` static route MUST be registered before `/:profileId` parametric routes (it already would be if placed in the block above line 213; verify ordering — put the import route alongside `/capture` at line 206-212 to be safe, since Fastify matches static before parametric anyway, but the codebase comments insist on explicit ordering).

**No DB migration needed** — export/import/clone all use existing `server_profiles` columns.

---

## 5. Raw-config power-tools — per-game cvar/setting reference + validate-before-apply

### 5a. Per-game reference data

The cvar tables we're already building (`CS_CVAR_FIELDS`, `TTT_FIELDS`, `PH_CVARS`, `FACTORIO`/`MC` field lists) ARE the reference source. Expose them through a new connector hook so the UI can offer autocomplete + inline docs in the Raw Config editor and `rawConfig` textarea.

**File:** `backend/src/servers/connectors/base.js` — new hook (default empty):

```js
// A per-game catalog of known settings the UI can use for autocomplete / docs /
// validation. Returns { cvars: [{ name, label, type, min?, max?, default?, help? }] }.
configReference() { return { cvars: [] }; }
```

**File:** `backend/src/servers/connectors/docker/counterstrike.js`:

```js
configReference() {
  return { cvars: [
    ...csProfile.CS_CVAR_FIELDS.map((f) => ({ name: f.cvar, label: f.label, type: f.bool?'bool':'number', min: f.min, max: f.max, default: f.def })),
    { name: 'sv_gravity', label: 'Gravity', type:'number', min:100, max:2000, default:800, help:'needs sv_cheats 1' },
    { name: 'sv_cheats',  label: 'Cheats',  type:'bool', default:0 },
    { name: 'bot_quota',  label: 'Bots',    type:'number', min:0, max:64, default:0 },
  ] };
}
```

Analogous one-liners on the GMOD (`TTT_FIELDS`), PH (`PH_CVARS`), Factorio, Minecraft connectors. Each maps its existing field table → reference entries; near-zero extra code.

### 5b. Service + route

**File:** `backend/src/servers/service.js` — add `configReference(id) { return connectorFor(id).configReference(); }`.

**File:** `backend/src/routes/servers.js` — add (read-only, no CSRF) near the raw-config block (line 260):

```js
route('get', '/:id/config-reference', (req) => svc.configReference(req.params.id), { schema: P({ id: ID_PARAM }) });
```

### 5c. Validate-before-apply (optional, additive)

Add a dry-run flag to the existing settings/profile validation by exposing validation without persistence:

**File:** `backend/src/servers/connectors/base.js`:

```js
// Validate a candidate settings doc without persisting/applying. Throws on invalid.
validateProfile(settings) { return this.validateProfileSettings(settings); }
```

**File:** `backend/src/servers/service.js`: `validateProfile(id, settings) { return connectorFor(id).validateProfile(settings); }`

**File:** `backend/src/routes/servers.js`:

```js
route('post', '/:id/profiles/validate', (req) => svc.validateProfile(req.params.id, req.body.settings), {
  csrf: true,
  schema: { ...P({ id: ID_PARAM }),
    body: { type:'object', properties:{ settings:{ type:'object' } }, required:['settings'], additionalProperties:false } },
});
```

Returns the normalized doc (200) or a `BAD_SETTING` 400 with the human message — the UI can show field-level errors before the user commits Apply.

For raw `rawConfig`/`server.cfg` cvar validation, the UI cross-references `config-reference` client-side (cheap, no round-trip). No server-side cvar linter is needed — the connector already null-byte/length guards every raw body.

---

## DB migrations

**None required.** Every feature reuses existing tables: profiles (`server_profiles` + `server_active_profile`, migration 003), workshop maps (`server_workshop_maps`, migration 002). Expanded profile fields live inside the existing `settings` JSON blob; clone/export/import are pure operations over `server_profiles`. If you later want per-profile metadata (author, exported-from), follow the exact mechanism: create `backend/src/migrations/005_*.sql` starting with `PRAGMA foreign_keys = ON;`, and it runs once via the alphabetical-order `runMigrations` loop — but this spec needs no new column.

---

## Items requiring host validation (consolidated)

1. **CS2** install/cfg paths (`/home/steam/cs2-dedicated/...`), and that `host_workshop_map`/`ds_workshop_changelevel`/all new `mp_*`/`sv_*` cvars apply over RCON on the running image.
2. **GMOD/PH** `wscollectionid` being live in the instance cfg, writable pre-restart without breaking the current session; `gmad_linux` path for `syncMaps`; `ttt_roundrestart`/`gmod_admin_cleanup` over RCON.
3. **PH bug fix:** removing `wscollectionid` from `prophunt.js applyProfileSettings` (so Apply can't break the X2Z mount) — verify the X2Z gamemode still boots after Apply.
4. **Factorio** `map-settings.json` path + that the factoriotools image reads it; that RCON-issued `/sc` works regardless of `allow_commands`; achievement-disable caveat.
5. **Minecraft** gamerule name casing for the deployed `VERSION` (camelCase vs snake_case on 1.21.11+).
6. **All RCON sliders/actions** added here should be smoke-tested for output parsing (multi-packet responses already handled by `rcon-tcp.js`).

## Tests to extend

- `backend/test/docker-counterstrike.test.mjs` — new `CS_CVAR_FIELDS` validation bounds; `importCollection` returns unified shape (`requiresRestart:false`); `csRangeCmd` clamps.
- `backend/test/profiles.test.mjs` — `cloneProfile`, `exportProfile`/`importProfile` round-trip (and rejects foreign `game` + `gamertownProfile!==1`); `validateProfile` throws on out-of-bounds.
- `backend/test/docker.test.mjs` — GMOD/PH `importCollection` writes `wscollectionid` + returns `requiresRestart:true`; PH `applyProfileSettings` no longer writes `wscollectionid`.
- Add `backend/test/docker-factorio.test.mjs` / `docker-minecraft.test.mjs` assertions for the new live `runLiveAction` range cases and expanded profile fields.

Key files touched: `base.js`, `counterstrike-profile.js`, `docker/counterstrike.js`, `gmod.js`, `prophunt.js`, `factorio-profile.js`, `docker/factorio.js`, `minecraft-profile.js`, `docker/minecraft.js`, `service.js`, `routes/servers.js`. No store schema change; `store.js` and `steam-workshop.js` are reused as-is (steam-workshop's `fetchCollectionMaps` is now imported by `gmod.js` too).

---

# PART B — FRONTEND SPEC

I have the exact API surface. Now I have everything needed to write the spec.

# servers.html — Frontend Implementation Spec (Redesign)

**Status:** buildable spec. Vanilla HTML/CSS/JS, no framework. ES module `<script type="module">`, same imports as today: `dbGet*` from `./db.js`, `loadSession` from `./auth.js`. Reuses the existing design tokens (`--gt-green #42F527`, `--gt-green-soft #7bb85f`, `--gt-amber #c2a13a`, `--gt-ink #d4d4b8`, `--gt-line #444`, bg `#2a2a2a`/`#222`/`#1a1a1a`, Verdana 12px, "Courier New" mono) and component classes (`.retro-btn[.primary/.danger/.warn]`, `.mini-btn[.x]`, `.tab`, `.dot.<state>`, `.gauge[.sm/.warn/.crit]`, `.bar`, `.meter`, `.entity`, `.console`, `.cfg`, `.switch`, all `@keyframes`). All CSS continues to live in the single `<style>` block.

This spec is purely the frontend contract. It assumes the backend spec's expanded `profileSchema()` / `getLive()` return shapes (new field types, `apply` descriptors, slider `controls`, grouped options). Every new field type degrades to a text input if the backend omits it, so the page never hard-fails on an unknown schema.

---

## 0. API call surface (exact, from `db.js`)

All used as-is — no new client functions required by the frontend:

```
dbGetServers() · dbGetServerStatus(id) · dbGetNodeStatus()
dbServerAction(id, action) · dbUpdateServer(id)
dbGetServerSettings(id) · dbSaveServerSettings(id, values)
dbListServerConfig(id) · dbReadServerConfig(id, file) · dbWriteServerConfig(id, file, content)
dbGetServerLive(id) · dbServerLiveCommand(id, command) · dbServerLiveAction(id, action, value)
dbListProfiles(id) · dbGetProfileSchema(id) · dbGetProfile(id, profileId)
dbCreateProfile(id, name, settings) · dbUpdateProfile(id, profileId, patch)
dbDeleteProfile(id, profileId) · dbApplyProfile(id, profileId) · dbCaptureProfile(id, name)
dbListServerMaps(id) · dbAddServerMap(id, workshopId, name) · dbImportServerCollection(id, collectionId)
dbSyncServerMaps(id) · dbRenameServerMap(id, workshopId, name) · dbDeleteServerMap(id, workshopId)
dbListServerConfigs(id) · dbGetServerConfigBody(id, configId) · dbCreateServerConfig(id, name, body)
dbUpdateServerConfig(id, configId, patch) · dbDeleteServerConfig(id, configId)
```

Note the two config systems the renderer must keep distinct: **whitelisted on-disk files** (`dbListServerConfig`/`dbReadServerConfig`/`dbWriteServerConfig`) feed the Raw-Config tab; the **DB-backed config library** (`dbListServerConfigs`/`dbGetServerConfigBody`/`dbCreateServerConfig`/…) feeds the saved-snippets sidebar in that same tab.

---

## 1. Overall layout & IA

Two regions, same as today, but the per-game card becomes **tabbed** instead of one long stacked column. This is the single biggest IA change: Runtime / Profiles / Maps / Raw Config become tabs rather than always-rendered sections, so each panel gets full width and the card stops scrolling forever.

```
#wrap
 ├─ brand header              .gt-brand        (GamerTownCloud)
 ├─ §FLEET STATUS  .sec-head
 │   └─ #dashboard
 │        ├─ .fleet-header    host facts + 2 fleet-total gauges (CPU/RAM)   [reused]
 │        └─ .entity-grid     5 clickable .entity tiles                     [reused]
 └─ §SERVER CONTROL .sec-head
     └─ #active-card → .srv   (one game, the selected entity)
```

### 1a. New card structure (`cardHtml(server)`)

```
┌─ .srv ────────────────────────────────────────────────────────────────┐
│ .srv-head   ● GMOD / TTT      ◉ hosting · up 3h 12m      [join: …][copy]│
├─ .srv-power   (always visible, above the tabs) ───────────────────────-─│
│   [▶ Start] [⟳ Restart] [⏻ Stop] [✕ Force Stop] [⬆ Update] [↻ Refresh]  │
│   .srv-err (inline error, hidden when empty)        .srv-busy spinner    │
├─ .srv-tabs   (role=tablist) ───────────────────────────────────────────│
│   [ Runtime ] [ Profiles ] [ Maps ] [ Raw Config ]                      │
├─ .srv-tabpanels ───────────────────────────────────────────────────────│
│   .tabpanel[data-tab=runtime]   ← live RCON controls (gated: hosting)   │
│   .tabpanel[data-tab=profiles]  ← schema-driven editor (gated: running) │
│   .tabpanel[data-tab=maps]      ← catalog + rotation + import (gated)    │
│   .tabpanel[data-tab=rawcfg]    ← file editor + cvar ref + snippets      │
├─ .console   (unified per-server log, always visible under tabs) ────────│
└─────────────────────────────────────────────────────────────────────────┘
```

**Tab visibility / gating rules** (computed in `updateStatus(root, s)` exactly as today, but now toggling `.tab[hidden]` + auto-switching active tab if the current one becomes hidden):

| Tab | Shown when | Default-active priority |
|---|---|---|
| Runtime | `gameStatus === 'hosting'` | 1 (if hosting) |
| Profiles | `status === 'running'` | 2 |
| Maps | game advertises maps (schema has a `maplist`/`mapcatalog` field OR `dbListServerMaps` non-empty) AND `running` | 3 |
| Raw Config | `status === 'running'` | 4 |

The card mounts with the highest-priority *visible* tab active. Switching tabs is pure DOM (`.tab.active` + `.tabpanel[hidden]` toggle); each panel lazy-loads its data on first activation and caches in the per-card state object.

**Tab component** reuses existing `.tab` class (already has hover/active underline-glow styling). `.srv-tabs` is `display:flex; gap:2px; border-bottom:1px solid var(--gt-line)`. Add minimal CSS:

```css
.srv-tabs{display:flex;gap:2px;border-bottom:1px solid #444;flex-wrap:wrap}
.srv-tabs .tab[hidden]{display:none}
.tabpanel{padding:10px 2px}
.tabpanel[hidden]{display:none}
```

### 1b. Per-card state object

Replaces today's `P` with a single per-card `S` so all four tabs share one cache:

```js
const S = {
  id, server,                 // identity
  status: null,               // last status payload
  loaded: { runtime:false, profiles:false, maps:false, rawcfg:false },
  // profiles
  schema:null, list:[], activeId:null, editId:null, values:{}, dirty:false,
  // maps
  maps:[],                    // dbListServerMaps result (catalog)
  // rawcfg
  files:[], curFile:null, fileBaseline:'', // baseline = last-loaded content (for diff)
  configs:[],                 // DB snippet library
  // runtime
  live:null,
};
```

`renderActiveCard()` builds `cardHtml`, wires power + tabs, then calls `activateTab(defaultTab)`.

---

## 2. Schema-driven profile editor (Profiles tab)

The editor is the existing `.pf-toolbar` / `.pf-groups` / `.pf-actions` structure, kept. The work is in `profFieldHtml(f)` + its wiring, which must support the **expanded field-type set** below. The renderer is a `switch (f.type)`; **default falls through to a text input** so an unknown type never breaks the page.

### 2a. Group rendering

`schema.groups[]` → one `<details class="prof-group">` each (first open). Summary = `group.title`, optional `group.note` under it. Body = `.prof-grid` (2-col: 150px label / 1fr field). A group may set `group.columns: 1` to render full-width rows (used for `maplist`, `textarea`, `info`). Add an optional **collapsed-by-"advanced"** convention: `group.advanced:true` renders the details closed and tags the summary with a muted "advanced" badge.

### 2b. Complete field-type table (the renderer contract)

Every `type` the renderer must handle, what it draws, and how its value is read back by `readProfileForm()`:

| `type` | Draws as | Read-back | Notes |
|---|---|---|---|
| `text` | `<input type=text>` | string | default fallback for any unknown type |
| `number` | `<input type=number min max step>` | Number | shows `f.suffix` as a trailing `.field-unit` span |
| `bool` | `.switch` checkbox | `'1'`/`'0'` | (matches current convention) |
| `select` | `<select>`; supports `<optgroup>` when options carry `.group` | string | base enum case |
| `slider` **(new)** | range track + live `.pf-range-val` readout + numeric mirror input | Number | `min/max/step/default/suffix`. The number input and the slider are two-way bound. Used for cvar-style numeric ranges that also want a "type exact value" affordance. Renders inside `.pf-range` grid (reuse `.rt-range` layout). |
| `segmented` **(new)** | button group (`.seg` of `.seg-btn`) for small enums (≤5 options) | string | drawn instead of `<select>` when `f.style==='segmented'`; e.g. difficulty, gamemode. CSS: `.seg{display:inline-flex;border:1px solid #3a3a3a}.seg-btn{padding:3px 9px}.seg-btn.on{background:#1e2e1e;color:var(--gt-green)}` |
| `textarea` | `<textarea class=cfg>` | string | raw cvar blocks |
| `info` | read-only `.field-help` doc block (`f.help` → `<br>`) | — | no value |
| `cvar` **(new)** | `<input>` + `<datalist>` of known cvars/values from `f.suggest:[{value,label}]` | string | autocomplete for a single cvar value; pairs with the cvar reference in §6. If `f.valueType==='number'` the input is `type=number`. |
| `maplist` | rotation builder widget (see §3c) | array of map tokens | full-width |
| `mapcatalog` **(new, unifies map UI)** | the shared **MapPanel** mount point (see §3) | n/a (panel owns its own state) | a group can declare one `mapcatalog` field to render the catalog+rotation+import block inline; OR the whole thing lives in the dedicated **Maps tab** (preferred — see §3a). |
| `mapsync` | single "⟳ Sync from Collection" button | — | action-only; calls `dbSyncServerMaps` then re-fetches schema |
| `password` **(new)** | `<input type=password>` + reveal toggle (👁) | string | RCON/join passwords; never pre-filled if backend returns `'••••'` sentinel — empty-on-save means "unchanged" |

`profFieldHtml` returns the `<label>` + field cell; `f.help` always renders as `.field-help` italic subtext. New CSS:

```css
.pf-range{display:grid;grid-template-columns:1fr 64px auto;gap:8px;align-items:center}
.pf-range-val{font-family:"Courier New";color:var(--gt-green-soft);min-width:46px;text-align:right}
.field-unit{color:#777;margin-left:4px;font-size:10px}
.field-help{color:#7a7a64;font-style:italic;font-size:10px;margin-top:2px}
```

### 2c. Apply / Save mechanics & boot-vs-live labeling

`schema.apply` drives the footer (`.pf-actions`):

- `apply.mode === 'live'` (CS2): primary button label = `apply.label || '▶ Apply Live'`; **no restart**; note line shows `apply.note` in amber. Save (no apply) button still present for persisting without pushing.
- `apply.mode === 'restart'` (default, GMOD/PH/MC/Factorio): primary = `apply.label || 'Apply & Restart'`; clicking shows a `confirm()` with `apply.confirm` text (e.g. "This reboots the container"). 
- Footer note text is computed from mode so the user always knows whether edits go live or wait for boot: `live → "Applies instantly over RCON — reverts on container restart."` / `restart → "Written to boot config; container restarts to take effect."`

`readProfileForm()` collects every `[data-pf-key]` field (including slider mirrors, segmented `.on` button, password sentinels) into `S.values`, then `dbUpdateProfile(id, S.editId, {settings:S.values})` (+ `dbApplyProfile` on apply). After apply, `reloadProfileList()` refreshes `activeId` and the live/not-applied badge.

**Dirty tracking:** any field `input`/`change` sets `S.dirty=true` and lights the Save button (`.retro-btn.primary`). Switching tabs or profiles while `S.dirty` prompts "Discard unsaved changes?".

---

## 3. Unified collection-import & map management (Maps tab)

One reusable component — **`MapPanel`** — used identically for CS2, TTT, and Prop Hunt. The backend already exposes the same verbs (`dbListServerMaps`, `dbAddServerMap`, `dbImportServerCollection`, `dbSyncServerMaps`, `dbDeleteServerMap`, `dbRenameServerMap`) for all three, so the component is game-agnostic. The only per-game variance is the **boot/rotation model**, surfaced as a capability flag read from the profile schema:

- `rotationModel: 'list'` (GMOD/PH — rotation = ordered `mapcycle`, first map is boot) → show the **Rotation builder**.
- `rotationModel: 'single'` (CS2 — one boot map + live `ds_workshop_changelevel`) → show a **single boot-map picker** instead of a rotation list.

`MapPanel` derives this from `S.schema` (look for a `maplist` field ⇒ `list`, else `select+addWorkshop` ⇒ `single`).

### 3a. Maps tab wireframe

```
┌ .tabpanel[data-tab=maps] ───────────────────────────────────────────────┐
│ ┌ .map-import (the shared CollectionImport component) ─────────────────┐ │
│ │ Import a Steam Workshop collection                                   │ │
│ │ [ collection id … 0000000 ]  [⤓ Preview]                             │ │
│ │ ── preview (hidden until Preview resolves) ──                        │ │
│ │  12 maps found in collection "TTT Night"                             │ │
│ │   ☑ ttt_clue_se       (123456)                                       │ │
│ │   ☑ ttt_minecraft_b5  (234567)                                       │ │
│ │   ☐ ttt_rooftops      (345678)                                       │ │
│ │  [✓ Import selected (11)]   [cancel]                                  │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│ ┌ .map-catalog ───────────────┐ ┌ .map-rotation (rotationModel=list) ──┐ │
│ │ INSTALLED MAPS    [+ Add WS] │ │ ROTATION (first = boot map)          │ │
│ │  ttt_clue_se      [→][✎][✕]  │ │  1 ⭑ ttt_clue_se       [↑][↓][✕]    │ │
│ │  ttt_dolls        [→][✎][✕]  │ │  2   ttt_dolls         [↑][↓][✕]    │ │
│ │  ttt_minecraft_b5 [→][✎][✕]  │ │  3   ttt_waterworld    [↑][↓][✕]    │ │
│ │  …                           │ │  [+ from catalog ▾]                  │ │
│ │  [⟳ Sync from Collection]    │ │  [Save rotation] → writes profile    │ │
│ └──────────────────────────────┘ └──────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

For `rotationModel:'single'` (CS2) the right column becomes:

```
┌ .map-boot ────────────────────────────────┐
│ BOOT MAP   ( ▼ de_inferno            )     │
│ [Set boot map] → writes profile.map        │
│ note: live map change is on the Runtime tab│
└────────────────────────────────────────────┘
```

### 3b. CollectionImport component (the unified flow)

Element: `.map-import`. Three states driven by a tiny local FSM (`idle → previewing → preview → importing`):

1. **idle** — `<input data-coll-id>` (digits only) + `[⤓ Preview]` (`.mini-btn`).
2. **Preview** click → `dbImportServerCollection(id, cid)` is the *commit* call; for **preview** we still call `dbImportServerCollection`? No — preview must not mutate. Backend `importCollection` is the import. So the preview step calls a **read-only expansion**: there isn't a dedicated client fn, so the component does preview by calling `dbImportServerCollection` only on the final **Import** click. **Preview is therefore a soft-confirm list built from the import result** in two-phase UX:
   - Practical buildable approach given current API: **single-step import with confirmation.** Click `⤓ Import collection` → `confirm("Import all maps from collection <id>?")` → `dbImportServerCollection(id, cid)` → response `{imported, maps:[…]}` is rendered into the preview list as the *result* ("Imported 11 maps ✓"), and `S.maps` is refreshed via `dbListServerMaps`. The checkbox/selective UI is shown **after** import as "uninstall any you didn't want" (each `✕` → `dbDeleteServerMap`). This keeps the component buildable against today's endpoints while presenting a preview-like list.
   - (If/when the backend adds a keyless `previewCollection` endpoint, the component swaps its phase-1 call to that and the checkboxes gate which ids get imported — the FSM and DOM are already shaped for it. Mark this seam clearly with `// PREVIEW-SEAM`.)
3. After import: re-fetch `dbListServerMaps`, re-fetch `dbGetProfileSchema` (so `maplist`/boot-picker options include new maps), re-render catalog + rotation. Log `Imported N map(s) from collection <id> ✓` to `.console`.

CSS reuse: `.mini-btn`, `.cfg`-style inputs, `.field-help` for the count line. New: `.map-import{border:1px solid #333;background:#181818;padding:8px;margin-bottom:10px}` and a `.coll-row{display:flex;gap:6px;align-items:center}` for each previewed/installed map.

### 3c. Catalog & rotation builder

- **Catalog** (`.map-catalog`) lists `S.maps` (from `dbListServerMaps`). Per row: name, `→` (add to rotation / set as boot), `✎` (rename → prompt → `dbRenameServerMap`), `✕` (`dbDeleteServerMap`, 404 treated as success). `[+ Add WS]` toggles an inline form: workshop id (+ optional name) → `dbAddServerMap(id, wsId, name||'')` (empty name ⇒ backend auto-fetches the Steam title). `[⟳ Sync from Collection]` → `dbSyncServerMaps` (GMOD/PH only; extracts `.bsp` then refreshes catalog + schema).
- **Rotation** (`.map-rotation`, reuses today's `maplist` widget logic): ordered array in `S.values[mapField]`. Rows: index, ⭑ boot badge on row 0, `↑/↓/✕`. `[+ from catalog]` select appends. `[Save rotation]` writes the profile (`dbUpdateProfile`) — and because rotation lives in the profile, **the Maps tab and Profiles tab share `S.values`**; saving in either persists the same field. Map-name validation regex `^[a-z0-9_]{1,64}$` retained.
- Workshop token format unchanged: `ws:{id}` for unsynced workshop entries, bare lowercase name for installed/stock.

This is the "unified collection → installed/selectable maps" workflow the goal calls for: identical component, identical calls, only the rotation-vs-single presentation differs, derived from schema — no per-game branching in the import code.

---

## 4. Runtime panel (Runtime tab)

`loadRuntime()` → `dbGetServerLive(id)` → `renderLive(data)`. Four blocks, each a `.rt-block` with an `.rt-block-head`. Any block whose source array is empty is omitted, so each game shows only what it advertises.

```
┌ .tabpanel[data-tab=runtime] ───────────────────────────────────────────┐
│ QUICK ACTIONS   .rt-actions (auto-fill 132px) ──────────────────────────│
│  [Restart Round][Warmup][Swap Teams][Add Bot][Kick…]   ([danger]=red)   │
│ LIVE TUNING     .rt-ranges  ────────────────────────────────────────────│
│  Gravity      [────●────] 600  [Set]                                     │
│  Player Speed [──●──────] 320  [Set]                                     │
│  Game Speed   [───●─────] 1.0  [Set]        hint: sv_cheats auto-toggled │
│ CHANGE MAP      .rt-changemap (when data.changeMap) ────────────────────│
│  ( ▼ stock / collection / workshop groups )  [Change Now]               │
│ CONSOLE         .rt-console ────────────────────────────────────────────│
│  > [ command…                                   ] [Send]   (Enter sends) │
└─────────────────────────────────────────────────────────────────────────┘
```

Block specs:

- **Quick actions** — `data.actions:[{key,label,danger?}]` → `<button data-rt-act=key>` (`.mini-btn`, `.danger` if flagged). Click → `dbServerLiveAction(id, key)`; output appended to `.console` as `> <label>\n<output>`. Actions that need an argument (`f.arg`, e.g. kick player name) render an inline mini-prompt before sending — pass the value as `dbServerLiveAction(id, key, value)`.
- **Live tuning (sliders)** — `data.controls:[{key,label,min,max,step,default,suffix?}]` → `.rt-range` rows (reuse existing 4-col grid that collapses to 3 ≤520px). Live readout updates on `input`; `[Set]` → `dbServerLiveAction(id, key, value)`. These map directly to the per-game slider sets the research enumerated (GMOD/PH gravity/speed/timescale; CS2 gravity/accel/round-time/bot-quota; Factorio evolution/game-speed; MC randomTickSpeed/sleep%/time).
- **Change map** — when `data.changeMap`, populate select from the profile schema's map options (stock/collection/workshop optgroups, reusing the schema fetched for the Maps tab). `[Change Now]` → `dbServerLiveAction(id, 'change_map', value)` (value may be `ws:{id}` or bare name). For CS2 this is the live `ds_workshop_changelevel` path; for GMOD/PH it's `changelevel` restricted to maps mounted at last boot (the select only lists installed maps).
- **Console** — text input (placeholder = `data.commandHint`) + `[Send]`; Enter also sends. `dbServerLiveCommand(id, cmd)` → append to `.console`.

No new CSS needed beyond what exists (`.rt-block`, `.rt-actions`, `.rt-ranges`, `.rt-range`, `.rt-range-val`, `.rt-changemap`, `.rt-console`). Gate: if `data.available===false`, render `data.reason` in a `.panel-ldg`-style muted note and nothing else.

---

## 5. Presets & sharing (Profiles toolbar)

`.pf-toolbar` keeps the picker + manage buttons; we extend it with import/export and a clearer active indicator.

```
┌ .pf-toolbar ────────────────────────────────────────────────────────────┐
│ Profile ( ▼ Default        )  [● live] / [○ not applied]                 │
│         [＋ New][⎘ Clone][⤓ Capture][⇄ Export][⇲ Import][🗑 Delete]       │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Active indicator** — `.pf-badge.live` (green "● live") when `S.editId === S.activeId`, else `.pf-badge.dirty` (amber "○ not applied"). If `S.dirty`, append " · unsaved" so users distinguish "saved-but-not-applied" from "edited-not-saved".
- **＋ New** — prompt name → `dbCreateProfile(id, name)` (server seeds defaults).
- **⎘ Clone** — prompt name → `readProfileForm()` then `dbCreateProfile(id, name, S.values)` (clones current edits).
- **⤓ Capture** — prompt name → `dbCaptureProfile(id, name)` (snapshots live box state).
- **⇄ Export** — client-only: serialize `{name, schemaVersion?, settings:S.values}` to JSON and trigger a download (`<a download="<game>-<profile>.json">` via `URL.createObjectURL(new Blob([json]))`). No API call.
- **⇲ Import** — client-only `<input type=file accept=.json>` → parse → validate it's an object with `settings` → prompt for a profile name → `dbCreateProfile(id, name, parsed.settings)`. Unknown keys are kept (backend `validateProfileSettings` drops them); a `.console` line reports any dropped keys after the next `dbGetProfile` round-trip.
- **🗑 Delete** — `confirm()` → `dbDeleteProfile(id, profileId)`; if it was active, badge falls back to "○ not applied".

Export/Import are the "sharing" axis and are intentionally pure-frontend (file in/out) so no backend route is needed. New CSS: `.pf-badge{font-size:10px;padding:1px 6px;border-radius:2px}.pf-badge.live{color:var(--gt-green);border:1px solid #2e5a2e}.pf-badge.dirty{color:var(--gt-amber);border:1px solid #5a4a1e}`.

---

## 6. Raw-config power-tools (Raw Config tab)

Two-pane layout: file editor (left/main) + reference & snippet sidebar (right). Adds **per-game cvar reference**, **client-side validation**, and **diff-before-apply**.

```
┌ .tabpanel[data-tab=rawcfg] ─────────────────────────────────────────────┐
│ ┌ .rc-editor ─────────────────────────────┐ ┌ .rc-side ───────────────┐ │
│ │ File ( ▼ cfg/gmodserver.cfg )            │ │ CVAR REFERENCE          │ │
│ │ ┌ .cfg textarea ──────────────────────┐ │ │ [filter… ttt_     ]     │ │
│ │ │ ttt_round_limit 6                    │ │ │ ttt_round_limit  int 6  │ │
│ │ │ ttt_traitor_pct 0.25                 │ │ │   rounds before map…    │ │
│ │ │ …                                    │ │ │ ttt_haste  bool 1  [ins]│ │
│ │ └──────────────────────────────────────┘ │ │ …                       │ │
│ │ .rc-lint  ⚠ line 4: unknown cvar 'ttt_xx'│ │ ───────────────         │ │
│ │ [⤺ Revert] [≡ Diff] [💾 Save File]        │ │ SAVED SNIPPETS          │ │
│ │                                          │ │  comp-ruleset  [load][✕]│ │
│ │ ── .rc-diff (hidden until Diff) ──       │ │  [＋ Save current as…]  │ │
│ │  - ttt_round_limit 6                     │ │                         │ │
│ │  + ttt_round_limit 8                     │ │                         │ │
│ └──────────────────────────────────────────┘ └─────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

- **File editor** — `dbListServerConfig(id)` populates the file `<select>`; selecting → `dbReadServerConfig(id, file)` into the `.cfg` textarea, and stores `S.fileBaseline = content`. `[💾 Save File]` → `dbWriteServerConfig(id, file, content)`. Lazy-loaded on first tab activation.
- **Cvar reference** (`.rc-side`) — driven by the profile schema's optional `schema.cvarRef:[{name,type,default,help,group}]` (a new schema field the backend can supply per game). Filter box does substring match. Each row has `[ins]` which inserts `name <default>\n` at the textarea caret. If `cvarRef` is absent, the sidebar hides — no hard dependency.
- **Validation** (`.rc-lint`) — purely client-side, runs on `input` (debounced 300ms). For Source `.cfg` files it parses `name value` lines and flags: empty value, unknown cvar (not in `cvarRef`, shown as a soft amber warning not an error), and out-of-range numeric (when `cvarRef` gives min/max). For JSON files (Factorio/MC `*.json`) it runs `JSON.parse` and reports parse errors with line/col. Lint is advisory — **Save is never blocked** (a hard JSON parse error does disable Save for `.json` files only, since writing invalid JSON bricks boot).
- **Diff-before-apply** (`.rc-diff`) — `[≡ Diff]` computes a line diff between `S.fileBaseline` and the textarea against the baseline, rendered as `-`/`+` lines (`.rc-del` red, `.rc-add` green). A trivial LCS-free line diff (Myers is overkill) — compare line-by-line and mark changed/added/removed — is sufficient and buildable inline. `[💾 Save File]` may open the diff first if the file is large/changed and ask `confirm()`.
- **Saved snippets** (DB library) — `dbListServerConfigs(id)` lists `{id,name}`; `[load]` → `dbGetServerConfigBody(id, configId)` replaces textarea content; `[✕]` → `dbDeleteServerConfig`. `[＋ Save current as…]` → prompt name → `dbCreateServerConfig(id, name, textarea.value)`. This is the reusable "config library" distinct from on-disk files.

New CSS:
```css
.rawcfg-grid{display:grid;grid-template-columns:1fr 280px;gap:10px}
@media(max-width:780px){.rawcfg-grid{grid-template-columns:1fr}}
.rc-lint{font-family:"Courier New";font-size:10px;color:var(--gt-amber);min-height:14px;margin:4px 0}
.rc-lint.err{color:#e06c6c}
.rc-side{border:1px solid #333;background:#181818;padding:8px}
.rc-ref-row{display:flex;justify-content:space-between;gap:6px;padding:2px 0;border-bottom:1px solid #262626;cursor:default}
.rc-diff{font-family:"Courier New";font-size:11px;white-space:pre;background:#141414;border:1px solid #333;padding:6px;max-height:200px;overflow:auto}
.rc-del{color:#e06c6c}.rc-add{color:var(--gt-green)}
```

---

## 7. JS function inventory (new/changed)

Keep all existing helpers (`esc`, `fmtUptime`, `fmtBytes`, `gaugeHtml`, `barHtml`, `copyToClipboard`, `statusBits`, `entityHtml`, `fleet*`, `renderDockerDashboard`, `wireEntities`, `selectServer`, `entityAction`). New/changed:

| Function | Role |
|---|---|
| `cardHtml(server)` | now emits `.srv-power` + `.srv-tabs` + 4 empty `.tabpanel`s + `.console` |
| `wireCard(id)` | wires power, tabs (`activateTab`), and defers panel loads |
| `activateTab(name)` | toggles `.tab.active`/`.tabpanel[hidden]`; lazy-calls `load<Tab>()` once |
| `updateStatus(root,s)` | gates tab visibility, auto-switches if active tab hidden |
| `loadRuntime()/renderLive(d)` | Runtime tab (§4) |
| `loadProfiles()/renderProfiles()/profFieldHtml(f)/readProfileForm()` | Profiles tab (§2); `profFieldHtml` extended with `slider/segmented/cvar/password/mapcatalog` |
| `loadMaps()/renderMapPanel()` + `wireCollectionImport()/wireMapCatalog()/wireRotation()` | Maps tab (§3) |
| `loadRawcfg()/renderRawcfg()` + `wireCvarRef()/lintConfig()/diffConfig()/wireSnippets()` | Raw Config tab (§6) |
| `exportProfile()/importProfileFile()` | client-only preset sharing (§5) |
| `lineDiff(a,b)` | tiny line-by-line diff for §6 |

---

## 8. Buildability notes / seams

- **Unknown field types never crash** — `profFieldHtml` default → text input; unknown `getLive` blocks omitted; absent `cvarRef`/`apply`/`changeMap` simply hide their UI.
- **One `S` per card**; `S.values` is shared by Profiles + Maps so rotation edits are coherent.
- **`// PREVIEW-SEAM`** in `wireCollectionImport` marks where a future keyless `previewCollection` endpoint slots in to make the checkbox preview pre-import rather than post-import; until then import-then-curate is the buildable flow against `dbImportServerCollection`.
- **CSRF/auth** unchanged — `loadSession()` at boot, cookies carry through `db.js`.
- **Polling** unchanged — fleet deck refreshes every 10s; the open card's status re-syncs on the same tick via `dbGetServerStatus(S.id)` and re-runs `updateStatus` (which may show/hide the Runtime tab as the game starts/stops hosting).

Relevant files for implementation: `C:\Users\wiley\Repos\Cbarr-hub.github.io\servers.html` (rewrite target), `C:\Users\wiley\Repos\Cbarr-hub.github.io\db.js` (API client, no changes needed), `C:\Users\wiley\Repos\Cbarr-hub.github.io\auth.js` (`loadSession`).
