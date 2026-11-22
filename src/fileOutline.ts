/**
 * A compact table of contents for a file too big to read in one go: each declaration with the lines it covers, so the next read_file call can go straight to a block with startLine/endLine
 * instead of guessing offsets. No language is assumed: it reads the declaration keywords the common languages share (function, class, def, func, fn, fun, struct, trait, ...) and top-level
 * `const`/`let`/`var`/`val` bindings. It is a map, not a parser: the end of a block is the line before the next declaration at the same level (or the end of the file).
 */

export interface OutlineEntry {
  start: number;
  end: number;
  text: string;
}

const KEYWORD =
  /^(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|internal|static|abstract|open|data|sealed|override|suspend|pub(?:\([^)]*\))?)\s+)*(?:async\s+)?(function\*?|class|interface|enum|struct|trait|impl|object|fun|def|func|fn|type|namespace|module)\b\s*(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)?/;
const BINDING = /^(?:export\s+)?(?:default\s+)?(const|let|var|val)\s+[A-Za-z_$][\w$]*/;

/** Leading whitespace as a width (a tab counts 4). */
function indentOf(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === " ") w++;
    else if (ch === "\t") w += 4;
    else break;
  }
  return w;
}

/** Declarations of a file with the lines each covers. `lines` are the file's lines as read (the numbers match a startLine/endLine request). */
export function outlineEntries(lines: string[], maxTextChars = 90): OutlineEntry[] {
  const found: { line: number; indent: number; text: string }[] = [];
  lines.forEach((raw, i) => {
    const indent = indentOf(raw);
    if (indent > 4) return;
    const t = raw.trim();
    if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*")) return;
    const isDecl = KEYWORD.test(t) || (BINDING.test(t) && (indent === 0 || /=>|\bfunction\b/.test(t)));
    if (!isDecl) return;
    found.push({ line: i + 1, indent, text: t.length > maxTextChars ? `${t.slice(0, maxTextChars - 3)}...` : t });
  });
  // A file that ends with a newline has an empty last element; it is not a line.
  const total = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  return found.map((e, k) => {
    let end = total;
    for (let j = k + 1; j < found.length; j++) {
      if (found[j].indent <= e.indent) {
        end = found[j].line - 1;
        break;
      }
    }
    return { start: e.line, end: Math.max(e.line, end), text: e.text };
  });
}

/**
 * The block added to a "truncated" notice: the whole file's outline (not just the part that was shown), at most `max` entries. Empty when the file has no declarations this reads, so the
 * notice stays as it was.
 */
export function truncationOutline(content: string, max = 80): string {
  const entries = outlineEntries(content.split("\n"));
  if (entries.length === 0) return "";
  const shown = entries.slice(0, max);
  const more = entries.length > shown.length ? `\n... ${entries.length - shown.length} more declaration(s); search_code finds them by name.` : "";
  return `\n\nOutline of the WHOLE file (lines each declaration covers, to the next one at the same level) — read a block with startLine/endLine:\n${shown.map((e) => `L${e.start}-${e.end}  ${e.text}`).join("\n")}${more}`;
}
