import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { authorizePifyAction } from "./permissions.mjs";

export const MEMORY_STATE_RESOURCE = "memory/vault-selection";
export const MEMORY_SCAFFOLD_VERSION = 1;
export const MEMORY_DIRECTORIES = Object.freeze([
  "00-inbox",
  "01-global",
  "01-global/preferences",
  "01-global/environment",
  "01-global/workflows",
  "01-global/knowledge",
  "02-projects",
  "03-reference",
  "03-reference/tools",
  "03-reference/research",
  "03-reference/procedures",
  "99-archive",
]);

const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const STATE_FILE = "memory-vault.json";
const MAX_STATE_BYTES = 8192;

function inside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function requireAgentDir(agentDir) {
  if (typeof agentDir !== "string" || !path.isAbsolute(agentDir)) throw new Error("Absolute Pi agent directory is required");
  return agentDir;
}

async function privateStateLocation(agentDir, create = false) {
  const agent = await fs.realpath(requireAgentDir(agentDir));
  const directory = path.join(agent, "pify-state");
  if (create) {
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Pify state directory is not private");
  } catch (error) {
    if (!create && error.code === "ENOENT") return { directory, file: path.join(directory, STATE_FILE), bytes: null, state: null };
    throw error;
  }
  return { directory, file: path.join(directory, STATE_FILE) };
}

async function readState(agentDir) {
  const location = await privateStateLocation(agentDir);
  if ("state" in location) return location;
  if (constants.O_NOFOLLOW === undefined) throw new Error("Platform lacks no-follow file opening");
  let handle;
  try { handle = await fs.open(location.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === "ENOENT") return { ...location, bytes: null, state: null };
    throw error;
  }
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > MAX_STATE_BYTES) {
      throw new Error("Unsafe Pify memory selection");
    }
    bytes = await handle.readFile();
    if (bytes.length > MAX_STATE_BYTES) throw new Error("Pify memory selection changed while reading");
  } finally { await handle.close(); }
  let state;
  try { state = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Invalid Pify memory selection JSON"); }
  if (state?.schemaVersion !== 1 || !["connected", "skipped"].includes(state.status) ||
      (state.status === "connected"
        ? typeof state.path !== "string" || !path.isAbsolute(state.path) || state.path.length > 4096 || state.scaffoldVersion !== MEMORY_SCAFFOLD_VERSION ||
          !/^[0-9]+$/.test(state.device) || !/^[0-9]+$/.test(state.inode)
        : "path" in state || "scaffoldVersion" in state || "device" in state || "inode" in state)) {
    throw new Error("Invalid Pify memory selection");
  }
  return { ...location, bytes, state };
}

async function writeState(agentDir, state) {
  const before = await readState(agentDir);
  await privateStateLocation(agentDir, true);
  const next = Buffer.from(`${JSON.stringify({ schemaVersion: 1, ...state }, null, 2)}\n`);
  const temporary = path.join(before.directory, `.pify-memory-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(next); await handle.sync(); }
    finally { await handle.close(); }
    const latest = await readState(agentDir);
    if (before.bytes === null ? latest.bytes !== null : latest.bytes === null || !latest.bytes.equals(before.bytes)) {
      throw new Error("Pify memory selection changed during update");
    }
    await fs.rename(temporary, before.file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function resolveMemoryVaultPath(agentDir, vaultPath) {
  if (typeof vaultPath !== "string" || !path.isAbsolute(vaultPath) || path.basename(vaultPath) === "") {
    throw new Error("Absolute vault path below an existing parent directory is required");
  }
  const parent = await fs.realpath(path.dirname(path.resolve(vaultPath)));
  const candidate = path.join(parent, path.basename(vaultPath));
  const agent = await fs.realpath(requireAgentDir(agentDir));
  if (inside(candidate, agent) || inside(candidate, PACKAGE_ROOT)) {
    throw new Error("Vault must be outside Pi agent and Pify package directories");
  }
  return candidate;
}

export function memoryVaultTargets(vaultPath) {
  if (typeof vaultPath !== "string" || !path.isAbsolute(vaultPath)) throw new Error("Absolute vault path is required");
  const id = createHash("sha256").update(vaultPath).digest("hex");
  return [MEMORY_STATE_RESOURCE, `memory/vault-path/${id}`];
}

async function regularDirectory(directory) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe vault directory: ${directory}`);
  return stat;
}

