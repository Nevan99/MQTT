// --- Pi detail page ---------------------------------------------------
// Reached by clicking a Pi's id in the fleet table (#pi/<id> in the hash).
// One command bar scoped to just that one Pi, with the exact same action
// list as the fleet command builder (ACTION_PARAMS, in the same order),
// just always targeting this one piId instead of an arbitrary target.

function actionLabel(action) {
  return action.replace(/_/g, ' ');
}

function piInterfaces(piId) {
  const pi = pis.find(p => p.pi_id === piId);
  return (pi && pi.metadata && Array.isArray(pi.metadata.interfaces)) ? pi.metadata.interfaces : [];
}

function renderDetailParamFields(container, actionSelectEl, piId) {
  const fields = ACTION_PARAMS[actionSelectEl.value] || [];
  const interfaces = piInterfaces(piId);
  container.innerHTML = fields.map(f => {
    if (f.type === 'interface') {
      return `<label>${f.label}</label><div class="iface-dropdown-mount" data-param="${f.name}"></div>`;
    }
    return paramFieldHtml(f);
  }).join('');
  applyShowIf(container);

  container.querySelectorAll('.iface-dropdown-mount[data-param]').forEach(mount => {
    const box = buildIfaceDropdown();
    box.dataset.param = mount.dataset.param;
    box.dataset.piId = piId;
    setDropdownOptions(box, interfaces, []);
    mount.replaceWith(box);
  });
}

function collectDetailParams(container) {
  const params = {};
  container.querySelectorAll('[data-param]').forEach(el => {
    if (isHiddenParam(el)) return;
    const name = el.dataset.param;
    if (el.classList.contains('iface-dropdown')) {
      const selected = getDropdownSelected(el);
      if (selected.length) params[name] = selected;
      return;
    }
    if (el.value === '') return;
    params[name] = el.type === 'number' ? Number(el.value) : el.value;
  });
  return params;
}

function detailAddCommandEntry(container, commandId, piId, action) {
  const entry = document.createElement('div');
  entry.className = 'cmd-entry';
  entry.dataset.commandId = commandId;
  entry.innerHTML = `
    <div class="hdr"><span><span class="toggle">&#9660;</span>${action}</span><span><span class="cmd-status pending">pending</span></span></div>
    <div class="result"></div>
  `;
  entry.querySelector('.hdr').addEventListener('click', () => {
    entry.classList.toggle('collapsed');
    entry.querySelector('.toggle').innerHTML = entry.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
  });
  container.prepend(entry);
  if (action === 'nearby_hotspots') renderWifiScanLoading(entry.querySelector('.result'));
  pollCommand(commandId, entry, piId, action);
}

async function sendDetailCommand(actionSelectEl, paramsContainer, resultsContainer, piId) {
  const action = actionSelectEl.value;
  const params = collectDetailParams(paramsContainer);
  const needsInterface = (ACTION_PARAMS[action] || []).some(f => f.type === 'interface');

  // nearby_hotspots is a pure backend DB read now - no MQTT command sent
  // to the Pi at all (see fetchNearbyHotspots/routers/Pis.get_nearby_hotspots)
  // - so it's handled entirely separately from everything below, which is
  // all still real command dispatch.
  if (action === 'nearby_hotspots') {
    const ifaces = params.interfaces || [];
    if (!ifaces.length) {
      alert('Select at least one interface.');
      return;
    }
    try {
      await sendScanWifiFanOut(ifaces.map(iface => ({ piId, interface: iface })), resultsContainer);
    } catch (err) {
      alert(`Command failed: ${err.message}`);
    }
    return;
  }

  try {
    if (needsInterface && Array.isArray(params.interface)) {
      const pickedInterfaces = params.interfaces || params.interface || [];
      if (!pickedInterfaces.length) {
        alert('Select at least one interface.');
        return;
      }
      if (action === 'connect_hotspot') {
        // Also one command - connect_hotspot joins every selected radio to
        // the same AP concurrently and reports per-radio outcomes.
        const res = await postCmd(piId, action, params);
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        return;
      }
      const tasks = params.interface.map(async iface => {
        const res = await postCmd(piId, action, { ...params, interface: iface });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        const data = await res.json();
        detailAddCommandEntry(resultsContainer, data.command_id, data.pi_id, data.action);
      });
      const results = await Promise.allSettled(tasks);
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length) {
        alert(`${failed.length} command(s) failed to send:\n` + failed.map(r => r.reason.message).join('\n'));
      }
    } else {
      const res = await postCmd(piId, action, params);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const data = await res.json();
      detailAddCommandEntry(resultsContainer, data.command_id, data.pi_id, data.action);
    }
  } catch (err) {
    alert(`Command failed: ${err.message}`);
  }
}

// Same groups as the Fleet tab's Action list; anything not listed lands
// under "Other" rather than disappearing.
const ACTION_GROUPS = [
  ['Diagnostics', ['ping', 'signal_stats', 'band_channel_info', 'link_info', 'throughput_test', 'list_interfaces']],
  ['Wi-Fi', ['connect_wifi', 'disconnect_wifi', 'nearby_hotspots', 'connect_hotspot', 'set_channel']],
  ['Logs & capture', ['syslog', 'stream_logs', 'stop_logs', 'tcpdump', 'stop_tcpdump', 'start_pcap_capture', 'stop_pcap_capture']],
  ['Interface setup', ['set_interface_mode', 'set_monitor_channel', 'set_interface_defaults']],
  ['Power', ['restart_agent', 'reboot_pi']],
];

function groupedActionOptions(actions) {
  const opt = a => `<option value="${a}">${actionLabel(a)}</option>`;
  const grouped = new Set(ACTION_GROUPS.flatMap(([, list]) => list));
  const groups = ACTION_GROUPS
    .map(([label, list]) => [label, list.filter(a => actions.includes(a))])
    .filter(([, list]) => list.length)
    .map(([label, list]) => `<optgroup label="${label.replace(/&/g, '&amp;')}">${list.map(opt).join('')}</optgroup>`);
  const rest = actions.filter(a => !grouped.has(a));
  if (rest.length) groups.push(`<optgroup label="Other">${rest.map(opt).join('')}</optgroup>`);
  return groups.join('');
}

function setupDetailBar(actionSelectEl, paramsContainer, sendBtn, resultsContainer, actions, piId) {
  actionSelectEl.innerHTML = groupedActionOptions(actions);
  renderDetailParamFields(paramsContainer, actionSelectEl, piId);
  actionSelectEl.onchange = () => renderDetailParamFields(paramsContainer, actionSelectEl, piId);
  sendBtn.onclick = () => sendDetailCommand(actionSelectEl, paramsContainer, resultsContainer, piId);
  resultsContainer.innerHTML = '';
}

let detailPiId = null;
let lastDetailInterfacesKey = null;
let detailLogEntry = null;

// Header: status next to the Pi's name, then IP · role · last seen.
function renderDetailInfo(piId) {
  const pi = pis.find(p => p.pi_id === piId);
  document.getElementById('pdHeroStatus').innerHTML = pi ? statusBadge(pi.status) : '';
  const bits = [];
  if (pi && pi.ip_address) bits.push(`<span class="pd-meta-k">IP</span> <span class="pd-meta-mono">${pi.ip_address}</span>`);
  if (pi && pi.role) bits.push(`<span class="pd-meta-k">Role</span> ${pi.role}`);
  if (pi && pi.last_seen) {
    bits.push(`<span class="pd-meta-k">Last seen</span> <span title="${formatVnDateTime(pi.last_seen)}">${fleetAgo(pi.last_seen)}</span>`);
  }
  document.getElementById('pdInfoFields').innerHTML = bits.join('<span class="pd-meta-sep" aria-hidden="true">·</span>');
}

// Latest buffered interface status for the open Pi (see
// refreshDetailInterfaceStatusBuffer) - drives the header stats and each
// interface card's one-line summary.
let pdStatusList = [];

