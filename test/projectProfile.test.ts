import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectProject } from "../src/projectProfile.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-projectprofile-test-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("detectProject", () => {
  test("a bare index.html with no package.json is detected as web, via file:// entryFile", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "index.html"), "<html><body>hi</body></html>\n");

    const profile = await detectProject(dir);
    assert.deepEqual(profile.stacks, ["web"]);
    assert.equal(profile.web?.entryFile, "index.html");
    assert.equal(profile.web?.packageManager, undefined, "a package.json-less project has no package manager");
  });

  test("a package.json with no framework and no scripts is not treated as web", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "lib", version: "1.0.0" }));

    const profile = await detectProject(dir);
    assert.deepEqual(profile.stacks, ["cli"]);
  });

  test("a Node project with a UI framework dependency is detected as web via npm", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "^18.0.0" }, scripts: { dev: "vite" } })
    );

    const profile = await detectProject(dir);
    assert.deepEqual(profile.stacks, ["web"]);
    assert.equal(profile.web?.packageManager, "npm");
    assert.equal(profile.web?.devScript, "dev");
  });

  test("react-native is detected instead of plain web, even though both share the 'react' dependency", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "^18.0.0", "react-native": "^0.74.0" } })
    );
    await fs.mkdir(path.join(dir, "android"));

    const profile = await detectProject(dir);
    assert.ok(profile.stacks.includes("react-native"));
    assert.ok(!profile.stacks.includes("web"), "react-native's own dev server must not also be treated as a browsable web app");
    assert.equal(profile.reactNative?.hasAndroid, true);
  });

  test("an Expo project is flagged isExpo with candidateUrls and a detected package manager, not also treated as plain web", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "^18.0.0", expo: "^51.0.0" } })
    );
    await fs.writeFile(path.join(dir, "yarn.lock"), "");

    const profile = await detectProject(dir);
    assert.ok(profile.stacks.includes("react-native"));
    assert.ok(!profile.stacks.includes("web"), "Expo's own dev server must not also be treated as a plain browsable web app");
    assert.equal(profile.reactNative?.isExpo, true);
    assert.equal(profile.reactNative?.packageManager, "yarn");
    assert.ok(profile.reactNative?.candidateUrls.length ?? 0 > 0, "must have fallback URLs for expo start --web");
    assert.ok(profile.reactNative?.candidateUrls.includes("http://localhost:8081"));
  });

  test("a non-Expo react-native project has no candidateUrls and no packageManager, since nothing probes it via a browser", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "^18.0.0", "react-native": "^0.74.0" } })
    );

    const profile = await detectProject(dir);
    assert.equal(profile.reactNative?.isExpo, false);
    assert.equal(profile.reactNative?.packageManager, undefined);
    assert.deepEqual(profile.reactNative?.candidateUrls, []);
  });

  test("an Android app module using the classic id(\"com.android.application\") plugin syntax is detected", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "settings.gradle.kts"), 'rootProject.name = "app"\ninclude(":app")\n');
    await fs.mkdir(path.join(dir, "app"));
    await fs.writeFile(
      path.join(dir, "app", "build.gradle.kts"),
      'plugins {\n    id("com.android.application")\n    id("org.jetbrains.kotlin.android")\n}\n'
    );

    const profile = await detectProject(dir);
    assert.ok(profile.stacks.includes("android"));
    assert.equal(profile.android?.moduleDir, "app");
    assert.equal(profile.android?.assembleTask, ":app:assembleDebug");
  });

  test("an Android app module declared via a version-catalog plugin alias is still detected", async () => {
    // The default Android Studio template since ~2023 applies the plugin via
    // `alias(libs.plugins.android.application)`, with the actual plugin id living only
    // in gradle/libs.versions.toml — the literal string "com.android.application" never
    // appears in the module's own build script in this case.
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "settings.gradle.kts"), 'rootProject.name = "app"\ninclude(":app")\n');
    await fs.mkdir(path.join(dir, "gradle"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "gradle", "libs.versions.toml"),
      '[versions]\nagp = "8.5.0"\n\n[plugins]\nandroid-application = { id = "com.android.application", version.ref = "agp" }\nkotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }\n'
    );
    await fs.mkdir(path.join(dir, "app"));
    await fs.writeFile(
      path.join(dir, "app", "build.gradle.kts"),
      "plugins {\n    alias(libs.plugins.android.application)\n    alias(libs.plugins.kotlin.android)\n}\n"
    );

    const profile = await detectProject(dir);
    assert.ok(profile.stacks.includes("android"), "version-catalog alias syntax must resolve to the android stack");
    assert.equal(profile.android?.moduleDir, "app");
    assert.equal(profile.android?.assembleTask, ":app:assembleDebug");
  });

  test("a go.mod is detected as a go project", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "go.mod"), "module example.com/thing\n\ngo 1.22\n");

    const profile = await detectProject(dir);
    assert.ok(profile.stacks.includes("go"));
  });

  test("an empty directory with no recognizable markers falls back to cli", async () => {
    const dir = await makeTempDir();

    const profile = await detectProject(dir);
    assert.deepEqual(profile.stacks, ["cli"]);
    assert.equal(profile.primary, "cli");
  });

  test("pnpm-lock.yaml is picked up as the package manager for a web project", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { vue: "^3.0.0" }, scripts: { dev: "vite" } })
    );
    await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const profile = await detectProject(dir);
    assert.equal(profile.web?.packageManager, "pnpm");
  });
});

