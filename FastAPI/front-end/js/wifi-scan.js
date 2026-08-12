// --- Fleet: merged scan_wifi result across several (Pi, interface) targets

// Same de-dup key an AP is identified by everywhere else: its BSSID, or
// its SSID if the BSSID wasn't reported (hidden/odd driver output).
function dedupeNetworks(networks) {
  const seen = new Map();
  networks.forEach(net => {
    const key = net.bssid || `ssid:${net.ssid}`;
    if (!seen.has(key)) seen.set(key, net);
  });
  return [...seen.values()];
}

// One merged AP row: same info table as the plain scan result, but its
// Connect button fans connect_wifi out to every (Pi, interface) target
// that took part in the scan, instead of just one. No per-target
// Disconnect here - which of several Pis/interfaces is "connected" to
// this particular AP isn't tracked on the fleet page (that's only shown
// on a single Pi's own detail page), so only Connect is offered.
function renderMergedWifiNetworkCard(targets, net) {
  const open = isOpenSecurity(net.security);
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
  const infoRows = [
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
      ${open ? '' : wifiPasswordFieldHtml(net)}
      <button type="button" class="wifi-connect-btn">Connect (${targets.length} interface${targets.length === 1 ? '' : 's'})</button>
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
  const rememberCheckbox = body.querySelector('.wifi-remember-checkbox');
  if (rememberCheckbox) rememberCheckbox.addEventListener('click', stop);

  body.querySelector('.wifi-connect-btn').addEventListener('click', async (e) => {
    stop(e);
    const btn = e.currentTarget;
    btn.disabled = true;
    statusEl.textContent = `Connecting on ${targets.length} interface(s)…`;
    const password = passwordInput && passwordInput.value ? passwordInput.value : undefined;
    const results = await Promise.allSettled(targets.map(async ({ piId, interface: iface }) => {
      const result = await connectWifiWithRetry(piId, {
        ssid: net.ssid || undefined,
        bssid: net.bssid || undefined,
        password,
        interface: iface,
      });
      if (!(result && result.connected)) {
        throw new Error(`${piId}/${iface}: failed${result && result.output ? ' - ' + result.output : ''}`);
      }
      // Nothing here previously refreshed the fleet's own interface cards -
      // connect succeeded but their wifi icon/connected-mark/IP stayed
      // stale (whatever they last showed) until something else happened
      // to touch them, which read as a mysterious delay. ifaceDetailsCache
      // is nulled to force a fresh IP address on next render; the wifi
      // icon/link info is refreshed right away.
      const entry = piRows.get(piId);
      const cardState = entry && entry.ifaceCards.get(iface);
      if (entry && cardState) {
        entry.ifaceDetailsCache = null;
        entry.ifaceDetailsPromise = null;
        await refreshFleetWifiIcon(piId, entry, cardState);
      }
    }));
    const okCount = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected');
    statusEl.textContent = failed.length
      ? `Connected on ${okCount}/${targets.length}. ${failed.map(r => r.reason.message).join('; ')}`
      : `Connected on all ${okCount} interface(s).`;
    if (okCount > 0) applyWifiPasswordMemory(body, net, password);
    btn.disabled = false;
  });

  return card;
}

function renderMergedWifiScan(container, targets, networks) {
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

  networks.forEach(net => listEl.appendChild(renderMergedWifiNetworkCard(targets, net)));

  searchWrap.querySelector('.pd-wifi-search-input').addEventListener('input', (e) => {
    applyWifiSearchFilter(listEl, e.target.value);
  });
}

// One combined feed entry for a scan_wifi fan-out across several targets -
// replaces what would otherwise be one pending/complete entry per (Pi,
// interface), which for a scan is just the same nearby APs reported N times.
// Added immediately (pending, with the scanning spinner) so there's
// visible feedback for the whole duration of the multi-interface scan,
// not just once every interface has reported back - see fillMergedScanEntry.
function createMergedScanEntry(targets, container) {
  const entry = document.createElement('div');
  entry.className = 'cmd-entry';
  const count = targets.length;
  const label = `scan wifi &rarr; ${count} interface${count === 1 ? '' : 's'} (merged)`;
  entry.innerHTML = `
    <div class="hdr"><span><span class="toggle">&#9660;</span>${label}</span><span><span class="cmd-status pending">pending</span></span></div>
    <div class="result"></div>
  `;
  entry.querySelector('.hdr').addEventListener('click', () => {
    entry.classList.toggle('collapsed');
    entry.querySelector('.toggle').innerHTML = entry.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
  });
  (container || cmdResults).prepend(entry);
  renderWifiScanLoading(entry.querySelector('.result'), `Scanning ${count} interface${count === 1 ? '' : 's'}…`);
  return entry;
}

function fillMergedScanEntry(entry, targets, networksByTarget) {
  const statusEl = entry.querySelector('.cmd-status');
  statusEl.textContent = 'complete';
  statusEl.className = 'cmd-status complete';
  const merged = dedupeNetworks(networksByTarget.flat());
  renderMergedWifiScan(entry.querySelector('.result'), targets, merged);
}

async function sendScanWifiFanOut(targets, params, container) {
  const entry = createMergedScanEntry(targets, container);
  const results = await Promise.allSettled(targets.map(({ piId, interface: iface }) =>
    sendCommandAwaitResult(piId, 'scan_wifi', { ...params, interface: iface })
  ));
  const networksByTarget = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') networksByTarget.push((r.value && r.value.networks) || []);
    else failed.push(`${targets[i].piId}/${targets[i].interface}: ${r.reason.message}`);
  });
  if (failed.length) {
    alert(`${failed.length} of ${targets.length} scan(s) failed:\n${failed.join('\n')}`);
  }
  fillMergedScanEntry(entry, targets, networksByTarget);
}

