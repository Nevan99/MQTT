// --- Fleet: command builder ------------------------------------------------

const actionSelect = document.getElementById('actionSelect');
const paramFields = document.getElementById('paramFields');
const sendCmdBtn = document.getElementById('sendCmdBtn');
const cmdResults = document.getElementById('cmdResults');

const ACTION_PARAMS = {
  ping: [
    { name: 'interface', label: 'Interface (optional)', type: 'interface' },
    // pingTargetPicker adds a "Pi radio to ping" quick-pick dropdown next to
    // this field (see renderParamFields/populatePingTargetPicker) - fed from
    // GET /pis/interface-status, so pinging another radio on this Pi (or a
    // different Pi entirely) doesn't require knowing/copying its IP by hand.
    // The plain text field is left in place for pinging an arbitrary
    // non-Pi target (8.8.8.8, a LAN gateway, etc) - the picker just fills it.
    { name: 'target', label: 'IP to ping', type: 'text', default: '8.8.8.8', pingTargetPicker: true },
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
  stream_logs: [],
  stop_logs: [],
  restart_agent: [],
  reboot_pi: [],
  tcpdump: [{ name: 'interface', label: 'Interface', type: 'interface', required: true }],
  stop_tcpdump: [{ name: 'interface', label: 'Interface', type: 'interface', required: true }],
  connect_wifi: [
    { name: 'ssid', label: 'SSID (ignored if BSSID is set)', type: 'text' },
    { name: 'bssid', label: 'BSSID (optional - overrides SSID)', type: 'text' },
    { name: 'password', label: 'Password (optional)', type: 'password' },
    { name: 'channel', label: 'Channel (optional - pins band+channel, ignored with BSSID)', type: 'number' },
    { name: 'interface', label: 'Interface', type: 'interface', required: true },
    {
      name: 'max_standard', label: 'Max 802.11 standard (optional)', type: 'select',
      options: [
        { value: '', label: 'auto (radio default)' },
        { value: 'be', label: '802.11be (Wi-Fi 7) max' },
        { value: 'ax', label: '802.11ax (Wi-Fi 6) max' },
        { value: 'ac', label: '802.11ac (Wi-Fi 5) max' },
        { value: 'n', label: '802.11n (Wi-Fi 4) max' },
        { value: 'legacy', label: '802.11a/g max' },
      ],
    },
    {
      name: 'security', label: 'Security', type: 'select',
      options: [
        { value: '', label: 'auto: open / WPA2 / WPA3-Personal / PCM (by password)' },
        { value: 'owe', label: 'OWE (Enhanced Open)' },
        { value: 'sae_pk', label: 'WPA3-Personal SAE-PK (Password = SAE-PK password)' },
        { value: 'enterprise', label: 'WPA3-Enterprise' },
        { value: 'enterprise_192', label: 'WPA3-Enterprise 192-bit (EAP-TLS)' },
      ],
    },
    {
      name: 'eap_method', label: 'Enterprise: EAP method', type: 'select', showIf: { security: ['enterprise', 'enterprise_192'] },
      options: [{ value: 'PEAP', label: 'PEAP' }, { value: 'TTLS', label: 'TTLS' }, { value: 'TLS', label: 'TLS (certificate)' }, { value: 'PWD', label: 'PWD' }],
    },
    { name: 'identity', label: 'Enterprise: identity', type: 'text', showIf: { security: ['enterprise', 'enterprise_192'] } },
    { name: 'anonymous_identity', label: 'Enterprise: anonymous identity (optional)', type: 'text', showIf: { security: ['enterprise', 'enterprise_192'] } },
    { name: 'eap_password', label: 'Enterprise: password (PEAP/TTLS/PWD)', type: 'password', showIf: { security: ['enterprise'] } },
    {
      name: 'phase2', label: 'Enterprise: inner auth (PEAP/TTLS)', type: 'select', showIf: { security: ['enterprise'] },
      options: [{ value: '', label: 'default (PEAP: MSCHAPV2, TTLS: PAP)' }, { value: 'MSCHAPV2', label: 'MSCHAPV2' }, { value: 'PAP', label: 'PAP' }, { value: 'GTC', label: 'GTC' }],
    },
    { name: 'domain_suffix_match', label: 'Enterprise: server domain (optional)', type: 'text', showIf: { security: ['enterprise', 'enterprise_192'] } },
    { name: 'ca_cert_pem', label: 'Enterprise: CA certificate PEM (optional - blank = server not validated)', type: 'textarea', showIf: { security: ['enterprise', 'enterprise_192'] } },
    { name: 'client_cert_pem', label: 'Enterprise: client certificate PEM (TLS)', type: 'textarea', showIf: { security: ['enterprise', 'enterprise_192'] } },
    { name: 'private_key_pem', label: 'Enterprise: private key PEM (TLS)', type: 'textarea', showIf: { security: ['enterprise', 'enterprise_192'] } },
    { name: 'private_key_passwd', label: 'Enterprise: private key password (optional)', type: 'password', showIf: { security: ['enterprise', 'enterprise_192'] } },
    // WPA3-Personal Compatibility Mode: the WPA3 part is in the AP's RSN
    // Override elements, only read with rsn_overriding on (agent default: force).
    {
      name: 'rsn_overriding', label: 'WPA3-PCM / RSN overriding', type: 'select',
      options: [
        { value: '', label: 'force on (default)' },
        { value: '1', label: 'auto (driver capability)' },
        { value: '0', label: 'off (join PCM AP as WPA2)' },
      ],
    },
  ],
  disconnect_wifi: [{ name: 'interface', label: 'Interface', type: 'interface', required: true }],
  list_interfaces: [],
  // Nearby hotspots across one or more radios. The interface picker is
  // multi-select and the whole list goes in one command: the agent scans
  // the radios concurrently and merges what they saw by BSSID, so an AP
  // only one radio can hear still shows up, and one several can hear
  // appears once with the best signal any of them measured.
  nearby_hotspots: [{ name: 'interfaces', label: 'Interfaces', type: 'interface', required: true }],
  // Join one hotspot on several radios at once. Pair it with a
  // nearby_hotspots result: BSSID pins the exact AP, which is what the
  // steering tests care about, while SSID alone lets each radio pick.
  connect_hotspot: [
    { name: 'ssid', label: 'SSID (ignored if BSSID is set)', type: 'text' },
    { name: 'bssid', label: 'BSSID (optional - overrides SSID)', type: 'text' },
    { name: 'password', label: 'Password (optional)', type: 'password' },
    { name: 'channel', label: 'Channel (optional - ignored with BSSID)', type: 'number' },
    { name: 'interfaces', label: 'Interfaces', type: 'interface', required: true },
    {
      name: 'max_standard', label: 'Max 802.11 standard (optional)', type: 'select',
      options: [
        { value: '', label: 'auto (radio default)' },
        { value: 'be', label: '802.11be (Wi-Fi 7) max' },
        { value: 'ax', label: '802.11ax (Wi-Fi 6) max' },
        { value: 'ac', label: '802.11ac (Wi-Fi 5) max' },
        { value: 'n', label: '802.11n (Wi-Fi 4) max' },
        { value: 'legacy', label: '802.11a/g max' },
      ],
    },
  ],
  // Monitor-mode's own channel setter (via iw - see
  // pi_agent.set_monitor_channel). Band only matters for 6GHz, whose
  // channel numbers overlap 2.4/5GHz; otherwise it's implied by the channel.
  set_monitor_channel: [
    { name: 'interface', label: 'Interface', type: 'interface', required: true },
    { name: 'channel', label: 'Channel', type: 'number', required: true },
    {
      name: 'band', label: 'Band', type: 'select',
      options: [{ value: '', label: 'auto (2.4/5GHz)' }, { value: '6', label: '6GHz' }],
    },
    {
      name: 'width', label: 'Width (MHz)', type: 'select',
      options: [{ value: '', label: '20' }, { value: '40', label: '40' }, { value: '80', label: '80' }, { value: '160', label: '160' }],
    },
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

// What each action's *result* looks like - the mirror of ACTION_PARAMS above,
// which describes its inputs. Drives the testcase step editor's expected-
// result section (see renderTcStepExpectedFields in testcases-tab.js), so an
// operator picks the field to assert on from a list of what this action
// actually returns instead of having to remember and type a dot-path.
//
// Kept in sync by hand with pi_agent's return dicts (agent/wifi.py,
// interfaces.py, streaming.py, core.py's handle_command). Being incomplete is
// not fatal: the editor always also offers a free-text "other field" row, so
// an unlisted or nested field is still assertable.
//
// `type` picks the value input and which operators make sense:
//   boolean -> eq/ne/exists, rendered as a true/false select
//   number  -> the full ordering set
//   text    -> eq/ne/contains/exists
//   json    -> exists/contains only (arrays/objects have no useful ordering)
const ACTION_RESULT_FIELDS = {
  ping: [
    { name: 'packets_transmitted', type: 'number' },
    { name: 'packets_received', type: 'number' },
    { name: 'packet_lost', type: 'number' },
    { name: 'rtt_avg_ms', type: 'number' },
    { name: 'rtt_min_ms', type: 'number' },
    { name: 'rtt_max_ms', type: 'number' },
    { name: 'rtt_mdev_ms', type: 'number' },
    { name: 'time_ms', type: 'number' },
    { name: 'interface', type: 'text' },
    { name: 'target', type: 'text' },
  ],
  signal_stats: [{ name: 'stations', type: 'json' }],
  band_channel_info: [
    { name: 'interface', type: 'text' },
    { name: 'wiphy', type: 'text' },
    { name: 'current', type: 'json' },
    { name: 'bands', type: 'json' },
  ],
  link_info: [
    { name: 'connected', type: 'boolean' },
    { name: 'ssid', type: 'text' },
    { name: 'bssid', type: 'text' },
    { name: 'signal_dbm', type: 'number' },
    { name: 'frequency_mhz', type: 'number' },
    { name: 'band', type: 'text' },
    { name: 'radio_type', type: 'text' },
    { name: 'rx_bitrate_mbps', type: 'number' },
    { name: 'tx_bitrate_mbps', type: 'number' },
    { name: 'gateway', type: 'text' },
    { name: 'interface', type: 'text' },
    { name: 'raw_output', type: 'text' },
  ],
  throughput_test: [
    { name: 'throughput_mbps', type: 'number' },
    { name: 'retransmits', type: 'number' },
    { name: 'interface', type: 'text' },
  ],
  set_channel: [
    { name: 'restarted', type: 'boolean' },
    { name: 'channel', type: 'number' },
  ],
  syslog: [{ name: 'logs', type: 'json' }],
  stream_logs: [
    { name: 'streaming', type: 'boolean' },
    { name: 'already_running', type: 'boolean' },
  ],
  restart_agent: [{ name: 'scheduled', type: 'text' }, { name: 'in_seconds', type: 'number' }],
  reboot_pi: [{ name: 'scheduled', type: 'text' }, { name: 'in_seconds', type: 'number' }],
  stop_logs: [
    { name: 'streaming', type: 'boolean' },
    { name: 'stopped', type: 'boolean' },
  ],
  tcpdump: [
    { name: 'streaming', type: 'boolean' },
    { name: 'already_running', type: 'boolean' },
    { name: 'interface', type: 'text' },
  ],
  stop_tcpdump: [
    { name: 'streaming', type: 'boolean' },
    { name: 'stopped', type: 'boolean' },
    { name: 'interface', type: 'text' },
  ],
  connect_wifi: [
    { name: 'connected', type: 'boolean' },
    { name: 'ip_address', type: 'text' },
    { name: 'ssid', type: 'text' },
    { name: 'bssid', type: 'text' },
    { name: 'channel', type: 'number' },
    { name: 'interface', type: 'text' },
    { name: 'max_standard', type: 'text' },
    { name: 'max_standard_applied', type: 'boolean' },
    { name: 'key_mgmt', type: 'text' },
    { name: 'pairwise_cipher', type: 'text' },
    { name: 'rsn_overriding_applied', type: 'boolean' },
    { name: 'security', type: 'text' },
    { name: 'eap_state', type: 'text' },
    { name: 'failure_reason', type: 'text' },
    { name: 'output', type: 'text' },
  ],
  disconnect_wifi: [
    { name: 'disconnected', type: 'boolean' },
    { name: 'interface', type: 'text' },
    { name: 'output', type: 'text' },
  ],
  list_interfaces: [{ name: 'interfaces', type: 'json' }],
  nearby_hotspots: [
    { name: 'networks', type: 'json' },
    { name: 'interfaces', type: 'json' },
    { name: 'errors', type: 'json' },
  ],
  connect_hotspot: [
    { name: 'connected', type: 'boolean' },
    { name: 'connected_interfaces', type: 'json' },
    { name: 'ssid', type: 'text' },
    { name: 'bssid', type: 'text' },
    { name: 'channel', type: 'number' },
    { name: 'interfaces', type: 'json' },
    { name: 'results', type: 'json' },
  ],
  set_monitor_channel: [
    { name: 'applied', type: 'boolean' },
    { name: 'interface', type: 'text' },
    { name: 'channel', type: 'number' },
    { name: 'output', type: 'text' },
  ],
  set_interface_mode: [
    { name: 'applied', type: 'boolean' },
    { name: 'resulting_type', type: 'text' },
    { name: 'mode', type: 'text' },
    { name: 'interface', type: 'text' },
    { name: 'output', type: 'text' },
  ],
};

// Offered on every action: pi_agent returns {"error": "..."} for a rejected
// command whatever the action was, so "error exists" is a valid assertion
// (and its negative a useful smoke check) everywhere.
const COMMON_RESULT_FIELDS = [{ name: 'error', type: 'text' }];

function resultFieldsForAction(action) {
  return [...(ACTION_RESULT_FIELDS[action] || []), ...COMMON_RESULT_FIELDS];
}

const RESULT_OPS_BY_TYPE = {
  boolean: ['eq', 'ne', 'exists'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists'],
  text: ['eq', 'ne', 'contains', 'exists'],
  json: ['exists', 'contains'],
};

function currentTargetInterfaces() {
  const target = targetSelect.value;
  if (!target || target === 'all' || target === 'multicast') return [];
  const pi = pis.find(p => p.pi_id === target);
  return (pi && pi.metadata && Array.isArray(pi.metadata.interfaces)) ? pi.metadata.interfaces : [];
}

// Shared by the Action panel and the Pi detail page's action bar.
function paramFieldHtml(f) {
  const value = f.default !== undefined ? `value="${f.default}"` : '';
  let html;
  if (f.type === 'password') {
    html = `
      <label>${f.label}</label>
      <div class="password-wrap">
        <input class="field" data-param="${f.name}" type="password" ${value}>
        <button type="button" class="password-toggle" title="Show password">${EYE_ICON_SVG}</button>
      </div>
    `;
  } else if (f.type === 'select') {
    html = `
      <label>${f.label}</label>
      <select class="field" data-param="${f.name}">
        ${f.options.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
      </select>
    `;
  } else if (f.type === 'textarea') {
    html = `
      <label>${f.label}</label>
      <textarea class="field param-textarea" data-param="${f.name}" rows="4" spellcheck="false" placeholder="-----BEGIN ...-----"></textarea>
    `;
  } else {
    html = `
      <label>${f.label}</label>
      <input class="field" data-param="${f.name}" type="${f.type}" ${value}>
    `;
  }
  // showIf: { otherParam: [values...] } - only shown (and only sent) while
  // that other field has one of those values. See applyShowIf.
  return f.showIf
    ? `<div class="param-field" data-show-if='${JSON.stringify(f.showIf)}'>${html}</div>`
    : html;
}

function applyShowIf(container) {
  container.querySelectorAll('.param-field[data-show-if]').forEach(wrap => {
    const cond = JSON.parse(wrap.dataset.showIf);
    const visible = Object.entries(cond).every(([name, values]) => {
      const el = container.querySelector(`[data-param="${name}"]`);
      return el && values.includes(el.value);
    });
    wrap.classList.toggle('hidden', !visible);
  });
  if (!container.dataset.showIfBound) {
    container.dataset.showIfBound = '1';
    container.addEventListener('change', () => applyShowIf(container));
  }
}

// Hidden showIf fields keep whatever was typed, but aren't sent.
function isHiddenParam(el) {
  return !!el.closest('.param-field.hidden');
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
    if (f.pingTargetPicker) {
      return `
        <label>${f.label}</label>
        <input class="field" data-param="${f.name}" type="${f.type}" ${f.default !== undefined ? `value="${f.default}"` : ''}>
        <select class="field ping-target-picker"><option value="">— or pick a Pi radio to ping —</option></select>
      `;
    }
    return paramFieldHtml(f);
  }).join('');
  applyShowIf(paramFields);

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

  const pingPicker = paramFields.querySelector('.ping-target-picker');
  if (pingPicker) {
    populatePingTargetPicker(pingPicker);
    const targetInput = paramFields.querySelector('input[data-param="target"]');
    if (targetInput) wirePingTargetExclusivity(pingPicker, targetInput);
  }
}

// Picking a Pi radio and typing a raw IP are mutually exclusive - using one
// clears+disables the other, so collectParams() (which just reads whichever
// input has a value) never has to reconcile two live sources for the same
// `target` param.
function wirePingTargetExclusivity(picker, targetInput) {
  picker.addEventListener('change', () => {
    if (picker.value) {
      targetInput.value = picker.value;
      targetInput.disabled = true;
    } else {
      targetInput.disabled = false;
      targetInput.value = '';
    }
  });
  targetInput.addEventListener('input', () => {
    if (targetInput.value) {
      picker.value = '';
      picker.disabled = true;
    } else {
      picker.disabled = false;
    }
  });
}

// Fills the ping action's "pick a Pi radio to ping" dropdown from every
// currently-known radio's live IP (GET /pis/interface-status, the same
// fleet-wide buffered snapshot the Interfaces tab uses) - lets a ping be
// aimed at another wlan on this same Pi, or a radio on a different Pi
// entirely, without the user having to look up/copy that IP by hand.
// Picking an entry just fills the plain `target` text field (still
// editable/clearable for a non-Pi target like 8.8.8.8), it doesn't become
// its own command param.
async function populatePingTargetPicker(picker) {
  let rows;
  try {
    const res = await apiFetch(`${API}/pis/interface-status`);
    if (!res.ok) return;
    rows = await res.json();
  } catch {
    return; // best-effort - the plain text field still works without this
  }
  const withIp = rows.filter(r => r.ip_address).sort((a, b) =>
    a.pi_id === b.pi_id ? a.interface.localeCompare(b.interface) : a.pi_id.localeCompare(b.pi_id));
  picker.innerHTML = '<option value="">— or pick a Pi radio to ping —</option>' + withIp.map(r =>
    `<option value="${r.ip_address}">${r.pi_id} / ${r.interface} — ${r.ip_address}${r.ssid ? ` (${r.ssid})` : ''}</option>`
  ).join('');
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
  if (action === 'nearby_hotspots') renderWifiScanLoading(entry.querySelector('.result'));
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

// Spinner + text shown in place of a nearby_hotspots result while the scan
// is still in flight - used by every entry point (plain action,
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

// nearby_hotspots' result is a list of nearby APs - shown as one collapsed card
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

// One nearby_hotspots network card, with a Connect button that joins this
// AP via connect_hotspot - not connect_wifi - targeting `net.seen_by` (the
// radios that actually heard this specific BSSID during the scan, per
// PiAgent.get_nearby_hotspots/_merge_hotspot), not every interface the scan
// was run against. Mirrors the fleet cross-Pi merged card's look
// (renderMergedWifiNetworkCard in wifi-scan.js), but for one Pi it can use
// connect_hotspot's own atomic multi-radio join instead of fanning out
// separate connect_wifi calls client-side.
function renderHotspotConnectCard(piId, net) {
  const open = isOpenSecurity(net.security);
  const targets = net.seen_by && net.seen_by.length ? net.seen_by : (net.best_interface ? [net.best_interface] : []);
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
    ['Seen by', targets.join(', ')],
    ['Channel', net.channel],
    ['Frequency', net.frequency_mhz != null ? `${net.frequency_mhz} MHz` : null],
    ['Band', net.band],
    ['Rate', net.rate],
    ['Signal', net.signal_percent != null ? `${net.signal_percent}%` : null],
    ['Security', net.security],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
  body.innerHTML = `
    <table class="result-table">${rows.map(([k, v]) =>
      `<tr><td class="result-key">${k}</td><td class="result-value">${v}</td></tr>`
    ).join('')}</table>
    <div class="wifi-connect-row">
      ${open ? '' : wifiPasswordFieldHtml(net)}
      <select class="field wifi-max-standard" title="Cap the 802.11 standard these radios negotiate at">
        <option value="">max standard: auto</option>
        <option value="be">802.11be (Wi-Fi 7) max</option>
        <option value="ax">802.11ax (Wi-Fi 6) max</option>
        <option value="ac">802.11ac (Wi-Fi 5) max</option>
        <option value="n">802.11n (Wi-Fi 4) max</option>
        <option value="legacy">802.11a/g max</option>
      </select>
      <button type="button" class="wifi-connect-btn" ${targets.length ? '' : 'disabled'}>Connect${targets.length > 1 ? ` (${targets.length} interfaces)` : ''}</button>
    </div>
    <div class="wifi-connect-status hint"></div>
  `;

  card.querySelector('.pd-iface-header').addEventListener('click', () => {
    const expanding = body.classList.contains('hidden');
    body.classList.toggle('hidden');
    card.querySelector('.pd-iface-toggle').innerHTML = chevronIconSvg(expanding ? 'down' : 'right');
  });

  const stop = (e) => e.stopPropagation();
  const statusEl = body.querySelector('.wifi-connect-status');
  const passwordInput = body.querySelector('.wifi-connect-password');
  if (passwordInput) passwordInput.addEventListener('click', stop);
  const maxStandardInput = body.querySelector('.wifi-max-standard');
  if (maxStandardInput) maxStandardInput.addEventListener('click', stop);
  const rememberCheckbox = body.querySelector('.wifi-remember-checkbox');
  if (rememberCheckbox) rememberCheckbox.addEventListener('click', stop);

  const connectBtn = body.querySelector('.wifi-connect-btn');
  connectBtn.addEventListener('click', async (e) => {
    stop(e);
    if (!targets.length) return;
    connectBtn.disabled = true;
    statusEl.textContent = `Connecting on ${targets.length} interface(s)…`;
    const password = passwordInput && passwordInput.value ? passwordInput.value : undefined;
    const max_standard = maxStandardInput && maxStandardInput.value ? maxStandardInput.value : undefined;
    try {
      const result = await sendCommandAwaitResult(piId, 'connect_hotspot', {
        ssid: net.ssid || undefined,
        bssid: net.bssid || undefined,
        password,
        channel: net.channel || undefined,
        interfaces: targets,
        max_standard,
      });
      const okCount = (result && result.connected_interfaces) ? result.connected_interfaces.length : 0;
      statusEl.textContent = result && result.connected
        ? `Connected on all ${okCount} interface(s).`
        : `Connected on ${okCount}/${targets.length}. ` +
          (result && Array.isArray(result.results)
            ? result.results.filter(r => !r.connected).map(r => `${r.interface}: ${r.error || wifiFailureDetail(r) || 'failed'}`).join('; ')
            : '');
      if (okCount > 0) {
        applyWifiPasswordMemory(body, net, password);
        // Refresh whichever of these interfaces are showing as fleet cards -
        // same reasoning as renderMergedWifiNetworkCard's own Connect button.
        (result.connected_interfaces || []).forEach(iface => {
          const entry = piRows.get(piId);
          const cardState = entry && entry.ifaceCards.get(iface);
          if (entry && cardState) {
            entry.ifaceDetailsCache = null;
            entry.ifaceDetailsPromise = null;
            refreshFleetWifiIcon(piId, entry, cardState);
          }
        });
      }
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
    } finally {
      connectBtn.disabled = false;
    }
  });

  return card;
}

// A single-Pi nearby_hotspots result (the common case from the Fleet/detail
// Actions panel) - one connect-capable card per AP (renderHotspotConnectCard
// above), instead of the connect-less plain result view, so scanning from
// the Actions panel can connect directly too, not just the merged
// cross-Pi/multi-interface fleet scan builder (wifi-scan.js's
// sendScanWifiFanOut/renderMergedWifiScan).
function renderNearbyHotspotsWithConnect(container, piId, networks) {
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

  networks.forEach(net => listEl.appendChild(renderHotspotConnectCard(piId, net)));

  searchWrap.querySelector('.pd-wifi-search-input').addEventListener('input', (e) => {
    applyWifiSearchFilter(listEl, e.target.value);
  });
}

// Single dispatch point so every place a command's result gets rendered
// (live poll, and restored history on page reload) picks nearby_hotspots'
// per-AP cards over the generic key-value table without duplicating logic.
function renderCommandResult(container, action, result, piId) {
  if (action === 'nearby_hotspots' && result && Array.isArray(result.networks)) {
    if (piId) {
      renderNearbyHotspotsWithConnect(container, piId, result.networks);
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

