/**
 * deps.dev lookups, "add a named package" policy, post-add version detection,
 * and the data-driven ambient table. No network.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lookupPackage, isValidPackageName, type FetchFn } from "../src/dependencyFacts.js";
import { CommandApprovals, analyzePackageAdd, evaluateCommand } from "../src/commandPolicy.js";
import { addedVersionCandidates, findInstalledVersions, snapshotDirs } from "../src/installVerify.js";
import { buildAmbientTable } from "../src/ambientHooks.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-dd-"));

function fetchTable(table: Record<string, { status?: number; body: unknown }>): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const key = Object.keys(table).find((k) => url.startsWith(k));
    const hit = key ? table[key] : { status: 404, body: "package not found" };
    const text = typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body);
    return { status: hit.status ?? 200, text: async () => text } as unknown as Response;
  }) as FetchFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const dd = (system: string, name: string, versions: Array<[string, string, boolean?]>) => ({
  packageKey: { system, name },
  versions: versions.map(([version, publishedAt, dep]) => ({
    versionKey: { system, name, version },
    publishedAt,
    isDefault: version === versions[versions.length - 1][0],
    isDeprecated: Boolean(dep),
    deprecatedReason: dep ? "gone" : "",
  })),
});

describe("deps.dev", () => {
  test("npm: versions carry real publish dates, with downloads from npm's API", async () => {
    const f = fetchTable({
      "https://api.deps.dev/v3/systems/npm/packages/%40expo%2Fvector-icons": {
        body: dd("NPM", "@expo/vector-icons", [["14.0.0", "2024-01-01T00:00:00Z"], ["14.1.0", "2024-06-01T00:00:00Z"]]),
      },
      "https://api.npmjs.org/downloads/": { body: { downloads: 900000 } },
    });
    const facts = await lookupPackage("npm", "@expo/vector-icons", f);
    assert.equal(facts.exists, true);
    assert.equal(facts.versions.find((v) => v.version === "14.0.0")?.publishedAt, "2024-01-01T00:00:00Z");
    assert.equal(facts.firstPublishedAt, "2024-01-01T00:00:00Z");
    assert.equal(facts.weeklyDownloads, 900000);
    assert.ok(!f.calls.some((u) => u.startsWith("https://registry.npmjs.org/")), "no native npm call needed");
  });

  test("go and nuget: module paths and ids are percent-encoded in the path segment", async () => {
    const f = fetchTable({
      "https://api.deps.dev/v3/systems/go/packages/golang.org%2Fx%2Fsync": {
        body: dd("GO", "golang.org/x/sync", [["v0.7.0", "2024-04-01T00:00:00Z"]]),
      },
    });
    const facts = await lookupPackage("go", "golang.org/x/sync", f);
    assert.equal(facts.versions[0].version, "v0.7.0");
    assert.equal(facts.exists, true);
  });

  test("an ecosystem deps.dev lacks is 'unverified', never 'does not exist'", async () => {
    const facts = await lookupPackage("nuget", "Some.Package", fetchTable({}));
    assert.equal(facts.exists, true);
    assert.ok(facts.lookupError);
  });

  test("npm falls back to the native registry when deps.dev has nothing", async () => {
    const f = fetchTable({
      "https://registry.npmjs.org/": { body: { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {} } } },
      "https://api.npmjs.org/": { body: { downloads: 10 } },
    });
    const facts = await lookupPackage("npm", "brand-new-pkg", f);
    assert.equal(facts.versions[0].version, "1.0.0");
  });

  test("go module paths are validated; traversal is not a valid name", () => {
    assert.equal(isValidPackageName("go", "github.com/gorilla/mux"), true);
    assert.equal(isValidPackageName("go", "github.com/../etc"), false);
    assert.equal(isValidPackageName("go", "notamodule"), false);
    assert.equal(isValidPackageName("nuget", "Newtonsoft.Json"), true);
  });
});

describe("analyzePackageAdd", () => {
  const names = (a: string[]) => analyzePackageAdd(a)?.names;
  test("recognises named adds across managers and strips version specs", () => {
    assert.deepEqual(names(["npm", "install", "left-pad@1.3.0", "--ignore-scripts"]), ["left-pad"]);
    assert.deepEqual(names(["npm", "i", "@scope/pkg@2.0.0"]), ["@scope/pkg"]);
    assert.deepEqual(names(["python", "-m", "pip", "install", "requests==2.31.0"]), ["requests"]);
    assert.deepEqual(names(["cargo", "add", "serde@1.0.0"]), ["serde"]);
    assert.deepEqual(names(["dotnet", "add", "package", "Newtonsoft.Json"]), ["Newtonsoft.Json"]);
    assert.deepEqual(names(["go", "get", "golang.org/x/sync@v0.7.0"]), ["golang.org/x/sync"]);
    assert.deepEqual(names(["npx", "expo", "install", "react-native-svg"]), ["react-native-svg"]);
  });
  test("installing what the manifest lists is not an add", () => {
    assert.equal(analyzePackageAdd(["npm", "install"]), undefined);
    assert.equal(analyzePackageAdd(["pip", "install", "-r", "requirements.txt"]), undefined);
    assert.deepEqual(analyzePackageAdd(["npm", "install", "./local-pkg"])?.names, []); // a local source: asked every time
  });
  test("script-skipping flags are required where the ecosystem has them", () => {
    assert.equal(analyzePackageAdd(["npm", "install", "x"])?.missingFlag, "--ignore-scripts");
    assert.equal(analyzePackageAdd(["npm", "install", "x", "--ignore-scripts"])?.missingFlag, undefined);
    assert.equal(analyzePackageAdd(["pip", "install", "x"])?.missingFlag, "--only-binary=:all:");
    assert.equal(analyzePackageAdd(["pip", "install", "--only-binary=:all:", "x"])?.missingFlag, undefined);
  });
});

describe("evaluateCommand and adds", () => {
  const setup = () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    return { dir, approvals: new CommandApprovals(path.join(os.tmpdir(), `a-${path.basename(dir)}.json`)) };
  };

  test("an uncleared name is denied with a pointer to request_dependency; a cleared one is asked every time", () => {
    const { dir, approvals } = setup();
    try {
      const denied = evaluateCommand("npm install left-pad --ignore-scripts", { repoRoot: dir, approvals });
      assert.equal(denied.verdict, "deny");
      assert.match((denied as any).reason, /request_dependency/);

      const cleared = new Set(["left-pad"]);
      const ok = evaluateCommand("npm install left-pad --ignore-scripts", { repoRoot: dir, approvals, clearedPackages: cleared });
      assert.equal(ok.verdict, "ask");
      assert.equal((ok as any).risk, "elevated");
      assert.deepEqual((ok as any).addsPackages, ["left-pad"]);

      const noFlag = evaluateCommand("npm install left-pad", { repoRoot: dir, approvals, clearedPackages: cleared });
      assert.equal(noFlag.verdict, "deny");
      assert.match((noFlag as any).reason, /--ignore-scripts/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("which version landed", () => {
  const known = new Set(["1.0.0", "1.2.0", "1.3.1", "2.0.0"]);

  test("package.json range line", () => {
    const before = new Map([["/p/package.json", '{\n  "dependencies": {\n  }\n}\n']]);
    const after = new Map([["/p/package.json", '{\n  "dependencies": {\n    "left-pad": "^1.3.1"\n  }\n}\n']]);
    assert.deepEqual(addedVersionCandidates("left-pad", known, before, after), ["1.3.1"]);
  });

  test("Cargo.lock block: name and version on separate lines", () => {
    const after = new Map([["/p/Cargo.lock", 'version = 3\n\n[[package]]\nname = "serde"\nversion = "1.2.0"\n']]);
    assert.deepEqual(addedVersionCandidates("serde", known, new Map(), after), ["1.2.0"]);
  });

  test("csproj PackageReference", () => {
    const after = new Map([["/p/a.csproj", '<ItemGroup><PackageReference Include="Newtonsoft.Json" Version="2.0.0" /></ItemGroup>']]);
    assert.deepEqual(addedVersionCandidates("Newtonsoft.Json", known, new Map(), after), ["2.0.0"]);
  });

  test("a longer package name containing this one does not match", () => {
    const after = new Map([["/p/package.json", '{ "react-native": "1.2.0" }']]);
    assert.deepEqual(addedVersionCandidates("react", new Set(["1.2.0"]), new Map(), after), []);
  });

  test("unchanged files and pre-existing lines are not credited", () => {
    const text = '{ "left-pad": "1.0.0" }';
    const f = new Map([["/p/package.json", text]]);
    assert.deepEqual(addedVersionCandidates("left-pad", known, f, f), []);
  });

  test("node: node_modules/<pkg>/package.json wins, regardless of manager", () => {
    const dir = tmp();
    try {
      fs.mkdirSync(path.join(dir, "node_modules", "@s", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "@s", "pkg", "package.json"), JSON.stringify({ version: "2.0.0" }));
      const r = findInstalledVersions({ ecosystem: "npm", name: "@s/pkg", known, before: new Map(), dirs: [dir] });
      assert.deepEqual(r, { versions: ["2.0.0"], source: "node_modules" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("snapshot skips binary files", () => {
    const dir = tmp();
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "hello");
      fs.writeFileSync(path.join(dir, "b.bin"), Buffer.from([0, 1, 2, 3]));
      const snap = snapshotDirs([dir]);
      assert.equal(snap.size, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ambient table is data", () => {
  test("a user family is added and a bad pattern is ignored", () => {
    const t = buildAmbientTable({
      families: {
        zig: { executables: ["zig"], names: ["^build\\.zig$", "([unclosed"] },
        python: { names: ["^custom_hook\\.py$"] },
      },
    });
    assert.equal(t.byExecutable.get("zig"), "zig");
    assert.equal(t.families.get("zig")!.names.length, 1);
    assert.ok(t.families.get("python")!.names.some((re) => re.test("custom_hook.py")));
    assert.ok(t.families.get("python")!.names.some((re) => re.test("conftest.py")), "built-ins are kept");
    assert.equal(t.byExecutable.get("dotnet"), "dotnet");
  });
});

describe("agent-created tripwire", () => {
  test("a dotfile or a file in a new directory trips the fingerprint; a plain new source file does not", () => {
    const dir = tmp();
    try {
      fs.writeFileSync(path.join(dir, "app.py"), "x=1\n");
      const approvals = new CommandApprovals(path.join(os.tmpdir(), `t-${path.basename(dir)}.json`));
      const fp = (created: { files: string[]; dirs: string[] }) => {
        const d = evaluateCommand("python app.py", { repoRoot: dir, approvals, agentCreated: created });
        return (d as any).fingerprint as string;
      };
      const base = fp({ files: [], dirs: [] });

      fs.writeFileSync(path.join(dir, "helper.py"), "y=1\n");
      assert.equal(fp({ files: ["helper.py"], dirs: [] }), base, "an ordinary new module does not re-prompt");

      fs.writeFileSync(path.join(dir, ".npmrc"), "x\n");
      assert.notEqual(fp({ files: [".npmrc"], dirs: [] }), base);

      fs.mkdirSync(path.join(dir, "gen"));
      fs.writeFileSync(path.join(dir, "gen", "mod.py"), "z=1\n");
      assert.notEqual(fp({ files: ["gen/mod.py"], dirs: ["gen"] }), base);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
