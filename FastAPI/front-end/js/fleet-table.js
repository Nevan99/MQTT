// --- Fleet: Pi list -------------------------------------------------------

const piTableBody = document.getElementById('piTableBody');
const targetSelect = document.getElementById('targetSelect');
const targetHint = document.getElementById('targetHint');
let pis = [];
let selectedPiId = null;

// Pi ids checked in the fleet table's select column. Independent of
// targetSelect's own value/DOM - this is what actually drives "multicast".
const checkedPiIds = new Set();

// Rebuilds the Target dropdown's options (all / multicast / one per Pi) and
// auto-switches to "multicast" the moment more than one Pi is checked in the
// table, per the requirement that multi-selecting Pis there should drive the
// dropdown rather than the other way around.
//
// Called on every 5s refreshPis() poll (fleet composition can change at any
// time), so this only touches the DOM - and only calls renderParamFields(),
// which wipes the whole param form - when something actually changed.
// Otherwise a field mid-edit (e.g. wifi SSID/password) gets reset out from
// under the user's typing every single poll.
let lastTargetOptionsKey = null;

function renderTargetSelect() {
  const current = targetSelect.value;
  const optionsKey = JSON.stringify([pis.map(p => p.pi_id), checkedPiIds.size > 1]);

  if (optionsKey !== lastTargetOptionsKey) {
    lastTargetOptionsKey = optionsKey;
    const options = ['<option value="all">all (broadcast)</option>'];
    if (checkedPiIds.size > 1) {
      options.push(`<option value="multicast">multicast (${checkedPiIds.size} selected)</option>`);
    }
    options.push(...pis.map(p => `<option value="${p.pi_id}">${p.pi_id}</option>`));
    targetSelect.innerHTML = options.join('');

    if (checkedPiIds.size > 1) {
      targetSelect.value = 'multicast';
    } else if ([...targetSelect.options].some(o => o.value === current)) {
      targetSelect.value = current;
    }
  }

  const isMulticast = targetSelect.value === 'multicast';
  targetHint.style.display = isMulticast ? 'block' : 'none';
  targetHint.textContent = isMulticast
    ? `Sends to the ${checkedPiIds.size} Pi(s) checked in the table above, one command per each Pi's own configured primary interface(s).`
    : '';

  if (targetSelect.value !== current) renderParamFields();
}

// One entry per Pi: { summaryRow, logRow, logPanel, expanded, ws }.
// Kept alive across refreshPis() calls so expanding a row and its live
// log feed survive the 5s poll instead of being torn down and rebuilt.
const piRows = new Map();

function statusBadge(status) {
  const cls = status === 'online' ? 'badge-online' : status === 'offline' ? 'badge-offline' : 'badge-unassigned';
  return `<span class="badge ${cls}">${status}</span>`;
}

// Shared toggle-dropdown-of-checkboxes widget, used for both the fleet
// table's Primary IF column and the Action panel's Interface param - lets a
// Pi have several primary interfaces, and a command target several
// interfaces at once, presented closed (a one-line summary) until clicked,
// rather than a native <select multiple> permanently taking up space.
function buildIfaceDropdown() {
  const wrap = document.createElement('div');
  wrap.className = 'iface-dropdown field';
  wrap.innerHTML = `
    <button type="button" class="iface-dropdown-toggle">select interface(s)</button>
    <div class="iface-dropdown-panel hidden"></div>
  `;
  const toggle = wrap.querySelector('.iface-dropdown-toggle');
  const panel = wrap.querySelector('.iface-dropdown-panel');
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = !panel.classList.contains('hidden');
    // Only one dropdown open at a time, anywhere on the page.
    document.querySelectorAll('.iface-dropdown-panel').forEach(p => p.classList.add('hidden'));
    if (!wasOpen) panel.classList.remove('hidden');
  });
  // Keeps clicks inside the panel (checkbox rows) from bubbling to the
  // document-level listener below, which would immediately close it, and
  // from bubbling to a Pi row's own click handler (which sets the target).
  wrap.addEventListener('click', (e) => e.stopPropagation());
  return wrap;
}

// One global listener closes whatever dropdown is open when clicking
// anywhere else on the page - registered once, not per widget instance.
document.addEventListener('click', () => {
  document.querySelectorAll('.iface-dropdown-panel').forEach(p => p.classList.add('hidden'));
});

// Slim chevron used for every collapse/expand toggle (side panels and the
// syslog/tcpdump blocks) - one thin stroked path, just rotated per
// direction, instead of the bold filled-triangle unicode glyphs.
function chevronIconSvg(direction) {
  const rotation = { right: 0, down: 90, left: 180, up: 270 }[direction] || 0;
  return `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate(${rotation}deg);"><polyline points="9 6 15 12 9 18"/></svg>`;
}

// Play/stop glyphs for the explicit "start streaming" toggle on the
// tcpdump panel - separate from the view expand/collapse chevron, so
// opening the panel to look at a previous capture doesn't itself start a
// new live capture.
const CLOSE_ICON_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const PLAY_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg>`;
const STOP_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="6" y="6" width="12" height="12"/></svg>`;

// Open-eye / eye-with-slash glyphs for the password show/hide toggle,
// replacing the old eye/see-no-evil-monkey emoji pair with a matched icon
// set consistent with the app's other inline-SVG icons.
const EYE_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/>
  <circle cx="12" cy="12" r="3"/>
</svg>`;
const EYE_OFF_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 12s4-7 11-7c2.1 0 3.9.5 5.4 1.2M23 12s-4 7-11 7c-2.1 0-3.9-.5-5.4-1.2"/>
  <path d="M9.5 9.5a3 3 0 0 0 4.2 4.2"/>
  <line x1="1" y1="1" x2="23" y2="23"/>
</svg>`;

