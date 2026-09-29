// --- Results tab: every past testcase/testsuite run in one list ------------
// Read-only. Runs are started from the Packages tab (or its bulk toolbar);
// this tab only lists and opens them, so nothing here dispatches anything.
//
// Two run kinds share one table: TestRun (a testcase) and TestSuiteRun (an
// ordered set of testcases, each of which produced its own TestRun). They
// come from separate endpoints with different shapes, so they are normalised
// into one row shape here (see resNormalise*) rather than the table having to
// branch per row.
//
// A testsuite run drills down into each testcase's own step detail inline
// (see renderResSuiteDetail) via tcRenderRunSteps from testcases-tab.js,
// which is why this file is loaded after it (and after testsuites-tab.js,
// whose openTsRunConfirmModal backs the testsuite Rerun path below).

let resRuns = [];
let resDetailPollTimer = null;

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

// Selected rows, keyed "kind:id" since a testcase run and a testsuite run
// can share the same numeric id - the composite key is what the checkbox
// column and the bulk delete below both key off of.
const resSelected = new Set();
const resRowKey = (kind, id) => `${kind}:${id}`;

// How many of each kind to pull. Deliberately generous - this tab is where
// someone goes to find "that run from this morning", and the two endpoints
// are cheap list queries with no per-run expansion.
const RES_FETCH_LIMIT = 200;

function resStopPolling() {
  if (resDetailPollTimer) {
    clearInterval(resDetailPollTimer);
    resDetailPollTimer = null;
  }
}

function showResListView() {
  resStopPolling();
  document.getElementById('resDetailView').classList.add('hidden');
  document.getElementById('resListView').classList.remove('hidden');
  loadResults();
}

function showResDetailView() {
  document.getElementById('resListView').classList.add('hidden');
  document.getElementById('resDetailView').classList.remove('hidden');
}

// --- list -----------------------------------------------------------------

function resNormaliseTestcaseRun(r) {
  return {
    kind: 'testcase', id: r.id, name: r.testcase_name, status: r.status,
    started_at: r.started_at, completed_at: r.completed_at, raw: r,
  };
}

function resNormaliseSuiteRun(r) {
  return {
    kind: 'testsuite', id: r.id, name: r.testsuite_name, status: r.status,
    started_at: r.started_at, completed_at: r.completed_at, raw: r,
  };
}

async function loadResults() {
  try {
    // Fetched together rather than per filter change: the type filter is
    // applied client-side below, so switching it doesn't re-hit the backend.
    const [tcRes, tsRes] = await Promise.all([
      apiFetch(`${API}/testcases/runs?limit=${RES_FETCH_LIMIT}`),
      apiFetch(`${API}/testsuites/runs?limit=${RES_FETCH_LIMIT}`),
    ]);
    const tcRuns = tcRes.ok ? (await tcRes.json()).map(resNormaliseTestcaseRun) : [];
    const tsRuns = tsRes.ok ? (await tsRes.json()).map(resNormaliseSuiteRun) : [];
    resRuns = [...tcRuns, ...tsRuns].sort(
      (a, b) => new Date(b.started_at) - new Date(a.started_at)
    );
    // Drop selection on anything that's no longer in the list (deleted
    // elsewhere, or aged out past RES_FETCH_LIMIT) rather than letting
    // resSelected accumulate stale keys forever.
    const liveKeys = new Set(resRuns.map(r => resRowKey(r.kind, r.id)));
    [...resSelected].forEach(k => { if (!liveKeys.has(k)) resSelected.delete(k); });
    renderResTable();
    resRenderBulkBar();
  } catch {
    // backend unreachable; keep whatever was last rendered
  }
}

