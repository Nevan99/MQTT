// --- Testsuites: named, ordered collections of existing testcases ---------
// Lives as its own panel inside the Testcases tab (see the "ts-list-panel"
// in index.html), not a separate top-level tab - the list is always
// visible alongside the testcase list; editing, running, and run history
// each open as their own popup instead of navigating anywhere.
//
// A testsuite doesn't own its testcases - the editor's picker lists every
// testcase that exists (see fetchAllTestcasesForPicker), whether or not
// it's already used in another suite, and adding one here is just adding
// its id to this suite's own list (routers/TestSuites.py's testcase_ids).
// Running a suite runs each of those testcases in order through the exact
// same run engine a standalone testcase uses (routers/TestCases._run_testcase,
// called directly by routers/TestSuites._run_testsuite) - this tab only
// displays/polls the resulting TestSuiteRun, same as testcases-tab.js does
// for a TestRun.

let tsList = [];
let tsAllTestcases = [];   // fetched fresh whenever the editor opens - the picker's pool
let tsEditingId = null;
let tsSelectedIds = [];    // ordered testcase ids for the suite being edited
let tsActiveRunId = null;
let tsRunPollTimer = null;
let tsLastRunRenderSignature = null;
// testcase_id -> name, fetched once per opened run (see openTsRunView) so
// the live view can show every testcase the suite will run - not just the
// ones that have reported a result yet - without an id-only placeholder for
// whichever one is still pending or currently running.
let tsRunTestcaseNames = {};
// testcase_id -> steps (its own definition, not a run) - fetched alongside
// the names above so a testcase the suite hasn't reached yet can still show
// its planned step list (all "pending") instead of nothing at all.
let tsRunTestcaseSteps = {};

// --- popups -------------------------------------------------------------

function stopTsRunPolling() {
  if (tsRunPollTimer) {
    clearInterval(tsRunPollTimer);
    tsRunPollTimer = null;
  }
}

function openTsEditorModal() {
  document.getElementById('tsEditorOverlay').classList.remove('hidden');
  document.addEventListener('keydown', tsEditorModalKeydown);
}

function closeTsEditorModal() {
  document.getElementById('tsEditorOverlay').classList.add('hidden');
  document.removeEventListener('keydown', tsEditorModalKeydown);
}

function tsEditorModalKeydown(e) {
  if (e.key === 'Escape') closeTsEditorModal();
}

// --- Running tab ------------------------------------------------------------
// Testsuite runs are watched in their own top-level tab (#running) rather
// than a pop-up: a list of running + recent suite runs on the left, the
// selected one's live detail on the right. Polling only happens while the
// tab is visible; leaving it pauses (tsActiveRunId is kept, so coming back
// resumes the same run).
let tsLivePollTimer = null;
const TS_LIVE_RECENT = 15;

// The selected standalone testcase run (null when a suite run - or nothing
// - is selected; tsActiveRunId is the suite equivalent). Only one of the
// two is ever set.
let tcLiveRunId = null;
let tcLivePollTimer = null;
let tcLiveRefreshing = false;

function stopTcLivePolling() {
  if (tcLivePollTimer) {
    clearInterval(tcLivePollTimer);
    tcLivePollTimer = null;
  }
}

function tsShowLivePane(which) {
  document.getElementById('tsRunEmpty').classList.toggle('hidden', which !== null);
  document.getElementById('tsRunDetail').classList.toggle('hidden', which !== 'testsuite');
  document.getElementById('tcLiveDetail').classList.toggle('hidden', which !== 'testcase');
}

// Selects a standalone testcase run in the Running tab, switching to it.
async function openLiveTestcaseRun(runId) {
  if (tsActiveRunId !== null) {
    stopTsRunPolling();
    tsActiveRunId = null;
  }
  if (tcLiveRunId !== runId) {
    tcLiveRunId = runId;
    document.getElementById('tcLiveSteps').innerHTML = '<div class="pi-log-empty">loading…</div>';
  }
  tsShowLivePane('testcase');
  tsMarkLiveSelection();
  if (location.hash !== '#running') {
    location.hash = '#running';   // tabshown resumes polling on this run
    return;
  }
  await refreshTcLive();
  startTcLivePolling();
}

function startTcLivePolling() {
  stopTcLivePolling();
  tcLivePollTimer = setInterval(refreshTcLive, 1500);
}

async function refreshTcLive() {
  if (tcLiveRunId === null || tcLiveRefreshing) return;
  const runId = tcLiveRunId;
  tcLiveRefreshing = true;
  try {
    // Expanded while running: the pass/step in flight opens by itself.
    const sm = await tcRenderRunInto(document.getElementById('tcLiveSteps'), runId);
    if (!sm || tcLiveRunId !== runId) return;
    document.getElementById('tcLiveTitle').textContent = `Testcase run: ${sm.testcase_name}`;
    const statusEl = document.getElementById('tcLiveStatus');
    statusEl.textContent = sm.status;
    statusEl.className = `cmd-status ${tcStatusClass(sm.status)}`;
    const c = k => sm.counts[k] || 0;
    const done = sm.total - c('pending') - c('running') - c('skipped');
    document.getElementById('tcLiveMeta').textContent = [
      `started ${formatVnDateTime(sm.started_at)}`,
      sm.completed_at ? `completed ${formatVnDateTime(sm.completed_at)}` : null,
      `${done}/${sm.total} step runs done`,
      c('skipped') ? `${c('skipped')} skipped` : null,
      sm.current !== null && sm.current !== undefined ? `now on #${sm.current + 1}` : null,
    ].filter(Boolean).join('  ·  ');
    tcRenderStopControls(document.getElementById('tcLiveStopHost'), 'testcase', sm);
    if (sm.status !== 'running') stopTcLivePolling();
  } catch {
    // transient; the next tick retries
  } finally {
    tcLiveRefreshing = false;
  }
}

function startTsRunPolling() {
  stopTsRunPolling();
  tsRunPollTimer = setInterval(refreshTsRun, 1500);
}