// Delegated show/hide toggle for every password field on the page (login
// form and any dynamically-built Action panel password param) - one
// listener instead of wiring each toggle button individually, so newly
// rendered password fields (e.g. after switching actions) work for free.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.password-toggle');
  if (!btn) return;
  const input = btn.closest('.password-wrap')?.querySelector('input');
  if (!input) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.innerHTML = showing ? EYE_ICON_SVG : EYE_OFF_ICON_SVG;
  btn.title = showing ? 'Show password' : 'Hide password';
});

function setDropdownOptions(wrap, interfaces, selectedValues, onChange) {
  const panel = wrap.querySelector('.iface-dropdown-panel');
  if (!interfaces.length) {
    panel.innerHTML = '<div class="pi-log-empty">no interfaces</div>';
    updateDropdownLabel(wrap);
    return;
  }

  panel.innerHTML = `
    <label class="iface-row iface-row-all">
      <input type="checkbox" class="iface-select-all">
      Select all
    </label>
  ` + interfaces.map(i => `<label class="iface-row"><input type="checkbox" value="${i}">${i}</label>`).join('');

  const selectAllCb = panel.querySelector('.iface-select-all');
  const itemCbs = [...panel.querySelectorAll('input[type="checkbox"]:not(.iface-select-all)')];
  itemCbs.forEach(cb => { cb.checked = selectedValues.includes(cb.value); });

  function syncSelectAll() {
    const checkedCount = itemCbs.filter(cb => cb.checked).length;
    selectAllCb.checked = checkedCount === itemCbs.length;
    selectAllCb.indeterminate = checkedCount > 0 && checkedCount < itemCbs.length;
  }
  syncSelectAll();

  // Assigning .onchange (not addEventListener) so rebuilding this panel in
  // place doesn't accumulate duplicate listeners across renderPis() polls.
  itemCbs.forEach(cb => {
    cb.onchange = () => {
      syncSelectAll();
      updateDropdownLabel(wrap);
      if (onChange) onChange();
    };
  });
  selectAllCb.onchange = () => {
    itemCbs.forEach(cb => { cb.checked = selectAllCb.checked; });
    selectAllCb.indeterminate = false;
    updateDropdownLabel(wrap);
    if (onChange) onChange();
  };

  updateDropdownLabel(wrap);
}

function updateDropdownLabel(wrap) {
  const selected = getDropdownSelected(wrap);
  wrap.querySelector('.iface-dropdown-toggle').textContent = selected.length ? selected.join(', ') : 'select interface(s)';
}

// Excludes the "select all" checkbox itself - only real interface values.
function getDropdownSelected(wrap) {
  return [...wrap.querySelectorAll('input[type="checkbox"]:checked:not(.iface-select-all)')].map(cb => cb.value);
}

// Category -> which panel it's routed to. registration/status/result are
// command acks and fleet metadata, not something to show in a log feed.
// Both categories now arrive via capture_socket_server.py's view-only
// socket connections (stream_syslog/stream_tcpdump) instead of MQTT, but
// the category names and this routing are unchanged - only the transport
// on the backend moved.
const CATEGORY_PANEL = { logs: 'logPanel', tcpdump: 'tcpdumpPanel' };

function connectPiLog(piId, entry) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Server-side filtered: the backend only forwards messages for this device_id.
  const ws = new WebSocket(withToken(`${proto}://${location.host}/ws/live/${encodeURIComponent(piId)}`));

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const panelKey = CATEGORY_PANEL[msg.category];
    if (!panelKey) return;
    const payload = msg.payload !== undefined ? msg.payload : msg;
    // tcpdump lines arrive batched (capture_socket_server groups whatever
    // decoded from one read-chunk into one message instead of publishing
    // per packet, to avoid flooding the browser on busy interfaces) - logs
    // lines still arrive one per message.
    const lines = Array.isArray(payload) ? payload : [payload];

    // Only show lines for the interface actually being streamed - tracked
    // separately from the dropdown's live value (entry.<kind>ActiveIface,
    // set when the stream is actually started/stopped) rather than read
    // straight off the <select> here. refreshDetailLogIfaceOptions rebuilds
    // that <select>'s options on every interfaces refresh and can
    // transiently reset its value to "" for a tick if the interface list
    // it's rebuilding from doesn't (yet) include the current selection -
    // reading the live value at message-arrival time meant that one bad
    // tick silently dropped every packet from then on, even though the
    // stream itself kept running fine server-side.
    const selectedIface = entry[msg.category + 'ActiveIface'];
    if (!selectedIface) return;

    const panel = entry[panelKey];
    if (msg.category === 'tcpdump') {
      const tbody = panel.querySelector('tbody');
      if (tbody) {
        lines.filter(line => line && line.interface === selectedIface)
          .forEach(line => appendPacketRow(tbody, line));
      }
      return;
    }

    const empty = panel.querySelector('.pi-log-empty');
    if (empty) empty.remove();
    lines.forEach(line => appendLineTo(panel, line));

    // Nothing is persisted server-side for these streams, so a capture in
    // progress buffers lines here, live, as they arrive.
    const active = entry.captureState && entry.captureState[msg.category];
    if (active) lines.forEach(line => active.lines.push(line));
  };

  return ws;
}