describe("plugin-host detection (not a browsable web app)", () => {
  test("a Power BI custom visual with a generic start script is NOT treated as web", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "pbiviz.json"), JSON.stringify({ visual: { name: "myVisual" } }));
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "my-visual", scripts: { start: "pbiviz start" } })
    );

    const profile = await detectProject(dir);
    assert.equal(profile.web, undefined);
    assert.ok(!profile.stacks.includes("web"));
    assert.ok(profile.notes.some((n) => n.includes("Power BI custom visual")));
  });

  test("a VS Code extension with engines.vscode is NOT treated as web, even with a dev script", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "my-ext", engines: { vscode: "^1.80.0" }, scripts: { dev: "webpack --watch" } })
    );

    const profile = await detectProject(dir);
    assert.equal(profile.web, undefined);
    assert.ok(profile.notes.some((n) => n.includes("VS Code extension")));
  });

  test("a VS Code extension is excluded even if it depends on React for a webview", async () => {
    // The whole point: a real UI framework dependency is not evidence this is
    // independently browsable — it renders inside VS Code's webview, never at
    // a plain localhost URL, regardless of what it's built with internally.
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "my-ext",
        engines: { vscode: "^1.80.0" },
        dependencies: { react: "^18.0.0" },
        scripts: { dev: "webpack --watch" },
      })
    );

    const profile = await detectProject(dir);
    assert.equal(profile.web, undefined);
  });

  test("a browser extension manifest is NOT treated as web", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "my-ext", background: { service_worker: "bg.js" } })
    );
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "my-ext", scripts: { start: "web-ext run" } }));

    const profile = await detectProject(dir);
    assert.equal(profile.web, undefined);
    assert.ok(profile.notes.some((n) => n.includes("browser extension")));
  });

  test("a Figma plugin manifest is NOT treated as web", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ name: "my-plugin", api: "1.0.0", main: "code.js", editorType: ["figma"] })
    );
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "my-plugin", scripts: { build: "webpack" } }));

    const profile = await detectProject(dir);
    assert.equal(profile.web, undefined);
    assert.ok(profile.notes.some((n) => n.includes("Figma")));
  });

  test("an ordinary manifest.json with neither shape does not false-positive as a plugin host", async () => {
    // Plenty of ordinary web/PWA projects also ship a manifest.json — this
    // must never be mistaken for a browser extension or Figma plugin.
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ name: "My PWA", icons: [] }));
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "^18.0.0" }, scripts: { dev: "vite" } })
    );

    const profile = await detectProject(dir);
    assert.deepEqual(profile.stacks, ["web"]);
  });

  test("an ordinary React app with no plugin-host marker is completely unaffected", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "^18.0.0" }, scripts: { dev: "vite" } })
    );

    const profile = await detectProject(dir);
    assert.deepEqual(profile.stacks, ["web"]);
    assert.equal(profile.web?.devScript, "dev");
  });
});
