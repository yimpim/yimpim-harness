/**
 * A reference app is read without a model: every file accounted for, what each
 * declares, which parts use which, and an order that puts what others depend on
 * first. Nothing in it knows a platform.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildOrder, coverageFiles, renderInventory, scanReference } from "../src/referenceInventory.js";

const project = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

const ANDROID: Record<string, string> = {
  "ref/app/src/main/AndroidManifest.xml": `<manifest package="com.shop"><application/></manifest>`,
  "ref/app/build.gradle": `plugins { id 'com.android.application' }`,
  "ref/app/src/main/java/com/shop/cart/CartScreen.kt": `@Composable\nfun CartScreen(vm: CartViewModel) {}\n`,
  "ref/app/src/main/java/com/shop/cart/CartViewModel.kt": `class CartViewModel(private val repo: CartRepository) {}\n`,
  "ref/app/src/main/java/com/shop/data/CartRepository.kt": `class CartRepository(private val api: ShopApi, private val dao: CartDao) {}\n`,
  "ref/app/src/main/java/com/shop/data/CartDao.kt": `interface CartDao { fun all(): List<CartItem> }\n`,
  "ref/app/src/main/java/com/shop/model/CartItem.kt": `data class CartItem(val id: String)\n`,
  "ref/app/src/main/java/com/shop/network/ShopApi.kt": `interface ShopApi { fun items(): List<CartItem> }\n`,
  "ref/app/src/main/res/layout/activity_main.xml": `<LinearLayout/>`,
  "ref/app/src/main/res/drawable/logo.png": "binary",
  "ref/app/src/main/res/font/inter.ttf": "binary",
  "ref/app/src/test/java/com/shop/cart/CartViewModelTest.kt": `class CartViewModelTest { fun works() {} }\n`,
  "ref/app/build/generated/Junk.kt": `class Junk\n`,
  "ref/.git/config": "x",
};

describe("scanning", () => {
  test("every source file is accounted for; images and fonts are counted, never read; build output and .git are skipped", () => {
    const inv = scanReference(project(ANDROID), "ref");
    assert.equal(inv.assets, 2);
    assert.ok(!inv.files.some((f) => /Junk|\.git|build\//.test(f.path)));
    assert.equal(inv.scanned, inv.files.length);
    assert.ok(inv.files.some((f) => f.path.endsWith("CartScreen.kt")));
    assert.equal(inv.truncated, false);
  });

  test("it reads what each file declares", () => {
    const inv = scanReference(project(ANDROID), "ref");
    const f = (n: string) => inv.files.find((x) => x.path.endsWith(n))!;
    assert.deepEqual(f("CartRepository.kt").symbols, ["CartRepository"]);
    assert.deepEqual(f("CartScreen.kt").symbols, ["CartScreen"]);
  });

  test("a role is judged from the name and shape, with no platform list", () => {
    const inv = scanReference(project(ANDROID), "ref");
    const role = (n: string) => inv.files.find((x) => x.path.endsWith(n))!.role;
    assert.equal(role("CartScreen.kt"), "ui");
    assert.equal(role("CartViewModel.kt"), "state");
    assert.equal(role("CartRepository.kt"), "data");
    assert.equal(role("ShopApi.kt"), "network");
    assert.equal(role("CartItem.kt"), "model");
    assert.equal(role("CartViewModelTest.kt"), "test");
    assert.equal(role("build.gradle"), "build");
    assert.equal(role("activity_main.xml"), "resource");
    assert.equal(role("AndroidManifest.xml"), "config");
  });

  test("the same scan works on a different platform's files", () => {
    const d = project({
      "ios/Cart/CartView.swift": `import SwiftUI\nstruct CartView: View { var model: CartModel }\n`,
      "ios/Cart/CartModel.swift": `final class CartModel { }\n`,
      "ios/Net/ApiClient.swift": `final class ApiClient { }\n`,
    });
    const inv = scanReference(d, "ios");
    assert.deepEqual(inv.files.find((f) => f.path.endsWith("CartView.swift"))!.symbols, ["CartView"]);
    assert.equal(inv.files.find((f) => f.path.endsWith("CartView.swift"))!.role, "ui");
  });

  test("a folder that is not there is an empty inventory, and one that is huge is cut at the limit and says so", () => {
    const d = project(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`ref/f${i}.ts`, `export const a${i} = 1;\n`])));
    assert.equal(scanReference(d, "nowhere").files.length, 0);
    const cut = scanReference(d, "ref", { maxFiles: 10 });
    assert.equal(cut.files.length, 10);
    assert.equal(cut.truncated, true);
  });

  test("a file too large to read is listed and counted, not parsed", () => {
    const d = project({ "ref/Big.kt": `class Big\n` + "x".repeat(2000), "ref/Small.kt": `class Small\n` });
    const inv = scanReference(d, "ref", { maxFileBytes: 500 });
    assert.equal(inv.skippedLarge, 1);
    assert.deepEqual(inv.files.find((f) => f.path.endsWith("Big.kt"))!.symbols, []);
  });

  test("it only looks inside the folder it was given", () => {
    const d = project({ "ref/A.kt": `class Alpha\n`, "other/B.kt": `class Beta\n` });
    assert.deepEqual(scanReference(d, "ref").files.map((f) => f.path), ["ref/A.kt"]);
  });
});

describe("modules and what uses what", () => {
  const twoLayers = () =>
    project({
      "ref/app/Home.kt": `class Home { val c: CoreClock }\n`,
      "ref/app/Settings.kt": `class Settings { val s: CoreStore }\n`,
      "ref/app/Profile.kt": `class Profile { val c: CoreClock }\n`,
      "ref/app/Search.kt": `class Search { val c: CoreClock }\n`,
      "ref/zcore/CoreClock.kt": `class CoreClock\n`,
      "ref/zcore/CoreStore.kt": `class CoreStore\n`,
      "ref/zcore/CoreLog.kt": `class CoreLog\n`,
      "ref/zcore/CoreNet.kt": `class CoreNet\n`,
    });

  test("a large folder is split into modules, and every file lands in exactly one", () => {
    const inv = scanReference(project(ANDROID), "ref", { maxModuleFiles: 3 });
    assert.ok(inv.modules.length > 1);
    const all = inv.modules.flatMap((m) => m.files).sort();
    assert.deepEqual(all, inv.files.map((f) => f.path).sort());
  });

  test("a file that mentions a type declared in another module depends on that module", () => {
    const inv = scanReference(twoLayers(), "ref", { maxModuleFiles: 4 });
    const app = inv.modules.find((m) => m.dir.endsWith("app"))!;
    const core = inv.modules.find((m) => m.dir.endsWith("zcore"))!;
    const edge = inv.edges.find((e) => e.from === app.id && e.to === core.id);
    assert.ok(edge && edge.weight >= 3);
    assert.ok(!inv.edges.some((e) => e.from === core.id && e.to === app.id));
  });

  test("a type declared in two places is ambiguous, so it creates no dependency", () => {
    const d = project({
      "ref/a/User.kt": `class UserCard\n`,
      "ref/b/Other.kt": `class UserCard\n`,
      "ref/c/Use.kt": `class Use { val u: UserCard }\n`,
      "ref/c/Use2.kt": `class Use2\n`,
      "ref/c/Use3.kt": `class Use3\n`,
    });
    const inv = scanReference(d, "ref", { maxModuleFiles: 1 });
    assert.equal(inv.edges.length, 0);
  });

  test("tests are not dependencies of anything", () => {
    const inv = scanReference(project(ANDROID), "ref", { maxModuleFiles: 2 });
    const testMod = inv.modules.filter((m) => m.files.every((f) => /Test\.kt$/.test(f)));
    for (const m of testMod) assert.ok(!inv.edges.some((e) => e.to === m.id));
  });

  test("the build order puts what others depend on first, not what sorts first", () => {
    const inv = scanReference(twoLayers(), "ref", { maxModuleFiles: 4 });
    const order = buildOrder(inv).flat();
    const core = inv.modules.find((m) => m.dir.endsWith("zcore"))!.id;
    const app = inv.modules.find((m) => m.dir.endsWith("app"))!.id;
    assert.ok(order.indexOf(core) < order.indexOf(app), `order was ${order.join(" ")}`);
  });

  test("modules that depend on each other in a loop are one group, to be done together", () => {
    const d = project({
      "ref/a/Alpha.kt": `class Alpha { val b: Beta }\n`,
      "ref/a/Al2.kt": `class Al2\n`,
      "ref/b/Beta.kt": `class Beta { val a: Alpha }\n`,
      "ref/b/Be2.kt": `class Be2\n`,
    });
    const inv = scanReference(d, "ref", { maxModuleFiles: 2 });
    const groups = buildOrder(inv);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 2);
  });
});

describe("telling a model about it", () => {
  test("it lists each module with its size, roles, names, and what it uses, dependencies first", () => {
    const d = project({
      "ref/app/Home.kt": `class Home { val c: CoreClock }\n`,
      "ref/app/Settings.kt": `class Settings\n`,
      "ref/app/Profile.kt": `class Profile\n`,
      "ref/app/Search.kt": `class Search\n`,
      "ref/zcore/CoreClock.kt": `class CoreClock\n`,
      "ref/zcore/CoreStore.kt": `class CoreStore\n`,
      "ref/zcore/CoreLog.kt": `class CoreLog\n`,
      "ref/zcore/CoreNet.kt": `class CoreNet\n`,
    });
    const text = renderInventory(scanReference(d, "ref", { maxModuleFiles: 4 }))[0];
    assert.match(text, /REFERENCE: ref — 8 source file\(s\)/);
    assert.match(text, /zcore — 4 files/);
    assert.match(text, /CoreClock/);
    assert.match(text, /app — 4 files.* uses M00\d/);
    assert.ok(text.indexOf("zcore") < text.indexOf("M001 ref/app") || text.indexOf("zcore") < text.lastIndexOf("ref/app"));
  });

  test("a large inventory is split into pieces that each fit", () => {
    const files = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`ref/m${i}/File${i}.kt`, `class File${i}\n`]));
    const inv = scanReference(project(files), "ref", { maxModuleFiles: 1 });
    const chunks = renderInventory(inv, 1500);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length < 2000));
    assert.ok(chunks.slice(1).every((c) => c.includes("(continued)")));
  });

  test("the files a roadmap must account for leave out build plumbing but keep resources and tests", () => {
    const inv = scanReference(project(ANDROID), "ref");
    const files = coverageFiles(inv);
    assert.ok(!files.some((f) => f.endsWith("build.gradle")));
    assert.ok(files.some((f) => f.endsWith("activity_main.xml")));
    assert.ok(files.some((f) => f.endsWith("CartViewModelTest.kt")));
  });
});
