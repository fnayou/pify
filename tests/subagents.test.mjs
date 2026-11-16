import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { permissionContext } from "../src/permissions.mjs";
import { SessionSubagents, SUBAGENT_START_RESOURCE } from "../src/subagents.mjs";

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pify-subagents-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, "worker.mjs");
  await fs.writeFile(script, `
const task = process.argv.at(-1);
if (task.includes("stuck")) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:task}],stopReason:"stop"}}) + "\\n");
    process.stdout.write(JSON.stringify({type:"agent_settled",aborted:false}) + "\\n");
  }, 1200);
}
`);
  const launches = [];
  const manager = new SessionSubagents({ ...options, spawnImpl: (_command, args, settings) => {
    launches.push({ args, settings });
    return spawn(process.execPath, [script, ...args], settings);
  } });
  t.after(() => manager.shutdown());
  return { root, manager, launches };
}

async function until(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Subagent state did not settle");
}

function request(root, task, provider = "fixture-a") {
  return { task, cwd: root, provider, model: "fixture-model", thinkingLevel: "low",
    parentPermission: permissionContext({ authorizedPaths: [SUBAGENT_START_RESOURCE, "files/a"] }),
    workerScope: ["files/a"], parentTools: ["read", "bash", "unknown"], trusted: false };
}

test("workers inherit narrower scope and tools; unscoped or wider starts fail", async (t) => {
  const { root, manager, launches } = await fixture(t);
  const published = [];
  const unsubscribe = manager.subscribe((status) => published.push(status));
  const denied = manager.start({ ...request(root, "denied"), parentPermission: permissionContext() });
  assert.equal(denied.outcome, "clarification_required");
  assert.equal(launches.length, 0);
  assert.throws(() => manager.start({ ...request(root, "wider"), workerScope: ["files/b"] }), /exceeds caller scope/);
  assert.throws(() => manager.start({ ...request(root, "wider-mode"), workerMode: "full" }), /exceeds caller mode/);
  const started = manager.start({ ...request(root, "quick"), workerMode: "safe" });
  assert.equal(started.state, "running");
  assert.deepEqual(started.scope, ["files/a"]);
  assert.equal(started.mode, "safe");
  assert.deepEqual(started.tools, ["read", "bash"]);
  const invocation = launches[0];
  assert.equal(invocation.settings.shell, false);
  assert.equal(invocation.settings.env.PIFY_SUBAGENT_CHILD, "1");
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--tools") + 1, invocation.args.indexOf("--tools") + 2), ["read,bash"]);
  assert.equal(invocation.args[invocation.args.indexOf("--pify-mode") + 1], "safe");
  assert.equal(invocation.args[invocation.args.indexOf("--pify-scope") + 1], "files/a");
  assert.ok(invocation.args.includes("--no-mcp") && invocation.args.includes("--no-extensions"));
  await until(() => manager.inspect(started.id).state === "succeeded");
  assert.match(manager.inspect(started.id).output, /quick/);
  assert.equal(published[0].counts.total, 0);
  assert.ok(published.some((status) => status.jobs[0]?.state === "running"));
  assert.equal(published.at(-1).jobs[0].state, "succeeded");
  assert.ok(published.at(-1).sequence > published[0].sequence);
  unsubscribe();
});

test("per-provider queue, cancellation, and a stuck worker never block the parent", async (t) => {
  const { root, manager } = await fixture(t, { maxPerProvider: 2, maxTotal: 3 });
  const first = manager.start(request(root, "stuck one"));
  const second = manager.start(request(root, "stuck two"));
  const third = manager.start(request(root, "queued third"));
  const other = manager.start(request(root, "other provider", "fixture-b"));
  assert.equal(third.state, "queued");
  assert.equal(other.state, "running");
  const before = Date.now();
  assert.equal(manager.list().length, 4);
  assert.ok(Date.now() - before < 100);
  const cancelled = await manager.cancel(first.id);
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(manager.inspect(first.id).state, "cancelled");
  await until(() => manager.inspect(third.id).state === "running");
  const queued = manager.start(request(root, "queued fourth"));
  assert.equal(queued.state, "queued");
  assert.equal((await manager.cancel(queued.id)).outcome, "cancelled_queued");
  assert.equal(manager.inspect(queued.id).pid, null);
  assert.equal((await manager.cancel(second.id)).outcome, "cancelled");
  await until(() => manager.inspect(third.id).state === "succeeded");
  await until(() => manager.inspect(other.id).state === "succeeded");
});

test("a timed-out worker releases its provider slot", async (t) => {
  const { root, manager } = await fixture(t, { maxPerProvider: 1, maxRunMs: 100 });
  const stuck = manager.start(request(root, "stuck timeout"));
  const queued = manager.start(request(root, "queued after timeout"));
  assert.equal(queued.state, "queued");
  await until(() => manager.inspect(stuck.id).state === "timed_out");
  await until(() => manager.inspect(queued.id).startedAt !== null);
});
