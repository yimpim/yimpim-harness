import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXTRACT_SYSTEM, JUDGE_SYSTEM, checkExistence, checkRequirements, existencePlannerSection, findCandidates, parseRequirements, parseVerdicts, renderExistence, settle, validQuotes, windows, wordsOf, type Msg, type Requirement,
} from "../src/existence.js";
import { createRoadmap } from "../src/roadmapFlow.js";
import { loadRoadmap } from "../src/roadmap.js";

const repo = (files: Record<string, string> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ex-"));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
};
const LOGIN = "import { signInWithEmail } from '../auth/client';\nexport function LoginScreen() {\n  const [email, setEmail] = useState('');\n  const submit = () => signInWithEmail(email, password);\n  return <Form onSubmit={submit} />;\n}\n";
const ORDERS = "export function OrderList({ orders }) {\n  return orders.map((o) => <OrderRow key={o.id} order={o} />);\n}\n";
const PROJECT = { "src/screens/LoginScreen.tsx": LOGIN, "src/screens/OrderList.tsx": ORDERS, "src/utils/format.ts": "export const money = (n) => n.toFixed(2);\n", "src/a.test.ts": "signInWithEmail('x')", "docs/spec.ts": "export const LoginScreen = 1;" };
const req = (id: string, text: string, terms: string[] = []): Requirement => ({ id, text, terms });

describe("splitting a request into requirements", () => {
  test("not a feature request means nothing is checked; junk is no answer; ids, caps and terms are tidied", () => {
    assert.deepEqual(parseRequirements(JSON.stringify({ applies: false, requirements: [{ text: "x" }] })), { applies: false, requirements: [{ id: "R1", text: "x", terms: [] }] });
    assert.equal(parseRequirements("not json"), null);
    const r = parseRequirements(JSON.stringify({ applies: true, requirements: Array.from({ length: 20 }, (_, i) => ({ text: `req ${i}`, terms: ["LoginScreen", "ab", "x".repeat(80), "a", "b", "c", "d", "e", "f", "g"] })) }), 12)!;
    assert.equal(r.requirements.length, 12);
    assert.equal(r.requirements[0].id, "R1");
    assert.deepEqual(r.requirements[0].terms.slice(0, 1), ["LoginScreen"]);
    assert.ok(r.requirements[0].terms.length <= 6 && r.requirements[0].terms.every((t) => t.length >= 3 && t.length <= 40));
    assert.equal(parseRequirements(JSON.stringify({ applies: true, requirements: [] }))!.applies, false, "applies with nothing to check is not applicable");
  });
  test("the extractor is told what is and is not a feature request", () => {
    assert.match(EXTRACT_SYSTEM, /bug fix.*refactor/s);
    assert.match(EXTRACT_SYSTEM, /search terms/);
    assert.match(JUDGE_SYSTEM, /related code is not an implementation/i);
    assert.match(JUDGE_SYSTEM, /copied EXACTLY/);
  });
  test("words are split from camelCase, short and filler words dropped", () => {
    assert.deepEqual(wordsOf("The user can reset passwordHash for orders"), ["reset", "password", "hash", "orders"]);
  });
});

describe("finding the code that would implement a requirement", () => {
  const files = Object.entries(PROJECT).map(([rel, text]) => ({ rel, text }));
  const lower = new Map(files.map((f) => [f.rel, f.text.toLowerCase()]));
  test("the file with the terms ranks first; tests and docs are never candidates", () => {
    const c = findCandidates(req("R1", "Users can sign in with email", ["LoginScreen", "signInWithEmail"]), files, lower);
    assert.equal(c[0].file, "src/screens/LoginScreen.tsx");
    assert.ok(!c.some((x) => /test|docs/.test(x.file)));
    assert.match(c[0].snippet, /\d+: .*signInWithEmail\(email, password\)/);
  });
  test("a shortlisted file is searched first, and a requirement matching nothing has no candidates", () => {
    const boosted = findCandidates(req("R2", "orders listing"), files, lower, new Set(["src/utils/format.ts"]));
    assert.ok(boosted.some((x) => x.file === "src/utils/format.ts"));
    assert.deepEqual(findCandidates(req("R3", "push notifications", ["fcmToken"]), files, lower), []);
  });
  test("a window is numbered lines around the best matches", () => {
    const w = windows("a\nb\nneedle here\nc\nd", ["needle"], 1);
    assert.equal(w, "2: b\n3: needle here\n4: c");
    assert.match(windows("x\ny", ["nothing"]), /^1: x/);
  });
});

