import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyAdoption, previewAdoption, previewUninstall, rollbackAdoption, uninstallManagedFiles } from "../src/adoption.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pify-adoption-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const externalDir = path.join(root, "external");
  await fs.mkdir(path.join(agentDir, "skills"), { recursive: true });
  await fs.mkdir(path.join(agentDir, "sessions"));
  await fs.mkdir(path.join(agentDir, "themes"));
  await fs.mkdir(externalDir);
  await fs.writeFile(path.join(agentDir, "skills", "personal.md"), "user skill\n", { mode: 0o640 });
  await fs.writeFile(path.join(agentDir, "themes", "personal.json"), "personal theme\n");
  await fs.writeFile(path.join(agentDir, "settings.json"), "user settings\n");
  await fs.writeFile(path.join(agentDir, "auth.json"), "credential-secret\n");
  await fs.writeFile(path.join(agentDir, "sessions", "session.jsonl"), "session-secret\n");
  await fs.writeFile(path.join(externalDir, "secret.txt"), "external-secret\n");
  await fs.symlink(externalDir, path.join(agentDir, "skills", "outside"));
  return { agentDir, externalDir };
}

async function unrelatedSnapshot(agentDir, externalDir) {
  return Promise.all([
    fs.readFile(path.join(agentDir, "settings.json")),
    fs.readFile(path.join(agentDir, "auth.json")),
    fs.readFile(path.join(agentDir, "sessions", "session.jsonl")),
    fs.readFile(path.join(agentDir, "themes", "personal.json")),
    fs.readFile(path.join(externalDir, "secret.txt")),
    fs.readlink(path.join(agentDir, "skills", "outside")),
  ]);
}

test("preview is read-only; unowned customization needs exact approval; rollback restores it", async (t) => {
  const { agentDir, externalDir } = await fixture(t);
  const before = await unrelatedSnapshot(agentDir, externalDir);
  const resources = [
    { relativePath: "skills/personal.md", content: "pify skill\n" },
    { relativePath: "prompts/pify.md", content: "pify prompt\n" },
  ];
  const preview = await previewAdoption({ agentDir, resources });
  assert.deepEqual(preview.changes.map(({ action, reason }) => [action, reason]), [["conflict", "unowned"], ["create", null]]);
  assert.deepEqual(preview.changes[1].parentsToCreate, ["prompts"]);
  await assert.rejects(fs.stat(path.join(agentDir, "pify-state")), { code: "ENOENT" });
  await assert.rejects(applyAdoption({ agentDir, resources, preview }), /Unresolved resource conflict/);
  await assert.rejects(fs.stat(path.join(agentDir, "pify-state")), { code: "ENOENT" });

  const applied = await applyAdoption({ agentDir, resources, preview, approvedConflicts: ["skills/personal.md"] });
  assert.equal(applied.status, "applied");
  assert.equal(await fs.readFile(path.join(agentDir, "skills", "personal.md"), "utf8"), "pify skill\n");
  const backup = path.join(agentDir, "pify-state", "backups", applied.transactions[0], "prior");
  assert.equal(await fs.readFile(backup, "utf8"), "user skill\n");
  assert.equal((await fs.stat(backup)).mode & 0o777, 0o600);
  assert.deepEqual(await unrelatedSnapshot(agentDir, externalDir), before);

  const rolledBack = await rollbackAdoption({ agentDir, transactions: applied.transactions });
  assert.equal(rolledBack.status, "rolled-back");
  assert.equal((await rollbackAdoption({ agentDir, transactions: applied.transactions })).status, "rolled-back");
  assert.equal(await fs.readFile(path.join(agentDir, "skills", "personal.md"), "utf8"), "user skill\n");
  assert.equal((await fs.stat(path.join(agentDir, "skills", "personal.md"))).mode & 0o777, 0o640);
  await assert.rejects(fs.stat(path.join(agentDir, "prompts", "pify.md")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(agentDir, "prompts")), { code: "ENOENT" });
  assert.deepEqual(await unrelatedSnapshot(agentDir, externalDir), before);
});

test("forced failure rolls back all already applied paths", async (t) => {
  const { agentDir } = await fixture(t);
  const resources = [
    { relativePath: "skills/personal.md", content: "new skill\n" },
    { relativePath: "prompts/pify.md", content: "new prompt\n" },
  ];
  const preview = await previewAdoption({ agentDir, resources });
  let appliedCount = 0;
  await assert.rejects(applyAdoption({
    agentDir,
    resources,
    preview,
    approvedConflicts: ["skills/personal.md"],
    onApplied: () => {
      appliedCount += 1;
      if (appliedCount === 2) throw new Error("forced failure");
    },
  }), /Adoption failed: forced failure; rollback rolled-back/);
  assert.equal(appliedCount, 2);
  assert.equal(await fs.readFile(path.join(agentDir, "skills", "personal.md"), "utf8"), "user skill\n");
  await assert.rejects(fs.stat(path.join(agentDir, "prompts", "pify.md")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(agentDir, "prompts")), { code: "ENOENT" });
});

