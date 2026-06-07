# Gamertown documentation

All project documentation lives here. Two files stay at the repo root by convention:
[`../README.md`](../README.md) (GitHub landing) and [`../CLAUDE.md`](../CLAUDE.md) (the
operations quick-reference + game-config gotchas, auto-loaded by Claude Code).

| Doc | What it covers |
|---|---|
| [`local-dev.md`](local-dev.md) | Run the full stack locally (Windows/macOS/Linux): one command `gt … dev --fresh` (over `tools/setup.*` + `tools/dev.*` + `tools/db-restore.*`) |
| [`infrastructure.md`](infrastructure.md) | Current architecture — the Docker stack on the keeper (VM 106), containers, volumes, edge, forwarded ports |
| [`disaster-recovery.md`](disaster-recovery.md) | Rebuild from GitHub + R2 + the age passphrase; the R2 backup inventory + partial-recovery recipes |
| [`backend.md`](backend.md) | Backend API surface, the auth/security model, the CLI, and the game-server control panel |
| [`design-system.md`](design-system.md) | Frontend design reference — colour scheme, layout, responsive breakpoints |

For day-to-day operations and the game-server gotchas (GMOD workshop, Factorio saves,
RCON ports, Prop Hunt), see [`../CLAUDE.md`](../CLAUDE.md).

> The pre-Docker Proxmox topology (`INFRA_LEGACY.md`) and the completed
> `DOCKER_MIGRATION_PLAN.md` were retired on 2026-06-05 — recover them from git history
> if you need the VM-era details.
