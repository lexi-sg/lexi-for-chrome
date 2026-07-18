// src/agent/anthropic-client.js
//
// Context-agnostic Anthropic Messages API client: streaming SSE, vision
// payloads, tools, key validation. Works identically in the side panel or
// the service worker context (pure fetch, no chrome.* APIs) — the LLM call
// itself is only ever made from the side panel per the architecture, but
// this module makes no assumption about that.
//
// ES module.

import {
  ANTHROPIC_URL,
  ANTHROPIC_MODELS_URL,
  ANTHROPIC_VERSION,
  EXTENSION_PROXY_PATH,
} from '../config.js';

// ---------------------------------------------------------------------------
// Typed error taxonomy (see spec.agent_loop_design "ERROR RECOVERY").
// ---------------------------------------------------------------------------

/** Base class for any non-2xx response from the Anthropic API. */
export class ApiError extends Error {
  constructor(message, { status, body, requestId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? null;
    this.body = body ?? null;
    this.requestId = requestId ?? null;
  }
}

/** 401 — invalid/missing API key. Fatal: surface to the user, do not retry. */
export class AuthError extends ApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'AuthError';
  }
}

/** 403 — key lacks permission for this model/feature. Fatal: do not retry. */
export class ForbiddenError extends ApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'ForbiddenError';
  }
}

/** 429 — rate limited. streamMessage() already retries this with backoff. */
export class RateLimitError extends ApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'RateLimitError';
  }
}

/** 529 — Anthropic is overloaded. streamMessage() already retries with backoff. */
export class OverloadedError extends ApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'OverloadedError';
  }
}

/**
 * The model produced tool_use input that could not be parsed as JSON.
 * Per spec: retry that one step once before giving up.
 */
export class ValidationError extends Error {
  constructor(message, { raw } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.raw = raw ?? null;
  }
}

// ---------------------------------------------------------------------------
// Retry / backoff helper for 429 / 529 (exponential, 3 tries).
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  const jitter = Math.random() * 250;
  return Math.min(BASE_DELAY_MS * 2 ** attempt + jitter, MAX_DELAY_MS);
}

/**
 * Normalize the caller's auth descriptor. Two shapes are accepted so both
 * transports share one client:
 *   {mode:'account', token, baseUrl} -> the landed Anthropic-shaped proxy
 *       (POST {baseUrl}/api/extension/messages) with a Bearer token. The
 *       server injects the real Anthropic key; we send NO x-api-key.
 *   {mode:'byok', apiKey}            -> direct api.anthropic.com (escape hatch)
 * A bare `apiKey` (legacy call shape) is treated as BYOK for backwards
 * compatibility, so existing BYOK callers/tests keep working unchanged.
 */
function resolveAuth(auth, apiKey) {
  if (auth && auth.mode) return auth;
  return { mode: 'byok', apiKey };
}

/** Target URL for a resolved auth descriptor. */
function endpointFor(auth) {
  if (auth.mode === 'account') return `${auth.baseUrl}${EXTENSION_PROXY_PATH}`;
  return ANTHROPIC_URL;
}

function buildHeaders(auth) {
  if (auth.mode === 'account') {
    // Bearer token only — never x-api-key/anthropic-* (the proxy owns those).
    // X-Lexi-Extension-Mode:agent flags this traffic for the 2x agent-quota
    // weighting the landed entitlement service applies.
    return {
      Authorization: `Bearer ${auth.token}`,
      'X-Lexi-Extension-Mode': 'agent',
      'content-type': 'application/json',
    };
  }
  return {
    'x-api-key': auth.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json',
  };
}

/**
 * Per-model `thinking` request field.
 *
 * This UI never surfaces the model's chain of thought, so we disable thinking
 * wherever the API allows it: that keeps tool-using turns free of Anthropic's
 * thinking-replay contract and avoids spending BYOK tokens on reasoning the
 * user never sees. Claude Fable 5 / Mythos run thinking UNCONDITIONALLY and
 * reject an explicit `{type:'disabled'}` with a 400 — for those we omit the
 * field entirely and instead rely on the thinking-block capture + replay path
 * (interpretSseEvent below emits `thinking_block` events; agent-loop.js and
 * sidepanel.js replay those blocks, verbatim and in order, ahead of any
 * tool_use when reconstructing the assistant turn) to satisfy the contract.
 */
function thinkingParamFor(model) {
  if (/fable|mythos/i.test(String(model || ''))) return null;
  return { type: 'disabled' };
}

/**
 * Normalizes an accumulated thinking / redacted_thinking block into the exact
 * content-block shape it must be echoed back as on the next request (same
 * model), preserving `signature` (or `data`) verbatim — including empty
 * `thinking` text, which the API accepts on replay but rejects if modified.
 */
