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
// A testsuite run drills down into each testcase's own step detail inline
// (see renderResSuiteDetail) via tcRenderRunSteps from testcases-tab.js,
// which is why this file is loaded after it (and after testsuites-tab.js,
// whose openTsRunConfirmModal backs the testsuite Rerun path below).

let resDetailPollTimer = null;
let resListPollTimer = null;

// testcase_id -> name, for the currently-open testsuite run's detail view -
// fetched once (see resLoadSuiteTestcaseNames) so a testcase the suite
// hasn't reached yet (or is running right now) can still show its name
// instead of just "#<id>". Reset whenever a different run is opened (see
// openResDetail).
let resSuiteTestcaseNames = {};
// testcase_id -> steps (its own definition, not a run), fetched alongside
// the names above - lets a not-yet-reached testcase still show its planned
// step list. Reset alongside resSuiteTestcaseNames.
let resSuiteTestcaseSteps = {};
// testcase_ids whose row in the currently-open suite detail is expanded to
// show its step-by-step detail inline - keyed by testcase_id (stable across
// pending -> running -> finished) rather than run_id (which doesn't exist
// yet for a pending row). Reset alongside the caches above.
let resExpandedSuiteTcIds = new Set();

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
  if (resDetailPollTimer) {
    clearInterval(resDetailPollTimer);
    resDetailPollTimer = null;
  }
  resStopListPolling();
}

function resStopListPolling() {
  if (resListPollTimer) {
    clearTimeout(resListPollTimer);
    resListPollTimer = null;
  }
}

function showResListView() {
  resStopPolling();
  document.getElementById('resDetailView').classList.add('hidden');
  document.getElementById('resListView').classList.remove('hidden');
  resSyncControlsFromState();
  loadResults();
}

function showResDetailView() {
  resStopListPolling();
  document.getElementById('resListView').classList.add('hidden');
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
  const deletedOpen = resDetailCurrent && resSelected.has(resRowKey(resDetailCurrent.kind, resDetailCurrent.id))
    && !resSelected.get(resRowKey(resDetailCurrent.kind, resDetailCurrent.id)).locked;
  resClearSelection();
  if (deletedOpen) showResListView(); else loadResults();
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
    showResListView();
  } else {
    loadResults();
  }
}

// --- detail ---------------------------------------------------------------

// The run the detail view is currently showing, for the Delete button (its
// click handler is wired once, in the "wiring" section below, rather than
// per-open - this is what tells it which run to act on).
let resDetailCurrent = null;

async function openResDetail(kind, id) {
  resDetailCurrent = { kind, id };
  resSuiteTestcaseNames = {};
  resSuiteTestcaseSteps = {};
  resExpandedSuiteTcIds.clear();
  showResDetailView();
  await refreshResDetail(kind, id);
  resStopPolling();
  // Only a run still in flight needs polling; a finished one never changes.
  const current = resKnownRun(kind, id);
  if (!current || current.status === 'running') {
    resDetailPollTimer = setInterval(() => refreshResDetail(kind, id), 1500);
  }
}

// testcase_id -> name for every testcase a suite run will step through -
// same reasoning and shape as testsuites-tab.js's tsLoadRunTestcaseNames,
// just against this tab's own cache (resSuiteTestcaseNames) since the two
// views can be open independently of each other.
async function resLoadSuiteTestcaseNames(ids) {
  const results = await Promise.all(ids.map(async (tcId) => {
    try {
      const res = await apiFetch(`${API}/testcases/${tcId}`);
      if (res.ok) {
        const t = await res.json();
        return [tcId, t.name, t.steps];
      }
    } catch {
      // transient; this testcase's row just falls back to "#<id>" below
    }
    return [tcId, null, null];
  }));
  results.forEach(([tcId, name, steps]) => {
    if (name) resSuiteTestcaseNames[tcId] = name;
    if (steps) resSuiteTestcaseSteps[tcId] = steps;
  });
}

// A fake TestRunOut-shaped object for a testcase the suite hasn't reached
// yet, built from its own step definitions (fetched above) rather than an
// actual run - there is none yet - so tcRenderRunSteps can show the planned
// step list, every one "pending", instead of nothing at all.
function resPendingStepsRun(testcaseId) {
  const steps = resSuiteTestcaseSteps[testcaseId] || [];
  return {
    id: `pending-${testcaseId}`, status: 'pending',
    results: steps.map((s, i) => ({
      action: s.action, target: s.target, status: 'pending', step_index: i,
      pass_index: 0, iteration: 1,
    })),
  };
}

// One refresh in flight at a time - see testcases-tab.js refreshTcRun.
let resDetailRefreshing = false;

