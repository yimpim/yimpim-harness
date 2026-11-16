/**
 * Ambient-hook fingerprints, "ran successfully" history, npm dates via HEAD,
 * PyPI wheels and Expo pins. No network.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandApprovals, evaluateCommand } from "../src/commandPolicy.js";
import {
  chooseVersionWithDates,
  lookupPackage,
  type FetchFn,
} from "../src/dependencyFacts.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-amb-"));

describe("ambient-hook fingerprint", () => {
  const setup = () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "tests"));
    fs.writeFileSync(path.join(dir, "tests", "test_math.py"), "def test_a():\n    assert True\n");
    fs.writeFileSync(path.join(dir, "app.py"), "x = 1\n");
    const approvals = new CommandApprovals(path.join(os.tmpdir(), `appr-${path.basename(dir)}.json`));
    const run = () => evaluateCommand("pytest tests/test_math.py", { repoRoot: dir, approvals });
    const remember = () => {
      const d = run();
      if (d.verdict === "deny") throw new Error(d.reason);
      approvals.remember(dir, d.argv, d.cwdRel, d.fingerprint);
    };
    return { dir, approvals, run, remember };
  };

  test("editing the named test file, or adding a conftest.py, invalidates the approval", () => {
    const { dir, run, remember } = setup();
    try {
      remember();
      assert.equal(run().verdict, "allow");

      fs.writeFileSync(path.join(dir, "tests", "test_math.py"), "import os\n");
      const edited = run();
      assert.equal(edited.verdict, "ask");
      assert.equal((edited as any).changedSinceApproval, true);

      remember();
      assert.equal(run().verdict, "allow");
      fs.writeFileSync(path.join(dir, "tests", "conftest.py"), "import os\n");
      assert.equal(run().verdict, "ask");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unrelated source edit does not re-prompt", () => {
    const { dir, run, remember } = setup();
    try {
      remember();
      fs.writeFileSync(path.join(dir, "app.py"), "x = 2\n");
      assert.equal(run().verdict, "allow");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dependency folders are not walked", () => {
    const { dir, run, remember } = setup();
    try {
      remember();
      fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "x", "conftest.py"), "x");
      assert.equal(run().verdict, "allow");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ran-successfully history", () => {
  test("lists only commands marked as exited 0, most recent first", () => {
    const dir = tmp();
    try {
      const a = new CommandApprovals(path.join(dir, "a.json"));
      a.remember(dir, ["npm", "run", "lint"], "");
      a.remember(dir, ["npm", "run", "build"], "");
      a.markSucceeded(dir, ["npm", "run", "build"], "");
      const out = a.listSucceeded(dir);
      assert.deepEqual(out.map((e) => e.argv.join(" ")), ["npm run build"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function headFetch(table: Record<string, string>, packument: unknown): FetchFn & { heads: string[] } {
  const heads: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    if (init?.method === "HEAD") {
      heads.push(url);
      const lm = table[url];
      return {
        status: lm ? 200 : 404,
        headers: { get: (k: string) => (k.toLowerCase() === "last-modified" ? lm : null) },
      } as unknown as Response;
    }
    return { status: 200, text: async () => JSON.stringify(packument) } as unknown as Response;
  }) as FetchFn & { heads: string[] };
  fn.heads = heads;
  return fn;
}

describe("npm dates through HEAD", () => {
  const T = (v: string) => `https://registry.npmjs.org/p/-/p-${v}.tgz`;
  const doc = {
    "dist-tags": { latest: "2.0.0" },
    versions: {
      "1.0.0": { dist: { tarball: T("1.0.0") } },
      "2.0.0": { dist: { tarball: T("2.0.0") } },
    },
  };

  test("a too-fresh newest release is skipped for an older one", async () => {
    const f = headFetch(
      { [T("2.0.0")]: new Date(Date.now() - 86_400_000).toUTCString(), [T("1.0.0")]: "Mon, 01 Jan 2018 00:00:00 GMT" },
      doc
    );
    const facts = await lookupPackage("npm", "p", f);
    const choice = await chooseVersionWithDates(facts, f);
    assert.equal(choice.version, "1.0.0");
    assert.equal(facts.versions.find((v) => v.version === "2.0.0")?.publishedAtIsUpperBound, true);
  });

  test("a failed HEAD leaves the version undated and still usable", async () => {
    const f = headFetch({}, doc);
    const facts = await lookupPackage("npm", "p", f);
    const choice = await chooseVersionWithDates(facts, f);
    assert.equal(choice.version, "2.0.0");
  });

  test("only the registry's own host is ever requested", async () => {
    const f = headFetch({}, { versions: { "1.0.0": { dist: { tarball: "http://evil.example/x.tgz" } } } });
    const facts = await lookupPackage("npm", "p", f);
    await chooseVersionWithDates(facts, f);
    assert.deepEqual(f.heads, []);
  });
});

describe("PyPI wheels", () => {
  test("a release without a non-yanked wheel is flagged", async () => {
    const f = (async () =>
      ({
        status: 200,
        text: async () =>
          JSON.stringify({
            info: { version: "1.0" },
            releases: {
              "1.0": [{ packagetype: "sdist", upload_time_iso_8601: "2020-01-01T00:00:00Z" }],
              "0.9": [{ packagetype: "bdist_wheel", upload_time_iso_8601: "2019-01-01T00:00:00Z", yanked: false }],
            },
          }),
      }) as unknown as Response) as unknown as FetchFn;
    const facts = await lookupPackage("pypi", "p", f);
    assert.equal(facts.versions.find((v) => v.version === "1.0")?.wheel, false);
    assert.equal(facts.versions.find((v) => v.version === "0.9")?.wheel, true);
  });
});
