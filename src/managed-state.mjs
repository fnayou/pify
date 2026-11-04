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

async function existingStateFor(agentDir) {
  const agent = await fs.realpath(agentDir);
  const stateDir = path.join(agent, STATE_NAME);
  try {
    await fs.lstat(stateDir);
  } catch (error) {
    if (error.code === "ENOENT") return { agent, manifest: { schemaVersion: 1, resources: {} } };
    throw error;
  }
  await privateDirectory(stateDir);
  const manifest = await privateJson(path.join(stateDir, "manifest.json"));
  if (manifest.schemaVersion !== 1 || !manifest.resources || typeof manifest.resources !== "object" || Array.isArray(manifest.resources)) {
    throw new Error("Unsupported or invalid Pify ownership manifest");
  }
  return { agent, manifest };
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

async function missingResourceParents(agent, relative) {
  const missing = [];
  let current = agent;
  let currentRelative = "";
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    currentRelative = currentRelative ? path.join(currentRelative, part) : part;
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe resource parent: ${relative}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(currentRelative);
    }
  }
  return missing;
}

async function readTarget(target) {
  if (constants.O_NOFOLLOW === undefined) throw new Error("Platform lacks no-follow file opening");
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Resource is not a regular file: ${target}`);
    if (stat.nlink !== 1) throw new Error(`Hard-linked resource cannot be managed: ${target}`);
    if (stat.mode & 0o7000) throw new Error(`Resource has unsupported mode bits: ${target}`);
    return { content: await handle.readFile(), mode: stat.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

/** Read-only classification for one exact planned path. Conflicts never become ownership. */
export async function inspectManagedFile({ agentDir, relativePath }) {
  const relative = resourcePath(relativePath);
  const { agent, manifest } = await existingStateFor(agentDir);
  const target = path.join(agent, relative);
  const previous = manifest.resources[relative] ?? null;
  let exists;
  try {
    ({ exists } = await inspectTarget(agent, relative));
  } catch (error) {
    return { relativePath: relative, target, action: "conflict", reason: error.message, oldDigest: null };
  }
  if (!exists) {
    return {
      relativePath: relative,
      target,
      action: previous ? "conflict" : "create",
      reason: previous ? "Managed resource is missing" : null,
      oldDigest: null,
      parentsToCreate: await missingResourceParents(agent, relative),
    };
  }
  let oldDigest;
  let mode;
  try {
    const prior = await readTarget(target);
    oldDigest = digestFile(prior.content);
    mode = prior.mode;
  } catch (error) {
    return { relativePath: relative, target, action: "conflict", reason: error.message, oldDigest: null };
  }
  if (!previous) return { relativePath: relative, target, action: "conflict", reason: "unowned", oldDigest, mode };
  if (previous.owner !== "pify" || previous.kind !== "file" || previous.target !== target || previous.digest !== oldDigest) {
    return { relativePath: relative, target, action: "conflict", reason: "ownership or content drift", oldDigest, mode };
  }
  return { relativePath: relative, target, action: "replace", reason: null, oldDigest, mode };
}

/** Read-only list of recorded ownership for uninstall preview. */
export async function listOwnedFiles({ agentDir }) {
  const { agent, manifest } = await existingStateFor(agentDir);
  const entries = [];
  for (const [relativePath, record] of Object.entries(manifest.resources)) {
    let inspected;
    try {
      inspected = await inspectManagedFile({ agentDir, relativePath });
    } catch (error) {
      inspected = { action: "conflict", reason: error.message };
    }
    let valid = inspected.action === "replace" && (record.origin === "created" || record.origin === "adopted") && UUID_PATTERN.test(record.lastTransactionId);
    if (valid) {
      try {
        const { transaction } = await transactionFor(path.join(agent, STATE_NAME), record.lastTransactionId);
        valid = transaction.relativePath === relativePath && transaction.expectedNewDigest === record.digest && ["prepared", "committed"].includes(transaction.status);
      } catch {
        valid = false;
      }
    }
    entries.push({
      relativePath,
      action: valid ? (record.origin === "adopted" ? "restore" : "remove") : "conflict",
      reason: valid ? null : (inspected.reason ?? "Missing transaction provenance"),
      digest: record.digest,
      version: record.version ?? null,
      lastTransactionId: record.lastTransactionId ?? null,
    });
  }
  return entries;
}

/** Prepare one exact resource change. This writes private state and a backup, never the resource. */
export async function prepareManagedFileChange({ agentDir, relativePath, expectedNewDigest, adoptExisting = false, expectedOldDigest = null, expectedOldMode = null }) {
  const relative = resourcePath(relativePath);
  if (!DIGEST_PATTERN.test(expectedNewDigest)) throw new Error("Expected new SHA-256 digest is required");
  const { agent, stateDir, manifest } = await stateFor(agentDir);
  const { target, exists } = await inspectTarget(agent, relative);
  const previous = manifest.resources[relative];
  let oldContent = null;
  let oldMode = null;

  if (exists) {
    if (!previous && !adoptExisting) {
      throw new Error(`Existing resource has no valid Pify ownership record: ${relative}`);
    }
    if (previous && (adoptExisting || previous.owner !== "pify" || previous.kind !== "file" || previous.target !== target || !DIGEST_PATTERN.test(previous.digest))) {
      throw new Error(`Existing resource has no valid Pify ownership record: ${relative}`);
    }
    ({ content: oldContent, mode: oldMode } = await readTarget(target));
    if (previous && digestFile(oldContent) !== previous.digest) throw new Error(`Managed resource changed since ownership was recorded: ${relative}`);
    if (expectedOldDigest !== null && digestFile(oldContent) !== expectedOldDigest) throw new Error(`Resource changed after preview: ${relative}`);
    if (expectedOldMode !== null && oldMode !== expectedOldMode) throw new Error(`Resource mode changed after preview: ${relative}`);
  } else if (previous) {
    throw new Error(`Managed resource is missing: ${relative}`);
  } else if (expectedOldDigest !== null) {
    throw new Error(`Resource changed after preview: ${relative}`);
  } else if (expectedOldMode !== null) {
    throw new Error(`Resource mode changed after preview: ${relative}`);
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
    action: exists ? (previous ? "replace" : "adopt") : "create",
    oldDigest: oldContent === null ? null : digestFile(oldContent),
    oldMode,
    previousRecord: previous ?? null,
    createdParents: exists ? [] : await missingResourceParents(agent, relative),
    expectedNewDigest,
    packageVersion: JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).version,
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
  const { content } = await readTarget(target);
  if (digestFile(content) !== transaction.expectedNewDigest) throw new Error(`Prepared content does not match its planned digest: ${relative}`);
  const previous = manifest.resources[relative];
  if ((transaction.action === "create" || transaction.action === "adopt") && previous) throw new Error(`Resource was claimed during preparation: ${relative}`);
  if (transaction.action === "replace" && (!previous || previous.digest !== transaction.oldDigest || previous.target !== target || previous.lastTransactionId !== transaction.previousRecord?.lastTransactionId)) {
    throw new Error(`Ownership changed during preparation: ${relative}`);
  }
  manifest.resources[relative] = {
    owner: "pify",
    kind: "file",
    target,
    origin: previous?.origin ?? (transaction.action === "adopt" ? "adopted" : "created"),
    digest: transaction.expectedNewDigest,
    version: transaction.packageVersion ?? null,
    lastTransactionId: transactionId,
  };
  await atomicJson(manifestPath, manifest);
  await atomicJson(transactionPath, { ...transaction, status: "committed" });
  return manifest.resources[relative];
}

async function ensureResourceParents(agent, relative, createdParents) {
  let current = agent;
  let currentRelative = "";
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    currentRelative = currentRelative ? path.join(currentRelative, part) : part;
    if (createdParents.includes(currentRelative)) {
      await fs.mkdir(current, { mode: 0o700 });
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe resource parent: ${relative}`);
  }
}

