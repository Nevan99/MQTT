// --- Command history ---------------------------------------------------
// Every stored command, a page at a time from /commands (newest first).
// The search, status, Pi and action filters are applied by the backend,
// so they cover the whole history, not just the page shown; /commands/stats
// gives the totals for the summary and the filter options.

const historyTableBody = document.getElementById('historyTableBody');
const historySelectAll = document.getElementById('historySelectAll');
const historyDeleteSelectedBtn = document.getElementById('historyDeleteSelectedBtn');
const histSummary = document.getElementById('histSummary');
const histBulkCount = document.getElementById('histBulkCount');
const histSearch = document.getElementById('histSearch');
const histStatusSeg = document.getElementById('histStatusSeg');
const histPiFilter = document.getElementById('histPiFilter');
const histActionFilter = document.getElementById('histActionFilter');
const histRange = document.getElementById('histRange');
const histPageInfo = document.getElementById('histPageInfo');
const histPrev = document.getElementById('histPrev');
const histNext = document.getElementById('histNext');
const histPageSize = document.getElementById('histPageSize');
const histDeleteAllBtn = document.getElementById('histDeleteAllBtn');
const checkedHistoryIds = new Set();
const openHistoryIds = new Set();

// The page shown, how many commands match the filters, and the totals.
let allCommands = [];
let histTotal = 0;
let histStats = { total: 0, by_status: {}, pis: [], actions: [] };
let histPage = 0;
let histStatus = '';

