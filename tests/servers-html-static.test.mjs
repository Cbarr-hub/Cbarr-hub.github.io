import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// servers.html lives at the repo root, one level up from tests/.
const htmlPath = fileURLToPath(new URL('../servers.html', import.meta.url));
const html = readFileSync(htmlPath, 'utf8');
const dbPath = fileURLToPath(new URL('../db.js', import.meta.url));
const dbJs = readFileSync(dbPath, 'utf8');

test('live Activity view is preserved', () => {
  assert.ok(html.includes("getElementById('actlist')"), 'Activity list lookup should remain');
  assert.ok(html.includes('function startActivity'), 'startActivity should remain');
  assert.ok(html.includes("'/servers/online'"), 'presence endpoint still polled');
});

test('Pulse analytics view is wired in', () => {
  assert.ok(html.includes('data-view="stats"'), 'Pulse nav button');
  assert.ok(html.includes('id="view-stats"'), 'Pulse view container');
  assert.ok(html.includes('function startStats'), 'startStats');
  assert.ok(html.includes('function loadStats'), 'loadStats');
  assert.ok(html.includes("'/servers/stats'"), 'stats endpoint still fetched');
});

test('Pulse per-game list has no monogram code chips', () => {
  assert.ok(!html.includes('g-code'), 'per-game rows should not render monogram code chips');
});

test('link queue has reversible dismiss/restore; economy shows earnings instead of inline linking', () => {
  assert.ok(html.includes('act-dismiss'), 'dismiss button class');
  assert.ok(html.includes('act-restore'), 'restore button class (dismiss is reversible)');
  assert.ok(html.includes('/ignore'), 'calls the player-ignore endpoint');
  assert.ok(html.includes('Player earnings'), 'economy roster relabeled to earnings');
  assert.ok(html.includes('eco-earned'), 'economy roster shows a $ earned cell');
});

test('kleptocrat accounts render as gold crown tiles', () => {
  assert.ok(html.includes('klepto'), 'klepto modifier class');
  assert.ok(html.includes('♛'), 'crown glyph');
});

// ── consolidation invariants (servers panel v3) ───────────────────────────────

test('the Intent-Switch mode system is gone — one sheet with tabs', () => {
  assert.ok(!html.includes('data-mode'), 'no mode-switch buttons remain');
  assert.ok(!html.includes('dmode'), 'no mode chrome remains');
  assert.ok(!html.includes('tweakCopy') && !html.includes('renderTweak'), 'no Tweak renderer remains');
  for (const pane of ['overview', 'runtime', 'profiles', 'maps', 'raw']) {
    assert.ok(html.includes(`key:'${pane}'`), `detail tab ${pane} present in DTABS`);
  }
});

test('removed db.js wrappers are not referenced and the import list matches db.js exports', () => {
  for (const gone of ['dbGetServers', 'dbGetActivityAll', 'dbAdminTables', 'dbGetEconomySettings', 'dbListProfiles', 'dbSetPlayerIgnored']) {
    assert.ok(!html.includes(gone), `${gone} no longer referenced by servers.html`);
    assert.ok(!dbJs.includes(`function ${gone}`), `${gone} no longer exported by db.js`);
  }
  // import-graph sanity: every name servers.html imports from ./db.js is exported
  const imp = html.match(/import \{([^}]*)\} from '\.\/db\.js'/);
  assert.ok(imp, 'servers.html imports from ./db.js');
  for (const name of imp[1].split(',').map(s => s.trim()).filter(Boolean)) {
    assert.ok(new RegExp(`export (async )?function ${name}\\b`).test(dbJs), `db.js exports ${name}`);
  }
});

test('one poller owns the timers; fleet stats stay live', () => {
  assert.ok(html.includes('function poll('), 'shared poller helper exists');
  assert.ok(html.includes('document.hidden'), 'poller gates on document.hidden');
  assert.ok(html.includes('15000'), 'fleet view polls at 15s');
  assert.ok(html.includes('function waitForRunning'), 'waitForRunning piggybacks the fleet poll');
});

test('the CS live-apply descriptor is honored', () => {
  assert.ok(html.includes('Apply Live'), 'live apply label rendered for mode:live schemas');
  assert.ok(html.includes("apply.mode === 'live'"), 'apply flow branches on the schema descriptor');
});

test('raw-config editor keeps lint + cvar reference + config library, drops the diff view', () => {
  assert.ok(html.includes('rc-lint'), 'lint strip kept');
  assert.ok(html.includes('Cvar Reference'), 'cvar reference panel kept');
  assert.ok(html.includes('data-snip-load'), 'config library load-into-editor kept');
  assert.ok(html.includes("'/configs'") || html.includes('/configs/'), 'config library endpoints kept');
  assert.ok(!html.includes('lineDiff'), 'LCS diff view removed');
});
