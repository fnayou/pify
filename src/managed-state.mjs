import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

const RESOURCE_ROOTS = new Set(["extensions", "skills", "prompts", "themes"]);
const STATE_NAME = "pify-state";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function digestFile(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function resourcePath(relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw new Error("Resource path must be relative to the Pi agent directory");
  }
  const parts = relativePath.split("/");
  if (!RESOURCE_ROOTS.has(parts[0]) || parts.length < 2 || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Resource path must name an exact file under extensions, skills, prompts, or themes");
  }
  return parts.join(path.sep);
}

async function privateDirectory(directory) {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Pify state directory is not private: ${directory}`);
  }
}

async function privateJson(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Pify state file is not private: ${file}`);
  }
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function atomicJson(file, value) {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function stateFor(agentDir) {
  const agent = await fs.realpath(agentDir);
  const stateDir = path.join(agent, STATE_NAME);
  await privateDirectory(stateDir);
  const manifestPath = path.join(stateDir, "manifest.json");
  try {
    await fs.writeFile(manifestPath, '{"schemaVersion":1,"resources":{}}\n', { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const manifest = await privateJson(manifestPath);
  if (manifest.schemaVersion !== 1 || !manifest.resources || typeof manifest.resources !== "object" || Array.isArray(manifest.resources)) {
    throw new Error("Unsupported or invalid Pify ownership manifest");
  }
  return { agent, stateDir, manifestPath, manifest };
}

async function inspectTarget(agent, relativePath) {
  const parts = relativePath.split(path.sep);
  let current = agent;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return { target: path.join(agent, relativePath), exists: false };
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink in resource path: ${relativePath}`);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`Non-directory in resource path: ${relativePath}`);
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      throw new Error(`Only regular files can be prepared: ${relativePath}`);
    }
  }
  return { target: path.join(agent, relativePath), exists: true };
}

async function readTarget(target) {
  if (constants.O_NOFOLLOW === undefined) throw new Error("Platform lacks no-follow file opening");
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Resource is not a regular file: ${target}`);
    if (stat.nlink !== 1) throw new Error(`Hard-linked resource cannot be managed: ${target}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Prepare one exact resource change. This writes private state and a backup, never the resource. */
export async function prepareManagedFileChange({ agentDir, relativePath, expectedNewDigest }) {
  const relative = resourcePath(relativePath);
  if (!DIGEST_PATTERN.test(expectedNewDigest)) throw new Error("Expected new SHA-256 digest is required");
  const { agent, stateDir, manifest } = await stateFor(agentDir);
  const { target, exists } = await inspectTarget(agent, relative);
  const previous = manifest.resources[relative];
  let oldContent = null;

  if (exists) {
    if (!previous || previous.owner !== "pify" || previous.kind !== "file" || previous.target !== target || !DIGEST_PATTERN.test(previous.digest)) {
      throw new Error(`Existing resource has no valid Pify ownership record: ${relative}`);
    }
    oldContent = await readTarget(target);
    if (digestFile(oldContent) !== previous.digest) throw new Error(`Managed resource changed since ownership was recorded: ${relative}`);
  } else if (previous) {
    throw new Error(`Managed resource is missing: ${relative}`);
  }

  const backupRoot = path.join(stateDir, "backups");
  await privateDirectory(backupRoot);
  const id = randomUUID();
  const transactionDir = path.join(backupRoot, id);
  await privateDirectory(transactionDir);
  const backupPath = oldContent === null ? null : path.join(transactionDir, "prior");
  if (backupPath) await fs.writeFile(backupPath, oldContent, { flag: "wx", mode: 0o600 });
  const transaction = {
    schemaVersion: 1,
    id,
    status: "prepared",
    relativePath: relative,
    action: exists ? "replace" : "create",
    oldDigest: oldContent === null ? null : digestFile(oldContent),
    expectedNewDigest,
    backup: backupPath ? "prior" : null,
  };
  await fs.writeFile(path.join(transactionDir, "transaction.json"), `${JSON.stringify(transaction, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { id, action: transaction.action, backupPath };
}

/** Record ownership only after the prepared content exists and matches its planned digest. */
export async function completeManagedFileChange({ agentDir, transactionId }) {
  if (typeof transactionId !== "string" || !UUID_PATTERN.test(transactionId)) throw new Error("Invalid transaction id");
  const { agent, stateDir, manifestPath, manifest } = await stateFor(agentDir);
  const transactionPath = path.join(stateDir, "backups", transactionId, "transaction.json");
  const transaction = await privateJson(transactionPath);
  if (transaction.schemaVersion !== 1 || transaction.id !== transactionId || transaction.status !== "prepared") {
    throw new Error("Transaction is not prepared");
  }
  const relative = resourcePath(transaction.relativePath);
  const { target, exists } = await inspectTarget(agent, relative);
  if (!exists) throw new Error(`Prepared resource is missing: ${relative}`);
  const content = await readTarget(target);
  if (digestFile(content) !== transaction.expectedNewDigest) throw new Error(`Prepared content does not match its planned digest: ${relative}`);
  const previous = manifest.resources[relative];
  if (transaction.action === "create" && previous) throw new Error(`Resource was claimed during preparation: ${relative}`);
  if (transaction.action === "replace" && (!previous || previous.digest !== transaction.oldDigest || previous.target !== target)) {
    throw new Error(`Ownership changed during preparation: ${relative}`);
  }
  manifest.resources[relative] = {
    owner: "pify",
    kind: "file",
    target,
    origin: previous?.origin ?? "created",
    digest: transaction.expectedNewDigest,
  };
  await atomicJson(manifestPath, manifest);
  await atomicJson(transactionPath, { ...transaction, status: "committed" });
  return manifest.resources[relative];
}
