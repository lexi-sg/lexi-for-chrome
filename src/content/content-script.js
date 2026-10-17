// src/content/content-script.js
//
// In-page message listener that orchestrates extraction, indexing, overlay
// drawing, ref-resolution, and the synthetic-action fallback. This is the
// LAST content file injected by service-worker.js's ensureInjected(), after
// extract-text.js, dom-index.js, find-text.js and overlay.js have already
// installed window.__lexi.extractText / .domIndex / .findText / .overlay.
//
// CLASSIC SCRIPT — no `import`/`export`. Runs in the ISOLATED world.
// Guarded by window.__lexiInjected so a re-injection into the same page is
// a safe no-op (service-worker.js is expected to check this too, but the
// guard lives here as the source of truth per spec).

(function () {
  if (window.__lexiInjected) {
    return;
  }
  window.__lexiInjected = true;

  // Mirrors the CS_* subset of MSG from src/config.js. Content scripts
  // cannot `import` config.js (see that file's header comment), so these
  // string literals MUST stay byte-for-byte in sync with it.
  var MSG = {
    CS_EXTRACT: 'CS_EXTRACT',
    CS_PAGE: 'CS_PAGE',
    CS_INDEX: 'CS_INDEX',
    CS_ELEMENTS: 'CS_ELEMENTS',
    CS_OVERLAY: 'CS_OVERLAY',
    CS_HIDE_FOR_TOOL: 'CS_HIDE_FOR_TOOL',
    CS_SHOW_AFTER_TOOL: 'CS_SHOW_AFTER_TOOL',
    CS_RESOLVE_REF: 'CS_RESOLVE_REF',
    CS_REF_INFO: 'CS_REF_INFO',
    CS_SYNTHETIC_ACTION: 'CS_SYNTHETIC_ACTION',
    CS_ACTION_RESULT: 'CS_ACTION_RESULT',
    CS_FIND_TEXT: 'CS_FIND_TEXT',
    CS_TEXT_FOUND: 'CS_TEXT_FOUND',
    CS_FIELD_INFO: 'CS_FIELD_INFO',
    CS_FIELD: 'CS_FIELD',
  };

  function lexi() {
    return window.__lexi || {};
  }

  function errMessage(err) {
    return String((err && err.message) || err || 'unknown error');
  }

  // ---------------------------------------------------------------------
  // CS_EXTRACT -> CS_PAGE{text, truncated, title, url, elements?, signals?}
  // ---------------------------------------------------------------------
  function handleExtract(message, sendResponse) {
    var mode = (message && message.mode) || 'both';
    var response = {
      type: MSG.CS_PAGE,
      text: '',
      truncated: false,
      title: document.title || '',
      url: location.href,
      elements: [],
    };

    try {
      if (mode === 'text' || mode === 'both') {
        var extracted = lexi().extractText.extractReadable();
        response.text = extracted.text;
        response.truncated = extracted.truncated;
        response.title = extracted.title;
        response.url = extracted.url;
      }
      if (mode === 'interactive' || mode === 'both') {
        var index = lexi().domIndex.buildIndex();
        response.elements = index.elements;
        response.signals = index.signals;
        // Keep the pixel marks in sync with the latest index so a
        // screenshot taken right after read_page shows the same [eN]
        // labels the model just read as text (page_perception_design).
        lexi().overlay.drawMarks(index.elements);
      }
      sendResponse(response);
    } catch (err) {
      response.error = errMessage(err);
      sendResponse(response);
    }
  }

  // ---------------------------------------------------------------------
  // CS_INDEX -> CS_ELEMENTS{elements, signals, url, title}
  // ---------------------------------------------------------------------
  function handleIndex(message, sendResponse) {
    try {
      var index = lexi().domIndex.buildIndex();
      lexi().overlay.drawMarks(index.elements);
      sendResponse({
        type: MSG.CS_ELEMENTS,
        elements: index.elements,
        signals: index.signals,
        url: location.href,
        title: document.title || '',
      });
    } catch (err) {
      sendResponse({ type: MSG.CS_ELEMENTS, elements: [], error: errMessage(err) });
    }
  }

  // ---------------------------------------------------------------------
  // CS_RESOLVE_REF{ref} -> CS_REF_INFO{found, bbox, sensitive}
  // ---------------------------------------------------------------------
  function handleResolveRef(message, sendResponse) {
    try {
      var info = lexi().domIndex.resolveRef(message && message.ref);
      if (!info || !info.found) {
        sendResponse({ type: MSG.CS_REF_INFO, found: false });
        return;
      }
      sendResponse({
        type: MSG.CS_REF_INFO,
        found: true,
        bbox: info.bbox,
        sensitive: !!info.sensitive,
        // Viewport size (CSS px) so the SW's CDP path can tell whether the
        // element's bbox center is on-screen before dispatching a trusted
        // click at viewport-relative coords. Additive/optional field.
        viewport: {
          w: window.innerWidth || document.documentElement.clientWidth || 0,
          h: window.innerHeight || document.documentElement.clientHeight || 0,
        },
      });
    } catch (err) {
      sendResponse({ type: MSG.CS_REF_INFO, found: false, error: errMessage(err) });
    }
  }

  // ---------------------------------------------------------------------
  // CS_FIND_TEXT{query, maxResults} -> CS_TEXT_FOUND{result}
  // ---------------------------------------------------------------------
  function handleFindText(message, sendResponse) {
    try {
      var result = lexi().findText.findText(message && message.query, message && message.maxResults);
      sendResponse({ type: MSG.CS_TEXT_FOUND, result: result });
    } catch (err) {
      sendResponse({ type: MSG.CS_TEXT_FOUND, result: null, error: errMessage(err) });
    }
  }

  // ---------------------------------------------------------------------
  // CS_FIELD_INFO{ref?} -> CS_FIELD{found, isSearch, isLink}
  // ---------------------------------------------------------------------
  function handleFieldInfo(message, sendResponse) {
    try {
      var info = lexi().domIndex.fieldInfo(message && message.ref);
      sendResponse({ type: MSG.CS_FIELD, found: !!info.found, isSearch: !!info.isSearch, isLink: !!info.isLink });
    } catch (err) {
      sendResponse({ type: MSG.CS_FIELD, found: false, isSearch: false, isLink: false, error: errMessage(err) });
    }
  }

  // ---------------------------------------------------------------------
  // CS_OVERLAY{show} -> overlay red border + acting pill
  // ---------------------------------------------------------------------
  function handleOverlay(message, sendResponse) {
    try {
      lexi().overlay.setActing(!!(message && message.show));
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: errMessage(err) });
    }
  }

  // ---------------------------------------------------------------------
  // CS_HIDE_FOR_TOOL / CS_SHOW_AFTER_TOOL — hide/restore our own overlay so
  // screenshots never capture the extension's own UI.
  // ---------------------------------------------------------------------
  function handleHideForTool(message, sendResponse) {
    try {
      lexi().overlay.hide();
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: errMessage(err) });
    }
  }

  function handleShowAfterTool(message, sendResponse) {
    try {
      lexi().overlay.restore();
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: errMessage(err) });
    }
  }

  // ---------------------------------------------------------------------
  // Synthetic-action FALLBACK (used when chrome.debugger/CDP is unavailable
  // or not attached). Trusted-event CDP dispatch is the primary path and
  // lives in the SW's cdp-driver.js / action-executor.js — this is only
  // the degraded, still-functional path.
  // ---------------------------------------------------------------------
  // Key names the model sends ("enter", "esc", "down") -> KeyboardEvent.key,
  // plus the legacy keyCode/which that older page scripts still test
  // (`e.which === 13`), mirroring cdp-driver.js's SPECIAL_KEYS.
  var NAMED_KEYS = {
    enter: ['Enter', 13], return: ['Enter', 13], tab: ['Tab', 9], escape: ['Escape', 27], esc: ['Escape', 27],
    backspace: ['Backspace', 8], delete: ['Delete', 46], space: [' ', 32],
    arrowup: ['ArrowUp', 38], up: ['ArrowUp', 38], arrowdown: ['ArrowDown', 40], down: ['ArrowDown', 40],
    arrowleft: ['ArrowLeft', 37], left: ['ArrowLeft', 37], arrowright: ['ArrowRight', 39], right: ['ArrowRight', 39],
    home: ['Home', 36], end: ['End', 35],
  };

  function keyIdentity(token) {
    var named = NAMED_KEYS[String(token).toLowerCase()];
    if (named) return { key: named[0], code: named[1] };
    if (Array.from(token).length === 1) return { key: token, code: token.toUpperCase().charCodeAt(0) };
    return { key: token, code: 0 };
  }

  /** Dispatch one keyboard event; false when the page cancelled it. */
  function dispatchKeyboardEvent(target, type, key, modifiers) {
    var id = keyIdentity(key);
    // Legacy codes go in the init dict (Chrome honours keyCode/charCode/which
    // there): a property defined on this isolated-world wrapper would be
    // invisible to the page's own listeners.
    var legacy = type === 'keypress' && id.key.length === 1 ? id.key.charCodeAt(0) : id.code;
    var evt = new KeyboardEvent(type, {
      key: id.key,
      keyCode: legacy,
      which: legacy,
      charCode: type === 'keypress' ? legacy : 0,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: !!modifiers.ctrl,
      altKey: !!modifiers.alt,
      shiftKey: !!modifiers.shift,
      metaKey: !!modifiers.meta,
    });
    return target.dispatchEvent(evt);
  }

  // Untrusted key events never trigger the browser's own Enter behaviour, so
  // the fallback performs a form's implicit submission itself (HTML spec:
  // click the default button; with none, submit only a one-field form).
  var NON_SUBMITTING_INPUTS = ['button', 'submit', 'reset', 'image', 'file', 'hidden'];
  var BLOCKS_IMPLICIT_SUBMIT = [
    'text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number',
  ];

  function implicitSubmit(target) {
    if (!target || target.tagName !== 'INPUT' || !target.form || !target.isConnected) return false;
    if (NON_SUBMITTING_INPUTS.indexOf(target.type) !== -1) return false;
    var form = target.form;
    var fields = Array.prototype.slice.call(form.elements);
    var defaultButton = fields.find(function (el) {
      return (el.tagName === 'BUTTON' || el.tagName === 'INPUT') && (el.type === 'submit' || el.type === 'image');
    });
    if (defaultButton) {
      if (defaultButton.disabled) return false;
      defaultButton.click();
      return true;
    }
    var blocking = fields.filter(function (el) {
      return el.tagName === 'INPUT' && BLOCKS_IMPLICIT_SUBMIT.indexOf(el.type) !== -1;
    });
    if (blocking.length > 1) return false;
    form.requestSubmit();
    return true;
  }

  function parseKeyCombo(keys) {
    var parts = String(keys || '')
      .split('+')
      .map(function (p) {
        return p.trim();
      })
      .filter(Boolean);
    var modifiers = { ctrl: false, alt: false, shift: false, meta: false };
    var mainKey = parts.length ? parts[parts.length - 1] : '';

    parts.slice(0, -1).forEach(function (p) {
      var low = p.toLowerCase();
      if (low === 'ctrl' || low === 'control') modifiers.ctrl = true;
      else if (low === 'alt') modifiers.alt = true;
      else if (low === 'shift') modifiers.shift = true;
      else if (low === 'meta' || low === 'cmd' || low === 'command') modifiers.meta = true;
    });

    return { key: mainKey, modifiers: modifiers };
  }

  function nativeValueSetterFor(el) {
    var proto =
      el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    return descriptor && descriptor.set ? descriptor.set : null;
  }

  function syntheticClick(ref) {
    var info = lexi().domIndex.resolveRef(ref);
    if (!info || !info.found || !info.element) {
      return { ok: false, error: 'element not found for ref ' + ref };
    }
    if (info.sensitive) {
      return { ok: false, error: 'refusing to interact with a sensitive field; call ask_user instead' };
    }
    try {
      info.element.scrollIntoView({ block: 'center', inline: 'center' });
      info.element.click();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  function syntheticType(ref, text) {
    var info = lexi().domIndex.resolveRef(ref);
    if (!info || !info.found || !info.element) {
      return { ok: false, error: 'element not found for ref ' + ref };
    }
    if (info.sensitive) {
      return { ok: false, error: 'refusing to type into a password/payment field; call ask_user instead' };
    }
    var el = info.element;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      if ('value' in el) {
        var setter = nativeValueSetterFor(el);
        if (setter) {
          setter.call(el, text);
        } else {
          el.value = text;
        }
      } else {
        el.textContent = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  function syntheticKeys(ref, keys) {
    var combo = parseKeyCombo(keys);
    if (!combo.key) return { ok: false, error: 'no key specified' };

    var target = document.activeElement || document.body;
    if (ref) {
      var info = lexi().domIndex.resolveRef(ref);
      if (info && info.found && info.element) target = info.element;
    }

    try {
      var id = keyIdentity(combo.key);
      var mods = combo.modifiers;
      var plain = !mods.ctrl && !mods.alt && !mods.meta;
      var proceed = dispatchKeyboardEvent(target, 'keydown', combo.key, mods);
      if (proceed && plain && (id.key === 'Enter' || id.key.length === 1)) {
        proceed = dispatchKeyboardEvent(target, 'keypress', combo.key, mods);
      }
      dispatchKeyboardEvent(target, 'keyup', combo.key, mods);
      var submitted = proceed && plain && id.key === 'Enter' && implicitSubmit(target);
      return { ok: true, submitted: submitted };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  // Native <select> dropdowns: the option list is drawn by the browser, not
  // the page, so a click cannot pick from it. Set the value and fire
  // input/change the way a user's pick does (the event a portal's cascading
  // "district -> tehsil" postback listens for).
  var MAX_OPTIONS_LISTED = 30;

  function optionLabel(opt) {
    return String(opt.label || opt.text || opt.value || '').replace(/\s+/g, ' ').trim();
  }

  function pickOption(select, wanted) {
    var w = String(wanted || '').replace(/\s+/g, ' ').trim().toLowerCase();
    var opts = Array.prototype.filter.call(select.options, function (o) {
      return !o.disabled;
    });
    function only(pred) {
      var hits = opts.filter(pred);
      return hits.length === 1 ? { option: hits[0] } : hits.length > 1 ? { ambiguous: hits } : null;
    }
    var exact =
      only(function (o) { return o.value === wanted; }) ||
      only(function (o) { return optionLabel(o).toLowerCase() === w; }) ||
      only(function (o) { return String(o.value).toLowerCase() === w; });
    if (exact) return exact;
    if (!w) return null;
    return (
      only(function (o) { return optionLabel(o).toLowerCase().indexOf(w) === 0; }) ||
      only(function (o) { return optionLabel(o).toLowerCase().indexOf(w) !== -1; })
    );
  }

  function syntheticSelect(ref, wanted) {
    var info = lexi().domIndex.resolveRef(ref);
    if (!info || !info.found || !info.element) {
      return { ok: false, error: 'element not found for ref ' + ref };
    }
    var el = info.element;
    if (el.tagName !== 'SELECT') {
      return { ok: false, error: 'Element ' + ref + ' is not a <select> dropdown. For a custom dropdown, click it, then click the option.' };
    }
    if (el.disabled) return { ok: false, error: 'The dropdown ' + ref + ' is disabled.' };
    var options = Array.prototype.slice.call(el.options, 0, MAX_OPTIONS_LISTED).map(optionLabel);
    var pick = pickOption(el, wanted);
    if (!pick || pick.ambiguous) {
      var reason = pick
        ? 'More than one option matches "' + wanted + '".'
        : 'No option matches "' + wanted + '".';
      return { ok: true, result: { selected: null, reason: reason, options: options, optionCount: el.options.length } };
    }
    try {
      el.focus();
      if (el.multiple) {
        pick.option.selected = true;
      } else {
        el.value = pick.option.value;
        pick.option.selected = true;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: true,
        result: { selected: { value: pick.option.value, label: optionLabel(pick.option) }, optionCount: el.options.length },
      };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  function syntheticScroll(direction, ref) {
    try {
      if (ref) {
        var info = lexi().domIndex.resolveRef(ref);
        if (!info || !info.found || !info.element) {
          return { ok: false, error: 'element not found for ref ' + ref };
        }
        info.element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        return { ok: true };
      }

      if (direction === 'top') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (direction === 'bottom') {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      } else if (direction === 'up') {
        window.scrollBy({ top: -Math.round(window.innerHeight * 0.8), behavior: 'smooth' });
      } else {
        window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: 'smooth' });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  function handleSyntheticAction(message, sendResponse) {
    var action = message && message.action;
    var result;

    try {
      if (action === 'click') {
        result = syntheticClick(message.ref);
      } else if (action === 'type') {
        result = syntheticType(message.ref, message.text || '');
      } else if (action === 'keys') {
        result = syntheticKeys(message.ref, message.keys || '');
      } else if (action === 'scroll') {
        result = syntheticScroll(message.direction, message.ref);
      } else if (action === 'select') {
        result = syntheticSelect(message.ref, message.option);
      } else {
        result = { ok: false, error: 'unknown synthetic action: ' + action };
      }
    } catch (err) {
      result = { ok: false, error: errMessage(err) };
    }

    sendResponse({ type: MSG.CS_ACTION_RESULT, ok: !!result.ok, error: result.error || null, result: result.result || null });
  }

  // ---------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return false;

    switch (message.type) {
      case MSG.CS_EXTRACT:
        handleExtract(message, sendResponse);
        return true;
      case MSG.CS_INDEX:
        handleIndex(message, sendResponse);
        return true;
      case MSG.CS_RESOLVE_REF:
        handleResolveRef(message, sendResponse);
        return true;
      case MSG.CS_OVERLAY:
        handleOverlay(message, sendResponse);
        return true;
      case MSG.CS_HIDE_FOR_TOOL:
        handleHideForTool(message, sendResponse);
        return true;
      case MSG.CS_SHOW_AFTER_TOOL:
        handleShowAfterTool(message, sendResponse);
        return true;
      case MSG.CS_SYNTHETIC_ACTION:
        handleSyntheticAction(message, sendResponse);
        return true;
      case MSG.CS_FIND_TEXT:
        handleFindText(message, sendResponse);
        return true;
      case MSG.CS_FIELD_INFO:
        handleFieldInfo(message, sendResponse);
        return true;
      default:
        return false;
    }
  });
})();
