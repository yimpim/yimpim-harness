/**
 * What the desktop terminal shows, as opposed to what a run says.
 *
 * Every line a run prints is also sent to a paired phone, which reads some of them (the verdict, the files searched). So nothing is
 * removed at the source: this decides only what is drawn on the TERMINAL. A line that is routine bookkeeping (a model call that
 * succeeded, a file that was read, a gate that passed) is hidden; anything that went wrong, needs a decision, or says what was done
 * is shown. Warnings and errors are never hidden. `/verbose` (or YIMPIM_VERBOSE=1) shows every line, for finding out what happened.
 */

let verbose = /^(1|true|yes|on)$/i.test(process.env.YIMPIM_VERBOSE ?? "");

export function isVerbose(): boolean {
  return verbose;
}

export function setVerbose(on: boolean): void {
  verbose = on;
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Routine bookkeeping: shown only in verbose mode. Each is a whole line, matched from its start. */
const ROUTINE: RegExp[] = [
  // A model call that came back fine. A slow call ("Still waiting"), a retry and a failure are different lines and stay.
  /^\[API\] \S+ \([A-Z_ ]+\) ✔ \(/,
  /^\[MEMORY\]/,
  // The files an agent opened and the searches it ran while looking: the same files are listed again as they are changed.
  /^\[[A-Z_ ]+\] (🔎 )?(Bounded inspection|Reading discovery target|Read file:|Searched code with pattern)/,
  // The environment report printed ahead of every verification.
  /^\[QA\] Project profile:/,
  /^\[QA\] Running build gate:/,
  /^\[QA GATE\] ✓/,
  /^\[QA ADVISORY\] ✓/,
  // Counted from the start of verification, so it leaves out the editor's own calls: the phase and job totals are the real figures.
  /^\[COST\] ".*": .* so far\.$/,
];

/** The verdict's own list of every gate repeats what the gate lines said. The defects and advisories are what a person acts on. */
function withoutEvidenceList(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*(\*\*)?Evidence collected:(\*\*)?\s*$/.test(l));
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && !/^\s*\*\*/.test(lines[end])) end++;
  // Keep one blank line between the headline and what follows.
  const before = lines.slice(0, start);
  while (before.length && before[before.length - 1].trim() === "") before.pop();
  const after = lines.slice(end);
  return after.length ? [...before, "", ...after].join("\n") : before.join("\n");
}

/**
 * The arguments to print on the terminal for a console call, or null to print nothing. Only plain log lines are ever changed:
 * warnings and errors, and anything that is not a string, go through as they are.
 */
export function terminalView(level: "log" | "warn" | "error", args: unknown[]): unknown[] | null {
  if (verbose || level !== "log" || typeof args[0] !== "string") return args;
  const first = args[0];
  const head = (first.replace(ANSI, "").split("\n").find((l) => l.trim()) ?? "").trim();
  if (ROUTINE.some((re) => re.test(head))) return null;
  if (/Evidence collected:/.test(first)) return [withoutEvidenceList(first), ...args.slice(1)];
  return args;
}
