import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildHealthReport } from "../src/health.mjs";
import { permissionContext } from "../src/permissions.mjs";
import { enableProjectWorkflow, inspectProjectWorkflow, WORKFLOW_RESOURCE } from "../src/project-workflow.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pify-project-workflow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await Promise.all([fs.mkdir(agentDir), fs.mkdir(first), fs.mkdir(second)]);
  return { agentDir, first, second };
}

const scope = permissionContext({ authorizedPaths: [WORKFLOW_RESOURCE] });

test("one project opts in while a second project and existing files stay unchanged", async (t) => {
  const { agentDir, first, second } = await fixture(t);
  await fs.writeFile(path.join(first, "AGENTS.md"), "project instructions\n");
  await fs.mkdir(path.join(first, ".pi"));
  await fs.writeFile(path.join(first, ".pi", "APPEND_SYSTEM.md"), "user system text\n");
  await fs.writeFile(path.join(second, "AGENTS.md"), "other instructions\n");

  const denied = await enableProjectWorkflow({ projectDir: first, permission: permissionContext() });
  assert.equal(denied.outcome, "clarification_required");
  assert.equal((await inspectProjectWorkflow({ projectDir: first })).status, "disabled");
  const applied = await enableProjectWorkflow({ projectDir: first, permission: scope });
  assert.equal(applied.status, "enabled");
  assert.equal((await enableProjectWorkflow({ projectDir: first, permission: scope })).status, "already_enabled");
  assert.equal((await inspectProjectWorkflow({ projectDir: first })).status, "enabled");
  assert.equal((await inspectProjectWorkflow({ projectDir: second })).status, "disabled");
  assert.equal((await buildHealthReport({ agentDir, projectDir: first })).projectWorkflow.status, "enabled");
  assert.equal((await buildHealthReport({ agentDir, projectDir: second })).projectWorkflow.status, "disabled");
  assert.equal(await fs.readFile(path.join(first, "AGENTS.md"), "utf8"), "project instructions\n");
  assert.equal(await fs.readFile(path.join(first, ".pi", "APPEND_SYSTEM.md"), "utf8"), "user system text\n");
  assert.equal(await fs.readFile(path.join(second, "AGENTS.md"), "utf8"), "other instructions\n");
  assert.deepEqual(await fs.readdir(second), ["AGENTS.md"]);
});

test("conflicting skill and symlink parent remain untouched", async (t) => {
  const { first, second } = await fixture(t);
  const existing = path.join(first, ".pi", WORKFLOW_RESOURCE);
  await fs.mkdir(path.dirname(existing), { recursive: true });
  await fs.writeFile(existing, "user skill\n");
  await assert.rejects(enableProjectWorkflow({ projectDir: first, permission: scope }), /conflict/);
  assert.equal(await fs.readFile(existing, "utf8"), "user skill\n");
  assert.equal((await inspectProjectWorkflow({ projectDir: first })).status, "conflict");

  await fs.symlink(path.join(first, ".pi"), path.join(second, ".pi"));
  await assert.rejects(enableProjectWorkflow({ projectDir: second, permission: scope }), /Project workflow conflict: unsafe parent path/);
  assert.equal((await inspectProjectWorkflow({ projectDir: second })).status, "conflict");
  assert.equal(await fs.readFile(existing, "utf8"), "user skill\n");
});
