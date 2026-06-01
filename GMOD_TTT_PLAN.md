# Garry's Mod (TTT) Server — Implementation Plan

Status: **infra provisioned + backend/frontend/tests/docs implemented; pending
deploy + the two manual steps (GSLT token, 27066 port-forward).** VM 104 is built
and running `terrortown` on port 27066 (LAN); the scoped PVE token, guest-agent
file-read, and in-guest RCON were all verified end-to-end. Adds a fourth game
server — Garry's Mod running
the **Trouble in Terrorist Town** gamemode — to the control panel
(`/servers.html` + `/api/servers`). Read alongside [`INFRA.md`](INFRA.md)
("Game Server Control Panel"), [`SERVER_PANEL_PLAN.md`](SERVER_PANEL_PLAN.md),
and [`backend/README.md`](backend/README.md).

---

## 0. Why this is mostly a copy job

Garry's Mod is a **Source-engine dedicated server managed by LinuxGSM**
(`gmodserver` instance) — architecturally identical to the CS2 (`cs2server`) and
Factorio (`fctrserver`) boxes. The new connector extends the existing
`LinuxGsmConnector`, reuses the existing `cvars.js`/`cfgvars.js`/`rcon.js`
helpers, the DB-backed config library, and the generic service/route/UI layers.
**No new architectural concepts.** The real cost is one-time infra: there is no
GMOD VM yet.

### Locked decisions (from requirements gathering)

| Question | Decision |
|---|---|
| Who provisions VM 104 | **Claude, end-to-end** on the `pve` host (`pct`/`qm` available locally) |
| Map collection + autoplay | **Workshop collection (`wscollectionid`) + panel-managed `mapcycle.txt`** (`ttt_always_use_mapcycle 1`) |
| Traitor controls | **Both roles**: traitor pct/max **and** detective pct/max |
| Runtime control | **Include live RCON** (console + curated buttons), like CS2 |

### How TTT settings split across files

| Setting | File | Key |
|---|---|---|
| Gamemode = TTT | LGSM instance cfg | `gamemode="terrortown"` |
| Starting map | LGSM instance cfg | `defaultmap="ttt_…"` |
| Workshop collection (auto-download maps + addons) | LGSM instance cfg | `wscollectionid="<id>"` |
| GSLT auth token | LGSM common cfg | `gslt="<token>"` |
| Max players | LGSM instance cfg | `maxplayers` |
| Game port | LGSM instance cfg | `port` (= **27016**, since 27015 is CS2) |
| RCON password | LGSM common cfg | `rconpassword` |
| Map rotation order | `garrysmod/mapcycle.txt` | one map name per line |
| Use mapcycle for autoplay | `garrysmod/cfg/server.cfg` | `ttt_always_use_mapcycle 1` |
| Rounds before map change | server.cfg | `ttt_round_limit` (def 6) |
| Time limit per map | server.cfg | `ttt_time_limit_minutes` (def 75) |
| Traitor ratio / cap | server.cfg | `ttt_traitor_pct` (0.25) / `ttt_traitor_max` (32) |
| Detective ratio / cap | server.cfg | `ttt_detective_pct` (0.13) / `ttt_detective_max` (32) |
| Min players to start | server.cfg | `ttt_minimum_players` (2) |

---

## 1. Phase 0 — Provision VM 104 (Claude, on `pve` host)

The existing game VMs were built from the Ubuntu live-server ISO (manual
install). For unattended provisioning we instead use the **Ubuntu 24.04 cloud
image + cloud-init** (the automatable path). Resources are available: 16 cores,
~20 GB RAM free, ~700 GB on `local-lvm`.

1. **Download cloud image + build a reusable template** (or build 104 directly):
   - `wget` `noble-server-cloudimg-amd64.img` to `/var/lib/vz/template/`.
   - `qm create 104 --name Garrys-Mod-Server --memory 6144 --cores 4 --cpu host
     --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-single --ostype l26
     --agent enabled=1 --machine q35`.
   - `qm importdisk 104 <img> local-lvm`; attach as `scsi0`
     (`cache=writeback,discard=on,iothread=1,ssd=1`), `qm resize 104 scsi0 40G`.
   - `qm set 104 --ide2 local-lvm:cloudinit`, `--boot order=scsi0`,
     `--ciuser miles`, `--sshkeys <pubkey>`, `--ipconfig0 ip=dhcp`.
   - `qm start 104`; wait for guest agent (`qm agent 104 ping`).
2. **Base packages** (over SSH/guest-exec as root): `qemu-guest-agent` (cloud
   image ships it; confirm enabled), `lib32gcc-s1`, `tmux`, `python3`,
   `/usr/local/bin/rcon` is **not** needed — we reuse the in-guest Python RCON
   client from `backend/src/servers/rcon.js`, so just ensure `python3` exists.
