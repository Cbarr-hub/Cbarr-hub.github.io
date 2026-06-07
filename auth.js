// Browser-side auth shim. The real session lives in an HttpOnly cookie set by
// the backend; this file only knows what the server tells it via /api/me.

import { dbWhoAmI, dbLogout } from './db.js';

// Per-page-load session cache. `loadSession()` hits /api/me at most once and
// every later caller awaits the same in-flight promise (so a page importing
// auth.js plus several modules calling loadSession() makes one request). The
// "not signed in" case is the common one and resolves to null (dbWhoAmI maps a
// 401 to null), so it caches cleanly; a genuine network/parse failure rejects
// the shared promise — acceptable here because such a page can't function
// authenticated anyway. logout() clears both so a later loadSession() re-fetches.
let cachedSession = null;
let sessionPromise = null;

async function fetchSession() {
  cachedSession = await dbWhoAmI();
  return cachedSession;
}

export async function loadSession() {
  if (!sessionPromise) sessionPromise = fetchSession();
  return sessionPromise;
}

export function getSession() {
  return cachedSession?.username ?? null;
}

export async function requireAuth(redirectTo = 'signin.html') {
  const session = await loadSession();
  if (!session) {
    window.location.href = redirectTo;
    return null;
  }
  return session.username;
}

export async function logout() {
  try { await dbLogout(); } catch {}
  cachedSession = null;
  sessionPromise = null;
}

// Swap the "sign in" nav link for a username + Logout control. Idempotent:
// once the sign-in link has been replaced, the querySelector below finds
// nothing and the function returns early, so re-invoking it can't append a
// second .nav-user. Called once from init(); safe to call again with an
// explicit username (e.g. right after sign-in on a page that doesn't navigate).
export function updateNavbar(username) {
  const signInLink = document.querySelector('a[href="signin.html"], #openSignIn');
  if (!signInLink) return;

  const name = username ?? cachedSession?.displayName ?? cachedSession?.username;
  if (!name) return;

  const nav = signInLink.parentElement;
  signInLink.remove();

  const userContainer = document.createElement('div');
  userContainer.className = 'nav-user';
  userContainer.innerHTML = `
    <span class="nav-username"></span>
    <button class="logout-btn" id="logoutBtn">Logout</button>
  `;
  userContainer.querySelector('.nav-username').textContent = name;
  nav.appendChild(userContainer);

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await logout();
    window.location.replace('/signin.html');
  });
}

async function init() {
  await loadSession();
  updateNavbar();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
