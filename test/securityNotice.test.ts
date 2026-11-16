/**
 * Every security result carries the notice that it is a tool and not a guarantee.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SECURITY_NOTICE_SHORT, SECURITY_NOTICE_FULL } from "../src/disclaimer.js";
import { renderReview } from "../src/securityReview.js";

const src = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf-8");

describe("the security notice", () => {
  test("says it is not a guarantee, can miss problems, and is not professional advice", () => {
    for (const t of [SECURITY_NOTICE_SHORT, SECURITY_NOTICE_FULL]) {
      assert.match(t, /miss/i);
      assert.match(t, /not a penetration test/i);
      assert.match(t, /guarantee/i);
    }
    assert.match(SECURITY_NOTICE_FULL, /without warranty/i);
    assert.match(SECURITY_NOTICE_FULL, /permission to test/i);
  });
  test("a review result carries it, with or without findings", () => {
    assert.ok(renderReview({ ran: true, findings: [], dropped: 0, highRisk: [], notes: [] } as any).includes(SECURITY_NOTICE_SHORT));
  });
  test("the audit summary and the saved report carry it, and the README says it", () => {
    const audit = src("src/securityAudit.ts");
    assert.match(audit, /\$\{SECURITY_NOTICE_SHORT\}/);
    assert.match(audit, /writeFileSync\(file, `\$\{SECURITY_NOTICE_FULL\}/);
    assert.match(src("README.md"), /Security checks are tools, not a guarantee/);
  });
});
