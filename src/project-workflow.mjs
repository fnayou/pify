import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { authorizePifyAction } from "./permissions.mjs";
import { readWorkflowRegistry, recordWorkflowProject } from "./workflow-registry.mjs";

export const WORKFLOW_RESOURCE = "skills/pify-development-workflow/SKILL.md";
const DISABLED_NAME = "SKILL.pify-disabled.md";
const COMPONENTS = [".pi", "skills", "pify-development-workflow"];
const TEMPLATE_URL = new URL("../templates/development-workflow/SKILL.md", import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function requireProjectDir(projectDir) {
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir)) {
    throw new Error("Absolute project directory is required");
  }
  return path.resolve(projectDir);
}

async function regularDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe project directory: ${directory}`);
}

async function resourceLocation(projectDir) {
  const root = requireProjectDir(projectDir);
  await regularDirectory(root);
  let current = root;
  for (const component of COMPONENTS) {
    current = path.join(current, component);
    try {
      await regularDirectory(current);
    } catch (error) {
      if (error.code === "ENOENT") return { status: "disabled", path: path.join(root, ".pi", WORKFLOW_RESOURCE) };
      if (error.message.startsWith("Unsafe project directory:")) return { status: "conflict", reason: "unsafe parent path" };
      throw error;
    }
  }
  return { status: "present", path: path.join(current, "SKILL.md") };
}

/** Inspect the project-local skill without claiming ownership or writing state. */
export async function inspectProjectWorkflow({ projectDir, agentDir = null }) {
  const location = await resourceLocation(projectDir);
  if (location.status === "disabled") return { status: "disabled", relativePath: `.pi/${WORKFLOW_RESOURCE}` };
  if (location.status === "conflict") return { status: "conflict", relativePath: `.pi/${WORKFLOW_RESOURCE}`, reason: location.reason };
  let stat;
  try {
    stat = await fs.lstat(location.path);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "disabled", relativePath: `.pi/${WORKFLOW_RESOURCE}` };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    return { status: "conflict", relativePath: `.pi/${WORKFLOW_RESOURCE}`, reason: "existing path is not a regular standalone file" };
  }
  const actual = await fs.readFile(location.path);
  if (agentDir !== null) {
    const projectPath = await fs.realpath(requireProjectDir(projectDir));
    const registry = await readWorkflowRegistry(agentDir);
    const recorded = registry.registry.projects.find((item) => item.path === projectPath);
    if (recorded?.status === "disabled") {
      return { status: "conflict", relativePath: `.pi/${WORKFLOW_RESOURCE}`, reason: "active skill appeared after opt-out" };
    }
    if (recorded?.status === "enabled") {
      return digest(actual) === recorded.digest
        ? { status: "enabled", relativePath: `.pi/${WORKFLOW_RESOURCE}` }
        : { status: "conflict", relativePath: `.pi/${WORKFLOW_RESOURCE}`, reason: "skill changed outside Pify" };
    }
  }
  const expected = await fs.readFile(TEMPLATE_URL);
  return actual.equals(expected)
    ? { status: "enabled", relativePath: `.pi/${WORKFLOW_RESOURCE}` }
    : { status: "conflict", relativePath: `.pi/${WORKFLOW_RESOURCE}`, reason: "existing skill differs from Pify's template" };
}

/** Create or restore one project skill after exact-scope authorization; preserve every existing file. */
export async function enableProjectWorkflow({ projectDir, agentDir = null, permission }) {
  const root = requireProjectDir(projectDir);
  const decision = authorizePifyAction({ permission, action: { kind: "workflow-enable", targets: [WORKFLOW_RESOURCE] } });
  if (decision.outcome !== "allowed") return decision;
  const before = await inspectProjectWorkflow({ projectDir: root, agentDir });
  if (before.status === "conflict") throw new Error(`Project workflow conflict: ${before.reason}`);
  if (agentDir !== null) await readWorkflowRegistry(agentDir);
  const expected = await fs.readFile(TEMPLATE_URL);
  const projectPath = await fs.realpath(root);
  if (before.status === "enabled") {
    try {
      await fs.lstat(path.join(path.dirname(path.join(root, ".pi", WORKFLOW_RESOURCE)), DISABLED_NAME));
      throw new Error("Project workflow conflict: active and disabled files both exist");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (agentDir !== null) await recordWorkflowProject(agentDir, projectPath, "enabled", digest(await fs.readFile(path.join(root, ".pi", WORKFLOW_RESOURCE))));
    return { status: "already_enabled", relativePath: before.relativePath };
  }

  let current = root;
  for (const component of COMPONENTS) {
    current = path.join(current, component);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await regularDirectory(current);
  }
  const destination = path.join(current, "SKILL.md");
  const disabled = path.join(current, DISABLED_NAME);
  let disabledStat = null;
  try { disabledStat = await fs.lstat(disabled); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (disabledStat) {
    const registry = agentDir === null ? null : await readWorkflowRegistry(agentDir);
    const recorded = registry?.registry.projects.find((item) => item.path === projectPath);
    const disabledBytes = await fs.readFile(disabled);
    if (!disabledStat.isFile() || disabledStat.isSymbolicLink() || disabledStat.nlink !== 1 ||
        (recorded?.status === "disabled" ? digest(disabledBytes) !== recorded.digest : !disabledBytes.equals(expected))) {
      throw new Error("Project workflow conflict: disabled copy differs from Pify's recorded skill");
    }
    await fs.rename(disabled, destination);
  } else {
    await fs.writeFile(destination, expected, { flag: "wx", mode: 0o644 });
  }
  if (agentDir !== null) await recordWorkflowProject(agentDir, projectPath, "enabled", digest(await fs.readFile(destination)));
  return { status: "enabled", relativePath: `.pi/${WORKFLOW_RESOURCE}` };
}

/** Move the exact workflow skill out of Pi discovery; no project file is deleted. */
export async function disableProjectWorkflow({ projectDir, agentDir, permission }) {
  const root = requireProjectDir(projectDir);
  const decision = authorizePifyAction({ permission, action: { kind: "workflow-disable", targets: [WORKFLOW_RESOURCE] } });
  if (decision.outcome !== "allowed") return decision;
  const projectPath = await fs.realpath(root);
  const location = await resourceLocation(root);
  if (location.status === "conflict") throw new Error(`Project workflow conflict: ${location.reason}`);
  if (location.status === "disabled") return { status: "already_disabled", relativePath: `.pi/${WORKFLOW_RESOURCE}` };
  const disabled = path.join(path.dirname(location.path), DISABLED_NAME);
  const registry = await readWorkflowRegistry(agentDir);
  const recorded = registry.registry.projects.find((item) => item.path === projectPath);
  let activeStat = null, disabledStat = null;
  try { activeStat = await fs.lstat(location.path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  try { disabledStat = await fs.lstat(disabled); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (activeStat && disabledStat) throw new Error("Project workflow conflict: active and disabled files both exist");
  if (activeStat && recorded?.status === "disabled") throw new Error("Project workflow conflict: an untracked active skill appeared after opt-out");
  const expectedDigest = recorded?.digest ?? digest(await fs.readFile(TEMPLATE_URL));
  if (!activeStat && !disabledStat) return { status: "already_disabled", relativePath: `.pi/${WORKFLOW_RESOURCE}` };
  const source = activeStat ? location.path : disabled;
  const stat = activeStat ?? disabledStat;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      digest(await fs.readFile(source)) !== expectedDigest) throw new Error("Project workflow conflict: skill changed outside Pify");
  if (activeStat) await fs.rename(location.path, disabled);
  await recordWorkflowProject(agentDir, projectPath, "disabled", expectedDigest);
  return { status: activeStat ? "disabled" : "already_disabled", relativePath: `.pi/${WORKFLOW_RESOURCE}`, preservedAs: `.pi/skills/pify-development-workflow/${DISABLED_NAME}` };
}

/** Read the private index and verify each project's observed state. */
export async function listProjectWorkflows({ agentDir }) {
  const registry = await readWorkflowRegistry(agentDir);
  const projects = [];
  for (const item of registry.registry.projects) {
    let status = "conflict";
    try {
      const location = await resourceLocation(item.path);
      if (location.status === "present") {
        const file = path.join(path.dirname(location.path), item.status === "enabled" ? "SKILL.md" : DISABLED_NAME);
        const other = path.join(path.dirname(location.path), item.status === "enabled" ? DISABLED_NAME : "SKILL.md");
        let otherExists = false;
        try { await fs.lstat(other); otherExists = true; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        const stat = await fs.lstat(file);
        if (!otherExists && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
            digest(await fs.readFile(file)) === item.digest) status = item.status;
      }
    } catch { /* Missing or unsafe projects remain visible as conflicts. */ }
    projects.push({ path: item.path, status });
  }
  return projects;
}
