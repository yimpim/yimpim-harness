/**
 * QA setup: validation/merging of .agent/qa-setup.json (pure), and a real
 * Chromium run proving captureUrl actually applies it — seeded storage, a start
 * path, a file chooser that gets answered, and a camera that returns a stream.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { isSafeLaunchPath, isSafeRepoRelativePath, loadQaSetup, rgbaToY4m, sanitizeQaSetup, saveQaSetup } from "../src/qaSetup.js";
import { AgentTools } from "../src/agentTools.js";
import { AgentConfig } from "../src/config.js";
import { captureUrl } from "../src/visualProbes.js";

const tempDirs: string[] = [];
async function tmp(prefix = "yimpim-qasetup-"): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("validation", () => {
  test("a launch path must stay on the app's own origin", () => {
    assert.ok(isSafeLaunchPath("/dashboard?demo=1"));
    assert.ok(isSafeLaunchPath("?demo=1"));
    assert.ok(isSafeLaunchPath("#/home"));
    assert.ok(!isSafeLaunchPath("//evil.example/x"));
    assert.ok(!isSafeLaunchPath("https://evil.example"));
    assert.ok(!isSafeLaunchPath("/" + String.fromCharCode(92) + "evil.example"));
    assert.ok(!isSafeLaunchPath("dashboard"));
  });

  test("file paths must be repo-relative and not secret-looking", () => {
    assert.ok(isSafeRepoRelativePath("fixtures/qr.png"));
    assert.ok(!isSafeRepoRelativePath("../outside.png"));
    assert.ok(!isSafeRepoRelativePath("/etc/passwd"));
    assert.ok(!isSafeRepoRelativePath(".env"));
    assert.ok(!isSafeRepoRelativePath("config/.env.local"));
    assert.ok(!isSafeRepoRelativePath("keys/id_rsa"));
    assert.ok(!isSafeRepoRelativePath("certs/server.pem"));
  });

  test("sanitize keeps good fields, drops bad ones, accepts both storage shapes", () => {
    const s = sanitizeQaSetup({
      launchPath: "//evil",
      localStorage: [{ key: "session", value: "demo" }, { key: "", value: "x" }],
      cameraImage: "../x.png",
      uploadFiles: ["a.png", ".env", 5],
    });
    assert.equal(s.launchPath, undefined);
    assert.deepEqual(s.localStorage, { session: "demo" });
    assert.equal(s.cameraImage, undefined);
    assert.deepEqual(s.uploadFiles, ["a.png"]);
    assert.deepEqual(sanitizeQaSetup({ localStorage: { a: "1" } }).localStorage, { a: "1" });
  });
});

describe("storage", () => {
  test("storage keys accumulate across saves; other fields are replaced", async () => {
    const dir = await tmp();
    saveQaSetup(dir, { localStorage: [{ key: "a", value: "1" }], launchPath: "/one" });
    saveQaSetup(dir, { localStorage: [{ key: "b", value: "2" }, { key: "a", value: "3" }], launchPath: "/two" });
    const s = loadQaSetup(dir);
    assert.deepEqual(s.localStorage, { a: "3", b: "2" });
    assert.equal(s.launchPath, "/two");
  });

  test("the register_qa_setup tool path saves and reports", async () => {
    const dir = await tmp();
    const tools = new AgentTools(dir, {} as AgentConfig);
    const msg = await tools.registerQaSetup({ launchPath: "/home", localStorage: [{ key: "k", value: "v" }] });
    assert.match(msg, /saved/);
    assert.equal(loadQaSetup(dir).launchPath, "/home");
    assert.match(await tools.registerQaSetup({ launchPath: "//x" }), /Nothing valid/);
  });
});

describe("rgbaToY4m", () => {
  test("writes a header plus N whole I420 frames", () => {
    const w = 4, h = 2;
    const buf = rgbaToY4m(new Uint8Array(w * h * 4).fill(255), w, h, 3);
    const header = "YUV4MPEG2 W4 H2 F30:1 Ip A1:1 C420jpeg\n";
    assert.equal(buf.subarray(0, header.length).toString(), header);
    assert.equal(buf.length, header.length + 3 * (6 + w * h * 3 / 2));
  });
});

describe("captureUrl applies the QA setup in a real browser", () => {
  test("seeded storage, start path, file chooser and camera all take effect", async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (url.startsWith("/_seen")) {
        seen.push(decodeURIComponent(url));
        res.end("ok");
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><html><body>
        <p>path=${url}</p>
        <button id="b" onclick="document.getElementById('f').click()">Attach</button>
        <input id="f" type="file" style="display:none"
          onchange="fetch('/_seen/file/'+encodeURIComponent(this.files[0].name))">
        <script>
          fetch('/_seen/storage/'+encodeURIComponent(localStorage.getItem('session')||'none'));
          if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia({video:true})
            .then(function(){ fetch('/_seen/camera/ok'); }, function(e){ fetch('/_seen/camera/'+e.name); });
        </script></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;

    try {
      const repo = await tmp();
      await fs.mkdir(path.join(repo, "fixtures"));
      await fs.writeFile(path.join(repo, "fixtures", "doc.txt"), "hello");
      saveQaSetup(repo, {
        launchPath: "/start?x=1",
        localStorage: [{ key: "session", value: "demo-paired" }],
        uploadFiles: ["fixtures/doc.txt"],
      });
      const shots = await tmp("yimpim-qasetup-shots-");

      let step = 0;
      const result = await captureUrl(
        `http://127.0.0.1:${port}/`,
        {} as any,
        shots,
        "qa",
        {
          maxSteps: 3,
          decideNext: async ({ hints }) => {
            step++;
            if (step === 1 && hints.length > 0) return { arrived: false, tapXPercent: hints[0].xPercent, tapYPercent: hints[0].yPercent, reason: "tap Attach" };
            return { arrived: true, reason: "done" };
          },
        },
        undefined,
        repo
      );
      await new Promise((r) => setTimeout(r, 500));

      assert.ok(seen.includes("/_seen/storage/demo-paired"), `storage not seeded: ${seen.join(", ")}`);
      assert.ok(seen.includes("/_seen/file/doc.txt"), `chooser not answered with the registered file: ${seen.join(", ")}`);
      assert.ok(seen.includes("/_seen/camera/ok"), `camera not available: ${seen.join(", ")}`);
      assert.match(result.detail, /QA setup/);
      assert.match(result.detail, /opened \/start\?x=1/);
    } finally {
      server.close();
    }
  });
});
