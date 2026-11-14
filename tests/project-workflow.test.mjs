import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildHealthReport } from "../src/health.mjs";
import { permissionContext } from "../src/permissions.mjs";
import { disableProjectWorkflow, enableProjectWorkflow, inspectProjectWorkflow, WORKFLOW_RESOURCE } from "../src/project-workflow.mjs";

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pify-project-workflow-")));
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

test("two indexed projects appear in health; opt-out preserves every project file and can be reversed", async (t) => {
  const { agentDir, first, second } = await fixture(t);
  await fs.writeFile(path.join(first, "AGENTS.md"), "first instructions\n");
  await fs.writeFile(path.join(second, "AGENTS.md"), "second instructions\n");
  await enableProjectWorkflow({ agentDir, projectDir: first, permission: scope });
  await enableProjectWorkflow({ agentDir, projectDir: second, permission: scope });
  const skill = path.join(first, ".pi", WORKFLOW_RESOURCE);
  const beforeSkill = await fs.readFile(skill);
  const beforeOther = await fs.readFile(path.join(second, ".pi", WORKFLOW_RESOURCE));
  const beforeHealth = await buildHealthReport({ agentDir, projectDir: first });
  assert.deepEqual(beforeHealth.projectWorkflows, [
    { path: first, status: "enabled" }, { path: second, status: "enabled" },
  ]);
  const stateDir = path.join(agentDir, "pify-state");
  assert.equal((await fs.stat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(stateDir, "project-workflows.json"))).mode & 0o777, 0o600);

  const denied = await disableProjectWorkflow({ agentDir, projectDir: first, permission: permissionContext() });
  assert.equal(denied.outcome, "clarification_required");
  assert.equal((await inspectProjectWorkflow({ projectDir: first })).status, "enabled");
  const disabled = await disableProjectWorkflow({ agentDir, projectDir: first, permission: scope });
  assert.equal(disabled.status, "disabled");
  assert.equal((await disableProjectWorkflow({ agentDir, projectDir: first, permission: scope })).status, "already_disabled");
  const preserved = path.join(path.dirname(skill), "SKILL.pify-disabled.md");
  assert.deepEqual(await fs.readFile(preserved), beforeSkill);
  assert.deepEqual(await fs.readdir(path.dirname(skill)), ["SKILL.pify-disabled.md"]);
  assert.equal(await fs.readFile(path.join(first, "AGENTS.md"), "utf8"), "first instructions\n");
  assert.equal(await fs.readFile(path.join(second, "AGENTS.md"), "utf8"), "second instructions\n");
  assert.deepEqual(await fs.readFile(path.join(second, ".pi", WORKFLOW_RESOURCE)), beforeOther);
  const afterHealth = await buildHealthReport({ agentDir, projectDir: first });
  assert.equal(afterHealth.projectWorkflow.status, "disabled");
  assert.deepEqual(afterHealth.projectWorkflows, [
    { path: first, status: "disabled" }, { path: second, status: "enabled" },
  ]);
  await enableProjectWorkflow({ agentDir, projectDir: first, permission: scope });
  assert.deepEqual(await fs.readFile(skill), beforeSkill);
  assert.deepEqual((await buildHealthReport({ agentDir })).projectWorkflows, beforeHealth.projectWorkflows);
});

test("edited workflow is never moved by opt-out and health exposes drift", async (t) => {
  const { agentDir, first } = await fixture(t);
  await enableProjectWorkflow({ agentDir, projectDir: first, permission: scope });
  const skill = path.join(first, ".pi", WORKFLOW_RESOURCE);
  await fs.appendFile(skill, "local edit\n");
  await assert.rejects(disableProjectWorkflow({ agentDir, projectDir: first, permission: scope }), /skill changed/);
  assert.match(await fs.readFile(skill, "utf8"), /local edit/);
  assert.deepEqual((await buildHealthReport({ agentDir })).projectWorkflows, [{ path: first, status: "conflict" }]);
});

test("explicit enable indexes a pre-index workflow; unsafe registry fails before project changes", async (t) => {
  const { agentDir, first, second } = await fixture(t);
  await enableProjectWorkflow({ projectDir: first, permission: scope });
  assert.deepEqual((await buildHealthReport({ agentDir })).projectWorkflows, []);
  assert.equal((await enableProjectWorkflow({ agentDir, projectDir: first, permission: scope })).status, "already_enabled");
  assert.deepEqual((await buildHealthReport({ agentDir })).projectWorkflows, [{ path: first, status: "enabled" }]);

  const registry = path.join(agentDir, "pify-state", "project-workflows.json");
  await fs.writeFile(registry, "invalid JSON\n");
  await assert.rejects(enableProjectWorkflow({ agentDir, projectDir: second, permission: scope }), /Invalid Pify workflow registry JSON/);
  assert.deepEqual(await fs.readdir(second), []);
  assert.deepEqual((await buildHealthReport({ agentDir })).projectWorkflows, []);
});
