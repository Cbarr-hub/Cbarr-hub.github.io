// Pure parsers for "who's online / who joined/left" output, shared by the
// host-side session collector (tools/gt-session-tracker.mjs). Dependency-free on
// purpose: the collector runs on the keeper with no node_modules and imports this
// directly, so keep this module to language builtins only.
//
// Three identity namespaces: SteamID64 (the Source games — GMOD/Prop Hunt/CS2),
// the Mojang UUID (Minecraft), and the Factorio account name (its only handle).

// SteamID64 base offset (the "Y" account-universe constant). The result exceeds
// Number.MAX_SAFE_INTEGER, so the math MUST be BigInt; we return a decimal string.
const STEAMID64_BASE = 76561197960265728n;

/**
 * Convert a Source SteamID token to SteamID64 (decimal string), or null if the
 * token isn't a recognized form. Handles both legacy `STEAM_X:Y:Z` and the
 * modern `[U:1:W]` ("SteamID3") notations.
 */
export function steamId64(token) {
  if (!token) return null;
  let m = /^STEAM_[0-5]:([01]):(\d+)$/.exec(token);
  if (m) {
    const y = BigInt(m[1]);
    const z = BigInt(m[2]);
    return (z * 2n + y + STEAMID64_BASE).toString();
  }
  m = /^\[U:1:(\d+)\]$/.exec(token);
  if (m) {
    return (BigInt(m[1]) + STEAMID64_BASE).toString();
  }
  return null;
}

/** Normalize one roster entry. */
export function player(name, uid, identityKind) {
  return { name: String(name), uid: uid ?? null, identityKind };
}

// A SteamID token in either notation, scanned for anywhere on a status line.
const STEAMID_TOKEN = /(STEAM_[0-5]:[01]:\d+|\[U:1:\d+\])/;

/**
 * Parse Source-engine `status` output into a roster. Token-anchored: a player
 * line carries a quoted "name" plus (usually) a SteamID token. GMOD/Prop Hunt
 * expose the SteamID → SteamID64; CS2 redacts it, so those rows degrade to
 * name-only (uid:null). Lines without a quoted name are ignored (headers, etc.).
 *
 * @returns {{name:string, uid:string|null, identityKind:'steam'}[]}
 */
export function parseSourceStatus(output) {
  const out = [];
  for (const line of String(output ?? '').split('\n')) {
    // Skip the "hostname:"/"players :" header rows — they carry no quoted name.
    const name = line.match(/"([^"]*)"/);
    if (!name) continue;
    const tok = line.match(STEAMID_TOKEN);
    out.push(player(name[1], tok ? steamId64(tok[1]) : null, 'steam'));
  }
  return out;
}

/**
 * Parse one Minecraft server log line (the itzg/vanilla format, after any
 * `docker logs -t` timestamp + the `[HH:MM:SS] [thread/LEVEL]:` prefix). Returns
 * a typed event or null. The UUID line precedes the join line at login, so the
 * collector caches name→uuid from 'uuid' events and consumes it on the next join.
 */
export function parseMinecraftLog(line) {
  const s = String(line ?? '');
  let m = /UUID of player (\S+) is ([0-9a-fA-F-]{32,36})/.exec(s);
  if (m) return { kind: 'uuid', name: m[1], uuid: m[2].toLowerCase() };
  m = /: (\S+) joined the game(?:\s|$)/.exec(s);
  if (m) return { kind: 'join', name: m[1] };
  m = /: (\S+) left the game(?:\s|$)/.exec(s);
  if (m) return { kind: 'leave', name: m[1] };
  return null;
}

/**
 * Parse one Factorio server log line. Factorio tags join/leave with [JOIN]/[LEAVE]
 * (the name IS the only identity it exposes). Returns a typed event or null.
 */
export function parseFactorioLog(line) {
  const s = String(line ?? '');
  let m = /\[JOIN\]\s+(.+?)\s+joined the game/.exec(s);
  if (m) return { kind: 'join', name: m[1] };
  m = /\[LEAVE\]\s+(.+?)\s+left the game/.exec(s);
  if (m) return { kind: 'leave', name: m[1] };
  return null;
}
