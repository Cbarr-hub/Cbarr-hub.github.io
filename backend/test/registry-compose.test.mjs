import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { listServers } from '../src/servers/registry.js';

// Registry ↔ compose drift guard: every registry entry must have a same-named
// service in servers.compose.yml whose block pins its container_name and
// mentions its public game port. Plain text checks on purpose — no yaml dep,
// non-brittle substring/regex checks per service block.
//
// The compose file lives at the REPO ROOT; the containerized backend-only test
// run mounts just backend/, so skip (rather than fail) when it isn't visible —
// the host/CI `gt … test` run covers it.
let compose = null;
try {
  compose = readFileSync(new URL('../../servers.compose.yml', import.meta.url), 'utf8');
} catch { /* backend-only mount */ }

// Slice one service's block: from its 2-space `  name:` key up to the next line
// indented two spaces or less (the next service, or the top-level volumes:).
const serviceBlock = (name) => {
  const m = compose.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^(?: {2})?\\S)`, 'm'));
  return m ? m[1] : null;
};

test('every registry entry has a matching servers.compose.yml service (name + port)', (t) => {
  if (compose === null) return t.skip('servers.compose.yml not mounted (backend-only container run)');
  for (const s of listServers()) {
    const block = serviceBlock(s.container);
    assert.ok(block, `compose service '${s.container}' missing`);
    assert.match(block, new RegExp(`container_name:\\s*${s.container}\\b`), `${s.container}: container_name out of sync`);
    assert.ok(block.includes(String(s.port)), `${s.container}: registry port ${s.port} not in its compose section`);
  }
});
