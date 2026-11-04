import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyAdoption, previewAdoption, previewUninstall, rollbackAdoption, uninstallManagedFiles } from "../src/adoption.mjs";
import { authorizePifyAction, deriveWorkerPermission, modeLabel, permissionContext } from "../src/permissions.mjs";

test("Balanced is visible by default; every mode fails closed without scope", () => {
  const basic = permissionContext();
  assert.equal(basic.mode, "balanced");
  assert.equal(modeLabel(basic), "Pify: Balanced");
  for (const mode of ["safe", "balanced", "full"]) {
    const permission = permissionContext({ mode });
    const result = authorizePifyAction({ permission, requestId: "req-1", action: { kind: "adopt", targets: ["skills/pify.md"] } });
    assert.deepEqual([result.schema, result.requestId, result.outcome], ["pify.permission-result/v1", "req-1", "clarification_required"]);
    assert.deepEqual(result.missing, ["explicit authorized scope"]);
  }
});

test("scope and mode give structured allow, approval, deny, and clarification results", () => {
  for (const mode of ["safe", "balanced", "full"]) {
    const permission = permissionContext({ mode, authorizedPaths: ["skills/pify.md"] });
    const allowed = authorizePifyAction({ permission, action: { kind: "adopt", targets: ["skills/pify.md"] } });
    assert.equal(allowed.outcome, "allowed");
    const outside = authorizePifyAction({ permission, action: { kind: "adopt", targets: ["skills/other.md"] } });
    assert.equal(outside.outcome, mode === "safe" ? "denied" : "approval_required");
    assert.deepEqual(outside.outside, ["skills/other.md"]);
    const missing = authorizePifyAction({ permission, action: { kind: "adopt", targets: [] } });
    assert.equal(missing.outcome, "clarification_required");
    const invalid = authorizePifyAction({ permission, action: { kind: "adopt", targets: ["../auth.json"] } });
    assert.equal(invalid.outcome, "clarification_required");
  }
});

test("worker mode and scope never widen caller authority", () => {
  const caller = permissionContext({ mode: "balanced", authorizedPaths: ["skills/a.md", "skills/b.md"], callerId: "caller" });
  const worker = deriveWorkerPermission(caller, { mode: "safe", authorizedPaths: ["skills/a.md"], callerId: "worker" });
  assert.equal(worker.mode, "safe");
  assert.deepEqual(worker.authorizedPaths, ["skills/a.md"]);
  assert.throws(() => deriveWorkerPermission(caller, { mode: "full", callerId: "worker" }), /exceeds caller mode/);
  assert.throws(() => deriveWorkerPermission(caller, { authorizedPaths: ["skills/c.md"], callerId: "worker" }), /exceeds caller scope/);
});

test("headless adoption and uninstall return structured refusal without modifying files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pify-permission-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir);
  const resources = [{ relativePath: "skills/pify.md", content: "managed" }];
  const preview = await previewAdoption({ agentDir, resources });
  for (const mode of ["safe", "balanced", "full"]) {
    const missing = await applyAdoption({ agentDir, resources, preview, permission: permissionContext({ mode }) });
    assert.equal(missing.outcome, "clarification_required");
    await assert.rejects(fs.stat(path.join(agentDir, "pify-state")), { code: "ENOENT" });
  }
  const scoped = permissionContext({ authorizedPaths: ["skills/pify.md"] });
  const applied = await applyAdoption({ agentDir, resources, preview, permission: scoped });
  assert.equal(applied.status, "applied");
  const rollbackRefused = await rollbackAdoption({ agentDir, transactions: applied.transactions });
  assert.equal(rollbackRefused.outcome, "clarification_required");
  const uninstallPreview = await previewUninstall({ agentDir });
  const refused = await uninstallManagedFiles({ agentDir, preview: uninstallPreview });
  assert.equal(refused.outcome, "clarification_required");
  assert.equal(await fs.readFile(path.join(agentDir, "skills", "pify.md"), "utf8"), "managed");
});
