/**
 * Reading the names a test runner prints, and finding those tests in their file. Small and import-free on purpose: the heal and the sandbox both need
 * it, and the sandbox pulls in the whole tool loop, which the heal loads only when it has to.
 */

/** A line that starts a test: `it(`, `test(`, `it.only(`, `test.skip(`, `it.each(`. */
export const isTestLine = (l: string): boolean => /\b(?:it|test)(?:\.(?:only|skip|each))?\s*\(/.test(l);

/**
 * The title of the test itself, from the name a runner prints. Jest joins the describe blocks and the test with " › " (U+203A), which is NOT the
 * ASCII ">": splitting on " > " (as this once did) left the whole "Suite › Group › test" string, which appears on no line of the test file, so
 * no failing test's code was ever found. A name with no " › " is the title as it stands (a title may itself contain ">", e.g. "expects x > 0").
 */
export function testTitleOf(full: string): string {
  const parts = full.split(/\s+›\s+/);
  return parts[parts.length - 1].trim();
}

/**
 * The line (0-based) where a test starts in its file, or -1. A name joined with " > " by another formatter is tried second, only when the name has no " › ".
 */
export function lineOfTest(lines: string[], full: string): number {
  const candidates = [testTitleOf(full), ...(!full.includes("›") && full.includes(" > ") ? [full.split(" > ").pop()!.trim()] : [])].filter((t) => t.length > 0);
  for (const title of candidates) {
    const idx = lines.findIndex((l) => isTestLine(l) && l.includes(title.slice(0, 60)));
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Where a test block that starts on line `idx` (0-based) ends: the line where its braces close again. Counts braces on each line, which is rough (a brace
 * in a string or a regex counts) but is the same on both sides of any comparison, and is bounded: a block that never closes within `maxLines` ends there.
 */
export function testBlockEnd(lines: string[], idx: number, maxLines = 400): number {
  let depth = 0;
  let opened = false;
  const last = Math.min(lines.length - 1, idx + maxLines);
  for (let i = idx; i <= last; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (opened && depth <= 0) return i;
  }
  return last;
}

/**
 * The names in the order their tests appear in the file (neighbouring tests share setup, so a batch of them has one thing to learn, not three). A name
 * not found in the file goes after the others and keeps its place among the unfound.
 */
export function inFileOrder(testText: string, names: string[]): string[] {
  const lines = testText.split(/\r?\n/);
  return names
    .map((name, i) => {
      const at = lineOfTest(lines, name);
      return { name, i, at: at < 0 ? Number.POSITIVE_INFINITY : at };
    })
    .sort((a, b) => (a.at === b.at ? a.i - b.i : a.at - b.at))
    .map((x) => x.name);
}