function pdRenderHeroStats() {
  const pi = pis.find(p => p.pi_id === detailPiId);
  const ifaces = piInterfaces(detailPiId);
  const up = pdStatusList.filter(s => String(s.state || '').toUpperCase() === 'UP').length;
  const radios = pdStatusList.filter(s => s.connected != null);
  const conn = radios.filter(s => s.connected).length;
  const primary = pi && pi.primary_interfaces && pi.primary_interfaces.length ? pi.primary_interfaces.join(', ') : '–';
  const stat = (num, label, cls = '') => `<div class="pd-stat ${cls}"><span class="pd-stat-num">${num}</span><span class="pd-stat-label">${label}</span></div>`;
  document.getElementById('pdHeroStats').innerHTML = [
    stat(pdStatusList.length ? `${up}<small>/${pdStatusList.length}</small>` : ifaces.length || '–', pdStatusList.length ? 'interfaces up' : 'interfaces'),
    stat(radios.length ? `${conn}<small>/${radios.length}</small>` : '–', 'Wi-Fi connected', 'pd-stat-wifi'),
    stat(`<span class="pd-stat-text">${primary}</span>`, 'primary interface'),
  ].join('');
}

// "UP · 10.10.0.21 · Lab-5G · -48 dBm" on each card's header line.
function pdRenderIfaceMeta() {
  const byIface = new Map(pdStatusList.map(s => [s.interface, s]));
  document.querySelectorAll('#pdInterfaceList .pd-iface-meta').forEach(el => {
    const s = byIface.get(el.dataset.iface);
    if (!s) { el.innerHTML = ''; return; }
    const up = String(s.state || '').toUpperCase() === 'UP';
    const bits = [];
    if (s.state) bits.push(`<span class="if-pill if-state-${up ? 'up' : 'down'}">${s.state}</span>`);
    if (s.type) bits.push(`<span class="pd-iface-type">${s.type}</span>`);
    if (s.ip_address) bits.push(`<span class="pd-meta-mono">${s.ip_address}</span>`);
    if (s.connected && s.ssid) bits.push(`<span class="pd-iface-ssid">${s.ssid}</span>`);
    if (s.band) bits.push(s.band);
    if (s.signal_dbm != null) bits.push(interfacesSignalHtml(s.signal_dbm));
    el.innerHTML = bits.join(' ');
  });
}

function isWifiInterface(name) {
  return /^(wl|wlan)/.test(name);
}

// "wifiN" tag shown next to an interface's name: the highest standard its
// radio can connect at as a station - pi_agent's max_standard_capable, a
// radio capability carried on both link_info results and the
// InterfaceStatus buffer. Left untouched while that's unknown (null/missing)
// so a reply without the field doesn't flicker an already-shown tag away.
// Falls back to the older boolean wifi7_capable from not-yet-updated agents.
const WIFI_STD_TAGS = {
  be: ['wifi7', '802.11be (Wi-Fi 7)'],
  ax: ['wifi6', '802.11ax (Wi-Fi 6)'],
  ac: ['wifi5', '802.11ac (Wi-Fi 5)'],
  n: ['wifi4', '802.11n (Wi-Fi 4)'],
  legacy: ['legacy', '802.11a/b/g only'],
};

function maxStandardOf(status) {
  if (!status) return null;
  if (status.max_standard_capable) return status.max_standard_capable;
  return status.wifi7_capable ? 'be' : null;
}

function wifiStdTagHtml(standard) {
  const [label, desc] = WIFI_STD_TAGS[standard] || ['', ''];
  const hidden = label ? '' : ' hidden';
  return `<span class="badge wifi-std-tag${hidden}" title="Radio supports up to ${desc} connections">${label}</span>`;
}

function applyWifiStdTag(card, status) {
  const tag = card && card.querySelector('.wifi-std-tag');
  const standard = maxStandardOf(status);
  if (!tag || !WIFI_STD_TAGS[standard]) return;
  const [label, desc] = WIFI_STD_TAGS[standard];
  tag.textContent = label;
  tag.title = `Radio supports up to ${desc} connections`;
  tag.classList.remove('hidden');
}

// Info-table rows for a Wi-Fi 7 connection's addressing (see pi_agent
// WifiMixin._wifi7_link_fields): the client/AP MLD addresses when the
// association is multi-link, and one row per link with that link's own
// client and AP addresses. Nothing for a pre-Wi-Fi 7 connection - mlo is
// null there. Shared by the detail page and the fleet table's cards.
function wifi7LinkRows(link) {
  if (!link || link.mlo == null) return [];
  const rows = [['Multi-link (MLO)', link.mlo ? 'yes' : 'no (single link)']];
  if (link.mld_address) rows.push(['MLD address', link.mld_address]);
  if (link.ap_mld_address) rows.push(['AP MLD address', link.ap_mld_address]);
  (link.mlo_links || []).forEach((l, i) => {
    const label = `Link ${l.link_id ?? i}${l.band ? ` (${l.band})` : ''}`;
    const freq = l.frequency_mhz != null ? ` @ ${l.frequency_mhz} MHz` : '';
    rows.push([label, `STA ${l.sta_address || '—'} ↔ AP ${l.ap_address || '—'}${freq}`]);
  });
  return rows;
}

// Best-effort name-based guess for a monitor-mode interface (mon0,
// wlan0mon, etc.) - used only for the quick synchronous checks (which
// interfaces get a default band/channel control, the bulk action's fan-out)
// that can't afford to fetch list_interfaces' real, name-independent
// "type": "monitor" (see pi_agent.get_interface_details) for every
// interface up front.
function isMonitorInterfaceName(name) {
  return /mon/i.test(name);
}

// Classic curved-bars wifi glyph (like the Windows taskbar icon), drawn in
// currentColor so the connected/disconnected/unknown CSS classes can just
// recolor it instead of swapping emoji glyphs.
const WIFI_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 9a15.5 15.5 0 0 1 22 0"/>
  <path d="M5 13.5a9.5 9.5 0 0 1 14 0"/>
  <path d="M9 18a3.5 3.5 0 0 1 6 0"/>
  <circle cx="12" cy="21" r="1.2" fill="currentColor" stroke="none"/>
</svg>`;

// Refresh/radar glyph for the "scan for nearby networks" trigger button -
// distinct from the magnifying glass below, which is for typing/filtering
// the already-scanned list rather than triggering a new scan.
const SCAN_TRIGGER_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 12a9 9 0 1 1-3-6.7"/>
  <polyline points="21 3 21 9 15 9"/>
</svg>`;

// Magnifying-glass glyph for the SSID filter box that narrows down an
// already-scanned network list by typed text.
const SEARCH_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="11" cy="11" r="7"/>
  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
</svg>`;

// Per-Pi caches for the expandable interface cards below - list_interfaces
// is fetched once per Pi visit and reused for every card; link_info is
// fetched once per wifi interface (by the icon refresh) and reused if the
// card is later expanded, instead of firing it again.
let detailIfaceDetailsCache = null;   // array from list_interfaces, or null until fetched
let detailLinkInfoCache = {};         // interface name -> link_info result

// Queries link_info for one wifi-capable interface and colors its icon:
// green (connected, with SSID in the tooltip) or dim gray (not connected).
// Fired once per wifi interface whenever the interface list is (re)built.
// Shared by refreshWifiIcon and disconnectDetailWifi - the latter applies
// a known {connected: false} result immediately (see disconnectDetailWifi
// for why) instead of only waiting on refreshWifiIcon's own link_info
// round-trip.
function applyDetailWifiIconStatus(iface, status) {
  const el = document.querySelector(`#pdInterfaceList .wifi-icon[data-iface="${CSS.escape(iface)}"]`);
  if (!el) return;
  const connected = !!(status && status.connected);
  el.classList.remove('wifi-unknown', 'wifi-connected', 'wifi-disconnected');
  el.classList.add(connected ? 'wifi-connected' : 'wifi-disconnected');
  el.title = connected ? `Wi-Fi connected${status.ssid ? ' — ' + status.ssid : ''}` : 'Wi-Fi not connected';
  const card = el.closest('.pd-iface-card');
  const mark = card && card.querySelector('.pd-iface-connected-mark');
  if (mark) {
    mark.classList.toggle('hidden', !connected);
    if (connected) mark.textContent = status.ssid ? `connected — ${status.ssid}` : 'connected';
  }
  const body = card && card.querySelector('.pd-iface-body');
  if (body && !body.classList.contains('hidden')) renderDetailIfaceBody(body, iface);
}