test("uninstall restores adopted files, removes created files, and preserves other Pi data", async (t) => {
  const { agentDir, externalDir } = await fixture(t);
  const before = await unrelatedSnapshot(agentDir, externalDir);
  const resources = [
    { relativePath: "skills/personal.md", content: "pify skill\n" },
    { relativePath: "prompts/pify.md", content: "pify prompt\n" },
  ];
  const preview = await previewAdoption({ agentDir, resources });
  await applyAdoption({ agentDir, resources, preview, approvedConflicts: ["skills/personal.md"] });
  const update = [{ relativePath: "skills/personal.md", content: "pify skill v2\n" }];
  await applyAdoption({ agentDir, resources: update, preview: await previewAdoption({ agentDir, resources: update }) });
  const uninstallPreview = await previewUninstall({ agentDir });
  assert.deepEqual(uninstallPreview.changes.map(({ action }) => action).sort(), ["remove", "restore"]);
  const result = await uninstallManagedFiles({ agentDir, preview: uninstallPreview });
  assert.equal(result.status, "uninstalled");
  assert.equal(await fs.readFile(path.join(agentDir, "skills", "personal.md"), "utf8"), "user skill\n");
  assert.equal((await fs.stat(path.join(agentDir, "skills", "personal.md"))).mode & 0o777, 0o640);
  await assert.rejects(fs.stat(path.join(agentDir, "prompts", "pify.md")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(agentDir, "prompts")), { code: "ENOENT" });
  assert.deepEqual(await unrelatedSnapshot(agentDir, externalDir), before);
  assert.deepEqual((await previewUninstall({ agentDir })).changes, []);
});

test("drift and symlinks stay untouched during preview, adoption, and uninstall", async (t) => {
  const { agentDir, externalDir } = await fixture(t);
  const linked = [{ relativePath: "skills/outside/secret.txt", content: "wrong" }];
  const linkPreview = await previewAdoption({ agentDir, resources: linked });
  assert.match(linkPreview.changes[0].reason, /Symlink/);
  await assert.rejects(applyAdoption({ agentDir, resources: linked, preview: linkPreview, approvedConflicts: ["skills/outside/secret.txt"] }), /Unresolved resource conflict/);
  assert.equal(await fs.readFile(path.join(externalDir, "secret.txt"), "utf8"), "external-secret\n");

  const resources = [{ relativePath: "prompts/pify.md", content: "installed" }];
  const stale = await previewAdoption({ agentDir, resources });
  await fs.mkdir(path.join(agentDir, "prompts"));
  await fs.writeFile(path.join(agentDir, "prompts", "pify.md"), "user appeared");
  await assert.rejects(applyAdoption({ agentDir, resources, preview: stale }), /changed after preview/);
  await fs.rm(path.join(agentDir, "prompts", "pify.md"));
  const current = await previewAdoption({ agentDir, resources });
  await applyAdoption({ agentDir, resources, preview: current });
  await fs.writeFile(path.join(agentDir, "prompts", "pify.md"), "user edit");
  const uninstallPreview = await previewUninstall({ agentDir });
  assert.equal(uninstallPreview.changes[0].action, "conflict");
  const result = await uninstallManagedFiles({ agentDir, preview: uninstallPreview });
  assert.equal(result.status, "partial");
  assert.equal(await fs.readFile(path.join(agentDir, "prompts", "pify.md"), "utf8"), "user edit");
  const transactionId = uninstallPreview.changes[0].lastTransactionId;
  const rollback = await rollbackAdoption({ agentDir, transactions: [transactionId] });
  assert.equal(rollback.status, "recovery-needed");
  assert.equal(await fs.readFile(path.join(agentDir, "prompts", "pify.md"), "utf8"), "user edit");
});

test("failed rollback reports recovery needed and preserves a post-install edit", async (t) => {
  const { agentDir } = await fixture(t);
  const target = path.join(agentDir, "prompts", "pify.md");
  const resources = [{ relativePath: "prompts/pify.md", content: "installed" }];
  const preview = await previewAdoption({ agentDir, resources });
  await assert.rejects(applyAdoption({
    agentDir,
    resources,
    preview,
    onApplied: async () => {
      await fs.writeFile(target, "user edit");
      throw new Error("forced failure");
    },
  }), (error) => error.recovery?.status === "recovery-needed");
  assert.equal(await fs.readFile(target, "utf8"), "user edit");
  assert.equal((await previewUninstall({ agentDir })).changes[0].action, "conflict");
});

test("permission drift after preview blocks adoption before mutation", async (t) => {
  const { agentDir } = await fixture(t);
  const target = path.join(agentDir, "skills", "personal.md");
  const resources = [{ relativePath: "skills/personal.md", content: "installed" }];
  const preview = await previewAdoption({ agentDir, resources });
  await fs.chmod(target, 0o600);
  await assert.rejects(applyAdoption({ agentDir, resources, preview, approvedConflicts: ["skills/personal.md"] }), /changed after preview/);
  assert.equal(await fs.readFile(target, "utf8"), "user skill\n");
  await assert.rejects(fs.stat(path.join(agentDir, "pify-state")), { code: "ENOENT" });
});
