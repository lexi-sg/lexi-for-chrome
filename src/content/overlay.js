// src/content/overlay.js
//
// Injected UI: numbered set-of-marks boxes (for vision grounding of the
// dom-index refs in screenshots) + the red "agent acting" page border/pill.
//
// CLASSIC SCRIPT — no `import`/`export`. Publishes on window.__lexi.
// Renders into a single shadow-DOM host so page CSS can never bleed in (or
// out) and the whole thing can be hidden in one line before a screenshot.
//
// window.__lexi.overlay.drawMarks(elements)
// window.__lexi.overlay.clearMarks()
// window.__lexi.overlay.setActing(on)
// window.__lexi.overlay.hide()
// window.__lexi.overlay.restore()

(function () {
  if (window.__lexi && window.__lexi.overlay) {
    return;
  }
  window.__lexi = window.__lexi || {};

  var HOST_ID = 'lexi-overlay-host';

  // 12-colour cycling palette for the numbered mark boxes.
  var PALETTE = [
    '#775AD8', '#DC2626', '#16A34A', '#F59E0B',
    '#3B82F6', '#D6409F', '#12B5B0', '#F76B15',
    '#8B5CF6', '#EAB308', '#EC4899', '#14B8A6',
  ];

  var CSS_TEXT =
    ':host { all: initial; }' +
    '.lexi-marks {' +
    '  position: fixed; top: 0; left: 0; width: 0; height: 0;' +
    '}' +
    '.lexi-mark-box {' +
    '  position: fixed; box-sizing: border-box; border-width: 2px;' +
    '  border-style: solid; border-radius: 3px; pointer-events: none;' +
    '}' +
    '.lexi-mark-label {' +
    '  position: absolute; top: -9px; right: -1px;' +
    '  font: 600 10px -apple-system, "Segoe UI", Roboto, sans-serif;' +
    '  color: #fff; padding: 1px 4px; border-radius: 4px;' +
    '  line-height: 1.4; white-space: nowrap;' +
    '}' +
    '.lexi-acting-border {' +
    '  position: fixed; top: 0; left: 0; right: 0; height: 4px;' +
    '  background: #DC2626; display: none; pointer-events: none;' +
    '}' +
    '.lexi-acting-border.lexi-on {' +
    '  display: block; animation: lexi-pulse 1.4s ease-in-out infinite;' +
    '}' +
    '.lexi-acting-pill {' +
    '  position: fixed; top: 10px; left: 50%; transform: translateX(-50%);' +
    '  background: #DC2626; color: #fff;' +
    '  font: 600 12px -apple-system, "Segoe UI", Roboto, sans-serif;' +
    '  padding: 6px 14px; border-radius: 999px; display: none;' +
    '  align-items: center; gap: 6px; pointer-events: none;' +
    '  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);' +
    '}' +
    '.lexi-acting-pill.lexi-on { display: flex; }' +
    '.lexi-acting-dot {' +
    '  width: 7px; height: 7px; border-radius: 50%; background: #fff;' +
    '  animation: lexi-pulse 1.2s ease-in-out infinite;' +
    '}' +
    '@keyframes lexi-pulse {' +
    '  0%, 100% { opacity: 1; }' +
    '  50% { opacity: 0.35; }' +
    '}';

  var hostEl = null;
  var shadowRoot = null;
  var marksContainer = null;
  var actingBorder = null;
  var actingPill = null;
  var wasHidden = false;

  function ensureHost() {
    if (hostEl && hostEl.isConnected && shadowRoot) return shadowRoot;

    hostEl = document.getElementById(HOST_ID);
    if (!hostEl) {
      hostEl = document.createElement('div');
      hostEl.id = HOST_ID;
      hostEl.style.cssText =
        'all: initial !important; position: fixed !important; top: 0 !important;' +
        'left: 0 !important; width: 0 !important; height: 0 !important;' +
        'z-index: 2147483647 !important;';
      (document.documentElement || document.body).appendChild(hostEl);
    }

    shadowRoot = hostEl.shadowRoot || hostEl.attachShadow({ mode: 'open' });

    if (!shadowRoot.querySelector('style')) {
      var style = document.createElement('style');
      style.textContent = CSS_TEXT;
      shadowRoot.appendChild(style);
    }

    marksContainer = shadowRoot.querySelector('.lexi-marks');
    if (!marksContainer) {
      marksContainer = document.createElement('div');
      marksContainer.className = 'lexi-marks';
      shadowRoot.appendChild(marksContainer);
    }

    actingBorder = shadowRoot.querySelector('.lexi-acting-border');
    if (!actingBorder) {
      actingBorder = document.createElement('div');
      actingBorder.className = 'lexi-acting-border';
      shadowRoot.appendChild(actingBorder);
    }

    actingPill = shadowRoot.querySelector('.lexi-acting-pill');
    if (!actingPill) {
      actingPill = document.createElement('div');
      actingPill.className = 'lexi-acting-pill';
      var dot = document.createElement('span');
      dot.className = 'lexi-acting-dot';
      var label = document.createElement('span');
      label.className = 'lexi-acting-label';
      label.textContent = 'Lexi is acting';
      actingPill.appendChild(dot);
      actingPill.appendChild(label);
      shadowRoot.appendChild(actingPill);
    }

    return shadowRoot;
  }

  function clearMarks() {
    ensureHost();
    marksContainer.innerHTML = '';
  }

  function drawMarks(elements) {
    ensureHost();
    clearMarks();

    (elements || []).forEach(function (item, idx) {
      var bbox = item.bbox || { x: 0, y: 0, w: 0, h: 0 };
      var color = PALETTE[idx % PALETTE.length];

      var box = document.createElement('div');
      box.className = 'lexi-mark-box';
      box.style.left = bbox.x + 'px';
      box.style.top = bbox.y + 'px';
      box.style.width = Math.max(bbox.w, 2) + 'px';
      box.style.height = Math.max(bbox.h, 2) + 'px';
      box.style.borderColor = color;
      box.style.background = color + '1A'; // ~10% alpha fill

      var label = document.createElement('span');
      label.className = 'lexi-mark-label';
      label.style.background = color;
      label.textContent = item.ref || '';
      box.appendChild(label);

      marksContainer.appendChild(box);
    });
  }

  function setActing(on) {
    ensureHost();
    var isOn = !!on;
    actingBorder.classList.toggle('lexi-on', isOn);
    actingPill.classList.toggle('lexi-on', isOn);
  }

  function hide() {
    ensureHost();
    wasHidden = hostEl.style.display === 'none';
    hostEl.style.setProperty('display', 'none', 'important');
  }

  function restore() {
    if (!hostEl) return;
    if (!wasHidden) {
      hostEl.style.removeProperty('display');
    }
  }

  window.__lexi.overlay = {
    drawMarks: drawMarks,
    clearMarks: clearMarks,
    setActing: setActing,
    hide: hide,
    restore: restore,
  };
})();
