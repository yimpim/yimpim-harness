/**
 * The planner's setup proposal (verified by code) and the YIMPIM.md context file.
 * No network: lookups go through an injected fetch.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FetchFn } from "../src/dependencyFacts.js";
import {
  MAX_PROPOSED_DEPENDENCIES,
  probeToolchain,
  renderDependencyGuidance,
  renderSetupReport,
  verifyDependencyProposal,
  type ProposedDependency,
} from "../src/setupProposal.js";
import {
  CONTEXT_FILE,
  loadProjectContext,
  mergeContext,
  parseContextFile,
  prepareSetupContext,
  renderGeneratedContext,
} from "../src/projectContext.js";
import { parsePlan } from "../src/planner.js";

function fakeFetch(table: Record<string, { status?: number; body: unknown }>): FetchFn {
  return (async (url: string) => {
    const key = Object.keys(table).find((k) => url.startsWith(k));
    const hit = key ? table[key] : { status: 404, body: "" };
    const text = typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body);
    return { status: hit.status ?? 200, text: async () => text } as unknown as Response;
  }) as FetchFn;
}

const OLD = "2020-01-01T00:00:00.000Z";
const registry = fakeFetch({
  "https://pypi.org/pypi/pandas/json": {
    body: {
      info: { version: "2.2.0" },
      releases: { "2.2.0": [{ packagetype: "bdist_wheel", upload_time_iso_8601: OLD, yanked: false }] },
    },
  },
  "https://api.osv.dev/": { body: {} },
});

const dep = (name: string, ecosystem: any = "pypi"): ProposedDependency => ({ ecosystem, name, reason: "needed" });

describe("verifyDependencyProposal", () => {
  test("a real package is verified with the policy's version; an invented one is refused", async () => {
    const out = await verifyDependencyProposal([dep("pandas"), dep("pandas-superfast-ai")], registry);
    assert.equal(out[0].verdict, "verified");
    assert.equal(out[0].version, "2.2.0");
    assert.equal(out[1].verdict, "refused");
  });

  test("an unreachable registry is 'unverified', never 'refused'", async () => {
    const down = fakeFetch({ "https://pypi.org/": { status: 503, body: "" } });
    const out = await verifyDependencyProposal([dep("pandas")], down);
    assert.equal(out[0].verdict, "unverified");
    assert.equal(out[0].version, undefined);
  });

  test("duplicates are collapsed and the list is capped", async () => {
    const many = Array.from({ length: MAX_PROPOSED_DEPENDENCIES + 10 }, (_, i) => dep(`pkg-${i}`));
    const out = await verifyDependencyProposal([dep("pandas"), dep("Pandas"), ...many], registry);
    assert.ok(out.length <= MAX_PROPOSED_DEPENDENCIES);
    assert.equal(out.filter((d) => d.name.toLowerCase() === "pandas").length, 1);
  });

  test("a name that could alter a URL is refused without a request for it", async () => {
    let asked = false;
    const spy = (async () => {
      asked = true;
      return { status: 200, text: async () => "{}" } as unknown as Response;
    }) as unknown as FetchFn;
    const out = await verifyDependencyProposal([dep("../../etc/passwd", "npm")], spy);
    assert.notEqual(out[0].verdict, "verified");
    assert.equal(asked, false);
  });
});

describe("guidance and report text", () => {
  test("guidance tells the editor what to use, what to clear first and what to avoid", async () => {
    const down = fakeFetch({});
    const report = {
      dependencies: await verifyDependencyProposal([dep("pandas"), dep("ghost-lib")], registry),
      toolchain: probeToolchain([{ tool: "definitely-not-a-real-tool-xyz", reason: "" }], os.tmpdir()),
    };
    void down;
    const text = renderDependencyGuidance(report);
    assert.match(text, /pypi:pandas 2\.2\.0/);
    assert.match(text, /Do NOT add[\s\S]*pypi:ghost-lib/);
    assert.match(text, /Tools missing[\s\S]*definitely-not-a-real-tool-xyz/);
    assert.match(renderSetupReport(report), /✗ definitely-not-a-real-tool-xyz — not found/);
  });
});

describe("probeToolchain", () => {
  test("finds a tool on PATH and ignores names that are not plain tool names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-tc-"));
    try {
      const exe = path.join(dir, process.platform === "win32" ? "mytool.cmd" : "mytool");
      fs.writeFileSync(exe, "echo hi\n", { mode: 0o755 });
      const env = { PATH: dir, PATHEXT: ".CMD;.EXE" } as NodeJS.ProcessEnv;
      const out = probeToolchain(
        [
          { tool: "mytool", reason: "x" },
          { tool: "../../evil", reason: "" },
          { tool: "a b", reason: "" },
        ],
        dir,
        env
      );
      assert.equal(out.length, 1);
      assert.equal(out[0].found, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("context file merge", () => {
  const gen1 = renderGeneratedContext({ stack: "  stacks: python", libraries: "- pypi:pandas 2.2.0" });
  const gen2 = renderGeneratedContext({ stack: "  stacks: python", libraries: "- pypi:pandas 2.2.0\n- pypi:numpy 2.0.0" });

  test("a new file has a generated block and a user section", () => {
    const m = mergeContext(undefined, gen1);
    const p = parseContextFile(m.text);
    assert.equal(p.generated?.trim(), gen1.trim());
    assert.equal(p.generatedEdited, false);
    assert.match(p.user, /Your notes/);
  });

  test("regeneration replaces the generated block and keeps the user's notes verbatim", () => {
    const first = mergeContext(undefined, gen1).text;
    const withNotes = first.replace(/\n$/, "\n\nUse tabs, never spaces.\n");
    const second = mergeContext(withNotes, gen2);
    assert.match(second.text, /numpy/);
    assert.match(second.text, /Use tabs, never spaces\./);
    assert.equal(second.keptEdits, false);
  });

  test("hand edits to the generated block are kept, not discarded", () => {
    const first = mergeContext(undefined, gen1).text;
    const edited = first.replace("pypi:pandas 2.2.0", "use polars, NOT pandas");
    const second = mergeContext(edited, gen2);
    assert.equal(second.keptEdits, true);
    assert.match(parseContextFile(second.text).user, /use polars, NOT pandas/);
    assert.match(parseContextFile(second.text).generated ?? "", /numpy/);
  });

  test("an unchanged regeneration reports no change", () => {
    const first = mergeContext(undefined, gen1).text;
    assert.equal(mergeContext(first, gen1).changed, false);
  });
});

describe("loadProjectContext and prepareSetupContext", () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-ctx-"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("no notes files means no text", () => {
    assert.equal(loadProjectContext(dir), "");
  });

  test("notes are read as data, capped, and labelled as granting nothing", () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "x".repeat(10_000));
    const text = loadProjectContext(dir);
    assert.match(text, /do not grant permission/);
    assert.match(text, /--- AGENTS\.md ---/);
    assert.ok(text.length < 6_000);
    fs.rmSync(path.join(dir, "AGENTS.md"));
  });

  test("prepareSetupContext verifies, writes the file once, and a rerun changes nothing", async () => {
    const args = {
      repoRoot: dir,
      dependencies: [dep("pandas"), dep("ghost-lib")],
      toolchain: [{ tool: "definitely-not-a-real-tool-xyz", reason: "interpreter" }],
      stack: "  stacks: python",
      fetchFn: registry,
    };
    const first = await prepareSetupContext(args);
    assert.equal(first.fileWritten, true);
    assert.match(first.reportText, /pandas 2\.2\.0/);
    const onDisk = fs.readFileSync(path.join(dir, CONTEXT_FILE), "utf-8");
    assert.match(onDisk, /ghost-lib/);
    assert.match(loadProjectContext(dir), /Pre-verified libraries/);

    const second = await prepareSetupContext(args);
    assert.equal(second.fileWritten, false);
  });
});

describe("planner schema", () => {
  const base = { goal: "g", phases: [{ id: "p1", name: "n", goal: "g" }] };

  test("dependencies and toolchain parse; malformed entries are dropped, not fatal", () => {
    const raw = JSON.stringify({
      ...base,
      toolchain: [{ tool: "python", reason: "run it" }, "node", 7],
      dependencies: [{ ecosystem: "PyPI", name: "pandas", reason: "frames" }, { ecosystem: "gem", name: "x" }, "nope"],
    });
    const r = parsePlan("```json\n" + raw + "\n```", "fallback");
    assert.equal(r.degraded, false);
    assert.deepEqual(r.plan.toolchain?.map((t) => t.tool), ["python", "node"]);
    assert.deepEqual(r.plan.dependencies?.map((d) => `${d.ecosystem}:${d.name}`), ["pypi:pandas"]);
  });

  test("a plan without the new fields still parses", () => {
    const r = parsePlan("```json\n" + JSON.stringify(base) + "\n```", "fallback");
    assert.equal(r.degraded, false);
    assert.deepEqual(r.plan.dependencies, []);
  });
});

import { CommandApprovals as _CA, evaluateCommand as _eval } from "../src/commandPolicy.js";
describe("phase-scoped trust for the editor's own edits", () => {
  const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-trust-"));
    fs.mkdirSync(path.join(dir, "tests"));
    fs.writeFileSync(path.join(dir, "tests", "test_a.py"), "def test_a():\n    assert True\n");
    fs.writeFileSync(path.join(dir, "tests", "test_b.py"), "def test_b():\n    assert True\n");
    return dir;
  };
  const run = (dir: string, approvals: any, file: string, trusted: string[]) =>
    _eval(`pytest ${file}`, { repoRoot: dir, approvals, agentCreated: { files: [], dirs: [], trusted } });

  test("re-editing a planned file keeps the approval; an unplanned file still invalidates it", () => {
    const dir = mk();
    try {
      const approvals = new _CA(path.join(os.tmpdir(), `appr-${path.basename(dir)}.json`));
      for (const file of ["tests/test_a.py", "tests/test_b.py"]) {
        const trusted = file === "tests/test_a.py" ? ["tests/test_a.py"] : [];
        const d: any = run(dir, approvals, file, trusted);
        approvals.remember(dir, d.argv, d.cwdRel, d.fingerprint);
        assert.equal(run(dir, approvals, file, trusted).verdict, "allow");
        fs.writeFileSync(path.join(dir, file), "import os\n");
        const after = run(dir, approvals, file, trusted);
        assert.equal(after.verdict, trusted.length > 0 ? "allow" : "ask", file);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
