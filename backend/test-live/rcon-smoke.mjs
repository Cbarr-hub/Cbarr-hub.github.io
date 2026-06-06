// Live RCON smoke test — drives the REAL connectors against the running game
// servers and reports what each wired action/control actually does over RCON.
//
// This is NOT a unit test (it needs the live stack), so it lives under test-live/
// and is excluded from `node --test test/*.test.mjs`. Run it INSIDE the app
// container, which has DOCKER_HOST, every *_RCON_PASSWORD, and compose-network
// reach to the game services:
//
//   docker cp backend/test-live/rcon-smoke.mjs cbarr-hubgithubio-app-1:/app/rcon-smoke.mjs
//   docker exec cbarr-hubgithubio-app-1 node /app/rcon-smoke.mjs
//
// Optional: pass a comma list to limit games, e.g. `... rcon-smoke.mjs minecraft,gmod`.
//
// It uses the same code path the panel uses (getLive → runLiveAction / sendCommand),
// so a green run means the buttons/sliders in the UI work. Classification:
//   CONFIRMED ✓    output proves the effect (echo / cvar read-back returns the value)
//   ACCEPTED  ·    ran, no error, but no observable echo (fire-and-forget)
//   FAILED    ✗    output matches an error signature (Unknown command / Incorrect argument / …)
//   UNREACHABLE    RCON unavailable (server still booting / password unset)
//
// Imports are written relative to /app (where this file is copied), so they resolve
// against the container's bind-mounted /app/src.

import { DockerClient } from './src/docker/client.js';
import { buildConnectors } from './src/servers/connectors/index.js';

const ONLY = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
const ORDER = ['counterstrike', 'gmod', 'prophunt', 'factorio', 'minecraft'];

// Output that means the game rejected the command.
const ERR_RE = /unknown command|incorrect argument|bad command|not ?found|cannot execute|invalid|unknown or incomplete|<--\[HERE\]|usage:|syntax error|no such|error running|attempt to/i;

// A control key → the cvar to query for read-back confirmation (Source games).
const READBACK = {
  gravity: 'sv_gravity', speed: 'hl2_normspeed', timescale: 'host_timescale',
  traitor_pct: 'ttt_traitor_pct', round_limit: 'ttt_round_limit',
  roundtime: 'mp_roundtime_defuse', startmoney: 'mp_startmoney', bots: 'bot_quota',
  ph_round_time: 'ph_round_time', ph_blind_time: 'ph_hunter_blindlock_time',
};

// A sanity read per game (proves RCON is alive + shows current state).
const SANITY = {
  counterstrike: 'status', gmod: 'status', prophunt: 'status',
  factorio: '/players', minecraft: 'list',
};

const tag = { CONFIRMED: '✓ CONFIRMED', ACCEPTED: '· accepted ', FAILED: '✗ FAILED   ', UNREACHABLE: '? UNREACH  ' };
const out1 = (s) => String(s ?? '').replace(/\r?\n/g, ' ⏎ ').trim().slice(0, 160);

function classify(output) {
  const s = String(output ?? '').trim();
  if (ERR_RE.test(s)) return 'FAILED';
  if (s.length) return 'CONFIRMED';
  return 'ACCEPTED';
}

function testValue(c) {
  const min = Number(c.min), max = Number(c.max), step = Number(c.step) || 1;
  let v = min + (max - min) * 0.5;
  v = Math.round(v / step) * step;
  v = Math.min(max, Math.max(min, v));
  return Number.isInteger(step) ? Math.round(v) : Number(v.toFixed(3));
}

const counts = { CONFIRMED: 0, ACCEPTED: 0, FAILED: 0, UNREACHABLE: 0 };
const failures = [];

function record(game, kind, label, status, output, sent) {
  counts[status]++;
  if (status === 'FAILED') failures.push({ game, label, sent, output: out1(output) });
  const sentStr = sent ? `  [${sent}]` : '';
  console.log(`  ${tag[status]}  ${kind.padEnd(7)} ${String(label).padEnd(22)}${sentStr}  →  ${out1(output) || '(no output)'}`);
}

