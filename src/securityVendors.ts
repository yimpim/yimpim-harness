/**
 * Platform, cloud and third-party-service packs: the places where a project's security is decided by how a
 * vendor is configured rather than by the code written around it. Wording follows each vendor's own security
 * guidance and the OWASP / CIS / MASVS material behind it; every pack lists configuration to harden.
 */
import type { Pack, SecRule, Sev } from "./securityRules.js";

const r = (id: string, sev: Sev, doText: string, notText: string, ref: string, core = false): SecRule => ({ id, sev, do: doText, not: notText, ref, core });

export const PLATFORM_PACKS: Pack[] = [
  {
    id: "supabase", name: "Supabase", hardening: ["Row Level Security enabled on every table in an exposed schema (public), with policies; run the security advisor.", "Storage buckets private by default with policies; signed URLs for private files.", "Edge Functions verify the JWT (or the webhook signature) and use the caller's token, not the service role, unless a server job.", "Restrict Auth: email confirmation on, redirect URLs allow-listed, strong password policy, MFA offered; disable signups you do not use.", "Never expose the service_role key or the database password to any client."],
    rules: [
      r("sb-rls", "critical", "Enable RLS on every table in an exposed schema and write policies using auth.uid() (and tenant ids); test them as anon and as another user.", "A table with RLS disabled or a policy of using (true) on anything but intentionally public data.", "Supabase RLS, CWE-862", true),
      r("sb-service-key", "critical", "Use the service_role key only in trusted server code; the client uses the anon key under RLS.", "service_role in a mobile app, browser bundle, public repo or any EXPO_PUBLIC_/NEXT_PUBLIC_ variable.", "CWE-798", true),
      r("sb-definer", "high", "Mark functions SECURITY INVOKER by default; for SECURITY DEFINER set search_path and check the caller inside.", "SECURITY DEFINER functions callable by anon that skip checks; views that bypass RLS (use security_invoker).", "CWE-250"),
      r("sb-storage", "high", "Storage policies per bucket and path; private buckets with signed URLs.", "Public buckets for user files.", "CWE-284"),
      r("sb-auth", "high", "Authorise from auth.uid() and a server-controlled claim; keep roles in app_metadata (not user_metadata, which users can edit).", "Trusting user_metadata for roles or plans.", "CWE-269"),
      r("sb-edge", "high", "Verify the JWT or signature in Edge Functions; validate input; restrict CORS.", "Open functions that use the service role for any caller.", "CWE-306"),
    ],
  },
  {
    id: "firebase", name: "Firebase", hardening: ["Firestore and Storage rules deny by default; test rules with the emulator.", "Enable App Check for Firestore, Storage, Functions and Auth.", "Admin SDK and service-account JSON only on trusted servers; use workload identity where possible.", "Restrict API keys by app and API; they identify the project, they are not secrets, but they must be restricted.", "Authentication: email enumeration protection, authorised domains, blocking functions where needed."],
    rules: [
      r("fb-rules", "critical", "Write Firestore, Realtime Database and Storage rules that check request.auth and ownership per document; deny by default.", "allow read, write: if true; or if request.auth != null for sensitive data (any signed-in user).", "CWE-862", true),
      r("fb-admin", "critical", "firebase-admin and service-account keys only in server code.", "Admin credentials in an app, repo or client bundle.", "CWE-798", true),
      r("fb-functions", "high", "Callable and HTTP functions check context.auth / the ID token and App Check, and validate input.", "Unauthenticated functions that write data or send messages.", "CWE-306"),
      r("fb-claims", "high", "Set custom claims for roles on the server; check them in rules.", "Roles stored in a user-writable document.", "CWE-269"),
      r("fb-storage", "high", "Storage rules limit size, content type and owner path.", "Public write; unrestricted uploads.", "CWE-434"),
    ],
  },
  {
    id: "aws", name: "AWS", hardening: ["Root account: MFA, no access keys; use IAM Identity Center or roles.", "S3 Block Public Access on; default encryption; HTTPS-only bucket policies.", "Security groups: nothing open to 0.0.0.0/0 on 22, 3389 or databases.", "IMDSv2 required; CloudTrail, GuardDuty and Config on; KMS for sensitive data."],
    rules: [
      r("aws-iam", "critical", "Least-privilege IAM: specific actions and resources, roles instead of long-lived keys, conditions where possible.", "Action:* with Resource:*, wildcard principals, access keys in code.", "CWE-250", true),
      r("aws-s3", "critical", "Block public access; grant through CloudFront or signed URLs.", "Public-read buckets or ACLs for user data.", "CWE-284", true),
      r("aws-sg", "high", "Open only needed ports to needed sources; databases private.", "0.0.0.0/0 on 22, 3389, 3306, 5432 or 27017.", "CWE-284"),
      r("aws-secrets", "high", "Secrets Manager or SSM Parameter Store; Lambda environment variables hold references, not secrets.", "Secrets in Lambda env vars, user data scripts or AMIs.", "CWE-798"),
      r("aws-metadata", "high", "Require IMDSv2 and a hop limit of 1.", "IMDSv1 reachable by apps that fetch URLs.", "CWE-918"),
    ],
  },
  {
    id: "azure", name: "Azure", hardening: ["Managed identities instead of keys; Key Vault for secrets; RBAC least privilege.", "Storage accounts: no anonymous blob access, HTTPS only, TLS 1.2 minimum, SAS tokens short and scoped.", "NSG: no inbound 22/3389 from the internet; use Bastion; SQL and Cosmos behind private endpoints or firewall rules.", "App Service/Functions: HTTPS only, FTPS disabled, minimum TLS 1.2, authentication on, no secrets in app settings plain text (use Key Vault references)."],
    rules: [
      r("az-identity", "high", "Managed identity and RBAC for service access; Key Vault for secrets.", "Connection strings and account keys in code or config; broad Owner/Contributor roles.", "CWE-798/250", true),
      r("az-storage", "critical", "Disable anonymous access; scoped, expiring SAS tokens; private endpoints for sensitive accounts.", "Public containers, account-key SAS with long expiry.", "CWE-284", true),
      r("az-functions", "high", "Use function auth levels deliberately and App Service Authentication; validate input.", "AuthorizationLevel.Anonymous on functions that act on data.", "CWE-306"),
      r("az-network", "high", "Restrict NSGs and firewalls; use private networking for data stores.", "SQL or storage open to all Azure services or the internet.", "CWE-284"),
    ],
  },
  {
    id: "gcp", name: "Google Cloud", hardening: ["Service accounts: one per workload, least privilege, workload identity instead of downloaded JSON keys.", "Buckets: uniform access, public access prevention on; no allUsers / allAuthenticatedUsers bindings.", "Cloud Run/Functions: require authentication unless intentionally public; set ingress; use Secret Manager.", "VPC firewall rules narrow; private Google access; audit logs on; org policies for key creation."],
    rules: [
      r("gcp-iam", "critical", "Grant narrow predefined or custom roles to dedicated service accounts; use workload identity.", "roles/owner or editor for workloads; downloaded service-account keys in code.", "CWE-250/798", true),
      r("gcp-public", "critical", "Keep buckets and services private; use signed URLs or IAP.", "allUsers or allAuthenticatedUsers bindings; Cloud Run --allow-unauthenticated by habit.", "CWE-284", true),
      r("gcp-secrets", "high", "Secret Manager with access per secret.", "Secrets in env vars in plain deployment files.", "CWE-798"),
    ],
  },
  {
    id: "containers", name: "Containers and Docker", hardening: ["Run as a non-root user with a read-only root filesystem where possible; drop capabilities.", "Pin base images by version or digest; use minimal images; rebuild and scan regularly.", "Keep secrets out of layers and build args (use build secrets); .dockerignore excludes .env, keys and .git.", "Never mount the Docker socket or run privileged."],
    rules: [
      r("dk-root", "high", "USER a non-root account in the final stage; multi-stage builds.", "Running as root; shipping build tools and secrets in the final image.", "CWE-250", true),
      r("dk-secrets", "critical", "Pass secrets at runtime or with BuildKit secrets.", "ENV, ARG or COPY of keys, tokens or .env files.", "CWE-798", true),
      r("dk-pin", "medium", "Pin images (digest or exact version); prefer COPY to ADD.", ":latest tags; ADD from URLs.", "CWE-1357"),
      r("dk-privileged", "critical", "Grant only needed capabilities; no host namespaces.", "--privileged, mounting /var/run/docker.sock, --pid=host, --net=host without need.", "CWE-250", true),
    ],
  },
  {
    id: "kubernetes", name: "Kubernetes", hardening: ["Pod Security Admission 'restricted'; seccomp RuntimeDefault; runAsNonRoot; readOnlyRootFilesystem; drop ALL capabilities; allowPrivilegeEscalation false.", "Default-deny NetworkPolicies; least-privilege RBAC; automountServiceAccountToken false unless needed.", "Secrets from an external manager or sealed secrets, not plain manifests in git; resource limits set; images pinned by digest."],
    rules: [
      r("k8s-pod", "high", "Set securityContext: runAsNonRoot, allowPrivilegeEscalation false, readOnlyRootFilesystem, drop ALL, seccomp RuntimeDefault.", "privileged: true, hostPath, hostNetwork, hostPID, running as root.", "CWE-250", true),
      r("k8s-rbac", "high", "Narrow Roles and bindings per namespace.", "cluster-admin for workloads; wildcard verbs or resources.", "CWE-269"),
      r("k8s-secrets", "critical", "Reference secrets from a secret store; never commit base64 Secret manifests.", "Secret values in git or ConfigMaps.", "CWE-798", true),
      r("k8s-network", "medium", "Default-deny NetworkPolicy and explicit allows.", "Flat networks where any pod reaches any other.", "CWE-284"),
    ],
  },
  {
    id: "iac", name: "Infrastructure as code (Terraform, Bicep, CloudFormation, Pulumi)", hardening: ["Encrypt state and restrict access to it; no secrets in variables files or state outputs in logs.", "Run a policy check (tfsec, Checkov, or cloud policy) in CI; peer-review plans."],
    rules: [
      r("iac-open", "critical", "Expose only the ports and principals needed.", "0.0.0.0/0 ingress on admin or database ports; public storage; wildcard IAM.", "CWE-284", true),
      r("iac-encrypt", "high", "Enable encryption at rest and in transit for stores and queues.", "Unencrypted volumes, buckets, databases.", "CWE-311"),
      r("iac-secrets", "critical", "Reference secrets from a manager at deploy time.", "Passwords or keys as literals in .tf, .tfvars, parameters or templates.", "CWE-798", true),
    ],
  },
  {
    id: "ci", name: "CI/CD (GitHub Actions and similar)", hardening: ["Pin third-party actions to a full commit SHA; set explicit minimal `permissions:` per workflow.", "Use short-lived OIDC credentials to deploy, not stored cloud keys; scope secrets to environments.", "Do not run untrusted pull-request code with secrets (avoid pull_request_target with a head checkout); protect branches; separate release jobs."],
    rules: [
      r("ci-pin", "high", "Pin actions by commit SHA; set permissions: contents: read by default.", "uses: some/action@main or @v1 for third-party actions with write permissions.", "CWE-829", true),
      r("ci-prt", "critical", "Treat pull request content as untrusted; never combine pull_request_target with checking out the PR head and running it.", "Using ${{ github.event.* }} text in run: steps (script injection); secrets exposed to fork builds.", "CWE-94/829", true),
      r("ci-secrets", "high", "Pass secrets only to the steps that need them; mask outputs.", "echo of secrets; secrets in workflow files.", "CWE-532/798"),
    ],
  },
  {
    id: "server", name: "Servers and virtual machines", hardening: ["SSH: key authentication only, PermitRootLogin no, PasswordAuthentication no, AllowUsers; restrict the port with a firewall.", "Firewall default deny with only needed ports; automatic security updates; time sync; fail2ban or equivalent.", "Services run as unprivileged users (systemd hardening options); logs shipped off the host; backups tested and encrypted.", "TLS 1.2+ only on nginx/Apache; server tokens off; autoindex off; security headers set."],
    rules: [
      r("vm-ssh", "high", "Key-only SSH, no root login, firewall the port, patch regularly.", "Password SSH logins, root login, default users, exposed management ports.", "CIS, CWE-287", true),
      r("vm-user", "high", "Run services as dedicated unprivileged users with least file permissions.", "Services as root; world-writable files; secrets in world-readable files.", "CWE-250/732"),
      r("vm-tls", "high", "Terminate TLS with modern settings and a renewing certificate.", "SSLv3/TLS 1.0/1.1; expired or self-signed in production.", "CWE-326"),
    ],
  },
  {
    id: "android", name: "Android", hardening: ["Release builds: debuggable false, allowBackup false (or backup rules), minify/R8 on, network security config forbidding cleartext.", "Exported components only when needed, each protected with a permission or validating the caller and intent data.", "Store secrets with the Keystore / EncryptedSharedPreferences; never ship API secrets in the APK.", "Verify app links (autoVerify); use FLAG_SECURE on sensitive screens; WebView hardened."],
    rules: [
      r("and-manifest", "high", "android:debuggable false, allowBackup false, usesCleartextTraffic false, exported only when intended.", "android:debuggable=true, usesCleartextTraffic=true, exported components with no permission.", "MASVS-PLATFORM/NETWORK", true),
      r("and-storage", "high", "Keystore-backed keys, EncryptedSharedPreferences, app-private storage.", "Tokens or PII in plain SharedPreferences, external storage or logs.", "MASVS-STORAGE", true),
      r("and-webview", "high", "Load only trusted https content; disable file access; no JavaScript unless needed; avoid addJavascriptInterface or restrict it.", "setJavaScriptEnabled(true) with untrusted URLs, setAllowFileAccess(true), loading user URLs.", "MASVS-PLATFORM", true),
      r("and-intent", "high", "Validate data from intents and deep links; use explicit intents and PendingIntent.FLAG_IMMUTABLE.", "Trusting extras; implicit intents carrying sensitive data.", "CWE-927"),
      r("and-tls", "high", "Use the platform TLS stack with default verification; pin only with a rotation plan.", "A TrustManager or HostnameVerifier that accepts everything.", "CWE-295", true),
      r("and-secrets", "high", "Keep real secrets on a server; the app gets short-lived tokens.", "API secrets or service keys in BuildConfig, strings.xml or assets.", "CWE-798"),
    ],
  },
  {
    id: "ios", name: "iOS and macOS", hardening: ["App Transport Security on (no NSAllowsArbitraryLoads); universal links over custom URL schemes.", "Keychain with kSecAttrAccessibleWhenUnlockedThisDeviceOnly (or stricter) for tokens; data protection classes on files.", "No secrets in Info.plist or the bundle; hide sensitive screens in the app switcher; avoid logging sensitive data."],
    rules: [
      r("ios-ats", "high", "Keep ATS on; use TLS for all connections.", "NSAllowsArbitraryLoads true.", "MASVS-NETWORK", true),
      r("ios-keychain", "high", "Store tokens and keys in the Keychain with a restrictive accessibility class.", "UserDefaults, plain files or plist for secrets.", "MASVS-STORAGE", true),
      r("ios-links", "medium", "Validate every deep link and universal link parameter; confirm the destination.", "Acting on a custom-scheme URL without validation.", "CWE-939"),
      r("ios-secrets", "high", "Keep secrets on a server.", "API secrets in the app bundle.", "CWE-798"),
    ],
  },
  {
    id: "payments", name: "Payments (Stripe, PayPal, Adyen, Square, Braintree and similar)", hardening: ["Secret and restricted keys only on the server; use restricted keys with the fewest permissions.", "Webhooks: verify the signature on the raw body, check the event is new (idempotency), respond quickly, and re-fetch the object from the API before acting.", "Use hosted fields or Checkout so card data never touches your servers (stay in the lowest PCI scope)."],
    rules: [
      r("pay-amount", "critical", "Create the charge or session on the server with the price looked up server-side.", "Trusting an amount, currency, price id, quantity or discount sent from the client.", "CWE-472, A04", true),
      r("pay-webhook", "critical", "Verify the provider's webhook signature using the raw request body and a timestamp tolerance; ignore duplicates by event id.", "Webhook endpoints that accept any POST; granting access on the redirect page instead of the verified event.", "CWE-345", true),
      r("pay-keys", "critical", "Secret keys server-side only.", "sk_live / secret keys in client code or the repo.", "CWE-798", true),
      r("pay-pci", "high", "Use the provider's hosted fields; never log or store card numbers, CVV or full tracks.", "Handling raw card data in your own forms or database.", "PCI DSS"),
      r("pay-idem", "high", "Idempotency keys on create calls; make fulfilment idempotent.", "Double fulfilment on retries or duplicate webhooks.", "CWE-841"),
      r("pay-refund", "high", "Authorise refunds, payouts and subscription changes by role and ownership.", "Refund endpoints callable by any signed-in user.", "CWE-862"),
    ],
  },
  {
    id: "auth", name: "Authentication services (Auth0, Clerk, Cognito, NextAuth, Firebase Auth, Okta, Keycloak and similar)", hardening: ["Redirect URIs and logout URLs exact allow-lists; PKCE for public clients; no implicit flow.", "Enforce MFA for admins; short access-token lifetime, rotating refresh tokens with reuse detection.", "Verify tokens on the server against the provider's keys (JWKS) with issuer, audience and expiry checks."],
    rules: [
      r("auth-verify", "critical", "Verify the provider's token on the server with the SDK or JWKS: signature, issuer, audience, expiry, and a token type.", "Reading user id or role from a token without verifying it, or trusting a client-supplied user id.", "CWE-347, A07", true),
      r("auth-redirect", "high", "Exact-match redirect URIs; state and PKCE on OAuth flows.", "Wildcard redirect URIs; skipping state; implicit flow.", "CWE-601, RFC 9700", true),
      r("auth-roles", "high", "Take roles and tenant from server-controlled claims; check them on every request.", "Roles the user can edit (profile metadata); trusting UI state.", "CWE-269"),
      r("auth-own", "high", "Prefer the provider's flows; if you add your own, use the checklist: rate limit, lockout, MFA, safe reset.", "Home-made password, reset or session logic next to a provider.", "A07"),
      r("auth-reset", "high", "Reset and magic links: single-use, short-lived, bound to the account, no account enumeration in the response.", "Predictable or reusable reset tokens; different messages for unknown email.", "CWE-640"),
    ],
  },
  {
    id: "email", name: "Email, SMS and marketing platforms (SendGrid, Mailchimp, Postmark, Mailgun, SES, Resend, Twilio, Klaviyo, Braze, Customer.io and similar)", hardening: ["API keys server-side only, scoped to sending, rotated; separate keys per environment.", "DNS: SPF, DKIM and DMARC (p=quarantine or reject) on the sending domain; dedicated subdomain for marketing.", "Rate-limit and CAPTCHA anything that triggers a send; verify addresses before sending; honour unsubscribes and consent (CAN-SPAM, GDPR)."],
    rules: [
      r("mail-keys", "critical", "Send from the server with a scoped key.", "Email or SMS provider keys in client code, in the repo or in client-readable variables.", "CWE-798", true),
      r("mail-abuse", "high", "Require authentication, a rate limit and a CAPTCHA on contact, invite, share and password-reset forms; cap recipients.", "Endpoints that let anyone send mail to any address with your domain (spam relay, enumeration).", "CWE-770, A04", true),
      r("mail-header", "high", "Reject CR and LF in addresses, subjects and header values; use the provider's template variables.", "Building headers or HTML bodies by concatenating user input.", "CWE-93/79"),
      r("mail-consent", "medium", "Store consent and honour unsubscribe immediately; keep suppression lists.", "Emailing people who opted out; purchased lists.", "GDPR/CAN-SPAM"),
      r("mail-links", "high", "Sign and expire links in emails; do not put tokens or personal data in tracked URLs.", "Predictable unsubscribe or login links; PII in query strings.", "CWE-598"),
    ],
  },
  {
    id: "database", name: "Databases", hardening: ["Not reachable from the internet; TLS in transit; encryption at rest; separate users per application with least privilege.", "Backups encrypted and restore-tested; audit logging for sensitive tables; no default accounts."],
    rules: [
      r("db-priv", "high", "Application users get only the grants they need; migrations use a separate privileged user.", "The app connecting as a superuser or owner.", "CWE-250", true),
      r("db-queries", "critical", "Parameterised queries everywhere, including ORMs' raw escape hatches.", "Concatenating identifiers or values; dynamic ORDER BY from input without an allow-list.", "CWE-89", true),
      r("db-expose", "critical", "Keep databases on private networks.", "Database ports open to the internet.", "CWE-284"),
      r("db-secrets", "high", "Encrypt sensitive columns and keep keys elsewhere.", "Plain-text secrets or national ids in tables.", "CWE-311"),
    ],
  },
  {
    id: "llm", name: "AI and LLM features", hardening: ["Treat model output as untrusted input; schema-validate it; never pass it to eval, a shell, SQL or innerHTML.", "Give agents and tools least privilege; require human approval for irreversible or costly actions; log tool calls.", "Cap tokens, tool calls and spend per user; protect keys and system prompts; filter what RAG retrieves by the caller's permissions."],
    rules: [
      r("llm-output", "critical", "Validate model output against a schema; render it as text; treat it as untrusted.", "Executing, querying or rendering raw model output.", "OWASP LLM05", true),
      r("llm-injection", "high", "Keep untrusted content (web pages, emails, files, retrieved documents) separate from instructions, and assume it can try to hijack the model.", "Giving untrusted text the same authority as the system prompt; tools that act on text from third parties without confirmation.", "OWASP LLM01", true),
      r("llm-agency", "high", "Scope tools narrowly, authorise each action as the end user, require confirmation for writes, payments and sends.", "Agents with admin keys or broad tools; no per-user authorisation.", "OWASP LLM06", true),
      r("llm-rag", "high", "Filter retrieval by the caller's permissions and tenant.", "One shared index returned to every user.", "OWASP LLM02/08"),
      r("llm-cost", "medium", "Rate-limit and cap usage per user.", "Unmetered endpoints that call paid models.", "OWASP LLM10"),
      r("llm-keys", "critical", "Call model APIs from a server.", "Model provider keys in client code.", "CWE-798", true),
    ],
  },
];
