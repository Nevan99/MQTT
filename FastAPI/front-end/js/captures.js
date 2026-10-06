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

// Full list from the last fetch; metadata filters run on this client-side,
// only the log-text search goes to the backend (it reads the files).
let allCaptures = [];

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
  capFilterEls.pi.innerHTML = '<option value="">all</option>' +
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

function renderCaptures() {
  const rows = filteredCaptures();
  capFilterCount.textContent = `${rows.length} / ${allCaptures.length}`;
  capturesTableBody.innerHTML = rows.map(c => {
    const start = captureStart(c);
    const stop = captureStop(c);
    return `
      <tr data-capture-id="${c.id}">
        <td>${escapeCaptureHtml(c.pi_id)}</td>
        <td>${escapeCaptureHtml(c.category)}</td>
        <td>${escapeCaptureHtml(c.name)}</td>
        <td>${c.category === 'pcap' ? '—' : c.line_count}</td>
        <td>${start ? formatVnDateTime(start) : '—'}</td>
        <td>${formatVnDateTime(stop)}</td>
        <td>${formatDuration(start, stop)}</td>
        <td class="capture-actions">
          <a href="${withToken(`${API}/captures/${c.id}/download`)}" class="icon-btn" title="Download">&#8681;</a>
          <button class="icon-btn capture-delete" data-capture-id="${c.id}" title="Delete">&#128465;</button>
        </td>
      </tr>
    `;
  }).join('') || `<tr><td colspan="8" class="pi-log-empty">${allCaptures.length ? 'no captures match the filters' : 'no captures yet'}</td></tr>`;

  capturesTableBody.querySelectorAll('.capture-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await apiFetch(`${API}/captures/${btn.dataset.captureId}`, { method: 'DELETE', keepalive: true });
        if (!res.ok && res.status !== 404) {
          alert('Failed to delete capture on the server; it may reappear on reload.');
          btn.disabled = false;
          return;
        }
        const id = Number(btn.dataset.captureId);
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

['pi', 'category', 'name', 'linesMin', 'linesMax', 'from', 'to'].forEach(key => {
  capFilterEls[key].addEventListener('input', renderCaptures);
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
  if (hadText) loadCaptures(); else renderCaptures();
});

loadCaptures();
