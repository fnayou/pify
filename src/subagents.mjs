import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

import { authorizePifyAction, deriveWorkerPermission, permissionContext } from "./permissions.mjs";
import { subagentStatus } from "./subagent-status.mjs";

export const SUBAGENT_START_RESOURCE = "agents/task-start";
const DEFAULT_EXTENSION = fileURLToPath(new URL("../extensions/pify-permissions.js", import.meta.url));
const TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "pify_search", "pify_inspect"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_HISTORY = 20;
const MAX_TASK_CHARS = 4096;
const MAX_RESULT_CHARS = 16_384;
const MAX_STDERR_CHARS = 4096;
const MAX_EVENT_CHARS = 1024 * 1024;
const STOP_GRACE_MS = 300;

function active(job) { return ["starting", "running", "cancelling"].includes(job.state); }
function bounded(value, max) { return value.length > max ? value.slice(-max) : value; }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function killGroup(job, signal) {
  if (!job.pid) return;
  try { process.kill(-job.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") job.child.kill(signal); }
}

function groupAlive(job) {
  if (!job.pid) return false;
  try { process.kill(-job.pid, 0); return true; }
  catch { return false; }
}

function publicJob(job, detailed = false) {
  const result = {
    id: job.id, provider: job.provider, model: job.model, mode: job.permission.mode,
    scope: [...job.permission.authorizedPaths], tools: [...job.tools], state: job.state,
    task: detailed ? job.task : job.task.slice(0, 160), pid: job.pid,
    queuedAt: job.queuedAt, startedAt: job.startedAt, endedAt: job.endedAt,
    exitCode: job.exitCode, signal: job.signal, message: job.message,
  };
  if (detailed) { result.output = job.output; result.stderr = job.stderr; }
  return result;
}

/** Session-bound Pi workers with bounded per-provider queues and cancellation. */
export class SessionSubagents {
  constructor({ command = "pi", spawnImpl = spawn, extensionPath = DEFAULT_EXTENSION,
    maxPerProvider = 2, maxTotal = 4, maxRunMs = 5 * 60 * 1000, onStatus = null } = {}) {
    if (![maxPerProvider, maxTotal, maxRunMs].every((value) => Number.isInteger(value) && value > 0)) {
      throw new Error("Subagent limits must be positive integers");
    }
    this.command = command;
    this.spawnImpl = spawnImpl;
    this.extensionPath = extensionPath;
    this.maxPerProvider = maxPerProvider;
    this.maxTotal = maxTotal;
    this.maxRunMs = maxRunMs;
    this.jobs = new Map();
    this.closed = false;
    this.sequence = 0;
    this.listeners = new Set();
    this.onStatus = onStatus;
    this.onProcessExit = () => {
      for (const job of this.jobs.values()) if (active(job)) killGroup(job, "SIGKILL");
    };
    process.on("exit", this.onProcessExit);
  }

  list() { return [...this.jobs.values()].map((job) => publicJob(job)); }

  status() { return subagentStatus(this.jobs.values(), { sequence: this.sequence, closed: this.closed }); }

  subscribe(listener) {
    if (typeof listener !== "function") throw new Error("Status listener must be a function");
    this.listeners.add(listener);
    try { listener(this.status()); }
    catch (error) { this.listeners.delete(listener); throw error; }
    return () => this.listeners.delete(listener);
  }

  publish() {
    this.sequence += 1;
    const snapshot = this.status();
    for (const listener of [this.onStatus, ...this.listeners]) {
      try { listener?.(snapshot); } catch { /* A status consumer cannot stop workers. */ }
    }
  }

  inspect(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Subagent not found: ${id}`);
    return publicJob(job, true);
  }

  start({ task, cwd, provider, model, thinkingLevel = "off", parentPermission,
    startPermission = parentPermission, workerMode, workerScope, parentTools = [], trusted = false }) {
    if (this.closed) throw new Error("Subagent session is ending");
    if (typeof task !== "string" || !task.trim() || task.length > MAX_TASK_CHARS || task.includes("\0")) {
      throw new Error("A task of at most 4096 characters is required");
    }
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Absolute worker directory is required");
    if (typeof provider !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(provider) ||
        typeof model !== "string" || !model || model.length > 200 || model.includes("\0")) {
      throw new Error("A selected provider and model are required");
    }
    if (!THINKING_LEVELS.has(thinkingLevel)) throw new Error("Invalid worker thinking level");
    if (!Array.isArray(parentTools) || parentTools.some((tool) => typeof tool !== "string")) throw new Error("Parent tools must be names");
    const parent = permissionContext(parentPermission);
    const decision = authorizePifyAction({ permission: startPermission, action: {
      kind: "subagent-start", targets: [SUBAGENT_START_RESOURCE],
    } });
    if (decision.outcome !== "allowed") return decision;
    const id = randomUUID();
    const permission = deriveWorkerPermission(parent, {
      mode: workerMode ?? parent.mode,
      authorizedPaths: workerScope ?? parent.authorizedPaths,
      callerId: `subagent:${id}`,
    });
    const tools = [...new Set(parentTools)].filter((tool) => TOOL_NAMES.has(tool));
    for (const [oldId, job] of this.jobs) {
      if (this.jobs.size < MAX_HISTORY) break;
      if (!active(job) && job.state !== "queued") this.jobs.delete(oldId);
    }
    if (this.jobs.size >= MAX_HISTORY) throw new Error("Subagent history is full");
    const job = {
      id, task, cwd, provider, model, thinkingLevel, permission, tools, trusted,
      state: "queued", queuedAt: new Date().toISOString(), startedAt: null, endedAt: null,
      pid: null, child: null, exitCode: null, signal: null, message: null,
      output: "", stderr: "", settled: false, protocolError: false,
      activity: "Queued", activityAt: new Date().toISOString(),
      cancelReason: null, done: null, timer: null,
    };
    this.jobs.set(id, job);
    this.pump();
    this.publish();
    return publicJob(job);
  }

  pump() {
    if (this.closed) return;
    for (const job of this.jobs.values()) {
      if (job.state !== "queued") continue;
      const running = [...this.jobs.values()].filter(active);
      if (running.length >= this.maxTotal) return;
      if (running.filter((item) => item.provider === job.provider).length >= this.maxPerProvider) continue;
      this.launch(job);
    }
  }

  launch(job) {
    job.state = "starting";
    job.startedAt = new Date().toISOString();
    job.activity = "Starting Pi worker";
    job.activityAt = job.startedAt;
    const args = ["--mode", "json", "--print", "--no-session", "--offline", "--no-mcp",
      "--no-extensions", "--extension", this.extensionPath, "--no-skills", "--no-prompt-templates",
      job.trusted ? "--approve" : "--no-approve", "--provider", job.provider, "--model", job.model,
      "--thinking", job.thinkingLevel, "--pify-mode", job.permission.mode];
    if (job.permission.authorizedPaths.length) args.push("--pify-scope", job.permission.authorizedPaths.join(","));
    if (job.tools.length) args.push("--tools", job.tools.join(","));
    else args.push("--no-tools");
    args.push("--", `Task delegated by the parent Pi session. Report the result to the parent.\n\n${job.task}`);

    let child;
    try {
      child = this.spawnImpl(this.command, args, {
        cwd: job.cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PIFY_SUBAGENT_CHILD: "1", GIT_TERMINAL_PROMPT: "0" },
      });
    } catch (error) {
      this.finish(job, null, null, `Could not start subagent: ${error.message}`);
      return;
    }
    job.child = child;
    job.pid = child.pid ?? null;
    job.state = "running";
    job.activity = "Running";
    job.activityAt = new Date().toISOString();
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_EVENT_CHARS) job.protocolError = true;
        else this.readEvent(job, line);
      }
      if (buffer.length > MAX_EVENT_CHARS) { job.protocolError = true; buffer = ""; }
    });
    child.stderr?.on("data", (chunk) => { job.stderr = bounded(job.stderr + chunk.toString("utf8"), MAX_STDERR_CHARS); });
    child.once("error", (error) => {
      if (!job.pid) this.finish(job, null, null, `Could not start subagent: ${error.message}`);
      else {
        job.message = `Subagent process error: ${error.message}`;
        killGroup(job, "SIGKILL");
      }
    });
    child.once("close", (code, signal) => {
      if (buffer.trim()) this.readEvent(job, buffer);
      this.finish(job, code, signal);
    });
    job.done = new Promise((resolve) => { job.resolveDone = resolve; });
    job.timer = setTimeout(() => { this.cancel(job.id, "timeout").catch(() => {}); }, this.maxRunMs);
  }

  readEvent(job, line) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { job.protocolError = true; return; }
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
      job.activity = `Using ${event.toolName}`;
      job.activityAt = new Date().toISOString();
      this.publish();
    }
    if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
      job.activity = `Finished ${event.toolName}`;
      job.activityAt = new Date().toISOString();
      this.publish();
    }
    if (event.type === "agent_settled") job.settled = !event.aborted;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const content = event.message.content;
      if (Array.isArray(content)) {
        const text = content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
        if (text) job.output = bounded(text, MAX_RESULT_CHARS);
      }
      if (event.message.stopReason === "error") job.message = "Subagent model returned an error";
      job.activity = job.message ?? "Response available";
      job.activityAt = new Date().toISOString();
      this.publish();
    }
  }

  finish(job, code, signal, error = null) {
    if (job.endedAt) return;
    if (job.timer) clearTimeout(job.timer);
    job.endedAt = new Date().toISOString();
    job.exitCode = code;
    job.signal = signal;
    if (job.cancelReason) {
      job.state = job.cancelReason === "timeout" ? "timed_out" : "cancelled";
      job.message = job.cancelReason === "timeout" ? "Subagent exceeded its time limit" : "Subagent cancelled";
    } else if (error || job.protocolError || job.message || code !== 0 || !job.settled) {
      job.state = "failed";
      job.message = error ?? job.message ?? (job.protocolError ? "Invalid subagent event stream" :
        code !== 0 ? `Subagent exited with code ${code}` : "Subagent ended without settling");
    } else job.state = "succeeded";
    job.activity = job.message ?? (job.state === "succeeded" ? "Completed" : job.state);
    job.activityAt = job.endedAt;
    job.resolveDone?.();
    this.pump();
    this.publish();
  }

  async cancel(id, reason = "user") {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Subagent not found: ${id}`);
    if (job.state === "queued") {
      job.state = "cancelled";
      job.cancelReason = reason;
      job.endedAt = new Date().toISOString();
      job.message = "Queued subagent cancelled";
      job.activity = job.message;
      job.activityAt = job.endedAt;
      this.pump();
      this.publish();
      return { ...publicJob(job), outcome: "cancelled_queued" };
    }
    if (!active(job)) return { ...publicJob(job), outcome: "already_finished" };
    job.cancelReason = reason;
    job.state = "cancelling";
    job.activity = reason === "timeout" ? "Time limit reached; stopping" : "Cancellation requested";
    job.activityAt = new Date().toISOString();
    this.publish();
    killGroup(job, "SIGTERM");
    await Promise.race([job.done ?? wait(STOP_GRACE_MS), wait(STOP_GRACE_MS)]);
    if (active(job) && groupAlive(job)) killGroup(job, "SIGKILL");
    await Promise.race([job.done ?? wait(STOP_GRACE_MS), wait(STOP_GRACE_MS)]);
    const confirmed = !active(job) && !groupAlive(job);
    return { ...publicJob(job), outcome: confirmed ? (reason === "timeout" ? "timed_out" : "cancelled") : "stop_unconfirmed" };
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.jobs.values()) {
      if (job.state === "queued") {
        job.state = "cancelled";
        job.endedAt = new Date().toISOString();
        job.message = "Session ended before subagent started";
        job.activity = job.message;
        job.activityAt = job.endedAt;
      }
    }
    this.publish();
    await Promise.all([...this.jobs.values()].filter(active).map((job) => this.cancel(job.id)));
    if (![...this.jobs.values()].some(active)) process.off("exit", this.onProcessExit);
  }
}
