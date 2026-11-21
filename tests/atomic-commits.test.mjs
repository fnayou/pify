import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { applyAtomicCommits, previewAtomicCommits } from "../src/atomic-commits.mjs";
import { permissionContext } from "../src/permissions.mjs";

const execFileAsync = promisify(execFile);
async function git(cwd, ...args) { return (await execFileAsync("git", args, { cwd })).stdout.trim(); }

async function repository(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pify-commit-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "work");
  const remote = path.join(root, "remote.git");
  await fs.mkdir(cwd);
  await git(root, "init", "--bare", "-q", remote);
  await git(cwd, "init", "-q", "-b", "main");
  await git(cwd, "config", "user.name", "Pify Fixture");
  await git(cwd, "config", "user.email", "pify@example.test");
  for (const file of ["feature.txt", "guide.txt", "unrelated.txt", "unstaged.txt", "delete.txt"]) await fs.writeFile(path.join(cwd, file), "before\n");
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-qm", "chore: baseline");
  await git(cwd, "remote", "add", "origin", remote);
  await git(cwd, "push", "-q", "-u", "origin", "main");
  return { cwd, remote, head: await git(cwd, "rev-parse", "HEAD") };
}

test("two reviewed logical commits preserve unrelated staging and do not push or run hooks", async (t) => {
  const { cwd, remote, head } = await repository(t);
  await fs.writeFile(path.join(cwd, "feature.txt"), "feature after\n");
  await fs.writeFile(path.join(cwd, "guide.txt"), "guide after\n");
  await fs.writeFile(path.join(cwd, "unrelated.txt"), "staged unrelated\n");
  await git(cwd, "add", "unrelated.txt");
  await fs.writeFile(path.join(cwd, "unstaged.txt"), "unstaged unrelated\n");
  await fs.writeFile(path.join(cwd, ".gitattributes"), "feature.txt filter=danger\n");
  await git(cwd, "config", "filter.danger.clean", "sh -c 'printf triggered > filter-marker; cat'");
  const hook = path.join(cwd, ".git", "hooks", "reference-transaction");
  await fs.writeFile(hook, "#!/bin/sh\nprintf triggered > hook-marker\n", { mode: 0o755 });
  const groups = [
    { message: "feat: update feature", paths: ["feature.txt"] },
    { message: "docs(guide): update guide", paths: ["guide.txt"] },
  ];
  const preview = await previewAtomicCommits({ cwd, groups });
  assert.deepEqual(preview.groups.map((group) => group.files[0].after), ["feature after\n", "guide after\n"]);
  assert.equal(await git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(await git(cwd, "diff", "--cached", "--name-only"), "unrelated.txt");
  const missingApproval = await applyAtomicCommits({ cwd, groups, reviewCode: preview.reviewCode });
  assert.equal(missingApproval.status, "approval_required");
  const missingScope = await applyAtomicCommits({ cwd, groups, reviewCode: preview.reviewCode, approved: true });
  assert.equal(missingScope.outcome, "clarification_required");
  assert.equal(await git(cwd, "rev-parse", "HEAD"), head);
  const result = await applyAtomicCommits({ cwd, groups, reviewCode: preview.reviewCode, approved: true,
    permission: permissionContext({ mode: "safe", authorizedPaths: ["git/commits/feature.txt", "git/commits/guide.txt"] }) });
  assert.equal(result.status, "committed");
  assert.equal(result.pushed, false);
  await assert.rejects(fs.stat(path.join(cwd, "hook-marker")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(cwd, "filter-marker")), { code: "ENOENT" });
  assert.deepEqual(result.commits.map((commit) => commit.message), groups.map((group) => group.message));
  assert.deepEqual((await git(cwd, "log", "-2", "--format=%s")).split("\n"), [groups[1].message, groups[0].message]);
  assert.equal(await git(cwd, "show", "--format=", "--name-only", "HEAD"), "guide.txt");
  assert.equal(await git(cwd, "show", "--format=", "--name-only", "HEAD^"), "feature.txt");
  assert.equal(await git(cwd, "diff", "--cached", "--name-only"), "unrelated.txt");
  assert.equal(await git(cwd, "diff", "--name-only"), "unstaged.txt");
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), head);
});

test("stale previews and invalid groups create no commit", async (t) => {
  const { cwd, head } = await repository(t);
  const groups = [{ message: "fix: change feature", paths: ["feature.txt"] }];
  await fs.writeFile(path.join(cwd, "feature.txt"), "first revision\n");
  const preview = await previewAtomicCommits({ cwd, groups });
  await fs.writeFile(path.join(cwd, "feature.txt"), "second revision\n");
  const result = await applyAtomicCommits({ cwd, groups, reviewCode: preview.reviewCode, approved: true,
    permission: permissionContext({ authorizedPaths: ["git/commits/feature.txt"] }) });
  assert.equal(result.status, "stale_preview");
  assert.equal(await git(cwd, "rev-parse", "HEAD"), head);
  await assert.rejects(previewAtomicCommits({ cwd, groups: [{ message: "not conventional", paths: ["feature.txt"] }] }), /Conventional Commit/);
  await assert.rejects(previewAtomicCommits({ cwd, groups: [...groups, { message: "docs: again", paths: ["feature.txt"] }] }), /more than one group/);
  await fs.symlink("feature.txt", path.join(cwd, "linked.txt"));
  await assert.rejects(previewAtomicCommits({ cwd, groups: [{ message: "fix: link", paths: ["linked.txt"] }] }));
  assert.equal(await git(cwd, "rev-parse", "HEAD"), head);
});

test("reviewed additions and deletions commit exact paths", async (t) => {
  const { cwd } = await repository(t);
  await fs.writeFile(path.join(cwd, "new.txt"), "new content\n");
  await fs.rm(path.join(cwd, "delete.txt"));
  const groups = [{ message: "chore: replace fixture", paths: ["new.txt", "delete.txt"] }];
  const preview = await previewAtomicCommits({ cwd, groups });
  assert.deepEqual(preview.groups[0].files.map((file) => file.action), ["add", "delete"]);
  const result = await applyAtomicCommits({ cwd, groups, reviewCode: preview.reviewCode, approved: true,
    permission: permissionContext({ authorizedPaths: ["git/commits/new.txt", "git/commits/delete.txt"] }) });
  assert.equal(result.status, "committed");
  assert.deepEqual((await git(cwd, "show", "--format=", "--name-only", "HEAD")).split("\n"), ["delete.txt", "new.txt"]);
  assert.equal(await git(cwd, "status", "--porcelain"), "");
});

test("an index lock reports an already-created commit without pretending rollback", async (t) => {
  const { cwd, remote, head } = await repository(t);
  await fs.writeFile(path.join(cwd, "feature.txt"), "reviewed\n");
  const groups = [{ message: "fix: update feature", paths: ["feature.txt"] }];
  const preview = await previewAtomicCommits({ cwd, groups });
  const lock = path.join(cwd, ".git", "index.lock");
  await fs.writeFile(lock, "locked");
  t.after(() => fs.rm(lock, { force: true }));
  const result = await applyAtomicCommits({ cwd, groups, reviewCode: preview.reviewCode, approved: true,
    permission: permissionContext({ authorizedPaths: ["git/commits/feature.txt"] }) });
  assert.equal(result.status, "partial");
  assert.equal(result.commits.length, 1);
  assert.match(result.reason, /index update failed/);
  assert.equal(await git(cwd, "rev-parse", "HEAD"), result.commits[0].oid);
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), head);
});
