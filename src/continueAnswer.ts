/**
 * Reads an answer to "Continue? [yes next / yes to all / no]" the way a person means it, not letter for letter.
 * "yes to alll", "all", "yes all", "yesall", "go on, all of them" are all "all"; "y", "ok", "next" are "next".
 * Anything that does not clearly say yes is "no", which is the safe side: it stops and asks nothing more.
 */
export type ContinueAnswer = "next" | "all" | "no";

export function parseContinueAnswer(raw: string): ContinueAnswer {
  const s = raw.trim().toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "no";
  if (/^(no|n|nope|nah|stop|cancel|abort|quit|exit|dont|don't)\b/.test(s)) return "no";
  // "all", "alll", "al", "everything", "keep going", "don't ask again" — said anywhere in the answer.
  if (/(\b|yes)al+\b|\bevery ?(thing|one)?\b|\bkeep going\b|\bwithout asking\b|\bdon't ask\b|\bdont ask\b|\bnon ?stop\b/.test(s) && !/\bnot all\b/.test(s)) return "all";
  if (/^(y|ye|yes|yess+|yep|yeah|yea|ya|yup|ok|okay|sure|go|next|continue|proceed|do it|please)\b/.test(s)) return "next";
  return "no";
}
