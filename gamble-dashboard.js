import { DEFAULT_BALANCE, getGamblingDashboardData } from './gamble-data.js?v=dashboard-clean-1';

const BIG_EVENT_AMOUNT = 1000;

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

function numberValue(value) {
  return Number(value ?? 0);
}

function formatDollars(value) {
  return `$${Math.round(numberValue(value)).toLocaleString('en-US')}`;
}

function formatSignedDollars(value) {
  const amount = Math.abs(Math.round(numberValue(value))).toLocaleString('en-US');
  return `${numberValue(value) < 0 ? '-' : '+'}$${amount}`;
}

function percent(value, total) {
  return total ? Math.round((value / total) * 100) : 0;
}

function compactDollars(value) {
  return Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(Math.round(numberValue(value)));
}

function playerName(row) {
  return row?.username ?? 'None yet';
}

function isPlayableEvent(event) {
  return event.outcome === 'win' || event.outcome === 'loss';
}

function isResetEvent(event) {
  return event.event_type === 'bankroll_reset' || event.outcome === 'reset';
}

function isBigEvent(event) {
  return isResetEvent(event) ||
    (event.outcome === 'win' && numberValue(event.payout_amount) >= BIG_EVENT_AMOUNT) ||
    (event.outcome === 'loss' && Math.abs(numberValue(event.net_change)) >= BIG_EVENT_AMOUNT);
}

function normalizeEvent(event) {
  return {
    ...event,
    bet_amount: numberValue(event.bet_amount),
    payout_amount: numberValue(event.payout_amount),
    net_change: numberValue(event.net_change),
    balance_before: numberValue(event.balance_before),
    balance_after: numberValue(event.balance_after),
    gameLabel: gameLabels[event.game] ?? event.game,
    isBig: isBigEvent(event),
    isReset: isResetEvent(event)
  };
}

function buildPlayerStats(users, balances, events) {
  const balancesByName = new Map((balances ?? []).map((row) => [row.Name, numberValue(row.Dollers ?? DEFAULT_BALANCE)]));
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
      games: 0,
      winRate: 0,
      net: 0,
      wagered: 0,
      biggestWin: 0,
      biggestLoss: 0,
      currentWinStreak: 0,
      bestWinStreak: 0,
      resets: 0
    });
  }

  for (const event of events) {
    const stats = statsByName.get(event.username);
    if (!stats) {
      continue;
    }

    if (isPlayableEvent(event)) {
      stats.games += 1;
      stats.wagered += event.bet_amount;
      stats.net += event.net_change;
    }

    if (event.outcome === 'win') {
      stats.wins += 1;
      stats.biggestWin = Math.max(stats.biggestWin, event.payout_amount, event.net_change);
      stats.currentWinStreak += 1;
      stats.bestWinStreak = Math.max(stats.bestWinStreak, stats.currentWinStreak);
    } else if (event.outcome === 'loss') {
      stats.losses += 1;
      stats.biggestLoss = Math.min(stats.biggestLoss, event.net_change);
      stats.currentWinStreak = 0;
    } else if (isResetEvent(event)) {
      stats.resets += 1;
    }
  }

  return Array.from(statsByName.values()).map((stats) => ({
    ...stats,
    winRate: percent(stats.wins, stats.games)
  }));
}

function buildGameStats(events) {
  const statsByGame = new Map();

  for (const event of events) {
    if (!isPlayableEvent(event)) {
      continue;
    }

    const stats = statsByGame.get(event.game) ?? {
      game: event.game,
      label: event.gameLabel,
      wins: 0,
      losses: 0,
      events: 0,
      net: 0,
      wagered: 0
    };

    stats.events += 1;
    stats.net += event.net_change;
    stats.wagered += event.bet_amount;
    if (event.outcome === 'win') {
      stats.wins += 1;
    } else {
      stats.losses += 1;
    }

    statsByGame.set(event.game, stats);
  }

  return Array.from(statsByGame.values())
    .map((stats) => ({
      ...stats,
      winRate: percent(stats.wins, stats.events)
    }))
    .sort((a, b) => b.events - a.events || a.label.localeCompare(b.label));
}

