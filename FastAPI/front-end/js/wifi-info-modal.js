// --- Nearby Hotspot popup: detailed per-AP scan table for one Pi interface -
// Triggered from the "Nearby Hotspot" button on a wifi-capable interface card
// (see renderDetailInterfaceList). Live-updated over the same /ws/live/{piId}
// firehose fleet-table.js's log panels use (see connectPiLog there) - every
// wifi_detail_scan result the backend relays for this interface (pi_agent's
// PiAgent._wifi_background_scan_loop publishes one roughly every
// WIFI_BACKGROUND_SCAN_INTERVAL_SECONDS) triggers an immediate re-fetch of
// GET /pis/{id}/wifi-history, so the table updates as soon as a scan lands
// instead of on a fixed poll cadence. A slow fallback poll stays as a
// safety net in case the socket drops or never connects.
const WIFI_INFO_FALLBACK_POLL_MS = 20000;

const WIFI_INFO_COLUMNS = [
  ['SSID', net => net.ssid || '(hidden)'],
  ['MAC Address', net => net.bssid],
  ['PHY Type', net => net.phy_type],
  ['RSSI', net => net.rssi_dbm != null ? `${net.rssi_dbm} dBm` : null],
  ['Signal Quality', net => net.signal_quality_percent != null ? `${net.signal_quality_percent}%` : null],
  ['Average Signal Quality', net => net.avg_signal_percent != null ? `${net.avg_signal_percent}%` : null],
  ['Frequency', net => net.frequency_mhz != null ? `${net.frequency_mhz} MHz` : null],
  ['Channel', net => net.channel],
  ['Information Size', net => net.information_size],
  ['Elements Count', net => net.elements_count],
  ['Company', net => net.company],
  ['Router Model', net => net.router_model],
  ['Router Name', net => net.router_name],
  ['Security', net => net.security],
  ['Cipher', net => net.cipher],
  ['Maximum Speed', net => net.max_speed_mbps != null ? `${net.max_speed_mbps} Mbps` : null],
  ['Channel Width', net => net.channel_width],
  ['Channels Range', net => net.channels_range],
  ['BSS Type', net => net.bss_type],
  ['WPS Support', net => net.wps_support == null ? null : (net.wps_support ? 'Yes' : 'No')],
  ['First Detection', net => net.first_seen ? formatVnDateTime(net.first_seen) : null],
  ['Last Detection', net => net.last_seen ? formatVnDateTime(net.last_seen) : null],
  ['Detection Count', net => net.detection_count],
  ['Start Time', net => net.first_seen ? formatVnDateTime(net.first_seen) : null],
  ['Minimum Signal Quality', net => net.min_signal_percent != null ? `${net.min_signal_percent}%` : null],
  ['Maximum Signal Quality', net => net.max_signal_percent != null ? `${net.max_signal_percent}%` : null],
  ['802.11 Standards', net => net.phy_type],
  ['Connected', net => net.connected == null ? null : (net.connected ? 'Yes' : 'No')],
  ['Stations Count', net => net.stations_count],
  ['Channel Utilization', net => net.channel_utilization_percent != null ? `${net.channel_utilization_percent}%` : null],
  ['Country Code', net => net.country_code],
  ['Description', net => net.description],
  ['MAC Group', net => net.mac_group],
];

let wifiInfoModalState = null;   // { piId, iface, timer, overlay } while the scan-list popup is open
let wifiHotspotModalState = null; // { overlay } while a hotspot's own detail popup (double-click) is open

function closeWifiHotspotDetailModal() {
  if (!wifiHotspotModalState) return;
  wifiHotspotModalState.overlay.remove();
  wifiHotspotModalState = null;
}

function closeWifiInfoModal() {
  closeWifiHotspotDetailModal();
  if (!wifiInfoModalState) return;
  clearInterval(wifiInfoModalState.fallbackTimer);
  if (wifiInfoModalState.ws) wifiInfoModalState.ws.close();
  wifiInfoModalState.overlay.remove();
  wifiInfoModalState = null;
  document.removeEventListener('keydown', onWifiInfoModalKeydown);
}