function startTsLivePolling() {
  stopTsLivePolling();
  tsLivePollTimer = setInterval(loadTsLiveList, 3000);
}

function stopTsLivePolling() {
  if (tsLivePollTimer) {
    clearInterval(tsLivePollTimer);
    tsLivePollTimer = null;
  }
}

// Called when navigating away from the tab (and from showPiDetail, which
// bypasses the tabshown event).
function pauseTsRunTab() {
  stopTsRunPolling();
  stopTcLivePolling();
  stopTsLivePolling();
}

let tsLiveLoading = false;

async function loadTsLiveList() {
  if (tsLiveLoading) return;
  tsLiveLoading = true;
  try {
    const [sRes, cRes] = await Promise.all([
      apiFetch(`${API}/testsuites/runs?limit=${TS_LIVE_RECENT + 20}`),
      apiFetch(`${API}/testcases/runs?limit=${TS_LIVE_RECENT + 20}&light=true`),
    ]);
    if (!sRes.ok || !cRes.ok) return;
    const runs = [
      ...(await sRes.json()).map(r => ({ ...r, kind: 'testsuite' })),
      ...(await cRes.json()).map(r => ({ ...r, kind: 'testcase' })),
    ].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    tsLiveRuns = runs;
    // Drop checks on runs no longer listed (deleted elsewhere, or aged out
    // of the recent window) so a bulk action never hits something unseen.
    const listed = new Set(tsLiveShownRuns().map(r => tsLiveKey(r.kind, r.id)));
    [...tsLiveSelected].forEach(k => { if (!listed.has(k)) tsLiveSelected.delete(k); });
    renderTsLiveList();
    // Nothing picked yet: open the newest running one by itself - but only
    // while the tab is still showing. A list fetch that finishes after the
    // user has moved to another tab would otherwise yank them back here.
    if (tsActiveRunId === null && tcLiveRunId === null && location.hash === '#running') {
      const first = runs.find(r => r.status === 'running');
      if (first && first.kind === 'testsuite') openTsRunView(first.id);
      else if (first) openLiveTestcaseRun(first.id);
    }
  } catch {
    // transient; the next tick retries
  } finally {
    tsLiveLoading = false;
  }
}

function tsLiveIsSelected(kind, id) {
  return kind === 'testsuite' ? id === tsActiveRunId : id === tcLiveRunId;
}

function tsLiveItemHtml(r) {
  const when = r.status === 'running'
    ? `started ${formatVnDateTime(r.started_at)}`
    : `${formatVnDateTime(r.completed_at || r.started_at)}`;
  let sub;
  if (r.kind === 'testsuite') {
    const done = (r.results || []).filter(e => !['pending', 'running', 'skipped'].includes(e.status)).length;
    sub = `suite · ${done}/${(r.testcase_ids || []).length} testcases · ${when}`;
  } else {
    sub = `testcase · ${when}`;
  }
  const name = r.kind === 'testsuite' ? r.testsuite_name : r.testcase_name;
  const checked = tsLiveSelected.has(tsLiveKey(r.kind, r.id));
  return `
    <div class="ts-live-item${tsLiveIsSelected(r.kind, r.id) ? ' selected' : ''}${checked ? ' checked' : ''}" data-kind="${r.kind}" data-id="${r.id}">
      <input type="checkbox" class="ts-live-check" ${checked ? 'checked' : ''} aria-label="Select ${tcEsc(name || '')} #${r.id}">
      <span class="ts-live-name">${tcEsc(name)} <span class="tc-run-meta">#${r.id}</span>
        <span class="ts-live-sub">${sub}</span>
      </span>
      <span class="cmd-status ${tcStatusClass(r.status)}">${r.status}</span>
    </div>`;
}

// What the list shows, in on-screen order: every running run, then the
// TS_LIVE_RECENT newest finished ones.
function tsLiveSplitRuns() {
  return {
    running: tsLiveRuns.filter(r => r.status === 'running'),
    recent: tsLiveRuns.filter(r => r.status !== 'running').slice(0, TS_LIVE_RECENT),
  };
}

function tsLiveShownRuns() {
  const { running, recent } = tsLiveSplitRuns();
  return [...running, ...recent];
}

function renderTsLiveList() {
  const { running, recent } = tsLiveSplitRuns();
  document.getElementById('tsLiveList').innerHTML = `
    <div class="ts-live-section">Running (${running.length})</div>
    ${running.map(tsLiveItemHtml).join('') || '<div class="pi-log-empty">nothing running</div>'}
    <div class="ts-live-section">Recent</div>
    ${recent.map(tsLiveItemHtml).join('') || '<div class="pi-log-empty">no finished runs</div>'}
  `;
  tsLiveRenderBulkBar();
}

function tsMarkLiveSelection() {
  document.querySelectorAll('#tsLiveList .ts-live-item').forEach(item => {
    item.classList.toggle('selected', tsLiveIsSelected(item.dataset.kind, Number(item.dataset.id)));
  });
}

// --- Running tab: selection + bulk actions ----------------------------------
// Each run in the list has a checkbox; the bar above the list re-runs or
// deletes every checked one at once. Checking is separate from opening (a
// plain click on the row still opens it on the right). Shift-click a
// checkbox to check/uncheck everything between it and the last one clicked.
//
// Keyed "kind:id" - a testcase run and a testsuite run can share a numeric
// id (same as resSelected in results-tab.js). Kept across the list's 3s
// re-renders, pruned in loadTsLiveList of runs no longer listed.

let tsLiveRuns = [];                 // last fetched list, both kinds, newest first
const tsLiveSelected = new Set();
let tsLiveLastCheckedKey = null;     // shift-click range anchor
const tsLiveKey = (kind, id) => `${kind}:${id}`;

function tsLiveSelectedRuns() {
  return tsLiveShownRuns().filter(r => tsLiveSelected.has(tsLiveKey(r.kind, r.id)));
}

