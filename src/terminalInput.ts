/**
 * Persistent, bottom-pinned terminal input.
 *
 * Collapses what used to be several independent raw-mode/keypress owners
 * (installEscToAbort's own listener, a fresh readline.Interface created by
 * every startPrompt() call, ...) into ONE readline.Interface, alive for the
 * whole interactive session — installed once, right where installEscToAbort
 * used to be installed. The point: the prompt line used to exist only
 * between tasks (nothing was listening on stdin once Discovery/a phase
 * started running, other than a bare Esc-keypress listener); now it stays
 * visible and typeable at every moment, so `/stop` is reachable the same way
 * the phone's Stop button always is — not just Esc, which depends on raw
 * keypress detection actually working in a given terminal.
 *
 * Every other module that used to print via plain console.log/process.stdout
 * keeps doing exactly that — this module's job is only to make sure that
 * output never corrupts whatever the user has half-typed on the pinned
 * line, by clearing the line, letting the real write happen (genuine
 * terminal scrollback, not a fake viewport), then redrawing the prompt +
 * in-progress buffer on top.
 */

import readline from "node:readline";
import process from "node:process";
import { runControl } from "./remote/control.js";
import { stripAnsi } from "./richText.js";
import { Writable } from "node:stream";
import { PasteCollector } from "./pasteCollector.js";
import { readClipboardText } from "./clipboard.js";
import { DESKTOP_SLASH_COMMANDS, SlashCommand } from "./slashCommands.js";

export interface CancellablePrompt {
  /** Resolves with the full answer, or rejects if cancel() ran first. */
  answer: Promise<string>;
  /** Closes the prompt without a normal answer — e.g. a racing answer surface
   *  won first. Safe to call after `answer` has already settled (no-op). */
  cancel: () => void;
}

const IDLE_PROMPT = "(type /stop to interrupt) › ";
// Same paste-debounce window the old per-call startPrompt used: a fast
// multi-line paste delivers every line in one burst, well under this gap; a
// person typing takes far longer between pressing Enter and starting their
// next line. See claim()'s own comment for the full reasoning.
const SETTLE_MS = 60;

interface ActiveClaim {
  lines: string[];
  settleTimer?: NodeJS.Timeout;
  settled: boolean;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
}

let rl: readline.Interface | undefined;
let installed = false; // true once installPersistentInput ran and stayed on a real TTY
let activeClaim: ActiveClaim | undefined;
let lastPromptRows = 1;
let lastSuggestionRows = 0;
let lastStatusRows = 0;
let currentSuggestions: SlashCommand[] = [];
let statusLine: string | undefined;
// Bracketed paste: a paste is one answer, never several submitted lines.
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
const paste = new PasteCollector();
let exitHookSet = false;
const liveCommands = new Map<string, () => void | Promise<void>>();

/** Commands that run the moment they are typed, even mid-run or at a question. Returns a function that removes them. */
export function registerLiveCommands(commands: string[], run: () => void | Promise<void>): () => void {
  for (const c of commands) liveCommands.set(c.toLowerCase(), run);
  return () => {
    for (const c of commands) if (liveCommands.get(c.toLowerCase()) === run) liveCommands.delete(c.toLowerCase());
  };
}

/**
 * readline's own output, with its echo dropped while a paste is arriving: a
 * pasted block would otherwise be typed out on screen line by line before the
 * placeholder replaces it. Everything else this module draws goes straight to
 * process.stdout, so only readline's per-keystroke echo is gated.
 */
function gatedOutput(): NodeJS.WritableStream {
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!paste.pasting) process.stdout.write(chunk);
      cb();
    },
  }) as Writable & { isTTY: boolean; columns: number; rows: number };
  out.isTTY = true;
  Object.defineProperty(out, "columns", { get: () => process.stdout.columns, enumerable: true });
  Object.defineProperty(out, "rows", { get: () => process.stdout.rows, enumerable: true });
  process.stdout.on("resize", () => out.emit("resize"));
  return out;
}

