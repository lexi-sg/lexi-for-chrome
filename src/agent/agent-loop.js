// src/agent/agent-loop.js
//
// The OBSERVE -> THINK -> ACT agent loop. Runs entirely in the side panel;
// tool execution is delegated to the service worker over the long-lived
// "lexi-sidepanel" Port. See spec.agent_loop_design for the full narrative
// this file implements.
//
// ES module.

import { MSG, LIMITS, DEFAULT_MODEL, FIND_MODEL } from '../config.js';
import { streamMessage, imageBlock, AuthError, ForbiddenError, RateLimitError, OverloadedError } from './anthropic-client.js';
import { TOOLS, toolActionClass } from './tools.js';
import { buildAgentSystem, wrapUntrusted, sanitize, scrubOutbound } from '../prompts/system-prompts.js';

const MAX_SCREENSHOTS_KEPT = 3;
const VISUAL_TASK_RE = /screenshot|image|photo|scan(?:ned)?|chart|diagram|signature|logo|picture|graphic|exhibit/i;
// Rough char-per-token heuristic (~4 chars/token) used only to decide when
// the running conversation needs its oldest tool turns trimmed.
const MAX_INPUT_CHARS = LIMITS.MAX_TOKENS_INPUT_CHARS || 180000 * 4;

/**
 * createAgentRun({port, tabId, task, model, approvalMode, apiKey, onEvent})
 *
 * Returns {start(), stop(), resolveConfirm(toolUseId, approved, opts),
 * provideAnswer(toolUseId, answerText)}. `start()` kicks the loop off
 * (fire-and-forget — progress arrives via onEvent) and also returns the
 * mutable `run` state object for inspection/debugging.
 *
 * onEvent(event) is called for, per spec.agent_loop_design:
 *   {type:'text', delta}                          - streamed answer text
 *   {type:'status', status, ...}                   - status in
 *        'acting' | 'thinking' | 'awaiting_confirm' | 'done' | 'error'
 *   {type:'tool_intent', name, id, input?}         - drives the acting bar
 *   {type:'confirm', toolUseId, name, input, actionClass, origin, reason}
 *        - a risky action needs approval; call resolveConfirm() with the result
 *   {type:'ask_user', toolUseId, question}         - the model asked a
 *        question; call provideAnswer() with the user's reply
 *   {type:'tokensSaved', tokens, total}            - old-screenshot trimming
 *   {type:'sw_event', raw}                         - passthrough of an
 *        unsolicited AGENT_STATUS/AGENT_ACTING message from the service worker
 */
