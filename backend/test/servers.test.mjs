import assert from 'node:assert/strict';
import test from 'node:test';

import { getServer, listServers } from '../src/servers/registry.js';
import { normalizeStatus } from '../src/servers/connectors/base.js';
import { createServerService, ServerControlError } from '../src/servers/service.js';

// A fake ProxmoxClient: records calls, returns canned data. No network.
function fakeClient(overrides = {}) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(); };
  return {
    calls,
    statusCurrent: overrides.statusCurrent ?? ((vmid) => {
      calls.push(['statusCurrent', vmid]);
      return Promise.resolve({ status: 'running', uptime: 3600 });
    }),
    start: rec('start'),
    stop: rec('stop'),
    shutdown: rec('shutdown'),
    reboot: rec('reboot'),
    agentExec: overrides.agentExec ?? (() => Promise.resolve({ pid: 1 })),
    agentExecStatus: overrides.agentExecStatus
      ?? (() => Promise.resolve({ exited: 1, exitcode: 0, 'out-data': 'ok' })),
    agentFileRead: overrides.agentFileRead
      ?? (() => Promise.resolve({ content: 'hello=world\n', truncated: false })),
    agentFileWrite: overrides.agentFileWrite ?? rec('agentFileWrite'),
  };
}

// ── registry ──────────────────────────────────────────────────────────────────
test('registry maps ids to the documented VMIDs', () => {
  assert.equal(getServer('counterstrike').vmid, 100);
  assert.equal(getServer('factorio').vmid, 101);
  assert.equal(getServer('minecraft').vmid, 102);
  assert.equal(getServer('nope'), undefined);
  assert.equal(listServers().length, 3);
});

// ── status normalization ────────────────────────────────────────────────────────
test('normalizeStatus maps proxmox payloads to a stable shape', () => {
  assert.equal(normalizeStatus({ status: 'running', uptime: 10 }).status, 'running');
  assert.equal(normalizeStatus({ status: 'stopped' }).status, 'stopped');
  assert.equal(normalizeStatus({ status: 'paused' }).status, 'unknown');
  assert.equal(normalizeStatus(null).status, 'unknown');
});

// ── service: not configured ──────────────────────────────────────────────────────
test('service without a client reports not-configured', async () => {
  const svc = createServerService({ client: null });
  assert.equal(svc.isConfigured(), false);
  await assert.rejects(() => svc.listServers(), (e) =>
    e instanceof ServerControlError && e.code === 'NOT_CONFIGURED');
  await assert.rejects(() => svc.doAction('factorio', 'start'), (e) =>
    e.code === 'NOT_CONFIGURED');
});

// ── service: list + status ──────────────────────────────────────────────────────
test('listServers returns every server with normalized status', async () => {
  const svc = createServerService({ client: fakeClient() });
  const list = await svc.listServers();
  assert.equal(list.length, 3);
  assert.ok(list.every((s) => s.status === 'running'));
  assert.equal(list.find((s) => s.id === 'factorio').vmid, 101);
});

test('listServers captures per-server errors without failing the whole list', async () => {
  const client = fakeClient({
    statusCurrent: (vmid) => vmid === 101
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({ status: 'stopped' }),
  });
  const svc = createServerService({ client });
  const list = await svc.listServers();
  const f = list.find((s) => s.id === 'factorio');
  assert.equal(f.status, 'unknown');
  assert.match(f.error, /boom/);
});

// ── service: power actions ──────────────────────────────────────────────────────
test('doAction dispatches to the right client method using the registry vmid', async () => {
  const client = fakeClient();
  const svc = createServerService({ client });
  await svc.doAction('minecraft', 'shutdown');
  assert.deepEqual(client.calls.at(-1), ['shutdown', 102]);
});

test('doAction rejects unknown actions and unknown servers', async () => {
  const svc = createServerService({ client: fakeClient() });
  await assert.rejects(() => svc.doAction('factorio', 'selfdestruct'), (e) =>
    e.code === 'BAD_ACTION');
  await assert.rejects(() => svc.doAction('halflife', 'start'), (e) =>
    e.code === 'UNKNOWN_SERVER');
});

// ── service: config (whitelist) ──────────────────────────────────────────────────
test('config read/write only allows whitelisted files', async () => {
  const client = fakeClient();
  const svc = createServerService({ client });

  const { files } = svc.listConfig('minecraft');
  assert.ok(files.includes('server.properties'));

  const read = await svc.readConfig('minecraft', 'server.properties');
  assert.equal(read.content, 'hello=world\n');

  await assert.rejects(() => svc.readConfig('minecraft', '/etc/shadow'), (e) =>
    e.code === 'UNKNOWN_CONFIG');
});

// ── service: update recipe ──────────────────────────────────────────────────────
test('runUpdate runs the connector recipe and returns step output', async () => {
  const client = fakeClient();
  const svc = createServerService({ client });
  const res = await svc.runUpdate('factorio');
  assert.ok(Array.isArray(res.steps));
  assert.equal(res.steps[0].exitCode, 0);
});
