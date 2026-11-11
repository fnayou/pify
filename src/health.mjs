import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listOwnedFiles } from "./managed-state.mjs";
import { inspectProjectWorkflow } from "./project-workflow.mjs";
import { inspectThemeSelection } from "./theme-selection.mjs";

const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const SUPPORTED_PI_VERSION = "1.5.2";
const NPM_SOURCE = "npm:@fnayou/pify";
const GIT_SOURCE = "git:github.com/fnayou/pify";

async function installStatus(agentDir, packageRoot, metadata, warnings) {
  let settings;
  try {
    settings = JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { status: "not_installed", evidence: "no agent settings" };
    warnings.push(`Pi settings could not be read: ${error.message}`);
    return { status: "unknown", evidence: "settings unavailable" };
  }
  if (!Array.isArray(settings?.packages)) return { status: "not_installed", evidence: "no package declarations" };
  const sources = settings.packages.map((entry) => typeof entry === "string" ? entry : entry?.source).filter((source) => typeof source === "string");
  const local = sources.some((source) => !/^(npm:|git:|https?:\/\/)/.test(source) && path.resolve(agentDir, source) === packageRoot);
  if (local) return { status: "installed", sourceKind: "local", evidence: "matching Pi package declaration" };

  const gitSources = sources.filter((source) => source === GIT_SOURCE || source.startsWith(`${GIT_SOURCE}@`));
  const npmSources = sources.filter((source) => source === NPM_SOURCE || source.startsWith(`${NPM_SOURCE}@`));
  if (gitSources.length > 0) {
    const pinned = gitSources[0].match(/^git:github\.com\/fnayou\/pify@([0-9a-f]{40})$/);
    let managedPath = false;
    let detachedHead = null;
    try {
      const agentRoot = await fs.realpath(agentDir);
      managedPath = await fs.realpath(packageRoot) === path.join(agentRoot, "git", "github.com", "fnayou", "pify");
      if (managedPath) {
        const gitDirectory = await fs.lstat(path.join(packageRoot, ".git"));
        const headFile = await fs.lstat(path.join(packageRoot, ".git", "HEAD"));
        if (gitDirectory.isDirectory() && !gitDirectory.isSymbolicLink() && headFile.isFile() &&
            !headFile.isSymbolicLink() && headFile.size <= 41) {
          detachedHead = (await fs.readFile(path.join(packageRoot, ".git", "HEAD"), "utf8")).trimEnd();
        }
      }
    } catch {
      // A missing or redirected checkout cannot establish source identity.
    }
    if (npmSources.length === 0 && gitSources.length === 1 && pinned && metadata?.name === "@fnayou/pify" &&
        managedPath && detachedHead === pinned[1]) {
      return { status: "installed", sourceKind: "git", evidence: "matching pinned Git declaration and Pi-managed checkout" };
    }
    return { status: "unknown", sourceKind: "git", evidence: "Pify Git declaration does not match a pinned commit and managed checkout" };
  }
  if (npmSources.length === 0) return { status: "not_installed", evidence: "no matching Pi package declaration" };
  let managedPath = false;
  try {
    const agentRoot = await fs.realpath(agentDir);
    managedPath = await fs.realpath(packageRoot) === path.join(agentRoot, "npm", "node_modules", "@fnayou", "pify");
  } catch {
    // A missing or redirected managed package cannot establish source identity.
  }
  if (metadata?.name === "@fnayou/pify" && typeof metadata.version === "string" && managedPath &&
      new Set(npmSources).size === 1 && npmSources[0] === `${NPM_SOURCE}@${metadata.version}`) {
    return { status: "installed", sourceKind: "npm", evidence: "matching pinned npm declaration and Pi-managed package path" };
  }
  return { status: "unknown", sourceKind: "npm", evidence: "Pify npm declaration does not match a pinned version and managed package path" };
}