/** Ctrl+V when the terminal hands it to us as a keystroke instead of pasting. */
async function pasteFromClipboard(): Promise<void> {
  const raw = await readClipboardText();
  const text = raw?.split("\r\n").join("\n").split("\r").join("\n");
  if (!text || !rl) return;
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length < 2) {
    (rl as any).write(lines[0] ?? "");
    return;
  }
  const prefix = rl.line;
  paste.start();
  for (const l of lines.slice(0, -1)) paste.line(l);
  const token = paste.end(lines[lines.length - 1]);
  if (token === undefined) return;
  (rl as any).line = prefix + token;
  (rl as any).cursor = (rl as any).line.length;
  refreshInputArea();
}

let onKeypress: ((str: string, key?: { name?: string; ctrl?: boolean }) => void) | undefined;

// Claude Code's own CLI shows this many candidates at once — matched here so
// the panel reads the same way, and stays well clear of a tiny terminal
// window's height.
const MAX_SUGGESTIONS = 6;

function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

function currentPromptRows(): number {
  if (!rl) return 1;
  const cols = process.stdout.columns || 80;
  const width = visibleWidth(rl.getPrompt() + rl.line);
  return Math.max(1, Math.ceil((width || 1) / cols));
}

function setPrompt(label: string): void {
  rl?.setPrompt(label);
}

/**
 * Matching commands for whatever's currently typed — empty whenever the line
 * isn't (or is no longer meaningfully) a slash command in progress. Once the
 * line is already an exact, unambiguous command, the panel has nothing left
 * to add over what the user already typed, so it disappears rather than
 * lingering.
 */
export function computeSuggestions(line: string): SlashCommand[] {
  if (!line.startsWith("/") || line.length <= 1) return [];
  const hits = DESKTOP_SLASH_COMMANDS.filter((c) => c.cmd.startsWith(line));
  if (hits.length === 1 && hits[0].cmd === line) return [];
  return hits.slice(0, MAX_SUGGESTIONS);
}

function suggestionsEqual(a: SlashCommand[], b: SlashCommand[]): boolean {
  return a.length === b.length && a.every((s, i) => s.cmd === b[i].cmd);
}

/** One row of the panel: bolded command, padded, then its description —
 *  truncated by VISIBLE width (ANSI-stripped) so a long description can
 *  never wrap and desync the reserved-row bookkeeping below. */
function renderSuggestionLine(entry: SlashCommand, colWidth: number): string {
  const cols = process.stdout.columns || 80;
  const pad = " ".repeat(Math.max(1, colWidth - entry.cmd.length));
  const plainPrefix = `  ${entry.cmd}${pad}`;
  const line = `  \x1b[1m${entry.cmd}\x1b[0m${pad}${entry.desc}`;
  if (visibleWidth(line) <= cols) return line;
  const budget = cols - visibleWidth(plainPrefix) - 1;
  return budget > 0 ? `  \x1b[1m${entry.cmd}\x1b[0m${pad}${entry.desc.slice(0, budget)}…` : `  \x1b[1m${entry.cmd}\x1b[0m`;
}

/** A dim, full-width rule separating scrolled-past output from the pinned
 *  input area below it — always exactly one row regardless of terminal
 *  width, so it never needs its own row-count bookkeeping beyond the fixed
 *  DIVIDER_ROWS constant. */
function dividerLine(): string {
  const cols = process.stdout.columns || 80;
  return `\x1b[2m${"─".repeat(cols)}\x1b[0m`;
}

const DIVIDER_ROWS = 1;

function totalReservedRows(): number {
  return lastStatusRows + DIVIDER_ROWS + lastSuggestionRows + lastPromptRows;
}

function clearInputArea(): void {
  if (!rl) return;
  readline.cursorTo(process.stdout, 0);
  readline.moveCursor(process.stdout, 0, -(totalReservedRows() - 1));
  readline.clearScreenDown(process.stdout);
}

/**
 * Sets (or clears, with `undefined`) the live status line shown above the
 * divider — "what's running right now", so a user doesn't have to scroll
 * back to see where a task currently stands. Deliberately just ONE MORE row
 * in the same bottom-pinned reserved region every other part of this module
 * already uses, not a true top-of-terminal-fixed header: that would need
 * ANSI scroll-region manipulation (DECSTBM), a meaningfully riskier and
 * less portable technique than the cursor-relative redraw this whole module
 * is built on — see this file's own top-of-file rationale for why that
 * approach was chosen over an alternate-screen/scroll-region UI in the
 * first place. Sits right above the divider, so the visual order reads
 * top-to-bottom as: status → divider → suggestions (if any) → prompt.
 */
