// --- Fleet: saved captures ---------------------------------------------

const capturesTableBody = document.getElementById('capturesTableBody');

const capFilterEls = {
  pi: document.getElementById('capFilterPi'),
  category: document.getElementById('capFilterCategory'),
  name: document.getElementById('capFilterName'),
  text: document.getElementById('capFilterText'),
  linesMin: document.getElementById('capFilterLinesMin'),
  linesMax: document.getElementById('capFilterLinesMax'),
  from: document.getElementById('capFilterFrom'),
  to: document.getElementById('capFilterTo'),
};
const capFilterCount = document.getElementById('capFilterCount');
const capSummary = document.getElementById('capSummary');
const capCategorySeg = document.getElementById('capCategorySeg');
const capMoreBtn = document.getElementById('capMoreBtn');
const capMore = document.getElementById('capMore');
const capSortRow = document.getElementById('capSortRow');

// The filters tucked under "More filters" - the button shows how many are set.
const CAP_MORE_KEYS = ['linesMin', 'linesMax', 'from', 'to'];
const CAP_CATEGORY_LABEL = { logs: 'Syslog', pcap: 'Pcap' };

// Full list from the last fetch; metadata filters run on this client-side,
// only the log-text search goes to the backend (it reads the files).
let allCaptures = [];
let capSort = { key: 'stop', dir: 'desc' };

// Rows saved before start/stop were recorded only have created_at, which
// is when the capture was saved, i.e. its stop time.
function captureStart(c) { return c.started_at ? parseApiDate(c.started_at) : null; }
function captureStop(c) { return parseApiDate(c.stopped_at || c.created_at); }

function formatDuration(start, stop) {
  if (!start || !stop) return '—';
  let s = Math.max(0, Math.round((stop - start) / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

function escapeCaptureHtml(v) {
  return String(v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function refreshCapturePiOptions() {
  const current = capFilterEls.pi.value;
  const pis = [...new Set(allCaptures.map(c => c.pi_id))].sort();
  capFilterEls.pi.innerHTML = '<option value="">All Pis</option>' +
    pis.map(p => `<option value="${escapeCaptureHtml(p)}">${escapeCaptureHtml(p)}</option>`).join('');
  if (pis.includes(current)) capFilterEls.pi.value = current;
}

function filteredCaptures() {
  const f = capFilterEls;
  const name = f.name.value.trim().toLowerCase();
  const linesMin = f.linesMin.value === '' ? null : Number(f.linesMin.value);
  const linesMax = f.linesMax.value === '' ? null : Number(f.linesMax.value);
  // datetime-local values have no zone, so they're read in the browser's
  // local time - same clock the user sees on screen.
  const from = f.from.value ? new Date(f.from.value) : null;
  const to = f.to.value ? new Date(f.to.value) : null;

  return allCaptures.filter(c => {
    if (f.pi.value && c.pi_id !== f.pi.value) return false;
    if (f.category.value && c.category !== f.category.value) return false;
    if (name && !c.name.toLowerCase().includes(name)) return false;
    if (linesMin !== null && (c.category === 'pcap' || c.line_count < linesMin)) return false;
    if (linesMax !== null && (c.category === 'pcap' || c.line_count > linesMax)) return false;
    const start = captureStart(c) || captureStop(c);
    if (from && start < from) return false;
    if (to && captureStop(c) > to) return false;
    return true;
  });
}

function captureSortValue(c, key) {
  switch (key) {
    case 'pi': return c.pi_id;
    case 'category': return c.category;
    case 'name': return c.name.toLowerCase();
    case 'lines': return c.category === 'pcap' ? -1 : c.line_count;
    case 'start': return (captureStart(c) || captureStop(c)).getTime();
    case 'duration': { const s = captureStart(c); return s ? captureStop(c) - s : -1; }
    default: return captureStop(c).getTime();
  }
}

function sortCaptures(rows) {
  const { key, dir } = capSort;
  const sign = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const va = captureSortValue(a, key), vb = captureSortValue(b, key);
    return (va < vb ? -1 : va > vb ? 1 : 0) * sign;
  });
}

function renderCaptureSummary() {
  const logs = allCaptures.filter(c => c.category !== 'pcap');
  const pcaps = allCaptures.length - logs.length;
  const lines = logs.reduce((n, c) => n + (c.line_count || 0), 0);
  capSummary.innerHTML = allCaptures.length
    ? `<b>${allCaptures.length}</b> saved · <span class="kt-chip kt-chip-logs">${logs.length} syslog</span>`
      + ` <span class="kt-chip kt-chip-pcap">${pcaps} pcap</span> · <b>${lines.toLocaleString('en-US')}</b> log lines`
    : '';
}

function renderCaptureSortHeaders() {
  capSortRow.querySelectorAll('th[data-sort]').forEach(th => {
    if (th.dataset.sort === capSort.key) th.dataset.dir = capSort.dir; else delete th.dataset.dir;
  });
}

function renderCaptureMoreBtn() {
  const set = CAP_MORE_KEYS.filter(k => capFilterEls[k].value !== '').length;
  capMoreBtn.innerHTML = `More filters${set ? ` <span class="kt-badge">${set}</span>` : ''} &#9662;`;
  capMoreBtn.classList.toggle('is-active', set > 0);
}

function captureEmptyHtml() {
  const filtered = allCaptures.length > 0;
  return `<tr class="kt-empty-row"><td colspan="8"><div class="kt-empty">
    <span class="kaon-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <strong>${filtered ? 'No captures match these filters' : 'No captures saved yet'}</strong>
    <span>${filtered ? 'Try clearing a filter or searching for something else.' : 'Record syslog or packets from a Pi on the Fleet tab and save them - they show up here.'}</span>
  </div></td></tr>`;
}

function renderCaptures() {
  const rows = sortCaptures(filteredCaptures());
  capFilterCount.innerHTML = `Showing <b>${rows.length}</b> of ${allCaptures.length}`;
  renderCaptureSummary();
  renderCaptureSortHeaders();
  renderCaptureMoreBtn();
  capturesTableBody.innerHTML = rows.map(c => {
    const start = captureStart(c);
    const stop = captureStop(c);
    const isPcap = c.category === 'pcap';
    return `
      <tr data-capture-id="${c.id}">
        <td><a href="#pi/${encodeURIComponent(c.pi_id)}" class="pi-id-link kt-pi">${escapeCaptureHtml(c.pi_id)}</a></td>
        <td><span class="kt-pill kt-pill-${isPcap ? 'pcap' : 'logs'}">${CAP_CATEGORY_LABEL[c.category] || escapeCaptureHtml(c.category)}</span></td>
        <td class="kt-name">${escapeCaptureHtml(c.name)}</td>
        <td class="res-num">${isPcap ? '<span class="kt-muted">—</span>' : c.line_count.toLocaleString('en-US')}</td>
        <td class="res-date">${ktDateTimeHtml(start)}</td>
        <td class="res-date">${ktDateTimeHtml(stop)}</td>
        <td class="res-num kt-mono">${formatDuration(start, stop)}</td>
        <td class="capture-actions">
          <a href="${withToken(`${API}/captures/${c.id}/download`)}" class="kt-act" title="Download ${isPcap ? '.pcap' : '.txt'}">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>Download</a>
          <button type="button" class="kt-act kt-act-danger capture-delete" data-capture-id="${c.id}" title="Delete" aria-label="Delete ${escapeCaptureHtml(c.name)}">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
        </td>
      </tr>
    `;
  }).join('') || captureEmptyHtml();

  capturesTableBody.querySelectorAll('.capture-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.captureId);
      const capture = allCaptures.find(c => c.id === id);
      if (!confirm(`Delete capture "${capture ? capture.name : id}"? This cannot be undone.`)) return;
      btn.disabled = true;
      try {
        const res = await apiFetch(`${API}/captures/${id}`, { method: 'DELETE', keepalive: true });
        if (!res.ok && res.status !== 404) {
          alert('Failed to delete capture on the server; it may reappear on reload.');
          btn.disabled = false;
          return;
        }
        allCaptures = allCaptures.filter(c => c.id !== id);
        renderCaptures();
      } catch {
        alert('Failed to delete capture on the server; it may reappear on reload.');
        btn.disabled = false;
      }
    });
  });
}