// The hotspot detail popup is stacked on top of the scan-list one - Escape
// should close just the top one, not both at once.
function onWifiInfoModalKeydown(e) {
  if (e.key !== 'Escape') return;
  if (wifiHotspotModalState) closeWifiHotspotDetailModal();
  else closeWifiInfoModal();
}

function wifiInfoCellValue(v) {
  return v === null || v === undefined || v === '' ? '—' : v;
}

// After a successful connect from the hotspot detail popup, refresh
// whichever wifi icon(s) might be showing this (piId, iface) - it can be
// reached from both the Fleet table's interface cards and the Pi detail
// page's, and either, both, or neither may currently exist in the DOM.
// Same reasoning/pattern as renderWifiNetworkCard and wifi-scan.js's
// pollCommand use for their own Connect buttons.
function wifiInfoRefreshWifiIcons(piId, iface) {
  const entry = typeof piRows !== 'undefined' && piRows.get(piId);
  const cardState = entry && entry.ifaceCards.get(iface);
  if (entry && cardState) {
    entry.ifaceDetailsCache = null;
    entry.ifaceDetailsPromise = null;
    refreshFleetWifiIcon(piId, entry, cardState);
  }
  if (typeof detailPiId !== 'undefined' && detailPiId === piId) {
    delete detailLinkInfoCache[iface];
    detailIfaceDetailsCache = null;
    detailIfaceDetailsPromise = null;
    refreshWifiIcon(piId, iface);
  }
}

// Connect/Disconnect control for the hotspot detail popup - same fields/
// flow as every other Connect button in the app (renderWifiNetworkCard in
// detail-page.js): password field for a secured network, "remember
// password", connectWifiWithRetry, then refresh whatever icon(s) show this
// interface's state.
function wifiInfoConnectSectionHtml(net) {
  const open = isOpenSecurity(net.security);
  return `
    <div class="wifi-connect-row">
      ${open ? '' : wifiPasswordFieldHtml(net)}
      <select class="field wifi-max-standard" title="Cap the 802.11 standard this radio negotiates at">
        <option value="">max standard: auto</option>
        <option value="be">802.11be (Wi-Fi 7) max</option>
        <option value="ax">802.11ax (Wi-Fi 6) max</option>
        <option value="ac">802.11ac (Wi-Fi 5) max</option>
        <option value="n">802.11n (Wi-Fi 4) max</option>
        <option value="legacy">802.11a/g max</option>
      </select>
      <button type="button" class="wifi-connect-btn">Connect</button>
    </div>
    <div class="wifi-connect-status hint"></div>
  `;
}

function wireWifiInfoConnectSection(container, piId, iface, net) {
  const statusEl = container.querySelector('.wifi-connect-status');
  const connectBtn = container.querySelector('.wifi-connect-btn');
  if (!connectBtn) return;
  connectBtn.addEventListener('click', async () => {
    const passwordInput = container.querySelector('.wifi-connect-password');
    const password = passwordInput && passwordInput.value ? passwordInput.value : undefined;
    const maxStandardInput = container.querySelector('.wifi-max-standard');
    const max_standard = maxStandardInput && maxStandardInput.value ? maxStandardInput.value : undefined;
    connectBtn.disabled = true;
    statusEl.textContent = 'Connecting…';
    try {
      const result = await connectWifiWithRetry(piId, {
        ssid: net.ssid || undefined,
        bssid: net.bssid || undefined,
        password,
        interface: iface,
        max_standard,
      });
      statusEl.textContent = result && result.connected
        ? `Connected.${result.max_standard_applied === false ? ' Note: this Pi\'s wpa_supplicant build doesn\'t support capping to ' + result.max_standard + ' - connected at the radio\'s normal max instead.' : ''}`
        : `Failed to connect${wifiFailureDetail(result) ? ': ' + wifiFailureDetail(result) : ''}`;
      if (result && result.connected) {
        applyWifiPasswordMemory(container, net, password);
        wifiInfoRefreshWifiIcons(piId, iface);
      }
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
    } finally {
      connectBtn.disabled = false;
    }
  });
}

