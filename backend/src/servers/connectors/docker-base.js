// BaseConnector adapter for servers whose backend is a single-purpose container.
//
// DockerClient duck-types the transport surface BaseConnector consumes; the one
// structural difference is that the registry locator is `container`, surfaced
// through the inherited `vmid` getter.

import { BaseConnector } from './base.js';

// Coerce a slider/profile value into [min, max], substituting `fallback` for
// empty/null/undefined/non-finite input. Shared by every Docker connector that
// pushes a clamped numeric cvar (e.g. live range sliders → RCON). The final
// Math.max(min, Math.min(max, …)) also guards `fallback` itself being out of
// range, so the return is always within bounds.
export function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') {
    return Math.max(min, Math.min(max, fallback));
  }
  const n = Number(value);
  const effective = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, effective));
}

// Mixin: the container IS the game. If the container is running, the game is
// hosting, so there is no separate in-guest service to start/stop — the
// game-lifecycle actions (startGame/stopGame/restartGame) alias straight onto
// container power (start/shutdown/reboot). Applied to BaseConnector below, and
// reused by the LinuxGSM Docker connectors (GMOD/Prop Hunt) so they share the
// same alias instead of throwing BAD_ACTION. Each action returns
// { ok: true, action } so callers/tests can assert which alias fired.
export function containerGameLifecycle(Base) {
  return class extends Base {
    // Always true while reachable: the container IS the game (status running ==
    // hosting), so base.js's separate 'idle' branch is intentionally unreachable
    // for Docker games.
    async gameRunning() { return true; }
    async startGame()   { await this.start();    return { ok: true, action: 'startGame' }; }
    async stopGame()    { await this.shutdown(); return { ok: true, action: 'stopGame' }; }
    async restartGame() { await this.reboot();   return { ok: true, action: 'restartGame' }; }
  };
}

export class DockerBaseConnector extends containerGameLifecycle(BaseConnector) {
  get vmid() { return this.server.container; }
}
