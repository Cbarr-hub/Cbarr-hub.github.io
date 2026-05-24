export const BIG_EVENT_AMOUNT = 1000;

export const gameLabels = {
  high_card: 'High Card',
  blackjack: 'Blackjack',
  roulette: 'Roulette',
  slots: 'Slots',
  system: 'System'
};

export function numberValue(value) {
  return Number(value ?? 0);
}

export function isResetEvent(event) {
  return event.event_type === 'bankroll_reset' || event.outcome === 'reset';
}

export function moneyOutcome(event) {
  if (isResetEvent(event)) {
    return 'reset';
  }

  const net = numberValue(event.net_change);
  if (net > 0) {
    return 'win';
  }
  if (net < 0) {
    return 'loss';
  }
  return event.outcome;
}

export function isMoneyEvent(event) {
  if (isResetEvent(event)) {
    return false;
  }

  return moneyOutcome(event) === 'win' || moneyOutcome(event) === 'loss';
}

export function isBigEvent(event) {
  const normalizedOutcome = moneyOutcome(event);
  return isResetEvent(event) ||
    (normalizedOutcome === 'win' && numberValue(event.payout_amount) >= BIG_EVENT_AMOUNT) ||
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
  normalized.isMoneyEvent = isMoneyEvent(normalized);
  normalized.isBig = event.isBig ?? isBigEvent(normalized);
  return normalized;
}