// One hotspot's full detail (every WIFI_INFO_COLUMNS field), opened by
// double-clicking its row in the scan-list popup - a static snapshot of
// that row as of the double-click, with its own explicit close button and
// a Connect control for that AP on the same (piId, iface) the popup was
// opened for.
function openWifiHotspotDetailModal(piId, iface, net) {
  closeWifiHotspotDetailModal();

  const overlay = document.createElement('div');
  overlay.className = 'wifi-info-overlay wifi-hotspot-detail-overlay';
  overlay.innerHTML = `
    <div class="wifi-info-modal wifi-hotspot-detail-modal">
      <div class="wifi-info-modal-header">
        <span>${net.ssid || '(hidden)'} &mdash; ${net.bssid || ''}</span>
        <span class="wifi-info-modal-status hint"></span>
        <button type="button" class="icon-btn wifi-hotspot-detail-close" title="Close">&times;</button>
      </div>
      <div class="wifi-info-modal-body">
        <table class="result-table">${WIFI_INFO_COLUMNS.map(([k, get]) =>
          `<tr><td class="result-key">${k}</td><td class="result-value">${wifiInfoCellValue(get(net))}</td></tr>`
        ).join('')}</table>
        ${wifiInfoConnectSectionHtml(net)}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeWifiHotspotDetailModal();
  });
  overlay.querySelector('.wifi-hotspot-detail-close').addEventListener('click', closeWifiHotspotDetailModal);
  wireWifiInfoConnectSection(overlay.querySelector('.wifi-info-modal-body'), piId, iface, net);

  wifiHotspotModalState = { overlay };
}

// Every non-empty filter input has to match (AND, not OR). Prefix match,
// ignoring case (spaces still count), so "ho" finds "Home-5G" but not
// "MyHotspot".
function wifiInfoRowMatchesFilters(bodyEl, net) {
  const inputs = bodyEl.querySelectorAll('.table-filter-input');
  for (const input of inputs) {
    const q = input.value.toLowerCase();
    if (!q) continue;
    const col = WIFI_INFO_COLUMNS.find(([label]) => label === input.dataset.key);
    const value = wifiInfoCellValue(col[1](net));
    if (!String(value).toLowerCase().startsWith(q)) return false;
  }
  return true;
}

// null/undefined always sort last regardless of direction - a missing
// value isn't meaningfully "less than" or "greater than" a real one.
function wifiInfoCompareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const an = Number(a), bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && a !== '' && b !== '') return an - bn;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

// null = whatever order the API returned (most-recently-seen first - see
// routers/Pis.get_wifi_scan_history).
let wifiInfoSortKey = null;
let wifiInfoSortDir = 1;   // 1 = ascending, -1 = descending

function wifiInfoUpdateSortHeaders(bodyEl) {
  bodyEl.querySelectorAll('.table-sort-row th').forEach(th => {
    th.classList.toggle('sorted', th.dataset.key === wifiInfoSortKey);
    th.dataset.dir = th.dataset.key === wifiInfoSortKey ? (wifiInfoSortDir === 1 ? 'asc' : 'desc') : '';
  });
}

function wifiInfoSortNetworks(networks) {
  if (!wifiInfoSortKey) return networks;
  const col = WIFI_INFO_COLUMNS.find(([label]) => label === wifiInfoSortKey);
  return [...networks].sort((a, b) => wifiInfoSortDir * wifiInfoCompareValues(col[1](a), col[1](b)));
}

function renderWifiInfoTbody(bodyEl, networks) {
  const tbody = bodyEl.querySelector('.wifi-info-table tbody');
  if (!networks.length) {
    tbody.innerHTML = `<tr><td colspan="${WIFI_INFO_COLUMNS.length}" class="pi-log-empty">no networks found</td></tr>`;
    return;
  }
  const filtered = wifiInfoSortNetworks(networks.filter(net => wifiInfoRowMatchesFilters(bodyEl, net)));
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="${WIFI_INFO_COLUMNS.length}" class="pi-log-empty">no networks match the filters</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map((net, i) => `
    <tr class="wifi-info-row" data-index="${i}" title="Double-click for full details">
      ${WIFI_INFO_COLUMNS.map(([, get]) => `<td>${wifiInfoCellValue(get(net))}</td>`).join('')}
    </tr>
  `).join('');

  tbody.querySelectorAll('.wifi-info-row').forEach(row => {
    row.addEventListener('dblclick', () => {
      // Only one Nearby Hotspot popup can be open at a time (see
      // wifiInfoModalState) - reading piId/iface from it here instead of
      // threading them through every render function in between.
      if (!wifiInfoModalState) return;
      openWifiHotspotDetailModal(wifiInfoModalState.piId, wifiInfoModalState.iface, filtered[Number(row.dataset.index)]);
    });
  });
}

// The header (labels + filter row) is only ever built once per popup open -
// rebuilding it on every 3s poll (the old behavior) would wipe out whatever
// the user had typed into a filter input each time. Only the tbody, via
// renderWifiInfoTbody, is rebuilt per poll.
let wifiInfoLastNetworks = [];

function renderWifiInfoTable(bodyEl, networks) {
  if (!bodyEl.querySelector('.wifi-info-table')) {
    bodyEl.innerHTML = `
      <table class="wifi-info-table">
        <thead>
          <tr class="table-sort-row">${WIFI_INFO_COLUMNS.map(([label]) => `<th data-key="${label}">${label}</th>`).join('')}</tr>
          <tr class="table-filter-row">${WIFI_INFO_COLUMNS.map(([label]) =>
            `<th><input type="text" class="table-filter-input" data-key="${label}" placeholder="Filter…"></th>`
          ).join('')}</tr>
        </thead>
        <tbody></tbody>
      </table>
    `;
    bodyEl.querySelectorAll('.table-filter-input').forEach(input => {
      input.addEventListener('input', () => renderWifiInfoTbody(bodyEl, wifiInfoLastNetworks));
    });
    bodyEl.querySelectorAll('.table-sort-row th').forEach(th => {
      th.addEventListener('click', () => {
        if (wifiInfoSortKey === th.dataset.key) {
          wifiInfoSortDir = -wifiInfoSortDir;
        } else {
          wifiInfoSortKey = th.dataset.key;
          wifiInfoSortDir = 1;
        }
        wifiInfoUpdateSortHeaders(bodyEl);
        renderWifiInfoTbody(bodyEl, wifiInfoLastNetworks);
      });
    });
    // The sort choice (wifiInfoSortKey/-Dir) persists across popup opens
    // (a plain module-level global, not reset per-open) - so a freshly
    // built skeleton needs its arrow indicator set to match immediately,
    // not just after the next click.
    wifiInfoUpdateSortHeaders(bodyEl);
  }

  // A poll landing empty (a background-scan hiccup, or a brief gap between
  // WIFI_BACKGROUND_SCAN_INTERVAL_SECONDS cycles) shouldn't blank out a
  // table that already has real rows in it - keep showing the last
  // known-good networks instead of flashing to "no networks found" every
  // time one cycle comes back empty. Only actually render empty if this
  // popup has never had real data to show at all yet.
  if (!networks.length && wifiInfoLastNetworks.length) {
    return false;
  }

  wifiInfoLastNetworks = networks;
  renderWifiInfoTbody(bodyEl, networks);
  return true;
}

async function refreshWifiInfoModal(bodyEl, statusEl, piId, iface) {
  try {
    const res = await apiFetch(`${API}/pis/${encodeURIComponent(piId)}/wifi-history?interface=${encodeURIComponent(iface)}`);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const networks = await res.json();
    // Only bail out on the very first load - a transient failure on a later
    // 5s poll shouldn't blank out the last-good table the user is looking at.
    const usedFreshData = renderWifiInfoTable(bodyEl, networks);
    statusEl.textContent = usedFreshData
      ? `Buffered as of ${formatVnTime()}`
      : `Buffered as of ${formatVnTime()} (no networks this cycle - showing last known)`;
  } catch (err) {
    if (!bodyEl.querySelector('.wifi-info-table')) {
      bodyEl.innerHTML = `<div class="pi-log-empty">failed to load: ${err.message}</div>`;
    }
    statusEl.textContent = `Last update failed: ${err.message}`;
  }
}

// Re-scan button: a fresh `iw scan` on the Pi right now (wifi_detail_scan
// with fresh=true - see pi_agent core.py) rather than the background
// cycle's cached results. The backend rolls the result into the same
// wifi-history buffer, so a normal refresh then shows it.
async function rescanWifiInfoModal(btn, bodyEl, statusEl, piId, iface) {
  btn.disabled = true;
  const label = btn.innerHTML;
  btn.innerHTML = 'Scanning&hellip;';
  statusEl.textContent = `Scanning ${iface}…`;
  try {
    const res = await postCmd(piId, 'wifi_detail_scan', { interface: iface, fresh: true });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json();
    const result = await awaitCommandResult(data.command_id, 30);
    if (result && result.error) throw new Error(result.error);
    // The popup may have been closed (or reopened elsewhere) mid-scan.
    if (!wifiInfoModalState || !document.body.contains(bodyEl)) return;
    await refreshWifiInfoModal(bodyEl, statusEl, piId, iface);
  } catch (err) {
    statusEl.textContent = `Re-scan failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

function openWifiInfoModal(piId, iface) {
  closeWifiInfoModal();

  const overlay = document.createElement('div');
  overlay.className = 'wifi-info-overlay';
  overlay.innerHTML = `
    <div class="wifi-info-modal">
      <div class="wifi-info-modal-header">
        <span>Nearby Hotspot &mdash; ${iface}</span>
        <span class="wifi-scanning-indicator" title="pi_agent is continuously scanning this interface in the background">
          <span class="wifi-scanning-dot"></span>Scanning
        </span>
        <span class="wifi-info-modal-status hint"></span>
        <button type="button" class="wifi-info-rescan-btn" title="Run a fresh scan on this interface now instead of waiting for the next background cycle">&#8635; Re-scan</button>
        <button type="button" class="icon-btn wifi-info-modal-close" title="Close">&times;</button>
      </div>
      <div class="wifi-info-modal-body">
        <div class="pi-log-empty">Scanning&hellip;</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeWifiInfoModal();
  });
  overlay.querySelector('.wifi-info-modal-close').addEventListener('click', closeWifiInfoModal);
  document.addEventListener('keydown', onWifiInfoModalKeydown);

  const bodyEl = overlay.querySelector('.wifi-info-modal-body');
  const statusEl = overlay.querySelector('.wifi-info-modal-status');

  const rescanBtn = overlay.querySelector('.wifi-info-rescan-btn');
  rescanBtn.addEventListener('click', () => rescanWifiInfoModal(rescanBtn, bodyEl, statusEl, piId, iface));

  const fallbackTimer = setInterval(() => refreshWifiInfoModal(bodyEl, statusEl, piId, iface), WIFI_INFO_FALLBACK_POLL_MS);
  wifiInfoModalState = { piId, iface, fallbackTimer, overlay, ws: connectWifiInfoLiveScan(piId, iface, bodyEl, statusEl) };
  refreshWifiInfoModal(bodyEl, statusEl, piId, iface);
}

// Opens the same per-device WS firehose fleet-table.js's log panels use
// (see connectPiLog there) and re-fetches the wifi-history buffer the
// moment a wifi_detail_scan result for this exact (piId, iface) comes
// through - live updates without polling at a fixed interval. No
// reconnect-on-close logic here (matching connectPiLog's own behavior) -
// the fallback poll (WIFI_INFO_FALLBACK_POLL_MS) covers the gap if the
// socket drops for the rest of this popup's lifetime.
function connectWifiInfoLiveScan(piId, iface, bodyEl, statusEl) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(withToken(`${proto}://${location.host}/ws/live/${encodeURIComponent(piId)}`));
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.category !== 'result') return;
    const payload = msg.payload || {};
    if (payload.action !== 'wifi_detail_scan' || payload.interface !== iface) return;
    refreshWifiInfoModal(bodyEl, statusEl, piId, iface);
  };
  return ws;
}