describe("a quote is only worth something if it is real", () => {
  const by = new Map(Object.entries(PROJECT));
  test("a verbatim quote, with different whitespace, is real; an invented, short, test-file or unknown-file one is not", () => {
    assert.equal(validQuotes([{ file: "src/screens/LoginScreen.tsx", quote: "const submit =   () => signInWithEmail(email, password);" }], by).length, 1);
    assert.equal(validQuotes([{ file: "src/screens/LoginScreen.tsx", quote: "const submit = () => signUpWithMagicLink(email);" }], by).length, 0, "invented");
    assert.equal(validQuotes([{ file: "src/screens/LoginScreen.tsx", quote: "useState" }], by).length, 0, "too short to mean anything");
    assert.equal(validQuotes([{ file: "src/a.test.ts", quote: "signInWithEmail('x')" }], by).length, 0, "a test is not the feature");
    assert.equal(validQuotes([{ file: "src/missing.ts", quote: "export function whatever() {}" }], by).length, 0);
  });
  test("built or partial with no real quote becomes unclear; missing and partial keep what they should", () => {
    const r = req("R1", "login");
    const real = { file: "src/screens/LoginScreen.tsx", quote: "export function LoginScreen() {" };
    assert.equal(settle({ id: "R1", verdict: "built", evidence: [real], missing: "", note: "" }, r, by).verdict, "built");
    const faked = settle({ id: "R1", verdict: "built", evidence: [{ file: "src/screens/LoginScreen.tsx", quote: "this is not in the file at all" }], missing: "", note: "looks done" }, r, by);
    assert.equal(faked.verdict, "unclear");
    assert.match(faked.note, /Claimed built but gave no quote that exists/);
    assert.equal(settle({ id: "R1", verdict: "partial", evidence: [], missing: "x", note: "" }, r, by).verdict, "unclear");
    const partial = settle({ id: "R1", verdict: "partial", evidence: [real], missing: "password reset", note: "" }, r, by);
    assert.deepEqual([partial.verdict, partial.missing], ["partial", "password reset"]);
    assert.equal(settle({ id: "R1", verdict: "missing", evidence: [], missing: "ignored", note: "" }, r, by).missing, "");
  });
  test("verdicts are read strictly: an unknown verdict is unclear, a result with no id is dropped", () => {
    const v = parseVerdicts(JSON.stringify({ results: [{ id: "R1", verdict: "done!" }, { verdict: "built" }, { id: "R2", verdict: "built", evidence: [{ file: "./src/a.ts", quote: "q" }] }] }));
    assert.deepEqual(v.map((x) => [x.id, x.verdict]), [["R1", "unclear"], ["R2", "built"]]);
    assert.equal(v[1].evidence[0].file, "src/a.ts");
  });
});

describe("checking requirements against the code", () => {
  const judgeAs = (fn: (user: string) => object | string, seen: string[] = []) => async (m: Msg[]) => {
    seen.push(m[1].content);
    const r = fn(m[1].content);
    return typeof r === "string" ? r : JSON.stringify(r);
  };
  test("a real implementation is built, an invented claim is unclear, and a requirement matching no code never costs a model call", async () => {
    const dir = repo(PROJECT);
    const seen: string[] = [];
    const call = judgeAs(() => ({ results: [
      { id: "R1", verdict: "built", evidence: [{ file: "src/screens/LoginScreen.tsx", quote: "export function LoginScreen() {" }], note: "present" },
      { id: "R2", verdict: "built", evidence: [{ file: "src/screens/OrderList.tsx", quote: "an invented line of code here" }], note: "looks done" },
    ] }), seen);
    const out = await checkRequirements({ call, repoRoot: dir, requirements: [req("R1", "Users can sign in with email", ["LoginScreen"]), req("R2", "Orders are listed", ["OrderList"]), req("R3", "Push notifications arrive", ["fcmToken"])] });
    assert.deepEqual(out.map((o) => o.verdict), ["built", "unclear", "missing"]);
    assert.equal(seen.length, 2, "one call for the two that had code, then a second look at the one not clearly built");
    assert.ok(seen.every((m) => !m.includes("R3")), "the one with no code was not even asked about");
    assert.match(out[2].note, /No code in the project matched it/);
  });
  test("requirements go to the model four at a time", async () => {
    const dir = repo(PROJECT);
    const seen: string[] = [];
    const reqs = Array.from({ length: 9 }, (_, i) => req(`R${i + 1}`, "login screen", ["LoginScreen"]));
    await checkRequirements({ call: judgeAs(() => ({ results: [] }), seen), repoRoot: dir, requirements: reqs });
    // three batches of up to four, then every one that could not be judged gets a second look, two at a time
    assert.equal(seen.length, 3 + 5);
  });
  test("a model that fails or skips a requirement leaves it unclear, never built, and never throws", async () => {
    const dir = repo(PROJECT);
    const failing = await checkRequirements({ call: async () => { throw new Error("down"); }, repoRoot: dir, requirements: [req("R1", "login", ["LoginScreen"])] });
    assert.equal(failing[0].verdict, "unclear");
    const skipped = await checkRequirements({ call: judgeAs(() => ({ results: [] })), repoRoot: dir, requirements: [req("R1", "login", ["LoginScreen"])] });
    assert.match(skipped[0].note, /could not be completed/);
  });
  test("a 'missing' verdict where closely matching code exists is flagged, so it is checked before it is rebuilt", async () => {
    const dir = repo(PROJECT);
    const out = await checkRequirements({ call: judgeAs(() => ({ results: [{ id: "R1", verdict: "missing", note: "not there" }] })), repoRoot: dir, requirements: [req("R1", "sign in with email", ["LoginScreen", "signInWithEmail", "email"])] });
    assert.equal(out[0].verdict, "missing");
    assert.match(out[0].note, /code that matched closely was found in src\/screens\/LoginScreen\.tsx/);
  });
});

