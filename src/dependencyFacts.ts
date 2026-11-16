/**
 * Verified facts about a package, and a version choice made from them.
 *
 * A model is unreliable on exactly the questions that matter when adding a
 * dependency: does this package exist, what is its latest version, was it
 * deprecated or yanked, is it brand new. So the model says WHAT and WHY, this
 * module fetches the FACTS from the real registry, and a small policy picks
 * the VERSION. Everything here is read-only network lookups.
 *
 * Failure semantics matter: a registry that cannot be reached is "unknown",
 * never "does not exist", so an offline machine is not told that real
 * packages are fake.
 */

export type Ecosystem = "npm" | "pypi" | "crates" | "maven" | "nuget" | "go";
export const ECOSYSTEMS: readonly Ecosystem[] = ["npm", "pypi", "crates", "maven", "nuget", "go"];

export interface VersionFact {
  version: string;
  publishedAt?: string;
  yanked?: boolean;
  /** npm's deprecation message, when the version is deprecated. */
  deprecated?: string;
  /** True when `publishedAt` is only an upper bound (npm: the tarball's Last-Modified). */
  publishedAtIsUpperBound?: boolean;
  /** npm: tarball URL from the registry (used only for a HEAD request). */
  tarball?: string;
  /** PyPI: a non-yanked wheel exists for this release. */
  wheel?: boolean;
}

export interface PackageFacts {
  ecosystem: Ecosystem;
  name: string;
  /** True only on an explicit "not found" from the registry. */
  exists: boolean;
  /** Set when the registry could not be reached: nothing else is then known. */
  lookupError?: string;
  versions: VersionFact[];
  registryLatest?: string;
  firstPublishedAt?: string;
  weeklyDownloads?: number;
  totalDownloads?: number;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const NAME_PATTERNS: Record<Ecosystem, RegExp> = {
  npm: /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
  pypi: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  crates: /^[A-Za-z][A-Za-z0-9_-]*$/,
  maven: /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/,
  nuget: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  // A module path: dotted host first, slash-separated; no "..", no empty segment.
  go: /^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(\/[A-Za-z0-9._~-]+)+$/,
};

/** An ecosystem's name rules; also what keeps a model-supplied name out of a URL's structure. */
export function isValidPackageName(ecosystem: Ecosystem, name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 214 &&
    !name.includes("..") &&
    NAME_PATTERNS[ecosystem].test(name)
  );
}

const TIMEOUT_MS = 8000;
const MAX_BODY_CHARS = 8 * 1024 * 1024;

