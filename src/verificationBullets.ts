/**
 * Planner verification bullets: a stable ID, optional tags, and a lightweight,
 * deterministic (no model call) quality lint.
 *
 * Storage/wire format stays `verification: string[]` so saved plans,
 * `--resume`, JSONL task logs and the phone app's event contract all keep
 * working unchanged. The ID and tags ride inside the string as a prefix:
 *
 *     "[A3][weak] The list renders correctly"
 *
 * Only IDs of the form A<n> and a short fixed set of tags are recognised in the
 * prefix, so a bullet that merely starts with a bracketed UI word
 * ("[Edit] button is visible") is left alone.
 *
 * The lint exists because QA can only judge what is observable: a bullet like
 * "works correctly" gives it nothing to check, and a quoted button label the
 * Planner guessed (rather than read in code) sends QA hunting for an element
 * that may never exist. It never hard-fails a plan on its own — see
 * applyVerificationQuality and the one-retry flow in index.ts.
 */

export interface ParsedBullet {
  /** "A1", "A2", ... or null when the bullet carries none yet. */
  id: string | null;
  /** Lower-cased tags in the prefix, e.g. ["weak", "requires:device"]. */
  tags: string[];
  /** The assertion itself, prefix removed. */
  text: string;
  /** Derived from tags, for convenience. */
  quality?: "weak" | "label_unverified";
}

const ID_RE = /^A(\d{1,3})$/i;
const TAG_RE = /^(weak|label_unverified|requires:[a-z_]{1,20})$/i;

/** The only "requires" reasons that mean anything to QA. */
export const ALLOWED_REQUIRES = ["requires:device", "requires:credentials"];

export function parseVerificationBullet(raw: string): ParsedBullet {
  let id: string | null = null;
  const tags: string[] = [];
  let rest = typeof raw === "string" ? raw : "";

  // Consume leading [..] groups only while they are an ID or a known tag.
  for (;;) {
    const m = rest.match(/^\s*\[([^\]\n]{1,40})\]\s*/);
    if (!m) break;
    const inner = m[1].trim();
    if (id === null && ID_RE.test(inner)) id = inner.toUpperCase();
    else if (TAG_RE.test(inner)) {
      const t = inner.toLowerCase();
      if (!tags.includes(t)) tags.push(t);
    } else break;
    rest = rest.slice(m[0].length);
  }

  const quality = tags.includes("weak") ? "weak" : tags.includes("label_unverified") ? "label_unverified" : undefined;
  return { id, tags, text: rest.trim(), ...(quality ? { quality } : {}) };
}

export function formatVerificationBullet(b: { id: string | null; tags: string[]; text: string }): string {
  const prefix = `${b.id ? `[${b.id}]` : ""}${b.tags.map((t) => `[${t}]`).join("")}`;
  return prefix ? `${prefix} ${b.text}` : b.text;
}

interface PlanLike {
  goal?: string;
  phases: {
    name?: string;
    goal?: string;
    changes?: string[];
    newFiles?: string[];
    verification: string[];
  }[];
}

/**
 * Gives every bullet in the plan a unique ID, in place. Existing valid IDs are
 * kept; a bullet with none (legacy plans, or a model that forgot) or a
 * duplicate gets the next unused number, plan-wide so an ID names exactly one
 * assertion across phases. Idempotent: running it again changes nothing.
 */
export function normalizeVerificationIds(plan: PlanLike): void {
  const used = new Set<string>();
  const parsed = plan.phases.map((p) => p.verification.map(parseVerificationBullet));

  // First pass: reserve the first occurrence of every ID already present.
  const keep = parsed.map((bullets) =>
    bullets.map((b) => {
      if (b.id && !used.has(b.id)) {
        used.add(b.id);
        return true;
      }
      return false;
    })
  );

  let next = 1;
  const nextFree = (): string => {
    while (used.has(`A${next}`)) next++;
    const id = `A${next}`;
    used.add(id);
    return id;
  };

  plan.phases.forEach((phase, pi) => {
    phase.verification = parsed[pi].map((b, bi) => {
      // requires:<x> is limited to the two reasons QA can act on; any other
      // value is the model inventing a way to excuse an assertion.
      const tags = b.tags.filter((t) => !t.startsWith("requires:") || ALLOWED_REQUIRES.includes(t));
      return formatVerificationBullet({ id: keep[pi][bi] ? b.id : nextFree(), tags, text: b.text });
    });
  });
}