async function bundledSkills(install, warnings, packageRoot) {
  if (install.status !== "installed") return [];
  try {
    const catalog = JSON.parse(await fs.readFile(path.join(packageRoot, "skills", "catalog.json"), "utf8"));
    if (catalog.schema !== "pify.skills/v1" || !Array.isArray(catalog.skills)) throw new Error("invalid skill catalog");
    const skills = [];
    for (const item of catalog.skills) {
      if (typeof item.name !== "string" || typeof item.path !== "string" ||
          !/^skills\/[a-z0-9-]+$/.test(item.path) || typeof item.source !== "string" ||
          typeof item.sourceVersion !== "string" || item.license !== "MIT") {
        throw new Error("invalid skill provenance");
      }
      const stat = await fs.lstat(path.join(packageRoot, item.path, "SKILL.md"));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid skill file: ${item.path}`);
      skills.push({ name: item.name, source: item.source, sourceVersion: item.sourceVersion, license: item.license });
    }
    return skills;
  } catch (error) {
    warnings.push(`Bundled skill provenance could not be read: ${error.message}`);
    return [];
  }
}

async function themeSelectionStatus(agentDir, warnings) {
  try {
    const selection = await inspectThemeSelection({ agentDir });
    return { status: "available", savedTheme: selection.theme, rollbackAvailable: selection.rollbackAvailable };
  } catch (error) {
    if (error.code === "ENOENT") {
      try {
        await fs.lstat(path.join(agentDir, "pify-state"));
      } catch (stateError) {
        if (stateError.code === "ENOENT") return { status: "not_configured", savedTheme: null, rollbackAvailable: false };
      }
    }
    warnings.push("Pify theme recovery state could not be read");
    return { status: "unavailable", savedTheme: null, rollbackAvailable: false };
  }
}

/** Build a read-only report. Unknown or damaged state is reported without claiming ownership. */
export async function buildHealthReport({ agentDir, projectDir = null, piVersion = null, packageRoot = PACKAGE_ROOT }) {
  if (typeof agentDir !== "string" || !path.isAbsolute(agentDir)) throw new Error("Absolute Pi agent directory is required");
  if (typeof packageRoot !== "string" || !path.isAbsolute(packageRoot)) throw new Error("Absolute Pify package directory is required");
  const warnings = [];
  let metadata = null;
  try {
    metadata = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    warnings.push(`Pify package metadata could not be read: ${error.message}`);
  }
  let owned = [];
  let inventoryStatus = "available";
  try {
    owned = await listOwnedFiles({ agentDir });
  } catch (error) {
    if (error.code !== "ENOENT") {
      inventoryStatus = "unavailable";
      warnings.push(`Pify ownership state could not be read: ${error.message}`);
    }
  }
  const install = await installStatus(agentDir, packageRoot, metadata, warnings);
  const themeSelection = await themeSelectionStatus(agentDir, warnings);
  let projectWorkflow = { status: "not_checked" };
  if (projectDir !== null) {
    try {
      projectWorkflow = await inspectProjectWorkflow({ projectDir });
    } catch (error) {
      warnings.push(`Project workflow could not be read: ${error.message}`);
      projectWorkflow = { status: "unavailable" };
    }
  }
  return {
    schema: "pify.health/v1",
    compatibility: {
      targetPiVersion: SUPPORTED_PI_VERSION,
      observedPiVersion: piVersion,
      status: piVersion === SUPPORTED_PI_VERSION ? "verified" : "unverified",
    },
    install,
    pifyPackageVersion: metadata?.version ?? null,
    bundledSkills: await bundledSkills(install, warnings, packageRoot),
    themeSelection,
    projectWorkflow,
    inventory: {
      status: inventoryStatus,
      managed: owned.filter((item) => item.action !== "conflict").map(({ relativePath, digest, version: resourceVersion }) => ({ relativePath, digest, version: resourceVersion })),
      conflicts: owned.filter((item) => item.action === "conflict").map(({ relativePath, reason }) => ({ relativePath, reason })),
    },
    optionalServices: "not_checked",
    warnings,
  };
}

export function formatHealthReport(report) {
  const lines = [
    `Pi ${report.compatibility.observedPiVersion ?? "unknown"}: ${report.compatibility.status} (target ${report.compatibility.targetPiVersion})`,
    `Pify package: ${report.install.status}${report.install.sourceKind ? ` (${report.install.sourceKind})` : ""}; metadata version ${report.pifyPackageVersion ?? "unknown"}`,
    `Bundled skills: ${report.bundledSkills.length}`,
    report.themeSelection.status === "available"
      ? `Saved theme: ${report.themeSelection.savedTheme ?? "none"}; Pify rollback: ${report.themeSelection.rollbackAvailable ? "available" : "unavailable"}`
      : `Theme recovery: ${report.themeSelection.status}`,
    `Project workflow: ${report.projectWorkflow.status}`,
    `Managed resources: ${report.inventory.managed.length}`,
  ];
  for (const item of report.bundledSkills) lines.push(`- ${item.name}: ${item.source} @ ${item.sourceVersion} (${item.license})`);
  for (const item of report.inventory.managed) lines.push(`- ${item.relativePath} (${item.version ?? "version unknown"})`);
  for (const item of report.inventory.conflicts) lines.push(`Conflict: ${item.relativePath} (${item.reason})`);
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  lines.push("Optional services: not checked");
  return lines.join("\n");
}
