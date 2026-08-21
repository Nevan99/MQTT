// --- Fleet: command builder ------------------------------------------------

const actionSelect = document.getElementById('actionSelect');
const paramFields = document.getElementById('paramFields');
const sendCmdBtn = document.getElementById('sendCmdBtn');
const cmdResults = document.getElementById('cmdResults');

const ACTION_PARAMS = {
  ping: [
    { name: 'interface', label: 'Interface (optional)', type: 'interface' },
    { name: 'target', label: 'IP to ping', type: 'text', default: '8.8.8.8' },
    { name: 'count', label: 'Count', type: 'number', default: 5 },
  ],
  signal_stats: [],
  band_channel_info: [{ name: 'interface', label: 'Interface', type: 'interface', required: true }],
  link_info: [{ name: 'interface', label: 'Interface', type: 'interface', required: true }],
  throughput_test: [
    { name: 'interface', label: 'Interface (optional - default route if omitted)', type: 'interface' },
    { name: 'duration', label: 'Duration (s)', type: 'number', default: 10 },
  ],
  set_channel: [{ name: 'channel', label: 'Channel', type: 'number' }],
  syslog: [{ name: 'lines', label: 'Lines', type: 'number', default: 100 }],
  stream_logs: [{ name: 'interface', label: 'Interface', type: 'interface', required: true }],
  stop_logs: [],
  tcpdump: [{ name: 'interface', label: 'Interface', type: 'interface', required: true }],
  stop_tcpdump: [{ name: 'interface', label: 'Interface', type: 'interface', required: true }],
  connect_wifi: [
    { name: 'ssid', label: 'SSID (ignored if BSSID is set)', type: 'text' },
    { name: 'bssid', label: 'BSSID (optional - overrides SSID)', type: 'text' },
    { name: 'password', label: 'Password (optional)', type: 'password' },
    { name: 'channel', label: 'Channel (optional - pins band+channel, ignored with BSSID)', type: 'number' },
    { name: 'interface', label: 'Interface', type: 'interface', required: true },
  ],
  disconnect_wifi: [{ name: 'interface', label: 'Interface', type: 'interface', required: true }],
  list_interfaces: [],
  scan_wifi: [{ name: 'interface', label: 'Interface', type: 'interface', required: true }],
  // Monitor-mode's own channel setter (via iw, not nmcli - see
  // pi_agent.set_monitor_channel) - no band field, since iw's "set channel"
  // infers band from the channel number, same as connect_wifi's own default.
  set_monitor_channel: [
    { name: 'interface', label: 'Interface', type: 'interface', required: true },
    { name: 'channel', label: 'Channel', type: 'number', required: true },
  ],
  // Switches an interface in place between managed and monitor mode (via
  // `iw ... set type` on the Pi - see pi_agent.set_interface_mode), instead
  // of the old permanent separate monitor interface per phy.
  set_interface_mode: [
    { name: 'interface', label: 'Interface', type: 'interface', required: true },
    {
      name: 'mode', label: 'Mode', type: 'select',
      options: [{ value: 'monitor', label: 'monitor' }, { value: 'managed', label: 'managed' }],
    },
  ],
  // Not a real Pi-agent action - see applySetInterfaceDefaults below. Applies
  // to every wifi interface of whichever Pi(s) Target resolves to, so no
  // "interface" field here (unlike every other action above).
  set_interface_defaults: [
    {
      name: 'band', label: 'Band (optional)', type: 'select',
      options: [{ value: '', label: 'any band' }, { value: 'bg', label: '2.4GHz' }, { value: 'a', label: '5GHz' }],
    },
    { name: 'channel', label: 'Channel (optional - leave both blank to clear)', type: 'number' },
  ],
};

function currentTargetInterfaces() {
  const target = targetSelect.value;
  if (!target || target === 'all' || target === 'multicast') return [];
  const pi = pis.find(p => p.pi_id === target);
  return (pi && pi.metadata && Array.isArray(pi.metadata.interfaces)) ? pi.metadata.interfaces : [];
}

