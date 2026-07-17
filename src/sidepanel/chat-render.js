// src/sidepanel/chat-render.js
//
// Streaming-safe renderer for the #messages log. Buffers incoming SSE text
// deltas and flushes on requestAnimationFrame so a burst of small deltas (or
// a stall/mid-word blink) never causes visible jank — the "blink/burst/
// stall" problem from brief 5.
//
// Renders a minimal, SAFE markdown subset (headings, bold/italic, unordered/
// ordered lists, fenced code blocks, inline code, tables, links) by building
// DOM nodes directly / via textContent. Raw model (or page-derived) text is
// NEVER passed through innerHTML — this is the XSS boundary between
// untrusted page content that may have leaked into an answer and the panel
// DOM.
//
// ES module — imported by sidepanel.js only.

// Matches a leading severity label — optionally wrapped in markdown emphasis
// ("**HIGH** — …", "*MED:* …") — at the start of a paragraph or list item.
const SEVERITY_RE = /^\s*[*_]{0,3}(HIGH|MED(?:IUM)?|LOW)[*_]{0,3}\b[\s:.\-–—]*/i;

/**
 * @param {HTMLElement} containerEl - the #messages log element deltas/
 *   messages are appended into.
 * @returns {{
 *   appendUser: (text: string) => HTMLElement,
 *   startAssistant: () => AssistantHandle,
 *   appendSystemNote: (text: string) => HTMLElement,
 * }}
 */