function tsLiveRenderBulkBar() {
  const shown = tsLiveShownRuns();
  const n = tsLiveSelectedRuns().length;
  document.getElementById('tsLiveBulkCount').textContent = n ? `${n} selected` : 'none selected';
  document.getElementById('tsLiveRerunBtn').disabled = n === 0;
  document.getElementById('tsLiveDeleteBtn').disabled = n === 0;
  const all = document.getElementById('tsLiveSelectAll');
  all.checked = shown.length > 0 && n === shown.length;
  all.indeterminate = n > 0 && n < shown.length;
  all.disabled = shown.length === 0;
}

function tsLiveSetChecked(keys, on) {
  keys.forEach(k => { if (on) tsLiveSelected.add(k); else tsLiveSelected.delete(k); });
  document.querySelectorAll('#tsLiveList .ts-live-item').forEach(item => {
    const k = tsLiveKey(item.dataset.kind, Number(item.dataset.id));
    const checked = tsLiveSelected.has(k);
    item.classList.toggle('checked', checked);
    item.querySelector('.ts-live-check').checked = checked;
  });
  tsLiveRenderBulkBar();
}

function tsLiveOnCheckClick(item, e) {
  const key = tsLiveKey(item.dataset.kind, Number(item.dataset.id));
  const on = e.target.checked;
  const order = tsLiveShownRuns().map(r => tsLiveKey(r.kind, r.id));
  const from = order.indexOf(tsLiveLastCheckedKey);
  const to = order.indexOf(key);
  if (e.shiftKey && from >= 0 && to >= 0) {
    tsLiveSetChecked(order.slice(Math.min(from, to), Math.max(from, to) + 1), on);
  } else {
    tsLiveSetChecked([key], on);
  }
  tsLiveLastCheckedKey = key;
}

// Empties the right-hand pane - used when the run it was showing is deleted.
function tsLiveCloseDetail() {
  stopTsRunPolling();
  stopTcLivePolling();
  tsActiveRunId = null;
  tcLiveRunId = null;
  tsShowLivePane(null);
}

// Starts a fresh run of the testcase/testsuite behind each checked run - the
// same as pressing Run on it in Packages, so it uses its *current* saved
// configuration (a suite's membership or a testcase's steps may have changed
// since the run being repeated). Several runs of the same testcase/testsuite
// collapse to one new run. Testcases go through the existing bulk endpoint
// (one independent run each); suites have none, so one POST per suite.
async function tsLiveRerunSelected() {
  const runs = tsLiveSelectedRuns();
  if (!runs.length) return;
  const uniq = (xs) => [...new Set(xs.filter(x => x !== null && x !== undefined))];
  const tcIds = uniq(runs.filter(r => r.kind === 'testcase').map(r => r.testcase_id));
  const suiteIds = uniq(runs.filter(r => r.kind === 'testsuite').map(r => r.testsuite_id));
  const what = [
    tcIds.length ? `${tcIds.length} testcase${tcIds.length === 1 ? '' : 's'}` : null,
    suiteIds.length ? `${suiteIds.length} testsuite${suiteIds.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' and ');
  if (!what) { alert("The selected runs' testcases/testsuites no longer exist."); return; }
  if (!confirm(`Re-run ${what}?\nEach starts a new run with its current saved configuration.`)) return;

  const started = [];
  const failed = [];
  if (tcIds.length) {
    try {
      const newRuns = await tcBulkPost('run', { ids: tcIds }, 'Failed to start testcase runs');
      newRuns.forEach(r => started.push({ kind: 'testcase', id: r.id }));
      // The bulk endpoint skips ids that no longer exist instead of failing.
      const missing = tcIds.length - newRuns.length;
      if (missing > 0) failed.push(`${missing} testcase${missing === 1 ? '' : 's'} no longer exist`);
    } catch (err) {
      failed.push(err.message);
    }
  }
  for (const id of suiteIds) {
    try {
      const res = await apiFetch(`${API}/testsuites/${id}/run`, { method: 'POST' });
      if (!res.ok) throw new Error(`testsuite #${id}: ${res.status} ${await res.text()}`);
      started.push({ kind: 'testsuite', id: (await res.json()).id });
    } catch (err) {
      failed.push(err.message);
    }
  }

  tsLiveSetChecked([...tsLiveSelected], false);
  await loadTsLiveList();
  // Follow the first new run, so its progress is on screen straight away.
  if (started.length) {
    const first = started[0];
    if (first.kind === 'testsuite') openTsRunView(first.id);
    else openLiveTestcaseRun(first.id);
  }
  if (failed.length) alert(`Started ${started.length} run(s). Some could not be started:\n${failed.join('\n')}`);
}

// Deletes every checked run's history record (one DELETE each - there's no
// bulk endpoint for runs; failures are skipped, not fatal, same as the
// Results tab's bulk delete). A run still in progress is stopped by the
// backend before it's deleted.
async function tsLiveDeleteSelected() {
  const runs = tsLiveSelectedRuns();
  if (!runs.length) return;
  const runningN = runs.filter(r => r.status === 'running').length;
  const msg = `Delete ${runs.length} run${runs.length === 1 ? '' : 's'}? This can't be undone.`
    + (runningN ? `\n${runningN} still running will be stopped first.` : '');
  if (!confirm(msg)) return;

  const outcomes = await Promise.all(runs.map(async (r) => {
    const path = r.kind === 'testsuite' ? `${API}/testsuites/runs/${r.id}` : `${API}/testcases/runs/${r.id}`;
    try {
      const res = await apiFetch(path, { method: 'DELETE' });
      return { r, ok: res.ok || res.status === 404 };   // 404: already gone
    } catch {
      return { r, ok: false };
    }
  }));

  const deleted = new Set(outcomes.filter(o => o.ok).map(o => tsLiveKey(o.r.kind, o.r.id)));
  tsLiveSetChecked([...deleted], false);
  if ((tsActiveRunId !== null && deleted.has(tsLiveKey('testsuite', tsActiveRunId)))
      || (tcLiveRunId !== null && deleted.has(tsLiveKey('testcase', tcLiveRunId)))) {
    tsLiveCloseDetail();
  }
  tsLiveRuns = tsLiveRuns.filter(r => !deleted.has(tsLiveKey(r.kind, r.id)));
  renderTsLiveList();
  loadTsLiveList();
  const failedN = outcomes.length - deleted.size;
  if (failedN) alert(`${failedN} run${failedN === 1 ? '' : 's'} could not be deleted.`);
}