// Each Pi has two independently-collapsible windows sharing one lazily
// opened WebSocket; the socket stays open as long as either is expanded.
const PANELS = [
  { kind: 'logs', rowKey: 'logRow', panelKey: 'logPanel', toggleKey: 'logToggle', expandedKey: 'logExpanded', label: 'syslog / stream_logs', short: 'syslog / stream_logs' },
  { kind: 'tcpdump', rowKey: 'tcpdumpRow', panelKey: 'tcpdumpPanel', toggleKey: 'tcpdumpToggle', expandedKey: 'tcpdumpExpanded', label: 'tcpdump', short: 'tcpdump' },
];

// Polls a command until it's no longer pending and returns its result (or
// throws on failure/timeout), mirroring pollCommand() below but returning
// instead of rendering into the command-builder feed.
async function awaitCommandResult(commandId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await apiFetch(`${API}/commands/${commandId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.status === 'complete') return data.result;
      if (data.status === 'failed' || data.status === 'timeout') {
        throw new Error(data.result?.error || `command ${data.status}`);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('timed out waiting for the Pi');
}

// Start/stop capture (the RECORDING feature - separate from the streaming
// view toggle below). Nothing is persisted server-side for either live
// stream until a capture is actually armed:
//  - syslog: lines are buffered client-side (see connectPiLog's
//    ws.onmessage) for exactly the window between Start and Stop, then
//    saved as a text capture via POST /captures - so the panel must stay
//    expanded (WebSocket connected) for the whole capture.
//  - tcpdump: a wholly separate tcpdump process on the Pi (start_pcap_capture)
//    pipes raw pcap bytes to capture_socket_server over its own socket
//    connection, saved straight to a .pcap file - independent of the
//    view-only decoded stream, both can run on the same interface at once.
async function toggleCapture(piId, spec, entry, btn) {
  if (spec.kind === 'tcpdump') return togglePcapCapture(piId, entry, btn);

  entry.captureState = entry.captureState || {};
  const active = entry.captureState[spec.kind];

  if (!active) {
    const name = prompt('Capture name:', `${piId}-${spec.kind}-${new Date().toISOString().slice(0, 19)}`);
    if (!name) return;
    entry.captureState[spec.kind] = { name, lines: [] };
    btn.innerHTML = '&#9209;';
    btn.title = 'Stop Capture';
    btn.classList.add('recording');
    return;
  }

  entry.captureState[spec.kind] = null;
  btn.innerHTML = '&#9210;';
  btn.title = 'Start Capture';
  btn.classList.remove('recording');
  btn.disabled = true;
  try {
    if (!active.lines.length) {
      alert('No logs arrived during that capture window.');
      return;
    }
    const res = await apiFetch(`${API}/captures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pi_id: piId, category: spec.kind, name: active.name, lines: active.lines }),
    });
    if (!res.ok) {
      alert('Captured the logs but failed to save the file on the server.');
      return;
    }
    await loadCaptures();
  } catch {
    alert('Failed to save the capture.');
  } finally {
    btn.disabled = false;
  }
}

async function togglePcapCapture(piId, entry, btn) {
  const iface = entry.tcpdumpIfaceSelect ? entry.tcpdumpIfaceSelect.value : '';

  if (!entry.pcapState) {
    if (!iface) {
      alert('Select an interface for the tcpdump panel first.');
      return;
    }
    const name = prompt('Capture name:', `${piId}-pcap-${new Date().toISOString().slice(0, 19)}`);
    if (!name) return;

    btn.disabled = true;
    try {
      const res = await postCmd(piId, 'start_pcap_capture', { interface: iface, name });
      if (!res.ok) {
        alert('Failed to start PCAP capture.');
        return;
      }
      const data = await res.json();
      await awaitCommandResult(data.command_id);
    } catch (err) {
      alert(`Failed to start PCAP capture: ${err.message}`);
      return;
    } finally {
      btn.disabled = false;
    }

    entry.pcapState = { name, interface: iface };
    btn.innerHTML = '&#9209;';
    btn.title = 'Stop Capture';
    btn.classList.add('recording');
    return;
  }

  const { interface: capturedIface } = entry.pcapState;
  entry.pcapState = null;
  btn.innerHTML = '&#9210;';
  btn.title = 'Start Capture';
  btn.classList.remove('recording');
  btn.disabled = true;
  try {
    // The pcap has been streaming live to the backend since Start was
    // clicked (see start_pcap_capture on the Pi), so stopping only has to
    // tear down tcpdump and flush whatever's left in flight - not upload an
    // entire finished file - and should resolve quickly.
    const res = await postCmd(piId, 'stop_pcap_capture', { interface: capturedIface });
    if (!res.ok) {
      alert('Failed to stop PCAP capture.');
      return;
    }
    const data = await res.json();
    const result = await awaitCommandResult(data.command_id, 30);
    if (!result || !result.saved) {
      alert('PCAP capture stopped but was not saved on the server.');
      return;
    }
    await loadCaptures();
  } catch (err) {
    alert(`Failed to stop PCAP capture: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function clearPanel(piId, spec, panel) {
  if (!confirm(`Clear ${spec.label} for ${piId}? This removes the saved history too.`)) return;
  resetLogPanel(panel, spec);
}

function postCmd(piId, action, params) {
  return apiFetch(`${API}/pis/${encodeURIComponent(piId)}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params }),
  });
}

// Sends connect_wifi and, if the Pi reports it didn't connect, sends it
// exactly one more time before giving up - covers the common case of a
// one-off transient failure (AP busy, brief scan/negotiation hiccup)
// without silently retrying forever. Returns whichever attempt's result
// (the successful one, or the last failure if both attempts failed).
async function connectWifiWithRetry(piId, params, maxAttempts = 2) {
  let result = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await postCmd(piId, 'connect_wifi', params);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json();
    result = await awaitCommandResult(data.command_id, 320);
    if (result && result.connected) return result;
  }
  return result;
}