function thinkingBlockToContent(block) {
  if (block.type === 'redacted_thinking') {
    return { type: 'redacted_thinking', data: block.data || '' };
  }
  return { type: 'thinking', thinking: block.thinking || '', signature: block.signature || '' };
}

async function parseErrorBody(response) {
  try {
    const json = await response.json();
    return (json && json.error && json.error.message) || response.statusText || 'Unknown Anthropic API error';
  } catch {
    return response.statusText || 'Unknown Anthropic API error';
  }
}

function errorForStatus(status, message, opts) {
  if (status === 401) return new AuthError(message, opts);
  if (status === 403) return new ForbiddenError(message, opts);
  if (status === 429) return new RateLimitError(message, opts);
  if (status === 529) return new OverloadedError(message, opts);
  return new ApiError(message, opts);
}

function statusForErrorType(type) {
  switch (type) {
    case 'authentication_error':
      return 401;
    case 'permission_error':
      return 403;
    case 'rate_limit_error':
      return 429;
    case 'overloaded_error':
      return 529;
    default:
      return 500;
  }
}

/**
 * POST to /v1/messages with retry/backoff on 429/529. Returns the raw fetch
 * Response (still unread — caller consumes the SSE body). Throws a typed
 * error for any other non-2xx status. AbortError propagates immediately.
 */
async function postWithRetry(body, auth, signal) {
  const url = endpointFor(auth);
  const headers = buildHeaders(auth);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      if (attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw new ApiError(`Network error contacting Anthropic: ${err && err.message}`, {});
    }

    if (response.ok) return response;

    const status = response.status;
    const requestId = response.headers.get('request-id') || null;

    if ((status === 429 || status === 529) && attempt < MAX_RETRIES) {
      const retryAfterHeader = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : backoffDelay(attempt);
      await sleep(delay);
      continue;
    }

    const message = await parseErrorBody(response);
    throw errorForStatus(status, message, { status, requestId });
  }
  // Unreachable in practice (the loop always returns or throws), but keeps
  // control flow analyzers happy.
  throw new ApiError('Exhausted retries contacting Anthropic');
}

// ---------------------------------------------------------------------------
// SSE parsing.
// ---------------------------------------------------------------------------