export function createRenderer(containerEl) {
  /**
   * @param {string} text
   */
  function appendUser(text) {
    const el = document.createElement('div');
    el.className = 'lexi-msg lexi-msg-user';
    el.textContent = text;
    containerEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  /**
   * A small informational aside rendered inline in the log (e.g. an
   * injection-guard flag, or "Enable agent actions" system notices).
   * @param {string} text
   */
  function appendSystemNote(text) {
    const el = document.createElement('div');
    el.className = 'lexi-msg lexi-injection-flag';
    el.textContent = text;
    containerEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  /**
   * Starts a new streaming assistant message. Returns a handle the caller
   * feeds deltas into and finalizes when the stream ends.
   * @returns {AssistantHandle}
   */
  function startAssistant() {
    const root = document.createElement('div');
    root.className = 'lexi-msg lexi-msg-assistant';
    containerEl.appendChild(root);

    const body = document.createElement('div');
    body.className = 'lexi-msg-body';
    root.appendChild(body);

    const caret = document.createElement('span');
    caret.className = 'lexi-caret';
    root.appendChild(caret);

    let raw = '';
    let rafHandle = null;
    let finalized = false;
    let tokensSavedCount = 0;

    function flush() {
      rafHandle = null;
      renderMarkdown(body, raw);
      scrollToBottom();
    }

    function scheduleFlush() {
      if (rafHandle !== null || finalized) return;
      rafHandle = requestAnimationFrame(flush);
    }

    return {
      /**
       * @param {string} delta - incremental text_delta content from the SSE
       *   stream.
       */
      pushDelta(delta) {
        if (finalized || !delta) return;
        raw += delta;
        scheduleFlush();
      },

      /**
       * Records tokens saved by an image-history-trim (per the token-
       * budgeting design) so a tiny cost-hint slot can render it.
       * @param {number} count
       */
      addTokensSaved(count) {
        tokensSavedCount += Number(count) || 0;
        renderTokensSavedSlot(root, tokensSavedCount);
      },

      /**
       * Renders an inline image bubble (used by "Screenshot & ask") above
       * the streamed text.
       * @param {string} dataUrl - a `data:image/...;base64,...` URL.
       */
      appendImage(dataUrl) {
        const img = document.createElement('img');
        img.className = 'lexi-msg-image';
        img.src = dataUrl;
        img.alt = 'Captured screenshot';
        root.insertBefore(img, body);
        scrollToBottom();
      },

      /**
       * Ends the stream: cancels any pending rAF flush, does one final
       * synchronous render, removes the caret, and returns the fully
       * rendered root element.
       * @param {{ notLegalAdviceFooter?: boolean, injectionFlagged?: boolean }} [opts]
       */
      finalize(opts = {}) {
        if (finalized) return root;
        finalized = true;
        if (rafHandle !== null) {
          cancelAnimationFrame(rafHandle);
          rafHandle = null;
        }
        renderMarkdown(body, raw);

        if (opts.injectionFlagged) {
          const flag = document.createElement('div');
          flag.className = 'lexi-injection-flag';
          flag.textContent =
            '⚠ This page appears to contain a hidden instruction — Lexi ignored it.';
          root.insertBefore(flag, body);
        }

        if (opts.notLegalAdviceFooter !== false && raw.trim()) {
          const footer = document.createElement('div');
          footer.className = 'lexi-disclaimer-line';
          footer.textContent = 'Not legal advice.';
          root.appendChild(footer);
        }

        caret.remove();
        scrollToBottom();
        return root;
      },

      /** The raw accumulated text so far (for callers that need to inspect it). */
      get text() {
        return raw;
      },
    };
  }

  function scrollToBottom() {
    containerEl.scrollTop = containerEl.scrollHeight;
  }

  return { appendUser, startAssistant, appendSystemNote };
}

/**
 * @typedef {{
 *   pushDelta: (delta: string) => void,
 *   addTokensSaved: (count: number) => void,
 *   appendImage: (dataUrl: string) => void,
 *   finalize: (opts?: { notLegalAdviceFooter?: boolean, injectionFlagged?: boolean }) => HTMLElement,
 *   text: string,
 * }} AssistantHandle
 */

function renderTokensSavedSlot(root, count) {
  let slot = root.querySelector('.lexi-tokens-saved');
  if (!slot) {
    slot = document.createElement('div');
    slot.className = 'lexi-tokens-saved lexi-disclaimer-line';
    root.appendChild(slot);
  }
  slot.textContent = `~${count.toLocaleString()} tokens saved by trimming older screenshots.`;
}

// ---------------------------------------------------------------------------
// Minimal, allowlist markdown -> DOM renderer. No innerHTML of model/page
// text anywhere below; every text run lands via textContent or a text node.
// ---------------------------------------------------------------------------

/**
 * Clears `container` and rebuilds it from `raw` markdown. Safe to call
 * repeatedly (e.g. on every rAF flush) against the same, growing `raw`.
 * @param {HTMLElement} container
 * @param {string} raw
 */
function renderMarkdown(container, raw) {
  container.textContent = '';
  const blocks = splitBlocks(raw);
  for (const block of blocks) {
    const node = renderBlock(block);
    if (node) container.appendChild(node);
  }
}

/**
 * Splits raw text into block-level chunks: fenced code blocks, tables,
 * lists, and paragraphs (split on blank lines).
 * @param {string} raw
 * @returns {Array<{type: string, lines: string[]}>}
 */
function splitBlocks(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const fenceLines = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        fenceLines.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or overshoot if unterminated — fine mid-stream)
      blocks.push({ type: 'code', lines: fenceLines });
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && isTableSeparator(lines[i + 1])) {
      const tableLines = [line];
      i++;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'table', lines: tableLines });
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const listLines = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || (lines[i].trim() !== '' && listLines.length))) {
        if (lines[i].trim() === '') break;
        listLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'list', lines: listLines });
      continue;
    }

    if (/^\s*#{1,3}\s+/.test(line)) {
      blocks.push({ type: 'heading', lines: [line] });
      i++;
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const paraLines = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'para', lines: paraLines });
  }

  return blocks;
}

