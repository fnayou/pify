import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { authorizePifyAction, permissionContext } from "./permissions.mjs";

const SCHEMA = "pify.atomic-commits/v1";
const MAX_GROUPS = 8;
const MAX_PATHS = 24;
const MAX_FILE_BYTES = 8192;
const MAX_PREVIEW_BYTES = 65536;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CONVENTIONAL = /^[a-z][a-z0-9-]*(?:\([a-z0-9][a-z0-9./-]*\))?!?: [^\r\n]+$/;

function gitEnv(indexFile, literalPaths) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  if (literalPaths) env.GIT_LITERAL_PATHSPECS = "1";
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  return env;
}

async function git(cwd, args, { input = Buffer.alloc(0), indexFile, accepted = [0], literalPaths = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgSign=false", ...args], { cwd, env: gitEnv(indexFile, literalPaths), stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    const fail = (message) => { if (!settled) { settled = true; reject(new Error(message)); } };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10_000);
    child.stdout.on("data", (chunk) => { size += chunk.length; output.push(chunk); if (size > MAX_GIT_OUTPUT) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk) => { size += chunk.length; errors.push(chunk); if (size > MAX_GIT_OUTPUT) child.kill("SIGKILL"); });
    child.stdin.on("error", () => {});
    child.once("error", (error) => { clearTimeout(timer); fail(`Git ${args[0]} failed: ${error.message}`); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (timedOut || size > MAX_GIT_OUTPUT || !accepted.includes(code)) {
        fail(`Git ${args[0]} failed: ${timedOut ? "timed out" : size > MAX_GIT_OUTPUT ? "output limit exceeded" : Buffer.concat(errors).toString("utf8").trim().slice(0, 500) || `exit ${code}`}`);
      } else { settled = true; resolve({ code, stdout: Buffer.concat(output) }); }
    });
    child.stdin.end(input);
  });
}

function line(result) { return result.stdout.toString("utf8").trim(); }

function exactFile(file) {
  if (typeof file !== "string" || !file || path.isAbsolute(file) || file.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(file) || file.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")) {
    throw new Error("Use exact relative file paths inside the repository");
  }
  return file;
}

function validateGroups(groups) {
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > MAX_GROUPS) throw new Error(`Name 1 to ${MAX_GROUPS} commit groups`);
  const seen = new Set();
  let count = 0;
  return groups.map((group) => {
    const message = group?.message;
    if (typeof message !== "string" || message !== message.trim() || message.length > 120 || !CONVENTIONAL.test(message)) {
      throw new Error("Each group needs one Conventional Commit subject");
    }
    if (!Array.isArray(group.paths) || group.paths.length === 0) throw new Error("Each group needs exact file paths");
    const paths = group.paths.map(exactFile);
    count += paths.length;
    if (count > MAX_PATHS) throw new Error(`Name at most ${MAX_PATHS} files`);
    for (const file of paths) {
      if (seen.has(file)) throw new Error(`File appears in more than one group: ${file}`);
      seen.add(file);
    }
    return { message, paths };
  });
}

