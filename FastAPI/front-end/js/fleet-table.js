// --- Fleet: Pi list -------------------------------------------------------

const piTableBody = document.getElementById('piTableBody');
const targetSelect = document.getElementById('targetSelect');
const targetHint = document.getElementById('targetHint');
let pis = [];
let selectedPiId = null;

// Pi ids checked in the fleet table's select column. Independent of
// targetSelect's own value/DOM - this is what actually drives "multicast".
const checkedPiIds = new Set();
let lastTargetOptionsKey = null;

function renderTargetSelect() {
  const current = targetSelect.value;
  const optionsKey = JSON.stringify([pis.map(p => p.pi_id), checkedPiIds.size > 1 ? checkedPiIds.size : 0]);

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

const piRows = new Map();

function statusBadge(status) {
  const cls = status === 'online' ? 'badge-online' : status === 'offline' ? 'badge-offline' : 'badge-unassigned';
  return `<span class="badge ${cls}">${status}</span>`;
}

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
  wrap.addEventListener('click', (e) => e.stopPropagation());
  return wrap;
}

document.addEventListener('click', () => {
  document.querySelectorAll('.iface-dropdown-panel').forEach(p => p.classList.add('hidden'));
});

function chevronIconSvg(direction) {
  const rotation = { right: 0, down: 90, left: 180, up: 270 }[direction] || 0;
  return `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate(${rotation}deg);"><polyline points="9 6 15 12 9 18"/></svg>`;
}
const CLOSE_ICON_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const PLAY_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg>`;
const STOP_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="6" y="6" width="12" height="12"/></svg>`;

const EYE_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/>
  <circle cx="12" cy="12" r="3"/>
</svg>`;
const EYE_OFF_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 12s4-7 11-7c2.1 0 3.9.5 5.4 1.2M23 12s-4 7-11 7c-2.1 0-3.9-.5-5.4-1.2"/>
  <path d="M9.5 9.5a3 3 0 0 0 4.2 4.2"/>
  <line x1="1" y1="1" x2="23" y2="23"/>
</svg>`;

// Duplicate button icon (Testcases/Testsuites tables) - two overlapping
// rounded rects, the standard "copy" glyph. stroke="currentColor" so it
// matches every other icon-btn glyph: gray by default (.icon-btn's own
// color:#888), lighter on hover (.icon-btn:hover's color:#eee).
const DUPLICATE_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="9" width="12" height="12" rx="2"/>
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
</svg>`;

// Rerun button icon (Results tab) - a circular arrow, the standard "redo/
// retry" glyph.
const RERUN_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 12a9 9 0 1 1-3-6.7"/>
  <polyline points="21 3 21 9 15 9"/>
</svg>`;

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
    const lines = Array.isArray(payload) ? payload : [payload];

    const panel = entry[panelKey];
    if (msg.category === 'tcpdump') {
      const selectedIface = entry.tcpdumpActiveIface;
      if (!selectedIface) return;
      const tbody = panel.querySelector('tbody');
      if (tbody) {
        lines.filter(line => line && line.interface === selectedIface)
          .forEach(line => appendPacketRow(tbody, line));
      }
      return;
    }
    if (msg.category === 'logs' && !entry.logsStreaming) return;

    const empty = panel.querySelector('.pi-log-empty');
    if (empty) empty.remove();
    lines.forEach(line => appendLineTo(panel, line));
  };

  return ws;
}

const PANELS = [
  { kind: 'logs', rowKey: 'logRow', panelKey: 'logPanel', toggleKey: 'logToggle', expandedKey: 'logExpanded', label: 'syslog / stream_logs', short: 'syslog / stream_logs' },
  { kind: 'tcpdump', rowKey: 'tcpdumpRow', panelKey: 'tcpdumpPanel', toggleKey: 'tcpdumpToggle', expandedKey: 'tcpdumpExpanded', label: 'tcpdump', short: 'tcpdump' },
];

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

function setCaptureBtn(btn, recording) {
  btn.innerHTML = recording ? '&#9209;' : '&#9210;';
  btn.title = recording ? 'Stop Capture' : 'Start Capture';
  btn.classList.toggle('recording', recording);
}

