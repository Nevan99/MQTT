
const historyTableBody = document.getElementById('historyTableBody');
const historySelectAll = document.getElementById('historySelectAll');
const historyDeleteSelectedBtn = document.getElementById('historyDeleteSelectedBtn');
const checkedHistoryIds = new Set();

function updateHistoryDeleteBtn() {
  historyDeleteSelectedBtn.disabled = checkedHistoryIds.size === 0;
  historyDeleteSelectedBtn.title = checkedHistoryIds.size
    ? `Delete selected (${checkedHistoryIds.size})`
    : 'Delete selected';
}

function syncHistorySelectAll() {
  const checkboxes = [...historyTableBody.querySelectorAll('.history-select-checkbox')];
  historySelectAll.checked = checkboxes.length > 0 && checkboxes.every(cb => cb.checked);
  historySelectAll.indeterminate = checkboxes.some(cb => cb.checked) && !historySelectAll.checked;
}

async function deleteHistoryEntries(ids) {
  const results = await Promise.allSettled(ids.map(id =>
    apiFetch(`${API}/commands/${id}`, { method: 'DELETE', keepalive: true })
  ));
  const failed = results.filter(r => r.status === 'rejected' || !r.value.ok && r.value.status !== 404);
  ids.forEach(id => checkedHistoryIds.delete(id));
  if (failed.length) alert(`${failed.length} of ${ids.length} failed to delete; they may reappear on reload.`);
  await loadHistory();
}

async function loadHistory() {
  try {
    const res = await apiFetch(`${API}/commands?limit=200`);
    if (!res.ok) return;
    const commands = await res.json();
    const seenIds = new Set(commands.map(c => c.command_id));
    [...checkedHistoryIds].forEach(id => { if (!seenIds.has(id)) checkedHistoryIds.delete(id); });

    historyTableBody.innerHTML = commands.map(c => {
      const displayStatus = effectiveCommandStatus(c.action, c.status, c.result);
      return `
      <tr class="history-row" data-command-id="${c.command_id}">
        <td><input type="checkbox" class="history-select-checkbox" ${checkedHistoryIds.has(c.command_id) ? 'checked' : ''}></td>
        <td>${c.pi_id}</td>
        <td>${actionLabel(c.action)}</td>
        <td><span class="cmd-status ${displayStatus}">${displayStatus}</span></td>
        <td>${formatVnDateTime(c.created_at)}</td>
        <td class="capture-actions">
          <button class="icon-btn history-toggle" title="Show result">&#9654;</button>
          <button class="icon-btn history-delete" data-command-id="${c.command_id}" title="Delete">&#128465;</button>
        </td>
      </tr>
      <tr class="history-detail-row hidden" data-command-id="${c.command_id}"><td colspan="6"><div class="result"></div></td></tr>
    `;
    }).join('') || '<tr><td colspan="6" class="pi-log-empty">no command history yet</td></tr>';

    historyTableBody.querySelectorAll('.history-select-checkbox').forEach(cb => {
      const id = cb.closest('tr').dataset.commandId;
      cb.addEventListener('change', () => {
        if (cb.checked) checkedHistoryIds.add(id); else checkedHistoryIds.delete(id);
        syncHistorySelectAll();

        updateHistoryDeleteBtn();
      });
    });

    historyTableBody.querySelectorAll('.history-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.closest('tr').dataset.commandId;
        const detailRow = historyTableBody.querySelector(`.history-detail-row[data-command-id="${id}"]`);
        const expanding = detailRow.classList.contains('hidden');
        detailRow.classList.toggle('hidden');
        btn.innerHTML = chevronIconSvg(expanding ? 'down' : 'right');
        if (!expanding) return;
        const command = commands.find(c => c.command_id === id);
        const resultEl = detailRow.querySelector('.result');
        if (command && command.result) renderCommandResult(resultEl, command.action, command.result, command.pi_id);
        else resultEl.innerHTML = '<div class="pi-log-empty">no result</div>';
      });
    });

    historyTableBody.querySelectorAll('.history-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await deleteHistoryEntries([btn.dataset.commandId]);
        } finally {
          updateHistoryDeleteBtn();
        }
      });
    });

    syncHistorySelectAll();
    updateHistoryDeleteBtn();
  } catch {
    // backend unreachable; leave the last known list in place
  }
}

historySelectAll.addEventListener('change', () => {
  historyTableBody.querySelectorAll('.history-select-checkbox').forEach(cb => {
    cb.checked = historySelectAll.checked;
    const id = cb.closest('tr').dataset.commandId;
    if (cb.checked) checkedHistoryIds.add(id); else checkedHistoryIds.delete(id);
  });
  updateHistoryDeleteBtn();
});

historyDeleteSelectedBtn.addEventListener('click', async () => {
  const ids = [...checkedHistoryIds];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} command result(s)? This cannot be undone.`)) return;
  historyDeleteSelectedBtn.disabled = true;
  await deleteHistoryEntries(ids);
});

loadHistory();

