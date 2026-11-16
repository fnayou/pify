import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  approveMemoryNote, buildPreferenceSnapshot, memoryApprovalTarget, previewMemoryNote, revokeMemoryNote,
} from "../src/memory-approvals.mjs";
import { createMemoryVault, memoryVaultTargets, skipMemoryVault } from "../src/memory-vault.mjs";
import { permissionContext } from "../src/permissions.mjs";

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pify-memory-approval-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const vaultPath = path.join(root, "vault");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await Promise.all([fs.mkdir(agentDir), fs.mkdir(first), fs.mkdir(second)]);
  await createMemoryVault({ agentDir, vaultPath, permission: permissionContext({ authorizedPaths: memoryVaultTargets(vaultPath) }) });
  return { root, agentDir, vaultPath, first, second };
}

function approvalPermission(vaultPath, relativePath) {
  return permissionContext({ authorizedPaths: [memoryApprovalTarget(vaultPath, relativePath)] });
}

test("only a locally reviewed note enters the preference snapshot", async (t) => {
  const { agentDir, vaultPath, first } = await fixture(t);
  const approvedPath = "01-global/preferences/editor.md";
  const newPath = "01-global/preferences/synced.md";
  await fs.writeFile(path.join(vaultPath, approvedPath), "Use concise commit messages.\n");
  const preview = await previewMemoryNote({ agentDir, relativePath: approvedPath, projectDir: first });
  assert.equal(preview.scope, "global");
  assert.equal((await buildPreferenceSnapshot({ agentDir, projectDir: first })).text, "");
  const denied = await approveMemoryNote({ agentDir, relativePath: approvedPath, projectDir: first,
    reviewCode: preview.reviewCode, permission: permissionContext() });
  assert.equal(denied.outcome, "clarification_required");
  assert.equal((await buildPreferenceSnapshot({ agentDir, projectDir: first })).text, "");
  await approveMemoryNote({ agentDir, relativePath: approvedPath, projectDir: first,
    reviewCode: preview.reviewCode, permission: approvalPermission(vaultPath, approvedPath) });
  await fs.writeFile(path.join(vaultPath, newPath), "Unreviewed synced text.\n");
  const snapshot = await buildPreferenceSnapshot({ agentDir, projectDir: first });
  assert.match(snapshot.text, /Use concise commit messages/);
  assert.doesNotMatch(snapshot.text, /Unreviewed synced text/);
  assert.deepEqual(snapshot.entries, [{ relativePath: approvedPath, scope: "global" }]);
  const registry = path.join(agentDir, "pify-state", "memory-approvals.json");
  assert.equal((await fs.stat(registry)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(registry))).mode & 0o777, 0o700);
  await assert.rejects(fs.lstat(path.join(vaultPath, "memory-approvals.json")), { code: "ENOENT" });
});

test("edit, move, scope change, and revoke each remove stale preferences", async (t) => {
  const { agentDir, vaultPath, first, second } = await fixture(t);
  const globalPath = "01-global/preferences/workflow.md";
  const projectPath = "02-projects/sample/context/workflow.md";
  await fs.writeFile(path.join(vaultPath, globalPath), "Always use the project issue.\n");
  const original = await previewMemoryNote({ agentDir, relativePath: globalPath, projectDir: first });
  await approveMemoryNote({ agentDir, relativePath: globalPath, projectDir: first,
    reviewCode: original.reviewCode, permission: approvalPermission(vaultPath, globalPath) });
  await fs.appendFile(path.join(vaultPath, globalPath), "Edited later.\n");
  assert.equal((await buildPreferenceSnapshot({ agentDir, projectDir: first })).entries.length, 0);
  await assert.rejects(approveMemoryNote({ agentDir, relativePath: globalPath, projectDir: first,
    reviewCode: original.reviewCode, permission: approvalPermission(vaultPath, globalPath) }), /changed after review/);
  const revised = await previewMemoryNote({ agentDir, relativePath: globalPath, projectDir: first });
  await approveMemoryNote({ agentDir, relativePath: globalPath, projectDir: first,
    reviewCode: revised.reviewCode, permission: approvalPermission(vaultPath, globalPath) });
  assert.equal((await buildPreferenceSnapshot({ agentDir, projectDir: first })).entries.length, 1);

  await fs.mkdir(path.dirname(path.join(vaultPath, projectPath)), { recursive: true });
  await fs.rename(path.join(vaultPath, globalPath), path.join(vaultPath, projectPath));
  assert.equal((await buildPreferenceSnapshot({ agentDir, projectDir: first })).entries.length, 0);
  const moved = await previewMemoryNote({ agentDir, relativePath: projectPath, projectDir: first });
  assert.equal(moved.scope, "project");
  assert.equal(moved.projectPath, first);
  assert.notEqual(moved.reviewCode, revised.reviewCode);
  await approveMemoryNote({ agentDir, relativePath: projectPath, projectDir: first,
    reviewCode: moved.reviewCode, permission: approvalPermission(vaultPath, projectPath) });
  assert.deepEqual((await buildPreferenceSnapshot({ agentDir, projectDir: first })).entries,
    [{ relativePath: projectPath, scope: "project" }]);
  assert.equal((await buildPreferenceSnapshot({ agentDir, projectDir: second })).entries.length, 0);
  assert.equal((await revokeMemoryNote({ agentDir, relativePath: projectPath,
    permission: approvalPermission(vaultPath, projectPath) })).status, "revoked");
  assert.equal((await buildPreferenceSnapshot({ agentDir, projectDir: first })).entries.length, 0);
  assert.match(await fs.readFile(path.join(vaultPath, projectPath), "utf8"), /Edited later/);
});

