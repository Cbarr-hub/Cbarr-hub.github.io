// BaseConnector adapter for servers whose backend is a single-purpose container.
//
// DockerClient duck-types the transport surface BaseConnector consumes; the one
// structural difference is that the registry locator is `container`, surfaced
// through the inherited `vmid` getter.

import { BaseConnector } from './base.js';

export function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') {
    return Math.max(min, Math.min(max, fallback));
  }
  const n = Number(value);
  const effective = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, effective));
}

// If the container is running, the game is hosting. There is no separate
// in-guest service to start or stop, so game lifecycle actions are container
// power actions.
export function containerGameLifecycle(Base) {
  return class extends Base {
    async gameRunning() { return true; }
    async startGame()   { await this.start();    return { ok: true, action: 'startGame' }; }
    async stopGame()    { await this.shutdown(); return { ok: true, action: 'stopGame' }; }
    async restartGame() { await this.reboot();   return { ok: true, action: 'restartGame' }; }
  };
}

export class DockerBaseConnector extends containerGameLifecycle(BaseConnector) {
  get vmid() { return this.server.container; }
}