const STREAM_START_ACTION = { logs: 'stream_logs', tcpdump: 'tcpdump' };
const STREAM_STOP_ACTION = { logs: 'stop_logs', tcpdump: 'stop_tcpdump' };

// Explicit start/stop for the tcpdump panel's live capture - a dedicated
// button (▶/■), separate from the panel's own expand/collapse chevron, so
// opening the panel to look at previously-captured packets doesn't itself
// kick off a brand new live capture. Returns the new streaming state
// (true/false), or null if the request failed (caller should leave state
// untouched in that case).
async function performToggleTcpdumpStream(piId, iface, btn, panel) {
  if (!iface) {
    alert('No interface for this panel.');
    return null;
  }
  const starting = !btn.classList.contains('streaming');
  btn.disabled = true;
  try {
    await postCmd(piId, starting ? 'tcpdump' : 'stop_tcpdump', { interface: iface });
  } catch (err) {
    alert(`Failed to ${starting ? 'start' : 'stop'} streaming: ${err.message}`);
    return null;
  } finally {
    btn.disabled = false;
  }
  btn.classList.toggle('streaming', starting);
  btn.innerHTML = starting ? STOP_ICON_SVG : PLAY_ICON_SVG;
  btn.title = starting ? 'Stop streaming' : 'Start streaming';

  // Pause state (from scrolling up to inspect old packets) otherwise
  // survives collapsing/re-expanding the panel and stopping/restarting the
  // stream, since only switching to a different Pi ever clears it
  // (resetLogPanel). Starting a fresh capture is a clear enough signal
  // that the user wants live view again, regardless of where they'd left
  // the scrollbar last time.
  if (starting && panel) {
    const tbody = panel.querySelector('tbody');
    if (tbody) resumeLiveCapture(tbody);
  }
  return starting;
}

// Called only from the explicit Watch/Stop toggle, never from picking an
// interface in a dropdown by itself - selecting an interface is just
// choosing a target, it has no side effects on its own. Wipes the panel
// locally on every call, since re-pointing at a new interface would
// otherwise leave old lines from the previous one sitting alongside (or
// ahead of) new ones. tcpdump can run several interfaces at once
// server-side, so switching here also explicitly stops the previously
// watched one; syslog only ever runs one stream per Pi.
async function setStreamInterface(piId, entry, spec, interface_) {
  const panel = entry[spec.panelKey];
  resetLogPanel(panel, spec);
  const prevIfaceKey = spec.kind + 'ActiveIface';
  const prevIface = entry[prevIfaceKey];
  try {
    if (prevIface && (spec.kind === 'tcpdump' ? prevIface !== interface_ : !interface_)) {
      await postCmd(piId, STREAM_STOP_ACTION[spec.kind], { interface: prevIface });
    }
    entry[prevIfaceKey] = interface_ || null;
    if (!interface_) return; // no interface selected - stream stays stopped
    await postCmd(piId, STREAM_START_ACTION[spec.kind], { interface: interface_ });
  } catch {
    // backend unreachable; panel is cleared locally regardless, next refresh will retry
  }
}

// One shared WebSocket per Pi, routing incoming lines to whichever
// *interface card's* panel they belong to instead of a single Pi-level
// panel:
//  - tcpdump: each line carries its own "interface" field (see
//    capture_socket_server.py's stream_tcpdump handler), so lines route to
//    the matching card - several interfaces can stream tcpdump concurrently.
//  - logs (syslog): the agent only ever runs one syslog stream per Pi at a
//    time (start_syslog_stream replaces any other), so lines route to
//    whichever single card currently has its syslog panel open.
function connectFleetPiLog(piId, entry) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(withToken(`${proto}://${location.host}/ws/live/${encodeURIComponent(piId)}`));

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const panelKey = CATEGORY_PANEL[msg.category];
    if (!panelKey) return;
    const payload = msg.payload !== undefined ? msg.payload : msg;
    const lines = Array.isArray(payload) ? payload : [payload];

    const appendTo = (cardState, cardLines) => {
      const panel = cardState[panelKey];
      const empty = panel.querySelector('.pi-log-empty');
      if (empty) empty.remove();
      cardLines.forEach(line => appendLineTo(panel, line));
      const active = cardState.captureState && cardState.captureState[msg.category];
      if (active) cardLines.forEach(line => active.lines.push(line));
    };

    if (msg.category === 'tcpdump') {
      const byIface = new Map();
      lines.forEach(line => {
        const iface = line && line.interface;
        if (!byIface.has(iface)) byIface.set(iface, []);
        byIface.get(iface).push(line);
      });
      byIface.forEach((ifaceLines, iface) => {
        const cardState = entry.ifaceCards.get(iface);
        if (!cardState || !cardState.tcpdumpStreaming) return;
        const tbody = cardState[panelKey].querySelector('tbody');
        if (tbody) ifaceLines.forEach(line => appendPacketRow(tbody, line));
      });
    } else {
      let target = null;
      entry.ifaceCards.forEach(cardState => { if (cardState.logExpanded) target = cardState; });
      if (target) appendTo(target, lines);
    }
  };

  return ws;
}

