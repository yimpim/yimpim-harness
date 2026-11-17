/** The roadmap spending notice rides on the "roadmap or single task" question: choosing a roadmap there is the confirmation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const t = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");

test("the roadmap-or-single question carries the notice and its roadmap choice still starts with Plan", () => {
  assert.match(t, /can cost real money\. YimPim does not limit spend, so set a spending limit on your OpenRouter key first/);
  assert.match(t, /"Plan a roadmap \(many model calls, may cost money\)", SINGLE/);
  assert.match(t, /if \(!pick\.startsWith\("Plan"\)\) return "single";\s*return await planRoadmap\(true\);/);
});
test("choosing it marks the roadmap as confirmed, and the separate question still guards every other way in", () => {
  assert.match(t, /if \(spendAcknowledged\) \{[\s\S]{0,200}rm\.costNoticeAckedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(t, /const confirmRoadmapSpend = async/);
  assert.match(t, /if \(!rm \|\| rm\.costNoticeAckedAt\) return true;/);
});
