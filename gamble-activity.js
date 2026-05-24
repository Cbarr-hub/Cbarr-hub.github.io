import { getRecentGamblingEvents } from './gamble-data.js?v=money-events-1';
import { gameLabels, normalizeGamblingEvent } from './gamble-stats-utils.js?v=money-events-1';

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

function filterEvents(events, filter) {
  const normalized = events.map(normalizeGamblingEvent);

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

  return normalized.filter((event) => event.isMoneyEvent || event.isReset);
}

function eventTitle(event) {
  if (event.isReset) {
    return 'Bankroll reset';
  }
  if (event.event_type === 'bonus_awarded') {
    return 'Crazy Mode awarded';
  }
  if (event.event_type === 'free_spin_settled') {
    return `Crazy Mode ${event.moneyOutcome}`;
  }
  return `${gameLabels[event.game] ?? event.game} ${event.moneyOutcome}`;
}

function eventMeta(event) {
  if (event.isReset) {
    return `${formatSignedDollars(event.net_change)} reset swing`;
  }
  if (event.event_type === 'bonus_awarded') {
    return `Bet ${formatDollars(event.bet_amount)} / free spins loaded`;
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
