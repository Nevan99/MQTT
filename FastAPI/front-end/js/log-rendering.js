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

// A busy tcpdump/syslog stream can push many messages per second; appending
// and re-measuring scroll position (a forced synchronous reflow) on every
// single one causes layout thrashing bad enough to stall the main thread and
// make unrelated UI (button clicks) feel like they hung. Instead, lines are
// queued and flushed together at most once per animation frame, so a burst
// of N messages costs one DOM batch + one layout read instead of N of each.
const linePanelQueues = new WeakMap();

// "Pinned" tracks whether the panel should keep following new lines: true
// while the user is sitting at the bottom, flipped to false the moment
// they scroll away (to the top, or anywhere in between) so old lines stay
// put under them instead of being yanked away by the next batch. Scrolling
// back down to the bottom re-pins it - same lock-at-bottom/lock-wherever-
// you-scrolled-to behavior the wireshark tcpdump table already has via its
// pause/resume banner (see setupWiresharkTable's scrollEl.onscroll).
const PIN_THRESHOLD_PX = 20;

// Shared cap for both the plain-text log panel and the tcpdump packet
// table - how many rows/lines a live stream keeps in the DOM before
// trimming the oldest off the top. Higher means more scrollback history
// but more DOM nodes and a heavier per-keystroke scan in the tcpdump
// filter input (it re-checks every row, undebounced).
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

