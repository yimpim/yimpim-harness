/**
 * Run control: cooperative abort and cross-surface questions.
 *
 * Abort is cooperative rather than a process kill, because killing mid-write
 * can leave a half-written source file. Instead the flag is checked at every
 * safe boundary — between tool rounds and between phases — so the run stops
 * with the working tree in a coherent state and the normal scoped-revert path
 * still runs.
 *
 * Questions are answered by whoever responds first, terminal or phone.
 */

import { PendingQuestion } from "./protocol.js";
import { startPrompt } from "../terminalPrompt.js";
import { withPlainWords, type PlainExplanation } from "../plainWords.js";

export class AbortedError extends Error {
  constructor(public reason: string) {
    super(`Run aborted: ${reason}`);
    this.name = "AbortedError";
  }
}

interface Waiter {
  question: PendingQuestion;
  resolve: (answer: string) => void;
  settled: boolean;
}

class RunControl {
  private aborted = false;
  private abortReason = "";
  private waiters = new Map<string, Waiter>();
  private listeners: ((q: PendingQuestion) => void)[] = [];
  private resolvedListeners: ((id: string) => void)[] = [];
  // A phone message with nowhere to land right now (nothing is pending) — see
  // provideForNextQuestion. Carries when it was queued so ask() can tell a
  // genuine "typed a task while the desktop was still finishing up" race
  // (a sub-second gap) apart from a stray answer meant for a SPECIFIC
  // question that has long since resolved some other way — see
  // QUEUED_ANSWER_TTL_MS below for why that distinction matters.
  private queuedAnswer: { text: string; queuedAt: number } | undefined;
  // Backs `signal` below. A fresh controller each time reset() runs, since a
  // fired AbortController can never be un-aborted.
  private controller = new AbortController();

  // ------------------------------------------------------------- abort

  requestAbort(reason = "requested"): void {
    if (this.aborted) return;
    this.aborted = true;
    this.abortReason = reason;
    // No console output here — the run doesn't actually stop until the next
    // safe boundary (a tool round, a phase edge), which can be a moment
    // later. Printing here as well as once the stop is confirmed used to
    // produce two (or three, across the keyboard/phone/Esc call sites) lines
    // for one event. The single, real "stopped" line is printed once, where
    // the AbortedError is actually caught — see index.ts's per-task catch.

    // Cancels any in-flight model call waiting on `signal` below. Safe to cut
    // off immediately, unlike a tool round: nothing has been written to disk
    // from a completion that hasn't returned yet, so there's no half-written
    // file to worry about here the way there is between tool rounds.
    this.controller.abort(new AbortedError(reason));

    // Unblock anything waiting on a question so the run can unwind promptly.
    for (const w of this.waiters.values()) {
      if (!w.settled) {
        w.settled = true;
        w.resolve(w.question.fallback);
      }
    }
    this.waiters.clear();
    this.queuedAnswer = undefined;
  }

  /** An AbortSignal that fires the instant requestAbort() runs — pass it into
   *  any in-flight fetch so a stop doesn't have to wait out a slow/hung call. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  get reason(): string {
    return this.abortReason;
  }

  /** Call at safe boundaries. Throws if an abort is pending. */
  throwIfAborted(): void {
    if (this.aborted) throw new AbortedError(this.abortReason);
  }

  /**
   * Clear abort state so a fresh question can genuinely wait for an answer
   * again. Used in tests to isolate cases, and in the main input loop when a
   * stop arrives with no phase actually running yet — that abort still needs
   * to be reset, or every subsequent question in the process would resolve
   * instantly with its fallback forever (see RunControl.ask's early return).
   */
  reset(): void {
    this.aborted = false;
    this.abortReason = "";
    this.waiters.clear();
    this.queuedAnswer = undefined;
    this.controller = new AbortController();
  }

  // ---------------------------------------------------------- questions

