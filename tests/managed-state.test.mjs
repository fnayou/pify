import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { completeManagedFileChange, digestFile, prepareManagedFileChange } from "../src/managed-state.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pify-state-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const externalDir = path.join(root, "external");
  await fs.mkdir(path.join(agentDir, "skills"), { recursive: true });
  await fs.mkdir(path.join(agentDir, "sessions"));
  await fs.mkdir(externalDir);
  await fs.writeFile(path.join(agentDir, "auth.json"), "credential-secret");
  await fs.writeFile(path.join(agentDir, "sessions", "session.jsonl"), "session-secret");
  await fs.writeFile(path.join(externalDir, "secret.txt"), "external-secret");
  await fs.symlink(externalDir, path.join(agentDir, "skills", "outside"));
  return { agentDir, externalDir };
}

async function manifest(agentDir) {
  return JSON.parse(await fs.readFile(path.join(agentDir, "pify-state", "manifest.json"), "utf8"));
}

test("creates private ownership state before a change and backs up only the owned file", async (t) => {
  const { agentDir } = await fixture(t);
  const relativePath = "skills/pify/SKILL.md";
  const target = path.join(agentDir, relativePath);
  const first = Buffer.from("first version\n");
  const preparedCreate = await prepareManagedFileChange({ agentDir, relativePath, expectedNewDigest: digestFile(first) });

  assert.equal(preparedCreate.action, "create");
  assert.equal(preparedCreate.backupPath, null);
  assert.deepEqual((await manifest(agentDir)).resources, {});
  await assert.rejects(fs.stat(target), { code: "ENOENT" });

  await fs.mkdir(path.dirname(target));
  await fs.writeFile(target, first);
  await completeManagedFileChange({ agentDir, transactionId: preparedCreate.id });
  assert.deepEqual((await manifest(agentDir)).resources[relativePath], {
    owner: "pify",
    kind: "file",
    target: path.join(await fs.realpath(agentDir), relativePath),
    origin: "created",
    digest: digestFile(first),
    lastTransactionId: preparedCreate.id,
  });

  const second = Buffer.from("second version\n");
  const preparedReplace = await prepareManagedFileChange({ agentDir, relativePath, expectedNewDigest: digestFile(second) });
  assert.equal(preparedReplace.action, "replace");
  assert.deepEqual(await fs.readFile(preparedReplace.backupPath), first);
  assert.deepEqual(await fs.readFile(target), first);

  const stateDir = path.join(agentDir, "pify-state");
  for (const directory of [stateDir, path.join(stateDir, "backups"), path.dirname(preparedReplace.backupPath)]) {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  }
  for (const file of [path.join(stateDir, "manifest.json"), preparedReplace.backupPath, path.join(path.dirname(preparedReplace.backupPath), "transaction.json")]) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
  const backupNames = await fs.readdir(path.dirname(preparedReplace.backupPath));
  assert.deepEqual(backupNames.sort(), ["prior", "transaction.json"]);
  const backupText = (await fs.readFile(preparedReplace.backupPath, "utf8")) + (await fs.readFile(path.join(path.dirname(preparedReplace.backupPath), "transaction.json"), "utf8"));
  for (const secret of ["credential-secret", "session-secret", "external-secret"]) {
    assert.equal(backupText.includes(secret), false);
  }

  await fs.writeFile(target, second);
  await completeManagedFileChange({ agentDir, transactionId: preparedReplace.id });
  assert.equal((await manifest(agentDir)).resources[relativePath].digest, digestFile(second));
});

test("refuses unowned files, excluded paths, symlinks, and hard links", async (t) => {
  const { agentDir } = await fixture(t);
  const prepare = (relativePath) => prepareManagedFileChange({ agentDir, relativePath, expectedNewDigest: digestFile("new") });
  await assert.rejects(prepare("auth.json"), /Resource path/);
  await assert.rejects(prepare("sessions/session.jsonl"), /Resource path/);
  await assert.rejects(prepare("../skills/escape"), /Resource path/);
  await assert.rejects(prepare("skills/outside/secret.txt"), /Symlink/);

  await fs.writeFile(path.join(agentDir, "skills", "user.md"), "user-owned");
  await assert.rejects(prepare("skills/user.md"), /no valid Pify ownership record/);

  await fs.link(path.join(agentDir, "auth.json"), path.join(agentDir, "skills", "linked.md"));
  await assert.rejects(prepare("skills/linked.md"), /no valid Pify ownership record/);
});

test("refuses drift and does not claim content that misses the planned digest", async (t) => {
  const { agentDir } = await fixture(t);
  const relativePath = "prompts/pify.md";
  const target = path.join(agentDir, relativePath);
  const prepared = await prepareManagedFileChange({ agentDir, relativePath, expectedNewDigest: digestFile("expected") });
  await fs.mkdir(path.dirname(target));
  await fs.writeFile(target, "unexpected");
  await assert.rejects(completeManagedFileChange({ agentDir, transactionId: prepared.id }), /does not match/);
  assert.deepEqual((await manifest(agentDir)).resources, {});

  await fs.writeFile(target, "expected");
  await completeManagedFileChange({ agentDir, transactionId: prepared.id });
  await assert.rejects(completeManagedFileChange({ agentDir, transactionId: prepared.id }), /not prepared/);
  await fs.writeFile(target, "user edit");
  await assert.rejects(prepareManagedFileChange({ agentDir, relativePath, expectedNewDigest: digestFile("replacement") }), /changed since ownership/);

  await fs.rm(target);
  await fs.link(path.join(agentDir, "auth.json"), target);
  await assert.rejects(prepareManagedFileChange({ agentDir, relativePath, expectedNewDigest: digestFile("replacement") }), /Hard-linked resource/);
});
