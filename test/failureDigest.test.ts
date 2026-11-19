import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { digestFailure, signatureOf, excerptAround } from "../src/failureDigest.js";

let dir = "";
const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};
const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-"));
  write("app/dashboard.tsx", lines(30, "app"));
  write("__tests__/dashboard.test.ts", lines(60, "test"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const jestFailure = (n: number) =>
  `FAIL __tests__/dashboard.test.ts\n` +
  Array.from({ length: n }, (_, i) =>
    [
      `  ● Dashboard › case ${i + 1}`,
      ``,
      `    TypeError: (0 , _secureStore.getSupabaseRefreshToken) is not a function`,
      ``,
      `      12 |   a`,
      `    > 13 |   void Promise.all([getSupabaseRefreshToken()])`,
      ``,
      `      at app/dashboard.tsx:13:46`,
      `      at Object.react_stack_bottom_frame (node_modules/react-test-renderer/cjs/react-test-renderer.development.js:15755:20)`,
      `      at render (__tests__/dashboard.test.ts:21:16)`,
    ].join("\n"),
  ).join("\n\n");

describe("eighty failures with one cause are one cause", () => {
  // Built inside each test: the temporary project exists only once beforeEach has run.
  let d: ReturnType<typeof digestFailure>;
  beforeEach(() => {
    d = digestFailure(jestFailure(80), dir, "__tests__/dashboard.test.ts");
  });
  test("it counts the failures and the distinct causes", () => {
    assert.equal(d.total, 80);
    assert.equal(d.clusters.length, 1);
    assert.equal(d.clusters[0].count, 80);
    assert.match(d.text, /^80 failures, 1 distinct cause\./);
  });
  test("it names the cause once, with how often it happens", () => {
    assert.match(d.text, /\[80×\] TypeError: \(0 , _secureStore\.getSupabaseRefreshToken\) is not a function/);
    assert.equal((d.text.match(/is not a function/g) ?? []).length, 1);
  });
  test("it points at the first line of the project's own code, not a dependency", () => {
    assert.deepEqual(d.clusters[0].frame, { file: "app/dashboard.tsx", line: 13 });
    assert.match(d.text, /first points at app\/dashboard\.tsx:13/);
    assert.doesNotMatch(d.text, /node_modules\/react-test-renderer/);
  });
  test("it shows the code around that line, with the failing line marked", () => {
    assert.match(d.text, />\s+13 \| app 13/);
    assert.match(d.text, /\s+12 \| app 12/);
  });
  test("it also shows where the test exercises it", () => {
    assert.deepEqual(d.clusters[0].testFrame, { file: "__tests__/dashboard.test.ts", line: 21 });
    assert.match(d.text, /exercised from the test at __tests__\/dashboard\.test\.ts:21/);
  });
  test("it is a small fraction of the raw output", () => {
    assert.ok(d.text.length < 2500, `${d.text.length} chars`);
    assert.ok(jestFailure(80).length > 20_000);
  });
});

describe("different causes are ranked by how often they happen", () => {
  test("the common one first, details that differ do not split a cause", () => {
    const out = [
      "  ● a",
      "    Error: timed out after 5000 ms",
      "  ● b",
      "    Error: timed out after 6000 ms",
      "  ● c",
      "    Error: timed out after 7000 ms",
      "  ● d",
      "    AssertionError: expected 1 to equal 2",
    ].join("\n");
    const d = digestFailure(out, dir);
    assert.equal(d.clusters[0].count, 3);
    assert.match(d.clusters[0].message, /timed out/);
    assert.equal(d.clusters[1].count, 1);
    assert.match(d.text, /2 distinct causes/);
  });
  test("signatures drop numbers and long quoted strings", () => {
    assert.equal(signatureOf("Error: 12 of 40"), "Error: # of #");
    assert.match(signatureOf(`Error: "${"x".repeat(60)}" failed`), /Error: "…" failed/);
  });
});

describe("it does not belong to one language or runner", () => {
  test("Python: an AssertionError line and File \"path\", line N frames", () => {
    write("pkg/mod.py", lines(20, "py"));
    const out = [
      "FAILED tests/test_mod.py::test_x - AssertionError",
      "    def test_x():",
      '  File "pkg/mod.py", line 7, in handler',
      "E   AssertionError: assert 1 == 2",
    ].join("\n");
    const d = digestFailure(out, dir);
    assert.equal(d.clusters[0].message, "E   AssertionError: assert 1 == 2".trim());
    assert.deepEqual(d.clusters[0].frame, undefined, "the frame comes AFTER the header in this layout");
    const after = digestFailure(["E   AssertionError: assert 1 == 2", '  File "pkg/mod.py", line 7, in handler'].join("\n"), dir);
    assert.deepEqual(after.clusters[0].frame, { file: "pkg/mod.py", line: 7 });
  });
  test("Go: a panic and a frame written as name.go:line, resolved by its unique name", () => {
    write("internal/svc/handler.go", lines(100, "go"));
    const out = ["panic: runtime error: index out of range [3] with length 3", "goroutine 6 [running]:", "\t/home/ci/build/internal/svc/handler.go:88 +0x1c"].join("\n");
    const d = digestFailure(out, dir);
    assert.match(d.clusters[0].message, /^panic:/);
    assert.deepEqual(d.clusters[0].frame, { file: "internal/svc/handler.go", line: 88 });
  });
  test("Kotlin and Java: a frame that only names the file, (Foo.kt:123)", () => {
    write("app/src/main/Foo.kt", lines(200, "kt"));
    const out = ["java.lang.AssertionError: expected:<1> but was:<2>", "\tat com.acme.Foo.bar(Foo.kt:123)", "\tat org.junit.Assert.fail(Assert.java:89)"].join("\n");
    const d = digestFailure(out, dir);
    assert.deepEqual(d.clusters[0].frame, { file: "app/src/main/Foo.kt", line: 123 });
  });
  test("Rust: thread panicked, frame src/lib.rs:12:5", () => {
    write("src/lib.rs", lines(30, "rs"));
    const d = digestFailure(["thread 'tests::adds' panicked at src/lib.rs:12:5:", "assertion `left == right` failed"].join("\n"), dir);
    assert.match(d.clusters[0].message, /panicked/);
    assert.deepEqual(d.clusters[0].frame, { file: "src/lib.rs", line: 12 });
  });
  test("a frame inside a dependency is never the answer", () => {
    const out = ["TypeError: x is not a function", "    at foo (node_modules/lib/index.js:10:5)", "    at bar (/usr/lib/python3/site-packages/x.py:3)"].join("\n");
    assert.equal(digestFailure(out, dir).clusters[0].frame, undefined);
  });
  test("an ambiguous bare file name is not guessed at", () => {
    write("a/Dup.kt", lines(10));
    write("b/Dup.kt", lines(10));
    assert.equal(digestFailure(["Error: boom", "\tat x(Dup.kt:3)"].join("\n"), dir).clusters[0].frame, undefined);
  });
});

describe("output with no readable cause", () => {
  test("is left to the caller (empty text)", () => {
    const d = digestFailure("something went sideways\nnothing error-like here", dir);
    assert.equal(d.text, "");
    assert.equal(d.clusters.length, 0);
  });
  test("an excerpt of a missing file is empty, not a crash", () => {
    assert.equal(excerptAround(dir, { file: "nope.ts", line: 3 }), "");
  });
});