function escapeHistoryHtml(v) {
  return String(v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// "5 min ago" beside the exact time, which stays in the tooltip.
function historyAgo(value) {
  const d = parseApiDate(value);
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (Number.isNaN(s)) return '';
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function commandDisplayStatus(c) {
  return effectiveCommandStatus(c.action, c.status, c.result);
}

function updateHistoryDeleteBtn() {
  const n = checkedHistoryIds.size;
  historyDeleteSelectedBtn.disabled = n === 0;
  historyDeleteSelectedBtn.textContent = n ? `Delete ${n}…` : 'Delete…';
  histBulkCount.innerHTML = n ? `<b>${n}</b> selected` : 'none selected';
  histBulkCount.closest('.tc-bulk-bar').classList.toggle('has-selection', n > 0);
}

function syncHistorySelectAll() {
  const checkboxes = [...historyTableBody.querySelectorAll('.history-select-checkbox')];
  historySelectAll.checked = checkboxes.length > 0 && checkboxes.every(cb => cb.checked);
  historySelectAll.indeterminate = checkboxes.some(cb => cb.checked) && !historySelectAll.checked;
}

async function deleteHistoryEntries(ids) {
  const results = await Promise.allSettled(ids.map(id =>
    apiFetch(`${API}/commands/${id}`, { method: 'DELETE', keepalive: true })
  ));
  const failed = results.filter(r => r.status === 'rejected' || !r.value.ok && r.value.status !== 404);
  ids.forEach(id => checkedHistoryIds.delete(id));
  if (failed.length) alert(`${failed.length} of ${ids.length} failed to delete; they may reappear on reload.`);
  await loadHistory();
}

function historyPageSize() { return Number(histPageSize.value) || 100; }

function refreshHistoryOptions() {
  const fill = (el, values, allLabel, label) => {
    const current = el.value;
    el.innerHTML = `<option value="">${allLabel}</option>` +
      values.map(v => `<option value="${escapeHistoryHtml(v)}">${escapeHistoryHtml(label(v))}</option>`).join('');
    if (values.includes(current)) el.value = current;
  };
  fill(histPiFilter, histStats.pis, 'All Pis', v => v);
  fill(histActionFilter, histStats.actions, 'All actions', actionLabel);
}

function renderHistorySummary() {
  const counts = histStats.by_status || {};
  const bad = (counts.failed || 0) + (counts.timeout || 0);
  histSummary.innerHTML = histStats.total
    ? `<b>${histStats.total.toLocaleString('en-US')}</b> commands · <span class="kt-chip kt-chip-ok">${counts.complete || 0} complete</span>`
      + (bad ? ` <span class="kt-chip kt-chip-bad">${bad} failed</span>` : '')
      + (counts.pending ? ` <span class="kt-chip kt-chip-warn">${counts.pending} pending</span>` : '')
    : '';
  histStatusSeg.querySelectorAll('button[data-status]').forEach(b => {
    const s = b.dataset.status;
    const n = s ? (counts[s] || 0) : histStats.total;
    b.innerHTML = `${b.dataset.label || (b.dataset.label = b.textContent)} <span class="kt-seg-n">${n}</span>`;
  });
}

function toggleHistoryRow(id, open) {
  const row = historyTableBody.querySelector(`.history-row[data-command-id="${id}"]`);
  const detailRow = historyTableBody.querySelector(`.history-detail-row[data-command-id="${id}"]`);
  if (!row || !detailRow) return;
  detailRow.classList.toggle('hidden', !open);
  row.classList.toggle('is-open', open);
  const toggle = row.querySelector('.history-toggle');
  toggle.innerHTML = chevronIconSvg(open ? 'down' : 'right');
  toggle.setAttribute('aria-expanded', String(open));
  if (open) openHistoryIds.add(id); else openHistoryIds.delete(id);
  if (!open) return;
  const command = allCommands.find(c => c.command_id === id);
  const resultEl = detailRow.querySelector('.result');
  if (command && command.result) renderCommandResult(resultEl, command.action, command.result, command.pi_id);
  else resultEl.innerHTML = '<div class="pi-log-empty">no result</div>';
}

function renderHistoryPager() {
  const size = historyPageSize();
  const pages = Math.max(1, Math.ceil(histTotal / size));
  const first = histTotal ? histPage * size + 1 : 0;
  const last = Math.min(histTotal, (histPage + 1) * size);
  histRange.innerHTML = `Showing <b>${first.toLocaleString('en-US')}–${last.toLocaleString('en-US')}</b> of <b>${histTotal.toLocaleString('en-US')}</b>`;
  histPageInfo.textContent = `Page ${histPage + 1} of ${pages}`;
  histPrev.disabled = histPage === 0;
  histNext.disabled = histPage >= pages - 1;
  updateHistoryDeleteAllBtn();
}

function historyEmptyHtml() {
  const filtered = histStats.total > 0;
  return `<tr class="kt-empty-row"><td colspan="6"><div class="kt-empty">
    <span class="kaon-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <strong>${filtered ? 'No commands match these filters' : 'No commands sent yet'}</strong>
    <span>${filtered ? 'Try another status or clear the filters.' : 'Commands sent to a Pi from the Fleet tab or a Pi page are listed here.'}</span>
  </div></td></tr>`;
}

function renderHistory() {
  const commands = allCommands;
  renderHistorySummary();
  renderHistoryPager();
  historyTableBody.innerHTML = commands.map(c => {
    const status = commandDisplayStatus(c);
    const exact = formatVnDateTime(c.created_at);
    return `
      <tr class="history-row" data-command-id="${c.command_id}">
        <td class="tc-check-col"><input type="checkbox" class="history-select-checkbox" aria-label="Select ${escapeHistoryHtml(actionLabel(c.action))} on ${escapeHistoryHtml(c.pi_id)}" ${checkedHistoryIds.has(c.command_id) ? 'checked' : ''}></td>
        <td>${c.pi_id === 'all' ? '<span class="kt-muted">all Pis</span>'
          : `<a href="#pi/${encodeURIComponent(c.pi_id)}" class="pi-id-link kt-pi">${escapeHistoryHtml(c.pi_id)}</a>`}</td>
        <td><code class="kt-code">${escapeHistoryHtml(actionLabel(c.action))}</code></td>
        <td><span class="kt-pill kt-status-${status}">${status}</span></td>
        <td class="res-date" title="${exact}"><span class="kt-date">${historyAgo(c.created_at)}</span> <span class="kt-time">${exact}</span></td>
        <td class="capture-actions">
          <button type="button" class="kt-act history-toggle" title="Show result" aria-label="Show result" aria-expanded="false">${chevronIconSvg('right')}</button>
          <button type="button" class="kt-act kt-act-danger history-delete" data-command-id="${c.command_id}" title="Delete" aria-label="Delete">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
        </td>
      </tr>
      <tr class="history-detail-row hidden" data-command-id="${c.command_id}"><td colspan="6"><div class="result"></div></td></tr>
    `;
  }).join('') || historyEmptyHtml();

  historyTableBody.querySelectorAll('.history-select-checkbox').forEach(cb => {
    const id = cb.closest('tr').dataset.commandId;
    cb.addEventListener('change', () => {
      if (cb.checked) checkedHistoryIds.add(id); else checkedHistoryIds.delete(id);
      syncHistorySelectAll();
      updateHistoryDeleteBtn();
    });
  });

  // The whole row opens its result; checkbox, links and buttons keep their own job.
  historyTableBody.querySelectorAll('.history-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('input, a, .history-delete')) return;
      const id = row.dataset.commandId;
      toggleHistoryRow(id, !openHistoryIds.has(id));
    });
  });

  historyTableBody.querySelectorAll('.history-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await deleteHistoryEntries([btn.dataset.commandId]);
      } finally {
        updateHistoryDeleteBtn();
      }
    });
  });

  [...openHistoryIds].forEach(id => toggleHistoryRow(id, true));
  syncHistorySelectAll();
  updateHistoryDeleteBtn();
}

// The active filters as query params - shared by the list and "Delete all".
function historyFilterParams() {
  const params = new URLSearchParams();
  const q = histSearch.value.trim();
  if (q) params.set('q', q);
  if (histStatus) params.set('status', histStatus);
  if (histPiFilter.value) params.set('pi_id', histPiFilter.value);
  if (histActionFilter.value) params.set('action', histActionFilter.value);
  return params;
}

function historyQuery() {
  const size = historyPageSize();
  const params = historyFilterParams();
  params.set('limit', size);
  params.set('offset', histPage * size);
  return params.toString();
}