function renderParamFields() {
  const fields = ACTION_PARAMS[actionSelect.value] || [];
  const interfaces = currentTargetInterfaces();
  const isMulticast = targetSelect.value === 'multicast';
  paramFields.innerHTML = fields.map(f => {
    if (f.type === 'interface') {
      // In multicast mode interfaces aren't picked here at all - each
      // targeted Pi's own configured primary interfaces are used instead,
      // fanning out one command per (Pi, interface) pair.
      if (isMulticast) {
        return `<label>${f.label}</label><div class="hint">Auto: each Pi's configured primary interface(s)</div>`;
      }
      return `<label>${f.label}</label><div class="iface-dropdown-mount" data-param="${f.name}"></div>`;
    }
    if (f.type === 'password') {
      return `
        <label>${f.label}</label>
        <div class="password-wrap">
          <input class="field" data-param="${f.name}" type="password" ${f.default !== undefined ? `value="${f.default}"` : ''}>
          <button type="button" class="password-toggle" title="Show password">${EYE_ICON_SVG}</button>
        </div>
      `;
    }
    if (f.type === 'select') {
      return `
        <label>${f.label}</label>
        <select class="field" data-param="${f.name}">
          ${f.options.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
      `;
    }
    return `
      <label>${f.label}</label>
      <input class="field" data-param="${f.name}" type="${f.type}" ${f.default !== undefined ? `value="${f.default}"` : ''}>
    `;
  }).join('');

  // set_interface_defaults has no "interface" field of its own (see
  // ACTION_PARAMS) - it always applies to every wifi interface of whichever
  // Pi(s) Target above resolves to, so make that scope explicit here.
  if (actionSelect.value === 'set_interface_defaults') {
    paramFields.insertAdjacentHTML('afterbegin',
      '<div class="hint">Applies to every wifi/monitor interface of the Pi(s) selected by Target above (all / multicast-checked / one Pi). Monitor interfaces are applied immediately; wifi interfaces on the next connect.</div>');
  }

  // The dropdown widget is real DOM built by JS, not a string - each mount
  // placeholder above gets replaced by a freshly built one, carrying the
  // data-param over so collectParams() can still find it by name.
  paramFields.querySelectorAll('.iface-dropdown-mount[data-param]').forEach(mount => {
    const box = buildIfaceDropdown();
    box.dataset.param = mount.dataset.param;
    setDropdownOptions(box, interfaces, []);
    mount.replaceWith(box);
  });
}

let lastRenderedInterfacesKey = null;

function refreshInterfaceOptions() {
  const interfaces = currentTargetInterfaces();
  const key = JSON.stringify(interfaces);
  if (key === lastRenderedInterfacesKey) return;
  lastRenderedInterfacesKey = key;

  paramFields.querySelectorAll('.iface-dropdown[data-param]').forEach(box => {
    const current = getDropdownSelected(box);
    setDropdownOptions(box, interfaces, current.filter(v => interfaces.includes(v)));
  });
}

actionSelect.addEventListener('change', renderParamFields);
targetSelect.addEventListener('change', renderParamFields);
renderTargetSelect();
renderParamFields();

// Multi-value params (currently just "interface") collect into an array;
// everything else stays a single scalar value, same as before.
function collectParams() {
  const params = {};
  paramFields.querySelectorAll('[data-param]').forEach(el => {
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

function addCommandEntry(commandId, piId, action) {
  const entry = document.createElement('div');
  entry.className = 'cmd-entry';
  entry.dataset.commandId = commandId;
  entry.innerHTML = `
    <div class="hdr"><span><span class="toggle">&#9660;</span>${action} &rarr; ${piId}</span><span><span class="cmd-status pending">pending</span><button class="icon-btn cmd-delete" title="Delete">&#128465;</button></span></div>
    <div class="result"></div>
  `;
  entry.querySelector('.hdr').addEventListener('click', (e) => {
    if (e.target.closest('.cmd-delete')) return;
    entry.classList.toggle('collapsed');
    entry.querySelector('.toggle').innerHTML = entry.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
  });
  entry.querySelector('.cmd-delete').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      // keepalive so the request still lands even if the page reloads/closes
      // right after the click - otherwise a quick reload can beat the DELETE
      // to the server and the "deleted" command reappears on next load.
      const res = await apiFetch(`${API}/commands/${commandId}`, { method: 'DELETE', keepalive: true });
      if (!res.ok && res.status !== 404) {
        alert('Failed to delete command on the server; it may reappear on reload.');
        return;
      }
    } catch {
      alert('Failed to delete command on the server; it may reappear on reload.');
      return;
    }
    entry.remove();
  });
  cmdResults.prepend(entry);
  if (action === 'scan_wifi') renderWifiScanLoading(entry.querySelector('.result'));
  pollCommand(commandId, entry, piId, action);
}

function formatResultValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    const allPrimitive = value.every(v => v === null || typeof v !== 'object');
    if (allPrimitive && value.length <= 5) return value.join(', ') || '(empty)';
    return `${value.length} item${value.length === 1 ? '' : 's'}`;
  }
  const str = String(value);
  return str.length > 200 ? `${str.slice(0, 200)}… (${str.length} chars)` : str;
}

