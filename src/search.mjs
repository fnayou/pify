import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_TIMEOUT_MS = 5000;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_TEXT_LENGTH = 240;

function boundedInteger(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return value;
}

function relativeResult(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/** Search one named directory. ripgrep enforces its filesystem and symlink traversal boundaries. */
export async function searchLocal({ cwd, scope = ".", mode, query, limit, timeoutMs, signal, rgPath = "rg" }) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Absolute working directory is required");
  if (typeof scope !== "string" || !scope.trim()) throw new Error("Search scope is required");
  if (mode !== "filename" && mode !== "content") throw new Error("Search mode must be filename or content");
  if (typeof query !== "string" || !query.trim()) throw new Error("Nonempty search query is required");
  if (query.includes("\0")) throw new Error("Search query cannot contain NUL");
  const resultLimit = boundedInteger(limit, DEFAULT_LIMIT, MAX_LIMIT, "limit");
  const deadlineMs = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeoutMs");
  const root = path.resolve(cwd, scope);
  const started = Date.now();
  let validationTimer;
  const stat = await Promise.race([
    fs.lstat(root),
    new Promise((resolve) => { validationTimer = setTimeout(() => resolve(null), deadlineMs); }),
  ]).finally(() => clearTimeout(validationTimer));
  const timedOutReport = () => ({
    schema: "pify.search/v1", scope: root, mode, query, results: [],
    limit: resultLimit, timeoutMs: deadlineMs,
    limitReached: false, timedOut: true, outputLimitReached: false, partial: true,
  });
  if (stat === null) return timedOutReport();
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Search scope must be a real directory");
  if (signal?.aborted) throw new Error("Search cancelled");
  const remainingMs = deadlineMs - (Date.now() - started);
  if (remainingMs <= 0) return timedOutReport();

  const args = ["--no-config", "--hidden", "--one-file-system", "--no-follow"];
  if (mode === "filename") args.push("--files", "--null", "--", root);
  else args.push("--json", "--fixed-strings", "--line-number", "--", query, root);

  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    const delimiter = mode === "filename" ? "\0" : "\n";
    const results = [];
    let pending = "";
    let stderr = "";
    let stopReason = null;
    let settled = false;
    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => stop("timeout"), remainingMs);
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const accept = (record) => {
      if (mode === "filename") {
        const relative = relativeResult(root, record);
        if (relative && path.basename(relative).includes(query)) results.push({ path: relative });
      } else {
        let event;
        try { event = JSON.parse(record); } catch { return; }
        if (event.type !== "match") return;
        const candidate = event.data?.path?.text;
        const line = event.data?.line_number;
        const content = event.data?.lines?.text;
        const relative = typeof candidate === "string" ? relativeResult(root, candidate) : null;
        if (!relative || !Number.isInteger(line) || typeof content !== "string") return;
        const oneLine = content.replace(/\r?\n$/, "");
        results.push({ path: relative, line, text: oneLine.slice(0, MAX_TEXT_LENGTH), textTruncated: oneLine.length > MAX_TEXT_LENGTH });
      }
      if (results.length >= resultLimit) stop("result_limit");
    };
    child.stdout.on("data", (chunk) => {
      if (stopReason) return;
      pending += decoder.write(chunk);
      let index;
      while (!stopReason && (index = pending.indexOf(delimiter)) >= 0) {
        const record = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (Buffer.byteLength(record) > MAX_RECORD_BYTES) { stop("record_limit"); break; }
        accept(record);
      }
      if (!stopReason && Buffer.byteLength(pending) > MAX_RECORD_BYTES) stop("record_limit");
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(0, 1000); });
    child.on("error", (error) => finish(() => reject(new Error(`Search could not start: ${error.message}`))));
    child.on("close", (code) => {
      if (settled) return;
      if (!stopReason) {
        pending += decoder.end();
        if (pending && mode === "content") accept(pending);
      }
      if (stopReason === "cancelled") return finish(() => reject(new Error("Search cancelled")));
      if (!stopReason && code !== 0 && code !== 1) return finish(() => reject(new Error(`Search failed: ${stderr.trim() || `ripgrep exited ${code}`}`)));
      finish(() => resolve({
        schema: "pify.search/v1", scope: root, mode, query, results,
        limit: resultLimit, timeoutMs: deadlineMs,
        limitReached: stopReason === "result_limit", timedOut: stopReason === "timeout",
        outputLimitReached: stopReason === "record_limit",
        partial: stopReason !== null,
      }));
    });
  });
}
