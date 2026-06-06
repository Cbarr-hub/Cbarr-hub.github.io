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

// A SteamID token in either notation. Matched ONLY against the part of a player
// row AFTER the (quoted) name — never the whole line — so a SteamID embedded in a
// display name can't be mistaken for the real uniqueid (anti-spoof).
const STEAMID_TOKEN = /(STEAM_[0-5]:[01]:\d+|\[U:1:\d+\])/;

// A legacy-srcds (GMOD/Prop Hunt) player row begins with `#` then a numeric userid
// ("slot"), e.g.  #  2 "Alice" STEAM_0:1:12345 05:30 60 0 active 1.2.3.4:27005
// The column header `# userid name uniqueid …` has NO numeric userid, so it is
// excluded — as are hostname:/map:/version:/players: header lines.
const LEGACY_ROW = /^#\s*(\d+)\s+(.+)$/;

// The CS2 (Source 2) `status` lists players in a `---------players--------` block,
// terminated by `#end`. Validated live against joedwards32/cs2:
//   ---------players--------
//     id     time ping loss      state   rate adr name
//      0      BOT    0    0     active      0 'Solman'             ← bot
//   65535 [NoChan]   0    0 challenging      0unknown ''           ← connecting slot
//      2    02:05    0    0     active 786432 172.18.0.1:37738 'dheagman'  ← human
//   #end
// Names are SINGLE-quoted and last, the SteamID is redacted (→ uid:null), `BOT`
// sits in the time column for bots, and connecting slots have an empty name `''`.
const CS2_PLAYERS_MARKER = /-{2,}\s*players\s*-{2,}/i;

/**
 * Parse Source-engine `status` output into a roster of
 * `{ name, uid|null, identityKind:'steam', slot }`. Dispatches on the two real
 * formats (both validated live against the running containers):
 *  • Legacy srcds — GMOD/Prop Hunt: `#<userid> "Name" <uniqueid> …`; the uniqueid is
 *    a STEAM_/[U:1:] token → SteamID64; name double-quoted.
 *  • Source 2 — CS2: the `--------players--------` block above; name single-quoted +
 *    last, SteamID redacted (uid:null).
 * BOT rows and empty-name slots are dropped in both. The uniqueid is taken only from
 * the part after the name (legacy) / is absent (CS2), so a SteamID embedded in a
 * display name cannot spoof it.
 */
export function parseSourceStatus(output) {
  const text = String(output ?? '');
  return CS2_PLAYERS_MARKER.test(text) ? parseCs2Status(text) : parseLegacyStatus(text);
}

function parseLegacyStatus(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const row = LEGACY_ROW.exec(line);
    if (!row) continue;
    // srcds quotes the name. Take the uniqueid ONLY from the remainder after the
    // closing quote (anti-spoof). No quoted name → unknown row shape, skip.
    const nameMatch = /^"([^"]*)"\s*(.*)$/.exec(row[2]);
    if (!nameMatch) continue;
    const after = nameMatch[2].trim();
    // BOT rows carry `BOT` in the uniqueid column instead of a SteamID — drop them.
    if (/^BOT\b/.test(after)) continue;
    const tok = after.match(STEAMID_TOKEN);
    out.push({ ...player(nameMatch[1], tok ? steamId64(tok[1]) : null, 'steam'), slot: row[1] });
  }
  return out;
}

function parseCs2Status(text) {
  const out = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (CS2_PLAYERS_MARKER.test(line)) { inBlock = true; continue; }
    if (!inBlock) continue;
    if (/^\s*#?end\b/i.test(line)) break;        // end-of-block marker
    if (/^\s*id\s+time\b/i.test(line)) continue;  // column header
    // Name is the trailing single-quoted field; CS2 redacts the SteamID (name-only).
    const nameMatch = /'([^']*)'\s*$/.exec(line);
    if (!nameMatch || !nameMatch[1]) continue;    // no name / empty connecting slot
    const before = line.slice(0, nameMatch.index);
    if (/\bBOT\b/.test(before)) continue;         // bots aren't real players
    out.push({ ...player(nameMatch[1], null, 'steam'), slot: (before.match(/\d+/) || [])[0] ?? null });
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
