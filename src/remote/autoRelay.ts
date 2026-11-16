/**
 * Zero-configuration relay provisioning.
 *
 * `/remote-control` should be the only thing a user types. This module works out
 * how to get a reachable HTTPS endpoint without asking, in priority order:
 *
 *   1. A valid Pro lease in ~/.yimpim/auth.json -> the cloud tunnel, which needs
 *      no local setup at all. This is the paid, zero-config path.
 *   2. A relay URL already in the config, if it actually answers.
 *   3. An EXPIRED lease: one refresh attempt against the broker, then the cloud
 *      tunnel if that renews it.
 *   4. Tailscale: run the relay on loopback and let `tailscale serve` publish it
 *      to the tailnet with a real certificate. Nothing becomes public.
 *   5. Neither a lease nor a running Tailscale: offer the `/link` phone-pairing
 *      flow on the spot rather than failing outright — the user may simply not
 *      know Pro exists.
 *   6. Give up with specific, actionable guidance.
 *
 * Why HTTPS is non-negotiable: the phone page decrypts with WebCrypto, and
 * browsers only expose `crypto.subtle` in a secure context. A plain-HTTP LAN
 * address silently has no crypto at all, so it is never offered.
 */

import { execFileSync, execFile } from "node:child_process";
import type { Server } from "node:http";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import fsSync from "node:fs";
import {
  getValidProToken, readSavedToken, attemptTokenRefresh, executeLinkFlow, LinkFlowOptions,
} from "./auth.js";

const execFileAsync = promisify(execFile);

/** Where the paid zero-config tunnel lives. Overridable for tests/self-hosting. */
export const CLOUD_BROKER_BASE = "https://broker.yimpim.com";

export type RelaySource = "cloud" | "configured" | "tailscale";

export interface ProvisionedRelay {
  url: string;
  source: RelaySource;
  /** Human-readable note about how this was obtained. */
  detail: string;
  stop(): Promise<void>;
}

export class RelayUnavailable extends Error {
  constructor(message: string, public guidance: string[]) {
    super(message);
    this.name = "RelayUnavailable";
  }
}

// ------------------------------------------------------------- tailscale

