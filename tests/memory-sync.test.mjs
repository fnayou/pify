import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { approveMemoryNote, buildPreferenceSnapshot, memoryApprovalTarget, previewMemoryNote } from "../src/memory-approvals.mjs";
import { connectMemoryVault, createMemoryVault, memoryVaultTargets } from "../src/memory-vault.mjs";
import { memorySyncTarget, previewMemoryPush, pullMemory, pushMemory } from "../src/memory-sync.mjs";
import { permissionContext } from "../src/permissions.mjs";

const execFileAsync = promisify(execFile);
const REPO = "fnayou/pify-memory-fixture";
const REMOTE = `https://github.com/${REPO}.git`;

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pify-memory-sync-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const vaultPath = path.join(root, "vault");
  const bare = path.join(root, "remote.git");
  const config = path.join(root, "gitconfig");
  await fs.mkdir(agentDir);
  await fs.writeFile(config, `[url "file://${bare}"]\n\tinsteadOf = ${REMOTE}\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const run = async (program, args, { cwd = root, encoding = "utf8" } = {}) => {
    if (program === "gh") {
      if (args[0] === "repo" && args[1] === "view") return run.private ? "true\n" : "false\n";
      if (args[0] === "pr" && args[1] === "list") return JSON.stringify(run.pr ? [run.pr] : []);
      if (args[0] === "pr" && args[1] === "create") {
        run.created += 1;
        run.pr = { number: 1, url: `https://github.com/${REPO}/pull/1` };
        return `${run.pr.url}\n`;
      }
      throw new Error(`Unexpected gh command: ${args.join(" ")}`);
    }
    const { stdout } = await execFileAsync(program, args, { cwd, encoding, env, timeout: 10000 });
    return stdout;
  };
  run.private = true;
  run.pr = null;
  run.created = 0;
  await run("git", ["init", "--bare", "--initial-branch=main", bare]);
  await createMemoryVault({ agentDir, vaultPath, permission: permissionContext({ authorizedPaths: memoryVaultTargets(vaultPath) }) });
  await run("git", ["init", "--initial-branch=main"], { cwd: vaultPath });
  await run("git", ["config", "user.name", "Pify Test"], { cwd: vaultPath });
  await run("git", ["config", "user.email", "pify-test@example.invalid"], { cwd: vaultPath });
  await run("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: vaultPath });
  await run("git", ["remote", "add", "origin", REMOTE], { cwd: vaultPath });
  await run("git", ["push", "-u", "origin", "main"], { cwd: vaultPath });
  return { root, agentDir, vaultPath, bare, run };
}

function permission(vaultPath, action) {
  return permissionContext({ authorizedPaths: [memorySyncTarget(vaultPath, action)] });
}

test("push stages only Markdown notes, opens one PR, and leaves origin/main unchanged", async (t) => {
  const { agentDir, vaultPath, run } = await fixture(t);
  const note = "01-global/preferences/example.md";
  await fs.writeFile(path.join(vaultPath, note), "Private memory note.\n");
  await fs.mkdir(path.join(vaultPath, ".obsidian"));
  await fs.writeFile(path.join(vaultPath, ".obsidian", "workspace.md"), "private app state\n");
  await fs.writeFile(path.join(vaultPath, "attachment.png"), "binary attachment");
  const plan = await previewMemoryPush({ agentDir, run });
  assert.deepEqual(plan.changes.map((item) => item.relativePath), [note]);
  assert.deepEqual(plan.excluded.sort(), [".obsidian/workspace.md", "attachment.png"]);
  const before = (await run("git", ["ls-remote", "--heads", "origin", "main"], { cwd: vaultPath })).trim();
  const denied = await pushMemory({ agentDir, reviewCode: plan.reviewCode, permission: permissionContext(), run });
  assert.equal(denied.outcome, "clarification_required");
  assert.equal((await run("git", ["symbolic-ref", "--short", "HEAD"], { cwd: vaultPath })).trim(), "main");
  const result = await pushMemory({ agentDir, reviewCode: plan.reviewCode, permission: permission(vaultPath, "push"), run });
  assert.equal(result.status, "pr_opened");
  assert.equal(run.created, 1);
  assert.equal((await run("git", ["ls-remote", "--heads", "origin", "main"], { cwd: vaultPath })).trim(), before);
  assert.equal((await run("git", ["show", "--pretty=format:", "--name-only", "HEAD"], { cwd: vaultPath })).trim(), note);
  assert.equal(await fs.readFile(path.join(vaultPath, ".obsidian", "workspace.md"), "utf8"), "private app state\n");
  const repeat = await previewMemoryPush({ agentDir, run });
  assert.equal((await pushMemory({ agentDir, reviewCode: repeat.reviewCode, permission: permission(vaultPath, "push"), run })).status, "pending_pr");
  assert.equal(run.created, 1);
});

