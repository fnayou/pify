import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { authorizePifyAction, permissionContext } from "./permissions.mjs";

const execFileAsync = promisify(execFile);
const SCHEMA = "pify.git-conflict/v1";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 8192;
const MARKER = /^(?:<{7}|={7}|>{7}|\|{7})(?:[ \t]|$)/;

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_LITERAL_PATHSPECS = "1";
  return env;
}

function gitError(command, error) {
  const detail = String(error.stderr ?? error.message ?? "Git failed").trim().slice(0, 500);
  return new Error(`Git ${command} failed: ${detail}`);
}

async function git(cwd, args, accepted = [0]) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd, env: gitEnv(), encoding: "buffer", maxBuffer: MAX_GIT_OUTPUT, timeout: 10_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (accepted.includes(error.code)) return { code: error.code, stdout: error.stdout ?? Buffer.alloc(0), stderr: error.stderr ?? Buffer.alloc(0) };
    throw gitError(args[0], error);
  }
}

async function gitInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd, env: gitEnv(), stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [];
    const errors = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10_000);
    child.stdout.on("data", (chunk) => { size += chunk.length; output.push(chunk); if (size > MAX_GIT_OUTPUT) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk) => { size += chunk.length; errors.push(chunk); if (size > MAX_GIT_OUTPUT) child.kill("SIGKILL"); });
    child.stdin.on("error", () => {});
    child.once("error", (error) => { clearTimeout(timer); reject(gitError(args[0], error)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(errors);
      if (code === 0 && !timedOut && size <= MAX_GIT_OUTPUT) resolve(Buffer.concat(output));
      else reject(gitError(args[0], { stderr: timedOut ? "Timed out" : size > MAX_GIT_OUTPUT ? "Output limit exceeded" : stderr }));
    });
    child.stdin.end(input);
  });
}

async function rootFor(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Absolute working directory is required");
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = result.stdout.toString("utf8").replace(/\n$/, "");
  if (!path.isAbsolute(root) || root.includes("\n")) throw new Error("Unsupported repository root");
  return fs.realpath(root);
}

function relativeFile(root, cwd, file) {
  if (typeof file !== "string" || !file || file.includes("\0") || path.isAbsolute(file)) throw new Error("A relative conflict path is required");
  const absolute = path.resolve(cwd, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || relative.includes("\\")) {
    throw new Error("Conflict path must stay inside the repository");
  }
  return { absolute, relative: relative.split(path.sep).join("/") };
}

function stagesFrom(output) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return output.toString("binary").split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("Malformed Git conflict index");
    const header = record.slice(0, tab).split(" ");
    if (header.length !== 3 || !/^[0-3]$/.test(header[2]) || !/^[0-9a-f]{40,64}$/.test(header[1])) {
      throw new Error("Malformed Git conflict index");
    }
    const raw = Buffer.from(record.slice(tab + 1), "binary");
    return { mode: header[0], oid: header[1], stage: Number(header[2]), path: decoder.decode(raw) };
  });
}

function markerLine(line) { return line.replace(/\r?\n$/, ""); }

function chooseHunks(source, choice) {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result = [];
  let state = "normal";
  let ours = [];
  let theirs = [];
  let hunks = 0;
  for (const line of lines) {
    const label = markerLine(line);
    if (state === "normal") {
      if (label.startsWith("<<<<<<< ")) { state = "ours"; ours = []; theirs = []; }
      else if (MARKER.test(label)) throw new Error("Malformed conflict markers");
      else result.push(line);
    } else if (state === "ours") {
      if (label === "=======") state = "theirs";
      else if (label.startsWith("||||||| ")) state = "base";
      else if (MARKER.test(label)) throw new Error("Malformed conflict markers");
      else ours.push(line);
    } else if (state === "base") {
      if (label === "=======") state = "theirs";
      else if (MARKER.test(label)) throw new Error("Malformed conflict markers");
    } else if (label.startsWith(">>>>>>> ")) {
      result.push(...(choice === "ours" ? ours : theirs));
      state = "normal";
      hunks += 1;
    } else if (MARKER.test(label)) throw new Error("Malformed conflict markers");
    else theirs.push(line);
  }
  if (state !== "normal" || hunks === 0 || result.some((line) => MARKER.test(markerLine(line)))) {
    throw new Error("No complete, standard text conflict hunks");
  }
  return { candidate: result.join(""), hunks };
}