// Opens/closes one interface card's syslog or tcpdump viewing panel (the
// STREAMING toggle - separate from the Start/Stop Capture recording
// button above). syslog also starts/stops the actual stream on the Pi
// (the agent only runs one at a time, so opening a different card's
// syslog panel first closes whichever other card on this Pi had it open).
// tcpdump stays view-only through its own dedicated stream_tcpdump
// connection (see pi_agent.py's start_tcpdump_stream) - independent of the
// separate recording process, both can run on the same interface at once.
// Pure view expand/collapse for syslog: syslog still auto-starts/stops on
// this toggle (the agent only ever runs one stream at a time, so there's
// nothing to separately "arm" - opening the panel IS the request to watch
// it). tcpdump does NOT auto-stream from this toggle anymore - it only
// shows/hides the packet table; starting/stopping the actual capture is
// the explicit "start streaming" button (see toggleFleetTcpdumpStream).
async function toggleFleetIfaceLogPanel(piId, entry, cardState, spec) {
  const expanding = !cardState[spec.expandedKey];

  if (spec.kind === 'logs' && expanding) {
    entry.ifaceCards.forEach((other) => {
      if (other !== cardState && other.logExpanded) {
        other.logExpanded = false;
        other.logRow.classList.add('pd-log-collapsed');
        other.logToggle.innerHTML = chevronIconSvg('down');
        other.logToggle.title = 'Expand';
      }
    });
  }

  cardState[spec.expandedKey] = expanding;
  cardState[spec.rowKey].classList.toggle('pd-log-collapsed', !expanding);
  cardState[spec.toggleKey].innerHTML = chevronIconSvg(expanding ? 'up' : 'down');
  cardState[spec.toggleKey].title = expanding ? 'Collapse' : 'Expand';

  if (expanding && !cardState[spec.panelKey].children.length) {
    cardState[spec.panelKey].innerHTML = '<div class="pi-log-empty">waiting for messages…</div>';
  }

  if (spec.kind === 'logs') {
    try {
      await postCmd(piId, expanding ? STREAM_START_ACTION.logs : STREAM_STOP_ACTION.logs, { interface: cardState.iface });
    } catch {
      // backend unreachable; UI still reflects the toggle, next attempt will retry
    }
  }

  const anyOpen = [...entry.ifaceCards.values()].some(c => c.logExpanded || c.tcpdumpStreaming);
  if (anyOpen && !entry.ws) {
    entry.ws = connectFleetPiLog(piId, entry);
  } else if (!anyOpen && entry.ws) {
    entry.ws.close();
    entry.ws = null;
  }
}

// Fleet wrapper for the tcpdump panel's explicit start/stop streaming
// button - manages the shared per-Pi websocket around the common
// start/stop core (performToggleTcpdumpStream).
async function toggleFleetTcpdumpStream(piId, entry, cardState, btn) {
  const starting = await performToggleTcpdumpStream(piId, cardState.iface, btn, cardState.tcpdumpPanel);
  if (starting === null) return;
  cardState.tcpdumpStreaming = starting;

  // Starting a stream while the packet table's row is still collapsed
  // would accumulate rows nobody can see (the row itself is display:none
  // until its own chevron is expanded) - auto-expand it so packets are
  // visible immediately. This doesn't reintroduce auto-streaming-on-
  // toggle: it's the view following an explicit start, not the reverse.
  if (starting && !cardState.tcpdumpExpanded) {
    cardState.tcpdumpExpanded = true;
    cardState.tcpdumpRow.classList.remove('pd-log-collapsed');
    cardState.tcpdumpToggle.innerHTML = chevronIconSvg('up');
    cardState.tcpdumpToggle.title = 'Collapse';
  }

  const anyOpen = [...entry.ifaceCards.values()].some(c => c.logExpanded || c.tcpdumpStreaming);
  if (anyOpen && !entry.ws) {
    entry.ws = connectFleetPiLog(piId, entry);
  } else if (!anyOpen && entry.ws) {
    entry.ws.close();
    entry.ws = null;
  }
}

// Expands/collapses one interface card's info body (list_interfaces +
// link_info details), fetching on first expand and caching per Pi.
async function toggleFleetIfaceCard(piId, entry, cardState) {
  const body = cardState.card.querySelector('.pd-iface-body');
  const toggleEl = cardState.card.querySelector('.pd-iface-toggle');
  const expanding = body.classList.contains('hidden');
  body.classList.toggle('hidden', !expanding);
  toggleEl.innerHTML = chevronIconSvg(expanding ? 'down' : 'right');
  if (!expanding) return;
  if (!cardState.infoEl.innerHTML.trim()) {
    cardState.infoEl.innerHTML = '<div class="pi-log-empty">loading…</div>';
    await loadFleetIfaceInfo(piId, entry, cardState.iface);
  }
  renderFleetIfaceBody(entry, cardState);
}

async function fetchFleetIfaceDetails(piId, entry) {
  if (entry.ifaceDetailsCache !== null) return entry.ifaceDetailsCache;
  if (!entry.ifaceDetailsPromise) {
    entry.ifaceDetailsPromise = (async () => {
      try {
        const res = await postCmd(piId, 'list_interfaces', {});
        if (res.ok) {
          const data = await res.json();
          const result = await awaitCommandResult(data.command_id, 10);
          entry.ifaceDetailsCache = (result && result.interfaces) || [];
        } else {
          entry.ifaceDetailsCache = [];
        }
      } catch {
        entry.ifaceDetailsCache = [];
      }
      return entry.ifaceDetailsCache;
    })();
  }
  return entry.ifaceDetailsPromise;
}

async function loadFleetIfaceInfo(piId, entry, iface) {
  await fetchFleetIfaceDetails(piId, entry);
  if (isWifiInterface(iface) && !(iface in entry.linkInfoCache)) {
    try {
      const res = await postCmd(piId, 'link_info', { interface: iface });
      if (res.ok) {
        const data = await res.json();
        entry.linkInfoCache[iface] = await awaitCommandResult(data.command_id, 10);
      }
    } catch {
      // leave unset - body will just omit the wifi rows
    }
  }
}

