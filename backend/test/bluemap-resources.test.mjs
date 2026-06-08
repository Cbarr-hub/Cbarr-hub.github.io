import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blueMapResourceOptions,
  createBlueMapResourceController,
  targetBlueMapCpus,
} from '../src/servers/bluemap-resources.js';

test('targetBlueMapCpus gives idle most cores while reserving host capacity', () => {
  assert.equal(targetBlueMapCpus({ onlineCount: 0, hostCpus: 32, reservedCpus: 4 }), 28);
  assert.equal(targetBlueMapCpus({ onlineCount: 1, hostCpus: 32, activeCpus: 2 }), 2);
  assert.equal(targetBlueMapCpus({ onlineCount: 0, hostCpus: 4, reservedCpus: 4 }), 1);
  assert.equal(targetBlueMapCpus({ onlineCount: 0, hostCpus: 8, idleCpus: 6 }), 6);
});

test('blueMapResourceOptions reads env toggles and defaults', () => {
  const opts = blueMapResourceOptions({
    BLUEMAP_RESOURCE_AUTOTUNE: 'false',
    BLUEMAP_CONTAINER: 'map',
    BLUEMAP_RESOURCE_POLL_SECONDS: '15',
    BLUEMAP_ACTIVE_CPUS: '3',
  });
  assert.equal(opts.enabled, false);
  assert.equal(opts.container, 'map');
  assert.equal(opts.pollMs, 15_000);
  assert.equal(opts.activeCpus, 3);
  assert.equal(opts.idleCpus, 0);
});

test('BlueMap resource controller applies idle and active cpu caps', async () => {
  const calls = [];
  let online = [];
  const dockerClient = {
    nodeStatus: async () => ({ ncpu: 32 }),
    setNanoCpus: async (container, nanoCpus) => { calls.push([container, nanoCpus]); return { ok: true }; },
  };
  const serverService = { listOnline: async () => online };
  const logger = { info() {}, error() {} };
  const ctl = createBlueMapResourceController({
    dockerClient,
    serverService,
    logger,
    env: { BLUEMAP_IDLE_DELAY_SECONDS: '0' },
  });

  assert.deepEqual(await ctl.tick(), {
    container: 'bluemap', mode: 'idle', onlineCount: 0, cpus: 28, hostCpus: 32,
  });
  online = [{ name: 'Alice' }];
  assert.deepEqual(await ctl.tick(), {
    container: 'bluemap', mode: 'active', onlineCount: 1, cpus: 2, hostCpus: 32,
  });
  assert.deepEqual(calls, [
    ['bluemap', 28_000_000_000],
    ['bluemap', 2_000_000_000],
  ]);
});

test('BlueMap resource controller waits before ramping back up after players leave', async () => {
  let t = 1_000;
  let online = [{ name: 'Alice' }];
  const calls = [];
  const ctl = createBlueMapResourceController({
    dockerClient: {
      nodeStatus: async () => ({ ncpu: 16 }),
      setNanoCpus: async (_container, nanoCpus) => { calls.push(nanoCpus); },
    },
    serverService: { listOnline: async () => online },
    logger: { info() {}, error() {} },
    env: { BLUEMAP_IDLE_DELAY_SECONDS: '300' },
    now: () => t,
  });

  assert.equal((await ctl.tick()).mode, 'active');
  online = [];
  assert.equal((await ctl.tick()).mode, 'active');
  t += 301_000;
  assert.equal((await ctl.tick()).mode, 'idle');
  assert.deepEqual(calls, [2_000_000_000, 12_000_000_000]);
});
