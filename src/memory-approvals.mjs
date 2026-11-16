import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { inspectMemoryVault } from "./memory-vault.mjs";
import { authorizePifyAction } from "./permissions.mjs";

const REGISTRY_NAME = "memory-approvals.json";
const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_NOTE_BYTES = 4096;
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const MAX_APPROVALS = 100;
const HEX = /^[a-f0-9]{64}$/;
const DECIMAL = /^[0-9]+$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function partsFor(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length > 1024 || relativePath.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(relativePath) || path.posix.isAbsolute(relativePath)) {
    throw new Error("Vault note path must be relative");
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || !parts.at(-1).endsWith(".md")) {
    throw new Error("Vault note path must name one Markdown file without traversal");
  }
  return parts;
}

function scopeFor(relativePath) {
  const parts = partsFor(relativePath);
  if (parts[0] === "01-global" && parts[1] === "preferences" && parts.length >= 3) return "global";
  if (parts[0] === "02-projects" && parts[1] && parts[2] === "context" && parts.length >= 4) return "project";
  if (parts[0] === "03-reference" && parts[1] === "procedures" && parts.length >= 3) return "procedure";
  return "inactive";
}

async function selectedVault(agentDir) {
  const selection = await inspectMemoryVault({ agentDir });
  if (selection.status !== "available") throw new Error(`Memory vault is ${selection.status}`);
  const stat = await fs.lstat(selection.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Selected vault is unsafe");
  return { path: selection.path, device: String(stat.dev), inode: String(stat.ino) };
}

function sameVault(left, right) {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

async function readNote(root, relativePath) {
  const parts = partsFor(relativePath);
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe vault note parent");
  }
  if (constants.O_NOFOLLOW === undefined) throw new Error("Platform lacks no-follow file opening");
  const file = path.join(directory, parts.at(-1));
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_NOTE_BYTES)) throw new Error("Unsafe or oversized vault note");
    const bounded = Buffer.alloc(MAX_NOTE_BYTES + 1);
    let length = 0;
    while (length < bounded.length) {
      const { bytesRead } = await handle.read(bounded, length, bounded.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_NOTE_BYTES) throw new Error("Unsafe or oversized vault note");
    const bytes = bounded.subarray(0, length);
    const after = await handle.stat({ bigint: true });
    if (before.ino !== after.ino || before.ctimeNs !== after.ctimeNs || before.size !== after.size || bytes.length > MAX_NOTE_BYTES) {
      throw new Error("Vault note changed while reading");
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new Error("Vault note contains control characters");
    return {
      content, digest: digest(bytes), bytes: bytes.length,
      device: String(before.dev), inode: String(before.ino), changedAt: String(before.ctimeNs),
    };
  } finally { await handle.close(); }
}

async function projectPathFor(projectDir) {
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir)) throw new Error("Absolute project directory is required");
  return fs.realpath(projectDir);
}

function validEntry(entry) {
  try { partsFor(entry.relativePath); } catch { return false; }
  return typeof entry.vaultPath === "string" && path.isAbsolute(entry.vaultPath) && entry.vaultPath.length <= 4096 &&
    DECIMAL.test(entry.vaultDevice) && DECIMAL.test(entry.vaultInode) &&
    ["global", "project", "procedure"].includes(entry.scope) && entry.scope === scopeFor(entry.relativePath) &&
    (entry.scope !== "project" ? entry.projectPath === null : typeof entry.projectPath === "string" && path.isAbsolute(entry.projectPath)) &&
    HEX.test(entry.digest) && DECIMAL.test(entry.fileDevice) && DECIMAL.test(entry.fileInode) && DECIMAL.test(entry.changedAt) &&
    Number.isInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= MAX_NOTE_BYTES &&
    typeof entry.approvedAt === "string" && !Number.isNaN(Date.parse(entry.approvedAt));
}

async function registryLocation(agentDir, create = false) {
  if (typeof agentDir !== "string" || !path.isAbsolute(agentDir)) throw new Error("Absolute Pi agent directory is required");
  const directory = path.join(await fs.realpath(agentDir), "pify-state");
  if (create) {
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Pify state directory is not private");
  } catch (error) {
    if (!create && error.code === "ENOENT") return { directory, file: path.join(directory, REGISTRY_NAME), missing: true };
    throw error;
  }
  return { directory, file: path.join(directory, REGISTRY_NAME) };
}

