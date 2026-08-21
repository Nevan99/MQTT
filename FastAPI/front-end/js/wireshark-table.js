// --- tcpdump: Wireshark-style packet list ----------------------------------
// Markup for a tcpdump panel - a sticky-header table (No./Time/Source/
// Destination/Protocol/Length/Info, the same columns Wireshark's packet
// list pane shows) instead of the plain scrolling text log syslog uses.
// Inserted in place of an empty '.pi-log-panel' div wherever a tcpdump
// block is built (both the fleet table's per-interface cards and the Pi
// detail page's shared block).
// Inlined rather than reusing the SEARCH_ICON_SVG constant defined further
// down the file - this is a top-level template string evaluated
// immediately, so it can't reference a const declared later (temporal
// dead zone), unlike the functions elsewhere that just happen to mention
// SEARCH_ICON_SVG inside a function body that only runs later.
const WIRESHARK_FILTER_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

const WIRESHARK_TABLE_HTML = `
  <div class="wireshark-filter-wrap">
    ${WIRESHARK_FILTER_ICON_SVG}
    <input type="text" class="wireshark-filter-input" placeholder="Filter (e.g. tcp, arp, 192.168.1.5)">
  </div>
  <div class="wireshark-pause-banner hidden">
    <span class="wireshark-pause-text">Live capture paused</span>
    <button type="button" class="wireshark-resume-btn">Resume</button>
  </div>
  <div class="wireshark-table-scroll">
    <table class="wireshark-table">
      <thead>
        <tr><th>No.</th><th>Time</th><th>Source</th><th>Destination</th><th>Protocol</th><th>Length</th><th>Info</th></tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>
  <div class="wireshark-detail-panel wireshark-detail-empty-state">
    <button type="button" class="wireshark-detail-close icon-btn" title="Close">${CLOSE_ICON_SVG}</button>
    <div class="wireshark-detail-body">
      <div class="wireshark-detail-empty">Click a packet row to see its details</div>
    </div>
  </div>
`;

