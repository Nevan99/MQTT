// --- Results tab: every past testcase/testsuite run in one list ------------
// Laid out like CDRouter's Results page: a sidebar with "Show" (owner, and
// which set of runs - current, starred, by date, archived, locked only) and
// "Filters" (device, type, status, package name, testcase name, popular
// tags, frequent packages), and a sortable, paged table with a bulk toolbar.
//
// Filtering, sorting and paging all happen server-side in GET /results
// (routers/Results.py), which flattens testcase runs and testsuite runs into
// one row shape - so this file only keeps the current page (resItems), not
// the whole history. Owner = the testcase/testsuite's author, Device = the
// Pi(s) its steps target, Package = the testcase/testsuite that ran.
//
// Opening a run shows CDRouter's result page for it (#results/<kind>/<id>,
// see "one run" below) - live runs included, which is why there's no
// separate Running tab. Its Log column reuses tcRenderRunInto/
// tcRenderRunSteps from testcases-tab.js, which is why this file is loaded
// after it (and after testsuites-tab.js, whose openTsRunConfirmModal backs
// the testsuite Re-run path below).

let resListPollTimer = null;

// Keyed "kind:id" since a testcase run and a testsuite run can share the
// same numeric id.
const resRowKey = (kind, id) => `${kind}:${id}`;

// Show + Filters + sort + page. Remembered per browser (see resSaveState) so
// coming back to the tab - or reloading - keeps the same view.
const RES_STATE_KEY = 'pi_fleet_results_state';
const RES_DEFAULT_STATE = {
  view: 'current', owner: '', device: '', kind: '', status: '', package: '', testcase: '',
  tags: [], date_from: '', date_to: '', sort: 'date', order: 'desc', page: 1, pageSize: 25,
};
let resState = { ...RES_DEFAULT_STATE };
try {
  const saved = JSON.parse(localStorage.getItem(RES_STATE_KEY) || 'null');
  if (saved && typeof saved === 'object') resState = { ...RES_DEFAULT_STATE, ...saved, tags: saved.tags || [] };
} catch { /* storage blocked or corrupt - defaults */ }

function resSaveState() {
  try { localStorage.setItem(RES_STATE_KEY, JSON.stringify(resState)); } catch { /* storage blocked */ }
}

let resItems = [];          // the rows on the current page
let resTotal = 0;
let resFacets = { owners: [], devices: [], tags: [], packages: [] };
let resShowAllTags = false;
const RES_POPULAR_TAGS = 12;

// Checked rows, kept across pages. Each value carries what the bulk actions
// need (source_id for Re-run, locked/status for Delete's warnings), from
// either a rendered row or the pager's "select all" (GET /results?ids_only).
const resSelected = new Map();

function resStopPolling() {
  resStopRunPolling();
  resStopListPolling();
  resStopLogPolling();
}

function resStopListPolling() {
  if (resListPollTimer) {
    clearTimeout(resListPollTimer);
    resListPollTimer = null;
  }
}

function showResListView() {
  resStopPolling();
  resDetailCurrent = null;
  resLogCurrent = null;
  document.getElementById('resDetailView').classList.add('hidden');
  document.getElementById('resLogView').classList.add('hidden');
  document.getElementById('resListView').classList.remove('hidden');
  resSyncControlsFromState();
  loadResults();
}

function showResDetailView() {
  resStopListPolling();
  resStopRunPolling();
  resStopLogPolling();
  resLogCurrent = null;
  document.getElementById('resListView').classList.add('hidden');
  document.getElementById('resLogView').classList.add('hidden');
  document.getElementById('resDetailView').classList.remove('hidden');
}

// --- query + load -----------------------------------------------------------

function resQueryParams({ paged = true } = {}) {
  const p = new URLSearchParams();
  const s = resState;
  p.set('view', s.view);
  for (const k of ['owner', 'device', 'kind', 'status', 'package', 'testcase']) {
    if (s[k]) p.set(k, s[k]);
  }
  if (s.tags.length) p.set('tags', s.tags.join(','));
  if (s.view === 'date') {
    if (s.date_from) p.set('date_from', s.date_from);
    if (s.date_to) p.set('date_to', s.date_to);
  }
  p.set('sort', s.sort);
  p.set('order', s.order);
  if (paged) {
    p.set('offset', String((s.page - 1) * s.pageSize));
    p.set('limit', String(s.pageSize));
  }
  return p;
}

let resLoadSeq = 0;
// What the last render drew - a poll tick that brings back the same page
// skips re-rendering, so it doesn't knock keyboard focus off a checkbox or
// chip every few seconds while a run is still going.
let resLastRenderSig = null;

async function loadResults() {
  const seq = ++resLoadSeq;
  resStopListPolling();
  try {
    const res = await apiFetch(`${API}/results?${resQueryParams()}`);
    if (!res.ok) return;
    const data = await res.json();
    if (seq !== resLoadSeq) return;   // a newer load (filter change) overtook this one
    const lastPage = Math.max(1, Math.ceil(data.total / resState.pageSize));
    if (resState.page > lastPage) {
      // Rows were deleted or a filter narrowed the set under the current page.
      resState.page = lastPage;
      resSaveState();
      loadResults();
      return;
    }
    const sig = JSON.stringify([data, resState]);
    resItems = data.items;
    resTotal = data.total;
    resFacets = data.facets;
    resItems.forEach(r => {
      const k = resRowKey(r.kind, r.id);
      if (resSelected.has(k)) resSelected.set(k, r);
    });
    if (sig !== resLastRenderSig) {
      resLastRenderSig = sig;
      renderResSidebar();
      renderResTable();
      renderResPager();
      resRenderBulkBar();
    }
    // Rows still running change status/pass/fail - keep them fresh while
    // the list is on screen.
    if (resItems.some(r => r.status === 'running')
        && !document.getElementById('resListView').classList.contains('hidden')) {
      resListPollTimer = setTimeout(loadResults, 5000);
    }
  } catch {
    // backend unreachable; keep whatever was last rendered
  }
}

// Any Show/Filter change: back to page 1, remember it, reload.
function resSetFilter(changes) {
  Object.assign(resState, changes, { page: 1 });
  resSaveState();
  resSyncControlsFromState();
  loadResults();
}

// --- sidebar ----------------------------------------------------------------

function resFillSelect(id, values, firstLabel, labelFn = v => v) {
  const el = document.getElementById(id);
  const current = resState[{ resOwner: 'owner', resDevice: 'device' }[id]];
  // Keep a chosen value listed even if nothing in this view has it any more,
  // so the select still shows what's actually being filtered on.
  const all = current && !values.includes(current) ? [current, ...values] : values;
  el.innerHTML = `<option value="">${firstLabel}</option>`
    + all.map(v => `<option value="${tcEsc(v)}">${tcEsc(labelFn(v))}</option>`).join('');
  el.value = current || '';
}

function renderResSidebar() {
  const running = resFacets.running || 0;
  const now = document.getElementById('resRunningNow');
  now.classList.toggle('hidden', !running);
  now.innerHTML = `<span class="res-live-dot" aria-hidden="true"></span>${running} running now`;
  resFillSelect('resOwner', resFacets.owners, 'All', o => `Owned by ${o}`);
  resFillSelect('resDevice', resFacets.devices, 'All Devices', d => (d === 'all' ? 'all (broadcast)' : d));

  const q = document.getElementById('resTagSearch').value.trim().toLowerCase();
  let tags = resFacets.tags.filter(t => !q || t.tag.toLowerCase().includes(q));
  if (!resShowAllTags && !q) tags = tags.slice(0, RES_POPULAR_TAGS);
  // A selected tag stays visible even when it isn't "popular".
  resState.tags.forEach(sel => {
    if (!tags.some(t => t.tag === sel)) tags.unshift({ tag: sel, count: 0 });
  });
  document.getElementById('resTagChips').innerHTML = tags.length
    ? tags.map(t => `
        <button type="button" class="res-tag${resState.tags.includes(t.tag) ? ' active' : ''}" data-tag="${tcEsc(t.tag)}"
                aria-pressed="${resState.tags.includes(t.tag)}" title="${tcEsc(t.tag)} - ${t.count} run${t.count === 1 ? '' : 's'}">${tcEsc(t.tag)}</button>`).join('')
    : '<span class="hint">no tags</span>';
  document.getElementById('resShowAllTags').textContent = resShowAllTags ? 'Show popular tags' : 'Show all tags';

  document.getElementById('resFrequentPackages').innerHTML = resFacets.packages.length
    ? resFacets.packages.map(p => `
        <button type="button" class="res-link res-frequent-item${resState.package.toLowerCase() === p.name.toLowerCase() ? ' active' : ''}"
                data-package="${tcEsc(p.name)}" title="${tcEsc(p.name)} - ${p.count} run${p.count === 1 ? '' : 's'}">
          ${tcEsc(p.name)} <span class="hint">${p.kind === 'testsuite' ? 'suite' : 'testcase'} · ${p.count}</span>
        </button>`).join('')
    : '<span class="hint">no runs yet</span>';
}

