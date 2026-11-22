/**
 * What a project is made of, as far as security is concerned: languages, frameworks, cloud and third-party
 * services, infrastructure files. Read from the project itself (manifests and files), never asked. The result
 * selects the rule packs that apply, so a Supabase and Stripe app on Expo is held to Supabase, Stripe, React
 * Native, Android and iOS rules, and a Go service in Kubernetes to Go, container and cluster rules.
 */
import fs from "node:fs";
import { lazyIgnore } from "./projectPaths.js";
import path from "node:path";
import { LANG_PACKS, UNIVERSAL, type Pack, type SecRule } from "./securityRules.js";
import { PLATFORM_PACKS } from "./securityVendors.js";

export const ALL_PACKS: Pack[] = [...PLATFORM_PACKS, ...LANG_PACKS];
export const packById = (id: string) => ALL_PACKS.find((p) => p.id === id);

export interface SecurityStack {
  /** Pack ids that apply, most specific (vendors, platforms) first. */
  packs: string[];
  /** Why each pack applies: a dependency or file, at most three. */
  evidence: Record<string, string[]>;
}

// Highest first: a vendor's configuration decides more than a language does.
const ORDER = ["supabase", "firebase", "payments", "auth", "email", "android", "ios", "containers", "kubernetes", "aws", "azure", "gcp", "iac", "ci", "server", "llm", "database", "react", "node", "python", "java", "go", "php", "ruby", "dotnet", "api", "web"];

const DEPS: [string, RegExp][] = [
  ["supabase", /^(@supabase\/.+|supabase|supabase-py|supabase-js|supabase-swift|supabase-kt)$/],
  ["firebase", /^(firebase|firebase-admin|firebase-functions|firebase-tools|@react-native-firebase\/.+|@firebase\/.+|flutterfire|cloud_firestore|firebase_core|firebase_auth)$/],
  ["payments", /^(stripe|@stripe\/.+|stripe-react-native|stripe-js|paypal.*|@paypal\/.+|braintree.*|adyen.*|@adyen\/.+|squareup|square|razorpay|mollie.*|@mollie\/.+|paddle.*|@paddle\/.+|lemonsqueezy|@lemonsqueezy\/.+|react-native-iap|react-native-purchases|checkout-sdk.*|flutter_stripe|in_app_purchase)$/],
  ["auth", /^(auth0|@auth0\/.+|auth0-.+|@clerk\/.+|next-auth|@auth\/.+|passport(-.+)?|amazon-cognito-identity-js|aws-amplify|@aws-amplify\/.+|keycloak-js|keycloak-connect|@okta\/.+|okta-.+|supertokens-.+|better-auth|lucia|jsonwebtoken|jose|pyjwt|python-jose|authlib|django-allauth|devise|omniauth|spring-security-.+|expo-auth-session|react-native-app-auth|firebase_auth|oauth2.*)$/],
  ["email", /^(@sendgrid\/.+|sendgrid|mailchimp.*|@mailchimp\/.+|postmark.*|mailgun.*|resend|nodemailer|twilio|@twilio\/.+|klaviyo.*|braze.*|@braze\/.+|customerio.*|sib-api-v3-sdk|@getbrevo\/.+|brevo|mandrill.*|sparkpost|@aws-sdk\/client-ses.*|@aws-sdk\/client-sns|onesignal.*|react-native-onesignal|mailjet.*|emailjs.*)$/],
  ["aws", /^(aws-sdk|@aws-sdk\/.+|aws-cdk.*|@aws-cdk\/.+|boto3|botocore|aws-lambda|serverless|aws-amplify)$/],
  ["azure", /^(@azure\/.+|azure-.+|azure|microsoft-graph.*|@microsoft\/microsoft-graph-client|msal.*|@azure\/msal-.+)$/],
  ["gcp", /^(@google-cloud\/.+|google-cloud-.+|googleapis|google-auth-library|google-cloud|cloud\.google\.com\/go.*)$/],
  ["database", /^(pg|postgres|mysql2?|mongodb|mongoose|sequelize|prisma|@prisma\/client|typeorm|knex|drizzle-orm|better-sqlite3|sqlite3|redis|ioredis|sqlalchemy|psycopg2?|pymysql|pymongo|django|activerecord|hibernate.*|spring-boot-starter-data-.+|gorm\.io.*|sqlx|diesel|room|sqflite|realm)$/],
  ["llm", /^(openai|@anthropic-ai\/.+|anthropic|@google\/generative-ai|langchain.*|@langchain\/.+|llamaindex|ai|@ai-sdk\/.+|cohere.*|replicate|transformers|@huggingface\/.+|@openrouter\/.+|ollama|google-generativeai|vertexai)$/],
  ["react", /^(react|react-dom|react-native|expo|next|vue|nuxt|svelte|@sveltejs\/kit|@angular\/core|astro|solid-js|remix|@remix-run\/.+|preact|ionic|@ionic\/.+|flutter)$/],
  ["node", /^(express|fastify|koa|@hapi\/hapi|hapi|@nestjs\/core|hono|next|nuxt|socket\.io|restify|@trpc\/server|apollo-server.*|@apollo\/server)$/],
  ["python", /^(django|flask|fastapi|starlette|tornado|aiohttp|pyramid|bottle|sanic|uvicorn|gunicorn)$/],
  ["java", /^(spring-boot.*|org\.springframework.*|quarkus.*|micronaut.*|ktor.*|io\.ktor.*|jakarta.*|javax\.servlet.*)$/],
  ["go", /^(github\.com\/gin-gonic\/gin|github\.com\/labstack\/echo.*|github\.com\/gofiber\/fiber.*|github\.com\/gorilla\/mux|github\.com\/go-chi\/chi.*)$/],
  ["php", /^(laravel\/framework|symfony\/.+|slim\/slim|cakephp\/cakephp)$/],
  ["ruby", /^(rails|sinatra|hanami|grape)$/],
  ["dotnet", /^(microsoft\.aspnetcore.*|aspnetcore.*|microsoft\.entityframeworkcore.*)$/],
  ["api", /^(graphql|apollo-server.*|@apollo\/server|express|fastify|fastapi|flask|django-rest-framework|djangorestframework|@nestjs\/core|trpc|@trpc\/server|hono|spring-boot-starter-web|gin|swagger.*|openapi.*)$/],
];