  onQuestion(fn: (q: PendingQuestion) => void): void {
    this.listeners.push(fn);
  }

  /** Undo a prior onQuestion — needed when a remote session is torn down and
   *  re-paired, so the old session's closure doesn't keep firing forever. */
  offQuestion(fn: (q: PendingQuestion) => void): void {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }

  onQuestionResolved(fn: (id: string) => void): void {
    this.resolvedListeners.push(fn);
  }

  offQuestionResolved(fn: (id: string) => void): void {
    this.resolvedListeners = this.resolvedListeners.filter((f) => f !== fn);
  }

  /** True when a remote surface (a phone) is listening for questions. */
  hasListeners(): boolean {
    return this.listeners.length > 0;
  }

  pending(): PendingQuestion[] {
    return [...this.waiters.values()].map((w) => w.question);
  }

  /**
   * How long a queued answer stays eligible to auto-answer "whatever's asked
   * next". The legitimate case this exists for — typing a task on the phone
   * right as the desktop finishes up and loops back to the idle prompt — only
   * ever needs to bridge a sub-second gap between the message arriving and
   * the idle prompt's own waiter being registered. Anything still queued
   * after several seconds is far more likely a stray answer that was meant
   * for a SPECIFIC question (e.g. a phone tapping a choice on a question
   * whose desktop-side prompt had already resolved some other way) that
   * silently missed its target and sat parked — applying THAT to an unrelated
   * later question (worst case: the idle prompt, minutes after a task
   * started) produces exactly the "garbage answer to the wrong question"
   * failure this guards against, rather than the "phone starts a new task"
   * behavior it's actually for.
   */
  private static readonly QUEUED_ANSWER_TTL_MS = 10_000;

  /**
   * Register a question and return a promise for its answer. The caller races
   * this against local stdin; whichever arrives first wins.
   */
  ask(question: PendingQuestion): Promise<string> {
    if (this.aborted) return Promise.resolve(question.fallback);

    // A phone message arrived while nothing was listening (mid-task) — the
    // moment ANY question is next asked, including the idle "what should I
    // do" prompt, use it immediately instead of making the phone answer a
    // second time or making the desktop sit waiting on input it already has.
    // Stale beyond QUEUED_ANSWER_TTL_MS, it's discarded instead — see that
    // constant's own comment for why.
    if (this.queuedAnswer !== undefined) {
      const { text, queuedAt } = this.queuedAnswer;
      this.queuedAnswer = undefined;
      if (Date.now() - queuedAt <= RunControl.QUEUED_ANSWER_TTL_MS) {
        return Promise.resolve(text);
      }
      console.warn(
        `[REMOTE] ⚠️ Discarded a stray message ("${text.slice(0, 80)}") queued ${Math.round(
          (Date.now() - queuedAt) / 1000
        )}s ago with no question to answer — too stale to safely apply to this one.`
      );
    }

    return new Promise<string>((resolve) => {
      this.waiters.set(question.id, { question, resolve, settled: false });
      for (const fn of this.listeners) {
        try {
          fn(question);
        } catch {}
      }
    });
  }

  /**
   * A phone message with no questionId to attach to — from a free-form
   * compose, not answering anything specific. If a question is already
   * outstanding, answers the oldest one immediately (the common case: the
   * agent's idle "what should I do" prompt, or any other blocking question).
   * Otherwise queues it for whatever is asked next. Returns true if it was
   * used right away, false if queued.
   */
  provideForNextQuestion(text: string): boolean {
    const oldest = [...this.waiters.keys()][0];
    if (oldest) return this.answer(oldest, text);
    this.queuedAnswer = { text, queuedAt: Date.now() };
    return false;
  }

  /** Answer from any surface. First responder wins; later ones are ignored. */
  answer(id: string, answer: string): boolean {
    const w = this.waiters.get(id);
    if (!w || w.settled) return false;
    w.settled = true;
    this.waiters.delete(id);
    w.resolve(answer);
    for (const fn of this.resolvedListeners) {
      try {
        fn(id);
      } catch {}
    }
    return true;
  }

