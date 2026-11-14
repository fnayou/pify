import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import { fetchLmStudioInventory } from "./lmstudio-inventory.mjs";
import { authorizePifyAction } from "./permissions.mjs";

export const MODEL_SYNC_TARGETS = ["models.json", "pify-state/model-sync.json"];
const MAX_CONFIG_BYTES = 1024 * 1024;
const STATE_SCHEMA = 1;

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validId(value) { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value); }
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function entryDigest(entry) { return digest(JSON.stringify(stable(entry))); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }

async function readRegular(file, { optional = false, privateFile = false } = {}) {
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
  try {
    const stat = await handle.stat();
    const limit = privateFile ? MAX_CONFIG_BYTES * 4 : MAX_CONFIG_BYTES;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit ||
        (stat.mode & 0o7000) !== 0 || (privateFile && (stat.mode & 0o077) !== 0)) {
      throw new Error(`Unsafe or oversized Pi configuration file: ${path.basename(file)}`);
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error(`Pi configuration changed while reading: ${path.basename(file)}`);
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error(`Pi configuration changed while reading: ${path.basename(file)}`);
    return { bytes, mode: stat.mode & 0o777 };
  } finally { await handle.close(); }
}

function parseObject(snapshot, label) {
  if (!snapshot) return {};
  let value;
  try { value = JSON.parse(snapshot.bytes.toString("utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
  if (!object(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

async function readSettings(root, projectDir, projectTrusted) {
  const userSnapshot = await readRegular(path.join(root, "settings.json"), { optional: true });
  const user = parseObject(userSnapshot, "Pi user settings");
  let projectSnapshot = null;
  let project = {};
  if (projectTrusted) {
    if (typeof projectDir !== "string" || !path.isAbsolute(projectDir)) throw new Error("Trusted project directory must be absolute");
    const piDir = path.join(projectDir, ".pi");
    try {
      const stat = await fs.lstat(piDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe project .pi directory");
      projectSnapshot = await readRegular(path.join(piDir, "settings.json"), { optional: true });
      project = parseObject(projectSnapshot, "Pi project settings");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const protectedIds = new Set();
  if ((user.defaultProvider === "lmstudio" || user.defaultProvider === undefined) &&
      typeof user.defaultModel === "string") protectedIds.add(user.defaultModel);
  const effectiveProvider = Object.hasOwn(project, "defaultProvider") ? project.defaultProvider : user.defaultProvider;
  const effectiveModel = Object.hasOwn(project, "defaultModel") ? project.defaultModel : user.defaultModel;
  if ((effectiveProvider === "lmstudio" || effectiveProvider === undefined) &&
      typeof effectiveModel === "string") protectedIds.add(effectiveModel);
  return { protectedIds, userSnapshot, projectSnapshot, projectDir, projectTrusted };
}

function validRecords(records) {
  return Array.isArray(records) && records.length <= 500 && records.every((item) =>
    object(item) && validId(item.id) && /^[a-f0-9]{64}$/.test(item.digest)) &&
    new Set(records.map((item) => item.id)).size === records.length;
}

function validState(state) {
  return object(state) && state.schemaVersion === STATE_SCHEMA && validRecords(state.owned) &&
    validRecords(state.reviewedManual) && (state.endpoint === null || typeof state.endpoint === "string") &&
    (state.endpoint !== null || state.owned.length === 0) &&
    Object.keys(state).every((key) => ["schemaVersion", "endpoint", "owned", "reviewedManual", "pending"].includes(key));
}

async function stateLocation(root) {
  const directory = path.join(root, "pify-state");
  let exists = true;
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Pify state directory is not private");
  } catch (error) { if (error.code === "ENOENT") exists = false; else throw error; }
  const file = path.join(directory, "model-sync.json");
  const snapshot = exists ? await readRegular(file, { optional: true, privateFile: true }) : null;
  const state = snapshot ? parseObject(snapshot, "Pify model sync state") :
    { schemaVersion: STATE_SCHEMA, endpoint: null, owned: [], reviewedManual: [] };
  if (!validState(state) ||
      (state.pending !== undefined && (!object(state.pending) || typeof state.pending.beforeModels !== "string" ||
        !/^[a-f0-9]{64}$/.test(state.pending.beforeDigest) || !/^[a-f0-9]{64}$/.test(state.pending.afterDigest) ||
        !Number.isInteger(state.pending.beforeMode) || state.pending.beforeMode < 0 || state.pending.beforeMode > 0o777 ||
        !validState(state.pending.beforeState) || state.pending.beforeState.pending !== undefined))) throw new Error("Invalid Pify model sync state");
  return { directory, file, snapshot, state };
}

async function readModels(root) {
  const file = path.join(root, "models.json");
  const snapshot = await readRegular(file);
  const config = parseObject(snapshot, "Pi models.json");
  const provider = config.providers?.lmstudio;
  if (!object(config.providers) || !object(provider) ||
      (provider.models !== undefined && !Array.isArray(provider.models))) {
    throw new Error("Configure providers.lmstudio in Pi models.json before sync");
  }
  const entries = provider.models ?? [];
  if (entries.length > 500 || entries.some((entry) => !object(entry) || !validId(entry.id)) ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("LM Studio model entries are invalid or repeated");
  return { file, snapshot, config, provider, entries };
}

function summary(ids) { return { count: ids.length, sample: ids.slice(0, 20), truncated: ids.length > 20 }; }

/** Read-only plan. Ambiguous entries and drift never become ownership. */
export async function prepareModelSync({ agentDir, projectDir, projectTrusted = false, fetchImpl = fetch, env = process.env }) {
  if (typeof agentDir !== "string" || !path.isAbsolute(agentDir)) throw new Error("Absolute Pi agent directory is required");
  const root = await fs.realpath(agentDir);
  const models = await readModels(root);
  const location = await stateLocation(root);
  const settings = await readSettings(root, projectDir, projectTrusted);
  if (location.state.pending) {
    return { report: { schema: "pify.model-sync/v1", status: "recovery_required" }, root, models, location, settings };
  }
  const inventory = await fetchLmStudioInventory({ provider: models.provider, fetchImpl, env });
  if (location.state.endpoint && location.state.endpoint !== inventory.baseUrl) {
    throw new Error("LM Studio endpoint changed since Pify ownership was recorded; preserving existing entries");
  }
  const observed = new Map(inventory.models.map((item) => [item.id, item]));
  const owned = new Map(location.state.owned.map((item) => [item.id, item.digest]));
  const reviewed = new Map(location.state.reviewedManual.map((item) => [item.id, item.digest]));
  const nextOwned = new Map(owned);
  const nextEntries = [];
  const present = new Set();
  const added = [], updated = [], removed = [], ambiguous = [], conflicts = [], preserved = [];
  for (const entry of models.entries) {
    const id = entry.id;
    present.add(id);
    const target = observed.get(id);
    const knownDigest = owned.get(id);
    if (knownDigest) {
      if (entryDigest(entry) !== knownDigest) {
        conflicts.push({ id, reason: "owned entry changed outside Pify" });
        nextEntries.push(entry);
      } else if (!target && settings.protectedIds.has(id)) {
        conflicts.push({ id, reason: "selected default would be removed" });
        nextEntries.push(entry);
      } else if (!target) {
        removed.push(id);
        nextOwned.delete(id);
      } else {
        nextEntries.push(target);
        nextOwned.set(id, entryDigest(target));
        if (entryDigest(entry) !== entryDigest(target)) updated.push(id);
        else preserved.push(id);
      }
    } else {
      nextEntries.push(entry);
      if (target && reviewed.get(id) !== entryDigest(entry)) ambiguous.push(id);
    }
  }
  for (const target of inventory.models) {
    if (present.has(target.id)) continue;
    nextEntries.push(target);
    nextOwned.set(target.id, entryDigest(target));
    added.push(target.id);
  }
  const report = {
    schema: "pify.model-sync/v1", status: "preview", provider: "lmstudio",
    added: summary(added), updated: summary(updated), removed: summary(removed),
    ambiguous: summary(ambiguous), conflicts: conflicts.slice(0, 20),
    conflictCount: conflicts.length, unmatchedCompatible: summary(inventory.unmatchedIds),
    verifiedMetadata: ["id", "native display_name when exact key matches"],
  };
  return { report, root, models, location, settings, inventory, nextEntries, nextOwned, reviewed, ambiguous };
}

async function ensurePrivateDirectory(directory) {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Pify state directory is not private");
}

async function atomicWrite(file, bytes, mode, expectedBytes) {
  const temporary = path.join(path.dirname(file), `.pify-model-sync-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", mode);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await fs.chmod(temporary, mode);
    if (expectedBytes !== undefined) {
      const current = await readRegular(file, { optional: expectedBytes === null, privateFile: file.endsWith("model-sync.json") });
      if (expectedBytes === null ? current !== null : current === null || !current.bytes.equals(expectedBytes)) {
        throw new Error(`Pi configuration changed during model sync: ${path.basename(file)}`);
      }
    }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

function cleanState(state) {
  const { pending: _pending, ...clean } = state;
  return clean;
}

async function recoverPending(plan) {
  const { root, models, location } = plan;
  const pending = location.state.pending;
  const beforeBytes = Buffer.from(pending.beforeModels, "base64");
  if (digest(beforeBytes) !== pending.beforeDigest) throw new Error("Model sync recovery backup is corrupt");
  const currentState = await stateLocation(root);
  if (JSON.stringify(currentState.state) !== JSON.stringify(location.state)) throw new Error("Pify ownership changed during recovery");
  const current = await readModels(root);
  const currentDigest = digest(current.snapshot.bytes);
  if (currentDigest === pending.afterDigest) {
    await atomicWrite(models.file, beforeBytes, pending.beforeMode, current.snapshot.bytes);
  } else if (currentDigest !== pending.beforeDigest) {
    throw new Error("Pi models changed during interrupted sync; manual recovery required");
  }
  await atomicWrite(location.file, jsonBytes(pending.beforeState), 0o600, currentState.snapshot.bytes);
  return { schema: "pify.model-sync/v1", status: "recovered", next: "Run sync again" };
}

/** Apply one explicit plan; a private pending journal restores prior config after failure. */
export async function applyModelSync(plan, { permission, review, afterModelsWrite } = {}) {
  const decision = authorizePifyAction({ permission, action: { kind: "model-sync", targets: MODEL_SYNC_TARGETS } });
  if (decision.outcome !== "allowed") return decision;
  if (plan.report.status === "recovery_required") return recoverPending(plan);
  if (plan.ambiguous.length && (!review || review.decision !== "keep" || review.id !== plan.ambiguous[0])) {
    return { schema: "pify.model-sync/v1", status: "clarification_required", modelId: plan.ambiguous[0], options: ["keep manual entry", "cancel sync"] };
  }
  const reviewed = new Map(plan.reviewed);
  if (review) {
    const entry = plan.models.entries.find((item) => item.id === review.id);
    reviewed.set(review.id, entryDigest(entry));
  }
  const nextState = {
    schemaVersion: STATE_SCHEMA, endpoint: plan.inventory.baseUrl,
    owned: [...plan.nextOwned].map(([id, digestValue]) => ({ id, digest: digestValue })).sort((a, b) => a.id.localeCompare(b.id)),
    reviewedManual: [...reviewed].map(([id, digestValue]) => ({ id, digest: digestValue })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  const nextConfig = { ...plan.models.config, providers: { ...plan.models.config.providers,
    lmstudio: { ...plan.models.provider, models: plan.nextEntries } } };
  const beforeBytes = plan.models.snapshot.bytes;
  const modelChanged = plan.report.added.count > 0 || plan.report.updated.count > 0 || plan.report.removed.count > 0;
  const nextBytes = modelChanged ? jsonBytes(nextConfig) : beforeBytes;
  const beforeState = cleanState(plan.location.state);
  const result = { ...plan.report, ambiguous: summary(plan.ambiguous.filter((id) => id !== review?.id)) };
  if (nextBytes.equals(beforeBytes) && JSON.stringify(nextState) === JSON.stringify(beforeState)) {
    return { ...result, status: "already_current" };
  }
  const current = await readModels(plan.root);
  const location = await stateLocation(plan.root);
  const settings = await readSettings(plan.root, plan.settings.projectDir, plan.settings.projectTrusted);
  if (!current.snapshot.bytes.equals(beforeBytes) || current.snapshot.mode !== plan.models.snapshot.mode ||
      JSON.stringify(location.state) !== JSON.stringify(plan.location.state) ||
      !sameSnapshot(settings.userSnapshot, plan.settings.userSnapshot) ||
      !sameSnapshot(settings.projectSnapshot, plan.settings.projectSnapshot)) {
    throw new Error("Pi models, settings, or Pify ownership changed after preview");
  }
  await ensurePrivateDirectory(location.directory);
  const pendingState = { ...beforeState, pending: {
    beforeDigest: digest(beforeBytes), afterDigest: digest(nextBytes),
    beforeModels: beforeBytes.toString("base64"), beforeMode: current.snapshot.mode, beforeState,
  } };
  await atomicWrite(location.file, jsonBytes(pendingState), 0o600, location.snapshot?.bytes ?? null);
  try {
    if (modelChanged) {
      await atomicWrite(current.file, nextBytes, current.snapshot.mode, beforeBytes);
      if (afterModelsWrite) await afterModelsWrite();
    }
    await atomicWrite(location.file, jsonBytes(nextState), 0o600, jsonBytes(pendingState));
  } catch (error) {
    try { await recoverPending({ root: plan.root, models: current, location: { ...location, state: pendingState } }); }
    catch { throw new Error("Model sync failed and requires recovery on the next explicit sync"); }
    throw error;
  }
  return { ...result, status: "synced" };
}

function sameSnapshot(a, b) {
  return a === null || b === null ? a === b : a.mode === b.mode && a.bytes.equals(b.bytes);
}