export function createAgentRun({ port, tabId, task, model, approvalMode, auth, apiKey, onEvent }) {
  // Auth descriptor for the transport: {mode:'account',token,baseUrl} routes
  // through the landed proxy; {mode:'byok',apiKey} hits api.anthropic.com
  // directly (escape hatch). A bare apiKey is accepted for backwards compat.
  const resolvedAuth = auth || (apiKey ? { mode: 'byok', apiKey } : null);
  const run = {
    tabId,
    task,
    model: model || DEFAULT_MODEL,
    approvalMode: approvalMode || 'manual',
    auth: resolvedAuth,
    messages: [],
    step: 0,
    maxSteps: LIMITS.MAX_STEPS,
    consecutiveFailures: 0,
    stopped: false,
    paused: false,
    lastKnownUrl: null,
    lastElements: [],
    prevRefs: new Set(),
    pendingNavReminder: null,
    screenshotCount: 0,
    tokensSaved: 0,
    _retriedValidation: false,
    _torndown: false,
  };

  /** @type {AbortController|null} */
  let abortController = null;
  /** toolUseId -> {resolve, kind, actionClass?, origin?} awaiting a human response. */
  const pending = new Map();

  function emit(evt) {
    try {
      if (onEvent) onEvent(evt);
    } catch {
      // A misbehaving UI callback must never take down the agent loop.
    }
  }

  // -- Port plumbing ---------------------------------------------------

  function onPortMessage(msg) {
    if (!msg) return;
    if (msg.type === MSG.AGENT_STOP && (!msg.tabId || msg.tabId === run.tabId)) {
      // The service worker (or another surface) requested a stop — e.g. the
      // debugger infobar's own Cancel button, or onDetach/onDisconnect.
      stop();
      return;
    }
    if ((msg.type === MSG.AGENT_STATUS || msg.type === MSG.AGENT_ACTING) && (!msg.tabId || msg.tabId === run.tabId)) {
      emit({ type: 'sw_event', raw: msg });
    }
  }
  port.onMessage.addListener(onPortMessage);

  /**
   * Sends a request-shaped message to the service worker and resolves once
   * a reply carrying the same `requestId` arrives. The service worker is
   * expected to echo `requestId` verbatim on its correlated reply.
   */
  function portRequest(message, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const outgoing = { ...message, requestId };

      const timer = setTimeout(() => {
        port.onMessage.removeListener(listener);
        reject(new Error(`Timed out waiting for a reply to ${message.type}`));
      }, timeoutMs);

      function listener(msg) {
        if (!msg || msg.requestId !== requestId) return;
        clearTimeout(timer);
        port.onMessage.removeListener(listener);
        resolve(msg);
      }

      port.onMessage.addListener(listener);
      try {
        port.postMessage(outgoing);
      } catch (err) {
        clearTimeout(timer);
        port.onMessage.removeListener(listener);
        reject(err);
      }
    });
  }

  function waitForResolution(toolUseId, kind, extra = {}) {
    return new Promise((resolve) => {
      pending.set(toolUseId, { resolve, kind, ...extra });
    });
  }

  function teardown() {
    if (run._torndown) return;
    run._torndown = true;
    port.onMessage.removeListener(onPortMessage);
    try {
      port.postMessage({ type: MSG.AGENT_STOP, tabId: run.tabId });
    } catch {
      /* port may already be disconnected */
    }
  }

  // -- Public API --------------------------------------------------------

  function start() {
    loop().catch((err) => {
      emit({ type: 'status', status: 'error', error: serializeError(err) });
      teardown();
    });
    return run;
  }

  function stop() {
    if (run.stopped) return;
    run.stopped = true;
    if (abortController) {
      try {
        abortController.abort();
      } catch {
        /* no-op */
      }
    }
    for (const [, waiter] of pending) {
      waiter.resolve({ approved: false, answer: '', message: 'Task stopped by user.' });
    }
    pending.clear();
    emit({ type: 'status', status: 'stopped' });
    teardown();
  }

  /**
   * Called by the panel when the user approves/denies a `{type:'confirm'}`
   * event. `always` persists a standing grant for this actionClass+origin
   * (the service worker's permission-manager owns that store; this just
   * notifies it — CONFIRM_RESPONSE is fire-and-forget).
   */
  async function resolveConfirm(toolUseId, approved, { always = false, message = '' } = {}) {
    const waiter = pending.get(toolUseId);
    if (!waiter) return;
    pending.delete(toolUseId);
    const payload = {
      type: MSG.CONFIRM_RESPONSE,
      tabId: run.tabId,
      toolUseId,
      approved: !!approved,
      always: !!always,
      actionClass: waiter.actionClass || null,
      origin: waiter.origin || null,
    };
    if (approved) {
      // On approval the service worker persists a grant keyed to this
      // toolUseId; the subsequent EXEC_TOOL re-checks that grant as its
      // server-side enforcement of the confirm. AWAIT the SW ack before
      // unblocking the loop so the grant is written before EXEC_TOOL runs
      // (otherwise the SW could reject a genuinely-approved risky action).
      try {
        await portRequest(payload);
      } catch {
        // If the ack never arrives the SW may reject the follow-up EXEC_TOOL;
        // still unblock so the loop can surface that as a tool error rather
        // than hanging.
      }
    } else {
      try {
        port.postMessage(payload);
      } catch {
        /* fire-and-forget */
      }
    }
    waiter.resolve({ approved: !!approved, always: !!always, message });
  }

  /** Called by the panel when the user answers an `{type:'ask_user'}` event. */
  function provideAnswer(toolUseId, answerText) {
    const waiter = pending.get(toolUseId);
    if (!waiter) return;
    pending.delete(toolUseId);
    waiter.resolve({ answer: answerText || '' });
  }

  // -- The loop itself -----------------------------------------------------

  async function loop() {
    try {
      port.postMessage({ type: MSG.AGENT_START, tabId: run.tabId, task: run.task });
    } catch {
      /* ignore */
    }

    try {
      emit({ type: 'status', status: 'thinking' });
      await observe();

      while (!run.stopped && run.step < run.maxSteps) {
        if (run.consecutiveFailures >= LIMITS.MAX_FAILURES) {
          emit({
            type: 'status',
            status: 'error',
            error: {
              type: 'MaxFailuresReachedError',
              message: `Stopped after ${LIMITS.MAX_FAILURES} consecutive tool failures.`,
            },
          });
          return;
        }

        trimHistoryIfNeeded();
        run.step += 1;
        emit({ type: 'status', status: 'thinking', step: run.step });

        const thinkResult = await thinkStep();
        if (run.stopped) return;
        if (thinkResult.retry) continue;

        if (thinkResult.finished) {
          // The answer text has already been streamed to the UI via 'text'
          // deltas this step; scrubOutbound is detection-only (returns
          // {text, flagged, matches}), so pass its .text string, not the object.
          const scrub = scrubOutbound(thinkResult.answer || '');
          emit({ type: 'status', status: 'done', answer: scrub.text, injectionFlagged: scrub.flagged });
          return;
        }

        await actStep(thinkResult.toolUses);
      }

      if (!run.stopped) {
        emit({
          type: 'status',
          status: 'error',
          error: {
            type: 'MaxStepsReachedError',
            message: `Stopped after ${run.maxSteps} steps without finishing.`,
          },
        });
      }
    } finally {
      teardown();
    }
  }

  // -- OBSERVE ---------------------------------------------------------

  async function requestPageContent(mode = 'both') {
    const response = await portRequest({ type: MSG.EXTRACT_PAGE, tabId: run.tabId, mode });
    if (response.type !== MSG.PAGE_CONTENT) {
      throw new Error(`Unexpected reply to EXTRACT_PAGE: ${response.type}`);
    }
    return response;
  }

  async function requestScreenshot(fullPage = false) {
    const response = await portRequest({ type: MSG.CAPTURE_SCREENSHOT, tabId: run.tabId, fullPage }, { timeoutMs: 15000 });
    if (response.type !== MSG.SCREENSHOT_RESULT) {
      throw new Error(`Unexpected reply to CAPTURE_SCREENSHOT: ${response.type}`);
    }
    return response;
  }

  function recordObservation(result) {
    if (result && Array.isArray(result.elements)) run.lastElements = result.elements;
    if (result && result.url) maybeNoteUrlChange(result.url);
  }

  function maybeNoteUrlChange(newUrl) {
    if (run.lastKnownUrl && newUrl && newUrl !== run.lastKnownUrl) {
      run.pendingNavReminder = newUrl;
    }
    run.lastKnownUrl = newUrl || run.lastKnownUrl;
  }

  /** Seeds the conversation with the task + an initial full page perception. */
  async function observe() {
    let page = { text: '', elements: [], truncated: false, url: null, title: '' };
    try {
      page = await requestPageContent('both');
      recordObservation(page);
    } catch {
      // Extraction can legitimately fail (activeTab lost the gesture, the
      // tab navigated away). Proceed with an empty perception — the model
      // can call read_page itself once a tool round-trip is available.
    }
    run.prevRefs = new Set((page.elements || []).map((el) => el.ref));

    const contentBlocks = [{ type: 'text', text: `Task: ${run.task}` }];

    const pageText = sanitize(page.text || '');
    const tree = renderInteractiveTree(page.elements || []);
    contentBlocks.push({
      type: 'text',
      text: wrapUntrusted(
        `Page: ${page.title || '(untitled)'} (${page.url || 'unknown URL'})\n\n` +
          `${pageText}${page.truncated ? '\n[page text truncated]' : ''}\n\n` +
          `Interactive elements:\n${tree}`
      ),
    });

    if (VISUAL_TASK_RE.test(run.task)) {
      try {
        const shot = await requestScreenshot(false);
        if (shot && shot.dataUrl) {
          run.screenshotCount += 1;
          contentBlocks.push(imageBlock(shot.dataUrl));
        }
      } catch {
        // A proactive screenshot is a nice-to-have for the seed turn; the
        // model can still call the screenshot tool explicitly.
      }
    }

    run.messages.push({ role: 'user', content: contentBlocks });
  }

  /** Fresh, lighter-weight perception appended alongside this step's tool_results. */
  async function observeForNextStep() {
    const blocks = [];
    try {
      const page = await requestPageContent('interactive');
      const tree = renderInteractiveTree(page.elements || [], run.prevRefs);
      recordObservation(page);
      run.prevRefs = new Set((page.elements || []).map((el) => el.ref));
      blocks.push({ type: 'text', text: wrapUntrusted(`Current interactive elements:\n${tree}`) });
    } catch (err) {
      blocks.push({ type: 'text', text: `[Could not refresh page state: ${err.message}]` });
    }
    if (run.pendingNavReminder) {
      blocks.push({
        type: 'text',
        text: `<system-reminder>The page navigated to ${run.pendingNavReminder}. The element refs above have been refreshed for the new page — re-check them before your next click/type.</system-reminder>`,
      });
      run.pendingNavReminder = null;
    }
    return blocks;
  }

  function renderInteractiveTree(elements, prevRefs) {
    if (!elements || !elements.length) return '(no interactive elements found)';
    return elements
      .slice(0, LIMITS.MAX_ELEMENTS)
      .map((el) => {
        const isNew = prevRefs && !prevRefs.has(el.ref);
        const prefix = isNew ? '*' : '';
        const role = el.role || el.tag || 'element';
        // Element names (aria-label/placeholder/visible text) are attacker-
        // controlled page content, so run them through the same injection
        // sanitizer as extracted body text before they enter the prompt.
        const name = sanitize(el.name || '');
        return `${prefix}[${el.ref}]<${role}> ${name}`.trimEnd();
      })
      .join('\n');
  }

  // -- THINK -------------------------------------------------------------

  async function thinkStep() {
    abortController = new AbortController();
    const toolBuffers = new Map(); // id -> {name, input, parseError}
    const order = [];
    const thinkingBlocks = []; // completed thinking/redacted_thinking blocks, in order
    let stopReason = null;
    let finalAnswerText = '';
    let sawText = false;

    try {
      for await (const evt of streamMessage({
        auth: run.auth,
        model: run.model,
        system: buildAgentSystem(),
        messages: run.messages,
        tools: TOOLS,
        maxTokens: LIMITS.MAX_TOKENS_STEP,
        signal: abortController.signal,
      })) {
        if (run.stopped) break;
        switch (evt.type) {
          case 'text':
            sawText = true;
            finalAnswerText += evt.delta;
            emit({ type: 'text', delta: evt.delta });
            break;
          case 'tool_use_start':
            order.push(evt.id);
            toolBuffers.set(evt.id, { name: evt.name, input: undefined, parseError: null });
            emit({ type: 'tool_intent', name: evt.name, id: evt.id });
            break;
          case 'tool_use_delta':
            if (evt.done) {
              const buf = toolBuffers.get(evt.id);
              if (buf) {
                buf.input = evt.input;
                buf.parseError = evt.parseError || null;
                emit({ type: 'tool_intent', name: buf.name, id: evt.id, input: evt.input });
              }
            }
            break;
          case 'thinking_block':
            // Captured so it can be replayed verbatim, ahead of any tool_use,
            // when this assistant turn is pushed into run.messages (required by
            // Anthropic's thinking-replay contract for thinking-enabled models).
            thinkingBlocks.push(evt.block);
            break;
          case 'stop':
            stopReason = evt.stopReason;
            break;
          case 'usage':
            run.usage = evt.usage;
            break;
          default:
            break;
        }
      }
    } catch (err) {
      return handleThinkError(err);
    } finally {
      abortController = null;
    }

    if (run.stopped) return { finished: true, answer: finalAnswerText };

    const toolUses = order.map((id) => ({ id, ...toolBuffers.get(id) }));

    // Retry-once on malformed tool_use JSON (per user memory: retry once on
    // an Anthropic structured-output ValidationError before giving up).
    const invalid = toolUses.find((t) => t.parseError);
    if (invalid && !run._retriedValidation) {
      run._retriedValidation = true;
      emit({ type: 'status', status: 'thinking', note: 'Retrying a malformed tool call once.' });
      return { retry: true };
    }
    if (!invalid) run._retriedValidation = false;

    run.messages.push({ role: 'assistant', content: buildAssistantContent(finalAnswerText, toolUses, sawText, thinkingBlocks) });

    if (stopReason !== 'tool_use' || toolUses.length === 0) {
      return { finished: true, answer: finalAnswerText.trim() };
    }

    return { finished: false, toolUses };
  }

  function buildAssistantContent(text, toolUses, sawText, thinkingBlocks = []) {
    const content = [];
    // Thinking blocks must come first and must precede any tool_use block when
    // continuing a thinking-enabled conversation — replay them verbatim.
    for (const tb of thinkingBlocks) content.push(tb);
    if (sawText && text.trim()) content.push({ type: 'text', text });
    for (const t of toolUses) {
      content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input ?? {} });
    }
    // Anthropic requires at least one content block per assistant turn.
    if (content.length === 0) content.push({ type: 'text', text: '' });
    return content;
  }

  function handleThinkError(err) {
    if (err && err.name === 'AbortError') {
      return { finished: true, answer: '' };
    }
    if (err instanceof AuthError) {
      // Fatal. In account mode a 401 means the Lexi session ended — surface a
      // distinct re-sign-in error (never a "bad key" message, and never a
      // silent fall back to a stored BYOK key). In BYOK mode it's a bad key.
      const error = serializeError(err);
      if (run.auth && run.auth.mode === 'account') error.type = 'SessionExpiredError';
      emit({ type: 'status', status: 'error', error });
      run.stopped = true;
      return { finished: true, answer: '' };
    }
    if (err instanceof ForbiddenError) {
      // Fatal — the account/key lacks access to this model. Never retry.
      emit({ type: 'status', status: 'error', error: serializeError(err) });
      run.stopped = true;
      return { finished: true, answer: '' };
    }
    if (err instanceof RateLimitError || err instanceof OverloadedError) {
      // anthropic-client already retried internally with backoff; if it
      // still surfaced, treat as fatal for this run rather than loop forever.
      emit({ type: 'status', status: 'error', error: serializeError(err) });
      run.stopped = true;
      return { finished: true, answer: '' };
    }
    // Any other ApiError/network error: count toward the failure budget and
    // let the outer loop's MAX_FAILURES guard decide whether to keep going.
    run.consecutiveFailures += 1;
    emit({ type: 'status', status: 'error', error: serializeError(err), recoverable: true });
    if (run.consecutiveFailures >= LIMITS.MAX_FAILURES) run.stopped = true;
    if (run.stopped) return { finished: true, answer: '' };
    // Recoverable and not out of budget: RETRY the think step. Returning
    // finished:false here without toolUses would crash actStep (it calls
    // toolUses.find) — the outer loop's `retry` branch is the correct path.
    return { retry: true };
  }

  // -- ACT -----------------------------------------------------------------

  async function actStep(toolUses) {
    const finishCall = toolUses.find((t) => t.name === 'finish');
    if (finishCall) {
      // The finish tool carries the answer as tool *input* — it was never
      // streamed as 'text' deltas, so stream it now so the panel renders it.
      // scrubOutbound is detection-only; use .text.
      const scrub = scrubOutbound(((finishCall.input && finishCall.input.answer) || '').trim());
      const finalAnswer = scrub.text;
      emit({ type: 'text', delta: finalAnswer });
      emit({ type: 'status', status: 'done', answer: finalAnswer, injectionFlagged: scrub.flagged });
      run.stopped = true;
      return;
    }

    emit({ type: 'status', status: 'acting' });

    const results = [];
    for (const toolUse of toolUses) {
      if (run.stopped) break;
      results.push(await executeTool(toolUse));
    }
    if (run.stopped) return;

    maybeTrimOldScreenshots();

    const observation = await observeForNextStep();
    // `_benign` is loop-internal failure-budget bookkeeping — it must NOT go on
    // the wire. The Anthropic API strictly validates tool_result blocks and
    // rejects unknown fields ("Extra inputs are not permitted"), which would
    // kill every run that needs a second model call after a tool_result.
    const wireResults = results.map(({ _benign, ...rest }) => rest);
    run.messages.push({ role: 'user', content: [...wireResults, ...observation] });

    const anyUnexpectedFailure = results.some((r) => r.is_error && !r._benign);
    const anySuccess = results.some((r) => !r.is_error);
    if (anyUnexpectedFailure && !anySuccess) {
      run.consecutiveFailures += 1;
    } else if (anySuccess) {
      run.consecutiveFailures = 0;
    }
  }

  async function executeTool(toolUse) {
    const { id, name, input, parseError } = toolUse;
    if (parseError) {
      return toolResult(id, `Invalid tool input JSON: ${parseError}. Please retry with valid arguments.`, true);
    }
    if (name === 'ask_user') return handleAskUser(id, input);
    if (name === 'find_element') return handleFindElement(id, input);
    return handleGenericTool(id, name, input || {});
  }

  async function handleAskUser(id, input) {
    const question = (input && input.question) || 'Could you clarify how you would like me to proceed?';
    emit({ type: 'status', status: 'awaiting_confirm' });
    emit({ type: 'ask_user', toolUseId: id, question });
    const resolution = await waitForResolution(id, 'ask_user');
    if (run.stopped) return toolResult(id, 'Task stopped by user.', true, true);
    return toolResult(id, resolution.answer || '(no response provided)', false);
  }

  async function handleFindElement(id, input) {
    const query = (input && input.query) || '';
    const elements = run.lastElements || [];
    if (!elements.length) {
      return toolResult(id, 'No indexed elements available yet — call read_page first.', true, true);
    }
    const tree = renderInteractiveTree(elements);
    const prompt =
      `Given this indexed list of interactive page elements:\n\n${tree}\n\n` +
      `Which ref best matches: "${query}"?\n` +
      `Respond with ONLY the ref (e.g. e12) and nothing else. If nothing matches, respond with "none".`;

    let text = '';
    // Thread an AbortController into this nested call (via the shared
    // `abortController`, which stop() aborts) so clicking Stop cancels the
    // in-flight find_element stream immediately, like every other request.
    abortController = new AbortController();
    try {
      for await (const evt of streamMessage({
        auth: run.auth,
        model: FIND_MODEL,
        system: 'You are a precise UI element locator. Respond with only a ref like e12, or the word "none". No other text.',
        messages: [{ role: 'user', content: prompt }],
        tools: [],
        maxTokens: 400,
        signal: abortController.signal,
      })) {
        if (evt.type === 'text') text += evt.delta;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return toolResult(id, 'Task stopped by user.', true, true);
      }
      return toolResult(id, `find_element failed: ${err.message}`, true, true);
    } finally {
      abortController = null;
    }

    const match = text.match(/\be\d+\b/);
    if (!match) {
      return toolResult(id, `No matching element found for "${query}".`, true, true);
    }
    return toolResult(id, JSON.stringify({ ref: match[0] }), false);
  }

  /**
   * Enriches a tool call's raw input (which for click/type_text is just {ref})
   * with derived fields the classifier and the TOCTOU guard need but the model
   * never provides: the target element's accessible name (so a click on a
   * "Delete account" / "Pay now" button classifies as DELETE/PAY, not generic
   * CLICK), the current URL for navigate cross-domain detection, and the
   * queue-time origin for the mid-navigation abort check. These extra fields
   * are ignored by action-executor's dispatch code and are NOT written back
   * into run.messages (the model's original input is what gets replayed).
   */
  function enrichToolInput(name, input) {
    const enriched = { ...(input || {}) };
    if ((name === 'click' || name === 'type_text') && enriched.ref && !enriched.elementName) {
      const match = (run.lastElements || []).find((e) => e && e.ref === enriched.ref);
      if (match && match.name) enriched.elementName = match.name;
    }
    if (name === 'navigate' && run.lastKnownUrl && !enriched.currentUrl) {
      enriched.currentUrl = run.lastKnownUrl;
    }
    if (
      ['click', 'type_text', 'press_key', 'navigate'].includes(name) &&
      run.lastKnownUrl &&
      !enriched.originAtQueue
    ) {
      enriched.originAtQueue = safeOrigin(run.lastKnownUrl);
    }
    return enriched;
  }

  async function handleGenericTool(id, name, input) {
    const enriched = enrichToolInput(name, input);
    const actionClass = toolActionClass(name, enriched, run.lastKnownUrl);
    const origin = safeOrigin(run.lastKnownUrl);

    let policy;
    try {
      policy = await portRequest({
        type: MSG.CHECK_SITE_POLICY,
        tabId: run.tabId,
        origin,
        actionClass,
        approvalMode: run.approvalMode,
      });
    } catch (err) {
      run.consecutiveFailures += 1;
      return toolResult(id, `Could not evaluate site policy: ${err.message}`, true);
    }

    if (policy.type !== MSG.SITE_POLICY_RESULT) {
      run.consecutiveFailures += 1;
      return toolResult(id, `Unexpected reply to CHECK_SITE_POLICY: ${policy.type}`, true);
    }

    const decision = policy.decision || 'confirm';

    if (decision === 'block') {
      emit({
        type: 'status',
        status: 'error',
        error: { type: 'RefusedByPolicy', message: (policy && policy.reason) || 'Blocked by site policy.' },
      });
      return toolResult(id, `This action is blocked on this site (${(policy && policy.reason) || 'policy'}). Call ask_user instead of retrying it.`, true, true);
    }

    if (decision === 'confirm') {
      emit({ type: 'status', status: 'awaiting_confirm' });
      emit({ type: 'confirm', toolUseId: id, name, input, actionClass, origin, reason: policy && policy.reason });
      const resolution = await waitForResolution(id, 'confirm', { actionClass, origin });
      if (run.stopped) return toolResult(id, 'Task stopped by user.', true, true);
      if (!resolution.approved) {
        return toolResult(id, `User denied this action.${resolution.message ? ' ' + resolution.message : ''}`, true, true);
      }
    }

    return execViaServiceWorker(id, name, enriched);
  }

  async function execViaServiceWorker(id, name, input) {
    let response;
    try {
      response = await portRequest({ type: MSG.EXEC_TOOL, tabId: run.tabId, toolUseId: id, name, input }, { timeoutMs: 30000 });
    } catch (err) {
      run.consecutiveFailures += 1;
      return toolResult(id, `Tool execution timed out or errored: ${err.message}`, true);
    }

    if (response.type !== MSG.TOOL_RESULT) {
      run.consecutiveFailures += 1;
      return toolResult(id, `Unexpected response executing ${name}.`, true);
    }

    if (!response.ok) {
      return toolResult(id, response.error || `${name} failed.`, true);
    }

    if (name === 'read_page' && response.result) recordObservation(response.result);

    if (name === 'screenshot' && response.result && response.result.dataUrl) {
      run.screenshotCount += 1;
      return imageToolResult(id, response.result.dataUrl);
    }

    if ((name === 'navigate' || name === 'click' || name === 'go_back') && response.result && typeof response.result.url === 'string') {
      maybeNoteUrlChange(response.result.url);
    }

    return toolResult(id, formatToolResultText(name, response.result), false);
  }

  function formatToolResultText(name, result) {
    if (result == null) return `${name} completed.`;
    if (name === 'read_page') {
      const parts = [];
      if (result.text) parts.push(sanitize(result.text));
      if (Array.isArray(result.elements)) parts.push(renderInteractiveTree(result.elements));
      if (result.truncated) parts.push('[page text truncated]');
      return wrapUntrusted(parts.join('\n\n'));
    }
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  function toolResult(toolUseId, text, isError, benign = false) {
    return { type: 'tool_result', tool_use_id: toolUseId, content: String(text), is_error: !!isError, _benign: benign };
  }

  function imageToolResult(toolUseId, dataUrl) {
    return { type: 'tool_result', tool_use_id: toolUseId, content: [imageBlock(dataUrl)], is_error: false };
  }

  // -- Token budgeting -------------------------------------------------

  function maybeTrimOldScreenshots() {
    const imageLocations = [];
    run.messages.forEach((msg, mi) => {
      if (!Array.isArray(msg.content)) return;
      msg.content.forEach((block, bi) => {
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          block.content.forEach((inner, ii) => {
            if (inner.type === 'image') imageLocations.push({ mi, bi, ii });
          });
        }
      });
    });
    if (imageLocations.length <= MAX_SCREENSHOTS_KEPT) return;

    const toTrim = imageLocations.slice(0, imageLocations.length - MAX_SCREENSHOTS_KEPT);
    let savedTokens = 0;
    for (const loc of toTrim) {
      const block = run.messages[loc.mi].content[loc.bi];
      const inner = block.content[loc.ii];
      if (inner && inner.type === 'image') {
        savedTokens += estimateImageTokens(inner.source && inner.source.data);
        block.content[loc.ii] = { type: 'text', text: '[screenshot omitted to save tokens]' };
      }
    }
    if (savedTokens > 0) {
      run.tokensSaved += savedTokens;
      emit({ type: 'tokensSaved', tokens: savedTokens, total: run.tokensSaved });
    }
  }

  function estimateImageTokens(base64) {
    if (!base64) return 0;
    const bytes = (base64.length * 3) / 4;
    // Conservative heuristic bounded by the documented worst case for a
    // <=1568px-long-edge PNG (~1600 tokens).
    return Math.min(Math.round(bytes / 750), 1600);
  }

  function trimHistoryIfNeeded() {
    if (run.messages.length <= 4) return;
    let total = 0;
    for (const msg of run.messages) total += roughLength(msg);
    if (total <= MAX_INPUT_CHARS) return;

    // Drop the oldest assistant(tool_use) turn together with its paired
    // user(tool_result) turn — the matched pair — but never the very first
    // message, which carries the original task + seed perception. Removing the
    // assistant turn and the user turn that immediately follows it keeps every
    // tool_use block matched to its tool_result and preserves user/assistant
    // alternation; dropping the user(tool_result) first would instead orphan
    // the preceding assistant(tool_use) and mis-pair the next tool_result.
    const dropIndex = run.messages.findIndex((m, i) => i > 0 && m.role === 'assistant');
    if (dropIndex > 0) {
      run.messages.splice(dropIndex, 2);
    }
  }

  function roughLength(msg) {
    try {
      return JSON.stringify(msg).length;
    } catch {
      return 0;
    }
  }

  // -- misc helpers ------------------------------------------------------

  function safeOrigin(url) {
    if (!url) return null;
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  function serializeError(err) {
    return { type: (err && err.name) || 'Error', message: (err && err.message) || String(err), status: err && err.status };
  }

  return { start, stop, resolveConfirm, provideAnswer };
}