// "Delete all" removes every command matching the filters (the whole
// history when none are set), on every page; pending ones are kept since a
// running testcase is still waiting on them.
function updateHistoryDeleteAllBtn() {
  const filtered = historyFilterParams().toString() !== '';
  histDeleteAllBtn.disabled = histTotal === 0;
  histDeleteAllBtn.textContent = filtered
    ? `Delete all ${histTotal.toLocaleString('en-US')} matching…`
    : `Delete all ${histTotal.toLocaleString('en-US')}…`;
}

histDeleteAllBtn.addEventListener('click', async () => {
  const params = historyFilterParams();
  const filtered = params.toString() !== '';
  const what = filtered
    ? `all ${histTotal.toLocaleString('en-US')} commands matching the current filters`
    : `the entire command history (${histTotal.toLocaleString('en-US')} commands)`;
  if (!confirm(`Delete ${what}?\n\nPending commands are kept. This cannot be undone.`)) return;
  histDeleteAllBtn.disabled = true;
  try {
    const res = await apiFetch(`${API}/commands${filtered ? `?${params}` : ''}`, { method: 'DELETE' });
    if (!res.ok) {
      alert('Failed to delete the command history.');
      return;
    }
    const { skipped_pending: skipped } = await res.json();
    if (skipped) alert(`${skipped} pending command(s) were kept - they are still waiting for a result.`);
    checkedHistoryIds.clear();
    openHistoryIds.clear();
    histPage = 0;
  } catch {
    alert('Failed to delete the command history.');
  } finally {
    await loadHistory();
  }
});

async function loadHistory() {
  try {
    const [res, statsRes] = await Promise.all([
      apiFetch(`${API}/commands?${historyQuery()}`),
      apiFetch(`${API}/commands/stats`),
    ]);
    if (!res.ok) return;
    allCommands = await res.json();
    histTotal = Number(res.headers.get('X-Total-Count')) || allCommands.length;
    if (statsRes.ok) histStats = await statsRes.json();
    // Deleting the last rows of the last page leaves it empty - step back.
    if (!allCommands.length && histPage > 0 && histTotal > 0) {
      histPage = Math.max(0, Math.ceil(histTotal / historyPageSize()) - 1);
      return loadHistory();
    }
    const seenIds = new Set(allCommands.map(c => c.command_id));
    [...checkedHistoryIds].forEach(id => { if (!seenIds.has(id)) checkedHistoryIds.delete(id); });
    [...openHistoryIds].forEach(id => { if (!seenIds.has(id)) openHistoryIds.delete(id); });
    const queried = historyQuery();
    refreshHistoryOptions();
    // A Pi/action filter whose last command was just deleted drops out of
    // its dropdown (back to "All") - fetch again so the list matches it.
    if (historyQuery() !== queried) return loadHistory();
    renderHistory();
  } catch {
    // backend unreachable; leave the last known list in place
  }
}

function setHistoryStatus(value) {
  histStatus = value;
  histStatusSeg.querySelectorAll('button[data-status]').forEach(b => {
    b.setAttribute('aria-checked', String(b.dataset.status === value));
  });
}

// Any filter change starts again from the newest page.
function reloadHistoryFromStart() {
  histPage = 0;
  loadHistory();
}

histStatusSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-status]');
  if (!btn) return;
  setHistoryStatus(btn.dataset.status);
  reloadHistoryFromStart();
});
[histPiFilter, histActionFilter, histPageSize].forEach(el => el.addEventListener('change', reloadHistoryFromStart));

let histSearchTimer = null;
histSearch.addEventListener('input', () => {
  clearTimeout(histSearchTimer);
  histSearchTimer = setTimeout(reloadHistoryFromStart, 300);
});

histPrev.addEventListener('click', () => { if (histPage > 0) { histPage--; loadHistory(); } });
histNext.addEventListener('click', () => { histPage++; loadHistory(); });

document.getElementById('histClearFilters').addEventListener('click', () => {
  histSearch.value = ''; histPiFilter.value = ''; histActionFilter.value = '';
  setHistoryStatus('');
  reloadHistoryFromStart();
});

historySelectAll.addEventListener('change', () => {
  historyTableBody.querySelectorAll('.history-select-checkbox').forEach(cb => {
    cb.checked = historySelectAll.checked;
    const id = cb.closest('tr').dataset.commandId;
    if (cb.checked) checkedHistoryIds.add(id); else checkedHistoryIds.delete(id);
  });
  updateHistoryDeleteBtn();
});

historyDeleteSelectedBtn.addEventListener('click', async () => {
  const ids = [...checkedHistoryIds];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} command result(s)? This cannot be undone.`)) return;
  historyDeleteSelectedBtn.disabled = true;
  await deleteHistoryEntries(ids);
});

document.getElementById('historyRefreshBtn').addEventListener('click', loadHistory);
document.addEventListener('tabshown', (e) => {
  if (e.detail && e.detail.viewId === 'history') loadHistory();
});

loadHistory();
