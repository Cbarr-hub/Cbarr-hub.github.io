import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// servers.html lives at the repo root, one level up from tests/.
const htmlPath = fileURLToPath(new URL('../servers.html', import.meta.url));
const html = readFileSync(htmlPath, 'utf8');

test('no orphaned Events globals remain', () => {
  for (const id of ['eventsFilter', 'eventsTimer', 'eventsLoadSeq']) {
    assert.ok(!html.includes(id), `servers.html should not reference orphan global "${id}"`);
  }
});

test('no orphaned Events element ids are queried', () => {
  for (const id of ['evFilter', 'evRefresh', 'evlist']) {
    assert.ok(
      !html.includes(`getElementById('${id}')`),
      `servers.html should not query nonexistent element id "${id}"`
    );
  }
});

test('orphaned Events functions are deleted', () => {
  for (const name of ['startEvents', 'loadEvents', 'renderEvFilter']) {
    assert.ok(
      !html.includes(`function ${name}`),
      `servers.html should not define orphan function "${name}"`
    );
  }
});

test('live Activity view is preserved', () => {
  assert.ok(html.includes("getElementById('actlist')"), 'Activity list lookup should remain');
  assert.ok(html.includes('function startActivity'), 'startActivity should remain');
});

test('Pulse analytics view is wired in', () => {
  assert.ok(html.includes('data-view="stats"'), 'Pulse nav button');
  assert.ok(html.includes('id="view-stats"'), 'Pulse view container');
  assert.ok(html.includes('function startStats'), 'startStats');
  assert.ok(html.includes('function loadStats'), 'loadStats');
  assert.ok(html.includes('dbGetServerStats'), 'stats fetch helper used');
});

test('Pulse per-game list has no monogram code chips', () => {
  assert.ok(!html.includes('g-code'), 'per-game rows should not render monogram code chips');
});

test('link queue has reversible dismiss/restore; economy shows earnings instead of inline linking', () => {
  assert.ok(html.includes('act-dismiss'), 'dismiss button class');
  assert.ok(html.includes('act-restore'), 'restore button class (dismiss is reversible)');
  assert.ok(html.includes('dbSetPlayerIgnored'), 'calls dbSetPlayerIgnored');
  assert.ok(html.includes('Player earnings'), 'economy roster relabeled to earnings');
  assert.ok(html.includes('eco-earned'), 'economy roster shows a $ earned cell');
});

test('kleptocrat accounts render as gold crown tiles', () => {
  assert.ok(html.includes('klepto'), 'klepto modifier class');
  assert.ok(html.includes('♛'), 'crown glyph');
});
