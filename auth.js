// Browser-side auth shim. The real session lives in an HttpOnly cookie set by
// the backend; this file only knows what the server tells it via /api/me.

import { dbWhoAmI, dbLogout } from './db.js';

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