async function refreshWifiIcon(piId, iface) {
  const iconEl = document.querySelector(`#pdInterfaceList .wifi-icon[data-iface="${CSS.escape(iface)}"]`);
  if (!iconEl) return;
  try {
    const res = await postCmd(piId, 'link_info', { interface: iface });
    if (!res.ok) return;
    const data = await res.json();
    const result = await awaitCommandResult(data.command_id, 10);
    detailLinkInfoCache[iface] = result;
    const el = document.querySelector(`#pdInterfaceList .wifi-icon[data-iface="${CSS.escape(iface)}"]`);
    if (!el) return;
    const connected = !!(result && result.connected);
    el.classList.remove('wifi-unknown', 'wifi-connected', 'wifi-disconnected');
    el.classList.add(connected ? 'wifi-connected' : 'wifi-disconnected');
    el.title = connected ? `Wi-Fi connected${result.ssid ? ' — ' + result.ssid : ''}` : 'Wi-Fi not connected';
    const card = el.closest('.pd-iface-card');
    applyWifiStdTag(card, result);
    const mark = card && card.querySelector('.pd-iface-connected-mark');
    if (mark) {
      mark.classList.toggle('hidden', !connected);
      if (connected) mark.textContent = result.ssid ? `connected — ${result.ssid}` : 'connected';
    }
    const body = card && card.querySelector('.pd-iface-body');
    if (body && !body.classList.contains('hidden')) renderDetailIfaceBody(body, iface);
  } catch {
    // leave as "unknown" - backend/Pi unreachable or command timed out
  }
}

// --- Buffered interface status (same InterfaceStatus buffer the fleet
// table's refreshFleetInterfaceStatusBuffer reads - continuously refreshed
// server-side every INTERFACE_STATUS_INTERVAL_SECONDS by pi_agent, see
// PiAgent._interface_status_loop). refreshDetailView (below) calls this on
// every 5s poll so wifi icons/connected-marks/interface info here stay
// current without a per-interface list_interfaces/link_info round-trip on
// every tick - unlike the eager one-shot load on page open (which still
// uses live commands, via loadDetailIfaceInfo/refreshWifiIcon, so a fresh
// page open doesn't have to wait on the buffer's first fill), and unlike a
// user-triggered action, which still calls refreshWifiIcon directly for its
// own instant feedback.
async function refreshDetailInterfaceStatusBuffer(piId) {
  let statusList;
  try {
    const res = await apiFetch(`${API}/pis/${encodeURIComponent(piId)}/interface-status`);
    statusList = res.ok ? await res.json() : [];
  } catch {
    statusList = [];
  }
  if (piId !== detailPiId) return;
  pdStatusList = statusList;
  pdRenderHeroStats();
  pdRenderIfaceMeta();
  if (!statusList.length) return;
  detailIfaceDetailsCache = statusList.map(s => ({
    name: s.interface, mac_address: s.mac_address, state: s.state, type: s.type,
    ip_address: s.ip_address, ipv6_address: s.ipv6_address,
  }));
  statusList.forEach(status => {
    const iface = status.interface;
    detailLinkInfoCache[iface] = status;
    const el = document.querySelector(`#pdInterfaceList .wifi-icon[data-iface="${CSS.escape(iface)}"]`);
    if (!el) return;
    const connected = !!status.connected;
    el.classList.remove('wifi-unknown', 'wifi-connected', 'wifi-disconnected');
    el.classList.add(connected ? 'wifi-connected' : 'wifi-disconnected');
    el.title = connected ? `Wi-Fi connected${status.ssid ? ' — ' + status.ssid : ''}` : 'Wi-Fi not connected';
    const card = el.closest('.pd-iface-card');
    applyWifiStdTag(card, status);
    const mark = card && card.querySelector('.pd-iface-connected-mark');
    if (mark) {
      mark.classList.toggle('hidden', !connected);
      if (connected) mark.textContent = status.ssid ? `connected — ${status.ssid}` : 'connected';
    }
    const body = card && card.querySelector('.pd-iface-body');
    if (body && !body.classList.contains('hidden')) renderDetailIfaceBody(body, iface);
  });
}

// Only ever touches the '.pd-iface-info' sub-div, not the whole card body -
// the wifi scan section (button + scanned-network cards) lives in a sibling
// div so a link_info refresh here doesn't wipe out an in-progress scan.
// Interfaces (piId::iface) with a set_interface_mode switch in flight -
// same reasoning/pattern as fleet-table.js's wifiModeSwitchInFlight: every
// re-render of this card's body (renderDetailIfaceBody rebuilds it from
// scratch each time, and the periodic status-buffer refresh calls it
// whenever the card is expanded) would otherwise silently replace a
// disabled "Switching…" button with a fresh enabled one mid-operation.
const detailWifiModeSwitchInFlight = new Set();

function renderDetailIfaceBody(body, name) {
  const info = body.querySelector('.pd-iface-info') || body;
  if (isEditingIfaceDefault(info)) return;
  const details = (detailIfaceDetailsCache || []).find(d => d.name === name);
  const link = detailLinkInfoCache[name];
  const rows = [];
  if (details) {
    rows.push(['State', details.state]);
    rows.push(['Type', details.type]);
    rows.push(['MAC address', details.mac_address]);
    rows.push(['IP address', details.ip_address || '—']);
  }
  if (link) {
    rows.push(['Wi-Fi connected', link.connected ? 'yes' : 'no']);
    if (link.ssid) rows.push(['SSID', link.ssid]);
    if (link.bssid) rows.push(['BSSID', link.bssid]);
    if (link.frequency_mhz != null) rows.push(['Frequency', `${link.frequency_mhz} MHz`]);
    if (link.band) rows.push(['Band', link.band]);
    if (link.radio_type) rows.push(['Radio type', link.radio_type]);
    rows.push(...wifi7LinkRows(link));
    if (link.key_mgmt) rows.push(['Key mgmt', link.key_mgmt]);
    if (link.signal_dbm != null) rows.push(['Signal', `${link.signal_dbm} dBm`]);
    if (link.rx_bitrate_mbps != null) rows.push(['RX bitrate', `${link.rx_bitrate_mbps} Mbps`]);
    if (link.tx_bitrate_mbps != null) rows.push(['TX bitrate', `${link.tx_bitrate_mbps} Mbps`]);
    if (link.gateway) rows.push(['Gateway', link.gateway]);
  }
  info.innerHTML = rows.length
    ? `<table class="result-table">${rows.map(([k, v]) =>
        `<tr><td class="result-key">${k}</td><td class="result-value">${v ?? ''}</td></tr>`
      ).join('')}</table>`
    : '<div class="pi-log-empty">no data</div>';

  if (link && link.connected) {
    if (link.gateway) {
      info.insertAdjacentHTML('beforeend',
        '<div class="wifi-disconnect-row"><button type="button" class="ap-weblink-btn">AP Configuration</button></div>');
      info.querySelector('.ap-weblink-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openApWebUi(detailPiId, name, e.currentTarget);
      });
    }
    info.insertAdjacentHTML('beforeend',
      '<div class="wifi-disconnect-row"><button type="button" class="wifi-disconnect-btn">Disconnect</button></div>');
    info.querySelector('.wifi-disconnect-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      disconnectDetailWifi(name, e.currentTarget);
    });
  }

  const isMonitor = details ? details.type === 'monitor' : isMonitorInterfaceName(name);
  // Needs a trustworthy current mode (details.type, from list_interfaces -
  // name-independent), not the isMonitorInterfaceName fallback, since a
  // wifi-named interface can now legitimately be in monitor mode - so this
  // button only appears once details are loaded.
  if (details && (isWifiInterface(name) || isMonitor) && detailPiId) {
    const targetMode = isMonitor ? 'managed' : 'monitor';
    const switching = detailWifiModeSwitchInFlight.has(`${detailPiId}::${name}`);
    info.insertAdjacentHTML('beforeend',
      `<div class="wifi-disconnect-row"><button type="button" class="iface-mode-switch-btn${isMonitor ? ' recording' : ''}" ${switching ? 'disabled' : ''}>${switching ? 'Switching…' : `Monitor mode: ${isMonitor ? 'On' : 'Off'}`}</button></div>`);
    if (!switching) {
      info.querySelector('.iface-mode-switch-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        switchDetailInterfaceMode(name, targetMode);
      });
    }
  }

  if ((isWifiInterface(name) || isMonitor) && detailPiId) {
    const pi = pis.find(p => p.pi_id === detailPiId);
    const current = (pi && pi.interface_defaults && pi.interface_defaults[name]) || null;
    renderInterfaceDefaultControl(info, detailPiId, name, current, (updated) => {
      if (pi) pi.interface_defaults = updated;
    }, isMonitor);
  }
}

