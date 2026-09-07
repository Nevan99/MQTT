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
// A testsuite run drills down twice: suite -> its testcase runs -> that
// testcase's steps. The step view is tcRenderRunSteps from testcases-tab.js,
// which is why this file is loaded after it.

let resRuns = [];
let resDetailPollTimer = null;

// testcase_id -> name, for the currently-open testsuite run's detail view -
// fetched once (see resLoadSuiteTestcaseNames) so a testcase the suite
// hasn't reached yet (or is running right now) can still show its name
// instead of just "#<id>". Reset whenever a different run is opened (see
// openResDetail).
let resSuiteTestcaseNames = {};

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
        <button class="icon-btn res-view-btn" data-kind="${r.kind}" data-id="${r.id}" title="View">&#9654;</button>
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
async function rerunResRun(kind, id) {
  const run = resRuns.find(r => r.kind === kind && r.id === id);
  if (!run) return;
  const sourceId = kind === 'testsuite' ? run.raw.testsuite_id : run.raw.testcase_id;
  if (sourceId === undefined || sourceId === null) return;
  const path = kind === 'testsuite' ? `${API}/testsuites/${sourceId}/run` : `${API}/testcases/${sourceId}/run`;
  try {
    const res = await apiFetch(path, { method: 'POST' });
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
      if (res.ok) return [tcId, (await res.json()).name];
    } catch {
      // transient; this testcase's row just falls back to "#<id>" below
    }
    return [tcId, null];
  }));
  results.forEach(([tcId, name]) => { if (name) resSuiteTestcaseNames[tcId] = name; });
}

async function refreshResDetail(kind, id) {
  const path = kind === 'testsuite' ? `${API}/testsuites/runs/${id}` : `${API}/testcases/runs/${id}`;
  try {
    const res = await apiFetch(path);
    if (!res.ok) return;
    const run = await res.json();
    if (kind === 'testsuite') {
      if (!Object.keys(resSuiteTestcaseNames).length && (run.testcase_ids || []).length) {
        await resLoadSuiteTestcaseNames(run.testcase_ids);
      }
      renderResSuiteDetail(run);
      await resRefreshRunningSuiteRow(run);
    } else {
      renderResTestcaseDetail(run);
    }
    if (run.status !== 'running') resStopPolling();
  } catch {
    // transient; the next tick retries
  }
}

function resSetDetailHeader(title, status, metaBits) {
  document.getElementById('resDetailTitle').textContent = title;
  const statusEl = document.getElementById('resDetailStatus');
  statusEl.textContent = status;
  statusEl.className = `cmd-status ${tcStatusClass(status)}`;
  document.getElementById('resDetailMeta').textContent = metaBits.filter(Boolean).join('  ·  ');
}

function renderResTestcaseDetail(run) {
  resSetDetailHeader(`Testcase run: ${run.testcase_name}`, run.status, [
    `started ${formatVnDateTime(run.started_at)}`,
    run.completed_at ? `completed ${formatVnDateTime(run.completed_at)}` : null,
    `${(run.results || []).length} step result(s)`,
    run.repeat_count > 1 ? `repeat ×${run.repeat_count}` : null,
    run.stop_on_failure ? 'stop on failure' : 'continue on failure',
  ]);
  // The same renderer the Packages tab's live run view uses.
  tcRenderRunSteps(document.getElementById('resDetailBody'), run);
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
  if (index < results.length) {
    const r = results[index];
    return { status: r.status, testcase_name: r.testcase_name, run_id: r.run_id, error: r.error, finished: true };
  }
  const id = run.testcase_ids[index];
  const name = resSuiteTestcaseNames[id] || `#${id}`;
  return { status: 'pending', testcase_name: name, run_id: null, finished: false };
}

