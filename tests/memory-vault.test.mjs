import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildHealthReport } from "../src/health.mjs";
import {
  connectMemoryVault, createMemoryVault, inspectMemoryVault, MEMORY_DIRECTORIES,
  MEMORY_STATE_RESOURCE, memoryVaultTargets, skipMemoryVault,
} from "../src/memory-vault.mjs";
import { permissionContext } from "../src/permissions.mjs";

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pify-memory-vault-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir);
  const vaultPath = path.join(root, "memory");
  const permission = permissionContext({ authorizedPaths: memoryVaultTargets(vaultPath) });
  return { root, agentDir, vaultPath, permission };
}

test("create selects an empty scoped vault and keeps private state outside it", async (t) => {
  const { agentDir, vaultPath, permission } = await fixture(t);
  assert.deepEqual(await inspectMemoryVault({ agentDir }), { status: "unconfigured" });
  const denied = await createMemoryVault({ agentDir, vaultPath, permission: permissionContext() });
  assert.equal(denied.outcome, "clarification_required");
  await assert.rejects(fs.lstat(vaultPath), { code: "ENOENT" });

  assert.equal((await createMemoryVault({ agentDir, vaultPath, permission })).status, "created");
  assert.deepEqual((await fs.readdir(vaultPath)).sort(), ["00-inbox", "01-global", "02-projects", "03-reference", "99-archive"]);
  for (const relative of MEMORY_DIRECTORIES) assert.deepEqual(await fs.readdir(path.join(vaultPath, relative)),
    MEMORY_DIRECTORIES.filter((other) => path.dirname(other) === relative).map((other) => path.basename(other)).sort());
  assert.equal((await inspectMemoryVault({ agentDir })).status, "available");
  const stateDir = path.join(agentDir, "pify-state");
  assert.equal((await fs.stat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(stateDir, "memory-vault.json"))).mode & 0o777, 0o600);
  await assert.rejects(createMemoryVault({ agentDir, vaultPath, permission }), { code: "EEXIST" });
});

test("connect adds missing scopes, preserves notes, and skip leaves the vault intact", async (t) => {
  const { agentDir, vaultPath, permission } = await fixture(t);
  await fs.mkdir(vaultPath);
  await fs.writeFile(path.join(vaultPath, "existing.md"), "my note\n");
  const denied = await connectMemoryVault({ agentDir, vaultPath, permission: permissionContext({ authorizedPaths: [MEMORY_STATE_RESOURCE] }) });
  assert.equal(denied.outcome, "approval_required");
  assert.deepEqual(await fs.readdir(vaultPath), ["existing.md"]);
  assert.equal((await connectMemoryVault({ agentDir, vaultPath, permission })).status, "connected");
  assert.equal(await fs.readFile(path.join(vaultPath, "existing.md"), "utf8"), "my note\n");
  assert.equal((await skipMemoryVault({ agentDir, permission: permissionContext({ authorizedPaths: [MEMORY_STATE_RESOURCE] }) })).status, "skipped");
  assert.deepEqual(await inspectMemoryVault({ agentDir }), { status: "skipped" });
  assert.equal(await fs.readFile(path.join(vaultPath, "existing.md"), "utf8"), "my note\n");
  assert.equal((await buildHealthReport({ agentDir })).memoryVault.status, "skipped");
});

test("an unavailable selected vault is reported and never replaced", async (t) => {
  const { root, agentDir, vaultPath, permission } = await fixture(t);
  await createMemoryVault({ agentDir, vaultPath, permission });
  await fs.rename(vaultPath, path.join(root, "offline"));
  const status = await inspectMemoryVault({ agentDir });
  assert.equal(status.status, "unavailable");
  assert.equal(status.path, vaultPath);
  assert.equal((await buildHealthReport({ agentDir })).memoryVault.status, "unavailable");
  await assert.rejects(fs.lstat(vaultPath), { code: "ENOENT" });
  await fs.mkdir(vaultPath);
  for (const relative of MEMORY_DIRECTORIES) await fs.mkdir(path.join(vaultPath, relative));
  assert.equal((await inspectMemoryVault({ agentDir })).reason, "Selected vault identity changed");
  assert.equal((await fs.readdir(path.join(root, "offline"))).length, 5);
});

test("connect refuses a scope collision before adding any folders", async (t) => {
  const { agentDir, vaultPath, permission } = await fixture(t);
  await fs.mkdir(vaultPath);
  await fs.writeFile(path.join(vaultPath, "01-global"), "user data\n");
  await assert.rejects(connectMemoryVault({ agentDir, vaultPath, permission }), /Unsafe vault directory/);
  assert.deepEqual(await fs.readdir(vaultPath), ["01-global"]);
  assert.equal(await fs.readFile(path.join(vaultPath, "01-global"), "utf8"), "user data\n");
  assert.deepEqual(await inspectMemoryVault({ agentDir }), { status: "unconfigured" });
});

test("vault paths overlapping Pi state or the Pify package are refused", async (t) => {
  const { root, agentDir, permission } = await fixture(t);
  const insideAgent = path.join(agentDir, "memory");
  await assert.rejects(createMemoryVault({ agentDir, vaultPath: insideAgent, permission }), /must not overlap/);
  await assert.rejects(fs.lstat(insideAgent), { code: "ENOENT" });
  await assert.rejects(connectMemoryVault({ agentDir, vaultPath: root, permission }), /must not overlap/);
});
