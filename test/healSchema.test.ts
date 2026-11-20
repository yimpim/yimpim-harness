/**
 * A Gemini model asked for plain JSON that looks like an action sometimes ends the call with MALFORMED_FUNCTION_CALL and no text (it tried to emit
 * the action as a native function call). Held to a json_schema the same requests answered 12 of 12; tool_choice "none" did nothing (0 of 6).
 * These keep that fix from quietly coming undone.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OpenRouterClient } from "../src/openrouter.js";
import { HEAL_REPLY_SCHEMA, HEAL_REPLY_STRUCTURED } from "../src/healSchema.js";

const enc = new TextEncoder();
const ok = (text: string) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

async function sentFor(model: string, options: Record<string, unknown>): Promise<any> {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  let body: any;
  (globalThis as any).fetch = async (_u: string, init: any) => ((body = JSON.parse(init.body)), ok('{"need":[]}'));
  (process.stdout as any).write = () => true;
  console.log = () => {};
  try {
    await new OpenRouterClient("k").complete([model], [{ role: "user", content: "hi" }], { agent: "REPAIR", ...options });
    return body;
  } finally {
    (globalThis as any).fetch = originalFetch;
    (process.stdout as any).write = originalWrite;
    console.log = originalLog;
  }
}

describe("the stronger model's reply is held to a schema", () => {
  test("a Google model is sent response_format json_schema with the heal schema", async () => {
    const b = await sentFor("google/gemini-4-hydrogen", { jsonMode: true, structured: HEAL_REPLY_STRUCTURED });
    assert.equal(b.response_format.type, "json_schema");
    assert.equal(b.response_format.json_schema.name, "heal_reply");
    assert.deepEqual(b.response_format.json_schema.schema, HEAL_REPLY_SCHEMA);
    assert.equal(b.tools, undefined, "no tools are declared: the schema is the fix, not a tool setting");
  });
  test("any other model gets plain JSON mode (not every model accepts json_schema)", async () => {
    const b = await sentFor("deepseek/deepseek-v4.1-flash-1017", { jsonMode: true, structured: HEAL_REPLY_STRUCTURED });
    assert.deepEqual(b.response_format, { type: "json_object" });
  });
  test("without the option nothing changes for a Google model: plain JSON mode", async () => {
    const b = await sentFor("google/gemini-4-hydrogen", { jsonMode: true });
    assert.deepEqual(b.response_format, { type: "json_object" });
  });
  test("the real call sites pass it for the stronger model", () => {
    for (const f of ["src/index.ts", "src/verifierTools.ts", "scripts/bench-heal.mjs"]) {
      const src = fs.readFileSync(f, "utf8");
      assert.match(src, /HEAL_REPLY_STRUCTURED/, f);
      assert.match(src, /slice\(1\)/, f);
    }
  });
});

describe("the schema covers every reply the heal reads, and each kind has to carry what it needs", () => {
  const branches = (HEAL_REPLY_SCHEMA as any).anyOf as any[];
  const names = new Set(branches.flatMap((b) => Object.keys(b.properties)));
  test("every field the worker reads from a reply is in the schema (a field left out is dropped by the model)", () => {
    for (const f of ["need", "verdict", "reason", "edits", "test", "codeBugs", "appDeviations", "cites", "kind"]) assert.ok(names.has(f), f);
  });
  test("a lookup branch, an edits branch, a whole-file branch, a claim branch and a park branch", () => {
    const req = branches.map((b) => b.required.join(","));
    assert.deepEqual(req, ["need", "verdict,reason,edits", "verdict,reason,test", "verdict,reason", "verdict,kind,reason"]);
  });
  test("a fix verdict cannot be answered without its reason and edits (the loose schema let {\"verdict\":\"stale-test\"} through)", () => {
    const fix = branches.find((b) => b.properties.edits);
    assert.deepEqual(fix.properties.verdict.enum, ["stale-test", "mixed"]);
    assert.ok(fix.required.includes("reason") && fix.required.includes("edits"));
  });
  test("every verdict the worker can give is allowed by some branch", () => {
    const allowed = new Set(branches.flatMap((b) => b.properties.verdict?.enum ?? []));
    for (const v of ["stale-test", "mixed", "code-bug", "app-deviation", "unclear", "park"]) assert.ok(allowed.has(v), v);
  });
});

describe("every kind of lookup the prompt offers can be said under the schema", () => {
  // A schema that leaves a kind out makes it IMPOSSIBLE for the model to ask for it: a schema without "probe" meant the stronger model could only read.
  const items = ((HEAL_REPLY_SCHEMA as any).anyOf[0].properties.need.items.anyOf as any[]);
  test("a bare file name, a range, a search and a probe", () => {
    assert.ok(items.some((i) => i.type === "string"), "a whole file by name");
    const obj = items.find((i) => i.type === "object");
    for (const f of ["path", "from", "to", "search", "probe"]) assert.ok(obj.properties[f], f);
  });
  test("a probe carries the three things runProbe needs, all required", () => {
    const probe = items.find((i) => i.type === "object").properties.probe;
    assert.deepEqual(Object.keys(probe.properties).sort(), ["before", "file", "log"]);
    assert.deepEqual([...probe.required].sort(), ["before", "file", "log"]);
  });
  test("the prompt's own examples of a lookup are all expressible (so the schema and the prompt cannot drift apart)", () => {
    const src = fs.readFileSync("src/testHeal.ts", "utf8");
    const line = src.split("\n").find((l) => l.trim().startsWith('{"need":["path/one"')) ?? "";
    assert.match(line, /"path":"path\/two","from":120,"to":260/);
    assert.match(line, /\{"search":"someName"\}/);
    assert.match(line, /\{"probe":\{"file":/);
  });
});