describe("the whole check", () => {
  const model = (extract: object | Error, verdicts: object = { results: [] }, seen: Msg[][] = []) => async (m: Msg[]) => {
    seen.push(m);
    if (/decide whether a software request is about FEATURES/.test(m[0].content)) {
      if (extract instanceof Error) throw extract;
      return JSON.stringify(extract);
    }
    return JSON.stringify(verdicts);
  };
  test("a bug fix is not a feature request: one cheap call, nothing searched", async () => {
    const seen: Msg[][] = [];
    const r = await checkExistence({ call: model({ applies: false, requirements: [] }, {}, seen), repoRoot: repo(PROJECT), request: "fix the crash on login" });
    assert.deepEqual([r.applies, r.items.length, r.allBuilt], [false, 0, false]);
    assert.equal(seen.length, 1);
  });
  test("the named spec reaches the extractor, and everything built means allBuilt", async () => {
    const seen: Msg[][] = [];
    const call = model(
      { applies: true, requirements: [{ text: "Users can sign in with email", terms: ["LoginScreen"] }] },
      { results: [{ id: "R1", verdict: "built", evidence: [{ file: "src/screens/LoginScreen.tsx", quote: "export function LoginScreen() {" }], note: "" }] },
      seen
    );
    const r = await checkExistence({ call, repoRoot: repo(PROJECT), request: "build login per the spec", docs: "SPEC: users sign in with an email address" });
    assert.match(seen[0][1].content, /A document the request names \(the spec\):\nSPEC: users sign in/);
    assert.equal(r.allBuilt, true);
  });
  test("one requirement not built means not allBuilt; an extraction failure says nothing was checked", async () => {
    const call = model({ applies: true, requirements: [{ text: "login", terms: ["LoginScreen"] }, { text: "push notifications", terms: ["fcmToken"] }] }, { results: [{ id: "R1", verdict: "built", evidence: [{ file: "src/screens/LoginScreen.tsx", quote: "export function LoginScreen() {" }] }] });
    assert.equal((await checkExistence({ call, repoRoot: repo(PROJECT), request: "r" })).allBuilt, false);
    const failed = await checkExistence({ call: model(new Error("down")), repoRoot: repo(PROJECT), request: "r" });
    assert.equal(failed.applies, false);
    assert.match(failed.note, /nothing was checked against the code/);
  });
  test("the report shows what is built with its evidence, what is partial and missing; the planner is told to reuse and plan only the rest", () => {
    const r = {
      applies: true, allBuilt: false, note: "",
      items: [
        { req: req("R1", "Users can sign in"), verdict: "built" as const, evidence: [{ file: "src/a.ts", quote: "export function LoginScreen() {" }], missing: "", note: "" },
        { req: req("R2", "Orders listed with filters"), verdict: "partial" as const, evidence: [{ file: "src/o.ts", quote: "orders.map((o) => <OrderRow />)" }], missing: "the filters", note: "" },
        { req: req("R3", "Push notifications"), verdict: "missing" as const, evidence: [], missing: "", note: "" },
        { req: req("R4", "Something vague"), verdict: "unclear" as const, evidence: [], missing: "", note: "too vague" },
      ],
    };
    const text = renderExistence(r);
    for (const re of [/Already built \(1\):[\s\S]*Users can sign in[\s\S]*src\/a\.ts: `export function LoginScreen/, /Partly built \(1\):[\s\S]*still missing: the filters/, /Not built \(1\):[\s\S]*Push notifications/, /Could not tell \(1\):[\s\S]*too vague/]) assert.match(text, re);
    const section = existencePlannerSection(r);
    assert.match(section, /Do NOT rebuild or rewrite it: reuse it, and plan only what is partial or missing/);
    assert.match(section, /Already built:\n- Users can sign in -> src\/a\.ts/);
    assert.match(section, /Partly built \(extend the existing code in place\):\n- Orders listed with filters -> exists in src\/o\.ts.*still missing: the filters/);
    assert.match(section, /Not built \(these are the work\):\n- Push notifications\n/);
    assert.match(section, /Not determined \(.*do not rebuild them blindly\):\n- Something vague \(too vague\)/);
    assert.equal(existencePlannerSection({ ...r, items: [r.items[2], r.items[3]] }), "", "nothing built, nothing to tell the planner");
  });
});

import { SHORT_EXCERPT } from "../src/existence.js";

describe("a short excerpt is not evidence that something is missing", () => {
  const judgeAs = (fn: (user: string) => object | string, seen: string[] = []) => async (m: Msg[]) => {
    seen.push(m[1].content);
    const r = fn(m[1].content);
    return typeof r === "string" ? r : JSON.stringify(r);
  };
  test("the wording models use for it is recognised", () => {
    for (const m of [
      "The excerpt does not show the run being appended as a distinct worker.",
      "The excerpts do not establish that the app rebuilds from the complete event list.",
      "The excerpts do not show per-agent usage being applied from status.",
      "The snippet provided does not include the unmatched-agent fallback.",
    ]) assert.match(m, SHORT_EXCERPT, m);
    for (const m of ["The filters are not implemented", "There is no retry on 401", "Only the Android half exists"]) assert.doesNotMatch(m, SHORT_EXCERPT, m);
  });
  test("such a partial becomes unclear, with the evidence kept and no 'missing' claim", () => {
    const byRel = new Map([["src/screens/LoginScreen.tsx", LOGIN]]);
    const c = settle(
      { id: "R1", verdict: "partial", evidence: [{ file: "src/screens/LoginScreen.tsx", quote: "export function LoginScreen() {" }], missing: "The excerpt does not show the sign-in call.", note: "" },
      req("R1", "sign in"), byRel
    );
    assert.equal(c.verdict, "unclear");
    assert.equal(c.missing, "");
    assert.equal(c.evidence.length, 1);
    assert.match(c.note, /not shown to be absent/);
  });
  test("a real gap stays partial", () => {
    const byRel = new Map([["src/screens/LoginScreen.tsx", LOGIN]]);
    const c = settle(
      { id: "R1", verdict: "partial", evidence: [{ file: "src/screens/LoginScreen.tsx", quote: "export function LoginScreen() {" }], missing: "There is no password reset link.", note: "" },
      req("R1", "sign in"), byRel
    );
    assert.equal(c.verdict, "partial");
    assert.equal(c.missing, "There is no password reset link.");
  });
  test("the judge is told a short excerpt is never a reason for partial", () => {
    assert.match(JUDGE_SYSTEM, /excerpts are too short to see all of it/);
    assert.match(JUDGE_SYSTEM, /never a reason for partial/);
  });
  test("a second, longer look settles what the first could not, and a better answer replaces the first", async () => {
    const dir = repo(PROJECT);
    const seen: string[] = [];
    let n = 0;
    const call = judgeAs(() => (n++ === 0
      ? { results: [{ id: "R1", verdict: "unclear", note: "excerpt too short" }] }
      : { results: [{ id: "R1", verdict: "built", evidence: [{ file: "src/screens/LoginScreen.tsx", quote: "export function LoginScreen() {" }], note: "seen in full" }] }), seen);
    const out = await checkRequirements({ call, repoRoot: dir, requirements: [req("R1", "Users can sign in with email", ["LoginScreen"])] });
    assert.equal(out[0].verdict, "built");
    assert.equal(seen.length, 2);
    assert.match(seen[1], /longer/);
  });
  test("a built one is not looked at twice", async () => {
    const dir = repo(PROJECT);
    const seen: string[] = [];
    const call = judgeAs(() => ({ results: [{ id: "R1", verdict: "built", evidence: [{ file: "src/screens/LoginScreen.tsx", quote: "export function LoginScreen() {" }], note: "" }] }), seen);
    await checkRequirements({ call, repoRoot: dir, requirements: [req("R1", "Users can sign in with email", ["LoginScreen"])] });
    assert.equal(seen.length, 1);
  });
});

describe("the roadmap does not plan what already exists", () => {
  const IDEA = { conventions: [], assumptions: [], questions: [], units: [
    { title: "Login screen", area: "Auth", summary: "Sign in with email", acceptance: ["a user can sign in"] },
    { title: "Order history", area: "Orders", summary: "List a user's orders with filters", acceptance: ["orders are listed"] },
    { title: "Push notifications", area: "Alerts", summary: "Notify about new orders", acceptance: ["a push arrives"] },
  ] };
  const complete = (calls: string[] = []) => async (m: Msg[]) => {
    calls.push(m[0].content.slice(0, 40));
    if (/ALREADY implemented/.test(m[0].content)) {
      return JSON.stringify({ results: [
        { id: "R1", verdict: "built", evidence: [{ file: "src/screens/LoginScreen.tsx", quote: "export function LoginScreen() {" }], note: "" },
        { id: "R2", verdict: "partial", evidence: [{ file: "src/screens/OrderList.tsx", quote: "orders.map((o) => <OrderRow key={o.id} order={o} />);" }], missing: "the filters", note: "" },
      ] });
    }
    return JSON.stringify(IDEA);
  };
  test("an unit the code already has is marked done with its file, a partly built one says what is missing, and a missing one is left to do", async () => {
    const dir = repo(PROJECT);
    const out = await createRoadmap({ repoRoot: dir, complete: complete() as any }, { goal: "bring the app up to the spec" });
    assert.equal(out.ok, true);
    const rm = loadRoadmap(dir)!;
    const by = (t: string) => rm.units.find((u) => u.title === t)!;
    assert.equal(by("Login screen").status, "done");
    assert.deepEqual(by("Login screen").done!.files, ["src/screens/LoginScreen.tsx"]);
    assert.match(by("Login screen").done!.summary!, /Already built, verified in the code: src\/screens\/LoginScreen\.tsx/);
    assert.equal(by("Order history").status, "todo");
    assert.match(by("Order history").summary, /Already in place: src\/screens\/OrderList\.tsx\. Still missing: the filters\./);
    assert.equal(by("Push notifications").status, "todo");
    assert.match(out.text, /1 unit\(s\) are already built \(marked done, with the file as evidence\) and 1 are partly built/);
  });
  test("it can be turned off, and an empty project asks the model nothing extra", async () => {
    const off: string[] = [];
    await createRoadmap({ repoRoot: repo(PROJECT), complete: complete(off) as any }, { goal: "g", verifyExisting: false });
    assert.ok(!off.some((c) => /ALREADY implemented/.test(c)));
    const empty: string[] = [];
    const dir = repo();
    await createRoadmap({ repoRoot: dir, complete: complete(empty) as any }, { goal: "g" });
    assert.ok(!empty.some((c) => /judge whether requirements/i.test(c)));
    assert.deepEqual(loadRoadmap(dir)!.units.map((u) => u.status), ["todo", "todo", "todo"]);
  });
});

describe("how it reaches a task", () => {
  test("a request is checked before it is planned; everything built stops there; only the rest reaches the Planner", () => {
    const idx = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    assert.match(idx, /async function checkWhatExists\(/);
    assert.match(idx, /if \(!config\.existence\.enabled\) return "task";/);
    assert.match(idx, /if \(found\.allBuilt\) \{[\s\S]*?return "handled";/);
    assert.match(idx, /existenceSection = existencePlannerSection\(found\);/);
    assert.match(idx, /\$\{lastFailureSection\}\$\{securitySection\}\$\{existenceSection\}/);
    const cfg = fs.readFileSync(new URL("../src/config.ts", import.meta.url), "utf-8");
    assert.match(cfg, /existence: z\s*\.object\(\{[\s\S]*?enabled: z\.boolean\(\)\.default\(true\)[\s\S]*?maxRequirements: z\.number\(\)\.int\(\)\.min\(1\)\.max\(30\)\.default\(12\)/);
  });
});

describe("a big request run as one task is checked too", () => {
  test("the plain task path, the interactive 'single task' choice and the unattended program path all check first", () => {
    const idx = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    assert.equal((idx.match(/await checkWhatExists\(/g) ?? []).length, 4, "plain task, the program question, single chosen, and the unattended program path");
    assert.match(idx, /programResult === "single" \? \(\(await checkWhatExists\(trimmed, client, config, repoRoot\)\) === "handled" \? "handled" : "task"\)/);
    assert.match(idx, /if \(said !== "single"\) return;\s*if \(\(await checkWhatExists\(instructions\.trim\(\), client, config, repoRoot\)\) === "handled"\) return;/);
  });
});

describe("a request too big for one task goes to a roadmap by itself", () => {
  const idx = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
  test("the settings default to on, with a threshold of 6 things still missing", () => {
    const cfg = fs.readFileSync(new URL("../src/config.ts", import.meta.url), "utf-8");
    assert.match(cfg, /roadmap: z\s*\.object\(\{[\s\S]*?autoRoute: z\.boolean\(\)\.default\(true\),\s*autoMinRequirements: z\.number\(\)\.int\(\)\.min\(2\)\.max\(30\)\.default\(6\)/);
  });
  test("it is decided from what is still missing; unattended with nothing to measure, a roadmap; borderline still asks", () => {
    assert.match(idx, /const clearlyBig = left === null \? !canAsk : left >= min;/);
    assert.match(idx, /if \(clearlyBig && !roadmapExists\) \{[\s\S]*?return await planRoadmap\(\);/);
    assert.match(idx, /if \(!canAsk\) return "single";[\s\S]*?This looks bigger than one task/);
    assert.match(idx, /if \(!offer \|\| !canAsk\) \{[\s\S]*?\/roadmap run/);
  });
  test("the check is paid once per request, and the unattended path uses the same decision", () => {
    assert.match(idx, /if \(existenceChecked\?\.text === text\) return "task";/);
    assert.match(idx, /const said = await handleProgram\(instructions\.trim\(\), programReferenceHint, false\);\s*if \(said !== "single"\) return;/);
  });
});

describe("a comment is not the feature", () => {
  const by = new Map([["src/a.ts", "/**\n * Sends the reminder email to the user.\n */\nexport function sendReminder(user) {\n  return mailer.send(user.email, 'reminder');\n}\n"], ["src/b.py", "# handles the export\ndef export_csv(rows):\n    return write(rows)\n"]]);
  test("a quote of only comment lines is rejected; one with a line of code is accepted", async () => {
    const { hasCode } = await import("../src/existence.js");
    assert.equal(validQuotes([{ file: "src/a.ts", quote: " * Sends the reminder email to the user." }], by).length, 0);
    assert.equal(validQuotes([{ file: "src/a.ts", quote: "/**\n * Sends the reminder email to the user.\n */" }], by).length, 0);
    assert.equal(validQuotes([{ file: "src/a.ts", quote: "export function sendReminder(user) {" }], by).length, 1);
    assert.equal(validQuotes([{ file: "src/b.py", quote: "# handles the export" }], by).length, 0);
    assert.equal(validQuotes([{ file: "src/b.py", quote: "def export_csv(rows):" }], by).length, 1);
    assert.equal(hasCode("// only a comment"), false);
    assert.equal(hasCode("// note\nconst a = 1;"), true);
    assert.equal(hasCode("#include <stdio.h>"), false, "a preprocessor line is not counted as code by itself, which is the safe side");
  });
  test("a built verdict backed only by a comment becomes unclear", () => {
    const r = settle({ id: "R1", verdict: "built", evidence: [{ file: "src/a.ts", quote: " * Sends the reminder email to the user." }], missing: "", note: "" }, req("R1", "reminder emails"), by);
    assert.equal(r.verdict, "unclear");
  });
  test("a comment mentioning the feature does not pull the window away from the code that does it", () => {
    const text = ["// reminder reminder reminder email", "x", "y", "z", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "mailer.send(reminder)"].join("\n");
    assert.match(windows(text, ["reminder", "email"], 2), /27: mailer\.send\(reminder\)/);
  });
  test("the judge is told a comment is not evidence; big central files are searched", () => {
    assert.match(JUDGE_SYSTEM, /never a comment, docstring or documentation/);
    const src = fs.readFileSync(new URL("../src/existence.ts", import.meta.url), "utf-8");
    assert.match(src, /collectFiles\(o\.repoRoot, 4000, 1_500_000\)/);
  });
});

import { unitsFor } from "../src/existence.js";
import { builtByUnits, emptyRoadmap, addUnits, markDone, saveRoadmap, archiveFinishedRoadmap } from "../src/roadmap.js";

describe("the roadmap is read first, then the code confirms it", () => {
  const built = [
    { id: "U003", title: "Match Timeline Cards and Q&A", summary: "Adjust timeline card rendering and question-and-answer presentation", files: ["src/screens/LoginScreen.tsx"], commit: "c1a017c5b496", openItems: [] },
    { id: "U009", title: "Port Post-Splash Routing", summary: "launch route", files: ["src/navigation/launchRoute.ts"], openItems: ["device test"] },
  ];
  test("a requirement is matched to the done units that cover it", () => {
    const r = req("R1", "Timeline cards show question and answer presentation inside the worker", ["DashboardTimeline"]);
    assert.deepEqual(unitsFor(r, built).map((u) => u.id), ["U003"]);
    assert.deepEqual(unitsFor(req("R2", "Push notifications arrive", ["fcmToken"]), built), []);
  });
  test("the judge is told what the roadmap recorded, as a lead and not as proof", async () => {
    const dir = repo(PROJECT);
    const seen: string[] = [];
    const call = async (m: Msg[]) => { seen.push(m[1].content); return JSON.stringify({ results: [{ id: "R1", verdict: "built", evidence: [{ file: "src/screens/LoginScreen.tsx", quote: "export function LoginScreen() {" }], note: "" }] }); };
    const out = await checkRequirements({ call, repoRoot: dir, built, requirements: [req("R1", "Timeline cards show question and answer presentation", ["LoginScreen"])] });
    assert.match(seen[0], /The roadmap recorded this as built by: U003 "Match Timeline Cards and Q&A" \(commit c1a017c5\)/);
    assert.match(seen[0], /a lead, not proof/);
    assert.equal(out[0].verdict, "built", "still needs a quote from the code");
  });
  test("a roadmap's claim alone never makes something built", async () => {
    const dir = repo(PROJECT);
    const call = async () => JSON.stringify({ results: [{ id: "R1", verdict: "built", evidence: [{ file: "src/x.ts", quote: "nothing like this exists in any file" }], note: "roadmap says so" }] });
    const out = await checkRequirements({ call, repoRoot: dir, built, requirements: [req("R1", "Timeline cards show question and answer presentation", ["LoginScreen"])] });
    assert.notEqual(out[0].verdict, "built");
  });
  test("done units are read from the active roadmap and from archived ones", () => {
    const dir = repo();
    const rm = emptyRoadmap("g", "idea");
    addUnits(rm, [{ title: "One" }, { title: "Two" }]);
    markDone(rm, "U001", { files: ["src/a.ts"], commit: "abc" });
    saveRoadmap(dir, rm);
    assert.deepEqual(builtByUnits(dir).map((u) => u.id), ["U001"]);
    markDone(rm, "U002", {});
    saveRoadmap(dir, rm);
    archiveFinishedRoadmap(dir);
    assert.deepEqual(builtByUnits(dir).map((u) => u.id), ["U001", "U002"]);
  });
});

import { wantsReportOnly } from "../src/existence.js";
import { userNamedFiles } from "../src/userFiles.js";

describe("an audit that only asks for findings", () => {
  test("the wording that means 'tell me, do not build' is recognised", () => {
    for (const t of [
      "check eference/timeline-port/EXPO_PORT_BRIEF.md and see if we complted it all already from our roadmap. if not let me know what is left before we work on anything",
      "compare the code to the spec, don't change anything",
      "just check what we have against the brief",
      "tell me what is still missing",
      "report what's left",
      "did we end up completing everything in the brief?",
      "are we done?",
      "have we finished everything in the roadmap?",
      "is everything in the spec built?",
      "what's still missing from the brief?",
      "what is left?",
      "how much is left to do",
    ]) assert.ok(wantsReportOnly(t), t);
    for (const t of [
      "build the login screen",
      "add push notifications and then check they work",
      "fix the crash on launch",
      "finish what is left in the brief",
      "complete everything in the brief",
      "do you know what is left? then build it",
      "is the settings screen missing a back button? add one",
      "what is left in the brief should be built now.",
    ]) assert.ok(!wantsReportOnly(t), t);
  });
  test("a typo in the front of a path still finds the document", () => {
    const dir = repo({ "reference/timeline-port/EXPO_PORT_BRIEF.md": "# brief", "reference/other/NOTES.md": "n" });
    assert.deepEqual(userNamedFiles("check eference/timeline-port/EXPO_PORT_BRIEF.md and see", dir), ["reference/timeline-port/EXPO_PORT_BRIEF.md"]);
    assert.deepEqual(userNamedFiles("see wrongdir/timeline-port/EXPO_PORT_BRIEF.md", dir), ["reference/timeline-port/EXPO_PORT_BRIEF.md"]);
    assert.deepEqual(userNamedFiles("see nothing/at/MISSING_FILE.md", dir), []);
  });
  test("a report-only audit prints the findings and plans nothing", () => {
    const t = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    assert.match(t, /reportOnly && !found\.allBuilt/);
    assert.match(t, /Nothing was planned or changed, as you asked/);
  });
});

describe("a folder being ported from is never proof that the project has it", () => {
  const KT = "fun roadmaps() { if (event.state.equals(\"reset\", true)) roadmaps.remove(event.roadmapId) }\n";
  const files = {
    "reference/android-ui/timeline/TimelineReducer.kt": KT,
    "reference/timeline-port/expo_reference/timeline.ts": "export function workerTypeOf() { return 'EDITOR'; }\n",
    "src/preferences/theme.ts": "export const roadmapsEnabled = true;\n",
    "src/models/timeline.ts": "export function reduce() { return 1; }\n",
  };
  test("reference copies and the roadmap's own reference folder are not candidates; a folder that merely contains the word is", () => {
    const dir = repo(files);
    const seen: string[] = [];
    const call = async (m: Msg[]) => { seen.push(m[1].content); return JSON.stringify({ results: [] }); };
    return checkRequirements({ call, repoRoot: dir, requirements: [req("R1", "roadmaps reset removes the roadmap", ["roadmaps", "reset"])], exclude: [] }).then(() => {
      const text = seen.join("\n");
      assert.ok(!text.includes("reference/android-ui") && !text.includes("expo_reference"), text);
      assert.ok(text.includes("src/preferences/theme.ts"), "preferences/ is not a reference folder");
    });
  });
  test("a quote from a reference copy no longer counts as evidence", () => {
    const byRel = new Map([["reference/android-ui/timeline/TimelineReducer.kt", KT]]);
    assert.deepEqual(validQuotes([{ file: "reference/android-ui/timeline/TimelineReducer.kt", quote: "roadmaps.remove(event.roadmapId)" }], byRel), []);
  });
  test("an explicitly named reference folder is left out too", async () => {
    const dir = repo({ "legacy_app/Reducer.kt": KT, "src/models/timeline.ts": "export const x = 'roadmaps reset';\n" });
    const seen: string[] = [];
    const call = async (m: Msg[]) => { seen.push(m[1].content); return JSON.stringify({ results: [] }); };
    await checkRequirements({ call, repoRoot: dir, requirements: [req("R1", "roadmaps reset", ["roadmaps", "reset"])], exclude: ["legacy_app/"] });
    assert.ok(!seen.join("\n").includes("legacy_app"));
  });
});

import { isAuditFollowUp } from "../src/existence.js";

describe("a build request is not mistaken for an audit, and a follow-up to an audit carries its findings", () => {
  test("rules about what NOT to touch inside a build request do not make it report-only", () => {
    for (const t of [
      "Do these jobs in order. Do not touch files outside the job. Do not add dependencies.",
      "add a login screen but don't change the header",
      "Before we start, read the spec. Then build the cards.",
      "build X, without changing the public API",
    ]) assert.ok(!wantsReportOnly(t), t);
    for (const t of ["see what's done and let me know what is left before we work on anything", "compare to the spec, do not change anything", "just check it, we are not building anything yet"]) assert.ok(wantsReportOnly(t), t);
  });
  test("short pointers back at a report are follow-ups; new requests and report requests are not", () => {
    for (const t of ["lets work on what existence found", "do the rest", "finish what is left", "go ahead", "fix those", "build what the check found"]) assert.ok(isAuditFollowUp(t), t);
    for (const t of ["add a settings screen", "tell me what is left before we work on anything", "x".repeat(400)]) assert.ok(!isAuditFollowUp(t), t);
  });
  test("the next prompt after a report-only audit gets the request and the findings as context", () => {
    const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    assert.match(src, /lastAudit = \{ request: text\.slice\(0, 3000\), report: renderExistence\(found\)/);
    assert.match(src, /const audit = !advice && lastAudit && isAuditFollowUp\(trimmed\)/);
    assert.match(src, /Do only what it found missing or not determined/);
  });
});

describe("a request that lists numbered jobs becomes those jobs, in order", () => {
  const GOAL =
    "Read first: reference/APP_SPEC.md. Do these jobs in order. For each one, report what you changed.\n" +
    "1. Generic worker card. An unknown agent name becomes a plain card.\n" +
    "2. Designer and Security workers. Names containing design or secur get their own cards.\n" +
    "3. Longer questions. Show the whole prompt.\n" +
    "4. Roadmap card. Parse roadmap.state and show one card.";
  const MODEL_UNITS = { conventions: [], assumptions: [], questions: [], units: [
    { title: "Dashboard Domain Models", area: "Dashboard", summary: "models" },
    { title: "Roadmap Timeline Reducer", area: "Timeline", summary: "reducer" },
  ] };
  const call = async () => JSON.stringify(MODEL_UNITS);
  test("one unit per job, in the order given, each depending on the one before, with the report asked for", async () => {
    const dir = repo(PROJECT);
    const out = await createRoadmap({ repoRoot: dir, complete: call as any }, { goal: GOAL });
    assert.equal(out.ok, true);
    const rm = loadRoadmap(dir)!;
    assert.deepEqual(rm.units.map((u) => u.id), ["U001", "U002", "U003", "U004"]);
    assert.match(rm.units[0].title, /^Job 1: Generic worker card/);
    assert.match(rm.units[3].title, /^Job 4: Roadmap card/);
    assert.deepEqual(rm.units.map((u) => u.deps), [[], ["U001"], ["U002"], ["U003"]]);
    assert.match(rm.units[1].summary, /Do only job 2 of 4/);
    assert.match(rm.units[1].acceptance[0], /Report what changed, the tests run with their counts/);
    assert.ok(!rm.units.some((u) => /Dashboard Domain Models/.test(u.title)), "the model's own grouping was not used");
    assert.match(rm.brief ?? rm.goal, /Do these jobs in order/);
  });
  test("a reference folder does not turn the jobs back into file groups", async () => {
    const dir = repo({ ...PROJECT, "ref/a.kt": "fun a() {}\n", "ref/b.kt": "fun b() {}\n" });
    await createRoadmap({ repoRoot: dir, complete: call as any }, { goal: GOAL, referenceDir: "ref" });
    const rm = loadRoadmap(dir)!;
    assert.equal(rm.units.length, 4);
    assert.equal(rm.reference, undefined, "no reference coverage to chase: /roadmap sync would add file units");
  });
  test("a request with no numbered list is planned as before", async () => {
    const dir = repo(PROJECT);
    await createRoadmap({ repoRoot: dir, complete: call as any }, { goal: "bring the app up to the spec", verifyExisting: false });
    assert.deepEqual(loadRoadmap(dir)!.units.map((u) => u.title), ["Dashboard Domain Models", "Roadmap Timeline Reducer"]);
  });
});
