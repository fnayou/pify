import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 256 * 1024;
const SCHEMA_VERSION = 1;

function emptyRegistry() { return { schemaVersion: SCHEMA_VERSION, projects: [] }; }

export async function readWorkflowRegistry(agentDir) {
  if (typeof agentDir !== "string" || !path.isAbsolute(agentDir)) throw new Error("Absolute Pi agent directory is required");
  const directory = path.join(await fs.realpath(agentDir), "pify-state");
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Pify state directory is not private");
  } catch (error) {
    if (error.code === "ENOENT") return { directory, file: path.join(directory, "project-workflows.json"), bytes: null, registry: emptyRegistry() };
    throw error;
  }
  const file = path.join(directory, "project-workflows.json");
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === "ENOENT") return { directory, file, bytes: null, registry: emptyRegistry() };
    throw error;
  }
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > MAX_BYTES) {
      throw new Error("Unsafe Pify workflow registry");
    }
    bytes = await handle.readFile();
    if (bytes.length > MAX_BYTES) throw new Error("Pify workflow registry changed while reading");
  } finally { await handle.close(); }
  let registry;
  try { registry = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Invalid Pify workflow registry JSON"); }
  if (registry?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(registry.projects) || registry.projects.length > 500 ||
      registry.projects.some((item) => typeof item?.path !== "string" || !path.isAbsolute(item.path) ||
        item.path.length > 4096 || !["enabled", "disabled"].includes(item.status) ||
        typeof item.digest !== "string" || !/^[a-f0-9]{64}$/.test(item.digest)) ||
      new Set(registry.projects.map((item) => item.path)).size !== registry.projects.length) {
    throw new Error("Invalid Pify workflow registry");
  }
  return { directory, file, bytes, registry };
}

export async function recordWorkflowProject(agentDir, projectPath, status, digest) {
  const current = await readWorkflowRegistry(agentDir);
  const projects = current.registry.projects.filter((item) => item.path !== projectPath);
  projects.push({ path: projectPath, status, digest });
  projects.sort((a, b) => a.path.localeCompare(b.path));
  if (projects.length > 500) throw new Error("Pify workflow registry is full");
  const next = Buffer.from(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, projects }, null, 2)}\n`);
  if (next.length > MAX_BYTES) throw new Error("Pify workflow registry is too large");
  try { await fs.mkdir(current.directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = await fs.lstat(current.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Pify state directory is not private");
  const temporary = path.join(current.directory, `.pify-workflow-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(next); await handle.sync(); }
    finally { await handle.close(); }
    const latest = await readWorkflowRegistry(agentDir);
    if (current.bytes === null ? latest.bytes !== null : latest.bytes === null || !latest.bytes.equals(current.bytes)) {
      throw new Error("Pify workflow registry changed during update");
    }
    await fs.rename(temporary, current.file);
  } finally { await fs.rm(temporary, { force: true }); }
}
