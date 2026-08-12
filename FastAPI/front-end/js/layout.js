// --- Fleet: resizable split between the Pi table and the command panel ----

(function setupFleetGutter() {
  const fleet = document.getElementById('fleet');
  const gutter = document.getElementById('fleetGutter');
  const MIN_RIGHT = 260;
  const MAX_RIGHT = 800;

  function applyRightWidth(px) {
    fleet.style.gridTemplateColumns = `1fr 6px ${px}px`;
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

// --- Pi detail page: resizable 3-column split (info / logs / actions) -----

(function setupPiDetailGutters() {
  const grid = document.getElementById('piDetailGrid');
  const gutterLeft = document.getElementById('pdGutterLeft');
  const gutterRight = document.getElementById('pdGutterRight');
  const infoPanel = document.getElementById('pdInfoPanel');
  const actionPanel = document.getElementById('pdActionPanel');
  const infoCollapseBtn = document.getElementById('pdInfoCollapseBtn');
  const actionCollapseBtn = document.getElementById('pdActionCollapseBtn');
  const MIN_LEFT = 200, MAX_LEFT = 480;
  const MIN_RIGHT = 260, MAX_RIGHT = 600;
  const COLLAPSED_WIDTH = 32;

  let leftWidth = parseInt(localStorage.getItem('pdLeftWidth'), 10);
  if (!(leftWidth >= MIN_LEFT && leftWidth <= MAX_LEFT)) leftWidth = 280;
  let rightWidth = parseInt(localStorage.getItem('pdRightWidth'), 10);
  if (!(rightWidth >= MIN_RIGHT && rightWidth <= MAX_RIGHT)) rightWidth = 380;
  let leftCollapsed = false;
  let rightCollapsed = false;

  function apply() {
    const left = leftCollapsed ? COLLAPSED_WIDTH : leftWidth;
    const right = rightCollapsed ? COLLAPSED_WIDTH : rightWidth;
    grid.style.gridTemplateColumns = `${left}px 6px 1fr 6px ${right}px`;
  }
  apply();

  // Collapsing either side panel to a thin strip (rather than a fixed
  // fraction) hands essentially all the freed width to the Logs panel in
  // the middle, since it's the only flexible ("1fr") column.
  infoCollapseBtn.addEventListener('click', () => {
    leftCollapsed = !leftCollapsed;
    infoPanel.classList.toggle('pd-panel-collapsed', leftCollapsed);
    infoCollapseBtn.innerHTML = chevronIconSvg(leftCollapsed ? 'right' : 'left');
    infoCollapseBtn.title = leftCollapsed ? 'Expand' : 'Collapse';
    apply();
  });
  actionCollapseBtn.addEventListener('click', () => {
    rightCollapsed = !rightCollapsed;
    actionPanel.classList.toggle('pd-panel-collapsed', rightCollapsed);
    actionCollapseBtn.innerHTML = chevronIconSvg(rightCollapsed ? 'left' : 'right');
    actionCollapseBtn.title = rightCollapsed ? 'Expand' : 'Collapse';
    apply();
  });

  function startDrag(which) {
    return (e) => {
      if ((which === 'left' && leftCollapsed) || (which === 'right' && rightCollapsed)) return;
      e.preventDefault();
      grid.classList.add('dragging');
      const gutterEl = which === 'left' ? gutterLeft : gutterRight;
      gutterEl.classList.add('active');

      function onMove(moveEvent) {
        const rect = grid.getBoundingClientRect();
        if (which === 'left') {
          leftWidth = Math.max(MIN_LEFT, Math.min(MAX_LEFT, moveEvent.clientX - rect.left));
        } else {
          rightWidth = Math.max(MIN_RIGHT, Math.min(MAX_RIGHT, rect.right - moveEvent.clientX));
        }
        apply();
      }

      function onUp() {
        grid.classList.remove('dragging');
        gutterEl.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem('pdLeftWidth', leftWidth);
        localStorage.setItem('pdRightWidth', rightWidth);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
  }

  gutterLeft.addEventListener('mousedown', startDrag('left'));
  gutterRight.addEventListener('mousedown', startDrag('right'));
})();

