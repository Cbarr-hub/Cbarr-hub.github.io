# BlueMap Performance

Gamertown keeps the 3D BlueMap renderer. The performance goal is to preserve
BlueMap's incremental state and reduce default client/render load, not replace it
with a 2D renderer.

## Current model

- `bluemap` runs as the standalone Docker CLI from `servers.compose.yml`, not as a
  Minecraft plugin.
- The command stays `-r -u -w`: render/update configured maps, watch world-file
  changes, and run the internal webserver.
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

- Normal operation: `command: ["-r", "-u", "-w"]`.
- Edge repair only: use BlueMap's edge-fix mode/command during a maintenance
  window.
- Avoid routine `docker compose down -v`; it deletes the render state and turns
  the next boot into a full rebuild.
- If recent Minecraft changes are not visible, first flush the Minecraft world to
  disk. The standalone BlueMap container can only see saved world-file changes.
- Keep `render-thread-count: 1` during normal play. For catch-up renders, raise it
  to `2` temporarily and watch Minecraft CPU/tick behavior.

## Tuned defaults

- BlueMap is pinned to a concrete Docker tag instead of `latest`.
- `webapp.conf` is tracked so 3D browser defaults are deterministic.
- Perspective/free-flight/high-res remain enabled for the Overworld.
- The high-res and low-res slider defaults are lower than BlueMap's defaults, so
  first load and pan/zoom use less geometry while users can still raise detail.
- File storage stays on `gzip`, which browsers can consume directly.

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