  /** Resolve every outstanding question with its fallback. */
  settleAllWithFallback(): void {
    for (const [id, w] of this.waiters) {
      if (!w.settled) {
        w.settled = true;
        w.resolve(w.question.fallback);
      }
      for (const fn of this.resolvedListeners) {
        try {
          fn(id);
        } catch {}
      }
    }
    this.waiters.clear();
  }
}

export const runControl = new RunControl();

/**
 * Adds the plain-words explanation under a question (see plainWords.ts). Set once at startup; unset (tests, no model) means
 * questions are asked exactly as they were written.
 */
let explainQuestion: ((q: PendingQuestion) => Promise<PlainExplanation | null>) | null = null;
export function setQuestionExplainer(fn: ((q: PendingQuestion) => Promise<PlainExplanation | null>) | null): void {
  explainQuestion = fn;
}

/**
 * Ask on the terminal and remotely at the same time; first answer wins.
 * Falls back cleanly when stdin is not a TTY, so piped/CI runs never hang.
 */
export async function askAnywhere(
  question: PendingQuestion,
  promptText: string
): Promise<string> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // Someone has to be there to read it: a terminal, or a phone that is connected.
  const back = new Map<string, string>();
  if (explainQuestion && (interactive || runControl.hasListeners())) {
    try {
      const found = await explainQuestion(question);
      if (found) {
        const original = question.prompt;
        question = { ...question, prompt: withPlainWords(original, found.plain) };
        promptText = promptText.includes(original) ? promptText.split(original).join(question.prompt) : `${question.prompt}
${promptText}`;
        // Each option gets its plain gloss too; whatever is chosen is turned back into the original option below.
        const choices = question.choices ?? [];
        if (found.options && found.options.length === choices.length) {
          const shown = choices.map((c, i) => `${c} (${found.options![i]})`);
          choices.forEach((c, i) => {
            back.set(shown[i].toLowerCase(), c);
            promptText = promptText.replace(`  ${i + 1}) ${c}`, `  ${i + 1}) ${shown[i]}`);
          });
          question = { ...question, choices: shown };
        }
      }
    } catch {
      // asked as written
    }
  }
  const raw = await askRaw(question, promptText, interactive);
  const answer = back.get(raw.answer.trim().toLowerCase()) ?? raw.answer;
  // A question left on screen with nothing under it reads as still waiting, hours later, in the scrollback. Say what was answered and where
  // it came from. A stop is not an answer, so nothing is claimed then.
  if (!runControl.isAborted) console.log(answeredLine(question.prompt, answer, raw.by));
  return answer;
}

/** One line that closes a question in the log: what was answered, and from where. */
export function answeredLine(prompt: string, answer: string, by: "terminal" | "phone"): string {
  const lines = prompt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // "X wants to run a command:" says nothing without the line after it.
  const what = (lines[0]?.endsWith(":") && lines[1] ? lines[0] + " " + lines[1] : lines[0] ?? "").replace(/\s+/g, " ").slice(0, 110);
  const said = answer.trim().replace(/\s+/g, " ");
  const mark = /^(yes|y)$/i.test(said) ? "✔ " : /^(no|n)$/i.test(said) ? "✖ " : "";
  return `   ↳ ${mark}Answered "${said.slice(0, 100)}${said.length > 100 ? "…" : ""}" ${by === "phone" ? "from the phone" : "here"}: ${what}`;
}