async function validateCandidate(root, originalFile, candidate, relative) {
  if (relative.toLowerCase().endsWith(".json")) {
    try { JSON.parse(candidate); }
    catch { return { status: "unresolvable", reason: "invalid_json" }; }
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pify-conflict-check-"));
  try {
    const candidateFile = path.join(temporary, "candidate");
    await fs.writeFile(candidateFile, candidate, { mode: 0o600 });
    const check = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-index", "--check", "--", originalFile, candidateFile], [0, 1, 3]);
    if (check.code > 1 || check.stdout.length || check.stderr.length) {
      return { status: "unresolvable", reason: "git_diff_check", detail: check.stdout.toString("utf8").slice(0, 500) };
    }
    const preview = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-index", "--unified=3", "--", originalFile, candidateFile], [0, 1]);
    const diff = preview.stdout.toString("utf8").replaceAll(originalFile, relative).replaceAll(candidateFile, `${relative} (resolved)`)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, " ");
    if (diff.length > MAX_PREVIEW_CHARS) return { status: "unresolvable", reason: "preview_too_large" };
    return { status: "valid", checks: ["standard_conflict_markers", "git_diff_check", ...(relative.toLowerCase().endsWith(".json") ? ["json_parse"] : [])], diff };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function prepare({ cwd, file, choice }) {
  if (choice !== "ours" && choice !== "theirs") throw new Error("Choose ours or theirs");
  const root = await rootFor(cwd);
  const { absolute, relative } = relativeFile(root, await fs.realpath(cwd), file);
  const base = { schema: SCHEMA, path: relative, choice };
  const unresolved = (reason) => ({ report: { ...base, status: "unresolvable", reason } });
  const head = (await git(root, ["rev-parse", "--verify", "HEAD"])).stdout.toString("utf8").trim();
  const index = (await git(root, ["ls-files", "-u", "-z", "--", relative])).stdout;
  const stages = stagesFrom(index).filter((entry) => entry.path === relative);
  if (!stages.length) return unresolved("not_unmerged");
  const ours = stages.find((entry) => entry.stage === 2);
  const theirs = stages.find((entry) => entry.stage === 3);
  if (!ours || !theirs || ours.mode !== theirs.mode || !["100644", "100755"].includes(ours.mode)) return unresolved("unsupported_conflict_type");
  let stat;
  let original;
  try {
    stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES || (stat.mode & 0o7000) !== 0 ||
        Boolean(stat.mode & 0o111) !== (ours.mode === "100755") || await fs.realpath(absolute) !== absolute) {
      return unresolved("unsupported_worktree_file");
    }
    original = await fs.readFile(absolute);
    if (original.includes(0)) return unresolved("binary_conflict");
  } catch { return unresolved("worktree_file_unavailable"); }
  let candidate;
  let hunks;
  try {
    ({ candidate, hunks } = chooseHunks(new TextDecoder("utf-8", { fatal: true }).decode(original), choice));
  } catch { return unresolved("malformed_or_missing_markers"); }
  const validation = await validateCandidate(root, absolute, candidate, relative);
  if (validation.status !== "valid") return { report: { ...base, ...validation } };
  const candidateBytes = Buffer.from(candidate, "utf8");
  const reviewCode = createHash("sha256").update(root).update(relative).update(head).update(index).update(original).update(choice).update(candidateBytes).digest("hex").slice(0, 16);
  return {
    report: { ...base, status: "ready", hunks, reviewCode, validation: validation.checks, projectTests: "not_run", diff: validation.diff },
    root, absolute, relative, original, candidateBytes, stat, index, head, mode: ours.mode,
  };
}

async function atomicWrite(file, content, mode) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.pify-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await fs.chmod(temporary, mode & 0o777);
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function unchanged(plan) {
  try {
    const stat = await fs.lstat(plan.absolute);
    if (stat.dev !== plan.stat.dev || stat.ino !== plan.stat.ino || stat.size !== plan.stat.size || stat.mtimeMs !== plan.stat.mtimeMs) return false;
    if (!(await fs.readFile(plan.absolute)).equals(plan.original)) return false;
    if (!(await git(plan.root, ["ls-files", "-u", "-z", "--", plan.relative])).stdout.equals(plan.index)) return false;
    return (await git(plan.root, ["rev-parse", "--verify", "HEAD"])).stdout.toString("utf8").trim() === plan.head;
  } catch { return false; }
}

export async function listGitConflicts({ cwd }) {
  const root = await rootFor(cwd);
  const entries = stagesFrom((await git(root, ["ls-files", "-u", "-z"])).stdout);
  const conflicts = [...new Set(entries.map((entry) => entry.path))].map((file) => ({ path: file, stages: entries.filter((entry) => entry.path === file).map((entry) => entry.stage) }));
  return { schema: SCHEMA, status: "listed", root, conflicts };
}

export async function previewGitConflict(options) { return (await prepare(options)).report; }

export async function resolveGitConflict({ cwd, file, choice, permission = permissionContext(), reviewCode }) {
  const plan = await prepare({ cwd, file, choice });
  if (plan.report.status !== "ready") return plan.report;
  if (reviewCode && reviewCode !== plan.report.reviewCode) return { ...plan.report, status: "unresolvable", reason: "preview_changed" };
  const target = `git/conflicts/${plan.relative}`;
  const decision = authorizePifyAction({ permission, action: { kind: "resolve-git-conflict", targets: [target] } });
  if (decision.outcome !== "allowed") return decision;
  if (!(await unchanged(plan))) return { ...plan.report, status: "unresolvable", reason: "conflict_changed" };
  let wrote = false;
  let indexed = false;
  let oid = null;
  try {
    oid = (await gitInput(plan.root, ["hash-object", "-w", "--no-filters", "--stdin"], plan.candidateBytes)).toString("utf8").trim();
    if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error("Git returned an invalid blob ID");
    if (!(await unchanged(plan))) throw new Error("Conflict changed during resolution");
    await atomicWrite(plan.absolute, plan.candidateBytes, plan.stat.mode);
    wrote = true;
    await gitInput(plan.root, ["update-index", "-z", "--index-info"], Buffer.from(`${plan.mode} ${oid}\t${plan.relative}\0`));
    indexed = true;
    const after = (await git(plan.root, ["ls-files", "-u", "-z", "--", plan.relative])).stdout;
    if (after.length || !(await fs.readFile(plan.absolute)).equals(plan.candidateBytes)) throw new Error("Resolution did not remain staged and unchanged");
    const check = await git(plan.root, ["diff", "--no-ext-diff", "--cached", "--check", "--", plan.relative]);
    if (check.stdout.length || (await git(plan.root, ["rev-parse", "--verify", "HEAD"])).stdout.toString("utf8").trim() !== plan.head) {
      throw new Error("Staged validation or HEAD changed");
    }
    return { ...plan.report, status: "resolved", staged: true,
      validation: [...plan.report.validation, "staged_diff_check"], commitCreated: false, pushed: false };
  } catch (error) {
    const recovery = [];
    if (indexed) {
      try {
        const staged = (await git(plan.root, ["ls-files", "-s", "-z", "--", plan.relative])).stdout.toString("utf8");
        if (!staged.startsWith(`${plan.mode} ${oid} 0\t${plan.relative}\0`)) throw new Error("Index changed concurrently");
        await gitInput(plan.root, ["update-index", "-z", "--index-info"], plan.index);
      } catch (restoreError) { recovery.push(`index: ${restoreError.message}`); }
    }
    if (wrote) {
      try {
        if (!(await fs.readFile(plan.absolute)).equals(plan.candidateBytes)) throw new Error("File changed concurrently");
        await atomicWrite(plan.absolute, plan.original, plan.stat.mode);
      } catch (restoreError) { recovery.push(`file: ${restoreError.message}`); }
    }
    return { ...plan.report, status: recovery.length ? "recovery_needed" : "unresolvable", reason: "apply_failed", detail: error.message, recovery };
  }
}
