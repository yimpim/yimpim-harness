/**
 * Regression tests for the CLI Pro-lease auth helpers in src/remote/auth.ts.
 *
 * The YIMPIM_AUTH_FILE override keeps every test in a temp directory —
 * nothing here ever touches the real ~/.yimpim.
 */
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getValidProToken,
  saveProToken,
  readSavedToken,
  clearProToken,
  attemptTokenRefresh,
  executeLinkFlow,
  decodeJwtPayload,
} from "../src/remote/auth.js";

const tempDirs: string[] = [];
const originalAuthFile = process.env.YIMPIM_AUTH_FILE;
// Saved/restored around each test; node --test runs each file in its own
// child process, so this cannot leak into sibling suites.
let authFile = "";

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A signature is never checked offline, so a fake one is fine for expiry tests. */
function jwtWithExp(expSecs: number, extra: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u_1", exp: expSecs, ...extra })}.fake-signature`;
}

beforeEach(async () => {
  authFile = path.join(await makeTempDir("yimpim-auth-test-"), "auth.json");
  process.env.YIMPIM_AUTH_FILE = authFile;
});

after(async () => {
  if (originalAuthFile === undefined) delete process.env.YIMPIM_AUTH_FILE;
  else process.env.YIMPIM_AUTH_FILE = originalAuthFile;
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("decodeJwtPayload", () => {
  test("decodes the payload segment without any network", () => {
    const payload = decodeJwtPayload(jwtWithExp(1_800_000_000, { tier: "pro" }));
    assert.equal(payload?.exp, 1_800_000_000);
    assert.equal(payload?.tier, "pro");
  });

  test("returns null for anything that is not a 3-part JWT", () => {
    assert.equal(decodeJwtPayload("not-a-jwt"), null);
    assert.equal(decodeJwtPayload("a.b"), null);
    assert.equal(decodeJwtPayload("a.b.c.d"), null);
    assert.equal(decodeJwtPayload("h.%%%notbase64%%%.s"), null);
  });
});

describe("getValidProToken — offline exp check only", () => {
  test("returns the token when exp is in the future, with no network involved", async () => {
    // A fetch that throws proves getValidProToken never touches the network.
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("must not be called"); };
    try {
      const expSecs = Math.floor(Date.now() / 1000) + 3600;
      const token = jwtWithExp(expSecs);
      saveProToken(token);
      assert.equal(getValidProToken(), token);
      assert.equal(getValidProToken(expSecs * 1000 - 1), token, "valid up to the final millisecond before exp");
      assert.equal(getValidProToken(expSecs * 1000), null, "expired exactly at exp * 1000");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("returns null when expired (exp * 1000 <= now)", () => {
    saveProToken(jwtWithExp(Math.floor(Date.now() / 1000) - 60));
    assert.equal(getValidProToken(), null);
  });

  test("returns null when nothing is saved", () => {
    assert.equal(getValidProToken(), null);
  });

  test("returns null when the saved value is not a JWT with a numeric exp", () => {
    saveProToken("opaque-token-not-a-jwt");
    assert.equal(getValidProToken(), null);

    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    saveProToken(`${b64({ alg: "none" })}.${b64({ sub: "u_1" })}.sig`); // no exp
    assert.equal(getValidProToken(), null);
  });

  test("returns null when the saved file is corrupted, not a crash", async () => {
    await fs.writeFile(authFile, "{not json", "utf-8");
    assert.equal(getValidProToken(), null);
  });
});

describe("saveProToken / clearProToken", () => {
  test("saves to ~/.yimpim/auth.json shape and round-trips through readSavedToken", () => {
    const token = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const file = saveProToken(token);
    assert.equal(file, authFile);
    const saved = readSavedToken();
    assert.equal(saved?.token, token);
    assert.ok(saved?.savedAt, "records when the lease was stored");
  });

  test("overwrites an existing auth.json in place, leaving no scratch file behind", async () => {
    const first = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const second = jwtWithExp(Math.floor(Date.now() / 1000) + 7200);
    saveProToken(first);
    saveProToken(second);
    assert.equal(readSavedToken()?.token, second, "the newest lease wins");
    const entries = await fs.readdir(path.dirname(authFile));
    assert.deepEqual(entries, ["auth.json"], `no scratch files left behind: ${entries.join(", ")}`);
  });

  test("creates the parent directory with 0700 and the file with 0600", async () => {
    if (process.platform === "win32") return; // POSIX permission bits don't exist on Windows
    const token = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    saveProToken(token);
    const fileMode = (await fs.stat(authFile)).mode & 0o777;
    const dirMode = (await fs.stat(path.dirname(authFile))).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.equal(dirMode, 0o700);
  });

  test("clearProToken deletes the file", () => {
    saveProToken(jwtWithExp(Math.floor(Date.now() / 1000) + 3600));
    clearProToken();
    assert.equal(readSavedToken(), null);
    assert.equal(getValidProToken(), null);
  });
});

describe("attemptTokenRefresh", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;

  test("saves and returns the refreshed lease on 200", async () => {
    saveProToken(jwtWithExp(Math.floor(Date.now() / 1000) - 60)); // expired old lease
    const fresh = jwtWithExp(future, { tier: "pro" });
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => {
      assert.equal(init?.method, "POST");
      assert.match(url, /\/api\/device\/refresh$/);
      return new Response(JSON.stringify({ token: fresh }), { status: 200 });
    };
    try {
      const result = await attemptTokenRefresh({ brokerBase: "https://broker.test" });
      assert.equal(result, fresh);
      assert.equal(getValidProToken(), fresh, "the refreshed lease is now the valid one");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("clears the saved token on a 401", async () => {
    saveProToken(jwtWithExp(future));
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ error: "revoked" }), { status: 401 });
    try {
      assert.equal(await attemptTokenRefresh(), null);
      assert.equal(readSavedToken(), null, "a revoked lease must not linger on disk");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("clears the saved token when the refresh answers with an explicit downgrade", async () => {
    saveProToken(jwtWithExp(future));
    const downgraded = jwtWithExp(future, { tier: "free" });
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ token: downgraded }), { status: 200 });
    try {
      assert.equal(await attemptTokenRefresh(), null);
      assert.equal(readSavedToken(), null, "a downgraded account must not keep a Pro lease");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("a network failure keeps the saved lease untouched (fail-open)", async () => {
    const token = jwtWithExp(future);
    saveProToken(token);
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("ENOTFOUND broker.test"); };
    try {
      assert.equal(await attemptTokenRefresh(), null);
      assert.equal(getValidProToken(), token, "an unreachable broker must never erase a valid lease");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("does nothing when no token is saved", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("must not be called"); };
    try {
      assert.equal(await attemptTokenRefresh(), null);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

describe("executeLinkFlow", () => {
  test("prints the alphanumeric code, logs claimUrl, and stops polling once claimed", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const lease = jwtWithExp(future, { tier: "pro" });
    let polls = 0;
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const printed: string[] = [];
    const logLines: string[] = [];
    console.log = (...args: unknown[]) => {
      printed.push(args.map((a) => String(a)).join(" "));
    };
    (globalThis as any).fetch = async (url: string, init?: any) => {
      if (init?.method === "POST") {
        assert.match(url, /\/api\/device\/request-link$/);
        return new Response(
          JSON.stringify({ code: "ABCD1234", claimUrl: "https://broker.test/link#ABCD1234" }),
          { status: 200 }
        );
      }
      polls++;
      assert.match(url, /\/api\/device\/poll\/ABCD1234$/);
      return new Response(JSON.stringify(polls === 1 ? { status: "pending" } : { token: lease }), { status: 200 });
    };
    try {
      const result = await executeLinkFlow({
        brokerBase: "https://broker.test",
        log: (m) => logLines.push(m),
        pollIntervalMs: 5,
        timeoutMs: 5000,
      });
      assert.equal(result, lease);
      assert.equal(getValidProToken(), lease, "the claimed lease is saved and valid");
      assert.equal(polls, 2, "polling stops the moment the lease arrives");
      assert.ok(printed.some((l) => l.includes("ABCD1234")), `code printed: ${printed.join("\n")}`);
      assert.ok(printed.some((l) => l.includes("https://broker.test/link#ABCD1234")), `URL printed: ${printed.join("\n")}`);
      assert.ok(logLines.some((l) => l.includes("claimUrl=https://broker.test/link#ABCD1234")), `logged: ${logLines.join("\n")}`);
    } finally {
      console.log = originalLog;
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("gives up with null once the polling budget is exhausted", async () => {
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    console.log = () => {};
    (globalThis as any).fetch = async (url: string, init?: any) => {
      if (url.includes("/poll/")) return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
      return new Response(JSON.stringify({ code: "CODE99", claimUrl: "https://broker.test/link#CODE99" }), { status: 200 });
    };
    try {
      const result = await executeLinkFlow({ brokerBase: "https://broker.test", pollIntervalMs: 5, timeoutMs: 40 });
      assert.equal(result, null);
      assert.equal(readSavedToken(), null, "nothing may be saved when the flow never completes");
    } finally {
      console.log = originalLog;
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("a 404 on the poll endpoint means the link died — stops, saves nothing", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const existing = jwtWithExp(future);
    saveProToken(existing); // pre-existing lease must survive
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    console.log = () => {};
    (globalThis as any).fetch = async (url: string, init?: any) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ code: "DEAD42", claimUrl: "https://broker.test/link#DEAD42" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "link expired" }), { status: 404 });
    };
    try {
      assert.equal(await executeLinkFlow({ brokerBase: "https://broker.test", pollIntervalMs: 5, timeoutMs: 5000 }), null);
      assert.equal(getValidProToken(), existing, "an expired link must not wipe an existing lease");
    } finally {
      console.log = originalLog;
      (globalThis as any).fetch = originalFetch;
    }
  });
});