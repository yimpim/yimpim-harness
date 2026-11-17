import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { repairJson, parseLenient } from "../src/jsonRepair.js";
import { parseDiscoveryJson, recoverDiscoveryOutput } from "../src/discoveryParsing.js";

const Q = '"';

describe("parseLenient", () => {
  test("valid JSON is parsed as is, never repaired", () => {
    const r = parseLenient('{"a":[1,2,{"b":"c"}]}');
    assert.deepEqual(r, { value: { a: [1, 2, { b: "c" }] }, repaired: false });
  });
  test("an unescaped quote inside a code snippet", () => {
    const text = `{"files":[{"path":"a.ts","relevantCode":"const x = foo(${Q}bar${Q}) + 1;","whyRelevant":"it is used"}]}`;
    const r = parseLenient(text);
    assert.equal(r?.repaired, true);
    assert.equal(r?.value.files[0].relevantCode, 'const x = foo("bar") + 1;');
    assert.equal(r?.value.files[0].whyRelevant, "it is used");
  });
  test("missing comma between array elements and between fields", () => {
    const r = parseLenient('{"a":["x" "y"],"b":1 "c":2}');
    assert.deepEqual(r?.value, { a: ["x", "y"], b: 1, c: 2 });
  });
  test("trailing commas", () => {
    assert.deepEqual(parseLenient('{"a":[1,2,],"b":3,}')?.value, { a: [1, 2], b: 3 });
  });
  test("a raw newline and tab inside a string", () => {
    assert.deepEqual(parseLenient('{"code":"line1\nline2\tend"}')?.value, { code: "line1\nline2\tend" });
  });
  test("an answer cut off before it closes keeps what came before", () => {
    const r = parseLenient('{"taskFindings":{"existingFiles":[{"path":"a.ts"},{"path":"b.ts","why":"cut o');
    assert.equal(r?.value.taskFindings.existingFiles[0].path, "a.ts");
    assert.equal(r?.value.taskFindings.existingFiles[1].path, "b.ts");
  });
  test("prose around the object is ignored", () => {
    assert.deepEqual(parseLenient('Here you go: {"a":1} hope that helps')?.value, { a: 1 });
  });
  test("text with no JSON gives undefined", () => {
    assert.equal(parseLenient("nothing here"), undefined);
    assert.equal(repairJson("nothing here"), undefined);
  });
  test("a bad escape does not break the rest", () => {
    assert.deepEqual(parseLenient('{"p":"C:\\dir\\Users","q":2}')?.value, { p: "C:\\dir\\Users", q: 2 });
  });
});

describe("Discovery keeps its findings through one slip", () => {
  const slip = `\`\`\`json\n{"taskFindings":{"existingFiles":[{"path":"src/a.ts","symbols":[],"relevantCode":"x = f(${Q}y${Q})","whyRelevant":"w"},{"path":"src/b.ts","symbols":[],"relevantCode":"","whyRelevant":"w2"}],"existingFlow":[],"newFilesNeeded":[],"uncertainties":[]}}\n\`\`\``;
  test("parseDiscoveryJson reads the repaired answer", () => {
    const parsed = parseDiscoveryJson(slip);
    assert.equal(parsed.taskFindings.existingFiles.length, 2);
  });
  test("recoverDiscoveryOutput does not replace it with unconfirmed leads", () => {
    assert.equal(recoverDiscoveryOutput(slip, ["src/zzz.ts"]), slip);
  });
});
