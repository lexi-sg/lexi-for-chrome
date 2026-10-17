// src/sidepanel/agent-activity.js
//
// Renders an Agent Mode run in the message log the way the Lexi web app shows
// an agent's work (lexi-frontend components/Messages/blocks/SegmentTimeline):
//   - every unbroken run of thinking and tool steps is one collapsible group,
//     headed "Thinking…" while it runs and a past-tense title once it is done;
//   - inside, each step is a row on a dashed timeline: the tool's icon, a
//     present-progressive label while it runs and a past-tense one after, a
//     spinner or check, a one-line detail of what it acted on, and an
//     "Error details" toggle when it failed; a "Done" row closes the group;
//   - groups stay open while the run is live and collapse when it ends;
//   - text the model writes between steps sits between groups in muted grey,
//     and the answer follows the last group.
//
// Model- and page-derived strings land via textContent or the safe markdown
// renderer, never innerHTML.
//
// ES module — imported by sidepanel.js only.

import { renderMarkdown, renderTokensSavedSlot } from './chat-render.js';
import { icon } from './icons.js';

// Per tool: its icon, a plain name for when it failed ("Click · error"), the
// labels for while it runs and once it is done, and the phrase a finished
// group's title is built from.
const TOOL_STEPS = {
  read_page: { icon: 'file-text', base: 'Read page', running: 'Reading the page', done: 'Read the page', phrase: 'read the page' },
  screenshot: { icon: 'camera', base: 'Screenshot', running: 'Taking a screenshot', done: 'Took a screenshot', phrase: 'took a screenshot' },
  click: { icon: 'mouse-pointer-click', base: 'Click', running: 'Clicking', done: 'Clicked', phrase: 'clicked' },
  type_text: { icon: 'text-cursor-input', base: 'Type text', running: 'Typing', done: 'Typed', phrase: 'typed' },
  select_option: { icon: 'list-checks', base: 'Choose option', running: 'Choosing an option', done: 'Chose an option', phrase: 'chose an option' },
  press_key: { icon: 'keyboard', base: 'Press key', running: 'Pressing a key', done: 'Pressed a key', phrase: 'pressed a key' },
  scroll: { icon: 'move-vertical', base: 'Scroll', running: 'Scrolling', done: 'Scrolled', phrase: 'scrolled' },
  navigate: { icon: 'globe', base: 'Open page', running: 'Opening a page', done: 'Opened a page', phrase: 'opened a page' },
  go_back: { icon: 'arrow-left', base: 'Go back', running: 'Going back', done: 'Went back', phrase: 'went back' },
  find_element: { icon: 'crosshair', base: 'Find element', running: 'Finding an element', done: 'Found an element', phrase: 'found an element' },
  find_text: { icon: 'file-search', base: 'Find text', running: 'Searching the page', done: 'Searched the page', phrase: 'searched the page' },
  wait_for: { icon: 'hourglass', base: 'Wait for page', running: 'Waiting for the page', done: 'Waited for the page', phrase: 'waited for the page' },
  ask_user: { icon: 'message-circle-question', base: 'Ask you', running: 'Asking you', done: 'Asked you', phrase: 'asked you' },
};

// The web app's one-line argument summary caps (toolArgsSummary.ts).
const VALUE_MAX = 48;
const LINE_MAX = 120;

