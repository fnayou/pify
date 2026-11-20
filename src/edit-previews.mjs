import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import { authorizePifyAction, permissionContext } from "./permissions.mjs";

const SCHEMA = "pify.edit-preview/v1";
const MAX_FILES = 12;
const MAX_FILE_BYTES = 8192;
const MAX_TOTAL_BYTES = 32768;
const MAX_PREVIEW_BYTES = 32768;

function relativePath(file) {
  if (typeof file !== "string" || !file || file.includes("\0") || file.includes("\\") || path.isAbsolute(file) ||
      file.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Use exact relative file paths inside the working directory");
  }
  return file;
}

async function readFile(cwd, file) {
  const parts = file.split("/");
  let parent = cwd;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    if (!(await fs.lstat(parent)).isDirectory()) throw new Error(`Unsupported parent directory: ${file}`);
  }
  const absolute = path.join(parent, parts.at(-1));
  const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES || (stat.mode & 0o7000) !== 0) {
      throw new Error(`Unsupported or oversized file: ${file}`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || bytes.includes(0)) throw new Error(`Unsupported file content: ${file}`);
    return { absolute, stat, bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } finally { await handle.close(); }
}

function riskFor(file, matches, mode) {
  if (matches >= 10 || (mode & 0o111) !== 0 || file.split("/").some((part) => part.startsWith(".")) ||
      /(^|\/)(?:AGENTS\.md|CLAUDE\.md|package\.json|[^/]*lock[^/]*)(?:\/|$)/i.test(file)) return "high";
  return "ordinary";
}

async function prepare({ cwd, paths, find, replace, permission = permissionContext() }) {
  const { mode } = permissionContext(permission);
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Absolute working directory required");
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES) throw new Error(`Name 1 to ${MAX_FILES} files`);
  if (typeof find !== "string" || !find || typeof replace !== "string" || find === replace || find.includes("\0") || replace.includes("\0")) {
    throw new Error("Provide distinct nonempty UTF-8 find and replacement text");
  }
  const files = paths.map(relativePath);
  if (new Set(files).size !== files.length) throw new Error("Duplicate file path");
  const root = await fs.realpath(cwd);
  const entries = [];
  let total = 0;
  for (const file of files) {
    const source = await readFile(root, file);
    total += source.bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("Edit preview exceeds total file size limit");
    const matches = source.text.split(find).length - 1;
    if (!matches) throw new Error(`Text not found in ${file}`);
    const after = source.text.replaceAll(find, replace);
    if (Buffer.byteLength(after) > MAX_FILE_BYTES) throw new Error(`Replacement exceeds file size limit: ${file}`);
    entries.push({ path: file, root, matches, risk: riskFor(file, matches, source.stat.mode), before: source.text, after,
      absolute: source.absolute, stat: source.stat, bytes: source.bytes });
  }
  const hash = createHash("sha256").update(root).update(JSON.stringify({ files, find, replace }));
  for (const entry of entries) hash.update(entry.bytes);
  const reviewCode = hash.digest("hex").slice(0, 20);
  const risk = entries.length > 1 || entries.some((entry) => entry.risk === "high") ? "high" : "ordinary";
  const report = { schema: SCHEMA, status: "preview", risk, reviewCode, mode,
    approval: { required: true, scope: mode === "safe" ? "predeclared" : "predeclared_or_tui_approval" },
    files: entries.map(({ path: file, matches, risk: fileRisk, before, after }) => ({ path: file, matches, risk: fileRisk, before, after })) };
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_PREVIEW_BYTES) throw new Error("Complete edit preview exceeds output limit");
  return { root, entries, report };
}

export async function previewEdit(options) { return (await prepare(options)).report; }

async function unchanged(entry) {
  try {
    const current = await readFile(entry.root, entry.path);
    return current.stat.dev === entry.stat.dev && current.stat.ino === entry.stat.ino &&
      current.stat.mode === entry.stat.mode && current.bytes.equals(entry.bytes);
  } catch { return false; }
}

async function restoreWrittenFile({ entry, appliedStat }) {
  const handle = await fs.open(entry.absolute, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== appliedStat.dev || current.ino !== appliedStat.ino || current.nlink !== 1) {
      throw new Error("File changed during recovery");
    }
    if (!(await handle.readFile()).equals(Buffer.from(entry.after))) throw new Error("File changed during recovery");
    await handle.truncate(0);
    let offset = 0;
    while (offset < entry.bytes.length) {
      const { bytesWritten } = await handle.write(entry.bytes, offset, entry.bytes.length - offset, offset);
      if (!bytesWritten) throw new Error("Recovery write made no progress");
      offset += bytesWritten;
    }
    await handle.chmod(entry.stat.mode & 0o777);
    await handle.sync();
  } finally { await handle.close(); }
}

export async function applyEdit({ cwd, paths, find, replace, reviewCode, approved = false, permission = permissionContext() }) {
  const plan = await prepare({ cwd, paths, find, replace, permission });
  if (!approved) return { ...plan.report, status: "approval_required" };
  if (reviewCode !== plan.report.reviewCode) return { ...plan.report, status: "stale_preview" };
  const decision = authorizePifyAction({ permission, action: { kind: "replace-text", targets: plan.entries.map((entry) => entry.path) } });
  if (decision.outcome !== "allowed") return decision;
  for (const entry of plan.entries) if (!(await unchanged(entry))) return { ...plan.report, status: "stale_preview" };
  const written = [];
  try {
    for (const entry of plan.entries) {
      if (!(await unchanged(entry))) throw new Error(`File changed after preview: ${entry.path}`);
      const temporary = path.join(path.dirname(entry.absolute), `.${path.basename(entry.absolute)}.pify-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, entry.after, { flag: "wx", mode: 0o600 });
        await fs.chmod(temporary, entry.stat.mode & 0o777);
        await fs.rename(temporary, entry.absolute);
        written.push({ entry, appliedStat: await fs.lstat(entry.absolute) });
      } finally { await fs.rm(temporary, { force: true }); }
    }
    return { schema: SCHEMA, status: "applied", risk: plan.report.risk, reviewCode, files: plan.report.files.map(({ path: file, matches }) => ({ path: file, matches })) };
  } catch (error) {
    const recovery = [];
    for (const item of written.reverse()) {
      try {
        await restoreWrittenFile(item);
      } catch (restoreError) { recovery.push(`${item.entry.path}: ${restoreError.message}`); }
    }
    return { schema: SCHEMA, status: "failed", reason: error.message, recovery };
  }
}
