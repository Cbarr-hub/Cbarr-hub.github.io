import { supabase } from './supabase-client.js';

export const DEFAULT_BALANCE = 5000;

export async function ensureBalance(username, defaultBalance = DEFAULT_BALANCE) {
  if (!username) {
    return;
  }

  const { error } = await supabase
    .from('Balance')
    .upsert(
      { Name: username, Dollers: defaultBalance },
      { onConflict: 'Name', ignoreDuplicates: true }
    );

  if (error) {
    throw error;
  }
}

export async function getPlayerBalance(username) {
  const { data, error } = await supabase
    .from('Balance')
    .select('Dollers')
    .eq('Name', username)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    await ensureBalance(username);
    return DEFAULT_BALANCE;
  }

  return Number(data.Dollers ?? DEFAULT_BALANCE);
}

export async function savePlayerBalance(username, credits) {
  const { error } = await supabase
    .from('Balance')
    .upsert(
      { Name: username, Dollers: Math.round(credits) },
      { onConflict: 'Name' }
    );

  if (error) {
    throw error;
  }
}

export async function getLeaderboardRows() {
  const [{ data: users, error: usersError }, { data: balances, error: balancesError }, { data: events, error: eventsError }] = await Promise.all([
    supabase
      .from('Users')
      .select('Username')
      .order('Username', { ascending: true }),
    supabase
      .from('Balance')
      .select('Name,Dollers'),
    supabase
      .from('gambling_events')
      .select('username,outcome,net_change,payout_amount')
      .in('outcome', ['win', 'loss'])
  ]);

  if (usersError) {
    throw usersError;
  }

  if (balancesError) {
    throw balancesError;
  }

  if (eventsError) {
    throw eventsError;
  }

  const balancesByName = new Map((balances ?? []).map((row) => [row.Name, Number(row.Dollers ?? DEFAULT_BALANCE)]));
  const statsByName = new Map();

  for (const event of events ?? []) {
    const stats = statsByName.get(event.username) ?? {
      wins: 0,
      losses: 0,
      net: 0,
      biggestWin: 0,
      currentWinStreak: 0,
      bestWinStreak: 0
    };

    if (event.outcome === 'win') {
      stats.wins += 1;
      stats.biggestWin = Math.max(stats.biggestWin, Number(event.payout_amount ?? 0));
      stats.currentWinStreak += 1;
      stats.bestWinStreak = Math.max(stats.bestWinStreak, stats.currentWinStreak);
    } else if (event.outcome === 'loss') {
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
  const { error } = await supabase
    .from('gambling_events')
    .insert([event]);

  if (error) {
    throw error;
  }
}

export async function getRecentGamblingEvents(limit = 12) {
  const { data, error } = await supabase
    .from('gambling_events')
    .select('created_at,username,game,event_type,outcome,bet_amount,payout_amount,net_change,balance_before,balance_after,details')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function getGamblingDashboardData() {
  const [{ data: users, error: usersError }, { data: balances, error: balancesError }, { data: events, error: eventsError }] = await Promise.all([
    supabase
      .from('Users')
      .select('Username')
      .order('Username', { ascending: true }),
    supabase
      .from('Balance')
      .select('Name,Dollers'),
    supabase
      .from('gambling_events')
      .select('created_at,username,game,event_type,outcome,bet_amount,payout_amount,net_change,balance_before,balance_after,details')
      .order('created_at', { ascending: true })
      .limit(2000)
  ]);

  if (usersError) {
    throw usersError;
  }

  if (balancesError) {
    throw balancesError;
  }

  if (eventsError) {
    throw eventsError;
  }

  return {
    users: users ?? [],
    balances: balances ?? [],
    events: events ?? []
  };
}
