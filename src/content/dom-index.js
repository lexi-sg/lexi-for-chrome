// src/content/dom-index.js
//
// Set-of-marks indexer: assigns persistent refs to visible interactive
// elements, builds a selectorMap (ref -> WeakRef<element>) plus a
// data-lexi-ref attribute fallback, and serializes an indented text tree.
//
// CLASSIC SCRIPT — no `import`/`export`. Publishes on window.__lexi.
//
// window.__lexi.domIndex.buildIndex()      -> {elements, tree}
// window.__lexi.domIndex.resolveRef(ref)   -> {found, element, bbox, sensitive}
// window.__lexi.domIndex.diffNew(prevRefs) -> string[] refs new since prevRefs

(function () {
  if (window.__lexi && window.__lexi.domIndex) {
    return;
  }
  window.__lexi = window.__lexi || {};

  // Mirrors LIMITS.MAX_ELEMENTS (150) from src/config.js — duplicated here
  // because classic content scripts cannot `import` config.js.
  var MAX_ELEMENTS = 150;

  var INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="switch"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');

  // Persistent identity across buildIndex() calls within the life of this
  // injected page instance, so refs remain stable step-to-step (required
  // for diffNew()'s "* new since last step" semantics and for resolveRef()
  // to keep working against refs the model saw in a previous turn).
  var elementRefs = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var fallbackRefStore = []; // used only if WeakMap is unavailable (never on Chrome 120+)
  var refMap = new Map(); // ref -> WeakRef(element) | element
  var refCounter = 0;
  var lastElements = [];

  function makeWeakRef(el) {
    if (typeof WeakRef !== 'undefined') return new WeakRef(el);
    return { deref: function () { return el; } };
  }

  function cssEscape(value) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function getExistingRef(el) {
    if (elementRefs) return elementRefs.get(el) || null;
    for (var i = 0; i < fallbackRefStore.length; i++) {
      if (fallbackRefStore[i].el === el) return fallbackRefStore[i].ref;
    }
    return null;
  }

  function setRef(el, ref) {
    if (elementRefs) {
      elementRefs.set(el, ref);
    } else {
      fallbackRefStore.push({ el: el, ref: ref });
    }
  }

  function getOrAssignRef(el) {
    var existingByIdentity = getExistingRef(el);
    if (existingByIdentity) return existingByIdentity;

    // Fallback: element identity map missed (e.g. cross-injection reload)
    // but the DOM attribute survived — reuse it so refs stay stable.
    var attrRef = el.dataset ? el.dataset.lexiRef : null;
    if (attrRef && !refMap.has(attrRef)) {
      setRef(el, attrRef);
      return attrRef;
    }

    refCounter += 1;
    var ref = 'e' + refCounter;
    setRef(el, ref);
    if (el.dataset) el.dataset.lexiRef = ref;
    return ref;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    var rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;

    var style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity) === 0) return false;

    var rect = rects[0];
    if (rect.width <= 0 || rect.height <= 0) return false;

    // Filter the common "visually-hidden" a11y trick (position far off
    // canvas) so the set-of-marks index doesn't offer the model elements a
    // sighted user could never see or click.
    if (rect.right < -1000 || rect.bottom < -1000) return false;

    if (
      el.offsetParent === null &&
      style.position !== 'fixed' &&
      style.position !== 'sticky'
    ) {
      return false;
    }

    return true;
  }

  function roleForElement(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;

    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'textbox';
    }
    return tag;
  }

  function isSensitive(el) {
    if (el.tagName.toLowerCase() !== 'input') return false;
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    var autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(^|\s)cc-/.test(autocomplete)) return true;
    return false;
  }

  function textOf(el) {
    if (!el) return '';
    var t = el.innerText;
    if (t === undefined || t === null || t === '') t = el.textContent || '';
    return t.trim().replace(/\s+/g, ' ');
  }

  function accessibleName(el) {
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 80);

    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var parts = labelledBy
        .split(/\s+/)
        .map(function (id) {
          var ref = document.getElementById(id);
          return ref ? textOf(ref) : '';
        })
        .filter(Boolean);
      if (parts.length) return parts.join(' ').slice(0, 80);
    }

    if (el.id) {
      var labelFor = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (labelFor) {
        var t = textOf(labelFor);
        if (t) return t.slice(0, 80);
      }
    }

    var closestLabel = typeof el.closest === 'function' ? el.closest('label') : null;
    if (closestLabel) {
      var t2 = textOf(closestLabel);
      if (t2) return t2.slice(0, 80);
    }

    var placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim().slice(0, 80);

    var title = el.getAttribute('title');
    if (title && title.trim()) return title.trim().slice(0, 80);

    var alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim().slice(0, 80);

    var text = textOf(el);
    if (text) return text.slice(0, 80);

    if (el.value) return String(el.value).slice(0, 80);

    return '';
  }

  function boxOf(rect) {
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }

  function distanceFromCenter(rect, cx, cy) {
    var ex = rect.left + rect.width / 2;
    var ey = rect.top + rect.height / 2;
    return Math.sqrt((ex - cx) * (ex - cx) + (ey - cy) * (ey - cy));
  }

  function buildIndex() {
    var nodeList = document.querySelectorAll(INTERACTIVE_SELECTOR);
    var candidates = Array.prototype.slice.call(nodeList);

    var viewportCx = (window.innerWidth || document.documentElement.clientWidth || 0) / 2;
    var viewportCy = (window.innerHeight || document.documentElement.clientHeight || 0) / 2;

    var scored = [];
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!isVisible(el)) continue;
      var rect = el.getBoundingClientRect();
      scored.push({ el: el, rect: rect, dist: distanceFromCenter(rect, viewportCx, viewportCy) });
    }
    scored.sort(function (a, b) {
      return a.dist - b.dist;
    });

    var limited = scored.slice(0, MAX_ELEMENTS);

    var elements = [];
    var treeLines = [];

    for (var j = 0; j < limited.length; j++) {
      var item = limited[j];
      var el2 = item.el;
      var ref = getOrAssignRef(el2);
      refMap.set(ref, makeWeakRef(el2));

      var role = roleForElement(el2);
      var name = accessibleName(el2);
      var tag = el2.tagName.toLowerCase();
      var sensitive = isSensitive(el2);
      var bbox = boxOf(item.rect);

      var entry = { ref: ref, role: role, name: name, bbox: bbox, tag: tag, sensitive: sensitive };
      elements.push(entry);
      treeLines.push('[' + ref + ']<' + role + '> ' + name);
    }

    lastElements = elements;
    return { elements: elements, tree: treeLines.join('\n') };
  }

  function resolveRef(ref) {
    if (!ref) return { found: false };

    var weak = refMap.get(ref);
    var el = weak ? weak.deref() : null;

    if (!el || !el.isConnected) {
      // Recover via the DOM attribute in case the in-memory map went stale
      // (e.g. re-injection) but the page itself hasn't changed underneath.
      el = document.querySelector('[data-lexi-ref="' + cssEscape(ref) + '"]');
      if (el) refMap.set(ref, makeWeakRef(el));
    }

    if (!el || !el.isConnected) return { found: false };

    var rect = el.getBoundingClientRect();
    return {
      found: true,
      element: el,
      bbox: boxOf(rect),
      sensitive: isSensitive(el),
    };
  }

  function diffNew(prevRefs) {
    var prevSet = new Set(prevRefs || []);
    var freshRefs = [];
    for (var i = 0; i < lastElements.length; i++) {
      if (!prevSet.has(lastElements[i].ref)) freshRefs.push(lastElements[i].ref);
    }
    return freshRefs;
  }

  window.__lexi.domIndex = {
    buildIndex: buildIndex,
    resolveRef: resolveRef,
    diffNew: diffNew,
  };
})();