function renderFleetIfaceBody(entry, cardState) {
  const details = (entry.ifaceDetailsCache || []).find(d => d.name === cardState.iface);
  const link = entry.linkInfoCache[cardState.iface];
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
    if (link.signal_dbm != null) rows.push(['Signal', `${link.signal_dbm} dBm`]);
    if (link.rx_bitrate_mbps != null) rows.push(['RX bitrate', `${link.rx_bitrate_mbps} Mbps`]);
    if (link.tx_bitrate_mbps != null) rows.push(['TX bitrate', `${link.tx_bitrate_mbps} Mbps`]);
  }
  cardState.infoEl.innerHTML = rows.length
    ? `<table class="result-table">${rows.map(([k, v]) =>
        `<tr><td class="result-key">${k}</td><td class="result-value">${v ?? ''}</td></tr>`
      ).join('')}</table>`
    : '<div class="pi-log-empty">no data</div>';

  if (link && link.connected) {
    cardState.infoEl.insertAdjacentHTML('beforeend',
      '<div class="wifi-disconnect-row"><button type="button" class="wifi-disconnect-btn">Disconnect</button></div>');
    cardState.infoEl.querySelector('.wifi-disconnect-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      disconnectFleetWifi(cardState, e.currentTarget);
    });
  }
}