function openTsRunHistoryModal() {
  document.getElementById('tsRunHistoryOverlay').classList.remove('hidden');
  document.addEventListener('keydown', tsRunHistoryModalKeydown);
  loadTsRunHistory();
}

function closeTsRunHistoryModal() {
  document.getElementById('tsRunHistoryOverlay').classList.add('hidden');
  document.removeEventListener('keydown', tsRunHistoryModalKeydown);
}

function tsRunHistoryModalKeydown(e) {
  if (e.key === 'Escape') closeTsRunHistoryModal();
}

// --- list -----------------------------------------------------------------

async function loadTestsuites() {
  const q = document.getElementById('tsSearchInput').value.trim();
  const tag = document.getElementById('tsTagFilterInput').value.trim();
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    const res = await apiFetch(`${API}/testsuites?${params}`);
    if (!res.ok) return;
    tsList = await res.json();
    renderTsTable();
  } catch {
    // backend unreachable; keep last known list
  }
}

function renderTsTable() {
  const body = document.getElementById('tsTableBody');
  if (!tsList.length) {
    body.innerHTML = '<tr><td colspan="3" class="pi-log-empty">no testsuites yet</td></tr>';
    return;
  }
  // Narrower panel than the testcase list (see .ts-list-panel) - tags/
  // author/updated are folded into the name cell's title tooltip instead of
  // their own columns, rather than competing for the width to show them.
  body.innerHTML = tsList.map(s => {
    const details = [
      s.tags && s.tags.length ? `tags: ${s.tags.join(', ')}` : null,
      s.author ? `author: ${s.author}` : null,
      `updated: ${formatVnDateTime(s.updated_at)}`,
    ].filter(Boolean).join(' · ');
    return `
    <tr>
      <td class="ts-name-cell" title="${details}">${s.name}</td>
      <td>${s.testcase_ids.length}</td>
      <td class="capture-actions">
        <button class="icon-btn ts-run-btn" data-id="${s.id}" title="Run">&#9654;</button>
        <button class="icon-btn ts-edit-btn" data-id="${s.id}" title="Edit">&#9998;</button>
        <button class="icon-btn ts-dup-btn" data-id="${s.id}" title="Duplicate">${DUPLICATE_ICON_SVG}</button>
        <button class="icon-btn ts-delete-btn" data-id="${s.id}" title="Delete">&#128465;</button>
      </td>
    </tr>
  `;
  }).join('');

  body.querySelectorAll('.ts-run-btn').forEach(btn => btn.addEventListener('click', () => openTsRunConfirmModal(Number(btn.dataset.id))));
  body.querySelectorAll('.ts-edit-btn').forEach(btn => btn.addEventListener('click', () => openEditTestsuite(btn.dataset.id)));
  body.querySelectorAll('.ts-dup-btn').forEach(btn => btn.addEventListener('click', () => duplicateTestsuite(btn.dataset.id)));
  body.querySelectorAll('.ts-delete-btn').forEach(btn => btn.addEventListener('click', () => deleteTestsuite(btn.dataset.id)));
}

async function duplicateTestsuite(id) {
  try {
    const res = await apiFetch(`${API}/testsuites/${id}/duplicate`, { method: 'POST' });
    if (!res.ok) { alert(`Failed to duplicate: ${res.status} ${await res.text()}`); return; }
    await loadTestsuites();
  } catch (err) {
    alert(`Failed to duplicate: ${err.message}`);
  }
}

async function deleteTestsuite(id) {
  if (!confirm('Delete this testsuite? This cannot be undone (the testcases in it are untouched).')) return;
  try {
    const res = await apiFetch(`${API}/testsuites/${id}`, { method: 'DELETE' });
    if (!res.ok) { alert(`Failed to delete: ${res.status} ${await res.text()}`); return; }
    await loadTestsuites();
  } catch (err) {
    alert(`Failed to delete: ${err.message}`);
  }
}

// --- testcase picker -----------------------------------------------------

async function fetchAllTestcasesForPicker() {
  try {
    const res = await apiFetch(`${API}/testcases`);
    tsAllTestcases = res.ok ? await res.json() : [];
  } catch {
    tsAllTestcases = [];
  }
}

function tsTestcaseName(id) {
  const t = tsAllTestcases.find(t => t.id === id);
  return t ? t.name : `testcase #${id} (not found)`;
}

function renderTsSelectedList() {
  const el = document.getElementById('tsSelectedList');
  el.innerHTML = tsSelectedIds.length
    ? tsSelectedIds.map((id, i) => `
        <div class="ts-picker-row">
          <span class="ts-picker-num">#${i + 1}</span>
          <span class="ts-picker-name">${tsTestcaseName(id)}</span>
          <span class="ts-picker-controls">
            <button type="button" class="icon-btn ts-move-up" title="Move up">&#8593;</button>
            <button type="button" class="icon-btn ts-move-down" title="Move down">&#8595;</button>
            <button type="button" class="icon-btn ts-remove" title="Remove from suite">&#128465;</button>
          </span>
        </div>
      `).join('')
    : '<div class="pi-log-empty">no testcases added yet - pick some below</div>';

  el.querySelectorAll('.ts-move-up').forEach((btn, i) => btn.addEventListener('click', () => tsMoveSelected(i, -1)));
  el.querySelectorAll('.ts-move-down').forEach((btn, i) => btn.addEventListener('click', () => tsMoveSelected(i, 1)));
  el.querySelectorAll('.ts-remove').forEach((btn, i) => btn.addEventListener('click', () => tsRemoveSelected(i)));
}

