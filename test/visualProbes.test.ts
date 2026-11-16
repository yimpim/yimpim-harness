import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { captureUrl, isInsufficientStorageError, waitForStableScreenshot } from "../src/visualProbes.js";

describe("isInsufficientStorageError", () => {
  test("matches adb's documented INSTALL_FAILED_INSUFFICIENT_STORAGE failure", () => {
    assert.equal(
      isInsufficientStorageError({ stdout: "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]" }),
      true
    );
  });

  test("matches the vaguer INSTALL_FAILED_MEDIA_UNAVAILABLE some emulators return for the same condition", () => {
    assert.equal(isInsufficientStorageError({ stderr: "Failure [INSTALL_FAILED_MEDIA_UNAVAILABLE]" }), true);
  });

  test("matches a bare ENOSPC from adb's own file transfer, case-insensitively", () => {
    assert.equal(isInsufficientStorageError({ message: "Error: enospc, write" }), true);
    assert.equal(isInsufficientStorageError({ message: "No space left on device" }), true);
  });

  test("does not match an unrelated install failure", () => {
    assert.equal(
      isInsufficientStorageError({ stdout: "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]" }),
      false
    );
  });

  test("does not match a plain command-not-found error", () => {
    assert.equal(isInsufficientStorageError({ code: "ENOENT", message: "spawn adb ENOENT" }), false);
  });

  test("handles an error object with none of stdout/stderr/message set", () => {
    assert.equal(isInsufficientStorageError({}), false);
  });
});

// The bug this fixes: the web probe's screenshot used to follow a plain
// page.waitForLoadState("networkidle") wait, which is unreliable for a dev
// server with a persistent HMR connection (Vite, webpack-dev-server) --
// that connection never goes idle, so the wait always ran out its full
// timeout regardless of whether the page had rendered anything yet. A real
// incident: an empty React/Vite mount point got captured and judged with
// nothing wrong ever reported, simply because the shot was taken too early.
describe("waitForStableScreenshot", () => {
  const tempDirs: string[] = [];
  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  test("waits until the page stops actively changing, not just until the first paint", async () => {
    const mod: any = await import("playwright");
    const browser = await mod.chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 200, height: 200 } });
      const page = await context.newPage();

      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-visualprobe-test-"));
      tempDirs.push(dir);
      const file = path.join(dir, "index.html");
      // Keeps mutating visible content every 100ms for ~1.2s (simulating a
      // JS bundle still parsing/rendering after domcontentloaded), then
      // settles permanently -- any poll interval shorter than that active
      // window can never see two identical consecutive frames until it
      // actually stops.
      await fs.writeFile(
        file,
        `<!doctype html><html><body style="margin:0">
          <div id="x" style="font-size:24px">start</div>
          <script>
            let n = 0;
            const el = document.getElementById("x");
            const iv = setInterval(() => {
              n++;
              el.textContent = "changing " + n;
              if (n >= 12) { clearInterval(iv); el.textContent = "SETTLED"; }
            }, 100);
          </script>
        </body></html>`,
        "utf-8"
      );

      await page.goto(pathToFileURL(file).href, { waitUntil: "domcontentloaded" });
      const { buffer, settled } = await waitForStableScreenshot(page, 300, 5000);
      const text = await page.textContent("#x");

      assert.equal(settled, true, "must actually settle within the wait budget, not just time out");
      assert.equal(text, "SETTLED", "must not capture until the page stopped actively changing, not just its first paint");
      assert.ok(buffer.length > 0);
    } finally {
      await browser.close();
    }
  });

  test("reports settled: false when the page is still changing once the wait budget runs out", async () => {
    const mod: any = await import("playwright");
    const browser = await mod.chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 200, height: 200 } });
      const page = await context.newPage();

      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-visualprobe-test-"));
      tempDirs.push(dir);
      const file = path.join(dir, "index.html");
      // Never stops changing -- proves the function gives up rather than
      // waiting forever, and says so honestly via `settled: false`.
      await fs.writeFile(
        file,
        `<!doctype html><html><body style="margin:0">
          <div id="x" style="font-size:24px">start</div>
          <script>
            let n = 0;
            const el = document.getElementById("x");
            setInterval(() => { n++; el.textContent = "changing " + n; }, 100);
          </script>
        </body></html>`,
        "utf-8"
      );

      await page.goto(pathToFileURL(file).href, { waitUntil: "domcontentloaded" });
      const { settled } = await waitForStableScreenshot(page, 300, 1200);
      assert.equal(settled, false, "a page that never stops changing must be reported as not settled, not silently treated as fine");
    } finally {
      await browser.close();
    }
  });
});

// probeExpoWeb's whole point is verifying an Expo screen looks right on a
// phone-shaped surface, not a desktop browser window -- if the device-name
// plumbing into captureUrl silently did nothing, the "iPhone" viewport claim
// would be false and this route would be no better than the existing web
// probe it's meant to improve on for cross-platform (iOS+Android) checks.
describe("captureUrl device emulation", () => {
  const tempDirs: string[] = [];
  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  function pngDimensions(buffer: Buffer): { width: number; height: number } {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  test("passing an iPhone device name captures at that device's (scaled) viewport width, not the desktop default", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-captureurl-test-"));
    tempDirs.push(dir);
    const file = path.join(dir, "index.html");
    // A real viewport meta tag, like any actual Expo web build ships --
    // without it, mobile emulation falls back to Chromium's generic 980px
    // "non-responsive site" layout width instead of the device's own.
    await fs.writeFile(
      file,
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="margin:0"><div style="height:50px;background:red"></div></body></html>`,
      "utf-8"
    );
    const url = pathToFileURL(file).href;
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-captureurl-shots-"));
    tempDirs.push(dir2);

    const desktop = await captureUrl(url, {} as any, dir2, "desktop-test");
    const iphone = await captureUrl(url, {} as any, dir2, "iphone-test", undefined, "iPhone 15");

    const desktopBuf = await fs.readFile(desktop.captures[0].file);
    const iphoneBuf = await fs.readFile(iphone.captures[0].file);
    const desktopSize = pngDimensions(desktopBuf);
    const iphoneSize = pngDimensions(iphoneBuf);

    assert.equal(desktopSize.width, 1280, "unaffected callers (probeWeb, probePythonWeb) must keep the existing desktop viewport");
    // iPhone 15's viewport is 393 CSS px wide at a 3x device scale factor.
    assert.equal(iphoneSize.width, 393 * 3, "must actually render at the iPhone 15 device's own (scaled) viewport width");
    assert.notEqual(iphoneSize.width, desktopSize.width);
  });
});
