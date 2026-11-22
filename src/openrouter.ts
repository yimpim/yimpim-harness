import { AgentConfig } from "./config.js";
import { fallbackTag } from "./workerLedger.js";
import { events, TokenUsage } from "./events.js";
import { runControl, AbortedError } from "./remote/control.js";
import { hasPinnedInput, writeRawAbove } from "./terminalInput.js";
import { trackCall } from "./liveCalls.js";
import { redactMessages } from "./redact.js";
import { tuneRequest, isReasoningRejected, isPriceCapMiss } from "./requestTuning.js";

export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** A plain string, or a content-block array for multimodal (vision) input. */
  content?: string | null | any[];
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  reasoning?: string;
  thought?: string;
  thought_signature?: string;
  [key: string]: any; // Preserves proprietary upstream signature fields
}

export interface CompleteOptions {
  tools?: FunctionTool[];
  toolChoice?: any;
  jsonSchema?: { name: string; schema: any };
  /** Plain `{"type":"json_object"}` mode, for callers with no schema to enforce. */
  jsonMode?: boolean;
  /**
   * The JSON reply is held to this schema for Google models (response_format json_schema); every other model gets plain `json_object` mode.
   * For callers whose reply looks like an action, which Gemini otherwise sometimes tries to emit as a native function call.
   */
  structured?: { name: string; schema: unknown };
  temperature?: number;
  /**
   * Ask the model to think before it answers, at this effort, whatever the settings turn off for this agent (deepseek.reasoningOff) and whatever the model
   * does by default. For a caller whose answer must be reasoned (the security panel). A model that cannot take the field is called again without it.
   */
  reasoning?: "low" | "medium" | "high";
  /** Agent role, recorded against token usage so tiering can be measured. */
  agent?: string;
  /** Overrides the default idle-stream timeout (see readStreamedCompletion) — exposed mainly for tests. */
  idleStreamTimeoutMs?: number;
  /**
   * Hard ceiling on one attempt's WHOLE duration, independent of the
   * time-to-first-byte and idle-stream guards below — those two together
   * still let a stream that trickles just enough data to reset the idle
   * timer (a degraded/overloaded provider, not a genuinely slow one) run
   * unbounded, since neither one ever fires. Left unset (the default) for
   * every large-output caller (Editor, Repair, Discovery, Planner), which
   * deliberately has no total-duration cap — see complete()'s own comment
   * for why that was removed. Set this only for callers whose OWN output is
   * always small and bounded regardless of input size (a QA verdict, a tap
   * decision) and so has no legitimate reason to ever run long even on a
   * slow-but-healthy model.
   */
  maxTotalDurationMs?: number;
}

export interface ModelHealth {
  /** Epoch ms before which this model is tried only as a last resort. */
  cooldownUntil: number;
  /** Consecutive whole-call failures; a success resets it. */
  failures: number;
}

/** First cooldown after a model fails every attempt of a call; doubles per
 *  consecutive failure up to the cap. */
/** When the account is out of credits: how long between checks. Four minutes, indefinitely: one request per check, never a burst. */
export const CREDITS_RECHECK_MS = 4 * 60_000;
/** Tries on a model that has a fallback model behind it in the chain (a model with nothing after it gets limits.apiMaxAttempts). */
export const FALLBACK_TRIES = 2;
export const MODEL_COOLDOWN_BASE_MS = 3 * 60_000;
export const MODEL_COOLDOWN_MAX_MS = 20 * 60_000;

