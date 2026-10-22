// --- Interfaces tab: flat, fleet-wide table of every managed Pi's every
// interface, straight from the same InterfaceStatus buffer the Fleet
// table's per-interface cards and the Pi detail page read (continuously
// refreshed server-side by pi_agent - see PiAgent._interface_status_loop
// and routers/Pis.get_all_interface_status). Refreshed on the same 5s
// cadence as the rest of the app (see refreshPis in fleet-table.js) - no
// command round-trip of its own, just a DB read.
//
// One toolbar instead of a filter box per column: a search across every
// column, quick Pi / type / band / connected-only filters, a column chooser
// (the core columns show by default, the rest are a click away) and an
// optional per-column filter row. Rows group under one header per Pi unless
// a column sort is chosen. Choices are remembered per browser.

// Local helpers: this file loads before testcases-tab.js (tcEsc, debounce)
// and wires its toolbar as it loads.
function ifEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ifDebounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function interfacesTabCellValue(v) {
  return v === null || v === undefined || v === '' ? '—' : v;
}

// [key, label, text getter (also used for search/filter/sort), shown by default, cell HTML]
const INTERFACES_TAB_COLUMNS = [
  ['pi_id', 'Pi ID', null, true],
  ['interface', 'Interface', null, true, r => `${ifEsc(r.interface)}${maxStandardOf(r) ? ' ' + wifiStdTagHtml(maxStandardOf(r)) : ''}`],
  ['state', 'State', null, true, r => r.state
    ? `<span class="if-pill if-state-${String(r.state).toLowerCase() === 'up' ? 'up' : 'down'}">${ifEsc(r.state)}</span>` : '—'],
  ['type', 'Type', null, true],
  ['mac_address', 'MAC address', null, false],
  ['ip_address', 'IP address', null, true],
  ['connected', 'Wi-Fi', r => r.connected == null ? null : (r.connected ? 'connected' : 'not connected'), true,
    r => r.connected == null ? '—'
      : `<span class="if-conn ${r.connected ? 'on' : 'off'}"><span class="if-dot" aria-hidden="true"></span>${r.connected ? 'connected' : 'not connected'}</span>`],
  ['ssid', 'SSID', null, true],
  ['bssid', 'BSSID', null, false],
  ['frequency_mhz', 'Frequency', r => r.frequency_mhz != null ? `${r.frequency_mhz} MHz` : null, false],
  ['band', 'Band', null, true],
  ['signal_dbm', 'Signal', r => r.signal_dbm != null ? `${r.signal_dbm} dBm` : null, true, r => interfacesSignalHtml(r.signal_dbm)],
  ['rx_bitrate_mbps', 'RX', r => r.rx_bitrate_mbps != null ? `${r.rx_bitrate_mbps} Mbps` : null, true],
  ['tx_bitrate_mbps', 'TX', r => r.tx_bitrate_mbps != null ? `${r.tx_bitrate_mbps} Mbps` : null, true],
  ['gateway', 'Gateway', null, false],
  ['key_mgmt', 'Key mgmt', null, false],
  ['radio_type', 'Radio type', null, true],
  // Wi-Fi 7 addressing - see wifi7LinkRows (detail-page.js) and pi_agent
  // WifiMixin._wifi7_link_fields. All empty for a pre-Wi-Fi 7 connection.
  ['mlo', 'MLO', r => r.mlo == null ? null : (r.mlo ? 'yes' : 'no'), false],
  ['mld_address', 'MLD address', null, false],
  ['ap_mld_address', 'AP MLD address', null, false],
  ['mlo_links', 'Links (STA ↔ AP)', r => (r.mlo_links && r.mlo_links.length)
    ? r.mlo_links.map((l, i) =>
        `${l.link_id ?? i}${l.band ? ` (${l.band})` : ''}: ${l.sta_address || '—'} ↔ ${l.ap_address || '—'}`
      ).join('; ')
    : null, false],
];

// Signal as four bars plus the dBm, coloured by quality.
function interfacesSignalHtml(dbm) {
  if (dbm == null) return '—';
  const level = dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -75 ? 2 : 1;
  const quality = ['', 'poor', 'fair', 'good', 'great'][level];
  const bars = [1, 2, 3, 4].map(n => `<i class="${n <= level ? 'on' : ''}"></i>`).join('');
  return `<span class="if-signal if-sig-${quality}" title="${quality}"><span class="if-bars" aria-hidden="true">${bars}</span>${dbm} dBm</span>`;
}

function interfacesColumnByKey(key) {
  return INTERFACES_TAB_COLUMNS.find(([k]) => k === key);
}

function interfacesText(r, key) {
  const [, , get] = interfacesColumnByKey(key);
  return get ? get(r) : r[key];
}

// --- remembered choices -------------------------------------------------