async function probeGame(id, conn) {
  console.log(`\n══ ${id} ${'═'.repeat(Math.max(0, 60 - id.length))}`);
  let live;
  try { live = await conn.getLive(); }
  catch (e) { console.log(`  getLive() threw: ${e.message}`); record(id, 'getLive', '(getLive)', 'UNREACHABLE', e.message); return; }
  if (!live || !live.available) {
    record(id, 'getLive', '(unavailable)', 'UNREACHABLE', live?.reason || 'getLive returned unavailable');
    return;
  }

  // sanity read
  try { const r = await conn.sendCommand(SANITY[id]); record(id, 'sanity', SANITY[id], classify(r?.output), r?.output, SANITY[id]); }
  catch (e) { record(id, 'sanity', SANITY[id], 'UNREACHABLE', e.message, SANITY[id]); }

  // action buttons
  for (const a of live.actions || []) {
    try { const r = await conn.runLiveAction(a.key); record(id, 'action', a.label || a.key, classify(r?.output), r?.output); }
    catch (e) { record(id, 'action', a.label || a.key, 'FAILED', e.message); }
  }

  // range sliders — set a mid value, then read the cvar back to confirm
  for (const c of live.controls || []) {
    const v = testValue(c);
    let status, output;
    try {
      const r = await conn.runLiveAction(c.key, String(v));
      output = r?.output; status = classify(output);
      if (status !== 'FAILED' && READBACK[c.key]) {
        const back = await conn.sendCommand(READBACK[c.key]);
        const bs = String(back?.output ?? '');
        if (!ERR_RE.test(bs) && bs.includes(String(Math.trunc(v)))) { status = 'CONFIRMED'; output = `set ${v}; readback: ${out1(bs)}`; }
        else if (status === 'ACCEPTED') { output = `set ${v} (no echo); readback: ${out1(bs)}`; }
      }
    } catch (e) { status = 'FAILED'; output = e.message; }
    record(id, 'control', `${c.label} = ${v}`, status, output, READBACK[c.key]);
  }
}

async function resetSane(conns) {
  // Put the few visible cvars back to defaults on the Source games (junk data, but tidy).
  const resets = {
    gmod: ['sv_gravity 600', 'host_timescale 1'],
    prophunt: ['sv_gravity 600', 'host_timescale 1'],
    counterstrike: ['sv_gravity 800'],
  };
  for (const [id, cmds] of Object.entries(resets)) {
    const conn = conns.get(id);
    if (!conn) continue;
    for (const c of cmds) { try { await conn.sendCommand(c); } catch {} }
  }
}

async function main() {
  if (!process.env.DOCKER_HOST) { console.error('DOCKER_HOST not set — run inside the app container.'); process.exit(2); }
  const docker = new DockerClient({ host: process.env.DOCKER_HOST });
  const conns = buildConnectors({ docker }, null);

  const ids = ORDER.filter((id) => conns.has(id) && (!ONLY.length || ONLY.includes(id)));
  console.log(`Live RCON smoke — games: ${ids.join(', ')}`);

  for (const id of ids) await probeGame(id, conns.get(id));
  await resetSane(conns);

  console.log(`\n${'─'.repeat(64)}\nSUMMARY  ✓ ${counts.CONFIRMED} confirmed   · ${counts.ACCEPTED} accepted   ✗ ${counts.FAILED} failed   ? ${counts.UNREACHABLE} unreachable`);
  if (failures.length) {
    console.log(`\nFAILURES (fix these command strings):`);
    for (const f of failures) console.log(`  ✗ ${f.game}: ${f.label}${f.sent ? ` [${f.sent}]` : ''} → ${f.output}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('harness error:', e); process.exit(1); });