async function refreshResDetail(kind, id) {
  if (resDetailRefreshing) return;
  resDetailRefreshing = true;
  try {
    let run;
    if (kind === 'testsuite') {
      const res = await apiFetch(`${API}/testsuites/runs/${id}`);
      if (!res.ok) return;
      run = await res.json();
      if (!Object.keys(resSuiteTestcaseNames).length && (run.testcase_ids || []).length) {
        await resLoadSuiteTestcaseNames(run.testcase_ids);
      }
      renderResSuiteDetail(run);
      await resRefreshRunningSuiteRow(run);
    } else {
      // Summary + only the opened loop passes, never the whole run - see
      // tcRenderRunInto (testcases-tab.js). Forced collapsed: this tab is
      // for scanning past runs, not watching one live, so nothing here
      // auto-expands just because a run happens to still be "running".
      run = await tcRenderRunInto(document.getElementById('resDetailBody'), id, { forceCollapsed: true });
      if (!run) return;
      renderResTestcaseDetail(run);
    }
    // The user may have navigated to another run while this one loaded.
    if (resDetailCurrent && resDetailCurrent.kind === kind && resDetailCurrent.id === id) {
      tcRenderStopControls(document.getElementById('resDetailStopHost'), kind, run);
    }
    if (run.status !== 'running') resStopPolling();
  } catch {
    // transient; the next tick retries
  } finally {
    resDetailRefreshing = false;
  }
}

function resSetDetailHeader(title, status, metaBits) {
  document.getElementById('resDetailTitle').textContent = title;
  const statusEl = document.getElementById('resDetailStatus');
  statusEl.textContent = status;
  statusEl.className = `cmd-status ${tcStatusClass(status)}`;
  document.getElementById('resDetailMeta').textContent = metaBits.filter(Boolean).join('  ·  ');
}

// Header only; run is a GET /testcases/runs/{id}/summary - the steps were
// already drawn by tcRenderRunInto in refreshResDetail.
function renderResTestcaseDetail(run) {
  resSetDetailHeader(`Testcase run: ${run.testcase_name}`, run.status, [
    `started ${formatVnDateTime(run.started_at)}`,
    run.completed_at ? `completed ${formatVnDateTime(run.completed_at)}` : null,
    `${run.total} step result(s)`,
    run.repeat_count > 1 ? `repeat ×${run.repeat_count}` : null,
    run.stop_on_failure ? 'stop on failure' : 'continue on failure',
  ]);
}

// One row per testcase_id the run steps through - not just the ones with a
// reported result yet. Same reasoning as testsuites-tab.js's tsRunRowState:
// mid-run this otherwise only ever showed what had already finished, with
// nothing indicating what was running right now or still queued behind it.
// The "running" entry (once it exists) already carries its run_id - see
// routers/TestSuites._run_testsuite, which records it before the testcase
// starts, not just once it finishes - so this only ever needs to fall back
// to a "pending" placeholder for testcases the suite run hasn't reached yet.
function resSuiteRowState(run, index) {
  const results = run.results || [];
  const id = run.testcase_ids[index];
  if (index < results.length) {
    const r = results[index];
    return {
      status: r.status, testcase_name: r.testcase_name, testcase_id: id,
      run_id: r.run_id, error: r.error,
    };
  }
  const name = resSuiteTestcaseNames[id] || `#${id}`;
  return { status: 'pending', testcase_name: name, testcase_id: id, run_id: null };
}

// Whether a row has anything to show if expanded - a run to poll/fetch
// (running or finished), or at least its own planned step list cached (see
// resLoadSuiteTestcaseNames) for one the suite hasn't reached yet. A row
// with neither (its testcase was deleted before the suite got to it, and
// nothing was ever cached for it) stays a plain non-toggling status line.
function resSuiteRowTogglable(r) {
  return !!r.run_id || (r.status === 'pending' && !!resSuiteTestcaseSteps[r.testcase_id]);
}