function formatPacketTime(iso) {
  const d = parseApiDate(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour12: false, timeZone: VN_TIME_ZONE }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

const PACKET_TABLE_PROTO_CLASSES = new Set(['tcp', 'udp', 'arp', 'icmp']);

const packetTableQueues = new WeakMap();

function getPacketTableState(tbody) {
  let state = packetTableQueues.get(tbody);
  if (!state) {
    state = {
      queue: [], scheduled: false, count: 0,
      paused: false, pending: [], filterQuery: '',
      scrollEl: null, banner: null, detailPanel: null,
    };
    packetTableQueues.set(tbody, state);
  }
  return state;
}

const SCROLL_BOTTOM_MARGIN_PX = 60;

function isScrolledNearBottom(scrollEl, marginPx = SCROLL_BOTTOM_MARGIN_PX) {
  return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < marginPx;
}

function updatePauseBanner(state) {
  if (!state.banner) return;
  state.banner.classList.toggle('hidden', !state.paused);
  if (state.paused) {
    state.banner.querySelector('.wireshark-pause-text').textContent = state.pending.length
      ? `Live capture paused — ${state.pending.length} new packet${state.pending.length === 1 ? '' : 's'}`
      : 'Live capture paused (scrolled up)';
  }
}

function resumeLiveCapture(tbody) {
  const state = getPacketTableState(tbody);
  state.paused = false;
  if (state.pending.length) {
    state.queue.push(...state.pending);
    state.pending = [];
    if (!state.scheduled) {
      state.scheduled = true;
      requestAnimationFrame(() => flushPacketQueue(tbody, state));
    }
  }
  updatePauseBanner(state);
  if (state.scrollEl) state.scrollEl.scrollTop = state.scrollEl.scrollHeight;
}

function setupWiresharkTable(panel) {
  const tbody = panel.querySelector('tbody');
  const scrollEl = panel.querySelector('.wireshark-table-scroll');
  const banner = panel.querySelector('.wireshark-pause-banner');
  const resumeBtn = panel.querySelector('.wireshark-resume-btn');
  const detailPanel = panel.querySelector('.wireshark-detail-panel');
  const detailBody = detailPanel ? detailPanel.querySelector('.wireshark-detail-body') : null;
  const detailCloseBtn = detailPanel ? detailPanel.querySelector('.wireshark-detail-close') : null;
  const filterInput = panel.querySelector('.wireshark-filter-input');
  if (!tbody || !scrollEl) return;

  const state = getPacketTableState(tbody);
  state.scrollEl = scrollEl;
  state.banner = banner;
  state.detailPanel = detailPanel;
  state.detailBody = detailBody;

  if (detailCloseBtn) {
    detailCloseBtn.onclick = (e) => {
      e.stopPropagation();
      closePacketDetail(tbody);
    };
  }

  scrollEl.onscroll = () => {
    if (isScrolledNearBottom(scrollEl)) {
      if (state.paused) resumeLiveCapture(tbody);
    } else if (!state.paused) {
      state.paused = true;
      updatePauseBanner(state);
    }
  };

  if (resumeBtn) resumeBtn.onclick = () => resumeLiveCapture(tbody);

  if (filterInput) {
    filterInput.value = state.filterQuery || '';
    filterInput.onclick = (e) => e.stopPropagation();
    filterInput.oninput = () => {
      state.filterQuery = filterInput.value.trim().toLowerCase();
      tbody.querySelectorAll('tr').forEach(tr => {
        const rowPayload = packetRowPayloads.get(tr);
        const show = !state.filterQuery || (rowPayload && matchesPacketFilter(rowPayload, state.filterQuery));
        tr.classList.toggle('filtered-out', !show);
      });
    };
  }

  tbody.onclick = (e) => {
    const tr = e.target.closest('tr');
    if (!tr) {
      closePacketDetail(tbody);
      return;
    }
    selectPacketRow(tbody, tr);
  };
}

// Tracks whichever packet's detail pane is currently open, across every
// tcpdump table on the page, so the one click-outside listener below can
// close it regardless of which panel it belongs to.
let activePacketSelection = null;

document.addEventListener('click', (e) => {
  if (!activePacketSelection) return;
  const { tbody, detailPanel } = activePacketSelection;
  if (tbody.contains(e.target)) return;
  if (detailPanel && detailPanel.contains(e.target)) return;
  closePacketDetail(tbody);
});

function closePacketDetail(tbody) {
  const state = getPacketTableState(tbody);
  const prevSelected = tbody.querySelector('tr.selected');
  if (prevSelected) prevSelected.classList.remove('selected');
  if (activePacketSelection && activePacketSelection.tbody === tbody) activePacketSelection = null;
  if (state.detailPanel) {
    state.detailPanel.classList.add('wireshark-detail-empty-state');
    if (state.detailBody) {
      state.detailBody.innerHTML = '<div class="wireshark-detail-empty">Click a packet row to see its details</div>';
    }
  }
}

// Simple substring match across the fields shown in the table plus the
// protocol - not Wireshark's real filter grammar (no "tcp.port == 80"
// expressions), but enough to narrow a busy capture down to one host,
// protocol, or keyword while it's still streaming.
function matchesPacketFilter(payload, query) {
  const haystack = [payload.protocol, payload.src, payload.dst, payload.info, payload.length]
    .filter(v => v !== null && v !== undefined)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

// Full decoded fields for whichever row is currently selected, keyed by
// the <tr> itself - the table only shows a summary per row, this backs
// the "click a packet to see its details" pane with everything received.
const packetRowPayloads = new WeakMap();

// Flat key/value packet detail pane - shown for whichever row is selected.
function renderPacketSummaryFallback(container, payload) {
  const rows = [
    ['No.', payload.no],
    ['Time', formatPacketTime(payload.timestamp)],
    ['Source', payload.src || '—'],
    ['Destination', payload.dst || '—'],
    ['Protocol', payload.protocol || '—'],
    ['Length', payload.length != null ? payload.length : '—'],
    ['Interface', payload.interface || '—'],
    ['Info', payload.info || '—'],
  ];
  container.innerHTML = `
    <table class="result-table">${rows.map(([k, v]) =>
      `<tr><td class="result-key">${k}</td><td class="result-value">${v}</td></tr>`
    ).join('')}</table>
  `;
}

function selectPacketRow(tbody, tr) {
  const state = getPacketTableState(tbody);
  const prevSelected = tbody.querySelector('tr.selected');

  // Clicking the already-selected row closes the detail pane instead of
  // re-rendering it - same toggle-to-close behavior as the collapse
  // chevrons elsewhere on the page.
  if (prevSelected === tr) {
    closePacketDetail(tbody);
    return;
  }

  if (prevSelected) prevSelected.classList.remove('selected');
  tr.classList.add('selected');

  const payload = packetRowPayloads.get(tr);
  if (!state.detailPanel || !payload) return;

  state.detailPanel.classList.remove('wireshark-detail-empty-state');
  activePacketSelection = { tbody, detailPanel: state.detailPanel };
  if (state.detailBody) renderPacketSummaryFallback(state.detailBody, payload);
}

function buildPacketRow(no, payload, filterQuery) {
  const tr = document.createElement('tr');
  const proto = (payload.protocol || '').toLowerCase();
  if (PACKET_TABLE_PROTO_CLASSES.has(proto)) tr.classList.add(`proto-${proto}`);
  const cells = [
    no,
    formatPacketTime(payload.timestamp),
    payload.src || '',
    payload.dst || '',
    payload.protocol || '',
    payload.length != null ? payload.length : '',
  ];
  tr.innerHTML = cells.map(v => `<td>${v}</td>`).join('') + '<td class="ws-info"></td>';
  tr.querySelector('.ws-info').textContent = payload.info || '';
  const fullPayload = { no, ...payload };
  packetRowPayloads.set(tr, fullPayload);
  if (filterQuery && !matchesPacketFilter(fullPayload, filterQuery)) tr.classList.add('filtered-out');
  return tr;
}

function appendPacketRow(tbody, payload) {
  const state = getPacketTableState(tbody);
  if (state.paused) {
    state.pending.push(payload);
    if (state.pending.length > 2000) state.pending.shift();
    updatePauseBanner(state);
    return;
  }
  state.queue.push(payload);
  if (!state.scheduled) {
    state.scheduled = true;
    requestAnimationFrame(() => flushPacketQueue(tbody, state));
  }
}

function flushPacketQueue(tbody, state) {
  state.scheduled = false;
  const items = state.queue;
  state.queue = [];
  if (!items.length) return;

  if (state.paused) {
    state.pending.push(...items);
    if (state.pending.length > 2000) state.pending.splice(0, state.pending.length - 2000);
    updatePauseBanner(state);
    return;
  }

  const frag = document.createDocumentFragment();
  items.forEach(payload => {
    state.count += 1;
    frag.appendChild(buildPacketRow(state.count, payload, state.filterQuery));
  });
  tbody.appendChild(frag);

  // Only reachable while live (paused packets never reach this function),
  // so it's always safe to prune old rows and snap to the bottom here.
  while (tbody.children.length > LOG_ROW_CAP) tbody.removeChild(tbody.firstChild);
  if (state.scrollEl) state.scrollEl.scrollTop = state.scrollEl.scrollHeight;
}

function resetLogPanel(panel, spec) {
  if (spec.kind === 'tcpdump') {
    const tbody = panel.querySelector('tbody');
    if (tbody) {
      tbody.innerHTML = '';
      const state = getPacketTableState(tbody);
      state.queue = [];
      state.scheduled = false;
      state.count = 0;
      state.paused = false;
      state.pending = [];
      state.filterQuery = '';
    }
    const detailPanel = panel.querySelector('.wireshark-detail-panel');
    if (detailPanel) {
      detailPanel.classList.add('wireshark-detail-empty-state');
      const detailBody = detailPanel.querySelector('.wireshark-detail-body');
      if (detailBody) detailBody.innerHTML = '<div class="wireshark-detail-empty">Click a packet row to see its details</div>';
    }
    if (activePacketSelection && activePacketSelection.tbody === tbody) activePacketSelection = null;
    const banner = panel.querySelector('.wireshark-pause-banner');
    if (banner) banner.classList.add('hidden');
    const filterInput = panel.querySelector('.wireshark-filter-input');
    if (filterInput) filterInput.value = '';
  } else {
    panel.innerHTML = '<div class="pi-log-empty">waiting for messages…</div>';
    linePanelQueues.delete(panel);
  }
}