// Log recording runs on the backend (it saves the Pi's syslog stream as it
// arrives), so it survives a page reload - see restoreRecordingState.
async function toggleCapture(piId, spec, entry, btn) {
  if (spec.kind === 'tcpdump') return togglePcapCapture(piId, entry, btn);

  entry.captureState = entry.captureState || {};
  const active = entry.captureState[spec.kind];

  if (!active) {
    const name = prompt('Capture name:', `${piId}-${spec.kind}-${new Date().toISOString().slice(0, 19)}`);
    if (!name) return;
    btn.disabled = true;
    try {
      const res = await apiFetch(`${API}/captures/recordings/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pi_id: piId, name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Failed to start recording: ${err.detail || res.status}`);
        return;
      }
    } catch (err) {
      alert(`Failed to start recording: ${err.message}`);
      return;
    } finally {
      btn.disabled = false;
    }
    entry.captureState[spec.kind] = { name };
    setCaptureBtn(btn, true);
    return;
  }

  entry.captureState[spec.kind] = null;
  setCaptureBtn(btn, false);
  btn.disabled = true;
  try {
    const res = await apiFetch(`${API}/captures/recordings/logs/${encodeURIComponent(piId)}/stop`, { method: 'POST' });
    if (res.status === 422) {
      alert('No logs arrived during that capture window.');
      return;
    }
    if (!res.ok && res.status !== 404) {
      alert('Failed to stop the recording on the server.');
      return;
    }
    await loadCaptures();
  } catch {
    alert('Failed to stop the recording.');
  } finally {
    btn.disabled = false;
  }
}

// The backend is the source of truth for recordings - the page that
// started one may have been reloaded, and another tab may have stopped it.
// applyRecordingState sets each button to match, both on and off.
// targets: [{ state, logsBtn, pcapBtn, iface, onPcapIface }] - one per
// panel set (detail page) or per Pi / interface card (fleet).
function applyRecordingState(piId, active, targets) {
  const mine = active.filter(r => r.pi_id === piId);
  const logs = mine.find(r => r.category === 'logs');
  targets.forEach(t => {
    if (t.logsBtn && !t.logsBtn.disabled) {   // disabled = start/stop in flight
      t.state.captureState = t.state.captureState || {};
      t.state.captureState.logs = logs ? { name: logs.name } : null;
      setCaptureBtn(t.logsBtn, !!logs);
    }
    if (t.pcapBtn && !t.pcapBtn.disabled) {
      const want = t.iface || (t.state.pcapState && t.state.pcapState.interface);
      const pcap = mine.find(r => r.category === 'pcap' && (!want || r.interface === want));
      if (pcap && !t.state.pcapState) {
        t.state.pcapState = { name: pcap.name, interface: pcap.interface };
        setCaptureBtn(t.pcapBtn, true);
        if (t.onPcapIface) t.onPcapIface(pcap.interface);
      } else if (!pcap && t.state.pcapState) {
        t.state.pcapState = null;
        setCaptureBtn(t.pcapBtn, false);
      }
    }
  });
}

async function fetchActiveRecordings(piId) {
  try {
    const q = piId ? `?pi_id=${encodeURIComponent(piId)}` : '';
    const res = await apiFetch(`${API}/captures/recordings${q}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function restoreRecordingState(piId, targets) {
  const active = await fetchActiveRecordings(piId);
  if (active) applyRecordingState(piId, active, targets);
}

function fleetRecordingTargets(entry) {
  const targets = [{ state: entry, logsBtn: entry.logRow.querySelector('.pi-log-capture') }];
  entry.ifaceCards.forEach(cardState => targets.push({
    state: cardState, iface: cardState.iface,
    pcapBtn: cardState.card.querySelector('.pi-log-capture'),
  }));
  return targets;
}

// Runs on every 5s refresh so all open tabs converge on the backend's view.
async function syncRecordingButtons() {
  const active = await fetchActiveRecordings();
  if (!active) return;
  piRows.forEach((entry, piId) => applyRecordingState(piId, active, fleetRecordingTargets(entry)));
  if (typeof detailLogEntry !== 'undefined' && detailLogEntry && detailPiId) {
    applyRecordingState(detailPiId, active, detailRecordingTargets(detailLogEntry));
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

// Restart pi-agent / reboot the Pi. The agent replies first, then systemd
// runs it a few seconds later (see PiAgent.schedule_power_action), so the
// command shows "complete" and the Pi then goes offline briefly.
const POWER_ACTIONS = {
  restart_agent: { label: '\u21bb Restart agent', confirm: 'Restart the pi-agent service on {pi}? Running streams and recordings on it will stop.' },
  reboot_pi: { label: '\u23fb Reboot Pi', confirm: 'Reboot {pi}? It will be offline for about a minute and running streams and recordings on it will stop.' },
};

function renderPowerButtons(container, piId) {
  container.innerHTML = Object.entries(POWER_ACTIONS).map(([action, a]) =>
    `<button type="button" class="pi-power-btn${action === 'reboot_pi' ? ' danger' : ''}" data-action="${action}">${a.label}</button>`
  ).join('');
  container.querySelectorAll('.pi-power-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const a = POWER_ACTIONS[btn.dataset.action];
      if (!confirm(a.confirm.replace('{pi}', piId))) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'sending…';
      try {
        const res = await postCmd(piId, btn.dataset.action, {});
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        const data = await res.json();
        const result = await awaitCommandResult(data.command_id, 20);
        if (!result || result.error) throw new Error((result && result.error) || 'no reply from the Pi');
        btn.textContent = btn.dataset.action === 'reboot_pi' ? 'rebooting…' : 'restarting…';
        setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 15000);
      } catch (err) {
        alert(`${original.slice(2)} failed on ${piId}: ${err.message}`);
        btn.textContent = original;
        btn.disabled = false;
      }
    });
  });
}

function postCmd(piId, action, params) {
  return apiFetch(`${API}/pis/${encodeURIComponent(piId)}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params }),
  });
}
function bandMatchesChannel(band, channel) {
  if (!band || !channel) return true;
  // 6GHz channels overlap 2.4/5GHz numbers - only check it's a real one.
  if (band === '6') return channel === 2 || (channel <= 233 && channel % 4 === 1);
  return band === (channel <= 14 ? 'bg' : 'a');
}