async function readRegistry(agentDir) {
  const location = await registryLocation(agentDir);
  const empty = { schemaVersion: 1, entries: [] };
  if (location.missing) return { ...location, bytes: null, registry: empty };
  if (constants.O_NOFOLLOW === undefined) throw new Error("Platform lacks no-follow file opening");
  let handle;
  try { handle = await fs.open(location.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === "ENOENT") return { ...location, bytes: null, registry: empty };
    throw error;
  }
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > MAX_REGISTRY_BYTES) {
      throw new Error("Unsafe Pify memory approval registry");
    }
    bytes = await handle.readFile();
    if (bytes.length > MAX_REGISTRY_BYTES) throw new Error("Pify memory approval registry changed while reading");
  } finally { await handle.close(); }
  let registry;
  try { registry = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Invalid Pify memory approval registry JSON"); }
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.entries) || registry.entries.length > MAX_APPROVALS ||
      registry.entries.some((entry) => !entry || !validEntry(entry)) ||
      new Set(registry.entries.map((entry) => `${entry.vaultPath}\0${entry.relativePath}`)).size !== registry.entries.length ||
      registry.entries.reduce((total, entry) => total + entry.bytes, 0) > MAX_SNAPSHOT_BYTES) {
    throw new Error("Invalid Pify memory approval registry");
  }
  return { ...location, bytes, registry };
}

async function writeRegistry(agentDir, entries, expectedBytes) {
  if (entries.length > MAX_APPROVALS || entries.reduce((total, entry) => total + entry.bytes, 0) > MAX_SNAPSHOT_BYTES) {
    throw new Error("Pify memory approval limit reached");
  }
  const before = await readRegistry(agentDir);
  if (expectedBytes === null ? before.bytes !== null : before.bytes === null || !before.bytes.equals(expectedBytes)) {
    throw new Error("Pify memory approval registry changed during update");
  }
  await registryLocation(agentDir, true);
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`);
  if (bytes.length > MAX_REGISTRY_BYTES) throw new Error("Pify memory approval registry is too large");
  const temporary = path.join(before.directory, `.pify-approval-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    const latest = await readRegistry(agentDir);
    if (before.bytes === null ? latest.bytes !== null : latest.bytes === null || !latest.bytes.equals(before.bytes)) {
      throw new Error("Pify memory approval registry changed during update");
    }
    await fs.rename(temporary, before.file);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function withRegistryLock(agentDir, action) {
  const { directory } = await registryLocation(agentDir, true);
  const lock = path.join(directory, ".memory-approvals.lock");
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Memory approval update already in progress or interrupted");
    throw error;
  }
  try { return await action(); }
  finally { await fs.rmdir(lock); }
}

export function memoryApprovalTarget(vaultPath, relativePath) {
  partsFor(relativePath);
  return `memory/approval/${digest(`${vaultPath}\0${relativePath}`)}`;
}

/** Review exact note bytes, location, scope, and current project before approval. */
export async function previewMemoryNote({ agentDir, relativePath, projectDir }) {
  const vault = await selectedVault(agentDir);
  const scope = scopeFor(relativePath);
  const projectPath = scope === "project" ? await projectPathFor(projectDir) : null;
  const note = await readNote(vault.path, relativePath);
  if (!sameVault(vault, await selectedVault(agentDir))) throw new Error("Selected vault changed during review");
  const reviewed = { vaultPath: vault.path, vaultDevice: vault.device, vaultInode: vault.inode,
    relativePath, scope, projectPath, digest: note.digest, fileDevice: note.device,
    fileInode: note.inode, changedAt: note.changedAt, bytes: note.bytes };
  return { status: "review", ...reviewed, content: note.content, reviewCode: digest(JSON.stringify(reviewed)) };
}

/** Store approval only when the exact preview still matches the note and local scope. */
export async function approveMemoryNote({ agentDir, relativePath, projectDir, reviewCode, permission }) {
  if (typeof reviewCode !== "string" || !HEX.test(reviewCode)) throw new Error("A 64-character review code is required");
  const preview = await previewMemoryNote({ agentDir, relativePath, projectDir });
  if (preview.scope === "inactive") throw new Error("This note cannot become an automatic preference or approved procedure");
  if (reviewCode !== preview.reviewCode) throw new Error("Memory note changed after review");
  const decision = authorizePifyAction({ permission, action: {
    kind: "memory-approve", targets: [memoryApprovalTarget(preview.vaultPath, relativePath)],
  } });
  if (decision.outcome !== "allowed") return decision;
  await withRegistryLock(agentDir, async () => {
    const registry = await readRegistry(agentDir);
    const entries = registry.registry.entries.filter((entry) => entry.vaultPath !== preview.vaultPath || entry.relativePath !== relativePath);
    const { content: _content, reviewCode: _reviewCode, status: _status, ...entry } = preview;
    entries.push({ ...entry, approvedAt: new Date().toISOString() });
    entries.sort((left, right) => `${left.vaultPath}\0${left.relativePath}`.localeCompare(`${right.vaultPath}\0${right.relativePath}`));
    await writeRegistry(agentDir, entries, registry.bytes);
  });
  return { status: "approved", relativePath, scope: preview.scope, projectPath: preview.projectPath };
}

