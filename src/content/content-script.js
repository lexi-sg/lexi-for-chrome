// src/content/content-script.js
//
// In-page message listener that orchestrates extraction, indexing, overlay
// drawing, ref-resolution, and the synthetic-action fallback. This is the
// LAST content file injected by service-worker.js's ensureInjected(), after
// extract-text.js, dom-index.js, and overlay.js have already installed
// window.__lexi.extractText / .domIndex / .overlay.
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
  };

  function lexi() {
    return window.__lexi || {};
  }

  function errMessage(err) {
    return String((err && err.message) || err || 'unknown error');
  }

  // ---------------------------------------------------------------------
  // CS_EXTRACT -> CS_PAGE{text, truncated, title, url, elements?}
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
  // CS_INDEX -> CS_ELEMENTS{elements}
  // ---------------------------------------------------------------------
  function handleIndex(message, sendResponse) {
    try {
      var index = lexi().domIndex.buildIndex();
      lexi().overlay.drawMarks(index.elements);
      sendResponse({ type: MSG.CS_ELEMENTS, elements: index.elements });
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
  function dispatchKeyboardEvent(target, type, key, modifiers) {
    var evt = new KeyboardEvent(type, {
      key: key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: !!modifiers.ctrl,
      altKey: !!modifiers.alt,
      shiftKey: !!modifiers.shift,
      metaKey: !!modifiers.meta,
    });
    target.dispatchEvent(evt);
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
      dispatchKeyboardEvent(target, 'keydown', combo.key, combo.modifiers);
      dispatchKeyboardEvent(target, 'keyup', combo.key, combo.modifiers);
      return { ok: true };
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
      } else {
        result = { ok: false, error: 'unknown synthetic action: ' + action };
      }
    } catch (err) {
      result = { ok: false, error: errMessage(err) };
    }

    sendResponse({ type: MSG.CS_ACTION_RESULT, ok: !!result.ok, error: result.error || null });
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
      default:
        return false;
    }
  });
})();
