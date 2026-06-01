# Server Config Profiles — Spitball

**Goal:** collapse the server panel onto exactly **two interaction modes** per game:

1. **Profiles** — a *named, structured* combination of everything that defines how
   the server starts: map / map-rotation, gameplay settings, and access lists
   (whitelist / ops / admins). Save many, pick one, apply it. Durable.
2. **Live commands** — ephemeral RCON/console. Don't persist, reset on restart.
   (This layer is already in good shape — leave it mostly alone.)

> **Build status (in progress):** backend foundation + the **GMOD pilot** +
> the **frontend editor** are done.
> - *Backend:* `server_profiles` + `server_active_profile` (migration 003), store
>   CRUD, generic profile lifecycle on `BaseConnector` (list/get/create/update/
>   delete/apply/capture + auto-seeded "Default"), GMOD `profileSchema()` /
>   `applyProfileSettings()` / `captureProfileSettings()`, `/api/servers/:id/
>   profiles*` routes. 9 new tests (70 total green); routes boot conflict-free.
> - *Frontend:* `db.js` profile client + a structured **Profiles** panel in
>   `servers.html` — profile picker with active badge, Apply / New / Save As /
>   Capture / Delete, schema-driven grouped fields (select / number / bool toggle
>   / text / map-name combos / **ordered map-rotation list builder**, first entry
>   badged "start"). Supersedes Quick Settings where a game has profiles (GMOD);
>   CS/Factorio/Minecraft fall back unchanged. Panel shows whenever the VM is up.
>
> **GMOD lessons (shipped, now live):**
> - Boot map = the **first rotation entry** (no separate start-map field).
> - **Apply = apply + restart** — the workshop collection only mounts at boot, so
>   writing config without a restart left maps unmountable + live changelevel
>   failing. Apply now restarts so the collection downloads/mounts and the config
>   takes effect in one action.
> - Maps are **collection-driven**: stock maps always; workshop maps only when a
>   collection is set (an empty collection mounts 0 addons → bricks a workshop boot
>   map). A boot-map guard blocks that case. See the CLAUDE.md GMOD gotchas.
>
> **Factorio (shipped):** profile = active world + structured `server-settings.json`
> (name, description, max players, visibility, game password, autosave) — replacing
> raw-JSON-only editing. World **operations** (Save As / Generate) stay in Quick
> Settings. This established the **config/operations panel split**: the frontend
> now renders the **Profiles** panel (config) *and* the **Quick Settings** panel
> (operations) together; each game can have one or both. GMOD's `getSettings` was
> trimmed to just the map block (for the live change-map) so it doesn't
> double-render. Box-verified against VM 101.
>
> **Next:** Counter-Strike (map + mode + max players + hostname + a raw-cvar block,
> replacing the bespoke CS panel). **Minecraft skipped** (low value for this group).
> Then live-vs-restart apply tagging.

This is a *re-framing + completion*, not a rewrite. Status quo and the gap:

| Game | Structured settings | Named presets | Whitelist UI |
|---|---|---|---|
| CS2 | direct file writes | ✅ but raw-text-only, separate from map | raw only |
| Factorio | save mgmt only | ❌ none | raw JSON only |
| Minecraft | world load/save only | ❌ none | raw JSON only |
| GMOD | rich TTT fields (direct) | ❌ none | n/a |

Nobody can save "loadout A" and "loadout B" and switch. The CS "config library"
is a raw cvar blob disjoint from the map + the structured settings. That's the
core thing to fix.

---

## The unifying abstraction

A **Profile** = `{ name, settings: <structured doc>, body: <raw escape-hatch>, }`
stored as JSON in SQLite, per server, one marked **active**. Generalize the three
things CS already does into one object:

- **`profileSchema()`** — connector declares its fields (types/enums/ranges).
  GMOD's `TTT_FIELDS` is already exactly this pattern; promote it.
- **`applyProfile(doc)`** — connector materializes the doc onto the VM's real
  config files. This *is* today's `setSettings`, just driven by a saved doc
  instead of an ad-hoc request. (CS's `gamertown/active.cfg` deploy is the proof
  of concept.)
- **`captureProfile()`** — read live *files* → produce a doc (pull an out-of-band
  SSH/LinuxGSM edit into a profile). Secondary convenience, not the persistence
  path — see below.

