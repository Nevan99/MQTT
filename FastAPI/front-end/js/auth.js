const API = '';

const VN_TIME_ZONE = 'Asia/Ho_Chi_Minh';

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

// "23/10/2026, 14:05:01" as a bold date and a muted time (.kt-date/.kt-time).
function ktDateTimeHtml(value) {
  const text = formatVnDateTime(value);
  if (!text) return '<span class="kt-muted">—</span>';
  const [date, time] = text.split(', ');
  return `<span class="kt-date">${date}</span> <span class="kt-time">${time || ''}</span>`;
}

function wifiFailureDetail(result) {
  const parts = [];
  if (result && result.output) parts.push(result.output);
  if (result && result.failure_reason) parts.push(result.failure_reason);
  return parts.join(' | ');
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

if (authToken) {
  hideLoginScreen();
} else {
  showLoginScreen();
}
const tabs = document.querySelectorAll('nav .tab');
const views = document.querySelectorAll('.view');
tabs.forEach(btn => btn.addEventListener('click', () => {
  location.hash = `#${btn.dataset.view}`;
}));