export function setStatusLine(text: string | undefined): void {
  if (text === statusLine) return;
  statusLine = text;
  if (!rl) return;
  clearInputArea();
  redrawInputArea();
}

function renderStatusLine(text: string): string {
  const cols = process.stdout.columns || 80;
  const line = `\x1b[2m▸\x1b[0m ${text}`;
  return visibleWidth(line) <= cols ? line : `\x1b[2m▸\x1b[0m ${text.slice(0, cols - 3)}…`;
}

/** Writes the status line (if set), the divider, whatever's in
 *  `currentSuggestions` (possibly nothing), then the prompt/line beneath it,
 *  and records how many rows the variable parts took so the next clear
 *  knows exactly how far to erase. Does NOT recompute suggestions — callers
 *  that changed `rl.line` do that themselves first (see
 *  updateSuggestionsIfNeeded/refreshInputArea below). */
function redrawInputArea(): void {
  if (!rl) return;
  // Whatever was written immediately before this call may have left the
  // cursor mid-row with trailing, non-newline-terminated text — the
  // elapsed-time API ticker (writeRawAbove in openrouter.ts) in particular,
  // which deliberately omits its own trailing newline so a SUBSEQUENT
  // identical tick can overwrite it in place. Without resetting to a clean
  // row first, the status line below gets appended onto that leftover text
  // instead of starting fresh, and the real "\n" it ends with then
  // permanently commits that merged line to scrollback — exactly why the
  // per-second ticker used to spam a brand new scrollback line every single
  // second instead of ever overwriting the same line.
  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  if (statusLine) {
    process.stdout.write(renderStatusLine(statusLine) + "\n");
    lastStatusRows = 1;
  } else {
    lastStatusRows = 0;
  }
  process.stdout.write(dividerLine() + "\n");
  const colWidth = currentSuggestions.reduce((w, c) => Math.max(w, c.cmd.length), 0) + 3;
  for (const entry of currentSuggestions) {
    process.stdout.write(renderSuggestionLine(entry, colWidth) + "\n");
  }
  lastSuggestionRows = currentSuggestions.length;
  rl.prompt(true); // preserveCursor: true — re-renders label+line, cursor from rl.cursor
  lastPromptRows = currentPromptRows();
}

/** Full refresh: recompute suggestions from the CURRENT line and redraw
 *  unconditionally. Used wherever the prompt's own content just changed for
 *  a reason other than a plain keystroke (a line was submitted, a new
 *  question was claimed, a claim settled) — those all need the prompt shown
 *  again regardless of whether the suggestion list happens to be unchanged. */
function refreshInputArea(): void {
  if (!rl) return;
  clearInputArea();
  currentSuggestions = computeSuggestions(rl.line);
  redrawInputArea();
}

/** Per-keystroke path: only pays for a clear+redraw when the suggestion set
 *  actually changed, so ordinary typing (no slash command in progress) never
 *  does extra work beyond readline's own already-fast in-place line update. */
function updateSuggestionsIfNeeded(): void {
  if (!rl) return;
  const next = computeSuggestions(rl.line);
  if (suggestionsEqual(next, currentSuggestions)) {
    // The line's own row count can still have changed (e.g. it just wrapped
    // to a second row) even when the suggestion set didn't — keep this
    // bookkeeping current so a LATER clear (a console.log, Esc, /stop) still
    // erases the right number of rows.
    lastPromptRows = currentPromptRows();
    return;
  }
  clearInputArea();
  currentSuggestions = next;
  redrawInputArea();
}

/**
 * Prints via `write` "above" the pinned prompt (and its suggestion panel,
 * when one is showing) without corrupting whatever the user has half-typed.
 * No-op passthrough (just calls `write()`) when the persistent input isn't
 * installed, so every caller — the console.log patch included — works
 * unchanged in a non-TTY/piped session.
 */
export function printAbove(write: () => void): void {
  if (!rl) {
    write();
    return;
  }
  clearInputArea();
  write();
  redrawInputArea();
}

/** Same idea for a raw write that bypasses console entirely — the elapsed-
 *  time ticker in openrouter.ts, currently a bare process.stdout.write. */
