import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { listGitConflicts, previewGitConflict, resolveGitConflict } from "../src/git-conflicts.mjs";
import { permissionContext } from "../src/permissions.mjs";

const execFileAsync = promisify(execFile);
const file = "data.json";

async function git(cwd, ...args) {
  try { return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim(); }
  catch (error) { throw new Error(`git ${args[0]}: ${error.stderr || error.message}`); }
}

async function conflictFixture(t, { name = file, base = '{"value":"base"}\n', ours = '{"value":"ours"}\n', theirs = '{"value":"theirs"}\n' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pify-git-conflict-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  await fs.mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.name", "Fixture");
  await git(repo, "config", "user.email", "fixture@example.test");
  await git(repo, "config", "merge.conflictstyle", "diff3");
  await fs.writeFile(path.join(repo, name), base);
  await git(repo, "add", name);
  await git(repo, "commit", "-qm", "base");
  await git(repo, "branch", "side");
  await git(repo, "switch", "-q", "side");
  await fs.writeFile(path.join(repo, name), theirs);
  await git(repo, "commit", "-qam", "theirs");
  await git(repo, "switch", "-q", "main");
  await fs.writeFile(path.join(repo, name), ours);
  await git(repo, "commit", "-qam", "ours");
  await git(root, "init", "--bare", "-q", remote);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-q", "-u", "origin", "main");
  const before = { head: await git(repo, "rev-parse", "HEAD"), remote: await git(root, "--git-dir", remote, "rev-parse", "refs/heads/main") };
  const merge = await execFileAsync("git", ["merge", "side"], { cwd: repo, encoding: "utf8" }).catch((error) => error);
  assert.equal(merge.code, 1);
  return { repo, remote, before, conflicted: await fs.readFile(path.join(repo, name), "utf8"), name };
}

test("preview is read-only; explicit scoped choice resolves and stages one conflict", async (t) => {
  const { repo, remote, before, conflicted } = await conflictFixture(t);
  const listed = await listGitConflicts({ cwd: repo });
  assert.deepEqual(listed.conflicts, [{ path: file, stages: [1, 2, 3] }]);
  const preview = await previewGitConflict({ cwd: repo, file, choice: "theirs" });
  assert.equal(preview.status, "ready");
  assert.equal(preview.hunks, 1);
  assert.deepEqual(preview.validation, ["standard_conflict_markers", "git_diff_check", "json_parse"]);
  assert.equal(await fs.readFile(path.join(repo, file), "utf8"), conflicted);
  assert.match(await git(repo, "ls-files", "-u", "--", file), /data\.json/);
  const denied = await resolveGitConflict({ cwd: repo, file, choice: "theirs" });
  assert.equal(denied.outcome, "clarification_required");
  assert.equal(await fs.readFile(path.join(repo, file), "utf8"), conflicted);
  const resolved = await resolveGitConflict({ cwd: repo, file, choice: "theirs", reviewCode: preview.reviewCode,
    permission: permissionContext({ authorizedPaths: [`git/conflicts/${file}`] }) });
  assert.deepEqual([resolved.status, resolved.staged, resolved.commitCreated, resolved.pushed], ["resolved", true, false, false]);
  assert.equal(await fs.readFile(path.join(repo, file), "utf8"), '{"value":"theirs"}\n');
  assert.equal(await git(repo, "ls-files", "-u", "--", file), "");
  assert.match(await git(repo, "diff", "--cached", "--name-only"), /data\.json/);
  assert.equal(await git(repo, "rev-parse", "HEAD"), before.head);
  assert.equal(await git(repo, "rev-list", "--count", "HEAD"), "2");
  assert.equal(await git(repo, "--git-dir", remote, "rev-parse", "refs/heads/main"), before.remote);
});

test("invalid or changed conflict is reported without guessing or staging", async (t) => {
  const { repo, conflicted } = await conflictFixture(t, { theirs: '{"value":}\n' });
  const invalid = await previewGitConflict({ cwd: repo, file, choice: "theirs" });
  assert.deepEqual([invalid.status, invalid.reason], ["unresolvable", "invalid_json"]);
  const preview = await previewGitConflict({ cwd: repo, file, choice: "ours" });
  assert.equal(preview.status, "ready");
  await fs.writeFile(path.join(repo, file), conflicted.replace("<<<<<<< HEAD", "<<<<<<< changed"));
  const changed = await resolveGitConflict({ cwd: repo, file, choice: "ours", reviewCode: preview.reviewCode,
    permission: permissionContext({ authorizedPaths: [`git/conflicts/${file}`] }) });
  assert.deepEqual([changed.status, changed.reason], ["unresolvable", "preview_changed"]);
  assert.match(await git(repo, "ls-files", "-u", "--", file), /data\.json/);
});

test("index failure restores the original conflict file and unmerged stages", async (t) => {
  const { repo, conflicted } = await conflictFixture(t);
  const lock = path.join(repo, ".git", "index.lock");
  await fs.writeFile(lock, "busy");
  t.after(() => fs.rm(lock, { force: true }));
  const result = await resolveGitConflict({ cwd: repo, file, choice: "theirs",
    permission: permissionContext({ authorizedPaths: [`git/conflicts/${file}`] }) });
  assert.equal(result.status, "unresolvable");
  assert.equal(result.reason, "apply_failed");
  assert.equal(await fs.readFile(path.join(repo, file), "utf8"), conflicted);
  assert.match(await git(repo, "ls-files", "-u", "--", file), /data\.json/);
});

test("choosing one side of a hunk keeps nonconflicting changes from the other side", async (t) => {
  const middle = Array.from({ length: 20 }, (_, index) => `context ${index}\n`).join("");
  const { repo, name, before } = await conflictFixture(t, {
    name: "notes.txt", base: `base head\n${middle}base tail\n`,
    ours: `ours head\n${middle}base tail\n`,
    theirs: `theirs head\n${middle}theirs tail\n`,
  });
  const report = await resolveGitConflict({ cwd: repo, file: name, choice: "ours",
    permission: permissionContext({ authorizedPaths: [`git/conflicts/${name}`] }) });
  assert.equal(report.status, "resolved");
  assert.equal(await fs.readFile(path.join(repo, name), "utf8"), `ours head\n${middle}theirs tail\n`);
  assert.equal(await git(repo, "rev-parse", "HEAD"), before.head);
});

test("linked conflict files are refused without following the link", async (t) => {
  const { repo } = await conflictFixture(t);
  const outside = path.join(path.dirname(repo), "outside.json");
  await fs.writeFile(outside, "outside\n");
  await fs.rm(path.join(repo, file));
  await fs.symlink(outside, path.join(repo, file));
  const result = await resolveGitConflict({ cwd: repo, file, choice: "ours",
    permission: permissionContext({ authorizedPaths: [`git/conflicts/${file}`] }) });
  assert.deepEqual([result.status, result.reason], ["unresolvable", "unsupported_worktree_file"]);
  assert.equal(await fs.readFile(outside, "utf8"), "outside\n");
  assert.match(await git(repo, "ls-files", "-u", "--", file), /data\.json/);
});