test("inbox and unsafe notes never enter applied preferences", async (t) => {
  const { agentDir, vaultPath, first, root } = await fixture(t);
  const inboxPath = "00-inbox/proposal.md";
  await fs.writeFile(path.join(vaultPath, inboxPath), "Proposal only.\n");
  const preview = await previewMemoryNote({ agentDir, relativePath: inboxPath, projectDir: first });
  assert.equal(preview.scope, "inactive");
  await assert.rejects(approveMemoryNote({ agentDir, relativePath: inboxPath, projectDir: first,
    reviewCode: preview.reviewCode, permission: approvalPermission(vaultPath, inboxPath) }), /cannot become automatic/);
  await assert.rejects(previewMemoryNote({ agentDir, relativePath: "../outside.md", projectDir: first }), /without traversal/);
  const outside = path.join(root, "outside.md");
  await fs.writeFile(outside, "Outside data.\n");
  const linkedPath = "01-global/preferences/linked.md";
  await fs.symlink(outside, path.join(vaultPath, linkedPath));
  await assert.rejects(previewMemoryNote({ agentDir, relativePath: linkedPath, projectDir: first }));
  const oversizedPath = "01-global/preferences/oversized.md";
  await fs.writeFile(path.join(vaultPath, oversizedPath), "x".repeat(4097));
  await assert.rejects(previewMemoryNote({ agentDir, relativePath: oversizedPath, projectDir: first }), /oversized/);
  const controlPath = "01-global/preferences/control.md";
  await fs.writeFile(path.join(vaultPath, controlPath), "unsafe\u001b[31m");
  await assert.rejects(previewMemoryNote({ agentDir, relativePath: controlPath, projectDir: first }), /control characters/);
  assert.equal((await buildPreferenceSnapshot({ agentDir, projectDir: first })).text, "");
});
test("skip and unavailable vaults apply no approved note", async (t) => {
  const { root, agentDir, vaultPath, first } = await fixture(t);
  const relativePath = "01-global/preferences/choice.md";
  await fs.writeFile(path.join(vaultPath, relativePath), "Keep this preference.\n");
  const preview = await previewMemoryNote({ agentDir, relativePath, projectDir: first });
  await approveMemoryNote({ agentDir, relativePath, projectDir: first,
    reviewCode: preview.reviewCode, permission: approvalPermission(vaultPath, relativePath) });
  await fs.rename(vaultPath, path.join(root, "offline"));
  assert.equal((await buildPreferenceSnapshot({ agentDir, projectDir: first })).status, "unavailable");
  await skipMemoryVault({ agentDir, permission: permissionContext({ authorizedPaths: ["memory/vault-selection"] }) });
  assert.equal((await buildPreferenceSnapshot({ agentDir, projectDir: first })).status, "skipped");
});

test("an interrupted registry lock blocks approval without activating the note", async (t) => {
  const { agentDir, vaultPath, first } = await fixture(t);
  const relativePath = "01-global/preferences/locked.md";
  await fs.writeFile(path.join(vaultPath, relativePath), "Needs approval.\n");
  const preview = await previewMemoryNote({ agentDir, relativePath, projectDir: first });
  await fs.mkdir(path.join(agentDir, "pify-state", ".memory-approvals.lock"));
  await assert.rejects(approveMemoryNote({ agentDir, relativePath, projectDir: first,
    reviewCode: preview.reviewCode, permission: approvalPermission(vaultPath, relativePath) }), /already in progress or interrupted/);
  assert.equal((await buildPreferenceSnapshot({ agentDir, projectDir: first })).text, "");
});
