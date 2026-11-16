/**
 * The classifier is shown what is really in the project and picks from it; what
 * it picks is checked, so a made-up path is never used.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { existingDirOnly, existingFilesOnly, projectLayout, renderLayout } from "../src/projectLayout.js";

const repo = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

const sample = () =>
  repo({
    ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`my old droid app/src/F${i}.kt`, `class F${i}`])),
    ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`src/f${i}.ts`, `export const a${i} = 1;`])),
    "docs/timeline brief.md": "# brief",
    "reference/PORT_NOTES.md": "# notes",
    "README.md": "# r",
    "node_modules/pkg/a.js": "x",
    "node_modules/pkg/b.js": "x",
    "node_modules/pkg/c.js": "x",
    "node_modules/pkg/NOTES.md": "x",
  });

describe("projectLayout", () => {
  test("folders are listed with file counts, biggest first, never node_modules", () => {
    const l = projectLayout(sample());
    assert.equal(l.dirs[0].path, "my old droid app");
    assert.ok(l.dirs[0].files >= 12);
    assert.ok(!l.dirs.some((d) => d.path.startsWith("node_modules")));
  });

  test("documents are listed nearest first, never from node_modules", () => {
    const l = projectLayout(sample());
    assert.deepEqual(l.docs, ["README.md", "docs/timeline brief.md", "reference/PORT_NOTES.md"]);
  });

  test("it is bounded", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
      for (const n of ["a", "b", "c"]) files[`d${i}/${n}.ts`] = "x";
      files[`n${i}.md`] = "x";
    }
    const l = projectLayout(repo(files), { maxDirs: 10, maxDocs: 7 });
    assert.equal(l.dirs.length, 10);
    assert.equal(l.docs.length, 7);
  });

  test("what the model sees is plain text it can copy a path from", () => {
    const text = renderLayout(projectLayout(sample()));
    assert.match(text, /Project folders \(path, number of files\):\n- my old droid app\/ \(\d+\)/);
    assert.match(text, /Project documents:\n- README\.md/);
  });

  test("a project with nothing to show adds nothing", () => {
    assert.equal(renderLayout({ dirs: [], docs: [] }), "");
  });
});

describe("what the model picked is checked", () => {
  test("only real files inside the project survive, once each", () => {
    const r = sample();
    assert.deepEqual(
      existingFilesOnly(r, ["docs/timeline brief.md", "docs/timeline brief.md", "docs/invented.md", "../outside.md", "README.md"]),
      ["docs/timeline brief.md", "README.md"]
    );
  });

  test("a folder, an absolute path, and nonsense are not files", () => {
    const r = sample();
    assert.deepEqual(existingFilesOnly(r, ["docs", path.resolve(r, "README.md"), null, 7, {}]), []);
    assert.deepEqual(existingFilesOnly(r, "README.md"), []);
  });

  test("a chosen folder is kept only if it is a folder in the project", () => {
    const r = sample();
    assert.equal(existingDirOnly(r, "my old droid app/"), "my old droid app");
    assert.equal(existingDirOnly(r, "nowhere"), undefined);
    assert.equal(existingDirOnly(r, "README.md"), undefined);
    assert.equal(existingDirOnly(r, "../elsewhere"), undefined);
  });
});
