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

export class DockerBaseConnector extends BaseConnector {
  get vmid() { return this.server.container; }
}