const IF_STATE_KEY = 'pi_fleet_interfaces_view';
const IF_DEFAULT_STATE = {
  q: '', pi: '', type: '', band: '', connectedOnly: false, columnFilters: false,
  columns: INTERFACES_TAB_COLUMNS.filter(c => c[3]).map(c => c[0]),
  filters: {},
};
let ifState = { ...IF_DEFAULT_STATE };
try {
  const saved = JSON.parse(localStorage.getItem(IF_STATE_KEY) || 'null');
  if (saved && typeof saved === 'object') {
    ifState = { ...IF_DEFAULT_STATE, ...saved, filters: saved.filters || {} };
    ifState.columns = (saved.columns || IF_DEFAULT_STATE.columns).filter(k => interfacesColumnByKey(k));
    if (!ifState.columns.length) ifState.columns = IF_DEFAULT_STATE.columns;
  }
} catch { /* storage blocked or corrupt - defaults */ }

function ifSaveState() {
  try { localStorage.setItem(IF_STATE_KEY, JSON.stringify(ifState)); } catch { /* storage blocked */ }
}

function ifVisibleColumns() {
  return INTERFACES_TAB_COLUMNS.filter(c => ifState.columns.includes(c[0]));
}

// Last-fetched, unfiltered rows - kept so typing into a filter (or the next
// 5s poll landing a fresh fetch) can both re-derive the visible table
// without needing a round-trip of their own.
let interfacesRawRows = [];
let interfacesLastSig = null;

// null = default order (grouped by Pi, then interface name - see below).
let interfacesSortKey = null;
let interfacesSortDir = 1;   // 1 = ascending, -1 = descending

// --- filtering + sorting ---------------------------------------------------

function interfacesRowMatchesFilters(r) {
  if (ifState.pi && r.pi_id !== ifState.pi) return false;
  if (ifState.type && r.type !== ifState.type) return false;
  if (ifState.band && r.band !== ifState.band) return false;
  if (ifState.connectedOnly && !r.connected) return false;
  const q = ifState.q.trim().toLowerCase();
  if (q && !INTERFACES_TAB_COLUMNS.some(([key]) =>
    String(interfacesTabCellValue(interfacesText(r, key))).toLowerCase().includes(q))) return false;
  if (ifState.columnFilters) {
    for (const [key, raw] of Object.entries(ifState.filters)) {
      const f = String(raw || '').trim().toLowerCase();
      if (!f || !ifState.columns.includes(key)) continue;
      if (!String(interfacesTabCellValue(interfacesText(r, key))).toLowerCase().includes(f)) return false;
    }
  }
  return true;
}

// null/undefined always sort last regardless of direction - a missing
// value isn't meaningfully "less than" or "greater than" a real one, and
// burying it at the bottom either way reads better than it jumping to the
// top on a descending sort.
function interfacesCompareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const an = Number(a), bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && a !== '' && b !== '') return an - bn;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

function interfacesSortRows(rows) {
  if (!interfacesSortKey) {
    // Grouped by Pi, then by interface name, so one Pi's radios sit
    // together instead of interleaving with everyone else's as rows arrive
    // in whatever order the buffer happens to return.
    return [...rows].sort((a, b) =>
      a.pi_id === b.pi_id ? a.interface.localeCompare(b.interface) : a.pi_id.localeCompare(b.pi_id));
  }
  // Sort on the raw value where there is one (numbers sort as numbers).
  const val = r => (r[interfacesSortKey] !== undefined ? r[interfacesSortKey] : interfacesText(r, interfacesSortKey));
  return [...rows].sort((a, b) => {
    const va = val(a), vb = val(b);
    // Missing values stay last in both directions, so only real values
    // take the direction.
    if (va == null || vb == null) return interfacesCompareValues(va, vb);
    return interfacesSortDir * interfacesCompareValues(va, vb);
  });
}

// --- rendering --------------------------------------------------------------

function renderInterfacesHead() {
  const cols = ifVisibleColumns();
  document.getElementById('interfacesSortRow').innerHTML = cols.map(([key, label]) => {
    const dir = key === interfacesSortKey ? (interfacesSortDir === 1 ? 'asc' : 'desc') : '';
    return `<th data-key="${key}" data-dir="${dir}" class="${dir ? 'sorted' : ''}" tabindex="0"
              aria-sort="${dir ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${ifEsc(label)}</th>`;
  }).join('');
  const filterRow = document.getElementById('interfacesFilterRow');
  filterRow.classList.toggle('hidden', !ifState.columnFilters);
  filterRow.innerHTML = cols.map(([key, label]) =>
    `<th><input type="text" class="table-filter-input" data-key="${key}" placeholder="Filter…"
         aria-label="Filter ${ifEsc(label)}" value="${ifEsc(ifState.filters[key] || '')}"></th>`).join('');
}

