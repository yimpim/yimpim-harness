import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContinueAnswer as p } from "../src/continueAnswer.js";

test("all, however it is typed", () => {
  for (const a of ["yes to all", "yes to alll", "yes to alll ", "Yes To All!", "all", "yes all", "yesall", "yes, all of them", "yes keep going", "yes and don't ask again"]) assert.equal(p(a), "all", a);
});
test("next, no, and the safe default", () => {
  for (const a of ["yes next", "yes", "y", "ok", "yep", "next", "continue"]) assert.equal(p(a), "next", a);
  for (const a of ["no", "n", "stop", "no, not all", "", "banana", "maybe later"]) assert.equal(p(a), "no", a);
});
