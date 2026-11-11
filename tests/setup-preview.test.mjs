import assert from "node:assert/strict";
import { cp, link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { formatSetupPreview, previewGitSetup, previewGitUpdateSetup, previewLocalSetup, verifyGitSetup, verifyLocalSetup } from "../src/setup-preview.mjs";

const GIT_COMMIT = "a".repeat(40);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pify-setup-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const packageRoot = path.join(root, "package");
  await mkdir(agentDir);
  await mkdir(path.join(packageRoot, "extensions"), { recursive: true });
  await mkdir(path.join(packageRoot, "skills", "pify-debug"), { recursive: true });
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  await mkdir(path.join(packageRoot, "templates"), { recursive: true });
  await mkdir(path.join(packageRoot, "themes"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@fnayou/pify", version: "2026.11.4", private: true,
    pi: { extensions: ["extensions/pify.js"], skills: ["skills/pify-debug"], prompts: [], themes: ["themes/pify.json"] },
  }));
  await writeFile(path.join(packageRoot, "extensions", "pify.js"), "export default () => {};\n");
  await writeFile(path.join(packageRoot, "src", "helper.mjs"), "export const ready = true;\n");
  await writeFile(path.join(packageRoot, "skills", "pify-debug", "SKILL.md"), "# Package skill\n");
  await writeFile(path.join(packageRoot, "templates", "workflow.md"), "# Workflow\n");
  await writeFile(path.join(packageRoot, "themes", "pify.json"), "{}\n");
  return { root, agentDir, packageRoot };
}

test("local setup preview reports package, collisions, and theme without changing Pi state", async (t) => {
  const { agentDir, packageRoot } = await fixture(t);
  await mkdir(path.join(agentDir, "skills", "pify-debug"), { recursive: true });
  const skill = path.join(agentDir, "skills", "pify-debug", "SKILL.md");
  await writeFile(skill, "private user skill\n");
  const settingsFile = path.join(agentDir, "settings.json");
  await writeFile(settingsFile, JSON.stringify({ packages: ["/other/package"], apiKey: "SECRET_NOT_FOR_REPORT" }));
  const before = [await readFile(settingsFile), await readFile(skill)];

  const report = await previewLocalSetup({ agentDir, packageRoot });
  assert.equal(report.piRegistration.action, "add_local_package_declaration");
  assert.deepEqual(report.firstInteractiveTheme, { action: "select_pify", reason: "no saved theme" });
  assert.equal(report.package.resources.length, 3);
  assert.deepEqual(report.package.resources.find((item) => item.kind === "skills").collision, { status: "present", type: "directory" });
  assert.equal(report.package.resources.find((item) => item.kind === "skills").precedence, "not_verified");
  assert.match(formatSetupPreview(report), /No installation performed/);
  assert.equal(JSON.stringify(report).includes("SECRET_NOT_FOR_REPORT"), false);
  assert.deepEqual([await readFile(settingsFile), await readFile(skill)], before);
  assert.equal((await previewLocalSetup({ agentDir, packageRoot })).source.declaredResourceDigest, report.source.declaredResourceDigest);
  assert.match(report.source.runtimeDigest, /^[a-f0-9]{64}$/);
  assert.match(report.source.reviewCode, /^[a-f0-9]{64}$/);

  await writeFile(settingsFile, JSON.stringify({ packages: [packageRoot], theme: "system" }));
  const installed = await previewLocalSetup({ agentDir, packageRoot });
  assert.equal(installed.piRegistration.action, "already_declared");
  assert.deepEqual(installed.firstInteractiveTheme, { action: "preserve", savedTheme: "system" });
});

