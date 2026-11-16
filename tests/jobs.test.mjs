import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JOB_START_RESOURCE, SessionJobs } from "../src/jobs.mjs";
import { permissionContext } from "../src/permissions.mjs";

const permission = permissionContext({ authorizedPaths: [JOB_START_RESOURCE] });

async function until(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Job state did not settle");
}

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

test("start, inspect, log, stop, and failure state stay in one session", async (t) => {
  const manager = new SessionJobs();
  t.after(() => manager.shutdown());
  const running = await manager.start({ command: "printf 'ready\\n'; sleep 30", cwd: process.cwd(), permission });
  assert.equal(running.state, "running");
  await until(() => manager.log(running.id).stdout.includes("ready"));
  assert.equal(manager.inspect(running.id).pid, running.pid);
  assert.equal(manager.list().length, 1);
  const stopped = await manager.stop(running.id);
  assert.equal(stopped.outcome, "stopped");
  assert.equal(groupExists(running.pid), false);

  const failed = await manager.start({ command: "printf 'bad\\n' >&2; exit 7", cwd: process.cwd(), permission });
  await until(() => manager.inspect(failed.id).state === "failed");
  assert.equal(manager.inspect(failed.id).message, "Command exited with code 7");
  assert.equal(manager.log(failed.id).stderr, "bad\n");
});

test("session shutdown ends a running job and blocks later starts", async () => {
  const manager = new SessionJobs();
  const running = await manager.start({ command: "sleep 30", cwd: process.cwd(), permission });
  await manager.shutdown();
  assert.equal(manager.inspect(running.id).state, "stopped");
  assert.equal(groupExists(running.pid), false);
  await assert.rejects(manager.start({ command: "sleep 1", cwd: process.cwd() }), /Session is ending/);
});

test("nested job commands require scope and Safe mode refuses dispatch", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pify-shell-policy-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const manager = new SessionJobs();
  t.after(() => manager.shutdown());
  for (const mode of ["safe", "balanced", "full"]) {
    const marker = path.join(cwd, mode);
    const command = `sh -c 'printf nested > ${mode}'`;
    const unscoped = await manager.start({ command, cwd, permission: permissionContext({ mode }) });
    assert.equal(unscoped.outcome, "clarification_required");
    const scoped = await manager.start({ command, cwd, permission: permissionContext({ mode, authorizedPaths: [JOB_START_RESOURCE] }) });
    if (mode === "safe") {
      assert.equal(scoped.outcome, "denied");
      await assert.rejects(fs.stat(marker), { code: "ENOENT" });
    } else {
      assert.ok(["running", "succeeded"].includes(scoped.state));
      await until(() => manager.inspect(scoped.id).state === "succeeded");
      assert.equal(await fs.readFile(marker, "utf8"), "nested");
    }
  }
});
