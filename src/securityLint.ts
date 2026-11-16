/**
 * Deterministic security checks on what a phase just wrote, for every language and platform the harness meets.
 * They read ADDED lines only (the existing code is not judged here), plus the whole file where one fact needs it
 * (a payment webhook handler without a signature check). A pattern cannot know intent, so only the unambiguous
 * cases are defects (they trigger a repair); the rest are concerns shown to the reviewer.
 *
 * Patterns come from vendor secret formats and the OWASP / CWE / MASVS / CIS material behind securityRules.ts.
 */
import fs from "node:fs";
import path from "node:path";

export interface SecSignal {
  severity: "defect" | "concern";
  requirement: string;
  message: string;
}

export interface SegmentLike {
  file?: string;
  diff: string;
}

const SKIP_FILE = /(^|\/)(__tests__|tests?|spec|e2e|fixtures?|mocks?|__mocks__|examples?|samples?|docs?|node_modules|vendor|dist|build)\/|\.(test|spec|stories|min)\.[a-z]+$|\.(md|mdx|txt|lock|svg|png|jpe?g|gif|ico|pdf|woff2?|ttf|snap)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$/i;
const ENV_FILE = /(^|\/)\.env(\.[a-z0-9_-]+)?$/i;
const ENV_EXAMPLE = /\.(example|sample|template|dist)$/i;
const SUPPRESS = /nosec|nosemgrep|noqa:\s*S\d|pragma:\s*allowlist\s*secret|eslint-disable(-next)?-line[^\n]*security|security-ignore|gitleaks:allow/i;
const PLACEHOLDER = /(your|example|changeme|change_me|replace|placeholder|dummy|sample|fake|todo|xxx+|\*{3,}|<[^>]+>|\$\{|%\(|process\.env|os\.environ|getenv|env\(|import\.meta\.env|config\.|settings\.|secrets?\.|vault|^\s*#)/i;
const INPUT = /\b(req|request)\.(body|query|params|headers|args|form|json|data)\b|\bparams\[|\$_(GET|POST|REQUEST|COOKIE)|\bsys\.argv\b|\buserInput\b|\binput\(/i;
const DOC_COMMENT = /^\s*(\/\/|\/\*|\*|#|<!--|--|;)/;

interface Check {
  id: string;
  sev: "defect" | "concern";
  /** path filter; absent means any non-skipped file */
  files?: RegExp;
  re: RegExp;
  /** a line that matches `re` but also matches this is fine */
  ok?: RegExp;
  /** match against the line with quoted strings removed, so words inside messages do not count */
  code?: boolean;
  /** the line must also match this (e.g. user input present) to be a defect; otherwise a concern */
  escalate?: RegExp;
  message: string;
}

const CODE = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|rb|php|java|kt|kts|swift|m|mm|go|rs|cs|dart|scala|sh|bash|zsh|ps1|html?|erb|ejs|hbs|twig)$/i;

const CHECKS: Check[] = [
  // --- transport and certificates
  { id: "tls-off", sev: "defect", re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*['"]?0|verify\s*=\s*False\b|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFY(PEER|HOST)\s*,\s*(false|0)|ALLOW_ALL_HOSTNAME_VERIFIER|setHostnameVerifier\([^)]*(true|ALLOW)|ServerCertificateValidationCallback\s*=[^;]*true|_create_unverified_context|check_hostname\s*=\s*False|TrustAllCerts|verify_ssl\s*[:=]\s*false|curl\b[^|\n]*\s(-k|--insecure)\b/i, message: "Certificate or TLS verification is turned off. Anyone on the network can read and change the traffic. Remove it and, for a private CA, trust that CA instead. If it is deliberate (a local dev server with a self-signed certificate), say why in a nosec comment on that line." },
  { id: "cleartext-url", sev: "concern", files: CODE, re: /['"`]http:\/\/(?!localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\]|www\.w3\.org|schemas?\.|xmlns|example\.|json-schema|purl\.org|ns\.adobe|[a-z0-9.-]*\.(local|test|internal)\b)[a-z0-9-]+(\.[a-z0-9-]+)+/i, message: "A remote endpoint is called over plain http. Use https." },
  // --- secrets
  { id: "secret-aws", sev: "defect", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, message: "An AWS access key id is in the code." },
  { id: "secret-github", sev: "defect", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|github_pat_[A-Za-z0-9_]{50,}/, message: "A GitHub token is in the code." },
  { id: "secret-stripe", sev: "defect", re: /\b(sk|rk)_live_[0-9A-Za-z]{16,}\b/, message: "A live Stripe secret or restricted key is in the code." },
  { id: "secret-slack", sev: "defect", re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/, message: "A Slack token is in the code." },
  { id: "secret-sendgrid", sev: "defect", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/, message: "A SendGrid API key is in the code." },
  { id: "secret-mailgun", sev: "defect", re: /\bkey-[0-9a-f]{32}\b/, message: "A Mailgun API key is in the code." },
  { id: "secret-twilio", sev: "defect", re: /(auth|token|secret|twilio)[^\n]*\b(SK|AC)[0-9a-f]{32}\b|\b(SK|AC)[0-9a-f]{32}\b[^\n]*(auth|token|secret|twilio)/i, message: "A Twilio credential is in the code." },
  { id: "secret-openai", sev: "defect", re: /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-or-v1-[0-9a-f]{40,}/, message: "A model-provider API key is in the code." },
  { id: "secret-privkey", sev: "defect", re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/, message: "A private key is in the code." },
  { id: "secret-gcp-sa", sev: "defect", re: /"private_key_id"\s*:\s*"[0-9a-f]{20,}"/, message: "A Google Cloud service-account key file is in the code." },
  { id: "secret-azure", sev: "defect", re: /AccountKey=[A-Za-z0-9+/=]{40,}|SharedAccessKey=[A-Za-z0-9+/=]{30,}/, message: "An Azure account or access key is in the code." },
  { id: "secret-supabase", sev: "defect", re: /\bsb_secret_[A-Za-z0-9_-]{16,}/, message: "A Supabase secret key is in the code." },
  { id: "secret-generic", sev: "concern", re: /\b(pass(word|wd)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i, message: "A credential looks hard-coded. Load it from the environment or a secret manager." },
  { id: "db-url-password", sev: "concern", re: /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqps?|mssql):\/\/[^\s:@/'"]+:[^\s@/'"]{3,}@(?!localhost|127\.0\.0\.1|db\b|postgres\b|mysql\b|mongo\b|redis\b)/i, message: "A connection string with an embedded password is in the code." },
  { id: "public-env-secret", sev: "defect", re: /\b(EXPO_PUBLIC|NEXT_PUBLIC|VITE|REACT_APP|NUXT_PUBLIC|PUBLIC)_[A-Z0-9_]*(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|ADMIN|SERVER_KEY|SIGNING)[A-Z0-9_]*/, message: "A secret is placed in a variable that is shipped to every client (EXPO_PUBLIC_, NEXT_PUBLIC_, VITE_, REACT_APP_). Move it to a server and give the client a short-lived token." },
  { id: "public-env-key", sev: "concern", re: /\b(EXPO_PUBLIC|NEXT_PUBLIC|VITE|REACT_APP|NUXT_PUBLIC)_[A-Z0-9_]*(API_KEY|TOKEN)\b(?![A-Z0-9_]*(ANON|PUBLISHABLE|PUBLIC_KEY|MAPS|CLIENT_ID|ANALYTICS|DSN))/, message: "A key is exposed to every client through a public variable. Confirm it is meant to be public (publishable key, anon key) and restricted by app or domain." },
  // --- injection and code execution
  { id: "eval-exec", sev: "concern", files: CODE, re: /\beval\s*\(|\bnew\s+Function\s*\(|\bos\.system\s*\(|\bshell\s*=\s*True\b|\b(shell_exec|passthru|proc_open|popen)\s*\(|(?<![.\w])system\s*\(|\bRuntime\.getRuntime\(\)\.exec\s*\(|exec\.Command\(\s*["'](sh|bash|cmd)["']\s*,\s*["']-c|child_process[^\n]*\bexec(Sync)?\s*\(|\bexec(Sync)?\s*\(\s*[`'"][^`'"\n]*(\$\{|["']\s*\+)/, escalate: INPUT, message: "Code or a shell command is built and executed. Pass an argument list without a shell and never put input into it." },
  { id: "sql-concat", sev: "concern", files: CODE, re: /^(?=.*\b(SELECT\s.*\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b)(?=.*(\$\{|["']\s*\+\s*\w|\.\s*\$_|\.format\(|%s["']?\s*%\s|\{[A-Za-z_][\w.()\[\]'"]*\}|fmt\.Sprintf|String\.format|\+\s*\w+\s*\+)).*$/i, escalate: INPUT, message: "A query is built by joining strings. Use parameter placeholders or the ORM's safe API." },
  { id: "deserialize", sev: "concern", files: CODE, re: /\bpickle\.loads?\b|\bcPickle\.loads?\b|\byaml\.load\s*\((?![^)\n]*Safe)|\bObjectInputStream\b|\bunserialize\s*\(|\bBinaryFormatter\b|\bNetDataContractSerializer\b|\bMarshal\.load\b|\bjsonpickle\.decode\b|\bXMLDecoder\b|TypeNameHandling\.(All|Auto|Objects)/, escalate: INPUT, message: "Data is deserialised with a format that can run code. Use JSON with a schema for untrusted data." },
  { id: "xss-sink", sev: "concern", files: CODE, re: /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|\bv-html\b|\[innerHTML\]|document\.write\s*\(|bypassSecurityTrust(Html|Script|Url|ResourceUrl)|\bhtml_safe\b|\bmark_safe\b|\|\s*safe\b|\{\{\{|Html\.Raw\(/, ok: /\.(innerHTML|outerHTML)\s*=\s*(''|""|``)\s*;?\s*$|textContent/, message: "User-influenced HTML may be rendered unescaped. Sanitise with a maintained sanitiser or render as text." },
  { id: "path-input", sev: "concern", files: CODE, re: /\b(readFile(Sync)?|createReadStream|sendFile|writeFile(Sync)?|open|file_get_contents|File\.read|include|require|Path\.Combine|os\.Open)\s*\([^)\n]*(req\.|request\.|params|query|body|\$_(GET|POST|REQUEST)|userInput)/, message: "A file path is built from request input. Resolve against a base directory and verify the result stays inside it." },
  { id: "ssrf", sev: "concern", files: CODE, re: /\b(fetch|axios(\.(get|post|request))?|requests\.(get|post|request)|urlopen|http\.(get|Get)|HttpClient|got|needle|curl_exec|file_get_contents)\s*\(\s*[^)\n]*(req\.|request\.|params|query|body|\$_(GET|POST)|userInput)/, message: "The server fetches a URL influenced by the request. Allow-list hosts and block private and metadata addresses." },
  { id: "open-redirect", sev: "concern", files: CODE, re: /\bredirect(To)?\s*\(\s*(req|request)\.(query|params|body)|\bres\.redirect\s*\(\s*(req|request)\.|\bRedirect\(\s*Request\[|\bheader\(\s*['"]Location:\s*['"]\s*\.\s*\$_(GET|POST)/, message: "A redirect target comes from the request. Redirect only to an allow-list or relative paths." },
  // --- crypto, tokens, sessions
  { id: "weak-password-hash", sev: "defect", files: CODE, re: /\b(md5|sha1|sha256|sha512)\b[^\n]{0,60}\b(pass(word|wd)?|pwd)\b|\b(pass(word|wd)?|pwd)\b[^\n]{0,60}\b(md5|sha1)\b/i, ok: /(pbkdf2|bcrypt|argon|scrypt|hmac|createHmac|compare|verify)/i, message: "A password is hashed with a fast general-purpose hash. Use Argon2id, scrypt, bcrypt or PBKDF2 with a high iteration count." },
  { id: "weak-crypto", sev: "concern", files: CODE, re: /createHash\(\s*['"](md5|sha1)['"]\)|MessageDigest\.getInstance\(\s*"(MD5|SHA-?1)"\)|hashlib\.(md5|sha1)\(|AES\/ECB|MODE_ECB|\bcreateCipher\(|DESede|\bRC4\b|\bDES\b\/|Cipher\.getInstance\(\s*"(AES|DES)"\)/, message: "A weak or broken primitive or mode is used (MD5, SHA-1, DES, RC4, ECB). Use AES-GCM or ChaCha20-Poly1305 and SHA-256 or better." },
  { id: "insecure-random", sev: "concern", files: CODE, re: /\b(token|secret|password|passcode|nonce|otp|session|api[_-]?key|salt|csrf|reset|verification|invite)\w*\s*[:=(][^\n]*\b(Math\.random|random\.(random|randint|choice)|\brand\(|mt_rand|java\.util\.Random|new\s+Random\(|math\/rand|Random\.nextInt)/i, message: "A secret or token is generated from a non-cryptographic random source. Use the platform's secure random." },
  { id: "jwt-unsafe", sev: "defect", files: CODE, re: /alg(orithm)?s?["']?\s*[:=]\s*\[?\s*["']none["']|jwt\.decode\([^)\n]*(verify_signature["']?\s*:\s*False|verify\s*=\s*False)|ignoreExpiration\s*:\s*true|ignore_expiration\s*=\s*True|jwt\.(decode|verify)\([^)\n]*complete\s*:\s*true[^)\n]*\)\s*(?=$)/, message: "A JWT is accepted without proper verification (alg none, signature or expiry skipped). Verify signature with a pinned algorithm, issuer, audience and expiry." },
  { id: "cookie-flags", sev: "concern", re: /\b(httpOnly|secure)\s*:\s*false\b|SESSION_COOKIE_(SECURE|HTTPONLY)\s*=\s*False|cookie_(secure|httponly)\s*=\s*(false|0)|SameSite\s*=\s*None(?![^\n]*Secure)|sameSite\s*:\s*['"]none['"](?![^\n]*secure)/i, message: "A cookie is set without Secure, HttpOnly or a safe SameSite value." },
  { id: "cors-any", sev: "concern", re: /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]?\*|origin\s*:\s*['"]\*['"]|allow_origins\s*=\s*\[\s*['"]\*['"]|AllowAnyOrigin\s*\(|cors\s*\(\s*\)|CORS_ORIGIN_ALLOW_ALL\s*=\s*True|origin\s*:\s*true\b/, message: "CORS allows any origin. List the exact origins that may call this API, especially if credentials are involved." },
  { id: "csrf-off", sev: "concern", re: /csrf\(\)\.disable\(\)|csrf\.disable\b|@csrf_exempt|skip_before_action\s*:verify_authenticity_token|protect_from_forgery\s+with:\s*:null_session|csrf\s*:\s*false|\[IgnoreAntiforgeryToken\]|CSRF_COOKIE_SECURE\s*=\s*False/, message: "CSRF protection is switched off. Fine for a stateless token API; not for cookie-authenticated requests." },
  { id: "mass-assign", sev: "concern", files: CODE, re: /\bpermit!|\.(create|update|new|build|insert|updateOne|findOneAndUpdate|save)\s*\(\s*(req\.body|request\.(body|json|data)|params\b|\$_(POST|REQUEST))\s*\)|new\s+\w+\(\s*req\.body\s*\)|\.\.\.(req|request)\.body\b|Object\.assign\([^)\n]*req\.body/, message: "A whole request body is bound to a model. Allow-list the fields (a user could set role, price or owner)." },
  { id: "debug-on", sev: "concern", re: /\bDEBUG\s*=\s*True\b|app\.run\([^)\n]*debug\s*=\s*True|APP_DEBUG\s*=\s*true|\bdebug\s*:\s*true\b[^\n]*(prod|release)|display_errors\s*=\s*(On|1)\b|app\.use\(\s*errorhandler\(\)\s*\)|ALLOWED_HOSTS\s*=\s*\[\s*['"]\*['"]/i, message: "Debug mode or a wildcard host setting is on. Make it environment-controlled and off in production." },
  { id: "default-creds", sev: "concern", re: /\b(user(name)?|login|admin|root)["']?\s*[:=]\s*["'](admin|root|test|user)["']\s*[,;)]?[^\n]*\bpass(word)?["']?\s*[:=]\s*["'](admin|password|123456|root|changeme|test|1234|qwerty)["']|\bpass(word)?["']?\s*[:=]\s*["'](admin|password|123456|changeme|qwerty)["']/i, message: "Default or trivial credentials are in the code." },
  { id: "secret-in-log", sev: "concern", code: true, files: CODE, re: /\b(console\.(log|info|debug|warn|error)|logger\.\w+|log\.(info|debug|warn|error|Printf)|print(ln|f)?|Log\.[dviwe]|NSLog|os_log)\s*\([^)\n]*(password|passwd|secret|authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|card[_-]?number|cvv|ssn)/i, ok: /(redact|mask|\*\*\*|hash|length|exists|missing|invalid|expired)/i, message: "A secret, token or sensitive value may be written to logs. Log events, not credentials or personal data." },
  // --- payments and third parties
  { id: "pay-client-amount", sev: "concern", files: CODE, re: /\b(amount|price|unit_amount|total|currency|discount|quantity)\w*\s*[:=]\s*(req|request)\.(body|query|params|json|data)\b|\bunit_amount\s*:\s*(body|data|input)\./, message: "A payment amount, price or quantity comes from the client. Look it up on the server." },
  // --- Android
  { id: "android-debuggable", sev: "defect", files: /AndroidManifest\.xml$/, re: /android:debuggable\s*=\s*"true"/, message: "The Android app is debuggable. Remove it from release builds." },
  { id: "android-cleartext", sev: "defect", files: /(AndroidManifest\.xml|network_security_config\.xml|\.xml)$/, re: /android:usesCleartextTraffic\s*=\s*"true"|cleartextTrafficPermitted\s*=\s*"true"/, message: "Android allows cleartext (http) traffic. Use https only." },
  { id: "android-backup", sev: "concern", files: /AndroidManifest\.xml$/, re: /android:allowBackup\s*=\s*"true"/, message: "Android backup is allowed, so app data can be pulled with adb or cloud backup. Set false or define backup rules." },
  { id: "android-exported", sev: "concern", files: /AndroidManifest\.xml$/, re: /android:exported\s*=\s*"true"/, ok: /android:permission/, message: "An Android component is exported without a permission. Validate callers and intent data, or set exported false." },
  { id: "android-usercerts", sev: "concern", files: /\.xml$/, re: /<certificates\s+src\s*=\s*"user"/, message: "The network security config trusts user-installed certificates." },
  { id: "android-webview", sev: "concern", files: /\.(kt|java|dart)$/, re: /setJavaScriptEnabled\s*\(\s*true\s*\)|setAllowFileAccess\s*\(\s*true\s*\)|setAllowUniversalAccessFromFileURLs\s*\(\s*true|setAllowFileAccessFromFileURLs\s*\(\s*true|addJavascriptInterface\s*\(|javaScriptEnabled\s*:\s*true/, message: "A WebView has JavaScript, file access or a JavaScript bridge enabled. Load only trusted https content and keep file access off." },
  { id: "android-world", sev: "defect", files: /\.(kt|java)$/, re: /MODE_WORLD_(READABLE|WRITEABLE)/, message: "A file or preference is world-readable or writable." },
  { id: "android-trust", sev: "defect", files: /\.(kt|java)$/, re: /checkServerTrusted\s*\([^)]*\)\s*\{\s*\}|getAcceptedIssuers\s*\(\s*\)\s*\{\s*return\s+(null|new X509Certificate\[0\]|arrayOf\(\))|HostnameVerifier\s*\{\s*_?\s*,?\s*_?\s*->\s*true|\{\s*(hostname|_)\s*,\s*(session|_)\s*->\s*true\s*\}/, message: "A TrustManager or HostnameVerifier accepts every certificate." },
  { id: "android-prefs-secret", sev: "concern", files: /\.(kt|java)$/, re: /(getSharedPreferences|SharedPreferences)[^\n]*(token|password|secret|api[_-]?key)|putString\(\s*["'][^"']*(token|password|secret)[^"']*["']/i, ok: /Encrypted/, message: "A secret may be stored in plain SharedPreferences. Use EncryptedSharedPreferences or the Keystore." },
  // --- iOS
  { id: "ios-keychain", sev: "defect", files: /\.(swift|m|mm)$/, re: /kSecAttrAccessibleAlways(ThisDeviceOnly)?\b/, message: "A Keychain item is accessible even when the device is locked. Use WhenUnlockedThisDeviceOnly or stricter." },
  { id: "ios-defaults-secret", sev: "concern", files: /\.(swift|m|mm)$/, re: /UserDefaults[^\n]*\.(set|setValue)\([^\n]*(token|password|secret|api[_-]?key)|\.set\([^\n]*forKey:\s*"[^"]*(token|password|secret)[^"]*"/i, message: "A secret may be stored in UserDefaults. Use the Keychain." },
  { id: "ios-ats-key", sev: "concern", files: /\.plist$/, re: /NSAllowsArbitraryLoads(InWebContent|ForMedia)?/, message: "App Transport Security may be disabled (NSAllowsArbitraryLoads). Keep it enabled." },
  // --- containers, orchestration, IaC, CI, servers
  { id: "docker-latest", sev: "concern", files: /(Dockerfile[^/]*|\.dockerfile)$/, re: /^\s*FROM\s+[^\s]+:latest\b|^\s*FROM\s+[a-z0-9./_-]+\s*(AS\s+\w+)?\s*$/i, ok: /scratch|\bAS\s+\w+\s*$|\$\{?\w|@sha256/i, message: "A base image is not pinned. Pin a version or digest." },
  { id: "docker-root", sev: "concern", files: /(Dockerfile[^/]*|\.dockerfile)$/, re: /^\s*USER\s+(root|0)\s*$/i, message: "The container runs as root. Add a non-root USER in the final stage." },
  { id: "docker-secret", sev: "defect", files: /(Dockerfile[^/]*|\.dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/, re: /^\s*(ENV|ARG)\s+\w*(SECRET|PASSWORD|TOKEN|API_?KEY|PRIVATE_?KEY)\w*[= ]\s*["']?[^\s$"'{][^\s"']{7,}/i, message: "A secret is baked into the image through ENV or ARG. Supply it at runtime or with BuildKit secrets." },
  { id: "docker-privileged", sev: "defect", files: /(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|\.sh|\.ya?ml)$/, re: /--privileged\b|privileged\s*:\s*true|\/var\/run\/docker\.sock|--pid=host|--net(work)?=host|network_mode\s*:\s*["']?host|--cap-add=?\s*(SYS_ADMIN|ALL)/i, message: "A container is given host-level power (privileged, docker.sock, host namespaces). Grant only the specific capability needed." },
  { id: "docker-add", sev: "concern", files: /(Dockerfile[^/]*|\.dockerfile)$/, re: /^\s*ADD\s+https?:\/\//i, message: "ADD fetches a remote URL into the image unverified. Download with a checksum, or COPY a vetted file." },
  { id: "k8s-privileged", sev: "defect", files: /\.ya?ml$/, re: /^\s*(privileged|hostNetwork|hostPID|hostIPC)\s*:\s*true\b/, message: "A pod is privileged or shares host namespaces." },
  { id: "k8s-escalation", sev: "concern", files: /\.ya?ml$/, re: /^\s*allowPrivilegeEscalation\s*:\s*true\b|^\s*runAsUser\s*:\s*0\b|^\s*runAsNonRoot\s*:\s*false\b|^\s*readOnlyRootFilesystem\s*:\s*false\b/, message: "A pod allows privilege escalation or runs as root." },
  { id: "k8s-secret", sev: "concern", files: /\.ya?ml$/, re: /^\s*kind\s*:\s*Secret\b/, message: "A Kubernetes Secret manifest is in the repo. Its values are only base64: use a secret manager or sealed secrets." },
  { id: "iac-public-acl", sev: "defect", files: /\.(tf|tfvars|json|ya?ml|bicep)$/, re: /\bacl\s*=\s*"public-read(-write)?"|\bAccessControl\s*:\s*Public(Read|ReadWrite)|allUsers|allAuthenticatedUsers|allow_blob_public_access\s*=\s*true|allowBlobPublicAccess["']?\s*:\s*true|publicNetworkAccess["']?\s*:\s*["']?Enabled["']?[^\n]*(storage|sql)|block_public_(acls|policy)\s*=\s*false/i, message: "A storage resource or binding is public. Keep it private and share through signed URLs or a CDN." },
  { id: "iac-wildcard-iam", sev: "concern", files: /\.(tf|json|ya?ml)$/, re: /"Action"\s*:\s*"\*"|actions\s*=\s*\[\s*"\*"\s*\]|Action:\s*['"]?\*['"]?\s*$|"Principal"\s*:\s*"\*"|principals?\s*\{[^}\n]*identifiers\s*=\s*\[\s*"\*"/, message: "An IAM statement allows every action or every principal. Narrow it." },
  { id: "iac-open-db", sev: "concern", files: /\.(tf|ya?ml|json|bicep)$/, re: /publicly_accessible\s*=\s*true|publiclyAccessible["']?\s*:\s*true|storage_encrypted\s*=\s*false|encrypted\s*=\s*false\b/i, message: "A database or volume is public or unencrypted." },
  { id: "ci-script-injection", sev: "concern", files: /\.github\/workflows\/[^/]+\.ya?ml$/, re: /\$\{\{\s*github\.(event\.(issue|pull_request|comment|review|review_comment|head_commit|discussion)[^}]*\.(title|body|name|message|label|ref)|head_ref)\s*\}\}/, ok: /^\s*(name|if|with|env)\s*:|^\s*[A-Z_]+\s*:/, message: "Untrusted text (a PR title, branch name or comment) is expanded into a workflow step. Pass it through an env variable, never directly into run:." },
  { id: "ci-unpinned", sev: "concern", files: /\.github\/workflows\/[^/]+\.ya?ml$/, re: /^\s*-?\s*uses\s*:\s*(?!actions\/|github\/|\.\/|docker:\/\/)[\w.\-]+\/[\w.\-/]+@(?![0-9a-f]{40}\b)\S+/i, message: "A third-party action is pinned to a tag or branch. Pin it to a full commit SHA." },
  { id: "ci-write-all", sev: "concern", files: /\.github\/workflows\/[^/]+\.ya?ml$/, re: /permissions\s*:\s*write-all\b|^\s*pull_request_target\s*:?/, message: "A workflow has broad permissions or runs on pull_request_target. Never run PR code with secrets or write access." },
  { id: "server-ssh", sev: "concern", re: /^\s*PermitRootLogin\s+(yes|without-password)\b|^\s*PasswordAuthentication\s+yes\b|^\s*PermitEmptyPasswords\s+yes\b/i, message: "SSH allows root login or password logins. Use key-only authentication and no root login." },
  { id: "server-tls", sev: "concern", re: /ssl_protocols\s[^;\n]*\b(SSLv[23]|TLSv1(?:\.0|\.1)?(?![.\d]))|SSLProtocol\s[^\n]*\b(\+?SSLv\d|\+?TLSv1(\.1)?)\b|^\s*autoindex\s+on\b/i, message: "An old TLS version or directory listing is enabled on the web server." },
  { id: "shell-pipe", sev: "concern", re: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b|chmod\s+(-R\s+)?0?777\b/, message: "A script pipes a download into a shell or sets world-writable permissions. Download, verify a checksum, then run; use minimal permissions." },
  // --- databases and BaaS
  { id: "firebase-rules-open", sev: "defect", files: /(\.rules|database\.rules\.json|firestore\.rules|storage\.rules)$/, re: /allow\s+[a-z, ]+:\s*if\s+true\b|"\.(read|write)"\s*:\s*(true|"true")/, message: "Firebase rules allow anyone to read or write. Check request.auth and ownership, and deny by default." },
  { id: "firebase-rules-authed", sev: "concern", files: /(\.rules|firestore\.rules|storage\.rules)$/, re: /allow\s+[a-z, ]+:\s*if\s+request\.auth\s*!=\s*null\s*;/, message: "Firebase rules allow any signed-in user. Restrict to the owner or an explicit role." },
  { id: "supabase-rls-off", sev: "defect", files: /\.sql$/, re: /\bdisable\s+row\s+level\s+security\b|\bgrant\s+all\b[^;\n]*\bto\s+(anon|public)\b|\bgrant\s+(insert|update|delete)\b[^;\n]*\bto\s+anon\b/i, message: "Row Level Security is disabled or the anonymous role is granted write access. Enable RLS and write policies." },
  { id: "supabase-policy-true", sev: "concern", files: /\.sql$/, re: /\busing\s*\(\s*true\s*\)|\bwith\s+check\s*\(\s*true\s*\)/i, message: "An RLS policy allows everything (using true). Intentional only for public data." },
  { id: "supabase-definer", sev: "concern", files: /\.sql$/, re: /\bsecurity\s+definer\b/i, ok: /search_path/i, message: "A SECURITY DEFINER function runs with its owner's rights. Set search_path and check the caller inside." },
];

/** Per-file facts that one line cannot show. `text` is the whole file. */
function fileChecks(file: string, added: string, text: string): { id: string; sev: "defect" | "concern"; message: string }[] {
  const out: { id: string; sev: "defect" | "concern"; message: string }[] = [];
  if (/webhook/i.test(file + " " + text.slice(0, 20000)) && /(stripe|paypal|braintree|adyen|square|paddle|lemonsqueezy|mollie|razorpay|checkout\.session|payment_intent)/i.test(text) && /(app|router|route|post|handler|endpoint|def |function |export )/i.test(text) && !/(constructEvent|constructEventAsync|verifyHeader|webhooks?\.construct|verify[_-]?(webhook|signature)|hmac|timingSafeEqual|compare_digest|svix|signature|Webhook-?Signature)/i.test(text)) {
    out.push({ id: "pay-webhook-unverified", sev: "defect", message: "A payment webhook handler does not verify the provider's signature. Anyone can post a fake 'payment succeeded' event. Verify the signature on the raw body." });
  }
  // The service role is fine in server code and fatal in anything that ships to a device or browser.
  if (
    /\.(tsx?|jsx?|vue|svelte|dart|kt|swift)$/i.test(file) &&
    /service_role|SERVICE_ROLE/.test(text) &&
    /from\s+['"](react|react-native|expo[^'"]*|vue|svelte[^'"]*|@angular\/[^'"]+|next\/(link|image|navigation|router))['"]|['"]use client['"]|\bdocument\.|\bwindow\.|import\s+.*\b(UIKit|SwiftUI)\b|\bandroid\.|package:flutter/.test(text)
  ) {
    out.push({ id: "supabase-service-client", sev: "concern", message: "The Supabase service role appears in code that ships to clients (a React, Expo, browser, Flutter or native file). It bypasses all RLS: keep it in server code only." });
  }
  if (/\.sql$/i.test(file)) {
    for (const m of added.matchAll(/create\s+table\s+(if\s+not\s+exists\s+)?((?:public\.)?"?[a-z_][\w]*"?)/gi)) {
      const name = m[2].replace(/^public\./i, "").replace(/"/g, "");
      const re = new RegExp(`alter\\s+table\\s+(public\\.)?"?${name}"?\\s+enable\\s+row\\s+level\\s+security`, "i");
      if (!re.test(text) && /supabase|auth\.uid|row level|policy|anon|authenticated/i.test(text + file)) out.push({ id: "supabase-table-no-rls", sev: "concern", message: `Table ${name} is created without enabling Row Level Security in the same file. In Supabase, a table in an exposed schema with RLS off is readable by anyone with the anon key.` });
    }
  }
  if (/\.plist$/i.test(file) && /NSAllowsArbitraryLoads<\/key>\s*<true\s*\/>/.test(text.replace(/\s+/g, " ").replace(/> </g, "><"))) {
    out.push({ id: "ios-ats-off", sev: "defect", message: "App Transport Security is disabled (NSAllowsArbitraryLoads is true). Use https and keep ATS on." });
  }
  if (/\.(tf|json|ya?ml|bicep)$/i.test(file) && /(0\.0\.0\.0\/0|::\/0)/.test(added) && /\b(from_port|to_port|fromPort|toPort|port|destinationPortRange|dest_port|containerPort)\b[^\n]{0,30}\b(22|3389|3306|5432|1433|27017|6379|9200|2375)\b/.test(added)) {
    out.push({ id: "iac-open-port", sev: "defect", message: "A firewall rule opens SSH, RDP or a database port to the whole internet (0.0.0.0/0). Restrict the source." });
  }
  return out;
}

export interface SecOptions {
  /** Reads a project file (bounded); absent means whole-file checks are skipped. */
  readFile?: (rel: string) => string | undefined;
  /** Which pack ids apply, so vendor-only checks stay quiet elsewhere (all run when absent). */
  packs?: string[];
}

/** A line without the text of its string literals (an interpolated `${expression}` is kept: it is code). */
function codeOnly(line: string): string {
  return line
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => (m.match(/\$\{[^}]*\}/g) ?? []).join(" ") || '""')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
}

function addedLines(diff: string): string[] {
  return diff.split(/\r?\n/).filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
}

interface Hit {
  file: string;
  sample: string;
  defect: boolean;
}

export interface LineHit {
  id: string;
  defect: boolean;
  message: string;
}

/** Every check that fires on one line of one file. The single place the line rules are applied. */
export function lineHits(file: string, line: string): LineHit[] {
  const out: LineHit[] = [];
  if (!line.trim() || SUPPRESS.test(line)) return out;
  const isComment = DOC_COMMENT.test(line);
  for (const c of CHECKS) {
    if (c.files && !c.files.test(file)) continue;
    if (isComment && !/^secret-|private-key/.test(c.id)) continue;
    if (!c.re.test(c.code ? codeOnly(line) : line)) continue;
    if (c.ok && c.ok.test(line)) continue;
    if ((c.id.startsWith("secret-") && c.id !== "secret-in-log") || c.id === "db-url-password") {
      if (PLACEHOLDER.test(line.replace(/AKIA[0-9A-Z]{16}/, "")) && c.id !== "secret-privkey") continue;
    }
    out.push({ id: c.id, defect: c.sev === "defect" || (!!c.escalate && c.escalate.test(line)), message: c.message });
  }
  // A Supabase service-role JWT looks like any other JWT until its payload is read.
  for (const m of line.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
    try {
      const payload = JSON.parse(Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
      if (payload?.role === "service_role") out.push({ id: "secret-supabase-jwt", defect: true, message: "A Supabase service_role key is in the code. It bypasses every RLS policy: rotate it and keep it server-side only." });
    } catch {
      // not a JWT
    }
  }
  return out;
}

export interface AuditHit {
  file: string;
  line: number;
  id: string;
  severity: "defect" | "concern";
  message: string;
  /** The code on the line; empty for secrets, whose values are never recorded. */
  sample: string;
}

const isSecretId = (id: string) => (id.startsWith("secret-") && id !== "secret-in-log") || id === "db-url-password" || id === "env-committed";

/**
 * Checks a whole file, not a diff: every line with its line number, plus the whole-file checks. Secret values are
 * never copied into the result.
 */
export function auditText(file: string, text: string): AuditHit[] {
  const rel = file.replace(/\\/g, "/");
  const out: AuditHit[] = [];
  const envFile = ENV_FILE.test(rel) && !ENV_EXAMPLE.test(rel);
  if (envFile) out.push({ file: rel, line: 1, id: "env-committed", severity: "defect", message: "An environment file with real values is in the project. It holds secrets: keep it out of version control and commit a .env.example with placeholders.", sample: "" });
  if (SKIP_FILE.test(rel) && !envFile) return out;
  const lines = text.split(/\r?\n/);
  lines.forEach((l, i) => {
    for (const h of lineHits(rel, l)) out.push({ file: rel, line: i + 1, id: h.id, severity: h.defect ? "defect" : "concern", message: h.message, sample: isSecretId(h.id) ? "" : l.trim().slice(0, 120) });
  });
  for (const f of fileChecks(rel, text, text.slice(0, 200_000))) out.push({ file: rel, line: 1, id: f.id, severity: f.sev, message: f.message, sample: "" });
  return out;
}

/**
 * The text with every secret in a known format replaced by [REDACTED], for anything that leaves the machine (a
 * model, a report). Generic assignments are replaced too, since a value that looks like a credential is treated as one.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const c of CHECKS) {
    if (!(c.id.startsWith("secret-") && c.id !== "secret-in-log") && c.id !== "db-url-password") continue;
    try {
      out = out.replace(new RegExp(c.re.source, c.re.flags.includes("g") ? c.re.flags : c.re.flags + "g"), "[REDACTED]");
    } catch {
      // keep the text rather than fail
    }
  }
  return out;
}

export function securitySignals(segments: SegmentLike[], opts: SecOptions = {}): SecSignal[] {
  const hits = new Map<string, { msg: string; sev: "defect" | "concern"; hits: Hit[] }>();
  const add = (id: string, msg: string, sev: "defect" | "concern", file: string, sample: string, defect: boolean) => {
    const e = hits.get(id) ?? { msg, sev, hits: [] };
    e.hits.push({ file, sample: sample.trim().slice(0, 90), defect });
    hits.set(id, e);
  };

  for (const seg of segments) {
    const file = seg.file?.replace(/\\/g, "/");
    if (!file) continue;
    const envFile = ENV_FILE.test(file) && !ENV_EXAMPLE.test(file);
    if (envFile) {
      add("env-committed", "A real environment file is part of the change. It holds secrets: do not commit it; commit a .env.example with placeholders and add .env to .gitignore.", "defect", file, path.basename(file), true);
    }
    if (SKIP_FILE.test(file) && !envFile) continue;
    const lines = addedLines(seg.diff);
    for (const line of lines) for (const h of lineHits(file, line)) add(h.id, h.message, h.defect ? "defect" : "concern", file, h.id === "secret-supabase-jwt" ? "service_role JWT" : line, h.defect);
    if (opts.readFile) {
      let text: string | undefined;
      try {
        text = opts.readFile(file);
      } catch {
        text = undefined;
      }
      if (text) for (const f of fileChecks(file, lines.join("\n"), text.slice(0, 200_000))) add(f.id, f.message, f.sev, file, f.id, f.sev === "defect");
    }
  }

  const out: SecSignal[] = [];
  for (const [id, e] of hits) {
    const defect = e.hits.some((h) => h.defect);
    const files = [...new Set(e.hits.map((h) => h.file))].slice(0, 3).join(", ");
    const first = e.hits.find((h) => h.defect) ?? e.hits[0];
    out.push({
      severity: defect ? "defect" : "concern",
      requirement: defect ? "No exploitable security flaw introduced" : "Security",
      message: `[${id}] ${e.msg} (${e.hits.length} place(s) in ${files}${id.startsWith("secret-") || id === "env-committed" ? "" : `, for example: ${first.sample}`}).`,
    });
  }
  // defects first
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "defect" ? -1 : 1));
}

/** Reads a file under a root, bounded, for the whole-file checks. */
export function fileReader(repoRoot: string): (rel: string) => string | undefined {
  return (rel) => {
    try {
      const abs = path.resolve(repoRoot, rel);
      if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) return undefined;
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 400_000) return undefined;
      return fs.readFileSync(abs, "utf-8");
    } catch {
      return undefined;
    }
  };
}

export const SECURITY_CHECK_IDS = CHECKS.map((c) => c.id);

/** Tests, fixtures, examples, docs, lockfiles and generated files: not judged by the pattern checks. */
export const isSkippedPath = (rel: string): boolean => SKIP_FILE.test(rel.replace(/\\/g, "/"));
