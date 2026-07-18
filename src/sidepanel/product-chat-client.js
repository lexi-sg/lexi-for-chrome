// src/sidepanel/product-chat-client.js
//
// The PRODUCT-CHAT transport — Chat mode's account-mode pipe. Speaks to the
// real Lexi product chat endpoint (POST /llm/chat, v2 block-SSE), NOT the
// Anthropic-shaped proxy. This is what makes extension Chat mode "the same
// chat the web app has": the GP v2 orchestrator owns the system prompt, model
// tiers, tools, citations, and persistence server-side; the client sends only
// the user's message + page context and renders the streamed blocks.
//
// Entirely separate from anthropic-client.js (which stays byte-fidelity for
// Agent Mode). Mirrors the web app's useSSEStream.readSSEBody line-splitter +
// seq-gate so reconnect replay is idempotent.
//
// ES module — imported by sidepanel.js only.

import { CHAT_PATH } from '../config.js';
import { AuthError, ApiError } from '../agent/anthropic-client.js';

// Reconnect backoff bounds (mirror the web attemptReconnect contract).
const RECONNECT_CEILING_MS = 120_000;
const RECONNECT_MAX_DELAY_MS = 16_000;
const RECONNECT_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stream one product-chat turn. Resolves when a terminal event
 * (stream_complete / error / cancel) has been observed OR the caller aborts.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl                 - Lexi API origin (active channel's api_base)
 * @param {string} opts.token                   - opaque lexiext_ Bearer token
 * @param {number|string} opts.conversationId   - 0 for a new conversation
 * @param {string} opts.userMessage
 * @param {{url?:string,title?:string,text?:string}|null} [opts.pageContext]
 * @param {Array<{base64:string,media_type?:string}>} [opts.inlineImages]
 * @param {string[]} [opts.sources]             - tools_to_be_invoked hints
 * @param {'chat'|'deep'|'draft'} [opts.mode]
 * @param {(evt:object)=>void} opts.onEvent     - normalized-event sink
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{conversationId:number|string}>}
 */
