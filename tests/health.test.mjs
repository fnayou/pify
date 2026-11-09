import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyAdoption, previewAdoption } from "../src/adoption.mjs";
import { buildHealthReport, formatHealthReport } from "../src/health.mjs";
import { permissionContext } from "../src/permissions.mjs";
import { rollbackPifyTheme, selectPifyTheme } from "../src/theme-selection.mjs";

const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pify-health-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir);
  return agentDir;
}

async function snapshot(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const stat = await fs.lstat(absolute);
      if (entry.isSymbolicLink()) entries.push([relative, "link", await fs.readlink(absolute)]);
      else if (entry.isDirectory()) {
        entries.push([relative, "directory", stat.mode & 0o777]);
        await visit(absolute);
      } else entries.push([relative, "file", stat.mode & 0o777, (await fs.readFile(absolute)).toString("hex")]);
    }
  }
  await visit(root);
  return entries.sort((left, right) => left[0].localeCompare(right[0]));
}

test("fresh check is read-only and useful without settings or optional services", async (t) => {
  const agentDir = await fixture(t);
  const before = await snapshot(agentDir);
  const report = await buildHealthReport({ agentDir, piVersion: "1.4.0" });
  assert.equal(report.compatibility.status, "verified");
  assert.equal(report.install.status, "not_installed");
  assert.deepEqual(report.themeSelection, { status: "not_configured", savedTheme: null, rollbackAvailable: false });
  assert.deepEqual(report.inventory.managed, []);
  assert.equal(report.optionalServices, "not_checked");
  assert.deepEqual(await snapshot(agentDir), before);
});

test("health reports theme rollback availability without changing its journal", async (t) => {
  const agentDir = await fixture(t);
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [PACKAGE_ROOT], theme: "system" }));
  const permission = permissionContext({ authorizedPaths: ["settings.json"] });
  await selectPifyTheme({ agentDir, permission });
  const before = await snapshot(agentDir);
  const active = await buildHealthReport({ agentDir, piVersion: "1.4.0" });
  assert.deepEqual(active.themeSelection, { status: "available", savedTheme: "pify", rollbackAvailable: true });
  assert.match(formatHealthReport(active), /Saved theme: pify; Pify rollback: available/);
  assert.deepEqual(await snapshot(agentDir), before);

  await rollbackPifyTheme({ agentDir, permission });
  const afterRollback = await snapshot(agentDir);
  const restored = await buildHealthReport({ agentDir, piVersion: "1.4.0" });
  assert.deepEqual(restored.themeSelection, { status: "available", savedTheme: "system", rollbackAvailable: false });
  assert.deepEqual(await snapshot(agentDir), afterRollback);

  await selectPifyTheme({ agentDir, permission });
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [PACKAGE_ROOT], theme: "personal" }));
  const drifted = await buildHealthReport({ agentDir, piVersion: "1.4.0" });
  assert.deepEqual(drifted.themeSelection, { status: "available", savedTheme: "personal", rollbackAvailable: false });
});

test("damaged theme journal reports unavailable without echoing its contents", async (t) => {
  const agentDir = await fixture(t);
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [PACKAGE_ROOT], theme: "pify" }));
  await fs.mkdir(path.join(agentDir, "pify-state"), { mode: 0o700 });
  await fs.writeFile(path.join(agentDir, "pify-state", "theme-selection.json"), '{"secret":"PRIVATE_TEST_VALUE",', { mode: 0o600 });
  const before = await snapshot(agentDir);
  const report = await buildHealthReport({ agentDir, piVersion: "1.4.0" });
  assert.deepEqual(report.themeSelection, { status: "unavailable", savedTheme: null, rollbackAvailable: false });
  assert.equal(JSON.stringify(report).includes("PRIVATE_TEST_VALUE"), false);
  assert.deepEqual(await snapshot(agentDir), before);

  const journal = path.join(agentDir, "pify-state", "theme-selection.json");
  const outside = path.join(path.dirname(agentDir), "private-journal.json");
  await fs.writeFile(outside, "PRIVATE_TEST_VALUE");
  await fs.rm(journal);
  await fs.symlink(outside, journal);
  const linkedBefore = await snapshot(agentDir);
  const linked = await buildHealthReport({ agentDir, piVersion: "1.4.0" });
  assert.deepEqual(linked.themeSelection, { status: "unavailable", savedTheme: null, rollbackAvailable: false });
  assert.equal(JSON.stringify(linked).includes("PRIVATE_TEST_VALUE"), false);
  assert.deepEqual(await snapshot(agentDir), linkedBefore);
});

