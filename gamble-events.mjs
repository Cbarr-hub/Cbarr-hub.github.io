import { numberValue } from './gamble-utils.mjs';

export const BIG_EVENT_AMOUNT = 1000;

export const gameLabels = {
  high_card: 'High Card',
  blackjack: 'Blackjack',
  roulette: 'Roulette',
  slots: 'Slots',
  system: 'System'
};

export function createClientEventId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (globalThis.crypto?.getRandomValues) {
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (char) =>
      (Number(char) ^ globalThis.crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(char) / 4).toString(16)
    );
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isResetEvent(event) {
  return event.event_type === 'bankroll_reset' || event.outcome === 'reset';
}

export function deriveNetOutcome({ event_type: eventType, outcome, net_change: netChange }) {
  if (eventType === 'bankroll_reset' || outcome === 'reset') {
    return 'reset';
  }

  const net = numberValue(netChange);
  if (net > 0) {
    return 'win';
  }
  if (net < 0) {
    return 'loss';
  }
  return 'push';
}

export function moneyOutcome(event) {
  return deriveNetOutcome(event);
}

export function isMoneyEvent(event) {
  const outcome = moneyOutcome(event);
  return outcome === 'win' || outcome === 'loss';
}

export function isBigEvent(event) {
  const normalizedOutcome = moneyOutcome(event);
  return isResetEvent(event) ||
    (normalizedOutcome === 'win' && numberValue(event.net_change) >= BIG_EVENT_AMOUNT) ||
    (normalizedOutcome === 'loss' && Math.abs(numberValue(event.net_change)) >= BIG_EVENT_AMOUNT);
}

export function normalizeGamblingEvent(event) {
  const normalized = {
    ...event,
    bet_amount: numberValue(event.bet_amount),
    payout_amount: numberValue(event.payout_amount),
    net_change: numberValue(event.net_change),
    balance_before: numberValue(event.balance_before),
    balance_after: numberValue(event.balance_after),
    gameLabel: gameLabels[event.game] ?? event.game,
    isReset: isResetEvent(event)
  };

  normalized.moneyOutcome = moneyOutcome(normalized);
  normalized.outcome = normalized.moneyOutcome;
  normalized.isMoneyEvent = isMoneyEvent(normalized);
  normalized.isBig = event.isBig ?? isBigEvent(normalized);
  return normalized;
}

export function buildGamblingEvent({
  username,
  game,
  eventType = 'wager_settled',
  betAmount = 0,
  payoutAmount = 0,
  balanceBefore = 0,
  balanceAfter = balanceBefore,
  details = {},
  clientEventId = createClientEventId()
}) {
  const roundedBefore = Math.round(numberValue(balanceBefore));
  const roundedAfter = Math.round(numberValue(balanceAfter));
  const netChange = roundedAfter - roundedBefore;
  const event = {
    username,
    game,
    event_type: eventType,
    bet_amount: Math.max(0, Math.round(numberValue(betAmount))),
    payout_amount: Math.max(0, Math.round(numberValue(payoutAmount))),
    net_change: netChange,
    balance_before: Math.max(0, roundedBefore),
    balance_after: Math.max(0, roundedAfter),
    client_event_id: clientEventId,
    details
  };

  return {
    ...event,
    outcome: deriveNetOutcome(event)
  };
}

export function applyNetRecord(record, balanceBefore, balanceAfter) {
  const outcome = deriveNetOutcome({
    net_change: Math.round(numberValue(balanceAfter) - numberValue(balanceBefore))
  });

  if (outcome === 'win') {
    record.streak += 1;
    record.wins += 1;
  } else if (outcome === 'loss') {
    record.streak = 0;
    record.losses += 1;
  } else {
    record.streak = 0;
  }

  return outcome;
}

export function sortRecentEvents(events) {
  return [...(events ?? [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export function selectRecentEvents(events, limit = 14) {
  return sortRecentEvents(events).slice(0, limit);
}