function pushToPiLogPanel(piId, lines) {
  if (piId === 'all') return;
  let entry = piRows.get(piId);
  if (!entry) return;
  const empty = entry.logPanel.querySelector('.pi-log-empty');
  if (empty) empty.remove();
  lines.forEach(line => appendLineTo(entry.logPanel, line));
}

// connect_wifi/disconnect_wifi report a command status of "complete" as
// soon as nmcli finishes running, regardless of whether the connect/
// disconnect itself actually succeeded - a wrong password or an
// unreachable AP still returns a "complete" command with connected:false
// in the result. Callers care about that outcome, not just whether nmcli
// ran without crashing, so the status badge should read as failed here too.
const WIFI_CONNECTED_ACTIONS = new Set(['connect_wifi', 'disconnect_wifi']);

function effectiveCommandStatus(action, status, result) {
  if (status === 'complete' && WIFI_CONNECTED_ACTIONS.has(action) &&
      result && result.connected === false) {
    return 'failed';
  }
  return status;
}

async function pollCommand(commandId, entry, piId, action) {
  const statusEl = entry.querySelector('.cmd-status');
  const resultEl = entry.querySelector('.result');
  for (let i = 0; i < 30; i++) {
    try {
      const res = await apiFetch(`${API}/commands/${commandId}`);
      if (res.ok) {
        const data = await res.json();
        const displayStatus = effectiveCommandStatus(action, data.status, data.result);
        statusEl.textContent = displayStatus;
        statusEl.className = `cmd-status ${displayStatus}`;
        if (data.result) renderCommandResult(resultEl, action, data.result, piId);
        if (data.status === 'complete' && action === 'syslog' && Array.isArray(data.result?.logs)) {
          pushToPiLogPanel(piId, data.result.logs);
        }
        if (data.status !== 'pending') return;
      }
    } catch {
      // ignore transient errors and keep polling
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function sendOneCommand(url, action, params) {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  const data = await res.json();
  addCommandEntry(data.command_id, data.pi_id, data.action);
}

async function sendFanOut(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) {
    alert(`${failed.length} of ${tasks.length} command(s) failed to send:\n` +
      failed.map(r => r.reason.message).join('\n'));
  }
}

async function sendCommandAwaitResult(piId, action, params) {
  const res = await apiFetch(`${API}/pis/${encodeURIComponent(piId)}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = await res.json();
  return awaitCommandResult(data.command_id, 30);
}

sendCmdBtn.addEventListener('click', async () => {
  const target = targetSelect.value;
  const action = actionSelect.value;
  const params = collectParams();
  const needsInterface = (ACTION_PARAMS[action] || []).some(f => f.type === 'interface');

  sendCmdBtn.disabled = true;
  try {
    if (target === 'all') {
      await sendOneCommand(`${API}/pis/broadcast`, action, params);
    } else if (target === 'multicast') {
      const targetIds = [...checkedPiIds];
      if (!targetIds.length) {
        alert('No Pis checked in the table for multicast.');
        return;
      }
      // One command per (checked Pi, that Pi's own primary interface) pair,
      // dispatched independently - no backend concept of "send to this
      // subset" to piggyback on, and each Pi can have several primary
      // interfaces now, so a single Pi can fan out into several commands.
      const targets = [];
      const rejections = [];
      for (const piId of targetIds) {
        const pi = pis.find(p => p.pi_id === piId);
        if (!needsInterface) {
          targets.push({ piId, interface: null });
          continue;
        }
        const ifaces = (pi && pi.primary_interfaces) || [];
        if (!ifaces.length) {
          rejections.push(`${piId}: no primary interface configured`);
          continue;
        }
        ifaces.forEach(iface => targets.push({ piId, interface: iface }));
      }
      if (rejections.length) alert(rejections.join('\n'));

      if (action === 'scan_wifi' && targets.length > 1) {
        // Scanning the same air from several interfaces just reports the
        // same nearby APs several times - merge into one de-duplicated
        // result instead of one feed entry per interface.
        await sendScanWifiFanOut(targets, params);
      } else {
        await sendFanOut(targets.map(({ piId, interface: iface }) =>
          sendOneCommand(`${API}/pis/${encodeURIComponent(piId)}/cmd`, action, iface ? { ...params, interface: iface } : params)
        ));
      }
    } else if (needsInterface && Array.isArray(params.interface)) {
      // Single Pi target, but multiple interfaces checked - one command per
      // checked interface, same fan-out principle as multicast.
      if (action === 'scan_wifi' && params.interface.length > 1) {
        await sendScanWifiFanOut(params.interface.map(iface => ({ piId: target, interface: iface })), params);
      } else {
        await sendFanOut(params.interface.map(iface =>
          sendOneCommand(`${API}/pis/${encodeURIComponent(target)}/cmd`, action, { ...params, interface: iface })
        ));
      }
    } else {
      await sendOneCommand(`${API}/pis/${encodeURIComponent(target)}/cmd`, action, params);
    }
  } catch (err) {
    alert(`Command failed: ${err.message}`);
  } finally {
    sendCmdBtn.disabled = false;
  }
});

