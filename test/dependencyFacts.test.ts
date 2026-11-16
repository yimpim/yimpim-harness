/**
 * request_dependency: registry facts, the version policy, and the warnings.
 * Every lookup goes through an injected fetch; nothing here touches the network.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assessPackage,
  chooseVersion,
  compareVersions,
  isPrerelease,
  isValidPackageName,
  lookupPackage,
  lookupVulnerabilities,
  type FetchFn,
  type PackageFacts,
} from "../src/dependencyFacts.js";
import { AgentTools } from "../src/agentTools.js";
import type { AgentConfig } from "../src/config.js";

/** A fetch that answers from a table keyed by URL prefix; unknown URLs are a 404. */
function fakeFetch(table: Record<string, { status?: number; body: unknown }>): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const key = Object.keys(table).find((k) => url.startsWith(k));
    const hit = key ? table[key] : { status: 404, body: "" };
    const text = typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body);
    return { status: hit.status ?? 200, text: async () => text } as unknown as Response;
  }) as FetchFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const DAY = 86_400_000;
const ago = (days: number, now = new Date()) => new Date(now.getTime() - days * DAY).toISOString();

describe("name and version helpers", () => {
  test("package names that could alter a URL are rejected", () => {
    assert.equal(isValidPackageName("npm", "react-native-svg"), true);
    assert.equal(isValidPackageName("npm", "@scope/pkg"), true);
    assert.equal(isValidPackageName("npm", "pkg/../../etc"), false);
    assert.equal(isValidPackageName("pypi", "pandas"), true);
    assert.equal(isValidPackageName("pypi", "pandas?x=1"), false);
    assert.equal(isValidPackageName("maven", "androidx.core:core-ktx"), true);
    assert.equal(isValidPackageName("maven", "just-one-part"), false);
  });

  test("pre-releases are recognised per ecosystem", () => {
    assert.equal(isPrerelease("npm", "2.0.0-beta.1"), true);
    assert.equal(isPrerelease("npm", "2.0.0"), false);
    assert.equal(isPrerelease("pypi", "2.0rc1"), true);
    assert.equal(isPrerelease("pypi", "2.1.3"), false);
    assert.equal(isPrerelease("maven", "1.0.0-SNAPSHOT"), true);
    assert.equal(isPrerelease("maven", "1.12.0"), false);
  });

  test("versions compare numerically, not as text", () => {
    assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
    assert.ok(compareVersions("2.0", "2.0.0") === 0);
  });
});

