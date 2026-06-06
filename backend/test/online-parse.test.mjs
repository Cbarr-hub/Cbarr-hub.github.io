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
test('parseSourceStatus reads names + SteamID64 from a GMOD status block', () => {
  const out = [
    'hostname: Gamertown TTT',
    'version : 1.2.3',
    'players : 2 humans, 0 bots (16 max)',
    '# userid name uniqueid connected ping loss state adr',
    '#  2 "Alice" STEAM_0:1:12345 05:30 60 0 active 192.168.1.5:27005',
    '#  3 "Bob"   [U:1:7654] 02:10 40 0 active 192.168.1.6:27005',
  ].join('\n');
  const roster = parseSourceStatus(out);
  assert.deepEqual(roster, [
    { name: 'Alice', uid: '76561197960290419', identityKind: 'steam' },
    { name: 'Bob', uid: steamId64('[U:1:7654]'), identityKind: 'steam' },
  ]);
});

test('parseSourceStatus degrades to name-only when the SteamID is redacted (CS2)', () => {
  const out = '#  4 "Carol"      active\nhostname: x';
  assert.deepEqual(parseSourceStatus(out), [
    { name: 'Carol', uid: null, identityKind: 'steam' },
  ]);
});

test('parseSourceStatus ignores empty input + header-only blocks', () => {
  assert.deepEqual(parseSourceStatus(''), []);
  assert.deepEqual(parseSourceStatus('hostname: x\nplayers : 0 humans'), []);
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

// ── Factorio log parser ──────────────────────────────────────────────────────────
test('parseFactorioLog detects [JOIN] / [LEAVE]', () => {
  assert.deepEqual(parseFactorioLog('2026-06-06 12:00:00 [JOIN] Alice joined the game'),
    { kind: 'join', name: 'Alice' });
  assert.deepEqual(parseFactorioLog('[LEAVE] Alice left the game'),
    { kind: 'leave', name: 'Alice' });
  assert.equal(parseFactorioLog('[CHAT] Alice: hi'), null);
});