function detailIfaceBodyEl(iface) {
  const card = document.querySelector(`#pdInterfaceList .pd-iface-card[data-iface="${CSS.escape(iface)}"]`);
  return card && card.querySelector('.pd-iface-body');
}

async function switchDetailInterfaceMode(iface, targetMode) {
  const piId = detailPiId;
  if (targetMode === 'monitor') {
    const link = detailLinkInfoCache[iface];
    if (link && link.connected &&
        !confirm(`${iface} is currently connected. Switching to monitor mode will disconnect it. Continue?`)) {
      return;
    }
  }
  // Tracked separately from the clicked button - see
  // detailWifiModeSwitchInFlight above for why (renderDetailInterfaceList
  // can also fully rebuild #pdInterfaceList mid-switch, same as
  // fleet-table.js's rebuildFleetIfaceCards, discarding the button
  // entirely; looking the body up fresh by iface each time, rather than
  // holding a reference to it, is what survives that).
  const key = `${piId}::${iface}`;
  detailWifiModeSwitchInFlight.add(key);
  const rerender = () => {
    const body = detailIfaceBodyEl(iface);
    if (body && !body.classList.contains('hidden')) renderDetailIfaceBody(body, iface);
  };
  rerender();
  let succeeded = false;
  try {
    const res = await postCmd(piId, 'set_interface_mode', { interface: iface, mode: targetMode });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json();
    // NetworkManager re-taking/re-associating the device can take a while -
    // same 3-minute allowance as connect_wifi, not the usual 30s.
    const result = await awaitCommandResult(data.command_id, 180);
    if (!result || !result.applied) {
      alert(`Failed to switch ${iface} to ${targetMode} mode: ${(result && result.output) || 'unknown error'}`);
    } else {
      succeeded = true;
    }
  } catch (err) {
    alert(`Failed to switch mode: ${err.message}`);
  } finally {
    detailWifiModeSwitchInFlight.delete(key);
  }
  if (succeeded) {
    delete detailLinkInfoCache[iface];
    detailIfaceDetailsCache = null;
    detailIfaceDetailsPromise = null;
    await loadDetailIfaceInfo(piId, iface);
  }
  rerender();
  refreshWifiIcon(piId, iface);
}