test("adopted check lists only provenance-matched files and their recorded version", async (t) => {
  const agentDir = await fixture(t);
  await fs.mkdir(path.join(agentDir, "skills"));
  await fs.writeFile(path.join(agentDir, "skills", "user.md"), "user owned");
  await fs.writeFile(path.join(agentDir, "auth.json"), "credential-secret");
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [PACKAGE_ROOT] }));
  const resources = [{ relativePath: "skills/pify.md", content: "managed" }];
  const preview = await previewAdoption({ agentDir, resources });
  await applyAdoption({ agentDir, resources, preview, permission: permissionContext({ authorizedPaths: ["skills/pify.md"] }) });
  const before = await snapshot(agentDir);
  const report = await buildHealthReport({ agentDir, piVersion: "1.4.0" });
  assert.equal(report.install.status, "installed");
  assert.deepEqual(report.inventory.managed.map(({ relativePath, version }) => [relativePath, version]), [["skills/pify.md", "2026.11.4"]]);
  assert.deepEqual(report.inventory.conflicts, []);
  assert.equal(JSON.stringify(report).includes("user.md"), false);
  assert.equal(JSON.stringify(report).includes("credential-secret"), false);
  assert.match(formatHealthReport(report), /skills\/pify.md \(2026.11.4\)/);
  assert.deepEqual(await snapshot(agentDir), before);
});

test("damaged settings and ownership report uncertainty without changing the fixture", async (t) => {
  const agentDir = await fixture(t);
  await fs.mkdir(path.join(agentDir, "pify-state"), { mode: 0o700 });
  await fs.writeFile(path.join(agentDir, "pify-state", "manifest.json"), "bad json", { mode: 0o600 });
  await fs.writeFile(path.join(agentDir, "settings.json"), "bad json");
  const before = await snapshot(agentDir);
  const report = await buildHealthReport({ agentDir, piVersion: "1.5.0" });
  assert.equal(report.compatibility.status, "unverified");
  assert.equal(report.install.status, "unknown");
  assert.deepEqual(report.themeSelection, { status: "unavailable", savedTheme: null, rollbackAvailable: false });
  assert.equal(report.inventory.status, "unavailable");
  assert.deepEqual(report.inventory.managed, []);
  assert.equal(report.warnings.length, 3);
  assert.deepEqual(await snapshot(agentDir), before);
});

test("edited managed content is a conflict, never a healthy managed resource", async (t) => {
  const agentDir = await fixture(t);
  const resources = [{ relativePath: "prompts/pify.md", content: "managed" }];
  await applyAdoption({
    agentDir, resources, preview: await previewAdoption({ agentDir, resources }),
    permission: permissionContext({ authorizedPaths: ["prompts/pify.md"] }),
  });
  await fs.writeFile(path.join(agentDir, "prompts", "pify.md"), "user edit");
  const before = await snapshot(agentDir);
  const report = await buildHealthReport({ agentDir, piVersion: null });
  assert.deepEqual(report.inventory.managed, []);
  assert.deepEqual(report.inventory.conflicts.map(({ relativePath }) => relativePath), ["prompts/pify.md"]);
  assert.deepEqual(await snapshot(agentDir), before);
});
