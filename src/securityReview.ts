/**
 * The attacker's review of a change. Method, from public practice:
 *   - scope is the change only: what it NEWLY makes exploitable, not old problems (Anthropic's security-review);
 *   - files are triaged by risk and by how many files depend on them (differential review);
 *   - one pass proposes concrete findings with an exploit scenario; a SEPARATE pass tries to refute each one
 *     (reachable? attacker-controlled? unprotected?) and only findings that survive at high confidence are kept;
 *   - each kept finding is searched for elsewhere in the project (variant analysis).
 * A model reasons and judges; code does the triage, bounds the evidence, applies the confidence threshold, and
 * does the searching. It runs only for changes that touch risky code, so ordinary changes cost nothing.
 */
import fs from "node:fs";
import { TEST_OR_SPEC_DIR } from "./projectPaths.js";
import { lazyIgnore } from "./projectPaths.js";
import path from "node:path";
import type { ChangeSet } from "./staticQa.js";
import { splitDiffByFile } from "./staticQa.js";
import type { TaskSecurity } from "./securityPlan.js";
import { securityForPrompt } from "./securityPlan.js";
import { redactSecrets } from "./securityLint.js";
import { isSensitiveName } from "./sensitivePaths.js";
import { SECURITY_NOTICE_SHORT } from "./disclaimer.js";

export type Ask = (system: string, user: string) => Promise<string>;

export const CONFIDENCE_MIN = 0.8;
const MAX_CANDIDATES = 6;
const AUDIT_CANDIDATES = 10;
const EVIDENCE_CHARS = 26000;
const AUDIT_EVIDENCE_CHARS = 52000;

export type Risk = "high" | "medium" | "low";

const NOT_CODE = new RegExp(String.raw`(^|\/)(${TEST_OR_SPEC_DIR}|fixtures?|mocks?|examples?|samples?|docs?|node_modules|vendor|dist|build)\/|\.(test|spec|stories|min)\.[a-z]+$|\.(md|mdx|txt|lock|svg|png|jpe?g|gif|ico|pdf|woff2?|ttf|snap|json)$`, "i");
const HIGH_PATH = /(auth|login|logout|signin|signup|session|token|jwt|oauth|password|passwd|credential|crypto|encrypt|decrypt|secret|payment|billing|checkout|stripe|paypal|webhook|invoice|refund|upload|admin|permission|role|acl|rbac|policy|policies|rls|middleware|guard|iam|sudo|exec|shell|sandbox|deserial|sanitize|validate|cors|firewall|ingress|security|manifest|dockerfile|\.tf$|\.rules$|nginx|sshd)/i;
const HIGH_CONTENT = /\b(jwt|bearer|password|passwd|hash(ed)?|bcrypt|argon|crypto\.|createCipher|encrypt|decrypt|secret|api[_-]?key|authorization|isAdmin|permission|sessions?\.|cookie|csrf|cors|child_process|subprocess|innerHTML|dangerouslySetInnerHTML|webhook|stripe|payment|refund|service_role|createClient|signed[_-]?url|presign|chmod|iptables)\b|\b(exec|eval|raw)\s*\(|\b(role)\s*[=:]|\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[\w*`'"]|0\.0\.0\.0\/0/i;
const MEDIUM_PATH = /(route|router|controller|handler|api|endpoint|service|repository|model|schema|migration|query|resolver|action|function|lambda|worker|job|queue|store|db|database|server)/i;

/** How risky a changed file is, from where it lives and what was added to it. */
export function classifyFile(file: string, added: string): Risk {
  if (NOT_CODE.test(file)) return "low";
  if (HIGH_PATH.test(file) || HIGH_CONTENT.test(added)) return "high";
  if (MEDIUM_PATH.test(file)) return "medium";
  return "low";
}

const SRC = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|rb|php|java|kt|swift|m|go|rs|cs|dart|sh|ya?ml|tf|sql)$/i;
const WALK_SKIP = lazyIgnore();

function sourceFiles(root: string, limit = 3000): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.length >= limit) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (WALK_SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (SRC.test(e.name)) out.push(full);
      if (out.length >= limit) return;
    }
  };
  walk(root, 0);
  return out;
}

export type Blast = "low" | "medium" | "high" | "critical";

/** How many other files import this one: 1-5 low, 6-20 medium, 21-50 high, over 50 critical. */
export function blastRadius(root: string, file: string, files: string[] = sourceFiles(root)): { callers: number; level: Blast } {
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  if (base.length < 3) return { callers: 0, level: "low" };
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(import|require|from|include|use|using|load|source)\\b[^\\n]*[\\\\/'"\\s.]${esc}(['"\\s;.)]|$)`, "m");
  let callers = 0;
  const self = path.resolve(root, file);
  for (const f of files) {
    if (path.resolve(f) === self) continue;
    try {
      const st = fs.statSync(f);
      if (st.size > 300_000) continue;
      if (re.test(fs.readFileSync(f, "utf-8"))) callers++;
    } catch {
      // skip
    }
  }
  return { callers, level: callers > 50 ? "critical" : callers > 20 ? "high" : callers > 5 ? "medium" : "low" };
}