async function loadCaptures() {
  try {
    const text = capFilterEls.text.value.trim();
    const url = text ? `${API}/captures?contains=${encodeURIComponent(text)}` : `${API}/captures`;
    const res = await apiFetch(url);
    if (!res.ok) return;
    allCaptures = await res.json();
    refreshCapturePiOptions();
    renderCaptures();
  } catch {
    // backend unreachable; leave the last known list in place
  }
}

function setCaptureCategory(value) {
  capFilterEls.category.value = value;
  capCategorySeg.querySelectorAll('button[data-cat]').forEach(b => {
    b.setAttribute('aria-checked', String(b.dataset.cat === value));
  });
}

['pi', 'name', 'linesMin', 'linesMax', 'from', 'to'].forEach(key => {
  capFilterEls[key].addEventListener('input', renderCaptures);
});

capCategorySeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cat]');
  if (!btn) return;
  setCaptureCategory(btn.dataset.cat);
  renderCaptures();
});

capMoreBtn.addEventListener('click', () => {
  const open = capMore.classList.toggle('hidden') === false;
  capMoreBtn.setAttribute('aria-expanded', String(open));
});

capSortRow.addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  // Text columns start A-Z, numbers and dates start newest/largest first.
  const ascFirst = ['pi', 'category', 'name'].includes(key);
  capSort = capSort.key === key
    ? { key, dir: capSort.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: ascFirst ? 'asc' : 'desc' };
  renderCaptures();
});

// Log-text search hits the backend (reads every file), so debounce it.
let capTextTimer = null;
capFilterEls.text.addEventListener('input', () => {
  clearTimeout(capTextTimer);
  capTextTimer = setTimeout(loadCaptures, 350);
});

document.getElementById('capFilterReset').addEventListener('click', () => {
  const hadText = capFilterEls.text.value !== '';
  Object.values(capFilterEls).forEach(el => { el.value = ''; });
  setCaptureCategory('');
  if (hadText) loadCaptures(); else renderCaptures();
});

document.getElementById('capRefreshBtn').addEventListener('click', loadCaptures);
document.addEventListener('tabshown', (e) => {
  if (e.detail && e.detail.viewId === 'captures') loadCaptures();
});

loadCaptures();