async function repository(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Absolute working directory required");
  const root = await fs.realpath(line(await git(cwd, ["rev-parse", "--show-toplevel"])));
  const here = await fs.realpath(cwd);
  const branch = line(await git(root, ["symbolic-ref", "-q", "HEAD"]));
  if (!branch.startsWith("refs/heads/")) throw new Error("An attached Git branch is required");
  const head = line(await git(root, ["rev-parse", "--verify", "HEAD"]));
  if (!OBJECT_ID.test(head)) throw new Error("Invalid Git HEAD");
  if ((await git(root, ["ls-files", "-u", "-z"])).stdout.length) throw new Error("Resolve unmerged paths before committing");
  const gitDir = line(await git(root, ["rev-parse", "--absolute-git-dir"]));
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    try { await fs.lstat(path.join(gitDir, name)); throw new Error(`Finish the active Git operation: ${name}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { root, here, branch, head };
}

function rootPath(repo, file) {
  const absolute = path.resolve(repo.here, exactFile(file));
  const relative = path.relative(repo.root, absolute).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../") || relative.split("/").includes(".git")) {
    throw new Error("Commit path must stay inside the repository");
  }
  return relative;
}

function decode(bytes, file) {
  if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw new Error(`Unsupported or oversized text file: ${file}`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`Non-UTF-8 file: ${file}`); }
}

async function headFile(repo, file, head = repo.head) {
  const bytes = (await git(repo.root, ["ls-tree", "-z", head, "--", file])).stdout;
  if (!bytes.length) return null;
  const records = bytes.toString("utf8").split("\0").filter(Boolean);
  if (records.length !== 1) throw new Error(`Unsupported Git tree path: ${file}`);
  const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(records[0]);
  if (!match || match[3] !== file) throw new Error(`Unsupported Git tree entry: ${file}`);
  const content = (await git(repo.root, ["cat-file", "blob", match[2]])).stdout;
  return { bytes: content, text: decode(content, file), mode: match[1] };
}

async function workFile(repo, file) {
  const parts = file.split("/");
  let parent = repo.root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    try {
      if (!(await fs.lstat(parent)).isDirectory()) throw new Error(`Unsupported parent directory: ${file}`);
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  const absolute = path.join(parent, parts.at(-1));
  let handle;
  try { handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES || (stat.mode & 0o7000) !== 0) {
      throw new Error(`Unsupported worktree file: ${file}`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw new Error(`File changed while reading: ${file}`);
    return { bytes, text: decode(bytes, file), mode: stat.mode & 0o111 ? "100755" : "100644" };
  } finally { await handle.close(); }
}

async function selectedFile(repo, file, head = repo.head) {
  const before = await headFile(repo, file, head);
  const after = await workFile(repo, file);
  if (!before && !after) throw new Error(`No commit change: ${file}`);
  if (before?.mode === after?.mode && before?.bytes.equals(after?.bytes)) throw new Error(`No commit change: ${file}`);
  if (!before && after) {
    const ignored = await git(repo.root, ["check-ignore", "-q", "--", file], { accepted: [0, 1], literalPaths: false });
    if (ignored.code === 0) throw new Error(`Ignored untracked file: ${file}`);
  }
  return { path: file, before, after, action: !before ? "add" : !after ? "delete" : "modify" };
}

async function prepare({ cwd, groups }) {
  const repo = await repository(cwd);
  const requested = validateGroups(groups);
  const planned = [];
  const used = new Set();
  for (const group of requested) {
    const files = [];
    for (const file of group.paths) {
      const relative = rootPath(repo, file);
      if (used.has(relative)) throw new Error(`File appears in more than one group: ${relative}`);
      used.add(relative);
      files.push(await selectedFile(repo, relative));
    }
    planned.push({ message: group.message, files });
  }
  const report = { schema: SCHEMA, status: "preview", branch: repo.branch, head: repo.head,
    groups: planned.map((group) => ({ message: group.message, files: group.files.map((file) => ({
      path: file.path, action: file.action, before: file.before?.text ?? null, after: file.after?.text ?? null,
      modeBefore: file.before?.mode ?? null, modeAfter: file.after?.mode ?? null,
    })) })) };
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_PREVIEW_BYTES) throw new Error("Complete commit preview exceeds output limit");
  report.reviewCode = createHash("sha256").update(repo.root).update(JSON.stringify(report)).digest("hex").slice(0, 20);
  return { repo, planned, report };
}

export async function previewAtomicCommits(options) { return (await prepare(options)).report; }

async function stillCurrent(repo, files, head) {
  if (line(await git(repo.root, ["rev-parse", "--verify", "HEAD"])) !== head ||
      line(await git(repo.root, ["symbolic-ref", "-q", "HEAD"])) !== repo.branch) return false;
  for (const file of files) {
    try {
      const current = await selectedFile(repo, file.path, head);
      if (current.before?.mode !== file.before?.mode || current.after?.mode !== file.after?.mode ||
          !(current.before?.bytes.equals(file.before?.bytes) ?? (!current.before && !file.before)) ||
          !(current.after?.bytes.equals(file.after?.bytes) ?? (!current.after && !file.after))) return false;
    } catch { return false; }
  }
  return true;
}

async function commitGroup(repo, group, head) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pify-commit-index-"));
  try {
    const indexFile = path.join(temporary, "index");
    await git(repo.root, ["read-tree", head], { indexFile });
    const records = [];
    for (const file of group.files) {
      if (!file.after) records.push(`0 ${"0".repeat(head.length)}\t${file.path}\0`);
      else {
        const oid = line(await git(repo.root, ["hash-object", "-w", "--no-filters", "--stdin"], { input: file.after.bytes }));
        if (!OBJECT_ID.test(oid)) throw new Error("Git returned an invalid blob ID");
        records.push(`${file.after.mode} ${oid}\t${file.path}\0`);
      }
    }
    const input = Buffer.from(records.join(""), "utf8");
    await git(repo.root, ["update-index", "-z", "--index-info"], { indexFile, input });
    const tree = line(await git(repo.root, ["write-tree"], { indexFile }));
    if (!OBJECT_ID.test(tree)) throw new Error("Git returned an invalid tree ID");
    const commit = line(await git(repo.root, ["commit-tree", tree, "-p", head, "-m", group.message]));
    if (!OBJECT_ID.test(commit)) throw new Error("Git returned an invalid commit ID");
    if (!(await stillCurrent(repo, group.files, head))) throw new Error("Selected files changed before commit");
    await git(repo.root, ["update-ref", repo.branch, commit, head]);
    try {
      await git(repo.root, ["update-index", "-z", "--index-info"], { input });
      return { oid: commit, indexError: null };
    } catch (error) { return { oid: commit, indexError: error.message }; }
  } finally { await fs.rm(temporary, { recursive: true, force: true }).catch(() => {}); }
}

export async function applyAtomicCommits({ cwd, groups, reviewCode, approved = false, permission = permissionContext() }) {
  let plan;
  try { plan = await prepare({ cwd, groups }); }
  catch (error) { if (reviewCode) return { schema: SCHEMA, status: "stale_preview", reason: error.message, commits: [], pushed: false }; throw error; }
  if (!approved) return { ...plan.report, status: "approval_required" };
  if (reviewCode !== plan.report.reviewCode) return { schema: SCHEMA, status: "stale_preview", commits: [], pushed: false };
  const targets = plan.planned.flatMap((group) => group.files.map((file) => `git/commits/${file.path}`));
  const decision = authorizePifyAction({ permission, action: { kind: "git-commit", targets } });
  if (decision.outcome !== "allowed") return decision;
  await git(plan.repo.root, ["var", "GIT_AUTHOR_IDENT"]);
  await git(plan.repo.root, ["var", "GIT_COMMITTER_IDENT"]);
  const commits = [];
  let head = plan.repo.head;
  for (const group of plan.planned) {
    try {
      if (!(await stillCurrent(plan.repo, group.files, head))) throw new Error("Selected files changed after preview");
      const result = await commitGroup(plan.repo, group, head);
      commits.push({ oid: result.oid, message: group.message, paths: group.files.map((file) => file.path) });
      head = result.oid;
      if (result.indexError) return { schema: SCHEMA, status: "partial", commits,
        reason: `Commit exists, but index update failed: ${result.indexError}`, pushed: false };
    } catch (error) {
      return { schema: SCHEMA, status: commits.length ? "partial" : "failed", commits, reason: error.message, pushed: false };
    }
  }
  return { schema: SCHEMA, status: "committed", commits, pushed: false };
}
