import { getRecentGamblingEvents } from './gamble-data.js?v=events-1';

const gameLabels = {
  high_card: 'High Card',
  blackjack: 'Blackjack',
  roulette: 'Roulette',
  slots: 'Slots',
  system: 'System'
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDollars(value) {
  const amount = Math.abs(Math.round(Number(value) || 0)).toLocaleString('en-US');
  return `${Number(value) < 0 ? '-' : '+'}$${amount}`;
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });
}

export async function renderRecentEvents({ listEl, statusEl }) {
  if (!listEl || !statusEl) {
    return;
  }

  statusEl.textContent = 'Loading...';

  try {
    const events = await getRecentGamblingEvents();

    if (!events.length) {
      listEl.innerHTML = '<li class="activity-empty">No wins or losses yet</li>';
      statusEl.textContent = '0 events';
      return;
    }

    listEl.innerHTML = events.map((event) => `
      <li class="activity-row ${event.outcome}">
        <div>
          <strong>${esc(event.username)}</strong>
          <span>${esc(gameLabels[event.game] ?? event.game)} ${esc(event.outcome)}</span>
        </div>
        <div class="activity-money">
          <strong>${formatDollars(event.net_change)}</strong>
          <span>${formatTime(event.created_at)}</span>
        </div>
      </li>
    `).join('');

    statusEl.textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
  } catch (error) {
    listEl.innerHTML = '<li class="activity-empty">Could not load recent results</li>';
    statusEl.textContent = error.message || 'Load failed';
  }
}
