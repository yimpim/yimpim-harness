/**
 * Outbound redaction: the last line of defence before text leaves for a model provider. Every reader that feeds a model already refuses secret files (sensitivePaths.ts); this catches
 * the credential that got through anyway (pasted by a person, printed by a command, sitting in a fixture). It is deliberately narrow: only values with a distinctive prefix and a long
 * body, which are never ordinary code or prose, so it does not rewrite what a model needs to read. Anything it replaces is logged.
 */

interface Rule {
  name: string;
  re: RegExp;
}

const RULES: Rule[] = [
  { name: "OpenRouter key", re: /\bsk-or-(?:v1-)?[A-Za-z0-9_-]{20,}/g },
  { name: "OpenAI project key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "GitHub token", re: /\bghp_[A-Za-z0-9]{36,}/g },
  // The whole block when it is complete, and the header with the base64 lines after it when a read cut it short: never the prose that follows.
  { name: "private key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\s*[A-Za-z0-9+/=]{16,})+(?:\s*-----END [A-Z0-9 ]*PRIVATE KEY-----)?/g },
];

export interface Redacted {
  text: string;
  /** What was replaced: rule name -> how many. */
  hits: Record<string, number>;
}

export function scrubCredentials(text: string): Redacted {
  const hits: Record<string, number> = {};
  let out = text;
  for (const { name, re } of RULES) {
    out = out.replace(re, () => {
      hits[name] = (hits[name] ?? 0) + 1;
      return `[REDACTED ${name}]`;
    });
  }
  return { text: out, hits };
}

/** The messages with every credential-shaped value replaced; the same array object when there was none. Logs one [REDACT] line when something was replaced. */
export function redactMessages<T extends { content?: unknown }>(messages: T[], log: (line: string) => void = (l) => console.log(l)): T[] {
  const total: Record<string, number> = {};
  let changed = false;
  const scrub = (s: string): string => {
    const r = scrubCredentials(s);
    for (const [k, n] of Object.entries(r.hits)) {
      total[k] = (total[k] ?? 0) + n;
      changed = true;
    }
    return r.text;
  };
  const out = messages.map((m) => {
    const c = m?.content;
    if (typeof c === "string") {
      const next = scrub(c);
      return next === c ? m : { ...m, content: next };
    }
    if (Array.isArray(c)) {
      let partChanged = false;
      const parts = c.map((p: any) => {
        if (p && typeof p.text === "string") {
          const next = scrub(p.text);
          if (next !== p.text) {
            partChanged = true;
            return { ...p, text: next };
          }
        }
        return p;
      });
      return partChanged ? { ...m, content: parts } : m;
    }
    return m;
  });
  if (!changed) return messages;
  const what = Object.entries(total).map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`).join(", ");
  log(`[REDACT] Replaced ${what} in the text before sending it to the model. The values never left this machine.`);
  return out;
}
