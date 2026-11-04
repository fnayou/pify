import assert from "node:assert/strict";
import test from "node:test";

import { SessionJobs } from "../src/jobs.mjs";

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
  const running = await manager.start({ command: "printf 'ready\\n'; sleep 30", cwd: process.cwd() });
  assert.equal(running.state, "running");
  await until(() => manager.log(running.id).stdout.includes("ready"));
  assert.equal(manager.inspect(running.id).pid, running.pid);
  assert.equal(manager.list().length, 1);
  const stopped = await manager.stop(running.id);
  assert.equal(stopped.outcome, "stopped");
  assert.equal(groupExists(running.pid), false);

  const failed = await manager.start({ command: "printf 'bad\\n' >&2; exit 7", cwd: process.cwd() });
  await until(() => manager.inspect(failed.id).state === "failed");
  assert.equal(manager.inspect(failed.id).message, "Command exited with code 7");
  assert.equal(manager.log(failed.id).stderr, "bad\n");
});

test("session shutdown ends a running job and blocks later starts", async () => {
  const manager = new SessionJobs();
  const running = await manager.start({ command: "sleep 30", cwd: process.cwd() });
  await manager.shutdown();
  assert.equal(manager.inspect(running.id).state, "stopped");
  assert.equal(groupExists(running.pid), false);
  await assert.rejects(manager.start({ command: "sleep 1", cwd: process.cwd() }), /Session is ending/);
});