function renderInterfaceDefaultControl(container, piId, iface, current, onSaved, isMonitor) {
  const wrap = document.createElement('div');
  wrap.className = 'wifi-connect-row';
  // Monitor interfaces get a 6GHz option: its channel numbers overlap
  // 2.4/5GHz ones, so set_monitor_channel needs the band to tune by
  // frequency. Station (connect_wifi) defaults stay 2.4/5GHz.
  wrap.innerHTML = `
    <label style="width:100%;">Default channel/band${isMonitor ? ' (applied immediately)' : ' for connect_wifi'}</label>
    <select class="field iface-default-band" style="flex:0 0 6.5rem;">
      <option value="">${isMonitor ? 'auto (2.4/5)' : 'any band'}</option>
      <option value="bg">2.4GHz</option>
      <option value="a">5GHz</option>
      ${isMonitor ? '<option value="6">6GHz</option>' : ''}
    </select>
    <input class="field iface-default-channel" type="number" min="1" placeholder="channel" style="flex:0 0 6.5rem;">
    <button type="button" class="iface-default-save">Save</button>
    <button type="button" class="iface-default-clear">Clear</button>
    <div class="iface-default-error login-error" style="width:100%;"></div>
    <div class="iface-default-success" style="width:100%; color:#6f6; font-size:0.8rem; min-height:1.2em; margin-top:0.5rem;"></div>
  `;
  const bandEl = wrap.querySelector('.iface-default-band');
  const channelEl = wrap.querySelector('.iface-default-channel');
  const errorEl = wrap.querySelector('.iface-default-error');
  const successEl = wrap.querySelector('.iface-default-success');
  if (bandEl) bandEl.value = (current && current.band) || '';
  channelEl.value = (current && current.channel) || '';

  const stop = (e) => e.stopPropagation();
  [bandEl, channelEl].forEach(el => el && el.addEventListener('click', stop));

  function describeBandChannel(band, channel) {
    const bandLabel = band === 'bg' ? '2.4GHz' : band === 'a' ? '5GHz' : band === '6' ? '6GHz' : null;
    if (bandLabel && channel) return `${bandLabel}, channel ${channel}`;
    if (channel) return `channel ${channel}`;
    if (bandLabel) return bandLabel;
    return 'any band/channel';
  }

  async function save(band, channel) {
    successEl.textContent = '';
    if (!bandMatchesChannel(band, channel)) {
      errorEl.textContent = band === '6'
        ? `Channel ${channel} is not a 6GHz channel - use 1, 5, 9 ... 233, or 2.`
        : `Channel ${channel} is ${channel <= 14 ? '2.4GHz' : '5GHz'} - pick a matching band, "any band", or a different channel.`;
      return;
    }
    errorEl.textContent = '';

    const btn = wrap.querySelector('.iface-default-save');
    btn.disabled = true;
    try {
      const res = await apiFetch(`${API}/pis/${encodeURIComponent(piId)}/interfaces/${encodeURIComponent(iface)}/default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ band: band || null, channel: channel || null }),
      });
      if (!res.ok) {
        errorEl.textContent = `Failed to save default: ${res.status} ${await res.text()}`;
        return;
      }
      const updated = await res.json();
      if (onSaved) onSaved(updated.interface_defaults);

      if (!band && !channel) {
        successEl.textContent = 'Cleared.';
        return;
      }

      // A monitor interface never goes through a connect_wifi-style event
      // to pick this default up later - it has to be applied right now, so
      // its confirmation is "the radio is actually on that channel now"
      // rather than just "the default was saved".
      if (isMonitor && channel) {
        const cmdRes = await postCmd(piId, 'set_monitor_channel', { interface: iface, channel, band: band || undefined });
        if (!cmdRes.ok) throw new Error(`${cmdRes.status} ${await cmdRes.text()}`);
        const data = await cmdRes.json();
        const result = await awaitCommandResult(data.command_id, 30);
        if (!result || !result.applied) {
          errorEl.textContent = `Saved as default, but applying it now failed: ${(result && (result.error || result.output)) || 'unknown error'}`;
        } else {
          successEl.textContent = `Applied: ${describeBandChannel(band, channel)}.`;
        }
      } else {
        successEl.textContent = `Saved as default: ${describeBandChannel(band, channel)}. Applies on this interface's next connect.`;
      }
    } catch (err) {
      errorEl.textContent = `Failed to save default: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  wrap.querySelector('.iface-default-save').addEventListener('click', (e) => {
    stop(e);
    const channel = channelEl.value ? Number(channelEl.value) : null;
    save(bandEl ? (bandEl.value || null) : null, channel);
  });
  wrap.querySelector('.iface-default-clear').addEventListener('click', (e) => {
    stop(e);
    if (bandEl) bandEl.value = '';
    channelEl.value = '';
    errorEl.textContent = '';
    save(null, null);
  });

  container.appendChild(wrap);
}

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

  if (starting && panel) {
    const tbody = panel.querySelector('tbody');
    if (tbody) resumeLiveCapture(tbody);
  }
  return starting;
}

// Syslog stream is the whole pi-agent daemon's journal (not per
// interface), so it's a plain start/stop toggle.
async function toggleLogsStream(piId, entry, btn) {
  const starting = !entry.logsStreaming;
  if (!starting && entry.captureState && entry.captureState.logs &&
      !confirm('A log recording is running. Stopping the stream also stops lines reaching the recording. Stop anyway?')) return;
  btn.disabled = true;
  try {
    await postCmd(piId, starting ? STREAM_START_ACTION.logs : STREAM_STOP_ACTION.logs, {});
  } catch (err) {
    alert(`Failed to ${starting ? 'start' : 'stop'} streaming: ${err.message}`);
    return;
  } finally {
    btn.disabled = false;
  }
  entry.logsStreaming = starting;
  btn.classList.toggle('streaming', starting);
  btn.innerHTML = starting ? STOP_ICON_SVG : PLAY_ICON_SVG;
  btn.title = starting ? 'Stop streaming' : 'Start streaming';
}

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
    } else if (entry.logExpanded) {
      appendTo(entry, lines);
    }
  };

  return ws;
}

function fleetAnyStreamOpen(entry) {
  return entry.logExpanded || [...entry.ifaceCards.values()].some(c => c.tcpdumpStreaming);
}

function syncFleetWs(piId, entry) {
  const anyOpen = fleetAnyStreamOpen(entry);
  if (anyOpen && !entry.ws) {
    entry.ws = connectFleetPiLog(piId, entry);
  } else if (!anyOpen && entry.ws) {
    entry.ws.close();
    entry.ws = null;
  }
}

// Per-interface tcpdump block: expand/collapse is view-only, the stream
// itself is started/stopped by its own button.
function toggleFleetIfaceLogPanel(piId, entry, cardState, spec) {
  const expanding = !cardState[spec.expandedKey];
  cardState[spec.expandedKey] = expanding;
  cardState[spec.rowKey].classList.toggle('pd-log-collapsed', !expanding);
  cardState[spec.toggleKey].innerHTML = chevronIconSvg(expanding ? 'up' : 'down');
  cardState[spec.toggleKey].title = expanding ? 'Collapse' : 'Expand';
}

// The Pi-wide syslog block at the bottom of the expanded row (the stream
// is the whole pi-agent journal, not per interface). Expanding starts the
// stream; collapsing stops it unless a recording is using it.
async function toggleFleetSyslogPanel(piId, entry) {
  const expanding = !entry.logExpanded;
  entry.logExpanded = expanding;
  entry.logRow.classList.toggle('pd-log-collapsed', !expanding);
  entry.logToggle.innerHTML = chevronIconSvg(expanding ? 'up' : 'down');
  entry.logToggle.title = expanding ? 'Collapse' : 'Expand';
  if (expanding && !entry.logPanel.children.length) {
    entry.logPanel.innerHTML = '<div class="pi-log-empty">waiting for messages…</div>';
  }

  const recordingLogs = entry.captureState && entry.captureState.logs;
  if (expanding || !recordingLogs) {
    try {
      await postCmd(piId, expanding ? STREAM_START_ACTION.logs : STREAM_STOP_ACTION.logs, {});
    } catch {
      // backend unreachable; UI still reflects the toggle, next attempt will retry
    }
  }
  syncFleetWs(piId, entry);
}

function buildFleetSyslogBlock(piId, entry) {
  const spec = PANELS.find(p => p.kind === 'logs');
  const row = document.createElement('div');
  row.className = 'pd-log-block pd-log-collapsed fleet-syslog-block';
  row.innerHTML = `
    <div class="pi-log-heading">
      <span>${spec.label}</span>
      <span class="pi-log-actions">
        <button class="pi-log-capture icon-btn" type="button" title="Start Capture">&#9210;</button>
        <button class="pi-log-clear icon-btn" type="button" title="Clear">&#128465;</button>
        <button class="pi-log-collapse icon-btn" type="button" title="Expand">${chevronIconSvg('down')}</button>
      </span>
    </div>
    <div class="pi-log-panel"></div>
  `;
  entry.logRow = row;
  entry.logPanel = row.querySelector('.pi-log-panel');
  entry.logToggle = row.querySelector('.pi-log-collapse');
  entry.logExpanded = false;

  const captureBtn = row.querySelector('.pi-log-capture');
  entry.logToggle.addEventListener('click', () => toggleFleetSyslogPanel(piId, entry));
  captureBtn.addEventListener('click', () => toggleCapture(piId, spec, entry, captureBtn));
  row.querySelector('.pi-log-clear').addEventListener('click', () => clearPanel(piId, spec, entry.logPanel));
  restoreRecordingState(piId, [{ state: entry, logsBtn: captureBtn }]);
  return row;
}

async function toggleFleetTcpdumpStream(piId, entry, cardState, btn) {
  const starting = await performToggleTcpdumpStream(piId, cardState.iface, btn, cardState.tcpdumpPanel);
  if (starting === null) return;
  cardState.tcpdumpStreaming = starting;

  if (starting && !cardState.tcpdumpExpanded) {
    cardState.tcpdumpExpanded = true;
    cardState.tcpdumpRow.classList.remove('pd-log-collapsed');
    cardState.tcpdumpToggle.innerHTML = chevronIconSvg('up');
    cardState.tcpdumpToggle.title = 'Collapse';
  }

  const anyOpen = fleetAnyStreamOpen(entry);
  if (anyOpen && !entry.ws) {
    entry.ws = connectFleetPiLog(piId, entry);
  } else if (!anyOpen && entry.ws) {
    entry.ws.close();
    entry.ws = null;
  }
}

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

// Interfaces (piId::iface) with a set_interface_mode switch in flight -
// checked by renderFleetIfaceBody so the mode button renders as disabled/
// "Switching…" even across a full card rebuild (rebuildFleetIfaceCards
// wipes and recreates every card on this Pi whenever the interface list's
// sort key changes, which a mode switch itself can trigger by deleting and
// recreating the netdev - see switchFleetInterfaceMode). Toggling a plain
// DOM button's own disabled/textContent doesn't survive that rebuild since
// the old button node is discarded entirely; tracking it here and
// re-rendering from it does.
const wifiModeSwitchInFlight = new Set();

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
    if (link.gateway) rows.push(['Gateway', link.gateway]);
    if (link.key_mgmt) rows.push(['Key mgmt', link.key_mgmt]);
    if (link.radio_type) rows.push(['Radio type', link.radio_type]);
    rows.push(...wifi7LinkRows(link));
  }
  cardState.infoEl.innerHTML = rows.length
    ? `<table class="result-table">${rows.map(([k, v]) =>
        `<tr><td class="result-key">${k}</td><td class="result-value">${v ?? ''}</td></tr>`
      ).join('')}</table>`
    : '<div class="pi-log-empty">no data</div>';

  if (link && link.connected) {
    if (link.gateway) {
      cardState.infoEl.insertAdjacentHTML('beforeend',
        '<div class="wifi-disconnect-row"><button type="button" class="ap-weblink-btn">AP Configuration</button></div>');
      cardState.infoEl.querySelector('.ap-weblink-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openApWebUi(cardState.piId, cardState.iface, e.currentTarget);
      });
    }
    cardState.infoEl.insertAdjacentHTML('beforeend',
      '<div class="wifi-disconnect-row"><button type="button" class="wifi-disconnect-btn">Disconnect</button></div>');
    cardState.infoEl.querySelector('.wifi-disconnect-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      disconnectFleetWifi(cardState, e.currentTarget);
    });
  }

  const isMonitor = details ? details.type === 'monitor' : isMonitorInterfaceName(cardState.iface);
  // The mode toggle needs a trustworthy current mode (details.type, from
  // list_interfaces - name-independent), not the isMonitorInterfaceName
  // fallback, since a wifi-named interface can now legitimately be in
  // monitor mode - so this button only appears once details are loaded.
  if (details && (isWifiInterface(cardState.iface) || isMonitor)) {
    const targetMode = isMonitor ? 'managed' : 'monitor';
    const switching = wifiModeSwitchInFlight.has(`${cardState.piId}::${cardState.iface}`);
    cardState.infoEl.insertAdjacentHTML('beforeend',
      `<div class="wifi-disconnect-row"><button type="button" class="iface-mode-switch-btn${isMonitor ? ' recording' : ''}" ${switching ? 'disabled' : ''}>${switching ? 'Switching…' : `Monitor mode: ${isMonitor ? 'On' : 'Off'}`}</button></div>`);
    if (!switching) {
      cardState.infoEl.querySelector('.iface-mode-switch-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        switchFleetInterfaceMode(entry, cardState, targetMode);
      });
    }
  }

  if (isWifiInterface(cardState.iface) || isMonitor) {
    const pi = pis.find(p => p.pi_id === cardState.piId);
    const current = (pi && pi.interface_defaults && pi.interface_defaults[cardState.iface]) || null;
    renderInterfaceDefaultControl(cardState.infoEl, cardState.piId, cardState.iface, current, (updated) => {
      if (pi) pi.interface_defaults = updated;
    }, isMonitor);
  }
}

async function switchFleetInterfaceMode(entry, cardState, targetMode) {
  const piId = cardState.piId;
  const iface = cardState.iface;
  if (targetMode === 'monitor') {
    const link = entry.linkInfoCache[iface];
    if (link && link.connected &&
        !confirm(`${iface} is currently connected. Switching to monitor mode will disconnect it. Continue?`)) {
      return;
    }
  }
  // Tracked separately from the clicked button itself: a mode switch
  // deletes and recreates the netdev, which can change list_interfaces'
  // reported order and trigger rebuildFleetIfaceCards mid-switch - that
  // discards every card's DOM (including the button just clicked) and
  // builds fresh ones. Re-rendering from this set (renderFleetIfaceBody)
  // is what makes a freshly rebuilt button start out disabled/"Switching…"
  // too, instead of flashing back to normal mid-operation.
  const key = `${piId}::${iface}`;
  wifiModeSwitchInFlight.add(key);
  const currentCard = () => entry.ifaceCards.get(iface);
  const rerender = () => {
    const cs = currentCard();
    if (cs && !cs.card.querySelector('.pd-iface-body').classList.contains('hidden')) {
      renderFleetIfaceBody(entry, cs);
    }
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
    wifiModeSwitchInFlight.delete(key);
  }
  // Always re-render/refresh, success or failure - otherwise a failed
  // switch would leave the button stuck showing "Switching…" (the flag
  // above is cleared, but nothing repainted from it) until some unrelated
  // refresh happened to touch this card next.
  if (succeeded) {
    // Type/link state both just changed on the Pi - force a fresh read
    // instead of showing stale cached details, same as disconnectFleetWifi.
    entry.ifaceDetailsCache = null;
    entry.ifaceDetailsPromise = null;
    delete entry.linkInfoCache[iface];
    await loadFleetIfaceInfo(piId, entry, iface);
  }
  const finalCard = currentCard();
  if (finalCard) {
    renderFleetIfaceBody(entry, finalCard);
    refreshFleetWifiIcon(piId, entry, finalCard);
  }
}

// Shared by fleet-table.js and detail-page.js - starts (or extends the TTL
// of) the Pi-side DNAT proxy for this interface's AP (see pi_agent's
// start_ap_webui_proxy), then opens it in a new tab through the Pi's own
// registered IP instead of the AP's gateway IP directly, since only the Pi
// is actually on the AP's network.
//
// The tab is opened synchronously, before the async postCmd/awaitCommandResult
// round-trip, and navigated afterward - opening it only after the command
// resolves would happen outside the click's original user-gesture context,
// which popup blockers treat as an unsolicited window.open and block.
async function openApWebUi(piId, iface, btn) {
  const win = window.open('', '_blank');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Opening…';
  try {
    const res = await postCmd(piId, 'start_ap_webui_proxy', { interface: iface });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json();
    const result = await awaitCommandResult(data.command_id, 30);
    if (!result || !result.applied) {
      if (win) win.close();
      alert(`Failed to open AP web UI: ${(result && result.error) || 'unknown error'}`);
      return;
    }
    const pi = pis.find(p => p.pi_id === piId);
    if (!pi || !pi.ip_address) {
      if (win) win.close();
      alert('This Pi has no known registered IP to proxy through.');
      return;
    }
    if (win) win.location.href = `http://${pi.ip_address}:${result.port}`;
  } catch (err) {
    if (win) win.close();
    alert(`Failed to open AP web UI: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function disconnectFleetWifi(cardState, btn) {
  const piId = cardState.piId;
  btn.disabled = true;
  btn.textContent = 'Disconnecting…';
  let result = null;
  try {
    const res = await postCmd(piId, 'disconnect_wifi', { interface: cardState.iface });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json();
    result = await awaitCommandResult(data.command_id, 320);
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
    // Apply straight from disconnect_wifi's own result first - waiting on
    // a separate link_info round-trip (refreshFleetWifiIcon) to learn this
    // was previously the only way the icon/SSID updated, and that
    // secondary command silently failing/timing out (e.g. right after
    // teardown, before the interface has fully settled) left the icon
    // stuck green with the old SSID even though the disconnect itself had
    // already succeeded. refreshFleetWifiIcon still runs after for
    // eventual consistency (e.g. to pick up a fresh IP-less link_info).
    if (result && result.disconnected) {
      entry.linkInfoCache[cardState.iface] = { connected: false };
      applyWifiIconStatus(cardState, { connected: false });
      if (!cardState.card.querySelector('.pd-iface-body').classList.contains('hidden')) {
        renderFleetIfaceBody(entry, cardState);
      }
    }
    refreshFleetWifiIcon(piId, entry, cardState);
  }
}

// --- Buffered interface status (list_interfaces + link_info, continuously
// refreshed server-side every INTERFACE_STATUS_INTERVAL_SECONDS by
// pi_agent - see PiAgent._interface_status_loop and
// routers/Pis.get_interface_status) - used for the fleet table's passive
// periodic refresh below instead of firing a live command per interface
// icon on every poll. A user-triggered action (connect/disconnect/mode
// switch) still calls refreshFleetWifiIcon/loadFleetIfaceInfo directly for
// its own instant live feedback - this is only the idle-refresh path.

async function fetchInterfaceStatusBuffer(piId) {
  try {
    const res = await apiFetch(`${API}/pis/${encodeURIComponent(piId)}/interface-status`);
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

function applyWifiIconStatus(cardState, status) {
  if (!isWifiInterface(cardState.iface) || !cardState.wifiIconEl) return;
  applyWifiStdTag(cardState.card, status);
  const connected = !!(status && status.connected);
  cardState.wifiIconEl.classList.remove('wifi-unknown', 'wifi-connected', 'wifi-disconnected');
  cardState.wifiIconEl.classList.add(connected ? 'wifi-connected' : 'wifi-disconnected');
  cardState.wifiIconEl.title = connected ? `Wi-Fi connected${status.ssid ? ' — ' + status.ssid : ''}` : 'Wi-Fi not connected';
  cardState.connectedMarkEl.classList.toggle('hidden', !connected);
  if (connected) cardState.connectedMarkEl.textContent = status.ssid ? `connected — ${status.ssid}` : 'connected';
}

async function refreshFleetInterfaceStatusBuffer(piId, entry) {
  const statusList = await fetchInterfaceStatusBuffer(piId);
  if (!statusList.length) return;
  entry.ifaceDetailsCache = statusList.map(s => ({
    name: s.interface, mac_address: s.mac_address, state: s.state, type: s.type,
    ip_address: s.ip_address, ipv6_address: s.ipv6_address,
  }));
  entry.ifaceDetailsPromise = null;
  const byIface = new Map(statusList.map(s => [s.interface, s]));
  entry.ifaceCards.forEach((cardState, iface) => {
    const status = byIface.get(iface);
    if (!status) return;
    entry.linkInfoCache[iface] = status;
    applyWifiIconStatus(cardState, status);
    if (!cardState.card.querySelector('.pd-iface-body').classList.contains('hidden')) {
      renderFleetIfaceBody(entry, cardState);
    }
  });
}

async function refreshFleetWifiIcon(piId, entry, cardState) {
  if (!isWifiInterface(cardState.iface) || !cardState.wifiIconEl) return;
  try {
    const res = await postCmd(piId, 'link_info', { interface: cardState.iface });
    if (!res.ok) return;
    const data = await res.json();
    const result = await awaitCommandResult(data.command_id, 10);
    entry.linkInfoCache[cardState.iface] = result;
    applyWifiStdTag(cardState.card, result);
    const connected = !!(result && result.connected);
    cardState.wifiIconEl.classList.remove('wifi-unknown', 'wifi-connected', 'wifi-disconnected');
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

function buildFleetIfaceCard(piId, entry, iface) {
  const isWifi = isWifiInterface(iface);
  const card = document.createElement('div');
  card.className = 'pd-iface-card';
  card.dataset.iface = iface;
  card.innerHTML = `
    <div class="pd-iface-header">
      <input type="checkbox" class="fleet-iface-primary-checkbox" title="Use as primary interface for multi-target actions">
      <span class="pd-iface-name">${iface}${isWifi ? wifiStdTagHtml(null) : ''}</span>
      ${isWifi ? `
        <span class="wifi-icon wifi-unknown" title="checking…">${WIFI_ICON_SVG}</span>
        <span class="pd-iface-connected-mark badge badge-online hidden"></span>
        <button type="button" class="pd-wifi-info-btn">Nearby Hotspot</button>
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

  PANELS.filter(spec => spec.kind === 'tcpdump').forEach(spec => {
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

  const wifiInfoBtn = card.querySelector('.pd-wifi-info-btn');
  if (wifiInfoBtn) {
    wifiInfoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openWifiInfoModal(piId, iface);
    });
  }

  card.querySelector('.pd-iface-header').addEventListener('click', () => toggleFleetIfaceCard(piId, entry, cardState));

  restoreRecordingState(piId, [{
    state: cardState, iface, pcapBtn: card.querySelector('.pi-log-capture'),
  }]);

  return cardState;
}

function rebuildFleetIfaceCards(piId, entry, interfaces) {
  if (entry.ws) {
    entry.ws.close();
    entry.ws = null;
  }
  entry.ifaceCards = new Map();
  entry.ifacesListEl.innerHTML = '';
  interfaces.forEach(iface => {
    // Isolated per-interface: one interface's card failing to build
    // (unexpected data) shouldn't take every other interface on this same
    // Pi down with it - same reasoning as renderPis's own per-Pi isolation.
    try {
      const cardState = buildFleetIfaceCard(piId, entry, iface);
      entry.ifaceCards.set(iface, cardState);
      entry.ifacesListEl.appendChild(cardState.card);
    } catch (err) {
      console.error(`[fleet] failed to build interface card for ${piId}/${iface}:`, err);
    }
  });
  if (entry.rowExpanded) syncFleetWs(piId, entry);
}

function toggleRow(piId) {
  const entry = piRows.get(piId);
  if (!entry) return;
  entry.rowExpanded = !entry.rowExpanded;
  entry.ifacesRow.classList.toggle('hidden', !entry.rowExpanded);
  entry.mainToggle.innerHTML = chevronIconSvg(entry.rowExpanded ? 'down' : 'right');

  if (entry.rowExpanded) {
    const anyActive = fleetAnyStreamOpen(entry);
    if (anyActive && !entry.ws) entry.ws = connectFleetPiLog(piId, entry);
    return;
  }

  if (entry.logExpanded) {
    entry.logExpanded = false;
    entry.logRow.classList.add('pd-log-collapsed');
    entry.logToggle.innerHTML = chevronIconSvg('down');
    entry.logToggle.title = 'Expand';
  }
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

  const selectCheckbox = summaryRow.querySelector('.pi-select-checkbox');
  selectCheckbox.addEventListener('click', (e) => e.stopPropagation());
  selectCheckbox.addEventListener('change', () => {
    if (selectCheckbox.checked) checkedPiIds.add(piId);
    else checkedPiIds.delete(piId);
    renderTargetSelect();
  });

  const ifacesRow = document.createElement('tr');
  ifacesRow.className = 'pi-ifaces-row hidden';
  const ifacesCell = document.createElement('td');
  ifacesCell.colSpan = 7;
  const ifacesListEl = document.createElement('div');
  ifacesListEl.className = 'fleet-iface-list';
  const powerBar = document.createElement('div');
  powerBar.className = 'pi-power-actions fleet-power-bar';
  renderPowerButtons(powerBar, piId);
  ifacesCell.appendChild(powerBar);
  ifacesCell.appendChild(ifacesListEl);
  ifacesRow.appendChild(ifacesCell);

  const entry = {
    summaryRow, mainToggle, ifacesRow, ifacesListEl,
    rowExpanded: false, ws: null,
    ifaceCards: new Map(),
    ifaceDetailsCache: null, ifaceDetailsPromise: null, linkInfoCache: {},
    captureState: null,
  };
  ifacesCell.appendChild(buildFleetSyslogBlock(piId, entry));

  return entry;
}

function renderPis() {
  const seen = new Set();

  // Each Pi's update is isolated - an exception building/refreshing one
  // Pi's row (e.g. unexpected interface data) used to propagate out of
  // this whole forEach uncaught, silently aborting every Pi processed
  // after it in the array too, for every 5s tick from then on. That read
  // as "this one Pi's row is stuck" (its own update never got that far)
  // while quietly breaking updates for other Pis as collateral damage.
  pis.forEach(p => {
    try {
      renderOnePiRow(p, seen);
    } catch (err) {
      console.error(`[fleet] failed to render Pi ${p.pi_id}:`, err);
    }
  });

  finishRenderPis(seen);
}

function renderOnePiRow(p, seen) {
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
  entry.summaryRow.querySelector('.c-seen').textContent = p.last_seen ? formatVnDateTime(p.last_seen) : '';
  entry.summaryRow.querySelector('.pi-select-checkbox').checked = checkedPiIds.has(p.pi_id);

  const interfaces = (p.metadata && Array.isArray(p.metadata.interfaces)) ? p.metadata.interfaces : [];
  // Sorted before comparing - list_interfaces re-registration reflects
  // `ip -o link show`'s current order, which can shift a same-named
  // interface's position after a mode switch deletes and recreates its
  // netdev (new ifindex). A pure reorder shouldn't blow away every
  // interface card (and the wifi icon state just refreshed on it) - only
  // an actual interface being added/removed should.
  const key = JSON.stringify([...interfaces].sort());
  if (entry.ifaceListKey !== key) {
    entry.ifaceListKey = key;
    entry.ifaceDetailsCache = null;
    entry.ifaceDetailsPromise = null;
    entry.linkInfoCache = {};
    rebuildFleetIfaceCards(p.pi_id, entry, interfaces);
  }

  entry.ifaceCards.forEach((cardState, iface) => {
    cardState.checkboxEl.checked = p.primary_interfaces.includes(iface);
  });

  if (entry.ifaceCards.size) refreshFleetInterfaceStatusBuffer(p.pi_id, entry);
}

function finishRenderPis(seen) {
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
  if (typeof refreshInterfacesTab === 'function') refreshInterfacesTab();
}

async function refreshPis() {
  try {
    const res = await apiFetch(`${API}/pis`);
    if (!res.ok) return;
    pis = await res.json();
    renderPis();
    syncRecordingButtons();
  } catch {
    // backend unreachable; keep last known list
  }
}

refreshPis();
setInterval(refreshPis, 5000);

