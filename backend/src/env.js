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
  };
}
