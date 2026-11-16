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
}

export const DESKTOP_SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "/remote-control", desc: "Pair your phone — QR code, sets up everything" },
  { cmd: "/rc", desc: "Alias for /remote-control" },
  { cmd: "/link", desc: "Link this machine to YIMPIM Pro (cloud-tunnel lease)" },
  { cmd: "/model", desc: "Change the model for one role" },
  { cmd: "/models", desc: "Alias for /model" },
  { cmd: "/model-sort", desc: "How OpenRouter picks a backend per call" },
  { cmd: "/api-key", desc: "Rotate your OpenRouter key" },
  { cmd: "/ask", desc: "Ask a question, read-only — nothing gets changed" },
  { cmd: "/status", desc: "Models, settings and readiness for this repo" },
  { cmd: "/usage", desc: "Lifetime tokens and cost — by worker, model and phase" },
  { cmd: "/approvals", desc: "Commands approved for this project — list or revoke" },
  { cmd: "/plan", desc: "The current plan" },
  { cmd: "/push-repo", desc: "Connect to a GitHub remote and push now" },
  { cmd: "/push-local", desc: "Commit pending work, turn auto-push OFF" },
  { cmd: "/branch", desc: "Create or switch to a branch" },
  { cmd: "/branches", desc: "List branches in this repo" },
  { cmd: "/merge", desc: "Merge a branch into the default branch" },
  { cmd: "/memory", desc: "What YIMPIM has learned about this repo" },
  { cmd: "/stop", desc: "Stop safely at the next boundary — works any time" },
  { cmd: "/continue", desc: "Resume the last plan a Stop interrupted" },
  { cmd: "/resume", desc: "Alias for /continue" },
  { cmd: "/help", desc: "Full command list" },
  { cmd: "/exit", desc: "Quit" },
];
