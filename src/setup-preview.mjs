import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildHealthReport } from "./health.mjs";

const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const GIT_SOURCE = "git:github.com/fnayou/pify";
const KINDS = ["extensions", "skills", "prompts", "themes"];
const MAX_RESOURCE_FILES = 100;
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
const RUNTIME_ROOTS = ["extensions", "src", "skills", "themes", "templates", "prompts"];
const MAX_RUNTIME_FILES = 200;
const MAX_RUNTIME_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_ENTRIES = 300;

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

async function digestRuntimeSource(root) {
  const hash = createHash("sha256").update("pify.runtime-source/v1\0");
  let fileCount = 0;
  let byteCount = 0;
  let entryCount = 0;
  async function visit(relativePath) {
    entryCount += 1;
    if (entryCount > MAX_RUNTIME_ENTRIES) throw new Error("Runtime source preview limit exceeded");
    const stat = await fs.lstat(path.join(root, relativePath));
    if (stat.isSymbolicLink()) throw new Error(`Symlinked runtime source: ${relativePath}`);
    if (stat.isDirectory()) {
      hash.update(`directory\0${relativePath}\0${stat.mode & 0o777}\0`);
      for (const name of (await fs.readdir(path.join(root, relativePath))).sort()) {
        await visit(`${relativePath}/${name}`);
      }
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe runtime source: ${relativePath}`);
    const { bytes, mode } = await regularBytes(path.join(root, relativePath));
    fileCount += 1;
    byteCount += bytes.length;
    if (fileCount > MAX_RUNTIME_FILES || byteCount > MAX_RUNTIME_BYTES) throw new Error("Runtime source preview limit exceeded");
    hash.update(`file\0${relativePath}\0${mode}\0${bytes.length}\0`);
    hash.update(bytes);
    hash.update("\0");
  }
  await visit("package.json");
  for (const directory of RUNTIME_ROOTS) {
    if (await lstatOrNull(path.join(root, directory))) await visit(directory);
    else hash.update(`missing\0${directory}\0`);
  }
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
  const runtimeDigest = await digestRuntimeSource(root);
  const reviewCode = createHash("sha256").update(`pify.local-source-review/v1\0${root}\0${runtimeDigest}`).digest("hex");
  return {
    schema: "pify.setup-preview/v1",
    status: "preview",
    source: { kind: "loaded_local_directory", path: root, declaredResourceDigest: packageHash.digest("hex"), runtimeDigest, reviewCode, origin: "not_verified" },
    package: { name: manifest.name, version: manifest.version, private: true, resources },
    piRegistration: { scope: "agent", action: alreadyDeclared ? "already_declared" : "add_local_package_declaration", owner: "pi" },
    firstInteractiveTheme: savedTheme === null ? { action: "select_pify", reason: "no saved theme" } : { action: "preserve", savedTheme },
    projectResources: "not_checked",
    npmGitIdentity: "not_checked",
  };
}

/** Compare a preview review code with the currently loaded and declared local package. */
export async function verifyLocalSetup({ agentDir, expectedReviewCode, packageRoot = PACKAGE_ROOT }) {
  if (typeof expectedReviewCode !== "string" || !/^[a-f0-9]{64}$/.test(expectedReviewCode)) {
    throw new Error("Expected a 64-character setup review code");
  }
  const preview = await previewLocalSetup({ agentDir, packageRoot });
  const declared = preview.piRegistration.action === "already_declared";
  return {
    schema: "pify.setup-verification/v1",
    status: !declared ? "not_installed" : preview.source.reviewCode === expectedReviewCode ? "verified" : "mismatch",
    source: { kind: preview.source.kind, path: preview.source.path, runtimeDigest: preview.source.runtimeDigest },
    piRegistration: preview.piRegistration,
  };
}

function gitDeclarations(settings) {
  return (settings.packages ?? [])
    .map((entry) => typeof entry === "string" ? entry : object(entry) ? entry.source : null)
    .filter((source) => typeof source === "string" && (source === GIT_SOURCE || source.startsWith(`${GIT_SOURCE}@`)));
}

function gitReviewCode(commit, runtimeDigest) {
  return createHash("sha256").update(`pify.git-source-review/v1\0${GIT_SOURCE}\0${commit}\0${runtimeDigest}`).digest("hex");
}

function requireFullCommit(commit) {
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected a full lowercase Git commit");
}

async function requireDetachedCommit(root, commit) {
  try {
    const gitDir = await fs.lstat(path.join(root, ".git"));
    const head = await fs.lstat(path.join(root, ".git", "HEAD"));
    if (gitDir.isDirectory() && !gitDir.isSymbolicLink() && head.isFile() && !head.isSymbolicLink() && head.size <= 41 &&
        (await fs.readFile(path.join(root, ".git", "HEAD"), "utf8")).trimEnd() === commit) return;
  } catch {
    // Missing or unsafe Git metadata cannot establish the requested checkout.
  }
  throw new Error("Expected a detached Git checkout at the requested commit");
}

/** Preview a reviewed clone without binding its review code to the clone path. */
export async function previewGitSetup({ agentDir, commit, packageRoot = PACKAGE_ROOT }) {
  requireFullCommit(commit);
  const local = await previewLocalSetup({ agentDir, packageRoot });
  await requireDetachedCommit(local.source.path, commit);
  const settings = await readAgentSettings(agentDir);
  const sources = gitDeclarations(settings);
  const npmDeclaration = (settings.packages ?? []).some((entry) => {
    const source = typeof entry === "string" ? entry : object(entry) ? entry.source : null;
    return typeof source === "string" && (source === "npm:@fnayou/pify" || source.startsWith("npm:@fnayou/pify@"));
  });
  const exactSource = `${GIT_SOURCE}@${commit}`;
  const action = npmDeclaration || local.piRegistration.action === "already_declared" ? "conflict" :
    sources.length === 0 ? "add_pinned_git_declaration" :
    sources.length === 1 && sources[0] === exactSource ? "already_declared" : "conflict";
  return {
    schema: "pify.git-setup-preview/v1",
    status: "preview",
    source: {
      kind: "reviewed_git_checkout", path: local.source.path, commit,
      declaredResourceDigest: local.source.declaredResourceDigest,
      runtimeDigest: local.source.runtimeDigest,
      reviewCode: gitReviewCode(commit, local.source.runtimeDigest), origin: "not_verified",
    },
    package: local.package,
    piRegistration: { scope: "agent", action, owner: "pi" },
    firstInteractiveTheme: local.firstInteractiveTheme,
    projectResources: "not_checked",
  };
}

/** Compare reviewed Git runtime bytes with Pi's declared managed checkout. */
export async function verifyGitSetup({ agentDir, commit, expectedReviewCode, packageRoot = PACKAGE_ROOT }) {
  requireFullCommit(commit);
  if (typeof expectedReviewCode !== "string" || !/^[a-f0-9]{64}$/.test(expectedReviewCode)) {
    throw new Error("Expected a 64-character setup review code");
  }
  const local = await previewLocalSetup({ agentDir, packageRoot });
  const sources = gitDeclarations(await readAgentSettings(agentDir));
  const declaration = sources.length === 0 ? "missing" :
    sources.length === 1 && sources[0] === `${GIT_SOURCE}@${commit}` ? "exact" : "conflicting";
  const health = await buildHealthReport({ agentDir, packageRoot });
  const verified = declaration === "exact" && health.install.status === "installed" && health.install.sourceKind === "git" &&
    gitReviewCode(commit, local.source.runtimeDigest) === expectedReviewCode;
  return {
    schema: "pify.git-setup-verification/v1",
    status: verified ? "verified" : declaration === "missing" ? "not_installed" : "mismatch",
    source: { kind: "managed_git_checkout", commit, path: local.source.path, runtimeDigest: local.source.runtimeDigest },
    piRegistration: { scope: "agent", declaration },
  };
}

export function formatSetupPreview(report) {
  const lines = [
    `Pify setup preview: ${report.package.name} ${report.package.version} (private local package)`,
    `Loaded directory: ${report.source.path}`,
    `Declared resource digest: ${report.source.declaredResourceDigest}`,
    `Runtime source digest: ${report.source.runtimeDigest}`,
    `Review code: ${report.source.reviewCode}`,
    `Pi registration: ${report.piRegistration.action}`,
    `First interactive theme: ${report.firstInteractiveTheme.action}${report.firstInteractiveTheme.savedTheme ? ` (${report.firstInteractiveTheme.savedTheme})` : ""}`,
  ];
  for (const resource of report.package.resources) {
    lines.push(`${resource.kind}: ${resource.relativePath}; agent collision: ${resource.collision.status}${resource.collision.type ? ` (${resource.collision.type})` : ""}; precedence: ${resource.precedence}`);
  }
  lines.push("Project resources and npm/git origin: not checked. No installation performed.");
  return lines.join("\n");
}

export function formatSetupVerification(report) {
  return `Pify local source: ${report.status}; loaded directory: ${report.source.path}; runtime digest: ${report.source.runtimeDigest}; Pi registration: ${report.piRegistration.action}`;
}

export function formatGitSetupPreview(report) {
  const lines = [
    `Pify Git setup preview: ${report.package.name} ${report.package.version} (private package)`,
    `Reviewed directory: ${report.source.path}`,
    `Commit: ${report.source.commit}; origin: ${report.source.origin}`,
    `Declared resource digest: ${report.source.declaredResourceDigest}`,
    `Runtime source digest: ${report.source.runtimeDigest}`,
    `Review code: ${report.source.reviewCode}`,
    `Pi registration: ${report.piRegistration.action}`,
    `First interactive theme: ${report.firstInteractiveTheme.action}${report.firstInteractiveTheme.savedTheme ? ` (${report.firstInteractiveTheme.savedTheme})` : ""}`,
  ];
  for (const resource of report.package.resources) {
    lines.push(`${resource.kind}: ${resource.relativePath}; agent collision: ${resource.collision.status}${resource.collision.type ? ` (${resource.collision.type})` : ""}; precedence: ${resource.precedence}`);
  }
  lines.push("Project resources and GitHub origin: not checked. No installation performed.");
  return lines.join("\n");
}

export function formatGitSetupVerification(report) {
  return `Pify Git source: ${report.status}; commit: ${report.source.commit}; runtime digest: ${report.source.runtimeDigest}; Pi declaration: ${report.piRegistration.declaration}`;
}
