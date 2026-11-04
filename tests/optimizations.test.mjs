import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectOptimizations } from "../src/optimizations.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pify-optimizations-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const projectDir = path.join(root, "project");
  const bin = path.join(root, "bin");
  await Promise.all([fs.mkdir(agentDir), fs.mkdir(projectDir), fs.mkdir(bin)]);
  return { agentDir, projectDir, bin };
}

async function snapshot(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else result[path.relative(root, file)] = await fs.readFile(file);
    }
  }
  await visit(root);
  return result;
}

test("known Pi integrations are detected without changing user files or enabling transforms", async (t) => {
  const { agentDir, projectDir, bin } = await fixture(t);
  await fs.mkdir(path.join(agentDir, "extensions"));
  await fs.writeFile(path.join(agentDir, "extensions", "rtk.ts"), "user RTK hook\n");
  await fs.mkdir(path.join(agentDir, "skills", "caveman"), { recursive: true });
  await fs.writeFile(path.join(agentDir, "skills", "caveman", "SKILL.md"), "user Caveman skill\n");
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@caveman-ai/pi@0.3.1"], compaction: { enabled: false } }));
  await fs.mkdir(path.join(projectDir, ".pi", "extensions"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".pi", "extensions", "rtk.ts"), "project RTK hook\n");
  await fs.writeFile(path.join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: [{ source: "npm:@caveman-ai/pi" }], compaction: { enabled: true } }));
  await fs.writeFile(path.join(bin, "rtk"), "fixture binary\n", { mode: 0o755 });
  const before = await snapshot(path.dirname(agentDir));

  const report = await inspectOptimizations({ agentDir, projectDir, projectTrusted: true, pathEnv: bin });
  assert.deepEqual(report.rtk, { binary: "present", agentPiHook: "present", projectPiHook: "present", projectTrusted: true, compatibility: "unverified" });
  assert.deepEqual(report.caveman, { binary: "not_found", agentPiPackage: "declared", projectPiPackage: "declared", agentSkill: "present", enabledByPify: false, compatibility: "unverified" });
  assert.deepEqual(report.nativeCompaction, { status: "enabled", source: "project" });
  assert.equal(report.newTransformsEnabledByPify, false);
  assert.deepEqual(await snapshot(path.dirname(agentDir)), before);
});

test("untrusted project settings stay unread and broken state remains uncertain", async (t) => {
  const { agentDir, projectDir } = await fixture(t);
  await fs.writeFile(path.join(agentDir, "settings.json"), "not-json\n");
  await fs.mkdir(path.join(projectDir, ".pi"));
  await fs.writeFile(path.join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@caveman-ai/pi"] }));
  const before = await snapshot(path.dirname(agentDir));
  const report = await inspectOptimizations({ agentDir, projectDir, pathEnv: "" });
  assert.equal(report.caveman.agentPiPackage, "unknown");
  assert.equal(report.caveman.projectPiPackage, "not_checked_untrusted");
  assert.equal(report.nativeCompaction.status, "unknown");
  assert.equal(report.rtk.projectPiHook, "absent");
  assert.equal(report.warnings.length, 1);
  assert.equal(report.warnings[0], "Agent settings could not be read");
  assert.deepEqual(await snapshot(path.dirname(agentDir)), before);
});

test("untrusted overrides and malformed settings never produce a false enabled claim", async (t) => {
  const { agentDir, projectDir } = await fixture(t);
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: {}, compaction: { enabled: true } }));
  await fs.mkdir(path.join(projectDir, ".pi"));
  await fs.writeFile(path.join(projectDir, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
  const report = await inspectOptimizations({ agentDir, projectDir, pathEnv: "" });
  assert.equal(report.caveman.agentPiPackage, "unknown");
  assert.deepEqual(report.nativeCompaction, { status: "unknown", source: null });

  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: "broken" }));
  const malformed = await inspectOptimizations({ agentDir, projectDir, projectTrusted: true, pathEnv: "" });
  assert.deepEqual(malformed.nativeCompaction, { status: "unknown", source: "agent" });
});
