/**
 * Regression tests for the device-linking client in src/auth/deviceLink.ts.
 *
 * Every test mocks globalThis.fetch, so nothing here touches the network.
 * The YIMPIM_AUTH_FILE override keeps the auth cache in a temp directory —
 * nothing ever touches the real ~/.yimpim.
 */
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  initiateDeviceLink,
  pollDeviceClaim,
  attemptTokenRefresh,
  renderPairingPrompt,
  parseClaimedToken,
} from "../src/auth/deviceLink.js";
import { readCachedAuth, writeCachedAuth, getAuthFilePath } from "../src/auth/tokenStorage.js";

const BROKER = "https://broker.test";

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

/** A signature is never checked offline, so a fake one is fine. */
function fakeJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u_1", exp: Math.floor(Date.now() / 1000) + 3600 })}.fake-signature`;
}

beforeEach(async () => {
  authFile = path.join(await makeTempDir("yimpim-device-link-"), "auth.json");
  process.env.YIMPIM_AUTH_FILE = authFile;
});

after(async () => {
  if (originalAuthFile === undefined) delete process.env.YIMPIM_AUTH_FILE;
  else process.env.YIMPIM_AUTH_FILE = originalAuthFile;
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("initiateDeviceLink", () => {
  test("returns the session code and claim URL from a 200 response", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => {
      assert.equal(init?.method, "POST");
      assert.match(new URL(url).pathname, /\/api\/device\/request-link$/);
      return new Response(
        JSON.stringify({ code: "ABCD1234", claimUrl: "https://broker.test/link#ABCD1234", userCode: "ABCD-1234" }),
        { status: 200 }
      );
    };
    try {
      const result = await initiateDeviceLink(BROKER);
      assert.deepEqual(result, {
        kind: "initiated",
        code: "ABCD1234",
        claimUrl: "https://broker.test/link#ABCD1234",
        userCode: "ABCD-1234",
      });
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("derives a claim URL from the base when the broker omits one", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ code: "CODE42" }), { status: 200 });
    try {
      const result = await initiateDeviceLink("https://broker.test/"); // trailing slash
      assert.equal(result.kind, "initiated");
      if (result.kind === "initiated") {
        assert.equal(result.code, "CODE42");
        assert.equal(result.claimUrl, "https://broker.test/link#CODE42");
        assert.equal(result.userCode, undefined);
      }
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("throws with the server's error detail on a non-2xx response", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ error: "link service is rate limited" }), { status: 429 });
    try {
      await assert.rejects(
        initiateDeviceLink(BROKER),
        /HTTP 429.*rate limited/
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("throws a readable message when the broker is unreachable", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("ENOTFOUND broker.test"); };
    try {
      await assert.rejects(
        initiateDeviceLink(BROKER),
        /Could not reach the link service: ENOTFOUND broker\.test/
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("throws when the response carries no usable code", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ claimUrl: "https://broker.test/link#" }), { status: 200 });
    try {
      await assert.rejects(
        initiateDeviceLink(BROKER),
        /no pairing code/
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

describe("renderPairingPrompt", () => {
  test("always prints the plain-text claim URL alongside the QR, and never throws", async () => {
    const originalLog = console.log;
    const printed: string[] = [];
    console.log = (...args: unknown[]) => {
      printed.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const claimUrl = "https://broker.test/link#ABCD1234";
      // The real module is installed in this repo, so this exercises the
      // QR-success path; whichever way the renderer goes, the URL itself is
      // printed as readable text — the fallback guarantee to assert on.
      await renderPairingPrompt(claimUrl, "ABCD1234");
      assert.ok(
        printed.some((l) => l.includes("Pairing code:  ABCD1234")),
        `code line printed: ${printed.join("\n")}`
      );
      assert.ok(
        printed.some((l) => l.includes(claimUrl)),
        `claimUrl always printed: ${printed.join("\n")}`
      );
    } finally {
      console.log = originalLog;
    }
  });

  test("prints the plain-text claim URL even without a user code", async () => {
    const originalLog = console.log;
    const printed: string[] = [];
    console.log = (...args: unknown[]) => {
      printed.push(args.map((a) => String(a)).join(" "));
    };
    try {
      // The QR is a bonus layer: whatever the renderer does, the claim URL
      // must always be printed as readable text for the no-QR fallback.
      const claimUrl = "https://broker.test/link#NCODE";
      await renderPairingPrompt(claimUrl);
      assert.ok(
        printed.some((l) => l.includes(claimUrl)),
        `claimUrl always printed: ${printed.join("\n")}`
      );
    } finally {
      console.log = originalLog;
    }
  });
});

describe("pollDeviceClaim", () => {
  test("polls pending, then saves and returns the lease once claimed", async () => {
    const lease = fakeJwt();
    let polls = 0;
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string) => {
      assert.match(new URL(url).pathname, /\/api\/device\/poll\/ABCD1234$/);
      polls++;
      return new Response(JSON.stringify(polls === 1 ? { status: "pending" } : { token: lease }), { status: 200 });
    };
    try {
      const result = await pollDeviceClaim(BROKER, "ABCD1234", {
        pollIntervalMs: 5,
        timeoutMs: 5000,
      });
      assert.deepEqual(result, { kind: "claimed", token: lease });
      assert.equal(readCachedAuth()?.token, lease, "the claimed lease is persisted via the shared auth cache");
      assert.ok(polls >= 2, `polled at least until claimed (${polls} polls)`);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("returns pending once the time budget is exhausted", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ status: "pending" }), { status: 200 });
    try {
      const result = await pollDeviceClaim(BROKER, "SLOW99", {
        pollIntervalMs: 5,
        timeoutMs: 25,
      });
      assert.equal(result.kind, "pending");
      assert.equal(readCachedAuth(), null, "nothing may be cached when the flow never completes");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("a 404 means the link died — returns expired and saves nothing", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ error: "link expired" }), { status: 404 });
    try {
      const result = await pollDeviceClaim(BROKER, "DEAD42", {
        pollIntervalMs: 5,
        timeoutMs: 5000,
      });
      assert.equal(result.kind, "expired");
      assert.equal(readCachedAuth(), null);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("survives transient network blips and still claims the lease", async () => {
    const lease = fakeJwt();
    let polls = 0;
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      polls++;
      if (polls === 1) throw new Error("ECONNRESET"); // blip — must be retried
      return new Response(JSON.stringify({ proToken: lease }), { status: 200 });
    };
    try {
      const result = await pollDeviceClaim(BROKER, "BLIP01", {
        pollIntervalMs: 5,
        timeoutMs: 5000,
      });
      assert.deepEqual(result, { kind: "claimed", token: lease });
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

describe("attemptTokenRefresh", () => {
  test("saves and returns the refreshed lease on 200", async () => {
    const fresh = fakeJwt();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => {
      assert.equal(init?.method, "POST");
      assert.match(new URL(url).pathname, /\/api\/device\/refresh$/);
      return new Response(JSON.stringify({ token: fresh }), { status: 200 });
    };
    try {
      const result = await attemptTokenRefresh(BROKER, "expired-lease");
      assert.equal(result, fresh);
      assert.equal(readCachedAuth()?.token, fresh, "the refreshed lease becomes the cached one");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("a 401 clears the cached auth and returns null", async () => {
    writeCachedAuth({ token: fakeJwt() });
    assert.ok(readCachedAuth(), "lease exists before the refresh");
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ error: "revoked" }), { status: 401 });
    try {
      const result = await attemptTokenRefresh(BROKER, "revoked-lease");
      assert.equal(result, null);
      assert.equal(readCachedAuth(), null, "a revoked lease must not linger in the cache");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("a network failure keeps the cached auth untouched (fail-open)", async () => {
    const existing = fakeJwt();
    writeCachedAuth({ token: existing });
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("ENOTFOUND broker.test"); };
    try {
      const result = await attemptTokenRefresh(BROKER, existing);
      assert.equal(result, null);
      assert.equal(readCachedAuth()?.token, existing, "an unreachable broker must never erase a cached lease");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("a malformed 200 body is fail-open too", async () => {
    const existing = fakeJwt();
    writeCachedAuth({ token: existing });
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ status: "still-pending" }), { status: 200 });
    try {
      const result = await attemptTokenRefresh(BROKER, existing);
      assert.equal(result, null);
      assert.equal(readCachedAuth()?.token, existing);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

describe("parseClaimedToken — type narrowing", () => {
  test("accepts token, jwt, or proToken", () => {
    assert.equal(parseClaimedToken({ token: "t" }), "t");
    assert.equal(parseClaimedToken({ jwt: "j" }), "j");
    assert.equal(parseClaimedToken({ proToken: "p" }), "p");
  });

  test("rejects non-objects, empty strings, and bodies without a lease field", () => {
    assert.equal(parseClaimedToken(null), null);
    assert.equal(parseClaimedToken("token"), null);
    assert.equal(parseClaimedToken(42), null);
    assert.equal(parseClaimedToken({ token: "" }), null);
    assert.equal(parseClaimedToken({ status: "pending" }), null);
    assert.equal(parseClaimedToken({ token: 123 }), null);
  });
});

describe("auth cache isolation", () => {
  test("pollDeviceClaim writes through to the dedicated YIMPIM_AUTH_FILE location", async () => {
    const lease = fakeJwt();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ token: lease }), { status: 200 });
    try {
      const result = await pollDeviceClaim(BROKER, "ISOL8", { pollIntervalMs: 5, timeoutMs: 5000 });
      assert.equal(result.kind, "claimed");
      assert.equal(getAuthFilePath(), authFile, "tests never touch the real ~/.yimpim");
      assert.equal(readCachedAuth()?.token, lease);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});