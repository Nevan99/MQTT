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
    renderResTable();
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
    body.innerHTML = '<tr><td colspan="7" class="pi-log-empty">no runs match</td></tr>';
    return;
  }
  body.innerHTML = runs.map(r => `
    <tr>
      <td>${r.kind === 'testsuite' ? 'Testsuite' : 'Testcase'}</td>
      <td>${r.name || ''}</td>
      <td><span class="cmd-status ${tcStatusClass(r.status)}">${r.status}</span></td>
      <td>${formatVnDateTime(r.started_at)}</td>
      <td>${r.completed_at ? formatVnDateTime(r.completed_at) : ''}</td>
      <td>${resDurationText(r)}</td>
      <td class="capture-actions">
        <button class="icon-btn res-view-btn" data-kind="${r.kind}" data-id="${r.id}" title="View">&#9654;</button>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('.res-view-btn').forEach(btn => btn.addEventListener('click', () => {
    openResDetail(btn.dataset.kind, Number(btn.dataset.id));
  }));
}

// --- detail ---------------------------------------------------------------

async function openResDetail(kind, id) {
  showResDetailView();
  await refreshResDetail(kind, id);
  resStopPolling();
  // Only a run still in flight needs polling; a finished one never changes.
  const current = resRuns.find(r => r.kind === kind && r.id === id);
  if (!current || current.status === 'running') {
    resDetailPollTimer = setInterval(() => refreshResDetail(kind, id), 1500);
  }
}

async function refreshResDetail(kind, id) {
  const path = kind === 'testsuite' ? `${API}/testsuites/runs/${id}` : `${API}/testcases/runs/${id}`;
  try {
    const res = await apiFetch(path);
    if (!res.ok) return;
    const run = await res.json();
    if (kind === 'testsuite') renderResSuiteDetail(run);
    else renderResTestcaseDetail(run);
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

// A suite run holds one entry per testcase it launched, each pointing at its
// own TestRun via run_id. Rendered as a list that drills into that testcase
// run rather than inlining every step of every testcase at once.
function renderResSuiteDetail(run) {
  const results = run.results || [];
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
  body.innerHTML = results.length
    ? results.map((r, i) => `
        <div class="cmd-entry">
          <div class="hdr">
            <span>${i + 1}. ${r.testcase_name || `testcase #${r.testcase_id}`}</span>
            <span class="cmd-status ${tcStatusClass(r.status)}">${r.status}</span>
          </div>
          <div class="result">
            ${r.error ? `<div class="tc-run-reason">${r.error}</div>` : ''}
            ${r.run_id
              ? `<button type="button" class="res-open-tc-run" data-id="${r.run_id}">Open step detail &rarr;</button>`
              : `<div class="hint">${r.status === 'pending' ? 'not started yet'
                  : r.status === 'skipped' ? 'never ran - the suite stopped before reaching it'
                  : 'no run to open - the testcase was gone when the suite reached it'}</div>`}
          </div>
        </div>
      `).join('')
    : `<div class="pi-log-empty">${run.status === 'running' ? 'starting…' : 'no testcases ran'}</div>`;

  // Only for runs recorded before the backend seeded every testcase up front -
  // a seeded run already shows the not-yet-reached ones as their own pending
  // rows, so a trailing "running…" would just be repeating itself.
  if (run.status === 'running' && !results.some(r => r.status === 'pending' || r.status === 'running')) {
    body.insertAdjacentHTML('beforeend', '<div class="pi-log-empty">running…</div>');
  }

  body.querySelectorAll('.res-open-tc-run').forEach(btn => btn.addEventListener('click', () => {
    openResDetail('testcase', Number(btn.dataset.id));
  }));
}

// --- wiring ---------------------------------------------------------------

document.getElementById('resRefreshBtn').addEventListener('click', loadResults);
document.getElementById('resDetailBackBtn').addEventListener('click', showResListView);
document.getElementById('resTypeFilter').addEventListener('change', renderResTable);
document.getElementById('resStatusFilter').addEventListener('change', renderResTable);
document.getElementById('resSearchInput').addEventListener('input', debounce(renderResTable, 200));

document.addEventListener('tabshown', (e) => {
  if (e.detail.viewId === 'results') showResListView();
  else resStopPolling();
});