// Disconnects one interface directly from its own card (no need to go
// through the Actions panel or a scanned network's own Disconnect button).
async function disconnectDetailWifi(iface, btn) {
  const piId = detailPiId;
  btn.disabled = true;
  btn.textContent = 'Disconnecting…';
  let result = null;
  try {
    const res = await postCmd(piId, 'disconnect_wifi', { interface: iface });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json();
    result = await awaitCommandResult(data.command_id, 320);
  } catch (err) {
    alert(`Failed to disconnect: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Disconnect';
  }
  delete detailLinkInfoCache[iface];
  detailIfaceDetailsCache = null;
  detailIfaceDetailsPromise = null;
  // Apply straight from disconnect_wifi's own result first - see the
  // matching comment in fleet-table.js's disconnectFleetWifi for why this
  // doesn't just rely on refreshWifiIcon's separate link_info round-trip.
  if (result && result.disconnected) {
    detailLinkInfoCache[iface] = { connected: false };
    applyDetailWifiIconStatus(iface, { connected: false });
  }
  refreshWifiIcon(piId, iface);
}

function isOpenSecurity(security) {
  return !security || security === '--' || /^(none|open)$/i.test(security);
}

// "Remember password" for wifi connect cards - stored in localStorage,
// keyed by SSID (falling back to BSSID for hidden networks), so
// reconnecting to the same network later can pre-fill the password
// instead of retyping it. Note: this is plaintext in the browser's
// localStorage, readable by any script running on this page/origin - a
// reasonable tradeoff for a lab-scale fleet tool, not something to rely on
// if this page is ever exposed somewhere less trusted.
const WIFI_PASSWORD_STORAGE_KEY = 'pi_fleet_wifi_passwords';

function wifiPasswordKey(net) {
  return net.ssid || net.bssid || null;
}

function getSavedWifiPasswords() {
  try {
    return JSON.parse(localStorage.getItem(WIFI_PASSWORD_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function getSavedWifiPassword(net) {
  const key = wifiPasswordKey(net);
  return key ? (getSavedWifiPasswords()[key] || '') : '';
}

function rememberWifiPassword(net, password) {
  const key = wifiPasswordKey(net);
  if (!key) return;
  const saved = getSavedWifiPasswords();
  saved[key] = password;
  localStorage.setItem(WIFI_PASSWORD_STORAGE_KEY, JSON.stringify(saved));
}

function forgetWifiPassword(net) {
  const key = wifiPasswordKey(net);
  if (!key) return;
  const saved = getSavedWifiPasswords();
  if (key in saved) {
    delete saved[key];
    localStorage.setItem(WIFI_PASSWORD_STORAGE_KEY, JSON.stringify(saved));
  }
}

// Shared markup for a password field + its "Remember password" checkbox,
// pre-filled/checked when a password is already saved for this network.
function wifiPasswordFieldHtml(net) {
  const saved = getSavedWifiPassword(net);
  return `
    <div class="password-wrap">
      <input type="password" class="wifi-connect-password field" placeholder="Password" value="${saved ? saved.replace(/"/g, '&quot;') : ''}">
      <button type="button" class="password-toggle" title="Show password">${EYE_ICON_SVG}</button>
    </div>
    <label class="wifi-remember-row">
      <input type="checkbox" class="wifi-remember-checkbox" ${saved ? 'checked' : ''}>
      Remember password
    </label>
  `;
}

// After a successful connect, save or forget the password per the
// "Remember password" checkbox's state.
function applyWifiPasswordMemory(body, net, password) {
  const remember = body.querySelector('.wifi-remember-checkbox');
  if (!remember) return;
  if (remember.checked && password) {
    rememberWifiPassword(net, password);
  } else {
    forgetWifiPassword(net);
  }
}

// One scanned AP, rendered as the same collapsed-card widget used
// elsewhere (interface list, plain nearby_hotspots results), but with a
// "connected" mark against the interface's current link_info and an
// inline Connect/Disconnect control using the same fields as the
// connect_wifi action (ssid/bssid/password/interface).
function renderWifiNetworkCard(piId, iface, net, connectedBssid) {
  const isConnected = !!(connectedBssid && net.bssid && connectedBssid === net.bssid);
  const open = isOpenSecurity(net.security);

  const card = document.createElement('div');
  card.className = 'pd-iface-card';
  card.innerHTML = `
    <div class="pd-iface-header">
      <span class="pd-iface-name">${net.ssid || '(hidden)'}</span>
      ${isConnected ? '<span class="badge badge-online">connected</span>' : ''}
      <span class="pd-iface-toggle">${chevronIconSvg('right')}</span>
    </div>
    <div class="pd-iface-body hidden"></div>
  `;
  const body = card.querySelector('.pd-iface-body');
  const infoRows = [
    ['SSID', net.ssid || '(hidden)'],
    ['BSSID', net.bssid],
    ['Frequency', net.frequency_mhz != null ? `${net.frequency_mhz} MHz` : null],
    ['Band', net.band],
    ['Channel', net.channel],
    ['Rate', net.rate],
    ['Signal', net.signal_percent != null ? `${net.signal_percent}%` : null],
    ['Security', net.security],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  body.innerHTML = `
    <table class="result-table">${infoRows.map(([k, v]) =>
      `<tr><td class="result-key">${k}</td><td class="result-value">${v}</td></tr>`
    ).join('')}</table>
    <div class="wifi-connect-row">
      ${isConnected
        ? `<button type="button" class="wifi-disconnect-btn">Disconnect</button>`
        : `${open ? '' : wifiPasswordFieldHtml(net)}
          <select class="field wifi-max-standard" title="Cap the 802.11 standard this radio negotiates at">
            <option value="">max standard: auto</option>
            <option value="be">802.11be (Wi-Fi 7) max</option>
            <option value="ax">802.11ax (Wi-Fi 6) max</option>
            <option value="ac">802.11ac (Wi-Fi 5) max</option>
            <option value="n">802.11n (Wi-Fi 4) max</option>
            <option value="legacy">802.11a/g max</option>
          </select>
          <button type="button" class="wifi-connect-btn">Connect</button>`
      }
    </div>
    <div class="wifi-connect-status hint"></div>
  `;

  card.querySelector('.pd-iface-header').addEventListener('click', () => {
    const expanding = body.classList.contains('hidden');
    body.classList.toggle('hidden');
    card.querySelector('.pd-iface-toggle').innerHTML = chevronIconSvg(expanding ? 'down' : 'right');
  });

  const statusEl = body.querySelector('.wifi-connect-status');
  const stop = (e) => e.stopPropagation();

  const connectBtn = body.querySelector('.wifi-connect-btn');
  if (connectBtn) {
    connectBtn.addEventListener('click', async (e) => {
      stop(e);
      const passwordInput = body.querySelector('.wifi-connect-password');
      const password = passwordInput && passwordInput.value ? passwordInput.value : undefined;
      const maxStandardInput = body.querySelector('.wifi-max-standard');
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
        if (result && result.connected) applyWifiPasswordMemory(body, net, password);
        // Only touch the Pi detail page's own cache/icon if this card is
        // actually being shown there for this same Pi - this card is also
        // reused for scan results on the Fleet Actions panel and History
        // tab, where there's no detail-page interface list to refresh.
        if (detailPiId === piId) {
          delete detailLinkInfoCache[iface];
          detailIfaceDetailsCache = null;
          detailIfaceDetailsPromise = null;
          refreshWifiIcon(piId, iface);
        }
      } catch (err) {
        statusEl.textContent = `Failed: ${err.message}`;
      } finally {
        connectBtn.disabled = false;
      }
    });
  }
  const passwordInput = body.querySelector('.wifi-connect-password');
  if (passwordInput) passwordInput.addEventListener('click', stop);
  const maxStandardInput = body.querySelector('.wifi-max-standard');
  if (maxStandardInput) maxStandardInput.addEventListener('click', stop);
  const rememberCheckbox = body.querySelector('.wifi-remember-checkbox');
  if (rememberCheckbox) rememberCheckbox.addEventListener('click', stop);

  const disconnectBtn = body.querySelector('.wifi-disconnect-btn');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async (e) => {
      stop(e);
      disconnectBtn.disabled = true;
      statusEl.textContent = 'Disconnecting…';
      try {
        const res = await postCmd(piId, 'disconnect_wifi', { interface: iface });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        const data = await res.json();
        await awaitCommandResult(data.command_id, 320);
        statusEl.textContent = 'Disconnected.';
        if (detailPiId === piId) {
          delete detailLinkInfoCache[iface];
          detailIfaceDetailsCache = null;
          detailIfaceDetailsPromise = null;
          refreshWifiIcon(piId, iface);
        }
      } catch (err) {
        statusEl.textContent = `Failed: ${err.message}`;
      } finally {
        disconnectBtn.disabled = false;
      }
    });
  }

  return card;
}

// Icon-only toggle (refresh glyph, rotates like a chevron) that triggers a
// fresh scan and shows/hides the results panel - collapsing just hides the
// last scan, expanding always re-scans since which APs are in range/what
// their signal is goes stale almost immediately.
async function toggleWifiScan(piId, iface, btn, resultsEl, listEl) {
  const expanding = resultsEl.classList.contains('hidden');
  resultsEl.classList.toggle('hidden');
  btn.classList.toggle('open', expanding);
  if (expanding) await scanWifiNetworks(piId, iface, listEl, btn);
}

// Hides scanned-network cards whose SSID doesn't contain the typed text -
// pure client-side narrowing of the last scan, no re-scan involved.
function applyWifiSearchFilter(listEl, query) {
  // Prefix match ignoring case (spaces still count), same as the hotspot
  // window's column filters (wifiInfoRowMatchesFilters).
  const q = query.toLowerCase();
  listEl.querySelectorAll('.pd-iface-card').forEach(card => {
    const ssid = (card.querySelector('.pd-iface-name')?.textContent || '').toLowerCase();
    card.classList.toggle('hidden', !!q && !ssid.startsWith(q));
  });
}

async function scanWifiNetworks(piId, iface, listEl, scanBtn) {
  scanBtn.disabled = true;
  renderWifiScanLoading(listEl, `Scanning ${iface} for networks…`);
  try {
    const res = await postCmd(piId, 'nearby_hotspots', { interfaces: [iface] });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json();
    const result = await awaitCommandResult(data.command_id, 30);
    const networks = sortNetworksBySsid((result && result.networks) || []);
    listEl.innerHTML = '';
    if (!networks.length) {
      listEl.innerHTML = '<div class="pi-log-empty">no networks found</div>';
      return;
    }
    const connectedBssid = (detailLinkInfoCache[iface] && detailLinkInfoCache[iface].connected)
      ? detailLinkInfoCache[iface].bssid : null;
    networks.forEach(net => listEl.appendChild(renderWifiNetworkCard(piId, iface, net, connectedBssid)));
    const searchInput = listEl.closest('.pd-wifi-scan-results')?.querySelector('.pd-wifi-search-input');
    if (searchInput && searchInput.value) applyWifiSearchFilter(listEl, searchInput.value);
  } catch (err) {
    listEl.innerHTML = `<div class="pi-log-empty">scan failed: ${err.message}</div>`;
  } finally {
    scanBtn.disabled = false;
  }
}

// In-flight list_interfaces fetch, so the eager per-interface load below
// (fired once per interface as soon as the page opens) issues exactly one
// list_interfaces command instead of one per interface racing each other.
let detailIfaceDetailsPromise = null;

async function fetchDetailIfaceDetails(piId) {
  if (detailIfaceDetailsCache !== null) return detailIfaceDetailsCache;
  if (!detailIfaceDetailsPromise) {
    detailIfaceDetailsPromise = (async () => {
      try {
        const res = await postCmd(piId, 'list_interfaces', {});
        if (res.ok) {
          const data = await res.json();
          const result = await awaitCommandResult(data.command_id, 10);
          detailIfaceDetailsCache = (result && result.interfaces) || [];
        } else {
          detailIfaceDetailsCache = [];
        }
      } catch {
        detailIfaceDetailsCache = [];
      }
      return detailIfaceDetailsCache;
    })();
  }
  return detailIfaceDetailsPromise;
}

// Fetches whatever's missing for one card - list_interfaces (shared across
// all cards, fetched at most once per Pi visit) and, for wifi interfaces,
// link_info (usually already cached by refreshWifiIcon by the time a user
// expands the card).
async function loadDetailIfaceInfo(piId, name) {
  await fetchDetailIfaceDetails(piId);
  if (isWifiInterface(name) && !(name in detailLinkInfoCache)) {
    try {
      const res = await postCmd(piId, 'link_info', { interface: name });
      if (res.ok) {
        const data = await res.json();
        detailLinkInfoCache[name] = await awaitCommandResult(data.command_id, 10);
      }
    } catch {
      // leave unset - body will just omit the wifi rows
    }
  }
}

// Info is already fetched eagerly (see renderDetailInterfaceList), so
// expanding a card just reveals it - only re-fetch if that eager load
// hasn't landed yet (e.g. a slow/unresponsive Pi) or hasn't run at all.
async function toggleDetailIfaceCard(piId, card, name) {
  const body = card.querySelector('.pd-iface-body');
  const info = body.querySelector('.pd-iface-info');
  const toggle = card.querySelector('.pd-iface-toggle');
  const expanding = body.classList.contains('hidden');
  body.classList.toggle('hidden');
  toggle.innerHTML = chevronIconSvg(expanding ? 'down' : 'right');
  if (!expanding) return;
  if (!info.innerHTML.trim()) {
    info.innerHTML = '<div class="pi-log-empty">loading…</div>';
    await loadDetailIfaceInfo(piId, name);
  }
  renderDetailIfaceBody(body, name);
}

function renderDetailInterfaceList(piId) {
  const interfaces = piInterfaces(piId);
  const list = document.getElementById('pdInterfaceList');
  list.innerHTML = interfaces.length ? interfaces.map(name => `
    <div class="pd-iface-card" data-iface="${name}">
      <div class="pd-iface-header">
        <span class="pd-iface-name">${name}${isWifiInterface(name) ? wifiStdTagHtml(null) : ''}</span>
        <span class="pd-iface-meta" data-iface="${name}"></span>
        ${isWifiInterface(name) ? `
          <span class="wifi-icon wifi-unknown" data-iface="${name}" title="checking…">${WIFI_ICON_SVG}</span>
          <span class="pd-iface-connected-mark badge badge-online hidden" data-iface="${name}"></span>
          <button type="button" class="pd-wifi-info-btn" data-iface="${name}">Nearby Hotspot</button>
        ` : ''}
        <span class="pd-iface-toggle">${chevronIconSvg('right')}</span>
      </div>
      <div class="pd-iface-body hidden">
        <div class="pd-iface-info"></div>
        ${isWifiInterface(name) ? `
          <div class="pd-wifi-scan-heading">
            <span>Nearby networks</span>
            <button type="button" class="pd-scan-wifi-toggle icon-btn" title="Scan for nearby networks">${SCAN_TRIGGER_ICON_SVG}</button>
          </div>
          <div class="pd-wifi-scan-results hidden">
            <div class="pd-wifi-search-wrap">
              ${SEARCH_ICON_SVG}
              <input type="text" class="pd-wifi-search-input" placeholder="Filter by SSID…">
            </div>
            <div class="pd-wifi-scan-list"></div>
          </div>
        ` : ''}
      </div>
    </div>
  `).join('') : '<div class="pi-log-empty">no interfaces</div>';
  document.getElementById('pdIfaceCount').textContent = interfaces.length || '';
  pdRenderIfaceMeta();

  list.querySelectorAll('.pd-iface-card').forEach(card => {
    const name = card.dataset.iface;
    card.querySelector('.pd-iface-header').addEventListener('click', () => toggleDetailIfaceCard(piId, card, name));
  });

  list.querySelectorAll('.pd-wifi-info-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openWifiInfoModal(piId, btn.dataset.iface);
    });
  });

  list.querySelectorAll('.pd-scan-wifi-toggle').forEach(btn => {
    const card = btn.closest('.pd-iface-card');
    const name = card.dataset.iface;
    const resultsEl = card.querySelector('.pd-wifi-scan-results');
    const listEl = card.querySelector('.pd-wifi-scan-list');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWifiScan(piId, name, btn, resultsEl, listEl);
    });
    const searchInput = card.querySelector('.pd-wifi-search-input');
    searchInput.addEventListener('click', (e) => e.stopPropagation());
    searchInput.addEventListener('input', () => applyWifiSearchFilter(listEl, searchInput.value));
  });

  interfaces.filter(isWifiInterface).forEach(name => refreshWifiIcon(piId, name));

  // Load every interface's list_interfaces/link_info info as soon as the
  // page is shown, not just when its card is expanded - so opening a card
  // shows data immediately instead of a "loading…" flash.
  interfaces.forEach(async (name) => {
    await loadDetailIfaceInfo(piId, name);
    const card = list.querySelector(`.pd-iface-card[data-iface="${CSS.escape(name)}"]`);
    const body = card && card.querySelector('.pd-iface-body');
    if (body) renderDetailIfaceBody(body, name);
  });
}

// Middle panel: syslog/tcpdump log windows, built once per visit to the
// detail page and reusing the same connectPiLog/toggleCapture/
// toggleLogsStream functions the fleet table's inline rows use - those
// only ever touch the entry object by key, so a plain object standing in
// for a table row's state works without any changes to that logic. Unlike
// the fleet table, both windows are always "expanded" here (no toggle),
// so the socket opens immediately and closes when leaving the page.
function buildDetailLogEntry(piId, lockedIface = null) {
  const entry = { captureState: null, pcapState: null, ws: null, tcpdumpStreaming: false, logsStreaming: false, lockedIface };
  document.querySelectorAll('#pdLogPanel .pd-log-block').forEach(block => {
    const kind = block.dataset.kind;
    const spec = PANELS.find(p => p.kind === kind);
    block.classList.remove('pd-log-collapsed');
    const existingCollapseBtn = block.querySelector('.pi-log-collapse');
    if (existingCollapseBtn) {
      existingCollapseBtn.innerHTML = chevronIconSvg('up');
      existingCollapseBtn.title = 'Collapse';
    }
    entry[spec.panelKey] = block.querySelector('.pi-log-panel');
    resetLogPanel(entry[spec.panelKey], spec);
    if (kind === 'tcpdump') setupWiresharkTable(entry[spec.panelKey]);

    // Explicit start/stop - opening the page never auto-starts a stream
    // (see performToggleTcpdumpStream / toggleLogsStream).
    const streamBtn = block.querySelector('.pi-log-stream');
    streamBtn.classList.remove('streaming');
    streamBtn.innerHTML = PLAY_ICON_SVG;
    streamBtn.title = 'Start streaming';
    streamBtn.onclick = kind === 'tcpdump'
      ? () => toggleDetailTcpdumpStream(piId, entry, streamBtn)
      : () => toggleLogsStream(piId, entry, streamBtn);

    // tcpdump only - syslog is the whole daemon's journal, no interface.
    // Switching interface stops any running stream so the button never
    // shows "streaming" for an interface that's no longer selected.
    if (kind === 'tcpdump') {
      const ifaceSelect = block.querySelector('.pi-stream-iface');
      entry.tcpdumpIfaceSelect = ifaceSelect;
      ifaceSelect.value = '';
      ifaceSelect.disabled = !!lockedIface;
      ifaceSelect.onchange = (e) => onDetailTcpdumpIfaceChange(piId, entry, streamBtn, e.target.value);

      // Each popped-out tab has its own page state and WebSocket, filtered
      // to its own interface (connectPiLog), so several interfaces can be
      // streamed/captured at once - the backend keys pcap recordings by
      // Pi+interface already.
      block.querySelector('.pi-log-popout').onclick = () => {
        if (!ifaceSelect.value) {
          alert('Select an interface to open in a new tab.');
          return;
        }
        window.open(captureTabHash(piId, ifaceSelect.value), '_blank');
      };
    }

    const captureBtn = block.querySelector('.pi-log-capture');
    captureBtn.innerHTML = '&#9210;';
    captureBtn.title = 'Start Capture';
    captureBtn.classList.remove('recording');
    captureBtn.onclick = () => toggleCapture(piId, spec, entry, captureBtn);

    block.querySelector('.pi-log-clear').onclick = () => clearPanel(piId, spec, entry[spec.panelKey]);

    // Pure screen-space toggle, independent of streaming state - collapsing
    // one block (down to just its heading) lets the other's flex-grow claim
    // the freed height, since it's the only block left competing for space.
    const collapseBtn = block.querySelector('.pi-log-collapse');
    collapseBtn.onclick = () => {
      const collapsed = block.classList.toggle('pd-log-collapsed');
      collapseBtn.innerHTML = chevronIconSvg(collapsed ? 'down' : 'up');
      collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
    };
  });
  return entry;
}

// Detail-page wrapper for the tcpdump panel's explicit start/stop
// streaming button - the page keeps one persistent websocket open for its
// whole visit (see showPiDetail), so unlike the fleet table there's no
// per-toggle connect/disconnect to manage here, just the backend command.
async function toggleDetailTcpdumpStream(piId, entry, btn) {
  const iface = entry.tcpdumpIfaceSelect ? entry.tcpdumpIfaceSelect.value : '';
  if (!iface) {
    alert('Select an interface for the tcpdump panel first.');
    return;
  }
  const starting = await performToggleTcpdumpStream(piId, iface, btn, entry.tcpdumpPanel);
  if (starting === null) return;
  entry.tcpdumpStreaming = starting;
  entry.tcpdumpActiveIface = starting ? iface : null;

  // Same reasoning as the fleet table: starting a stream while the block
  // is collapsed (the space-saving toggle, not this streaming toggle)
  // would accumulate rows nobody can see.
  if (starting) {
    const block = document.querySelector('#pdLogPanel .pd-log-block[data-kind="tcpdump"]');
    if (block && block.classList.contains('pd-log-collapsed')) {
      block.classList.remove('pd-log-collapsed');
      const collapseBtn = block.querySelector('.pi-log-collapse');
      if (collapseBtn) {
        collapseBtn.innerHTML = chevronIconSvg('up');
        collapseBtn.title = 'Collapse';
      }
    }
  }
}

// Fired when the tcpdump panel's interface dropdown changes. If a stream
// was running on the interface being switched away from, stop it
// server-side and reset the button back to "Start streaming" - otherwise
// the button kept showing "streaming" for an interface no longer selected,
// and the orphaned stream on the old interface would just keep running.
// Either way, the panel is cleared since whatever it's showing belongs to
// the previously selected interface, not the new one.
async function onDetailTcpdumpIfaceChange(piId, entry, btn, newIface) {
  const panel = entry.tcpdumpPanel;
  const spec = PANELS.find(p => p.kind === 'tcpdump');
  if (panel) resetLogPanel(panel, spec);

  // A recording on the previous interface keeps running on the Pi; the
  // button just switches to the new interface's state (off until
  // restoreRecordingState finds one running there).
  const captureBtn = document.querySelector('#pdLogPanel .pd-log-block[data-kind="tcpdump"] .pi-log-capture');
  if (entry.pcapState && entry.pcapState.interface !== newIface && captureBtn && !captureBtn.disabled) {
    entry.pcapState = null;
    setCaptureBtn(captureBtn, false);
  }
  restoreRecordingState(piId, detailRecordingTargets(entry));

  if (entry.tcpdumpActiveIface && entry.tcpdumpActiveIface !== newIface) {
    const prevIface = entry.tcpdumpActiveIface;
    entry.tcpdumpStreaming = false;
    entry.tcpdumpActiveIface = null;
    btn.classList.remove('streaming');
    btn.innerHTML = PLAY_ICON_SVG;
    btn.title = 'Start streaming';
    try {
      await postCmd(piId, 'stop_tcpdump', { interface: prevIface });
    } catch {
      // backend unreachable; button/panel are already reset locally
    }
  }
}

function captureTabHash(piId, iface) {
  return `#capture/${encodeURIComponent(piId)}/${encodeURIComponent(iface)}`;
}

