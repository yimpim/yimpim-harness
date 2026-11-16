/**
 * API key storage.
 *
 * Prefers the OS credential store so the key never sits in a plaintext file:
 *   Windows  - Credential Manager, via PowerShell + DPAPI
 *   macOS    - Keychain, via `security`
 *   Linux    - Secret Service, via `secret-tool`
 *
 * Falls back to ~/.yimpim/credentials with 0600 permissions when no store is
 * available (headless Linux, minimal containers). The fallback is reported
 * honestly rather than silently.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVICE = "yimpim-openrouter";
const ACCOUNT = "default";

export type SecretBackend = "keychain" | "credential-manager" | "secret-service" | "file" | "env";

export interface SecretStatus {
  present: boolean;
  backend?: SecretBackend;
  detail: string;
}

function yimpimDir(): string {
  return path.join(os.homedir(), ".yimpim");
}

function credentialFile(): string {
  return path.join(yimpimDir(), "credentials");
}

function run(bin: string, args: string[], input?: string): string {
  return execFileSync(bin, args, {
    encoding: "utf-8",
    input,
    stdio: ["pipe", "pipe", "ignore"],
    timeout: 15_000,
  });
}

function has(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ Windows

/** DPAPI-encrypt to a per-user blob; only this Windows account can read it. */
function winStore(secret: string): boolean {
  const target = path.join(yimpimDir(), "credential.dpapi");
  const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b=[System.Text.Encoding]::UTF8.GetBytes($env:YIMPIM_SECRET_IN)
$e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser')
[System.IO.File]::WriteAllBytes($env:YIMPIM_SECRET_PATH,$e)
`;
  try {
    fs.mkdirSync(yimpimDir(), { recursive: true });
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      stdio: "ignore",
      timeout: 20_000,
      env: { ...process.env, YIMPIM_SECRET_IN: secret, YIMPIM_SECRET_PATH: target },
    });
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function winLoad(): string | undefined {
  const target = path.join(yimpimDir(), "credential.dpapi");
  if (!fs.existsSync(target)) return undefined;
  const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$e=[System.IO.File]::ReadAllBytes($env:YIMPIM_SECRET_PATH)
$b=[System.Security.Cryptography.ProtectedData]::Unprotect($e,$null,'CurrentUser')
[System.Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($b))
`;
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
      env: { ...process.env, YIMPIM_SECRET_PATH: target },
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------------------- Store

export function storeApiKey(secret: string): SecretBackend {
  fs.mkdirSync(yimpimDir(), { recursive: true });

  if (process.platform === "darwin" && has("security")) {
    try {
      try {
        run("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
      } catch {}
      run("security", ["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", secret]);
      return "keychain";
    } catch {}
  }

  if (process.platform === "win32" && winStore(secret)) return "credential-manager";

  if (process.platform === "linux" && has("secret-tool")) {
    try {
      run("secret-tool", ["store", "--label=YIMPIM OpenRouter key", "service", SERVICE, "account", ACCOUNT], secret);
      return "secret-service";
    } catch {}
  }

  // Fallback: owner-only file.
  const file = credentialFile();
  fs.writeFileSync(file, `OPENROUTER_API_KEY=${secret}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return "file";
}

export function loadApiKey(): { key?: string; backend?: SecretBackend } {
  // An explicit environment variable always wins, for CI and one-off overrides.
  if (process.env.OPENROUTER_API_KEY) return { key: process.env.OPENROUTER_API_KEY, backend: "env" };
  return loadStoredKey();
}

/** Every backend except the environment variable — the actual saved credential. */
function loadStoredKey(): { key?: string; backend?: SecretBackend } {
  if (process.platform === "darwin" && has("security")) {
    try {
      const out = run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
      if (out.trim()) return { key: out.trim(), backend: "keychain" };
    } catch {}
  }

  if (process.platform === "win32") {
    const k = winLoad();
    if (k) return { key: k, backend: "credential-manager" };
  }

  if (process.platform === "linux" && has("secret-tool")) {
    try {
      const out = run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT]);
      if (out.trim()) return { key: out.trim(), backend: "secret-service" };
    } catch {}
  }

  const file = credentialFile();
  if (fs.existsSync(file)) {
    const m = fs.readFileSync(file, "utf-8").match(/OPENROUTER_API_KEY=(.+)/);
    if (m) return { key: m[1].trim(), backend: "file" };
  }

  return {};
}

/**
 * Detects the trap that turns "I rotated my key" into a recurring mystery:
 * OPENROUTER_API_KEY always wins over the credential store (by design, for
 * CI/one-off overrides), so a stale value left behind in a shell — e.g. from
 * `$env:OPENROUTER_API_KEY = ...`, or a `setx`/System Properties entry that
 * was later cleared without a reboot — keeps silently overriding a correctly
 * rotated key, since Windows does not retroactively purge an already-running
 * session's inherited environment when the registry value changes. Every
 * later call still 401s no matter how many times the "real" key is rotated.
 */
export function detectStaleEnvKey(): { envPreview: string; storedBackend: SecretBackend; storedPreview: string } | undefined {
  const envKey = process.env.OPENROUTER_API_KEY;
  if (!envKey) return undefined;

  const stored = loadStoredKey();
  if (!stored.key || stored.key === envKey) return undefined;

  const preview = (k: string) => (k.length > 12 ? `${k.slice(0, 8)}…${k.slice(-4)}` : "***");
  return { envPreview: preview(envKey), storedBackend: stored.backend!, storedPreview: preview(stored.key) };
}

export function clearApiKey(): void {
  try {
    if (process.platform === "darwin") run("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
  } catch {}
  try {
    if (process.platform === "linux") run("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT]);
  } catch {}
  for (const f of [credentialFile(), path.join(yimpimDir(), "credential.dpapi")]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  }
}

export function describeBackend(b?: SecretBackend): string {
  switch (b) {
    case "keychain": return "macOS Keychain";
    case "credential-manager": return "Windows Credential Manager (DPAPI, this user only)";
    case "secret-service": return "Linux Secret Service";
    case "file": return `file ${credentialFile()} (owner-only)`;
    case "env": return "OPENROUTER_API_KEY environment variable";
    default: return "not stored";
  }
}

export function apiKeyStatus(): SecretStatus {
  const { key, backend } = loadApiKey();
  return {
    present: Boolean(key),
    backend,
    detail: key ? describeBackend(backend) : "no API key saved yet",
  };
}

export { yimpimDir };