// A "flat" object has no nested objects/arrays of its own - safe to put on
// one table row without recursing further.
function isFlatObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    Object.values(v).every(x => x === null || typeof x !== 'object');
}

// Arrays of flat objects (e.g. band_channel_info's channel lists) render as
// one compact table with a column per key, instead of one full indexed
// key-value sub-table per element - the latter is unreadable for anything
// more than 2-3 items (a 40-channel list becomes ~200 rows of noise).
function renderCompactArrayTable(container, arr) {
  const keys = [...new Set(arr.flatMap(o => Object.keys(o)))];
  const table = document.createElement('table');
  table.className = 'result-table result-array-table';
  const headRow = document.createElement('tr');
  keys.forEach(k => {
    const th = document.createElement('th');
    th.textContent = k;
    headRow.appendChild(th);
  });
  table.appendChild(headRow);
  arr.forEach(obj => {
    const row = document.createElement('tr');
    keys.forEach(k => {
      const td = document.createElement('td');
      td.textContent = formatResultValue(obj[k]);
      row.appendChild(td);
    });
    table.appendChild(row);
  });
  container.appendChild(table);
}

function renderResultTable(container, obj) {
  container.innerHTML = '';
  if (obj === null || typeof obj !== 'object') {
    container.textContent = JSON.stringify(obj);
    return;
  }
  if (Array.isArray(obj) && obj.length && obj.every(isFlatObject)) {
    renderCompactArrayTable(container, obj);
    return;
  }
  const table = document.createElement('table');
  table.className = 'result-table';
  // Arrays of objects (e.g. band_channel_info's bands) get their own indexed
  // rows instead of collapsing to "N items" - otherwise nested structured
  // data like that is invisible in the result view.
  const entries = Array.isArray(obj) ? obj.map((v, i) => [i, v]) : Object.entries(obj);
  entries.forEach(([key, value]) => {
    const isExpandable = value !== null && typeof value === 'object' &&
      (!Array.isArray(value) || value.some(v => v !== null && typeof v === 'object'));

    if (isExpandable) {
      // A nested table (e.g. a band's channel list) needs the full row
      // width to be readable - cramming it into a value cell next to its
      // label produces a squeezed, unreadable mess. Give the label its own
      // full-width row, then the nested content its own full-width row.
      const labelRow = document.createElement('tr');
      const labelCell = document.createElement('td');
      labelCell.className = 'result-key result-nested-label';
      labelCell.colSpan = 2;
      labelCell.textContent = key;
      labelRow.appendChild(labelCell);
      table.appendChild(labelRow);

      const nestedRow = document.createElement('tr');
      const nestedCell = document.createElement('td');
      nestedCell.className = 'result-nested';
      nestedCell.colSpan = 2;
      renderResultTable(nestedCell, value);
      nestedRow.appendChild(nestedCell);
      table.appendChild(nestedRow);
    } else {
      const row = document.createElement('tr');
      const keyCell = document.createElement('td');
      keyCell.className = 'result-key';
      keyCell.textContent = key;
      const valCell = document.createElement('td');
      valCell.className = 'result-value';
      valCell.textContent = formatResultValue(value);
      row.append(keyCell, valCell);
      table.appendChild(row);
    }
  });
  container.appendChild(table);
}

// Spinner + text shown in place of a scan_wifi result while the scan is
// still in flight - used by every scan_wifi entry point (plain action,
// fleet merged multi-interface scan, per-interface "Nearby networks").
function renderWifiScanLoading(container, text) {
  container.innerHTML = `
    <div class="wifi-scan-loading">
      <span class="wifi-scan-spinner"></span>
      <span>${text || 'Scanning for networks…'}</span>
    </div>
  `;
}

// Alphabetical by SSID (case-insensitive), hidden/unnamed networks last -
// applied everywhere a scanned network list gets rendered.
function sortNetworksBySsid(networks) {
  return [...networks].sort((a, b) => {
    const aSsid = a.ssid || '';
    const bSsid = b.ssid || '';
    if (!aSsid && !bSsid) return 0;
    if (!aSsid) return 1;
    if (!bSsid) return -1;
    return aSsid.localeCompare(bSsid, undefined, { sensitivity: 'base' });
  });
}