async function vaultIdentity(root) {
  const stat = await regularDirectory(root);
  return { device: String(stat.dev), inode: String(stat.ino) };
}

async function inspectScaffold(root) {
  await regularDirectory(root);
  for (const relative of MEMORY_DIRECTORIES) {
    try { await regularDirectory(path.join(root, relative)); }
    catch (error) {
      if (error.code === "ENOENT") return { available: false, reason: `Missing vault scope: ${relative}` };
      throw error;
    }
  }
  return { available: true, identity: await vaultIdentity(root) };
}

async function ensureScaffold(root) {
  await regularDirectory(root);
  for (const relative of MEMORY_DIRECTORIES) {
    const directory = path.join(root, relative);
    try { await regularDirectory(directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const relative of MEMORY_DIRECTORIES) {
    const directory = path.join(root, relative);
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await regularDirectory(directory);
  }
  return vaultIdentity(root);
}

/** Read local selection and report a missing or changed vault without replacing it. */
export async function inspectMemoryVault({ agentDir }) {
  const { state } = await readState(agentDir);
  if (!state) return { status: "unconfigured" };
  if (state.status === "skipped") return { status: "skipped" };
  try {
    const check = await inspectScaffold(state.path);
    if (!check.available) return { status: "unavailable", path: state.path, reason: check.reason };
    if (check.identity.device !== state.device || check.identity.inode !== state.inode) {
      return { status: "unavailable", path: state.path, reason: "Selected vault identity changed" };
    }
    return { status: "available", path: state.path, scaffoldVersion: state.scaffoldVersion };
  } catch (error) {
    return { status: "unavailable", path: state.path, reason: error.message };
  }
}

/** Create only empty scope directories, then select the new vault. */
export async function createMemoryVault({ agentDir, vaultPath, permission }) {
  const root = await resolveMemoryVaultPath(agentDir, vaultPath);
  const decision = authorizePifyAction({ permission, action: { kind: "memory-create", targets: memoryVaultTargets(root) } });
  if (decision.outcome !== "allowed") return decision;
  await readState(agentDir);
  await fs.mkdir(root, { mode: 0o700 });
  const identity = await ensureScaffold(root);
  await writeState(agentDir, { status: "connected", path: root, scaffoldVersion: MEMORY_SCAFFOLD_VERSION, ...identity });
  return { status: "created", path: root, scaffoldVersion: MEMORY_SCAFFOLD_VERSION };
}

/** Add missing scope directories to an existing vault; preserve every existing entry. */
export async function connectMemoryVault({ agentDir, vaultPath, permission }) {
  const root = await resolveMemoryVaultPath(agentDir, vaultPath);
  const decision = authorizePifyAction({ permission, action: { kind: "memory-connect", targets: memoryVaultTargets(root) } });
  if (decision.outcome !== "allowed") return decision;
  await readState(agentDir);
  const identity = await ensureScaffold(root);
  await writeState(agentDir, { status: "connected", path: root, scaffoldVersion: MEMORY_SCAFFOLD_VERSION, ...identity });
  return { status: "connected", path: root, scaffoldVersion: MEMORY_SCAFFOLD_VERSION };
}

/** Stop using memory without deleting the previous vault. */
export async function skipMemoryVault({ agentDir, permission }) {
  const decision = authorizePifyAction({ permission, action: { kind: "memory-skip", targets: [MEMORY_STATE_RESOURCE] } });
  if (decision.outcome !== "allowed") return decision;
  await writeState(agentDir, { status: "skipped" });
  return { status: "skipped" };
}
