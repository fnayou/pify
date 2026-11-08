import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { formatSetupPreview, previewLocalSetup } from "../src/setup-preview.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pify-setup-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const packageRoot = path.join(root, "package");
  await mkdir(agentDir);
  await mkdir(path.join(packageRoot, "extensions"), { recursive: true });
  await mkdir(path.join(packageRoot, "skills", "pify-debug"), { recursive: true });
  await mkdir(path.join(packageRoot, "themes"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@fnayou/pify", version: "2026.11.4", private: true,
    pi: { extensions: ["extensions/pify.js"], skills: ["skills/pify-debug"], prompts: [], themes: ["themes/pify.json"] },
  }));
  await writeFile(path.join(packageRoot, "extensions", "pify.js"), "export default () => {};\n");
  await writeFile(path.join(packageRoot, "skills", "pify-debug", "SKILL.md"), "# Package skill\n");
  await writeFile(path.join(packageRoot, "themes", "pify.json"), "{}\n");
  return { root, agentDir, packageRoot };
}

test("local setup preview reports package, collisions, and theme without changing Pi state", async (t) => {
  const { agentDir, packageRoot } = await fixture(t);
  await mkdir(path.join(agentDir, "skills", "pify-debug"), { recursive: true });
  const skill = path.join(agentDir, "skills", "pify-debug", "SKILL.md");
  await writeFile(skill, "private user skill\n");
  const settingsFile = path.join(agentDir, "settings.json");
  await writeFile(settingsFile, JSON.stringify({ packages: ["/other/package"], apiKey: "SECRET_NOT_FOR_REPORT" }));
  const before = [await readFile(settingsFile), await readFile(skill)];

  const report = await previewLocalSetup({ agentDir, packageRoot });
  assert.equal(report.piRegistration.action, "add_local_package_declaration");
  assert.deepEqual(report.firstInteractiveTheme, { action: "select_pify", reason: "no saved theme" });
  assert.equal(report.package.resources.length, 3);
  assert.deepEqual(report.package.resources.find((item) => item.kind === "skills").collision, { status: "present", type: "directory" });
  assert.equal(report.package.resources.find((item) => item.kind === "skills").precedence, "not_verified");
  assert.match(formatSetupPreview(report), /No installation performed/);
  assert.equal(JSON.stringify(report).includes("SECRET_NOT_FOR_REPORT"), false);
  assert.deepEqual([await readFile(settingsFile), await readFile(skill)], before);
  assert.equal((await previewLocalSetup({ agentDir, packageRoot })).source.declaredResourceDigest, report.source.declaredResourceDigest);

  await writeFile(settingsFile, JSON.stringify({ packages: [packageRoot], theme: "system" }));
  const installed = await previewLocalSetup({ agentDir, packageRoot });
  assert.equal(installed.piRegistration.action, "already_declared");
  assert.deepEqual(installed.firstInteractiveTheme, { action: "preserve", savedTheme: "system" });
});

test("preview does not follow symlinked resource paths", async (t) => {
  const { root, agentDir, packageRoot } = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(agentDir, "skills"));
  const report = await previewLocalSetup({ agentDir, packageRoot });
  assert.equal(report.package.resources.find((item) => item.kind === "skills").collision.status, "unsafe_parent");
  await symlink(path.join(root, "outside"), path.join(packageRoot, "skills", "pify-debug", "linked"));
  await assert.rejects(previewLocalSetup({ agentDir, packageRoot }), /Symlinked package resource/);
});

test("invalid Pi settings fail without echoing their contents", async (t) => {
  const { agentDir, packageRoot } = await fixture(t);
  await writeFile(path.join(agentDir, "settings.json"), '{"apiKey":"SECRET_NOT_FOR_REPORT",');
  await assert.rejects(previewLocalSetup({ agentDir, packageRoot }), (error) => {
    assert.equal(error.message, "Pi settings are invalid JSON");
    return true;
  });
});
