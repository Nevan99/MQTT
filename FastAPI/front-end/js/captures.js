// --- Fleet: saved captures ---------------------------------------------

const capturesTableBody = document.getElementById('capturesTableBody');

async function loadCaptures() {
  try {
    const res = await apiFetch(`${API}/captures`);
    if (!res.ok) return;
    const captures = await res.json();
    capturesTableBody.innerHTML = captures.map(c => `
      <tr data-capture-id="${c.id}">
        <td>${c.pi_id}</td>
        <td>${c.category}</td>
        <td>${c.name}</td>
        <td>${c.category === 'pcap' ? '—' : c.line_count}</td>
        <td>${new Date(c.created_at).toLocaleString()}</td>
        <td class="capture-actions">
          <a href="${withToken(`${API}/captures/${c.id}/download`)}" class="icon-btn" title="Download">&#8681;</a>
          <button class="icon-btn capture-delete" data-capture-id="${c.id}" title="Delete">&#128465;</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="6" class="pi-log-empty">no captures yet</td></tr>';

    capturesTableBody.querySelectorAll('.capture-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await apiFetch(`${API}/captures/${btn.dataset.captureId}`, { method: 'DELETE', keepalive: true });
          if (!res.ok && res.status !== 404) {
            alert('Failed to delete capture on the server; it may reappear on reload.');
            btn.disabled = false;
            return;
          }
          btn.closest('tr').remove();
        } catch {
          alert('Failed to delete capture on the server; it may reappear on reload.');
          btn.disabled = false;
        }
      });
    });
  } catch {
    // backend unreachable; leave the last known list in place
  }
}

loadCaptures();

