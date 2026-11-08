import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const KINDS = ["extensions", "skills", "prompts", "themes"];
const MAX_RESOURCE_FILES = 100;
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactResourcePath(value, kind) {
  return typeof value === "string" && value.startsWith(`${kind}/`) && !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function regularBytes(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Unsafe package file: ${file}`);
  if (stat.size > MAX_RESOURCE_BYTES) throw new Error(`Package file exceeds preview limit: ${file}`);
  return { bytes: await fs.readFile(file), mode: stat.mode & 0o777 };
}

async function digestResource(root, relativePath) {
  const hash = createHash("sha256");
  let fileCount = 0;
  let byteCount = 0;
  async function visit(current) {
    const absolute = path.join(root, current);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symlinked package resource: ${current}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(absolute)).sort()) await visit(`${current}/${name}`);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe package resource: ${current}`);
    fileCount += 1;
    byteCount += stat.size;
    if (fileCount > MAX_RESOURCE_FILES || byteCount > MAX_RESOURCE_BYTES) throw new Error("Package resource preview limit exceeded");
    const { bytes, mode } = await regularBytes(absolute);
    hash.update(`${current}\0${mode}\0`);
    hash.update(bytes);
    hash.update("\0");
  }
  await visit(relativePath);
  if (fileCount === 0) throw new Error(`Empty package resource: ${relativePath}`);
  return hash.digest("hex");
}

async function collisionAt(agentDir, kind, name) {
  const parent = path.join(agentDir, kind);
  const parentStat = await lstatOrNull(parent);
  if (!parentStat) return { status: "none" };
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return { status: "unsafe_parent" };
  const stat = await lstatOrNull(path.join(parent, name));
  if (!stat) return { status: "none" };
  return { status: "present", type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other" };
}

async function readAgentSettings(agentDir) {
  const file = path.join(agentDir, "settings.json");
  const stat = await lstatOrNull(file);
  if (!stat) return {};
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe Pi settings file");
  let settings;
  try {
    settings = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Pi settings are invalid JSON");
    throw error;
  }
  if (!object(settings)) throw new Error("Pi settings must be an object");
  if (Object.hasOwn(settings, "theme") && typeof settings.theme !== "string") throw new Error("Pi theme setting must be a string");
  if (Object.hasOwn(settings, "packages") && !Array.isArray(settings.packages)) throw new Error("Pi packages setting must be an array");
  return settings;
}

/** Read-only preview for the current local package; no source-origin attestation. */
export async function previewLocalSetup({ agentDir, packageRoot = PACKAGE_ROOT }) {
  if (typeof agentDir !== "string" || !path.isAbsolute(agentDir)) throw new Error("Absolute Pi agent directory is required");
  const agentStat = await fs.lstat(agentDir);
  if (!agentStat.isDirectory() || agentStat.isSymbolicLink()) throw new Error("Unsafe Pi agent directory");
  if (typeof packageRoot !== "string" || !path.isAbsolute(packageRoot)) throw new Error("Absolute package directory is required");
  const root = await fs.realpath(packageRoot);
  const { bytes: manifestBytes } = await regularBytes(path.join(root, "package.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest?.name !== "@fnayou/pify" || manifest.private !== true || !object(manifest.pi)) {
    throw new Error("Expected the private Pify package manifest");
  }
  const settings = await readAgentSettings(agentDir);
  const resources = [];
  const packageHash = createHash("sha256").update(manifestBytes);
  for (const kind of KINDS) {
    const entries = manifest.pi[kind];
    if (!Array.isArray(entries) || entries.length > 32) throw new Error(`Invalid package ${kind} manifest`);
    for (const relativePath of entries) {
      if (!exactResourcePath(relativePath, kind)) throw new Error(`Unsupported package resource path: ${relativePath}`);
      const digest = await digestResource(root, relativePath);
      const name = path.posix.basename(relativePath);
      const collision = await collisionAt(agentDir, kind, name);
      resources.push({ kind, relativePath, digest, collision, precedence: "not_verified" });
      packageHash.update(`\0${kind}\0${relativePath}\0${digest}`);
    }
  }
  const packages = settings.packages ?? [];
  let alreadyDeclared = false;
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : object(entry) ? entry.source : null;
    if (typeof source !== "string" || /^(npm:|git:|https?:)/.test(source)) continue;
    try {
      if (await fs.realpath(path.resolve(agentDir, source)) === root) alreadyDeclared = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const savedTheme = Object.hasOwn(settings, "theme") ? settings.theme : null;
  return {
    schema: "pify.setup-preview/v1",
    status: "preview",
    source: { kind: "loaded_local_directory", path: root, declaredResourceDigest: packageHash.digest("hex"), origin: "not_verified" },
    package: { name: manifest.name, version: manifest.version, private: true, resources },
    piRegistration: { scope: "agent", action: alreadyDeclared ? "already_declared" : "add_local_package_declaration", owner: "pi" },
    firstInteractiveTheme: savedTheme === null ? { action: "select_pify", reason: "no saved theme" } : { action: "preserve", savedTheme },
    projectResources: "not_checked",
    npmGitIdentity: "not_checked",
  };
}

export function formatSetupPreview(report) {
  const lines = [
    `Pify setup preview: ${report.package.name} ${report.package.version} (private local package)`,
    `Loaded directory: ${report.source.path}`,
    `Declared resource digest: ${report.source.declaredResourceDigest}`,
    `Pi registration: ${report.piRegistration.action}`,
    `First interactive theme: ${report.firstInteractiveTheme.action}${report.firstInteractiveTheme.savedTheme ? ` (${report.firstInteractiveTheme.savedTheme})` : ""}`,
  ];
  for (const resource of report.package.resources) {
    lines.push(`${resource.kind}: ${resource.relativePath}; agent collision: ${resource.collision.status}${resource.collision.type ? ` (${resource.collision.type})` : ""}; precedence: ${resource.precedence}`);
  }
  lines.push("Project resources and npm/git origin: not checked. No installation performed.");
  return lines.join("\n");
}
