import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listOwnedFiles } from "./managed-state.mjs";

const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const SUPPORTED_PI_VERSION = "1.4.0";

async function installStatus(agentDir, warnings) {
  let settings;
  try {
    settings = JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { status: "not_installed", evidence: "no agent settings" };
    warnings.push(`Pi settings could not be read: ${error.message}`);
    return { status: "unknown", evidence: "settings unavailable" };
  }
  if (!Array.isArray(settings?.packages)) return { status: "not_installed", evidence: "no package declarations" };
  const declared = settings.packages.some((entry) => typeof entry === "string" && path.resolve(agentDir, entry) === PACKAGE_ROOT);
  return { status: declared ? "installed" : "not_installed", evidence: declared ? "matching Pi package declaration" : "no matching Pi package declaration" };
}

async function bundledSkills(install, warnings) {
  if (install.status !== "installed") return [];
  try {
    const catalog = JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, "skills", "catalog.json"), "utf8"));
    if (catalog.schema !== "pify.skills/v1" || !Array.isArray(catalog.skills)) throw new Error("invalid skill catalog");
    const skills = [];
    for (const item of catalog.skills) {
      if (typeof item.name !== "string" || typeof item.path !== "string" ||
          !/^skills\/[a-z0-9-]+$/.test(item.path) || typeof item.source !== "string" ||
          typeof item.sourceVersion !== "string" || item.license !== "MIT") {
        throw new Error("invalid skill provenance");
      }
      const stat = await fs.lstat(path.join(PACKAGE_ROOT, item.path, "SKILL.md"));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid skill file: ${item.path}`);
      skills.push({ name: item.name, source: item.source, sourceVersion: item.sourceVersion, license: item.license });
    }
    return skills;
  } catch (error) {
    warnings.push(`Bundled skill provenance could not be read: ${error.message}`);
    return [];
  }
}

/** Build a read-only report. Unknown or damaged state is reported without claiming ownership. */
export async function buildHealthReport({ agentDir, piVersion = null }) {
  if (typeof agentDir !== "string" || !path.isAbsolute(agentDir)) throw new Error("Absolute Pi agent directory is required");
  const warnings = [];
  let version = null;
  try {
    version = JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version ?? null;
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
  const install = await installStatus(agentDir, warnings);
  return {
    schema: "pify.health/v1",
    compatibility: {
      targetPiVersion: SUPPORTED_PI_VERSION,
      observedPiVersion: piVersion,
      status: piVersion === SUPPORTED_PI_VERSION ? "verified" : "unverified",
    },
    install,
    pifyPackageVersion: version,
    bundledSkills: await bundledSkills(install, warnings),
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
    `Pify package: ${report.install.status}; metadata version ${report.pifyPackageVersion ?? "unknown"}`,
    `Bundled skills: ${report.bundledSkills.length}`,
    `Managed resources: ${report.inventory.managed.length}`,
  ];
  for (const item of report.bundledSkills) lines.push(`- ${item.name}: ${item.source} @ ${item.sourceVersion} (${item.license})`);
  for (const item of report.inventory.managed) lines.push(`- ${item.relativePath} (${item.version ?? "version unknown"})`);
  for (const item of report.inventory.conflicts) lines.push(`Conflict: ${item.relativePath} (${item.reason})`);
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  lines.push("Optional services: not checked");
  return lines.join("\n");
}