async function writeResource(target, content, mode, create, recheck) {
  const temporary = path.join(path.dirname(target), `.${randomUUID()}.pify-tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await recheck();
    if (create) {
      await fs.link(temporary, target);
    } else {
      await fs.rename(temporary, target);
    }
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    try {
      await handle?.close();
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

async function transactionFor(stateDir, transactionId) {
  if (typeof transactionId !== "string" || !UUID_PATTERN.test(transactionId)) throw new Error("Invalid transaction id");
  const transactionPath = path.join(stateDir, "backups", transactionId, "transaction.json");
  const transaction = await privateJson(transactionPath);
  if (transaction.schemaVersion !== 1 || transaction.id !== transactionId ||
      !["create", "replace", "adopt"].includes(transaction.action) ||
      !DIGEST_PATTERN.test(transaction.expectedNewDigest) ||
      (transaction.action !== "create" && (!DIGEST_PATTERN.test(transaction.oldDigest) || !Number.isInteger(transaction.oldMode) || transaction.oldMode < 0 || transaction.oldMode > 0o777))) {
    throw new Error("Invalid Pify transaction");
  }
  const relative = resourcePath(transaction.relativePath);
  const parts = relative.split(path.sep).slice(0, -1);
  const validParents = parts.map((_, index) => path.join(...parts.slice(0, index + 1)));
  const createdParents = transaction.createdParents ?? [];
  if (!Array.isArray(createdParents) || createdParents.some((parent) => !validParents.includes(parent)) ||
      new Set(createdParents).size !== createdParents.length ||
      (transaction.action !== "create" && createdParents.length !== 0) ||
      !sameOrderedSubset(createdParents, validParents)) {
    throw new Error("Invalid Pify transaction parents");
  }
  return { transaction, transactionPath };
}

/** Read-only transaction target for permission checks before rollback. */
export async function describeManagedTransaction({ agentDir, transactionId }) {
  const { agent } = await existingStateFor(agentDir);
  const { transaction } = await transactionFor(path.join(agent, STATE_NAME), transactionId);
  return { relativePath: transaction.relativePath, status: transaction.status };
}

function sameOrderedSubset(subset, full) {
  let previousIndex = -1;
  for (const item of subset) {
    const index = full.indexOf(item);
    if (index <= previousIndex) return false;
    previousIndex = index;
  }
  return true;
}

/** Promote exactly the content named by a prepared transaction, then record ownership. */
export async function promoteManagedFileChange({ agentDir, transactionId, content }) {
  const { agent, stateDir, manifest } = await stateFor(agentDir);
  const { transaction } = await transactionFor(stateDir, transactionId);
  if (transaction.status !== "prepared") throw new Error("Transaction is not prepared");
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (digestFile(bytes) !== transaction.expectedNewDigest) throw new Error("Content does not match prepared digest");
  const relative = resourcePath(transaction.relativePath);
  const target = path.join(agent, relative);
  const previous = manifest.resources[relative] ?? null;
  if (JSON.stringify(previous) !== JSON.stringify(transaction.previousRecord ?? null)) throw new Error(`Ownership changed after preview: ${relative}`);
  await ensureResourceParents(agent, relative, transaction.createdParents ?? []);
  const recheck = async () => {
    const current = await inspectTarget(agent, relative);
    if (transaction.action === "create") {
      if (current.exists) throw new Error(`Resource changed after preview: ${relative}`);
    } else {
      const prior = current.exists ? await readTarget(target) : null;
      if (!prior || digestFile(prior.content) !== transaction.oldDigest || prior.mode !== transaction.oldMode) {
        throw new Error(`Resource changed after preview: ${relative}`);
      }
    }
  };
  const mode = transaction.oldMode ?? 0o600;
  await writeResource(target, bytes, mode, transaction.action === "create", recheck);
  return completeManagedFileChange({ agentDir, transactionId });
}

async function privateBackup(file, expectedDigest) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error(`Unsafe Pify backup: ${file}`);
  const content = await fs.readFile(file);
  if (digestFile(content) !== expectedDigest) throw new Error(`Pify backup digest mismatch: ${file}`);
  return content;
}

/** Reverse one transaction only when the current file still matches its installed digest. */
export async function rollbackManagedFileChange({ agentDir, transactionId }) {
  const { agent, stateDir, manifestPath, manifest } = await stateFor(agentDir);
  const { transaction, transactionPath } = await transactionFor(stateDir, transactionId);
  if (transaction.status === "rolled-back") {
    if (manifest.resources[transaction.relativePath]?.lastTransactionId === transactionId) {
      throw new Error(`Recovery needed: rolled-back transaction still owns resource: ${transaction.relativePath}`);
    }
    return { status: "rolled-back", relativePath: transaction.relativePath };
  }
  if (transaction.status !== "prepared" && transaction.status !== "committed") throw new Error("Transaction cannot be rolled back");
  const relative = resourcePath(transaction.relativePath);
  const target = path.join(agent, relative);
  const record = manifest.resources[relative] ?? null;
  if (record?.lastTransactionId === transactionId && (record.owner !== "pify" || record.kind !== "file" || record.target !== target || record.digest !== transaction.expectedNewDigest)) {
    throw new Error(`Recovery needed: ownership record does not match transaction: ${relative}`);
  }
  if (transaction.status === "committed" && record?.lastTransactionId !== transactionId) {
    if (JSON.stringify(record) !== JSON.stringify(transaction.previousRecord ?? null)) throw new Error(`Ownership changed since transaction: ${relative}`);
  } else if (transaction.status === "prepared" && record?.lastTransactionId !== transactionId && JSON.stringify(record) !== JSON.stringify(transaction.previousRecord ?? null)) {
    throw new Error(`Ownership changed since transaction: ${relative}`);
  }
  const current = await inspectTarget(agent, relative);
  const currentFile = current.exists ? await readTarget(target) : null;
  const currentDigest = currentFile ? digestFile(currentFile.content) : null;
  if (currentDigest !== transaction.expectedNewDigest && currentDigest !== transaction.oldDigest) {
    throw new Error(`Recovery needed: resource changed after transaction: ${relative}`);
  }
  if (currentDigest === transaction.oldDigest && currentFile && currentFile.mode !== transaction.oldMode) {
    throw new Error(`Recovery needed: resource mode changed after transaction: ${relative}`);
  }
  if (transaction.action === "create") {
    if (currentDigest === transaction.expectedNewDigest) await fs.unlink(target);
    for (const parent of [...(transaction.createdParents ?? [])].reverse()) {
      const directory = path.join(agent, parent);
      try {
        await fs.rmdir(directory);
      } catch (error) {
        if (error.code !== "ENOENT") throw new Error(`Recovery needed: created directory is not empty or safe: ${parent}`, { cause: error });
      }
    }
  } else {
    const backup = await privateBackup(path.join(stateDir, "backups", transactionId, "prior"), transaction.oldDigest);
    if (currentDigest === transaction.expectedNewDigest) {
      await writeResource(target, backup, transaction.oldMode, false, async () => {
        const rechecked = await inspectTarget(agent, relative);
        if (!rechecked.exists || digestFile((await readTarget(target)).content) !== transaction.expectedNewDigest) {
          throw new Error(`Recovery needed: resource changed after transaction: ${relative}`);
        }
      });
    }
  }
  if (transaction.previousRecord) manifest.resources[relative] = transaction.previousRecord;
  else delete manifest.resources[relative];
  await atomicJson(manifestPath, manifest);
  await atomicJson(transactionPath, { ...transaction, status: "rolled-back" });
  return { status: "rolled-back", relativePath: relative };
}