3. **LinuxGSM gmodserver** (as `miles`):
   `curl -Lo linuxgsm.sh https://linuxgsm.sh && chmod +x linuxgsm.sh &&
   ./linuxgsm.sh gmodserver && ./gmodserver auto-install`.
   Install dir: `/home/miles/gmodserver`.
4. **CS:S content mount** (TTT maps reference CS:S textures/models):
   install CS:S dedicated content via SteamCMD (app **232330**) into a content
   dir, then add it to `garrysmod/cfg/mount.cfg`. Without this, TTT maps show
   missing-texture checkerboards.
5. **systemd unit** `gmodserver.service` — oneshot + `RemainAfterExit`,
   `ExecStart=/bin/bash -lc '… gmodserver start'`, `KillMode=process` (mirror the
   CS2 unit verbatim so booting the VM brings the game up).
6. **Instance + common cfg** (`lgsm/config-lgsm/gmodserver/`):
   - `gmodserver.cfg`: `gamemode="terrortown"`, `defaultmap="ttt_…"`,
     `maxplayers="<n>"`, `port="27016"`, `wscollectionid="<id>"`.
   - `common.cfg`: `rconpassword="<secret>"`, `gslt="<token>"`.

### Two steps that require **you** (cannot be automated)

- **GSLT token** — generate a Game Server Login Token for appid **4000** at
  `steamgameservers.com` (needs your Steam login). Required for reliable workshop
  downloads / server listing. Paste it; Claude writes it into `common.cfg`.
- **BGW210 port-forward** — add **27016 TCP/UDP → the GMOD VM** in the router web
  UI (27015 is already taken by CS2). Until then the server is LAN-only.

---

## 2. Phase 0b — PVE token ACL (Claude)

Grant the scoped `serverctl` token rights on the new VM (privsep ⇒ grant on
**both** the token and the user, per the CLAUDE.md gotcha):

```
pveum acl modify /vms/104 --tokens 'gamertown@pve!serverctl' --roles ServerCtl
pveum acl modify /vms/104 --users gamertown@pve --roles ServerCtl
```

Verify end-to-end: `qm agent 104 ping` and a token-authenticated
`status/current` call against `/nodes/pve/qemu/104`.

---

## 3. Phase 1 — Registry + connector wiring (code)

- `backend/src/servers/registry.js`: add
  `{ id: 'gmod', name: "Garry's Mod (TTT)", vmid: 104, connector: 'gmod',
     port: 27016, connect: 'cs' }`
  (`connect: 'cs'` → join string `connect <host>:27016`). Update the file header
  comment (currently says "only ever touch these three VMs").
- `backend/src/servers/connectors/index.js`: import `GmodConnector`, add
  `gmod: GmodConnector` to `CONNECTOR_CLASSES`.

No DB migration needed — `server_configs` and `server_workshop_maps` are already
scoped by `server_id`, so GMOD just uses `server_id='gmod'`.

---

## 4. Phase 2 — `GmodConnector` (the core code)

New file `backend/src/servers/connectors/gmod.js`, `extends LinuxGsmConnector`:

```
gsmUser = 'miles'; gsmDir = '/home/miles/gmodserver'; gsmScript = 'gmodserver';
```

Paths:
```
GARRYSMOD   = `${DIR}/serverfiles/garrysmod`
SERVER_CFG  = `${GARRYSMOD}/cfg/server.cfg`
MAPCYCLE    = `${GARRYSMOD}/cfg/mapcycle.txt`   // (or ${GARRYSMOD}/mapcycle.txt — verify on the box)
INSTANCE_CFG= `${DIR}/lgsm/config-lgsm/gmodserver/gmodserver.cfg`
COMMON_CFG  = `${DIR}/lgsm/config-lgsm/gmodserver/common.cfg`
```

**`configFiles`** whitelist (raw-editor access, Advanced): `server.cfg`,
`mapcycle.txt`, `lgsm.cfg` (instance), `lgsm-common.cfg`.

**`getSettings()`** — structured quick-settings the panel renders. Read
`server.cfg` (via `getCvar` from `cvars.js`) + instance cfg (via `getVar` from
`cfgvars.js`) + `mapcycle.txt`:

| Field | Source | Type |
|---|---|---|
| `map` (starting map) | instance `defaultmap` | text/select |
| `workshopCollection` | instance `wscollectionid` | text (digits) |
| `maxPlayers` | instance `maxplayers` | number 1–128 |
| `roundLimit` | `ttt_round_limit` | number |
| `timeLimitMinutes` | `ttt_time_limit_minutes` | number |
| `traitorPct` | `ttt_traitor_pct` | number 0–1 |
| `traitorMax` | `ttt_traitor_max` | number |
| `detectivePct` | `ttt_detective_pct` | number 0–1 |
| `detectiveMax` | `ttt_detective_max` | number |
| `minPlayers` | `ttt_minimum_players` | number |
| `useMapcycle` | `ttt_always_use_mapcycle` | bool (0/1) |
| `mapcycle` | `mapcycle.txt` body | textarea (one map per line) |
| `configId` | instance `gt_active_config` | select (config library) |

