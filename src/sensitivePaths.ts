/**
 * Which files hold secrets and must never be read for, or shown to, a model: the ONE definition every reader uses (the Editor's file tools, search results, the shared line reader, the git
 * searches the repair and heal passes run, the diff a reviewer reads). safety.blockedFilePatterns is the user's list; this is its default and the helpers that apply it.
 */

/** Globs on a file NAME (not a path): keystores and keys, env files, SSH keys, and service-account / credentials JSON. */
export const DEFAULT_BLOCKED_FILE_PATTERNS = [
  "*.keystore",
  "*.jks",
  "*.p12",
  "*.pem",
  "*.key",
  "*.pfx",
  "*.p8",
  ".env",
  "*.env",
  "*.env.*",
  "id_rsa",
  "id_ed25519",
  "*service-account*.json",
  "*serviceaccount*.json",
  "*-credentials.json",
  "credentials.json",
  "firebase-adminsdk*.json",
];

/**
 * The standard, cross-ecosystem convention for an env-var TEMPLATE: variable names only, never real values, and made to be committed and read. A bare "*.env.*" glob would block these too,
 * and a task like "document the required variables in .env.example" must not be refused.
 */
export const SAFE_ENV_TEMPLATE_RE = /^\.?env\.(example|sample|template|dist|defaults?)$/i;

/** Glob patterns as case-insensitive whole-name RegExps. */
export function compileBlockedPatterns(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i"));
}

const DEFAULT_COMPILED = compileBlockedPatterns(DEFAULT_BLOCKED_FILE_PATTERNS);

/** True when a file NAME (or the last part of a path) is a secrets file. `compiled` is the user's list; the default list when omitted. */
export function isSensitiveName(nameOrPath: string, compiled: RegExp[] = DEFAULT_COMPILED): boolean {
  const name = nameOrPath.replace(/\\/g, "/").split("/").pop() ?? nameOrPath;
  if (SAFE_ENV_TEMPLATE_RE.test(name)) return false;
  return compiled.some((re) => re.test(name));
}

/** `git grep` / `git log` pathspecs that leave the default secret files out of a search (a template such as .env.example is left out too: git cannot express the exception). */
export const SENSITIVE_PATHSPECS: string[] = DEFAULT_BLOCKED_FILE_PATTERNS.map((p) => `:(exclude,glob,icase)**/${p}`);
