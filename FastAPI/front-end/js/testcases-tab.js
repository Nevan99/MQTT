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
  return {
    action: TC_ACTIONS[0], target: 'all', target_pi_ids: [], params: {},
    delay_before_seconds: 0, repeat_count: 1, expected: null,
    loop_group: null, loop_count: 1,
  };
}

// --- loops ---------------------------------------------------------------
// Edited as ranges ("repeat steps 2-4, three times") but *stored* on the
// steps themselves as loop_group/loop_count, which is what the backend walks
// (TestCases.py's _expand_step_plan). Keeping it inside steps_json avoids a
// new column on the live pi_fleet.db; the range view is derived back from the
// steps whenever the editor opens.

let tcLoops = [];

function tcLoopsFromSteps(steps) {
  const loops = [];
  let i = 0;
  while (i < steps.length) {
    const group = steps[i].loop_group;
    if (!group) { i++; continue; }
    let j = i;
    while (j < steps.length && steps[j].loop_group === group) j++;
    loops.push({ from: i, to: j - 1, count: Math.max(1, Number(steps[i].loop_count) || 1) });
    i = j;
  }
  return loops;
}

// Stamps the range list back onto the steps, then re-derives it. The
// round-trip is deliberate: overlapping ranges resolve by later-wins, and
// re-deriving means the editor immediately shows what actually resulted
// rather than a range list that disagrees with the steps it produced.
function applyTcLoopsToSteps() {
  tcSteps.forEach(s => { s.loop_group = null; s.loop_count = 1; });
  tcLoops.forEach((loop, idx) => {
    if (!tcSteps.length) return;
    const from = Math.max(0, Math.min(Number(loop.from) || 0, tcSteps.length - 1));
    const to = Math.max(from, Math.min(Number(loop.to) || 0, tcSteps.length - 1));
    const count = Math.max(1, Number(loop.count) || 1);
    const group = `L${idx + 1}`;
    for (let i = from; i <= to; i++) {
      tcSteps[i].loop_group = group;
      tcSteps[i].loop_count = count;
    }
  });
  tcLoops = tcLoopsFromSteps(tcSteps);
}

function tcStepOptionsHtml(selectedIndex) {
  return tcSteps.map((s, i) =>
    `<option value="${i}" ${i === selectedIndex ? 'selected' : ''}>${i + 1}. ${actionLabel(s.action)}</option>`
  ).join('');
}

function renderTcLoops() {
  const el = document.getElementById('tcLoopsList');
  if (!tcSteps.length) {
    el.innerHTML = '<div class="pi-log-empty">add steps first</div>';
    return;
  }
  el.innerHTML = tcLoops.length
    ? tcLoops.map((l, i) => `
        <div class="tc-loop-row" data-index="${i}">
          <span class="tc-loop-name">L${i + 1}</span>
          <label>steps</label>
          <select class="field tc-loop-from">${tcStepOptionsHtml(l.from)}</select>
          <label>to</label>
          <select class="field tc-loop-to">${tcStepOptionsHtml(l.to)}</select>
          <label>&times;</label>
          <input type="number" class="field tc-loop-count" min="1" value="${l.count}">
          <button type="button" class="icon-btn tc-loop-remove" title="Remove loop">&#128465;</button>
        </div>
      `).join('')
    : '<div class="pi-log-empty">no loops - each step runs once per pass</div>';

  el.querySelectorAll('.tc-loop-row').forEach(row => {
    const i = Number(row.dataset.index);
    const commit = () => {
      const from = Number(row.querySelector('.tc-loop-from').value);
      let to = Number(row.querySelector('.tc-loop-to').value);
      // A range can only run forwards; snap the end back rather than
      // rejecting the pick.
      if (to < from) { to = from; row.querySelector('.tc-loop-to').value = String(to); }
      tcLoops[i] = { from, to, count: Math.max(1, Number(row.querySelector('.tc-loop-count').value) || 1) };
      syncTcStepsFromDom();
      applyTcLoopsToSteps();
      renderTcSteps();          // refresh the per-step loop badges
      renderTcLoops();
    };
    row.querySelector('.tc-loop-from').addEventListener('change', commit);
    row.querySelector('.tc-loop-to').addEventListener('change', commit);
    row.querySelector('.tc-loop-count').addEventListener('change', commit);
    row.querySelector('.tc-loop-remove').addEventListener('click', () => {
      syncTcStepsFromDom();
      tcLoops.splice(i, 1);
      applyTcLoopsToSteps();
      renderTcSteps();
      renderTcLoops();
    });
  });
}

