/**
 * Screen capture for a UI critique: discovery across stacks, picking at most six, the gating rules (a redirect, a 401/403, or the same image as
 * an earlier screen means sign-in or app state is needed), screenshots the person gives, and the guard that nothing a routine run executes can
 * start it.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverScreens,
  pickScreens,
  captureScreens,
  providedScreens,
  captureAppScreens,
  describeCapture,
  routeUrl,
  staticFileFor,
  serveStatic,
  screenName,
  MAX_SCREENS,
  PHONE,
  DESKTOP,
  type OpenPage,
  type ScreenCandidate,
} from "../src/uiCapture.js";

const roots: string[] = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function repo(files: Record<string, string>, deps: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-capture-"));
  roots.push(root);
  if (deps.length) files["package.json"] = JSON.stringify({ dependencies: Object.fromEntries(deps.map((d) => [d, "1.0.0"])) });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const routes = (r: string) => discoverScreens(r).candidates.filter((c) => !c.skip).map((c) => c.route).sort();
const skips = (r: string) => Object.fromEntries(discoverScreens(r).candidates.filter((c) => c.skip).map((c) => [c.route, c.skip!]));

describe("discovery, one stack at a time", () => {
  test("Expo Router: layouts and +files are not screens, groups vanish, index is its folder, [id] needs a value, debug is skipped", () => {
    const r = repo(
      { "app/_layout.tsx": "", "app/index.tsx": "", "app/settings.tsx": "", "app/(tabs)/history.tsx": "", "app/session/[id].tsx": "", "app/+not-found.tsx": "", "app/debug.tsx": "" },
      ["expo-router"]
    );
    assert.deepEqual(routes(r), ["/", "/history", "/settings"]);
    assert.match(skips(r)["/session/[id]"], /needs a value for \[id\]/);
    assert.match(skips(r)["/debug"], /a debug page, not a product screen/);
    assert.equal(discoverScreens(r).router, "Expo Router");
  });

  test("Next.js app router: page files only; groups vanish; private folders and parallel slots are not routes", () => {
    const r = repo(
      { "app/page.tsx": "", "app/layout.tsx": "", "app/(marketing)/pricing/page.tsx": "", "app/dashboard/page.tsx": "", "app/dashboard/@modal/page.tsx": "", "app/_parts/page.tsx": "", "app/products/[slug]/page.tsx": "" },
      ["next"]
    );
    assert.deepEqual(routes(r), ["/", "/dashboard", "/pricing"]);
    assert.ok(skips(r)["/products/[slug]"]);
  });

  test("Next.js pages router: _app, _document and API routes are not screens", () => {
    const r = repo({ "pages/index.tsx": "", "pages/_app.tsx": "", "pages/_document.tsx": "", "pages/api/users.ts": "", "pages/about.tsx": "", "pages/blog/[id].tsx": "" }, ["next"]);
    assert.deepEqual(routes(r), ["/", "/about"]);
  });

  test("SvelteKit, Astro, Nuxt and Remix file routes", () => {
    assert.deepEqual(routes(repo({ "src/routes/+page.svelte": "", "src/routes/(app)/account/+page.svelte": "", "src/routes/+layout.svelte": "" }, ["@sveltejs/kit"])), ["/", "/account"]);
    assert.deepEqual(routes(repo({ "src/pages/index.astro": "", "src/pages/privacy.md": "", "src/pages/_draft.astro": "" }, ["astro"])), ["/", "/privacy"]);
    assert.deepEqual(routes(repo({ "pages/index.vue": "", "pages/cart.vue": "" }, ["nuxt"])), ["/", "/cart"]);
    const remix = repo({ "app/routes/_index.tsx": "", "app/routes/settings.profile.tsx": "", "app/routes/_auth.login.tsx": "", "app/routes/api.users.ts": "", "app/routes/products.$id.tsx": "" }, ["@remix-run/react"]);
    assert.deepEqual(routes(remix), ["/", "/login", "/settings/profile"]);
    assert.ok(skips(remix)["/products/$id"]);
  });

  test("a route table in code (React Router, Vue Router) when there is no file router", () => {
    const r = repo({ "src/App.tsx": `<Routes><Route path="/checkout" element={<C/>} /></Routes>\nconst routes = [{ path: "/orders", component: O }, { path: '/' }];` }, ["react-router-dom"]);
    assert.deepEqual(routes(r), ["/", "/checkout", "/orders"]);
    assert.equal(discoverScreens(r).router, "route table in code");
  });

  const doc = (body = "") => `<!doctype html><html lang="en"><body>${body}</body></html>`;

  test("a plain HTML site: its full documents are pages; fragments and templates are not", () => {
    const r = repo({ "index.html": doc("<h1>x</h1>"), "privacy.html": doc(), "nav.html": "<nav>fragment</nav>", "layout.html": doc("{{content}}"), "node_modules/x/index.html": doc() });
    assert.deepEqual(routes(r), ["/", "/privacy"]);
    const d = discoverScreens(r);
    assert.equal(d.router, "HTML files");
    assert.equal(d.staticRoot, ".");
  });

  test("a static site with a build step: its built pages, not its templates (a marketing or legal site)", () => {
    const r = repo(
      { "package.json": JSON.stringify({ scripts: { build: "node build.mjs" } }), "src/layout.html": doc("{{content}}"), "src/pages/terms.html": "<h1>Terms</h1>", "dist/index.html": doc(), "dist/privacy/index.html": doc(), "dist/terms.html": doc(), "dist/404.html": doc() },
    );
    const d = discoverScreens(r);
    assert.equal(d.router, "built static site (dist/)");
    assert.equal(d.staticRoot, "dist");
    assert.deepEqual(routes(r), ["/", "/privacy", "/terms"]);
    assert.match(skips(r)["/404"], /a 404 page/);
  });

  test("a native app's nav map: screens known only by name, with nothing to open", () => {
    const r = repo({ ".agent/nav_map.json": JSON.stringify({ RootLayout: { file: "app/src/main/MainLayout.kt" }, Home: { file: "app/src/main/HomeScreen.kt" }, Cart: { file: "app/src/main/CartScreen.kt" } }) });
    const d = discoverScreens(r);
    assert.deepEqual(d.candidates, []);
    assert.deepEqual(d.nameOnly, ["Home", "Cart"]);
  });

  test("the nav map names screens the router maps, and its order is kept", () => {
    const r = repo(
      { "app/index.tsx": "", "app/settings.tsx": "", "app/history.tsx": "", ".agent/nav_map.json": JSON.stringify({ SettingsScreen: { file: "app/settings.tsx" }, HistoryScreen: { file: "app\\history.tsx" } }) },
      ["expo-router"]
    );
    const c = discoverScreens(r).candidates;
    assert.deepEqual(c.slice(0, 2).map((x) => [x.name, x.route, x.from]), [["SettingsScreen", "/settings", "nav map"], ["HistoryScreen", "/history", "nav map"]]);
  });

  test("the QA setup's launch path and deep links come first: they are how a person said to get past sign-in", () => {
    const r = repo(
      { "app/index.tsx": "", "app/orders.tsx": "", ".agent/qa-setup.json": JSON.stringify({ launchPath: "/dashboard?demo=1", deepLinks: [{ name: "Orders", url: "/orders" }, { name: "App link", url: "myapp://x" }] }) },
      ["expo-router"]
    );
    const c = discoverScreens(r).candidates;
    assert.deepEqual(c.slice(0, 2).map((x) => [x.route, x.priority]), [["/dashboard?demo=1", true], ["/orders", true]]);
    assert.ok(!c.some((x) => x.route.startsWith("myapp:")), "a custom-scheme deep link is not a web route");
    assert.equal(pickScreens(c).chosen[0].route, "/dashboard?demo=1");
  });

  test("a plain route with the same path as a QA-setup one is that screen without its state: one slot, not two", () => {
    const r = repo({ "app/index.tsx": "", "app/dashboard.tsx": "", ".agent/qa-setup.json": JSON.stringify({ launchPath: "/dashboard?demo=1" }) }, ["expo-router"]);
    assert.deepEqual(discoverScreens(r).candidates.map((c) => c.route), ["/dashboard?demo=1", "/"]);
  });

  test("screen names read like names", () => {
    assert.equal(screenName("/"), "Home");
    assert.equal(screenName("/order-history?x=1"), "Order history");
    assert.equal(screenName("public/terms.html"), "Terms");
    assert.equal(screenName("/privacy/index.html"), "Privacy");
  });
});

describe("picking", () => {
  const c = (route: string, extra: Partial<ScreenCandidate> = {}): ScreenCandidate => ({ route, name: screenName(route), from: "x", ...extra });

  test(`${MAX_SCREENS} chosen: priority, then the root, then the shallowest; the rest wait as spares, and what can never open is skipped`, () => {
    const all = [c("/a/b/c"), c("/x"), c("/"), c("/y"), c("/z/q"), c("/w"), c("/v"), c("/u"), c("/p", { priority: true }), c("/s/[id]", { skip: "needs a value" })];
    const { chosen, spares, skipped } = pickScreens(all);
    assert.deepEqual(chosen.map((s) => s.route), ["/p", "/", "/x", "/y", "/w", "/v"]);
    assert.deepEqual(spares.map((s) => s.route), ["/u", "/z/q", "/a/b/c"]);
    assert.deepEqual(skipped.map((s) => [s.route, s.reason]), [["/s/[id]", "needs a value"]]);
  });

  test("a gated screen hands its slot to the next spare; past the limit, the rest are reported, not dropped silently", async () => {
    const root = repo({});
    const list = ["/", "/gated", "/a", "/b", "/c"].map((route) => c(route));
    const r = await captureScreens({
      repoRoot: root,
      baseUrl: "http://localhost:1",
      screens: list,
      cap: 3,
      viewports: [PHONE],
      outDir: path.join(root, "out"),
      open: async (url) => (url.endsWith("/gated") ? { finalUrl: "http://localhost:1/login", status: 200, png: Buffer.from("l") } : { finalUrl: url, status: 200, png: Buffer.from(url) }),
    });
    assert.deepEqual(r.screens.map((s) => s.route), ["/", "/a", "/b"]);
    assert.deepEqual(r.skipped.map((s) => [s.route, s.reason.split(":")[0]]), [["/gated", "redirected to /login"], ["/c", "over the 3-screen limit"]]);
  });
});

describe("capturing", () => {
  const png = (n: number) => Buffer.from(`png-${n}`);
  const screens: ScreenCandidate[] = ["/", "/settings", "/dashboard", "/account", "/admin", "/broken", "/again"].map((route) => ({ route, name: screenName(route), from: "x" }));
  const open: OpenPage = async (url, vp) => {
    const p = new URL(url).pathname;
    if (p === "/dashboard") return { finalUrl: new URL("/login?next=dashboard", url).href, status: 200, png: png(9) };
    if (p === "/account") return { finalUrl: url, status: 401, png: png(8) };
    if (p === "/broken") throw new Error("net::ERR_CONNECTION_RESET\nat ...");
    if (p === "/again") return { finalUrl: url, status: 200, png: png(vp.width) }; // the same image the root gave
    if (p === "/admin") return { finalUrl: url, status: 500, png: png(7) };
    return { finalUrl: url, status: 200, png: p === "/" ? png(vp.width) : png(vp.width + 1) };
  };

  test("captured screens are saved per size; gated, refused, broken and repeated screens are skipped with why", async () => {
    const root = repo({});
    const out = path.join(root, "design-system/critique/before");
    const r = await captureScreens({ repoRoot: root, baseUrl: "http://localhost:8081", screens, viewports: [PHONE, DESKTOP], outDir: out, open });
    assert.deepEqual(r.screens.map((s) => s.file), [
      "design-system/critique/before/home-phone.png",
      "design-system/critique/before/home-desktop.png",
      "design-system/critique/before/settings-phone.png",
      "design-system/critique/before/settings-desktop.png",
    ]);
    for (const s of r.screens) assert.ok(fs.existsSync(path.join(root, s.file)));
    const why = Object.fromEntries(r.skipped.map((s) => [s.route, s.reason]));
    assert.match(why["/dashboard"], /^redirected to \/login\?next=dashboard: needs sign-in or app state/);
    assert.match(why["/account"], /^refused with 401: needs sign-in/);
    assert.match(why["/broken"], /^could not be opened \(net::ERR_CONNECTION_RESET\)$/);
    assert.match(why["/again"], /^showed exactly what Home showed/);
    assert.equal(why["/admin"], "answered 500");
  });

  test("a screen that throws while loading is reported as crashed, not judged as a design", async () => {
    const root = repo({});
    const r = await captureScreens({
      repoRoot: root,
      baseUrl: "http://localhost:1",
      screens: [{ route: "/", name: "Home", from: "x" }, { route: "/dash", name: "Dash", from: "x" }],
      viewports: [PHONE],
      outDir: path.join(root, "out"),
      open: async (url) => (url.endsWith("/dash") ? { finalUrl: url, status: 200, png: Buffer.from("overlay"), errors: ["styles is not defined"] } : { finalUrl: url, status: 200, png: Buffer.from("home") }),
    });
    assert.deepEqual(r.screens.map((s) => s.name), ["Home"]);
    assert.deepEqual(r.skipped, [{ route: "/dash", name: "Dash", reason: "it crashed while loading (styles is not defined): fix that before judging its design" }]);
  });

  test("routes become URLs on the app's server", () => {
    assert.equal(routeUrl("http://localhost:3000", "/pricing?x=1"), "http://localhost:3000/pricing?x=1");
    assert.equal(routeUrl("http://127.0.0.1:5000/", "/"), "http://127.0.0.1:5000/");
  });

  test("a static site is served on loopback, so its root-relative links work; nothing outside its folder is served", async () => {
    const root = repo({ "dist/index.html": "<html>home</html>", "dist/privacy/index.html": "<html>privacy</html>", "dist/terms.html": "<html>terms</html>", "dist/assets/site.css": "body{}", "secret.txt": "no" });
    const dist = path.join(root, "dist");
    assert.equal(staticFileFor(dist, "/privacy"), path.join(dist, "privacy", "index.html"));
    assert.equal(staticFileFor(dist, "/terms"), path.join(dist, "terms.html"));
    assert.equal(staticFileFor(dist, "/../secret.txt"), null);
    assert.equal(staticFileFor(dist, "/%2e%2e/secret.txt"), null);
    const served = await serveStatic(dist);
    try {
      assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const page = await fetch(served.url + "/privacy");
      assert.equal(await page.text(), "<html>privacy</html>");
      const css = await fetch(served.url + "/assets/site.css");
      assert.equal(css.headers.get("content-type"), "text/css");
      assert.equal((await fetch(served.url + "/../secret.txt")).status, 404);
    } finally {
      served.stop();
    }
  });

  test("screenshots the person gives are added; anything that is not an image is refused, not sent", async () => {
    const root = repo({ "shots/Dashboard.png": "\x89PNG\r\n\x1a\nfake", "shots/notes.txt": "hello" });
    const out = path.join(root, "design-system/critique/before");
    const r = await providedScreens([path.join(root, "shots/Dashboard.png"), path.join(root, "shots/notes.txt")], root, out);
    assert.deepEqual(r.screens.map((s) => [s.name, s.viewport, s.file]), [["Dashboard", "provided", "design-system/critique/before/provided-dashboard.png"]]);
    assert.match(r.refused[0], /notes\.txt: not an image/);
  });
});

describe("the whole step", () => {
  test("starts the app, captures, stops it, adds the person's screenshots, and writes the record beside them", async () => {
    const root = repo({ "app/index.tsx": "", "app/settings.tsx": "", "shot.png": "\x89PNG\r\n\x1a\nx" }, ["expo-router"]);
    let stopped = false;
    const r = await captureAppScreens({
      repoRoot: root,
      provided: [path.join(root, "shot.png")],
      server: { start: async () => ({ baseUrl: "http://localhost:8081", stop: () => (stopped = true), viewports: [PHONE] }) },
      open: async (url) => ({ finalUrl: url, status: 200, png: Buffer.from(url) }),
    });
    assert.equal(stopped, true);
    assert.deepEqual(r.screens.map((s) => s.name), ["Home", "Settings", "shot"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "design-system/critique/before/capture.json"), "utf8"));
    assert.equal(manifest.router, "Expo Router");
    assert.equal(manifest.screens.length, 3);
  });

  test("what the QA setup seeds or mocks goes into the record, so a judge knows the fixture buttons are not the product", async () => {
    const root = repo({ "app/index.tsx": "", ".agent/qa-setup.json": JSON.stringify({ launchPath: "/", notes: "Signed-in fixture.", mockNotes: "Fixture buttons are QA-only." }) }, ["expo-router"]);
    const r = await captureAppScreens({ repoRoot: root, server: { start: async () => ({ unavailable: "x" }) }, open: async () => { throw new Error("never"); } });
    assert.equal(r.setupNotes, "Signed-in fixture.\nFixture buttons are QA-only.");
  });

  test("with no web build, or no browser, it says so, and the person's screenshots still count", async () => {
    const root = repo({ "app/index.tsx": "", "shot.png": "\x89PNG\r\n\x1a\nx" }, ["expo-router"]);
    const noWeb = await captureAppScreens({ repoRoot: root, provided: [path.join(root, "shot.png")], server: { start: async () => ({ unavailable: "this project has no web build to open" }) }, open: async () => { throw new Error("never"); } });
    assert.equal(noWeb.unavailable, "this project has no web build to open");
    assert.deepEqual(noWeb.screens.map((s) => s.viewport), ["provided"]);
    let started = false;
    const noBrowser = await captureAppScreens({ repoRoot: root, server: { start: async () => ((started = true), { unavailable: "x" }) }, open: null });
    assert.equal(noBrowser.unavailable, "no browser is available (Playwright)");
    assert.equal(started, false, "no dev server is started when there is no browser to look with");
  });

  test("what the person is told names every skipped screen and why", () => {
    const lines = describeCapture({
      router: "Expo Router",
      screens: [{ name: "Home", route: "/", viewport: "phone", file: "a", from: "x" }, { name: "Home", route: "/", viewport: "desktop", file: "b", from: "x" }],
      skipped: [{ route: "/dashboard", name: "Dashboard", reason: "redirected to /login: needs sign-in or app state" }],
      nameOnly: ["Cart"],
    });
    assert.equal(lines[0], "[CRITIQUE] Captured 1 screen(s): Home (phone, desktop).");
    assert.match(lines[1], /skipped Dashboard \(\/dashboard\): redirected to \/login/);
    assert.match(lines[2], /known only by name.*Cart/);
  });
});

/** The modules that start a browser or a dev server for design work, and the only files allowed to import them. */
const USER_INITIATED: Record<string, string[]> = {
  // The critique and the polish (/design critique ui, /design polish ui) are the only commands that capture screens.
  "uiCapture.ts": ["uiCritique.ts", "uiPolish.ts"],
  // The read describes the captured cues; it opens no browser itself.
  "uiReference.ts": ["referenceRead.ts", "uiCritique.ts"],
  // Spends a vision-model call per reference.
  "referenceRead.ts": ["uiCritique.ts", "uiPolish.ts"],
  // Loaded by index.ts only with a dynamic import inside the explicit command (see uiCritique.test.ts), never statically.
  "uiCritique.ts": ["uiPolish.ts"],
  // Likewise (see uiPolish.test.ts).
  "uiPolish.ts": [],
};

test("nothing a routine run executes can start a capture or open a reference: only the explicit commands may import them", () => {
  const files = fs.readdirSync("src", { recursive: true }).map((f) => String(f).replace(/\\/g, "/")).filter((f) => f.endsWith(".ts"));
  for (const [mod, allowed] of Object.entries(USER_INITIATED)) {
    const imports = new RegExp(`from "\\.\\.?/(?:[\\w/]*/)?${mod.replace(/\.ts$/, "")}\\.js"`);
    const importers = files.filter((f) => f !== mod && imports.test(fs.readFileSync(path.join("src", f), "utf8")));
    assert.deepEqual(importers, allowed, `${mod} may be imported only by the explicit /design commands (added in later commits)`);
  }
  // The check itself works: the test file imports uiCapture in exactly the form it looks for.
  assert.match(fs.readFileSync("test/uiCapture.test.ts", "utf8"), new RegExp(`from "\\.\\.?/(?:[\\w/]*/)?uiCapture\\.js"`));
});