function renderTsAvailableList() {
  const el = document.getElementById('tsAvailableList');
  const q = document.getElementById('tsAvailableSearchInput').value.trim().toLowerCase();
  const available = tsAllTestcases.filter(t => !tsSelectedIds.includes(t.id) && (!q || t.name.toLowerCase().includes(q)));
  el.innerHTML = available.length
    ? available.map(t => `
        <div class="ts-picker-row" data-id="${t.id}">
          <span class="ts-picker-name">${t.name}</span>
          <span class="hint" style="margin: 0 0.5rem; flex: 1 1 auto;">${(t.tags || []).join(', ')}</span>
          <button type="button" class="icon-btn ts-add" title="Add to suite">+</button>
        </div>
      `).join('')
    : '<div class="pi-log-empty">no matching testcases</div>';

  el.querySelectorAll('.ts-add').forEach(btn => {
    btn.addEventListener('click', () => {
      tsSelectedIds.push(Number(btn.closest('.ts-picker-row').dataset.id));
      renderTsPickerLists();
    });
  });
}

function renderTsPickerLists() {
  renderTsSelectedList();
  renderTsAvailableList();
}

function tsMoveSelected(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= tsSelectedIds.length) return;
  [tsSelectedIds[i], tsSelectedIds[j]] = [tsSelectedIds[j], tsSelectedIds[i]];
  renderTsPickerLists();
}

function tsRemoveSelected(i) {
  tsSelectedIds.splice(i, 1);
  renderTsPickerLists();
}

// --- editor: open/save -------------------------------------------------

async function openNewTestsuite() {
  tsEditingId = null;
  tsSelectedIds = [];
  document.getElementById('tsEditorTitle').textContent = 'New Testsuite';
  document.getElementById('tsName').value = '';
  document.getElementById('tsDescription').value = '';
  document.getElementById('tsTags').value = '';
  document.getElementById('tsAuthor').value = '';
  document.getElementById('tsStopOnFailure').checked = true;
  document.getElementById('tsAvailableSearchInput').value = '';
  await fetchAllTestcasesForPicker();
  renderTsPickerLists();
  openTsEditorModal();
}

async function openEditTestsuite(id) {
  try {
    const res = await apiFetch(`${API}/testsuites/${id}`);
    if (!res.ok) { alert('Failed to load testsuite.'); return; }
    const s = await res.json();
    tsEditingId = s.id;
    tsSelectedIds = [...s.testcase_ids];
    document.getElementById('tsEditorTitle').textContent = `Edit: ${s.name}`;
    document.getElementById('tsName').value = s.name;
    document.getElementById('tsDescription').value = s.description || '';
    document.getElementById('tsTags').value = (s.tags || []).join(', ');
    document.getElementById('tsAuthor').value = s.author || '';
    document.getElementById('tsStopOnFailure').checked = s.stop_on_failure;
    document.getElementById('tsAvailableSearchInput').value = '';
    await fetchAllTestcasesForPicker();
    renderTsPickerLists();
    openTsEditorModal();
  } catch (err) {
    alert(`Failed to load testsuite: ${err.message}`);
  }
}

function collectTestsuiteFromForm() {
  const tags = document.getElementById('tsTags').value.split(',').map(s => s.trim()).filter(Boolean);
  return {
    name: document.getElementById('tsName').value.trim(),
    description: document.getElementById('tsDescription').value,
    tags,
    author: document.getElementById('tsAuthor').value,
    stop_on_failure: document.getElementById('tsStopOnFailure').checked,
    testcase_ids: tsSelectedIds,
  };
}

async function saveTestsuite(thenRun) {
  const body = collectTestsuiteFromForm();
  if (!body.name) {
    alert('Name is required.');
    return;
  }
  try {
    const url = tsEditingId ? `${API}/testsuites/${tsEditingId}` : `${API}/testsuites`;
    const method = tsEditingId ? 'PUT' : 'POST';
    const res = await apiFetch(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      alert(`Failed to save: ${res.status} ${await res.text()}`);
      return;
    }
    const saved = await res.json();
    tsEditingId = saved.id;
    closeTsEditorModal();
    if (thenRun) await runTestsuiteById(saved.id);
    else await loadTestsuites();
  } catch (err) {
    alert(`Failed to save: ${err.message}`);
  }
}

// --- run confirmation ------------------------------------------------------
// A testsuite's own membership/config can drift after a run - testcases
// added, removed, reordered, or stop_on_failure flipped - so before actually
// dispatching anything, this shows exactly what will run: the suite's name,
// stop_on_failure, and its *current* ordered testcase list (fetched fresh,
// not whatever a stale row in some table remembers). Used by both the
// Testsuites table's own Run button and the Results tab's Rerun action.

let tsRunConfirmSuiteId = null;
let tsRunConfirmOnConfirm = null;

// onConfirm: (id) => void, called with the suite id if the user confirms.
// Defaults to running it in this tab's own view (the Run button's case) -
// results-tab.js passes its own callback so a rerun opens in the Results
// tab's detail view instead.
async function openTsRunConfirmModal(id, onConfirm) {
  tsRunConfirmSuiteId = id;
  tsRunConfirmOnConfirm = onConfirm || ((confirmedId) => runTestsuiteById(confirmedId));
  const nameEl = document.getElementById('tsRunConfirmName');
  const metaEl = document.getElementById('tsRunConfirmMeta');
  const listEl = document.getElementById('tsRunConfirmList');
  nameEl.textContent = 'Loading…';
  metaEl.textContent = '';
  listEl.innerHTML = '';
  document.getElementById('tsRunConfirmOverlay').classList.remove('hidden');
  try {
    const res = await apiFetch(`${API}/testsuites/${id}`);
    if (!res.ok) {
      alert(`Failed to load testsuite: ${res.status} ${await res.text()}`);
      closeTsRunConfirmModal();
      return;
    }
    const suite = await res.json();
    if (tsRunConfirmSuiteId !== id) return; // overtaken by a different open/close
    await fetchAllTestcasesForPicker();
    nameEl.textContent = suite.name;
    metaEl.textContent = suite.stop_on_failure
      ? 'Stops on the first failing testcase' : 'Continues through every testcase regardless of failures';
    listEl.innerHTML = suite.testcase_ids.length
      ? suite.testcase_ids.map((tcId, i) => `
          <div class="ts-picker-row">
            <span class="ts-picker-num">#${i + 1}</span>
            <span class="ts-picker-name">${tcEsc(tsTestcaseName(tcId))}</span>
          </div>
        `).join('')
      : '<div class="pi-log-empty">no testcases in this suite - running it will do nothing</div>';
  } catch (err) {
    alert(`Failed to load testsuite: ${err.message}`);
    closeTsRunConfirmModal();
  }
}

