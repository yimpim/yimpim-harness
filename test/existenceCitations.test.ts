/**
 * Existence reads the places a request cites. A requirement that names "DashboardScreen.kt:1720-2040" is judged from those lines in the FIRST look, instead of from wherever its
 * keywords happen to cluster and then, when that is not enough, from four more rounds of the stronger model over whole files.
 * The first block pins what existence did before (it must keep doing it for a requirement that cites nothing); the rest is the new behaviour.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findCandidates, windows, checkRequirements, citationsFor, type Requirement, type Call } from "../src/existence.js";
import { parseCodeRefs, mergeRefs, resolveRefs, unseenRanges, readRange } from "../src/codeContext.js";

const file = (rel: string, lines: number, at: Record<number, string> = {}) => ({ rel, text: Array.from({ length: lines }, (_, i) => at[i + 1] ?? `// filler ${i + 1}`).join("\n") });
const lowerOf = (files: { rel: string; text: string }[]) => new Map(files.map((f) => [f.rel, f.text.toLowerCase()]));
const req = (text: string, terms: string[] = []): Requirement => ({ id: "R1", text, terms });

describe("pinned: a requirement that cites nothing is found and shown exactly as before", () => {
  const files = [file("src/cart.ts", 60, { 30: "export function addToCart(item) { return cart.push(item); }" }), file("src/other.ts", 40, { 5: "export const unrelated = 1;" })];
  test("the candidates are the keyword-scored files, each with the windows around its best matches, and nothing cited changes them", () => {
    const r = req("The cart can add an item", ["addToCart"]);
    const before = findCandidates(r, files, lowerOf(files));
    assert.deepEqual(before.map((c) => c.file), ["src/cart.ts"]);
    assert.equal(before[0].snippet, windows(files[0].text, ["addtocart", "cart", "item"]));
    assert.deepEqual(findCandidates(r, files, lowerOf(files), new Set(), 4, false, new Set(), []), before, "an empty citation list is the old behaviour");
  });
  test("a file already named by the roadmap is still boosted, and a file outside test/doc/generated folders is still the only evidence", () => {
    const tests = [file("src/cart.ts", 10, { 3: "const cart = 1; // cart item" }), file("src/cart.test.ts", 10, { 3: "cart item cart item cart item" })];
    const out = findCandidates(req("cart item", ["cart"]), tests, lowerOf(tests));
    assert.deepEqual(out.map((c) => c.file), ["src/cart.ts"]);
  });
});

describe("the citation parser reads every style a spec uses", () => {
  const one = (t: string) => parseCodeRefs(t);
  test("single lines, line ranges (hyphen, en dash), columns, #L anchors and prose forms", () => {
    assert.deepEqual(one("fix app/x.tsx:120"), [{ file: "app/x.tsx", from: 120, to: 120 }]);
    assert.deepEqual(one("see DashboardScreen.kt:1720-2040 for the card"), [{ file: "DashboardScreen.kt", from: 1720, to: 2040 }]);
    assert.deepEqual(one("DashboardScreen.kt:1720–2040"), [{ file: "DashboardScreen.kt", from: 1720, to: 2040 }]);
    assert.deepEqual(one("src/a.ts:12:8"), [{ file: "src/a.ts", from: 12, to: 12 }]);
    assert.deepEqual(one("src/a.ts#L10-L25"), [{ file: "src/a.ts", from: 10, to: 25 }]);
    assert.deepEqual(one("src/a.ts#L7"), [{ file: "src/a.ts", from: 7, to: 7 }]);
    assert.deepEqual(one("Home.kt lines 300-340"), [{ file: "Home.kt", from: 300, to: 340 }]);
    assert.deepEqual(one("Home.kt (line 88)"), [{ file: "Home.kt", from: 88, to: 88 }]);
    assert.deepEqual(one("Home.kt, L120-130"), [{ file: "Home.kt", from: 120, to: 130 }]);
    assert.deepEqual(one("Home.kt (lines 1720 to 2040)"), [{ file: "Home.kt", from: 1720, to: 2040 }]);
    assert.deepEqual(one("a.ts:50-40"), [{ file: "a.ts", from: 40, to: 50 }], "a backwards range is the same range");
  });
  test("a bare file name is a citation with no lines, and mixed styles in one spec all come out", () => {
    assert.deepEqual(one("the logic lives in lib/store.dart."), [{ file: "lib/store.dart" }]);
    const mixed = one("Port DashboardScreen.kt:1720-2040, then wire app/home.tsx:44 and check theme.ts and ui/Card.kt lines 5-9.");
    assert.deepEqual(mixed, [
      { file: "DashboardScreen.kt", from: 1720, to: 2040 },
      { file: "app/home.tsx", from: 44, to: 44 },
      { file: "theme.ts" },
      { file: "ui/Card.kt", from: 5, to: 9 },
    ]);
  });
  test("not a citation: a version number, a URL path's dot, a path out of the project, a plain sentence", () => {
    assert.deepEqual(one("upgrade to 1.2.3 and then 4.5"), []);
    assert.deepEqual(one("open ../secrets/key.ts:3 and node_modules/x/y.js:9"), []);
    assert.deepEqual(one("It works. Then it ships."), []);
  });
  test("ranges of one file that touch are one place; a bare name is dropped when the same file is cited with lines; resolution finds bare names by their last part and cuts to the file", () => {
    assert.deepEqual(mergeRefs([{ file: "a.ts", from: 10, to: 20 }, { file: "a.ts", from: 25, to: 30 }, { file: "a.ts", from: 200, to: 210 }, { file: "a.ts" }]), [
      { file: "a.ts", from: 10, to: 30 },
      { file: "a.ts", from: 200, to: 210 },
    ]);
    const files = [{ rel: "app/ui/DashboardScreen.kt", lines: 100 }, { rel: "x/Dup.kt", lines: 5 }, { rel: "y/Dup.kt", lines: 5 }, { rel: "z/Dup.kt", lines: 5 }];
    assert.deepEqual(resolveRefs([{ file: "DashboardScreen.kt", from: 60, to: 500 }], files), [{ file: "app/ui/DashboardScreen.kt", from: 60, to: 100 }]);
    assert.deepEqual(resolveRefs([{ file: "DashboardScreen.kt", from: 900, to: 950 }], files), [{ file: "app/ui/DashboardScreen.kt" }], "past the end: the whole file is the lead");
    assert.deepEqual(resolveRefs([{ file: "Dup.kt", from: 1, to: 2 }], files), [], "a name that is everywhere is not a lead");
    assert.deepEqual(resolveRefs([{ file: "missing.kt", from: 1, to: 2 }], files), []);
  });
});

describe("a citation reaches the first look", () => {
  // The keyword (StreakCard) is defined far from the lines the request cites, so only the citation can put those lines in front of the judge.
  const big = file("app/ui/DashboardScreen.kt", 2100, { 300: "fun StreakCard(days: Int) = Card { Text(\"Streak \" + days) }", 1795: "fun renderDashboardHeader() = Header(title = \"Dashboard\")" });
  const other = file("app/ui/Other.kt", 300, { 10: "fun unrelatedThing() = 1" });
  const files = [big, other];
  const lineCounts = files.map((f) => ({ rel: f.rel, lines: f.text.split("\n").length }));

  test("the lines a requirement cites lead its excerpt, and the cited file ranks first even when its words barely match", () => {
    const r = req("Show the streak at the top of the dashboard (DashboardScreen.kt:1790-1810)", ["StreakCard"]);
    const cited = citationsFor(r, [], lineCounts);
    assert.deepEqual(cited, [{ file: "app/ui/DashboardScreen.kt", from: 1790, to: 1810 }]);
    const out = findCandidates(r, files, lowerOf(files), new Set(), 4, false, new Set(), cited);
    assert.equal(out[0].file, "app/ui/DashboardScreen.kt");
    assert.match(out[0].snippet, /^1790: /m);
    assert.match(out[0].snippet, /1795: fun renderDashboardHeader/);
    assert.match(out[0].snippet, /1810: /);
    assert.ok(out[0].snippet.length <= 6200, "the cited lines are bounded");
  });
  test("a citation the model dropped from the requirement is taken from the request's own words, by the file the requirement names", () => {
    const source = parseCodeRefs("Move the streak card. DashboardScreen.kt:1790-1810 is where it is today.");
    const noLines = req("DashboardScreen shows the streak card", ["DashboardScreen.kt"]);
    assert.deepEqual(citationsFor(noLines, source, lineCounts), [{ file: "app/ui/DashboardScreen.kt", from: 1790, to: 1810 }]);
    assert.deepEqual(citationsFor(req("Something about dark mode", ["theme"]), source, lineCounts), [], "a requirement that names no such file takes none");
  });
  test("a cited test or doc file is not evidence (unless the requirement is about a test)", () => {
    const t = file("src/cart.test.ts", 50, { 10: "it('adds an item to the cart', () => {})" });
    const r = req("cart test (src/cart.test.ts:5-20)", ["cart"]);
    const cited = citationsFor(r, [], [{ rel: t.rel, lines: 50 }]);
    assert.deepEqual(findCandidates(r, [t], lowerOf([t]), new Set(), 4, false, new Set(), cited), []);
    const asTest: Requirement = { ...r, kind: "test" };
    assert.equal(findCandidates(asTest, [t], lowerOf([t]), new Set(), 4, false, new Set(), cited)[0].file, "src/cart.test.ts");
  });

  test("end to end: a cited requirement is settled by the first look; the stronger model is never asked and no whole file is sent", async () => {
    const calls: { sys: string; user: string }[] = [];
    const cheap: Call = async (m) => {
      calls.push({ sys: m[0].content, user: m[1].content });
      return JSON.stringify({ results: [{ id: "R1", verdict: "built", evidence: [{ file: "app/ui/DashboardScreen.kt", quote: 'fun renderDashboardHeader() = Header(title = "Dashboard")' }], missing: "", note: "" }] });
    };
    const strong: Call = async (m) => {
      calls.push({ sys: m[0].content, user: m[1].content });
      throw new Error("the stronger model should not be needed");
    };
    const r = req("Show the streak (DashboardScreen.kt:1790-1810)", ["StreakCard"]);
    const out = await checkRequirements({ call: strong, cheapCall: cheap, repoRoot: ".", requirements: [r], files, sourceText: "" });
    assert.equal(out[0].verdict, "built");
    assert.ok(calls.length >= 1);
    assert.match(calls[0].user, /1795: fun renderDashboardHeader/, "the cited lines were in the first excerpt");
    assert.ok(!calls.some((c) => /\(complete\)/.test(c.user)), "no whole file was sent");
  });

  test("a cited range in a very large file is what the whole-file round sends, not all 2,100 lines; a file that is only partly shown can never be called missing", async () => {
    const sent: string[] = [];
    const call: Call = async (m) => {
      sent.push(m[1].content);
      if (m[0].content.startsWith("You are shown ONE")) return JSON.stringify({ results: [{ id: "R1", verdict: "missing", evidence: [], missing: "", note: "not here" }] });
      return JSON.stringify({ results: [{ id: "R1", verdict: "unclear", evidence: [], missing: "", note: "cannot see" }] });
    };
    const r = req("Show the streak (DashboardScreen.kt:1790-1810)", ["StreakCard"]);
    const out = await checkRequirements({ call, repoRoot: ".", requirements: [r], files, sourceText: "" });
    const whole = sent.filter((s) => /^The file /.test(s));
    assert.ok(whole.length > 0, "the whole-file round ran");
    for (const s of whole) {
      assert.ok(s.length < 20_000, `sent ${s.length} characters, not the whole file`);
      assert.match(s, /Only parts of the file are shown/);
      assert.match(s, /1795: fun renderDashboardHeader/);
    }
    assert.notEqual(out[0].verdict, "missing", "absence in a part is not absence from the file");
  });
});

describe("the shared reading layer is the one heal uses", () => {
  test("readRange and unseenRanges are the same functions heal imports", async () => {
    const heal = await import("../src/healEdits.js");
    assert.equal(heal.readRange, readRange);
    assert.equal(heal.unseenRanges, unseenRanges);
    assert.deepEqual(unseenRanges(1, 100, [[10, 20], [50, 60]]), [[1, 9], [21, 49], [61, 100]]);
  });
});
