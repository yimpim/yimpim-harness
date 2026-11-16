/**
 * When Discovery runs out of turns, what it read is not thrown away: the
 * Planner gets those files as unconfirmed leads, not an empty allowlist.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractDiscoveryTargetFiles, extractTaskFindings, recoverDiscoveryOutput } from "../src/discoveryParsing.js";

const TURN_LIMIT = "Turn limit of 40 reached without complete task conclusion.";

describe("recoverDiscoveryOutput", () => {
  test("a Discovery that ran out of turns gives the Planner the files it read", () => {
    const out = recoverDiscoveryOutput(TURN_LIMIT, ["app/dashboard.tsx", "src/services/eventLog.ts"]);
    assert.deepEqual(extractDiscoveryTargetFiles(out), ["app/dashboard.tsx", "src/services/eventLog.ts"]);
  });

  test("they are labelled as unconfirmed leads, not as a verified list", () => {
    const findings = JSON.parse(extractTaskFindings(recoverDiscoveryOutput(TURN_LIMIT, ["a.ts"])));
    assert.match(findings.existingFiles[0].whyRelevant, /Unconfirmed/);
    assert.match(findings.uncertainties[0], /ran out of turns/);
    assert.match(findings.uncertainties[0], /not a verified list/);
  });

  test("the original text is kept, so nothing Discovery did say is lost", () => {
    assert.ok(recoverDiscoveryOutput(TURN_LIMIT, ["a.ts"]).includes(TURN_LIMIT));
  });

  test("an answer that already has a file list is returned untouched", () => {
    const good = '```json\n{"taskFindings":{"existingFiles":[{"path":"x.ts"}],"existingFlow":[],"newFilesNeeded":[],"uncertainties":[]}}\n```';
    assert.equal(recoverDiscoveryOutput(good, ["other.ts"]), good);
  });

  test("an answer with an empty file list is recovered from what was read", () => {
    const empty = '```json\n{"taskFindings":{"existingFiles":[],"existingFlow":[],"newFilesNeeded":[],"uncertainties":[]}}\n```';
    const out = recoverDiscoveryOutput(empty, ["a.ts"]);
    assert.notEqual(out, empty);
    assert.deepEqual(extractDiscoveryTargetFiles(out), ["a.ts"]);
  });

  test("if nothing was read either, there is nothing to invent", () => {
    assert.equal(recoverDiscoveryOutput(TURN_LIMIT, []), TURN_LIMIT);
  });
});
