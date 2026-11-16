/**
 * Security before building. Three things happen before a task is planned:
 *
 *   1. The project's security posture is written once (security/SECURITY.md): what it is built on, every rule that
 *      applies to that stack with its standard reference, and what to harden. It is read from the project's own files.
 *   2. A threat model for the task, when the task touches something an attacker would want (identity, money, files,
 *      personal data, webhooks, email, admin, infrastructure): assets, who attacks, entry points, abuse cases, and the
 *      security requirements the plan must meet. A model reasons about it; code validates and records it.
 *   3. The Planner and every Editor are given the rules and the requirements, so security is part of the design.
 */
import fs from "node:fs";
import path from "node:path";
import { coreSecurityBlock, detectSecurityStack, securityDoc, type SecurityStack } from "./securityStack.js";

export type Call = (models: string[], messages: { role: "system" | "user" | "assistant"; content: string | any[] }[], label: string, json: boolean) => Promise<string>;

export const SECURITY_DIR = "security";
export const TASK_FILE = path.join(".agent", "security_task.json");

export const SURFACES = ["identity", "authorisation", "payments", "uploads", "personal-data", "third-party-webhooks", "admin", "multi-tenant", "email-sms", "secrets", "deep-links", "public-api", "ai-agent", "infrastructure", "file-access", "external-fetch"] as const;
export type Surface = (typeof SURFACES)[number];

export interface AbuseCase {
  attack: string;
  impact: string;
  mitigation: string;
}

export interface TaskSecurity {
  /** How many attacker-style reviews this task has already had (they use the security model, so they are capped). */
  reviews?: number;
  risky: boolean;
  surfaces: Surface[];
  assets: string[];
  actors: string[];
  entryPoints: string[];
  abuseCases: AbuseCase[];
  requirements: string[];
  file?: string;
  createdAt: string;
}

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const list = (v: unknown, n: number, len = 160) => (Array.isArray(v) ? v : []).map((x) => clip(x, len)).filter(Boolean).slice(0, n);

// ---------------------------------------------------------------------------
// 1. the posture document
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; stack: SecurityStack }>();

/** The detected stack, cached briefly: agents ask for it on every call. */
export function securityStackOf(repoRoot: string): SecurityStack {
  const hit = cache.get(repoRoot);
  if (hit && Date.now() - hit.at < 60_000) return hit.stack;
  const stack = detectSecurityStack(repoRoot);
  cache.set(repoRoot, { at: Date.now(), stack });
  return stack;
}

export function clearSecurityCache(): void {
  cache.clear();
}

/** The short rules block for an agent's system prompt. */
export function securityForPrompt(repoRoot: string): string {
  try {
    return coreSecurityBlock(securityStackOf(repoRoot));
  } catch {
    return "";
  }
}

/**
 * Writes security/SECURITY.md when it is missing or the packs that apply have changed. A hand-edited file (one without
 * the generated header) is never overwritten.
 */
export function ensureSecurityDoc(repoRoot: string): { stack: SecurityStack; written: boolean } {
  const stack = detectSecurityStack(repoRoot);
  cache.set(repoRoot, { at: Date.now(), stack });
  if (stack.packs.length === 0) return { stack, written: false };
  const file = path.join(repoRoot, SECURITY_DIR, "SECURITY.md");
  try {
    let existing = "";
    try {
      existing = fs.readFileSync(file, "utf-8");
    } catch {
      existing = "";
    }
    if (existing) {
      const m = /^<!-- packs: ([^>]*) -->/.exec(existing);
      if (!m) return { stack, written: false }; // a person's own document
      if (m[1].trim() === stack.packs.join(",")) return { stack, written: false };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, securityDoc(stack, path.basename(repoRoot)));
    return { stack, written: true };
  } catch {
    return { stack, written: false };
  }
}

// ---------------------------------------------------------------------------
// 2. the threat model
// ---------------------------------------------------------------------------

export const THREAT_SYSTEM =
  "You are a security architect. You think like an attacker BEFORE code is written. Read the request and decide whether it touches something an attacker would want: " +
  `${SURFACES.join(", ")}. ` +
  "If it does not (a visual change, copy, a refactor with no new inputs, a read-only internal tool with no data), answer sensitive=false with empty lists. " +
  "If it does, produce a compact threat model: the ASSETS at stake, the ACTORS who would attack (anonymous visitor, signed-in user attacking another user, malicious tenant, compromised third party, insider), the ENTRY POINTS (routes, forms, webhooks, deep links, files, queues, AI inputs), " +
  "up to 6 concrete ABUSE CASES (what the attacker does, the impact, the mitigation that must exist) and the REQUIREMENTS the plan and code must meet. " +
  "Requirements must be specific and testable (for example: 'every order route checks order.userId equals the caller on the server'; 'the webhook verifies the Stripe signature on the raw body and ignores duplicate event ids'), never generic advice. " +
  "Use the project's detected stack and vendors. Consider: authorisation per object, input validation, secrets, rate limits and abuse of anything that sends email or costs money, replay and idempotency, data exposure, logging, and failure modes (fail closed). " +
  'Respond ONLY with JSON: {"sensitive": true|false, "surfaces": [from the list], "assets": [], "actors": [], "entryPoints": [], "abuseCases": [{"attack": "", "impact": "", "mitigation": ""}], "requirements": []}';

