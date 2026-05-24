import { getLeaderboardRows } from './gamble-data.js?v=money-events-2';
import { esc, formatSignedDollars, formatWholeDollars, numberValue } from './gamble-utils.mjs?v=money-events-2';

function formatDollars(value) {
  return formatWholeDollars(value);
}

function normalizeRows(rows) {
  return rows.map((row) => {
    const wins = numberValue(row.wins);
    const losses = numberValue(row.losses);
    const games = numberValue(row.games) || wins + losses;
    return {
      username: row.username,
      balance: numberValue(row.balance),
      wins,
      losses,
      winRate: games ? Math.round((wins / games) * 100) : 0,
      net: numberValue(row.net),
      biggestWin: numberValue(row.biggestWin),
      bestWinStreak: numberValue(row.bestWinStreak)
    };
  });
}

export async function renderLeaderboard({ listEl, statusEl, currentUsername, rows = null }) {
  if (!listEl || !statusEl) {
    return;
  }

  statusEl.textContent = 'Loading...';

  try {
    const sourceRows = rows ?? await getLeaderboardRows();
    const rankedRows = normalizeRows(sourceRows)
      .sort((a, b) => b.balance - a.balance || b.net - a.net || a.username.localeCompare(b.username));

    if (!rankedRows.length) {
      listEl.innerHTML = '<li class="leaderboard-empty">No users yet</li>';
      statusEl.textContent = '0 players';
      return;
    }

    listEl.innerHTML = rankedRows.map((row, index) => {
      const isCurrent = row.username === currentUsername;
      return `
        <li class="leaderboard-row${isCurrent ? ' current' : ''}">
          <span class="leaderboard-rank">${index + 1}</span>
          <span class="leaderboard-name" title="${esc(row.username)}">
            <strong>${esc(row.username)}</strong>
            <em>${row.wins}-${row.losses} record / ${row.winRate}% win rate</em>
          </span>
          <span class="leaderboard-bankroll">
            <strong>${formatDollars(row.balance)}</strong>
            <em>bankroll</em>
          </span>
          <span class="leaderboard-net ${row.net < 0 ? 'loss' : 'win'}">
            <strong>${formatSignedDollars(row.net)}</strong>
            <em>net</em>
          </span>
          <span class="leaderboard-detail">Max win ${formatDollars(row.biggestWin)} / streak ${row.bestWinStreak}</span>
        </li>
      `;
    }).join('');

    statusEl.textContent = `${rankedRows.length} player${rankedRows.length === 1 ? '' : 's'}`;
  } catch (error) {
    listEl.innerHTML = '<li class="leaderboard-empty">Could not load leaderboard</li>';
    statusEl.textContent = error.message || 'Load failed';
  }
}
