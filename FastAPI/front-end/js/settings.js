// --- Settings: theme + accent ----------------------------------------------
//
// Choices live in localStorage (per browser, not per user) and are applied as
// data-theme / data-mode / data-accent on <html> - themes.css keys every
// color token off those. index.html's <head> runs the same logic inline
// before first paint; this file owns the popup and live updates.

const THEME_KEY = 'pi_fleet_theme';
const ACCENT_KEY = 'pi_fleet_accent';
const DEFAULT_THEME = 'dark';
const DEFAULT_ACCENT = 'cyan';

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'slate', name: 'Slate' },
  { id: 'light', name: 'Light' },
  { id: 'system', name: 'System' },
];

// dark/light swatch shades match themes.css's --accent for each mode.
const ACCENTS = [
  { id: 'cyan', name: 'Cyan', dark: '#66ccff', light: '#0369a1' },
  { id: 'blue', name: 'Blue', dark: '#6ab0ff', light: '#1d4ed8' },
  { id: 'green', name: 'Green', dark: '#4ade80', light: '#15803d' },
  { id: 'violet', name: 'Violet', dark: '#a78bfa', light: '#6d28d9' },
  { id: 'amber', name: 'Amber', dark: '#fbbf24', light: '#b45309' },
];

const systemLightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

function readSetting(key, fallback, allowed) {
  let value = null;
  try { value = localStorage.getItem(key); } catch (e) { /* storage blocked */ }
  return allowed.some((o) => o.id === value) ? value : fallback;
}

function writeSetting(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* storage blocked */ }
}

function currentTheme() { return readSetting(THEME_KEY, DEFAULT_THEME, THEMES); }
function currentAccent() { return readSetting(ACCENT_KEY, DEFAULT_ACCENT, ACCENTS); }

function resolveMode(theme) {
  if (theme === 'light') return 'light';
  if (theme === 'system') return systemLightQuery && systemLightQuery.matches ? 'light' : 'dark';
  return 'dark';
}

function applyTheme(theme = currentTheme(), accent = currentAccent()) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-mode', resolveMode(theme));
  root.setAttribute('data-accent', accent);
  renderSettingsOptions();
}

// "System" has to track the OS switching light/dark while the page is open.
if (systemLightQuery) {
  const onSystemChange = () => { if (currentTheme() === 'system') applyTheme(); };
  if (systemLightQuery.addEventListener) systemLightQuery.addEventListener('change', onSystemChange);
  else systemLightQuery.addListener(onSystemChange);
}

// Another tab changing the setting updates this one too.
window.addEventListener('storage', (e) => {
  if (e.key === THEME_KEY || e.key === ACCENT_KEY) applyTheme();
});

function setTheme(theme) { writeSetting(THEME_KEY, theme); applyTheme(); }
function setAccent(accent) { writeSetting(ACCENT_KEY, accent); applyTheme(); }

const CHECK_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function renderSettingsOptions() {
  const themeHost = document.getElementById('themeOptions');
  const accentHost = document.getElementById('accentOptions');
  if (!themeHost || !accentHost) return;
  const theme = currentTheme();
  const accent = currentAccent();
  const mode = resolveMode(theme);

  themeHost.innerHTML = THEMES.map((t) => `
    <button type="button" class="theme-option" role="radio" data-theme-id="${t.id}"
            aria-checked="${t.id === theme}" tabindex="${t.id === theme ? 0 : -1}">
      <span class="theme-preview" data-preview="${t.id}" aria-hidden="true">
        <i class="p-head"></i><i class="p-panel"></i><i class="p-side"></i>
        <i class="p-line"></i><i class="p-line l2"></i><i class="p-accent"></i>
      </span>
      <span class="theme-option-name">${t.name}<span class="theme-option-check">${CHECK_SVG}</span></span>
    </button>`).join('');

  accentHost.innerHTML = ACCENTS.map((a) => `
    <button type="button" class="accent-option" role="radio" data-accent-id="${a.id}"
            aria-checked="${a.id === accent}" tabindex="${a.id === accent ? 0 : -1}">
      <span class="accent-swatch" style="--swatch: ${a[mode]}" aria-hidden="true">${CHECK_SVG}</span>${a.name}
    </button>`).join('');
}

// Radio-group keyboard behaviour: arrows move (and select), like native radios.
function radioGroupKeydown(e, selector, idAttr, select) {
  const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (!(e.key in keys)) return;
  const items = [...e.currentTarget.querySelectorAll(selector)];
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = items[(i + keys[e.key] + items.length) % items.length];
  select(next.getAttribute(idAttr));
  e.currentTarget.querySelector(`[${idAttr}="${next.getAttribute(idAttr)}"]`).focus();
}

let settingsReturnFocus = null;

function openSettingsModal() {
  settingsReturnFocus = document.activeElement;
  renderSettingsOptions();
  document.getElementById('settingsOverlay').classList.remove('hidden');
  const checked = document.querySelector('#themeOptions [aria-checked="true"]');
  if (checked) checked.focus();
}

function closeSettingsModal() {
  document.getElementById('settingsOverlay').classList.add('hidden');
  if (settingsReturnFocus && settingsReturnFocus.focus) settingsReturnFocus.focus();
}

function isSettingsOpen() {
  return !document.getElementById('settingsOverlay').classList.contains('hidden');
}

document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
document.getElementById('settingsCloseBtn').addEventListener('click', closeSettingsModal);
document.getElementById('settingsOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'settingsOverlay') closeSettingsModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isSettingsOpen()) closeSettingsModal();
});

const themeOptionsEl = document.getElementById('themeOptions');
themeOptionsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme-id]');
  if (btn) { setTheme(btn.dataset.themeId); themeOptionsEl.querySelector(`[data-theme-id="${btn.dataset.themeId}"]`).focus(); }
});
themeOptionsEl.addEventListener('keydown', (e) => radioGroupKeydown(e, '.theme-option', 'data-theme-id', setTheme));

const accentOptionsEl = document.getElementById('accentOptions');
accentOptionsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-accent-id]');
  if (btn) { setAccent(btn.dataset.accentId); accentOptionsEl.querySelector(`[data-accent-id="${btn.dataset.accentId}"]`).focus(); }
});
accentOptionsEl.addEventListener('keydown', (e) => radioGroupKeydown(e, '.accent-option', 'data-accent-id', setAccent));

document.getElementById('settingsResetBtn').addEventListener('click', () => {
  writeSetting(THEME_KEY, DEFAULT_THEME);
  writeSetting(ACCENT_KEY, DEFAULT_ACCENT);
  applyTheme();
});

applyTheme();