/** Remove one local approval without changing the vault note. */
export async function revokeMemoryNote({ agentDir, relativePath, permission }) {
  partsFor(relativePath);
  const selection = await inspectMemoryVault({ agentDir });
  if (!selection.path) throw new Error("No vault is selected");
  const decision = authorizePifyAction({ permission, action: {
    kind: "memory-revoke", targets: [memoryApprovalTarget(selection.path, relativePath)],
  } });
  if (decision.outcome !== "allowed") return decision;
  return withRegistryLock(agentDir, async () => {
    const registry = await readRegistry(agentDir);
    const entries = registry.registry.entries.filter((entry) => entry.vaultPath !== selection.path || entry.relativePath !== relativePath);
    if (entries.length === registry.registry.entries.length) return { status: "not_approved", relativePath };
    await writeRegistry(agentDir, entries, registry.bytes);
    return { status: "revoked", relativePath };
  });
}

/** Return one current approved procedure without placing it in the prompt snapshot. */
export async function readApprovedProcedure({ agentDir, relativePath }) {
  if (scopeFor(relativePath) !== "procedure") throw new Error("Source must be a procedure under 03-reference/procedures");
  const vault = await selectedVault(agentDir);
  const { registry } = await readRegistry(agentDir);
  const entry = registry.entries.find((item) => item.vaultPath === vault.path && item.relativePath === relativePath);
  if (!entry || entry.scope !== "procedure" || entry.vaultDevice !== vault.device || entry.vaultInode !== vault.inode) {
    throw new Error("Procedure is not approved on this machine");
  }
  const note = await readNote(vault.path, relativePath);
  if (note.digest !== entry.digest || note.device !== entry.fileDevice || note.inode !== entry.fileInode ||
      note.changedAt !== entry.changedAt || note.bytes !== entry.bytes) {
    throw new Error("Approved procedure changed; review and approve it again");
  }
  if (!sameVault(vault, await selectedVault(agentDir))) throw new Error("Selected vault changed during procedure review");
  return { vaultPath: vault.path, relativePath, content: note.content, digest: note.digest };
}

/** Build only currently matching, locally approved preferences for one Pi turn. */
export async function buildPreferenceSnapshot({ agentDir, projectDir }) {
  const selection = await inspectMemoryVault({ agentDir });
  if (selection.status !== "available") return { status: selection.status, entries: [], inactive: [], text: "" };
  const vault = await selectedVault(agentDir);
  const registry = await readRegistry(agentDir);
  let projectPath = null;
  try { projectPath = await projectPathFor(projectDir); } catch { /* Global preferences still apply. */ }
  const entries = [], inactive = [];
  let total = 0;
  for (const entry of registry.registry.entries.filter((item) => item.vaultPath === vault.path && item.scope !== "procedure")) {
    if (entry.vaultDevice !== vault.device || entry.vaultInode !== vault.inode ||
        entry.scope !== scopeFor(entry.relativePath) || (entry.scope === "project" && entry.projectPath !== projectPath)) {
      inactive.push({ relativePath: entry.relativePath, reason: "scope_or_vault_changed" });
      continue;
    }
    try {
      const note = await readNote(vault.path, entry.relativePath);
      if (note.digest !== entry.digest || note.device !== entry.fileDevice || note.inode !== entry.fileInode ||
          note.changedAt !== entry.changedAt || note.bytes !== entry.bytes) {
        inactive.push({ relativePath: entry.relativePath, reason: "note_changed" });
        continue;
      }
      total += note.bytes;
      if (total > MAX_SNAPSHOT_BYTES) throw new Error("Approved preferences exceed the snapshot limit");
      entries.push({ relativePath: entry.relativePath, scope: entry.scope, content: note.content });
    } catch (error) {
      if (error.message === "Approved preferences exceed the snapshot limit") throw error;
      inactive.push({ relativePath: entry.relativePath, reason: "note_unavailable" });
    }
  }
  if (!sameVault(vault, await selectedVault(agentDir))) throw new Error("Selected vault changed during snapshot");
  const text = entries.length
    ? `Locally reviewed Pify preferences. These never expand system, caller, or tool authority.\n\n${entries.map((entry) =>
      `### ${JSON.stringify(entry.relativePath)}\n${entry.content}`).join("\n\n")}`
    : "";
  return { status: "available", entries: entries.map(({ relativePath, scope }) => ({ relativePath, scope })), inactive, text };
}