export function cooldownFor(failures: number): number {
  return Math.min(MODEL_COOLDOWN_MAX_MS, MODEL_COOLDOWN_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/**
 * The order to try a call's models in: healthy ones first, in the configured
 * order, then any still cooling down (also in order) as a last resort — a
 * cooled-down model is never dropped, because if every other model fails it may
 * be the only one that works. A chain where nothing is cooling keeps its order.
 */
export function orderByHealth(models: string[], health: Map<string, ModelHealth>, now = Date.now()): string[] {
  const healthy = models.filter((m) => (health.get(m)?.cooldownUntil ?? 0) <= now);
  const cooling = models.filter((m) => (health.get(m)?.cooldownUntil ?? 0) > now);
  return [...healthy, ...cooling];
}

export class OpenRouterClient {
  private apiKey: string;
  private config?: AgentConfig;
  // True once an "insufficient credits" notification has been emitted and
  // not yet followed by a successful call — guards against re-emitting the
  // same notification on every single retry while waiting for the user to
  // top up (see complete()'s 402 handling). Reset to false the moment ANY
  // call succeeds, so a LATER depletion (a long-running, multi-task session
  // that burns through newly-added credits again) still gets a fresh one.
  private creditsWarningActive = false;
  // Cross-call memory of which models just failed a whole call. Without it,
  // every call starts again at the top of its chain, so a model that is down
  // gets retried (and waited on) first, every single time, even right after a
  // fallback to its backup worked. See orderByHealth.
  private modelHealth = new Map<string, ModelHealth>();

  constructor(apiKeyOrConfig?: string | AgentConfig, config?: AgentConfig) {
    if (typeof apiKeyOrConfig === "string") {
      this.apiKey = apiKeyOrConfig;
      this.config = config;
    } else if (apiKeyOrConfig && typeof apiKeyOrConfig === "object") {
      this.config = apiKeyOrConfig;
      this.apiKey = process.env.OPENROUTER_API_KEY || "";
    } else {
      this.apiKey = process.env.OPENROUTER_API_KEY || "";
    }

    if (!this.apiKey) {
      throw new Error("Missing OPENROUTER_API_KEY environment variable.");
    }
  }

  /**
   * Swap the key this client sends without recreating it. Lets a rotated key
   * (e.g. via /api-key in an interactive session) take effect on the very
   * next call, rather than requiring a restart.
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }

  /** How long to wait between checks when the account is out of credits. A field (not only the constant) so a test can shorten it. */
  public creditsRecheckMs = CREDITS_RECHECK_MS;

  /**
   * The wait between credit checks. Unlike `delay`, a user Stop ends it at once (a wait this long that ignored Stop would leave a stopped run
   * hanging for minutes), by throwing the same AbortedError the rest of the client uses for a Stop.
   */
  private async creditsDelay(ms: number): Promise<void> {
    if (runControl.isAborted) throw new AbortedError(runControl.reason);
    const signal = runControl.signal;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortedError(runControl.reason));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Reads one streamed chat-completion response and reassembles it into the
   * exact `ChatMessage` shape the non-streaming API used to return, so no
   * caller has to know streaming happened at all.
   *
   * OpenRouter streams SSE: one `data: {...}` line per delta, terminated by
   * `data: [DONE]`. Three things make this more than a `JSON.parse` loop:
   *  - Chunks are raw bytes, not text, and a multi-byte character (or a whole
   *    SSE frame) can straddle a chunk boundary — hence the TextDecoder with
   *    `{ stream: true }` plus a line buffer that only emits complete lines.
   *  - Content, reasoning/thought and `tool_calls` all arrive as FRAGMENTS
   *    that must be concatenated, not replaced; tool-call argument strings in
   *    particular are typically split across many chunks.
   *  - `usage` (opted into by the request's `usage.include`) only shows up on
   *    a final frame, and providers that never send one still need a token
   *    figure recorded rather than vanishing from the cost summary.
   *
   * `onFirstChunk` fires once, before the first frame is parsed — that is the
   * only moment the caller's request timeout is still meaningful.
   */
  /**
   * `controller`/`idleTimeoutMs` guard against a stream that goes silent
   * AFTER it already started — the request's own timeout (see `complete()`'s
   * timeoutDurationMs) only ever covers time-to-first-byte and is cleared the
   * instant any byte arrives, so without this a connection that streamed one
   * chunk and then stalled (a dead socket the OS never reports as closed, a
   * provider hang) had no ceiling at all and could sit "still waiting"
   * indefinitely. Reset on every chunk, so a genuinely slow-but-alive
   * generation is never killed — only real silence trips it.
   */
  private async readStreamedCompletion(
    response: Response,
    controller: AbortController,
    idleTimeoutMs: number,
    onFirstChunk?: () => void,
    /** Told how many characters the model has produced so far (answer, thinking and tool arguments), for the live status line. */
    onProgress?: (chars: number) => void
  ): Promise<{ message: ChatMessage; usage?: TokenUsage; finish?: { reason?: string; native?: string } }> {
    if (!response.body) {
      throw new Error("Streaming response carried no body to read.");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let thought = "";
    let thoughtSignature: string | undefined;
    const toolCalls: any[] = [];
    // Delta keys this method assembles itself. Anything else a provider streams
    // (Gemini's opaque thought signature via `reasoning_details`, a refusal, an
    // audio transcript, ...) is passed through verbatim: callers echo the
    // assistant message straight back on the next tool-call turn, and a
    // provider that signed it rejects the follow-up if that field went missing.
    const ASSEMBLED_DELTA_KEYS = new Set([
      "role",
      "content",
      "reasoning",
      "reasoning_content",
      "thought",
      "thought_signature",
      "tool_calls",
    ]);
    const passthrough: Record<string, any> = {};
    let usagePayload: any;
    // Why the provider ended the answer: a call that produced nothing is told apart from one with nothing to say by this (Google ends a call that
    // tried to emit a malformed function call as `error` / `MALFORMED_FUNCTION_CALL`, with no text at all).
    let finishReason: string | undefined;
    let nativeFinish: string | undefined;
    let sawFirstChunk = false;

    /** Tool-call deltas are keyed by `index`, never by array position — one
     *  call's id/name arrive once, its argument string arrives in pieces. */
    const mergeToolCallDelta = (delta: any) => {
      const index = typeof delta?.index === "number" ? delta.index : toolCalls.length;
      const existing = (toolCalls[index] ??= {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      });

      if (typeof delta.id === "string" && delta.id) {
        // Almost every provider sends the whole id exactly once; a few emit it
        // in fragments. Appending only when it genuinely differs handles both
        // without duplicating an id that merely repeats verbatim.
        existing.id = existing.id && existing.id !== delta.id ? existing.id + delta.id : delta.id;
      }
      if (typeof delta.type === "string" && delta.type) existing.type = delta.type;

      const fn = delta.function ?? {};
      if (typeof fn.name === "string" && fn.name) {
        existing.function.name =
          existing.function.name && existing.function.name !== fn.name
            ? existing.function.name + fn.name
            : fn.name;
      }
      if (typeof fn.arguments === "string") existing.function.arguments += fn.arguments;
    };

    /** One `data:` payload. Malformed frames and keep-alives are skipped — a
     *  single bad line must never abort an otherwise healthy stream. */
    const consumeFrame = (payload: string) => {
      if (!payload || payload === "[DONE]") return;
      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }

      // A provider can fail MID-stream (quota exhausted, upstream dropped)
      // and report it as an error frame with no choices at all. Thrown rather
      // than swallowed: the retry/fallback chain above can react to a thrown
      // error, whereas silently returning an empty completion looks exactly
      // like a model that simply had nothing to say.
      if (parsed?.error) {
        const detail = parsed.error.message ?? JSON.stringify(parsed.error);
        throw new Error(`Stream error: ${detail}`);
      }

      // Sent on its own final frame (choices is empty there), so this is read
      // before the choice is inspected rather than as part of it.
      if (parsed?.usage) usagePayload = parsed.usage;

      const choice = parsed?.choices?.[0];
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      if (typeof choice?.native_finish_reason === "string") nativeFinish = choice.native_finish_reason;
      // `message` rather than `delta` covers providers that emit the assembled
      // message in their last frame instead of a delta.
      const delta = choice?.delta ?? choice?.message;
      if (!delta) return;

      if (typeof delta.content === "string") {
        content += delta.content;
      } else if (Array.isArray(delta.content)) {
        // Some providers stream content as typed blocks rather than a string.
        for (const block of delta.content) {
          if (typeof block === "string") content += block;
          else if (typeof block?.text === "string") content += block.text;
        }
      }

      if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
      else if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (typeof delta.thought === "string") thought += delta.thought;
      // Carried through verbatim: it's a proprietary upstream signature some
      // providers require echoed back on the next tool-call turn.
      if (typeof delta.thought_signature === "string") thoughtSignature = delta.thought_signature;

      if (Array.isArray(delta.tool_calls)) for (const tc of delta.tool_calls) mergeToolCallDelta(tc);
      if (onProgress) {
        let chars = content.length + reasoning.length + thought.length;
        for (const tc of toolCalls) chars += tc?.function?.arguments?.length ?? 0;
        onProgress(chars);
      }

      for (const [key, value] of Object.entries(delta)) {
        if (ASSEMBLED_DELTA_KEYS.has(key) || value == null) continue;
        if (typeof value === "string") {
          // Same rule as a tool-call id: append only when it genuinely differs,
          // so a field that simply repeats on every frame isn't duplicated
          // while a field streamed as fragments still comes through whole.
          passthrough[key] = passthrough[key] && passthrough[key] !== value ? passthrough[key] + value : value;
        } else {
          passthrough[key] = value;
        }
      }
    };

    /** One raw SSE line: comments (`:`), `event:`/`id:` frames and blanks all
     *  carry no delta and are ignored. */
    const consumeLine = (raw: string) => {
      const line = raw.trim();
      if (!line || line.startsWith(":")) return;
      if (!line.startsWith("data:")) return;
      consumeFrame(line.slice(5).trim());
    };

    let idleTimer: NodeJS.Timeout | undefined;
    const idleTimeoutError = new Error(
      `Stream stalled: no new data received for ${idleTimeoutMs / 1000}s after streaming had already begun.`
    );
    // Same name as the time-to-first-byte error, and for the same reason: any
    // caller classifying model-call failures (orchestrator.ts's
    // classifyEditorError, this file's own retry branch below) already
    // branches on "TimeoutError" and should treat either kind the same way —
    // `stalled` is only there to let this file's own diagnostic line say
    // which one actually fired.
    idleTimeoutError.name = "TimeoutError";
    (idleTimeoutError as any).stalled = true;
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(idleTimeoutError), idleTimeoutMs);
    };

    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        // The request timeout only guards time-to-first-byte. Once anything
        // has arrived the model is demonstrably alive, and a long generation
        // must be allowed to finish — from here on, only a user Stop or a
        // genuine mid-stream stall (armIdleTimer, above) cuts it short.
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          onFirstChunk?.();
        }
        armIdleTimer();

        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          consumeLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      }
    } finally {
      clearTimeout(idleTimer);
    }

    // Flush whatever the decoder held back, plus any final frame that arrived
    // without a trailing newline.
    buffer += decoder.decode();
    for (const line of buffer.split("\n")) consumeLine(line);

    const message: ChatMessage = {
      role: "assistant",
      // `null`, not `""`: identical to what the non-streaming API returns for a
      // pure tool-call turn, which is what callers already branch on.
      content: content.length > 0 ? content : null,
    };
    if (reasoning) message.reasoning = reasoning;
    if (thought) message.thought = thought;
    if (thoughtSignature) message.thought_signature = thoughtSignature;
    if (toolCalls.length > 0) message.tool_calls = toolCalls.filter(Boolean);
    Object.assign(message, passthrough);

    let usage: TokenUsage | undefined;
    if (usagePayload) {
      usage = {
        prompt: usagePayload.prompt_tokens ?? 0,
        completion: usagePayload.completion_tokens ?? 0,
        total: usagePayload.total_tokens ?? 0,
        // Present because of usage.include in the request. Absent (rather than
        // 0) on any provider/route that doesn't report it, so a summary can
        // tell "genuinely free" apart from "cost unknown" instead of silently
        // treating both the same way.
        cost: typeof usagePayload.cost === "number" ? usagePayload.cost : undefined,
      };
    } else if (content.length > 0 || reasoning.length > 0 || toolCalls.length > 0) {
      // A provider that reported no usage at all still produced tokens; an
      // approximation keeps the call visible in the usage summary instead of
      // it disappearing from the cost picture entirely. Prompt tokens are
      // genuinely unknowable here, so they stay 0 rather than being invented.
      const completion = Math.max(1, Math.ceil((content.length + reasoning.length + thought.length) / 4));
      usage = { prompt: 0, completion, total: completion };
    }

    return { message, usage, finish: { reason: finishReason, native: nativeFinish } };
  }

  async complete(
    models: string | string[],
    messages: ChatMessage[],
    options?: CompleteOptions
  ): Promise<any> {
    // Credential-shaped values never leave this machine (redact.ts); a [REDACT] line says so when one is replaced.
    messages = redactMessages(messages);
    const requested = Array.isArray(models) ? models : [models];
    const modelList = orderByHealth(requested, this.modelHealth);
    if (modelList.length > 1 && modelList[0] !== requested[0]) {
      const mins = Math.ceil(((this.modelHealth.get(requested[0])?.cooldownUntil ?? 0) - Date.now()) / 60_000);
      console.log(`[${fallbackTag(options?.agent)}] ${requested[0]} failed a recent call — trying ${modelList[0]} first (it is tried first again in ~${Math.max(1, mins)}m).`);
    }
    let lastError: Error | null = null;
    // Insufficient-credits retries (see the 402 branch below) are uncounted
    // against maxRetriesPerModel, and they are NOT capped: the user's cost
    // control is the limit they set on their own OpenRouter key, and when
    // the money runs out the run waits for it, checking again every
    // CREDITS_RECHECK_MS (one request, never a burst), and carries on
    // exactly where it was once credits are back. A user Stop ends the wait.
    // When the first 402 of this call arrived, for the "waiting since" line.
    let creditsSince: number | undefined;
    // 3 attempts = the initial call plus 2 retries on the SAME model before
    // falling through to the next one in the chain (the loop below). This
    // timeout only ever guards time-to-first-byte (see firstChunkTimer) — a
    // model that's actively streaming is never killed by this regardless of
    // total duration, only a call where literally nothing has arrived yet.
    // idleStreamTimeoutMs is the companion guard for AFTER streaming starts:
    // see readStreamedCompletion's own doc comment.
    // limits.apiMaxAttempts is the tries for a model with nothing after it. A model with a fallback behind it gets at most 2: a dead endpoint should hand over to the next model after two
    // tries, not four. The wait for the first byte (timeoutDurationMs) is NOT shortened: a large prefill or a reasoning pass legitimately takes minutes, and aborting it wastes the input tokens.
    const configuredTries = this.config?.limits?.apiMaxAttempts ?? 3;
    // limits.apiBaseDelayMs scales every backoff below: 1000 keeps the built-in waits, 500 halves them. A wait the server asks for (Retry-After) is never scaled.
    const backoff = (this.config?.limits?.apiBaseDelayMs ?? 1000) / 1000;
    const timeoutDurationMs = 300_000;
    const idleStreamTimeoutMs = options?.idleStreamTimeoutMs ?? 90_000;
    const maxTotalDurationMs = options?.maxTotalDurationMs;

    // Surfaced in every "[API] ..." console line below so a bare "Calling
    // deepseek/... — 20s elapsed" doesn't leave someone watching the terminal
    // (or a paired phone) guessing which agent's turn it currently is —
    // that context already exists here, it just wasn't being printed.
    const agent = options?.agent ?? "unknown";

    for (const model of modelList) {
      const maxRetriesPerModel = model === modelList[modelList.length - 1] ? configuredTries : Math.min(configuredTries, FALLBACK_TRIES);
      // Set when this model cannot read images at all: a fact about the model, not a failure, so it is neither retried nor
      // counted against its health for the text-only calls that follow.
      let cannotReadImages = false;
      // Set when this model refused `reasoning: none` (its thinking cannot be turned off): then it is sent without, once.
      let reasoningRejected = false;
      // Set when the provider ended a call with NO text because the model tried to emit a malformed function call (Gemini does this when its
      // answer is JSON that looks like a call, e.g. a lookup request). The same request fails the same way, so each retry asks for a different
      // amount of reasoning instead: that is what made the answer come through when it was tried by hand.
      let malformedTries = 0;
      for (let attempt = 1; attempt <= maxRetriesPerModel; attempt++) {
        const startTime = Date.now();
        const retrySuffix = attempt > 1 ? ` (retry ${attempt}/${maxRetriesPerModel})` : "";

        // In JSON mode stdout carries only NDJSON, so the progress ticker must
        // never touch it — a stray dot would corrupt the stream for consumers.
        const jsonMode = events.isEnabled();
        const tick = (s: string) => {
          // With the pinned prompt on screen a line written every second scrolls instead of updating in place, which is the flood
          // of "Calling ..." lines; the status line already says what is running, and a call still logs when it ends and every 20s.
          if (!jsonMode && !hasPinnedInput()) writeRawAbove(s);
        };
        const clearLine = "\r\x1b[K";

        // A live, per-second countdown replaces the old accumulating dots,
        // which gave no sense of how long a call had actually been running or
        // how close it was to the timeout — a call quietly hung for two
        // minutes looked identical to one that had just started. Every 20s
        // this also logs a standalone line rather than just overwriting one,
        // so the wait leaves a real record in scrollback — and since it goes
        // through console.log, it reaches a paired phone too, same as any
        // other terminal output.
        const renderTick = () => {
          const secs = Math.floor((Date.now() - startTime) / 1000);
          tick(`${clearLine}[API] Calling ${model} (${agent})${retrySuffix} — ${secs}s elapsed `);
          if (secs > 0 && secs % 20 === 0) {
            console.log(`${clearLine}[API] Still waiting on ${model} (${agent})${retrySuffix} — ${secs}s elapsed`);
          }
        };
        renderTick();
        const ticker = setInterval(renderTick, 1000);
        // Counted for the terminal's one live status line ("calling REPAIR ×2 …"); ended wherever the ticker is stopped.
        const endCall = trackCall(agent, model);

        try {
          const bodyPayload: Record<string, any> = {
            model,
            messages,
            // Streamed rather than single-shot: a 120s budget covering the
            // WHOLE generation killed long-but-healthy completions mid-flight,
            // and gave no way to tell "still working" apart from "hung" while
            // it ran. Streaming moves the timeout to time-to-first-byte only
            // (cleared the moment the first chunk lands — see below), so a
            // slow model no longer gets its work thrown away at the deadline.
            stream: true,
            tools: options?.tools && options.tools.length > 0 ? options.tools : undefined,
            tool_choice: options?.toolChoice,
            temperature: options?.temperature,
            // Without this, OpenRouter's usage block carries only token counts —
            // the actual billed dollar amount (per-provider, accounting for
            // whatever routing/discount actually applied) is opt-in per request,
            // not returned by default. This is real spend from OpenRouter itself,
            // not a hardcoded per-model price table this codebase would otherwise
            // have to maintain and which would silently go stale as pricing changes.
            usage: { include: true },
          };

          if (options?.jsonSchema) {
            bodyPayload.response_format = {
              type: "json_object",
              schema: options.jsonSchema.schema,
            };
          } else if (options?.structured && /^google\//i.test(model)) {
            // Gemini held to a schema cannot emit a native function call in place of its JSON (see healSchema.ts). Other models get plain JSON mode:
            // not every model accepts json_schema, and none of them has this failure.
            bodyPayload.response_format = {
              type: "json_schema",
              json_schema: { name: options.structured.name, strict: false, schema: options.structured.schema },
            };
          } else if (options?.jsonMode || options?.structured) {
            bodyPayload.response_format = { type: "json_object" };
          }

          // Backend choice, price ceiling and reasoning (DeepSeek's own settings first, then the global sort): see requestTuning.ts.
          const tuned = tuneRequest(model, agent, this.config, { reasoningRejected, forceReasoning: options?.reasoning });
          if (tuned.provider) bodyPayload.provider = tuned.provider;
          if (tuned.reasoning) bodyPayload.reasoning = tuned.reasoning;
          else if (malformedTries > 0 && !reasoningRejected) bodyPayload.reasoning = { effort: malformedTries % 2 === 1 ? "low" : "medium" };

          // One dedicated controller for this attempt, rather than
          // AbortSignal.any([AbortSignal.timeout(...), runControl.signal]):
          // AbortSignal.timeout starts counting the moment it is CREATED and
          // AbortSignal.any fires immediately if ANY input is already aborted,
          // so a signal left aborted from earlier (or a Stop arriving during
          // the retry backoff) killed the request before the socket had any
          // chance to connect. Owning the controller also lets the timeout be
          // cancelled precisely when it should be — on the first streamed byte.
          const controller = new AbortController();
          const timeoutError = new Error(
            `Socket timeout after ${timeoutDurationMs / 1000}s waiting for the first response byte from ${model}.`
          );
          // The name must stay exactly "TimeoutError": classifyEditorError in
          // orchestrator.ts maps that name to the model_timeout failure kind,
          // and this file's own catch below branches on it to retry.
          timeoutError.name = "TimeoutError";
          const firstChunkTimer = setTimeout(() => controller.abort(timeoutError), timeoutDurationMs);

          // Unlike firstChunkTimer, this is never cleared on the first byte —
          // it runs for the attempt's whole duration, so a stream that keeps
          // trickling just enough data to dodge idleStreamTimeoutMs (a
          // degraded provider, not a genuinely slow one) still eventually
          // gets cut instead of running unbounded. Only set when the caller
          // opted in (see CompleteOptions.maxTotalDurationMs) — every other
          // caller keeps today's unbounded-while-streaming behavior.
          let totalDurationTimer: NodeJS.Timeout | undefined;
          if (maxTotalDurationMs) {
            const totalDurationError = new Error(
              `Exceeded max total duration of ${maxTotalDurationMs / 1000}s for ${model}.`
            );
            totalDurationError.name = "TimeoutError";
            (totalDurationError as any).budgetExceeded = true;
            totalDurationTimer = setTimeout(() => controller.abort(totalDurationError), maxTotalDurationMs);
          }

          // A user Stop cancels this request the instant it's requested, rather
          // than waiting out whatever's left of the socket timeout — safe to
          // cut off mid-completion since nothing is written to disk until a
          // tool call runs on the response. Forwarding runControl's own abort
          // reason (an AbortedError) keeps the throw below identifiable, and
          // the listener is always removed in the finally so a long-lived
          // process can't accumulate one per attempt.
          const onRunAbort = () =>
            controller.abort(runControl.signal.reason ?? new AbortedError(runControl.reason));
          if (runControl.signal.aborted) onRunAbort();
          else runControl.signal.addEventListener("abort", onRunAbort, { once: true });

          try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/yimpim/agent",
                "X-Title": "Local Code Agent",
              },
              body: JSON.stringify(bodyPayload),
              signal: controller.signal,
            });

            if (!response.ok) {
              clearInterval(ticker);
              endCall();
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              const errorBody = await response.text();
              console.log(`${clearLine}[API] ${model} (${agent})${retrySuffix} ❌ (${elapsed}s)`);

              if (response.status === 429) {
                const retryAfter = response.headers.get("retry-after");
                const waitMs = retryAfter
                  ? parseInt(retryAfter, 10) * 1000
                  : (Math.pow(2, attempt) * 2000 + Math.random() * 1000) * backoff;
                console.log(`\n[STATUS 429 Rate Limit] Pausing ${(waitMs / 1000).toFixed(1)}s...`);
                await this.delay(waitMs);
                continue;
              }

              if (response.status >= 500) {
                const waitMs = Math.pow(2, attempt) * 1500 * backoff;
                console.log(`\n[STATUS ${response.status} Provider Error] Pausing ${(waitMs / 1000).toFixed(1)}s...`);
                await this.delay(waitMs);
                continue;
              }

              // Insufficient credits (OpenRouter's documented shape:
              // {"error":{"code":402,"message":"...","metadata":{"error_type":
              // "payment_required"}}}) is the one failure here that's both
              // fatal to THIS call and trivially fixable by a human WHILE the
              // process keeps running — unlike a bad model slug or a broken
              // request, topping up the account is all it takes, and the very
              // next retry then just succeeds. Aborting the task over it would
              // throw away everything done so far and force a manual resume;
              // instead this notifies once (not re-spammed on every attempt —
              // see creditsWarningActive) and keeps patiently retrying the
              // SAME request, uncounted against the normal 3-attempt budget
              // (via the attempt-- below), so a user who sees the notification
              // and adds credits gets seamless continuation with zero lost
              // work. There is no cap on the wait: the user's own limit on
              // their OpenRouter key is the cost control, and a user Stop ends
              // the wait (creditsDelay). It checks every CREDITS_RECHECK_MS.
              if (response.status === 402) {
                if (!this.creditsWarningActive) {
                  this.creditsWarningActive = true;
                  let detail = "Your account or API key has insufficient credits.";
                  try {
                    const body = JSON.parse(errorBody);
                    if (typeof body?.error?.message === "string" && body.error.message.trim()) {
                      detail = body.error.message.trim();
                    }
                  } catch {}
                  events.emit({
                    type: "error",
                    message:
                      `OpenRouter: insufficient credits — ${detail} Add credits at ` +
                      `https://openrouter.ai/credits to continue — this will resume automatically, ` +
                      `no restart needed. (model: ${model})`,
                    fatal: false,
                  });
                }

                creditsSince ??= Date.now();
                const waitMs = this.creditsRecheckMs;
                const since = new Date(creditsSince).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                console.log(
                  `\n[CREDITS] Out of OpenRouter credits. Checking again in ${Math.round(waitMs / 60_000)} min ` +
                    `(waiting since ${since}). Add credits any time: no need to restart.`
                );
                await this.creditsDelay(waitMs);
                attempt--; // keep retrying this model without spending the shared 3-attempt budget
                continue;
              }

              // The model refused `reasoning: none` (its thinking cannot be turned off): say so once and send the call again without it,
              // rather than failing an agent over a cost setting. Not counted against the attempt budget or the model's health.
              if (bodyPayload.reasoning && !reasoningRejected && isReasoningRejected(response.status, errorBody)) {
                console.log(options?.reasoning ? `[${agent}] ${model} does not accept a thinking setting. Sending the call again without it.` : `[${agent}] ${model} will not turn its thinking off. Sending the call again with its default.`);
                reasoningRejected = true;
                attempt--;
                continue;
              }
              // No provider is under the price cap, so OpenRouter did not run the call: say why, and the next model in the chain is tried.
              const cap = (bodyPayload.provider as { max_price?: { prompt?: number; completion?: number } } | undefined)?.max_price;
              if (isPriceCapMiss(response.status, errorBody, !!cap)) {
                console.log(
                  `[${agent}] No provider for ${model} is under your price cap (${cap?.prompt ?? "no cap"} prompt / ${cap?.completion ?? "no cap"} completion, dollars per million tokens). ` +
                    `Raise deepseek.maxPromptPrice and deepseek.maxCompletionPrice, or set them to 0 for no cap.`
                );
              }

              throw new Error(`HTTP ${response.status}: ${errorBody}`);
            }

            // The ticker deliberately keeps running until the stream ends: the
            // response headers arrive in well under a second, so stopping it
            // here would leave a 30s generation looking frozen, and would print
            // the "✔ (0.4s)" line as if the call had already finished. The
            // elapsed time on that line must keep meaning "this whole call".
            const { message, usage, finish } = await this.readStreamedCompletion(
              response,
              controller,
              idleStreamTimeoutMs,
              () => clearTimeout(firstChunkTimer),
              endCall.progress
            );

            // No text and no tool call, and the provider says it ended in error: a malformed function call, not a model with nothing to say.
            // Retried with a different reasoning effort; on the last attempt the empty answer is returned as it always was.
            const noAnswer = message.content === null && !(message.tool_calls && message.tool_calls.length > 0);
            if (noAnswer && (finish?.reason === "error" || /MALFORMED/i.test(finish?.native ?? "")) && attempt < maxRetriesPerModel) {
              malformedTries++;
              console.log(`${clearLine}[DIAGNOSTIC] ${model} ended with no answer (${finish?.native ?? finish?.reason}); retrying with ${malformedTries % 2 === 1 ? "low" : "medium"} reasoning.`);
              throw new Error(`${model} returned no answer (${finish?.native ?? finish?.reason}).`);
            }

            clearInterval(ticker);
            // The provider's own count of what the model wrote replaces the running estimate in the step's total.
            endCall.done(usage?.completion);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`${clearLine}[API] ${model} (${agent})${retrySuffix} ✔ (${elapsed}s)`);

            // A call succeeding means credits are fine again (whether they
            // were topped up or this was never actually the blocker) — reset
            // so a LATER depletion gets its own fresh notification instead of
            // staying silent because of one from earlier in the run.
            this.creditsWarningActive = false;

            this.modelHealth.delete(model);
            events.recordUsage(agent, model, usage);
            events.emit({
              type: "model.call",
              agent,
              model,
              ok: true,
              elapsedMs: Date.now() - startTime,
              usage,
            });

            return message;
          } finally {
            clearTimeout(firstChunkTimer);
            clearTimeout(totalDurationTimer);
            runControl.signal.removeEventListener("abort", onRunAbort);
          }
        } catch (err: any) {
          clearInterval(ticker);
          endCall();
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`${clearLine}[API] ${model} (${agent})${retrySuffix} ❌ (${elapsed}s)`);

          // A user Stop, not a network hiccup — propagate immediately rather
          // than retrying or falling through to the next model.
          if (runControl.isAborted) throw new AbortedError(runControl.reason);

          // A budget-exceeded timeout is already a diagnosis, not a guess:
          // the provider kept the connection alive and trickled SOME data,
          // just never enough to finish within a budget sized for this
          // call's genuinely small, bounded output (see
          // CompleteOptions.maxTotalDurationMs) — "a degraded provider, not
          // a genuinely slow one." Retrying the SAME model fights that
          // diagnosis, so this skips the remaining same-model retries and
          // falls straight through to the next model in the chain, if any —
          // unlike every OTHER timeout flavor (a cold connection, real
          // stream silence) or a 429/5xx, which genuinely can be transient
          // and still get the normal same-model retry below.
          cannotReadImages = isImageUnsupportedError(err);
          const skipRemainingRetries = (err.name === "TimeoutError" && Boolean(err.budgetExceeded)) || cannotReadImages;

          if (err.name === "TimeoutError") {
            console.log(
              err.budgetExceeded
                ? `\n[DIAGNOSTIC] ${model} exceeded its ${maxTotalDurationMs! / 1000}s total-duration budget — ` +
                  `still trickling data but not finishing (a degraded provider, not a genuinely slow one).`
                : err.stalled
                  ? `\n[DIAGNOSTIC] Stream stalled after ${idleStreamTimeoutMs / 1000}s of silence on ${model}.`
                  : `\n[DIAGNOSTIC] Socket timeout after ${timeoutDurationMs / 1000}s on ${model}.`
            );
            if (skipRemainingRetries) {
              console.log(`[DIAGNOSTIC] Not retrying the same model — moving to the next one in the chain, if any.`);
            } else if (attempt < maxRetriesPerModel) {
              console.log(`[DIAGNOSTIC] Retrying in ${+(3 * backoff).toFixed(1)}s...`);
              await this.delay(3000 * backoff);
              continue;
            }
          } else if (err.code === "ENOTFOUND" || err.code === "ECONNRESET") {
            console.log(`\n[DIAGNOSTIC] Network disconnect (${err.code}). Retrying in ${+(4 * backoff).toFixed(1)}s...`);
            await this.delay(4000 * backoff);
            continue;
          } else {
            console.log(`\n[DIAGNOSTIC] Request error: ${err.message}`);
          }

          events.emit({
            type: "model.call",
            agent: options?.agent ?? "unknown",
            model,
            ok: false,
            elapsedMs: Date.now() - startTime,
            error: err?.message ?? String(err),
          });

          lastError = err;
          if (skipRemainingRetries || attempt === maxRetriesPerModel) {
            break;
          }
        }
      }

      // Reaching here means this model used up every attempt without returning
      // (credits waiting and a user Stop both exit differently). Remember it so
      // the NEXT call does not start by waiting on it again.
      if (!cannotReadImages) {
        const failures = (this.modelHealth.get(model)?.failures ?? 0) + 1;
        this.modelHealth.set(model, { failures, cooldownUntil: Date.now() + cooldownFor(failures) });
      }

      if (modelList.indexOf(model) < modelList.length - 1) {
        console.log(`[${fallbackTag(options?.agent)}] Switching from ${model}...`);
      }
    }

    // Every model in the chain refused the image: send the same request with the images replaced by a note, rather than failing a
    // task over a screenshot a text-only model was never going to read.
    if (lastError && isImageUnsupportedError(lastError)) {
      const text = withoutImages(messages);
      if (text) {
        console.log(`[API] None of ${modelList.join(", ")} can read images — sending this request without them.`);
        return this.complete(models, text, options);
      }
    }

    throw lastError || new Error("Failed all configured model attempts.");
  }
}

/** OpenRouter's answer when a model has no endpoint that accepts image input. It will not change on a retry. */
export function isImageUnsupportedError(err: unknown): boolean {
  return /No endpoints found that support image input/i.test(String((err as any)?.message ?? err ?? ""));
}

/** The same messages with every image part replaced by a short note. Undefined when there were no images to remove. */
export function withoutImages(messages: ChatMessage[]): ChatMessage[] | undefined {
  let removed = false;
  const out = messages.map((m: any) => {
    if (!Array.isArray(m?.content)) return m;
    const content = m.content.map((part: any) => {
      if (part && (part.type === "image_url" || part.type === "image" || part.type === "input_image")) {
        removed = true;
        return { type: "text", text: "[An image was attached here, but the model reading this cannot see images.]" };
      }
      return part;
    });
    return { ...m, content };
  });
  return removed ? (out as ChatMessage[]) : undefined;
}