function tailscaleBin(): string | undefined {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(finder, ["tailscale"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  } catch {}

  // Windows installs to Program Files but does not always add it to PATH.
  if (process.platform === "win32") {
    for (const root of [process.env["ProgramFiles"], process.env["ProgramW6432"]].filter(Boolean) as string[]) {
      const p = path.join(root, "Tailscale", "tailscale.exe");
      if (fsSync.existsSync(p)) return p;
    }
  }
  if (process.platform === "darwin") {
    const p = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    if (fsSync.existsSync(p)) return p;
  }
  return undefined;
}

interface TailscaleState {
  running: boolean;
  dnsName?: string;
  detail: string;
}

function tailscaleState(bin: string): TailscaleState {
  try {
    const out = execFileSync(bin, ["status", "--json"], {
      encoding: "utf-8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const status = JSON.parse(out);

    if (status?.BackendState !== "Running") {
      return { running: false, detail: `Tailscale is installed but not connected (${status?.BackendState ?? "unknown"})` };
    }
    // DNSName comes with a trailing dot.
    const dnsName = String(status?.Self?.DNSName ?? "").replace(/\.$/, "");
    if (!dnsName) return { running: false, detail: "Tailscale is running but this device has no MagicDNS name" };

    return { running: true, dnsName, detail: `Tailscale connected as ${dnsName}` };
  } catch (err: any) {
    return { running: false, detail: `Could not read Tailscale status: ${err.message}` };
  }
}

// --------------------------------------------------------------- probing

async function reachable(url: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ cloud tunnel

export interface CloudTunnelOptions {
  /** Defaults to https://broker.yimpim.com. */
  brokerBase?: string;
  /** Extra headers (normally none — the lease travels in the body). */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Lease the paid zero-config cloud tunnel.
 *
 * The agent process still only ever makes OUTBOUND requests — the broker holds
 * the public HTTPS endpoint and relays opaque envelopes — so this is the one
 * provisioning path that needs nothing installed, nothing opened, and nothing
 * running locally at all. It is gated purely on holding a lease the broker
 * accepts (`payload.exp` in the future, checked offline first by the caller).
 *
 * Fails closed: any non-2xx, malformed body, or unreachable broker throws
 * `RelayUnavailable`, and the caller falls through to Tailscale/guidance. The
 * one thing this must never do is hand back a URL the broker did not actually
 * issue, since the phone would then pair against nothing.
 */
export async function provisionCloudTunnel(
  token: string,
  opts: CloudTunnelOptions = {}
): Promise<ProvisionedRelay> {
  if (!token || typeof token !== "string") {
    throw new RelayUnavailable("No Pro lease available for the cloud tunnel.", []);
  }
  const base = (opts.brokerBase ?? CLOUD_BROKER_BASE).replace(/\/+$/, "");

  let res: Response;
  try {
    res = await fetch(`${base}/api/tunnel/provision`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (err: any) {
    throw new RelayUnavailable(`Could not reach the cloud tunnel service: ${err?.message ?? err}`, [
      "Check your internet connection, then run /remote-control again.",
      "",
      "Prefer a tunnel that never leaves your own devices?",
      "  1. Install https://tailscale.com/download",
      "  2. Sign in on this PC and on your phone",
      "  3. Run /remote-control again",
    ]);
  }

  if (res.status === 401 || res.status === 403) {
    throw new RelayUnavailable("The broker rejected this Pro lease.", [
      "Run /link to re-link this machine and get a fresh lease.",
    ]);
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  const url =
    typeof body?.url === "string" && body.url.trim() ? body.url.trim() :
    typeof body?.tunnelUrl === "string" && body.tunnelUrl.trim() ? body.tunnelUrl.trim() :
    "";

  if (!res.ok) {
    const detail = typeof body?.error === "string" && body.error.trim() ? ` — ${body.error.trim()}` : "";
    throw new RelayUnavailable(`The cloud tunnel service refused the request: HTTP ${res.status}${detail}`, [
      "Run /link to re-link this machine, or run /remote-control again in a moment.",
    ]);
  }
  if (!url) {
    throw new RelayUnavailable("The cloud tunnel service returned no usable endpoint.", [
      "Run /remote-control again. If it keeps happening, run /link to re-link this machine.",
    ]);
  }

  return {
    url: url.replace(/\/+$/, ""),
    source: "cloud",
    detail: `${url} — hosted by YIMPIM Pro, nothing to install or keep running`,
    // The endpoint is the broker's, not ours: the session teardown is the
    // /v1/unregister the RemoteSession itself performs on stop(). There is
    // no local server and no local routing entry to undo.
    stop: async () => {},
  };
}

// ------------------------------------------------------------ entry point

export interface ProvisionOptions {
  configuredUrl: string;
  /** Starts the in-process relay and resolves with its bound port. */
  startLocalRelay: () => Promise<{ server: Server; port: number }>;
  log: (msg: string) => void;
  /**
   * Asks the user whether to start the /link phone-pairing flow now, used only
   * when there is no lease AND Tailscale is not running. Defaults to answering
   * "no", matching every other unattended-safe default in this app. Returns
   * true when the user opted in.
   */
  confirmLinkFlow?: () => Promise<boolean>;
  /** Overrides for tests/self-hosting. */
  brokerBase?: string;
  /**
   * Test seam: force the Tailscale tier to look unavailable. The real
   * availability check shells out to `which tailscale` + `tailscale status`,
   * which makes the tier ORDERING untestable on any machine that happens to
   * have Tailscale installed — and the ordering is the whole contract here.
   */
  tailscaleAvailable?: boolean;
  /**
   * Passed through to executeLinkFlow when the /link offer is taken — the poll
   * cadence/timeout are the only knobs that make that path testable without a
   * real 5-minute wait.
   */
  linkFlowOptions?: Omit<LinkFlowOptions, "brokerBase">;
}

export async function provisionRelay(opts: ProvisionOptions): Promise<ProvisionedRelay> {
  const { configuredUrl, startLocalRelay, log } = opts;
  const brokerBase = opts.brokerBase ?? CLOUD_BROKER_BASE;

  // ---- 1. Pro lease -> cloud tunnel: the zero-config path -----------------
  // Checked FIRST, ahead of a configured relay, because a user who paid for
  // the cloud tunnel should get it without having to also edit config. A
  // valid lease is proven offline (payload.exp), so this costs no round trip
  // until the tunnel is actually requested.
  const activeLease = getValidProToken();
  if (activeLease) {
    log(`Pro lease found — connecting to the YIMPIM cloud tunnel…`);
    try {
      // Not logged here: connectRemote's caller already prints
      // "Relay ready: ${relay.detail}" unconditionally for every source once
      // this returns, so logging it here too just repeated the same line
      // back to back.
      return await provisionCloudTunnel(activeLease, { brokerBase });
    } catch (err: any) {
      if (!(err instanceof RelayUnavailable)) throw err;
      log(`${err.message}`);
      log(`Falling back to a relay you host yourself…`);
    }
  }

  // ---- 2. An already-configured relay, if it is actually answering --------
  if (configuredUrl) {
    log(`Checking your configured relay…`);
    if (await reachable(configuredUrl)) {
      return {
        url: configuredUrl,
        source: "configured",
        detail: `using ${configuredUrl}`,
        stop: async () => {},
      };
    }
    log(`That relay is not responding — trying to set one up automatically.`);
  }

  // ---- 3. An EXPIRED lease: exactly one refresh attempt -------------------
  // Only reached when nothing above worked. A lease that merely aged out is
  // still worth re-arming — the user keeps the tunnel they paid for without
  // ever noticing. A lease that was never there (or was revoked, which makes
  // attemptTokenRefresh clear it) leaves nothing to do here.
  const saved = readSavedToken();
  if (saved && !activeLease) {
    log(`Your Pro lease has expired — trying to renew it…`);
    const refreshed = await attemptTokenRefresh({ brokerBase });
    if (refreshed) {
      log(`Lease renewed — connecting to the YIMPIM cloud tunnel…`);
      try {
        // See the comment on the first provisionCloudTunnel call above — the
        // caller logs relay.detail itself, unconditionally, once this returns.
        return await provisionCloudTunnel(refreshed, { brokerBase });
      } catch (err: any) {
        if (!(err instanceof RelayUnavailable)) throw err;
        log(`${err.message}`);
      }
    } else {
      log(`Could not renew that lease — continuing without the cloud tunnel.`);
    }
  }

  // ---- 4/5. Tailscale, or the /link offer when there is no lease at all ----
  const bin = opts.tailscaleAvailable === false ? undefined : tailscaleBin();
  const state = bin ? tailscaleState(bin) : undefined;
  const tailscaleReady = Boolean(state?.running && state.dnsName);

  // Tailscale is not usable here (not installed, or installed but not
  // connected). With no lease either, don't dead-end on installing something:
  // offer the one path that genuinely needs no local setup — the paid cloud
  // tunnel, via the `/link` phone-pairing flow.
  if (!tailscaleReady && !readSavedToken() && opts.confirmLinkFlow) {
    const wantsLink = await opts.confirmLinkFlow();
    if (wantsLink) {
      log(`Starting the link flow — scan the code below with your phone…`);
      let linked: string | null = null;
      try {
        linked = await executeLinkFlow({ brokerBase, ...(opts.linkFlowOptions ?? {}) });
      } catch (err: any) {
        log(`Link flow failed: ${err?.message ?? err}`);
      }
      if (linked) {
        try {
          // See the comment on the first provisionCloudTunnel call above.
          return await provisionCloudTunnel(linked, { brokerBase });
        } catch (err: any) {
          if (!(err instanceof RelayUnavailable)) throw err;
          log(`${err.message}`);
        }
      } else {
        log(`No lease was saved — continuing without the cloud tunnel.`);
      }
    }
  }

  if (!bin) {
    throw new RelayUnavailable("No relay available and Tailscale is not installed.", [
      "Phone control needs an HTTPS endpoint both your PC and phone can reach.",
      "",
      "Recommended — Tailscale (private to your own devices, nothing public):",
      "  1. Install from https://tailscale.com/download",
      "  2. Sign in on this PC and on your phone",
      "  3. Run /remote-control again — everything else is automatic",
      "",
      "Already have a relay elsewhere?",
      "  yimpim config set remote.brokerUrl https://your-relay",
    ]);
  }

  if (!state!.running || !state!.dnsName) {
    // Tailscale is installed but not up. A user with an active Pro lease
    // would not have reached here (step 1 already returned), so tell them
    // the option exists rather than silently sending them to `tailscale up`.
    if (getValidProToken()) {
      log(`[Tailscale] Session active. Have a Pro subscription? Run /link to enable cloud tunnel.`);
    }
    throw new RelayUnavailable(state!.detail, [
      "Tailscale is installed but not ready.",
      "",
      "  tailscale up          # sign in / reconnect",
      "",
      "Then run /remote-control again.",
    ]);
  }

  log(`${state!.detail}`);
  // Tailscale is up: mention the Pro alternative once, since a user who
  // deliberately keeps Tailscale running may never think to look for it.
  log(`[Tailscale] Session active. Have a Pro subscription? Run /link to enable cloud tunnel.`);
  log(`Starting the relay on this machine (loopback only)…`);
  const { server, port } = await startLocalRelay();

  log(`Publishing it to your tailnet over HTTPS…`);
  try {
    // `serve` is tailnet-only. `funnel` would make it public — never used here.
    await execFileAsync(bin, ["serve", "--bg", `http://127.0.0.1:${port}`], {
      timeout: 45_000,
    });
  } catch (err: any) {
    server.close();
    // Only the command's own output may be classified. err.message echoes the
    // full command line back, so matching on it makes any failure look like
    // whichever flag happens to appear in the arguments.
    const output = `${err?.stderr ?? ""}\n${err?.stdout ?? ""}`.trim();

    if (/certificate|cert.*not.*enabled|HTTPS is not enabled/i.test(output)) {
      throw new RelayUnavailable("Tailscale needs HTTPS certificates enabled for your tailnet.", [
        "Enable it once, in the Tailscale admin console:",
        "  https://login.tailscale.com/admin/dns  →  enable HTTPS Certificates",
        "",
        "Then run /remote-control again.",
      ]);
    }
    if (/invalid argument format|unknown flag|usage info/i.test(output)) {
      throw new RelayUnavailable("This version of Tailscale did not accept the serve command.", [
        `Reported: ${output.split("\n")[0]}`,
        "",
        "YIMPIM uses the modern syntax (tailscale 1.60+):",
        "  tailscale serve --bg http://127.0.0.1:<port>",
        "",
        "Upgrade Tailscale, or host a relay yourself:",
        "  yimpim config set remote.brokerUrl https://your-relay",
      ]);
    }
    throw new RelayUnavailable(`tailscale serve failed: ${output.slice(0, 300) || err?.message}`, [
      "You can still point YIMPIM at any HTTPS relay you control:",
      "  yimpim config set remote.brokerUrl https://your-relay",
    ]);
  }

  const url = `https://${state!.dnsName}`;

  // Confirm it really works before handing the user a QR code. The first
  // request to a new name triggers certificate issuance, which was measured at
  // about 20 seconds — so this waits well past that rather than declaring
  // failure while the certificate is still being minted.
  let ok = false;
  for (let i = 0; i < 12 && !ok; i++) {
    if (i === 3) log(`Still waiting — the first run issues a TLS certificate, which takes ~20s…`);
    ok = await reachable(url, 8000);
    if (!ok) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!ok) {
    server.close();
    throw new RelayUnavailable(`Published to ${url} but it never answered.`, [
      "The certificate may still be issuing. Run /remote-control again —",
      "the second attempt is usually instant.",
      "",
      "If it keeps failing, check:  tailscale serve status",
    ]);
  }

  return {
    url,
    source: "tailscale",
    detail: `${url} — reachable only from your own devices`,
    stop: async () => {
      try {
        await execFileAsync(bin, ["serve", "--https=443", "off"], { timeout: 20_000 });
      } catch {}
      server.close();
    },
  };
}