function resDurationText(run) {
  if (!run.completed_at) return run.status === 'running' ? '…' : '';
  const ms = new Date(run.completed_at) - new Date(run.started_at);
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function resFilteredRuns() {
  const type = document.getElementById('resTypeFilter').value;
  const status = document.getElementById('resStatusFilter').value;
  const q = document.getElementById('resSearchInput').value.trim().toLowerCase();
  return resRuns.filter(r =>
    (type === 'all' || r.kind === type) &&
    (status === 'all' || r.status === status) &&
    (!q || (r.name || '').toLowerCase().includes(q))
  );
}

function renderResTable() {
  const body = document.getElementById('resTableBody');
  const runs = resFilteredRuns();
  if (!runs.length) {
    body.innerHTML = '<tr><td colspan="8" class="pi-log-empty">no runs match</td></tr>';
    resSyncSelectAllCheckbox();
    return;
  }
  body.innerHTML = runs.map(r => {
    const key = resRowKey(r.kind, r.id);
    return `
    <tr class="${resSelected.has(key) ? 'tc-row-selected' : ''}">
      <td class="tc-check-col"><input type="checkbox" class="res-row-check" data-kind="${r.kind}" data-id="${r.id}" ${resSelected.has(key) ? 'checked' : ''}></td>
      <td>${r.kind === 'testsuite' ? 'Testsuite' : 'Testcase'}</td>
      <td>${r.name || ''}</td>
      <td><span class="cmd-status ${tcStatusClass(r.status)}">${r.status}</span></td>
      <td>${formatVnDateTime(r.started_at)}</td>
      <td>${r.completed_at ? formatVnDateTime(r.completed_at) : ''}</td>
      <td>${resDurationText(r)}</td>
      <td class="capture-actions">
        <button class="icon-btn res-view-btn" data-kind="${r.kind}" data-id="${r.id}" title="View">${chevronIconSvg('right')}</button>
        <button class="icon-btn res-rerun-btn" data-kind="${r.kind}" data-id="${r.id}" title="Rerun">${RERUN_ICON_SVG}</button>
        <button class="icon-btn res-delete-btn" data-kind="${r.kind}" data-id="${r.id}" title="Delete">&#128465;</button>
      </td>
    </tr>
  `;
  }).join('');

  body.querySelectorAll('.res-row-check').forEach(cb => cb.addEventListener('change', () => {
    const key = resRowKey(cb.dataset.kind, Number(cb.dataset.id));
    if (cb.checked) resSelected.add(key); else resSelected.delete(key);
    cb.closest('tr').classList.toggle('tc-row-selected', cb.checked);
    resSyncSelectAllCheckbox();
    resRenderBulkBar();
  }));
  resSyncSelectAllCheckbox();

  body.querySelectorAll('.res-view-btn').forEach(btn => btn.addEventListener('click', () => {
    openResDetail(btn.dataset.kind, Number(btn.dataset.id));
  }));
  body.querySelectorAll('.res-rerun-btn').forEach(btn => btn.addEventListener('click', () => {
    rerunResRun(btn.dataset.kind, Number(btn.dataset.id));
  }));
  body.querySelectorAll('.res-delete-btn').forEach(btn => btn.addEventListener('click', () => {
    deleteResRun(btn.dataset.kind, Number(btn.dataset.id));
  }));
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
  const run = resRuns.find(r => r.kind === kind && r.id === id);
  if (!run) return;
  const sourceId = kind === 'testsuite' ? run.raw.testsuite_id : run.raw.testcase_id;
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
// those testcases had been run standalone.
async function deleteResRun(kind, id) {
  const label = kind === 'testsuite' ? 'testsuite run' : 'testcase run';
  if (!confirm(`Delete this ${label}? This can't be undone.`)) return;
  try {
    const res = await apiFetch(resRunPath(kind, id), { method: 'DELETE' });
    if (!res.ok) return;
  } catch {
    return;
  }
  resRuns = resRuns.filter(r => !(r.kind === kind && r.id === id));
  resSelected.delete(resRowKey(kind, id));
  renderResTable();
  resRenderBulkBar();
  // Back out of the detail view if it was showing the run just deleted -
  // there's nothing left there to poll or display.
  if (resDetailCurrent && resDetailCurrent.kind === kind && resDetailCurrent.id === id) {
    showResListView();
  }
}

// --- selection + bulk delete -----------------------------------------------
// Every run currently on screen (the filtered set), for the header
// checkbox's "select all on this page" behaviour - matches the Testcases
// table's tcPageIds/tcSyncSelectAllCheckbox pattern.
function resPageKeys() {
  return resFilteredRuns().map(r => resRowKey(r.kind, r.id));
}

function resSyncSelectAllCheckbox() {
  const all = document.getElementById('resSelectAll');
  if (!all) return;
  const keys = resPageKeys();
  const selectedHere = keys.filter(k => resSelected.has(k)).length;
  all.checked = keys.length > 0 && selectedHere === keys.length;
  all.indeterminate = selectedHere > 0 && selectedHere < keys.length;
}

function resRenderBulkBar() {
  const n = resSelected.size;
  document.getElementById('resBulkCount').textContent = n ? `${n} selected` : 'none selected';
  document.getElementById('resBulkDeleteBtn').disabled = n === 0;
}

function resClearSelection() {
  resSelected.clear();
  resRenderBulkBar();
}

// Runs, split back out from the composite "kind:id" keys - deletion needs
// each row's kind to hit the right endpoint (see resRunPath).
function resSelectedRuns() {
  return [...resSelected].map(key => {
    const i = key.indexOf(':');
    return { kind: key.slice(0, i), id: Number(key.slice(i + 1)) };
  });
}

async function bulkDeleteResSelected() {
  const runs = resSelectedRuns();
  if (!runs.length) return;
  if (!confirm(`Delete ${runs.length} run${runs.length === 1 ? '' : 's'}? This cannot be undone.`)) return;

  // Fired concurrently (each is its own DELETE, there's no bulk endpoint
  // for runs) - individual failures are skipped rather than aborting the
  // rest, same spirit as the backend's own bulk testcase/testsuite deletes
  // ("ids that no longer exist are skipped").
  const outcomes = await Promise.all(runs.map(async ({ kind, id }) => {
    try {
      const res = await apiFetch(resRunPath(kind, id), { method: 'DELETE' });
      return { kind, id, ok: res.ok };
    } catch {
      return { kind, id, ok: false };
    }
  }));

  const deleted = new Set(outcomes.filter(o => o.ok).map(o => resRowKey(o.kind, o.id)));
  resRuns = resRuns.filter(r => !deleted.has(resRowKey(r.kind, r.id)));
  resClearSelection();
  renderResTable();
  if (resDetailCurrent && deleted.has(resRowKey(resDetailCurrent.kind, resDetailCurrent.id))) {
    showResListView();
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
  const current = resRuns.find(r => r.kind === kind && r.id === id);
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

document.getElementById('resRefreshBtn').addEventListener('click', loadResults);
document.getElementById('resDetailBackBtn').addEventListener('click', showResListView);
document.getElementById('resDetailRerunBtn').addEventListener('click', () => {
  if (resDetailCurrent) rerunResRun(resDetailCurrent.kind, resDetailCurrent.id);
});
document.getElementById('resDetailDeleteBtn').addEventListener('click', () => {
  if (resDetailCurrent) deleteResRun(resDetailCurrent.kind, resDetailCurrent.id);
});
document.getElementById('resTypeFilter').addEventListener('change', renderResTable);
document.getElementById('resStatusFilter').addEventListener('change', renderResTable);
document.getElementById('resSearchInput').addEventListener('input', debounce(renderResTable, 200));
document.getElementById('resSelectAll').addEventListener('change', (e) => {
  const keys = resPageKeys();
  if (e.target.checked) keys.forEach(k => resSelected.add(k));
  else keys.forEach(k => resSelected.delete(k));
  renderResTable();
  resRenderBulkBar();
});
document.getElementById('resBulkDeleteBtn').addEventListener('click', bulkDeleteResSelected);

document.addEventListener('tabshown', (e) => {
  if (e.detail.viewId === 'results') showResListView();
  else resStopPolling();
});
