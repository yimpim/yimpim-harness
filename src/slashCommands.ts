/**
 * Every slash command the desktop's interactive prompt recognizes, primary
 * spelling and aliases alike — the source list for terminalInput.ts's Tab
 * completion AND its live suggestion panel (the "type /s and see matching
 * commands" list, shown above the pinned input the same way Claude Code's
 * own CLI shows one). `desc` is kept to one short line — it has to fit next
 * to the command on a single terminal row.
 */
export interface SlashCommand {
  cmd: string;
  desc: string;
  /** A sub-command: listed only once the line already starts with its parent, so "/r" stays a short list. */
  parent?: string;
  /** Another spelling of a command: it still works when typed, but is never suggested or completed from a prefix. */
  alias?: boolean;
}

/** Whether an entry belongs in the list for what has been typed so far. */
export function matchesTyped(c: SlashCommand, line: string): boolean {
  if (c.alias) return c.cmd === line;
  return c.cmd.startsWith(line) && (!c.parent || line.startsWith(c.parent));
}

export const DESKTOP_SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "/remote-control", desc: "Pair your phone — QR code, sets up everything" },
  { cmd: "/rc", desc: "Alias for /remote-control", alias: true },
  { cmd: "/link", desc: "Link this machine to YIMPIM Pro (cloud-tunnel lease)" },
  { cmd: "/model", desc: "Change the model for one role" },
  { cmd: "/models", desc: "Alias for /model", alias: true },
  { cmd: "/model-sort", desc: "How OpenRouter picks a backend per call" },
  { cmd: "/api-key", desc: "Rotate your OpenRouter key" },
  { cmd: "/ask", desc: "Ask a question, read-only — nothing gets changed" },
  { cmd: "/status", desc: "Models, settings and readiness for this repo" },
  { cmd: "/usage", desc: "Lifetime tokens and cost — by worker, model and phase" },
  { cmd: "/approvals", desc: "Commands approved for this project — list or revoke" },
  { cmd: "/plan", desc: "The current plan" },
  { cmd: "/roadmap", desc: "A big job split into units, tracked until it is done" },
  { cmd: "/roadmap new", desc: "Plan a whole job from an idea", parent: "/roadmap" },
  { cmd: "/roadmap port", desc: "Plan a rebuild from a reference folder", parent: "/roadmap" },
  { cmd: "/roadmap run", desc: "Start the next unit", parent: "/roadmap" },
  { cmd: "/roadmap add", desc: "Add to the roadmap (or say what to drop)", parent: "/roadmap" },
  { cmd: "/roadmap drop", desc: "Leave a unit out: /roadmap drop U003", parent: "/roadmap" },
  { cmd: "/roadmap reopen", desc: "Put a blocked or failed unit back", parent: "/roadmap" },
  { cmd: "/roadmap done", desc: "Mark a unit done by hand", parent: "/roadmap" },
  { cmd: "/roadmap open", desc: "Note what a done unit left open", parent: "/roadmap" },
  { cmd: "/roadmap sync", desc: "Add reference files that appeared since", parent: "/roadmap" },
  { cmd: "/roadmap reset", desc: "Throw the roadmap away (a copy of finished units is kept)", parent: "/roadmap" },
  { cmd: "/design", desc: "Make a logo, favicon and app icons" },
  { cmd: "/tests", desc: "Fix a red test suite: update stale tests, report real code bugs" },
  { cmd: "/tests heal", desc: "One worker per failing test file, all at once", parent: "/tests" },
  { cmd: "/tests heal all", desc: "Same, rerunning every test", parent: "/tests" },
  { cmd: "/tests log", desc: "When each test last ran green or red", parent: "/tests" },
  { cmd: "/pentest", desc: "Security audit of this project (read-only)" },
  { cmd: "/push-repo", desc: "Connect to a GitHub remote and push now" },
  { cmd: "/push-local", desc: "Commit pending work, turn auto-push OFF" },
  { cmd: "/branch", desc: "Create or switch to a branch" },
  { cmd: "/branches", desc: "List branches in this repo" },
  { cmd: "/merge", desc: "Merge a branch into the default branch" },
  { cmd: "/memory", desc: "What YIMPIM has learned about this repo" },
  { cmd: "/stop", desc: "Stop safely at the next boundary — works any time" },
  { cmd: "/continue", desc: "Resume the last plan a Stop interrupted" },
  { cmd: "/resume", desc: "Alias for /continue", alias: true },
  { cmd: "/help", desc: "Full command list" },
  { cmd: "/exit", desc: "Quit" },
];
