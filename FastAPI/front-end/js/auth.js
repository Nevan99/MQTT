const API = '';

// --- Date/time display -------------------------------------------------
// Every timestamp from the backend is stored/sent as UTC (ISO 8601) -
// `new Date(...).toLocaleString()` used to render it in whatever timezone
// the browser/OS itself is set to, which drifted from Vietnam time on any
// machine not explicitly configured for it. These pin every timestamp
// display in the app to Asia/Ho_Chi_Minh (ICT, UTC+7) regardless of the
// viewing machine's own timezone setting.
const VN_TIME_ZONE = 'Asia/Ho_Chi_Minh';

// SQLite drops timezone info on write, so every datetime the backend sends
// back over the API - despite being generated as UTC-aware (utcnow() in
// database/models.py) - round-trips as a bare, marker-less ISO string like
// "2026-08-21T09:15:00" instead of "...+00:00"/"...Z". `new Date(...)`
// treats a string with no timezone marker as *local browser time*, not
// UTC - so without this, every timestamp got silently reinterpreted
// through whatever timezone the viewing machine happens to be set to
// before VN formatting was even applied. Every such timestamp in this app
// is UTC by convention, so a missing marker is appended before parsing.
function parseApiDate(value) {
  const s = String(value);
  const hasTz = /Z$|[+-]\d\d:?\d\d$/.test(s);
  return new Date(hasTz ? s : s + 'Z');
}

function formatVnDateTime(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : parseApiDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { timeZone: VN_TIME_ZONE });
}

function formatVnTime(value) {
  const d = value instanceof Date ? value : (value ? parseApiDate(value) : new Date());
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { timeZone: VN_TIME_ZONE });
}

// --- Auth ------------------------------------------------------------------

const AUTH_TOKEN_KEY = 'pi_fleet_token';
let authToken = localStorage.getItem(AUTH_TOKEN_KEY);

function setAuthToken(token) {
  authToken = token;
  if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
  else localStorage.removeItem(AUTH_TOKEN_KEY);
}

// A plain-navigation link (capture download) or a WebSocket URL can't carry
// an Authorization header, so the backend also accepts the token as a query
// param for exactly those two cases - this appends it.
function withToken(url) {
  if (!authToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(authToken)}`;
}

function showLoginScreen(message) {
  document.getElementById('loginOverlay').classList.add('active');
  document.getElementById('appRoot').classList.add('auth-hidden');
  document.getElementById('loginError').textContent = message || '';
}

function hideLoginScreen() {
  document.getElementById('loginOverlay').classList.remove('active');
  document.getElementById('appRoot').classList.remove('auth-hidden');
}

// Every API call in this app goes through here instead of calling fetch()
// directly, so the bearer token and 401 handling (session expired/invalid -
// drop the token and force a fresh login) are applied uniformly in one place.
async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    setAuthToken(null);
    showLoginScreen('Session expired - please log in again.');
    throw new Error('Not authenticated');
  }
  return res;
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginSubmit');
  errEl.textContent = '';
  btn.disabled = true;
  try {
    const res = await fetch(`${API}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }),
    });
    if (!res.ok) {
      errEl.textContent = 'Incorrect username or password.';
      return;
    }
    const data = await res.json();
    setAuthToken(data.access_token);
    document.getElementById('loginPassword').value = '';
    hideLoginScreen();
    // The initial data loads below already ran once (and failed with 401
    // before login) - re-trigger them now instead of waiting up to 5s for
    // the next refreshPis() poll to happen to succeed.
    refreshPis();
    loadCaptures();
    loadHistory();
  } catch {
    errEl.textContent = 'Could not reach the server.';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  setAuthToken(null);
  showLoginScreen();
});

// appRoot starts hidden (class="auth-hidden" in the markup) so it's never
// visible for even a flash before we know whether there's a token. If one
// exists from a previous session, reveal the app optimistically - if it's
// actually expired/invalid, the first API call's 401 (via apiFetch) will
// send the user back to the login screen anyway.
if (authToken) {
  hideLoginScreen();
} else {
  showLoginScreen();
}
const tabs = document.querySelectorAll('nav .tab');
const views = document.querySelectorAll('.view');
// A tab click only ever changes the URL hash - routeApp (detail-page.js),
// driven by the resulting hashchange, is what actually shows/hides views.
// That's what makes a reload land back on whatever tab (or Pi detail page)
// was open, and the browser Back/Forward buttons step between them - a
// plain classList toggle here (the old behavior) did neither, since it
// left no trace in the URL/history for a reload or Back to recover.
tabs.forEach(btn => btn.addEventListener('click', () => {
  location.hash = `#${btn.dataset.view}`;
}));

