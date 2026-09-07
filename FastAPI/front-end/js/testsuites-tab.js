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

function openTsRunModal() {
  document.getElementById('tsRunOverlay').classList.remove('hidden');
  document.addEventListener('keydown', tsRunModalKeydown);
}

function closeTsRunModal() {
  stopTsRunPolling();
  tsActiveRunId = null;
  document.getElementById('tsRunOverlay').classList.add('hidden');
  document.removeEventListener('keydown', tsRunModalKeydown);
}

function tsRunModalKeydown(e) {
  if (e.key === 'Escape') closeTsRunModal();
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
      <td title="${details}">${s.name}</td>
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

  body.querySelectorAll('.ts-run-btn').forEach(btn => btn.addEventListener('click', () => runTestsuiteById(btn.dataset.id)));
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

async function openTsRunView(runId) {
  tsActiveRunId = runId;
  tsLastRunRenderSignature = null;
  tsResetRunDetailState();
  openTsRunModal();
  await refreshTsRun();
  stopTsRunPolling();
  tsRunPollTimer = setInterval(refreshTsRun, 1500);
}

// Every testcase_id the suite run will step through, by name - fetched once
// per opened run rather than per poll tick, since a run's own testcase_ids
// don't change once it's launched (see TestSuiteRun.testcase_ids_json).
async function tsLoadRunTestcaseNames(ids) {
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const res = await apiFetch(`${API}/testcases/${id}`);
      if (res.ok) return [id, (await res.json()).name];
    } catch {
      // transient; this testcase's row just falls back to "#<id>" below
    }
    return [id, null];
  }));
  results.forEach(([id, name]) => { if (name) tsRunTestcaseNames[id] = name; });
}

async function refreshTsRun() {
  if (!tsActiveRunId) return;
  try {
    const res = await apiFetch(`${API}/testsuites/runs/${tsActiveRunId}`);
    if (!res.ok) return;
    const run = await res.json();
    if (!Object.keys(tsRunTestcaseNames).length && (run.testcase_ids || []).length) {
      await tsLoadRunTestcaseNames(run.testcase_ids);
    }
    renderTsRunView(run);
    await tsRefreshRunningStepDetail(run);
    if (run.status !== 'running') stopTsRunPolling();
  } catch {
    // transient; the next tick retries
  }
}

// One testcase's step-level detail, rendered inside its row when expanded.
// Reuses GET /testcases/runs/{run_id} and tcRenderRunSteps (testcases-tab.js)
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
const tsDetailSignatures = new Map();     // run_id -> last rendered step signature

function tsResetRunDetailState() {
  tsExpandedRunIds.clear();
  tsAutoExpandedRunIds.clear();
  tsFinishedDetailRunIds.clear();
  tsDetailSignatures.clear();
}

async function tsLoadTestcaseRunDetail(resultEl, runId) {
  // A tick can fire again while the previous fetch is still in flight; one
  // request per row at a time keeps them from rendering out of order.
  if (resultEl.dataset.loading === '1') return;
  if (!resultEl.dataset.rendered) resultEl.innerHTML = '<div class="pi-log-empty">loading…</div>';
  resultEl.dataset.loading = '1';
  try {
    const res = await apiFetch(`${API}/testcases/runs/${runId}`);
    if (!res.ok) {
      if (!resultEl.dataset.rendered) resultEl.innerHTML = '<div class="pi-log-empty">failed to load</div>';
      return;
    }
    const tcRun = await res.json();
    // Same reasoning as the suite-level signature below: re-rendering
    // identical steps every 1.5s would close any log block just opened.
    const signature = JSON.stringify({
      status: tcRun.status,
      results: (tcRun.results || []).map(r => [r.step_index, r.status, (r.entries || []).length, (r.log || []).length]),
    });
    if (tsDetailSignatures.get(runId) !== signature) {
      tsDetailSignatures.set(runId, signature);
      tcRenderRunSteps(resultEl, tcRun);
    }
    resultEl.dataset.rendered = '1';
    if (tcRun.status !== 'running') tsFinishedDetailRunIds.add(runId);
  } catch (err) {
    if (!resultEl.dataset.rendered) resultEl.innerHTML = `<div class="pi-log-empty">failed to load: ${err.message}</div>`;
  } finally {
    delete resultEl.dataset.loading;
  }
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
  tsDetailSignatures.clear();
  tsFinishedDetailRunIds.clear();
  container.innerHTML = run.results.length
    ? run.results.map((r, i) => tsRunTestcaseRowHtml(r, i, !!r.run_id && tsExpandedRunIds.has(r.run_id))).join('')
    : `<div class="pi-log-empty">${run.status === 'running' ? 'starting…' : 'no testcases ran'}</div>`;

  // Older suite runs (and any run recorded before the backend seeded every
  // testcase up front) only carry entries for what already finished.
  if (run.status === 'running' && run.results.length < run.testcase_ids.length) {
    container.insertAdjacentHTML('beforeend', '<div class="pi-log-empty">running…</div>');
  }

  container.querySelectorAll('.cmd-entry').forEach((entry, i) => {
    const r = rows[i];
    const toggle = entry.querySelector('.ts-run-toggle');
    // Nothing to drill into for a testcase that hasn't produced a run yet
    // (not reached) - only a row with a run_id (running or finished) is
    // expandable.
    if (!toggle || !r.run_id) return;
    if (r.status === 'running') {
      // Loaded immediately (not lazily on click, like the finished-row path
      // below) - it starts expanded, and tsRefreshRunningStepDetail below
      // keeps it live on every subsequent poll tick.
      tcRenderRunSteps(entry.querySelector('.result'), { id: r.run_id, results: [], status: 'running', steps: [] });
    }
    toggle.addEventListener('click', () => {
      const resultEl = entry.querySelector('.result');
      const expanding = resultEl.classList.contains('hidden');
      resultEl.classList.toggle('hidden');
      entry.querySelector('.toggle').innerHTML = expanding ? '&#9660;' : '&#9654;';
      if (!r.run_id) {
        if (expanding) resultEl.innerHTML = `<div class="pi-log-empty">${r.error || 'not run yet'}</div>`;
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
  try {
    const res = await apiFetch(`${API}/testcases/runs/${runId}`);
    if (!res.ok) return;
    tcRenderRunSteps(resultEl, await res.json());
  } catch {
    // transient; the next tick retries
  }
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
document.getElementById('tsRunCloseBtn').addEventListener('click', closeTsRunModal);
document.getElementById('tsRunOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'tsRunOverlay') closeTsRunModal();
});
document.getElementById('tsRunHistoryBtn').addEventListener('click', openTsRunHistoryModal);
document.getElementById('tsRunHistoryCloseBtn').addEventListener('click', closeTsRunHistoryModal);
document.getElementById('tsRunHistoryOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'tsRunHistoryOverlay') closeTsRunHistoryModal();
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
    closeTsRunModal();
    closeTsRunHistoryModal();
  }
});