/** Parses one raw "event: X\ndata: {...}" block into {event, data}. */
function parseSseEvent(rawEvent) {
  let eventName = 'message';
  const dataLines = [];
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
    // ignore blank lines / ":" comment lines / "id:" lines
  }
  if (dataLines.length === 0) return null;
  try {
    return { event: eventName, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

/**
 * Turns one parsed SSE event into zero or more of our public event shapes,
 * mutating the shared `blocks` (per-content-block accumulation state) and
 * `usage` (running usage totals) maps/objects as it goes. May throw a typed
 * ApiError for a mid-stream `event: error`.
 */
function interpretSseEvent(parsed, blocks, usage) {
  const { event, data } = parsed;
  const events = [];

  switch (event) {
    case 'message_start': {
      Object.assign(usage, (data.message && data.message.usage) || {});
      events.push({ type: 'usage', usage: { ...usage } });
      break;
    }

    case 'content_block_start': {
      const block = data.content_block || {};
      if (block.type === 'tool_use') {
        blocks.set(data.index, { type: 'tool_use', id: block.id, name: block.name, json: '' });
        events.push({ type: 'tool_use_start', id: block.id, name: block.name, index: data.index });
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        // Thinking blocks are never rendered, but they MUST be captured so they
        // can be replayed verbatim ahead of tool_use on the next request (the
        // API's replay rule for thinking-enabled models such as Fable 5).
        blocks.set(data.index, {
          type: block.type,
          thinking: block.thinking || '',
          signature: block.signature || '',
          data: block.data || '',
        });
      } else {
        blocks.set(data.index, { type: block.type });
      }
      break;
    }

    case 'content_block_delta': {
      const delta = data.delta || {};
      if (delta.type === 'text_delta') {
        events.push({ type: 'text', delta: delta.text, index: data.index });
      } else if (delta.type === 'input_json_delta') {
        const block = blocks.get(data.index);
        if (block) {
          block.json += delta.partial_json || '';
          events.push({
            type: 'tool_use_delta',
            id: block.id,
            index: data.index,
            partialJson: delta.partial_json || '',
            accumulated: block.json,
            done: false,
          });
        }
      } else if (delta.type === 'thinking_delta') {
        const block = blocks.get(data.index);
        if (block) block.thinking += delta.thinking || '';
      } else if (delta.type === 'signature_delta') {
        const block = blocks.get(data.index);
        if (block) block.signature += delta.signature || '';
      }
      // thinking/signature deltas are accumulated (for the replay block) but not
      // surfaced as UI text — Agent Mode does not stream thinking to the UI.
      break;
    }

    case 'content_block_stop': {
      const block = blocks.get(data.index);
      if (block && block.type === 'tool_use') {
        let input;
        let parseError = null;
        try {
          input = block.json ? JSON.parse(block.json) : {};
        } catch (err) {
          parseError = err.message;
        }
        events.push({
          type: 'tool_use_delta',
          id: block.id,
          index: data.index,
          partialJson: '',
          accumulated: block.json,
          done: true,
          input,
          parseError,
        });
      } else if (block && (block.type === 'thinking' || block.type === 'redacted_thinking')) {
        events.push({ type: 'thinking_block', index: data.index, block: thinkingBlockToContent(block) });
      }
      blocks.delete(data.index);
      break;
    }

    case 'message_delta': {
      if (data.usage) Object.assign(usage, data.usage);
      events.push({ type: 'usage', usage: { ...usage } });
      if (data.delta && data.delta.stop_reason) {
        events.push({
          type: 'stop',
          stopReason: data.delta.stop_reason,
          stopSequence: data.delta.stop_sequence || null,
        });
      }
      break;
    }

    case 'error': {
      const err = data.error || {};
      const status = statusForErrorType(err.type);
      throw errorForStatus(status, err.message || 'Anthropic stream error', { status });
    }

    case 'message_stop':
    case 'ping':
    default:
      break;
  }

  return events;
}

/**
 * Streams one Messages API call, yielding incremental events as the SSE
 * response arrives. Reassembles tool_use `input_json_delta` fragments into
 * a running `accumulated` string, and — once a tool_use content block
 * closes — attempts to JSON.parse the full input, attaching the parsed
 * `input` (or a `parseError` string) to that block's final `tool_use_delta`
 * event (done:true).
 *
 * Yielded event shapes (the `type` values are the cross-file contract —
 * consumers must switch on `type`, not assume any other field is present):
 *   {type:'text', delta, index}
 *   {type:'tool_use_start', id, name, index}
 *   {type:'tool_use_delta', id, index, partialJson, accumulated, done, input?, parseError?}
 *   {type:'thinking_block', index, block}  - a completed thinking /
 *        redacted_thinking block, already in the content-block shape it must be
 *        echoed back as (with signature/data preserved). Only emitted for
 *        models that run thinking (e.g. Fable 5); consumers replay these ahead
 *        of tool_use blocks when reconstructing the assistant turn.
 *   {type:'stop', stopReason, stopSequence}
 *   {type:'usage', usage}
 *
 * @param {object} opts
 * @param {{mode:'account',token:string,baseUrl:string}|{mode:'byok',apiKey:string}} [opts.auth]
 *   Auth descriptor (preferred). If omitted, `opts.apiKey` is used as BYOK.
 * @param {string} [opts.apiKey] - legacy BYOK key (equivalent to auth:{mode:'byok',apiKey}).
 * @param {string} opts.model
 * @param {string} opts.system - plain text system prompt (wrapped with an
 *   ephemeral cache_control breakpoint automatically).
 * @param {Array}  opts.messages
 * @param {Array}  [opts.tools]
 * @param {number} opts.maxTokens
 * @param {AbortSignal} [opts.signal]
 */
export async function* streamMessage({ apiKey, auth, model, system, messages, tools, maxTokens, signal }) {
  const resolvedAuth = resolveAuth(auth, apiKey);
  const body = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    stream: true,
  };
  const thinking = thinkingParamFor(model);
  if (thinking) body.thinking = thinking;
  if (tools && tools.length) body.tools = tools;

  const response = await postWithRetry(body, resolvedAuth, signal);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const blocks = new Map(); // content-block index -> {type, id?, name?, json?}
  const usage = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex = buffer.indexOf('\n\n');
      while (sepIndex !== -1) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const parsed = parseSseEvent(rawEvent);
        if (parsed) {
          for (const evt of interpretSseEvent(parsed, blocks, usage)) {
            yield evt;
          }
        }
        sepIndex = buffer.indexOf('\n\n');
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
 * Cheap key-validation call: GET /v1/models with the given key. Used on
 * paste in options.js so onboarding fails fast with a clear message.
 */
export async function validateKey(apiKey) {
  try {
    const response = await fetch(ANTHROPIC_MODELS_URL, {
      method: 'GET',
      headers: buildHeaders({ mode: 'byok', apiKey }),
    });
    if (response.ok) return { valid: true, error: null };
    const message = await parseErrorBody(response);
    return { valid: false, error: message };
  } catch (err) {
    return { valid: false, error: (err && err.message) || 'Network error validating key' };
  }
}

/**
 * Converts a data: URL (or bare base64 string) PNG into an Anthropic vision
 * content block. Strips any `data:image/png;base64,` prefix if present.
 */
export function imageBlock(dataUrl) {
  const commaIndex = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
  const data = commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data },
  };
}
