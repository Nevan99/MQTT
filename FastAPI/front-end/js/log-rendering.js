// --- Shared log line rendering (used by per-Pi log panels) -----------------

function levelClass(level) {
  const l = (level || 'unknown').toLowerCase();
  return ['info', 'warning', 'error'].includes(l) ? `lvl-${l}` : 'lvl-unknown';
}

function buildLineElement(payload) {
  const div = document.createElement('div');
  div.className = 'line';

  if (typeof payload === 'string') {
    // Raw journalctl/tcpdump line - no structured fields, just show it as-is.
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = payload;
    div.append(msg);
  } else {
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = payload.timestamp || '';

    const lvl = document.createElement('span');
    const levelValue = payload.loglevel || payload.level || 'unknown';
    lvl.className = `lvl ${levelClass(levelValue)}`;
    lvl.textContent = levelValue;

    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = payload.message !== undefined ? payload.message : JSON.stringify(payload);

    div.append(ts, lvl, msg);
  }
  return div;
}
const linePanelQueues = new WeakMap();
const PIN_THRESHOLD_PX = 20;
const LOG_ROW_CAP = 10000;

function appendLineTo(container, payload) {
  let state = linePanelQueues.get(container);
  if (!state) {
    state = { queue: [], scheduled: false, pinned: true };
    linePanelQueues.set(container, state);
    container.onscroll = () => {
      state.pinned = container.scrollHeight - container.scrollTop - container.clientHeight < PIN_THRESHOLD_PX;
    };
  }
  state.queue.push(payload);
  if (!state.scheduled) {
    state.scheduled = true;
    requestAnimationFrame(() => flushLineQueue(container, state));
  }
}

function flushLineQueue(container, state) {
  state.scheduled = false;
  const lines = state.queue;
  state.queue = [];
  if (!lines.length) return;

  const frag = document.createDocumentFragment();
  lines.forEach(payload => frag.appendChild(buildLineElement(payload)));
  container.appendChild(frag);

  // Cap growth so a long-running stream (tcpdump, syslog) doesn't leak memory.
  while (container.children.length > LOG_ROW_CAP) container.removeChild(container.firstChild);

  if (state.pinned) container.scrollTop = container.scrollHeight;
}

