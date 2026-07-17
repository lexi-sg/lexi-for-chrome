// src/agent/gemini-nano.js
//
// Optional, keyless, on-device provider backed by Chrome's built-in Prompt API
// (`LanguageModel`, GA in Chrome 138+ for extensions — no origin trial token,
// no manifest permission required).
//
// This is strictly a "Basic (on-device)" tier: text-only, no tools, no vision,
// never used for agent mode or for risk-flagging full contracts. The caller
// (sidepanel.js) is responsible for only surfacing this tier when
// `nanoAvailability()` resolves to 'available' (or 'downloadable'), for
// showing a "basic on-device model" badge + an upgrade-to-Claude nudge on
// every response produced here, and for routing straight to BYOK onboarding
// when this tier is unavailable.
//
// ES module — imported directly by sidepanel.js. Not used as a classic
// content script, so `import`/`export` are safe here.

/**
 * Capability flags for the Nano on-device tier. Consumed by the side panel
 * to decide what UI affordances (quick actions, agent toggle, image upload)
 * to show/hide when this provider is active.
 * @type {{vision: boolean, tools: boolean, agent: boolean}}
 */
export const NANO_CAPABILITIES = Object.freeze({
  vision: false,
  tools: false,
  agent: false,
});

/**
 * Feature-detects and reports the readiness of Chrome's on-device
 * LanguageModel (Gemini Nano) for plain English text prompting.
 *
 * @returns {Promise<'unavailable'|'downloadable'|'downloading'|'available'>}
 */
export async function nanoAvailability() {
  if (typeof LanguageModel === 'undefined') {
    return 'unavailable';
  }

  try {
    const availability = await LanguageModel.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
    });

    if (
      availability === 'available' ||
      availability === 'downloadable' ||
      availability === 'downloading'
    ) {
      return availability;
    }

    return 'unavailable';
  } catch (err) {
    // Any feature-detection failure (older Chrome, disabled flag, unsupported
    // platform) is treated as simply unavailable — this tier is optional and
    // must fail closed, never surface an error to the user.
    return 'unavailable';
  }
}

/**
 * Runs a single text-only prompt against the on-device Gemini Nano model,
 * streaming incremental text deltas to the caller as they arrive.
 *
 * Text-only, no tool use, no vision — never call this for agent mode or for
 * risk-flagging a full contract; it exists solely for lightweight single-
 * clause "explain" / "summarize" quick actions.
 *
 * @param {string} text - The user's prompt (already includes any selected
 *   page text / clause the quick action is operating on).
 * @param {object} [options]
 * @param {string} [options.system] - Optional system instruction, e.g. a
 *   short "explain this legal clause in plain English" directive.
 * @param {AbortSignal} [options.signal] - Aborts session creation and/or the
 *   in-flight prompt (wired to the panel's Stop button).
 * @param {(delta: string, fullTextSoFar: string) => void} [options.onDelta] -
 *   Invoked once per streamed chunk with the incremental delta and the
 *   cumulative text so far, so the panel can render progressively.
 * @returns {Promise<string>} The full generated text once streaming ends.
 */
export async function nanoPrompt(text, options = {}) {
  const { system, signal, onDelta } = options;

  if (typeof LanguageModel === 'undefined') {
    throw new Error(
      'Gemini Nano (on-device LanguageModel) is not available in this browser.'
    );
  }

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const createOptions = {};
  if (system) {
    createOptions.initialPrompts = [{ role: 'system', content: system }];
  }
  if (signal) {
    createOptions.signal = signal;
  }

  const session = await LanguageModel.create(createOptions);

  try {
    const promptOptions = signal ? { signal } : undefined;
    const stream = session.promptStreaming(text, promptOptions);

    let fullText = '';
    for await (const delta of stream) {
      if (!delta) {
        continue;
      }
      fullText += delta;
      if (typeof onDelta === 'function') {
        onDelta(delta, fullText);
      }
    }

    return fullText;
  } finally {
    // Free the on-device session's resources as soon as we're done with it —
    // Nano sessions hold real memory/VRAM for the lifetime of the object.
    if (typeof session.destroy === 'function') {
      try {
        session.destroy();
      } catch (err) {
        // Best-effort cleanup only; nothing actionable if this fails.
      }
    }
  }
}