export interface Candidate {
  file: string;
  line: number;
  category: string;
  severity: "high" | "medium";
  description: string;
  exploit: string;
  fix: string;
  confidence: number;
  /** A literal fragment of the vulnerable code, used to look for the same mistake elsewhere. */
  pattern?: string;
}

export interface Finding extends Candidate {
  /** Other places with the same pattern: file:line. */
  variants: string[];
  /** Why the filter pass kept it. */
  verdict: string;
  blast?: { callers: number; level: Blast };
}

export interface SecurityReviewResult {
  ran: boolean;
  findings: Finding[];
  dropped: number;
  highRisk: string[];
  notes: string[];
}

const num01 = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n > 1 ? n / 10 : n)) : 0;
};

const FINDER_SYSTEM =
  "You are an application security engineer reviewing ONE code change as an attacker would. Report only vulnerabilities that this change NEWLY makes exploitable; do not comment on existing code. " +
  "Look for: input validation (SQL, command, NoSQL, template, XXE, path traversal), authentication and authorisation (bypass, missing object-level checks, privilege escalation, session and JWT flaws), " +
  "cryptography and secrets (hard-coded keys, weak algorithms, weak randomness, certificate checks disabled), injection and code execution (deserialisation, eval, XSS), data exposure (secrets or personal data in logs, responses or client bundles), " +
  "third-party service misuse (payment webhooks without signature verification, client-trusted prices, email or SMS endpoints usable as a spam relay, backend rules that allow anyone, service keys in clients, public cloud storage, permissive IAM) and infrastructure (privileged containers, open ports, unpinned CI actions). " +
  "Use the threat model's abuse cases and requirements as a checklist: for each, is it met by this change? An unmet requirement is a finding. " +
  "Do NOT report: denial of service or resource exhaustion, generic rate limiting, theoretical races, outdated libraries, memory-safety issues in memory-safe languages, issues only in test files or documentation, log spoofing, regex denial of service, missing hardening with no concrete exploit, or client-side checks that the server also enforces. " +
  "Severity: HIGH is directly exploitable for code execution, data breach, account takeover, payment fraud or authentication bypass; MEDIUM needs specific conditions but has significant impact. Report nothing lower. " +
  "Every finding needs the file, the line, a category (sql_injection, authz_bypass, secret_exposure, ...), a one-sentence description, a concrete exploit scenario (precondition, steps, impact), a fix, your confidence from 0 to 1, and a short LITERAL fragment of the vulnerable code (pattern) so the same mistake can be searched for. " +
  "Only report what you are more than 80 percent sure is exploitable. If there is nothing, return an empty list. " +
  'Respond ONLY with JSON: {"findings": [{"file": "", "line": 0, "category": "", "severity": "high"|"medium", "description": "", "exploit": "", "fix": "", "confidence": 0.0, "pattern": ""}]}';

const FILTER_SYSTEM =
  "You are a skeptical senior security engineer. A colleague claims a vulnerability. Try to REFUTE it. Check, using the code shown: Is the code reachable by an attacker? Is the data attacker-controlled? Is it protected by a guard, sanitiser, framework default, type constraint, authorisation check or caller elsewhere? " +
  "Is the exploit scenario realistic, or does it rely on conditions that cannot occur? Known non-issues: client-side authorisation gaps that the server enforces; UUIDs and random ids treated as unguessable; environment variables and command-line flags as trusted; React and Angular output as XSS-safe unless dangerouslySetInnerHTML or bypassSecurityTrust is used; logging non-secret values; resource leaks; open redirects and tabnabbing unless clearly exploitable. " +
  "Code with no callers is not refuted: unreachable but unprotected code stays at lower severity. Judge reachable, controllable and unprotected separately, then give a verdict and your confidence (0 to 1) that this is a real, exploitable vulnerability. " +
  'Respond ONLY with JSON: {"keep": true|false, "confidence": 0.0, "reachable": true|false, "controllable": true|false, "unprotected": true|false, "reason": "one or two sentences", "severity": "high"|"medium"}';