// scan_wifi's result is a list of nearby APs - shown as one collapsed card
// per SSID (reusing the same card look as the interface list) instead of
// the generic key-value table, so the scan reads as a scan rather than a
// wall of JSON. Each card expands to BSSID/signal/mode/channel/rate/security.
function renderWifiScanResults(container, networks) {
  container.innerHTML = '';
  if (!networks.length) {
    container.innerHTML = '<div class="pi-log-empty">no networks found</div>';
    return;
  }
  networks = sortNetworksBySsid(networks);

  // Same SSID filter box as the per-interface "Nearby networks" scan on
  // the Pi detail page - typing narrows this list without re-scanning.
  const searchWrap = document.createElement('div');
  searchWrap.className = 'pd-wifi-search-wrap';
  searchWrap.innerHTML = `${SEARCH_ICON_SVG}<input type="text" class="pd-wifi-search-input" placeholder="Filter by SSID…">`;
  container.appendChild(searchWrap);

  const listEl = document.createElement('div');
  listEl.className = 'pd-wifi-scan-list';
  container.appendChild(listEl);

  networks.forEach(net => {
    const card = document.createElement('div');
    card.className = 'pd-iface-card';
    card.innerHTML = `
      <div class="pd-iface-header">
        <span class="pd-iface-name">${net.ssid || '(hidden)'}</span>
        <span class="pd-iface-toggle">${chevronIconSvg('right')}</span>
      </div>
      <div class="pd-iface-body hidden"></div>
    `;
    const body = card.querySelector('.pd-iface-body');
    const rows = [
      ['BSSID', net.bssid],
      ['Mode', net.mode],
      ['Channel', net.channel],
      ['Frequency', net.frequency_mhz != null ? `${net.frequency_mhz} MHz` : null],
      ['Band', net.band],
      ['Rate', net.rate],
      ['Signal', net.signal_percent != null ? `${net.signal_percent}%` : null],
      ['Security', net.security],
    ].filter(([, v]) => v !== null && v !== undefined && v !== '');
    body.innerHTML = rows.length
      ? `<table class="result-table">${rows.map(([k, v]) =>
          `<tr><td class="result-key">${k}</td><td class="result-value">${v}</td></tr>`
        ).join('')}</table>`
      : '<div class="pi-log-empty">no data</div>';
    card.querySelector('.pd-iface-header').addEventListener('click', () => {
      const expanding = body.classList.contains('hidden');
      body.classList.toggle('hidden');
      card.querySelector('.pd-iface-toggle').innerHTML = chevronIconSvg(expanding ? 'down' : 'right');
    });
    listEl.appendChild(card);
  });

  searchWrap.querySelector('.pd-wifi-search-input').addEventListener('input', (e) => {
    applyWifiSearchFilter(listEl, e.target.value);
  });
}

// A single-target scan_wifi result (one Pi, one interface - the common
// case from the Fleet/detail Actions panel) reuses the exact same
// connect-capable card as the per-interface "Nearby networks" widget
// (renderWifiNetworkCard), instead of the connect-less plain result view -
// so scanning from the Actions panel can connect directly too, not just
// the merged multi-interface fleet scan.
function renderScanResultsWithConnect(container, piId, iface, networks) {
  container.innerHTML = '';
  if (!networks.length) {
    container.innerHTML = '<div class="pi-log-empty">no networks found</div>';
    return;
  }
  networks = sortNetworksBySsid(networks);

  const searchWrap = document.createElement('div');
  searchWrap.className = 'pd-wifi-search-wrap';
  searchWrap.innerHTML = `${SEARCH_ICON_SVG}<input type="text" class="pd-wifi-search-input" placeholder="Filter by SSID…">`;
  container.appendChild(searchWrap);

  const listEl = document.createElement('div');
  listEl.className = 'pd-wifi-scan-list';
  container.appendChild(listEl);

  // connectedBssid unknown here (no link_info fetched for this render) -
  // the "connected" badge just won't show; Connect/Disconnect still work.
  networks.forEach(net => listEl.appendChild(renderWifiNetworkCard(piId, iface, net, null)));

  searchWrap.querySelector('.pd-wifi-search-input').addEventListener('input', (e) => {
    applyWifiSearchFilter(listEl, e.target.value);
  });
}

// Single dispatch point so every place a command's result gets rendered
// (live poll, and restored history on page reload) picks scan_wifi's
// per-AP cards over the generic key-value table without duplicating logic.
function renderCommandResult(container, action, result, piId) {
  if (action === 'scan_wifi' && result && Array.isArray(result.networks)) {
    if (piId && result.interface) {
      renderScanResultsWithConnect(container, piId, result.interface, result.networks);
    } else {
      renderWifiScanResults(container, result.networks);
    }
  } else {
    renderResultTable(container, result);
  }
}

