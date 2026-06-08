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