function isBlockStart(line) {
  return (
    /^\s*```/.test(line) ||
    /^\s*#{1,3}\s+/.test(line) ||
    /^\s*([-*]|\d+\.)\s+/.test(line) ||
    /^\s*\|.*\|\s*$/.test(line)
  );
}

function isTableSeparator(line) {
  return typeof line === 'string' && /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

/**
 * @param {{type: string, lines: string[]}} block
 * @returns {HTMLElement|null}
 */
function renderBlock(block) {
  switch (block.type) {
    case 'code':
      return renderCodeBlock(block.lines);
    case 'table':
      return renderTable(block.lines);
    case 'list':
      return renderList(block.lines);
    case 'heading':
      return renderHeading(block.lines[0]);
    case 'para':
      return renderParagraph(block.lines);
    default:
      return null;
  }
}

function renderCodeBlock(lines) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = lines.join('\n');
  pre.appendChild(code);
  return pre;
}

function renderHeading(line) {
  const match = /^\s*(#{1,3})\s+(.*)$/.exec(line);
  const level = match ? match[1].length : 3;
  const text = match ? match[2] : line;
  const h = document.createElement(`h${Math.min(level + 1, 3)}`);
  appendInline(h, text);
  return h;
}

function renderParagraph(lines) {
  const joined = lines.join(' ').trim();
  const severityMatch = SEVERITY_RE.exec(joined);
  if (severityMatch) {
    return renderRiskItem(severityMatch[1], joined.slice(severityMatch[0].length));
  }
  const p = document.createElement('p');
  appendInline(p, joined);
  return p;
}

function renderRiskItem(severityRaw, rest) {
  const severity = /high/i.test(severityRaw)
    ? 'high'
    : /low/i.test(severityRaw)
      ? 'low'
      : 'med';

  const item = document.createElement('div');
  item.className = `lexi-risk-item lexi-risk-${severity}`;

  const dot = document.createElement('span');
  dot.className = 'lexi-risk-dot';
  item.appendChild(dot);

  const body = document.createElement('div');
  body.className = 'lexi-risk-body';
  appendInline(body, rest);
  item.appendChild(body);

  return item;
}

function renderList(lines) {
  const ordered = /^\s*\d+\.\s+/.test(lines[0]);
  const list = document.createElement(ordered ? 'ol' : 'ul');
  for (const line of lines) {
    const text = line.replace(/^\s*([-*]|\d+\.)\s+/, '');
    const li = document.createElement('li');
    // A ranked risk list ("Flag risky terms") usually arrives as a markdown
    // list whose items lead with a severity label — render those with the
    // same severity treatment as standalone paragraphs.
    const severityMatch = SEVERITY_RE.exec(text);
    if (severityMatch) {
      li.appendChild(renderRiskItem(severityMatch[1], text.slice(severityMatch[0].length)));
    } else {
      appendInline(li, text);
    }
    list.appendChild(li);
  }
  return list;
}

function renderTable(lines) {
  const rows = lines
    .filter((_, idx) => idx !== 1) // drop the |---|---| separator row
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())
    );

  const wrap = document.createElement('div');
  wrap.className = 'lexi-table-scroll';
  const table = document.createElement('table');

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const cell of rows[0] || []) {
    const th = document.createElement('th');
    appendInline(th, cell);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows.slice(1)) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      appendInline(td, cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  wrap.appendChild(table);
  return wrap;
}

// Inline-level tokens: **bold**, *italic*, `code`, [text](url). Applied left
// to right over the text, appending real DOM nodes (never innerHTML).
const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/;

/**
 * Appends the inline-formatted rendering of `text` as child nodes of `el`.
 * @param {HTMLElement} el
 * @param {string} text
 */
function appendInline(el, text) {
  const parts = String(text ?? '').split(INLINE_RE);
  for (const part of parts) {
    if (!part) continue;

    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      el.appendChild(strong);
      continue;
    }

    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      el.appendChild(code);
      continue;
    }

    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (linkMatch) {
      const a = document.createElement('a');
      a.textContent = linkMatch[1];
      // Only allow http(s) targets; anything else renders as plain text to
      // avoid a javascript: URL sneaking through from injected page content.
      if (/^https?:\/\//i.test(linkMatch[2])) {
        a.href = linkMatch[2];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      el.appendChild(a);
      continue;
    }

    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      const em = document.createElement('em');
      em.textContent = part.slice(1, -1);
      el.appendChild(em);
      continue;
    }

    el.appendChild(document.createTextNode(part));
  }
}
