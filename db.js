import { supabase } from './supabase-client.js';

async function sbQuery(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data ?? null;
}

// ── Balance ───────────────────────────────────────────────────────────────────

export async function dbUpsertBalance(username, dollers, ignoreDuplicates = false) {
  await sbQuery(
    supabase
      .from('Balance')
      .upsert(
        { Name: username, Dollers: dollers },
        { onConflict: 'Name', ignoreDuplicates }
      )
  );
}

export async function dbGetBalance(username) {
  return sbQuery(
    supabase
      .from('Balance')
      .select('Dollers')
      .eq('Name', username)
      .maybeSingle()
  );
}

export async function dbGetAllBalances() {
  return sbQuery(
    supabase
      .from('Balance')
      .select('Name,Dollers')
  ) ?? [];
}

// ── Users ─────────────────────────────────────────────────────────────────────

export async function dbGetAllUsers() {
  return sbQuery(
    supabase
      .from('Users')
      .select('Username')
      .order('Username', { ascending: true })
  ) ?? [];
}

export async function dbFindUser(username, password) {
  return sbQuery(
    supabase
      .from('Users')
      .select('Username')
      .eq('Username', username)
      .eq('Password', password)
      .single()
  );
}

export async function dbInsertUser(username, password) {
  await sbQuery(
    supabase
      .from('Users')
      .insert([{ Username: username, Password: password }])
  );
}

// ── gambling_events ───────────────────────────────────────────────────────────

export async function dbGetEvents({ fields = '*', ascending = false, limit } = {}) {
  let query = supabase
    .from('gambling_events')
    .select(fields)
    .order('created_at', { ascending });

  if (limit != null) {
    query = query.limit(limit);
  }

  return sbQuery(query) ?? [];
}

export async function dbInsertEvent(event) {
  await sbQuery(
    supabase
      .from('gambling_events')
      .insert([event])
  );
}

// ── games (wheel page) ────────────────────────────────────────────────────────

export async function dbGetAllGames() {
  return sbQuery(
    supabase
      .from('games')
      .select('id,name,players,minplayers,maxplayers,time_minutes')
      .order('name', { ascending: true })
  ) ?? [];
}

// ── leaderboard (fishtank page) ───────────────────────────────────────────────

export async function dbInsertScore(name, seconds) {
  await sbQuery(
    supabase
      .from('leaderboard')
      .insert([{ name, seconds }])
  );
}

export async function dbGetTopScores(limit = 10) {
  return sbQuery(
    supabase
      .from('leaderboard')
      .select('name,seconds')
      .order('seconds', { ascending: false })
      .limit(limit)
  ) ?? [];
}

// ── forum (threads + comments) ────────────────────────────────────────────────

export async function dbGetThreads() {
  return sbQuery(
    supabase
      .from('threads')
      .select('*, comments(count)')
      .order('created_at', { ascending: false })
  ) ?? [];
}

export async function dbGetThread(id) {
  return sbQuery(
    supabase
      .from('threads')
      .select('*')
      .eq('id', id)
      .single()
  );
}

export async function dbInsertThread(author, title, body) {
  await sbQuery(
    supabase
      .from('threads')
      .insert({ author, title, body })
  );
}

export async function dbGetThreadComments(threadId) {
  return sbQuery(
    supabase
      .from('comments')
      .select('*')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })
  ) ?? [];
}

export async function dbInsertComment(threadId, author, body) {
  await sbQuery(
    supabase
      .from('comments')
      .insert({ thread_id: threadId, author, body })
  );
}