function addTcLoop() {
  if (!tcSteps.length) return;
  syncTcStepsFromDom();
  tcLoops.push({ from: 0, to: Math.min(1, tcSteps.length - 1), count: 2 });
  applyTcLoopsToSteps();
  renderTcSteps();
  renderTcLoops();
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
// The sentinel the backend expands per-Pi at run time (TestCases.py's
// ALL_INTERFACES). Stored instead of a frozen list so "all interfaces" keeps
// meaning that when a Pi gains or loses a dongle, and so one step can cover a
// fleet whose members don't have matching interface names.
const TC_ALL_INTERFACES = '*';

// The Pi objects this step's target resolves to, in fleet order.
function tcTargetPis(step) {
  const target = step.target;
  if (target === 'multicast') {
    const ids = step.target_pi_ids || [];
    return pis.filter(p => ids.includes(p.pi_id));
  }
  if (target && target !== 'all') return pis.filter(p => p.pi_id === target);
  return pis;
}

function tcPiInterfaces(p) {
  return (p.metadata && Array.isArray(p.metadata.interfaces)) ? p.metadata.interfaces : [];
}

// Whether the param is on "all" or an explicit selection. '*' is all;
// everything else (map, list, bare string) is a selection.
function tcIfaceMode(saved) {
  return saved === TC_ALL_INTERFACES || saved === undefined || saved === null ? 'all' : 'select';
}

// What's selected for one specific Pi, from whichever shape the value has.
// A flat list or bare string predates per-Pi selection and meant "these names
// on every Pi", so it pre-ticks here on any Pi that actually has them - which
// is what it was doing at run time anyway, minus the impossible ones.
function tcIfaceSelectedForPi(saved, pi) {
  const own = tcPiInterfaces(pi);
  if (Array.isArray(saved)) return saved.filter(i => own.includes(i));
  if (saved && typeof saved === 'object') return (saved[pi.pi_id] || []).filter(i => own.includes(i));
  if (typeof saved === 'string' && saved && saved !== TC_ALL_INTERFACES) {
    return own.includes(saved) ? [saved] : [];
  }
  return [];
}

// Flattened selection, for the single-Pi case where a plain list is stored.
function tcIfaceFlatSelection(saved) {
  if (Array.isArray(saved)) return saved;
  if (saved && typeof saved === 'object') {
    return [...new Set(Object.values(saved).flat())];
  }
  if (typeof saved === 'string' && saved && saved !== TC_ALL_INTERFACES) return [saved];
  return [];
}

function renderTcStepParamFields(container, step) {
  const fields = ACTION_PARAMS[step.action] || [];
  const targetPis = tcTargetPis(step);
  container.innerHTML = fields.map(f => {
    const saved = step.params[f.name];
    if (f.type === 'interface') {
      const mode = tcIfaceMode(saved);
      const allLabel = targetPis.length === 1
        ? `All interfaces on ${targetPis[0].pi_id}`
        : 'All interfaces on each target Pi';
      return `
        <label>${f.label}</label>
        <div class="tc-iface-param" data-param="${f.name}">
          <select class="field tc-iface-mode">
            <option value="all" ${mode === 'all' ? 'selected' : ''}>${allLabel}</option>
            <option value="select" ${mode === 'select' ? 'selected' : ''}>Selected interfaces…</option>
          </select>
          <div class="tc-iface-pick${mode === 'all' ? ' hidden' : ''}"></div>
        </div>
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

  container.querySelectorAll('.tc-iface-param').forEach(wrap => {
    const saved = step.params[wrap.dataset.param];
    const pick = wrap.querySelector('.tc-iface-pick');

    if (targetPis.length === 1) {
      // One Pi: the Action panel's own widget (fleet-table.js's
      // buildIfaceDropdown/setDropdownOptions, which already has the "Select
      // all" row), listing exactly that Pi's radios. Stored as a plain list -
      // no need to name the Pi when there's only one, and a flat list stays
      // correct if the target is later pointed at a different Pi.
      const box = buildIfaceDropdown();
      setDropdownOptions(box, tcPiInterfaces(targetPis[0]), tcIfaceFlatSelection(saved));
      pick.appendChild(box);
    } else {
      // Several Pis: one section each, listing only that Pi's own radios, so
      // pi01's wlan1 and pi03's wlan1 are separately checkable and an
      // interface a Pi doesn't have can't be picked for it at all. Stored as
      // a {pi_id: [...]} map - see _resolve_iface_value.
      pick.innerHTML = targetPis.length
        ? targetPis.map(p => {
            const own = tcPiInterfaces(p);
            const sel = tcIfaceSelectedForPi(saved, p);
            return `
              <div class="tc-iface-pi" data-pi="${p.pi_id}">
                <label class="tc-iface-pi-hdr">
                  <input type="checkbox" class="tc-iface-pi-all">
                  <span class="tc-iface-pi-name">${p.pi_id}</span>
                  <span class="hint">${own.length ? `${own.length} interface(s)` : 'none reported'}</span>
                </label>
                <div class="tc-iface-pi-list">
                  ${own.map(i => `
                    <label class="iface-row">
                      <input type="checkbox" value="${i}" ${sel.includes(i) ? 'checked' : ''}>${i}
                    </label>
                  `).join('') || '<div class="hint">no interfaces reported for this Pi</div>'}
                </div>
              </div>`;
          }).join('')
        : '<div class="hint">no Pis targeted - pick some above</div>';

      pick.querySelectorAll('.tc-iface-pi').forEach(section => {
        const all = section.querySelector('.tc-iface-pi-all');
        const items = [...section.querySelectorAll('.tc-iface-pi-list input[type="checkbox"]')];
        const sync = () => {
          const n = items.filter(cb => cb.checked).length;
          all.checked = items.length > 0 && n === items.length;
          all.indeterminate = n > 0 && n < items.length;
        };
        items.forEach(cb => cb.addEventListener('change', sync));
        all.addEventListener('change', () => {
          items.forEach(cb => { cb.checked = all.checked; });
          all.indeterminate = false;
        });
        sync();
      });
    }

    const modeSel = wrap.querySelector('.tc-iface-mode');
    modeSel.addEventListener('change', () => {
      pick.classList.toggle('hidden', modeSel.value === 'all');
    });
  });
}

// The step as the card currently reads, for the renderers that need to know
// the action/target/params without a full syncTcStepsFromDom. target_pi_ids
// matters as much as target here: the interface picker is per-Pi, so
// "multicast" alone doesn't say which Pis to show.
function tcStepShapeFromCard(card, overrides = {}) {
  return {
    action: card.querySelector('.tc-step-action').value,
    target: card.querySelector('.tc-step-target').value,
    target_pi_ids: [...card.querySelectorAll('.tc-step-multicast-list input[type="checkbox"]:checked')]
      .map(cb => cb.value),
    params: collectTcStepParams(card),
    ...overrides,
  };
}

function collectTcStepParams(card) {
  const params = {};
  card.querySelectorAll('.tc-step-param').forEach(el => {
    const name = el.dataset.param;
    if (el.value === '') return;
    params[name] = el.type === 'number' ? Number(el.value) : el.value;
  });
  card.querySelectorAll('.tc-iface-param').forEach(wrap => {
    const name = wrap.dataset.param;
    if (wrap.querySelector('.tc-iface-mode').value === 'all') {
      params[name] = TC_ALL_INTERFACES;
      return;
    }

    const sections = [...wrap.querySelectorAll('.tc-iface-pi')];
    if (sections.length) {
      // Per-Pi map. Pis with nothing ticked are left out entirely rather than
      // given an empty list - that absence is what tells the backend to skip
      // them instead of failing the step (see _selection_omits_pi).
      const map = {};
      sections.forEach(section => {
        const chosen = [...section.querySelectorAll('.tc-iface-pi-list input[type="checkbox"]:checked')]
          .map(cb => cb.value);
        if (chosen.length) map[section.dataset.pi] = chosen;
      });
      if (Object.keys(map).length) params[name] = map;
      return;
    }

    const box = wrap.querySelector('.iface-dropdown');
    const selected = box ? getDropdownSelected(box) : [];
    // Left on "Selected" with nothing ticked: omitted rather than sent as an
    // empty list, so the step reports a missing required param instead of
    // quietly resolving to no interfaces.
    if (selected.length) params[name] = selected;
  });
  return params;
}

// A step's expectations as a list, whatever shape it was saved in - matches
// the backend's _normalise_expectations, so a testcase written before the
// per-field editor existed (single {field, op, value}) still loads into it.
function tcExpectedList(step) {
  const e = step.expected;
  if (!e) return [];
  return Array.isArray(e) ? e.filter(Boolean) : [e];
}

function tcOpsForType(type) {
  return RESULT_OPS_BY_TYPE[type] || TC_EXPECTED_OPS;
}

// Renders the saved value back into its input. Strings go in bare (so
// `ip_address eq 192.168.1.5` shows the address, not a quoted one); anything
// else is JSON so booleans/numbers/objects round-trip.
function tcExpectedValueText(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function tcExpectedValueInputHtml(field, check) {
  const value = check ? check.value : undefined;
  if (field.type === 'boolean') {
    return `
      <select class="field tc-expect-value" data-vtype="boolean">
        <option value="true" ${value === true ? 'selected' : ''}>true</option>
        <option value="false" ${value === false ? 'selected' : ''}>false</option>
      </select>`;
  }
  const inputType = field.type === 'number' ? 'number' : 'text';
  return `<input type="${inputType}" class="field tc-expect-value" data-vtype="${field.type || 'text'}"
    placeholder="expected value" value="${tcExpectedValueText(value)}">`;
}

function tcExpectRowHtml(field, check) {
  const on = !!check;
  const ops = tcOpsForType(field.type);
  const op = check ? check.op : ops[0];
  // "exists" takes no value - hide the input rather than leave a box that
  // does nothing.
  const valueHidden = op === 'exists' ? ' hidden' : '';
  return `
    <div class="tc-expect-row${on ? '' : ' tc-expect-off'}" data-field="${field.name}" data-type="${field.type || 'text'}">
      <label class="tc-expect-check">
        <input type="checkbox" class="tc-expect-on" ${on ? 'checked' : ''}>
        <span class="tc-expect-name">${field.name}</span>
      </label>
      <select class="field tc-expect-op">
        ${ops.map(o => `<option value="${o}" ${o === op ? 'selected' : ''}>${o}</option>`).join('')}
      </select>
      <span class="tc-expect-value-wrap${valueHidden}">${tcExpectedValueInputHtml(field, check)}</span>
    </div>`;
}

// Fields the saved checks reference that aren't in this action's known list -
// a nested path, or a field added to pi_agent since ACTION_RESULT_FIELDS was
// last updated. Kept as editable custom rows so opening an old testcase never
// silently drops an assertion it was relying on.
function tcCustomExpectRowHtml(check, i) {
  const ops = TC_EXPECTED_OPS;
  const op = check ? check.op : 'eq';
  return `
    <div class="tc-expect-row tc-expect-custom${check ? '' : ' tc-expect-off'}" data-custom="${i}">
      <label class="tc-expect-check">
        <input type="checkbox" class="tc-expect-on" ${check ? 'checked' : ''}>
        <input type="text" class="field tc-expect-field" placeholder="other field (dot path)"
          value="${check ? (check.field || '') : ''}">
      </label>
      <select class="field tc-expect-op">
        ${ops.map(o => `<option value="${o}" ${o === op ? 'selected' : ''}>${o}</option>`).join('')}
      </select>
      <span class="tc-expect-value-wrap${op === 'exists' ? ' hidden' : ''}">
        <input type="text" class="field tc-expect-value" data-vtype="text" placeholder="expected value"
          value="${check ? tcExpectedValueText(check.value) : ''}">
      </span>
    </div>`;
}

function renderTcStepExpectedFields(container, step) {
  const fields = resultFieldsForAction(step.action);
  const checks = tcExpectedList(step);
  const byField = new Map(checks.filter(c => c.field).map(c => [c.field, c]));

  const known = fields.map(f => tcExpectRowHtml(f, byField.get(f.name)));
  const knownNames = new Set(fields.map(f => f.name));
  // Anything saved that this action's list doesn't cover, plus one blank row
  // to add another.
  const custom = checks.filter(c => !c.field || !knownNames.has(c.field));
  const customRows = [...custom.map((c, i) => tcCustomExpectRowHtml(c, i)),
                      tcCustomExpectRowHtml(null, custom.length)];

  container.innerHTML = `
    <div class="hint tc-expect-hint">Tick each result field to assert on. All ticked checks must pass.</div>
    <div class="tc-expect-rows">${known.join('')}${customRows.join('')}</div>`;

  container.querySelectorAll('.tc-expect-row').forEach(row => {
    const on = row.querySelector('.tc-expect-on');
    const op = row.querySelector('.tc-expect-op');
    on.addEventListener('change', () => row.classList.toggle('tc-expect-off', !on.checked));
    op.addEventListener('change', () => {
      row.querySelector('.tc-expect-value-wrap').classList.toggle('hidden', op.value === 'exists');
    });
    // Typing a path into a blank custom row is the intent to use it - saves
    // having to also tick the box.
    const fieldInput = row.querySelector('.tc-expect-field');
    if (fieldInput) {
      fieldInput.addEventListener('input', () => {
        if (fieldInput.value.trim() && !on.checked) {
          on.checked = true;
          row.classList.remove('tc-expect-off');
        }
      });
    }
  });
}

function collectTcStepExpected(card) {
  if (!card.querySelector('.tc-step-expected-toggle').checked) return null;
  const checks = [];
  card.querySelectorAll('.tc-expect-row').forEach(row => {
    if (!row.querySelector('.tc-expect-on').checked) return;
    const fieldInput = row.querySelector('.tc-expect-field');
    const field = fieldInput ? fieldInput.value.trim() : row.dataset.field;
    if (fieldInput && !field) return;          // blank custom row - ignore

    const op = row.querySelector('.tc-expect-op').value;
    if (op === 'exists') {
      checks.push({ field, op, value: null });
      return;
    }
    const valueEl = row.querySelector('.tc-expect-value');
    const raw = valueEl ? valueEl.value : '';
    let value = raw;
    if (valueEl && valueEl.dataset.vtype === 'boolean') value = raw === 'true';
    else if (valueEl && valueEl.dataset.vtype === 'number') value = raw === '' ? null : Number(raw);
    else {
      // Same rule as before the per-field editor: JSON if it parses (so
      // true/5/["a"] mean what they look like), otherwise a plain string.
      try { value = JSON.parse(raw); } catch { /* keep as a plain string */ }
    }
    checks.push({ field, op, value });
  });
  return checks.length ? checks : null;
}

function tcStepCardHtml(step, i) {
  const expected = tcExpectedList(step);
  return `
    <div class="tc-step-card" data-index="${i}">
      <div class="tc-step-header">
        <span class="tc-step-num">#${i + 1}</span>
        ${step.loop_group ? `<span class="tc-step-loop-badge" title="Repeats with loop ${step.loop_group}">${step.loop_group} &times;${step.loop_count}</span>` : ''}
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
          <input type="checkbox" class="tc-step-expected-toggle" ${expected.length ? 'checked' : ''}> Expect specific results
        </label>
        <div class="tc-step-expected${expected.length ? '' : ' hidden'}"></div>
      </div>
    </div>
  `;
}

function wireTcStepCard(i) {
  const card = document.querySelector(`#tcStepsList .tc-step-card[data-index="${i}"]`);
  if (!card) return;
  const step = tcSteps[i];
  const paramsContainer = card.querySelector('.tc-step-params');
  const expectedContainer = card.querySelector('.tc-step-expected');
  renderTcStepParamFields(paramsContainer, step);
  renderTcStepExpectedFields(expectedContainer, step);

  // Live re-render of the params sub-section on action/target change - the
  // rest of a step's fields are only ever read back from the DOM at
  // save/reorder time (see syncTcStepsFromDom), since nothing else here
  // needs to react to them immediately.
  card.querySelector('.tc-step-action').addEventListener('change', (e) => {
    const action = e.target.value;
    renderTcStepParamFields(paramsContainer, tcStepShapeFromCard(card, { action, params: {} }));
    // The expected section is per-action too (each action returns different
    // fields), so it has to be rebuilt here as well. Whatever was ticked for
    // the previous action is dropped deliberately: those fields don't exist
    // on the new action's result, so carrying them over would silently
    // assert on something that can never be there.
    renderTcStepExpectedFields(expectedContainer, { action, expected: null });
  });
  // The interface picker is built from the step's *resolved target Pis*, so
  // it has to be rebuilt whenever the target changes - including when the
  // multicast checkboxes change, which alter which Pis are targeted without
  // touching the target select itself.
  const rerenderParams = () => {
    renderTcStepParamFields(paramsContainer, tcStepShapeFromCard(card));
  };
  card.querySelector('.tc-step-target').addEventListener('change', (e) => {
    card.querySelector('.tc-step-multicast-list').classList.toggle('hidden', e.target.value !== 'multicast');
    rerenderParams();
  });
  card.querySelectorAll('.tc-step-multicast-list input[type="checkbox"]')
    .forEach(cb => cb.addEventListener('change', rerenderParams));
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

    step.expected = collectTcStepExpected(card);
  });
}

// Adding, removing or reordering steps shifts the indices a loop range is
// written in terms of, so the range list is re-derived from the (already
// moved) steps afterwards and the loops panel redrawn. Because the group tag
// travels on the step itself, a moved step keeps its membership and the
// derived range follows it rather than silently pointing at whatever landed
// on the old index.
function tcAfterStepsChanged() {
  tcLoops = tcLoopsFromSteps(tcSteps);
  applyTcLoopsToSteps();
  renderTcSteps();
  renderTcLoops();
}

function addTcStep() {
  syncTcStepsFromDom();
  tcSteps.push(newTcStep());
  tcAfterStepsChanged();
}

function removeTcStep(i) {
  syncTcStepsFromDom();
  tcSteps.splice(i, 1);
  tcAfterStepsChanged();
}

function moveTcStep(i, dir) {
  syncTcStepsFromDom();
  const j = i + dir;
  if (j < 0 || j >= tcSteps.length) return;
  [tcSteps[i], tcSteps[j]] = [tcSteps[j], tcSteps[i]];
  tcAfterStepsChanged();
}

// --- editor: open/save -------------------------------------------------

function openNewTestcase() {
  tcEditingId = null;
  tcSteps = [];
  tcLoops = [];
  document.getElementById('tcEditorTitle').textContent = 'New Testcase';
  document.getElementById('tcName').value = '';
  document.getElementById('tcDescription').value = '';
  document.getElementById('tcTags').value = '';
  document.getElementById('tcAuthor').value = '';
  document.getElementById('tcStopOnFailure').checked = true;
  document.getElementById('tcRepeatCount').value = 1;
  renderTcSteps();
  renderTcLoops();
  openTcEditorModal();
}

async function openEditTestcase(id) {
  try {
    const res = await apiFetch(`${API}/testcases/${id}`);
    if (!res.ok) { alert('Failed to load testcase.'); return; }
    const t = await res.json();
    tcEditingId = t.id;
    tcSteps = t.steps.map(s => ({ ...s, target_pi_ids: s.target_pi_ids || [] }));
    // Range view derived from the steps' own loop_group tags - see
    // tcLoopsFromSteps. A testcase saved before loops existed has none.
    tcLoops = tcLoopsFromSteps(tcSteps);
    document.getElementById('tcEditorTitle').textContent = `Edit: ${t.name}`;
    document.getElementById('tcName').value = t.name;
    document.getElementById('tcDescription').value = t.description || '';
    document.getElementById('tcTags').value = (t.tags || []).join(', ');
    document.getElementById('tcAuthor').value = t.author || '';
    document.getElementById('tcStopOnFailure').checked = t.stop_on_failure;
    document.getElementById('tcRepeatCount').value = t.repeat_count;
    renderTcSteps();
    renderTcLoops();
    openTcEditorModal();
  } catch (err) {
    alert(`Failed to load testcase: ${err.message}`);
  }
}

function collectTestcaseFromForm() {
  syncTcStepsFromDom();
  // Loop ranges live on the steps in the payload (loop_group/loop_count).
  applyTcLoopsToSteps();
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

// --- shared run renderer -------------------------------------------------
// Used by this tab's live run view *and* by the Results tab (results-tab.js,
// loaded after this file) - one renderer so a finished run looks exactly the
// same wherever it's opened from.

// Result values and log messages are pi-supplied strings (an SSID, a
// command's raw output) rendered via innerHTML here - escaped so an angle
// bracket in one can't break the markup. The result payload itself goes
// through renderResultTable, which builds DOM and needs no escaping.
function tcEsc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tcLogTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? ts : d.toLocaleTimeString('en-GB', { hour12: false });
}

function tcDuration(ms) {
  if (ms === undefined || ms === null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Step meta shown next to the action name: where it ran, which repeat it is,
// and how long it took. Each piece is omitted when it has nothing to say, so
// a plain single-shot step doesn't carry noise.
function tcStepMetaText(r) {
  const bits = [];
  if (r.target) bits.push(r.target);
  if (r.pass_index > 0) bits.push(`pass ${r.pass_index + 1}`);
  if (r.iteration > 1) bits.push(`repeat ${r.iteration}`);
  const d = tcDuration(r.duration_ms);
  if (d) bits.push(d);
  return bits.join(' · ');
}

function tcRunStepHtml(r, i) {
  const log = r.log || [];
  const entries = r.entries || [];
  return `
    <div class="cmd-entry tc-run-step" data-step="${i}">
      <div class="hdr">
        <span>Step ${r.step_index + 1}: ${actionLabel(r.action)}
          <span class="tc-run-meta">${tcStepMetaText(r)}</span>
        </span>
        <span class="cmd-status ${tcStatusClass(r.status)}">${r.status}</span>
      </div>
      <div class="result">
        ${entries.map((e, j) => `
          <div class="tc-run-entry">
            <div class="tc-run-entry-hdr">
              <span class="tc-run-entry-pi">${e.pi_id || '(unresolved target)'}</span>
              <span class="cmd-status ${tcStatusClass(e.status)}">${e.status}</span>
              <span class="tc-run-meta">${[
                e.command_status && e.command_status !== e.status ? `command ${e.command_status}` : '',
                tcDuration(e.duration_ms),
                e.command_id ? `cmd ${String(e.command_id).slice(0, 8)}` : '',
              ].filter(Boolean).join(' · ')}</span>
            </div>
            ${(e.checks || []).length ? `
              <div class="tc-run-checks">
                ${e.checks.map(c => `
                  <div class="tc-run-check ${c.passed ? 'ok' : 'fail'}">
                    <span class="tc-run-check-mark">${c.passed ? '&#10003;' : '&#10007;'}</span>
                    <span class="tc-run-check-expr">${tcEsc(c.field || '<result>')} ${tcEsc(c.op)}${c.op === 'exists' ? '' : ' ' + tcEsc(tcExpectedValueText(c.value))}</span>
                    ${c.passed ? '' : `<span class="tc-run-check-actual">actual: ${tcEsc(tcExpectedValueText(c.actual))}</span>`}
                  </div>
                `).join('')}
              </div>` : ''}
            ${e.error ? `<div class="tc-run-reason">${tcEsc(e.error)}</div>` : ''}
            <div class="tc-run-result" data-step="${i}" data-entry="${j}"></div>
          </div>
        `).join('') || '<div class="pi-log-empty">no targets</div>'}
        ${log.length ? `
          <div class="tc-run-log">
            <button type="button" class="tc-log-toggle" data-step="${i}">Log (${log.length})</button>
            <div class="tc-log-lines" data-step="${i}">
              ${log.map(l => `
                <div class="tc-log-line tc-log-${l.level || 'info'}">
                  <span class="tc-log-ts">${tcLogTime(l.ts)}</span>
                  <span class="tc-log-msg">${tcEsc(l.message)}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// container: where to render. run: a TestRunOut.
function tcRenderRunSteps(container, run) {
  const results = run.results || [];
  if (!results.length) {
    container.innerHTML = `<div class="pi-log-empty">${run.status === 'running' ? 'starting…' : 'no steps recorded'}</div>`;
    return;
  }
  container.innerHTML = results.map((r, i) => tcRunStepHtml(r, i)).join('');

  // Result payloads go through command-builder.js's renderResultTable - the
  // same nested renderer the Action panel uses, so a testcase result reads
  // identically to running that action by hand. It builds DOM (textContent,
  // not innerHTML), which also keeps arbitrary result strings inert.
  container.querySelectorAll('.tc-run-result').forEach(el => {
    const r = results[Number(el.dataset.step)];
    const entry = r && (r.entries || [])[Number(el.dataset.entry)];
    if (entry && entry.result !== undefined && entry.result !== null) {
      renderResultTable(el, entry.result);
    }
  });

  container.querySelectorAll('.tc-log-toggle').forEach(btn => btn.addEventListener('click', () => {
    const lines = container.querySelector(`.tc-log-lines[data-step="${btn.dataset.step}"]`);
    if (lines) lines.classList.toggle('hidden');
  }));

  const planned = (run.steps || []).reduce((n, s) => n + Math.max(1, s.repeat_count || 1), 0)
    * Math.max(1, run.repeat_count || 1);
  if (run.status === 'running' && results.length < planned) {
    container.insertAdjacentHTML('beforeend', '<div class="pi-log-empty">running…</div>');
  }
}

function renderTcRunView(run) {
  document.getElementById('tcRunTitle').textContent = `Run: ${run.testcase_name}`;
  const statusEl = document.getElementById('tcRunStatus');
  statusEl.textContent = run.status;
  statusEl.className = `cmd-status ${tcStatusClass(run.status)}`;
  tcRenderRunSteps(document.getElementById('tcRunSteps'), run);
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
document.getElementById('tcAddLoopBtn').addEventListener('click', addTcLoop);
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
// directly on #packages, or Back/Forward navigating into it (see
// showTabView in detail-page.js), not just a literal click on the tab
// button, which would miss the other two and leave the list empty.
//
// The editor popup lives outside #packages (see #tcEditorOverlay in
// index.html) so it stays visible across a tab switch unless explicitly
// closed here - navigating to any other tab while it's open should close
// it rather than leave it floating over unrelated content. Navigating to
// the Pi detail page (which bypasses showTabView/this event entirely) is
// handled separately, in showPiDetail (detail-page.js).
document.addEventListener('tabshown', (e) => {
  if (e.detail.viewId === 'packages') showTcListView();
  else {
    closeTcEditorModal();
    closeTcBulkTagModal();
  }
});
