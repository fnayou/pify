import * as fs from "node:fs/promises";
import path from "node:path";

import { authorizePifyAction } from "./permissions.mjs";

export const WORKFLOW_RESOURCE = "skills/pify-development-workflow/SKILL.md";
const COMPONENTS = [".pi", "skills", "pify-development-workflow"];
const TEMPLATE_URL = new URL("../templates/development-workflow/SKILL.md", import.meta.url);

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
export async function inspectProjectWorkflow({ projectDir }) {
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
  const expected = await fs.readFile(TEMPLATE_URL);
  return actual.equals(expected)
    ? { status: "enabled", relativePath: `.pi/${WORKFLOW_RESOURCE}` }
    : { status: "conflict", relativePath: `.pi/${WORKFLOW_RESOURCE}`, reason: "existing skill differs from Pify's template" };
}

/** Create one project skill after exact-scope authorization; preserve every existing file. */
export async function enableProjectWorkflow({ projectDir, permission }) {
  const root = requireProjectDir(projectDir);
  const decision = authorizePifyAction({ permission, action: { kind: "workflow-enable", targets: [WORKFLOW_RESOURCE] } });
  if (decision.outcome !== "allowed") return decision;
  const before = await inspectProjectWorkflow({ projectDir: root });
  if (before.status === "enabled") return { status: "already_enabled", relativePath: before.relativePath };
  if (before.status === "conflict") throw new Error(`Project workflow conflict: ${before.reason}`);

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
  await fs.writeFile(destination, await fs.readFile(TEMPLATE_URL), { flag: "wx", mode: 0o644 });
  return { status: "enabled", relativePath: `.pi/${WORKFLOW_RESOURCE}` };
}
