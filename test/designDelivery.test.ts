import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { KIT_IGNORED, stageDesignImage, writeKitGitignore } from "../src/designDelivery.js";
import { runDesign, type DesignDeps } from "../src/designer.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dd-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" });
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("the kit's .gitignore", () => {
  test("it lists only the regenerable working files, once, and never overwrites a person's own", () => {
    const dir = tmp();
    writeKitGitignore(dir);
    const first = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    for (const f of ["concepts/", "typography/", "guidelines.html", "guidelines-preview.png", "preview.png"]) assert.match(first, new RegExp(`^${f.replace(".", "\\.")}$`, "m"));
    for (const keep of ["brand.json", "logo", "favicon", "app-icon", "tokens", "fonts", "guidelines.pdf", "README"]) assert.ok(!first.split("\n").some((l) => !l.startsWith("#") && l.includes(keep)), keep);
    fs.writeFileSync(path.join(dir, ".gitignore"), "mine\n");
    writeKitGitignore(dir);
    assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8"), "mine\n");
    assert.doesNotThrow(() => writeKitGitignore(path.join(dir, "does", "not", "exist")));
  });

  test("with real git: the kit is committed, the working files are not", { skip: !hasGit }, () => {
    const repo = tmp();
    git(repo, "init", "-q");
    const kit = path.join(repo, "brand", "lumen");
    for (const f of ["brand.json", "logo.svg", "lockup-horizontal.svg", "favicon.svg", "app-icon-1024.png", "guidelines.pdf", "README.md", "fonts/OFL-poppins.txt", "palette/tokens.css", "concepts/concept-a.svg", "concepts/concept-a.png", "typography/option-a.png", "guidelines.html", "guidelines-preview.png", "preview.png"]) {
      fs.mkdirSync(path.dirname(path.join(kit, f)), { recursive: true });
      fs.writeFileSync(path.join(kit, f), "x");
    }
    writeKitGitignore(kit);
    const status = git(repo, "status", "--porcelain", "-uall");
    const listed = status.split("\n").filter(Boolean).map((l) => l.slice(3));
    for (const f of ["brand.json", "logo.svg", "lockup-horizontal.svg", "favicon.svg", "app-icon-1024.png", "guidelines.pdf", "README.md", "fonts/OFL-poppins.txt", "palette/tokens.css"]) assert.ok(listed.includes(`brand/lumen/${f}`), `${f} should be committed:\n${status}`);
    for (const f of ["concepts/concept-a.svg", "concepts/concept-a.png", "typography/option-a.png", "guidelines.html", "guidelines-preview.png", "preview.png"]) assert.ok(!listed.includes(`brand/lumen/${f}`), `${f} should be ignored`);
  });

  test("a design run writes it when the folder is made, so even a kit with nothing else yet is clean", async () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x" }));
    const call: DesignDeps["call"] = async (_m, _msgs, label) => {
      if (label === "brief") return JSON.stringify({ name: "Lumen", offering: "x", audience: "y", personality: [], avoid: [], constraints: [], assumptions: [] });
      if (label.startsWith("concepts")) return JSON.stringify({ concepts: [{ title: "A", markType: "abstract", idea: "i", construction: "c" }] });
      if (label.startsWith("draw")) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="38" fill="#2563eb"/></svg>';
      return "{}";
    };
    const res = await runDesign({ repoRoot: repo, models: ["a/x", "b/y"], visionModels: ["b/y"], call, renderer: null, log: () => {}, limits: { competitors: false } }, "logo");
    assert.ok(res.ok, res.text);
    const ig = fs.readFileSync(path.join(res.dir!, ".gitignore"), "utf-8");
    for (const f of KIT_IGNORED) assert.ok(ig.includes(f), f);
  });
});

describe("staging a picture for the phone", () => {
  test("it is copied into .agent/screenshots/ with a unique, safe name, and the original is left alone", () => {
    const repo = tmp();
    const src = path.join(repo, "brand", "x y", "concept (a).png");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, "PNGDATA");
    const a = stageDesignImage(repo, src);
    const b = stageDesignImage(repo, src);
    assert.notEqual(a, b);
    for (const p of [a, b]) {
      assert.equal(path.dirname(p), path.resolve(repo, ".agent", "screenshots"));
      assert.match(path.basename(p), /^design-\d+-\d+-concept__a_\.png$/);
      assert.equal(fs.readFileSync(p, "utf-8"), "PNGDATA");
    }
    assert.ok(fs.existsSync(src));
  });
  test("a missing file falls back to the original path instead of throwing", () => {
    const repo = tmp();
    const ghost = path.join(repo, "nope.png");
    assert.equal(stageDesignImage(repo, ghost), ghost);
  });
  test("the phone's own re-request would find it: the folder and base name match what the screenshot handler serves", () => {
    const repo = tmp();
    const src = path.join(repo, "a.png");
    fs.writeFileSync(src, "x");
    const staged = stageDesignImage(repo, src);
    // the handler reduces any request to basename(...) inside <repo>/.agent/screenshots
    const served = path.join(path.resolve(repo, ".agent", "screenshots"), path.basename(staged));
    assert.equal(served, staged);
    assert.ok(fs.existsSync(served));
  });
  test("the design job sends the staged copy to the phone", () => {
    const idx = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    assert.match(idx, /remote\.pushScreenshot\(`design_[^`]*`, label, stageDesignImage\(repoRoot, file\)\)/);
  });
});
