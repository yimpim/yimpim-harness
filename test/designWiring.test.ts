/**
 * index.ts runs the whole CLI when imported, so these check the Designer is
 * really connected: the classifier can send a request to it, /design runs it,
 * the models come from config, and the person's pick goes through askChoice.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { INTENT_SYSTEM } from "../src/prompts.js";
import { ConfigSchema } from "../src/config.js";

const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");

describe("the Designer is connected", () => {
  test("the classifier can answer 'design', and is told what is and is not one", () => {
    assert.match(INTENT_SYSTEM, /"roadmap" \| "design"/);
    assert.match(INTENT_SYSTEM, /"design" — they want NEW visual brand assets created from scratch/);
    assert.match(INTENT_SYSTEM, /Not for changing how\s+an existing screen looks/);
  });

  test("a 'design' answer is accepted from the model and returned to the caller", () => {
    assert.match(src, /parsed\?\.intent === "design"/);
    assert.ok(src.includes('if (intent === "design") return "design";'));
  });

  test("typing it, saying it, and a one-shot task all reach the same function", () => {
    assert.ok(src.includes('trimmed === "/design" || trimmed.startsWith("/design ")'));
    assert.ok(src.includes('if (outcome === "design") {\n            await runDesignJob(trimmed);'));
    assert.ok(src.includes('if (outcome === "design") {\n        await runDesignJob(instructions.trim());\n        return;'));
  });

  test("the models are the configured set, falling back sensibly, and the look uses a vision model", () => {
    assert.ok(src.includes("config.models.designer ?? config.models.planner"));
    assert.ok(src.includes("config.models.designerVision ?? config.models.verifierVision ?? config.models.editorVision ?? config.models.verifier"));
  });

  test("the pick is asked through the same channel as every other question, with the recommended one as the fallback", () => {
    assert.match(src, /id: `design_\$\{Date\.now\(\)\}`,\n\s+kind: "blocking",\n\s+prompt,\n\s+choices,\n\s+allowCustom: false,\n\s+fallback,/);
  });

  test("the browser used to look is always closed, even when the job fails", () => {
    assert.match(src, /finally \{\n\s+await renderer\?\.close\(\);/);
  });

  test("/help lists it", () => {
    assert.ok(src.includes("/design <what>"));
  });
});

describe("the Designer's config", () => {
  test("defaults are bounded and the model lists are optional", () => {
    const c = ConfigSchema.parse({});
    assert.deepEqual(c.designer, { candidates: 6, rounds: 2, maxCalls: 60, outputDir: "brand", typography: true, competitors: true, guidelines: true });
    assert.equal(c.models.designer, undefined);
    assert.equal(c.models.designerVision, undefined);
  });

  test("a set of models from different providers is accepted; silly limits are not", () => {
    const c = ConfigSchema.parse({ models: { designer: ["openai/a", "google/b"], designerVision: ["google/b"] }, designer: { candidates: 8 } });
    assert.deepEqual(c.models.designer, ["openai/a", "google/b"]);
    assert.equal(c.designer.candidates, 8);
    assert.throws(() => ConfigSchema.parse({ designer: { maxCalls: 100000 } }));
    assert.throws(() => ConfigSchema.parse({ designer: { candidates: 0 } }));
  });
});
