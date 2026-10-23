// --- Testsuites: named, ordered collections of existing testcases ---------
// The Testsuites sub-tab of Packages (#packages/testsuites - see pkgShow in
// testcases-tab.js); editing, running, and run history each open as their
// own popup instead of navigating anywhere.
//
// A testsuite doesn't own its testcases - the editor's picker lists every
// testcase that exists (see fetchAllTestcasesForPicker), whether or not
// it's already used in another suite, and adding one here is just adding
// its id to this suite's own list (routers/TestSuites.py's testcase_ids).
// Running a suite runs each of those testcases in order through the exact
// same run engine a standalone testcase uses (routers/TestCases._run_testcase,
// called directly by routers/TestSuites._run_testsuite). The resulting
// TestSuiteRun is watched in the Results tab, like any other run (see
// openTsRunView below and results-tab.js).

let tsList = [];
let tsAllTestcases = [];   // fetched fresh whenever the editor opens - the picker's pool
let tsEditingId = null;
let tsSelectedIds = [];    // ordered testcase ids for the suite being edited

// --- popups -------------------------------------------------------------

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

// --- watching a run -------------------------------------------------------
// There is no separate Running tab: as in CDRouter, a run - live or finished
// - opens as its own result page in the Results tab (results-tab.js,
// #results/<kind>/<id>), which updates in place while it runs. These two
// names stay because starting a run (here and in testcases-tab.js) and the
// run history popup's View buttons call them.
function openTsRunView(runId) {
  openResDetail('testsuite', runId);
}

function openLiveTestcaseRun(runId) {
  openResDetail('testcase', runId);
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
  document.getElementById('pkgCountTestsuites').textContent = tsList.length;
  pkgAddKnownTags(tsList.flatMap(t => t.tags || []));
  if (!tsList.length) {
    body.innerHTML = '<tr><td colspan="6" class="pi-log-empty">no testsuites yet</td></tr>';
    return;
  }
  body.innerHTML = tsList.map(s => `
    <tr>
      <td class="ts-name-cell">${tcEsc(s.name)}${s.description ? `<div class="hint pkg-desc">${tcEsc(s.description)}</div>` : ''}</td>
      <td class="res-num">${s.testcase_ids.length}</td>
      <td class="pkg-tags">${pkgTagChips(s.tags, 'ts')}</td>
      <td class="kt-author">${tcEsc(s.author || '')}</td>
      <td class="res-date">${ktDateTimeHtml(s.updated_at)}</td>
      <td class="capture-actions">
        <button class="icon-btn ts-run-btn" data-id="${s.id}" title="Run">&#9654;</button>
        <button class="icon-btn ts-edit-btn" data-id="${s.id}" title="Edit">&#9998;</button>
        <button class="icon-btn ts-dup-btn" data-id="${s.id}" title="Duplicate">${DUPLICATE_ICON_SVG}</button>
        <button class="icon-btn ts-delete-btn" data-id="${s.id}" title="Delete">&#128465;</button>
      </td>
    </tr>
  `).join('');

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
});