test("review code binds the local directory and imported runtime code; verification reads only", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const preview = await previewLocalSetup(first);
  const secondPreview = await previewLocalSetup(second);
  assert.equal(preview.source.runtimeDigest, secondPreview.source.runtimeDigest);
  assert.notEqual(preview.source.reviewCode, secondPreview.source.reviewCode);
  assert.equal((await verifyLocalSetup({ ...first, expectedReviewCode: preview.source.reviewCode })).status, "not_installed");

  const settingsFile = path.join(first.agentDir, "settings.json");
  await writeFile(settingsFile, JSON.stringify({ packages: [first.packageRoot], apiKey: "PRIVATE_TEST_VALUE" }));
  const before = await readFile(settingsFile);
  const verified = await verifyLocalSetup({ ...first, expectedReviewCode: preview.source.reviewCode });
  assert.equal(verified.status, "verified");
  assert.equal(JSON.stringify(verified).includes("PRIVATE_TEST_VALUE"), false);
  assert.deepEqual(await readFile(settingsFile), before);

  await writeFile(path.join(first.packageRoot, "src", "helper.mjs"), "export const ready = false;\n");
  const changed = await previewLocalSetup(first);
  assert.equal(changed.source.declaredResourceDigest, preview.source.declaredResourceDigest);
  assert.notEqual(changed.source.runtimeDigest, preview.source.runtimeDigest);
  assert.equal((await verifyLocalSetup({ ...first, expectedReviewCode: preview.source.reviewCode })).status, "mismatch");
  assert.deepEqual(await readFile(settingsFile), before);

  await writeFile(path.join(second.agentDir, "settings.json"), JSON.stringify({ packages: [second.packageRoot] }));
  assert.equal((await verifyLocalSetup({ ...second, expectedReviewCode: preview.source.reviewCode })).status, "mismatch");
});

test("Git review code compares runtime bytes across reviewed and managed paths", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  for (const item of [first, second]) {
    await mkdir(path.join(item.packageRoot, ".git"));
    await writeFile(path.join(item.packageRoot, ".git", "HEAD"), `${GIT_COMMIT}\n`);
  }
  const settingsFile = path.join(first.agentDir, "settings.json");
  await writeFile(settingsFile, JSON.stringify({ packages: [], apiKey: "PRIVATE_TEST_VALUE" }));
  const settingsBefore = await readFile(settingsFile);
  const preview = await previewGitSetup({ ...first, commit: GIT_COMMIT });
  const otherPreview = await previewGitSetup({ ...second, commit: GIT_COMMIT });
  assert.equal(preview.schema, "pify.git-setup-preview/v1");
  assert.equal(preview.piRegistration.action, "add_pinned_git_declaration");
  assert.equal(preview.source.origin, "not_verified");
  assert.equal(preview.source.reviewCode, otherPreview.source.reviewCode);
  assert.notEqual(preview.source.reviewCode, (await previewLocalSetup(first)).source.reviewCode);
  assert.equal(JSON.stringify(preview).includes("PRIVATE_TEST_VALUE"), false);
  assert.deepEqual(await readFile(settingsFile), settingsBefore);

  const managed = path.join(first.agentDir, "git", "github.com", "fnayou", "pify");
  await mkdir(path.dirname(managed), { recursive: true });
  await cp(first.packageRoot, managed, { recursive: true });
  await writeFile(settingsFile, JSON.stringify({ packages: [{ source: `git:github.com/fnayou/pify@${GIT_COMMIT}`, skills: [] }], apiKey: "PRIVATE_TEST_VALUE" }));
  const installedSettings = await readFile(settingsFile);
  const verified = await verifyGitSetup({ agentDir: first.agentDir, packageRoot: managed, commit: GIT_COMMIT, expectedReviewCode: preview.source.reviewCode });
  assert.equal(verified.status, "verified");
  assert.equal(verified.piRegistration.declaration, "exact");
  assert.equal(JSON.stringify(verified).includes("PRIVATE_TEST_VALUE"), false);
  assert.deepEqual(await readFile(settingsFile), installedSettings);

  await writeFile(path.join(managed, "src", "helper.mjs"), "export const ready = false;\n");
  assert.equal((await verifyGitSetup({ agentDir: first.agentDir, packageRoot: managed, commit: GIT_COMMIT, expectedReviewCode: preview.source.reviewCode })).status, "mismatch");
  await writeFile(path.join(managed, "src", "helper.mjs"), "export const ready = true;\n");
  await writeFile(path.join(managed, ".git", "HEAD"), `${"b".repeat(40)}\n`);
  assert.equal((await verifyGitSetup({ agentDir: first.agentDir, packageRoot: managed, commit: GIT_COMMIT, expectedReviewCode: preview.source.reviewCode })).status, "mismatch");
  await writeFile(path.join(managed, ".git", "HEAD"), `${GIT_COMMIT}\n`);
  await writeFile(settingsFile, JSON.stringify({ packages: [`git:github.com/fnayou/pify@${"b".repeat(40)}`] }));
  assert.equal((await verifyGitSetup({ agentDir: first.agentDir, packageRoot: managed, commit: GIT_COMMIT, expectedReviewCode: preview.source.reviewCode })).status, "mismatch");
  await writeFile(settingsFile, JSON.stringify({ packages: [] }));
  assert.equal((await verifyGitSetup({ agentDir: first.agentDir, packageRoot: managed, commit: GIT_COMMIT, expectedReviewCode: preview.source.reviewCode })).status, "not_installed");
});