/** The same finder, pointed at an existing application instead of one change. */
export const AUDIT_FINDER_SYSTEM = FINDER_SYSTEM.replace(
  "reviewing ONE code change as an attacker would. Report only vulnerabilities that this change NEWLY makes exploitable; do not comment on existing code.",
  "auditing an EXISTING application as an attacker would. Report real, exploitable vulnerabilities in the code shown, in places an attacker can reach, ranked by impact; the code shown is the riskiest part of the application, not all of it."
);

export function parseCandidates(text: string, knownFiles: string[]): Candidate[] {
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
  const out: Candidate[] = [];
  for (const f of Array.isArray(j?.findings) ? j.findings : []) {
    const file = String(f?.file ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
    const severity = f?.severity === "high" ? "high" : f?.severity === "medium" ? "medium" : null;
    // A finding must be about a file the change touched, with a stated exploit.
    if (!severity || !knownFiles.includes(file) || !String(f?.exploit ?? "").trim() || !String(f?.description ?? "").trim()) continue;
    out.push({
      file,
      line: Math.max(0, Math.floor(Number(f?.line) || 0)),
      category: String(f?.category ?? "security").replace(/[^a-z0-9_ -]/gi, "").slice(0, 40) || "security",
      severity,
      description: String(f.description).replace(/\s+/g, " ").trim().slice(0, 300),
      exploit: String(f.exploit).replace(/\s+/g, " ").trim().slice(0, 400),
      fix: String(f?.fix ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      confidence: num01(f?.confidence),
      pattern: typeof f?.pattern === "string" ? f.pattern.trim().slice(0, 120) : undefined,
    });
  }
  return out;
}

/** The lines around a reported line, so the skeptic sees the guard if there is one. */
function around(root: string, file: string, line: number, radius = 40): string {
  try {
    const lines = fs.readFileSync(path.resolve(root, file), "utf-8").split(/\r?\n/);
    const from = Math.max(0, (line || 1) - radius);
    return lines.slice(from, (line || 1) + radius).map((l, i) => `${from + i + 1}: ${l}`).join("\n").slice(0, 7000);
  } catch {
    return "(the file could not be read)";
  }
}

/** Other places with the same literal fragment; the changed line itself is excluded. */
export function findVariants(root: string, c: Candidate, files: string[] = sourceFiles(root), max = 5): string[] {
  const p = c.pattern?.trim();
  if (!p || p.length < 8 || /^[\s\W]*$/.test(p)) return [];
  const out: string[] = [];
  for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, "/");
    try {
      if (fs.statSync(f).size > 300_000) continue;
      const lines = fs.readFileSync(f, "utf-8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(p) && !(rel === c.file && Math.abs(i + 1 - c.line) <= 2)) {
          out.push(`${rel}:${i + 1}`);
          if (out.length >= max) return out;
          break;
        }
      }
    } catch {
      // skip
    }
  }
  return out;
}

export interface ReviewOptions {
  goal: string;
  change: ChangeSet;
  repoRoot: string;
  ask: Ask;
  task?: TaskSecurity | null;
  /** Concern messages already found by the pattern checks, given to the finder as leads. */
  leads?: string[];
  /** Audit an existing application (the change holds the files to examine) rather than review one change. */
  audit?: boolean;
}