function resSyncControlsFromState() {
  const s = resState;
  document.getElementById('resView').value = s.view;
  document.getElementById('resDateRange').classList.toggle('hidden', s.view !== 'date');
  document.getElementById('resDateFrom').value = s.date_from;
  document.getElementById('resDateTo').value = s.date_to;
  document.getElementById('resKind').value = s.kind;
  document.getElementById('resStatus').value = s.status;
  const pkg = document.getElementById('resPackage');
  if (document.activeElement !== pkg) pkg.value = s.package;
  const tc = document.getElementById('resTestcase');
  if (document.activeElement !== tc) tc.value = s.testcase;
  document.getElementById('resPageSize').value = String(s.pageSize);
  document.querySelectorAll('.res-table th[data-sort]').forEach(th => {
    th.dataset.dir = th.dataset.sort === s.sort ? (s.order === 'asc' ? 'asc' : 'desc') : '';
    th.setAttribute('aria-sort', th.dataset.dir ? (th.dataset.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
  document.getElementById('resBulkStarBtn').textContent = s.view === 'starred' ? 'Unstar' : 'Star';
  document.getElementById('resBulkArchiveBtn').textContent = s.view === 'archived' ? 'Unarchive' : 'Archive';
}

// --- table ------------------------------------------------------------------

const RES_LOCK_SVG = (on) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="${on ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.5-2'}"/></svg>`;
const RES_STAR_SVG = (on) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/></svg>`;

// hh:mm:ss, or mm:ss under an hour - same as CDRouter's Time column.
function resDurationText(run) {
  if (run.duration_s === null || run.duration_s === undefined) return run.status === 'running' ? '…' : '';
  const t = Math.round(run.duration_s);
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  const p2 = n => String(n).padStart(2, '0');
  return hh ? `${p2(hh)}:${p2(mm)}:${p2(ss)}` : `${p2(mm)}:${p2(ss)}`;
}

function resDevicesHtml(devices) {
  if (!devices.length) return '<span class="hint">–</span>';
  const shown = devices.slice(0, 3).map(d => tcEsc(d === 'all' ? 'all' : d)).join(', ');
  return devices.length > 3 ? `${shown} <span class="hint" title="${tcEsc(devices.join(', '))}">+${devices.length - 3}</span>` : shown;
}

function renderResTable() {
  const body = document.getElementById('resTableBody');
  if (!resItems.length) {
    body.innerHTML = '<tr><td colspan="15" class="pi-log-empty">no results match</td></tr>';
    resSyncSelectAllCheckbox();
    return;
  }
  body.innerHTML = resItems.map(r => {
    const key = resRowKey(r.kind, r.id);
    const checked = resSelected.has(key);
    return `
    <tr class="${checked ? 'tc-row-selected' : ''}${r.archived ? ' res-archived' : ''}" data-kind="${r.kind}" data-id="${r.id}">
      <td class="tc-check-col"><input type="checkbox" class="res-row-check" ${checked ? 'checked' : ''} aria-label="Select ${r.kind} run #${r.id} (${tcEsc(r.name || '')})"></td>
      <td class="res-icon-col"><button type="button" class="icon-btn res-flag-btn${r.locked ? ' on' : ''}" data-flag="locked"
          title="${r.locked ? 'Locked - click to unlock' : 'Lock (prevents deletion)'}" aria-pressed="${r.locked}">${RES_LOCK_SVG(r.locked)}</button></td>
      <td class="res-icon-col"><button type="button" class="icon-btn res-flag-btn res-star${r.starred ? ' on' : ''}" data-flag="starred"
          title="${r.starred ? 'Unstar' : 'Star'}" aria-pressed="${r.starred}">${RES_STAR_SVG(r.starred)}</button></td>
      <td class="res-date">${formatVnDateTime(r.started_at)}</td>
      <td><button type="button" class="res-link res-open" title="Open ${r.kind} run #${r.id}">#${r.id}</button></td>
      <td class="res-package"><button type="button" class="res-link res-open">${tcEsc(r.name || '')}</button>${
        r.kind === 'testsuite' && r.testcase_count !== null ? ` <span class="hint">(${r.testcase_count})</span>` : ''}</td>
      <td>${r.kind === 'testsuite' ? 'Testsuite' : 'Testcase'}</td>
      <td class="res-devices">${resDevicesHtml(r.devices)}</td>
      <td><span class="cmd-status ${tcStatusClass(r.status)}">${r.status}</span></td>
      <td class="res-num">${r.passed}</td>
      <td class="res-num${r.failed ? ' res-fail' : ''}">${r.failed}</td>
      <td class="res-num">${resDurationText(r)}</td>
      <td>${tcEsc(r.owner || '–')}</td>
      <td class="res-tags">${r.tags.map(t => `<button type="button" class="res-tag res-tag-sm${resState.tags.includes(t) ? ' active' : ''}" data-tag="${tcEsc(t)}" title="Filter by this tag">${tcEsc(t)}</button>`).join('')}</td>
      <td class="capture-actions">
        <button type="button" class="icon-btn res-rerun-btn" title="Re-run">${RERUN_ICON_SVG}</button>
        <button type="button" class="icon-btn res-delete-btn" title="${r.locked ? 'Locked - unlock to delete' : 'Delete'}" ${r.locked ? 'disabled' : ''}>&#128465;</button>
      </td>
    </tr>`;
  }).join('');
  resSyncSelectAllCheckbox();
}

// One star/lock click: flips it on the server, then updates just that row.
async function resToggleFlag(kind, id, flag) {
  const r = resItems.find(x => x.kind === kind && x.id === id);
  if (!r) return;
  try {
    const res = await apiFetch(`${API}/results/${kind}/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [flag]: !r[flag] }),
    });
    if (!res.ok) { alert(`Failed to update: ${res.status} ${await res.text()}`); return; }
    const out = await res.json();
    Object.assign(r, { starred: out.starred, archived: out.archived, locked: out.locked });
    const sel = resSelected.get(resRowKey(kind, id));
    if (sel) sel.locked = out.locked;
    // Unstarring in Starred (or unlocking in Locked Only) drops it from view.
    if ((resState.view === 'starred' && flag === 'starred') || (resState.view === 'locked' && flag === 'locked')) {
      loadResults();
    } else {
      renderResTable();
    }
  } catch (err) {
    alert(`Failed to update: ${err.message}`);
  }
}

// --- pager ------------------------------------------------------------------

function renderResPager() {
  const { page, pageSize } = resState;
  const last = Math.max(1, Math.ceil(resTotal / pageSize));
  const from = resTotal ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(resTotal, page * pageSize);
  document.getElementById('resPagerSummary').textContent = `${from}-${to} of ${resTotal} result${resTotal === 1 ? '' : 's'}`;
  document.getElementById('resSelectAllMatching').textContent = resTotal ? `select all ${resTotal}` : 'select all';
  document.getElementById('resGotoPage').max = String(last);

  // A window of up to 5 page numbers around the current one.
  const start = Math.max(1, Math.min(page - 2, last - 4));
  const nums = [];
  for (let n = start; n <= Math.min(last, start + 4); n++) nums.push(n);
  const btn = (label, target, { current = false, disabled = false, aria = '' } = {}) =>
    `<button type="button" class="res-page-btn${current ? ' current' : ''}" data-page="${target}" ${disabled ? 'disabled' : ''}
             ${current ? 'aria-current="page"' : ''} ${aria ? `aria-label="${aria}"` : ''}>${label}</button>`;
  document.getElementById('resPagerNav').innerHTML = [
    btn('First', 1, { disabled: page === 1 }),
    btn('Previous', page - 1, { disabled: page === 1 }),
    ...nums.map(n => btn(String(n), n, { current: n === page, aria: `Page ${n}` })),
    btn('Next', page + 1, { disabled: page >= last }),
    btn('Last', last, { disabled: page >= last }),
  ].join('');
}

function resGoToPage(n) {
  const last = Math.max(1, Math.ceil(resTotal / resState.pageSize));
  const page = Math.min(last, Math.max(1, Math.floor(Number(n)) || 1));
  if (page === resState.page) return;
  resState.page = page;
  resSaveState();
  loadResults();
}

// --- selection --------------------------------------------------------------

function resPageKeys() {
  return resItems.map(r => resRowKey(r.kind, r.id));
}

function resSyncSelectAllCheckbox() {
  const all = document.getElementById('resSelectAll');
  const keys = resPageKeys();
  const selectedHere = keys.filter(k => resSelected.has(k)).length;
  all.checked = keys.length > 0 && selectedHere === keys.length;
  all.indeterminate = selectedHere > 0 && selectedHere < keys.length;
}

function resRenderBulkBar() {
  const n = resSelected.size;
  document.getElementById('resBulkCount').textContent = n ? `${n} selected` : 'none selected';
  ['resBulkRerunBtn', 'resBulkStarBtn', 'resBulkArchiveBtn', 'resBulkLockBtn', 'resBulkUnlockBtn', 'resBulkDeleteBtn']
    .forEach(id => { document.getElementById(id).disabled = n === 0; });
}

function resClearSelection() {
  resSelected.clear();
  renderResTable();
  resRenderBulkBar();
}

// Every run matching the current view + filters, across all pages.
async function resSelectAllMatching() {
  try {
    const res = await apiFetch(`${API}/results?${resQueryParams({ paged: false })}&ids_only=true`);
    if (!res.ok) return;
    const data = await res.json();
    data.keys.forEach(k => {
      const key = resRowKey(k.kind, k.id);
      if (!resSelected.has(key)) resSelected.set(key, k);
    });
    renderResTable();
    resRenderBulkBar();
  } catch {
    // transient; nothing selected
  }
}

// --- bulk actions -----------------------------------------------------------

async function resBulkPost(action) {
  const items = [...resSelected.values()].map(r => ({ kind: r.kind, id: r.id }));
  const res = await apiFetch(`${API}/results/bulk`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, items }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function resBulkFlag(action) {
  if (!resSelected.size) return;
  try {
    await resBulkPost(action);
    resClearSelection();
    loadResults();
  } catch (err) {
    alert(`Failed to ${action}: ${err.message}`);
  }
}

async function resBulkDelete() {
  const runs = [...resSelected.values()];
  if (!runs.length) return;
  const lockedN = runs.filter(r => r.locked).length;
  const runningN = runs.filter(r => r.status === 'running' && !r.locked).length;
  const deletable = runs.length - lockedN;
  if (!deletable) { alert('Every selected run is locked - unlock them first.'); return; }
  const msg = `Delete ${deletable} run${deletable === 1 ? '' : 's'}? This cannot be undone.`
    + (runningN ? `\n${runningN} still running will be stopped first.` : '')
    + (lockedN ? `\n${lockedN} locked run${lockedN === 1 ? '' : 's'} will be kept.` : '');
  if (!confirm(msg)) return;
  try {
    await resBulkPost('delete');
  } catch (err) {
    alert(`Failed to delete: ${err.message}`);
    return;
  }
  resClearSelection();
  loadResults();
}

// A fresh run of the testcase/testsuite behind each checked run, with its
// *current* saved configuration (same as pressing Run in Packages). Several
// runs of the same one collapse into a single new run.
async function resBulkRerun() {
  const runs = [...resSelected.values()];
  if (!runs.length) return;
  const uniq = xs => [...new Set(xs.filter(x => x !== null && x !== undefined))];
  const tcIds = uniq(runs.filter(r => r.kind === 'testcase').map(r => r.source_id));
  const suiteIds = uniq(runs.filter(r => r.kind === 'testsuite').map(r => r.source_id));
  const what = [
    tcIds.length ? `${tcIds.length} testcase${tcIds.length === 1 ? '' : 's'}` : null,
    suiteIds.length ? `${suiteIds.length} testsuite${suiteIds.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' and ');
  if (!what) return;
  if (!confirm(`Re-run ${what}?\nEach starts a new run with its current saved configuration.`)) return;
  const failed = [];
  let started = 0;
  if (tcIds.length) {
    try {
      started += (await tcBulkPost('run', { ids: tcIds }, 'Failed to start testcase runs')).length;
    } catch (err) {
      failed.push(err.message);
    }
  }
  for (const id of suiteIds) {
    try {
      const res = await apiFetch(`${API}/testsuites/${id}/run`, { method: 'POST' });
      if (!res.ok) throw new Error(`testsuite #${id}: ${res.status} ${await res.text()}`);
      started += 1;
    } catch (err) {
      failed.push(err.message);
    }
  }
  resClearSelection();
  // New runs are newest - jump to the first page sorted by date to show them.
  Object.assign(resState, { sort: 'date', order: 'desc', page: 1 });
  resSaveState();
  resSyncControlsFromState();
  loadResults();
  if (failed.length) alert(`Started ${started} run(s). Some could not be started:\n${failed.join('\n')}`);
}

async function resExportCsv() {
  try {
    const res = await apiFetch(`${API}/results/export.csv?${resQueryParams({ paged: false })}`);
    if (!res.ok) { alert(`Failed to export: ${res.status} ${await res.text()}`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'results.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Failed to export: ${err.message}`);
  }
}

// --- single-run actions (row buttons + detail view) ------------------------

// A row the list has shown (or "select all" fetched), for its source_id.
function resKnownRun(kind, id) {
  if (resRunSummary && resRunSummary.kind === kind && resRunSummary.id === id) return resRunSummary;
  return resItems.find(r => r.kind === kind && r.id === id) || resSelected.get(resRowKey(kind, id)) || null;
}

// Launches a fresh run of the same testcase/testsuite a past run belongs to
// (POST /testcases/{id}/run or /testsuites/{id}/run - the same endpoint the
// Packages tab's own Run button hits), then opens the new run in the detail
// view so its progress is immediately visible, same as starting it from
// there would.
//
// A testsuite goes through openTsRunConfirmModal (testsuites-tab.js) first -
// the suite may have been edited (testcases added/removed/reordered, or
// stop_on_failure flipped) since the run being repeated, so "rerun" here
// means "run its *current* configuration", not literally repeat what ran
// before. Worth confirming rather than assuming. A lone testcase has no such
// editable membership to drift, so it still runs immediately.
async function rerunResRun(kind, id) {
  const run = resKnownRun(kind, id);
  const sourceId = run ? run.source_id : null;
  if (sourceId === undefined || sourceId === null) return;
  if (kind === 'testsuite') {
    openTsRunConfirmModal(sourceId, (confirmedId) => resStartTestsuiteRun(confirmedId));
    return;
  }
  try {
    const res = await apiFetch(`${API}/testcases/${sourceId}/run`, { method: 'POST' });
    if (!res.ok) {
      alert(`Failed to start run: ${res.status} ${await res.text()}`);
      return;
    }
    const newRun = await res.json();
    await loadResults();
    openResDetail(kind, newRun.id);
  } catch (err) {
    alert(`Failed to start run: ${err.message}`);
  }
}

// Same as the testcase branch above, split out so it can be passed as
// openTsRunConfirmModal's onConfirm callback.
async function resStartTestsuiteRun(id) {
  try {
    const res = await apiFetch(`${API}/testsuites/${id}/run`, { method: 'POST' });
    if (!res.ok) {
      alert(`Failed to start run: ${res.status} ${await res.text()}`);
      return;
    }
    const newRun = await res.json();
    await loadResults();
    openResDetail('testsuite', newRun.id);
  } catch (err) {
    alert(`Failed to start run: ${err.message}`);
  }
}

function resRunPath(kind, id) {
  return kind === 'testsuite' ? `${API}/testsuites/runs/${id}` : `${API}/testcases/runs/${id}`;
}

// Deletes one run's history record. A testsuite run's delete only removes
// the suite run itself - the individual testcase runs it launched stay
// around (see DELETE /testsuites/runs/{id} on the backend), same as if
// those testcases had been run standalone. A locked run is refused (409).
async function deleteResRun(kind, id) {
  const label = kind === 'testsuite' ? 'testsuite run' : 'testcase run';
  if (!confirm(`Delete this ${label}? This can't be undone.`)) return;
  try {
    const res = await apiFetch(resRunPath(kind, id), { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(`Failed to delete: ${body.detail || res.status}`);
      return;
    }
  } catch {
    return;
  }
  resSelected.delete(resRowKey(kind, id));
  // Back out of the detail view if it was showing the run just deleted -
  // there's nothing left there to poll or display.
  if (resDetailCurrent && resDetailCurrent.kind === kind && resDetailCurrent.id === id) {
    location.hash = '#results';
  } else {
    loadResults();
  }
}

// --- one run: CDRouter-style result page ------------------------------------
// #results/<kind>/<id>. A sidebar to filter the run's tests (status, name
// search) and move around them (jump to a test, previous/next failure), a
// summary card (status, progress, PASS/FAIL/TIME, stop + re-run), and a
// paged tests table - a testsuite run's testcases, or a testcase run's step
// executions - all from GET /results/{kind}/{id}/tests (routers/Results.py).
// A live run polls every 2s and updates in place, which is what replaced the
// old Running tab.

// The run on screen, for the toolbar/sidebar actions. Its summary carries
// source_id (Re-run) and the star/archive/lock flags.
let resDetailCurrent = null;
let resRunSummary = null;
let resRunPollTimer = null;
const RES_RUN_DEFAULT = { status: 'all', q: '', page: 1, pageSize: 25 };
let resRunState = { ...RES_RUN_DEFAULT };
let resRunFailures = [];        // failed tests' seqs, in the filtered order
let resRunFocusSeq = null;      // the test Jump to / Prev / Next Failure landed on
// What the last render drew, split so a live tick that only moved the
// clocks patches those cells instead of rebuilding the table (which would
// reload every open Log and knock keyboard focus off the page).
let resRunLastSig = null;
let resRunRowsSig = null;
const resRunOpenLogs = new Set();   // seqs whose Log row is open

function resStopRunPolling() {
  if (resRunPollTimer) {
    clearTimeout(resRunPollTimer);
    resRunPollTimer = null;
  }
}

// Every way into a run's page - list rows, starting a run (openTsRunView /
// openLiveTestcaseRun), the run history popup - goes through the hash, so
// the run has its own link and Back returns to wherever you came from.
function openResDetail(kind, id) {
  const hash = `#results/${kind}/${id}`;
  if (location.hash === hash) resShowRun(kind, id);
  else location.hash = hash;
}

function resRunFromHash() {
  const m = location.hash.match(/^#results\/(testcase|testsuite)\/(\d+)$/);
  return m ? { kind: m[1], id: Number(m[2]) } : null;
}

async function resShowRun(kind, id) {
  const same = resDetailCurrent && resDetailCurrent.kind === kind && resDetailCurrent.id === id;
  if (!same) {
    resDetailCurrent = { kind, id };
    resRunSummary = null;
    resRunState = { ...RES_RUN_DEFAULT, pageSize: resRunState.pageSize };
    resRunFocusSeq = null;
    resRunLastSig = null;
    resRunRowsSig = null;
    resRunOpenLogs.clear();
    document.getElementById('resTestStatus').value = 'all';
    document.getElementById('resTestSearch').value = '';
    document.getElementById('resJumpTo').value = '';
    document.getElementById('resTestsBody').innerHTML = '<tr><td colspan="7" class="pi-log-empty">loading…</td></tr>';
    document.getElementById('resRunStopHost').innerHTML = '';
  }
  showResDetailView();
  await loadResRun();
}

async function loadResRun({ aroundSeq = null } = {}) {
  if (!resDetailCurrent) return;
  const { kind, id } = resDetailCurrent;
  resStopRunPolling();
  const p = new URLSearchParams({
    status: resRunState.status, q: resRunState.q,
    offset: String((resRunState.page - 1) * resRunState.pageSize), limit: String(resRunState.pageSize),
  });
  if (aroundSeq !== null) p.set('around_seq', String(aroundSeq));
  try {
    const res = await apiFetch(`${API}/results/${kind}/${id}/tests?${p}`);
    if (!resDetailCurrent || resDetailCurrent.kind !== kind || resDetailCurrent.id !== id) return;
    if (res.status === 404) {
      resRenderRunGone();
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    resRunState.page = Math.floor(data.offset / resRunState.pageSize) + 1;
    resRunSummary = data.summary;
    resRunFailures = data.failure_seqs;
    // Same skip-if-unchanged as the list, so a poll tick doesn't knock
    // focus off a control or collapse what's being read.
    const sig = JSON.stringify([data, resRunState, resRunFocusSeq]);
    if (sig !== resRunLastSig) {
      resRunLastSig = sig;
      const rowsSig = JSON.stringify([
        data.items.map(t => [t.seq, t.status, t.name, t.description, t.run_id, t.error]),
        data.total, data.summary.status, resRunState, resRunFocusSeq,
      ]);
      renderResRunSidebar(data);
      renderResRunSummary(data.summary);
      if (rowsSig !== resRunRowsSig) {
        resRunRowsSig = rowsSig;
        renderResTests(data);
        renderResTestsPager(data);
      } else {
        resPatchTestTimes(data);
      }
    }
    resRefreshOpenLogs(data);
    tcRenderStopControls(document.getElementById('resRunStopHost'), kind, data.summary);
    if (data.summary.status === 'running' && !document.getElementById('resDetailView').classList.contains('hidden')) {
      resRunPollTimer = setTimeout(() => loadResRun(), 2000);
    }
  } catch {
    // transient; the next tick (or a Refresh) retries
    if (resRunSummary && resRunSummary.status === 'running') resRunPollTimer = setTimeout(() => loadResRun(), 4000);
  }
}

function resRenderRunGone() {
  document.getElementById('resRunTitle').textContent = `#${resDetailCurrent.id}`;
  document.getElementById('resRunStatusBig').textContent = 'NOT FOUND';
  document.getElementById('resRunMessage').textContent = 'This run was deleted.';
  document.getElementById('resTestsBody').innerHTML = '<tr><td colspan="7" class="pi-log-empty">nothing to show</td></tr>';
}

// --- sidebar ----------------------------------------------------------------

function renderResRunSidebar(data) {
  const s = data.summary;
  document.getElementById('resRunTitle').textContent = `#${s.id}`;
  document.getElementById('resRunKind').textContent = `${s.kind === 'testsuite' ? 'Testsuite' : 'Testcase'} run · ${formatVnDateTime(s.started_at)}`;
  const flag = (id, on, onTitle, offTitle, svg) => {
    const b = document.getElementById(id);
    b.innerHTML = svg;
    b.classList.toggle('on', on);
    b.title = on ? onTitle : offTitle;
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(on));
  };
  flag('resRunStarBtn', s.starred, 'Starred - click to unstar', 'Star this result', RES_STAR_SVG(s.starred));
  flag('resRunArchiveBtn', s.archived, 'Archived - click to unarchive', 'Archive this result', RES_ARCHIVE_SVG);
  flag('resRunLockBtn', s.locked, 'Locked - click to unlock', 'Lock this result', RES_LOCK_SVG(s.locked));
  document.getElementById('resRunArchiveLink').textContent = s.archived ? 'Unarchive this Result' : 'Archive this Result';
  document.getElementById('resRunLockLink').textContent = s.locked ? 'Unlock this Result' : 'Lock this Result...';
  const del = document.getElementById('resRunDeleteLink');
  del.disabled = s.locked;
  del.title = s.locked ? 'Locked - unlock it to delete' : '';
  document.getElementById('resRunPackageLink').textContent = s.name;
  document.getElementById('resJumpList').innerHTML = data.names.map(n => `<option value="${tcEsc(n)}"></option>`).join('');
  document.getElementById('resPrevFailBtn').disabled = !data.failure_seqs.length;
  document.getElementById('resNextFailBtn').disabled = !data.failure_seqs.length;
}

// --- summary + info cards ---------------------------------------------------

const RES_STATUS_WORD = {
  running: 'RUNNING', passed: 'COMPLETED', failed: 'COMPLETED', stopped: 'STOPPED',
};

function resRunMessage(s) {
  const what = s.kind === 'testsuite' ? 'testsuite' : 'testcase';
  if (s.status === 'running') {
    if (s.stop_requested) return `Stopping${s.stop_requested === 'now' ? '' : ` (${s.stop_requested.replace(/_/g, ' ')})`}…`;
    if (!s.live) return `This ${what} run lost its runner (the backend restarted) - stop it to close it out.`;
    return s.current ? `Now running ${s.current}` : `The ${what} is starting…`;
  }
  if (s.status === 'stopped') return `The ${what} was stopped before it finished.`;
  const failed = s.counts.failed || 0;
  return failed
    ? `The ${what} completed with ${failed} failure${failed === 1 ? '' : 's'}.`
    : `The ${what} completed successfully.`;
}

function renderResRunSummary(s) {
  const big = document.getElementById('resRunStatusBig');
  big.textContent = RES_STATUS_WORD[s.status] || s.status.toUpperCase();
  big.className = `res-run-status ${tcStatusClass(s.status)}`;
  document.getElementById('resRunProgress').textContent = `${s.progress}%`;
  const bar = document.getElementById('resRunProgressBar');
  bar.setAttribute('aria-valuenow', String(s.progress));
  bar.querySelector('span').style.width = `${s.progress}%`;
  bar.classList.toggle('done', s.status !== 'running');
  document.getElementById('resRunMessage').textContent = resRunMessage(s);
  document.getElementById('resRunPass').textContent = s.counts.passed || 0;
  document.getElementById('resRunFail').textContent = s.counts.failed || 0;
  document.getElementById('resRunTime').textContent = resDurationText(s) || '–';
  const rerun = document.getElementById('resRunRerunBtn');
  rerun.disabled = !s.source_exists;
  rerun.title = s.source_exists ? `Start a new run of ${s.name}` : `${s.name} no longer exists`;

  const unit = s.kind === 'testsuite'
    ? `${s.testcase_count} testcase${s.testcase_count === 1 ? '' : 's'}`
    : `${s.step_count} step${s.step_count === 1 ? '' : 's'}${s.repeat_count > 1 ? ` × ${s.repeat_count} passes` : ''}`;
  document.getElementById('resRunInfoPackage').innerHTML = `
    <button type="button" class="res-link" id="resRunInfoPackageLink">${tcEsc(s.name)}</button> - ${unit},
    ${s.stop_on_failure ? 'stops on the first failure' : 'runs normally'}
    ${s.description ? `<div class="hint">${tcEsc(s.description)}</div>` : ''}
    ${s.suite_run_id ? `<div class="hint">part of <button type="button" class="res-link" data-suite-run="${s.suite_run_id}">testsuite run #${s.suite_run_id}</button></div>` : ''}`;
  document.getElementById('resRunInfoDevice').innerHTML = s.devices.length
    ? s.devices.map(d => tcEsc(d === 'all' ? 'all Pis (broadcast)' : d)).join(', ') : '<span class="hint">–</span>';
  document.getElementById('resRunInfoOwner').textContent = s.owner || '–';
  document.getElementById('resRunInfoStarted').innerHTML = `${formatVnDateTime(s.started_at)}${
    s.completed_at ? `<div class="hint">ended ${formatVnDateTime(s.completed_at)}</div>` : ''}`;
  document.getElementById('resRunInfoTags').innerHTML = s.tags.length
    ? s.tags.map(t => `<button type="button" class="res-tag res-tag-sm" data-tag="${tcEsc(t)}" title="Show every result tagged ${tcEsc(t)}">${tcEsc(t)}</button>`).join('')
    : '<span class="hint">–</span>';
}

// --- tests table ------------------------------------------------------------

const RES_TEST_ICON = {
  passed: '<span class="res-ti res-ti-pass" title="passed">&#10003;</span>',
  failed: '<span class="res-ti res-ti-fail" title="failed">&#10007;</span>',
  timeout: '<span class="res-ti res-ti-fail" title="timeout">&#9201;</span>',
  running: '<span class="res-ti res-ti-run" title="running"><span class="wifi-scan-spinner"></span></span>',
  pending: '<span class="res-ti res-ti-dim" title="pending">&#9675;</span>',
  skipped: '<span class="res-ti res-ti-dim" title="skipped">&#8631;</span>',
  stopped: '<span class="res-ti res-ti-stop" title="stopped">&#9632;</span>',
};

function resTestTime(t) {
  if (t.duration_s === null || t.duration_s === undefined) return t.status === 'running' ? '…' : '';
  return resDurationText({ duration_s: t.duration_s, status: t.status });
}

function renderResTests(data) {
  const body = document.getElementById('resTestsBody');
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="7" class="pi-log-empty">${
      data.summary.total ? 'no tests match the filter' : (data.summary.status === 'running' ? 'starting…' : 'nothing ran')}</td></tr>`;
    return;
  }
  const kind = data.summary.kind;
  body.innerHTML = data.items.map(t => {
    const hasDetails = kind === 'testcase' ? t.status !== 'pending' : !!t.run_id;
    const open = resRunOpenLogs.has(t.seq);
    return `
    <tr class="res-test-row${t.seq === resRunFocusSeq ? ' res-test-focus' : ''}${t.status === 'running' ? ' res-test-running' : ''}" data-seq="${t.seq}">
      <td class="res-icon-col">${RES_TEST_ICON[t.status] || tcEsc(t.status)}</td>
      <td class="res-num">${resTestTime(t)}</td>
      <td class="res-test-name">${kind === 'testsuite' && t.run_id
        ? `<button type="button" class="res-link" data-open-run="${t.run_id}" title="Open this testcase run">${tcEsc(t.name)}</button>`
        : tcEsc(t.name)}</td>
      <td class="res-test-desc">${tcEsc(t.description)}${t.error ? ` <span class="res-test-error">${tcEsc(t.error)}</span>` : ''}</td>
      <td class="res-log-cell">${t.status === 'pending'
        ? '<span class="hint">–</span>'
        : `<button type="button" class="res-link res-log-open" title="This test's syslog">log</button>`}</td>
      <td class="res-log-cell">${hasDetails
        ? `<button type="button" class="res-link res-log-btn" aria-expanded="${open}" title="Step results, checks and per-Pi output">${open ? 'hide' : 'details'}</button>`
        : '<span class="hint">–</span>'}</td>
      <td class="res-num">${t.seq}</td>
    </tr>
    ${open ? `<tr class="res-log-row" data-log-for="${t.seq}"><td colspan="7"><div class="res-log-body"></div></td></tr>` : ''}`;
  }).join('');
  body.querySelectorAll('.res-log-row').forEach(row => {
    const t = data.items.find(x => x.seq === Number(row.dataset.logFor));
    if (t) resFillLog(row.querySelector('.res-log-body'), t, data.summary);
  });
  const focus = body.querySelector('.res-test-focus');
  if (focus) focus.scrollIntoView({ block: 'nearest' });
}

// The Log column's "details": a suite's testcase shows that testcase run's
// full step detail (the same renderer the old views used); a testcase's
// step shows that one step's checks and per-Pi results. "log" opens the
// test's syslog page instead (see "one test's log" below).
async function resFillLog(el, t, summary) {
  if (!el.childElementCount) el.innerHTML = '<div class="pi-log-empty">loading…</div>';
  if (summary.kind === 'testsuite') {
    await tcRenderRunInto(el, t.run_id, { forceCollapsed: summary.status !== 'running' });
    return;
  }
  const page = await tcFetchRunSteps(summary.id, t.seq - 1, 1).catch(() => null);
  if (!page || !page.items.length) {
    el.innerHTML = '<div class="pi-log-empty">failed to load</div>';
    return;
  }
  // Opened on purpose from the Log column, so the step starts expanded -
  // tcRenderRunSteps only expands by default for a run that's "running".
  tcRenderRunSteps(el, { id: summary.id, status: 'running', results: page.items }, false, t.seq - 1);
}

// Live tick with the same rows: just move the clocks.
function resPatchTestTimes(data) {
  data.items.forEach(t => {
    const cell = document.querySelector(`#resTestsBody tr[data-seq="${t.seq}"] > td:nth-child(2)`);
    if (cell) cell.textContent = resTestTime(t);
  });
}

// An open Log on a test that's still going keeps following it.
// tcRenderRunInto skips the redraw when nothing changed.
function resRefreshOpenLogs(data) {
  data.items.forEach(t => {
    if (t.status !== 'running' || !resRunOpenLogs.has(t.seq)) return;
    const el = document.querySelector(`#resTestsBody tr[data-log-for="${t.seq}"] .res-log-body`);
    if (el && el.childElementCount) resFillLog(el, t, data.summary);
  });
}

function renderResTestsPager(data) {
  const { page, pageSize } = resRunState;
  const total = data.total;
  const last = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  document.getElementById('resTestsSummary').textContent =
    `${from}-${Math.min(total, page * pageSize)} of ${total} test${total === 1 ? '' : 's'}`
    + (total !== data.summary.total ? ` (of ${data.summary.total})` : '');
  document.getElementById('resTestsGoto').max = String(last);
  document.getElementById('resTestsPageSize').value = String(pageSize);
  const start = Math.max(1, Math.min(page - 2, last - 4));
  const nums = [];
  for (let n = start; n <= Math.min(last, start + 4); n++) nums.push(n);
  const btn = (label, target, { current = false, disabled = false } = {}) =>
    `<button type="button" class="res-page-btn${current ? ' current' : ''}" data-page="${target}" ${disabled ? 'disabled' : ''} ${current ? 'aria-current="page"' : ''}>${label}</button>`;
  document.getElementById('resTestsNav').innerHTML = [
    btn('First', 1, { disabled: page === 1 }),
    btn('Previous', page - 1, { disabled: page === 1 }),
    ...nums.map(n => btn(String(n), n, { current: n === page })),
    btn('Next', page + 1, { disabled: page >= last }),
    btn('Last', last, { disabled: page >= last }),
  ].join('');
}

function resRunSetFilter(changes) {
  Object.assign(resRunState, changes, { page: 1 });
  resRunFocusSeq = null;
  loadResRun();
}

function resRunGoToPage(n) {
  const page = Math.max(1, Math.floor(Number(n)) || 1);
  if (page === resRunState.page) return;
  resRunState.page = page;
  loadResRun();
}

// --- test navigation --------------------------------------------------------

function resRunGoToSeq(seq) {
  resRunFocusSeq = seq;
  loadResRun({ aroundSeq: seq });
}

function resRunStepFailure(dir) {
  if (!resRunFailures.length) return;
  const cur = resRunFocusSeq;
  let target;
  if (cur === null) {
    target = dir > 0 ? resRunFailures[0] : resRunFailures[resRunFailures.length - 1];
  } else if (dir > 0) {
    target = resRunFailures.find(s => s > cur) ?? resRunFailures[0];
  } else {
    target = [...resRunFailures].reverse().find(s => s < cur) ?? resRunFailures[resRunFailures.length - 1];
  }
  resRunGoToSeq(target);
}

// Jump to: the first test with that exact name (or the first that contains
// it). A status filter that would hide it is cleared first.
async function resRunJumpTo(name) {
  name = name.trim();
  if (!name || !resDetailCurrent) return;
  const { kind, id } = resDetailCurrent;
  try {
    const res = await apiFetch(`${API}/results/${kind}/${id}/tests?${new URLSearchParams({ q: name, limit: '0' })}`);
    if (!res.ok) return;
    const data = await res.json();
    const hit = data.items.find(t => t.name.toLowerCase() === name.toLowerCase()) || data.items[0];
    if (!hit) { alert(`No test named "${name}" in this run.`); return; }
    const visible = data.items.length && (resRunState.status === 'all' || resRunState.status === hit.status);
    if (!visible || resRunState.q) {
      Object.assign(resRunState, { status: 'all', q: '' });
      document.getElementById('resTestStatus').value = 'all';
      document.getElementById('resTestSearch').value = '';
    }
    resRunGoToSeq(hit.seq);
  } catch {
    // transient
  }
}

// --- actions ----------------------------------------------------------------

const RES_ARCHIVE_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/></svg>';

async function resRunToggleFlag(flag) {
  if (!resRunSummary) return;
  const { kind, id } = resRunSummary;
  try {
    const res = await apiFetch(`${API}/results/${kind}/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [flag]: !resRunSummary[flag] }),
    });
    if (!res.ok) { alert(`Failed to update: ${res.status} ${await res.text()}`); return; }
    resRunLastSig = null;
    resRunRowsSig = null;
    loadResRun();
  } catch (err) {
    alert(`Failed to update: ${err.message}`);
  }
}

async function resRunExportCsv() {
  if (!resDetailCurrent) return;
  const { kind, id } = resDetailCurrent;
  try {
    const res = await apiFetch(`${API}/results/${kind}/${id}/tests.csv`);
    if (!res.ok) { alert(`Failed to export: ${res.status} ${await res.text()}`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'tests.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Failed to export: ${err.message}`);
  }
}

// --- one test's log: CDRouter-style test log page ----------------------------
// #results/<kind>/<id>/tests/<seq>. The syslog the test's Pis streamed while
// it ran (captured per run on the backend - service/run_logs.py), one
// collapsible SECTION per step with its line count, and PASS/FAIL lines for
// each Pi result and the step. Filter box, line-type and Pi filters, prev/
// next test, download. A live test is followed every 2s.

let resLogCurrent = null;     // { kind, id, seq }
let resLogData = null;
let resLogPollTimer = null;
let resLogSig = null;
const resLogCollapsed = new Set();   // section line numbers folded shut

function resStopLogPolling() {
  if (resLogPollTimer) {
    clearTimeout(resLogPollTimer);
    resLogPollTimer = null;
  }
}

function resLogFromHash() {
  const m = location.hash.match(/^#results\/(testcase|testsuite)\/(\d+)\/tests\/(\d+)$/);
  return m ? { kind: m[1], id: Number(m[2]), seq: Number(m[3]) } : null;
}

function openResTestLog(kind, id, seq) {
  location.hash = `#results/${kind}/${id}/tests/${seq}`;
}

function showResLogView() {
  resStopListPolling();
  resStopRunPolling();
  document.getElementById('resListView').classList.add('hidden');
  document.getElementById('resDetailView').classList.add('hidden');
  document.getElementById('resLogView').classList.remove('hidden');
}

async function resShowTestLog(kind, id, seq) {
  const same = resLogCurrent && resLogCurrent.kind === kind && resLogCurrent.id === id && resLogCurrent.seq === seq;
  if (!same) {
    resLogCurrent = { kind, id, seq };
    resLogData = null;
    resLogSig = null;
    resLogCollapsed.clear();
    document.getElementById('resLogLines').innerHTML = '<div class="pi-log-empty">Loading… please wait while the log loads.</div>';
    document.getElementById('resLogTitle').textContent = '';
    document.getElementById('resLogMeta').textContent = '';
  }
  showResLogView();
  await loadResTestLog();
}

async function loadResTestLog() {
  if (!resLogCurrent) return;
  const { kind, id, seq } = resLogCurrent;
  resStopLogPolling();
  try {
    const res = await apiFetch(`${API}/results/${kind}/${id}/tests/${seq}/log`);
    if (!resLogCurrent || resLogCurrent.kind !== kind || resLogCurrent.id !== id || resLogCurrent.seq !== seq) return;
    if (!res.ok) {
      document.getElementById('resLogLines').innerHTML = `<div class="pi-log-empty">${res.status === 404 ? 'This test or run no longer exists.' : 'Failed to load the log.'}</div>`;
      return;
    }
    const data = await res.json();
    resLogData = data;
    const sig = JSON.stringify([data.test.status, data.test.duration_s, data.lines.length, data.lines[data.lines.length - 1]]);
    if (sig !== resLogSig) {
      resLogSig = sig;
      renderResLogHead(data);
      renderResLogLines(data);
    }
    if (data.running && !document.getElementById('resLogView').classList.contains('hidden')) {
      resLogPollTimer = setTimeout(loadResTestLog, 2000);
    }
  } catch {
    if (resLogData && resLogData.running) resLogPollTimer = setTimeout(loadResTestLog, 4000);
  }
}

function renderResLogHead(data) {
  const t = data.test;
  const head = document.getElementById('resLogHead');
  head.className = `panel res-log-head res-log-${t.status === 'timeout' ? 'failed' : t.status}`;
  document.getElementById('resLogTitle').textContent = t.name;
  document.getElementById('resLogRunLink').textContent = `${data.kind === 'testsuite' ? 'testsuite' : 'testcase'} run #${data.run_id}`;
  const time = resTestTime(t);
  document.getElementById('resLogMeta').innerHTML =
    `Test result: <strong>${tcEsc(t.status)}</strong>${time ? ` (${time})` : ''} · test ${data.seq} of ${data.total} · ${tcEsc(data.run_name)}`;
  const nav = { first: 1, prev: data.seq - 1, next: data.seq + 1, last: data.total };
  document.querySelectorAll('#resLogView [data-nav]').forEach(b => {
    const target = nav[b.dataset.nav];
    b.dataset.seq = String(target);
    b.disabled = target < 1 || target > data.total || target === data.seq;
  });
  const piSel = document.getElementById('resLogPi');
  const chosen = piSel.value;
  piSel.innerHTML = '<option value="">All Pis</option>' + data.pis.map(p => `<option value="${tcEsc(p)}">${tcEsc(p)}</option>`).join('');
  piSel.value = data.pis.includes(chosen) ? chosen : '';
}

// 2026-10-22 15:40:27.123, in the app's display time zone.
function resLogTime(iso) {
  if (!iso) return '';
  const d = parseApiDate(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: VN_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const RES_LOG_TAG = {
  section: () => '&#8597;SECTION',
  syslog: (ln) => `SYSLOG(${tcEsc(ln.src || '?')})`,
  pass: () => '',
  fail: () => '',
  info: () => 'INFO',
};

function renderResLogLines(data) {
  const box = document.getElementById('resLogLines');
  const follow = document.getElementById('resLogFollow').checked;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  let n = 0;
  const out = data.header.map(h => `<div class="ll ll-header"><span class="ln">${++n}</span><span class="lx">${tcEsc(h)}</span></div>`);
  let section = null;
  data.lines.forEach(ln => {
    n += 1;
    if (ln.kind === 'section') section = n;
    const cls = [`ll`, `ll-${ln.kind}`, `ll-lv-${ln.level}`];
    const inSection = ln.kind !== 'section' && section !== null;
    if (inSection && resLogCollapsed.has(section)) cls.push('ll-folded');
    out.push(`<div class="${cls.join(' ')}" data-n="${n}" ${inSection ? `data-section="${section}"` : ''} data-kind="${ln.kind}" data-level="${ln.level}" data-src="${tcEsc(ln.src || '')}">`
      + `<span class="ln">${n}</span><span class="lt">${resLogTime(ln.t)}</span>`
      + (ln.kind === 'section'
        ? `<button type="button" class="ll-fold" aria-expanded="${!resLogCollapsed.has(n)}" title="Fold this section">${resLogCollapsed.has(n) ? '&#9656;' : '&#9662;'}</button>`
        : '')
      + `<span class="lk">${RES_LOG_TAG[ln.kind] ? RES_LOG_TAG[ln.kind](ln) : ''}</span>`
      + `<span class="lx">${tcEsc(ln.text)}</span>`
      + (ln.kind === 'section' ? `<span class="lc">${ln.count}</span>` : '')
      + '</div>');
  });
  if (!data.lines.length) out.push('<div class="pi-log-empty">No log lines.</div>');
  else if (!data.lines.some(l => l.kind === 'syslog')) {
    out.push(`<div class="ll ll-note"><span class="ln"></span><span class="lx">No syslog was captured for this test${
      data.running ? ' yet' : ' - its Pis may have been offline, or it ran before syslog capture existed'}.</span></div>`);
  }
  box.innerHTML = out.join('');
  applyResLogFilters();
  if (data.running && follow && (atBottom || !resLogSig)) box.scrollTop = box.scrollHeight;
}

function applyResLogFilters() {
  const q = document.getElementById('resLogFilter').value.trim().toLowerCase();
  const kind = document.getElementById('resLogKind').value;
  const pi = document.getElementById('resLogPi').value;
  document.querySelectorAll('#resLogLines .ll[data-kind]').forEach(el => {
    const k = el.dataset.kind;
    let show = true;
    if (kind === 'syslog') show = k === 'syslog' || k === 'section';
    else if (kind === 'passfail') show = k === 'pass' || k === 'fail' || k === 'section';
    else if (kind === 'problems') show = el.dataset.level === 'error' || el.dataset.level === 'warning' || k === 'section';
    if (show && pi && k !== 'section') show = el.dataset.src === pi;
    if (show && q && k !== 'section') show = el.textContent.toLowerCase().includes(q);
    el.classList.toggle('ll-filtered', !show);
  });
}

function resLogToggleSection(n) {
  const open = !resLogCollapsed.has(n);
  if (open) resLogCollapsed.add(n); else resLogCollapsed.delete(n);
  document.querySelectorAll(`#resLogLines .ll[data-section="${n}"]`).forEach(el => el.classList.toggle('ll-folded', open));
  const btn = document.querySelector(`#resLogLines .ll[data-n="${n}"] .ll-fold`);
  if (btn) {
    btn.innerHTML = open ? '&#9656;' : '&#9662;';
    btn.setAttribute('aria-expanded', String(!open));
  }
}

async function resLogDownload() {
  if (!resLogCurrent) return;
  const { kind, id, seq } = resLogCurrent;
  try {
    const res = await apiFetch(`${API}/results/${kind}/${id}/tests/${seq}/log.txt`);
    if (!res.ok) { alert(`Failed to download: ${res.status}`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'test.log';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Failed to download: ${err.message}`);
  }
}

// --- wiring ---------------------------------------------------------------

const resById = (id) => document.getElementById(id);

// Show
resById('resOwner').addEventListener('change', (e) => resSetFilter({ owner: e.target.value }));
resById('resView').addEventListener('change', (e) => resSetFilter({ view: e.target.value }));
resById('resDateFrom').addEventListener('change', (e) => resSetFilter({ date_from: e.target.value }));
resById('resDateTo').addEventListener('change', (e) => resSetFilter({ date_to: e.target.value }));

// Filters
resById('resDevice').addEventListener('change', (e) => resSetFilter({ device: e.target.value }));
resById('resKind').addEventListener('change', (e) => resSetFilter({ kind: e.target.value }));
resById('resStatus').addEventListener('change', (e) => resSetFilter({ status: e.target.value }));
resById('resPackage').addEventListener('input', debounce((e) => resSetFilter({ package: e.target.value.trim() }), 300));
resById('resTestcase').addEventListener('input', debounce((e) => resSetFilter({ testcase: e.target.value.trim() }), 300));
resById('resClearFilters').addEventListener('click', () => {
  resById('resTagSearch').value = '';
  resSetFilter({ owner: '', device: '', kind: '', status: '', package: '', testcase: '', tags: [], date_from: '', date_to: '' });
});

// Tags: the sidebar chips and the table's own tag chips both toggle a filter.
function resToggleTag(tag) {
  const tags = resState.tags.includes(tag) ? resState.tags.filter(t => t !== tag) : [...resState.tags, tag];
  resSetFilter({ tags });
}
resById('resTagChips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-tag]');
  if (chip) resToggleTag(chip.dataset.tag);
});
resById('resTagSearch').addEventListener('input', debounce(renderResSidebar, 150));
resById('resShowAllTags').addEventListener('click', () => { resShowAllTags = !resShowAllTags; renderResSidebar(); });
resById('resClearTags').addEventListener('click', () => resSetFilter({ tags: [] }));
resById('resFrequentPackages').addEventListener('click', (e) => {
  const item = e.target.closest('[data-package]');
  if (!item) return;
  const name = item.dataset.package;
  resSetFilter({ package: resState.package.toLowerCase() === name.toLowerCase() ? '' : name });
});

// Table (delegated - rows are re-rendered on every load)
resById('resTableBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-kind]');
  if (!tr) return;
  const kind = tr.dataset.kind;
  const id = Number(tr.dataset.id);
  if (e.target.classList.contains('res-row-check')) {
    const key = resRowKey(kind, id);
    if (e.target.checked) resSelected.set(key, resKnownRun(kind, id) || { kind, id });
    else resSelected.delete(key);
    tr.classList.toggle('tc-row-selected', e.target.checked);
    resSyncSelectAllCheckbox();
    resRenderBulkBar();
    return;
  }
  const flagBtn = e.target.closest('.res-flag-btn');
  if (flagBtn) { resToggleFlag(kind, id, flagBtn.dataset.flag); return; }
  const tagBtn = e.target.closest('[data-tag]');
  if (tagBtn) { resToggleTag(tagBtn.dataset.tag); return; }
  if (e.target.closest('.res-open')) { openResDetail(kind, id); return; }
  if (e.target.closest('.res-rerun-btn')) { rerunResRun(kind, id); return; }
  if (e.target.closest('.res-delete-btn')) deleteResRun(kind, id);
});
resById('resSelectAll').addEventListener('change', (e) => {
  resItems.forEach(r => {
    const key = resRowKey(r.kind, r.id);
    if (e.target.checked) resSelected.set(key, r); else resSelected.delete(key);
  });
  renderResTable();
  resRenderBulkBar();
});
document.querySelectorAll('.res-table th[data-sort]').forEach(th => {
  th.tabIndex = 0;
  const sortBy = () => {
    const sort = th.dataset.sort;
    // Same column flips direction; a new column starts descending for
    // date/time (newest/longest first), ascending for text.
    const order = resState.sort === sort
      ? (resState.order === 'asc' ? 'desc' : 'asc')
      : (['date', 'time', 'id'].includes(sort) ? 'desc' : 'asc');
    resSetFilter({ sort, order });
  };
  th.addEventListener('click', sortBy);
  th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(); } });
});

// Toolbar
resById('resBulkRerunBtn').addEventListener('click', resBulkRerun);
resById('resBulkStarBtn').addEventListener('click', () => resBulkFlag(resState.view === 'starred' ? 'unstar' : 'star'));
resById('resBulkArchiveBtn').addEventListener('click', () => resBulkFlag(resState.view === 'archived' ? 'unarchive' : 'archive'));
resById('resBulkLockBtn').addEventListener('click', () => resBulkFlag('lock'));
resById('resBulkUnlockBtn').addEventListener('click', () => resBulkFlag('unlock'));
resById('resBulkDeleteBtn').addEventListener('click', resBulkDelete);
resById('resExportBtn').addEventListener('click', resExportCsv);
resById('resRefreshBtn').addEventListener('click', loadResults);

// Pager
resById('resPagerNav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-page]');
  if (b && !b.disabled) resGoToPage(b.dataset.page);
});
resById('resGotoPage').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { resGoToPage(e.target.value); e.target.value = ''; }
});
resById('resPageSize').addEventListener('change', (e) => resSetFilter({ pageSize: Number(e.target.value) || 25 }));
resById('resExportLink').addEventListener('click', resExportCsv);
resById('resSelectAllMatching').addEventListener('click', resSelectAllMatching);

// Result page
resById('resTestStatus').addEventListener('change', (e) => resRunSetFilter({ status: e.target.value }));
resById('resTestSearch').addEventListener('input', debounce((e) => resRunSetFilter({ q: e.target.value.trim() }), 300));
resById('resJumpTo').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); resRunJumpTo(e.target.value); }
});
// Picking a suggestion from the datalist fires "change" without an Enter.
resById('resJumpTo').addEventListener('change', (e) => resRunJumpTo(e.target.value));
resById('resPrevFailBtn').addEventListener('click', () => resRunStepFailure(-1));
resById('resNextFailBtn').addEventListener('click', () => resRunStepFailure(1));
document.querySelectorAll('#resDetailView .res-run-flag').forEach(b => {
  b.addEventListener('click', () => resRunToggleFlag(b.dataset.flag));
});
resById('resRunArchiveLink').addEventListener('click', () => resRunToggleFlag('archived'));
resById('resRunLockLink').addEventListener('click', () => resRunToggleFlag('locked'));
resById('resRunDeleteLink').addEventListener('click', () => {
  if (resDetailCurrent) deleteResRun(resDetailCurrent.kind, resDetailCurrent.id);
});
resById('resRunExportLink').addEventListener('click', resRunExportCsv);
resById('resRunBackLink').addEventListener('click', () => { location.hash = '#results'; });
resById('resRunRerunBtn').addEventListener('click', () => {
  if (resDetailCurrent) rerunResRun(resDetailCurrent.kind, resDetailCurrent.id);
});

// Back to the list, filtered to every run of this package / with this tag.
function resListFilteredBy(changes) {
  resById('resTagSearch').value = '';
  Object.assign(resState, {
    view: 'current', owner: '', device: '', kind: '', status: '', package: '', testcase: '',
    tags: [], date_from: '', date_to: '', page: 1,
  }, changes);
  resSaveState();
  location.hash = '#results';
}
function resListThisPackage() {
  if (resRunSummary) resListFilteredBy({ package: resRunSummary.name, kind: resRunSummary.kind });
}
resById('resRunPackageLink').addEventListener('click', resListThisPackage);
document.querySelector('#resDetailView .res-run-info').addEventListener('click', (e) => {
  if (e.target.id === 'resRunInfoPackageLink') { resListThisPackage(); return; }
  const suite = e.target.closest('[data-suite-run]');
  if (suite) { openResDetail('testsuite', Number(suite.dataset.suiteRun)); return; }
  const tag = e.target.closest('[data-tag]');
  if (tag) resListFilteredBy({ tags: [tag.dataset.tag] });
});

resById('resTestsBody').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open-run]');
  if (open) { openResDetail('testcase', Number(open.dataset.openRun)); return; }
  const logLink = e.target.closest('.res-log-open');
  if (logLink && resDetailCurrent) {
    openResTestLog(resDetailCurrent.kind, resDetailCurrent.id, Number(logLink.closest('tr').dataset.seq));
    return;
  }
  const logBtn = e.target.closest('.res-log-btn');
  if (!logBtn || !resRunSummary) return;
  const row = logBtn.closest('tr');
  const seq = Number(row.dataset.seq);
  const next = row.nextElementSibling;
  if (resRunOpenLogs.has(seq)) {
    resRunOpenLogs.delete(seq);
    if (next && next.classList.contains('res-log-row')) next.remove();
    logBtn.textContent = 'details';
    logBtn.setAttribute('aria-expanded', 'false');
    return;
  }
  resRunOpenLogs.add(seq);
  logBtn.textContent = 'hide';
  logBtn.setAttribute('aria-expanded', 'true');
  row.insertAdjacentHTML('afterend', `<tr class="res-log-row" data-log-for="${seq}"><td colspan="7"><div class="res-log-body"></div></td></tr>`);
  // The row's test, rebuilt from what's on screen (run_id for a suite's testcase).
  const runBtn = row.querySelector('[data-open-run]');
  resFillLog(row.nextElementSibling.querySelector('.res-log-body'),
    { seq, run_id: runBtn ? Number(runBtn.dataset.openRun) : null }, resRunSummary);
});
resById('resTestsNav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-page]');
  if (b && !b.disabled) resRunGoToPage(b.dataset.page);
});
resById('resTestsGoto').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { resRunGoToPage(e.target.value); e.target.value = ''; }
});
resById('resTestsPageSize').addEventListener('change', (e) => resRunSetFilter({ pageSize: Number(e.target.value) || 25 }));

resById('resRunningNow').addEventListener('click', () => resSetFilter({ view: 'current', status: 'running' }));

// Test log page
resById('resLogRunLink').addEventListener('click', () => {
  if (resLogCurrent) openResDetail(resLogCurrent.kind, resLogCurrent.id);
});
document.querySelectorAll('#resLogView [data-nav]').forEach(b => b.addEventListener('click', () => {
  if (resLogCurrent && !b.disabled) openResTestLog(resLogCurrent.kind, resLogCurrent.id, Number(b.dataset.seq));
}));
resById('resLogDownloadBtn').addEventListener('click', resLogDownload);
resById('resLogFilter').addEventListener('input', debounce(applyResLogFilters, 150));
resById('resLogKind').addEventListener('change', applyResLogFilters);
resById('resLogPi').addEventListener('change', applyResLogFilters);
resById('resLogLines').addEventListener('click', (e) => {
  const fold = e.target.closest('.ll-fold');
  if (fold) resLogToggleSection(Number(fold.closest('.ll').dataset.n));
});

// #results is the list, #results/<kind>/<id> one run's page and
// #results/<kind>/<id>/tests/<seq> one test's log (detail-page.js routes all
// three here).
document.addEventListener('tabshown', (e) => {
  if (e.detail.viewId !== 'results') {
    resStopPolling();
    return;
  }
  const log = resLogFromHash();
  if (log) { resShowTestLog(log.kind, log.id, log.seq); return; }
  const run = resRunFromHash();
  if (run) resShowRun(run.kind, run.id);
  else showResListView();
});
