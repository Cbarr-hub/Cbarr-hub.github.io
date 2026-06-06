import assert from 'node:assert/strict';
import test from 'node:test';

import {
  steamId64, parseSourceStatus, parseMinecraftLog, parseFactorioLog,
} from '../src/servers/connectors/online-parse.js';

// ── SteamID → SteamID64 (BigInt) ─────────────────────────────────────────────────
test('steamId64 converts both notations (BigInt, beyond Number safe range)', () => {
  // STEAM_0:1:12345 → 76561197960265728 + 12345*2 + 1
  assert.equal(steamId64('STEAM_0:1:12345'), '76561197960290419');
  // [U:1:W] where W = Z*2+Y = 24691 → same player as the STEAM_ form above
  assert.equal(steamId64('[U:1:24691]'), '76561197960290419');
  // value exceeds Number.MAX_SAFE_INTEGER, so plain Number math would corrupt it
  assert.ok(Number('76561197960290419') > Number.MAX_SAFE_INTEGER);
  assert.equal(steamId64('not-an-id'), null);
  assert.equal(steamId64(''), null);
});

// ── Source `status` parser ───────────────────────────────────────────────────────
// parseSourceStatus returns { players, valid }: `valid` = a real status block was
// recognized (legacy header/row or CS2 block), the collector's close-pass gate.
test('parseSourceStatus reads names + SteamID64 from a GMOD status block, skipping the header row', () => {
  const out = [
    'hostname: Gamertown TTT',
    'version : 1.2.3',
    'players : 2 humans, 0 bots (16 max)',
    '# userid name uniqueid connected ping loss state adr', // header — not a player row
    '#  2 "Alice" STEAM_0:1:12345 05:30 60 0 active 192.168.1.5:27005',
    '#  3 "Bob"   [U:1:7654] 02:10 40 0 active 192.168.1.6:27005',
  ].join('\n');
  assert.deepEqual(parseSourceStatus(out), {
    valid: true,
    players: [
      { name: 'Alice', uid: '76561197960290419', identityKind: 'steam', slot: '2' },
      { name: 'Bob', uid: steamId64('[U:1:7654]'), identityKind: 'steam', slot: '3' },
    ],
  });
});

test('parseSourceStatus takes the uniqueid positionally — a SteamID in the display name cannot spoof it', () => {
  // The name embeds a STEAM_ token; the REAL uniqueid (after the closing quote) must win.
  const out = '#  2 "STEAM_0:1:99999 lol" STEAM_0:1:12345 05:30 60 0 active 1.2.3.4:27005';
  assert.deepEqual(parseSourceStatus(out).players, [
    { name: 'STEAM_0:1:99999 lol', uid: '76561197960290419', identityKind: 'steam', slot: '2' },
  ]);
});

test('parseSourceStatus dispatches on STRUCTURE — a GMOD player named --players-- still parses the real SteamID rows', () => {
  // The CS2 dispatch marker (`---players---`) here appears as a PLAYER NAME in a
  // legacy row. Dispatching on the legacy `#<userid> "name"` structure (not the text
  // marker) must keep this in the legacy parser; routing it to the CS2 parser would
  // yield an empty roster and make the collector close everyone's session.
  const out = [
    'hostname: Gamertown TTT',
    'players : 2 humans, 0 bots (16 max)',
    '#  2 "--players--" STEAM_0:1:12345 05:30 60 0 active 1.2.3.4:27005',
    '#  3 "Bob"   [U:1:7654] 02:10 40 0 active 1.2.3.4:27005',
  ].join('\n');
  const res = parseSourceStatus(out);
  assert.equal(res.valid, true);
  assert.deepEqual(res.players, [
    { name: '--players--', uid: '76561197960290419', identityKind: 'steam', slot: '2' },
    { name: 'Bob', uid: steamId64('[U:1:7654]'), identityKind: 'steam', slot: '3' },
  ]);
});

test('parseSourceStatus drops BOT rows (no SteamID, not a real human)', () => {
  const out = [
    '#  2 "Alice" STEAM_0:1:12345 05:30 60 0 active 1.2.3.4:27005',
    '#  5 "HardBot" BOT active',
  ].join('\n');
  assert.deepEqual(parseSourceStatus(out).players, [
    { name: 'Alice', uid: '76561197960290419', identityKind: 'steam', slot: '2' },
  ]);
});

test('parseSourceStatus degrades to name-only when the SteamID is redacted but the name is still quoted', () => {
  // Models a redacted-but-quoted Source row (uid unresolved → null). The REAL CS2
  // row shape is host-validated separately (see online-parse.js note) — if CS2 does
  // not quote names, that case is covered by the next test.
  assert.deepEqual(parseSourceStatus('#  4 "Carol"      active').players, [
    { name: 'Carol', uid: null, identityKind: 'steam', slot: '4' },
  ]);
});

test('parseSourceStatus skips a player row with no quoted name (the unverified CS2 shape) instead of guessing', () => {
  // Documents the known host-validation gap: an unquoted `#`-row yields NOTHING
  // (vs. mis-parsing some other column as the name). A CS2-specific branch is added
  // once we have a real `status` capture.
  assert.deepEqual(parseSourceStatus('#  4 1234567 Carol 00:30 50 0 active').players, []);
});

