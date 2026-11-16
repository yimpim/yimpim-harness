/**
 * What a failed test run is shown as. The build-failure filter keeps lines that
 * look like compiler errors, and a stack frame ("at toEqual (x.test.ts:74:20)")
 * looks like one, so for a Jest failure it kept that single line and dropped
 * the part that explains the failure: the test's name and the Expected and
 * Received diff. The repair Planner then, quite reasonably, had no way to say
 * what was wrong and asked a human to paste the output.
 *
 * A test runner prints a report written for a person to read. This keeps it,
 * per runner: Jest/Vitest failure blocks, pytest's FAILURES section, `go test`
 * failures, cargo's failures, mocha's failing list. It returns undefined for
 * output that is not a test run, so the compiler-error filter still applies
 * there.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const SUMMARY_LINE = /^\s*(Test Suites|Tests|Snapshots|Time):\s/;

function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (${text.length - maxChars} more character(s) of this test report omitted for length)`;
}

export function extractTestFailureReport(raw: string, maxChars = 8000): string | undefined {
  const clean = raw.replace(ANSI, "");
  const lines = clean.split(/\r?\n/);

  // Jest, and Vitest's Jest-style reporter: "  ● suite › test name" blocks.
  const isHeader = (l: string) => /^\s{0,4}● .+/.test(l) && !/^\s{0,4}● Console\b/.test(l);
  const headers = lines.map((l, i) => (isHeader(l) ? i : -1)).filter((i) => i >= 0);
  if (headers.length > 0) {
    const summary = lines.filter((l) => SUMMARY_LINE.test(l)).map((l) => l.trim());
    const perBlock = Math.max(600, Math.floor((maxChars - summary.join("\n").length - 40) / Math.min(headers.length, 6)));
    const blocks: string[] = [];
    headers.forEach((start, n) => {
      let end = n + 1 < headers.length ? headers[n + 1] : lines.length;
      for (let i = start + 1; i < end; i++) {
        // A block ends at the run summary, or where Jest starts printing what
        // the code under test logged (not part of the failure itself).
        if (SUMMARY_LINE.test(lines[i]) || /^\s{0,4}● Console\b/.test(lines[i]) || /^\s{2}console\.(log|warn|error|info|debug)\s*$/.test(lines[i])) {
          end = i;
          break;
        }
      }
      blocks.push(cap(lines.slice(start, end).join("\n").trimEnd(), perBlock));
    });
    const shown = blocks.slice(0, 6);
    const more = blocks.length > shown.length ? `\n... (${blocks.length - shown.length} more failing test(s) not shown)` : "";
    return cap([...shown, more ? more.trim() : "", ...summary].filter(Boolean).join("\n\n"), maxChars);
  }

  // Vitest / Node's runner / anything that prints an assertion diff.
  if (/^\s*(FAIL|✗|×)\s/m.test(clean) && /(Expected|Received|AssertionError|expected .* to )/i.test(clean)) {
    const from = lines.findIndex((l) => /^\s*(FAIL|✗|×)\s/.test(l));
    return cap(lines.slice(Math.max(0, from)).join("\n").trim(), maxChars);
  }

  // pytest: from the FAILURES header on.
  const py = lines.findIndex((l) => /^=+ FAILURES =+$/.test(l.trim()));
  if (py >= 0) return cap(lines.slice(py).join("\n").trim(), maxChars);

  // go test: the first failing test on.
  const go = lines.findIndex((l) => /^\s*--- FAIL:/.test(l));
  if (go >= 0) return cap(lines.slice(go).join("\n").trim(), maxChars);

  // cargo test: the "failures:" section on.
  const rs = lines.findIndex((l) => /^failures:\s*$/.test(l.trim()));
  if (rs >= 0 && /test result: FAILED/.test(clean)) return cap(lines.slice(rs).join("\n").trim(), maxChars);

  // mocha: the "N failing" list.
  const mocha = lines.findIndex((l) => /^\s*\d+ failing\s*$/.test(l));
  if (mocha >= 0) return cap(lines.slice(mocha).join("\n").trim(), maxChars);

  return undefined;
}