function closeTsRunConfirmModal() {
  document.getElementById('tsRunConfirmOverlay').classList.add('hidden');
  tsRunConfirmSuiteId = null;
  tsRunConfirmOnConfirm = null;
}

// --- run + run history --------------------------------------------------

async function runTestsuiteById(id) {
  try {
    const res = await apiFetch(`${API}/testsuites/${id}/run`, { method: 'POST' });
    if (!res.ok) {
      alert(`Failed to start run: ${res.status} ${await res.text()}`);
      return;
    }
    const run = await res.json();
    openTsRunView(run.id);
  } catch (err) {
    alert(`Failed to start run: ${err.message}`);
  }
}

// Selects a suite run in the Running tab (switching to the tab if needed) -
// used by starting a run, the run history's View buttons, and the tab's own
// list.
async function openTsRunView(runId) {
  if (tcLiveRunId !== null) {
    stopTcLivePolling();
    tcLiveRunId = null;
  }
  tsShowLivePane('testsuite');
  if (tsActiveRunId !== runId) {
    tsActiveRunId = runId;
    tsLastRunRenderSignature = null;
    tsRunTestcaseNames = {};
    tsRunTestcaseSteps = {};
    tsResetRunDetailState();
    document.getElementById('tsRunTestcases').innerHTML = '<div class="pi-log-empty">loading…</div>';
  }
  tsMarkLiveSelection();
  if (location.hash !== '#running') {
    // tabshown for #running resumes polling on this run.
    location.hash = '#running';
    return;
  }
  await refreshTsRun();
  startTsRunPolling();
}

// Every testcase_id the suite run will step through, by name - fetched once
// per opened run rather than per poll tick, since a run's own testcase_ids
// don't change once it's launched (see TestSuiteRun.testcase_ids_json).
async function tsLoadRunTestcaseNames(ids) {
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const res = await apiFetch(`${API}/testcases/${id}`);
      if (res.ok) {
        const t = await res.json();
        return [id, t.name, t.steps];
      }
    } catch {
      // transient; this testcase's row just falls back to "#<id>" below
    }
    return [id, null, null];
  }));
  results.forEach(([id, name, steps]) => {
    if (name) tsRunTestcaseNames[id] = name;
    if (steps) tsRunTestcaseSteps[id] = steps;
  });
}

// A fake TestRunOut-shaped object for a testcase the suite hasn't reached
// yet, built from its own step definitions rather than an actual run (there
// is none to fetch) - so tcRenderRunSteps can show the planned step list,
// every one "pending", the same way it shows a real run's steps.
function tsPendingStepsRun(testcaseId) {
  const steps = tsRunTestcaseSteps[testcaseId] || [];
  return {
    id: `pending-${testcaseId}`, status: 'pending',
    results: steps.map((s, i) => ({
      action: s.action, target: s.target, status: 'pending', step_index: i,
      pass_index: 0, iteration: 1,
    })),
  };
}

let tsRunRefreshing = false;

async function refreshTsRun() {
  if (!tsActiveRunId || tsRunRefreshing) return;
  tsRunRefreshing = true;
  try {
    const runId = tsActiveRunId;
    const res = await apiFetch(`${API}/testsuites/runs/${runId}`);
    if (!res.ok || tsActiveRunId !== runId) return;
    const run = await res.json();
    if (!Object.keys(tsRunTestcaseNames).length && (run.testcase_ids || []).length) {
      await tsLoadRunTestcaseNames(run.testcase_ids);
    }
    renderTsRunView(run);
    await tsRefreshRunningStepDetail(run);
    if (run.status !== 'running') stopTsRunPolling();
  } catch {
    // transient; the next tick retries
  } finally {
    tsRunRefreshing = false;
  }
}

// One testcase's step-level detail, rendered inside its row when expanded.
// Reuses tcRenderRunInto (testcases-tab.js)
// - the exact renderer the Testcases tab's own run view uses - so a suite run
// shows the same per-step targets, checks, logs and timings, live, instead of
// a stripped-down summary.
//
// Refetched on every poll tick while that testcase is still running (the old
// version loaded once and cached, which is why an expanded row sat on
// "starting…" for the whole run); a finished one is fetched once more to pick
// up its final state and then left alone (tsFinishedDetailRunIds).
const tsExpandedRunIds = new Set();       // testcase run_ids whose detail is open
const tsAutoExpandedRunIds = new Set();   // ones this view opened by itself
const tsFinishedDetailRunIds = new Set(); // detail is final - stop refetching
// testcase_ids whose row is expanded while the suite hasn't reached them yet
// (no run_id to key off, unlike tsExpandedRunIds above).
const tsExpandedPendingIds = new Set();

function tsResetRunDetailState() {
  tsExpandedRunIds.clear();
  tsAutoExpandedRunIds.clear();
  tsFinishedDetailRunIds.clear();
  tsExpandedPendingIds.clear();
}

// tcRenderRunInto does the in-flight guard and skip-if-unchanged itself, and
// only loads the loop passes that are open - a looped testcase inside a
// suite no longer pulls every step result on every tick.
async function tsLoadTestcaseRunDetail(resultEl, runId) {
  if (!resultEl.childElementCount) resultEl.innerHTML = '<div class="pi-log-empty">loading…</div>';
  const summary = await tcRenderRunInto(resultEl, runId);
  if (summary && summary.status !== 'running') tsFinishedDetailRunIds.add(runId);
}

// Every open row that still has something new to show, refreshed on each
// poll tick - run separately from the row rendering below so a tick that
// changes nothing at the suite level still advances the open testcase.
function tsRefreshExpandedDetails() {
  document.querySelectorAll('#tsRunTestcases .cmd-entry[data-run-id]').forEach(entry => {
    const runId = Number(entry.dataset.runId);
    if (!tsExpandedRunIds.has(runId) || tsFinishedDetailRunIds.has(runId)) return;
    tsLoadTestcaseRunDetail(entry.querySelector('.result'), runId);
  });
}

