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
} from "../src/wizard/modelPicker.js";
import { canRunWizard } from "../src/wizard/prompts.js";
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
  test("each row shows the id, price in and out per 1M tokens, and the context window", () => {
    const row = modelLabel(m("google/gemini-pro", { promptCost: 1.25, completionCost: 10, contextLength: 1_048_576 }), 20, true);
    assert.match(row, /^google\/gemini-pro\s+\$1\.25 \/ \$10\.0 per 1M\s+1M ctx  ● current$/);
    assert.equal(formatPrice({ promptCost: 0, completionCost: 0 }), "free");
    assert.equal(formatPrice({ promptCost: null, completionCost: 2 }), "variable price");
    assert.equal(formatContext(200_000), "200k ctx");
    assert.equal(formatContext(2_000_000), "2M ctx");
    assert.equal(vendorOf("Google/x"), "google");
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
  test("withExclusiveStdin pauses only a live input line, and restores raw mode and the line in finally", () => {
    const ui = src("wizard/prompts.ts");
    assert.match(ui, /const owned = inputActive\(\);\s*if \(owned\) pauseInput\(\);/);
    assert.match(ui, /finally \{\s*try \{ stdin\.setRawMode\?\.\(wasRaw\); \} catch[^}]*\}\s*if \(owned\) resumeInput\(\);/);
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
