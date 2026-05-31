// Gambling dashboard data layer. Everything routes through db.js → /api/*.
// No direct database calls live here; this file only shapes responses.

import {
  dbUpsertBalance,
  dbGetBalance,
  dbGetMyBalance,
  dbGetAllBalances,
  dbGetEvents,
  dbInsertEvent,
} from './db.js';
import { getSession } from './auth.js';
import { normalizeGamblingEvent } from './gamble-events.mjs?v=money-events-2';

export const DEFAULT_BALANCE = 5000;

// Kept as an export for back-compat — the backend now seeds the starting
// balance when an admin creates the account, so callers don't need to.
export async function ensureBalance(_username, _defaultBalance = DEFAULT_BALANCE) {
  return;
}

export async function getPlayerBalance(username) {
  // Fast path: the signed-in user reads their own balance via /me.
  if (username && username === getSession()) {
    const dollars = await dbGetMyBalance();
    return dollars ?? DEFAULT_BALANCE;
  }

  const data = await dbGetBalance(username);
  return data ? Number(data.Dollers ?? DEFAULT_BALANCE) : DEFAULT_BALANCE;
}

export async function savePlayerBalance(username, credits) {
  await dbUpsertBalance(username, Math.round(credits));
}

function usernamesFromBalances(balances) {
  return (balances ?? []).map((row) => row.Name).filter(Boolean);
}

export async function getLeaderboardRows() {
  const [balances, events] = await Promise.all([
    dbGetAllBalances(),
    dbGetEvents({
      fields: 'created_at,username,outcome,event_type,bet_amount,net_change,payout_amount',
      ascending: true,
    }),
  ]);

  const balancesByName = new Map(
    (balances ?? []).map((row) => [row.Name, Number(row.Dollers ?? DEFAULT_BALANCE)])
  );
  const statsByName = new Map();

  for (const rawEvent of events ?? []) {
    const event = normalizeGamblingEvent(rawEvent);
    if (!event.isMoneyEvent) continue;

    const stats = statsByName.get(event.username) ?? {
      wins: 0,
      losses: 0,
      games: 0,
      net: 0,
      biggestWin: 0,
      currentWinStreak: 0,
      bestWinStreak: 0,
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

  return usernamesFromBalances(balances)
    .map((username) => {
      const stats = statsByName.get(username) ?? {
        wins: 0,
        losses: 0,
        games: 0,
        net: 0,
        biggestWin: 0,
        currentWinStreak: 0,
        bestWinStreak: 0,
      };

      return {
        username,
        balance: balancesByName.get(username) ?? DEFAULT_BALANCE,
        ...stats,
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
    limit,
  });
}

export async function getGamblingDashboardData() {
  const [balances, events] = await Promise.all([
    dbGetAllBalances(),
    dbGetEvents({
      fields: 'created_at,username,game,event_type,outcome,bet_amount,payout_amount,net_change,balance_before,balance_after,details',
    }),
  ]);

  const users = usernamesFromBalances(balances).map((Username) => ({ Username }));

  return {
    users,
    balances: balances ?? [],
    events: events ?? [],
  };
}
