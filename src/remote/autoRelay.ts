/**
 * Relay provisioning: remote control runs through the hosted YIMPIM broker, and only through it.
 *
 * `/remote-control` should be the only thing a user types. In order:
 *
 *   1. A valid Pro lease in ~/.yimpim/auth.json -> the cloud tunnel. Nothing to install, open or keep running.
 *   2. An EXPIRED lease: one refresh attempt against the broker, then the cloud tunnel if that renews it.
 *   3. No usable lease: offer the `/link` phone-pairing flow on the spot (the user may simply not know Pro exists).
 *   4. Otherwise stop with what to do: link this machine to YIMPIM Pro.
 *
 * The desktop only ever makes OUTBOUND requests; the broker holds the public HTTPS endpoint and relays opaque, end-to-end
 * encrypted envelopes. It never holds the session key.
 */

import {
  getValidProToken, readSavedToken, attemptTokenRefresh, executeLinkFlow, LinkFlowOptions,
} from "./auth.js";

/** Where the hosted broker lives. Overridable for tests only (ProvisionOptions.brokerBase). */
export const CLOUD_BROKER_BASE = "https://broker.yimpim.com";

export type RelaySource = "cloud";

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

/** What to do when this machine has no Pro link: the one path there is. */
export const LINK_GUIDANCE = [
  "Remote control runs through YIMPIM Pro: link this machine once, then pair the YIMPIM app.",
  "",
  "  /link            (or `yimpim link` from a shell) — scan the code with the YIMPIM app",
  "  /remote-control  — then pair",
];

// ------------------------------------------------------------ cloud tunnel

export interface CloudTunnelOptions {
  /** Defaults to https://broker.yimpim.com. */
  brokerBase?: string;
  /** Extra headers (normally none — the lease travels in the body). */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Lease the cloud tunnel. Fails closed: any non-2xx, malformed body or unreachable broker throws `RelayUnavailable`. The one
 * thing this must never do is hand back a URL the broker did not actually issue, since the phone would then pair against nothing.
 */
export async function provisionCloudTunnel(
  token: string,
  opts: CloudTunnelOptions = {}
): Promise<ProvisionedRelay> {
  if (!token || typeof token !== "string") {
    throw new RelayUnavailable("No Pro lease available for the cloud tunnel.", LINK_GUIDANCE);
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
    throw new RelayUnavailable(`Could not reach the YIMPIM broker: ${err?.message ?? err}`, [
      "Check your internet connection, then run /remote-control again.",
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
    throw new RelayUnavailable(`The broker refused the request: HTTP ${res.status}${detail}`, [
      "Run /link to re-link this machine, or run /remote-control again in a moment.",
    ]);
  }
  if (!url) {
    throw new RelayUnavailable("The broker returned no usable endpoint.", [
      "Run /remote-control again. If it keeps happening, run /link to re-link this machine.",
    ]);
  }

  return {
    url: url.replace(/\/+$/, ""),
    source: "cloud",
    detail: `${url} — hosted by YIMPIM Pro, nothing to install or keep running`,
    // The endpoint is the broker's: the session teardown is the /v1/unregister the RemoteSession itself performs on stop().
    stop: async () => {},
  };
}

// ------------------------------------------------------------ entry point

export interface ProvisionOptions {
  log: (msg: string) => void;
  /**
   * Asks the user whether to start the /link phone-pairing flow now, used only when this machine has no usable lease. Returns
   * true when the user opted in.
   */
  confirmLinkFlow?: () => Promise<boolean>;
  /** Test seam: the broker to talk to. */
  brokerBase?: string;
  /** Passed through to executeLinkFlow when the /link offer is taken (makes that path testable without a 5-minute wait). */
  linkFlowOptions?: Omit<LinkFlowOptions, "brokerBase">;
}

export async function provisionRelay(opts: ProvisionOptions): Promise<ProvisionedRelay> {
  const { log } = opts;
  const brokerBase = opts.brokerBase ?? CLOUD_BROKER_BASE;

  // ---- 1. A valid Pro lease: proven offline (payload.exp), so no round trip until the tunnel is requested.
  const activeLease = getValidProToken();
  if (activeLease) {
    log(`Pro lease found — connecting to the YIMPIM cloud tunnel…`);
    return await provisionCloudTunnel(activeLease, { brokerBase });
  }

  // ---- 2. An EXPIRED lease: exactly one refresh attempt. A lease that was revoked is cleared by attemptTokenRefresh.
  if (readSavedToken()) {
    log(`Your Pro lease has expired — trying to renew it…`);
    const refreshed = await attemptTokenRefresh({ brokerBase });
    if (refreshed) {
      log(`Lease renewed — connecting to the YIMPIM cloud tunnel…`);
      return await provisionCloudTunnel(refreshed, { brokerBase });
    }
    log(`Could not renew that lease.`);
  }

  // ---- 3. No usable lease: offer the link flow, once.
  if (!readSavedToken() && opts.confirmLinkFlow) {
    const wantsLink = await opts.confirmLinkFlow();
    if (wantsLink) {
      log(`Starting the link flow — scan the code below with your phone…`);
      let linked: string | null = null;
      try {
        linked = await executeLinkFlow({ brokerBase, ...(opts.linkFlowOptions ?? {}) });
      } catch (err: any) {
        log(`Link flow failed: ${err?.message ?? err}`);
      }
      if (linked) return await provisionCloudTunnel(linked, { brokerBase });
      log(`No lease was saved.`);
    }
  }

  // ---- 4. Nothing to connect through.
  throw new RelayUnavailable("This machine is not linked to YIMPIM Pro.", LINK_GUIDANCE);
}
