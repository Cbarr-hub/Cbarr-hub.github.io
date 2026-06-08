import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnv(path = '.env') {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    const parsed = parseDotenv(readFileSync(absolute, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
  return {
    PORT: Number(process.env.PORT ?? 3000),
    HOST: process.env.HOST ?? '127.0.0.1',
    DB_PATH: process.env.DB_PATH ?? './data/gamertown.sqlite',
    SESSION_KEY_PATH: process.env.SESSION_KEY_PATH ?? './data/session-key',
    NODE_ENV: process.env.NODE_ENV ?? 'development',

    // Public address players use to reach the game servers (the port-forwarded
    // WAN IP or a domain). Dynamic on AT&T — update if it changes. Used only to
    // render the copy-pastable join strings on the control panel.
    PUBLIC_HOST: process.env.PUBLIC_HOST ?? '104.177.95.216',

    // Docker Engine — powers the containerized game servers + the control panel.
    // When not configured the /api/servers endpoints return 503 "not configured"
    // rather than crashing the backend. Points at the scoped socket-proxy, e.g.
    // "tcp://docker-proxy:2375".
    DOCKER_HOST: process.env.DOCKER_HOST ?? '',
    DOCKER_API_VERSION: process.env.DOCKER_API_VERSION ?? '',

    // BlueMap CPU auto-tuning. With render-thread-count set high in core.conf,
    // the backend dynamically caps the BlueMap container: low while players are
    // online, high while the hosted servers are empty.
    BLUEMAP_RESOURCE_AUTOTUNE: process.env.BLUEMAP_RESOURCE_AUTOTUNE ?? '1',
    BLUEMAP_CONTAINER: process.env.BLUEMAP_CONTAINER ?? 'bluemap',
    BLUEMAP_RESOURCE_POLL_SECONDS: process.env.BLUEMAP_RESOURCE_POLL_SECONDS ?? '60',
    BLUEMAP_IDLE_DELAY_SECONDS: process.env.BLUEMAP_IDLE_DELAY_SECONDS ?? '300',
    BLUEMAP_ACTIVE_CPUS: process.env.BLUEMAP_ACTIVE_CPUS ?? '2',
    BLUEMAP_IDLE_CPUS: process.env.BLUEMAP_IDLE_CPUS ?? '0',
    BLUEMAP_RESERVED_CPUS: process.env.BLUEMAP_RESERVED_CPUS ?? '4',
  };
}
