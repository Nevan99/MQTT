// --- Fleet: resizable split between the Pi table and the command panel ----

(function setupFleetGutter() {
  const fleet = document.getElementById('fleet');
  const gutter = document.getElementById('fleetGutter');
  const MIN_RIGHT = 260;
  const MAX_RIGHT = 800;

  function applyRightWidth(px) {
    fleet.style.gridTemplateColumns = `minmax(0, 1fr) 6px ${px}px`;
  }

  const saved = parseInt(localStorage.getItem('fleetRightWidth'), 10);
  if (saved && saved >= MIN_RIGHT && saved <= MAX_RIGHT) applyRightWidth(saved);

  gutter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    fleet.classList.add('dragging');
    gutter.classList.add('active');

    function onMove(moveEvent) {
      const fleetRect = fleet.getBoundingClientRect();
      let rightWidth = fleetRect.right - moveEvent.clientX;
      rightWidth = Math.max(MIN_RIGHT, Math.min(MAX_RIGHT, rightWidth));
      applyRightWidth(rightWidth);
    }

    function onUp() {
      fleet.classList.remove('dragging');
      gutter.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const currentRight = fleet.style.gridTemplateColumns.split(' ')[2];
      if (currentRight) localStorage.setItem('fleetRightWidth', parseInt(currentRight, 10));
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

// --- Testsuites/Testcases tables: resizable Name column --------------------
// Drag handle sits directly on the Name column's own right border (see
// .col-resize-handle in styles.css); dragging it sets a CSS var on the
// <table> itself, which .ts-name-cell/.tc-name-cell read for their width -
// every cell in the column, header included, tracks one value instead of
// each row being sized independently.

function setupNameColResize(tableId, handleId, storageKey) {
  const table = document.getElementById(tableId);
  const handle = document.getElementById(handleId);
  if (!table || !handle) return;
  const MIN = 100;
  const MAX = 480;

  function apply(px) {
    table.style.setProperty('--name-col-w', `${px}px`);
  }

  let width = parseInt(localStorage.getItem(storageKey), 10);
  if (width >= MIN && width <= MAX) apply(width);

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    // Without this, the mousedown also starts the browser's own text
    // selection on the header label next to it.
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = handle.closest('th').getBoundingClientRect().width;
    handle.classList.add('active');

    function onMove(moveEvent) {
      width = Math.max(MIN, Math.min(MAX, startWidth + (moveEvent.clientX - startX)));
      apply(width);
    }

    function onUp() {
      handle.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem(storageKey, width);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

setupNameColResize('tsTable', 'tsNameColResize', 'tsNameColWidth');
setupNameColResize('tcTable', 'tcNameColResize', 'tcNameColWidth');

// --- Pi detail page: resizable / hideable command column ------------------

(function setupPiDetailGutters() {
  const grid = document.getElementById('piDetailGrid');
  const gutterRight = document.getElementById('pdGutterRight');
  const actionPanel = document.getElementById('pdActionPanel');
  const actionCollapseBtn = document.getElementById('pdActionCollapseBtn');
  const MIN_RIGHT = 260, MAX_RIGHT = 600;
  const COLLAPSED_WIDTH = 32;

  let rightWidth = parseInt(localStorage.getItem('pdRightWidth'), 10);
  if (!(rightWidth >= MIN_RIGHT && rightWidth <= MAX_RIGHT)) rightWidth = 380;
  let rightCollapsed = false;

  function apply() {
    const right = rightCollapsed ? COLLAPSED_WIDTH : rightWidth;
    grid.style.gridTemplateColumns = `1fr 6px ${right}px`;
  }
  apply();

  // Hiding the command column hands its width to the main panel.
  actionCollapseBtn.addEventListener('click', () => {
    rightCollapsed = !rightCollapsed;
    actionPanel.classList.toggle('pd-panel-collapsed', rightCollapsed);
    actionCollapseBtn.innerHTML = chevronIconSvg(rightCollapsed ? 'left' : 'right');
    actionCollapseBtn.title = rightCollapsed ? 'Show the command panel' : 'Hide';
    actionCollapseBtn.setAttribute('aria-label', rightCollapsed ? 'Show the command panel' : 'Hide the command panel');
    apply();
  });

  gutterRight.addEventListener('mousedown', (e) => {
    if (rightCollapsed) return;
    e.preventDefault();
    grid.classList.add('dragging');
    gutterRight.classList.add('active');

    function onMove(moveEvent) {
      const rect = grid.getBoundingClientRect();
      rightWidth = Math.max(MIN_RIGHT, Math.min(MAX_RIGHT, rect.right - moveEvent.clientX));
      apply();
    }

    function onUp() {
      grid.classList.remove('dragging');
      gutterRight.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem('pdRightWidth', rightWidth);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