export function writeRawAbove(s: string): void {
  printAbove(() => process.stdout.write(s));
}

/**
 * Settles a claim's answer promise. Also redraws whenever it actually flips
 * the pinned prompt back to the idle label — critical for the paste-debounce
 * path below, where this runs asynchronously, well after handleLine (and
 * whatever redraw IT did) already returned; without this, the screen would
 * keep showing the just-answered question's label until some unrelated
 * later keystroke happened to trigger a redraw.
 */
function settle(claim: ActiveClaim, answer: string): void {
  if (claim.settled) return;
  claim.settled = true;
  if (claim.settleTimer) clearTimeout(claim.settleTimer);
  if (activeClaim === claim) {
    activeClaim = undefined;
    setPrompt(IDLE_PROMPT);
    refreshInputArea();
  }
  claim.resolve(answer);
}

/** What stays in the scrollback after Enter: the pinned line is cleared on submit, so without this what you typed vanishes. */
export function echoedInput(text: string): string {
  const MAX = 600;
  const one = text.length > MAX ? `${text.slice(0, MAX)}… (+${text.length - MAX} more characters)` : text;
  return `\n\x1b[2m›\x1b[0m ${one}\n`;
}

function handleLine(rawLine: string): void {
  // Mid-paste, every embedded newline arrives as its own `line`: hold them
  // until the end marker instead of submitting each one.
  if (paste.pasting) {
    paste.line(rawLine);
    return;
  }
  const raw = paste.expand(rawLine);
  const trimmed = raw.trim();
  if (trimmed) writeRawAbove(echoedInput(trimmed));

  // /stop always wins, regardless of what currently owns the line — same
  // priority a phone's Stop button or Esc already has over anything else.
  if (/^\/stop$/i.test(trimmed)) {
    runControl.requestAbort("keyboard (/stop)");
    // settle() already redraws when it flips the prompt back to idle; only
    // need to do it here ourselves when nothing was actually claimed.
    if (activeClaim) settle(activeClaim, "");
    else refreshInputArea();
    return;
  }

  // A command that must work while a run is in flight (pairing a phone). Handled on the spot instead of being queued as
  // the answer to the next question; the run keeps going and the output scrolls above the pinned line as usual.
  const live = liveCommands.get(trimmed.toLowerCase());
  if (live) {
    if (activeClaim) activeClaim.lines.length = 0;
    refreshInputArea();
    void Promise.resolve()
      .then(live)
      .catch((err) => console.error(`[CONTROL] ${trimmed} failed: ${err?.message ?? err}`));
    return;
  }

  if (activeClaim) {
    const claim = activeClaim;
    claim.lines.push(raw);
    if (claim.settleTimer) clearTimeout(claim.settleTimer);
    claim.settleTimer = setTimeout(() => settle(claim, claim.lines.join("\n")), SETTLE_MS);
    // Immediate feedback for a fast multi-line paste's intermediate lines —
    // the label hasn't changed yet (still mid-paste), but the now-cleared
    // line buffer has. settle() (above) handles the label's own eventual
    // change back to idle once the whole paste actually finishes.
    refreshInputArea();
    return;
  }

  // Nothing is currently asking anything (a worker is mid-run) — queue it
  // exactly like a phone message that arrives with nothing pending: used the
  // instant anything is next asked, including the idle "what should I do"
  // prompt. Not a new mechanism — this is RunControl's own existing path.
  if (trimmed) runControl.provideForNextQuestion(trimmed);
  refreshInputArea();
}

/**
 * Tab-completion for slash commands — the standard readline `completer`
 * mechanism every Node CLI that supports this uses, not a custom renderer:
 * readline itself decides what to do with what this returns (auto-fill the
 * line on a single match, print a candidate list on several, do nothing on
 * none), so there's no bespoke redraw/cursor logic here to get wrong. Fires
 * only on an explicit Tab keypress — never on plain typing — and only ever
 * matches against the fixed, hardcoded DESKTOP_SLASH_COMMANDS list, so it
 * can't be steered into completing to anything unexpected.
 */
