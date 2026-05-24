import { getLeaderboardRows } from './gamble-data.js?v=events-1';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDollars(value) {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

export async function renderLeaderboard({ listEl, statusEl, currentUsername }) {
  if (!listEl || !statusEl) {
    return;
  }

  statusEl.textContent = 'Loading...';

  try {
    const rows = await getLeaderboardRows();

    if (!rows.length) {
      listEl.innerHTML = '<li class="leaderboard-empty">No users yet</li>';
      statusEl.textContent = '0 players';
      return;
    }

    listEl.innerHTML = rows.map((row, index) => {
      const isCurrent = row.username === currentUsername;
      return `
        <li class="leaderboard-row${isCurrent ? ' current' : ''}">
          <span class="leaderboard-rank">${index + 1}</span>
          <span class="leaderboard-name">${esc(row.username)}</span>
          <strong class="leaderboard-balance">${formatDollars(row.balance)}</strong>
        </li>
      `;
    }).join('');

    statusEl.textContent = `${rows.length} player${rows.length === 1 ? '' : 's'}`;
  } catch (error) {
    listEl.innerHTML = '<li class="leaderboard-empty">Could not load leaderboard</li>';
    statusEl.textContent = error.message || 'Load failed';
  }
}
