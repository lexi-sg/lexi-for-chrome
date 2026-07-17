// src/content/extract-text.js
//
// Readability-lite main-content text extraction.
//
// CLASSIC SCRIPT — injected via chrome.scripting.executeScript, NOT an ES
// module. Do not use `import`/`export`. Publishes its API on the shared
// `window.__lexi` namespace so content-script.js (injected after this file,
// per service-worker.js's fixed injection order) can call it.
//
// window.__lexi.extractText.extractReadable() -> {text, truncated, title, url}

(function () {
  if (window.__lexi && window.__lexi.extractText) {
    // Already installed by a previous injection into this page — no-op.
    return;
  }
  window.__lexi = window.__lexi || {};

  // Mirrors LIMITS.MAX_TEXT_TOKENS (12000) from src/config.js at ~4 chars/token.
  // Content scripts cannot `import` config.js (see config.js header comment),
  // so this cap is intentionally duplicated here as a literal.
  var MAX_TEXT_CHARS = 48000;

  var REMOVE_SELECTOR =
    'script, style, noscript, nav, aside, header, footer, ' +
    '[aria-hidden="true"], [hidden]';

  var CONTENT_CLASS_RE = /article|content|post|prose|main/i;

  function collapseWhitespace(str) {
    return String(str || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // innerText only reflects real rendered/layout state — a fully detached
  // clone always reports "" for innerText in Chromium. So the clone is
  // stitched into the live document (off-screen, non-interactive) just long
  // enough to read its rendered text, then removed. Never left in the DOM.
  function withRenderedClone(node, fn) {
    var container = document.createElement('div');
    container.style.cssText =
      'all: initial !important;' +
      'position: fixed !important;' +
      'top: 0 !important;' +
      'left: -999999px !important;' +
      'width: 1024px !important;' +
      'height: auto !important;' +
      'pointer-events: none !important;' +
      'z-index: -1 !important;';
    container.appendChild(node);
    var root = document.documentElement || document.body;
    root.appendChild(container);
    try {
      return fn(container);
    } finally {
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
    }
  }

  function textLengthOf(el) {
    var t = el.innerText;
    return t ? t.length : 0;
  }

  function pickContentRoot(root) {
    var candidates = [];

    var article = root.querySelector('article');
    if (article) candidates.push(article);

    var main = root.querySelector('main');
    if (main) candidates.push(main);

    var roleMain = root.querySelector('[role="main"]');
    if (roleMain) candidates.push(roleMain);

    var classCandidates = root.querySelectorAll('[class]');
    for (var i = 0; i < classCandidates.length; i++) {
      var el = classCandidates[i];
      if (CONTENT_CLASS_RE.test(el.className) && textLengthOf(el) > 200) {
        candidates.push(el);
      }
    }

    if (!candidates.length) return root;

    var best = candidates[0];
    var bestLen = textLengthOf(best);
    for (var j = 1; j < candidates.length; j++) {
      var len = textLengthOf(candidates[j]);
      if (len > bestLen) {
        best = candidates[j];
        bestLen = len;
      }
    }
    return best;
  }

  function extractReadable() {
    var title = document.title || '';
    var url = location.href;

    var bodySource = document.body;
    if (!bodySource) {
      return { text: '', truncated: false, title: title, url: url };
    }

    var clone = bodySource.cloneNode(true);

    // Strip structural noise before measuring/selecting a content root.
    var toRemove = clone.querySelectorAll(REMOVE_SELECTOR);
    for (var i = 0; i < toRemove.length; i++) {
      var el = toRemove[i];
      if (el.parentNode) el.parentNode.removeChild(el);
    }

    var rawText = withRenderedClone(clone, function (container) {
      var root = pickContentRoot(container.firstChild || container);
      return root.innerText || root.textContent || '';
    });

    var text = collapseWhitespace(rawText);
    var truncated = false;

    if (text.length > MAX_TEXT_CHARS) {
      var headLen = Math.floor(MAX_TEXT_CHARS * 0.7);
      var tailLen = Math.floor(MAX_TEXT_CHARS * 0.2);
      var head = text.slice(0, headLen);
      var tail = text.slice(text.length - tailLen);
      text = head + '\n\n…[truncated]…\n\n' + tail;
      truncated = true;
    }

    return { text: text, truncated: truncated, title: title, url: url };
  }

  window.__lexi.extractText = { extractReadable: extractReadable };
})();