export function slashCompleter(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const hits = DESKTOP_SLASH_COMMANDS.map((c) => c.cmd).filter((cmd) => cmd.startsWith(line));
  // A single, unambiguous match auto-fills the line (readline's own
  // behavior for a one-element result) — trailing space lets the user keep
  // typing an argument (e.g. "/branch ") without an extra keystroke, and is
  // harmless for an argument-less command since every dispatch site already
  // trims input. Several matches instead print a plain candidate list
  // (readline's behavior for a multi-element result), left untouched so it
  // reads like a normal shell completion list rather than one with stray
  // trailing spaces — the live suggestion panel (see computeSuggestions)
  // already shows descriptions for that case.
  return hits.length === 1 ? [[`${hits[0]} `], line] : [hits, line];
}

function setup(): void {
  process.stdin.resume();
  // readline.createInterface itself puts a TTY input into raw mode and
  // manages keypress-level line editing (backspace, arrow-key history,
  // paste) internally — nothing here needs to touch setRawMode by hand,
  // which is what made the old design (five+ independent raw-mode
  // save/restore sites) fragile in the first place.
  rl = readline.createInterface({
    input: process.stdin,
    output: gatedOutput() as any,
    prompt: IDLE_PROMPT,
    terminal: true,
    completer: slashCompleter,
  });

  rl.on("line", handleLine);
  // Fires whenever the interface is closed out from under us unexpectedly
  // (should not happen in normal operation — pauseInput is the only other
  // closer, and it clears `rl` itself first) so state never points at a
  // dead interface.
  rl.once("close", () => {
    if (rl) rl = undefined;
  });

  // Registered AFTER readline.createInterface's own internal keypress
  // handling has already run for a given keystroke (Node fires listeners in
  // registration order), so rl.line/rl.cursor here reflect the keystroke
  // readline already applied.
  onKeypress = (_str, key) => {
    if (key?.ctrl && key.name === "v") {
      void pasteFromClipboard();
      return;
    }
    if (key?.name === "paste-start") {
      paste.start();
      return;
    }
    if (key?.name === "paste-end") {
      const shown = paste.end(rl?.line ?? "");
      if (shown !== undefined && rl) {
        (rl as any).line = shown;
        (rl as any).cursor = shown.length;
        refreshInputArea();
      }
      return;
    }
    if (key?.name === "escape") {
      // Bonus path, not load-bearing: /stop is now the primary way to
      // interrupt from the keyboard, reachable regardless of whether raw
      // keypress detection behaves in a given terminal. Esc still works
      // wherever it already did.
      runControl.requestAbort("keyboard (Esc)");
      return;
    }
    if (key?.ctrl && key.name === "c") {
      // Raw mode intercepts Ctrl-C as a plain keystroke instead of letting
      // the terminal driver raise SIGINT — re-raised by hand here, exactly
      // as the retired installEscToAbort did, or Ctrl-C would silently do
      // nothing for the whole interactive session.
      process.emit("SIGINT");
      return;
    }
    // Every other keystroke (including Tab, after readline's own completer
    // has already run) — keep the live suggestion panel in sync with
    // whatever's now typed.
    updateSuggestionsIfNeeded();
  };
  process.stdin.on("keypress", onKeypress);
  // Tell the host terminal this app handles paste markers itself, so it stops
  // showing its own "paste N lines / paste as one line?" confirmation.
  if (process.stdout.isTTY) {
    process.stdout.write(BRACKETED_PASTE_ON);
    if (!exitHookSet) {
      exitHookSet = true;
      // Never leave the user's shell in bracketed-paste mode after we exit.
      process.once("exit", () => process.stdout.write(BRACKETED_PASTE_OFF));
    }
  }

  redrawInputArea();
}

/**
 * Installs the persistent input line for the life of the interactive
 * session. TTY-only; a non-interactive/piped session (or a terminal that
 * doesn't support raw mode) gets a no-op teardown and every prompt in this
 * module transparently falls back to the old one-shot-readline behavior via
 * claim()'s own guard.
 */
export function installPersistentInput(): () => void {
  // Both failure modes used to return the same silent no-op as success under
  // the retired installEscToAbort — someone hits Esc (or now, types /stop),
  // nothing happens, with no way to tell "this terminal can't do that" from
  // "it's broken". An IDE-embedded terminal panel routinely fails one or
  // both of these checks even though it looks like an ordinary interactive
  // terminal.
  if (!process.stdin.isTTY) {
    console.warn(
      "[CONTROL] ⚠️ The pinned input line is unavailable in this terminal (stdin is not a TTY) — use Ctrl+C to stop instead."
    );
    return () => {};
  }
  if (typeof process.stdin.setRawMode !== "function") {
    console.warn(
      "[CONTROL] ⚠️ The pinned input line is unavailable in this terminal (raw input mode is unsupported here) — use Ctrl+C to stop instead."
    );
    return () => {};
  }
  installed = true;
  setup();
  return () => {
    installed = false;
    teardown();
  };
}