test("manual merge then fast-forward pull keeps new notes inactive until local approval", async (t) => {
  const { root, agentDir, vaultPath, bare, run } = await fixture(t);
  const second = path.join(root, "second");
  const secondAgent = path.join(root, "second-agent");
  await fs.mkdir(secondAgent);
  await run("git", ["clone", bare, second]);
  await run("git", ["remote", "set-url", "origin", REMOTE], { cwd: second });
  await connectMemoryVault({ agentDir: secondAgent, vaultPath: second,
    permission: permissionContext({ authorizedPaths: memoryVaultTargets(second) }) });
  const note = "01-global/preferences/shared.md";
  await fs.writeFile(path.join(vaultPath, note), "Review on each machine.\n");
  const plan = await previewMemoryPush({ agentDir, run });
  const pushed = await pushMemory({ agentDir, reviewCode: plan.reviewCode, permission: permission(vaultPath, "push"), run });
  assert.equal(pushed.status, "pr_opened");
  const reviewer = path.join(root, "reviewer");
  await run("git", ["clone", bare, reviewer]);
  await run("git", ["fetch", "origin", pushed.branch], { cwd: reviewer });
  await run("git", ["merge", "--ff-only", "FETCH_HEAD"], { cwd: reviewer });
  await run("git", ["push", "origin", "main"], { cwd: reviewer });
  const denied = await pullMemory({ agentDir: secondAgent, permission: permissionContext(), run });
  assert.equal(denied.outcome, "clarification_required");
  assert.equal((await pullMemory({ agentDir: secondAgent, permission: permission(second, "pull"), run })).status, "fast_forwarded");
  assert.equal(await fs.readFile(path.join(second, note), "utf8"), "Review on each machine.\n");
  assert.equal((await buildPreferenceSnapshot({ agentDir: secondAgent, projectDir: second })).entries.length, 0);
  const review = await previewMemoryNote({ agentDir: secondAgent, relativePath: note, projectDir: second });
  await approveMemoryNote({ agentDir: secondAgent, relativePath: note, projectDir: second, reviewCode: review.reviewCode,
    permission: permissionContext({ authorizedPaths: [memoryApprovalTarget(second, note)] }) });
  assert.equal((await buildPreferenceSnapshot({ agentDir: secondAgent, projectDir: second })).entries.length, 1);
  assert.equal((await pullMemory({ agentDir: secondAgent, permission: permission(second, "pull"), run })).status, "up_to_date");
});