function buildEventStats(events) {
  const playableEvents = events.filter(isPlayableEvent);
  const wins = playableEvents.filter((event) => event.outcome === 'win').length;
  const losses = playableEvents.filter((event) => event.outcome === 'loss').length;
  const resets = events.filter(isResetEvent).length;
  const bigEvents = events.filter(isBigEvent).length;

  return {
    total: events.length,
    playable: playableEvents.length,
    wins,
    losses,
    resets,
    bigEvents,
    winRate: percent(wins, wins + losses)
  };
}

function buildKpis(players, events, eventStats) {
  const playableEvents = events.filter(isPlayableEvent);
  const totalNet = playableEvents.reduce((sum, event) => sum + event.net_change, 0);
  const totalWagered = playableEvents.reduce((sum, event) => sum + event.bet_amount, 0);
  const biggestWin = playableEvents.reduce((best, event) =>
    event.outcome === 'win' && event.payout_amount > numberValue(best?.payout_amount) ? event : best, null);
  const bestGambler = players.reduce((top, row) => row.net > numberValue(top?.net ?? -Infinity) ? row : top, null);
  const worstGambler = players.reduce((bottom, row) => row.net < numberValue(bottom?.net ?? Infinity) ? row : bottom, null);
  const bestStreak = players.reduce((top, row) => row.bestWinStreak > numberValue(top?.bestWinStreak ?? -1) ? row : top, null);

  return {
    totalEvents: eventStats.total,
    totalWagered,
    totalNet,
    biggestWin,
    bestGambler,
    worstGambler,
    bestStreak,
    tableRecord: `${eventStats.wins}-${eventStats.losses}`,
    tableWinRate: eventStats.winRate,
    resetCount: eventStats.resets,
    bigEvents: eventStats.bigEvents
  };
}

export function buildDashboardModel({ users, balances, events }) {
  const normalizedEvents = (events ?? []).map(normalizeEvent);
  const players = buildPlayerStats(users, balances, normalizedEvents)
    .sort((a, b) => b.balance - a.balance || b.net - a.net || a.username.localeCompare(b.username));
  const gameStats = buildGameStats(normalizedEvents);
  const eventStats = buildEventStats(normalizedEvents);

  return {
    players,
    kpis: buildKpis(players, normalizedEvents, eventStats),
    gameStats,
    eventStats,
    recentEvents: [...normalizedEvents].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  };
}

export async function loadGamblingDashboardModel() {
  return buildDashboardModel(await getGamblingDashboardData());
}

function outlierClass(value, model) {
  const values = model.players.map((player) => Math.abs(player.net)).filter(Boolean);
  const max = Math.max(0, ...values);
  return Math.abs(value) >= BIG_EVENT_AMOUNT || Math.abs(value) === max && max > 0 ? ' outlier' : '';
}

function logWidth(value, max) {
  if (!value || !max) {
    return 6;
  }

  return Math.max(8, Math.round((Math.log10(value + 1) / Math.log10(max + 1)) * 100));
}

function renderKpis(kpiEl, model) {
  const { kpis } = model;

  kpiEl.innerHTML = `
    <div class="viz-card primary">
      <span>Total events</span>
      <strong>${kpis.totalEvents.toLocaleString('en-US')}</strong>
      <em>${kpis.bigEvents} big events</em>
    </div>
    <div class="viz-card">
      <span>Total wagered</span>
      <strong>${formatDollars(kpis.totalWagered)}</strong>
      <em>${kpis.resetCount} bankroll resets</em>
    </div>
    <div class="viz-card ${kpis.totalNet < 0 ? 'danger' : 'success'}">
      <span>Total net</span>
      <strong>${formatSignedDollars(kpis.totalNet)}</strong>
      <em>${kpis.tableWinRate}% win rate, ${kpis.tableRecord}</em>
    </div>
    <div class="viz-card success">
      <span>Biggest win</span>
      <strong>${formatDollars(kpis.biggestWin?.payout_amount ?? 0)}</strong>
      <em>${esc(kpis.biggestWin?.username ?? 'No wins yet')}</em>
    </div>
    <div class="viz-card">
      <span>Best gambler</span>
      <strong>${esc(playerName(kpis.bestGambler))}</strong>
      <em>${formatSignedDollars(kpis.bestGambler?.net ?? 0)} net</em>
    </div>
    <div class="viz-card danger">
      <span>Worst gambler</span>
      <strong>${esc(playerName(kpis.worstGambler))}</strong>
      <em>${formatSignedDollars(kpis.worstGambler?.net ?? 0)} net</em>
    </div>
  `;
}