export async function securityReview(o: ReviewOptions): Promise<SecurityReviewResult | null> {
  if (o.change.isEmpty) return null;
  const segs = splitDiffByFile(o.change.diff).filter((s) => s.file && !NOT_CODE.test(s.file) && !isSensitiveName(s.file));
  if (segs.length === 0) return null;
  const added = (d: string) => d.split(/\r?\n/).filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
  const ranked = segs
    .map((s) => ({ s, risk: classifyFile(s.file!, added(s.diff)) }))
    .sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.risk] - { high: 0, medium: 1, low: 2 }[b.risk]));
  const highRisk = ranked.filter((r) => r.risk === "high").map((r) => r.s.file!);
  const run = !!o.audit || !!o.task?.risky || highRisk.length > 0 || (o.leads?.length ?? 0) > 0;
  if (!run) return null;

  // Evidence: risky files first, bounded.
  let budget = o.audit ? AUDIT_EVIDENCE_CHARS : EVIDENCE_CHARS;
  const parts: string[] = [];
  for (const r of ranked) {
    if (budget <= 0) break;
    if (r.risk === "low" && parts.length > 0) continue;
    // Nothing that looks like a credential leaves the machine, whatever the file holds.
    const d = redactSecrets(r.s.diff.slice(0, Math.min(o.audit ? 9000 : 8000, budget)));
    parts.push(`### ${r.s.file} (risk ${r.risk})\n${d}`);
    budget -= d.length;
  }
  const known = ranked.map((r) => r.s.file!);
  const task = o.task?.risky
    ? `\nThreat model for this task:\nAbuse cases:\n${o.task.abuseCases.map((a) => `- ${a.attack} -> ${a.mitigation}`).join("\n")}\nRequirements:\n${o.task.requirements.map((r) => `- ${r}`).join("\n")}\n`
    : "";
  const rules = securityForPrompt(o.repoRoot);
  const notes: string[] = [];

  let candidates: Candidate[] = [];
  try {
    candidates = parseCandidates(
      await o.ask(
        o.audit ? AUDIT_FINDER_SYSTEM : FINDER_SYSTEM,
        `${o.audit ? "What is being audited" : "The goal of the change"}:\n${o.goal.slice(0, 1500)}\n${task}${o.leads?.length ? `\nPattern checks already raised (leads, not conclusions):\n${o.leads.slice(0, 8).map((l) => `- ${l}`).join("\n")}\n` : ""}\nRules that apply to this project:\n${rules.slice(0, 5000)}\n\nThe change (files that may be touched: ${known.join(", ")}):\n${parts.join("\n\n")}`
      ),
      known
    );
  } catch (err: any) {
    return { ran: false, findings: [], dropped: 0, highRisk, notes: [`The security review could not run (${String(err?.message ?? err).slice(0, 80)}).`] };
  }
  const proposed = candidates.length;
  candidates = candidates
    .filter((c) => c.confidence >= 0.6)
    .sort((a, b) => (a.severity === b.severity ? b.confidence - a.confidence : a.severity === "high" ? -1 : 1))
    .slice(0, o.audit ? AUDIT_CANDIDATES : MAX_CANDIDATES);

  // The refuting pass: a separate question per finding, in parallel.
  const verdicts = await Promise.allSettled(
    candidates.map((c) =>
      o.ask(
        FILTER_SYSTEM,
        `The claim:\n[${c.severity}] ${c.category} in ${c.file}:${c.line}\n${c.description}\nExploit scenario: ${c.exploit}\n\nThe code around it:\n${redactSecrets(around(o.repoRoot, c.file, c.line))}\n\nThe change to this file:\n${redactSecrets((segs.find((s) => s.file === c.file)?.diff ?? "").slice(0, 5000))}`
      )
    )
  );
  const files = sourceFiles(o.repoRoot);
  const findings: Finding[] = [];
  candidates.forEach((c, i) => {
    const v = verdicts[i];
    if (v.status !== "fulfilled") {
      notes.push(`A finding in ${c.file} could not be checked by the second pass and was not reported.`);
      return;
    }
    let j: any = null;
    try {
      j = JSON.parse(v.value);
    } catch {
      const a = v.value.indexOf("{");
      const b = v.value.lastIndexOf("}");
      try {
        j = a >= 0 && b > a ? JSON.parse(v.value.slice(a, b + 1)) : null;
      } catch {
        j = null;
      }
    }
    const conf = num01(j?.confidence);
    if (!j || j.keep !== true || conf < CONFIDENCE_MIN) return;
    const severity = j.severity === "medium" ? "medium" : j.severity === "high" ? "high" : c.severity;
    findings.push({
      ...c,
      severity,
      confidence: conf,
      variants: findVariants(o.repoRoot, c, files),
      verdict: String(j.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
      blast: blastRadius(o.repoRoot, c.file, files),
    });
  });
  return { ran: true, findings, dropped: proposed - findings.length, highRisk, notes };
}

/** A finding as the text a repair agent and a person both need. */
export function renderFinding(f: Finding): string {
  return (
    `[${f.severity.toUpperCase()}] ${f.category} at ${f.file}${f.line ? `:${f.line}` : ""} (confidence ${Math.round(f.confidence * 100)}%)\n` +
    `${f.description}\nHow it is exploited: ${f.exploit}\nFix: ${f.fix}` +
    (f.variants.length ? `\nThe same pattern also appears at: ${f.variants.join(", ")} (check these too)` : "") +
    (f.blast && f.blast.level !== "low" ? `\nBlast radius: ${f.blast.callers} file(s) depend on ${f.file} (${f.blast.level}).` : "")
  );
}

export function renderReview(r: SecurityReviewResult): string {
  if (!r.ran) return r.notes.join(" ");
  const notice = `\n\n${SECURITY_NOTICE_SHORT}`;
  if (r.findings.length === 0) {
    return `No high-confidence exploitable flaw found in the change${r.highRisk.length ? ` (risky files looked at: ${r.highRisk.slice(0, 5).join(", ")})` : ""}${r.dropped ? `; ${r.dropped} candidate(s) did not survive the refuting pass` : ""}. This is a reasoned review of the change, not proof of safety.${notice}`;
  }
  return r.findings.map(renderFinding).join("\n\n") + notice;
}
