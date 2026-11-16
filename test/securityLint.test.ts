import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SECURITY_CHECK_IDS, securitySignals } from "../src/securityLint.js";

const seg = (file: string, lines: string[]) => ({ file, diff: `diff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n${lines.map((l) => "+" + l).join("\n")}` });
const run = (file: string, lines: string[], opts: any = {}) => securitySignals([seg(file, lines)], opts);
const ids = (s: { message: string }[]) => s.map((x) => /^\[([a-z0-9-]+)\]/.exec(x.message)?.[1]);
const has = (file: string, line: string, id: string) => ids(run(file, [line])).includes(id);
const sev = (file: string, line: string, id: string) => run(file, [line]).find((x) => x.message.startsWith(`[${id}]`))?.severity;

// [check id, file, a line that must trigger it, severity expected]
const POSITIVE: [string, string, string, "defect" | "concern"][] = [
  ["tls-off", "src/a.ts", "const agent = new https.Agent({ rejectUnauthorized: false });", "defect"],
  ["tls-off", "app.py", "requests.get(url, verify=False)", "defect"],
  ["tls-off", "main.go", "tls.Config{InsecureSkipVerify: true}", "defect"],
  ["tls-off", "deploy.sh", "curl -k https://internal.example.org/x", "defect"],
  ["cleartext-url", "src/api.ts", 'const BASE = "http://api.shopfront.io/v1";', "concern"],
  ["secret-aws", "src/c.ts", 'const k = "AKIAIOSFODNN7EXAMPLQ";', "defect"],
  ["secret-github", "src/c.ts", 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";', "defect"],
  ["secret-stripe", "src/c.ts", 'const s = "sk_' + 'live_51HxyzABCDEFGHIJKLMNOP1234";', "defect"],
  ["secret-slack", "src/c.ts", 'const s = "xoxb-123456789012-abcdefghijkl";', "defect"],
  ["secret-sendgrid", "src/c.ts", 'const s = "SG.abcdefghijklmnop1234.qrstuvwxyzABCDEFGH5678";', "defect"],
  ["secret-mailgun", "src/c.ts", 'const s = "' + "ke" + "y-" + "0123456789abcdef0123456789abcdef" + '";', "defect"],
  ["secret-twilio", "src/c.ts", 'const authToken = "' + "S" + "K" + "0123456789abcdef0123456789abcdef" + '";', "defect"],
  ["secret-openai", "src/c.ts", 'const s = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD";', "defect"],
  ["secret-openai", "src/c.ts", 'const s = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";', "defect"],
  ["secret-privkey", "src/k.ts", "-----BEGIN RSA PRIVATE KEY-----", "defect"],
  ["secret-gcp-sa", "sa.js", '"private_key_id": "0123456789abcdef0123456789abcdef01234567",', "defect"],
  ["secret-azure", "src/c.cs", 'var cs = "DefaultEndpointsProtocol=https;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCD+/==";', "defect"],
  ["secret-supabase", "src/c.ts", 'const k = "sb_secret_abcdefghijklmnopqrstuvwx";', "defect"],
  ["secret-generic", "src/c.ts", 'const password = "Tr0ub4dor&3xAmple9";', "concern"],
  ["db-url-password", "src/db.ts", 'const url = "postgres://app:hunter2pw@prod-db.internal.corp:5432/app";', "concern"],
  ["public-env-secret", "app/config.ts", "const k = process.env.EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;", "defect"],
  ["public-env-secret", ".env.production", "NEXT_PUBLIC_STRIPE_SECRET=abc", "defect"],
  ["public-env-key", "app/config.ts", "const k = process.env.NEXT_PUBLIC_SENDGRID_API_KEY;", "concern"],
  ["eval-exec", "src/a.js", "const r = eval(code);", "concern"],
  ["eval-exec", "src/a.js", "const r = eval(req.body.code);", "defect"],
  ["eval-exec", "a.py", "subprocess.run(cmd, shell=True)", "concern"],
  ["eval-exec", "a.py", "os.system('ls ' + request.args['d'])", "defect"],
  ["eval-exec", "a.php", "shell_exec($_GET['cmd']);", "defect"],
  ["eval-exec", "main.go", 'exec.Command("sh", "-c", input)', "concern"],
  ["eval-exec", "a.js", "child_process.exec(`ls ${dir}`)", "concern"],
  ["sql-concat", "a.js", 'db.query("SELECT * FROM users WHERE id = " + req.params.id);', "defect"],
  ["sql-concat", "a.py", 'cursor.execute(f"SELECT * FROM t WHERE id = {user_id}")', "concern"],
  ["sql-concat", "a.go", 'db.Query(fmt.Sprintf("SELECT * FROM t WHERE id = %s", id))', "concern"],
  ["sql-concat", "A.java", 'stmt.executeQuery("SELECT * FROM t WHERE name = \'" + name + "\'");', "concern"],
  ["deserialize", "a.py", "obj = pickle.loads(data)", "concern"],
  ["deserialize", "a.py", "cfg = yaml.load(open(f))", "concern"],
  ["deserialize", "a.php", "$o = unserialize($_POST['x']);", "defect"],
  ["deserialize", "A.java", "ObjectInputStream in = new ObjectInputStream(s);", "concern"],
  ["xss-sink", "a.tsx", "<div dangerouslySetInnerHTML={{ __html: html }} />", "concern"],
  ["xss-sink", "a.vue", '<div v-html="body"></div>', "concern"],
  ["xss-sink", "a.js", "el.innerHTML = msg;", "concern"],
  ["path-input", "a.js", "fs.readFile(path.join(base, req.query.name), cb);", "concern"],
  ["ssrf", "a.js", "const r = await fetch(req.query.url);", "concern"],
  ["open-redirect", "a.js", "res.redirect(req.query.next);", "concern"],
  ["weak-password-hash", "a.js", "const h = crypto.createHash('md5').update(password).digest('hex');", "defect"],
  ["weak-crypto", "a.js", "crypto.createHash('sha1').update(data)", "concern"],
  ["weak-crypto", "A.java", 'Cipher.getInstance("AES/ECB/PKCS5Padding");', "concern"],
  ["insecure-random", "a.js", "const resetToken = Math.random().toString(36);", "concern"],
  ["insecure-random", "a.py", "session_id = random.randint(0, 99999999)", "concern"],
  ["jwt-unsafe", "a.js", "jwt.verify(t, key, { ignoreExpiration: true });", "defect"],
  ["jwt-unsafe", "a.py", "jwt.decode(t, options={'verify_signature': False})", "defect"],
  ["jwt-unsafe", "a.js", "const opts = { algorithms: ['none'] };", "defect"],
  ["cookie-flags", "a.js", "res.cookie('sid', v, { httpOnly: false });", "concern"],
  ["cors-any", "a.js", "app.use(cors({ origin: '*' }));", "concern"],
  ["cors-any", "a.py", "allow_origins=['*']", "concern"],
  ["csrf-off", "S.java", "http.csrf().disable();", "concern"],
  ["csrf-off", "v.py", "@csrf_exempt", "concern"],
  ["mass-assign", "a.js", "const u = await User.create(req.body);", "concern"],
  ["mass-assign", "a.rb", "params.permit!", "concern"],
  ["debug-on", "settings.py", "DEBUG = True", "concern"],
  ["debug-on", "settings.py", "ALLOWED_HOSTS = ['*']", "concern"],
  ["default-creds", "a.js", 'const password = "admin";', "concern"],
  ["secret-in-log", "a.js", "console.log('login', email, password);", "concern"],
  ["pay-client-amount", "pay.js", "const amount = req.body.amount;", "concern"],
  ["android-debuggable", "app/src/main/AndroidManifest.xml", '<application android:debuggable="true">', "defect"],
  ["android-cleartext", "app/src/main/AndroidManifest.xml", '<application android:usesCleartextTraffic="true">', "defect"],
  ["android-backup", "app/src/main/AndroidManifest.xml", '<application android:allowBackup="true">', "concern"],
  ["android-exported", "app/src/main/AndroidManifest.xml", '<activity android:name=".Main" android:exported="true">', "concern"],
  ["android-usercerts", "res/xml/network_security_config.xml", '<certificates src="user" />', "concern"],
  ["android-webview", "Web.kt", "settings.javaScriptEnabled = true; webView.settings.setJavaScriptEnabled(true)", "concern"],
  ["android-world", "F.java", "openFileOutput(n, MODE_WORLD_READABLE);", "defect"],
  ["android-trust", "T.java", "public void checkServerTrusted(X509Certificate[] c, String a) { }", "defect"],
  ["android-prefs-secret", "P.kt", 'prefs.edit().putString("auth_token", t).apply()', "concern"],
  ["ios-keychain", "K.swift", "kSecAttrAccessible: kSecAttrAccessibleAlways", "defect"],
  ["ios-defaults-secret", "U.swift", 'UserDefaults.standard.set(token, forKey: "authToken")', "concern"],
  ["ios-ats-key", "Info.plist", "<key>NSAllowsArbitraryLoads</key>", "concern"],
  ["docker-latest", "Dockerfile", "FROM node:latest", "concern"],
  ["docker-latest", "Dockerfile", "FROM node", "concern"],
  ["docker-root", "Dockerfile", "USER root", "concern"],
  ["docker-secret", "Dockerfile", "ENV API_KEY=abcdefghijklmnop1234", "defect"],
  ["docker-privileged", "docker-compose.yml", "    privileged: true", "defect"],
  ["docker-privileged", "run.sh", "docker run -v /var/run/docker.sock:/var/run/docker.sock x", "defect"],
  ["docker-add", "Dockerfile", "ADD https://example.org/x.tgz /opt/", "concern"],
  ["k8s-privileged", "k8s/pod.yaml", "      privileged: true", "defect"],
  ["k8s-escalation", "k8s/pod.yaml", "      allowPrivilegeEscalation: true", "concern"],
  ["k8s-secret", "k8s/s.yaml", "kind: Secret", "concern"],
  ["iac-public-acl", "main.tf", '  acl = "public-read"', "defect"],
  ["iac-public-acl", "b.tf", '  member = "allUsers"', "defect"],
  ["iac-wildcard-iam", "iam.tf", '    "Action": "*",', "concern"],
  ["iac-open-db", "db.tf", "  publicly_accessible = true", "concern"],
  ["ci-script-injection", ".github/workflows/a.yml", "        run: echo ${{ github.event.pull_request.title }}", "concern"],
  ["ci-unpinned", ".github/workflows/a.yml", "      - uses: someone/deploy-action@v2", "concern"],
  ["ci-write-all", ".github/workflows/a.yml", "permissions: write-all", "concern"],
  ["server-ssh", "sshd_config", "PermitRootLogin yes", "concern"],
  ["server-tls", "nginx.conf", "ssl_protocols TLSv1 TLSv1.1;", "concern"],
  ["shell-pipe", "install.sh", "curl -fsSL https://get.example.sh | sudo bash", "concern"],
  ["firebase-rules-open", "firestore.rules", "      allow read, write: if true;", "defect"],
  ["firebase-rules-open", "database.rules.json", '    ".read": true,', "defect"],
  ["firebase-rules-authed", "firestore.rules", "      allow read: if request.auth != null;", "concern"],
  ["supabase-rls-off", "supabase/migrations/1.sql", "alter table notes disable row level security;", "defect"],
  ["supabase-rls-off", "supabase/migrations/1.sql", "grant all on public.notes to anon;", "defect"],
  ["supabase-policy-true", "supabase/migrations/1.sql", "create policy p on notes for select using (true);", "concern"],
  ["supabase-definer", "supabase/migrations/1.sql", "create function f() returns int security definer as $$ select 1 $$ language sql;", "concern"],
];

// lines that look close but are fine
const NEGATIVE: [string, string, string][] = [
  ["tls-off", "a.ts", "const agent = new https.Agent({ rejectUnauthorized: true });"],
  ["cleartext-url", "a.ts", 'const BASE = "http://localhost:3000/api";'],
  ["cleartext-url", "a.ts", 'const ns = "http://www.w3.org/2000/svg";'],
  ["secret-generic", "a.ts", 'const password = process.env.DB_PASSWORD ?? "";'],
  ["secret-generic", "a.ts", 'const password = "your-password-here";'],
  ["secret-aws", "a.ts", 'const k = "AKIAIOSFODNN7EXAMPLE"; // example'],
  ["public-env-secret", "a.ts", "const k = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;"],
  ["public-env-key", "a.ts", "const k = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;"],
  ["eval-exec", "a.ts", "const evaluated = evaluate(code);"],
  ["eval-exec", "a.py", "subprocess.run(['ls', d], shell=False)"],
  ["sql-concat", "a.js", 'db.query("SELECT * FROM users WHERE id = $1", [id]);'],
  ["sql-concat", "a.js", 'const label = "Select your plan and continue";'],
  ["deserialize", "a.py", "cfg = yaml.load(f, Loader=yaml.SafeLoader)"],
  ["deserialize", "a.py", "cfg = yaml.safe_load(f)"],
  ["xss-sink", "a.tsx", "<p>{text}</p>"],
  ["xss-sink", "a.js", "el.innerHTML = '';"],
  ["secret-in-log", "a.ts", "console.log(`Wrote a starter .gitignore (secrets, keys, build output)`);"],
  ["weak-password-hash", "a.js", "const h = await bcrypt.hash(password, 12);"],
  ["weak-crypto", "a.js", "crypto.createHash('sha256').update(data)"],
  ["insecure-random", "a.js", "const jitter = Math.random() * 100;"],
  ["jwt-unsafe", "a.js", "jwt.verify(t, key, { algorithms: ['RS256'] });"],
  ["cookie-flags", "a.js", "res.cookie('sid', v, { httpOnly: true, secure: true });"],
  ["cors-any", "a.js", "app.use(cors({ origin: ['https://app.example.com'] }));"],
  ["mass-assign", "a.js", "const u = await User.create({ name: body.name });"],
  ["debug-on", "settings.py", "DEBUG = os.environ.get('DEBUG') == '1'"],
  ["secret-in-log", "a.js", "console.log('password reset sent to', email);"],
  ["android-debuggable", "AndroidManifest.xml", '<application android:debuggable="false">'],
  ["android-exported", "AndroidManifest.xml", '<activity android:exported="true" android:permission="com.x.PERM">'],
  ["docker-latest", "Dockerfile", "FROM node:20.11.1-alpine AS build"],
  ["docker-latest", "Dockerfile", "FROM scratch"],
  ["docker-secret", "Dockerfile", "ENV API_KEY=${API_KEY}"],
  ["docker-root", "Dockerfile", "USER app"],
  ["k8s-privileged", "k8s/pod.yaml", "      privileged: false"],
  ["ci-unpinned", ".github/workflows/a.yml", "      - uses: actions/checkout@v4"],
  ["ci-unpinned", ".github/workflows/a.yml", "      - uses: someone/act@0123456789abcdef0123456789abcdef01234567"],
  ["server-tls", "nginx.conf", "ssl_protocols TLSv1.2 TLSv1.3;"],
  ["firebase-rules-open", "firestore.rules", "      allow read: if request.auth.uid == userId;"],
  ["supabase-definer", "supabase/migrations/1.sql", "create function f() returns int security definer set search_path = '' as $$ select 1 $$ language sql;"],
  ["supabase-policy-true", "supabase/migrations/1.sql", "create policy p on notes for select using (auth.uid() = user_id);"],
  ["iac-public-acl", "main.tf", '  acl = "private"'],
];

describe("every pattern check fires on what it should, with the right severity", () => {
  for (const [id, file, line, severity] of POSITIVE) {
    test(`${id}: ${line.slice(0, 60)}`, () => {
      assert.ok(has(file, line, id), `${id} should fire for ${file}: ${line}`);
      assert.equal(sev(file, line, id), severity);
    });
  }
  test("every check in the table has at least one positive and one negative case", () => {
    const wholeFile = new Set(["env-committed", "secret-supabase-jwt", "pay-webhook-unverified", "supabase-table-no-rls", "ios-ats-off", "iac-open-port", "supabase-service-client"]);
    const covered = new Set(POSITIVE.map((p) => p[0]));
    const missing = SECURITY_CHECK_IDS.filter((id) => !covered.has(id) && !wholeFile.has(id));
    assert.deepEqual(missing, [], "checks without a positive test");
    // negative cases are written for the checks that are easy to over-trigger (a vendor's secret format is not)
    const negs = new Set(NEGATIVE.map((n) => n[0]));
    for (const id of ["tls-off", "cleartext-url", "secret-generic", "eval-exec", "sql-concat", "deserialize", "xss-sink", "weak-password-hash", "insecure-random", "jwt-unsafe", "cors-any", "debug-on", "secret-in-log", "docker-latest", "server-tls", "ci-unpinned"]) assert.ok(negs.has(id), `${id} needs a negative case`);
  });
});

describe("close-but-fine lines stay quiet", () => {
  for (const [id, file, line] of NEGATIVE) {
    test(`${id} ignores: ${line.slice(0, 60)}`, () => {
      assert.ok(!has(file, line, id), `${id} should not fire for ${file}: ${line}`);
    });
  }
});

describe("what is skipped, and how", () => {
  test("test, fixture, doc and lock files are not judged, but a committed real .env is", () => {
    assert.deepEqual(run("src/__tests__/a.test.ts", ['const k = "AKIAIOSFODNN7EXAMPLQ";']), []);
    assert.deepEqual(run("fixtures/a.ts", ['const k = "AKIAIOSFODNN7EXAMPLQ";']), []);
    assert.deepEqual(run("README.md", ["verify=False"]), []);
    assert.deepEqual(run("package-lock.json", ['"resolved": "http://registry.shopfront.io/x"']), []);
    const e = run(".env", ["DB_PASSWORD=hunter2"]);
    assert.equal(e[0].severity, "defect");
    assert.match(e[0].message, /\[env-committed\]/);
    assert.deepEqual(run(".env.example", ["DB_PASSWORD=changeme"]), []);
  });
  test("comments are not judged, except secrets and private keys, which stay secrets in a comment", () => {
    assert.deepEqual(run("a.js", ["// eval(req.body.code) is dangerous"]), []);
    assert.ok(has("a.js", '// key = "AKIAIOSFODNN7EXAMPLQ"', "secret-aws"));
  });
  test("an explicit suppression marker on the line is respected", () => {
    assert.deepEqual(run("a.py", ["subprocess.run(cmd, shell=True)  # nosec B602"]), []);
    assert.deepEqual(run("a.ts", ['const k = "AKIAIOSFODNN7EXAMPLQ"; // gitleaks:allow']), []);
  });
  test("only ADDED lines count: context and removed lines are ignored", () => {
    const diff = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@\n-eval(req.body.code)\n eval(old)\n+const ok = 1;";
    assert.deepEqual(securitySignals([{ file: "a.js", diff }]), []);
  });
  test("defects come first, and a repeated pattern is one signal with a count", () => {
    const s = run("src/a.js", ["el.innerHTML = a;", "el.innerHTML = b;", "const t = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789\";"]);
    assert.equal(s[0].severity, "defect");
    const xss = s.find((x) => x.message.startsWith("[xss-sink]"))!;
    assert.match(xss.message, /2 place\(s\) in src\/a\.js/);
    assert.equal(s.filter((x) => x.message.startsWith("[xss-sink]")).length, 1);
  });
  test("a secret's value is never repeated in the message", () => {
    const s = run("src/a.ts", ['const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";']);
    assert.ok(!s[0].message.includes("ghp_abcdef"));
  });
});

describe("checks that need more than one line", () => {
  test("a Supabase service_role key is found inside a JWT", () => {
    const payload = Buffer.from(JSON.stringify({ iss: "supabase", role: "service_role" })).toString("base64url");
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.abcdefghijklmnopqrstuvwxyz`;
    const s = run("src/c.ts", [`const key = "${jwt}";`]);
    assert.ok(s.some((x) => x.severity === "defect" && x.message.includes("[secret-supabase-jwt]")));
    const anon = Buffer.from(JSON.stringify({ iss: "supabase", role: "anon" })).toString("base64url");
    assert.ok(!run("src/c.ts", [`const key = "eyJhbGciOiJIUzI1NiJ9.${anon}.abcdefghijklmnopqrstuvwxyz";`]).some((x) => x.message.includes("secret-supabase-jwt")));
  });
  test("a payment webhook handler without a signature check is a defect; with one it is not", () => {
    const bad = "app.post('/webhooks/stripe', express.json(), async (req, res) => {\n  const event = req.body;\n  if (event.type === 'checkout.session.completed') await grant(event.data.object);\n  res.sendStatus(200);\n});";
    const good = "app.post('/webhooks/stripe', express.raw({type:'application/json'}), async (req, res) => {\n  const event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);\n  res.sendStatus(200);\n});";
    const lines = bad.split("\n");
    const s = securitySignals([seg("src/webhooks/stripe.ts", lines)], { readFile: () => bad });
    assert.ok(s.some((x) => x.severity === "defect" && x.message.includes("[pay-webhook-unverified]")));
    assert.ok(!securitySignals([seg("src/webhooks/stripe.ts", good.split("\n"))], { readFile: () => good }).some((x) => x.message.includes("pay-webhook-unverified")));
    assert.ok(!securitySignals([seg("src/webhooks/stripe.ts", lines)]).some((x) => x.message.includes("pay-webhook-unverified")), "no file reader, no whole-file check");
  });
  test("a table created without RLS in a Supabase migration is flagged; with it, not", () => {
    const sql = "create table public.notes (id uuid primary key, user_id uuid);\n-- policies below use auth.uid()";
    const withRls = sql + "\nalter table public.notes enable row level security;";
    assert.ok(securitySignals([seg("supabase/migrations/2.sql", sql.split("\n"))], { readFile: () => sql }).some((x) => x.message.includes("[supabase-table-no-rls]") && /notes/.test(x.message)));
    assert.ok(!securitySignals([seg("supabase/migrations/2.sql", withRls.split("\n"))], { readFile: () => withRls }).some((x) => x.message.includes("supabase-table-no-rls")));
  });
  test("an iOS plist with ATS disabled is a defect; a rule opening SSH to the world is a defect", () => {
    const plist = "<dict><key>NSAllowsArbitraryLoads</key>\n<true/></dict>";
    assert.ok(securitySignals([seg("ios/App/Info.plist", plist.split("\n"))], { readFile: () => plist }).some((x) => x.severity === "defect" && x.message.includes("[ios-ats-off]")));
    const tf = 'ingress {\n  from_port = 22\n  to_port = 22\n  cidr_blocks = ["0.0.0.0/0"]\n}';
    assert.ok(securitySignals([seg("net.tf", tf.split("\n"))], { readFile: () => tf }).some((x) => x.severity === "defect" && x.message.includes("[iac-open-port]")));
    const web = 'ingress {\n  from_port = 443\n  to_port = 443\n  cidr_blocks = ["0.0.0.0/0"]\n}';
    assert.ok(!securitySignals([seg("net.tf", web.split("\n"))], { readFile: () => web }).some((x) => x.message.includes("iac-open-port")));
  });
  test("a file reader that throws or returns nothing never breaks the checks", () => {
    assert.doesNotThrow(() => securitySignals([seg("a.ts", ["el.innerHTML = a;"])], { readFile: () => { throw new Error("x"); } }));
    assert.equal(securitySignals([seg("a.ts", ["el.innerHTML = a;"])], { readFile: () => undefined }).length, 1);
  });
});

describe("the same mistake in different languages", () => {
  test("hard-coded TLS bypass, shell injection, SQL and deserialisation across Node, Python, PHP, Go, Java, C#, Ruby, Kotlin", () => {
    const langs: [string, string, string][] = [
      ["tls-off", "a.cs", "handler.ServerCertificateValidationCallback = (m, c, ch, e) => true;"],
      ["tls-off", "a.php", "curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);"],
      ["tls-off", "a.py", "ctx = ssl._create_unverified_context()"],
      ["deserialize", "a.cs", "var f = new BinaryFormatter();"],
      ["deserialize", "a.rb", "obj = Marshal.load(data)"],
      ["eval-exec", "a.rb", "eval(params[:code])"],
      ["eval-exec", "A.java", "Runtime.getRuntime().exec(cmd);"],
      ["sql-concat", "a.php", '$r = mysqli_query($c, "SELECT * FROM t WHERE id = " . $_GET["id"]);'],
      ["sql-concat", "a.cs", 'var cmd = new SqlCommand("SELECT * FROM t WHERE n = \'" + name + "\'", conn);'],
      ["insecure-random", "a.go", "token := rand.Intn(1000000) // math/rand: password reset token = rand.Int()"],
    ];
    for (const [id, f, l] of langs) assert.ok(has(f, l, id), `${id} in ${f}: ${l}`);
  });
});

describe("tuned against real code", () => {
  test("words inside log messages are not secrets, but an interpolated secret is", () => {
    assert.ok(!has("a.ts", "console.log(`reading the api key from env`);", "secret-in-log"));
    assert.ok(!has("a.ts", 'console.error("failed to read the password file");', "secret-in-log"));
    assert.ok(has("a.ts", "console.log(`login for ${email} with ${password}`);", "secret-in-log"));
    assert.ok(has("a.ts", 'console.log("pw:", password);', "secret-in-log"));
  });
  test("the TLS message tells a person how to mark a deliberate local exception, and the marker works", () => {
    assert.match(run("a.ts", ["agent = { rejectUnauthorized: false }"])[0].message, /nosec comment/);
    assert.deepEqual(run("a.ts", ["agent = { rejectUnauthorized: false } // nosec: local self-signed dev server"]), []);
  });
  test("the service role is flagged in a file that ships to a client, not in server code", () => {
    const client = ["import { createClient } from '@supabase/supabase-js';", "import React from 'react';", "const c = createClient(u, process.env.SUPABASE_SERVICE_ROLE_KEY);"];
    const server = ["import { createClient } from '@supabase/supabase-js';", "export const admin = createClient(u, process.env.SUPABASE_SERVICE_ROLE_KEY);"];
    const use = ["'use client'", "const k = process.env.NEXT_SERVICE_ROLE;"];
    const flagged = (file: string, lines: string[]) => securitySignals([seg(file, lines)], { readFile: () => lines.join("\n") }).some((x) => x.message.includes("[supabase-service-client]"));
    assert.ok(flagged("src/App.tsx", client));
    assert.ok(!flagged("src/server/admin.ts", server));
    assert.ok(flagged("app/page.tsx", use));
  });
});
