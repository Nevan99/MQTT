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

async function loadTestcases() {
  const q = document.getElementById('tcSearchInput').value.trim();
  const tag = document.getElementById('tcTagFilterInput').value.trim();
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    const res = await apiFetch(`${API}/testcases?${params}`);
    if (!res.ok) return;
    tcList = await res.json();
    renderTcTable();
  } catch {
    // backend unreachable; keep last known list
  }
}

function renderTcTable() {
  const body = document.getElementById('tcTableBody');
  if (!tcList.length) {
    body.innerHTML = '<tr><td colspan="7" class="pi-log-empty">no testcases yet</td></tr>';
    return;
  }
  body.innerHTML = tcList.map(t => `
    <tr>
      <td>${t.name}</td>
      <td>${(t.tags || []).join(', ')}</td>
      <td>${t.status}</td>
      <td>${t.steps.length}</td>
      <td>${t.author || ''}</td>
      <td>${new Date(t.updated_at).toLocaleString()}</td>
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
            <td>${new Date(r.started_at).toLocaleString()}</td>
            <td>${r.completed_at ? new Date(r.completed_at).toLocaleString() : ''}</td>
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
document.getElementById('tcSearchInput').addEventListener('input', debounce(loadTestcases, 300));
document.getElementById('tcTagFilterInput').addEventListener('input', debounce(loadTestcases, 300));

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
  else closeTcEditorModal();
});