// ----------------------------------------------------------------------- lint

/** Phrases that restate "it should be fine" without naming anything to check. */
const FLUFF_PATTERNS: RegExp[] = [
  /\b(works?\s+(correctly|properly|as\s+expected)|functions?\s+normally|no\s+errors?)\b/i,
  // "Verify file attachment works." — ends on the bare verb.
  /\b(works?|working|functions?|functional)\s*[.!]?\s*$/i,
];

/**
 * Something a person or a script could actually look at: visible text or an
 * element, a state change, data written or sent, a navigation, a count, or an
 * explicit negative constraint ("does not crash", "no longer appears").
 */
const OBSERVABLE_PATTERN = new RegExp(
  [
    "\\b(visible|appears?|shown?|shows?|displays?|displayed|renders?|rendered|lists?|listed|contains?|includes?)\\b",
    "\\b(equals?|matches|is\\s+(set|empty|disabled|enabled|selected|checked|unchecked|hidden|focused|greater|less|not)|becomes?|changes?\\s+(to|from)|updates?\\s+to|toggles?|cycles?)\\b",
    "\\b(navigates?|opens?|closes?|redirects?|returns?|responds?|persists?|saved|stores?|stored|written|writes|sent|sends|uploaded|uploads|deleted|removed?|disappears?|replaced|increments?|decrements?)\\b",
    // Specific measurable results only. A bare noun ("file", "response") names a
    // subject, not something that is true afterwards, so it is deliberately absent.
    "\\b(status\\s*(code\\s*)?\\d{3}|http\\s*\\d{3}|exit\\s+code\\s*\\d*|non-?empty|is\\s+(empty|null|undefined))\\b",
    "\\b(no\\s+longer|does\\s+not|doesn'?t|do\\s+not|never|without|not\\s+(crash|appear|show|render|throw|exist))\\b",
    "\\b\\d+\\b",
    "[\"'`\\u201c][^\"'`\\u201d]{1,60}[\"'`\\u201d]",
  ].join("|"),
  "i"
);

export function isFluff(text: string): boolean {
  return FLUFF_PATTERNS.some((re) => re.test(text));
}

export function hasObservable(text: string): boolean {
  return OBSERVABLE_PATTERN.test(text);
}

/** Quoted strings that read as on-screen UI text (a button, a heading), not
 *  as code, a path or a value. Straight/curly double quotes and backticks;
 *  single quotes are skipped because they are mostly apostrophes. */
