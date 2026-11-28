import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_NATIVE_REBUILD_ALLOWLIST,
  buildTargetedRebuildInvocation,
  formatRebuildEscalationQuestion,
  isAllowlistedNativePackage,
  planPostInstallRebuild,
  readInstalledLifecycleScripts,
} from "../src/nativeRebuild.js";

describe("nativeRebuild escape hatch", () => {
  it("recognizes default allowlisted native/binary packages and custom allowlists", () => {
    for (const pkg of [
      "esbuild",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "puppeteer",
      "playwright",
      "@swc/core",
      "lightningcss",
    ]) {
      assert.equal(isAllowlistedNativePackage(pkg), true, `${pkg} should be allowlisted`);
    }
    assert.equal(isAllowlistedNativePackage("evil-pkg"), false);
    assert.equal(isAllowlistedNativePackage("custom-native", ["custom-native"]), true);
    assert.ok(DEFAULT_NATIVE_REBUILD_ALLOWLIST.includes("esbuild"));
  });

  it("auto-rebuilds allowlisted packages that pass verification and escalates when verification warns", () => {
    const scripts = { postinstall: "node install.js" };
    const autoPlan = planPostInstallRebuild({
      pkgName: "esbuild",
      lifecycleScripts: scripts,
      passedVerification: true,
    });
    assert.equal(autoPlan.action, "auto_rebuild");

    const warnedPlan = planPostInstallRebuild({
      pkgName: "esbuild",
      lifecycleScripts: scripts,
      passedVerification: false,
    });
    assert.equal(warnedPlan.action, "escalate_human");
  });

  it("escalates non-allowlisted packages with preinstall/install/postinstall scripts to human approval", () => {
    const scripts = { postinstall: "node scripts/download-binary.js" };
    const plan = planPostInstallRebuild({
      pkgName: "untrusted-native-addon",
      lifecycleScripts: scripts,
      passedVerification: true,
    });
    assert.equal(plan.action, "escalate_human");
    const question = formatRebuildEscalationQuestion("EDITOR", "untrusted-native-addon", scripts);
    assert.match(question, /postinstall: node scripts\/download-binary\.js/);
    assert.match(question, /npm rebuild untrusted-native-addon --ignore-scripts=false/);
  });

  it("returns action 'none' when a package has no install lifecycle scripts", () => {
    const plan = planPostInstallRebuild({
      pkgName: "zod",
      lifecycleScripts: undefined,
      passedVerification: true,
    });
    assert.equal(plan.action, "none");
  });

  it("builds a strictly scoped single-package npm rebuild invocation and rejects invalid names", () => {
    const inv = buildTargetedRebuildInvocation("@swc/core", {
      PATH: "/usr/bin",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
    });
    assert.deepEqual(inv.argv, ["rebuild", "@swc/core", "--ignore-scripts=false"]);
    assert.equal(inv.env.NPM_CONFIG_IGNORE_SCRIPTS, "false");
    assert.equal(inv.env.npm_config_ignore_scripts, "false");

    assert.throws(() => buildTargetedRebuildInvocation("esbuild; rm -rf /", {}));
    assert.throws(() => buildTargetedRebuildInvocation("../escape", {}));
  });

  it("reads preinstall/install/postinstall scripts from node_modules/<pkg>/package.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-rebuild-"));
    try {
      const pkgDir = path.join(tmp, "node_modules", "@swc", "core");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          name: "@swc/core",
          version: "1.10.0",
          scripts: {
            postinstall: "node postinstall.js",
            test: "jest",
          },
        })
      );
      const scripts = readInstalledLifecycleScripts("@swc/core", [tmp]);
      assert.deepEqual(scripts, { postinstall: "node postinstall.js" });
      assert.equal(readInstalledLifecycleScripts("nonexistent-pkg", [tmp]), undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