export async function streamProductChat({
  baseUrl,
  token,
  conversationId,
  userMessage,
  pageContext,
  inlineImages,
  sources,
  mode,
  onEvent,
  signal,
}) {
  const url = `${baseUrl}${CHAT_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'text/event-stream',
    'content-type': 'application/json',
  };
  const body = {
    user_message: userMessage,
    conversation_id: conversationId || 0,
    metadata: {
      source_channel: 'chrome_extension',
      page_context: pageContext || null,
      inline_images: inlineImages || [],
      tools_to_be_invoked: sources || [],
      deep_think: mode === 'deep',
      draft_mode: mode === 'draft',
    },
  };

  // Per-turn stream state (shared with reconnect passes).
  const st = { convId: conversationId || 0, lastSeq: 0, terminal: false };

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  throwForStatus(response);
  await readSSEBody(response.body, st, onEvent, signal);

  // Reconnect-on-drop: the initial POST closed without a terminal event
  // (Container Apps idle timeout, network blip). Poll the status endpoint with
  // exponential backoff and re-subscribe if it hands back a live SSE stream.
  if (!st.terminal && !aborted(signal)) {
    await reconnect({ baseUrl, headers, st, onEvent, signal });
  }

  return { conversationId: st.convId };
}

function aborted(signal) {
  return !!(signal && signal.aborted);
}

function throwForStatus(response) {
  if (response.ok) return;
  if (response.status === 401) {
    throw new AuthError('Your Lexi session ended.', { status: 401 });
  }
  throw new ApiError(`Lexi chat returned HTTP ${response.status}.`, { status: response.status });
}

/**
 * Reconnect to an in-flight generation via GET /llm/chat/{id}/status, exp
 * backoff 1s -> 16s, up to a 120s wall-clock ceiling. Re-subscribes (and
 * seq-gates via the shared state) if the response is a live SSE stream.
 */
async function reconnect({ baseUrl, headers, st, onEvent, signal }) {
  const statusHeaders = { Authorization: headers.Authorization, Accept: 'text/event-stream' };
  const start = Date.now();
  let delay = RECONNECT_BASE_DELAY_MS;

  while (!st.terminal && Date.now() - start < RECONNECT_CEILING_MS) {
    await sleep(delay);
    delay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS);
    if (aborted(signal)) return;

    let resp;
    try {
      resp = await fetch(`${baseUrl}${CHAT_PATH}/${st.convId}/status`, {
        headers: statusHeaders,
        signal,
      });
    } catch {
      continue; // transient — keep retrying until the ceiling
    }
    if (resp.status === 401) throw new AuthError('Your Lexi session ended.', { status: 401 });

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') && resp.body) {
      await readSSEBody(resp.body, st, onEvent, signal);
      // Loop again if it closed without terminating.
      continue;
    }
    // Non-SSE JSON: the generation already finished/idle — stop reconnecting.
    try {
      const data = await resp.json();
      if (!data || data.status !== 'generating') {
        if (!st.terminal) onEvent({ type: 'complete', data: data || {} });
        st.terminal = true;
      }
    } catch {
      st.terminal = true;
    }
    return;
  }
}

/**
 * Reads an SSE ReadableStream to completion, parsing `event:`/`data:` line
 * pairs and dispatching each through the event map (mirror of the web app's
 * readSSEBody). Mutates `st` (convId/lastSeq/terminal) as it goes.
 */
async function readSSEBody(streamBody, st, onEvent, signal) {
  if (!streamBody) return;
  const reader = streamBody.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventType = null;

  if (signal) {
    signal.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) eventType = processLines(buffer.split('\n'), eventType, st, onEvent);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      eventType = processLines(lines, eventType, st, onEvent);
      if (st.terminal) {
        reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/**
 * Processes a batch of raw SSE lines. Returns the carried event-type (so the
 * caller threads it across chunk boundaries, exactly like the web reader).
 */
function processLines(lines, eventType, st, onEvent) {
  let currentType = eventType;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) {
      currentType = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('data:')) {
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || !currentType) continue;
      let data;
      try {
        data = JSON.parse(dataStr);
      } catch {
        continue;
      }
      dispatch(currentType, data, st, onEvent);
    }
  }
  return currentType;
}

// ---------------------------------------------------------------------------
// Event map — product SSE -> normalized events the panel/renderer consume.
// Seq-gated events (content_delta, block_start/delta/stop) are dropped when
// their seq <= the last applied one, so an idempotent reconnect replay is safe.
// Ephemeral events (tool_progress/build_tally/segment_title, follow_up) carry
// no seq and are never gated.
// ---------------------------------------------------------------------------

function seqGate(st, data) {
  const seq = typeof data.seq === 'number' ? data.seq : null;
  if (seq === null) return true; // ungated
  if (seq <= st.lastSeq) return false;
  st.lastSeq = seq;
  return true;
}

function dispatch(type, data, st, onEvent) {
  switch (type) {
    case 'stream_start':
      if (data.conversation_id !== undefined && data.conversation_id !== null) {
        st.convId = data.conversation_id;
      }
      onEvent({ type: 'stream_start', conversationId: st.convId, publicUuid: data.public_uuid || null });
      break;

    // Legacy v1 cumulative/incremental text (seq-gated).
    case 'content_delta':
      if (!seqGate(st, data)) break;
      onEvent({ type: 'text', delta: data.content ?? '' });
      break;
    case 'token':
      onEvent({ type: 'text', delta: data.token ?? '' });
      break;

    case 'snapshot':
      st.lastSeq = data.seq ?? st.lastSeq;
      onEvent({ type: 'snapshot', content: data.content ?? '', blocks: data.blocks || [] });
      break;

    // v2 block streaming (seq-gated).
    case 'block_start':
      if (!seqGate(st, data)) break;
      onEvent(mapBlockStart(data));
      break;
    case 'block_delta':
      if (!seqGate(st, data)) break;
      onEvent(mapBlockDelta(data));
      break;
    case 'block_stop':
      if (!seqGate(st, data)) break;
      onEvent({ type: 'block_stop', blockIndex: data.block_index, final: data.final || null });
      break;

    // Ephemeral status lines (never seq-gated).
    case 'tool_progress':
      onEvent({ type: 'status_line', message: data.message || '', current: data.current, total: data.total });
      break;
    case 'build_tally':
      onEvent({ type: 'status_line', message: summarizeTally(data.rows), rows: data.rows || [] });
      break;
    case 'segment_title':
      onEvent({ type: 'status_line', message: data.segment_title || '' });
      break;

    case 'status':
      if (data.status === 'warning') onEvent({ type: 'banner', message: data.message || '' });
      else onEvent({ type: 'status_line', message: data.message || '' });
      break;

    // Live agentic narration the GP v2 pipeline emits for tool/search/
    // translation runs and the deep-research pipeline. Without these the
    // extension panel shows a blank assistant bubble with no progress while
    // the web app renders full step-by-step status for the same turn.
    case 'agent_status':
      if (data.message) onEvent({ type: 'status_line', message: data.message });
      break;
    case 'tool_status': {
      const msg = (data.messages && data.messages[0]) || data.message || data.tool_name || '';
      if (msg) onEvent({ type: 'status_line', message: msg });
      break;
    }
    case 'research_step':
      if (data.label || data.message) onEvent({ type: 'status_line', message: data.label || data.message });
      break;
    // Model reasoning (Deep-Think / drafting). Rendered into the same
    // collapsed thinking affordance the v2 block path uses.
    case 'thinking_delta':
    case 'self_thinking_delta':
      onEvent({ type: 'thinking', delta: data.delta ?? data.text ?? data.content ?? '' });
      break;

    case 'follow_up_questions':
      onEvent({ type: 'follow_ups', questions: data.follow_up_questions || [] });
      break;

    case 'stream_complete':
      st.terminal = true;
      onEvent({ type: 'complete', data });
      break;
    case 'cancel':
      st.terminal = true;
      onEvent({ type: 'cancel' });
      break;
    case 'error':
      st.terminal = true;
      onEvent({ type: 'error', message: (data && data.error) || 'Lexi hit an error.' });
      break;

    default:
      // Unknown/future events are ignorable (liveness only) — like the web reader.
      break;
  }
}

function mapBlockStart(data) {
  const block = data.block || {};
  const bi = data.block_index;
  if (block.type === 'text') {
    return { type: 'block_start', blockIndex: bi, kind: 'text', purpose: block.purpose || 'answer' };
  }
  if (block.type === 'thinking') {
    return { type: 'block_start', blockIndex: bi, kind: 'thinking' };
  }
  if (block.type === 'tool_use') {
    return {
      type: 'block_start',
      blockIndex: bi,
      kind: 'tool',
      toolId: block.id,
      name: block.name,
      status: block.status || 'running',
    };
  }
  if (block.type === 'artifact') {
    return {
      type: 'block_start',
      blockIndex: bi,
      kind: 'artifact',
      artifactId: block.artifact_id,
      title: block.title || 'Draft',
      artifactKind: block.kind,
      version: block.version || null,
    };
  }
  return { type: 'block_start', blockIndex: bi, kind: block.type || 'unknown' };
}

function mapBlockDelta(data) {
  const bi = data.block_index;
  const delta = data.delta || {};
  switch (delta.kind) {
    case 'text':
      return { type: 'block_delta', blockIndex: bi, kind: 'text', delta: delta.text || '' };
    case 'thinking':
      return { type: 'block_delta', blockIndex: bi, kind: 'thinking', delta: delta.text || '' };
    case 'input_json':
      return { type: 'block_delta', blockIndex: bi, kind: 'input_json', partialJson: delta.partial_json || '' };
    case 'artifact_content':
      return { type: 'block_delta', blockIndex: bi, kind: 'artifact_content', delta: delta.text || '' };
    default:
      return { type: 'block_delta', blockIndex: bi, kind: delta.kind || 'unknown' };
  }
}

function summarizeTally(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'Building…';
  return rows
    .map((r) => `${r.label || r.key}: ${r.value ?? 0}${r.total ? `/${r.total}` : ''}`)
    .join(' · ');
}