Routes/service/UI stay generic; all game knowledge stays in the connector — same
contract the panel already has. `getSettings`/`setSettings` become "edit + apply
the active profile."

### Persistence model — DECIDED

A **profile is the startup config the server boots as.** From there:

- **Runtime/live amendments are ephemeral** — they change the *running* state only
  and are **never** written back to the startup config; they're gone on restart.
- **Runtime → startup is an explicit act only.** The sole path is deliberately
  editing the startup profile's fields (the editable surface we choose to expose,
  i.e. the profile's *managed keys*). No implicit promotion of live tweaks.
- Therefore `applyProfile` (writes managed startup keys) and the live layer (touches
  running state) are **non-overlapping**; they cross only on an explicit edit+save.

**Drift, precisely:** runtime state differing from the profile is *expected and
never flagged* (that's what live commands are for). The only divergence worth
surfacing is **startup-file drift** — when something *outside* the panel
(LinuxGSM regenerating a cfg, an SSH hand-edit) changes the startup files out from
under the active profile. A "box differs from active profile" badge diffs
`captureProfile()`'s managed keys against the stored doc and offers
**[re-apply]** or **[capture into profile]**.

### Data flow (unchanged shape)
```
servers.html → /api/servers → service → connector → ProxmoxClient → PVE API
                                            └→ serverStore (SQLite: profiles)
```

---

## Per-game profile contents (spitball)

**Counter-Strike 2** — mostly a re-frame. One profile bundles: map (stock or
workshop from the catalog), game mode, max players, hostname, + the raw-cvar
block (today's "config body"). Optional: bot count, warmup, a maps cycle via
`mapgroup`/`nextlevel`. Net change: "map + separate config + loose settings"
become one named thing you switch.

**Factorio** — biggest structured-settings win. Profile bundles: active save +
`server-settings.json` as real fields (name, description, max_players, visibility,
game_password, autosave_interval, afk_autokick) + access lists
(`server-whitelist.json` / `server-adminlist.json`). World **generation** stays a
separate action (it makes a new save; a profile only *points at* one). Today this
is raw-JSON-only — structured + named is a real upgrade.

**Minecraft** — profile bundles: active world (`level-name`) + a `server.properties`
subset (gamemode, difficulty, hardcore, pvp, max-players, motd, view-distance,
white-list on/off, spawn-protection) + **structured whitelist / ops / bans**
editors. The whitelist editor is the single biggest MC ask and is raw-JSON-only
today. Side-quest: enable real **RCON** (`enable-rcon=true` + existing `rcon.js`)
so MC joins the same live model instead of the tmux/log hack.

**GMOD/TTT** — richest structured settings already; profiles are nearly free
reuse. Bundle: starting map, max players, workshop collection, all `ttt_*` cvars,
`mapcycle.txt` (this *is* the "map rotation" you described), use-mapcycle toggle.
Upgrade the mapcycle textarea to a multi-select from discovered maps. ULX admin
list later if ULX is added.

---

## Cross-cutting improvements

1. **"Save current as profile"** (`captureProfile`) — snapshot live state.
2. **Apply tagging** — each field marked *applies live* vs *needs restart*; where
   a live RCON equivalent exists (CS map/cvars, GMOD cvars), offer "apply now" vs
   "on next restart." The per-game live infra already exists.
3. **Structured access lists** — MC ops/whitelist/bans + Factorio admins/whitelist
   as add/remove list editors with validation, not raw JSON.
4. **One validation source** — declare ranges/enums in `profileSchema()`, use for
   both render and validate (GMOD's `TTT_FIELDS` already does this).
5. **Active-profile badge + dirty-state** in the UI so "what's running" vs "what
   I'm editing" is unambiguous.

---

## Access control (cross-game) — DECIDED: per-profile + capability-declared

Access lives **inside the profile** (switch the whitelist/password *with* the
loadout). Each game supports a different subset, so connectors **declare**
capabilities rather than the UI hardcoding fields — same pattern as `getLive()`:

```
accessSchema() → {
  password?: { key, set: bool },                 // join password, if native
  lists?: [ { kind: 'whitelist'|'admins'|'bans',
              enabledToggle?: bool,               // e.g. MC white-list on/off
              entryLabel: 'Minecraft username' | 'Steam ID' | 'Factorio username',
              entries: string[] } ],
}
```

| Game | Join password | Whitelist | Other lists |
|---|---|---|---|
| Minecraft | ✗ (online-mode is the auth) | ✓ `white-list` toggle + `whitelist.json` | ops, banned-players, banned-ips |
| Factorio | ✓ `game_password` (server-settings) | ✓ `server-whitelist.json` + enable | adminlist, banlist |
| CS2 | ✓ `sv_password` | ✗ native (SourceMod later) | — |
| GMOD/TTT | ✓ `sv_password` | ✗ native (ULX later) | — |

The weirdness collapses to **one generic list-editor widget** (add/remove +
validate by `entryLabel`) reused for every list kind, plus an optional password
box. Games that lack a native whitelist just don't declare one (or render a
disabled "requires admin mod" hint). `applyProfile` writes the declared lists to
their files + the enable flag/password; nothing is hardcoded per game in the UI.

---

## UI information architecture — DECIDED: structured-first, logically separated

Profile editing is a **structured form**, not a text blob. The raw body is demoted
to an **Advanced** escape hatch (kept for un-modeled cvars like CS bunnyhop).
Per-server card, cleanly separated:

```
┌ Status · Power · Join · Update ─────────────────────────────┐  top bar
├ PROFILES   active: ▾   [Apply] [Save As] [Capture] [Delete] ┤
│   Map / World   — map or world + rotation (multiselect)      │  structured
│   Gameplay      — mode / TTT cvars / difficulty / limits     │  groups,
│   Access        — password? + whitelist toggle + list editor │  typed fields
│   Advanced      — raw cfg body, hostname, niche knobs        │
├ RUNTIME   live — only when hosting ─────────────────────────┤
│   curated actions · live change-map · console               │  ephemeral
└─────────────────────────────────────────────────────────────┘
```

`profileSchema()` returns **groups** of typed fields; the generic renderer grows a
few field types beyond today's text/number/select/textarea: **bool** (toggle),
**multiselect** (map rotation), and **list-editor** (access lists). GMOD's
`TTT_FIELDS`-as-data is the template — every game declares groups+fields, the
renderer stays game-agnostic.

---

## Phasing (each independently shippable)

- **P1** — Profile store + generic CRUD/UI + the **structured-form renderer**
  (groups + new field types: bool, multiselect, list-editor). Migrate CS
  `server_configs` → `server_profiles`. No behavior change beyond naming.
- **P2** — `applyProfile`/`captureProfile` + active-profile pointer (mirrored:
  on-box `gt_active_profile` var + SQLite); refactor each connector's
  `setSettings` to apply-from-doc, one game at a time.
- **P3** — `accessSchema()` + the generic list-editor widget (password + lists);
  wire MC whitelist/ops/bans first, then Factorio whitelist/admins/bans.
- **P4** — Factorio/MC structured settings (server-settings.json /
  server.properties subsets) as profile fields.
- **P5** — Live-vs-restart apply tagging + "apply live where possible" + the
  startup-file drift badge.
- **P6 (opt)** — Minecraft RCON; world/map pools; CS mapgroup rotation; CS/GMOD
  whitelist via SourceMod/ULX.

---

## Decisions (resolved)

1. **Persistence:** profile = startup config; runtime amendments ephemeral;
   runtime→startup explicit-only (snapshot + apply, non-authoritative). Only
   *startup-file* drift is surfaced. → "Persistence model — DECIDED".
2. **Active-profile pointer:** mirror both — on-box `gt_active_profile` var + a
   SQLite pointer.
3. **Access scope:** per-profile, capability-declared (`accessSchema()`); one
   generic list-editor widget; optional join password where native. → "Access
   control".
4. **Editing UX:** structured-first form (typed field groups); raw body demoted to
   Advanced. → "UI information architecture".

### Still loose (spitball further)

- **Apply semantics per field:** which fields "apply live" vs "needs restart," and
  whether Apply offers both. CS map/cvars + GMOD cvars have live paths today;
  world/save loads are restart-only.
- **Capture fidelity:** `captureProfile()` only sees what's written to *files* —
  in-memory live tweaks (RCON `changelevel`, `sv_cheats`) won't round-trip. Likely
  fine (they're ephemeral by design).
- **Profile portability:** per-server only (schemas differ), with Save-As /
  Duplicate within a server — vs cross-game cloning (probably not worth it).
- **Starter profiles:** seed a "Default" per game (capture box state on first run)
  so the list is never empty.