export function parseThreatModel(text: string): TaskSecurity | null {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    try {
      j = a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null;
    } catch {
      j = null;
    }
  }
  if (!j || typeof j !== "object") return null;
  const surfaces = (Array.isArray(j.surfaces) ? j.surfaces : []).map(String).filter((s: string): s is Surface => (SURFACES as readonly string[]).includes(s));
  const requirements = list(j.requirements, 12, 220);
  const sensitive = j.sensitive === true && (surfaces.length > 0 || requirements.length > 0);
  if (!sensitive) return { risky: false, surfaces: [], assets: [], actors: [], entryPoints: [], abuseCases: [], requirements: [], createdAt: new Date().toISOString() };
  return {
    risky: true,
    surfaces: [...new Set<Surface>(surfaces)],
    assets: list(j.assets, 8),
    actors: list(j.actors, 6),
    entryPoints: list(j.entryPoints, 10),
    abuseCases: (Array.isArray(j.abuseCases) ? j.abuseCases : [])
      .map((a: any) => ({ attack: clip(a?.attack, 200), impact: clip(a?.impact, 160), mitigation: clip(a?.mitigation, 200) }))
      .filter((a: AbuseCase) => a.attack && a.mitigation)
      .slice(0, 6),
    requirements,
    createdAt: new Date().toISOString(),
  };
}

export function renderThreatModel(t: TaskSecurity, title: string, stack: SecurityStack): string {
  return (
    `# Threat model: ${title}\n\nRecorded ${t.createdAt.slice(0, 10)}. Stack: ${stack.packs.join(", ") || "unknown"}. Touches: ${t.surfaces.join(", ")}.\n\n` +
    `## Assets\n${t.assets.map((a) => `- ${a}`).join("\n") || "- (none listed)"}\n\n` +
    `## Who attacks\n${t.actors.map((a) => `- ${a}`).join("\n") || "- (none listed)"}\n\n` +
    `## Entry points\n${t.entryPoints.map((a) => `- ${a}`).join("\n") || "- (none listed)"}\n\n` +
    `## Abuse cases\n${t.abuseCases.map((a, i) => `${i + 1}. **${a.attack}** — impact: ${a.impact || "n/a"}. Mitigation: ${a.mitigation}`).join("\n") || "- (none listed)"}\n\n` +
    `## Requirements (the plan and the code must meet these)\n${t.requirements.map((r) => `- [ ] ${r}`).join("\n")}\n\n` +
    `This is reasoned, not measured. It lists what to defend against; it does not prove the code does.\n`
  );
}

export interface ThreatContext {
  call: Call;
  /** The security model: writes the threat model, and only for a task that is security-sensitive. */
  models: string[];
  /** A cheaper model that first decides whether the task is security-sensitive at all. Absent: one call, by `models`. */
  triageModels?: string[];
  repoRoot: string;
  request: string;
  /** The briefs and specs the request names, as the Planner will read them. They state how the product must behave. */
  documents?: string;
  log: (line: string) => void;
}

export interface ThreatResult {
  task: TaskSecurity;
  /** Text for the Planner. Empty when the task is not security-sensitive. */
  plannerSection: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";

/** The chain for security work: the security model if set, else the verifier's, else the planner's. */
export function securityModels(models: { security?: string[]; verifier?: string[]; planner: string[] }): string[] {
  return models.security?.length ? models.security : models.verifier?.length ? models.verifier : models.planner;
}

export const TRIAGE_SYSTEM =
  "Decide whether a software request touches something an attacker would want: " +
  `${SURFACES.join(", ")}. ` +
  "A visual change, copy, a refactor with no new inputs, or a read-only internal tool with no data is NOT sensitive. " +
  'Respond ONLY with JSON: {"sensitive": true|false, "surfaces": [from the list]}';

/** true or false when the cheap model decided; null when its answer was unusable. */
export function parseTriage(text: string): boolean | null {
  try {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    const j = JSON.parse(a >= 0 && b > a ? text.slice(a, b + 1) : text);
    return j?.sensitive === true ? true : j?.sensitive === false ? false : null;
  } catch {
    return null;
  }
}

/** Records which task the verifier is judging; a stale record from an earlier task must never carry over. */
export function writeTaskSecurity(repoRoot: string, t: TaskSecurity): void {
  try {
    const f = path.join(repoRoot, TASK_FILE);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(t, null, 2));
  } catch {
    // never block a task on bookkeeping
  }
}

