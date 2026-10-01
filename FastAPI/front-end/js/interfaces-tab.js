// --- Interfaces tab: flat, fleet-wide table of every managed Pi's every
// interface, straight from the same InterfaceStatus buffer the Fleet
// table's per-interface cards and the Pi detail page read (continuously
// refreshed server-side by pi_agent - see PiAgent._interface_status_loop
// and routers/Pis.get_all_interface_status). Refreshed on the same 5s
// cadence as the rest of the app (see refreshPis in fleet-table.js) - no
// command round-trip of its own, just a DB read.

function interfacesTabCellValue(v) {
  return v === null || v === undefined || v === '' ? '—' : v;
}

const INTERFACES_TAB_COLUMNS = [
  ['pi_id'],
  ['interface'],
  ['state'],
  ['type'],
  ['mac_address'],
  ['ip_address'],
  ['connected', r => r.connected == null ? null : (r.connected ? 'yes' : 'no')],
  ['ssid'],
  ['bssid'],
  ['frequency_mhz', r => r.frequency_mhz != null ? `${r.frequency_mhz} MHz` : null],
  ['band'],
  ['signal_dbm', r => r.signal_dbm != null ? `${r.signal_dbm} dBm` : null],
  ['rx_bitrate_mbps', r => r.rx_bitrate_mbps != null ? `${r.rx_bitrate_mbps} Mbps` : null],
  ['tx_bitrate_mbps', r => r.tx_bitrate_mbps != null ? `${r.tx_bitrate_mbps} Mbps` : null],
  ['gateway'],
  ['key_mgmt'],
  ['radio_type'],
];

// Last-fetched, unfiltered rows - kept so typing into a filter (or the next
// 5s poll landing a fresh fetch) can both re-derive the visible table
// without needing a round-trip of their own.
let interfacesRawRows = [];

function interfacesColumnByKey(key) {
  return INTERFACES_TAB_COLUMNS.find(([k]) => k === key);
}

// Every non-empty filter input has to match (AND, not OR) - reads live
// straight from the (static, never-rebuilt - see index.html) filter row,
// so there's no separate filter-state object to keep in sync.
function interfacesRowMatchesFilters(r) {
  const inputs = document.querySelectorAll('#interfacesFilterRow .table-filter-input');
  for (const input of inputs) {
    const q = input.value.trim().toLowerCase();
    if (!q) continue;
    const [key, get] = interfacesColumnByKey(input.dataset.key);
    const value = interfacesTabCellValue(get ? get(r) : r[key]);
    if (!String(value).toLowerCase().includes(q)) return false;
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

// null = default order (grouped by Pi, then interface name - see below).
let interfacesSortKey = null;
let interfacesSortDir = 1;   // 1 = ascending, -1 = descending

function interfacesUpdateSortHeaders() {
  document.querySelectorAll('#interfacesSortRow th').forEach(th => {
    th.classList.toggle('sorted', th.dataset.key === interfacesSortKey);
    th.dataset.dir = th.dataset.key === interfacesSortKey ? (interfacesSortDir === 1 ? 'asc' : 'desc') : '';
  });
}

function interfacesSortRows(rows) {
  if (!interfacesSortKey) {
    // Grouped by Pi, then by interface name, so one Pi's radios sit
    // together instead of interleaving with everyone else's as rows arrive
    // in whatever order the buffer happens to return.
    return [...rows].sort((a, b) =>
      a.pi_id === b.pi_id ? a.interface.localeCompare(b.interface) : a.pi_id.localeCompare(b.pi_id));
  }
  const [, get] = interfacesColumnByKey(interfacesSortKey);
  return [...rows].sort((a, b) =>
    interfacesSortDir * interfacesCompareValues(
      get ? get(a) : a[interfacesSortKey], get ? get(b) : b[interfacesSortKey],
    ));
}

function applyInterfacesFilter() {
  const body = document.getElementById('interfacesTableBody');
  if (!interfacesRawRows.length) {
    body.innerHTML = `<tr><td colspan="${INTERFACES_TAB_COLUMNS.length}" class="pi-log-empty">no interfaces reported yet</td></tr>`;
    return;
  }
  const filtered = interfacesRawRows.filter(interfacesRowMatchesFilters);
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="${INTERFACES_TAB_COLUMNS.length}" class="pi-log-empty">no interfaces match the filters</td></tr>`;
    return;
  }
  const sorted = interfacesSortRows(filtered);
  body.innerHTML = sorted.map(r => `
    <tr>${INTERFACES_TAB_COLUMNS.map(([key, get]) =>
      `<td>${interfacesTabCellValue(get ? get(r) : r[key])}${key === 'interface' && r.wifi7_capable ? ' ' + WIFI7_TAG_HTML : ''}</td>`
    ).join('')}</tr>
  `).join('');
}

function renderInterfacesTab(rows) {
  interfacesRawRows = rows;
  applyInterfacesFilter();
}

document.querySelectorAll('#interfacesFilterRow .table-filter-input').forEach(input => {
  input.addEventListener('input', applyInterfacesFilter);
});

document.querySelectorAll('#interfacesSortRow th').forEach(th => {
  th.addEventListener('click', () => {
    if (interfacesSortKey === th.dataset.key) {
      interfacesSortDir = -interfacesSortDir;
    } else {
      interfacesSortKey = th.dataset.key;
      interfacesSortDir = 1;
    }
    interfacesUpdateSortHeaders();
    applyInterfacesFilter();
  });
});

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
