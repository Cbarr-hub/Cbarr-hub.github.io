export function getSession() {
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'gt_session') {
      return decodeURIComponent(value);
    }
  }

  const legacySession = sessionStorage.getItem('gt_user');
  if (legacySession) {
    setSession(legacySession);
    return legacySession;
  }

  return null;
}

export function setSession(username) {
  document.cookie = `gt_session=${encodeURIComponent(username)}; path=/; SameSite=Strict`;
  sessionStorage.setItem('gt_user', username);
}

export function clearSession() {
  document.cookie = 'gt_session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC; SameSite=Strict';
  sessionStorage.removeItem('gt_user');
}

export function requireAuth(redirectTo = 'index.html') {
  const session = getSession();
  if (!session) {
    window.location.href = redirectTo;
  }
  return session;
}

export function updateNavbar(username) {
  const signInLink = document.querySelector('a[href="signin.html"], #openSignIn');
  if (!signInLink) return;

  const currentSession = username || getSession();
  if (currentSession) {
    const nav = signInLink.parentElement;
    signInLink.remove();

    const userContainer = document.createElement('div');
    userContainer.className = 'nav-user';
    userContainer.innerHTML = `
      <span class="nav-username">${currentSession}</span>
      <button class="logout-btn" id="logoutBtn">Logout</button>
    `;
    nav.appendChild(userContainer);

    document.getElementById('logoutBtn').addEventListener('click', () => {
      clearSession();
      location.reload();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => updateNavbar());
} else {
  updateNavbar();
}