function teardown(): void {
  if (process.stdout.isTTY) process.stdout.write(BRACKETED_PASTE_OFF);
  if (onKeypress) process.stdin.off("keypress", onKeypress);
  onKeypress = undefined;
  rl?.close();
  rl = undefined;
}

/**
 * Closes the persistent interface entirely so a caller that needs true
 * exclusive raw stdin (askHidden's masked input, the /model /model-sort
 * /api-key menu pickers' own ESC-aware prompts) doesn't have two things
 * reacting to the same keystrokes. Close-and-recreate rather than
 * rl.pause()/resume(): askHidden unconditionally calls input.resume() as
 * part of its own contract, which would silently re-enable flow to this
 * interface's still-attached listeners too if they weren't fully torn down.
 */
export function pauseInput(): void {
  if (!installed || !rl) return;
  teardown();
}

/** Recreates the persistent interface after pauseInput(). No-op if it was
 *  never installed in the first place, or is already active. */
export function resumeInput(): void {
  if (!installed || rl) return;
  setup();
}

/**
 * Claims the next submitted line(s) as the answer to `query`, exactly like
 * the old per-call startPrompt did — same shape, same multi-line-paste
 * debounce — but reusing the ONE persistent interface instead of creating
 * its own. Falls back to a private one-shot readline when the persistent
 * input was never installed (non-TTY), so every caller works unchanged
 * either way.
 */
export function claim(query: string): CancellablePrompt {
  if (!rl) return legacyClaim(query);

  // Discard anything the user had half-typed under the PREVIOUS owner (the
  // idle default prompt, or nothing) rather than letting it silently become
  // part of this new question's answer.
  (rl as any).line = "";
  (rl as any).cursor = 0;

  const claimObj: ActiveClaim = {
    lines: [],
    settled: false,
    resolve: () => {},
    reject: () => {},
  };
  const answer = new Promise<string>((resolve, reject) => {
    claimObj.resolve = resolve;
    claimObj.reject = reject;
  });

  activeClaim = claimObj;
  setPrompt(query);
  refreshInputArea();

  return {
    answer,
    cancel: () => {
      if (claimObj.settled) return;
      claimObj.settled = true;
      if (claimObj.settleTimer) clearTimeout(claimObj.settleTimer);
      if (activeClaim === claimObj) {
        activeClaim = undefined;
        setPrompt(IDLE_PROMPT);
        refreshInputArea();
      }
      claimObj.reject(new Error("prompt cancelled"));
    },
  };
}

/**
 * The original startPrompt implementation, verbatim in spirit — used only
 * when the persistent interface isn't installed (non-interactive/piped
 * stdin, or a terminal without raw-mode support). Owns its own short-lived
 * readline.Interface exactly as before.
 */
function legacyClaim(query: string): CancellablePrompt {
  process.stdin.resume();
  const wasRaw = Boolean((process.stdin as any).isRaw);
  process.stdin.setRawMode?.(false);
  const local = readline.createInterface({ input: process.stdin, output: process.stdout });

  const lines: string[] = [];
  let settleTimer: NodeJS.Timeout | undefined;
  let settled = false;

  const doSettle = (): boolean => {
    if (settled) return false;
    settled = true;
    if (settleTimer) clearTimeout(settleTimer);
    process.stdin.setRawMode?.(wasRaw);
    return true;
  };

  const answer = new Promise<string>((resolve, reject) => {
    const finish = () => {
      if (!doSettle()) return;
      local.close();
      resolve(lines.join("\n"));
    };
    local.on("line", (line) => {
      lines.push(line);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, SETTLE_MS);
    });
    local.once("close", () => {
      if (doSettle()) reject(new Error("prompt cancelled"));
    });
    process.stdout.write(query);
  });

  return { answer, cancel: () => local.close() };
}
