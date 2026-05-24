import { DEFAULT_BALANCE, getGamblingDashboardData } from './gamble-data.js?v=stats-1';

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
  return `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`;
}

function formatSignedDollars(value) {
  const amount = Math.abs(Math.round(Number(value) || 0)).toLocaleString('en-US');
  return `${Number(value) < 0 ? '-' : '+'}$${amount}`;
}

function percent(value, total) {
  return total ? Math.round((value / total) * 100) : 0;
}

function playerName(row) {
  return row?.username ?? 'None yet';
}

function buildPlayerStats(users, balances, events) {
  const balancesByName = new Map((balances ?? []).map((row) => [row.Name, Number(row.Dollers ?? DEFAULT_BALANCE)]));
  const statsByName = new Map();

  for (const user of users ?? []) {
    if (!user.Username) {
      continue;
    }

    statsByName.set(user.Username, {
      username: user.Username,
      balance: balancesByName.get(user.Username) ?? DEFAULT_BALANCE,
      wins: 0,
      losses: 0,
      net: 0,
      wagered: 0,
      biggestWin: 0,
      biggestLoss: 0,
      currentWinStreak: 0,
      bestWinStreak: 0
    });
  }

  for (const event of events ?? []) {
    const stats = statsByName.get(event.username);
    if (!stats) {
      continue;
    }

    if (event.outcome === 'win' || event.outcome === 'loss') {
      stats.wagered += Number(event.bet_amount ?? 0);
      stats.net += Number(event.net_change ?? 0);
    }

    if (event.outcome === 'win') {
      stats.wins += 1;
      stats.biggestWin = Math.max(stats.biggestWin, Number(event.payout_amount ?? 0), Number(event.net_change ?? 0));
      stats.currentWinStreak += 1;
      stats.bestWinStreak = Math.max(stats.bestWinStreak, stats.currentWinStreak);
    } else if (event.outcome === 'loss') {
      stats.losses += 1;
      stats.biggestLoss = Math.min(stats.biggestLoss, Number(event.net_change ?? 0));
      stats.currentWinStreak = 0;
    }
  }

  return Array.from(statsByName.values());
}

function renderKpis(kpiEl, stats, events) {
  const playableEvents = events.filter((event) => event.outcome === 'win' || event.outcome === 'loss');
  const wins = playableEvents.filter((event) => event.outcome === 'win').length;
  const losses = playableEvents.filter((event) => event.outcome === 'loss').length;
  const totalNet = playableEvents.reduce((sum, event) => sum + Number(event.net_change ?? 0), 0);
  const totalWagered = playableEvents.reduce((sum, event) => sum + Number(event.bet_amount ?? 0), 0);
  const resetCount = events.filter((event) => event.event_type === 'bankroll_reset').length;
  const biggestWinEvent = playableEvents.reduce((best, event) => Number(event.net_change ?? 0) > Number(best?.net_change ?? -Infinity) ? event : best, null);
  const best = stats.reduce((top, row) => row.net > (top?.net ?? -Infinity) ? row : top, null);
  const worst = stats.reduce((bottom, row) => row.net < (bottom?.net ?? Infinity) ? row : bottom, null);
  const streak = stats.reduce((top, row) => row.bestWinStreak > (top?.bestWinStreak ?? -1) ? row : top, null);

  kpiEl.innerHTML = `
    <div class="viz-card">
      <span>Best gambler</span>
      <strong>${esc(playerName(best))}</strong>
      <em>${formatSignedDollars(best?.net ?? 0)} net</em>
    </div>
    <div class="viz-card danger">
      <span>Worst gambler</span>
      <strong>${esc(playerName(worst))}</strong>
      <em>${formatSignedDollars(worst?.net ?? 0)} net</em>
    </div>
    <div class="viz-card">
      <span>Max win</span>
      <strong>${formatDollars(biggestWinEvent?.net_change ?? 0)}</strong>
      <em>${esc(biggestWinEvent?.username ?? 'No wins yet')}</em>
    </div>
    <div class="viz-card">
      <span>Best win streak</span>
      <strong>${streak?.bestWinStreak ?? 0}</strong>
      <em>${esc(playerName(streak))}</em>
    </div>
    <div class="viz-card">
      <span>Table win rate</span>
      <strong>${percent(wins, wins + losses)}%</strong>
      <em>${wins}-${losses}</em>
    </div>
    <div class="viz-card">
      <span>Total wagered</span>
      <strong>${formatDollars(totalWagered)}</strong>
      <em>${formatSignedDollars(totalNet)} net, ${resetCount} resets</em>
    </div>
  `;
}

function renderNetBars(chartEl, stats) {
  const ranked = [...stats]
    .sort((a, b) => b.net - a.net)
    .slice(0, 8);
  const max = Math.max(1, ...ranked.map((row) => Math.abs(row.net)));

  chartEl.innerHTML = ranked.map((row) => `
    <div class="viz-bar-row">
      <span>${esc(row.username)}</span>
      <div class="viz-bar-track">
        <i class="viz-bar ${row.net < 0 ? 'loss' : 'win'}" style="width: ${Math.max(4, percent(Math.abs(row.net), max))}%"></i>
      </div>
      <strong>${formatSignedDollars(row.net)}</strong>
    </div>
  `).join('');
}

function renderStreakBars(chartEl, stats) {
  const ranked = [...stats]
    .sort((a, b) => b.bestWinStreak - a.bestWinStreak || b.currentWinStreak - a.currentWinStreak)
    .slice(0, 8);
  const max = Math.max(1, ...ranked.map((row) => row.bestWinStreak));

  chartEl.innerHTML = ranked.map((row) => `
    <div class="viz-bar-row">
      <span>${esc(row.username)}</span>
      <div class="viz-bar-track">
        <i class="viz-bar streak" style="width: ${Math.max(4, percent(row.bestWinStreak, max))}%"></i>
      </div>
      <strong>${row.bestWinStreak}</strong>
    </div>
  `).join('');
}

function renderGameMix(chartEl, events) {
  const playableEvents = events.filter((event) => event.outcome === 'win' || event.outcome === 'loss');
  const counts = new Map();

  for (const event of playableEvents) {
    counts.set(event.game, (counts.get(event.game) ?? 0) + 1);
  }

  const rows = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(([, count]) => count));

  chartEl.innerHTML = rows.length ? rows.map(([game, count]) => `
    <div class="viz-bar-row">
      <span>${esc(gameLabels[game] ?? game)}</span>
      <div class="viz-bar-track">
        <i class="viz-bar game" style="width: ${Math.max(4, percent(count, max))}%"></i>
      </div>
      <strong>${count}</strong>
    </div>
  `).join('') : '<div class="viz-empty">No game events yet</div>';
}

export async function renderGamblingDashboard({ statusEl, kpiEl, netChartEl, streakChartEl, gameChartEl }) {
  if (!statusEl || !kpiEl || !netChartEl || !streakChartEl || !gameChartEl) {
    return;
  }

  statusEl.textContent = 'Loading...';

  try {
    const { users, balances, events } = await getGamblingDashboardData();
    const stats = buildPlayerStats(users, balances, events);

    renderKpis(kpiEl, stats, events);
    renderNetBars(netChartEl, stats);
    renderStreakBars(streakChartEl, stats);
    renderGameMix(gameChartEl, events);

    statusEl.textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
  } catch (error) {
    kpiEl.innerHTML = '<div class="viz-empty">Could not load dashboard</div>';
    netChartEl.innerHTML = '';
    streakChartEl.innerHTML = '';
    gameChartEl.innerHTML = '';
    statusEl.textContent = error.message || 'Load failed';
  }
}
