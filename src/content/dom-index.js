// src/content/dom-index.js
//
// Set-of-marks indexer: assigns persistent refs to visible interactive
// elements, builds a selectorMap (ref -> WeakRef<element>) plus a
// data-lexi-ref attribute fallback, and serializes an indented text tree.
//
// CLASSIC SCRIPT — no `import`/`export`. Publishes on window.__lexi.
//
// window.__lexi.domIndex.buildIndex()      -> {elements, tree, signals}
// window.__lexi.domIndex.resolveRef(ref)   -> {found, element, bbox, sensitive}
// window.__lexi.domIndex.diffNew(prevRefs) -> string[] refs new since prevRefs
// window.__lexi.domIndex.refFor(el)        -> ref for any element (scroll target)
// window.__lexi.domIndex.fieldInfo(ref?)   -> {found, isSearch, isLink}
// window.__lexi.domIndex.detectSignals()   -> {loginWall, captcha} ({reason, blocking} | null each)

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

  // A native select, checkbox or radio made transparent and laid over a
  // styled stand-in (wikipedia.org's language picker) is still the control
  // the user operates, so it stays in the index.
  function isTransparentControl(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'select') return true;
    var type = (el.getAttribute('type') || '').toLowerCase();
    return tag === 'input' && (type === 'checkbox' || type === 'radio');
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    var rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;

    var style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity) === 0 && !isTransparentControl(el)) return false;

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

  // Words in a field's name/id/placeholder/label that mark it as a one-time
  // code or CAPTCHA answer — the user types those, never the agent.
  var CODE_FIELD_TOKENS = ['otp', 'totp', '2fa', 'mfa', 'passcode', 'captcha'];
  var CODE_FIELD_PAIRS = [['one', 'time'], ['verification', 'code'], ['security', 'code'], ['auth', 'code']];

  function hintTokens(el) {
    var raw = [
      el.getAttribute('name'),
      el.id,
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      accessibleName(el),
    ].join(' ');
    return raw
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  function isCodeField(el) {
    var tokens = hintTokens(el);
    if (tokens.some(function (t) { return CODE_FIELD_TOKENS.indexOf(t) !== -1 || t.indexOf('captcha') !== -1; })) {
      return true;
    }
    return CODE_FIELD_PAIRS.some(function (pair) {
      var i = tokens.indexOf(pair[0]);
      return i !== -1 && tokens[i + 1] === pair[1];
    });
  }

  function isSensitive(el) {
    if (el.tagName.toLowerCase() !== 'input') return false;
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    var autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(^|\s)cc-/.test(autocomplete)) return true;
    if (/(^|\s)one-time-code(\s|$)/.test(autocomplete)) return true;
    if (['', 'text', 'tel', 'number'].indexOf(type) !== -1 && isCodeField(el)) return true;
    return false;
  }

  // A text box whose Enter runs a search (not a form that files, sends or
  // buys something). The SW lets typing a query and running the search go
  // without a confirm; Enter anywhere else stays a SUBMIT.
  var SEARCH_HINT_TOKENS = ['search', 'query', 'keyword', 'keywords', 'find', 'lookup', 'q', 'searchtext', 'searchbox'];

  function isSearchField(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    var role = (el.getAttribute('role') || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && role !== 'searchbox' && role !== 'combobox') return false;
    if (isSensitive(el)) return false;
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'input' && ['text', 'search'].indexOf(type) === -1) return false;
    if (type === 'search' || role === 'searchbox') return true;
    if (el.closest('[role="search"], search')) return true;
    var tokens = hintTokens(el);
    if (tokens.some(function (t) { return SEARCH_HINT_TOKENS.indexOf(t) !== -1; })) return true;
    var form = el.form;
    var formHint = form ? (form.getAttribute('action') || '') + ' ' + (form.id || '') + ' ' + (form.getAttribute('name') || '') : '';
    return /search|query|find/i.test(formHint);
  }

  // ---------------------------------------------------------------------
  // Page signals — things only the user can get past (a sign-in wall, a
  // CAPTCHA). The agent loop pauses and hands over when one is blocking.
  // ---------------------------------------------------------------------

  var SIGN_IN_PATH_RE = /(^|[/_.-])(log-?in|sign-?in|signon|sso|auth|session)([/_.?-]|$)/i;
  var SIGN_IN_TEXT_RE =
    /\b(session (?:has )?(?:expired|timed out)|you (?:have been|are now) (?:logged|signed) out|please (?:log|sign) ?in to (?:continue|proceed|view|access|read))\b/i;
  var CAPTCHA_SRC_RE = /recaptcha|hcaptcha|turnstile|captcha/i;
  // A page this short around a sign-in form is the sign-in wall itself, not
  // a content page with a login box in its header.
  var WALL_TEXT_CHARS = 2500;

  function textLikeInputs(scope) {
    var inputs = scope.querySelectorAll('input');
    var n = 0;
    for (var i = 0; i < inputs.length; i++) {
      var type = (inputs[i].getAttribute('type') || 'text').toLowerCase();
      if (['text', 'email', 'tel'].indexOf(type) !== -1 && isVisible(inputs[i])) n += 1;
    }
    return n;
  }

  function detectLoginWall(pageText) {
    var pws = document.querySelectorAll('input[type="password" i]');
    for (var i = 0; i < pws.length; i++) {
      var pw = pws[i];
      if (pw.disabled || !isVisible(pw)) continue;
      // Sign-up and change-password forms ask for a NEW password.
      if ((pw.getAttribute('autocomplete') || '').toLowerCase() === 'new-password') continue;
      var scope = pw.form || document;
      if (textLikeInputs(scope) > 2) continue; // a longer form that merely has a password field
      var blocking = SIGN_IN_PATH_RE.test(location.pathname) || pageText.length < WALL_TEXT_CHARS;
      return { reason: 'A sign-in form is showing.', blocking: blocking };
    }
    if (SIGN_IN_TEXT_RE.test(pageText)) {
      return { reason: 'The page says the session ended or a sign-in is needed.', blocking: true };
    }
    return null;
  }

  function isCaptchaFrame(frame) {
    var src = frame.getAttribute('src') || '';
    if (!CAPTCHA_SRC_RE.test(src + ' ' + (frame.getAttribute('title') || ''))) return false;
    // reCAPTCHA v3 / invisible widgets only show a corner badge — not a challenge.
    if (/size=invisible/i.test(src) || frame.closest('.grecaptcha-badge')) return false;
    return isVisible(frame);
  }

  function detectCaptcha() {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      if (isCaptchaFrame(frames[i])) return { reason: 'A CAPTCHA challenge is showing.', blocking: true };
    }
    var widgets = document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile');
    for (var w = 0; w < widgets.length; w++) {
      if (widgets[w].getAttribute('data-size') === 'invisible') continue;
      if (isVisible(widgets[w])) return { reason: 'A CAPTCHA challenge is showing.', blocking: true };
    }
    var inputs = document.querySelectorAll('input');
    for (var k = 0; k < inputs.length; k++) {
      if (isVisible(inputs[k]) && hintTokens(inputs[k]).some(function (t) { return t.indexOf('captcha') !== -1; })) {
        return { reason: 'The page asks for a CAPTCHA code.', blocking: true };
      }
    }
    var imgs = document.querySelectorAll('img');
    for (var m = 0; m < imgs.length; m++) {
      var hint = (imgs[m].getAttribute('src') || '') + ' ' + (imgs[m].alt || '') + ' ' + (imgs[m].id || '');
      if (/captcha/i.test(hint) && isVisible(imgs[m])) {
        return { reason: 'The page asks for a CAPTCHA code.', blocking: true };
      }
    }
    return null;
  }

  function detectSignals() {
    var pageText = '';
    try {
      pageText = (document.body && document.body.innerText) || '';
    } catch (_e) {
      pageText = '';
    }
    return { loginWall: detectLoginWall(pageText), captcha: detectCaptcha() };
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
    return { elements: elements, tree: treeLines.join('\n'), signals: detectSignals() };
  }

  /** A ref for any element (e.g. the paragraph a find_text match is in), so
   * the agent can scroll to it. Not added to the interactive index. */
  function refFor(el) {
    var ref = getOrAssignRef(el);
    refMap.set(ref, makeWeakRef(el));
    return ref;
  }

  /** What the SW needs to know about an element before acting on it: is it
   * a search box or search button, or a plain link? These only browse, so the
   * SW lets them run without a prompt. `ref` omitted = the focused element. */
  function fieldInfo(ref) {
    var el = ref ? resolveRef(ref).element : document.activeElement;
    if (!el) return { found: false, isSearch: false, isLink: false };
    var isSearch = (isSearchField(el) && isSearchOnlyForm(el.form)) || isSearchButton(el);
    return { found: true, isSearch: isSearch, isLink: isPlainLink(el) };
  }

  var NON_TEXT_INPUT_TYPES = ['hidden', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio'];

  /** No form, or a form whose only text fields are search boxes -- so running
   * it cannot file, send or buy anything along with the query. */
  function isSearchOnlyForm(form) {
    if (!form) return true;
    var fields = form.querySelectorAll('input, textarea');
    for (var i = 0; i < fields.length; i++) {
      var type = (fields[i].getAttribute('type') || 'text').toLowerCase();
      if (NON_TEXT_INPUT_TYPES.indexOf(type) === -1 && !isSearchField(fields[i])) return false;
    }
    return true;
  }

  function isSearchButton(el) {
    var btn = el.closest('button, input[type="submit"], input[type="image"], [role="button"]');
    if (!btn) return false;
    var form = btn.form || btn.closest('form');
    if (form) {
      var boxes = form.querySelectorAll('input, textarea, [role="searchbox"], [role="combobox"]');
      return Array.prototype.some.call(boxes, isSearchField) && isSearchOnlyForm(form);
    }
    return !!btn.closest('[role="search"], search');
  }

  // A link that only takes you somewhere: an http(s) href the page wrote, not
  // a script hook, a download, a Rails-style data-method, or a label that
  // reads like an action (sign out, unsubscribe, accept…).
  var LINK_ACTION_RE =
    /\b(log ?out|sign ?out|unsubscribe|subscribe|delete|remove|cancel|confirm|approve|accept|decline|reject|archive|follow|unfollow|like|vote|join|leave|enable|disable|activate|deactivate|reset|buy|pay|order|checkout|book|reserve|send|submit)\b/i;

  function isPlainLink(el) {
    var link = el.closest('a[href]');
    if (!link || link.hasAttribute('download')) return false;
    if (link.hasAttribute('data-method') || link.hasAttribute('data-turbo-method')) return false;
    if ((link.getAttribute('role') || '').toLowerCase() === 'button') return false;
    var raw = (link.getAttribute('href') || '').trim();
    if (!raw || raw.charAt(0) === '#') return false;
    if (!/^https?:$/.test(link.protocol || '')) return false;
    var label = [link.textContent, link.getAttribute('aria-label'), link.getAttribute('title')].join(' ');
    return !LINK_ACTION_RE.test(label);
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
    refFor: refFor,
    fieldInfo: fieldInfo,
    detectSignals: detectSignals,
  };
})();
