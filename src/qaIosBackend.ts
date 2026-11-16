/**
 * What QA's agent can do on an iOS Simulator, through `xcrun simctl` (macOS
 * only). Everything it changes is put back when it finishes.
 *
 * There is deliberately no tap tool: simctl cannot tap or type, and driving
 * the UI would take a UI-test runner (XCUITest or idb) that this project may
 * not have. A state that needs a tap to reach is reported as unreachable, and
 * the Planner triage decides whether a deep link or a launch argument is worth
 * building so it can be reached without one.
 */
import type { QaBackend, ToolSpec } from "./qaBrowserAgent.js";

/** Runs `xcrun simctl <args>` and returns stdout. Throws on a non-zero exit. */
export type SimctlExec = (args: string[], timeoutMs?: number) => string;

/** The services `simctl privacy` accepts. Anything else is refused. */
export const IOS_PRIVACY_SERVICES = [
  "all",
  "calendar",
  "contacts-limited",
  "contacts",
  "location",
  "location-always",
  "photos-add",
  "photos",
  "media-library",
  "microphone",
  "motion",
  "reminders",
  "siri",
] as const;

export const IOS_TEXT_SIZES = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
] as const;

const BUNDLE_ID = /^[A-Za-z0-9.-]{1,200}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TOOLS: ToolSpec[] = [
  { name: "set_appearance", args: '{"value":"light"|"dark"}', does: "Set the simulator's appearance (system light or dark). An app that follows its own saved theme setting may not respond; a screenshot will show whether it did. Put back when you finish." },
  { name: "set_text_size", args: `{"value":${IOS_TEXT_SIZES.map((s) => `"${s}"`).slice(0, 3).join("|")}|...}`, does: `Set the system text size (Dynamic Type). One of: ${IOS_TEXT_SIZES.join(", ")}. Put back when you finish.` },
  { name: "open_link", args: '{"uri":string}', does: "Open a URL or deep link in the simulator (a custom scheme the app handles, or a universal link). For reaching a screen a link leads to." },
  { name: "relaunch", args: "{}", does: "Terminate the app and launch it again." },
  { name: "set_location", args: '{"latitude":number,"longitude":number}', does: "Set the simulated GPS location. Put back (cleared) when you finish." },
  { name: "set_permission", args: '{"service":string,"value":"granted"|"revoked"}', does: `Grant or revoke one privacy permission for this app. Services: ${IOS_PRIVACY_SERVICES.join(", ")}. Relaunch for the app to notice. Afterwards the permission is reset to "ask again".` },
  { name: "read_logs", args: '{"minutes"?:number}', does: "Read recent log lines that mention this app (1-10 minutes back)." },
];

export function iosBackend(opts: { exec: SimctlExec; bundleId: string; shoot: () => Promise<Buffer> }): QaBackend {
  const { exec, bundleId } = opts;
  if (!BUNDLE_ID.test(bundleId)) throw new Error("unusable bundle id");
  let scheme: "light" | "dark" | undefined;
  let originalAppearance: string | undefined;
  let originalTextSize: string | undefined;
  let changedAppearance = false;
  let changedTextSize = false;
  let changedLocation = false;
  const touchedServices = new Set<string>();
  const conditions = new Set<string>();

  try {
    originalAppearance = exec(["ui", "booted", "appearance"], 15000).trim().toLowerCase();
    if (originalAppearance === "light" || originalAppearance === "dark") scheme = originalAppearance;
  } catch {}
  try {
    originalTextSize = exec(["ui", "booted", "content_size"], 15000).trim().toLowerCase();
  } catch {}

  return {
    kind: "ios",
    tools: TOOLS,
    state: () => ({ scheme, viewport: "iOS Simulator", conditions: [...conditions] }),
    shoot: opts.shoot,
    async run(tool, args) {
      if (tool === "set_appearance") {
        if (args.value !== "light" && args.value !== "dark") throw new Error('value must be "light" or "dark"');
        exec(["ui", "booted", "appearance", args.value], 15000);
        scheme = args.value;
        changedAppearance = true;
        await sleep(1500);
        return { retake: `after setting the simulator appearance to ${args.value}` };
      }
      if (tool === "set_text_size") {
        if (!(IOS_TEXT_SIZES as readonly string[]).includes(args.value)) throw new Error("value must be one of: " + IOS_TEXT_SIZES.join(", "));
        exec(["ui", "booted", "content_size", args.value], 15000);
        changedTextSize = true;
        conditions.add(`text size ${args.value}`);
        await sleep(1500);
        return { retake: `after setting the text size to ${args.value}` };
      }
      if (tool === "open_link") {
        const uri = String(args.uri ?? "").slice(0, 500);
        if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) throw new Error("uri must start with a scheme, such as https: or myapp:");
        exec(["openurl", "booted", uri], 20000);
        await sleep(2500);
        return { retake: `after opening ${uri}` };
      }
      if (tool === "relaunch") {
        try {
          exec(["terminate", "booted", bundleId], 15000);
        } catch {}
        exec(["launch", "booted", bundleId], 30000);
        await sleep(3000);
        return { retake: "after relaunching the app" };
      }
      if (tool === "set_location") {
        const lat = Number(args.latitude);
        const lon = Number(args.longitude);
        if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw new Error("latitude -90..90 and longitude -180..180 required");
        exec(["location", "booted", "set", `${lat},${lon}`], 15000);
        changedLocation = true;
        conditions.add(`location ${lat},${lon}`);
        await sleep(1000);
        return { retake: `after setting the location to ${lat},${lon}` };
      }
      if (tool === "set_permission") {
        const service = String(args.service ?? "");
        if (!(IOS_PRIVACY_SERVICES as readonly string[]).includes(service)) throw new Error("service must be one of: " + IOS_PRIVACY_SERVICES.join(", "));
        if (args.value !== "granted" && args.value !== "revoked") throw new Error('value must be "granted" or "revoked"');
        exec(["privacy", "booted", args.value === "granted" ? "grant" : "revoke", service, bundleId], 15000);
        touchedServices.add(service);
        conditions.add(`${service} ${args.value}`);
        return { retake: `after ${args.value === "granted" ? "granting" : "revoking"} ${service}` };
      }
      if (tool === "read_logs") {
        const minutes = Math.min(10, Math.max(1, Math.round(Number(args.minutes) || 2)));
        const text = exec(
          ["spawn", "booted", "log", "show", "--last", `${minutes}m`, "--style", "compact", "--predicate", `eventMessage CONTAINS "${bundleId}" OR subsystem CONTAINS "${bundleId}"`],
          30000
        );
        const lines = text.split("\n").filter((l) => l.trim()).slice(-40).join("\n");
        return { evidence: `logs, last ${minutes}m`, text: lines || "no log lines mention this app" };
      }
      throw new Error("unknown tool");
    },
    async restore() {
      if (changedAppearance && originalAppearance && (originalAppearance === "light" || originalAppearance === "dark")) {
        try {
          exec(["ui", "booted", "appearance", originalAppearance], 15000);
        } catch {}
      }
      if (changedTextSize && originalTextSize && (IOS_TEXT_SIZES as readonly string[]).includes(originalTextSize)) {
        try {
          exec(["ui", "booted", "content_size", originalTextSize], 15000);
        } catch {}
      }
      if (changedLocation) {
        try {
          exec(["location", "booted", "clear"], 15000);
        } catch {}
      }
      for (const service of touchedServices) {
        try {
          exec(["privacy", "booted", "reset", service, bundleId], 15000);
        } catch {}
      }
    },
  };
}