function tsRunTestcaseRowHtml(r, i, expanded) {
  const name = r.testcase_name || `#${r.testcase_id} (deleted)`;
  return `
    <div class="cmd-entry"${r.run_id ? ` data-run-id="${r.run_id}"` : ''}>
      <div class="hdr ts-run-toggle">
        <span><span class="toggle">${expanded ? '&#9660;' : '&#9654;'}</span>Testcase ${i + 1}: ${name}</span>
        <span class="cmd-status ${tcStatusClass(r.status)}">${r.status}</span>
      </div>
      <div class="result${expanded ? '' : ' hidden'}"></div>
    </div>
  `;
}

function renderTsRunView(run) {
  document.getElementById('tsRunTitle').textContent = `Run: ${run.testsuite_name}`;
  const statusEl = document.getElementById('tsRunStatus');
  statusEl.textContent = run.status;
  statusEl.className = `cmd-status ${tcStatusClass(run.status)}`;
  tcRenderStopControls(document.getElementById('tsRunStopHost'), 'testsuite', run);
  const done = run.results.filter(e => !['pending', 'running', 'skipped'].includes(e.status)).length;
  const current = run.results.find(e => e.status === 'running');
  document.getElementById('tsRunMeta').textContent = [
    `started ${formatVnDateTime(run.started_at)}`,
    run.completed_at ? `completed ${formatVnDateTime(run.completed_at)}` : null,
    `${done}/${run.testcase_ids.length} testcases done`,
    current ? `now running: ${current.testcase_name || `#${current.testcase_id}`}` : null,
  ].filter(Boolean).join('  ·  ');

  // The testcase the suite is on right now opens by itself, so the steps are
  // visible without a click - once per run_id, so collapsing it by hand isn't
  // undone by the next tick.
  const active = run.results.find(r => r.status === 'running' && r.run_id);
  if (active && !tsAutoExpandedRunIds.has(active.run_id)) {
    tsAutoExpandedRunIds.add(active.run_id);
    tsExpandedRunIds.add(active.run_id);
  }

  // Rows are rebuilt only when something about them actually changed - the
  // 1.5s poll would otherwise wipe every open row's detail each tick. Step
  // detail inside an open row refreshes on its own, below, either way.
  // Expanding/collapsing by hand isn't part of this - the click already
  // updated the DOM, and a rebuild triggered by anything else restores every
  // open row from tsExpandedRunIds anyway.
  const signature = JSON.stringify({
    status: run.status,
    results: run.results.map(r => [r.status, r.run_id]),
  });
  if (signature !== tsLastRunRenderSignature) {
    tsLastRunRenderSignature = signature;
    tsRenderRunTestcaseRows(run);
  }

  tsRefreshExpandedDetails();
}

function tsRenderRunTestcaseRows(run) {
  const container = document.getElementById('tsRunTestcases');
  // Rebuilding throws away whatever was rendered inside each open row, so the
  // per-row caches go with it - otherwise an unchanged testcase would be
  // skipped as "already rendered" and its row left blank.
  tsFinishedDetailRunIds.clear();
  container.innerHTML = run.results.length
    ? run.results.map((r, i) => tsRunTestcaseRowHtml(r, i, r.run_id
        ? tsExpandedRunIds.has(r.run_id)
        : tsExpandedPendingIds.has(r.testcase_id))).join('')
    : `<div class="pi-log-empty">${run.status === 'running' ? 'starting…' : 'no testcases ran'}</div>`;

  // Older suite runs (and any run recorded before the backend seeded every
  // testcase up front) only carry entries for what already finished.
  if (run.status === 'running' && run.results.length < run.testcase_ids.length) {
    container.insertAdjacentHTML('beforeend', '<div class="pi-log-empty">running…</div>');
  }

  container.querySelectorAll('.cmd-entry').forEach((entry, i) => {
    const r = run.results[i];
    const toggle = entry.querySelector('.ts-run-toggle');
    if (!toggle) return;
    // A testcase the suite hasn't reached yet has no run_id - nothing to
    // poll - but its own step list is already known (fetched up front via
    // tsLoadRunTestcaseNames), so it can still show every step as "pending"
    // rather than nothing at all.
    const pending = !r.run_id && tsRunTestcaseSteps[r.testcase_id];
    if (r.status === 'running') {
      // Loaded immediately (not lazily on click, like the finished-row path
      // below) - it starts expanded, and tsRefreshRunningStepDetail below
      // keeps it live on every subsequent poll tick.
      tcRenderRunSteps(entry.querySelector('.result'), { id: r.run_id, results: [], status: 'running', steps: [] });
    } else if (pending) {
      tcRenderRunSteps(entry.querySelector('.result'), tsPendingStepsRun(r.testcase_id));
    }
    // Nothing to drill into for a testcase that both hasn't run and has no
    // step list to fall back on (e.g. it was deleted before the suite
    // reached it) - only that case skips wiring the toggle at all.
    if (!r.run_id && !pending) {
      toggle.addEventListener('click', () => {
        const resultEl = entry.querySelector('.result');
        const expanding = resultEl.classList.contains('hidden');
        resultEl.classList.toggle('hidden');
        entry.querySelector('.toggle').innerHTML = expanding ? '&#9660;' : '&#9654;';
        if (expanding) resultEl.innerHTML = `<div class="pi-log-empty">${r.error || 'not run yet'}</div>`;
      });
      return;
    }
    toggle.addEventListener('click', () => {
      const resultEl = entry.querySelector('.result');
      const expanding = resultEl.classList.contains('hidden');
      resultEl.classList.toggle('hidden');
      entry.querySelector('.toggle').innerHTML = expanding ? '&#9660;' : '&#9654;';
      if (!r.run_id) {
        // Pending: the step list is static (nothing to poll), so toggling
        // just shows/hides what was already rendered above.
        if (expanding) tsExpandedPendingIds.add(r.testcase_id);
        else tsExpandedPendingIds.delete(r.testcase_id);
        return;
      }
      if (expanding) {
        tsExpandedRunIds.add(r.run_id);
        tsLoadTestcaseRunDetail(resultEl, r.run_id);
      } else {
        tsExpandedRunIds.delete(r.run_id);
      }
    });
  });
}

