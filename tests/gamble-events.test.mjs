import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyNetRecord,
  buildGamblingEvent,
  normalizeGamblingEvent,
  selectRecentEvents
} from '../gamble-events.mjs';

test('normalization derives money outcome from net change', () => {
  assert.equal(normalizeGamblingEvent({ outcome: 'win', net_change: -25 }).outcome, 'loss');
  assert.equal(normalizeGamblingEvent({ outcome: 'loss', net_change: 40 }).outcome, 'win');
  assert.equal(normalizeGamblingEvent({ outcome: 'win', net_change: 0 }).outcome, 'push');
  assert.equal(normalizeGamblingEvent({ event_type: 'bankroll_reset', outcome: 'win', net_change: 5000 }).outcome, 'reset');
});

test('record counters use net bankroll movement', () => {
  const record = { wins: 0, losses: 0, streak: 3 };

  assert.equal(applyNetRecord(record, 1000, 925), 'loss');
  assert.deepEqual(record, { wins: 0, losses: 1, streak: 0 });

  assert.equal(applyNetRecord(record, 925, 1025), 'win');
  assert.deepEqual(record, { wins: 1, losses: 1, streak: 1 });

  assert.equal(applyNetRecord(record, 1025, 1025), 'push');
  assert.deepEqual(record, { wins: 1, losses: 1, streak: 0 });
});

test('recent event selection uses newest timestamps from large fixtures', () => {
  const events = Array.from({ length: 2105 }, (_, index) => ({
    id: index + 1,
    created_at: new Date(Date.UTC(2026, 4, 24, 18, 0, index)).toISOString()
  }));

  const recent = selectRecentEvents(events, 3);

  assert.deepEqual(recent.map((event) => event.id), [2105, 2104, 2103]);
});

test('slot event builder treats partial payouts as net losses', () => {
  const event = buildGamblingEvent({
    username: 'Wiley',
    game: 'slots',
    betAmount: 100,
    payoutAmount: 25,
    balanceBefore: 1000,
    balanceAfter: 925,
    details: {
      play_result: {
        type: 'payout',
        label: '1 line paid $25'
      }
    },
    clientEventId: 'partial-slot'
  });

  assert.equal(event.outcome, 'loss');
  assert.equal(event.net_change, -75);
  assert.equal(event.details.play_result.type, 'payout');
});

test('slot event builder treats profitable payouts as wins', () => {
  const event = buildGamblingEvent({
    username: 'Wiley',
    game: 'slots',
    betAmount: 100,
    payoutAmount: 250,
    balanceBefore: 1000,
    balanceAfter: 1150,
    clientEventId: 'profitable-slot'
  });

  assert.equal(event.outcome, 'win');
  assert.equal(event.net_change, 150);
});

test('slot bonus trigger with a paid base bet is a net loss', () => {
  const event = buildGamblingEvent({
    username: 'Wiley',
    game: 'slots',
    eventType: 'bonus_awarded',
    betAmount: 100,
    payoutAmount: 0,
    balanceBefore: 1000,
    balanceAfter: 900,
    details: {
      play_result: {
        type: 'bonus_trigger',
        label: '3 scatters loaded Crazy Mode'
      }
    },
    clientEventId: 'bonus-slot'
  });

  assert.equal(event.outcome, 'loss');
  assert.equal(event.details.play_result.type, 'bonus_trigger');
});

test('zero-net free spins are pushes', () => {
  const event = buildGamblingEvent({
    username: 'Wiley',
    game: 'slots',
    eventType: 'free_spin_settled',
    betAmount: 0,
    payoutAmount: 0,
    balanceBefore: 1000,
    balanceAfter: 1000,
    clientEventId: 'free-spin-push'
  });

  assert.equal(event.outcome, 'push');
  assert.equal(event.net_change, 0);
});