const FILES: [string, RegExp][] = [
  ["supabase", /(^|\/)supabase\/(config\.toml|migrations\/|functions\/)/],
  ["firebase", /(^|\/)(firebase\.json|\.firebaserc|firestore\.rules|storage\.rules|database\.rules\.json|google-services\.json|GoogleService-Info\.plist)$/],
  ["aws", /(^|\/)(serverless\.ya?ml|samconfig\.toml|cdk\.json|buildspec\.ya?ml|appspec\.ya?ml)$/],
  ["azure", /(^|\/)(azure-pipelines\.ya?ml|host\.json|[^/]+\.bicep|azure\.yaml)$/],
  ["gcp", /(^|\/)(app\.yaml|cloudbuild\.ya?ml|\.gcloudignore)$/],
  ["containers", /(^|\/)(Dockerfile[^/]*|[^/]*\.dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml|\.dockerignore)$/],
  ["kubernetes", /(^|\/)(Chart\.yaml|kustomization\.ya?ml|(k8s|kubernetes|manifests|helm|charts)\/.+\.ya?ml)$/],
  ["iac", /(^|\/)([^/]+\.tf|[^/]+\.tfvars|Pulumi\.ya?ml|[^/]+\.bicep|cdk\.json|template\.ya?ml)$/],
  ["ci", /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile|\.circleci\/config\.ya?ml|bitbucket-pipelines\.ya?ml)$/],
  ["server", /(^|\/)(nginx[^/]*\.conf|httpd\.conf|Vagrantfile|ansible\.cfg|playbook[^/]*\.ya?ml|[^/]+\.service|Procfile|sshd_config|Caddyfile)$/],
  ["android", /(^|\/)(AndroidManifest\.xml|network_security_config\.xml|[^/]+\.gradle(\.kts)?)$/],
  ["ios", /(^|\/)(Info\.plist|Podfile|Package\.swift|[^/]+\.xcodeproj|[^/]+\.entitlements)$/],
  ["python", /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py)$/],
  ["java", /(^|\/)(pom\.xml)$/],
  ["go", /(^|\/)go\.mod$/],
  ["php", /(^|\/)composer\.json$/],
  ["ruby", /(^|\/)Gemfile$/],
  ["dotnet", /(^|\/)([^/]+\.csproj|[^/]+\.sln|[^/]+\.fsproj)$/],
  ["database", /(^|\/)([^/]+\.sql|prisma\/schema\.prisma|schema\.rb|alembic\.ini|knexfile\.[jt]s)$/],
  ["web", /(^|\/)(index\.html|[^/]+\.html|vite\.config\.[jt]s|next\.config\.[a-z]+|webpack\.config\.[a-z]+)$/],
];

