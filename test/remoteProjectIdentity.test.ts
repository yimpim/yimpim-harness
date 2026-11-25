/**
 * A terminal labels itself by project so a phone with several paired can tell them apart. The name and the working directory
 * travel SEALED (session.hello, and the status heartbeat), never in the plaintext /v1/register body, because the relay must
 * not learn a project or a path. These tests pin both halves: the hello carries them, and the register body does not.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RemoteSession, type RemoteHandlers } from "../src/remote/client.js";
import { buildSessionHello } from "../src/remote/hello.js";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-projectid-test-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const d of tempDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const handlers: RemoteHandlers = {
  onAbort: () => {},
  onAnswer: () => {},
  onAttach: () => {},
  onMessage: () => {},
  onFetchDiff: () => {},
  onFetchHistory: () => {},
  onHistoryList: () => {},
  onFetchScreenshot: () => {},
  onGetModelConfig: () => {},
  onListModels: () => {},
  onSetModel: () => {},
  onGetUsage: () => {},
};

describe("terminal identity", () => {
  test("the sealed hello names the project by its working-directory folder, and carries the working directory", () => {
    const hello = buildSessionHello({ repoRoot: process.cwd(), shareHostname: false });
    assert.equal(hello.projectName, path.basename(process.cwd()));
    assert.equal(hello.cwd, process.cwd());
  });

  test("the plaintext register body carries neither the project name nor the working directory", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    let registerBody: any;
    (globalThis as any).fetch = (async (url: string, init: any) => {
      if (String(url).endsWith("/v1/register")) {
        registerBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ sessionId: "s_id", agentToken: "at_id" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const session = new RemoteSession({
        brokerUrl: "https://broker.example.invalid",
        allowAnswer: true,
        redactLogs: false,
        repoRoot,
      });
      await session.start("run1", "test-repo", handlers, buildSessionHello({ repoRoot, shareHostname: false }));
      await session.stop("test done");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
    const wire = JSON.stringify(registerBody);
    assert.ok(!wire.includes(process.cwd()), "the working directory must never be sent in plaintext");
    assert.ok(!("projectName" in registerBody) && !("cwd" in registerBody), "no project identity in the plaintext register body");
  });
});
