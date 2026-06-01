# Garry's Mod (TTT) Server — ✅ Shipped

Adds a fourth game server — Garry's Mod running **Trouble in Terrorist Town** —
to the control panel. **Done and live:** VM 104 provisioned, `GmodConnector`
wired, frontend + tests + docs landed, the 27066 port-forward is live and
A2S-verified. This file is kept as a short record; the canonical reference is
[`INFRA.md`](INFRA.md) ("Game Server Control Panel" + the VM-104 runbook).

Architecturally it was a copy job: GMOD is a Source/LinuxGSM server like CS2 and
Factorio, so `GmodConnector extends LinuxGsmConnector` and reuses
`cvars.js`/`cfgvars.js`/`rcon.js`, the DB config library, and the generic
service/route/UI layers. No new architectural concepts.

## What shipped

- **VM 104** (`Garrys-Mod-Server`, 192.168.1.243) — Ubuntu 24.04 cloud-image +
  cloud-init, LinuxGSM `gmodserver`, CS:S content mounted, systemd auto-start.
  Full provisioning runbook in `INFRA.md`.
- **Port 27066** (TCP/UDP) — **27015/27016 were unavailable** because the CS
  forward already claims 27000–27039; 27066 is forwarded + live.
- **Registry + connector** — `{ id:'gmod', vmid:104, port:27066 }`;
  `connectors/gmod.js`.
- **Panel** — TTT quick-settings (map, workshop collection, round/time limits,
  traitor & detective pct/max, min players, mapcycle, config preset) via the
  generic section renderer; live RCON console + curated actions.
- **Tests + docs** — `backend/test/`, `INFRA.md`, `CLAUDE.md` gotchas.

## ⚠️ Config-file reality (differs from the original plan)

The plan guessed `server.cfg` / port 27016; the **as-built** truth (see the
CLAUDE.md gotchas) is:

| Thing | Actual |
|---|---|
| Game cfg (TTT cvars + `rcon_password`) | `serverfiles/garrysmod/cfg/gmodserver.cfg` (launched via `+servercfgfile gmodserver.cfg`) — **not** `server.cfg` |
| Map rotation | `serverfiles/garrysmod/mapcycle.txt` (needs `ttt_always_use_mapcycle 1`) |
| Managed live-config exec | `cfg/gamertown/active.cfg` (same convention as CS) |
| Game port | **27066** |

## Still pending

- **GSLT token (manual — needs a Steam login).** Generate a Game Server Login
  Token for appid 4000 at `steamgameservers.com`, set `gslt="…"` in the instance
  cfg, restart. Without it the server runs fine (TTT is built in, LAN works) but
  Workshop auto-download / public listing are unreliable.

## Open / nice-to-haves (not blocking)

- ULX/ULib admin mod for richer runtime actions (kick/ban/force-traitor).
- Saved "map pools" as library configs written to mapcycle.
- RTV / map-vote addon as an alternative to fixed mapcycle autoplay.
