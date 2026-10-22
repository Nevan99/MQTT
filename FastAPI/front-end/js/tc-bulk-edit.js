// --- Testcases: mass step edit ------------------------------------------
// Find-and-replace over the steps of many testcases: pick which steps
// (filter), what to change (ops, applied in order), preview, apply. The
// backend (POST /testcases/bulk/edit-steps, service/step_bulk_edit.py) does
// the matching for both the preview and the apply, so the preview is exactly
// what gets saved. Each apply keeps an undo record ("Undo step edit").

const TC_BE_OPS = {
  set_param: { label: 'Set parameter', fields: ['param', 'value'] },
  replace_param: { label: 'Replace parameter value', fields: ['param', 'from', 'to'] },
  remove_param: { label: 'Remove parameter', fields: ['param'] },
  replace_target: { label: 'Change target Pi', fields: ['from', 'to'], hints: { from: 'e.g. pi03', to: 'e.g. pi01' } },
  rename_interface: { label: 'Rename interface', fields: ['from', 'to'], hints: { from: 'e.g. wlan1', to: 'e.g. wlan4' } },
  set_field: { label: 'Set delay / repeat', fields: ['stepField', 'value'] },
  set_expected: { label: 'Set expected result', fields: ['resultField', 'cmp', 'value'] },
  remove_expected: { label: 'Remove expected result', fields: ['resultField'] },
};
const TC_BE_CMPS = ['==', '!=', '>', '>=', '<', '<=', 'contains', 'exists'];

let tcBeLastPreview = null;   // last preview response, for the exclude checkboxes

function tcBeEl(id) { return document.getElementById(id); }

