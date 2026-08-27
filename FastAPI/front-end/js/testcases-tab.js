// --- Testcases tab: build/run/manage ordered sequences of commands ---------
// A testcase is a name + ordered list of steps (action/target/params, same
// shape as the Action panel - see command-builder.js's ACTION_PARAMS), each
// with an optional delay, repeat count, and expected-result check. Running
// one dispatches its steps sequentially through the same Command/mqtt_service
// machinery every other action already uses (see routers/TestCases.py's
// _run_testcase), server-side, so a run keeps going even if this tab/page
// is closed - this tab only ever displays/polls it, never drives it itself.

let tcList = [];
let tcEditingId = null;
let tcSteps = [];
let tcActiveRunId = null;
let tcRunPollTimer = null;

// Pagination is server-side (GET /testcases?offset=&limit=, total in the
// X-Total-Count header) - tcList only ever holds the page on screen, so
// nothing here may assume it contains every testcase.
let tcPage = 0;
let tcPageSize = 25;
let tcTotal = 0;

// Ids ticked in the table's checkbox column. A Set of ids rather than a
// per-row flag because it deliberately survives paging: tick three rows on
// page 1, page forward, tick two more, and Delete acts on all five. The
// header checkbox is "select all on this page" only, which is why it
// reflects the current page's rows rather than this whole set.
let tcSelected = new Set();

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// set_interface_defaults is a frontend-only action (see command-builder.js -
// no MQTT round-trip, applied via a PUT to /pis/.../interfaces/.../default)
// with no pi_agent-side handler, so it isn't offered as a testcase step -
// dispatching it as a real command would just fail with "unknown action".
const TC_ACTIONS = Object.keys(ACTION_PARAMS).filter(a => a !== 'set_interface_defaults');
const TC_EXPECTED_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'];

function newTcStep() {
  return { action: TC_ACTIONS[0], target: 'all', target_pi_ids: [], params: {}, delay_before_seconds: 0, repeat_count: 1, expected: null };
}

// --- view switching ---------------------------------------------------

function tcHideAllViews() {
  document.getElementById('tcListView').classList.add('hidden');
  document.getElementById('tcRunView').classList.add('hidden');
  document.getElementById('tcRunHistoryView').classList.add('hidden');
}

function stopTcRunPolling() {
  if (tcRunPollTimer) {
    clearInterval(tcRunPollTimer);
    tcRunPollTimer = null;
  }
}

function showTcListView() {
  stopTcRunPolling();
  tcHideAllViews();
  document.getElementById('tcListView').classList.remove('hidden');
  // Entering the tab starts clean: a selection carried over from a previous
  // visit would arm the bulk toolbar against rows the operator can no longer
  // see, and page 3 of a stale result set is rarely where they meant to be.
  tcClearSelection();
  tcPage = 0;
  loadTestcases();
}

// New/edit testcase is a popup (see #tcEditorOverlay in index.html), not
// one of the tab's own sub-views - it opens on top of whichever of those is
// currently showing (almost always the list) instead of replacing it, and
// closing it just reveals that view again rather than navigating anywhere.
function openTcEditorModal() {
  document.getElementById('tcEditorOverlay').classList.remove('hidden');
  document.addEventListener('keydown', tcEditorModalKeydown);
}

function closeTcEditorModal() {
  document.getElementById('tcEditorOverlay').classList.add('hidden');
  document.removeEventListener('keydown', tcEditorModalKeydown);
}

function tcEditorModalKeydown(e) {
  if (e.key === 'Escape') closeTcEditorModal();
}

function showTcRunView() {
  tcHideAllViews();
  document.getElementById('tcRunView').classList.remove('hidden');
}

function showTcRunHistoryView() {
  stopTcRunPolling();
  tcHideAllViews();
  document.getElementById('tcRunHistoryView').classList.remove('hidden');
  loadTcRunHistory();
}

// --- list -----------------------------------------------------------------

// Filters narrow the whole result set, not just the visible page, so a
// changed filter has to go back to page 1 - staying on page 3 of a set that
// just shrank to 12 rows would show an empty table.
function reloadTestcasesFromFirstPage() {
  tcPage = 0;
  loadTestcases();
}