// Disconnects one interface card's wifi directly (no need to go through
// the Actions panel or a scanned network's own Disconnect button).
async function disconnectFleetWifi(cardState, btn) {
  const piId = cardState.piId;
  btn.disabled = true;
  btn.textContent = 'Disconnecting…';
  try {
    const res = await postCmd(piId, 'disconnect_wifi', { interface: cardState.iface });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json();
    await awaitCommandResult(data.command_id, 320);
  } catch (err) {
    alert(`Failed to disconnect: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Disconnect';
  }
  const entry = piRows.get(piId);
  if (entry) {
    // IP address goes away on disconnect too, same as it changes on
    // connect - force a fresh read instead of showing the stale one.
    entry.ifaceDetailsCache = null;
    entry.ifaceDetailsPromise = null;
    refreshFleetWifiIcon(piId, entry, cardState);
  }
}

// Colors one card's wifi icon and "connected — SSID" mark via link_info -
// called for every wifi-capable interface card, not just primary ones, so
// connection status is visible fleet-wide (mirrors the Pi detail page).
async function refreshFleetWifiIcon(piId, entry, cardState) {
  if (!isWifiInterface(cardState.iface) || !cardState.wifiIconEl) return;
  try {
    const res = await postCmd(piId, 'link_info', { interface: cardState.iface });
    if (!res.ok) return;
    const data = await res.json();
    const result = await awaitCommandResult(data.command_id, 10);
    entry.linkInfoCache[cardState.iface] = result;
    const connected = !!(result && result.connected);
    cardState.wifiIconEl.classList.remove('wifi-unknown');
    cardState.wifiIconEl.classList.add(connected ? 'wifi-connected' : 'wifi-disconnected');
    cardState.wifiIconEl.title = connected ? `Wi-Fi connected${result.ssid ? ' — ' + result.ssid : ''}` : 'Wi-Fi not connected';
    cardState.connectedMarkEl.classList.toggle('hidden', !connected);
    if (connected) cardState.connectedMarkEl.textContent = result.ssid ? `connected — ${result.ssid}` : 'connected';
    if (!cardState.card.querySelector('.pd-iface-body').classList.contains('hidden')) {
      renderFleetIfaceBody(entry, cardState);
    }
  } catch {
    // leave as "unknown" - backend/Pi unreachable or command timed out
  }
}

async function saveFleetPrimaryInterfaces(piId, entry) {
  const checkboxes = [...entry.ifaceCards.values()].map(c => c.checkboxEl);
  const selected = [...entry.ifaceCards.values()].filter(c => c.checkboxEl.checked).map(c => c.iface);
  checkboxes.forEach(cb => cb.disabled = true);
  try {
    const res = await apiFetch(`${API}/pis/${encodeURIComponent(piId)}/primary-interface`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primary_interfaces: selected }),
    });
    if (!res.ok) {
      alert('Failed to set primary interfaces.');
      return;
    }
    const updated = await res.json();
    const pi = pis.find(p => p.pi_id === piId);
    if (pi) pi.primary_interfaces = updated.primary_interfaces;
  } catch {
    alert('Failed to set primary interfaces.');
  } finally {
    checkboxes.forEach(cb => cb.disabled = false);
  }
}

// One interface card in a Pi's expanded row: checkbox to mark it primary
// (same PATCH endpoint/semantics as before, just moved out of a closed
// dropdown), a wifi icon + "connected — SSID" mark, a toggle that reveals
// list_interfaces/link_info details, and its own syslog/tcpdump viewers -
// each with an independent streaming toggle (view, socket-based) and a
// separate Start/Stop Capture button (recording, saved to the Captures tab).
function buildFleetIfaceCard(piId, entry, iface) {
  const isWifi = isWifiInterface(iface);
  const card = document.createElement('div');
  card.className = 'pd-iface-card';
  card.dataset.iface = iface;
  card.innerHTML = `
    <div class="pd-iface-header">
      <input type="checkbox" class="fleet-iface-primary-checkbox" title="Use as primary interface for multi-target actions">
      <span class="pd-iface-name">${iface}</span>
      ${isWifi ? `
        <span class="wifi-icon wifi-unknown" title="checking…">${WIFI_ICON_SVG}</span>
        <span class="pd-iface-connected-mark badge badge-online hidden"></span>
      ` : ''}
      <span class="pd-iface-toggle">${chevronIconSvg('right')}</span>
    </div>
    <div class="pd-iface-body hidden">
      <div class="pd-iface-info"></div>
    </div>
  `;

  const body = card.querySelector('.pd-iface-body');
  const checkboxEl = card.querySelector('.fleet-iface-primary-checkbox');

  const cardState = {
    piId, iface, card, checkboxEl,
    infoEl: card.querySelector('.pd-iface-info'),
    wifiIconEl: card.querySelector('.wifi-icon'),
    connectedMarkEl: card.querySelector('.pd-iface-connected-mark'),
    captureState: null, pcapState: null, tcpdumpStreaming: false,
    tcpdumpIfaceSelect: { value: iface },
  };

  PANELS.forEach(spec => {
    const isTcpdump = spec.kind === 'tcpdump';
    const row = document.createElement('div');
    row.className = 'pd-log-block pd-log-collapsed';
    row.innerHTML = `
      <div class="pi-log-heading">
        <span>${spec.label}</span>
        <span class="pi-log-actions">
          ${isTcpdump ? `<button class="pi-log-stream icon-btn" type="button" title="Start streaming">${PLAY_ICON_SVG}</button>` : ''}
          <button class="pi-log-capture icon-btn" type="button" title="Start Capture">&#9210;</button>
          <button class="pi-log-clear icon-btn" type="button" title="Clear">&#128465;</button>
          <button class="pi-log-collapse icon-btn" type="button" title="Expand">${chevronIconSvg('down')}</button>
        </span>
      </div>
      <div class="pi-log-panel${isTcpdump ? ' wireshark-table-wrap' : ''}">${isTcpdump ? WIRESHARK_TABLE_HTML : ''}</div>
    `;
    body.appendChild(row);

    cardState[spec.rowKey] = row;
    cardState[spec.panelKey] = row.querySelector('.pi-log-panel');
    cardState[spec.toggleKey] = row.querySelector('.pi-log-collapse');
    cardState[spec.expandedKey] = false;
    if (isTcpdump) setupWiresharkTable(cardState[spec.panelKey]);

    cardState[spec.toggleKey].addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFleetIfaceLogPanel(piId, entry, cardState, spec);
    });
    if (isTcpdump) {
      row.querySelector('.pi-log-stream').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFleetTcpdumpStream(piId, entry, cardState, e.currentTarget);
      });
    }
    row.querySelector('.pi-log-capture').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCapture(piId, spec, cardState, e.currentTarget);
    });
    row.querySelector('.pi-log-clear').addEventListener('click', (e) => {
      e.stopPropagation();
      clearPanel(piId, spec, cardState[spec.panelKey]);
    });
  });

  checkboxEl.addEventListener('click', (e) => e.stopPropagation());
  checkboxEl.addEventListener('change', () => saveFleetPrimaryInterfaces(piId, entry));

  card.querySelector('.pd-iface-header').addEventListener('click', () => toggleFleetIfaceCard(piId, entry, cardState));

  return cardState;
}

// Rebuilds every interface card for a Pi (only when its interface set
// actually changes) - tears down the shared websocket first since cards
// (and their expanded/streaming state) are being thrown away.
function rebuildFleetIfaceCards(piId, entry, interfaces) {
  if (entry.ws) {
    entry.ws.close();
    entry.ws = null;
  }
  entry.ifaceCards = new Map();
  entry.ifacesListEl.innerHTML = '';
  interfaces.forEach(iface => {
    const cardState = buildFleetIfaceCard(piId, entry, iface);
    entry.ifaceCards.set(iface, cardState);
    entry.ifacesListEl.appendChild(cardState.card);
  });
}

function toggleRow(piId) {
  const entry = piRows.get(piId);
  if (!entry) return;
  entry.rowExpanded = !entry.rowExpanded;
  entry.ifacesRow.classList.toggle('hidden', !entry.rowExpanded);
  entry.mainToggle.innerHTML = chevronIconSvg(entry.rowExpanded ? 'down' : 'right');

  if (entry.rowExpanded) {
    // A tcpdump capture (or syslog stream) started before the row was
    // collapsed keeps running server-side regardless - only the live
    // relay's websocket was torn down, so reconnect it if still needed.
    const anyActive = [...entry.ifaceCards.values()].some(c => c.logExpanded || c.tcpdumpStreaming);
    if (anyActive && !entry.ws) entry.ws = connectFleetPiLog(piId, entry);
    return;
  }

  // Collapsing the Pi row also hides every interface card's log windows
  // and tears down the shared websocket (view only - doesn't stop an
  // in-progress capture/stream).
  entry.ifaceCards.forEach(cardState => {
    cardState.card.querySelector('.pd-iface-body').classList.add('hidden');
    cardState.card.querySelector('.pd-iface-toggle').innerHTML = chevronIconSvg('right');
    PANELS.forEach(spec => {
      if (cardState[spec.expandedKey]) {
        cardState[spec.expandedKey] = false;
        cardState[spec.rowKey].classList.add('pd-log-collapsed');
        cardState[spec.toggleKey].innerHTML = chevronIconSvg('down');
        cardState[spec.toggleKey].title = 'Expand';
      }
    });
  });
  if (entry.ws) {
    entry.ws.close();
    entry.ws = null;
  }
}

function createPiRow(piId) {
  const summaryRow = document.createElement('tr');
  summaryRow.className = 'pi-row';
  summaryRow.dataset.piId = piId;
  summaryRow.innerHTML = `
    <td><input type="checkbox" class="pi-select-checkbox" title="Select for multicast"></td>
    <td><a href="#" class="c-id-link pi-id-link"></a></td>
    <td class="c-ip"></td>
    <td class="c-role"></td>
    <td class="c-status"></td>
    <td class="c-seen"></td>
    <td><span class="pd-iface-toggle main-toggle">${chevronIconSvg('right')}</span></td>
  `;
  const mainToggle = summaryRow.querySelector('.main-toggle');
  mainToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRow(piId);
  });
  const idLink = summaryRow.querySelector('.c-id-link');
  idLink.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    location.hash = `#pi/${encodeURIComponent(piId)}`;
  });
  summaryRow.addEventListener('click', () => {
    selectedPiId = piId;
    targetSelect.value = piId;
    renderParamFields();
    piRows.forEach((entry, id) => entry.summaryRow.classList.toggle('selected', id === selectedPiId));
  });
  // Double-click the row anywhere (not just the id link) as a quicker way
  // to jump to this Pi's own page.
  summaryRow.addEventListener('dblclick', () => {
    location.hash = `#pi/${encodeURIComponent(piId)}`;
  });

  // Multi-select checkbox: independent of the row-click single target above,
  // this drives the "multicast" target - checking more than one Pi here
  // auto-switches the Target dropdown to multicast (see renderTargetSelect).
  const selectCheckbox = summaryRow.querySelector('.pi-select-checkbox');
  selectCheckbox.addEventListener('click', (e) => e.stopPropagation());
  selectCheckbox.addEventListener('change', () => {
    if (selectCheckbox.checked) checkedPiIds.add(piId);
    else checkedPiIds.delete(piId);
    renderTargetSelect();
  });

  // Interfaces row: only visible once the Pi row itself is expanded; holds
  // one card per interface (see buildFleetIfaceCard) - each individually
  // toggleable, with its own primary-interface checkbox, connected-status
  // mark, and syslog/tcpdump viewers.
  const ifacesRow = document.createElement('tr');
  ifacesRow.className = 'pi-ifaces-row hidden';
  const ifacesCell = document.createElement('td');
  ifacesCell.colSpan = 7;
  const ifacesListEl = document.createElement('div');
  ifacesListEl.className = 'fleet-iface-list';
  ifacesCell.appendChild(ifacesListEl);
  ifacesRow.appendChild(ifacesCell);

  const entry = {
    summaryRow, mainToggle, ifacesRow, ifacesListEl,
    rowExpanded: false, ws: null,
    ifaceCards: new Map(),
    ifaceDetailsCache: null, ifaceDetailsPromise: null, linkInfoCache: {},
  };

  return entry;
}

