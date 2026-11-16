/**
 * The generic command policy behind run_project_command: parsing without a
 * shell, containment, the deny list, approve-once-and-remember, and the
 * AgentTools path that ties them together.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CommandApprovals,
  describeBinary,
  describeCommand,
  evaluateCommand,
  executableName,
  resolveExecutable,
  runsInstalledBinary,
  runResolvedCommand,
  tokenizeCommand,
} from "../src/commandPolicy.js";
import { AgentTools } from "../src/agentTools.js";
import type { AgentConfig } from "../src/config.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-policy-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("tokenizeCommand", () => {
  test("splits plain words and groups quoted ones", () => {
    assert.deepEqual(tokenizeCommand('npm run "build all" --flag=1'), { argv: ["npm", "run", "build all", "--flag=1"] });
  });

  test("quoted metacharacters are literal data, not operators", () => {
    assert.deepEqual(tokenizeCommand('tool "a && b" \'c | d\''), { argv: ["tool", "a && b", "c | d"] });
  });

  for (const [label, cmd] of [
    ["&&", "npm install && npm test"],
    ["pipe", "cat package.json | sh"],
    ["semicolon", "npm install; rm -rf /"],
    ["redirect", "echo hi > file"],
    ["backtick", "echo `whoami`"],
    ["substitution", "echo $(whoami)"],
    ["newline", "npm install\nnpm test"],
  ] as const) {
    test(`rejects ${label}`, () => {
      assert.ok("error" in tokenizeCommand(cmd));
    });
  }

  test("rejects an empty command and an unterminated quote", () => {
    assert.ok("error" in tokenizeCommand("   "));
    assert.ok("error" in tokenizeCommand('npm "install'));
  });
});

describe("executableName", () => {
  test("strips directories and Windows executable extensions, case-folded", () => {
    assert.equal(executableName("C:\\Program Files\\nodejs\\NPM.CMD"), "npm");
    assert.equal(executableName("./gradlew"), "gradlew");
    assert.equal(executableName("/usr/bin/python3"), "python3");
  });
});

describe("evaluateCommand", () => {
  const repo = tempDir();
  fs.mkdirSync(path.join(repo, "web"), { recursive: true });

  const verdict = (cmd: string, cwd?: string, extra: object = {}) =>
    evaluateCommand(cmd, { repoRoot: repo, cwd, ...extra });

  test("an ordinary command in the repo asks, as normal risk", () => {
    const d = verdict("npm install --ignore-scripts", "web");
    assert.equal(d.verdict, "ask");
    if (d.verdict === "ask") {
      assert.equal(d.risk, "normal");
      assert.equal(d.cwdRel, "web");
    }
  });

  for (const cmd of ["sudo npm install", "bash -c ls", "powershell -Command x", "rm -rf node_modules", "ssh host", "chmod 777 x"]) {
    test(`denies: ${cmd}`, () => {
      assert.equal(verdict(cmd).verdict, "deny");
    });
  }

  test("a deny reason on deletion points at the staged path", () => {
    const d = verdict("rm file.txt");
    assert.equal(d.verdict, "deny");
    if (d.verdict === "deny") assert.match(d.reason, /stage_file_for_deletion/);
  });

  test("denies a working directory outside the project, and a missing one", () => {
    assert.equal(verdict("npm test", "..").verdict, "deny");
    assert.equal(verdict("npm test", "does-not-exist").verdict, "deny");
  });

  for (const cmd of [
    "tool ../secrets",
    "tool /etc/passwd",
    "tool ~/.ssh/id_rsa",
    "tool --out=../elsewhere",
    "tool a/../../b",
  ]) {
    test(`denies a path outside the project: ${cmd}`, () => {
      assert.equal(verdict(cmd).verdict, "deny");
    });
  }

  test("inside-repo paths, package specs and URLs are not treated as escapes", () => {
    assert.equal(verdict("tool src/main.ts").verdict, "ask");
    assert.equal(verdict("tool @scope/pkg@1.2.3").verdict, "ask");
    assert.equal(verdict("tool --index-url https://pypi.org/simple pkg").verdict, "ask");
    assert.equal(verdict("tool --config=web/config.json").verdict, "ask");
  });

  test("a relative executable path outside the project is denied", () => {
    assert.equal(verdict("../tool run").verdict, "deny");
  });

  test("Windows re-interprets cmd metacharacters in batch-file arguments, so they are refused there", () => {
    const d = evaluateCommand('gradlew.bat "a&b"', { repoRoot: repo, platform: "win32" });
    assert.equal(d.verdict, "deny");
    const ok = evaluateCommand('gradlew.bat "a&b"', { repoRoot: repo, platform: "linux" });
    assert.equal(ok.verdict, "ask");
  });

  for (const [cmd, why] of [
    ["node -e \"console.log(1)\"", /inline code/],
    ["python -c \"print(1)\"", /inline code/],
    ["npx some-package", /downloads a package/],
    ["npm exec some-package", /downloads a package/],
    ["curl https://example.com", /network/],
    ["build/tracediff.exe --help", /compiled program/],
    ["./out/game_host.exe", /compiled program/],
  ] as const) {
    test(`elevated: ${cmd}`, () => {
      const d = verdict(cmd);
      assert.equal(d.verdict, "ask");
      if (d.verdict === "ask") {
        assert.equal(d.risk, "elevated");
        assert.match(String(d.elevatedBecause), why);
      }
    });
  }

  test("a program outside the repo by absolute path is elevated, not denied", () => {
    const outside = path.join(path.dirname(repo), "tools", "ninja");
    const d = verdict(`${outside} --version`);
    assert.equal(d.verdict, "ask");
    if (d.verdict === "ask") {
      assert.equal(d.risk, "elevated");
      assert.match(String(d.elevatedBecause), /outside the project/);
    }
  });

  test("a compiled program is asked about every time even if remembered", () => {
    const approvals = new CommandApprovals(path.join(tempDir(), "approvals.json"));
    approvals.remember(repo, ["build/tool.exe"], "");
    assert.equal(verdict("build/tool.exe", undefined, { approvals }).verdict, "ask");
  });

  test("scripts and wrappers inside the repo stay normal risk", () => {
    const d = verdict("./gradlew build");
    assert.equal(d.verdict, "ask");
    if (d.verdict === "ask") assert.equal(d.risk, "normal");
  });

  test("remembering a normal command makes the exact same command allowed", () => {
    const approvals = new CommandApprovals(path.join(tempDir(), "approvals.json"));
    assert.equal(verdict("npm test", undefined, { approvals }).verdict, "ask");
    approvals.remember(repo, ["npm", "test"], "");
    assert.equal(verdict("npm test", undefined, { approvals }).verdict, "allow");
  });

  test("an approval does not extend to different arguments or a different directory", () => {
    const approvals = new CommandApprovals(path.join(tempDir(), "approvals.json"));
    approvals.remember(repo, ["npm", "install"], "");
    assert.equal(verdict("npm install --ignore-scripts", undefined, { approvals }).verdict, "ask");
    assert.equal(verdict("npm install", "web", { approvals }).verdict, "ask");
  });

  test("an elevated command is asked about even if it was somehow remembered", () => {
    const approvals = new CommandApprovals(path.join(tempDir(), "approvals.json"));
    approvals.remember(repo, ["npx", "thing"], "");
    const d = verdict("npx thing", undefined, { approvals });
    assert.equal(d.verdict, "ask");
  });
});

describe("describeBinary", () => {
  test("reports the SHA-256 of the file and, on Windows, its signature", async () => {
    const file = path.join(tempDir(), "tool.exe");
    fs.writeFileSync(file, "abc");
    const out = await describeBinary(file, { platform: "win32", signature: async () => "NotSigned (unsigned)" });
    assert.match(out, /SHA-256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/);
    assert.match(out, /Signature: NotSigned/);
  });

  test("skips the signature off Windows and never throws on a missing file", async () => {
    const file = path.join(tempDir(), "tool");
    fs.writeFileSync(file, "abc");
    assert.doesNotMatch(await describeBinary(file, { platform: "linux" }), /Signature/);
    assert.match(await describeBinary(path.join(tempDir(), "gone.exe")), /Could not read/);
  });

  test("a native program decision is flagged so the prompt can show these facts", () => {
    const d = evaluateCommand("build/tool.exe", { repoRoot: tempDir() });
    assert.equal(d.verdict === "ask" && d.nativeProgram, true);
  });
});

describe("CommandApprovals", () => {
  test("persists across instances and is scoped per repository", () => {
    const file = path.join(tempDir(), "approvals.json");
    const repoA = tempDir();
    const repoB = tempDir();
    new CommandApprovals(file).remember(repoA, ["cargo", "check"], "");
    const reloaded = new CommandApprovals(file);
    assert.equal(reloaded.isApproved(repoA, ["cargo", "check"], ""), true);
    assert.equal(reloaded.isApproved(repoB, ["cargo", "check"], ""), false);
    assert.equal(reloaded.list(repoA).length, 1);
  });

  test("revoke removes one approval by position, or all of them", () => {
    const file = path.join(tempDir(), "approvals.json");
    const repo = tempDir();
    const approvals = new CommandApprovals(file);
    approvals.remember(repo, ["npm", "test"], "");
    approvals.remember(repo, ["cargo", "check"], "");
    assert.equal(approvals.revoke(repo, 1), 1);
    assert.deepEqual(approvals.list(repo).map((e) => e.argv[0]), ["cargo"]);
    assert.equal(approvals.revoke(repo, 9), 0);
    assert.equal(new CommandApprovals(file).revoke(repo, "all"), 1);
    assert.equal(new CommandApprovals(file).list(repo).length, 0);
  });

  test("a corrupt file is set aside and treated as empty", () => {
    const dir = tempDir();
    const file = path.join(dir, "approvals.json");
    fs.writeFileSync(file, "{ nope");
    const approvals = new CommandApprovals(file);
    assert.equal(approvals.isApproved(dir, ["x"], ""), false);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("approvals.json.corrupt-")));
  });

  test("the file is never created inside a repository by default", () => {
    // The default location is under the user's home, not the project.
    const saved = process.env.YIMPIM_APPROVALS_FILE;
    delete process.env.YIMPIM_APPROVALS_FILE;
    try {
      const approvals = new CommandApprovals();
      // Only the path is asserted: nothing is written here.
      assert.match(String((approvals as any).file), /\.yimpim/);
    } finally {
      if (saved !== undefined) process.env.YIMPIM_APPROVALS_FILE = saved;
    }
  });
});

describe("resolveExecutable / runResolvedCommand", () => {
  const isWin = process.platform === "win32";

  test("finds a tool on PATH and reports a missing one as undefined", () => {
    const bin = tempDir();
    const name = isWin ? "mytool.cmd" : "mytool";
    fs.writeFileSync(path.join(bin, name), isWin ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
    const env = { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    assert.ok(resolveExecutable("mytool", bin, env));
    assert.equal(resolveExecutable("no-such-tool-xyz", bin, env), undefined);
  });

  test("finds a project wrapper by relative path", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "android"));
    const name = isWin ? "gradlew.bat" : "gradlew";
    fs.writeFileSync(path.join(dir, "android", name), "", { mode: 0o755 });
    const found = resolveExecutable(`android/${name}`, dir, { PATH: "" });
    assert.ok(found && found.endsWith(name));
  });

  test("runs without a shell and captures output and the exit code", async () => {
    const dir = tempDir();
    const ok = await runResolvedCommand(process.execPath, ["-e", "console.log('hello')"], { cwd: dir });
    assert.equal(ok.ok, true);
    assert.match(ok.output, /hello/);

    const bad = await runResolvedCommand(process.execPath, ["-e", "console.error('boom'); process.exit(3)"], { cwd: dir });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 3);
    assert.match(bad.output, /boom/);
  });

  test("a shell operator in an argument is just a string: nothing is chained", async () => {
    const dir = tempDir();
    const marker = path.join(dir, "should-not-exist");
    const res = await runResolvedCommand(
      process.execPath,
      ["-e", "console.log(process.argv[1])", `x; touch ${marker}`],
      { cwd: dir }
    );
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(marker), false);
  });
});

describe("AgentTools.runProjectCommand", () => {
  const config = { prompts: { systemPersona: "You are YIMPIM." } } as AgentConfig;
  const savedFile = process.env.YIMPIM_APPROVALS_FILE;
  const ttyStdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const ttyStdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  before(() => {
    process.env.YIMPIM_APPROVALS_FILE = path.join(tempDir(), "approvals.json");
    // The approval prompt refuses to run non-interactively; pretend a terminal.
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });
  after(() => {
    if (savedFile === undefined) delete process.env.YIMPIM_APPROVALS_FILE;
    else process.env.YIMPIM_APPROVALS_FILE = savedFile;
    if (ttyStdin) Object.defineProperty(process.stdin, "isTTY", ttyStdin);
    else delete (process.stdin as any).isTTY;
    if (ttyStdout) Object.defineProperty(process.stdout, "isTTY", ttyStdout);
    else delete (process.stdout as any).isTTY;
  });

  // Bare name: an absolute path outside the repo is (rightly) an elevated, never-remembered command.
  const nodeCmd = () => "node --trace-warnings --version"; // not one of the commands that need no approval

  test("asks once, runs, then remembers: the same command runs without a second prompt", async () => {
    const repo = tempDir();
    const asked: string[] = [];
    const tools = new AgentTools(repo, config, async (q) => {
      asked.push(q);
      return "yes";
    });
    const first = await tools.runProjectCommand({ command: nodeCmd(), purpose: "check the runtime" });
    assert.match(first, /\[PASS\]/);
    assert.match(first, /v\d+\./);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /check the runtime/);
    assert.match(asked[0], /remembers/);

    const second = await tools.runProjectCommand({ command: nodeCmd(), purpose: "again" });
    assert.match(second, /\[PASS\]/);
    assert.equal(asked.length, 1, "an approved command must not prompt again");
  });

  test("a decline is reported to the model and not re-asked", async () => {
    const repo = tempDir();
    let asked = 0;
    const tools = new AgentTools(repo, config, async () => {
      asked++;
      return "no";
    });
    const first = await tools.runProjectCommand({ command: nodeCmd(), purpose: "x" });
    assert.match(first, /declined/);
    const second = await tools.runProjectCommand({ command: nodeCmd(), purpose: "x" });
    assert.match(second, /Not re-run/);
    assert.equal(asked, 1);
  });

  test("a policy refusal never reaches the user", async () => {
    const repo = tempDir();
    let asked = 0;
    const tools = new AgentTools(repo, config, async () => {
      asked++;
      return "yes";
    });
    for (const command of ["sudo whoami", "npm install && npm test", "rm -rf .", "tool ../outside"]) {
      const out = await tools.runProjectCommand({ command, purpose: "x" });
      assert.match(out, /^Not run — /, command);
    }
    assert.equal(asked, 0);
  });

  test("a program that is not installed is reported before any prompt", async () => {
    const repo = tempDir();
    let asked = 0;
    const tools = new AgentTools(repo, config, async () => {
      asked++;
      return "yes";
    });
    const out = await tools.runProjectCommand({ command: "definitely-not-installed-xyz --version", purpose: "x" });
    assert.match(out, /was not found/);
    assert.match(out, /manual step/);
    assert.equal(asked, 0);
  });

  test("a failing command is reported with its output and an identical retry is not re-run", async () => {
    const repo = tempDir();
    fs.writeFileSync(path.join(repo, "fail.js"), "console.error('compile error'); process.exit(2);");
    let asked = 0;
    const tools = new AgentTools(repo, config, async () => {
      asked++;
      return "yes";
    });
    const command = `"${process.execPath}" fail.js`;
    const first = await tools.runProjectCommand({ command, purpose: "build" });
    assert.match(first, /\[FAIL: exit 2\]/);
    assert.match(first, /compile error/);

    const second = await tools.runProjectCommand({ command, purpose: "build" });
    assert.match(second, /Not re-run/);
    assert.match(second, /compile error/);
    assert.equal(asked, 1);
  });

  test("describeCommand shows the directory when it is not the root", () => {
    assert.equal(describeCommand(["npm", "install"], "web"), "npm install  (in web)");
    assert.equal(describeCommand(["npm", "run", "a b"], ""), 'npm run "a b"');
  });
});

describe("script fingerprints and install redirects", () => {
  const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-fp-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
    const approvals = new CommandApprovals(path.join(dir, "..", `appr-${path.basename(dir)}.json`));
    return { dir, approvals };
  };

  test("editing the package.json script invalidates a remembered `npm run test`", () => {
    const { dir, approvals } = mk();
    try {
      const first = evaluateCommand("npm run test", { repoRoot: dir, approvals });
      assert.equal(first.verdict, "ask");
      if (first.verdict === "deny") throw new Error("unexpected deny");
      approvals.remember(dir, first.argv, first.cwdRel, first.fingerprint);
      assert.equal(evaluateCommand("npm run test", { repoRoot: dir, approvals }).verdict, "allow");

      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node evil.js" } }));
      assert.equal(evaluateCommand("npm run test", { repoRoot: dir, approvals }).verdict, "ask");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("naming a package in an install is redirected; installing the manifest is not", () => {
    const { dir, approvals } = mk();
    try {
      for (const cmd of ["npm install left-pad", "npm i -D typescript", "pip install requests", "python -m pip install requests", "cargo add serde", "yarn add lodash"]) {
        const d = evaluateCommand(cmd, { repoRoot: dir, approvals });
        assert.equal(d.verdict, "deny", cmd);
        assert.match((d as any).reason, /request_dependency/);
      }
      for (const cmd of ["npm install", "pip install -r requirements.txt", "npm ci"]) {
        assert.notEqual(evaluateCommand(cmd, { repoRoot: dir, approvals }).verdict, "deny", cmd);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("npx of a program the project already has installed", () => {
  const mk = () => {
    const r = tempDir();
    fs.mkdirSync(path.join(r, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(r, "node_modules", ".bin", "jest"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(r, "node_modules", ".bin", "tsc.cmd"), "@echo off\n");
    return r;
  };
  test("it starts the installed program and downloads nothing, so it is not elevated", () => {
    const r = mk();
    for (const cmd of ["npx jest __tests__/a.test.ts --verbose", "npx --no-install jest", "npm exec jest", "pnpm exec jest -- --ci", "npx tsc --noEmit"]) {
      assert.equal(runsInstalledBinary((tokenizeCommand(cmd) as { argv: string[] }).argv, r, r), true, cmd);
      const d = evaluateCommand(cmd, { repoRoot: r, platform: "linux" });
      if (d.verdict === "ask") assert.notEqual(d.risk, "elevated", cmd);
    }
  });
  test("a version, --package, a program that is not installed, or one outside the project still counts as a download", () => {
    const r = mk();
    for (const cmd of ["npx jest@29", "npx --package left-pad jest", "npx -p x jest", "npx cowsay", "npx @scope/tool", "npx ../jest", "pnpm dlx jest", "bunx jest", "npx"]) {
      assert.equal(runsInstalledBinary((tokenizeCommand(cmd) as { argv: string[] }).argv, r, r), false, cmd);
    }
    const d = evaluateCommand("npx cowsay hi", { repoRoot: r, platform: "linux" });
    assert.equal(d.verdict, "ask");
    if (d.verdict === "ask") assert.match(String(d.elevatedBecause), /downloads a package/);
  });
  test("an installed program in a sub-folder of the project counts, one in a parent folder does not", () => {
    const r = mk();
    const sub = path.join(r, "app");
    fs.mkdirSync(sub);
    assert.equal(runsInstalledBinary(["npx", "jest"], sub, r), true);
    assert.equal(runsInstalledBinary(["npx", "jest"], path.dirname(r), r), false);
  });
});