// --- set_interface_defaults: bulk band/channel default action --------------
// Not a real Pi-agent action (no MQTT round-trip) - it's a backend-only
// setting, applied to every wifi interface of however many Pis the Target
// select resolves to ("all", "multicast" via checkedPiIds, or one Pi),
// fanned out client-side as one PUT per (Pi, wifi interface) pair against
// the same endpoint the individual per-interface card control uses.
// sendCmdBtn's click handler (wifi-scan.js) special-cases this action and
// calls applySetInterfaceDefaults() instead of dispatching a real command.
function bulkDefaultTargetPiIds() {
  const target = targetSelect.value;
  if (target === 'all') return pis.map(p => p.pi_id);
  if (target === 'multicast') return [...checkedPiIds];
  return target ? [target] : [];
}

async function applySetInterfaceDefaults(params, entry) {
  const statusEl = entry.querySelector('.cmd-status');
  const resultEl = entry.querySelector('.result');
  const band = params.band || null;
  const channel = params.channel || null;

  if (!bandMatchesChannel(band, channel)) {
    const inferred = channel <= 14 ? '2.4GHz' : '5GHz';
    statusEl.textContent = 'failed';
    statusEl.className = 'cmd-status failed';
    resultEl.textContent = `Channel ${channel} is ${inferred} - pick a matching band, "any band", or a different channel.`;
    return;
  }

  const piIds = bulkDefaultTargetPiIds();
  const tasks = [];
  piIds.forEach(piId => {
    const pi = pis.find(p => p.pi_id === piId);
    const ifaces = ((pi && pi.metadata && pi.metadata.interfaces) || [])
      .filter(iface => isWifiInterface(iface) || isMonitorInterfaceName(iface));
    ifaces.forEach(iface => tasks.push({ piId, iface, isMonitor: isMonitorInterfaceName(iface) && !isWifiInterface(iface) }));
  });
  if (!tasks.length) {
    statusEl.textContent = 'failed';
    statusEl.className = 'cmd-status failed';
    resultEl.textContent = 'No wifi/monitor interfaces found on the Pi(s) selected by Target.';
    return;
  }

  // A monitor interface never goes through a connect_wifi-style event to
  // pick this default up later - it has to be applied right now too, same
  // as the per-interface card's own Save (renderInterfaceDefaultControl).
  const results = await Promise.allSettled(tasks.map(async ({ piId, iface, isMonitor }) => {
    const res = await apiFetch(`${API}/pis/${encodeURIComponent(piId)}/interfaces/${encodeURIComponent(iface)}/default`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ band, channel }),
    });
    if (!res.ok) throw new Error(`${piId}/${iface}: ${res.status} ${await res.text()}`);
    const updated = await res.json();
    const pi = pis.find(p => p.pi_id === piId);
    if (pi) pi.interface_defaults = updated.interface_defaults;

    if (isMonitor && channel) {
      const cmdRes = await postCmd(piId, 'set_monitor_channel', { interface: iface, channel });
      if (!cmdRes.ok) throw new Error(`${piId}/${iface}: applying now failed - ${cmdRes.status} ${await cmdRes.text()}`);
      const data = await cmdRes.json();
      const result = await awaitCommandResult(data.command_id, 30);
      if (!result || !result.applied) {
        throw new Error(`${piId}/${iface}: saved as default, but applying it now failed - ${(result && result.output) || 'unknown error'}`);
      }
    }
  }));

  const failed = results.filter(r => r.status === 'rejected');
  statusEl.textContent = failed.length ? 'failed' : 'complete';
  statusEl.className = `cmd-status ${failed.length ? 'failed' : 'complete'}`;
  resultEl.textContent = failed.length
    ? `Applied to ${tasks.length - failed.length}/${tasks.length}. Failed:\n${failed.map(r => r.reason.message).join('\n')}`
    : `Applied to all ${tasks.length} wifi interface(s) across ${piIds.length} Pi(s).`;
}

// Same cmd-entry look as a real command (see addCommandEntry) so it sits in
// the same results feed, but with no command_id/polling - the work here is
// a handful of synchronous-ish PUTs, not a Pi round-trip.
function addSetInterfaceDefaultsEntry(params) {
  const entry = document.createElement('div');
  entry.className = 'cmd-entry';
  entry.innerHTML = `
    <div class="hdr"><span><span class="toggle">&#9660;</span>set_interface_defaults</span><span><span class="cmd-status pending">pending</span></span></div>
    <div class="result"></div>
  `;
  entry.querySelector('.hdr').addEventListener('click', () => {
    entry.classList.toggle('collapsed');
    entry.querySelector('.toggle').innerHTML = entry.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
  });
  cmdResults.prepend(entry);
  applySetInterfaceDefaults(params, entry);
}