test("Git preview requires a detached full commit and reports conflicting declarations", async (t) => {
  const { root, agentDir, packageRoot } = await fixture(t);
  await mkdir(path.join(packageRoot, ".git"));
  const head = path.join(packageRoot, ".git", "HEAD");
  await writeFile(head, "ref: refs/heads/main\n");
  await assert.rejects(previewGitSetup({ agentDir, packageRoot, commit: GIT_COMMIT }), /Expected a detached Git checkout/);
  await assert.rejects(previewGitSetup({ agentDir, packageRoot, commit: "main" }), /full lowercase Git commit/);
  await rm(head);
  await symlink(path.join(root, "outside-head"), head);
  await writeFile(path.join(root, "outside-head"), `${GIT_COMMIT}\n`);
  await assert.rejects(previewGitSetup({ agentDir, packageRoot, commit: GIT_COMMIT }), /Expected a detached Git checkout/);
  await rm(head);
  await writeFile(head, `${GIT_COMMIT}\n`);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["git:github.com/fnayou/pify@main"] }));
  assert.equal((await previewGitSetup({ agentDir, packageRoot, commit: GIT_COMMIT })).piRegistration.action, "conflict");
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@fnayou/pify@2026.11.4"] }));
  assert.equal((await previewGitSetup({ agentDir, packageRoot, commit: GIT_COMMIT })).piRegistration.action, "conflict");
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
  assert.equal((await previewGitSetup({ agentDir, packageRoot, commit: GIT_COMMIT })).piRegistration.action, "conflict");
});