test("public GitHub origin and divergent main are refused", async (t) => {
  const { root, agentDir, vaultPath, bare, run } = await fixture(t);
  await fs.writeFile(path.join(vaultPath, "00-inbox", "draft.md"), "Draft.\n");
  run.private = false;
  await assert.rejects(previewMemoryPush({ agentDir, run }), /must be private/);
  run.private = true;
  const other = path.join(root, "other");
  await run("git", ["clone", bare, other]);
  await run("git", ["config", "user.name", "Pify Test"], { cwd: other });
  await run("git", ["config", "user.email", "pify-test@example.invalid"], { cwd: other });
  await fs.writeFile(path.join(other, "README.md"), "Remote change.\n");
  await run("git", ["add", "README.md"], { cwd: other });
  await run("git", ["commit", "-m", "remote change"], { cwd: other });
  await run("git", ["push", "origin", "main"], { cwd: other });
  await assert.rejects(previewMemoryPush({ agentDir, run }), /differs from origin\/main/);
  await fs.writeFile(path.join(vaultPath, "README.md"), "Local change.\n");
  await run("git", ["add", "README.md"], { cwd: vaultPath });
  await run("git", ["commit", "-m", "local change"], { cwd: vaultPath });
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: vaultPath })).trim();
  await assert.rejects(pullMemory({ agentDir, permission: permission(vaultPath, "pull"), run }), /diverged/);
  assert.equal((await run("git", ["rev-parse", "HEAD"], { cwd: vaultPath })).trim(), head);
});

test("pull refuses remote links and leaves local main unchanged", async (t) => {
  const { root, agentDir, vaultPath, bare, run } = await fixture(t);
  const other = path.join(root, "other");
  await run("git", ["clone", bare, other]);
  await run("git", ["config", "user.name", "Pify Test"], { cwd: other });
  await run("git", ["config", "user.email", "pify-test@example.invalid"], { cwd: other });
  await fs.mkdir(path.join(other, "00-inbox"));
  await fs.symlink("../../README.md", path.join(other, "00-inbox", "link.md"));
  await run("git", ["add", "00-inbox/link.md"], { cwd: other });
  await run("git", ["commit", "-m", "remote link"], { cwd: other });
  await run("git", ["push", "origin", "main"], { cwd: other });
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: vaultPath })).trim();
  await assert.rejects(pullMemory({ agentDir, permission: permission(vaultPath, "pull"), run }), /unsupported files or links/);
  assert.equal((await run("git", ["rev-parse", "HEAD"], { cwd: vaultPath })).trim(), head);
});

test("push refuses unsupported commits already on the memory PR branch", async (t) => {
  const { agentDir, vaultPath, run } = await fixture(t);
  await fs.writeFile(path.join(vaultPath, "00-inbox", "note.md"), "Reviewed.\n");
  const plan = await previewMemoryPush({ agentDir, run });
  await pushMemory({ agentDir, reviewCode: plan.reviewCode, permission: permission(vaultPath, "push"), run });
  await fs.writeFile(path.join(vaultPath, "README.md"), "Unreviewed branch file.\n");
  await run("git", ["add", "README.md"], { cwd: vaultPath });
  await run("git", ["commit", "-m", "extra file"], { cwd: vaultPath });
  await assert.rejects(previewMemoryPush({ agentDir, run }), /unsupported changes/);
});

test("push stops before network publish if a local commit hook stages another file", async (t) => {
  const { agentDir, vaultPath, run } = await fixture(t);
  await fs.writeFile(path.join(vaultPath, "00-inbox", "note.md"), "Reviewed.\n");
  await fs.writeFile(path.join(vaultPath, "README.md"), "Unreviewed.\n");
  const hook = path.join(vaultPath, ".git", "hooks", "pre-commit");
  await fs.writeFile(hook, "#!/bin/sh\ngit add README.md\n", { mode: 0o755 });
  const plan = await previewMemoryPush({ agentDir, run });
  await assert.rejects(pushMemory({ agentDir, reviewCode: plan.reviewCode, permission: permission(vaultPath, "push"), run }), /Committed memory paths differ/);
  assert.equal(run.created, 0);
  assert.equal((await run("git", ["ls-remote", "--heads", "origin", "main"], { cwd: vaultPath })).trim().split(/\s+/)[0], plan.upstream);
});
