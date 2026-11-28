/**
 * Anyone can be asked a question: a developer, or someone using this for the first time. A question about reducers, a
 * dependency or an approval for "npx jest" goes over the second person's head. So every question that reaches a human
 * keeps its exact technical wording (for those who know what is being asked) and gets a short plain-words explanation in
 * brackets under it (for everyone else): what is being asked, and what each option would mean for them.
 *
 * The explanation is added in one place, where questions are put to the user, so the Planner, Discovery, the Editor, QA and
 * the command approvals all get it. If the question is already plain, or the model is slow or fails, it is asked as it was.
 */

export const PLAIN_MARK = "In plain words:";

const MAX_PLAIN = 800;
const MIN_PROMPT = 20;

/** What goes under a question: the explanation, and a short gloss for each option (same order) when it has options. */
export interface PlainExplanation {
  plain: string;
  options?: string[];
}

export interface AskedQuestion {
  prompt: string;
  choices?: string[];
  idle?: boolean;
  kind?: string;
}

/** Does this question still need a plain-words explanation? */
export function needsPlainWords(q: AskedQuestion): boolean {
  if (q.idle) return false; // the normal "what should I do" prompt is not a question about the work
  if (q.kind === "approval") return false; // command/install approvals are already plain English and must reach the user/phone immediately
  const p = String(q.prompt ?? "").trim();
  if (p.length < MIN_PROMPT) return false;
  if (p.toLowerCase().includes(PLAIN_MARK.toLowerCase())) return false; // the asker already wrote it
  return true;
}

export function buildPlainMessages(q: AskedQuestion): { role: "system" | "user"; content: string }[] {
  const choices = (q.choices ?? []).map((c, i) => `${i + 1}) ${c}`).join("\n");
  return [
    {
      role: "system",
      content: `A coding assistant is asking a person a question. The person may have never programmed. Their question is written for developers and must stay exactly as it is. Your job is the short explanation in brackets underneath it, for someone using this for the first time.

Write it so that a non-technical person understands (1) what is being asked, in everyday words, and (2) what each option would mean for them, if there are options, and which one you would suggest only if the question already makes a recommendation. Rules:
- No jargon, no code, no file names, no acronyms; say what a thing is for instead of what it is called ("the part that keeps track of the screen's data", not "the reducer").
- Do not add facts, decisions or advice that are not in the question. Do not answer it.
- At most 4 short sentences. Plain sentences, no lists, no markdown.
- If there are options, also give "options": one very short everyday-words gloss for each option, in the same order and the same number (at most 12 words each; what choosing it means). Leave "options" out when there are none.
- If the question is already fully understandable to a non-technical person, set "alreadyPlain" to true and leave "plain" empty.

Respond ONLY with JSON: {"alreadyPlain":true|false,"plain":"...","options":["...","..."]}`,
    },
    { role: "user", content: `Question:\n${q.prompt}${choices ? `\n\nOptions:\n${choices}` : ""}` },
  ];
}

/** The explanation from the model's reply, or null when there is nothing usable to add. */
export function parsePlain(raw: string, prompt: string, optionCount = 0): PlainExplanation | null {
  let j: any;
  try {
    j = JSON.parse(raw || "{}");
  } catch {
    return null;
  }
  if (j?.alreadyPlain === true) return null;
  const plain = String(j?.plain ?? "").replace(/\s+/g, " ").trim().replace(/^\(+|\)+$/g, "").trim();
  if (plain.length < 15 || plain.length > MAX_PLAIN) return null;
  if (plain.toLowerCase() === prompt.trim().toLowerCase()) return null;
  const glosses: string[] = Array.isArray(j?.options) ? j.options.map((o: unknown) => String(o ?? "").replace(/\s+/g, " ").trim().replace(/^\(+|\)+$/g, "").trim()) : [];
  const usable = optionCount > 0 && glosses.length === optionCount && glosses.every((g) => g.length >= 3 && g.length <= 140);
  return usable ? { plain, options: glosses } : { plain };
}

/** The question as asked, with the explanation under it. The technical text is untouched. */
export function withPlainWords(prompt: string, plain: string): string {
  return `${prompt.replace(/\s+$/, "")}\n\n(${PLAIN_MARK} ${plain})`;
}

/** The explanation for a question, or null (already plain, too slow, or the model failed). */
export async function plainWordsFor(
  q: AskedQuestion,
  complete: (messages: { role: "system" | "user"; content: string }[]) => Promise<string>,
  timeoutMs = 20_000
): Promise<PlainExplanation | null> {
  if (!needsPlainWords(q)) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const raw = await Promise.race([
      complete(buildPlainMessages(q)),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(""), timeoutMs);
      }),
    ]);
    return parsePlain(raw, q.prompt, (q.choices ?? []).length);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
