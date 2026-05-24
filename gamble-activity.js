import { getRecentGamblingEvents } from './gamble-data.js?v=dashboard-clean-1';

const gameLabels = {
  high_card: 'High Card',
  blackjack: 'Blackjack',
  roulette: 'Roulette',
  slots: 'Slots',
  system: 'System'
};

const filterLabels = {
  all: 'All',
  wins: 'Wins',
  losses: 'Losses',
  resets: 'Resets',
  big: 'Big Events'
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function numberValue(value) {
  return Number(value ?? 0);
}

function formatSignedDollars(value) {
  const amount = Math.abs(Math.round(numberValue(value))).toLocaleString('en-US');
  return `${numberValue(value) < 0 ? '-' : '+'}$${amount}`;
}

function formatDollars(value) {
  return `$${Math.round(numberValue(value)).toLocaleString('en-US')}`;
}

function formatTime(value) {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function isResetEvent(event) {
  return event.event_type === 'bankroll_reset' || event.outcome === 'reset';
}

function moneyOutcome(event) {
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

function isBigEvent(event) {
  return isResetEvent(event) ||
    (event.outcome === 'win' && numberValue(event.payout_amount) >= 1000) ||
    (event.outcome === 'loss' && Math.abs(numberValue(event.net_change)) >= 1000);
}

function normalizeEvent(event) {
  return {
    ...event,
    bet_amount: numberValue(event.bet_amount),
    payout_amount: numberValue(event.payout_amount),
    net_change: numberValue(event.net_change),
    moneyOutcome: moneyOutcome(event),
    isBig: event.isBig ?? isBigEvent(event),
    isReset: event.isReset ?? isResetEvent(event)
  };
}

function filterEvents(events, filter) {
  const normalized = events.map(normalizeEvent);

  if (filter === 'wins') {
    return normalized.filter((event) => event.moneyOutcome === 'win');
  }
  if (filter === 'losses') {
    return normalized.filter((event) => event.moneyOutcome === 'loss');
  }
  if (filter === 'resets') {
    return normalized.filter((event) => event.isReset);
  }
  if (filter === 'big') {
    return normalized.filter((event) => event.isBig);
  }

  return normalized.filter((event) => event.moneyOutcome === 'win' || event.moneyOutcome === 'loss' || event.isReset);
}

function eventTitle(event) {
  if (event.isReset) {
    return 'Bankroll reset';
  }
  return `${gameLabels[event.game] ?? event.game} ${event.moneyOutcome}`;
}

function eventMeta(event) {
  if (event.isReset) {
    return `${formatSignedDollars(event.net_change)} reset swing`;
  }
  return `Bet ${formatDollars(event.bet_amount)} / payout ${formatDollars(event.payout_amount)}`;
}

function eventClass(event) {
  if (event.isReset) {
    return 'reset';
  }
  return event.moneyOutcome === 'win' ? 'win' : 'loss';
}

export async function renderRecentEvents({ listEl, statusEl, events = null, filter = 'all', limit = 14 }) {
  if (!listEl || !statusEl) {
    return;
  }

  statusEl.textContent = 'Loading...';

  try {
    const sourceEvents = events ?? await getRecentGamblingEvents(80);
    const filtered = filterEvents(sourceEvents, filter)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);

    if (!filtered.length) {
      listEl.innerHTML = `<li class="activity-empty">No ${esc(filterLabels[filter] ?? filter)} events yet</li>`;
      statusEl.textContent = '0 events';
      return;
    }

    listEl.innerHTML = filtered.map((event) => `
      <li class="activity-row ${eventClass(event)}${event.isBig ? ' big' : ''}">
        <div class="activity-main">
          <strong>${esc(event.username)}</strong>
          <span>${esc(eventTitle(event))}</span>
          <em>${esc(eventMeta(event))}</em>
        </div>
        <div class="activity-money">
          <strong>${formatSignedDollars(event.net_change)}</strong>
          <span>${formatTime(event.created_at)}</span>
        </div>
      </li>
    `).join('');

    statusEl.textContent = `${filtered.length} ${esc(filterLabels[filter] ?? filter).toLowerCase()}`;
  } catch (error) {
    listEl.innerHTML = '<li class="activity-empty">Could not load recent results</li>';
    statusEl.textContent = error.message || 'Load failed';
  }
}
