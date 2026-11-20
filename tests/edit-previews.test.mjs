import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyEdit, previewEdit } from "../src/edit-previews.mjs";
import { permissionContext } from "../src/permissions.mjs";

async function workspace(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pify-edit-test-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("single and bulk previews show complete changes without writing", async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, "one.txt"), "old here\n");
  await fs.writeFile(path.join(cwd, "two.txt"), "old and old\n");
  const input = { cwd, paths: ["one.txt", "two.txt"], find: "old", replace: "new" };
  const report = await previewEdit(input);
  assert.equal(report.status, "preview");
  assert.equal(report.risk, "high");
  assert.deepEqual(report.files.map(({ path: file, matches, before, after }) => [file, matches, before, after]), [
    ["one.txt", 1, "old here\n", "new here\n"],
    ["two.txt", 2, "old and old\n", "new and new\n"],
  ]);
  assert.equal(await fs.readFile(path.join(cwd, "one.txt"), "utf8"), "old here\n");
  const declined = await applyEdit({ ...input, reviewCode: report.reviewCode, permission: permissionContext({ mode: "full", authorizedPaths: input.paths }) });
  assert.equal(declined.status, "approval_required");
  assert.equal(await fs.readFile(path.join(cwd, "two.txt"), "utf8"), "old and old\n");
});

test("each mode needs exact scope and explicit approval before bulk changes", async (t) => {
  const cwd = await workspace(t);
  const input = { cwd, paths: ["a.txt", "b.txt"], find: "old", replace: "new" };
  for (const file of input.paths) await fs.writeFile(path.join(cwd, file), "old\n");
  for (const mode of ["safe", "balanced", "full"]) {
    const preview = await previewEdit({ ...input, permission: permissionContext({ mode }) });
    assert.equal(preview.mode, mode);
    assert.deepEqual(preview.approval, { required: true, scope: mode === "safe" ? "predeclared" : "predeclared_or_tui_approval" });
    const declined = await applyEdit({ ...input, reviewCode: preview.reviewCode, permission: permissionContext({ mode }) });
    assert.equal(declined.status, "approval_required");
    const refused = await applyEdit({ ...input, reviewCode: preview.reviewCode, approved: true, permission: permissionContext({ mode }) });
    assert.equal(refused.outcome, "clarification_required");
    for (const file of input.paths) assert.equal(await fs.readFile(path.join(cwd, file), "utf8"), "old\n");
  }
  const preview = await previewEdit(input);
  const applied = await applyEdit({ ...input, reviewCode: preview.reviewCode, approved: true,
    permission: permissionContext({ mode: "safe", authorizedPaths: input.paths }) });
  assert.equal(applied.status, "applied");
  for (const file of input.paths) assert.equal(await fs.readFile(path.join(cwd, file), "utf8"), "new\n");
});

test("high-impact single-file preview is explicit and stale previews cannot write", async (t) => {
  const cwd = await workspace(t);
  const file = "AGENTS.md";
  await fs.writeFile(path.join(cwd, file), "old instruction\n");
  const input = { cwd, paths: [file], find: "old", replace: "new" };
  const preview = await previewEdit(input);
  assert.equal(preview.risk, "high");
  await fs.writeFile(path.join(cwd, file), "old instruction\nextra\n");
  const stale = await applyEdit({ ...input, reviewCode: preview.reviewCode, approved: true,
    permission: permissionContext({ mode: "full", authorizedPaths: [file] }) });
  assert.equal(stale.status, "stale_preview");
  assert.equal(await fs.readFile(path.join(cwd, file), "utf8"), "old instruction\nextra\n");
});

test("a later write failure restores an earlier replaced file", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root can write through directory permissions");
  const cwd = await workspace(t);
  const locked = path.join(cwd, "locked");
  await fs.mkdir(locked);
  await fs.writeFile(path.join(cwd, "first.txt"), "old\n");
  await fs.writeFile(path.join(locked, "second.txt"), "old\n");
  const input = { cwd, paths: ["first.txt", "locked/second.txt"], find: "old", replace: "new" };
  const preview = await previewEdit(input);
  await fs.chmod(locked, 0o555);
  let result;
  try {
    result = await applyEdit({ ...input, reviewCode: preview.reviewCode, approved: true,
      permission: permissionContext({ mode: "balanced", authorizedPaths: input.paths }) });
  } finally { await fs.chmod(locked, 0o755); }
  assert.equal(result.status, "failed");
  assert.deepEqual(result.recovery, []);
  assert.equal(await fs.readFile(path.join(cwd, "first.txt"), "utf8"), "old\n");
  assert.equal(await fs.readFile(path.join(locked, "second.txt"), "utf8"), "old\n");
});

test("unsafe paths, symlinks, and oversized previews fail closed", async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, "source.txt"), "old");
  await fs.symlink("source.txt", path.join(cwd, "link.txt"));
  await fs.mkdir(path.join(cwd, "real"));
  await fs.writeFile(path.join(cwd, "real", "nested.txt"), "old");
  await fs.symlink("real", path.join(cwd, "linked"));
  for (const file of ["../source.txt", "/tmp/source.txt", "link.txt", "linked/nested.txt"]) {
    await assert.rejects(previewEdit({ cwd, paths: [file], find: "old", replace: "new" }));
  }
  await fs.writeFile(path.join(cwd, "large.txt"), `old${"x".repeat(8192)}`);
  await assert.rejects(previewEdit({ cwd, paths: ["large.txt"], find: "old", replace: "new" }), /oversized/);
  for (const file of ["wide-a.txt", "wide-b.txt", "wide-c.txt"]) await fs.writeFile(path.join(cwd, file), `old${"x".repeat(5997)}`);
  await assert.rejects(previewEdit({ cwd, paths: ["wide-a.txt", "wide-b.txt", "wide-c.txt"], find: "old", replace: "new" }), /output limit/);
  assert.equal(await fs.readFile(path.join(cwd, "source.txt"), "utf8"), "old");
});