function refreshDetailLogIfaceOptions(piId, entry) {
  // A capture tab stays on its one interface, even before the Pi list has
  // loaded (piInterfaces is empty on a fresh tab's first render).
  if (entry.lockedIface) {
    const select = entry.tcpdumpIfaceSelect;
    select.innerHTML = `<option value="${escapeCaptureHtml(entry.lockedIface)}">${escapeCaptureHtml(entry.lockedIface)}</option>`;
    select.value = entry.lockedIface;
    return;
  }
  const interfaces = piInterfaces(piId);
  PANELS.forEach(spec => {
    const select = entry[spec.kind + 'IfaceSelect'];
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">select interface</option>' +
      interfaces.map(i => `<option value="${i}">${i}</option>`).join('');
    if (interfaces.includes(current)) select.value = current;
  });
}

function detailRecordingTargets(logEntry) {
  return [{
    state: logEntry,
    // The record button belongs to the selected interface (or a capture
    // tab's locked one), not to whichever interface happens to be recording.
    iface: () => logEntry.lockedIface || (logEntry.tcpdumpIfaceSelect && logEntry.tcpdumpIfaceSelect.value) || undefined,
    logsBtn: document.querySelector('#pdLogPanel .pd-log-block[data-kind="logs"] .pi-log-capture'),
    pcapBtn: document.querySelector('#pdLogPanel .pd-log-block[data-kind="tcpdump"] .pi-log-capture'),
    // The pcap stop command needs the interface, so show which one it is.
    onPcapIface: (iface) => {
      const select = logEntry.tcpdumpIfaceSelect;
      if (select && [...select.options].some(o => o.value === iface)) select.value = iface;
    },
  }];
}