export function loadTaskSecurity(repoRoot: string): TaskSecurity | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(repoRoot, TASK_FILE), "utf-8"));
    return j && typeof j === "object" && typeof j.risky === "boolean" ? { ...j, surfaces: j.surfaces ?? [], assets: j.assets ?? [], actors: j.actors ?? [], entryPoints: j.entryPoints ?? [], abuseCases: j.abuseCases ?? [], requirements: j.requirements ?? [] } : null;
  } catch {
    return null;
  }
}

/**
 * Posture document, then the task's threat model. Never throws. The model is asked once; a failed or unusable answer
 * leaves the task un-flagged (the rules and the diff checks still apply), and says so.
 */
export async function ensureThreatModel(ctx: ThreatContext): Promise<ThreatResult> {
  const { stack, written } = ensureSecurityDoc(ctx.repoRoot);
  if (written) ctx.log(`[SECURITY] Wrote security/SECURITY.md for ${stack.packs.join(", ")}.`);
  const none: TaskSecurity = { risky: false, surfaces: [], assets: [], actors: [], entryPoints: [], abuseCases: [], requirements: [], createdAt: new Date().toISOString() };
  const docs = ctx.documents?.trim()
    ? `\n\nDocuments the request names (they state how the product must behave; a requirement of yours must fit them and never contradict a behavior they state, such as timings, limits or what is kept or cleared):\n${ctx.documents}`
    : "";
  const userText = `The request:\n${ctx.request.slice(0, 2000)}${docs}\n\nThe project is built on: ${stack.packs.map((p) => `${p} (${(stack.evidence[p] ?? []).slice(0, 2).join(", ")})`).join("; ") || "nothing recognised"}.`;
  // The security model is the expensive one, so a cheap model first rules out the many tasks that are not sensitive.
  if (ctx.triageModels) {
    let sensitive: boolean | null = null;
    try {
      sensitive = parseTriage(await ctx.call(ctx.triageModels, [{ role: "system", content: TRIAGE_SYSTEM }, { role: "user", content: userText }], "threat triage", true));
    } catch {
      sensitive = null;
    }
    if (sensitive === false) {
      writeTaskSecurity(ctx.repoRoot, none);
      return { task: none, plannerSection: "" };
    }
  }
  let task: TaskSecurity | null = null;
  try {
    task = parseThreatModel(
      await ctx.call(
        ctx.models,
        [
          { role: "system", content: THREAT_SYSTEM },
          { role: "user", content: userText },
        ],
        "threat model",
        true
      )
    );
  } catch {
    task = null;
  }
  if (!task) {
    writeTaskSecurity(ctx.repoRoot, none);
    ctx.log("[SECURITY] No threat model could be made for this task; the security rules and diff checks still apply.");
    return { task: none, plannerSection: "" };
  }
  if (!task.risky) {
    writeTaskSecurity(ctx.repoRoot, task);
    return { task, plannerSection: "" };
  }
  const title = clip(ctx.request, 60);
  const rel = path.join(SECURITY_DIR, "threat-models", `${task.createdAt.slice(0, 10)}-${slug(title)}.md`);
  try {
    fs.mkdirSync(path.join(ctx.repoRoot, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(ctx.repoRoot, rel), renderThreatModel(task, title, stack));
    task.file = rel.replace(/\\/g, "/");
  } catch {
    // the requirements still reach the plan
  }
  writeTaskSecurity(ctx.repoRoot, task);
  ctx.log(`[SECURITY] This task touches ${task.surfaces.join(", ")}: ${task.requirements.length} requirement(s), ${task.abuseCases.length} abuse case(s)${task.file ? `, recorded in ${task.file}` : ""}.`);
  return { task, plannerSection: plannerText(task) };
}

export function plannerText(t: TaskSecurity): string {
  if (!t.risky) return "";
  return (
    `\n\nSecurity requirements for this task (a threat model was made; the plan must satisfy them, and a phase is not done until its code does):\n` +
    t.requirements.map((r) => `- ${r}`).join("\n") +
    (t.abuseCases.length ? `\nAbuse cases the code must withstand:\n${t.abuseCases.map((a) => `- ${a.attack} (mitigation: ${a.mitigation})`).join("\n")}` : "") +
    `\nPut each requirement into the phase that builds the code it applies to, written as something the Editor can check. Enforce on the server and in the database; the client is untrusted.` +
    `\nThese requirements add protection; they do not decide how the product behaves. The user's request and the documents it names (a brief, a spec, the reference implementation) decide that. Where a requirement above conflicts with a behavior those state (a timing, a retry count, what is kept or cleared), follow the documents, meet the requirement only as far as that allows, and put one line in the phase saying what differs. Do not ask the user which wins.`
  );
}
