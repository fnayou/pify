import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { inspectMemoryVault } from "./memory-vault.mjs";
import { authorizePifyAction } from "./permissions.mjs";

const execFileAsync = promisify(execFile);
const MAX_NOTE_BYTES = 1024 * 1024;
const MAX_CHANGED_PATHS = 200;
const SCOPES = new Set(["00-inbox", "01-global", "02-projects", "03-reference", "99-archive"]);
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function runCommand(program, args, { cwd, encoding = "utf8" }) {
  try {
    const { stdout } = await execFileAsync(program, args, {
      cwd, encoding, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    });
    return stdout;
  } catch (error) {
    throw new Error(`${program} ${args[0]} failed (${error.code ?? error.signal ?? "unknown"})`);
  }
}

async function output(run, program, args, cwd, encoding = "utf8") {
  return run(program, args, { cwd, encoding });
}

function nulPaths(value) {
  if (!value) return [];
  if (!value.endsWith("\0")) throw new Error("Invalid Git path output");
  return value.slice(0, -1).split("\0");
}

function safePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(relativePath) || path.posix.isAbsolute(relativePath)) return false;
  const parts = relativePath.split("/");
  return parts.every((part) => part && part !== "." && part !== ".." && !part.startsWith("."));
}

function eligibleNote(relativePath) {
  return safePath(relativePath) && SCOPES.has(relativePath.split("/")[0]) &&
    relativePath.split("/").length >= 2 && relativePath.endsWith(".md");
}

function permittedRemoteFile(relativePath) {
  return eligibleNote(relativePath) || relativePath === ".gitignore" || relativePath === "README.md";
}

function treeFiles(value) {
  return nulPaths(value).map((entry) => {
    const match = /^(100644) blob [a-f0-9]{40}\t(.+)$/.exec(entry);
    if (!match || !permittedRemoteFile(match[2])) throw new Error("Private memory remote contains unsupported files or links");
    return match[2];
  });
}

function githubRepo(remote) {
  const prefixes = ["git@github.com:", "https://github.com/", "ssh://git@github.com/"];
  const prefix = prefixes.find((item) => remote.startsWith(item));
  if (!prefix) throw new Error("Memory origin must be a GitHub SSH or HTTPS repository without embedded credentials");
  let name = remote.slice(prefix.length);
  if (name.endsWith(".git")) name = name.slice(0, -4);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error("Invalid memory GitHub origin");
  return name;
}

async function selectedVault(agentDir) {
  const selection = await inspectMemoryVault({ agentDir });
  if (selection.status !== "available") throw new Error(`Memory vault is ${selection.status}`);
  return selection.path;
}

async function privateRepo(run, vaultPath) {
  const root = (await output(run, "git", ["rev-parse", "--show-toplevel"], vaultPath)).trim();
  if (await fs.realpath(root) !== vaultPath) throw new Error("Memory vault must be the root of its own Git repository");
  const remote = (await output(run, "git", ["config", "--get", "remote.origin.url"], vaultPath)).trim();
  const repo = githubRepo(remote);
  const isPrivate = (await output(run, "gh", ["repo", "view", repo, "--json", "isPrivate", "--jq", ".isPrivate"], vaultPath)).trim();
  if (isPrivate !== "true") throw new Error("Memory GitHub repository must be private");
  return repo;
}

async function branchAndHead(run, vaultPath) {
  const branch = (await output(run, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], vaultPath)).trim();
  const head = (await output(run, "git", ["rev-parse", "HEAD"], vaultPath)).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Invalid memory Git HEAD");
  return { branch, head };
}

async function remoteMain(run, vaultPath) {
  const result = (await output(run, "git", ["ls-remote", "--heads", "origin", "main"], vaultPath)).trim();
  const match = /^([a-f0-9]{40})\s+refs\/heads\/main$/.exec(result);
  if (!match) throw new Error("Private memory origin/main is unavailable");
  return match[1];
}

async function ensureIndexClean(run, vaultPath) {
  if (await output(run, "git", ["diff", "--cached", "--name-only", "-z"], vaultPath) ||
      await output(run, "git", ["ls-files", "-u", "-z"], vaultPath)) {
    throw new Error("Memory Git index has staged changes or conflicts");
  }
}