function closeDetailLogEntry() {
  if (detailLogEntry && detailLogEntry.ws) detailLogEntry.ws.close();
  detailLogEntry = null;
}

// Called on every refreshPis() poll (5s) so status/last-seen/interfaces
// stay current without rebuilding the whole page (which would tear down
// the log WebSocket and reset in-progress captures every 5s).
function refreshDetailView() {
  if (!detailPiId || !document.getElementById('piDetail').classList.contains('active')) return;
  renderDetailInfo(detailPiId);
  refreshDetailInterfaceStatusBuffer(detailPiId);
  pdUpdateLiveDots();

  const interfaces = piInterfaces(detailPiId);
  // Sorted before comparing - see the matching comment in fleet-table.js's
  // renderPis: a mode switch's delete+recreate can reorder this list
  // without actually adding/removing anything, and a pure reorder shouldn't
  // rebuild every interface card (resetting wifi icon state etc).
  const key = JSON.stringify([...interfaces].sort());
  if (key === lastDetailInterfacesKey) return;
  lastDetailInterfacesKey = key;

  document.getElementById('pdActionParams').querySelectorAll('.iface-dropdown[data-param]').forEach(box => {
    const current = getDropdownSelected(box);
    setDropdownOptions(box, interfaces, current.filter(v => interfaces.includes(v)));
  });
  renderDetailInterfaceList(detailPiId);
  if (detailLogEntry) refreshDetailLogIfaceOptions(detailPiId, detailLogEntry);
}

const APP_TITLE = document.title;