// The shared ignore list (projectPaths.ts) plus the .NET build folders.
const SKIP = lazyIgnore(["bin", "obj"]);

/** Manifest dependency names of every flavour, lower-cased. */
function readDependencies(file: string, text: string): string[] {
  const base = path.basename(file);
  const names = new Set<string>();
  try {
    if (base === "package.json") {
      const j = JSON.parse(text);
      for (const k of Object.keys({ ...j.dependencies, ...j.devDependencies, ...j.peerDependencies })) names.add(k.toLowerCase());
    } else if (/^requirements.*\.txt$/.test(base)) {
      for (const l of text.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9_.\-]+)/.exec(l);
        if (m && !l.trim().startsWith("#")) names.add(m[1].toLowerCase());
      }
    } else if (base === "pyproject.toml" || base === "Pipfile") {
      for (const m of text.matchAll(/^\s*"?([A-Za-z0-9_.\-]+)"?\s*(?:=|>=|<=|~=|==|\[)/gm)) names.add(m[1].toLowerCase());
      for (const m of text.matchAll(/"([A-Za-z0-9_.\-]+)\s*(?:[<>=~!;\[]|")/g)) names.add(m[1].toLowerCase());
    } else if (base === "go.mod") {
      for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]+\/[^\s]+)\s+v/gim)) names.add(m[1].toLowerCase());
    } else if (base === "Gemfile") {
      for (const m of text.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) names.add(m[1].toLowerCase());
    } else if (base === "composer.json") {
      const j = JSON.parse(text);
      for (const k of Object.keys({ ...j.require, ...j["require-dev"] })) names.add(k.toLowerCase());
    } else if (base === "pubspec.yaml") {
      for (const m of text.matchAll(/^\s{2}([a-z0-9_]+):/gm)) names.add(m[1].toLowerCase());
      if (/^\s*flutter:/m.test(text)) names.add("flutter");
    } else if (base === "pom.xml" || /\.gradle(\.kts)?$/.test(base)) {
      for (const m of text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) names.add(m[1].toLowerCase());
      for (const m of text.matchAll(/['"]([a-z0-9_.\-]+):([a-z0-9_.\-]+)(?::[^'"]*)?['"]/gi)) {
        names.add(m[2].toLowerCase());
        names.add(`${m[1]}.${m[2]}`.toLowerCase());
      }
      if (/com\.android\.(application|library)/.test(text)) names.add("com.android.application");
    } else if (/\.csproj$/.test(base)) {
      for (const m of text.matchAll(/PackageReference\s+Include="([^"]+)"/g)) names.add(m[1].toLowerCase());
    }
  } catch {
    // an unreadable manifest just contributes nothing
  }
  return [...names];
}

export function detectSecurityStack(repoRoot: string): SecurityStack {
  const evidence: Record<string, string[]> = {};
  const hit = (pack: string, why: string) => {
    const list = (evidence[pack] ??= []);
    if (list.length < 3 && !list.includes(why)) list.push(why);
  };
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || seen > 4000) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
      if (e.isDirectory()) {
        // a folder can be the evidence (supabase/functions/, k8s/)
        for (const [pack, re] of FILES) if (re.test(rel + "/")) hit(pack, rel + "/");
        walk(full, depth + 1);
        continue;
      }
      seen++;
      for (const [pack, re] of FILES) if (re.test(rel)) hit(pack, rel);
      if (/^(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|go\.mod|Gemfile|composer\.json|pubspec\.yaml|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj)$/.test(e.name)) {
        let text = "";
        try {
          text = fs.readFileSync(full, "utf-8").slice(0, 200_000);
        } catch {
          continue;
        }
        for (const dep of readDependencies(full, text)) for (const [pack, re] of DEPS) if (re.test(dep)) hit(pack, `${dep} (${e.name})`);
      }
      // Kubernetes manifests are YAML like any other: the kind says what they are.
      if (/\.ya?ml$/.test(e.name) && !/node_modules/.test(rel)) {
        try {
          const head = fs.readFileSync(full, "utf-8").slice(0, 3000);
          if (/^apiVersion:/m.test(head) && /^kind:\s*(Deployment|Pod|StatefulSet|DaemonSet|CronJob|Job|Ingress|Service|NetworkPolicy|Role|ClusterRole)\b/m.test(head)) hit("kubernetes", rel);
          if (/AWSTemplateFormatVersion|Transform:\s*AWS::Serverless/.test(head)) {
            hit("aws", rel);
            hit("iac", rel);
          }
        } catch {
          // skip
        }
      }
    }
  };
  walk(repoRoot, 0);

  // Frameworks that imply both halves of a platform.
  if (evidence["react"]?.some((e) => /^(expo|react-native)\b/.test(e))) {
    hit("android", "react-native/expo");
    hit("ios", "react-native/expo");
  }
  if (evidence["react"]?.some((e) => /^flutter\b/.test(e))) {
    hit("android", "flutter");
    hit("ios", "flutter");
  }
  if (evidence["java"]?.some((e) => /spring|quarkus|micronaut|ktor/.test(e)) || evidence["python"]?.some((e) => /django|flask|fastapi/.test(e)) || evidence["node"] || evidence["go"] || evidence["php"] || evidence["ruby"] || evidence["dotnet"]) {
    if (!evidence["api"]) hit("api", "a server framework");
    hit("web", "a server framework");
  }
  if (evidence["react"]?.some((e) => /^(react|next|vue|nuxt|svelte|@angular|astro|solid|preact|remix|@remix)/.test(e))) hit("web", "a web front end");
  if (evidence["react"]?.some((e) => /^(next|nuxt|@sveltejs\/kit|remix|@remix-run)/.test(e))) {
    hit("node", "a server-rendered framework");
    hit("api", "a server-rendered framework");
  }

  const packs = ORDER.filter((id) => evidence[id]);
  return { packs, evidence };
}