function tcBeEsc(v) {
  return String(v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Parameter definitions for the filtered action, or every action's when
// "any action" - interface pickers left out (use "Rename interface").
function tcBeParamDefs() {
  const action = tcBeEl('tcBeAction').value;
  const actions = action ? [action] : TC_ACTIONS;
  const defs = new Map();
  actions.forEach(a => (ACTION_PARAMS[a] || []).forEach(f => {
    if (f.type !== 'interface' && !defs.has(f.name)) defs.set(f.name, f);
  }));
  return defs;
}

function tcBeResultFields() {
  const action = tcBeEl('tcBeAction').value;
  const actions = action ? [action] : TC_ACTIONS;
  const names = new Set();
  actions.forEach(a => (ACTION_RESULT_FIELDS[a] || []).forEach(f => names.add(f.name)));
  return [...names];
}

function tcBeParamOptions(selected) {
  return [...tcBeParamDefs().keys()].map(n =>
    `<option value="${n}" ${n === selected ? 'selected' : ''}>${n}</option>`).join('');
}

// Value input matching the parameter's own editor field where known: a
// dropdown for select params, a number box for numbers, text otherwise.
function tcBeValueInput(cls, def, current = '') {
  if (def && def.type === 'select') {
    return `<select class="field ${cls}">${def.options.map(o =>
      `<option value="${tcBeEsc(o.value)}" ${o.value === current ? 'selected' : ''}>${tcBeEsc(o.label)}</option>`).join('')}</select>`;
  }
  const type = def && def.type === 'number' ? 'number' : 'text';
  const ph = def && def.pingTargetPicker ? 'IP or pi:<pi>/<interface>' : '';
  return `<input class="field ${cls}" type="${type}" value="${tcBeEsc(current)}" placeholder="${ph}">`;
}

function renderTcBeOpRow(row, kind) {
  const spec = TC_BE_OPS[kind];
  const keep = {};
  row.querySelectorAll('[data-k]').forEach(el => { keep[el.dataset.k] = el.value; });
  const paramName = keep.param || [...tcBeParamDefs().keys()][0] || '';
  const def = tcBeParamDefs().get(paramName);
  const hint = (k) => (spec.hints && spec.hints[k]) || '';

  const parts = spec.fields.map(f => {
    switch (f) {
      case 'param':
        return `<label>Parameter<select class="field" data-k="param">${tcBeParamOptions(paramName)}</select></label>`;
      case 'value':
        if (kind === 'set_field') {
          return `<label>Value<input class="field" data-k="value" type="number" step="any" value="${tcBeEsc(keep.value || '')}"></label>`;
        }
        if (kind === 'set_expected') {
          return `<label>Value<input class="field" data-k="value" type="text" value="${tcBeEsc(keep.value || '')}" placeholder="e.g. true, 0, SAE"></label>`;
        }
        return `<label>New value${tcBeValueInput('', def, keep.value).replace('class="field ', 'data-k="value" class="field ')}</label>`;
      case 'from':
        return `<label>From<input class="field" data-k="from" type="text" value="${tcBeEsc(keep.from || '')}" placeholder="${hint('from')}"></label>`;
      case 'to':
        return kind === 'replace_param'
          ? `<label>To${tcBeValueInput('', def, keep.to).replace('class="field ', 'data-k="to" class="field ')}</label>`
          : `<label>To<input class="field" data-k="to" type="text" value="${tcBeEsc(keep.to || '')}" placeholder="${hint('to')}"></label>`;
      case 'stepField':
        return `<label>Field<select class="field" data-k="stepField">
          <option value="delay_before_seconds" ${keep.stepField === 'delay_before_seconds' ? 'selected' : ''}>delay before (s)</option>
          <option value="repeat_count" ${keep.stepField === 'repeat_count' ? 'selected' : ''}>repeat count</option>
        </select></label>`;
      case 'resultField': {
        const fields = tcBeResultFields();
        return `<label>Result field<input class="field" data-k="resultField" list="tcBeResultFieldList" value="${tcBeEsc(keep.resultField || '')}" placeholder="e.g. connected">
          <datalist id="tcBeResultFieldList">${fields.map(n => `<option value="${n}">`).join('')}</datalist></label>`;
      }
      case 'cmp':
        return `<label>Check<select class="field" data-k="cmp">${TC_BE_CMPS.map(c =>
          `<option ${c === (keep.cmp || '==') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>`;
      default:
        return '';
    }
  }).join('');

  row.innerHTML = `
    <label class="tc-be-op-kind">Change<select class="field tc-be-kind">${Object.entries(TC_BE_OPS).map(([k, o]) =>
      `<option value="${k}" ${k === kind ? 'selected' : ''}>${o.label}</option>`).join('')}</select></label>
    ${parts}
    <button type="button" class="icon-btn tc-be-remove" title="Remove this change">&times;</button>
  `;
  row.querySelector('.tc-be-kind').addEventListener('change', e => { renderTcBeOpRow(row, e.target.value); tcBeInvalidate(); });
  const paramSel = row.querySelector('[data-k="param"]');
  if (paramSel) paramSel.addEventListener('change', () => { renderTcBeOpRow(row, kind); tcBeInvalidate(); });
  row.querySelector('.tc-be-remove').addEventListener('click', () => { row.remove(); tcBeInvalidate(); });
}

function addTcBeOpRow(kind = 'set_param') {
  const row = document.createElement('div');
  row.className = 'tc-be-op';
  tcBeEl('tcBeOps').appendChild(row);
  renderTcBeOpRow(row, kind);
  tcBeInvalidate();
}

// "true"/"false"/numbers typed as such - expected values are compared
// against typed command results.
function tcBeLooseValue(text) {
  const t = String(text).trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
  return t;
}

function tcBeTypedParam(name, raw) {
  const def = tcBeParamDefs().get(name);
  if (def && def.type === 'number' && raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

function collectTcBeRequest() {
  const ops = [];
  for (const row of tcBeEl('tcBeOps').querySelectorAll('.tc-be-op')) {
    const kind = row.querySelector('.tc-be-kind').value;
    const v = {};
    row.querySelectorAll('[data-k]').forEach(el => { v[el.dataset.k] = el.value; });
    const need = (k, what) => { if (!String(v[k] ?? '').trim()) throw new Error(`${TC_BE_OPS[kind].label}: ${what} is required`); };
    switch (kind) {
      case 'set_param': need('param', 'parameter'); ops.push({ op: kind, name: v.param, value: tcBeTypedParam(v.param, v.value) }); break;
      case 'replace_param': need('param', 'parameter'); need('from', '"from"');
        ops.push({ op: kind, name: v.param, from: tcBeTypedParam(v.param, v.from), to: tcBeTypedParam(v.param, v.to) }); break;
      case 'remove_param': need('param', 'parameter'); ops.push({ op: kind, name: v.param }); break;
      case 'replace_target':
      case 'rename_interface': need('from', '"from"'); need('to', '"to"'); ops.push({ op: kind, from: v.from.trim(), to: v.to.trim() }); break;
      case 'set_field': need('value', 'value'); ops.push({ op: kind, name: v.stepField, value: Number(v.value) }); break;
      case 'set_expected': need('resultField', 'result field');
        ops.push({ op: kind, field: v.resultField.trim(), cmp: v.cmp, value: tcBeLooseValue(v.value) }); break;
      case 'remove_expected': need('resultField', 'result field'); ops.push({ op: kind, field: v.resultField.trim() }); break;
    }
  }
  if (!ops.length) throw new Error('Add at least one change.');

  const all = tcBeEl('tcBeScope').value === 'all';
  if (!all && !tcSelected.size) throw new Error('No testcases ticked - tick some, or choose "all testcases".');
  const filter = {};
  if (tcBeEl('tcBeAction').value) filter.action = tcBeEl('tcBeAction').value;
  if (tcBeEl('tcBePi').value.trim()) filter.pi = tcBeEl('tcBePi').value.trim();
  if (tcBeEl('tcBeParamName').value) {
    filter.param_name = tcBeEl('tcBeParamName').value;
    if (tcBeEl('tcBeParamValue').value !== '') filter.param_value = tcBeTypedParam(filter.param_name, tcBeEl('tcBeParamValue').value);
  }
  return { ids: all ? [] : tcSelectedIds(), all_testcases: all, filter, ops };
}

// Any edit to the form makes the shown preview stale - Apply needs a fresh one.
function tcBeInvalidate() {
  tcBeLastPreview = null;
  tcBeEl('tcBeApplyBtn').disabled = true;
  if (tcBeEl('tcBePreview').innerHTML) {
    tcBeEl('tcBeSummary').textContent = 'changed - preview again';
  }
}

async function tcBePost(body) {
  const res = await apiFetch(`${API}/testcases/bulk/edit-steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `${res.status}`);
  return data;
}

async function previewTcBulkEdit() {
  let req;
  try {
    req = collectTcBeRequest();
  } catch (err) {
    alert(err.message);
    return;
  }
  tcBeEl('tcBePreviewBtn').disabled = true;
  try {
    const data = await tcBePost({ ...req, dry_run: true });
    tcBeLastPreview = { req, data };
    renderTcBePreview(data);
  } catch (err) {
    tcBeEl('tcBePreview').innerHTML = '';
    tcBeEl('tcBeSummary').textContent = '';
    alert(`Preview failed: ${err.message}`);
  } finally {
    tcBeEl('tcBePreviewBtn').disabled = false;
  }
}

function renderTcBePreview(data) {
  const box = tcBeEl('tcBePreview');
  if (!data.changes.length) {
    box.innerHTML = '<div class="pi-log-empty">no step matches - nothing would change</div>';
    tcBeEl('tcBeSummary').textContent = `${data.testcases_scanned} testcase(s) scanned`;
    tcBeEl('tcBeApplyBtn').disabled = true;
    return;
  }
  box.innerHTML = `<table><tbody>${data.changes.map(c => `
    <tr data-key="${c.testcase_id}:${c.step_index}">
      <td><input type="checkbox" class="tc-be-include" checked title="Untick to leave this step unchanged"></td>
      <td>${tcBeEsc(c.testcase_name)}</td>
      <td>step ${c.step_index + 1}<br><span class="hint">${tcBeEsc(c.action)}</span></td>
      <td class="tc-be-diff">${c.diffs.map(tcBeEsc).join('\n')}</td>
    </tr>`).join('')}</tbody></table>`;
  const update = () => {
    const rows = [...box.querySelectorAll('tr[data-key]')];
    rows.forEach(r => r.classList.toggle('excluded', !r.querySelector('.tc-be-include').checked));
    const n = rows.filter(r => r.querySelector('.tc-be-include').checked).length;
    const tcs = new Set(rows.filter(r => r.querySelector('.tc-be-include').checked).map(r => r.dataset.key.split(':')[0])).size;
    tcBeEl('tcBeSummary').textContent = `${n} step(s) in ${tcs} testcase(s) will change (${data.testcases_scanned} scanned)`;
    tcBeEl('tcBeApplyBtn').disabled = n === 0;
  };
  box.querySelectorAll('.tc-be-include').forEach(cb => cb.addEventListener('change', update));
  update();
}

async function applyTcBulkEdit() {
  if (!tcBeLastPreview) return;
  const exclude = [...tcBeEl('tcBePreview').querySelectorAll('tr[data-key]')]
    .filter(r => !r.querySelector('.tc-be-include').checked).map(r => r.dataset.key);
  const n = tcBeLastPreview.data.changes.length - exclude.length;
  if (!confirm(`Apply changes to ${n} step(s)? You can undo this with "Undo step edit".`)) return;
  tcBeEl('tcBeApplyBtn').disabled = true;
  try {
    const data = await tcBePost({ ...tcBeLastPreview.req, exclude, dry_run: false });
    closeTcBulkEditModal();
    await loadTestcases();
    await refreshTcUndoEditBtn();
    alert(`Updated ${data.steps_changed} step(s) in ${data.testcases_changed} testcase(s).`);
  } catch (err) {
    alert(`Apply failed - nothing was changed: ${err.message}`);
    tcBeEl('tcBeApplyBtn').disabled = false;
  }
}

function openTcBulkEditModal() {
  tcBeEl('tcBeScope').value = tcSelected.size ? 'selected' : 'all';
  tcBeEl('tcBeScope').options[0].textContent = `ticked testcases (${tcSelected.size})`;
  tcBeEl('tcBeAction').innerHTML = '<option value="">any action</option>' +
    TC_ACTIONS.map(a => `<option value="${a}">${a}</option>`).join('');
  tcBeEl('tcBePi').value = '';
  tcBeEl('tcBeParamValue').value = '';
  tcBeRefreshParamFilter();
  tcBeEl('tcBeOps').innerHTML = '';
  addTcBeOpRow();
  tcBeEl('tcBePreview').innerHTML = '';
  tcBeEl('tcBeSummary').textContent = '';
  tcBeInvalidate();
  tcBeEl('tcBulkEditOverlay').classList.remove('hidden');
}

function closeTcBulkEditModal() {
  tcBeEl('tcBulkEditOverlay').classList.add('hidden');
}

function tcBeRefreshParamFilter() {
  const sel = tcBeEl('tcBeParamName');
  const cur = sel.value;
  sel.innerHTML = '<option value="">any</option>' + tcBeParamOptions(cur);
}

async function refreshTcUndoEditBtn() {
  const btn = tcBeEl('tcBulkUndoEditBtn');
  try {
    const res = await apiFetch(`${API}/testcases/bulk/edit-steps/last`);
    const last = res.ok ? await res.json() : null;
    btn.classList.toggle('hidden', !last);
    if (last) btn.title = `Undo: ${last.summary} (${formatVnDateTime(last.created_at)})`;
  } catch {
    btn.classList.add('hidden');
  }
}

async function undoTcBulkEdit() {
  const btn = tcBeEl('tcBulkUndoEditBtn');
  if (!confirm(`${btn.title}?\nThe affected testcases' steps go back to how they were before that edit.`)) return;
  try {
    const res = await apiFetch(`${API}/testcases/bulk/edit-steps/undo`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || res.status);
    await loadTestcases();
    alert(`Undone: ${data.summary} (${data.restored_testcases.length} testcase(s) restored).`);
  } catch (err) {
    alert(`Undo failed: ${err.message}`);
  }
  await refreshTcUndoEditBtn();
}

tcBeEl('tcBulkEditStepsBtn').addEventListener('click', openTcBulkEditModal);
tcBeEl('tcBulkUndoEditBtn').addEventListener('click', undoTcBulkEdit);
tcBeEl('tcBulkEditCloseBtn').addEventListener('click', closeTcBulkEditModal);
tcBeEl('tcBeCancelBtn').addEventListener('click', closeTcBulkEditModal);
tcBeEl('tcBeAddOp').addEventListener('click', () => addTcBeOpRow());
tcBeEl('tcBePreviewBtn').addEventListener('click', previewTcBulkEdit);
tcBeEl('tcBeApplyBtn').addEventListener('click', applyTcBulkEdit);
tcBeEl('tcBeAction').addEventListener('change', () => {
  // Parameter lists follow the chosen action.
  tcBeRefreshParamFilter();
  tcBeEl('tcBeOps').querySelectorAll('.tc-be-op').forEach(row =>
    renderTcBeOpRow(row, row.querySelector('.tc-be-kind').value));
  tcBeInvalidate();
});
['tcBeScope', 'tcBePi', 'tcBeParamName', 'tcBeParamValue'].forEach(id =>
  tcBeEl(id).addEventListener('input', tcBeInvalidate));
tcBeEl('tcBeOps').addEventListener('input', tcBeInvalidate);
tcBeEl('tcBeOps').addEventListener('change', tcBeInvalidate);

refreshTcUndoEditBtn();