export function extractQuotedUiStrings(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"\n]{2,40})"|“([^”\n]{2,40})”|`([^`\n]{2,40})`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!s) continue;
    if (/[\\/(){}=<>;:]/.test(s)) continue; // path, call, expression, selector
    if (/^[\w$.-]+\.\w{1,6}$/.test(s)) continue; // file name or property access
    if (/^\d+([.,]\d+)?$/.test(s)) continue; // bare number
    // A shell command, not something drawn on screen.
    if (/^(npm|npx|pnpm|yarn|bun|node|deno|python3?|pip3?|git|cargo|go|adb|gradlew?|make|curl|docker|pytest|jest|vitest|tsc)\b/i.test(s)) continue;
    if (/\s--?[a-z]/i.test(s)) continue; // command-line flag
    if (/^[a-z]+[A-Za-z0-9]*[A-Z_][A-Za-z0-9_]*$/.test(s) || /^[a-z0-9]+_[a-z0-9_]+$/.test(s)) continue; // camelCase / snake_case identifier
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(s) && s.includes("_")) continue; // CONSTANT_NAME
    out.push(s);
  }
  return out;
}

export type VerificationIssueKind = "weak" | "label_unverified";

export interface VerificationIssue {
  phaseIndex: number;
  bulletIndex: number;
  id: string | null;
  kind: VerificationIssueKind;
  message: string;
}

export interface VerificationLintContext {
  /** Free text the Planner is allowed to take UI strings from: the nav map,
   *  the user's request, and (optionally) Discovery's findings. */
  knownText: string;
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Finds bullets that give QA nothing to check, or that quote UI text with no
 * source. A quoted string is accepted if it appears in the nav map, the
 * request, Discovery's text, OR anything this plan itself says it will build
 * (any phase's goal/name/changes) — a new button the plan creates is a
 * legitimate label even though no map can know it yet.
 */
export function lintPlanVerification(plan: PlanLike, ctx: VerificationLintContext): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const planOwnText = [
    plan.goal ?? "",
    ...plan.phases.flatMap((p) => [p.name ?? "", p.goal ?? "", ...(p.changes ?? []), ...(p.newFiles ?? [])]),
  ].join("\n");
  const corpus = squash(`${ctx.knownText}\n${planOwnText}`);

  plan.phases.forEach((phase, pi) => {
    phase.verification.forEach((raw, bi) => {
      const b = parseVerificationBullet(raw);
      if (!b.text) return;
      const label = `phase ${pi + 1}${b.id ? ` ${b.id}` : ""}`;

      if (isFluff(b.text) && !hasObservable(b.text)) {
        issues.push({
          phaseIndex: pi,
          bulletIndex: bi,
          id: b.id,
          kind: "weak",
          message:
            `${label} verification "${b.text.slice(0, 90)}" gives QA nothing to check — state what a user or a ` +
            `test would actually SEE or MEASURE (a visible text or element, a changed value, a file or request ` +
            `sent, a navigation, or an explicit negative like "does not crash" / "no longer appears")`,
        });
        return;
      }

      const unknown = extractQuotedUiStrings(b.text).filter((s) => !corpus.includes(squash(s)));
      if (unknown.length > 0) {
        issues.push({
          phaseIndex: pi,
          bulletIndex: bi,
          id: b.id,
          kind: "label_unverified",
          message:
            `${label} verification quotes ${unknown.map((s) => `"${s}"`).join(", ")} but that text appears in no ` +
            `file you were shown, the request, or what this plan builds — don't name a button, heading or message ` +
            `you haven't seen in the code; describe the outcome instead, or take the label from the code you read`,
        });
      }
    });
  });
  return issues;
}

/**
 * Records lint findings on the bullets themselves, as tags, so they survive
 * saving and resuming without any new field. Used after the single permitted
 * re-plan: a bullet that is still flagged is kept (a retry loop costs more
 * than a mildly weak assertion) but is marked so QA and the report can say so.
 */
export function applyVerificationQuality(plan: PlanLike, issues: VerificationIssue[]): void {
  for (const issue of issues) {
    const phase = plan.phases[issue.phaseIndex];
    const raw = phase?.verification[issue.bulletIndex];
    if (raw === undefined) continue;
    const b = parseVerificationBullet(raw);
    if (!b.tags.includes(issue.kind)) b.tags.push(issue.kind);
    phase.verification[issue.bulletIndex] = formatVerificationBullet(b);
  }
}

/** Remove quality tags (after a clean re-plan the new bullets carry none, but
 *  a resumed plan may hold stale ones). Other tags are untouched. */
export function stripQualityTags(plan: PlanLike): void {
  for (const phase of plan.phases) {
    phase.verification = phase.verification.map((raw) => {
      const b = parseVerificationBullet(raw);
      b.tags = b.tags.filter((t) => t !== "weak" && t !== "label_unverified");
      return formatVerificationBullet(b);
    });
  }
}