// Keeps the currently-running testcase's step-by-step detail live - called
// on every poll tick regardless of renderTsRunView's own skip-if-unchanged
// (that skip is keyed on each row's *status*, which stays "running" for
// many ticks while the steps underneath it keep changing).
async function tsRefreshRunningStepDetail(run) {
  const idx = run.results.findIndex(r => r.status === 'running');
  if (idx === -1) return;
  const runId = run.results[idx].run_id;
  if (!runId) return;
  const entry = document.querySelectorAll('#tsRunTestcases .cmd-entry')[idx];
  const resultEl = entry && entry.querySelector('.result');
  // Not rendered, or the user collapsed it by hand - leave it alone rather
  // than fight a deliberate click.
  if (!resultEl || resultEl.classList.contains('hidden')) return;
  await tcRenderRunInto(resultEl, runId);
}

async function loadTsRunHistory() {
  try {
    const res = await apiFetch(`${API}/testsuites/runs?limit=100`);
    if (!res.ok) return;
    const runs = await res.json();
    const body = document.getElementById('tsRunHistoryBody');
    body.innerHTML = runs.length
      ? runs.map(r => `
          <tr>
            <td>${r.testsuite_name}</td>
            <td><span class="cmd-status ${tcStatusClass(r.status)}">${r.status}</span></td>
            <td>${formatVnDateTime(r.started_at)}</td>
            <td>${r.completed_at ? formatVnDateTime(r.completed_at) : ''}</td>
            <td><button class="icon-btn ts-run-history-view-btn" data-id="${r.id}" title="View">&#9654;</button></td>
          </tr>
        `).join('')
      : '<tr><td colspan="5" class="pi-log-empty">no runs yet</td></tr>';
    body.querySelectorAll('.ts-run-history-view-btn').forEach(btn => {
      btn.addEventListener('click', () => openTsRunView(Number(btn.dataset.id)));
    });
  } catch {
    // backend unreachable; keep last known list
  }
}

// --- wiring -------------------------------------------------------------

document.getElementById('tsNewBtn').addEventListener('click', openNewTestsuite);
document.getElementById('tsEditorCloseBtn').addEventListener('click', closeTsEditorModal);
document.getElementById('tsEditorOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'tsEditorOverlay') closeTsEditorModal();
});
document.getElementById('tsLiveRefreshBtn').addEventListener('click', loadTsLiveList);
// Delegated - the list's items are re-rendered every poll tick.
document.getElementById('tsLiveList').addEventListener('click', (e) => {
  const item = e.target.closest('.ts-live-item');
  if (!item) return;
  if (e.target.classList.contains('ts-live-check')) {
    tsLiveOnCheckClick(item, e);
    return;
  }
  if (item.dataset.kind === 'testsuite') openTsRunView(Number(item.dataset.id));
  else openLiveTestcaseRun(Number(item.dataset.id));
});
document.getElementById('tsLiveSelectAll').addEventListener('change', (e) => {
  tsLiveSetChecked(tsLiveShownRuns().map(r => tsLiveKey(r.kind, r.id)), e.target.checked);
});
document.getElementById('tsLiveRerunBtn').addEventListener('click', tsLiveRerunSelected);
document.getElementById('tsLiveDeleteBtn').addEventListener('click', tsLiveDeleteSelected);
document.getElementById('tsRunHistoryBtn').addEventListener('click', openTsRunHistoryModal);
document.getElementById('tsRunHistoryCloseBtn').addEventListener('click', closeTsRunHistoryModal);
document.getElementById('tsRunHistoryOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'tsRunHistoryOverlay') closeTsRunHistoryModal();
});
document.getElementById('tsRunConfirmApplyBtn').addEventListener('click', () => {
  const id = tsRunConfirmSuiteId;
  const onConfirm = tsRunConfirmOnConfirm;
  closeTsRunConfirmModal();
  if (id !== null && onConfirm) onConfirm(id);
});
document.getElementById('tsRunConfirmCancelBtn').addEventListener('click', closeTsRunConfirmModal);
document.getElementById('tsRunConfirmCloseBtn').addEventListener('click', closeTsRunConfirmModal);
document.getElementById('tsRunConfirmOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'tsRunConfirmOverlay') closeTsRunConfirmModal();
});
document.getElementById('tsSaveBtn').addEventListener('click', () => saveTestsuite(false));
document.getElementById('tsSaveRunBtn').addEventListener('click', () => saveTestsuite(true));
document.getElementById('tsSearchInput').addEventListener('input', debounce(loadTestsuites, 300));
document.getElementById('tsTagFilterInput').addEventListener('input', debounce(loadTestsuites, 300));
document.getElementById('tsAvailableSearchInput').addEventListener('input', debounce(renderTsAvailableList, 200));

// The testsuites panel lives inside the Testcases tab (see index.html), not
// its own tab - loads alongside the testcase list whenever that tab
// actually becomes visible (click, reload, Back/Forward - see showTabView
// in detail-page.js), and every testsuite popup (editor/run/run history,
// all of which live outside #packages) closes on navigating to any other
// tab so nothing is left floating over unrelated content.
document.addEventListener('tabshown', (e) => {
  if (e.detail.viewId === 'packages') {
    loadTestsuites();
  } else {
    closeTsEditorModal();
    closeTsRunHistoryModal();
  }
  if (e.detail.viewId === 'running') {
    loadTsLiveList();
    startTsLivePolling();
    if (tsActiveRunId !== null) {
      refreshTsRun();
      startTsRunPolling();
    } else if (tcLiveRunId !== null) {
      refreshTcLive();
      startTcLivePolling();
    }
  } else {
    pauseTsRunTab();
  }
});
