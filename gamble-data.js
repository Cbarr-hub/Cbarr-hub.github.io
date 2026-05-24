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
  const [{ data: users, error: usersError }, { data: balances, error: balancesError }] = await Promise.all([
    supabase
      .from('Users')
      .select('Username')
      .order('Username', { ascending: true }),
    supabase
      .from('Balance')
      .select('Name,Dollers')
  ]);

  if (usersError) {
    throw usersError;
  }

  if (balancesError) {
    throw balancesError;
  }

  const balancesByName = new Map((balances ?? []).map((row) => [row.Name, Number(row.Dollers ?? DEFAULT_BALANCE)]));

  return (users ?? [])
    .filter((user) => user.Username)
    .map((user) => ({
      username: user.Username,
      balance: balancesByName.get(user.Username) ?? DEFAULT_BALANCE
    }))
    .sort((a, b) => b.balance - a.balance || a.username.localeCompare(b.username));
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
    .select('created_at,username,game,outcome,bet_amount,payout_amount,net_change,details')
    .in('outcome', ['win', 'loss'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data ?? [];
}
