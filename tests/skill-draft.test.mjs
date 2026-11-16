import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { approveMemoryNote, buildPreferenceSnapshot, memoryApprovalTarget, previewMemoryNote, revokeMemoryNote } from "../src/memory-approvals.mjs";
import { createMemoryVault, memoryVaultTargets } from "../src/memory-vault.mjs";
import { permissionContext } from "../src/permissions.mjs";
import { createSkillDraft, previewSkillDraft, skillDraftTarget } from "../src/skill-draft.mjs";

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pify-skill-draft-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const vaultPath = path.join(root, "vault");
  const drafts = path.join(root, "drafts");
  await Promise.all([fs.mkdir(agentDir), fs.mkdir(drafts)]);
  await createMemoryVault({ agentDir, vaultPath, permission: permissionContext({ authorizedPaths: memoryVaultTargets(vaultPath) }) });
  const relativePath = "03-reference/procedures/check-build.md";
  const original = "# Check build\n\nRun the focused tests.\n";
  await fs.writeFile(path.join(vaultPath, relativePath), original);
  const destinationDir = path.join(drafts, "check-build");
  return { root, agentDir, vaultPath, relativePath, original, destinationDir };
}

async function approve({ agentDir, vaultPath, relativePath }) {
  const preview = await previewMemoryNote({ agentDir, relativePath });
  assert.equal(preview.scope, "procedure");
  return approveMemoryNote({ agentDir, relativePath, reviewCode: preview.reviewCode,
    permission: permissionContext({ authorizedPaths: [memoryApprovalTarget(vaultPath, relativePath)] }) });
}

function draftPermission(vaultPath, relativePath, destinationDir) {
  return permissionContext({ authorizedPaths: [skillDraftTarget(vaultPath, relativePath, destinationDir)] });
}

test("only a locally approved procedure creates an inactive draft in the chosen directory", async (t) => {
  const setup = await fixture(t);
  const { agentDir, vaultPath, relativePath, original, destinationDir } = setup;
  await assert.rejects(previewSkillDraft({ agentDir, relativePath, destinationDir }), /not approved/);
  await approve(setup);
  const snapshot = await buildPreferenceSnapshot({ agentDir, projectDir: setup.root });
  assert.equal(snapshot.text, "");
  assert.deepEqual(snapshot.entries, []);
  const preview = await previewSkillDraft({ agentDir, relativePath, destinationDir });
  assert.match(preview.content, /disable-model-invocation: true/);
  assert.match(preview.content, /Run the focused tests/);
  await assert.rejects(fs.lstat(destinationDir), { code: "ENOENT" });
  const denied = await createSkillDraft({ agentDir, relativePath, destinationDir, reviewCode: preview.reviewCode,
    permission: permissionContext() });
  assert.equal(denied.outcome, "clarification_required");
  await assert.rejects(fs.lstat(destinationDir), { code: "ENOENT" });
  const result = await createSkillDraft({ agentDir, relativePath, destinationDir, reviewCode: preview.reviewCode,
    permission: draftPermission(vaultPath, relativePath, destinationDir) });
  assert.equal(result.status, "draft_created");
  assert.equal(result.active, false);
  assert.equal(await fs.readFile(result.draftPath, "utf8"), preview.content);
  assert.equal((await fs.stat(result.draftPath)).mode & 0o777, 0o600);
  await assert.rejects(fs.lstat(path.join(destinationDir, "SKILL.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(vaultPath, relativePath), "utf8"), original);
  assert.equal((await buildPreferenceSnapshot({ agentDir, projectDir: setup.root })).text, "");
});

test("edits, revocation, and destination conflicts stop draft promotion", async (t) => {
  const setup = await fixture(t);
  const { agentDir, vaultPath, relativePath, destinationDir } = setup;
  await approve(setup);
  const preview = await previewSkillDraft({ agentDir, relativePath, destinationDir });
  await fs.appendFile(path.join(vaultPath, relativePath), "Check lint.\n");
  await assert.rejects(createSkillDraft({ agentDir, relativePath, destinationDir, reviewCode: preview.reviewCode,
    permission: draftPermission(vaultPath, relativePath, destinationDir) }), /changed/);
  await assert.rejects(fs.lstat(destinationDir), { code: "ENOENT" });
  await approve(setup);
  const revised = await previewSkillDraft({ agentDir, relativePath, destinationDir });
  await assert.rejects(createSkillDraft({ agentDir, relativePath, destinationDir, reviewCode: preview.reviewCode,
    permission: draftPermission(vaultPath, relativePath, destinationDir) }), /changed after review/);
  await fs.mkdir(destinationDir);
  await fs.writeFile(path.join(destinationDir, "SKILL.md"), "existing active skill\n");
  await assert.rejects(createSkillDraft({ agentDir, relativePath, destinationDir, reviewCode: revised.reviewCode,
    permission: draftPermission(vaultPath, relativePath, destinationDir) }), /already contains SKILL.md/);
  assert.equal(await fs.readFile(path.join(destinationDir, "SKILL.md"), "utf8"), "existing active skill\n");
  await fs.rm(path.join(destinationDir, "SKILL.md"));
  await revokeMemoryNote({ agentDir, relativePath,
    permission: permissionContext({ authorizedPaths: [memoryApprovalTarget(vaultPath, relativePath)] }) });
  await assert.rejects(previewSkillDraft({ agentDir, relativePath, destinationDir }), /not approved/);
});

test("draft destination is bounded and never replaces an existing file", async (t) => {
  const setup = await fixture(t);
  const { agentDir, vaultPath, relativePath, destinationDir } = setup;
  await approve(setup);
  await assert.rejects(previewSkillDraft({ agentDir, relativePath, destinationDir: path.join(vaultPath, "03-reference", "procedures", "draft") }), /outside the memory vault/);
  await assert.rejects(previewSkillDraft({ agentDir, relativePath, destinationDir: path.join(setup.root, "drafts", "Bad Name") }), /lowercase skill slug/);
  const preview = await previewSkillDraft({ agentDir, relativePath, destinationDir });
  await fs.mkdir(destinationDir);
  await fs.writeFile(path.join(destinationDir, "SKILL.pify-draft.md"), "personal draft\n");
  await assert.rejects(createSkillDraft({ agentDir, relativePath, destinationDir, reviewCode: preview.reviewCode,
    permission: draftPermission(vaultPath, relativePath, destinationDir) }), /already contains SKILL.pify-draft.md/);
  assert.equal(await fs.readFile(path.join(destinationDir, "SKILL.pify-draft.md"), "utf8"), "personal draft\n");
});
