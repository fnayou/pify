import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { authorizePifyAction } from "./permissions.mjs";

export const PIFY_THEME = "pify";
export const THEME_SETTING_RESOURCE = "settings.json";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function agentRoot(agentDir) {
  if (typeof agentDir !== "string" || !path.isAbsolute(agentDir)) throw new Error("Absolute Pi agent directory is required");
  const root = await fs.realpath(agentDir);
  if (!(await fs.lstat(root)).isDirectory()) throw new Error("Pi agent directory is not a directory");
  return root;
}

async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o7000) !== 0) {
    throw new Error(`Unsafe Pi settings or state file: ${file}`);
  }
  return stat;
}

async function readSettings(root) {
  const file = path.join(root, "settings.json");
  const stat = await regularFile(file);
  const bytes = await fs.readFile(file);
  let settings;
  try {
    settings = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Pi settings are not valid JSON: ${error.message}`);
  }
  if (!object(settings)) throw new Error("Pi settings must be a JSON object");
  if (Object.hasOwn(settings, "theme") && typeof settings.theme !== "string") throw new Error("Pi theme setting must be a string");
  return { file, stat, bytes, settings };
}

function priorTheme(settings) {
  return Object.hasOwn(settings, "theme") ? { present: true, value: settings.theme } : { present: false };
}

async function readJournal(root) {
  const directory = path.join(root, "pify-state");
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Pify state directory is not private");
  } catch (error) {
    if (error.code === "ENOENT") return { directory, file: path.join(directory, "theme-selection.json"), journal: { schemaVersion: 1, transactions: [] } };
    throw error;
  }
  const file = path.join(directory, "theme-selection.json");
  let journal;
  try {
    const stat = await regularFile(file);
    if ((stat.mode & 0o077) !== 0) throw new Error("Pify theme journal is not private");
    journal = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    journal = { schemaVersion: 1, transactions: [] };
  }
  if (journal.schemaVersion !== 1 || !Array.isArray(journal.transactions)) throw new Error("Invalid Pify theme journal");
  return { directory, file, journal };
}

function activeTransaction(journal) {
  const active = journal.transactions.filter((item) => item.status === "active");
  if (active.length > 1) throw new Error("Multiple active Pify theme transactions");
  if (active[0] && (!object(active[0].previous) || typeof active[0].previous.present !== "boolean" ||
      (active[0].previous.present && typeof active[0].previous.value !== "string") ||
      active[0].selected !== PIFY_THEME || typeof active[0].approvedBy !== "string" ||
      !["tui-confirmation", "explicit-scope"].includes(active[0].approvalSource))) {
    throw new Error("Invalid Pify theme transaction");
  }
  return active[0] ?? null;
}

async function writeJournal(location) {
  try {
    await fs.mkdir(location.directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(location.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Pify state directory is not private");
  const temporary = path.join(location.directory, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(location.journal, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, location.file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function writeSettings(snapshot, settings) {
  const current = await readSettings(path.dirname(snapshot.file));
  if (!current.bytes.equals(snapshot.bytes) || (current.stat.mode & 0o777) !== (snapshot.stat.mode & 0o777)) {
    throw new Error("Pi settings changed after preview");
  }
  const temporary = path.join(path.dirname(snapshot.file), `.pify-settings-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: snapshot.stat.mode & 0o777 });
    await fs.chmod(temporary, snapshot.stat.mode & 0o777);
    const rechecked = await readSettings(path.dirname(snapshot.file));
    if (!rechecked.bytes.equals(snapshot.bytes)) throw new Error("Pi settings changed during theme update");
    await fs.rename(temporary, snapshot.file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Read the saved choice and Pify rollback state without creating files. */
export async function inspectThemeSelection({ agentDir }) {
  const root = await agentRoot(agentDir);
  const { settings } = await readSettings(root);
  const { journal } = await readJournal(root);
  const active = activeTransaction(journal);
  return {
    theme: Object.hasOwn(settings, "theme") ? settings.theme : null,
    usePifyOnFreshStart: !Object.hasOwn(settings, "theme"),
    rollbackAvailable: active !== null && settings.theme === PIFY_THEME,
  };
}

/** Persist an explicitly authorized theme choice; journal the previous setting first. */
export async function selectPifyTheme({ agentDir, permission, approvalSource = "explicit-scope" }) {
  if (!["tui-confirmation", "explicit-scope"].includes(approvalSource)) throw new Error("Invalid Pify theme approval source");
  const decision = authorizePifyAction({ permission, action: { kind: "theme-select", targets: [THEME_SETTING_RESOURCE] } });
  if (decision.outcome !== "allowed") return decision;
  const root = await agentRoot(agentDir);
  const snapshot = await readSettings(root);
  const location = await readJournal(root);
  const active = activeTransaction(location.journal);
  if (active) {
    if (snapshot.settings.theme === PIFY_THEME) return { status: "already_selected", rollbackAvailable: true };
    throw new Error("Pify theme selection changed after approval; rollback or inspect it first");
  }
  if (snapshot.settings.theme === PIFY_THEME) return { status: "already_selected", rollbackAvailable: false };
  const transaction = {
    id: randomUUID(),
    status: "active",
    previous: priorTheme(snapshot.settings),
    selected: PIFY_THEME,
    approvedBy: decision.callerId,
    approvalSource,
  };
  location.journal.transactions.push(transaction);
  await writeJournal(location);
  await writeSettings(snapshot, { ...snapshot.settings, theme: PIFY_THEME });
  return { status: "selected", transactionId: transaction.id, previousTheme: transaction.previous.present ? transaction.previous.value : null };
}

/** Restore only the prior theme key; preserve unrelated Pi settings and footer data. */
export async function rollbackPifyTheme({ agentDir, permission }) {
  const decision = authorizePifyAction({ permission, action: { kind: "theme-rollback", targets: [THEME_SETTING_RESOURCE] } });
  if (decision.outcome !== "allowed") return decision;
  const root = await agentRoot(agentDir);
  const snapshot = await readSettings(root);
  const location = await readJournal(root);
  const active = activeTransaction(location.journal);
  if (!active) return { status: "nothing_to_rollback" };
  const matchesPrevious = active.previous.present
    ? snapshot.settings.theme === active.previous.value
    : !Object.hasOwn(snapshot.settings, "theme");
  if (snapshot.settings.theme !== PIFY_THEME && !matchesPrevious) {
    throw new Error("Pi theme changed after Pify selection; preserving current choice");
  }
  const settings = { ...snapshot.settings };
  if (active.previous.present) settings.theme = active.previous.value;
  else settings.theme = "system";
  if (!matchesPrevious) await writeSettings(snapshot, settings);
  active.status = "rolled-back";
  await writeJournal(location);
  return { status: "rolled-back", theme: active.previous.present ? active.previous.value : "system" };
}