describe("lookupPackage", () => {
  test("npm: reads latest, per-version deprecation and weekly downloads", async () => {
    const f = fakeFetch({
      "https://registry.npmjs.org/": {
        body: {
          "dist-tags": { latest: "2.0.0" },
          versions: { "1.0.0": { deprecated: "use 2.x" }, "2.0.0": {} },
        },
      },
      "https://api.npmjs.org/downloads/point/last-week/": { body: { downloads: 123456 } },
    });
    const facts = await lookupPackage("npm", "left-thing", f);
    assert.equal(facts.exists, true);
    assert.equal(facts.registryLatest, "2.0.0");
    assert.equal(facts.weeklyDownloads, 123456);
    assert.equal(facts.versions.find((v) => v.version === "1.0.0")?.deprecated, "use 2.x");
  });

  test("a 404 is 'does not exist'; a server error or network failure is 'unknown'", async () => {
    const missing = await lookupPackage("pypi", "no-such-pkg", fakeFetch({}));
    assert.equal(missing.exists, false);
    assert.equal(missing.lookupError, undefined);

    const broken = await lookupPackage("pypi", "pandas", fakeFetch({ "https://pypi.org/": { status: 503, body: "" } }));
    assert.ok(broken.lookupError);
    assert.equal(broken.exists, true, "an unreachable registry must not claim the package is fake");

    const offline = await lookupPackage("crates", "serde", (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as FetchFn);
    assert.match(String(offline.lookupError), /ENOTFOUND/);
    assert.equal(offline.exists, true);
  });

  test("pypi: publish dates and yanked releases", async () => {
    const f = fakeFetch({
      "https://pypi.org/pypi/pandas/json": {
        body: {
          info: { version: "2.2.0" },
          releases: {
            "2.1.0": [{ upload_time_iso_8601: "2023-09-01T00:00:00Z" }],
            "2.2.0": [{ upload_time_iso_8601: "2024-01-01T00:00:00Z" }],
            "2.2.1": [{ upload_time_iso_8601: "2024-02-01T00:00:00Z", yanked: true }],
            "3.0.0": [],
          },
        },
      },
    });
    const facts = await lookupPackage("pypi", "pandas", f);
    assert.equal(facts.versions.length, 3, "a release with no files is not a release");
    assert.equal(facts.firstPublishedAt, "2023-09-01T00:00:00Z");
    assert.equal(facts.versions.find((v) => v.version === "2.2.1")?.yanked, true);
  });

  test("maven: falls through from Maven Central to Google's repository", async () => {
    const xml = "<metadata><versioning><release>1.13.1</release><versions><version>1.12.0</version><version>1.13.1</version></versions></versioning></metadata>";
    const f = fakeFetch({ "https://dl.google.com/dl/android/maven2/androidx/core/core-ktx/": { body: xml } });
    const facts = await lookupPackage("maven", "androidx.core:core-ktx", f);
    assert.equal(facts.exists, true);
    assert.equal(facts.registryLatest, "1.13.1");
    assert.deepEqual(facts.versions.map((v) => v.version), ["1.12.0", "1.13.1"]);
    // deps.dev is tried first (it has no androidx), then Central, then Google.
    assert.match(f.calls[0], /^https:\/\/api\.deps\.dev\//);
    assert.equal(f.calls.length, 3);
  });

  test("an invalid name is refused without any network call", async () => {
    const f = fakeFetch({});
    const facts = await lookupPackage("npm", "x/../../y", f);
    assert.equal(facts.exists, false);
    assert.equal(f.calls.length, 0);
  });
});

describe("lookupVulnerabilities", () => {
  test("returns advisory ids; a failed lookup is 'not checked', not 'clean'", async () => {
    const hit = await lookupVulnerabilities("npm", "x", "1.0.0", fakeFetch({ "https://api.osv.dev/": { body: { vulns: [{ id: "GHSA-1" }, { id: "CVE-2" }] } } }));
    assert.deepEqual(hit, { checked: true, ids: ["GHSA-1", "CVE-2"] });
    const clean = await lookupVulnerabilities("npm", "x", "1.0.0", fakeFetch({ "https://api.osv.dev/": { body: {} } }));
    assert.deepEqual(clean, { checked: true, ids: [] });
    const failed = await lookupVulnerabilities("npm", "x", "1.0.0", fakeFetch({ "https://api.osv.dev/": { status: 500, body: "" } }));
    assert.equal(failed.checked, false);
  });
});

describe("chooseVersion", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const facts = (versions: PackageFacts["versions"], ecosystem: PackageFacts["ecosystem"] = "pypi"): PackageFacts => ({
    ecosystem,
    name: "p",
    exists: true,
    versions,
  });

  test("picks the newest stable release", () => {
    const c = chooseVersion(
      facts([
        { version: "1.9.0", publishedAt: ago(400, now) },
        { version: "1.10.0", publishedAt: ago(200, now) },
        { version: "2.0.0rc1", publishedAt: ago(100, now) },
      ]),
      { now }
    );
    assert.equal(c.version, "1.10.0");
  });

  test("skips a release that is too fresh to have been vetted", () => {
    const c = chooseVersion(
      facts([
        { version: "1.0.0", publishedAt: ago(300, now) },
        { version: "1.1.0", publishedAt: ago(2, now) },
      ]),
      { now }
    );
    assert.equal(c.version, "1.0.0");
    assert.match(c.reason, /too fresh/);
  });

  test("ignores yanked and deprecated releases", () => {
    const c = chooseVersion(
      facts(
        [
          { version: "3.0.0", yanked: true },
          { version: "2.0.0", deprecated: "do not use" },
          { version: "1.5.0" },
        ],
        "npm"
      ),
      { now }
    );
    assert.equal(c.version, "1.5.0");
  });

  test("honours an exact requested version that exists", () => {
    const c = chooseVersion(facts([{ version: "1.0.0" }, { version: "2.0.0" }]), { now, requested: "1.0.0" });
    assert.equal(c.version, "1.0.0");
  });

  test("no usable release yields no version", () => {
    assert.equal(chooseVersion(facts([{ version: "1.0.0", yanked: true }]), { now }).version, undefined);
  });

  test("when every stable release is fresh, the newest is still chosen (and says so)", () => {
    const c = chooseVersion(facts([{ version: "0.1.0", publishedAt: ago(1, now) }]), { now });
    assert.equal(c.version, "0.1.0");
    assert.match(c.reason, /very recent/);
  });
});

describe("assessPackage", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const base: PackageFacts = {
    ecosystem: "npm",
    name: "p",
    exists: true,
    versions: [{ version: "1.0.0" }, { version: "1.1.0" }],
    weeklyDownloads: 500_000,
    firstPublishedAt: ago(900, now),
  };

  test("a healthy, popular package has no warnings", () => {
    const a = assessPackage(base, base.versions[1], { checked: true, ids: [] }, now);
    assert.equal(a.level, "none");
  });

  test("a package that does not exist blocks", () => {
    const a = assessPackage({ ...base, exists: false }, undefined, undefined, now);
    assert.equal(a.level, "block");
  });

  test("brand-new + almost no downloads asks for confirmation", () => {
    const a = assessPackage({ ...base, firstPublishedAt: ago(3, now), weeklyDownloads: 4 }, base.versions[1], undefined, now);
    assert.equal(a.level, "confirm");
    assert.equal(a.warnings.length >= 2, true);
  });

  test("known advisories for the chosen version ask for confirmation", () => {
    const a = assessPackage(base, base.versions[1], { checked: true, ids: ["GHSA-x"] }, now);
    assert.equal(a.level, "confirm");
    assert.match(a.warnings.map((w) => w.text).join(" "), /GHSA-x/);
  });

  test("an unverifiable registry is info only, never a claim of danger", () => {
    const a = assessPackage({ ...base, lookupError: "HTTP 503" }, undefined, undefined, now);
    assert.equal(a.level, "info");
  });
});