function renderInterfacesQuickFilters() {
  const fill = (id, values, allLabel, current) => {
    const el = document.getElementById(id);
    const list = current && !values.includes(current) ? [current, ...values] : values;
    el.innerHTML = `<option value="">${allLabel}</option>` + list.map(v => `<option value="${ifEsc(v)}">${ifEsc(v)}</option>`).join('');
    el.value = current || '';
  };
  const uniq = key => [...new Set(interfacesRawRows.map(r => r[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
  fill('ifPiFilter', uniq('pi_id'), 'All Pis', ifState.pi);
  fill('ifTypeFilter', uniq('type'), 'All types', ifState.type);
  fill('ifBandFilter', uniq('band'), 'All bands', ifState.band);
  document.getElementById('ifConnectedOnly').checked = ifState.connectedOnly;
  document.getElementById('ifColumnFiltersBtn').setAttribute('aria-pressed', String(ifState.columnFilters));
  document.getElementById('ifColumnFiltersBtn').classList.toggle('active', ifState.columnFilters);
  document.getElementById('ifColumnsMenu').innerHTML = INTERFACES_TAB_COLUMNS.map(([key, label]) => `
    <label class="if-col-option"><input type="checkbox" data-col="${key}" ${ifState.columns.includes(key) ? 'checked' : ''}
      ${key === 'pi_id' || key === 'interface' ? 'disabled' : ''}> ${ifEsc(label)}</label>`).join('')
    + '<button type="button" class="res-link if-col-reset" id="ifColumnsReset">Reset to default columns</button>';
}

// One header row per Pi in the default (grouped) order.
function interfacesGroupHeader(piId, rows, colCount) {
  const pi = (typeof pis !== 'undefined' ? pis : []).find(p => p.pi_id === piId);
  const wifi = rows.filter(r => r.connected != null);
  const conn = wifi.filter(r => r.connected).length;
  return `
    <tr class="if-group"><td colspan="${colCount}">
      <a href="#pi/${encodeURIComponent(piId)}" class="pi-id-link if-group-pi">${ifEsc(piId)}</a>
      ${pi ? statusBadge(pi.status) : ''}
      ${pi && pi.ip_address ? `<span class="hint">${ifEsc(pi.ip_address)}</span>` : ''}
      ${pi && pi.role ? `<span class="hint">· ${ifEsc(pi.role)}</span>` : ''}
      <span class="if-group-sum">${rows.length} interface${rows.length === 1 ? '' : 's'}${wifi.length ? ` · ${conn}/${wifi.length} Wi-Fi connected` : ''}</span>
    </td></tr>`;
}

function applyInterfacesFilter() {
  const body = document.getElementById('interfacesTableBody');
  const cols = ifVisibleColumns();
  const all = interfacesRawRows;
  const filtered = all.filter(interfacesRowMatchesFilters);
  const conn = filtered.filter(r => r.connected).length;
  document.getElementById('ifSummary').textContent = all.length
    ? `${filtered.length}${filtered.length !== all.length ? ` of ${all.length}` : ''} interfaces · ${new Set(filtered.map(r => r.pi_id)).size} Pis · ${conn} Wi-Fi connected`
    : '';
  if (!all.length) {
    body.innerHTML = `<tr><td colspan="${cols.length}" class="pi-log-empty">no interfaces reported yet</td></tr>`;
    return;
  }
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="${cols.length}" class="pi-log-empty">no interfaces match the filters</td></tr>`;
    return;
  }
  const sorted = interfacesSortRows(filtered);
  const rowHtml = r => `<tr>${cols.map(([key, , get, , html]) =>
    `<td class="if-c-${key}">${html ? html(r) : ifEsc(String(interfacesTabCellValue(get ? get(r) : r[key])))}</td>`).join('')}</tr>`;
  if (interfacesSortKey) {
    body.innerHTML = sorted.map(rowHtml).join('');
    return;
  }
  const out = [];
  let i = 0;
  while (i < sorted.length) {
    const piId = sorted[i].pi_id;
    const group = [];
    while (i < sorted.length && sorted[i].pi_id === piId) group.push(sorted[i++]);
    out.push(interfacesGroupHeader(piId, group, cols.length), ...group.map(rowHtml));
  }
  body.innerHTML = out.join('');
}

function rerenderInterfaces() {
  renderInterfacesHead();
  applyInterfacesFilter();
}

function renderInterfacesTab(rows) {
  // The 5s poll usually brings back the same data - skip the redraw then,
  // so keyboard focus and an open menu aren't disturbed.
  const sig = JSON.stringify(rows);
  if (sig === interfacesLastSig) return;
  interfacesLastSig = sig;
  interfacesRawRows = rows;
  renderInterfacesQuickFilters();
  rerenderInterfaces();
}

function ifSet(changes) {
  Object.assign(ifState, changes);
  ifSaveState();
  renderInterfacesQuickFilters();
  rerenderInterfaces();
}

// --- wiring -------------------------------------------------------------

document.getElementById('ifSearch').value = ifState.q;
document.getElementById('ifSearch').addEventListener('input', ifDebounce((e) => {
  ifState.q = e.target.value;
  ifSaveState();
  applyInterfacesFilter();
}, 150));
document.getElementById('ifPiFilter').addEventListener('change', (e) => ifSet({ pi: e.target.value }));
document.getElementById('ifTypeFilter').addEventListener('change', (e) => ifSet({ type: e.target.value }));
document.getElementById('ifBandFilter').addEventListener('change', (e) => ifSet({ band: e.target.value }));
document.getElementById('ifConnectedOnly').addEventListener('change', (e) => ifSet({ connectedOnly: e.target.checked }));
document.getElementById('ifColumnFiltersBtn').addEventListener('click', () => ifSet({ columnFilters: !ifState.columnFilters }));
document.getElementById('ifClearFilters').addEventListener('click', () => {
  document.getElementById('ifSearch').value = '';
  ifSet({ q: '', pi: '', type: '', band: '', connectedOnly: false, filters: {} });
});

// Per-column filter row (delegated - it's rebuilt with the columns).
document.getElementById('interfacesFilterRow').addEventListener('input', ifDebounce((e) => {
  if (!e.target.dataset.key) return;
  ifState.filters[e.target.dataset.key] = e.target.value;
  ifSaveState();
  applyInterfacesFilter();
}, 150));

// Sorting: click (or Enter/Space on) a header; a third click returns to
// the grouped-by-Pi order.
function interfacesSortBy(key) {
  if (interfacesSortKey === key) {
    if (interfacesSortDir === 1) interfacesSortDir = -1;
    else { interfacesSortKey = null; interfacesSortDir = 1; }
  } else {
    interfacesSortKey = key;
    interfacesSortDir = 1;
  }
  rerenderInterfaces();
}
document.getElementById('interfacesSortRow').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-key]');
  if (th) interfacesSortBy(th.dataset.key);
});
document.getElementById('interfacesSortRow').addEventListener('keydown', (e) => {
  const th = e.target.closest('th[data-key]');
  if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); interfacesSortBy(th.dataset.key); }
});

// Columns menu
function ifCloseColumnsMenu() {
  document.getElementById('ifColumnsMenu').classList.add('hidden');
  document.getElementById('ifColumnsBtn').setAttribute('aria-expanded', 'false');
}
document.getElementById('ifColumnsBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = document.getElementById('ifColumnsMenu');
  const opening = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !opening);
  e.currentTarget.setAttribute('aria-expanded', String(opening));
  if (opening) menu.querySelector('input:not([disabled])')?.focus();
});
document.getElementById('ifColumnsMenu').addEventListener('change', (e) => {
  const key = e.target.dataset.col;
  if (!key) return;
  const set = new Set(ifState.columns);
  if (e.target.checked) set.add(key); else set.delete(key);
  // Keep the table's own column order, whatever order they were ticked in.
  ifState.columns = INTERFACES_TAB_COLUMNS.map(c => c[0]).filter(k => set.has(k));
  if (interfacesSortKey && !set.has(interfacesSortKey)) interfacesSortKey = null;
  ifSaveState();
  rerenderInterfaces();
});
document.getElementById('ifColumnsMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  if (e.target.id !== 'ifColumnsReset') return;
  ifState.columns = [...IF_DEFAULT_STATE.columns];
  ifSaveState();
  renderInterfacesQuickFilters();
  rerenderInterfaces();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.if-columns')) ifCloseColumnsMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('ifColumnsMenu').classList.contains('hidden')) {
    ifCloseColumnsMenu();
    document.getElementById('ifColumnsBtn').focus();
  }
});

renderInterfacesQuickFilters();
rerenderInterfaces();

async function fetchAndRenderInterfacesTab() {
  try {
    const res = await apiFetch(`${API}/pis/interface-status`);
    if (!res.ok) return;
    renderInterfacesTab(await res.json());
  } catch {
    // backend unreachable; keep showing the last known table
  }
}

// Called every 5s regardless of which tab is showing (see fleet-table.js's
// renderPis) - skips the fetch unless this tab is actually visible.
async function refreshInterfacesTab() {
  if (!document.getElementById('interfaces').classList.contains('active')) return;
  await fetchAndRenderInterfacesTab();
}

// Fires whenever this tab actually becomes the visible view - a click, a
// reload landing directly on #interfaces, or Back/Forward navigating into
// it (see showTabView in detail-page.js) - not just a literal click on the
// tab button, which would miss the other two.
document.addEventListener('tabshown', (e) => {
  if (e.detail.viewId === 'interfaces') fetchAndRenderInterfacesTab();
});