function renderNetBars(chartEl, model) {
  const ranked = [...model.players]
    .sort((a, b) => b.net - a.net)
    .slice(0, 8);
  const max = Math.max(1, ...ranked.map((row) => Math.abs(row.net)));

  chartEl.innerHTML = ranked.map((row) => `
    <div class="viz-bar-row${outlierClass(row.net, model)}">
      <span title="${esc(row.username)}">${esc(row.username)}</span>
      <div class="viz-bar-track">
        <i class="viz-bar ${row.net < 0 ? 'loss' : 'win'}" style="width: ${logWidth(Math.abs(row.net), max)}%"></i>
      </div>
      <strong>${formatSignedDollars(row.net)}</strong>
    </div>
  `).join('');
}

function renderWinLossMix(chartEl, model) {
  const { wins, losses, resets, bigEvents } = model.eventStats;
  const rows = [
    ['Wins', wins, 'win'],
    ['Losses', losses, 'loss'],
    ['Resets', resets, 'reset'],
    ['Big events', bigEvents, 'big']
  ];
  const max = Math.max(1, ...rows.map(([, count]) => count));

  chartEl.innerHTML = rows.map(([label, count, type]) => `
    <div class="viz-bar-row">
      <span>${label}</span>
      <div class="viz-bar-track">
        <i class="viz-bar ${type}" style="width: ${Math.max(8, percent(count, max))}%"></i>
      </div>
      <strong>${count}</strong>
    </div>
  `).join('');
}

function renderGameMix(chartEl, model) {
  const max = Math.max(1, ...model.gameStats.map((row) => row.events));

  chartEl.innerHTML = model.gameStats.length ? model.gameStats.map((row) => `
    <div class="viz-bar-row">
      <span>${esc(row.label)}</span>
      <div class="viz-bar-track">
        <i class="viz-bar game" style="width: ${Math.max(8, percent(row.events, max))}%"></i>
      </div>
      <strong>${row.events}</strong>
    </div>
  `).join('') : '<div class="viz-empty">No game events yet</div>';
}

export function renderDashboardModel({ model, statusEl, kpiEl, netChartEl, mixChartEl, gameChartEl }) {
  if (!model || !statusEl || !kpiEl || !netChartEl || !mixChartEl || !gameChartEl) {
    return;
  }

  renderKpis(kpiEl, model);
  renderNetBars(netChartEl, model);
  renderWinLossMix(mixChartEl, model);
  renderGameMix(gameChartEl, model);

  statusEl.textContent = `${model.eventStats.total.toLocaleString('en-US')} events`;
}

export async function renderGamblingDashboard(elements) {
  if (!elements?.statusEl || !elements?.kpiEl || !elements?.netChartEl || !elements?.mixChartEl || !elements?.gameChartEl) {
    return null;
  }

  elements.statusEl.textContent = 'Loading...';

  try {
    const model = await loadGamblingDashboardModel();
    renderDashboardModel({ model, ...elements });
    return model;
  } catch (error) {
    elements.kpiEl.innerHTML = '<div class="viz-empty">Could not load dashboard</div>';
    elements.netChartEl.innerHTML = '';
    elements.mixChartEl.innerHTML = '';
    elements.gameChartEl.innerHTML = '';
    elements.statusEl.textContent = error.message || 'Load failed';
    return null;
  }
}