function showPiDetail(piId, captureIface = null) {
  closeDetailLogEntry();
  closeWifiInfoModal();
  // Bypasses showTabView/its "tabshown" event (this isn't a tab), so every
  // testcase/testsuite popup (see testcases-tab.js, testsuites-tab.js)
  // needs its own explicit close here too, the same reason
  // closeWifiInfoModal is called above.
  if (typeof closeTcEditorModal === 'function') closeTcEditorModal();
  if (typeof closeTsEditorModal === 'function') closeTsEditorModal();
  if (typeof resStopPolling === 'function') resStopPolling();
  if (typeof closeTsRunHistoryModal === 'function') closeTsRunHistoryModal();
  detailPiId = piId;
  lastDetailInterfacesKey = null;
  detailIfaceDetailsCache = null;
  detailIfaceDetailsPromise = null;
  detailLinkInfoCache = {};
  tabs.forEach(b => b.classList.remove('active'));
  views.forEach(v => v.classList.remove('active'));
  const detailEl = document.getElementById('piDetail');
  detailEl.classList.add('active');
  detailEl.classList.toggle('capture-only', !!captureIface);
  document.getElementById('piDetailTitle').textContent = captureIface ? `${piId} · ${captureIface}` : piId;
  document.title = captureIface ? `${captureIface} @ ${piId}` : APP_TITLE;
  renderPowerButtons(document.getElementById('piDetailPower'), piId);

  pdStatusList = [];
  renderDetailInfo(piId);
  pdRenderHeroStats();
  renderDetailInterfaceList(piId);
  refreshDetailInterfaceStatusBuffer(piId);
  // A capture pop-out (#capture/<pi>/<iface>) is only ever the Packets view.
  pdShowTab(captureIface ? 'tcpdump' : pdSavedTab());

  detailLogEntry = buildDetailLogEntry(piId, captureIface);
  refreshDetailLogIfaceOptions(piId, detailLogEntry);
  detailLogEntry.ws = connectPiLog(piId, detailLogEntry);
  restoreRecordingState(piId, detailRecordingTargets(detailLogEntry));

  setupDetailBar(
    document.getElementById('pdAction'), document.getElementById('pdActionParams'),
    document.getElementById('pdActionSendBtn'), document.getElementById('pdActionResults'),
    Object.keys(ACTION_PARAMS), piId
  );
  pdUpdateLiveDots();
}

// --- Pi page sub-tabs: Interfaces | Syslog | Packets ------------------------
// One section at a time at full width. Both log windows are built and
// connected on page open (buildDetailLogEntry) whichever tab is showing, so
// switching tabs never stops a stream; a dot on the tab says it's live
// (accent) or recording (red). The last tab used is remembered.

const PD_TAB_KEY = 'pi_fleet_pi_tab';
const PD_TABS = ['interfaces', 'logs', 'tcpdump'];

function pdSavedTab() {
  let t = null;
  try { t = localStorage.getItem(PD_TAB_KEY); } catch { /* storage blocked */ }
  return PD_TABS.includes(t) ? t : 'interfaces';
}

function pdShowTab(which, remember = false) {
  if (remember) {
    try { localStorage.setItem(PD_TAB_KEY, which); } catch { /* storage blocked */ }
  }
  document.querySelectorAll('#pdMainPanel [data-pd-tab]').forEach(tab => {
    const on = tab.dataset.pdTab === which;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  });
  document.getElementById('pdInterfacesPane').classList.toggle('hidden', which !== 'interfaces');
  const logs = document.getElementById('pdLogPanel');
  logs.classList.toggle('hidden', which === 'interfaces');
  if (which !== 'interfaces') logs.dataset.show = which;
}

function pdUpdateLiveDots() {
  ['logs', 'tcpdump'].forEach(kind => {
    const block = document.querySelector(`#pdLogPanel .pd-log-block[data-kind="${kind}"]`);
    const dot = document.querySelector(`#pdMainPanel .pd-live[data-live="${kind}"]`);
    if (!block || !dot) return;
    const recording = !!block.querySelector('.pi-log-capture.recording');
    const streaming = !!block.querySelector('.pi-log-stream.streaming');
    dot.classList.toggle('on', streaming || recording);
    dot.classList.toggle('rec', recording);
    dot.title = recording ? 'recording' : (streaming ? 'streaming' : '');
  });
}

document.querySelectorAll('#pdMainPanel [data-pd-tab]').forEach(tab => {
  tab.addEventListener('click', () => pdShowTab(tab.dataset.pdTab, true));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = PD_TABS.indexOf(tab.dataset.pdTab);
    const next = PD_TABS[(i + (e.key === 'ArrowRight' ? 1 : PD_TABS.length - 1)) % PD_TABS.length];
    pdShowTab(next, true);
    document.querySelector(`#pdMainPanel [data-pd-tab="${next}"]`).focus();
  });
});
// Stream/record buttons flip their own state after a command round-trip -
// re-check the dots shortly after any click in the log windows.
document.getElementById('pdLogPanel').addEventListener('click', () => {
  setTimeout(pdUpdateLiveDots, 400);
  setTimeout(pdUpdateLiveDots, 2000);
});
document.getElementById('pdActionResultsClear').addEventListener('click', () => {
  document.getElementById('pdActionResults').innerHTML = '';
});

// Every top-level tab's data-view value doubles as its URL hash (see the
// tab click handler in auth.js) and its section id (index.html) - this is
// the one place both meanings have to agree, so it's read from the tabs
// themselves rather than hardcoded, in case a tab's data-view ever changes.
const KNOWN_VIEWS = [...tabs].map(b => b.dataset.view);

function showTabView(viewId) {
  closeDetailLogEntry();
  document.title = APP_TITLE;
  closeWifiInfoModal();
  detailPiId = null;
  document.getElementById('piDetail').classList.remove('active');
  tabs.forEach(b => b.classList.remove('active'));
  views.forEach(v => v.classList.remove('active'));
  const tabBtn = [...tabs].find(b => b.dataset.view === viewId);
  if (tabBtn) tabBtn.classList.add('active');
  document.getElementById(viewId).classList.add('active');
  // Lets a tab's own script (e.g. interfaces-tab.js, testcases-tab.js) do
  // an immediate data refresh whenever it becomes the visible view -
  // covers a reload landing directly on that tab's hash and Back/Forward
  // navigating into it, not just a literal click on its button (which a
  // listener on the tab element itself would miss both of).
  document.dispatchEvent(new CustomEvent('tabshown', { detail: { viewId } }));
}

document.getElementById('piDetailBack').addEventListener('click', () => {
  location.hash = '#fleet';
});

// Single router for the whole app - every tab (Fleet/Interfaces/Testcases/
// Captures/History) and the Pi detail page are all just states of the URL
// hash, restored here on load (so a reload lands back where it was, not
// always on Fleet) and on every hashchange (so Back/Forward step through
// them, since location.hash = '#...' pushes a real history entry - see the
// tab click handler and fleet-table.js's #pi/<id> links).
function routeApp() {
  const hash = location.hash.slice(1);
  const captureMatch = hash.match(/^capture\/([^/]+)\/(.+)$/);
  if (captureMatch) {
    showPiDetail(decodeURIComponent(captureMatch[1]), decodeURIComponent(captureMatch[2]));
    return;
  }
  const piMatch = hash.match(/^pi\/(.+)$/);
  if (piMatch) {
    showPiDetail(decodeURIComponent(piMatch[1]));
    return;
  }
  // One run's result page, or one of its tests' log page (results-tab.js
  // reads kind/id/seq back out of the hash on "tabshown"), so each has its
  // own link and Back returns to where you were.
  if (/^results\/(testcase|testsuite)\/\d+(\/tests\/\d+)?$/.test(hash)) {
    showTabView('results');
    return;
  }
  // Packages has two sub-tabs (testcases-tab.js's pkgShow reads which).
  if (/^packages\/(testcases|testsuites)$/.test(hash)) {
    showTabView('packages');
    return;
  }
  // The old Running tab merged into Results - keep its bookmarks working.
  if (hash === 'running') {
    location.replace(`${location.pathname}${location.search}#results`);
    return;
  }
  if (KNOWN_VIEWS.includes(hash)) {
    showTabView(hash);
    return;
  }
  // No/unknown hash (fresh load with no fragment, or a stale/bad URL) -
  // default to Fleet. Replaced rather than pushed so this fallback doesn't
  // itself become an extra Back-button stop separate from just "how the
  // app starts".
  location.replace(`${location.pathname}${location.search}#fleet`);
}
window.addEventListener('hashchange', routeApp);
routeApp();

const footerYearEl = document.getElementById('footerYear');
if (footerYearEl) footerYearEl.textContent = new Date().getFullYear();
