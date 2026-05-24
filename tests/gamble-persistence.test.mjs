import assert from 'node:assert/strict';
import test from 'node:test';
import { createGamblingPersistence } from '../gamble-persistence.mjs';

test('persistence queue saves quick settlements in order and refreshes once for latest write', async () => {
  const writes = [];
  const refreshes = [];
  const queue = createGamblingPersistence({
    getUsername: () => 'Wiley',
    persistBalance: async (username, credits) => {
      writes.push(`balance:${username}:${credits}`);
    },
    insertEvent: async (event) => {
      writes.push(`event:${event.client_event_id}:${event.balance_after}`);
    },
    refreshStats: async () => {
      refreshes.push('refresh');
    },
    delayMs: 0,
    onError: (label, message) => {
      throw new Error(`${label} ${message}`);
    }
  });

  const first = queue.saveBalanceAndEvent({
    username: 'Wiley',
    client_event_id: 'first',
    balance_after: 110
  });
  const second = queue.saveBalanceAndEvent({
    username: 'Wiley',
    client_event_id: 'second',
    balance_after: 95
  });

  await Promise.all([first, second]);

  assert.deepEqual(writes, [
    'balance:Wiley:110',
    'event:first:110',
    'balance:Wiley:95',
    'event:second:95'
  ]);
  assert.deepEqual(refreshes, ['refresh']);
});

test('superseded debounced balance saves resolve without writing stale balance', async () => {
  const writes = [];
  let timerCallback = null;
  const queue = createGamblingPersistence({
    getUsername: () => 'Wiley',
    persistBalance: async (username, credits) => {
      writes.push(`balance:${username}:${credits}`);
    },
    insertEvent: async (event) => {
      writes.push(`event:${event.client_event_id}:${event.balance_after}`);
    },
    refreshStats: async () => {},
    setTimeoutFn: (callback) => {
      timerCallback = callback;
      return 1;
    },
    clearTimeoutFn: () => {
      timerCallback = null;
    },
    onError: (label, message) => {
      throw new Error(`${label} ${message}`);
    }
  });

  const staleBalance = queue.saveBalance(120);
  const settlement = queue.saveBalanceAndEvent({
    username: 'Wiley',
    client_event_id: 'settlement',
    balance_after: 80
  });

  await Promise.all([staleBalance, settlement]);

  assert.equal(timerCallback, null);
  assert.deepEqual(writes, [
    'balance:Wiley:80',
    'event:settlement:80'
  ]);
});
