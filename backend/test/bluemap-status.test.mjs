import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBlueMapStatus } from '../src/servers/bluemap-status.js';

test('parseBlueMapStatus reports latest render percent and ETA', () => {
  const status = parseBlueMapStatus(`
[21:58:58 INFO] updating map 'nether': 44.996% (ETA: 47 minutes)
[21:59:08 INFO] updating map 'nether': 45.11% (ETA: 49 minutes)
`);
  assert.equal(status.state, 'rendering');
  assert.equal(status.map, 'nether');
  assert.equal(status.percent, 45.1);
  assert.equal(status.eta, '49 minutes');
  assert.equal(status.message, 'Nether rendering 45.1% - ETA 49 minutes');
});

test('parseBlueMapStatus reports complete after up-to-date or waiting messages', () => {
  const status = parseBlueMapStatus(`
[18:42:56 INFO] updating map 'overworld': 99.9% (ETA: 1 seconds)
[18:42:56 INFO] Your maps are now all up-to-date!
[18:43:06 INFO] Waiting for changes on the world-files...
`);
  assert.equal(status.state, 'complete');
  assert.equal(status.percent, 100);
  assert.equal(status.message, 'Render complete');
});

test('parseBlueMapStatus reports startup before progress exists', () => {
  const status = parseBlueMapStatus(`
[21:53:47 INFO] Loading resources...
[21:53:48 INFO] Start updating 3 maps ...
`);
  assert.equal(status.state, 'starting');
  assert.equal(status.percent, null);
});
