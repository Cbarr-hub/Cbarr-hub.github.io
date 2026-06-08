// Public, keyless Steam Workshop lookups for the CS map catalog: expand a
// collection into its item ids, and resolve item ids → titles (auto map names).
//
// Uses the ISteamRemoteStorage endpoints, which require NO API key — they accept
// a plain form POST. If STEAM_API_KEY happens to be set it's passed through
// (harmless; these endpoints tolerate it), but it is never required.

import { badSetting } from './errors.js';

const BASE = 'https://api.steampowered.com/ISteamRemoteStorage';
const TIMEOUT_MS = 10_000;

const validId = (raw) => {
  const id = String(raw ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) throw badSetting(`invalid Workshop id: ${id}`);
  return id;
};

async function steamPost(endpoint, fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.set(k, String(v));
  if (process.env.STEAM_API_KEY) body.set('key', process.env.STEAM_API_KEY);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE}/${endpoint}/v1/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw badSetting(e?.name === 'AbortError'
      ? 'Steam Workshop request timed out — try again.'
      : `could not reach Steam Workshop: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw badSetting(`Steam Workshop returned HTTP ${res.status}`);
  try { return (await res.json())?.response ?? {}; }
  catch { throw badSetting('Steam Workshop returned an unreadable response'); }
}

// Expand a collection id → ordered array of child item ids (strings).
export async function fetchCollectionItems(collectionId) {
  const id = validId(collectionId);
  const r = await steamPost('GetCollectionDetails', { collectioncount: 1, 'publishedfileids[0]': id });
  const detail = r.collectiondetails?.[0];
  if (!detail || detail.result !== 1 || !Array.isArray(detail.children)) {
    throw badSetting(`Workshop collection ${id} not found — make sure the id is a public collection.`);
  }
  return detail.children
    .map((c) => String(c.publishedfileid))
    .filter((c) => /^\d{1,20}$/.test(c));
}

// Resolve item ids → Map<id, title>. Private/removed items are skipped.
export async function fetchItemTitles(ids) {
  const clean = [...new Set(ids.map(String))].filter((i) => /^\d{1,20}$/.test(i));
  const out = new Map();
  if (!clean.length) return out;
  // Batch: GetPublishedFileDetails has a practical per-call item cap (and the urlencoded
  // body grows with the count), so a large collection sent in one call truncates or
  // errors. Chunk it; missing titles still fall back to "Workshop <id>" upstream.
  const BATCH = 100;
  for (let i = 0; i < clean.length; i += BATCH) {
    const batch = clean.slice(i, i + BATCH);
    const fields = { itemcount: batch.length };
    batch.forEach((id, j) => { fields[`publishedfileids[${j}]`] = id; });
    const r = await steamPost('GetPublishedFileDetails', fields);
    for (const d of r.publishedfiledetails ?? []) {
      if (d?.result === 1 && d.title) out.set(String(d.publishedfileid), String(d.title));
    }
  }
  return out;
}

// One id → its title (or '' when unknown/private).
export async function fetchItemTitle(id) {
  const clean = validId(id);
  return (await fetchItemTitles([clean])).get(clean) ?? '';
}

// Collection id → [{ workshopId, name }] for every child item, names from Steam
// (falls back to "Workshop <id>" for any item whose title couldn't be resolved).
export async function fetchCollectionMaps(collectionId) {
  const ids = await fetchCollectionItems(collectionId);
  if (!ids.length) return [];
  const titles = await fetchItemTitles(ids);
  return ids.map((workshopId) => ({ workshopId, name: titles.get(workshopId) || `Workshop ${workshopId}` }));
}
