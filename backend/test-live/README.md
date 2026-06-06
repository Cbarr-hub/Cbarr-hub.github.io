# Live RCON smoke tests

These are **integration** checks that need the real stack running (not part of
`npm test` — they live here, outside `test/`, so `node --test test/*.test.mjs` skips them).
They drive the **actual connectors** (`getLive` → `runLiveAction` / `sendCommand`) against the
running game containers, so a green run means the panel's live buttons/sliders work on the
deployed game images — catching image-specific command mismatches that unit tests can't
(e.g. Minecraft gamerules going snake_case + `spawn_mobs`, GMOD lacking the CS2-only
`sv_*bunnyhopping` / HL2-only `hl2_normspeed` cvars).

## Run

Bring the dev stack up first (`tools/dev.ps1`). Then, from the repo root, copy a script into the
running app container (which has `DOCKER_HOST`, every `*_RCON_PASSWORD`, and compose-network reach
to each game service) and run it:

```powershell
# Full matrix across all 5 games:
docker cp backend/test-live/rcon-smoke.mjs cbarr-hubgithubio-app-1:/app/rcon-smoke.mjs
docker exec cbarr-hubgithubio-app-1 node /app/rcon-smoke.mjs
# Limit to specific games:
docker exec cbarr-hubgithubio-app-1 node /app/rcon-smoke.mjs gmod,prophunt,minecraft

# Ad-hoc probe of arbitrary commands against one game (to discover the right cvar/name):
docker cp backend/test-live/probe.mjs cbarr-hubgithubio-app-1:/app/probe.mjs
docker exec cbarr-hubgithubio-app-1 node /app/probe.mjs gmod "sv_maxspeed" "sv_airaccelerate"
```

`rcon-smoke.mjs` fires every advertised action + control (sliders get a mid-range value, then the
cvar is read back), plus a per-game sanity query, and prints a matrix + a `FAILURES` list.

## Classification

| Tier | Meaning |
|---|---|
| **✓ CONFIRMED** | output proves the effect — an echo (`… is now set to`, `Set the time to`) or a cvar **read-back** returning the value we set |
| **· accepted** | ran with no error but no observable echo (fire-and-forget: `mp_restartgame`, `sv_cheats 1`, `/server-save`, silent cvar sets) — verify in-game, not over RCON |
| **✗ FAILED** | output matches an error signature (`Unknown command`, `Incorrect argument`, `<--[HERE]`, …) — the command string is wrong for this image; fix it in the connector |
| **? UNREACHABLE** | RCON unavailable (server still booting / password unset) |

The data is junk/local, so these are destructive by design (they set gravity, gamerules, maps,
etc.); the harness resets the few visible Source cvars at the end. Prod data is separate and
restorable from R2 (`tools/db-restore.ps1`). Re-run after any game image version bump.