async function loadTestcases() {
  const q = document.getElementById('tcSearchInput').value.trim();
  const tag = document.getElementById('tcTagFilterInput').value.trim();
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    params.set('offset', tcPage * tcPageSize);
    params.set('limit', tcPageSize);
    const res = await apiFetch(`${API}/testcases?${params}`);
    if (!res.ok) return;
    tcList = await res.json();
    // Absent only if something upstream strips the header; falling back to
    // the page length keeps the pager coherent (single page) rather than
    // rendering "1-25 of 0".
    const total = Number(res.headers.get('X-Total-Count'));
    tcTotal = Number.isFinite(total) && total >= 0 ? total : tcList.length;

    // A page can empty out under us - the last row deleted, or a filter
    // narrowing the set - in which case step back rather than showing an
    // empty table with pages still listed after it.
    if (!tcList.length && tcPage > 0 && tcTotal > 0) {
      tcPage = Math.max(0, Math.ceil(tcTotal / tcPageSize) - 1);
      await loadTestcases();
      return;
    }
    renderTcTable();
    renderTcPager();
    tcRenderBulkBar();
  } catch {
    // backend unreachable; keep last known list
  }
}

function renderTcTable() {
  const body = document.getElementById('tcTableBody');
  if (!tcList.length) {
    body.innerHTML = '<tr><td colspan="8" class="pi-log-empty">no testcases yet</td></tr>';
    tcSyncSelectAllCheckbox();
    return;
  }
  body.innerHTML = tcList.map(t => `
    <tr class="${tcSelected.has(t.id) ? 'tc-row-selected' : ''}" data-id="${t.id}">
      <td class="tc-check-col"><input type="checkbox" class="tc-row-check" data-id="${t.id}" ${tcSelected.has(t.id) ? 'checked' : ''}></td>
      <td>${t.name}</td>
      <td>${(t.tags || []).join(', ')}</td>
      <td>${t.status}</td>
      <td>${t.steps.length}</td>
      <td>${t.author || ''}</td>
      <td>${formatVnDateTime(t.updated_at)}</td>
      <td class="capture-actions">
        <button class="icon-btn tc-run-btn" data-id="${t.id}" title="Run">&#9654;</button>
        <button class="icon-btn tc-edit-btn" data-id="${t.id}" title="Edit">&#9998;</button>
        <button class="icon-btn tc-dup-btn" data-id="${t.id}" title="Duplicate">${DUPLICATE_ICON_SVG}</button>
        <button class="icon-btn tc-delete-btn" data-id="${t.id}" title="Delete">&#128465;</button>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('.tc-run-btn').forEach(btn => btn.addEventListener('click', () => runTestcaseById(btn.dataset.id)));
  body.querySelectorAll('.tc-edit-btn').forEach(btn => btn.addEventListener('click', () => openEditTestcase(btn.dataset.id)));
  body.querySelectorAll('.tc-dup-btn').forEach(btn => btn.addEventListener('click', () => duplicateTestcase(btn.dataset.id)));
  body.querySelectorAll('.tc-delete-btn').forEach(btn => btn.addEventListener('click', () => deleteTestcase(btn.dataset.id)));
  body.querySelectorAll('.tc-row-check').forEach(cb => cb.addEventListener('change', () => {
    const id = Number(cb.dataset.id);
    if (cb.checked) tcSelected.add(id); else tcSelected.delete(id);
    cb.closest('tr').classList.toggle('tc-row-selected', cb.checked);
    tcSyncSelectAllCheckbox();
    tcRenderBulkBar();
  }));
  tcSyncSelectAllCheckbox();
}

// --- selection + bulk toolbar --------------------------------------------

function tcPageIds() {
  return tcList.map(t => t.id);
}

// Header checkbox tracks only the rows on screen (it is "select all on this
// page"), and shows indeterminate when the page is partly selected.
function tcSyncSelectAllCheckbox() {
  const all = document.getElementById('tcSelectAll');
  if (!all) return;
  const ids = tcPageIds();
  const selectedHere = ids.filter(id => tcSelected.has(id)).length;
  all.checked = ids.length > 0 && selectedHere === ids.length;
  all.indeterminate = selectedHere > 0 && selectedHere < ids.length;
}

function tcRenderBulkBar() {
  const n = tcSelected.size;
  document.getElementById('tcBulkCount').textContent =
    n ? `${n} selected` : 'none selected';
  ['tcBulkRunBtn', 'tcBulkDuplicateBtn', 'tcBulkTagBtn', 'tcBulkExportBtn', 'tcBulkDeleteBtn']
    .forEach(id => { document.getElementById(id).disabled = n === 0; });
}

function tcClearSelection() {
  tcSelected.clear();
  tcRenderBulkBar();
}

function tcSelectedIds() {
  return [...tcSelected];
}

// --- pager ---------------------------------------------------------------

// CDRouter-style: a range summary, First/Previous, numbered pages, then
// Next/Last. Page numbers are windowed around the current page so a large
// set doesn't render a hundred buttons.
function renderTcPager() {
  const el = document.getElementById('tcPager');
  const pageCount = Math.max(1, Math.ceil(tcTotal / tcPageSize));
  if (tcTotal === 0) {
    el.innerHTML = '';
    return;
  }
  const first = tcPage * tcPageSize + 1;
  const last = Math.min(tcTotal, first + tcList.length - 1);

  const windowSize = 5;
  let start = Math.max(0, tcPage - Math.floor(windowSize / 2));
  const end = Math.min(pageCount, start + windowSize);
  start = Math.max(0, end - windowSize);

  const numbered = [];
  for (let p = start; p < end; p++) {
    numbered.push(
      `<button type="button" class="tc-pager-page${p === tcPage ? ' tc-pager-current' : ''}" data-page="${p}">${p + 1}</button>`
    );
  }

  el.innerHTML = `
    <span class="tc-pager-range">${first}-${last} of ${tcTotal} testcase${tcTotal === 1 ? '' : 's'}</span>
    <button type="button" data-page="0" ${tcPage === 0 ? 'disabled' : ''}>First</button>
    <button type="button" data-page="${tcPage - 1}" ${tcPage === 0 ? 'disabled' : ''}>Previous</button>
    ${numbered.join('')}
    <button type="button" data-page="${tcPage + 1}" ${tcPage >= pageCount - 1 ? 'disabled' : ''}>Next</button>
    <button type="button" data-page="${pageCount - 1}" ${tcPage >= pageCount - 1 ? 'disabled' : ''}>Last</button>
    <select id="tcPageSizeSelect" class="tc-pager-size" title="Rows per page">
      ${[10, 25, 50, 100].map(n => `<option value="${n}" ${n === tcPageSize ? 'selected' : ''}>${n} / page</option>`).join('')}
    </select>
  `;

  el.querySelectorAll('button[data-page]').forEach(btn => btn.addEventListener('click', () => {
    const p = Number(btn.dataset.page);
    if (p < 0 || p >= pageCount || p === tcPage) return;
    tcPage = p;
    loadTestcases();
  }));
  document.getElementById('tcPageSizeSelect').addEventListener('change', (e) => {
    tcPageSize = Number(e.target.value) || 25;
    tcPage = 0;
    loadTestcases();
  });
}

// --- bulk actions --------------------------------------------------------

async function tcBulkPost(path, body, failLabel) {
  const res = await apiFetch(`${API}/testcases/bulk/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${failLabel}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function bulkRunSelected() {
  const ids = tcSelectedIds();
  if (!ids.length) return;
  if (!confirm(`Start ${ids.length} testcase run${ids.length === 1 ? '' : 's'}?`)) return;
  try {
    const runs = await tcBulkPost('run', { ids }, 'Failed to start runs');
    tcClearSelection();
    // One selection, several independent runs - there is no single run view
    // to land on, so show the history (where they all appear) unless it was
    // really just one, which behaves exactly like the row's own Run button.
    if (runs.length === 1) openRunView(runs[0].id);
    else showTcRunHistoryView();
  } catch (err) {
    alert(err.message);
  }
}

async function bulkDuplicateSelected() {
  const ids = tcSelectedIds();
  if (!ids.length) return;
  try {
    await tcBulkPost('duplicate', { ids }, 'Failed to duplicate');
    tcClearSelection();
    await loadTestcases();
  } catch (err) {
    alert(err.message);
  }
}

async function bulkDeleteSelected() {
  const ids = tcSelectedIds();
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} testcase${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  try {
    await tcBulkPost('delete', { ids }, 'Failed to delete');
    tcClearSelection();
    await loadTestcases();
  } catch (err) {
    alert(err.message);
  }
}

// Fetched rather than linked: every /testcases route is behind a Bearer
// token (see apiFetch), which a plain <a download> would not send.
async function bulkExportSelected() {
  const ids = tcSelectedIds();
  if (!ids.length) return;
  try {
    const res = await apiFetch(`${API}/testcases/bulk/export?ids=${ids.join(',')}`);
    if (!res.ok) { alert(`Failed to export: ${res.status} ${await res.text()}`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'testcases.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Failed to export: ${err.message}`);
  }
}

function openTcBulkTagModal() {
  if (!tcSelected.size) return;
  const n = tcSelected.size;
  document.getElementById('tcBulkTagTarget').textContent =
    `${n} testcase${n === 1 ? '' : 's'} selected`;
  document.getElementById('tcBulkTagInput').value = '';
  document.getElementById('tcBulkTagMode').value = 'add';
  document.getElementById('tcBulkTagOverlay').classList.remove('hidden');
}

function closeTcBulkTagModal() {
  document.getElementById('tcBulkTagOverlay').classList.add('hidden');
}

async function applyTcBulkTag() {
  const ids = tcSelectedIds();
  if (!ids.length) return;
  const tags = document.getElementById('tcBulkTagInput').value
    .split(',').map(s => s.trim()).filter(Boolean);
  const mode = document.getElementById('tcBulkTagMode').value;
  if (!tags.length && mode !== 'set') {
    alert('Enter at least one tag.');
    return;
  }
  try {
    await tcBulkPost('tag', { ids, tags, mode }, 'Failed to tag');
    closeTcBulkTagModal();
    tcClearSelection();
    await loadTestcases();
  } catch (err) {
    alert(err.message);
  }
}

async function duplicateTestcase(id) {
  try {
    const res = await apiFetch(`${API}/testcases/${id}/duplicate`, { method: 'POST' });
    if (!res.ok) { alert(`Failed to duplicate: ${res.status} ${await res.text()}`); return; }
    await loadTestcases();
  } catch (err) {
    alert(`Failed to duplicate: ${err.message}`);
  }
}

async function deleteTestcase(id) {
  if (!confirm('Delete this testcase? This cannot be undone.')) return;
  try {
    const res = await apiFetch(`${API}/testcases/${id}`, { method: 'DELETE' });
    if (!res.ok) { alert(`Failed to delete: ${res.status} ${await res.text()}`); return; }
    // Drop it from the selection too, or the bulk toolbar keeps counting a
    // row that no longer exists.
    tcSelected.delete(Number(id));
    await loadTestcases();
  } catch (err) {
    alert(`Failed to delete: ${err.message}`);
  }
}

// --- step builder -----------------------------------------------------

// An "interface" param field offers a dropdown of the target Pi's own known
// interfaces when the step targets exactly one Pi; for "all"/"multicast" -
// where the resolved Pi(s) aren't fixed until run time - it falls back to a
// plain text field (the operator types the interface name directly, e.g.
// "wlan0"), since there's no single Pi to source a dropdown from.
function tcInterfacesForTarget(target) {
  if (target === 'all' || target === 'multicast' || !target) return null;
  const pi = pis.find(p => p.pi_id === target);
  return (pi && pi.metadata && Array.isArray(pi.metadata.interfaces)) ? pi.metadata.interfaces : [];
}

function renderTcStepParamFields(container, step) {
  const fields = ACTION_PARAMS[step.action] || [];
  const interfaces = tcInterfacesForTarget(step.target);
  container.innerHTML = fields.map(f => {
    const saved = step.params[f.name];
    if (f.type === 'interface') {
      if (interfaces === null) {
        return `<label>${f.label}</label><input type="text" class="field tc-step-param" data-param="${f.name}" placeholder="interface name (e.g. wlan0)" value="${saved || ''}">`;
      }
      return `
        <label>${f.label}</label>
        <select class="field tc-step-param" data-param="${f.name}">
          <option value="">(select interface)</option>
          ${interfaces.map(i => `<option value="${i}" ${saved === i ? 'selected' : ''}>${i}</option>`).join('')}
        </select>
      `;
    }
    if (f.type === 'password') {
      const value = saved !== undefined ? saved : (f.default !== undefined ? f.default : '');
      return `
        <label>${f.label}</label>
        <div class="password-wrap">
          <input class="field tc-step-param" data-param="${f.name}" type="password" value="${value}">
          <button type="button" class="password-toggle" title="Show password">${EYE_ICON_SVG}</button>
        </div>
      `;
    }
    if (f.type === 'select') {
      return `
        <label>${f.label}</label>
        <select class="field tc-step-param" data-param="${f.name}">
          ${f.options.map(o => `<option value="${o.value}" ${saved === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      `;
    }
    const value = saved !== undefined ? saved : (f.default !== undefined ? f.default : '');
    return `<label>${f.label}</label><input class="field tc-step-param" data-param="${f.name}" type="${f.type}" value="${value}">`;
  }).join('') || '<div class="hint">this action has no parameters</div>';
}

function collectTcStepParams(card) {
  const params = {};
  card.querySelectorAll('.tc-step-param').forEach(el => {
    const name = el.dataset.param;
    if (el.value === '') return;
    params[name] = el.type === 'number' ? Number(el.value) : el.value;
  });
  return params;
}

function tcStepCardHtml(step, i) {
  const expected = step.expected || {};
  return `
    <div class="tc-step-card" data-index="${i}">
      <div class="tc-step-header">
        <span class="tc-step-num">#${i + 1}</span>
        <select class="field tc-step-action">
          ${TC_ACTIONS.map(a => `<option value="${a}" ${a === step.action ? 'selected' : ''}>${actionLabel(a)}</option>`).join('')}
        </select>
        <span class="tc-step-controls">
          <button type="button" class="icon-btn tc-step-up" title="Move up">&#8593;</button>
          <button type="button" class="icon-btn tc-step-down" title="Move down">&#8595;</button>
          <button type="button" class="icon-btn tc-step-remove" title="Remove step">&#128465;</button>
        </span>
      </div>
      <div class="tc-step-body">
        <label>Target</label>
        <select class="field tc-step-target">
          <option value="all" ${step.target === 'all' ? 'selected' : ''}>all (broadcast)</option>
          <option value="multicast" ${step.target === 'multicast' ? 'selected' : ''}>multicast (choose Pis)</option>
          ${pis.map(p => `<option value="${p.pi_id}" ${step.target === p.pi_id ? 'selected' : ''}>${p.pi_id}</option>`).join('')}
        </select>
        <div class="tc-step-multicast-list${step.target === 'multicast' ? '' : ' hidden'}">
          ${pis.map(p => `
            <label class="tc-step-multicast-item">
              <input type="checkbox" value="${p.pi_id}" ${step.target_pi_ids.includes(p.pi_id) ? 'checked' : ''}> ${p.pi_id}
            </label>
          `).join('') || '<div class="hint">no Pis registered</div>'}
        </div>

        <div class="tc-step-params"></div>

        <div class="row">
          <div>
            <label>Delay before (s)</label>
            <input type="number" class="field tc-step-delay" min="0" step="0.5" value="${step.delay_before_seconds}">
          </div>
          <div>
            <label>Repeat this step</label>
            <input type="number" class="field tc-step-repeat" min="1" value="${step.repeat_count}">
          </div>
        </div>

        <label class="tc-step-expected-toggle-row">
          <input type="checkbox" class="tc-step-expected-toggle" ${step.expected ? 'checked' : ''}> Expect a specific result
        </label>
        <div class="tc-step-expected${step.expected ? '' : ' hidden'}">
          <label>Result field (dot path; blank = whole result)</label>
          <input type="text" class="field tc-step-expected-field" placeholder="e.g. connected" value="${expected.field || ''}">
          <label>Operator</label>
          <select class="field tc-step-expected-op">
            ${TC_EXPECTED_OPS.map(op => `<option value="${op}" ${expected.op === op ? 'selected' : ''}>${op}</option>`).join('')}
          </select>
          <label>Value</label>
          <input type="text" class="field tc-step-expected-value" placeholder="true / 5 / text (JSON-parsed if valid)"
            value="${expected.value !== undefined && expected.value !== null ? JSON.stringify(expected.value) : ''}">
        </div>
      </div>
    </div>
  `;
}

function wireTcStepCard(i) {
  const card = document.querySelector(`#tcStepsList .tc-step-card[data-index="${i}"]`);
  if (!card) return;
  const step = tcSteps[i];
  const paramsContainer = card.querySelector('.tc-step-params');
  renderTcStepParamFields(paramsContainer, step);

  // Live re-render of the params sub-section on action/target change - the
  // rest of a step's fields are only ever read back from the DOM at
  // save/reorder time (see syncTcStepsFromDom), since nothing else here
  // needs to react to them immediately.
  card.querySelector('.tc-step-action').addEventListener('change', (e) => {
    renderTcStepParamFields(paramsContainer, { action: e.target.value, target: card.querySelector('.tc-step-target').value, params: {} });
  });
  card.querySelector('.tc-step-target').addEventListener('change', (e) => {
    const target = e.target.value;
    card.querySelector('.tc-step-multicast-list').classList.toggle('hidden', target !== 'multicast');
    renderTcStepParamFields(paramsContainer, { action: card.querySelector('.tc-step-action').value, target, params: collectTcStepParams(card) });
  });
  card.querySelector('.tc-step-expected-toggle').addEventListener('change', (e) => {
    card.querySelector('.tc-step-expected').classList.toggle('hidden', !e.target.checked);
  });

  card.querySelector('.tc-step-up').addEventListener('click', () => moveTcStep(i, -1));
  card.querySelector('.tc-step-down').addEventListener('click', () => moveTcStep(i, 1));
  card.querySelector('.tc-step-remove').addEventListener('click', () => removeTcStep(i));
}

function renderTcSteps() {
  const list = document.getElementById('tcStepsList');
  list.innerHTML = tcSteps.length
    ? tcSteps.map((step, i) => tcStepCardHtml(step, i)).join('')
    : '<div class="pi-log-empty">no steps yet - add one below</div>';
  tcSteps.forEach((_, i) => wireTcStepCard(i));
}

// Reads every step card's live DOM state back into tcSteps - required
// before any structural change (add/remove/reorder) or a save, since
// renderTcSteps() rebuilds the DOM from tcSteps and would otherwise lose
// whatever's currently typed into every other step's fields.
function syncTcStepsFromDom() {
  document.querySelectorAll('#tcStepsList .tc-step-card').forEach(card => {
    const i = Number(card.dataset.index);
    const step = tcSteps[i];
    if (!step) return;
    step.action = card.querySelector('.tc-step-action').value;
    step.target = card.querySelector('.tc-step-target').value;
    step.target_pi_ids = [...card.querySelectorAll('.tc-step-multicast-list input[type="checkbox"]:checked')].map(cb => cb.value);
    step.delay_before_seconds = Number(card.querySelector('.tc-step-delay').value) || 0;
    step.repeat_count = Math.max(1, Number(card.querySelector('.tc-step-repeat').value) || 1);
    step.params = collectTcStepParams(card);

    if (card.querySelector('.tc-step-expected-toggle').checked) {
      const rawValue = card.querySelector('.tc-step-expected-value').value;
      let value = rawValue;
      try { value = JSON.parse(rawValue); } catch { /* keep as a plain string */ }
      step.expected = {
        field: card.querySelector('.tc-step-expected-field').value || null,
        op: card.querySelector('.tc-step-expected-op').value,
        value,
      };
    } else {
      step.expected = null;
    }
  });
}

function addTcStep() {
  syncTcStepsFromDom();
  tcSteps.push(newTcStep());
  renderTcSteps();
}

function removeTcStep(i) {
  syncTcStepsFromDom();
  tcSteps.splice(i, 1);
  renderTcSteps();
}

function moveTcStep(i, dir) {
  syncTcStepsFromDom();
  const j = i + dir;
  if (j < 0 || j >= tcSteps.length) return;
  [tcSteps[i], tcSteps[j]] = [tcSteps[j], tcSteps[i]];
  renderTcSteps();
}

// --- editor: open/save -------------------------------------------------

function openNewTestcase() {
  tcEditingId = null;
  tcSteps = [];
  document.getElementById('tcEditorTitle').textContent = 'New Testcase';
  document.getElementById('tcName').value = '';
  document.getElementById('tcDescription').value = '';
  document.getElementById('tcTags').value = '';
  document.getElementById('tcAuthor').value = '';
  document.getElementById('tcStopOnFailure').checked = true;
  document.getElementById('tcRepeatCount').value = 1;
  renderTcSteps();
  openTcEditorModal();
}

async function openEditTestcase(id) {
  try {
    const res = await apiFetch(`${API}/testcases/${id}`);
    if (!res.ok) { alert('Failed to load testcase.'); return; }
    const t = await res.json();
    tcEditingId = t.id;
    tcSteps = t.steps.map(s => ({ ...s, target_pi_ids: s.target_pi_ids || [] }));
    document.getElementById('tcEditorTitle').textContent = `Edit: ${t.name}`;
    document.getElementById('tcName').value = t.name;
    document.getElementById('tcDescription').value = t.description || '';
    document.getElementById('tcTags').value = (t.tags || []).join(', ');
    document.getElementById('tcAuthor').value = t.author || '';
    document.getElementById('tcStopOnFailure').checked = t.stop_on_failure;
    document.getElementById('tcRepeatCount').value = t.repeat_count;
    renderTcSteps();
    openTcEditorModal();
  } catch (err) {
    alert(`Failed to load testcase: ${err.message}`);
  }
}

function collectTestcaseFromForm() {
  syncTcStepsFromDom();
  const tags = document.getElementById('tcTags').value.split(',').map(s => s.trim()).filter(Boolean);
  return {
    name: document.getElementById('tcName').value.trim(),
    description: document.getElementById('tcDescription').value,
    tags,
    author: document.getElementById('tcAuthor').value,
    stop_on_failure: document.getElementById('tcStopOnFailure').checked,
    repeat_count: Math.max(1, Number(document.getElementById('tcRepeatCount').value) || 1),
    steps: tcSteps,
  };
}

async function saveTestcase(status, thenRun) {
  const body = collectTestcaseFromForm();
  body.status = status;
  if (!body.name) {
    alert('Name is required.');
    return;
  }
  try {
    const url = tcEditingId ? `${API}/testcases/${tcEditingId}` : `${API}/testcases`;
    const method = tcEditingId ? 'PUT' : 'POST';
    const res = await apiFetch(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      alert(`Failed to save: ${res.status} ${await res.text()}`);
      return;
    }
    const saved = await res.json();
    tcEditingId = saved.id;
    closeTcEditorModal();
    if (thenRun) await runTestcaseById(saved.id);
    else await loadTestcases();
  } catch (err) {
    alert(`Failed to save: ${err.message}`);
  }
}

// --- run + run history --------------------------------------------------

async function runTestcaseById(id) {
  try {
    const res = await apiFetch(`${API}/testcases/${id}/run`, { method: 'POST' });
    if (!res.ok) {
      alert(`Failed to start run: ${res.status} ${await res.text()}`);
      return;
    }
    const run = await res.json();
    openRunView(run.id);
  } catch (err) {
    alert(`Failed to start run: ${err.message}`);
  }
}

async function openRunView(runId) {
  tcActiveRunId = runId;
  showTcRunView();
  await refreshTcRun();
  stopTcRunPolling();
  tcRunPollTimer = setInterval(refreshTcRun, 1500);
}

async function refreshTcRun() {
  if (!tcActiveRunId) return;
  try {
    const res = await apiFetch(`${API}/testcases/runs/${tcActiveRunId}`);
    if (!res.ok) return;
    const run = await res.json();
    renderTcRunView(run);
    if (run.status !== 'running') stopTcRunPolling();
  } catch {
    // transient; the next tick retries
  }
}

function tcStatusClass(status) {
  if (status === 'passed') return 'complete';
  if (status === 'failed' || status === 'timeout') return 'failed';
  return 'pending';
}

function renderTcRunView(run) {
  document.getElementById('tcRunTitle').textContent = `Run: ${run.testcase_name}`;
  const statusEl = document.getElementById('tcRunStatus');
  statusEl.textContent = run.status;
  statusEl.className = `cmd-status ${tcStatusClass(run.status)}`;

  const stepsEl = document.getElementById('tcRunSteps');
  const totalPlanned = run.steps.reduce((n, s) => n + Math.max(1, s.repeat_count || 1), 0) * Math.max(1, run.repeat_count);

  stepsEl.innerHTML = run.results.length
    ? run.results.map(r => `
        <div class="cmd-entry">
          <div class="hdr">
            <span>Step ${r.step_index + 1}: ${actionLabel(r.action)}</span>
            <span class="cmd-status ${tcStatusClass(r.status)}">${r.status}</span>
          </div>
          <div class="result">
            <table class="result-table">
              ${r.entries.map(e => `
                <tr>
                  <td class="result-key">${e.pi_id || '(unresolved target)'}</td>
                  <td class="result-value">${e.status}${e.reason ? ' — ' + e.reason : ''}${e.error ? ' — ' + e.error : ''}</td>
                </tr>
              `).join('')}
            </table>
          </div>
        </div>
      `).join('')
    : '<div class="pi-log-empty">starting…</div>';

  if (run.status === 'running' && run.results.length < totalPlanned) {
    stepsEl.insertAdjacentHTML('beforeend', '<div class="pi-log-empty">running…</div>');
  }
}

async function loadTcRunHistory() {
  try {
    const res = await apiFetch(`${API}/testcases/runs?limit=100`);
    if (!res.ok) return;
    const runs = await res.json();
    const body = document.getElementById('tcRunHistoryBody');
    body.innerHTML = runs.length
      ? runs.map(r => `
          <tr>
            <td>${r.testcase_name}</td>
            <td><span class="cmd-status ${tcStatusClass(r.status)}">${r.status}</span></td>
            <td>${formatVnDateTime(r.started_at)}</td>
            <td>${r.completed_at ? formatVnDateTime(r.completed_at) : ''}</td>
            <td><button class="icon-btn tc-run-history-view-btn" data-id="${r.id}" title="View">&#9654;</button></td>
          </tr>
        `).join('')
      : '<tr><td colspan="5" class="pi-log-empty">no runs yet</td></tr>';
    body.querySelectorAll('.tc-run-history-view-btn').forEach(btn => {
      btn.addEventListener('click', () => openRunView(Number(btn.dataset.id)));
    });
  } catch {
    // backend unreachable; keep last known list
  }
}

// --- wiring -------------------------------------------------------------

document.getElementById('tcNewBtn').addEventListener('click', openNewTestcase);
document.getElementById('tcEditorCloseBtn').addEventListener('click', closeTcEditorModal);
document.getElementById('tcEditorOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'tcEditorOverlay') closeTcEditorModal();
});
document.getElementById('tcRunBackBtn').addEventListener('click', showTcListView);
document.getElementById('tcRunHistoryBtn').addEventListener('click', showTcRunHistoryView);
document.getElementById('tcRunHistoryBackBtn').addEventListener('click', showTcListView);
document.getElementById('tcAddStepBtn').addEventListener('click', addTcStep);
document.getElementById('tcSaveDraftBtn').addEventListener('click', () => saveTestcase('draft', false));
document.getElementById('tcSaveRunBtn').addEventListener('click', () => saveTestcase('ready', true));
document.getElementById('tcSearchInput').addEventListener('input', debounce(reloadTestcasesFromFirstPage, 300));
document.getElementById('tcTagFilterInput').addEventListener('input', debounce(reloadTestcasesFromFirstPage, 300));

document.getElementById('tcSelectAll').addEventListener('change', (e) => {
  const ids = tcPageIds();
  if (e.target.checked) ids.forEach(id => tcSelected.add(id));
  else ids.forEach(id => tcSelected.delete(id));
  renderTcTable();
  tcRenderBulkBar();
});
document.getElementById('tcBulkRunBtn').addEventListener('click', bulkRunSelected);
document.getElementById('tcBulkDuplicateBtn').addEventListener('click', bulkDuplicateSelected);
document.getElementById('tcBulkTagBtn').addEventListener('click', openTcBulkTagModal);
document.getElementById('tcBulkExportBtn').addEventListener('click', bulkExportSelected);
document.getElementById('tcBulkDeleteBtn').addEventListener('click', bulkDeleteSelected);
document.getElementById('tcBulkTagApplyBtn').addEventListener('click', applyTcBulkTag);
document.getElementById('tcBulkTagCancelBtn').addEventListener('click', closeTcBulkTagModal);
document.getElementById('tcBulkTagCloseBtn').addEventListener('click', closeTcBulkTagModal);
document.getElementById('tcBulkTagOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'tcBulkTagOverlay') closeTcBulkTagModal();
});

// Reset to the list view (discarding any in-progress run view) whenever
// this tab actually becomes the visible one - a click, a reload landing
// directly on #testcases, or Back/Forward navigating into it (see
// showTabView in detail-page.js), not just a literal click on the tab
// button, which would miss the other two and leave the list empty.
//
// The editor popup lives outside #testcases (see #tcEditorOverlay in
// index.html) so it stays visible across a tab switch unless explicitly
// closed here - navigating to any other tab while it's open should close
// it rather than leave it floating over unrelated content. Navigating to
// the Pi detail page (which bypasses showTabView/this event entirely) is
// handled separately, in showPiDetail (detail-page.js).
document.addEventListener('tabshown', (e) => {
  if (e.detail.viewId === 'testcases') showTcListView();
  else {
    closeTcEditorModal();
    closeTcBulkTagModal();
  }
});
