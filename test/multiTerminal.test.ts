/**
 * Several terminals on one account: approvals that two terminals can both write, a terminal that says who it is (sealed), and a
 * terminal that is told why the relay ended it and what to do next.
 */
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandApprovals } from "../src/commandPolicy.js";
import { RemoteSession, SessionLimitError, endedMessage, sessionLimitMessage } from "../src/remote/client.js";
import { buildSessionHello } from "../src/remote/hello.js";
import { readHistoryBacklog } from "../src/remote/historyLog.js";
import { decodePairing, open, type Envelope } from "../src/remote/protocol.js";
import { ConfigSchema } from "../src/config.js";
import { SETTINGS } from "../src/settings.js";

const tempDirs: string[] = [];
const mkdtemp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
};
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
after(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------------ approvals shared by two terminals

describe("command approvals written by two terminals at once", () => {
  const argv = (n: string) => ["npm", "run", n];
  const fresh = () => {
    const file = path.join(mkdtemp("yimpim-approvals-"), "command-approvals.json");
    return { file, a: new CommandApprovals(file), b: new CommandApprovals(file), repo: mkdtemp("yimpim-repo-") };
  };
  const onDisk = (file: string, repo: string, c: CommandApprovals) => new CommandApprovals(file).list(repo).map((e) => e.argv.join(" ")).sort();

  test("an approval one terminal makes is not erased by the other saving a moment later", () => {
    const { file, a, b, repo } = fresh();
    a.isApproved(repo, argv("x"), ""); // both have read the (empty) file
    b.isApproved(repo, argv("x"), "");
    a.remember(repo, argv("build"), "");
    b.remember(repo, argv("lint"), "");
    assert.deepEqual(onDisk(file, repo, a), ["npm run build", "npm run lint"], "both approvals survive");
  });

  test("each terminal then sees the other's approval", () => {
    const { a, b, repo } = fresh();
    a.isApproved(repo, argv("x"), "");
    b.isApproved(repo, argv("x"), "");
    a.remember(repo, argv("build"), "");
    b.remember(repo, argv("lint"), ""); // this save re-reads the file and takes A's approval in
    assert.equal(b.isApproved(repo, argv("build"), ""), true);
  });

  test("a revoke in one terminal removes only what it revoked", () => {
    const { file, a, b, repo } = fresh();
    a.remember(repo, argv("build"), "");
    a.remember(repo, argv("lint"), "");
    b.isApproved(repo, argv("x"), ""); // b loaded both
    b.remember(repo, argv("test"), "");
    assert.equal(a.revoke(repo, 1), 1); // a forgets its first
    const left = onDisk(file, repo, a);
    assert.equal(left.length, 2, "b's new approval was not swept away, and only one was removed");
    assert.ok(left.includes("npm run test"));
  });

  test("revoking everything keeps what another terminal approved afterwards", () => {
    const { file, a, b, repo } = fresh();
    a.remember(repo, argv("build"), "");
    b.isApproved(repo, argv("x"), "");
    a.revoke(repo, "all");
    b.remember(repo, argv("lint"), "");
    assert.deepEqual(onDisk(file, repo, a), ["npm run lint"]);
  });

  test("a success marker merges too, and the existing behaviour is unchanged", () => {
    const { file, a, b, repo } = fresh();
    a.remember(repo, argv("build"), "");
    b.isApproved(repo, argv("x"), "");
    a.remember(repo, argv("lint"), "");
    b.markSucceeded(repo, argv("build"), "");
    const reread = new CommandApprovals(file);
    assert.equal(reread.listSucceeded(repo).length, 1);
    assert.equal(reread.isApproved(repo, argv("lint"), ""), true, "a's later approval is still there");
    assert.equal(a.revoke(repo, 99), 0, "an index out of range removes nothing");
    assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp")).length, 0, "no temp files left");
  });
});

// ------------------------------------------------------------------ the client

const handlers = {
  onAbort: () => {},
  onAnswer: () => {},
  onAttach: () => {},
  onMessage: () => {},
  onFetchDiff: () => {},
  onGetModelConfig: () => {},
  onListModels: () => {},
  onSetModel: () => {},
} as any;

interface Relay {
  requests: { url: string; body?: any; raw?: string }[];
  warnings: string[];
}
let relay: Relay;

/** A relay stand-in: each route answers with whatever the test set. Polls wait a moment, like a real long poll. */
function stubRelay(routes: {
  register?: () => Response;
  commands?: () => Response;
  events?: () => Response;
}): void {
  relay = { requests: [], warnings: [] };
  console.warn = (...args: unknown[]) => relay.warnings.push(args.join(" "));
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    relay.requests.push({ url: u, raw, body: raw ? JSON.parse(raw) : undefined });
    if (u.endsWith("/v1/register")) return routes.register?.() ?? new Response(JSON.stringify({ sessionId: "s_test", agentToken: "at_test", limit: 3 }), { status: 200 });
    if (u.includes("/v1/commands")) {
      await new Promise((r) => setTimeout(r, 25));
      return routes.commands?.() ?? new Response(JSON.stringify({ commands: [], paired: false }), { status: 200 });
    }
    if (u.endsWith("/v1/events")) return routes.events?.() ?? new Response(JSON.stringify({ ok: true, paired: false }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const newSession = (extra: Record<string, unknown> = {}) =>
  new RemoteSession({ brokerUrl: "https://relay.example.invalid", allowAnswer: true, redactLogs: false, ...extra });

/** Every sealed event the session has posted so far, opened with the session's own key. */
function postedEvents(key: string): any[] {
  const out: any[] = [];
  for (const r of relay.requests.filter((x) => x.url.endsWith("/v1/events"))) {
    for (const env of (r.body?.events ?? []) as Envelope[]) out.push(open(Buffer.from(key, "base64url"), env));
  }
  return out;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

describe("a full account", () => {
  test("a refused registration says how many terminals are open and what to do", async () => {
    stubRelay({ register: () => json(409, { error: "full", code: "session_limit", limit: 3 }) });
    const s = newSession();
    await assert.rejects(
      () => s.start("run1", "repo", handlers),
      (err: any) => err instanceof SessionLimitError && err.limit === 3 && /3 terminals/.test(err.message) && /unpair it in the app/.test(err.message) && /\/remote-control/.test(err.message)
    );
    assert.equal(s.connected, false);
  });
  test("one terminal is worded as one; an unknown limit does not print a number", () => {
    assert.match(sessionLimitMessage(1), /1 terminal connected/);
    assert.doesNotMatch(sessionLimitMessage(undefined), /undefined|NaN/);
  });
  test("any other refusal keeps the plain error", async () => {
    stubRelay({ register: () => json(503, { error: "at capacity" }) });
    await assert.rejects(() => newSession().start("run1", "repo", handlers), (err: any) => !(err instanceof SessionLimitError) && /HTTP 503/.test(err.message));
  });
});

describe("who this terminal is, sealed", () => {
  test("session.hello carries the project, branch, host, platform and start time, and only inside the encryption", async () => {
    stubRelay({});
    const repo = mkdtemp("yimpim-hello-secret-name-");
    const s = newSession({ repoRoot: repo });
    const url = await s.start("run1", "hello-secret-name", handlers, { branch: "feature-x", hostname: "my-laptop", cliVersion: "9.9.9" });
    const key = decodePairing(new URL(url).hash.slice(1)).key;
    await waitFor(() => postedEvents(key).some((e) => e.kind === "session.hello"));

    const hello = postedEvents(key).find((e) => e.kind === "session.hello");
    assert.equal(hello.repoName, "hello-secret-name");
    assert.equal(hello.branch, "feature-x");
    assert.equal(hello.hostname, "my-laptop");
    assert.equal(hello.cliVersion, "9.9.9");
    assert.equal(hello.platform, process.platform);
    assert.ok(Date.parse(hello.startedAt) > 0);

    const everythingTheRelaySaw = relay.requests.map((r) => r.raw ?? "").join("\n") + url.split("#")[0];
    for (const secret of ["hello-secret-name", "feature-x", "my-laptop"]) {
      assert.ok(!everythingTheRelaySaw.includes(secret), `${secret} is never in a request the relay can read`);
    }
    await s.stop("test");
  });

  test("the pairing link is exactly the four parts it always was, so older apps still read it", async () => {
    stubRelay({});
    const s = newSession();
    const url = await s.start("run1", "repo", handlers);
    assert.equal(new URL(url).hash.slice(1).split(".").length, 4);
    await s.stop("test");
  });

  test("it is sent again the moment a phone pairs, and is never written to the history log", async () => {
    let polls = 0;
    stubRelay({ commands: () => json(200, { commands: [], paired: ++polls > 1 }) });
    const repo = mkdtemp("yimpim-hello-repo-");
    const s = newSession({ repoRoot: repo });
    const url = await s.start("run1", "repo", handlers);
    const key = decodePairing(new URL(url).hash.slice(1)).key;
    await waitFor(() => postedEvents(key).filter((e) => e.kind === "session.hello").length >= 2);
    assert.ok(readHistoryBacklog(repo).every((e: any) => e.kind !== "session.hello"), "an old hello must never be replayed into a new session");
    await s.stop("test");
  });
});

describe("a terminal the relay ended", () => {
  const cases: [string, string, RegExp][] = [
    ["unpaired", "Your phone unpaired this terminal", /fresh QR/],
    ["phone_replaced", "Another phone took over", /pair a phone again/],
    ["evicted", "make room for another", /allows 3/],
    ["account_deleted", "account was deleted", /remote control has ended/],
  ];

  for (const [reason, said, then] of cases) {
    test(`${reason}: the person is told, the session stops, and the owner is called back (answer on the command poll)`, async () => {
      stubRelay({ commands: () => json(200, { commands: [], paired: false, ended: reason }) });
      let ended = "";
      const s = newSession({ onEnded: (r: string) => (ended = r) });
      await s.start("run1", "repo", handlers);
      await waitFor(() => ended !== "");
      assert.equal(ended, reason);
      assert.ok(relay.warnings.some((w) => w.includes(said) && then.test(w)), relay.warnings.join(" | "));
      assert.equal(s.connected, false);
      assert.ok(relay.requests.some((r) => r.url.endsWith("/v1/unregister")), "its slot on the relay is released");
    });
  }

  test("a 401 that says session_ended (a session the relay already removed) ends it the same way", async () => {
    stubRelay({ commands: () => json(401, { error: "that session has ended", code: "session_ended", ended: "evicted" }) });
    let ended = "";
    const s = newSession({ onEnded: (r: string) => (ended = r) });
    await s.start("run1", "repo", handlers);
    await waitFor(() => ended !== "");
    assert.equal(ended, "evicted");
    assert.equal(s.connected, false);
  });

  test("so does the answer to an event upload", async () => {
    stubRelay({ events: () => json(401, { error: "that session has ended", code: "session_ended", ended: "account_deleted" }) });
    let ended = "";
    const s = newSession({ onEnded: (r: string) => (ended = r) });
    await s.start("run1", "repo", handlers);
    s.push("log", { level: "info", message: "hello" });
    await waitFor(() => ended !== "");
    assert.equal(ended, "account_deleted");
  });

  test("it only ends once, however many answers say so", async () => {
    stubRelay({ commands: () => json(200, { commands: [], paired: false, ended: "unpaired" }) });
    let calls = 0;
    const s = newSession({ onEnded: () => calls++ });
    await s.start("run1", "repo", handlers);
    await waitFor(() => calls > 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(calls, 1);
    assert.equal(relay.warnings.filter((w) => w.includes("unpaired this terminal")).length, 1);
  });

  test("a bare 401 (no reason) is not an end: it keeps retrying as before", async () => {
    stubRelay({ commands: () => json(401, { error: "unauthorized" }) });
    let ended = false;
    const s = newSession({ onEnded: () => (ended = true) });
    await s.start("run1", "repo", handlers);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(ended, false);
    assert.equal(s.connected, true);
    await s.stop("test");
  });

  test("every reason has words, and an unknown one still says what to do", () => {
    for (const r of ["unpaired", "evicted", "phone_replaced", "account_deleted"]) assert.ok(endedMessage(r, 3).length > 20, r);
    assert.match(endedMessage("something-new"), /\/remote-control/);
    assert.match(endedMessage("evicted", undefined), /allows a few/);
  });
});

describe("the hello builder and its setting", () => {
  test("hostname only when sharing is on; project name from the folder", () => {
    const dir = mkdtemp("yimpim-hello-builder-");
    const shared = buildSessionHello({ repoRoot: dir, shareHostname: true });
    const hidden = buildSessionHello({ repoRoot: dir, shareHostname: false });
    assert.equal(shared.repoName, path.basename(dir));
    assert.equal(shared.hostname, os.hostname());
    assert.equal("hostname" in hidden, false);
    assert.equal(hidden.platform, process.platform);
    assert.ok(hidden.cliVersion, "the version is read from package.json");
  });

  test("the branch of a git project; none for a folder that is not one", () => {
    const repo = mkdtemp("yimpim-hello-git-");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "feature-x");
    git("commit", "-q", "--allow-empty", "-m", "start");
    assert.equal(buildSessionHello({ repoRoot: repo, shareHostname: false }).branch, "feature-x");
    assert.equal("branch" in buildSessionHello({ repoRoot: mkdtemp("yimpim-not-git-"), shareHostname: false }), false);
  });

  test("remote.shareHostname is on by default and is in the settings list", () => {
    assert.equal((ConfigSchema.parse({}).remote as any).shareHostname, true);
    assert.equal(ConfigSchema.parse({ remote: { shareHostname: false } }).remote.shareHostname, false);
    assert.ok(SETTINGS.some((x: { key: string }) => x.key === "remote.shareHostname"));
  });
});
