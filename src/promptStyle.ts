/**
 * One wording for every yes/no question the harness asks at the terminal, and
 * one parser for the answers. Before this, prompts used `[y/N]`, `[Y/n]`,
 * `[yes/no]` and `(yes/no)` depending on who wrote them, a capital letter
 * silently meant "this is what Enter does", and one prompt accepted only the
 * exact word "yes" (typing "y" was read as no).
 *
 * The suffix says in words what a bare Enter does:
 *   (yes/no, Enter = no)   a side-effecting action: silence is never consent
 *   (yes/no, Enter = yes)  a harmless, reversible suggestion
 *   (yes/no)               no default: the user must answer
 */

export const YES_NO_ENTER_NO = "(yes/no, Enter = no)";
export const YES_NO_ENTER_YES = "(yes/no, Enter = yes)";
export const YES_NO = "(yes/no)";

export type EnterMeans = "yes" | "no" | "none";

/**
 * y/yes (anything starting with "y", case-insensitive) is yes; n/no is no.
 * A bare Enter is whatever the prompt said it was; with no default it, and any
 * answer that is neither, count as no.
 */
export function parseYesNo(answer: string, enterMeans: EnterMeans = "no"): boolean {
  const v = String(answer ?? "").trim().toLowerCase();
  if (v === "") return enterMeans === "yes";
  if (v.startsWith("y")) return true;
  return false;
}
