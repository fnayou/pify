import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyAdoption, previewAdoption } from "../src/adoption.mjs";
import { buildHealthReport, formatHealthReport } from "../src/health.mjs";
import { permissionContext } from "../src/permissions.mjs";

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
  assert.deepEqual(report.inventory.managed, []);
  assert.equal(report.optionalServices, "not_checked");
  assert.deepEqual(await snapshot(agentDir), before);
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
  assert.equal(report.inventory.status, "unavailable");
  assert.deepEqual(report.inventory.managed, []);
  assert.equal(report.warnings.length, 2);
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