function resSuiteRowHtml(r, i, expanded) {
  const togglable = resSuiteRowTogglable(r);
  return `
    <div class="cmd-entry">
      <div class="hdr${togglable ? ' res-suite-tc-toggle' : ''}"${togglable ? ` data-testcase-id="${r.testcase_id}"` : ''}>
        ${togglable ? `<button type="button" class="icon-btn tc-run-toggle-chevron" title="Show/hide step detail">${chevronIconSvg(expanded ? 'down' : 'right')}</button>` : ''}
        <span>${i + 1}. ${r.testcase_name || `testcase #${r.testcase_id}`}</span>
        <span class="cmd-status ${tcStatusClass(r.status)}">${r.status}</span>
      </div>
      <div class="result${togglable && !expanded ? ' hidden' : ''}" data-testcase-id="${r.testcase_id}">
        ${r.error ? `<div class="tc-run-reason">${r.error}</div>` : ''}
        ${togglable ? '' : `<div class="hint">${r.status === 'pending' ? 'not started yet'
            : r.status === 'skipped' ? 'never ran - the suite stopped before reaching it'
            : 'no run to open - the testcase was gone when the suite reached it'}</div>`}
      </div>
    </div>
  `;
}

// Fills one row's expanded step detail - a static planned-step preview for
// one not yet started, or the real (possibly still live) run for one that
// is. Called both right after expanding and, for a running testcase, on
// every subsequent poll tick (see resRefreshRunningSuiteRow) - forceCollapsed
// is passed through to tcRenderRunSteps either way, per this tab's own
// default of every step/Pi entry starting collapsed (see
// renderResTestcaseDetail above).
async function resFillSuiteTcSteps(el, r) {
  if (r.status === 'pending') {
    tcRenderRunSteps(el, resPendingStepsRun(r.testcase_id), true);
    return;
  }
  if (!r.run_id) return;
  // Summary-first and lazy per loop pass, same as the testcase-run view -
  // a finished row re-rendered by a suite-level tick costs one small
  // summary request, not the whole run.
  await tcRenderRunInto(el, r.run_id, { forceCollapsed: true });
}

// A suite run holds one entry per testcase it launched, each pointing at its
// own TestRun via run_id. Every togglable row (started or not-yet-reached -
// see resSuiteRowTogglable) expands inline to show that testcase's own step
// detail, rather than navigating away to see it - collapsed by default
// (see resExpandedSuiteTcIds), same as this tab's testcase-run view.
function renderResSuiteDetail(run) {
  const results = run.results || [];
  const rows = (run.testcase_ids || []).map((_, i) => resSuiteRowState(run, i));
  // Entries are seeded pending for the whole suite up front (see
  // routers/TestSuites._run_testsuite), so "run" here means started - one
  // that has its own TestRun to point at - not merely listed.
  const started = results.filter(r => r.run_id).length;
  resSetDetailHeader(`Testsuite run: ${run.testsuite_name}`, run.status, [
    `started ${formatVnDateTime(run.started_at)}`,
    run.completed_at ? `completed ${formatVnDateTime(run.completed_at)}` : null,
    `${started} of ${(run.testcase_ids || []).length} testcase(s) run`,
    run.stop_on_failure ? 'stop on failure' : 'continue on failure',
  ]);

  const body = document.getElementById('resDetailBody');
  body.innerHTML = rows.length
    ? rows.map((r, i) => resSuiteRowHtml(r, i, resExpandedSuiteTcIds.has(r.testcase_id))).join('')
    : `<div class="pi-log-empty">${run.status === 'running' ? 'starting…' : 'no testcases ran'}</div>`;

  // Only for runs recorded before the backend seeded every testcase up front -
  // a seeded run already shows the not-yet-reached ones as their own pending
  // rows, so a trailing "running…" would just be repeating itself.
  if (run.status === 'running' && !results.some(r => r.status === 'pending' || r.status === 'running')) {
    body.insertAdjacentHTML('beforeend', '<div class="pi-log-empty">running…</div>');
  }

  body.querySelectorAll('.cmd-entry').forEach((entry, i) => {
    const r = rows[i];
    const toggle = entry.querySelector('.res-suite-tc-toggle');
    if (!toggle) return;
    const resultEl = entry.querySelector('.result');
    // Already expanded (surviving a poll-driven re-render) - re-fill rather
    // than leave whatever was rendered before this tick's fetch/data.
    if (resExpandedSuiteTcIds.has(r.testcase_id)) resFillSuiteTcSteps(resultEl, r);
    toggle.addEventListener('click', () => {
      const expanding = resultEl.classList.contains('hidden');
      resultEl.classList.toggle('hidden', !expanding);
      toggle.querySelector('.tc-run-toggle-chevron').innerHTML = chevronIconSvg(expanding ? 'down' : 'right');
      if (expanding) {
        resExpandedSuiteTcIds.add(r.testcase_id);
        resFillSuiteTcSteps(resultEl, r);
      } else {
        resExpandedSuiteTcIds.delete(r.testcase_id);
      }
    });
  });
}

// Keeps the currently-running testcase's step-by-step detail live, inline in
// the suite detail view, if its row happens to be expanded - called on every
// poll tick (see refreshResDetail). A collapsed running row is left alone:
// renderResSuiteDetail's own rebuild above already redraws its status text.
async function resRefreshRunningSuiteRow(run) {
  const idx = (run.results || []).findIndex(r => r.status === 'running');
  if (idx === -1) return;
  const r = run.results[idx];
  if (!resExpandedSuiteTcIds.has(r.testcase_id)) return;
  const el = document.querySelector(`#resDetailBody .result[data-testcase-id="${r.testcase_id}"]`);
  if (!el) return;
  await resFillSuiteTcSteps(el, r);
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

// Detail view
resById('resDetailBackBtn').addEventListener('click', showResListView);
resById('resDetailRerunBtn').addEventListener('click', () => {
  if (resDetailCurrent) rerunResRun(resDetailCurrent.kind, resDetailCurrent.id);
});
resById('resDetailDeleteBtn').addEventListener('click', () => {
  if (resDetailCurrent) deleteResRun(resDetailCurrent.kind, resDetailCurrent.id);
});

document.addEventListener('tabshown', (e) => {
  if (e.detail.viewId === 'results') showResListView();
  else resStopPolling();
});
