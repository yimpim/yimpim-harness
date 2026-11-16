import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { diffStore } from "../src/diffStore.js";

describe("diffStore", () => {
  test("records a diff and retrieves it by changeId", () => {
    diffStore.record("chg-a", "src/foo.ts", "  const x = 1;\n- old\n+ new");
    const stored = diffStore.get("chg-a");
    assert.equal(stored?.path, "src/foo.ts");
    assert.equal(stored?.diffText, "  const x = 1;\n- old\n+ new");
  });

  test("an unknown changeId returns undefined", () => {
    assert.equal(diffStore.get("never-recorded"), undefined);
  });

  test("evicts the oldest entries once the entry-count cap is exceeded", () => {
    for (let i = 0; i < 305; i++) {
      diffStore.record(`cap-${i}`, `path-${i}.ts`, "+ line");
    }
    // The very first entries from this loop should have been evicted (oldest first).
    assert.equal(diffStore.get("cap-0"), undefined);
    // The most recent ones must still be there.
    assert.equal(diffStore.get("cap-304")?.path, "path-304.ts");
  });
});
