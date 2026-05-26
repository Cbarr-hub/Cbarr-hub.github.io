import { dbUpsertBalance, dbGetBalance, dbGetAllBalances, dbGetAllUsers, dbGetEvents, dbInsertEvent } from './db.js';
import { normalizeGamblingEvent } from './gamble-events.mjs?v=money-events-2';

export const DEFAULT_BALANCE = 5000;

export async function ensureBalance(username, defaultBalance = DEFAULT_BALANCE) {
  if (!username) {
    return;
  }

  await dbUpsertBalance(username, defaultBalance, true);
}

export async function getPlayerBalance(username) {
  const data = await dbGetBalance(username);

  if (!data) {
    await ensureBalance(username);
    return DEFAULT_BALANCE;
  }

  return Number(data.Dollers ?? DEFAULT_BALANCE);
}

export async function savePlayerBalance(username, credits) {
  await dbUpsertBalance(username, Math.round(credits));
}

export async function getLeaderboardRows() {
  const [users, balances, events] = await Promise.all([
    dbGetAllUsers(),
    dbGetAllBalances(),
    dbGetEvents({
      fields: 'created_at,username,outcome,event_type,bet_amount,net_change,payout_amount',
      ascending: true
    })
  ]);

  const balancesByName = new Map((balances ?? []).map((row) => [row.Name, Number(row.Dollers ?? DEFAULT_BALANCE)]));
  const statsByName = new Map();

  for (const rawEvent of events ?? []) {
    const event = normalizeGamblingEvent(rawEvent);
    if (!event.isMoneyEvent) {
      continue;
    }

    const stats = statsByName.get(event.username) ?? {
      wins: 0,
      losses: 0,
      games: 0,
      net: 0,
      biggestWin: 0,
      currentWinStreak: 0,
      bestWinStreak: 0
    };

    stats.games += 1;
    if (event.moneyOutcome === 'win') {
      stats.wins += 1;
      stats.biggestWin = Math.max(stats.biggestWin, Number(event.payout_amount ?? 0));
      stats.currentWinStreak += 1;
      stats.bestWinStreak = Math.max(stats.bestWinStreak, stats.currentWinStreak);
    } else if (event.moneyOutcome === 'loss') {
      stats.losses += 1;
      stats.currentWinStreak = 0;
    }

    stats.net += Number(event.net_change ?? 0);
    statsByName.set(event.username, stats);
  }

  return (users ?? [])
    .filter((user) => user.Username)
    .map((user) => {
      const stats = statsByName.get(user.Username) ?? {
        wins: 0,
        losses: 0,
        games: 0,
        net: 0,
        biggestWin: 0,
        currentWinStreak: 0,
        bestWinStreak: 0
      };

      return {
        username: user.Username,
        balance: balancesByName.get(user.Username) ?? DEFAULT_BALANCE,
        ...stats
      };
    })
    .sort((a, b) => b.balance - a.balance || b.net - a.net || a.username.localeCompare(b.username));
}

export async function insertGamblingEvent(event) {
  await dbInsertEvent(event);
}

export async function getRecentGamblingEvents(limit = 12) {
  return dbGetEvents({
    fields: 'created_at,username,game,event_type,outcome,bet_amount,payout_amount,net_change,balance_before,balance_after,details',
    limit
  });
}

export async function getGamblingDashboardData() {
  const [users, balances, events] = await Promise.all([
    dbGetAllUsers(),
    dbGetAllBalances(),
    dbGetEvents({
      fields: 'created_at,username,game,event_type,outcome,bet_amount,payout_amount,net_change,balance_before,balance_after,details',
      limit: 5000
    })
  ]);

  return {
    users: users ?? [],
    balances: balances ?? [],
    events: events ?? []
  };
}