**`setSettings(values)`** — validate every field (numeric ranges; pct 0–1;
`wscollectionid` `^\d{1,20}$`; map name `^[a-z0-9_]{1,64}$`; mapcycle lines each
match the map-name regex), then:
- write `defaultmap` / `maxplayers` / `wscollectionid` into the **instance cfg**
  (`setVar`),
- write the `ttt_*` cvars into **server.cfg** (`setCvars`),
- write the **mapcycle.txt** body (sanitized: drop blank lines / bad names),
- deploy the selected library config into a managed `cfg/gamertown_active.cfg`
  exec'd from `server.cfg` — **identical mechanism to CS's `gamertown/active.cfg`**
  (idempotent `exec` line; empty file = no-op). Store the id in
  `gt_active_config`.
All changes apply on the next **Restart Hosting** / restart.

**Config library + map catalog** — reuse `BaseConnector`'s store-backed methods
(already generic). GMOD gets the same "save named TTT presets, pick one, deploy"
flow CS has. The workshop **collection** is a single id (a quick-settings field),
so the per-map `server_workshop_maps` catalog is optional for GMOD; the map
**rotation** is the `mapcycle.txt` textarea. (Optional nice-to-have: a saved
"map pool" stored as a library config and written to mapcycle.)

**Live RCON** (`getLive`/`sendCommand`/`runLiveAction`) — GMOD speaks Source
RCON on its game port (27016); reuse `rcon.js` exactly like CS. Available when
`rconpassword` is set (read from `common.cfg`/`server.cfg` at call time, never
persisted). Curated actions:
- `players` → `status` (or `ulx who` if ULX is added later)
- `change_map` → `changelevel <ttt_map>` (runtime-only; Startup sets persistent)
- `restart_map` → `changelevel <current>` (fast full reset)
- `apply_config` → `exec gamertown_active` (apply a saved preset live)
- free-form console box (validated by `validateLiveCommand`).

---

## 5. Phase 3 — Frontend (`servers.html`)

The structured fields are simple (numbers, a couple of selects, one textarea), so
GMOD uses the **generic section renderer** (Factorio-style) rather than a bespoke
panel — with two small, reusable additions to the renderer:
- `type: 'number'` (min/max/step) and `type: 'textarea'` field support
  (benefits any future game).
- a `bool` toggle (or render `useMapcycle` as a 0/1 select to avoid renderer
  changes).

Sections:
1. **TTT Settings** (apply on restart): map, max players, workshop collection,
   round limit, time limit, traitor pct/max, detective pct/max, min players,
   use-mapcycle, mapcycle textarea, config preset.
2. **Runtime** (live, server must be running): the existing generic console +
   curated-action UI from Phase 3 — no new UI code, just consumes `getLive()`.
3. Power/status/join bar + Update button (already generic).

---

## 6. Phase 4 — Tests + docs

- **Unit tests** (`backend/test/`, fake client + in-memory DB): cvar read/write
  round-trip in server.cfg; instance-cfg var writes; mapcycle sanitization;
  settings validation (ranges, pct bounds, bad map names rejected);
  `gamertown_active.cfg` exec-line idempotency; RCON argv construction +
  injection safety; join-string rendering for the new registry entry.
- **Docs**:
  - `INFRA.md`: new VM 104 row (RAM/disk/IP), port-forward table (+27016),
    systemd unit row, in-guest layout row (install dir, control, editable
    files), token-ACL note, GSLT + CS:S-mount notes.
  - `CLAUDE.md` gotchas: TTT cvar locations (server.cfg vs instance cfg),
    `ttt_always_use_mapcycle` requirement for autoplay, CS:S content mount,
    GSLT token, **port 27016** (27015 collision), `gamertown_active.cfg` exec
    convention.
  - `backend/README.md`: note GMOD in the servers section.
  - `SERVER_PANEL_PLAN.md` / `registry.js` header: drop "three VMs" wording.

---

## 7. Suggested order

1. **Phase 0/0b infra** (Claude provisions VM 104; you supply GSLT + port-forward).
2. **Phase 1 wiring** + **Phase 2 connector** (panel can read/write config).
3. **Phase 3 frontend** (renderer number/textarea support + sections).
4. **Phase 4 tests + docs**.

Each phase is independently shippable; until the port-forward lands the server is
fully usable on the LAN, and until the GSLT lands everything except workshop
auto-download works.

---

## 8. Open / nice-to-haves (not blocking)

- **ULX/ULib admin mod** for richer runtime actions (kick/ban/force-traitor,
  `ulx map`). Adds curated buttons later; not required for v1.
- **Saved map pools** as library configs (pick a pool → write mapcycle).
- **RTV / map-vote addon** as an alternative to fixed mapcycle autoplay.
- **Per-map TTT tuning** (different round counts per map) — out of scope.