// ---------------------------------------------------------------------------
// what is shown to agents
// ---------------------------------------------------------------------------

const short = (r: SecRule) => `${r.do} Not: ${r.not}`;

/**
 * The short block every Editor sees: the universal core rules plus the core rules of the packs that apply, within a
 * character budget (specific vendors first). The full rule set is in security/SECURITY.md.
 */
export function coreSecurityBlock(stack: SecurityStack, budget = 6500): string {
  const lines: string[] = [];
  let used = 0;
  const add = (label: string, rules: SecRule[]) => {
    for (const r of rules) {
      const text = `- [${label}] ${short(r)}`;
      if (used + text.length > budget) return false;
      lines.push(text);
      used += text.length;
    }
    return true;
  };
  add("all code", UNIVERSAL.filter((r) => r.core));
  for (const id of stack.packs) {
    const p = packById(id);
    if (!p) continue;
    if (!add(p.name.split(" (")[0], p.rules.filter((r) => r.core))) break;
  }
  return (
    "SECURITY RULES (apply to everything you write; deviations are findings. Assume a hostile user, a hostile network and leaked client code. Where a rule is not met by existing code, fix it in the files you are already changing and report the rest):\n" +
    lines.join("\n") +
    "\nFull rule set and hardening checklist: security/SECURITY.md."
  );
}

/** The project's security posture document: detected stack, every applicable rule with its reference, hardening. */
export function securityDoc(stack: SecurityStack, projectName: string): string {
  const packs = stack.packs.map((id) => packById(id)!).filter(Boolean);
  const rule = (r: SecRule) => `- **${r.id}** [${r.sev}; ${r.ref}] ${r.do} *Not:* ${r.not}`;
  return (
    `<!-- packs: ${stack.packs.join(",")} -->\n# Security: ${projectName}\n\n` +
    `Read before writing code that handles input, identity, money, files, email, third-party services or infrastructure. Binding for every phase. Written from the project's own files, not from a questionnaire. Standards behind it: OWASP Top 10, ASVS, MASVS, the OWASP cheat sheets and the LLM Top 10, CWE, CIS benchmarks and each vendor's own security guidance.\n\n` +
    `## What this project uses\n${packs.map((p) => `- ${p.name}: ${(stack.evidence[p.id] ?? []).join(", ")}`).join("\n") || "- (nothing specific detected: the universal rules apply)"}\n\n` +
    `## How to work\n- Think like the attacker first: who can reach this, what can they send, what do they gain, what stops them? State the answer in the plan for anything touching identity, money, files, email or data.\n- Enforce on the server and in the database; the client is untrusted.\n- Fail closed. Least privilege. No secrets in code, client bundles, logs or images.\n- A finding without a concrete way to exploit it is a note, not a defect; a concrete exploit is a defect to fix now.\n\n` +
    `## Rules for all code\n${UNIVERSAL.map(rule).join("\n")}\n\n` +
    packs.map((p) => `## ${p.name}\n${p.rules.map(rule).join("\n")}\n\nHarden:\n${p.hardening.map((h) => `- ${h}`).join("\n")}\n`).join("\n") +
    `\n## What a clean result means\nChecks here find known patterns and reasoned risks. They do not prove an app is secure. Anything holding money, health or identity data should also have an independent penetration test.\n`
  );
}