async function noteDigest(vaultPath, relativePath) {
  const parts = relativePath.split("/");
  let parent = vaultPath;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    let stat;
    try { stat = await fs.lstat(parent); }
    catch (error) { if (error.code === "ENOENT") return { action: "delete", digest: null, bytes: 0 }; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe memory note parent: ${relativePath}`);
  }
  const file = path.join(parent, parts.at(-1));
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT") return { action: "delete", digest: null, bytes: 0 }; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_NOTE_BYTES) throw new Error(`Unsafe or oversized memory note: ${relativePath}`);
    const bounded = Buffer.alloc(MAX_NOTE_BYTES + 1);
    let length = 0;
    while (length < bounded.length) {
      const { bytesRead } = await handle.read(bounded, length, bounded.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_NOTE_BYTES) throw new Error(`Oversized memory note: ${relativePath}`);
    const bytes = bounded.subarray(0, length);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.includes(0)) throw new Error(`Binary memory note: ${relativePath}`);
    return { action: "upsert", digest: digest(bytes), bytes: bytes.length };
  } finally { await handle.close(); }
}

async function changedPaths(run, vaultPath) {
  const tracked = nulPaths(await output(run, "git", ["diff", "--name-only", "--no-renames", "-z"], vaultPath));
  const untracked = nulPaths(await output(run, "git", ["ls-files", "--others", "--exclude-standard", "-z"], vaultPath));
  const all = [...new Set([...tracked, ...untracked])].sort();
  if (all.length > MAX_CHANGED_PATHS) throw new Error("Too many memory worktree changes for one review");
  return all;
}

export function memorySyncTarget(vaultPath, action) {
  if (action !== "push" && action !== "pull") throw new Error("Memory sync action must be push or pull");
  return `memory/sync-${action}/${digest(vaultPath)}`;
}

/** Read-only plan. Only scoped Markdown notes enter the outgoing branch. */
export async function previewMemoryPush({ agentDir, run = runCommand }) {
  const vaultPath = await selectedVault(agentDir);
  const repo = await privateRepo(run, vaultPath);
  const { branch, head } = await branchAndHead(run, vaultPath);
  if (branch !== "main" && !/^pify-memory\/[0-9]{8}-[a-f0-9]{8}$/.test(branch)) {
    throw new Error("Push requires main or a Pify memory PR branch");
  }
  await ensureIndexClean(run, vaultPath);
  const upstream = await remoteMain(run, vaultPath);
  if (branch === "main" && head !== upstream) throw new Error("Memory main differs from origin/main; pull or resolve divergence first");
  if (branch !== "main") {
    const existing = nulPaths(await output(run, "git", ["diff", "--name-only", "-z", upstream, "HEAD"], vaultPath));
    if (existing.some((item) => !eligibleNote(item))) throw new Error("Memory PR branch contains unsupported changes");
  }
  const all = await changedPaths(run, vaultPath);
  const excluded = all.filter((item) => !eligibleNote(item));
  const changes = [];
  for (const relativePath of all.filter(eligibleNote)) {
    changes.push({ relativePath, ...(await noteDigest(vaultPath, relativePath)) });
  }
  const plan = { vaultPath, repo, branch, head, upstream, changes, excluded };
  return { status: changes.length ? "ready" : "no_changes", ...plan, reviewCode: digest(JSON.stringify(plan)) };
}

async function existingPr(run, vaultPath, repo, branch) {
  const raw = await output(run, "gh", ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url"], vaultPath);
  let prs;
  try { prs = JSON.parse(raw); } catch { throw new Error("Invalid GitHub PR list response"); }
  if (!Array.isArray(prs) || prs.length > 1) throw new Error("Ambiguous memory pull requests");
  return prs[0] ?? null;
}

async function confirmStaged(run, plan) {
  const staged = nulPaths(await output(run, "git", ["diff", "--cached", "--name-only", "-z"], plan.vaultPath));
  if (JSON.stringify(staged.sort()) !== JSON.stringify(plan.changes.map((item) => item.relativePath).sort())) {
    throw new Error("Staged memory paths differ from the reviewed plan");
  }
  for (const change of plan.changes) {
    if (change.action === "delete") continue;
    const bytes = await output(run, "git", ["show", `:${change.relativePath}`], plan.vaultPath, "buffer");
    if (digest(bytes) !== change.digest) throw new Error(`Staged memory note changed after review: ${change.relativePath}`);
  }
}

async function confirmCommit(run, plan) {
  const committed = nulPaths(await output(run, "git", ["diff", "--name-only", "-z", "HEAD^", "HEAD"], plan.vaultPath));
  if (JSON.stringify(committed.sort()) !== JSON.stringify(plan.changes.map((item) => item.relativePath).sort())) {
    throw new Error("Committed memory paths differ from the reviewed plan");
  }
  for (const change of plan.changes) {
    if (change.action === "delete") continue;
    const bytes = await output(run, "git", ["show", `HEAD:${change.relativePath}`], plan.vaultPath, "buffer");
    if (digest(bytes) !== change.digest) throw new Error(`Committed memory note changed after review: ${change.relativePath}`);
  }
}

/** Commit only reviewed notes to a Pify branch, push it, and open or reuse an unmerged PR. */
export async function pushMemory({ agentDir, reviewCode, permission, run = runCommand }) {
  const plan = await previewMemoryPush({ agentDir, run });
  if (reviewCode !== plan.reviewCode) throw new Error("Memory changes changed after preview");
  const decision = authorizePifyAction({ permission, action: {
    kind: "memory-push", targets: [memorySyncTarget(plan.vaultPath, "push")],
  } });
  if (decision.outcome !== "allowed") return decision;
  let branch = plan.branch;
  if (branch === "main" && plan.changes.length === 0) return { status: "no_changes", excluded: plan.excluded };
  if (branch === "main") {
    branch = `pify-memory/${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(4).toString("hex")}`;
    await output(run, "git", ["switch", "-c", branch], plan.vaultPath);
  }
  if (plan.changes.length) {
    await output(run, "git", ["add", "-A", "--", ...plan.changes.map((item) => item.relativePath)], plan.vaultPath);
    await confirmStaged(run, plan);
    await output(run, "git", ["commit", "-m", "docs(memory): sync reviewed notes"], plan.vaultPath);
    await confirmCommit(run, plan);
  }
  await privateRepo(run, plan.vaultPath);
  await output(run, "git", ["push", "-u", "origin", branch], plan.vaultPath);
  const pending = await existingPr(run, plan.vaultPath, plan.repo, branch);
  if (pending) return { status: "pending_pr", branch, number: pending.number, url: pending.url };
  const url = (await output(run, "gh", ["pr", "create", "--repo", plan.repo, "--base", "main", "--head", branch,
    "--title", "Update memory notes", "--body", "Explicit Pify memory sync. Review changes and merge manually."], plan.vaultPath)).trim();
  return { status: "pr_opened", branch, url };
}

/** Fetch one private main branch and advance local main only when Git can fast-forward. */
export async function pullMemory({ agentDir, permission, run = runCommand }) {
  const vaultPath = await selectedVault(agentDir);
  const repo = await privateRepo(run, vaultPath);
  const { branch } = await branchAndHead(run, vaultPath);
  if (branch !== "main") throw new Error("Pull requires the memory vault's main branch");
  const decision = authorizePifyAction({ permission, action: {
    kind: "memory-pull", targets: [memorySyncTarget(vaultPath, "pull")],
  } });
  if (decision.outcome !== "allowed") return decision;
  await ensureIndexClean(run, vaultPath);
  if (await output(run, "git", ["diff", "--name-only", "-z"], vaultPath)) {
    throw new Error("Memory worktree has tracked changes; pull stopped");
  }
  await output(run, "git", ["fetch", "origin", "main"], vaultPath);
  const remoteFiles = treeFiles(await output(run, "git", ["ls-tree", "-r", "-z", "FETCH_HEAD"], vaultPath));
  const untracked = new Set(nulPaths(await output(run, "git", ["ls-files", "--others", "--exclude-standard", "-z"], vaultPath)));
  if (remoteFiles.some((item) => untracked.has(item))) throw new Error("Pulled memory would collide with an untracked file");
  const counts = (await output(run, "git", ["rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"], vaultPath)).trim().split(/\s+/).map(Number);
  if (counts.length !== 2 || counts.some((item) => !Number.isInteger(item) || item < 0)) throw new Error("Invalid memory Git divergence result");
  if (counts[0] > 0) throw new Error("Memory main diverged; pull requires fast-forward");
  if (counts[1] === 0) return { status: "up_to_date", repo };
  await privateRepo(run, vaultPath);
  await output(run, "git", ["merge", "--ff-only", "FETCH_HEAD"], vaultPath);
  return { status: "fast_forwarded", repo, commits: counts[1] };
}