// A suite run holds one entry per testcase it launched, each pointing at its
// own TestRun via run_id. A finished testcase only gets a link to drill into
// its full step detail elsewhere (rather than inlining every step of every
// testcase at once) - but the one currently running gets its live step-by-
// step progress shown right here (see resRefreshRunningSuiteRow), so the
// view doesn't sit blank on "running" with nothing to show for it.
function renderResSuiteDetail(run) {
  const results = run.results || [];
<<<<<<< HEAD
  const rows = (run.testcase_ids || []).map((_, i) => resSuiteRowState(run, i));
=======
  // Entries are seeded pending for the whole suite up front (see
  // routers/TestSuites._run_testsuite), so "run" here means started - one
  // that has its own TestRun to point at - not merely listed.
  const started = results.filter(r => r.run_id).length;
>>>>>>> 089b72e452011768b940d1453c50a67ddeddeb7b
  resSetDetailHeader(`Testsuite run: ${run.testsuite_name}`, run.status, [
    `started ${formatVnDateTime(run.started_at)}`,
    run.completed_at ? `completed ${formatVnDateTime(run.completed_at)}` : null,
    `${started} of ${(run.testcase_ids || []).length} testcase(s) run`,
    run.stop_on_failure ? 'stop on failure' : 'continue on failure',
  ]);

  const body = document.getElementById('resDetailBody');
  body.innerHTML = rows.length
    ? rows.map((r, i) => `
        <div class="cmd-entry">
          <div class="hdr">
            <span>${i + 1}. ${r.testcase_name || `testcase #${run.testcase_ids[i]}`}</span>
            <span class="cmd-status ${tcStatusClass(r.status)}">${r.status}</span>
          </div>
          <div class="result">
            ${r.error ? `<div class="tc-run-reason">${r.error}</div>` : ''}
            ${r.status === 'running' ? '<div class="res-suite-running-steps"></div>' : ''}
            ${r.run_id && r.status !== 'running'
              ? `<button type="button" class="res-open-tc-run" data-id="${r.run_id}">Open step detail &rarr;</button>`
<<<<<<< HEAD
              : (r.finished && !r.run_id ? '<div class="hint">no run to open - the testcase was gone when the suite reached it</div>' : '')}
=======
              : `<div class="hint">${r.status === 'pending' ? 'not started yet'
                  : r.status === 'skipped' ? 'never ran - the suite stopped before reaching it'
                  : 'no run to open - the testcase was gone when the suite reached it'}</div>`}
>>>>>>> 089b72e452011768b940d1453c50a67ddeddeb7b
          </div>
        </div>
      `).join('')
    : `<div class="pi-log-empty">${run.status === 'running' ? 'starting…' : 'no testcases ran'}</div>`;

<<<<<<< HEAD
=======
  // Only for runs recorded before the backend seeded every testcase up front -
  // a seeded run already shows the not-yet-reached ones as their own pending
  // rows, so a trailing "running…" would just be repeating itself.
  if (run.status === 'running' && !results.some(r => r.status === 'pending' || r.status === 'running')) {
    body.insertAdjacentHTML('beforeend', '<div class="pi-log-empty">running…</div>');
  }

>>>>>>> 089b72e452011768b940d1453c50a67ddeddeb7b
  body.querySelectorAll('.res-open-tc-run').forEach(btn => btn.addEventListener('click', () => {
    openResDetail('testcase', Number(btn.dataset.id));
  }));
}

// Keeps the currently-running testcase's step-by-step detail live, inline in
// the suite detail view - called on every poll tick (see refreshResDetail).
async function resRefreshRunningSuiteRow(run) {
  const idx = (run.results || []).findIndex(r => r.status === 'running');
  if (idx === -1) return;
  const runId = run.results[idx].run_id;
  if (!runId) return;
  const container = document.querySelectorAll('#resDetailBody .cmd-entry')[idx]
    ?.querySelector('.res-suite-running-steps');
  if (!container) return;
  try {
    const res = await apiFetch(`${API}/testcases/runs/${runId}`);
    if (!res.ok) return;
    tcRenderRunSteps(container, await res.json());
  } catch {
    // transient; the next tick retries
  }
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