test('parseSourceStatus ignores headers, quoted hostnames, and quoted asset lines (no phantom entries)', () => {
  // Empty / unrecognized input is NOT a trustworthy status block (valid:false).
  assert.deepEqual(parseSourceStatus(''), { players: [], valid: false });
  // A real header with an empty roster IS trustworthy (valid:true) — the close pass
  // must run so the last stragglers get closed when a server genuinely empties.
  assert.deepEqual(parseSourceStatus('hostname: x\nplayers : 0 humans'), { players: [], valid: true });
  // A quoted server name / map-asset line must NOT become a phantom player.
  assert.deepEqual(parseSourceStatus('hostname: "Gamertown TTT"').players, []);
  assert.deepEqual(parseSourceStatus('spawngroups : loaded "[1: main {[0] | maps/de_dust2.vpk} ]"').players, []);
});

// ── CS2 (Source 2) `status` — captured live from joedwards32/cs2 ──────────────────
test('parseSourceStatus reads the CS2 players block: human captured name-only, bot + empty slot dropped', () => {
  const cs2 = [
    'players  : 1 humans, 1 bots (0 max) (not hibernating) (unreserved)',
    '---------spawngroups----',
    'loaded spawngroup(  1)  : SV:  [1: de_dust2 | main lump | mapload]',
    '---------players--------',
    '  id     time ping loss      state   rate adr name',
    "   0      BOT    0    0     active      0 'Solman'",
    "65535 [NoChan]    0    0 challenging      0unknown ''",
    "   2    02:05    0    0     active 786432 172.18.0.1:37738 'dheagman'",
    '#end',
  ].join('\n');
  const res = parseSourceStatus(cs2);
  assert.equal(res.valid, true);
  assert.deepEqual(res.players, [
    { name: 'dheagman', uid: null, identityKind: 'steam', slot: '2' },
  ]);
});

test('parseSourceStatus keeps an apostrophe inside a CS2 name (O\'Brien is not truncated to Brien)', () => {
  // The buggy `'([^']*)'$` capture took the LAST quoted run → 'Brien'. Capturing from
  // the first quote to the last (the columns before carry no quotes) preserves the
  // embedded apostrophe.
  const cs2 = [
    '---------players--------',
    '  id     time ping loss      state   rate adr name',
    "   2    02:05    0    0     active 786432 172.18.0.1:37738 'O'Brien'",
    '#end',
  ].join('\n');
  assert.deepEqual(parseSourceStatus(cs2).players, [
    { name: "O'Brien", uid: null, identityKind: 'steam', slot: '2' },
  ]);
});

test('parseSourceStatus returns [] for a CS2 server with only bots (no phantom from spawngroups)', () => {
  const cs2 = [
    '---------players--------',
    '  id     time ping loss      state   rate adr name',
    "   0      BOT    0    0     active      0 'Solman'",
    "   3      BOT    0    0     active      0 'Enforcer'",
    '#end',
  ].join('\n');
  assert.deepEqual(parseSourceStatus(cs2).players, []);
});

// ── Minecraft log parser ─────────────────────────────────────────────────────────
test('parseMinecraftLog detects uuid / join / leave', () => {
  assert.deepEqual(
    parseMinecraftLog('[12:00:00] [User Authenticator #1/INFO]: UUID of player Notch is 069a79f4-0807-408f-b8bf-ea1c0843f0a0'),
    { kind: 'uuid', name: 'Notch', uuid: '069a79f4-0807-408f-b8bf-ea1c0843f0a0' },
  );
  assert.deepEqual(parseMinecraftLog('[12:00:01] [Server thread/INFO]: Notch joined the game'),
    { kind: 'join', name: 'Notch' });
  assert.deepEqual(parseMinecraftLog('[12:00:05] [Server thread/INFO]: Notch left the game'),
    { kind: 'leave', name: 'Notch' });
  assert.equal(parseMinecraftLog('[12:00:09] [Server thread/INFO]: <Notch> hello'), null);
});

test('parseMinecraftLog does NOT treat chat as a join (anti-injection)', () => {
  // A player whose chat message embeds "ghost joined the game" must not forge a join:
  // the post-`]: ` text starts with the `<sender>` chat wrapper, not a bare name.
  assert.equal(parseMinecraftLog('[12:00:09] [Server thread/INFO]: <Evil> hey: ghost joined the game'), null);
  // A player literally chatting "joined the game" (sender wrapped in <…>) is not a join.
  assert.equal(parseMinecraftLog('[12:00:09] [Server thread/INFO]: <Evil> joined the game'), null);
  assert.equal(parseMinecraftLog('[12:00:09] [Server thread/INFO]: <Evil> left the game'), null);
});

// ── Factorio log parser ──────────────────────────────────────────────────────────
test('parseFactorioLog detects [JOIN] / [LEAVE]', () => {
  assert.deepEqual(parseFactorioLog('2026-06-06 12:00:00 [JOIN] Alice joined the game'),
    { kind: 'join', name: 'Alice' });
  assert.deepEqual(parseFactorioLog('[LEAVE] Alice left the game'),
    { kind: 'leave', name: 'Alice' });
  assert.equal(parseFactorioLog('[CHAT] Alice: hi'), null);
});

test('parseFactorioLog does NOT treat a [JOIN] embedded in chat as a join (anti-injection)', () => {
  // The server emits [JOIN]/[LEAVE] at the start of the message; a [JOIN] inside a
  // [CHAT] line (player-controlled text) must be ignored.
  assert.equal(parseFactorioLog('2026-06-06 12:00:00 [CHAT] Attacker: [JOIN] Ghost joined the game'), null);
  assert.equal(parseFactorioLog('2026-06-06 12:00:00 [CHAT] Attacker: [LEAVE] Ghost left the game'), null);
  // Sanity: the same tag at message start (with that timestamp) still parses.
  assert.deepEqual(parseFactorioLog('2026-06-06 12:00:00 [JOIN] Ghost joined the game'),
    { kind: 'join', name: 'Ghost' });
});