/** snake_case → Title Case, the web app's fallback label (formatToolName). */
function formatToolName(name) {
  return String(name || 'Tool')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Icon and labels for a tool; unknown tools get the wrench and their name. */
export function toolStep(name) {
  if (TOOL_STEPS[name]) return TOOL_STEPS[name];
  const label = formatToolName(name);
  return { icon: 'wrench', base: label, running: label, done: label, phrase: `used ${label}` };
}

function clip(value, max) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One line saying what a step acted on, "key: value · key: value" as in the
 * web app. `target` is the element's accessible name when the loop knows it.
 * @returns {string}
 */
export function stepDetail(name, input, target) {
  const i = input || {};
  const what = target || i.ref;
  let pairs;
  switch (name) {
    case 'click':
      pairs = [['element', what]];
      break;
    case 'type_text':
      pairs = [['text', i.text], ['field', what], i.submit ? ['submit', 'yes'] : null];
      break;
    case 'select_option':
      pairs = [['option', i.option], ['field', what]];
      break;
    case 'press_key':
      pairs = [['keys', i.keys]];
      break;
    case 'scroll':
      pairs = [['direction', i.direction], i.ref ? ['element', what] : null];
      break;
    case 'navigate':
      pairs = [['url', i.url]];
      break;
    case 'find_element':
    case 'find_text':
      pairs = [['query', i.query]];
      break;
    case 'wait_for':
      pairs = [['text', i.text], ['selector', i.selector], ['url', i.url_contains]];
      break;
    case 'screenshot':
      pairs = [i.fullPage ? ['area', 'full page'] : null];
      break;
    case 'ask_user':
      pairs = [['question', i.question]];
      break;
    case 'read_page':
    case 'go_back':
      pairs = [];
      break;
    default:
      pairs = Object.entries(i);
  }
  const line = pairs
    .filter((p) => p && p[1] !== undefined && p[1] !== null && p[1] !== '')
    .map(([k, v]) => `${k}: ${clip(typeof v === 'string' ? v : JSON.stringify(v), VALUE_MAX)}`)
    .join(' · ');
  return line ? clip(line, LINE_MAX) : '';
}

/**
 * Past-tense, sentence-case title for a finished group, from the tools it ran
 * in order: "Read the page, typed and clicked".
 * @param {string[]} names
 */
export function segmentTitle(names) {
  const phrases = [...new Set((names || []).map((n) => toolStep(n).phrase))];
  if (!phrases.length) return 'Thought it over';
  const shown = phrases.slice(0, 3);
  let text;
  if (phrases.length > 3) text = `${shown.join(', ')} and more`;
  else if (shown.length === 1) text = shown[0];
  else text = `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Thinking text as the web app shows it (thinkingText.ts): a leading
 * **Heading** is dropped from each paragraph, other emphasis markers are
 * removed and their words kept.
 */
export function plainThinking(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((para) => para.replace(/^\s*\*\*[^*\n]+\*\*[ \t]*\n?/, ''))
    .filter((para) => para.trim())
    .join('\n\n')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/gm, '$1$2')
    .trim();
}

/**
 * Title for a finished group from its steps ({name, status}). Steps that never
 * ran — denied, or cut off by Stop — are left out; a group where nothing ran
 * says why.
 */
export function groupTitle(steps) {
  const ran = steps.filter((s) => s.status === 'ok' || s.status === 'error').map((s) => s.name);
  if (ran.length || !steps.length) return segmentTitle(ran);
  return steps.some((s) => s.status === 'denied') ? 'Asked for approval' : 'Stopped';
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {HTMLElement} containerEl - the #messages log.
 */
export function createAgentActivity(containerEl) {
  let root = null; // this run's current message element
  let segment = null; // the group new steps join, or null
  const segments = [];
  let textPart = null; // the text block streaming now
  const steps = new Map(); // tool_use id -> step
  let tokensSaved = 0;
  let finished = false;

  function scrollToBottom() {
    containerEl.scrollTop = containerEl.scrollHeight;
  }

  // New blocks go into this run's message. When something else has landed
  // below it (a question for the user, their reply), the run carries on in a
  // new message underneath so the log stays in time order.
  function ensureRoot() {
    if (root && root.isConnected && containerEl.lastElementChild === root) return root;
    if (root) {
      closeText();
      closeSegment();
    }
    root = make('div', 'lexi-msg lexi-msg-assistant lexi-agent-msg');
    containerEl.appendChild(root);
    return root;
  }

  // ---- Groups ---------------------------------------------------------------

  function segmentOpen(seg) {
    return seg.override ?? (!finished || !seg.complete);
  }

  function applyOpen(seg) {
    const open = segmentOpen(seg);
    seg.el.classList.toggle('lexi-seg-open', open);
    seg.head.setAttribute('aria-expanded', String(open));
    seg.body.hidden = !open;
    if (open) seg.body.querySelectorAll('.lexi-thought').forEach(fitThought);
  }

  function newSegment() {
    const seg = { steps: [], thinkingRow: null, complete: false, override: null };
    seg.el = make('div', 'lexi-seg');
    seg.head = make('button', 'lexi-seg-head');
    seg.head.type = 'button';
    seg.titleEl = make('span', 'lexi-seg-title', 'Thinking…');
    seg.head.append(seg.titleEl, icon('chevron-down', 'lexi-seg-chevron'));
    seg.body = make('div', 'lexi-seg-body');
    seg.el.append(seg.head, seg.body);
    seg.head.addEventListener('click', () => {
      seg.override = !segmentOpen(seg);
      applyOpen(seg);
    });
    ensureRoot().appendChild(seg.el);
    segments.push(seg);
    applyOpen(seg);
    return seg;
  }

  /** The group the next step joins: the open one, or a new one. */
  function currentSegment() {
    ensureRoot();
    if (!segment) segment = newSegment();
    return segment;
  }

  function dropThinkingRow(seg = segment) {
    if (seg && seg.thinkingRow) {
      seg.thinkingRow.remove();
      seg.thinkingRow = null;
    }
  }

  /** The row that closes a run: "Done", or "Stopped" with a stop icon. */
  function endRow(label) {
    const end = make('div', 'lexi-step lexi-step-end');
    end.append(icon(label === 'Done' ? 'circle-check' : 'circle-stop', 'lexi-step-icon'), make('span', 'lexi-step-end-text', label));
    return end;
  }

  function completeSegment(seg, endLabel) {
    if (seg.complete) return;
    seg.complete = true;
    seg.titleEl.textContent = groupTitle(seg.steps);
    seg.body.appendChild(endRow(endLabel));
    applyOpen(seg);
  }

  /** Ends the open group; one left with no steps is removed. */
  function closeSegment(endLabel = 'Done') {
    const seg = segment;
    segment = null;
    if (!seg) return;
    dropThinkingRow(seg);
    if (!seg.body.children.length) {
      seg.el.remove();
      segments.splice(segments.indexOf(seg), 1);
      return;
    }
    completeSegment(seg, endLabel);
  }

  // ---- Text -----------------------------------------------------------------

  /** Ends the streaming text block: narration if steps follow, else the answer. */
  function closeText({ narration = true } = {}) {
    const part = textPart;
    textPart = null;
    if (!part) return;
    if (part.raf !== null) cancelAnimationFrame(part.raf);
    if (!part.raw.trim()) {
      part.el.remove();
      return;
    }
    renderMarkdown(part.body, part.raw);
    part.caret.remove();
    part.el.classList.add(narration ? 'lexi-agent-narration' : 'lexi-agent-answer');
  }

  // ---- Steps ----------------------------------------------------------------

  function errorDetails(step) {
    const wrap = make('div', 'lexi-step-result');
    const chip = make('button', 'lexi-step-chip');
    chip.type = 'button';
    chip.setAttribute('aria-expanded', String(!!step.errorOpen));
    chip.append(icon(step.errorOpen ? 'chevron-down' : 'chevron-right', 'lexi-step-chip-icon'), make('span', '', 'Error details'));
    chip.addEventListener('click', () => {
      step.errorOpen = !step.errorOpen;
      renderStep(step);
    });
    wrap.appendChild(chip);
    if (step.errorOpen) wrap.appendChild(make('div', 'lexi-step-result-text', step.error));
    return wrap;
  }

  function renderStep(step) {
    const spec = toolStep(step.name);
    const running = step.status === 'running';
    const failed = !running && step.status !== 'ok';
    const { row } = step;
    row.textContent = '';
    row.dataset.status = step.status;
    row.dataset.tool = step.name;

    const head = make('div', 'lexi-step-head');
    const label = make('span', 'lexi-step-label', running ? spec.running : failed ? spec.base : spec.done);
    label.title = `Tool: ${step.name}`;
    head.appendChild(label);
    if (running) head.appendChild(icon('loader-circle', 'lexi-step-spinner'));
    else if (!failed) head.appendChild(icon('check', 'lexi-step-check'));
    else head.append(make('span', 'lexi-step-dot'), make('span', 'lexi-step-badge', step.status));

    const main = make('div', 'lexi-step-main');
    main.appendChild(head);
    const detail = stepDetail(step.name, step.input, step.target);
    if (detail) main.appendChild(make('div', 'lexi-step-detail', detail));
    if (running && step.progress) main.appendChild(make('div', 'lexi-step-progress', step.progress));
    if (step.status === 'error' && step.error) main.appendChild(errorDetails(step));

    row.append(icon(spec.icon, 'lexi-step-icon'), main);
  }

  // Thinking text is clamped to six lines; "Show more" appears only when it
  // actually overflows, which can be measured only while its group is open.
  function fitThought(row) {
    const text = row.querySelector('.lexi-thought-text');
    const more = row.querySelector('.lexi-thought-more');
    if (!text || !more || row.classList.contains('lexi-thought-expanded') || !text.offsetParent) return;
    const overflows = text.scrollHeight > text.clientHeight + 1;
    more.hidden = !overflows;
    row.classList.toggle('lexi-thought-clamped', overflows);
  }

  return {
    /** The model is working out its next step (a status 'thinking' event). */
    thinking() {
      if (finished) return;
      closeText();
      const seg = currentSegment();
      if (seg.thinkingRow) return;
      const row = make('div', 'lexi-step lexi-step-thinking');
      row.append(icon('clock', 'lexi-step-icon lexi-icon-clock'), make('span', 'lexi-thinking-wait', 'Thinking…'));
      seg.body.appendChild(row);
      seg.thinkingRow = row;
      scrollToBottom();
    },

    /** Thinking text the model returned with its step. */
    thought(text) {
      const plain = plainThinking(text);
      if (finished || !plain) return;
      closeText();
      const seg = currentSegment();
      const row = seg.thinkingRow || make('div', 'lexi-step lexi-step-thinking');
      seg.thinkingRow = null; // this row now holds the thought
      row.textContent = '';
      row.classList.add('lexi-thought');
      const more = make('button', 'lexi-thought-more', 'Show more');
      more.type = 'button';
      more.hidden = true;
      more.addEventListener('click', () => {
        const expanded = row.classList.toggle('lexi-thought-expanded');
        row.classList.toggle('lexi-thought-clamped', !expanded);
        more.textContent = expanded ? 'Show less' : 'Show more';
      });
      const main = make('div', 'lexi-step-main');
      main.append(make('p', 'lexi-thought-text', plain), more);
      row.append(icon('clock', 'lexi-step-icon lexi-icon-clock'), main);
      if (!row.isConnected) seg.body.appendChild(row);
      fitThought(row);
      scrollToBottom();
    },

    /** Streamed model text: narration between steps, or the answer. */
    text(delta) {
      if (finished || !delta) return;
      if (!textPart) {
        closeSegment();
        const el = make('div', 'lexi-agent-text');
        const body = make('div', 'lexi-msg-body');
        const caret = make('span', 'lexi-caret');
        el.append(body, caret);
        ensureRoot().appendChild(el);
        textPart = { el, body, caret, raw: '', raf: null };
      }
      const part = textPart;
      part.raw += delta;
      if (part.raf === null) {
        part.raf = requestAnimationFrame(() => {
          part.raf = null;
          renderMarkdown(part.body, part.raw);
          scrollToBottom();
        });
      }
    },

    /** A tool call the model is making ({id, name, input?, target?}). */
    toolIntent({ id, name, input, target } = {}) {
      if (finished || !id) return;
      closeText();
      if (name === 'finish') {
        dropThinkingRow();
        return;
      }
      let step = steps.get(id);
      if (!step) {
        const seg = currentSegment();
        dropThinkingRow(seg);
        step = { id, name, input: {}, target: null, status: 'running', progress: '', error: '', errorOpen: false };
        step.row = make('div', 'lexi-step lexi-step-tool');
        seg.body.appendChild(step.row);
        seg.steps.push(step);
        steps.set(id, step);
      }
      if (input) step.input = input;
      if (target) step.target = target;
      renderStep(step);
      scrollToBottom();
    },

    /** A running step is waiting on something (e.g. the user's approval). */
    toolWaiting(id, message) {
      const step = steps.get(id);
      if (!step || step.status !== 'running') return;
      step.progress = message || '';
      renderStep(step);
      scrollToBottom();
    },

    /** A step finished ({id, ok, denied?, error?}). */
    toolResult({ id, ok, denied, error } = {}) {
      const step = steps.get(id);
      if (!step) return;
      step.status = ok ? 'ok' : denied ? 'denied' : 'error';
      step.error = step.status === 'error' ? String(error || '') : '';
      step.progress = '';
      renderStep(step);
    },

    addTokensSaved(count) {
      tokensSaved += Number(count) || 0;
    },

    /**
     * The run ended ('done' | 'stopped' | 'error'): the last text is the
     * answer, unfinished steps read "stopped", and every group collapses to
     * its title.
     */
    finish(status = 'done', { injectionFlagged = false } = {}) {
      if (finished) return;
      const answer = textPart;
      closeText({ narration: false });
      for (const step of steps.values()) {
        if (step.status === 'running') {
          step.status = 'stopped';
          step.progress = '';
          renderStep(step);
        }
      }
      closeSegment(status === 'done' ? 'Done' : 'Stopped');
      // Stopped before anything showed: say so rather than leave the task
      // unanswered.
      if (status === 'stopped' && !(root && root.childElementCount)) {
        ensureRoot().appendChild(endRow('Stopped'));
      }
      finished = true;
      segments.forEach(applyOpen);
      if (root && injectionFlagged) {
        const flag = make('div', 'lexi-injection-flag', '⚠ This page appears to contain a hidden instruction — Lexi ignored it.');
        root.insertBefore(flag, answer && answer.el.isConnected ? answer.el : null);
      }
      if (root && tokensSaved) renderTokensSavedSlot(root, tokensSaved);
      scrollToBottom();
    },
  };
}
