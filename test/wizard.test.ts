/**
 * The setup wizard and /model picker: the key is masked and never leaks into text, the picker searches the whole catalog with no
 * fixed cap, the one-model choice fills the right roles, and every wizard screen keeps stdin to itself and stays off the phone.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { CatalogModel } from "../src/models.js";
import {
  looksLikeOpenRouterKey, maskKey, sanitize, parseKeyInfo, checkKey, describeKey, spendLimitWarning, AUTH_KEY_URL,
} from "../src/wizard/keyCheck.js";
import {
  formatContext, formatPrice, modelLabel, matchesQuery, rankModels, currentFirst, vendorOf, VISIBLE_ROWS,
  rowLayout, wrapText, visibleWidth, pickOne, RAIL_WIDTH, RADIO_WIDTH,
} from "../src/wizard/modelPicker.js";
import { PassThrough, Writable } from "node:stream";
import { canRunWizard, holdRawMode, rawHoldCount } from "../src/wizard/prompts.js";
import { chainsForOneModel, summaryLines, emptyChains, NON_INTERACTIVE_HELP } from "../src/setup.js";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab";
const src = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf-8").replace(/\r\n/g, "\n");

const m = (id: string, o: Partial<CatalogModel> = {}): CatalogModel => ({
  id, name: o.name ?? id, contextLength: o.contextLength ?? 128_000, promptCost: o.promptCost ?? 1, completionCost: o.completionCost ?? 2,
  supportsTools: o.supportsTools ?? true, supportsVision: o.supportsVision ?? false,
});

describe("the OpenRouter key is never shown", () => {
  test("masked to the prefix and last four characters", () => {
    assert.equal(maskKey(KEY), "sk-or-••••89ab");
    assert.equal(maskKey("short"), "••••");
    assert.equal(maskKey("abcdefghijklmnop"), "••••mnop");
  });
  test("the format check only recognises sk-or- keys, and is used as a warning, not a block", () => {
    assert.equal(looksLikeOpenRouterKey(KEY), true);
    assert.equal(looksLikeOpenRouterKey("sk-proj-abc"), false);
    assert.equal(looksLikeOpenRouterKey(""), false);
    assert.match(src("setup.ts"), /doesn't look like an OpenRouter key[^]*Use it anyway\?/);
  });
  test("sanitize removes the key, and other credential-shaped text, from any message", () => {
    const out = sanitize(`request to openrouter failed for ${KEY} with Bearer ${KEY}`, KEY);
    assert.ok(!out.includes(KEY));
    assert.ok(!out.includes("0123456789abcdef0123"));
    assert.ok(!sanitize(`leaked ${KEY}`).includes(KEY), "the redaction rules catch it even without the key passed in");
  });
  test("the key prompt is a masked password field with •", () => {
    for (const f of ["setup.ts", "index.ts"]) assert.match(src(f), /password\(\{[^}]*mask: "•"/s, f);
  });
  test("the key is never written to the config file", () => {
    const setup = src("setup.ts");
    assert.match(setup, /writeGlobalConfig\(\{ \.\.\.current, models: chosen \}\)/);
    assert.doesNotMatch(setup, /writeGlobalConfig\([^)]*key/i);
    assert.match(setup, /storeApiKey\(key\)/);
  });
});

describe("checking the key live", () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("calls GET /auth/key with the key as a bearer token", async () => {
    let seen: { url: string; auth: string } | undefined;
    const fetchImpl = (async (url: any, init: any) => {
      seen = { url: String(url), auth: init.headers.authorization };
      return new Response(JSON.stringify({ data: { limit: 20, usage: 1.5 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await checkKey(KEY, { fetchImpl });
    assert.equal(seen?.url, AUTH_KEY_URL);
    assert.equal(seen?.auth, `Bearer ${KEY}`);
    assert.ok(r.ok && r.info.limit === 20 && r.info.usage === 1.5);
  });
  test("a rejected key, a server error and a network failure each come back as a reason without the key in it", async () => {
    const rejected = await checkKey(KEY, { fetchImpl: respond(401, { error: "bad" }) });
    assert.ok(!rejected.ok && /did not accept/.test(rejected.reason));
    const down = await checkKey(KEY, { fetchImpl: respond(503, {}) });
    assert.ok(!down.ok && /HTTP 503/.test(down.reason));
    const offline = await checkKey(KEY, {
      fetchImpl: (async () => { throw new Error(`getaddrinfo ENOTFOUND for ${KEY}`); }) as unknown as typeof fetch,
    });
    assert.ok(!offline.ok && /Could not reach OpenRouter/.test(offline.reason));
    for (const r of [rejected, down, offline]) assert.ok(!r.ok && !r.reason.includes(KEY));
  });
  test("a key with no spend limit gets the warning; one with a limit does not", () => {
    const none = parseKeyInfo({ data: { limit: null, usage: 0.25, label: "laptop" } });
    assert.equal(none.limit, null);
    assert.match(spendLimitWarning(none)!, /no spend limit/);
    assert.equal(describeKey(none), "laptop · $0.25 used · no spend limit");
    const capped = parseKeyInfo({ data: { limit: 10, limit_remaining: 7.5 } });
    assert.equal(spendLimitWarning(capped), undefined);
    assert.equal(describeKey(capped), "limit $10.00 ($7.50 left)");
  });
  test("an answer with unexpected fields is read safely, nothing guessed", () => {
    assert.deepEqual(parseKeyInfo({}), { label: undefined, usage: undefined, limit: null, limitRemaining: undefined, isFreeTier: undefined });
    assert.deepEqual(parseKeyInfo(null).limit, null);
  });
});

describe("the model picker searches the whole catalog", () => {
  const catalog = [
    m("google/gemini-flash-lite", { name: "Google: Gemini Flash Lite", promptCost: 0.1 }),
    m("deepseek/deepseek-v4", { name: "DeepSeek V4", promptCost: 0.3 }),
    m("google/gemini-pro", { name: "Google: Gemini Pro", promptCost: 1.25 }),
    m("anthropic/claude-sonnet", { name: "Anthropic: Claude Sonnet", promptCost: 3 }),
    m("acme/agemini-tune", { name: "Acme tune of gemini", promptCost: 0.05 }),
  ];
  test("every word must match the id or name", () => {
    assert.equal(matchesQuery(catalog[2], "gemini pro"), true);
    assert.equal(matchesQuery(catalog[2], "gemini flash"), false);
    assert.equal(matchesQuery(catalog[3], "ANTHROPIC"), true);
    assert.equal(matchesQuery(catalog[3], ""), true);
  });
  test("matches come first, best match first, ties cheapest first, and nothing is dropped", () => {
    const ranked = rankModels(catalog, "gemini");
    assert.equal(ranked.length, catalog.length, "the full list stays, so the picker can show N matches out of all of them");
    assert.deepEqual(ranked.slice(0, 3).map((x) => x.id), ["google/gemini-flash-lite", "google/gemini-pro", "acme/agemini-tune"]);
    assert.deepEqual(rankModels(catalog, "google").slice(0, 2).map((x) => x.id), ["google/gemini-flash-lite", "google/gemini-pro"]);
    assert.deepEqual(rankModels(catalog, "").map((x) => x.id), catalog.map((x) => x.id));
  });
  test("there is no fixed result cap: a search matching hundreds keeps all of them, and the list scrolls", () => {
    const big = Array.from({ length: 400 }, (_, i) => m(`google/gemini-${i}`));
    assert.equal(rankModels(big, "gemini").filter((x) => matchesQuery(x, "gemini")).length, 400);
    assert.ok(VISIBLE_ROWS >= 12 && VISIBLE_ROWS <= 15);
    const picker = src("wizard/modelPicker.ts");
    assert.doesNotMatch(picker, /slice\(0, ?12\)/);
    assert.match(picker, /maxItems: VISIBLE_ROWS/);
  });
  test("the current model is listed first", () => {
    assert.equal(currentFirst(catalog, "anthropic/claude-sonnet")[0].id, "anthropic/claude-sonnet");
    assert.equal(currentFirst(catalog, "gone/model")[0].id, catalog[0].id);
  });
  test("each row shows the id, price in and out per 1M tokens, the context window, the current marker and the name", () => {
    const row = modelLabel(m("google/gemini-pro", { name: "Gemini Pro", promptCost: 1.25, completionCost: 10, contextLength: 1_048_576 }), rowLayout(160, 20), true);
    assert.match(row, /^google\/gemini-pro\s+\$1\.25 \/ \$10\.0 per 1M\s+1M ctx · ● current · Gemini Pro$/);
    assert.equal(formatPrice({ promptCost: 0, completionCost: 0 }), "free");
    assert.equal(formatPrice({ promptCost: null, completionCost: 2 }), "variable price");
    assert.equal(formatContext(200_000), "200k ctx");
    assert.equal(formatContext(2_000_000), "2M ctx");
    assert.equal(vendorOf("Google/x"), "google");
  });
});

describe("a long third column wraps under itself, never under the id", () => {
  const long = m("acme/very-capable-model-v2", {
    name: "Acme: A Very Capable Model With An Unusually Long Display Name That Runs Past The Edge",
    contextLength: 262_144,
  });
  // What clack puts on screen for an option: the rail, the radio on the first line only, then the label's lines.
  const onScreen = (label: string) => label.split("\n").map((l, i) => (i === 0 ? "│  ● " : "│  ") + l);

  test("at 80 columns every line fits, and continuation lines start exactly at the third column", () => {
    const layout = rowLayout(80, long.id.length);
    const lines = onScreen(modelLabel(long, layout, true));
    assert.ok(lines.length > 1, "the long name had to wrap");
    for (const l of lines) assert.ok(visibleWidth(l) <= 80, `${visibleWidth(l)} > 80: ${l}`);
    const col3 = layout.detailsOffset;
    assert.equal(lines[0].indexOf("262k ctx"), col3, "the first line's third column starts at the computed offset");
    for (const l of lines.slice(1)) {
      assert.equal(l.slice(RAIL_WIDTH, col3).trim(), "", `nothing between the rail and the third column: ${l}`);
      assert.notEqual(l[col3], " ", `text starts right at the third column: ${l}`);
      assert.equal(l.slice(0, RAIL_WIDTH), "│  ");
    }
    // Inside the label itself (before clack adds its rail), a continuation line is exactly that many spaces, then text.
    for (const l of modelLabel(long, layout).split("\n").slice(1)) assert.match(l, new RegExp(`^ {${col3 - RAIL_WIDTH}}\\S`));
  });

  test("an id longer than its column wraps inside the first column and the other columns stay aligned", () => {
    const longId = m("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning-extended-context:free", { name: "" });
    const layout = rowLayout(80, longId.id.length);
    const lines = onScreen(modelLabel(longId, layout));
    for (const l of lines) assert.ok(visibleWidth(l) <= 80, l);
    const priceAt = RAIL_WIDTH + RADIO_WIDTH + layout.idWidth + 2;
    assert.equal(lines[0].indexOf("$1.00"), priceAt);
    assert.equal(lines.map((l) => l.slice(RAIL_WIDTH + RADIO_WIDTH).trimEnd()).join("").replace(/\s/g, "").startsWith("nvidia/nemotron"), true);
  });

  test("words wrap, and a word longer than the width is broken hard", () => {
    assert.deepEqual(wrapText("one two three", 7), ["one two", "three"]);
    assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
    assert.deepEqual(wrapText("", 5), [""]);
    assert.equal(visibleWidth("\x1b[2mdim\x1b[22m"), 3);
  });

  test("drawn by clack itself at 80 columns: rows fit, the third column continues under itself, and the frame keeps its bottom border", async () => {
    const input = new PassThrough() as any;
    input.isTTY = true;
    input.setRawMode = () => {};
    let written = "";
    const output = new Writable({ write(c, _e, cb) { written += c.toString(); cb(); } }) as any;
    output.columns = 80;
    output.rows = 24;
    output.isTTY = true;
    const models = [long, ...Array.from({ length: 30 }, (_, i) => m(`vendor/model-${i}`, { name: `Model ${i}` }))];
    const pending = pickOne({ message: "Discovery", models, current: long.id, input, output });
    await new Promise((r) => setTimeout(r, 50));
    const frame = written.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/);
    input.write("\x1b"); // Esc: cancel
    await assert.rejects(pending);

    for (const l of frame) assert.ok(visibleWidth(l) <= 80, `${visibleWidth(l)} > 80: ${l}`);
    const first = frame.findIndex((l) => l.includes("acme/very-capable-model-v2"));
    assert.ok(first >= 0);
    const col3 = frame[first].indexOf("262k ctx");
    assert.ok(col3 > 40, "the third column is to the right of id and price");
    const cont = frame[first + 1];
    assert.equal(cont.slice(3, col3).trim(), "", `continuation is blank up to the third column: ${cont}`);
    assert.notEqual(cont[col3], " ", `and its text starts there: ${cont}`);
    assert.ok(frame.length <= 24 + 2, "taller rows mean fewer of them, not a frame taller than the terminal");
    assert.ok(frame.some((l) => l.includes("Enter: confirm")), "the footer is still drawn");
  });
});

describe("setup", () => {
  test("one model for every role fills Discovery, Planner, Editor and Verifier, leaves Repair to reuse the Editor", () => {
    const c = chainsForOneModel(m("a/main"), m("b/backup"));
    for (const r of ["discovery", "planner", "editor", "verifier"] as const) assert.deepEqual(c[r], ["a/main", "b/backup"]);
    assert.deepEqual(c.repair, []);
    assert.deepEqual(c.verifierVision, [], "a model that cannot see images is not given the screenshot checks");
    assert.deepEqual(c.security, []);
  });
  test("a model that sees images also runs the screenshot checks; its backup only if it sees images too", () => {
    assert.deepEqual(chainsForOneModel(m("a/v", { supportsVision: true }), m("b/text")).verifierVision, ["a/v"]);
    assert.deepEqual(chainsForOneModel(m("a/v", { supportsVision: true }), m("b/v", { supportsVision: true })).verifierVision, ["a/v", "b/v"]);
  });
  test("the summary card shows the masked key and each role with a model", () => {
    const models = { ...emptyChains(), planner: ["a/x", "b/y"], editor: ["c/z"] };
    const lines = summaryLines({ masked: maskKey(KEY), where: "Windows Credential Manager" }, models);
    assert.match(lines[0], /^Key\s+sk-or-••••89ab  \(Windows Credential Manager\)$/);
    assert.ok(lines.some((l) => /^Planner\s+a\/x  →  b\/y$/.test(l)));
    assert.ok(!lines.some((l) => l.startsWith("Discovery")), "a role with nothing set is left off");
    assert.ok(!lines.join("\n").includes(KEY));
  });
  test("an OPENROUTER_API_KEY in the environment skips only the key step: models are still chosen", () => {
    const setup = src("setup.ts");
    assert.match(setup, /if \(envKey\) \{\s*key = envKey;/);
    assert.match(setup, /How do you want to choose models\?/);
    assert.doesNotMatch(setup, /if \(envKey\)[^}]*return 0/);
  });
  test("no terminal: setup explains what to do instead and never prompts", () => {
    assert.match(src("setup.ts"), /if \(!canRunWizard\(\)\) \{\s*for \(const l of NON_INTERACTIVE_HELP\)/);
    assert.ok(NON_INTERACTIVE_HELP.some((l) => /OPENROUTER_API_KEY/.test(l)));
    assert.match(src("index.ts"), /needsSetup\(\) && !args\.yes && !args\.json/);
  });
  test("the personal config file is written owner-only", () => {
    assert.match(src("globalConfig.ts"), /mode: 0o600/);
    assert.match(src("settings.ts"), /personal \? \{ encoding: "utf-8", mode: 0o600 \}/);
  });
});

describe("raw mode is held for the whole wizard (the Windows dead-keys bug)", () => {
  const fakeStdin = () => {
    const calls: boolean[] = [];
    const s: any = { isTTY: true, setRawMode(m: boolean) { calls.push(m); return s; } };
    return { s, calls };
  };
  test("while held, setRawMode(false) keeps raw mode on; released, it works again", () => {
    const { s, calls } = fakeStdin();
    const release = holdRawMode(s);
    assert.deepEqual(calls, [true], "holding turns raw mode on at once");
    s.setRawMode(false);
    assert.deepEqual(calls, [true, true], "a prompt ending (or a readline closing) cannot drop raw mode");
    release();
    s.setRawMode(false);
    assert.deepEqual(calls, [true, true, false], "the real setRawMode is back");
    assert.equal(rawHoldCount(), 0);
  });
  test("holds nest: only the outermost release gives setRawMode back, and releasing twice is harmless", () => {
    const { s, calls } = fakeStdin();
    const outer = holdRawMode(s);
    const inner = holdRawMode(s);
    inner();
    inner();
    s.setRawMode(false);
    assert.equal(calls.at(-1), true, "still held by the outer hold");
    outer();
    s.setRawMode(false);
    assert.equal(calls.at(-1), false);
  });
  test("no terminal: nothing is touched", () => {
    const s: any = { isTTY: false, setRawMode: () => { throw new Error("must not be called"); } };
    holdRawMode(s)();
  });
  test("setup and every session menu run inside the hold", () => {
    assert.match(src("setup.ts"), /return withExclusiveStdin\(\(\) => runSetupSteps\(force\)\)/);
    assert.match(src("wizard/prompts.ts"), /const release = holdRawMode\(stdin\);/);
  });
});

describe("wizard screens keep stdin to themselves and stay off the phone", () => {
  test("a wizard runs only where both stdin and stdout are terminals", () => {
    assert.equal(canRunWizard({ isTTY: true }, { isTTY: true }), true);
    assert.equal(canRunWizard({ isTTY: false }, { isTTY: true }), false);
    assert.equal(canRunWizard({}, { isTTY: true }), false);
  });
  test("every menu in the session runs inside withExclusiveStdin and checks for a terminal first", () => {
    const idx = src("index.ts");
    for (const fn of ["changeApiKey", "changeModel", "changeProviderSort"]) {
      const body = idx.slice(idx.indexOf(`async function ${fn}(`), idx.indexOf("\n}\n", idx.indexOf(`async function ${fn}(`)));
      assert.match(body, /if \(!canRunWizard\(\)\)/, fn);
      assert.match(body, /await withExclusiveStdin\(/, fn);
    }
  });
  test("withExclusiveStdin pauses only a live input line, and restores the line; raw mode goes back only outside a session", () => {
    const ui = src("wizard/prompts.ts");
    assert.match(ui, /const owned = inputActive\(\);\s*if \(owned\) pauseInput\(\);/);
    assert.match(ui, /finally \{\s*release\(\);\s*if \(owned\) resumeInput\(\);\s*else if \(!inputInstalled\(\) && rawHolds === 0\) \{\s*try \{ stdin\.setRawMode\?\.\(wasRaw\); \}/);
  });
  test("the old hand-written readline prompts are gone", () => {
    const all = src("index.ts") + src("setup.ts");
    for (const old of ["askHidden", "askOrEscape", "withEscWatch", "isCancelAnswer", "MENU_EXIT_HINT"]) assert.ok(!all.includes(old), old);
  });
  test("wizard screens draw with clack, which writes to the terminal and not through the console.log the phone mirrors", () => {
    const ui = src("wizard/prompts.ts");
    assert.match(ui, /import \* as p from "@clack\/prompts"/);
    assert.doesNotMatch(src("wizard/keyCheck.ts") + src("wizard/modelPicker.ts"), /console\.log/);
  });
  test("@clack/prompts is pinned to an exact version", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(pkg.dependencies["@clack/prompts"], "1.9.0");
  });
});
