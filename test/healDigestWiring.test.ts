/** Every place a model reads a test failure gets the digest (one cause, its count, its source line), not a raw tail of repeated traces. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf-8").replace(/\r\n/g, "\n");

describe("the readers of a test failure", () => {
  test("the verifier's failed-test report, which REPAIR reads, leads with the digest", () => {
    const src = read("../src/verifierTools.ts");
    assert.ok(src.includes("const digest = digestFailure(run.output, this.repoRoot, caused[0]);"));
    assert.ok(src.includes("digest.text ? `${digest.text}"));
    assert.ok(src.includes("TEST OUTPUT (start)"));
  });
  test("the shared-setup worker and the settle worker use it, and neither slices the raw tail any more", () => {
    const src = read("../src/testHeal.ts");
    assert.ok(src.includes("failureText(group[0].failure!, repoRoot, group[0].file)"));
    assert.ok(src.includes('failureText(r.failure ?? "", repoRoot, r.file)'));
    assert.ok(!src.includes(".slice(-8000)}"), "no raw 8000-character tail is sent to a model any more");
  });
  test("the heal worker itself uses it for the first prompt and for every retry", () => {
    const src = read("../src/testHeal.ts");
    // The first prompt, the retry after a failing edit, the "nothing new to apply" turn (every edit sent was already in the file), and the hand-off to
    // the stronger model, and the digest handed to the sandbox agent for a named cause and for the unclustered tests (the same one the first model saw,
    // never the raw output).
    assert.equal(src.split("failureText(current.output, repoRoot, file)").length - 1, 6);
  });
});