async function getText(fetchFn: FetchFn, url: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
  const res = await fetchFn(url, {
    ...init,
    headers: { "user-agent": "yimpim-cli (dependency check)", accept: "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, text: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text };
}

// ---------------------------------------------------------------- versions

export function isPrerelease(ecosystem: Ecosystem, version: string): boolean {
  const v = version.toLowerCase();
  if (ecosystem === "pypi") return /(a|b|rc|alpha|beta|dev|pre)\d*/.test(v.replace(/^\d+(\.\d+)*/, ""));
  if (ecosystem === "maven") return /(alpha|beta|rc|snapshot|preview|-m\d|\.m\d|dev|eap|canary)/.test(v);
  return v.includes("-"); // npm / crates semver: anything after a hyphen is a pre-release
}

/** Numeric, segment-wise comparison; enough to order stable releases. */
export function compareVersions(a: string, b: string): number {
  const seg = (v: string) => v.replace(/^v(?=\d)/, "").split(/[.\-+_]/).map((s) => (/^\d+$/.test(s) ? Number(s) : -1));
  const x = seg(a);
  const y = seg(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ----------------------------------------------------------------- registries

async function addNpmDownloads(facts: PackageFacts, fetchFn: FetchFn): Promise<void> {
  try {
    const dl = await getText(fetchFn, `https://api.npmjs.org/downloads/point/last-week/${facts.name.replace("/", "%2F")}`);
    if (dl.status === 200) facts.weeklyDownloads = Number(JSON.parse(dl.text)?.downloads) || 0;
  } catch {
    /* optional signal */
  }
}

async function lookupNpm(name: string, fetchFn: FetchFn): Promise<PackageFacts> {
  const base: PackageFacts = { ecosystem: "npm", name, exists: true, versions: [] };
  // Abbreviated metadata: dist-tags and per-version deprecation, without the
  // multi-megabyte full document.
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
  const { status, text } = await getText(fetchFn, url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (status === 404) return { ...base, exists: false };
  if (status !== 200) return { ...base, lookupError: `npm registry answered HTTP ${status}` };
  const doc = JSON.parse(text);
  base.registryLatest = doc?.["dist-tags"]?.latest;
  for (const [version, meta] of Object.entries<any>(doc?.versions ?? {})) {
    const tarball = typeof meta?.dist?.tarball === "string" ? meta.dist.tarball : undefined;
    base.versions.push({
      version,
      ...(meta?.deprecated ? { deprecated: String(meta.deprecated) } : {}),
      // Only the registry's own host is ever requested.
      ...(tarball && tarball.startsWith("https://registry.npmjs.org/") ? { tarball } : {}),
    });
  }
  // Popularity is the one cheap signal that separates a real library from a
  // freshly registered look-alike.
  try {
    const dl = await getText(fetchFn, `https://api.npmjs.org/downloads/point/last-week/${name.replace("/", "%2F")}`);
    if (dl.status === 200) base.weeklyDownloads = Number(JSON.parse(dl.text)?.downloads) || 0;
  } catch {
    /* optional signal */
  }
  return base;
}

async function lookupPypi(name: string, fetchFn: FetchFn): Promise<PackageFacts> {
  const base: PackageFacts = { ecosystem: "pypi", name, exists: true, versions: [] };
  const { status, text } = await getText(fetchFn, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  if (status === 404) return { ...base, exists: false };
  if (status !== 200) return { ...base, lookupError: `PyPI answered HTTP ${status}` };
  const doc = JSON.parse(text);
  base.registryLatest = doc?.info?.version;
  let first: string | undefined;
  for (const [version, files] of Object.entries<any>(doc?.releases ?? {})) {
    if (!Array.isArray(files) || files.length === 0) continue;
    const times = files.map((f: any) => f?.upload_time_iso_8601).filter(Boolean).sort();
    const publishedAt: string | undefined = times[0];
    if (publishedAt && (!first || publishedAt < first)) first = publishedAt;
    base.versions.push({
      version,
      ...(publishedAt ? { publishedAt } : {}),
      ...(files.every((f: any) => f?.yanked) ? { yanked: true } : {}),
      wheel: files.some((f: any) => f?.packagetype === "bdist_wheel" && !f?.yanked),
    });
  }
  base.firstPublishedAt = first;
  return base;
}

async function lookupCrates(name: string, fetchFn: FetchFn): Promise<PackageFacts> {
  const base: PackageFacts = { ecosystem: "crates", name, exists: true, versions: [] };
  const { status, text } = await getText(fetchFn, `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`);
  if (status === 404) return { ...base, exists: false };
  if (status !== 200) return { ...base, lookupError: `crates.io answered HTTP ${status}` };
  const doc = JSON.parse(text);
  base.registryLatest = doc?.crate?.max_stable_version ?? doc?.crate?.max_version;
  base.totalDownloads = Number(doc?.crate?.downloads) || undefined;
  let first: string | undefined;
  for (const v of doc?.versions ?? []) {
    if (v?.created_at && (!first || v.created_at < first)) first = v.created_at;
    base.versions.push({
      version: String(v?.num),
      ...(v?.created_at ? { publishedAt: String(v.created_at) } : {}),
      ...(v?.yanked ? { yanked: true } : {}),
    });
  }
  base.firstPublishedAt = first;
  return base;
}

async function lookupMaven(name: string, fetchFn: FetchFn): Promise<PackageFacts> {
  const base: PackageFacts = { ecosystem: "maven", name, exists: true, versions: [] };
  const [group, artifact] = name.split(":");
  const dir = `${group.replace(/\./g, "/")}/${artifact}`;
  // Android libraries (androidx, play-services) are on Google's repository,
  // not Maven Central.
  const repos = ["https://repo1.maven.org/maven2", "https://dl.google.com/dl/android/maven2"];
  let sawError: string | undefined;
  for (const repo of repos) {
    const { status, text } = await getText(fetchFn, `${repo}/${dir}/maven-metadata.xml`, {
      headers: { accept: "application/xml" },
    });
    if (status === 404) continue;
    if (status !== 200) {
      sawError = `${repo} answered HTTP ${status}`;
      continue;
    }
    for (const m of text.matchAll(/<version>([^<]+)<\/version>/g)) base.versions.push({ version: m[1].trim() });
    base.registryLatest = /<release>([^<]+)<\/release>/.exec(text)?.[1]?.trim() ?? /<latest>([^<]+)<\/latest>/.exec(text)?.[1]?.trim();
    return base;
  }
  return sawError ? { ...base, lookupError: sawError } : { ...base, exists: false };
}

// -------------------------------------------------------------------- deps.dev

const DEPSDEV_SYSTEM: Partial<Record<Ecosystem, string>> = {
  npm: "npm",
  maven: "maven",
  nuget: "nuget",
  go: "go",
  pypi: "pypi",
  crates: "cargo",
};

/**
 * Google's Open Source Insights: one JSON shape and real per-version publish
 * dates for several ecosystems (what npm's cheap metadata lacks). Returns
 * undefined when it has nothing usable, so the caller can fall back to the
 * ecosystem's own registry; "not found here" is never "does not exist".
 */
async function lookupDepsDev(ecosystem: Ecosystem, name: string, fetchFn: FetchFn): Promise<PackageFacts | undefined> {
  const system = DEPSDEV_SYSTEM[ecosystem];
  if (!system) return undefined;
  const url = `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(name)}`;
  let res: { status: number; text: string };
  try {
    res = await getText(fetchFn, url);
  } catch {
    return undefined;
  }
  if (res.status !== 200) return undefined;
  let doc: any;
  try {
    doc = JSON.parse(res.text);
  } catch {
    return undefined;
  }
  const list: any[] = Array.isArray(doc?.versions) ? doc.versions : [];
  if (list.length === 0) return undefined;
  const facts: PackageFacts = { ecosystem, name, exists: true, versions: [] };
  let first: string | undefined;
  for (const v of list) {
    const version = v?.versionKey?.version;
    if (typeof version !== "string") continue;
    const publishedAt = typeof v?.publishedAt === "string" ? v.publishedAt : undefined;
    if (publishedAt && (!first || publishedAt < first)) first = publishedAt;
    facts.versions.push({
      version,
      ...(publishedAt ? { publishedAt } : {}),
      ...(v?.isDeprecated ? { deprecated: String(v?.deprecatedReason || "deprecated").slice(0, 200) } : {}),
    });
    if (v?.isDefault) facts.registryLatest = version;
  }
  if (facts.versions.length === 0) return undefined;
  facts.firstPublishedAt = first;
  return facts;
}

/** Looks a package up in its registry. Never throws: a failure becomes `lookupError`. */
export async function lookupPackage(
  ecosystem: Ecosystem,
  name: string,
  fetchFn: FetchFn = fetch
): Promise<PackageFacts> {
  if (!isValidPackageName(ecosystem, name)) {
    return { ecosystem, name, exists: false, versions: [], lookupError: `"${name}" is not a valid ${ecosystem} package name` };
  }
  try {
    // PyPI and crates.io keep their own adapters first: they report yanked
    // releases and (PyPI) wheels, which deps.dev does not.
    if (ecosystem === "npm" || ecosystem === "maven" || ecosystem === "nuget" || ecosystem === "go") {
      const viaDepsDev = await lookupDepsDev(ecosystem, name, fetchFn);
      if (viaDepsDev) {
        if (ecosystem === "npm") await addNpmDownloads(viaDepsDev, fetchFn);
        return viaDepsDev;
      }
    }
    switch (ecosystem) {
      case "npm":
        return await lookupNpm(name, fetchFn);
      case "pypi":
        return await lookupPypi(name, fetchFn);
      case "crates":
        return await lookupCrates(name, fetchFn);
      case "maven":
        return await lookupMaven(name, fetchFn);
      default:
        // NuGet / Go exist only through deps.dev. Not being found there can
        // mean "not indexed" (or a registry outage), never "invented".
        return {
          ecosystem,
          name,
          exists: true,
          versions: [],
          lookupError: `${ecosystem} packages are checked through deps.dev, which has no record of "${name}" (or could not be reached)`,
        };
    }
  } catch (err: any) {
    return { ecosystem, name, exists: true, versions: [], lookupError: String(err?.message ?? err).slice(0, 200) };
  }
}

// ------------------------------------------------------------ vulnerabilities

const OSV_ECOSYSTEM: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  crates: "crates.io",
  maven: "Maven",
  nuget: "NuGet",
  go: "Go",
};

export interface VulnerabilityFacts {
  /** False when the lookup failed: absence of results then proves nothing. */
  checked: boolean;
  ids: string[];
}

/** Known advisories for one exact version, from OSV.dev. */
export async function lookupVulnerabilities(
  ecosystem: Ecosystem,
  name: string,
  version: string,
  fetchFn: FetchFn = fetch
): Promise<VulnerabilityFacts> {
  try {
    const { status, text } = await getText(fetchFn, "https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: { name, ecosystem: OSV_ECOSYSTEM[ecosystem] }, version }),
    });
    if (status !== 200) return { checked: false, ids: [] };
    const vulns = JSON.parse(text)?.vulns;
    const ids = Array.isArray(vulns) ? vulns.map((v: any) => String(v?.id)).filter(Boolean) : [];
    return { checked: true, ids };
  } catch {
    return { checked: false, ids: [] };
  }
}

// -------------------------------------------------------------------- policy

export interface VersionChoice {
  version?: string;
  /** Plain-language account of why this one (or why none). */
  reason: string;
}

export interface ChooseOptions {
  now?: Date;
  /** A release newer than this is skipped in favour of an older stable one. */
  minAgeDays?: number;
  /** A specific version the caller wants; used if it exists and is not yanked. */
  requested?: string;
}

/**
 * Newest stable, non-yanked, non-deprecated release that is not brand new.
 * "Not brand new" is a margin against a just-published compromised release
 * that has not been caught yet; it applies only where the registry reports
 * publish dates.
 */
export function chooseVersion(facts: PackageFacts, opts: ChooseOptions = {}): VersionChoice {
  const now = (opts.now ?? new Date()).getTime();
  const margin = (opts.minAgeDays ?? 7) * 86_400_000;

  if (opts.requested) {
    const hit = facts.versions.find((v) => v.version === opts.requested);
    if (hit && !hit.yanked) return { version: hit.version, reason: `the requested version ${hit.version}` };
  }

  const stable = facts.versions
    .filter((v) => !v.yanked && !v.deprecated && !isPrerelease(facts.ecosystem, v.version))
    .sort((a, b) => compareVersions(b.version, a.version));
  if (stable.length === 0) return { reason: "no stable, non-yanked, non-deprecated release exists" };

  const settled = stable.find((v) => !v.publishedAt || now - Date.parse(v.publishedAt) >= margin);
  if (settled) {
    const skipped = stable.indexOf(settled);
    return {
      version: settled.version,
      reason:
        skipped === 0
          ? `the newest stable release${settled.publishedAt ? ` (published ${settled.publishedAt.slice(0, 10)})` : ""}`
          : `the newest stable release that is at least ${opts.minAgeDays ?? 7} days old ` +
            `(${skipped} newer release(s) were skipped as too fresh to have been vetted)`,
    };
  }
  return { version: stable[0].version, reason: "the newest stable release (every stable release is very recent)" };
}

/**
 * chooseVersion plus the one thing npm's cheap metadata lacks: a date. The
 * full packument (where `time` lives) can be megabytes, and the per-version
 * document has no timestamp, so the tarball's Last-Modified is read with a
 * HEAD request. It is an UPPER BOUND on the publish date (a re-upload only
 * moves it later), which is the safe direction for an "old enough" margin.
 * At most 5 HEADs; a failure leaves the version undated, as before.
 */
export async function chooseVersionWithDates(
  facts: PackageFacts,
  fetchFn: FetchFn,
  opts: ChooseOptions = {}
): Promise<VersionChoice> {
  if (facts.ecosystem !== "npm" || facts.lookupError) return chooseVersion(facts, opts);
  const tried = new Set<string>();
  let choice = chooseVersion(facts, opts);
  for (let i = 0; i < 5 && choice.version && !tried.has(choice.version); i++) {
    const v = facts.versions.find((x) => x.version === choice.version);
    if (!v || v.publishedAt || !v.tarball) break;
    tried.add(v.version);
    try {
      const res = await fetchFn(v.tarball, { method: "HEAD" });
      const lm = (res as any)?.headers?.get?.("last-modified");
      const ms = lm ? Date.parse(lm) : NaN;
      if (res.status === 200 && Number.isFinite(ms)) {
        v.publishedAt = new Date(ms).toISOString();
        v.publishedAtIsUpperBound = true;
      }
    } catch {
      /* undated: the policy then has no age to apply */
    }
    choice = chooseVersion(facts, opts);
  }
  return choice;
}

export type WarningLevel = "block" | "confirm" | "info";
export interface DependencyWarning {
  level: WarningLevel;
  text: string;
}

export interface Assessment {
  warnings: DependencyWarning[];
  /** The highest level present: block > confirm > info > none. */
  level: WarningLevel | "none";
}

/** Signals worth a person's attention, from facts only. No guessing about intent. */
export function assessPackage(
  facts: PackageFacts,
  chosen: VersionFact | undefined,
  vulns: VulnerabilityFacts | undefined,
  now: Date = new Date()
): Assessment {
  const warnings: DependencyWarning[] = [];
  const add = (level: WarningLevel, text: string) => warnings.push({ level, text });

  if (!facts.exists) {
    add("block", `"${facts.name}" does not exist in the ${facts.ecosystem} registry. It was probably invented; do not add it.`);
  } else if (facts.lookupError) {
    add("info", `could not verify against the registry (${facts.lookupError}); nothing below is confirmed`);
  } else {
    if (!chosen) add("block", "no usable release exists (all are yanked, deprecated or pre-release)");
    if (chosen && chosen.wheel === false) {
      add("confirm", "no prebuilt wheel is published for this release; installing it runs a build step on this machine");
    }
    if (chosen?.deprecated) add("confirm", `this version is deprecated: ${chosen.deprecated.slice(0, 160)}`);

    if (facts.firstPublishedAt) {
      const ageDays = (now.getTime() - Date.parse(facts.firstPublishedAt)) / 86_400_000;
      if (ageDays < 30) add("confirm", `first published only ${Math.max(0, Math.floor(ageDays))} day(s) ago`);
    }
    if (facts.weeklyDownloads !== undefined && facts.weeklyDownloads < 100) {
      add("confirm", `very few downloads (${facts.weeklyDownloads} last week); a look-alike name is possible`);
    }
    if (facts.versions.length <= 1 && facts.exists) add("info", "only one release has ever been published");

    if (vulns && !vulns.checked) add("info", "known-vulnerability lookup was unavailable");
    if (vulns?.checked && vulns.ids.length > 0) {
      add("confirm", `known advisories for this version: ${vulns.ids.slice(0, 5).join(", ")}`);
    }
  }
  const rank: Record<WarningLevel, number> = { info: 1, confirm: 2, block: 3 };
  const top = warnings.reduce<WarningLevel | "none">(
    (acc, w) => (acc === "none" || rank[w.level] > rank[acc] ? w.level : acc),
    "none"
  );
  return { warnings, level: top };
}