test("Git update preview requires the exact reviewed installed pin and changes nothing", async (t) => {
  const old = await fixture(t);
  const next = await fixture(t);
  const nextCommit = "b".repeat(40);
  await mkdir(path.join(old.packageRoot, ".git"));
  await writeFile(path.join(old.packageRoot, ".git", "HEAD"), `${GIT_COMMIT}\n`);
  await mkdir(path.join(next.packageRoot, ".git"));
  await writeFile(path.join(next.packageRoot, ".git", "HEAD"), `${nextCommit}\n`);
  const oldReview = (await previewGitSetup({ agentDir: old.agentDir, packageRoot: old.packageRoot, commit: GIT_COMMIT })).source.reviewCode;
  const managed = path.join(old.agentDir, "git", "github.com", "fnayou", "pify");
  await mkdir(path.dirname(managed), { recursive: true });
  await cp(old.packageRoot, managed, { recursive: true });
  const settingsFile = path.join(old.agentDir, "settings.json");
  const source = `git:github.com/fnayou/pify@${GIT_COMMIT}`;
  await writeFile(settingsFile, JSON.stringify({ packages: ["/other/package", source], apiKey: "PRIVATE_TEST_VALUE" }));
  const before = [await readFile(settingsFile), await readFile(path.join(managed, "src", "helper.mjs"))];

  const input = { agentDir: old.agentDir, packageRoot: next.packageRoot,
    fromCommit: GIT_COMMIT, fromReviewCode: oldReview, toCommit: nextCommit };
  const report = await previewGitUpdateSetup(input);
  assert.equal(report.schema, "pify.git-update-preview/v1");
  assert.equal(report.piRegistration.action, "replace_pinned_git_declaration");
  assert.equal(report.piRegistration.fromSource, source);
  assert.equal(report.piRegistration.toSource, `git:github.com/fnayou/pify@${nextCommit}`);
  assert.deepEqual(report.transition, { fromCommit: GIT_COMMIT, toCommit: nextCommit, backupRequired: true });
  assert.match(report.source.reviewCode, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(report).includes("PRIVATE_TEST_VALUE"), false);
  assert.deepEqual([await readFile(settingsFile), await readFile(path.join(managed, "src", "helper.mjs"))], before);

  await assert.rejects(previewGitUpdateSetup({ ...input, fromReviewCode: "0".repeat(64) }), /no longer matches/);
  await assert.rejects(previewGitUpdateSetup({ ...input, toCommit: GIT_COMMIT }), /different commit/);
  await writeFile(path.join(managed, "src", "helper.mjs"), "export const changed = true;\n");
  await assert.rejects(previewGitUpdateSetup(input), /no longer matches/);
  await writeFile(path.join(managed, "src", "helper.mjs"), before[1]);
  await writeFile(settingsFile, JSON.stringify({ packages: [source, source] }));
  await assert.rejects(previewGitUpdateSetup(input), /no longer matches/);
  await writeFile(settingsFile, JSON.stringify({ packages: [source, "npm:@fnayou/pify@2026.11.4"] }));
  await assert.rejects(previewGitUpdateSetup(input), /no longer matches/);
  await writeFile(settingsFile, JSON.stringify({ packages: [] }));
  await assert.rejects(previewGitUpdateSetup(input), /no longer matches/);
});

test("runtime source digest refuses linked imported files", async (t) => {
  const { root, agentDir, packageRoot } = await fixture(t);
  const outside = path.join(root, "outside.mjs");
  await writeFile(outside, "export const outside = true;\n");
  await symlink(outside, path.join(packageRoot, "src", "linked.mjs"));
  await assert.rejects(previewLocalSetup({ agentDir, packageRoot }), /Symlinked runtime source/);
  await rm(path.join(packageRoot, "src", "linked.mjs"));
  await link(outside, path.join(packageRoot, "src", "linked.mjs"));
  await assert.rejects(previewLocalSetup({ agentDir, packageRoot }), /Unsafe runtime source/);
});

test("runtime source digest refuses an oversized imported file", async (t) => {
  const { agentDir, packageRoot } = await fixture(t);
  await writeFile(path.join(packageRoot, "src", "large.mjs"), new Uint8Array(2 * 1024 * 1024 + 1));
  await assert.rejects(previewLocalSetup({ agentDir, packageRoot }), /Package file exceeds preview limit/);
});

test("preview does not follow symlinked resource paths", async (t) => {
  const { root, agentDir, packageRoot } = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(agentDir, "skills"));
  const report = await previewLocalSetup({ agentDir, packageRoot });
  assert.equal(report.package.resources.find((item) => item.kind === "skills").collision.status, "unsafe_parent");
  await symlink(path.join(root, "outside"), path.join(packageRoot, "skills", "pify-debug", "linked"));
  await assert.rejects(previewLocalSetup({ agentDir, packageRoot }), /Symlinked package resource/);
});

test("invalid Pi settings fail without echoing their contents", async (t) => {
  const { agentDir, packageRoot } = await fixture(t);
  await writeFile(path.join(agentDir, "settings.json"), '{"apiKey":"SECRET_NOT_FOR_REPORT",');
  await assert.rejects(previewLocalSetup({ agentDir, packageRoot }), (error) => {
    assert.equal(error.message, "Pi settings are invalid JSON");
    return true;
  });
});