describe("AgentTools.requestDependency", () => {
  const config = { prompts: { systemPersona: "You are YIMPIM." } } as AgentConfig;
  const dirs: string[] = [];
  const ttyIn = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const ttyOut = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  before(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });
  after(() => {
    if (ttyIn) Object.defineProperty(process.stdin, "isTTY", ttyIn);
    else delete (process.stdin as any).isTTY;
    if (ttyOut) Object.defineProperty(process.stdout, "isTTY", ttyOut);
    else delete (process.stdout as any).isTTY;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function tools(askFn: (q: string, fallback: string) => Promise<string>, fetchFn: FetchFn): AgentTools {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-deps-"));
    dirs.push(dir);
    const t = new AgentTools(dir, config, askFn);
    t.setFactsFetch(fetchFn);
    return t;
  }

  const healthyNpm = {
    "https://registry.npmjs.org/": {
      body: { "dist-tags": { latest: "2.0.0" }, versions: { "1.0.0": {}, "2.0.0": {} } },
    },
    "https://api.npmjs.org/": { body: { downloads: 900000 } },
    "https://api.osv.dev/": { body: {} },
  };

  test("a real, healthy package returns the version to use and asks nobody", async () => {
    let asked = 0;
    const t = tools(async () => (asked++, "yes"), fakeFetch(healthyNpm));
    const out = await t.requestDependency({ ecosystem: "npm", name: "react-native-svg", reason: "icons" });
    assert.match(out, /\[VERIFIED\] npm:react-native-svg/);
    assert.match(out, /Use version 2\.0\.0/);
    assert.equal(asked, 0);
  });

  test("a package that does not exist is refused", async () => {
    const t = tools(async () => "yes", fakeFetch({}));
    const out = await t.requestDependency({ ecosystem: "npm", name: "totally-invented-lib", reason: "x" });
    assert.match(out, /\[REFUSED\]/);
    assert.match(out, /Do not add/);
  });

  test("an unreachable registry yields UNVERIFIED and no version to copy", async () => {
    const t = tools(async () => "yes", fakeFetch({ "https://registry.npmjs.org/": { status: 503, body: "" } }));
    const out = await t.requestDependency({ ecosystem: "npm", name: "react", reason: "x" });
    assert.match(out, /\[UNVERIFIED\]/);
    assert.doesNotMatch(out, /Use version/);
    assert.match(out, /Do not invent a version/);
  });

  test("a warning asks the user, and a decline tells the model not to add it", async () => {
    const risky = {
      ...healthyNpm,
      "https://api.npmjs.org/": { body: { downloads: 2 } },
    };
    let q = "";
    const t = tools(async (question) => ((q = question), "no"), fakeFetch(risky));
    const out = await t.requestDependency({ ecosystem: "npm", name: "lookalike-lib", reason: "x" });
    assert.match(q, /very few downloads/);
    assert.match(out, /did NOT approve/);
  });

  test("an unknown ecosystem or an invalid name is rejected without a lookup", async () => {
    const f = fakeFetch(healthyNpm);
    const t = tools(async () => "yes", f);
    assert.match(await t.requestDependency({ ecosystem: "cobol", name: "x", reason: "x" }), /Unknown ecosystem/);
    const bad = await t.requestDependency({ ecosystem: "npm", name: "../../etc/passwd", reason: "x" });
    assert.match(bad, /REFUSED/);
    assert.equal(f.calls.length, 0);
  });

  test("the same request twice in a phase is answered once from memory", async () => {
    const f = fakeFetch(healthyNpm);
    const t = tools(async () => "yes", f);
    await t.requestDependency({ ecosystem: "npm", name: "react-native-svg", reason: "x" });
    const callsAfterFirst = f.calls.length;
    const second = await t.requestDependency({ ecosystem: "npm", name: "react-native-svg", reason: "x" });
    assert.match(second, /Same answer/);
    assert.equal(f.calls.length, callsAfterFirst);
  });
});
