import { getLeaderboardRows } from './gamble-data.js?v=stats-1';

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

function formatSignedDollars(value) {
  const amount = Math.abs(Math.round(Number(value) || 0)).toLocaleString('en-US');
  return `${Number(value) < 0 ? '-' : '+'}$${amount}`;
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
      const games = row.wins + row.losses;
      const winRate = games ? Math.round((row.wins / games) * 100) : 0;
      return `
        <li class="leaderboard-row${isCurrent ? ' current' : ''}">
          <span class="leaderboard-rank">${index + 1}</span>
          <span class="leaderboard-name">${esc(row.username)}</span>
          <span class="leaderboard-record">${row.wins}-${row.losses}</span>
          <span class="leaderboard-rate">${winRate}%</span>
          <strong class="leaderboard-net ${row.net < 0 ? 'loss' : 'win'}">${formatSignedDollars(row.net)}</strong>
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