let pisPollCount = 0;

function renderPis() {
  const seen = new Set();

  pis.forEach(p => {
    seen.add(p.pi_id);
    let entry = piRows.get(p.pi_id);
    if (!entry) {
      entry = createPiRow(p.pi_id);
      piRows.set(p.pi_id, entry);
      piTableBody.appendChild(entry.summaryRow);
      piTableBody.appendChild(entry.ifacesRow);
    }
    entry.summaryRow.classList.toggle('selected', p.pi_id === selectedPiId);
    entry.summaryRow.querySelector('.c-id-link').textContent = p.pi_id;
    entry.summaryRow.querySelector('.c-ip').textContent = p.ip_address || '';
    entry.summaryRow.querySelector('.c-role').textContent = p.role || '';
    entry.summaryRow.querySelector('.c-status').innerHTML = statusBadge(p.status);
    entry.summaryRow.querySelector('.c-seen').textContent = p.last_seen ? new Date(p.last_seen).toLocaleString() : '';
    entry.summaryRow.querySelector('.pi-select-checkbox').checked = checkedPiIds.has(p.pi_id);

    const interfaces = (p.metadata && Array.isArray(p.metadata.interfaces)) ? p.metadata.interfaces : [];
    const key = JSON.stringify(interfaces);
    if (entry.ifaceListKey !== key) {
      entry.ifaceListKey = key;
      entry.ifaceDetailsCache = null;
      entry.ifaceDetailsPromise = null;
      entry.linkInfoCache = {};
      rebuildFleetIfaceCards(p.pi_id, entry, interfaces);
    }

    // Each card's primary-interface checkbox is config, not a live filter -
    // it always mirrors the server's p.primary_interfaces.
    entry.ifaceCards.forEach((cardState, iface) => {
      cardState.checkboxEl.checked = p.primary_interfaces.includes(iface);
    });

    // Wifi connected-status refresh: every interface card, not just primary
    // ones, but only every few polls (~15s) to avoid a link_info command per
    // wifi interface per Pi every single 5s tick.
    if (pisPollCount % 3 === 0) {
      entry.ifaceCards.forEach(cardState => refreshFleetWifiIcon(p.pi_id, entry, cardState));
    }
  });
  pisPollCount++;

  // Drop rows for Pis that disappeared, closing any open log socket.
  [...piRows.keys()].forEach(id => {
    if (seen.has(id)) return;
    const entry = piRows.get(id);
    if (entry.ws) entry.ws.close();
    entry.summaryRow.remove();
    entry.ifacesRow.remove();
    piRows.delete(id);
  });

  [...checkedPiIds].forEach(id => { if (!seen.has(id)) checkedPiIds.delete(id); });
  renderTargetSelect();

  if (typeof refreshInterfaceOptions === 'function') refreshInterfaceOptions();
  if (typeof refreshDetailView === 'function') refreshDetailView();
}

async function refreshPis() {
  try {
    const res = await apiFetch(`${API}/pis`);
    if (!res.ok) return;
    pis = await res.json();
    renderPis();
  } catch {
    // backend unreachable; keep last known list
  }
}

refreshPis();
setInterval(refreshPis, 5000);