async function askRaw(question: PendingQuestion, promptText: string, interactive: boolean): Promise<{ answer: string; by: "terminal" | "phone" }> {
  const remote = runControl.ask(question);
  if (!interactive) {
    // No terminal to ask: wait only on the remote surface, and if nothing is
    // connected the caller's timeout/fallback applies.
    const answer = await remote;
    runControl.answer(question.id, answer);
    return { answer, by: "phone" };
  }

  // startPrompt (not a raw rl.question): folds a pasted multi-line answer
  // into one response instead of splitting it on every embedded newline and
  // leaking the tail into whatever prompt reads stdin next.
  const prompt = startPrompt(promptText);
  let by: "terminal" | "phone" | undefined;
  const local = prompt.answer
    .then((a) => {
      by ??= "terminal";
      // Feed the terminal answer through the same path so remote surfaces see
      // the question disappear.
      runControl.answer(question.id, a.trim());
      return a.trim();
    })
    .catch(() => question.fallback);

  try {
    const answer = await Promise.race([local, remote.then((a) => ((by ??= "phone"), a))]);
    return { answer, by: by ?? "terminal" };
  } finally {
    prompt.cancel();
  }
}

/**
 * The numbered pick-list text for a `choices`-bearing question, CLI-side —
 * today, `choices` only ever reached the terminal as hint text inside a
 * hand-written prompt string, typed back verbatim; a real phone already
 * renders `choices` as tappable buttons (see RemoteSession.askQuestion/
 * PendingQuestion), so this brings the desktop terminal to parity with it.
 * Pulled out of askChoice as its own pure function so the exact rendering
 * is directly testable without a real TTY.
 */
export function buildChoicePromptText(prompt: string, choices: string[], allowCustom: boolean | undefined): string {
  return [
    prompt,
    ...choices.map((c, i) => `  ${i + 1}) ${c}`),
    ...(allowCustom ? [`  ${choices.length + 1}) something else — type your own`] : []),
    "  > ",
  ].join("\n");
}

/**
 * Maps a raw typed/tapped answer back onto the canonical choice text,
 * however it arrived: a typed number, the choice text itself (any casing),
 * or — only when `allowCustom` is set — genuine free text for "something
 * else". Pulled out of askChoice as its own pure function, independent of
 * askAnywhere's real TTY/remote plumbing, so the mapping itself has direct
 * test coverage.
 */
export function resolveChoiceAnswer(
  raw: string,
  choices: string[],
  allowCustom: boolean | undefined,
  fallback: string
): string {
  const trimmed = raw.trim();

  const asIndex = Number(trimmed);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= choices.length) {
    return choices[asIndex - 1];
  }
  const exact = choices.find((c) => c.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact;

  // A bare "other"/empty answer with nothing further typed, or the
  // just-printed "something else" option number itself with no follow-up —
  // both read as "no real answer given" rather than a genuine custom one.
  if (allowCustom && trimmed && trimmed !== String(choices.length + 1)) {
    return trimmed;
  }
  return fallback;
}

/**
 * Same cross-surface race as askAnywhere, but for a `choices`-bearing
 * question — see buildChoicePromptText/resolveChoiceAnswer above for the
 * two pieces this just wires together around the real ask.
 *
 * `question.choices` must be non-empty; this is specifically the
 * choice-rendering path, askAnywhere itself remains the plain free-text one.
 */
export async function askChoice(question: PendingQuestion): Promise<string> {
  const choices = question.choices ?? [];
  const promptText = buildChoicePromptText(question.prompt, choices, question.allowCustom);
  const answer = await askAnywhere(question, promptText);
  return resolveChoiceAnswer(answer, choices, question.allowCustom, question.fallback);
}

// Esc-to-abort and Ctrl-C re-emit used to live here as installEscToAbort(),
// installed/torn down once per task-loop iteration with its own independent
// raw-mode ownership. Retired in favor of terminalInput.ts's persistent
// input line, which absorbs the exact same keypress handling (Esc still
// calls requestAbort below, Ctrl-C is still re-emitted as a real SIGINT) as
// part of ONE readline.Interface kept alive for the whole session, instead
// of raw mode being independently grabbed/released by several unrelated
// call sites. See terminalInput.ts's installPersistentInput().
