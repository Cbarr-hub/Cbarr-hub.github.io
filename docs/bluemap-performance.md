# BlueMap Performance

Gamertown keeps the 3D BlueMap renderer. The performance goal is to preserve
BlueMap's incremental state and reduce default client/render load, not replace it
with a 2D renderer.

## Current model

- `bluemap` runs as the standalone Docker CLI from `servers.compose.yml`, not as a
  Minecraft plugin.
- The command stays `-r -u -w -m overworld,nether,end`: render/update the
  configured dimensions, watch world-file changes, and run the internal
  webserver.
- The Minecraft world is mounted read-only at `/app/world`; BlueMap writes render
  state to `bluemap-data` and generated web/tile files to `bluemap-web`.
- Caddy reverse-proxies `/map/*` to `bluemap:8100` behind the login gate.

## Incremental updates

BlueMap already updates by differences. Its update system is based on Minecraft
region files: when the watched world files change, BlueMap schedules updates for
the affected map regions and normal render mode skips unchanged chunks. This is
not a pixel-diff between old and new map images.

A BlueMap container restart should not rerender the whole world if:

- `bluemap-data` and `bluemap-web` are preserved.
- Map config filenames/IDs stay stable.
- The command does not include `-f`.
- The map was not purged.
- Render-affecting settings were not changed.

Full rerenders are expected after deleting BlueMap volumes, purging maps, renaming
map config files, changing storage/map IDs, forcing `-f`, some BlueMap upgrades,
or changing render geometry settings such as high-res enablement, cave removal,
render masks, resource packs, or texture/model behavior.

## Operational rules

- Normal operation: `command: ["-r", "-u", "-w", "-m", "overworld,nether,end"]`.
- Edge repair only: use BlueMap's edge-fix mode/command during a maintenance
  window.
- Avoid routine `docker compose down -v`; it deletes the render state and turns
  the next boot into a full rebuild.
- If recent Minecraft changes are not visible, first flush the Minecraft world to
  disk. The standalone BlueMap container can only see saved world-file changes.
- Keep `render-thread-count: 0` so BlueMap has enough workers for the host. The
  app and host maintenance runner dynamically cap the container CPU quota: high
  while nobody is online, low while players are active.

## Tuned defaults

- BlueMap is pinned to a concrete Docker tag instead of `latest`.
- `webapp.conf` is tracked so 3D browser defaults are deterministic.
- Perspective/free-flight/high-res remain enabled for the Overworld.
- The map list is sorted so Overworld opens first; Nether and End remain
  available from BlueMap's map selector.
- The low-res default is high enough for the large Gamertown world to look
  populated on first open; users can lower it from BlueMap's settings if needed.
- BlueMap cookies are disabled so stale client-side map/distance settings do not
  override these defaults after deploys.
- File storage stays on `gzip`, which browsers can consume directly.
- BlueMap CPU policy defaults: active players -> 2 CPUs; empty server -> host CPU
  count minus 4 reserved CPUs; wait 5 minutes after the last player leaves before
  ramping up again.

## Live player markers (standalone, app-fed)

The standalone CLI has no server connection, so BlueMap's native live-player
markers are normally empty. The app fills them in:

- `backend/src/servers/bluemap-players.js` (`createBlueMapPlayersController`,
  wired in `server.js`) polls online Minecraft players every ~2s, looks up each
  position over RCON (the same `getPlayerPosition` the map "locate" used), and
  writes BlueMap's expected `web/maps/<id>/live/players.json` into the `bluemap`
  container through the scoped docker-proxy (`EXEC`). `foreign` is set per map so
  a player only draws as a marker on the dimension they're actually in.
- Real skins: it fetches each player's head PNG (by Mojang UUID, from
  `BLUEMAP_SKIN_BASE`, default `mc-heads.net`) once per process and writes it to
  **each rendered map's own asset root** `web/maps/<id>/assets/playerheads/<uuid>.png`
  — the path BlueMap v5 actually loads heads from (a global `web/assets/` is NOT
  served), and a foreign player still shows in other maps' lists so the head must
  exist under all of them. BlueMap's webapp renders it as the marker face;
  missing/failed heads fall back to BlueMap's default head. The skin fetch is
  time-bounded so a slow head service can't stall the loop.
- The marker is BlueMap's native head-on-a-billboard, not a posed 3D body.
- Needs `MINECRAFT_RCON_PASSWORD`; otherwise the controller stays idle. Knobs:
  `BLUEMAP_PLAYERS_AUTOWRITE`, `BLUEMAP_PLAYERS_POLL_MS`, `BLUEMAP_SKIN_BASE`,
  `BLUEMAP_SKIN_TIMEOUT_MS`.

The servers panel's Map tab adds a clickable live-player list (fly the camera)
over the same data, and a **Detail radius** slider that drives BlueMap's hires
view distance (its ceiling/default live in `webapp.conf`).

## Why there is no Factorio map

The Map tab is Minecraft-only. Every Factorio web-map tool (Mapshot,
FactorioMaps, Maptorio) renders the factory from in-game **screenshots**, which
the headless `factoriotools/factorio` image cannot produce (no display). The
only path is running a second, non-headless Factorio under Xvfb that loads the
save and exports Leaflet tiles on a schedule — heavyweight, non-live, and a
separate project. Deferred; the placeholder "Factorio mode" (a bare coordinate
readout) was removed from the panel.

## Measurement checklist

Before and after future changes, capture:

- `docker logs bluemap` startup behavior: it should report checking/updating, not
  forced full rendering.
- BlueMap render queue/progress while users build.
- `docker stats minecraft bluemap gamertown-app-1 gamertown-caddy-1`.
- Browser network waterfall for `/map/` first load, zoom, and pan.
- `/api/auth/gate` request fanout if map loads feel slow through Caddy.

## Fallbacks

If the 3D renderer is still too heavy after measurement:

- First fallback: move Minecraft to Paper/Fabric and test `squaremap` for a
  lightweight live 2D map. This sacrifices the 3D view.
- Vanilla-preserving fallback: scheduled Overviewer static renders. This also
  sacrifices live 3D.
- Avoid custom rendering unless the site needs a dedicated map product; it would
  require owning Anvil parsing, lighting, texture/model handling, tile pyramids,
  atomic publishing, and browser map UI.
