/**
 * Regression tests for the local auth cache in src/auth/tokenStorage.ts.
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
  getAuthFilePath,
  readCachedAuth,
  writeCachedAuth,
  clearCachedAuth,
  isTokenActive,
} from "../src/auth/tokenStorage.js";

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
  authFile = path.join(await makeTempDir("yimpim-token-storage-"), "auth.json");
  process.env.YIMPIM_AUTH_FILE = authFile;
});

after(async () => {
  if (originalAuthFile === undefined) delete process.env.YIMPIM_AUTH_FILE;
  else process.env.YIMPIM_AUTH_FILE = originalAuthFile;
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("getAuthFilePath", () => {
  test("honors the YIMPIM_AUTH_FILE override", () => {
    assert.equal(getAuthFilePath(), authFile);
  });

  test("falls back to ~/.yimpim/auth.json when the override is unset", () => {
    try {
      delete process.env.YIMPIM_AUTH_FILE;
      assert.equal(getAuthFilePath(), path.join(os.homedir(), ".yimpim", "auth.json"));
    } finally {
      process.env.YIMPIM_AUTH_FILE = authFile;
    }
  });
});

describe("writeCachedAuth / readCachedAuth", () => {
  test("creates the auth file and round-trips through readCachedAuth", async () => {
    const token = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const written = writeCachedAuth({ token });
    assert.equal(written, authFile);
    assert.equal(readCachedAuth()?.token, token);
    const cached = readCachedAuth();
    assert.ok(cached?.savedAt, "stamps savedAt when the caller did not provide one");
    await assert.doesNotReject(async () => fs.access(authFile)); // file exists on disk
  });

  test("preserves an explicit savedAt", () => {
    writeCachedAuth({ token: jwtWithExp(1_800_000_000), savedAt: "2026-01-02T03:04:05.000Z" });
    assert.equal(readCachedAuth()?.savedAt, "2026-01-02T03:04:05.000Z");
  });

  test("creates the parent directory with 0700 and the file with 0600", async () => {
    if (process.platform === "win32") return; // POSIX permission bits don't exist on Windows
    writeCachedAuth({ token: jwtWithExp(1_800_000_000) });
    const fileMode = (await fs.stat(authFile)).mode & 0o777;
    const dirMode = (await fs.stat(path.dirname(authFile))).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.equal(dirMode, 0o700);
  });

  test("readCachedAuth returns null when nothing is on disk", () => {
    assert.equal(readCachedAuth(), null);
  });

  test("readCachedAuth returns null for a corrupted file, not a crash", async () => {
    await fs.mkdir(path.dirname(authFile), { recursive: true });
    await fs.writeFile(authFile, "{not json", "utf-8");
    assert.equal(readCachedAuth(), null);
  });
});

describe("isTokenActive — offline exp check only", () => {
  test("returns true for a future exp, with no network involved", () => {
    // A fetch that throws proves isTokenActive never touches the network.
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("must not be called"); };
    try {
      const expSecs = Math.floor(Date.now() / 1000) + 3600;
      assert.equal(isTokenActive(jwtWithExp(expSecs)), true);
      assert.equal(isTokenActive(jwtWithExp(expSecs), expSecs * 1000 - 1), true, "valid up to the final millisecond before exp");
      assert.equal(isTokenActive(jwtWithExp(expSecs), expSecs * 1000), false, "expired exactly at exp * 1000");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("returns false for an expired token (now >= exp * 1000)", () => {
    assert.equal(isTokenActive(jwtWithExp(Math.floor(Date.now() / 1000) - 60)), false);
  });

  test("returns false for anything that is not a JWT with a numeric exp", () => {
    assert.equal(isTokenActive("opaque-token-not-a-jwt"), false);

    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    assert.equal(isTokenActive(`${b64({ alg: "none" })}.${b64({ sub: "u_1" })}.sig`), false); // no exp
    assert.equal(isTokenActive(`${b64({ alg: "none" })}.${b64({ sub: "u_1", exp: "1234567890" })}.sig`), false); // string exp, not number
    assert.equal(isTokenActive("a.b"), false); // not a 3-part JWT
  });
});

describe("clearCachedAuth", () => {
  test("removes the auth file", async () => {
    writeCachedAuth({ token: jwtWithExp(Math.floor(Date.now() / 1000) + 3600) });
    assert.ok(readCachedAuth(), "lease exists before clearing");
    clearCachedAuth();
    assert.equal(readCachedAuth(), null);
    await assert.rejects(fs.access(authFile), "the file itself is gone");
  });

  test("is a no-op when nothing is cached", () => {
    assert.doesNotThrow(() => clearCachedAuth());
  });
});