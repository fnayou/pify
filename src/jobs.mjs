import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const MAX_ACTIVE = 4;
const MAX_HISTORY = 20;
const MAX_LOG_CHARS = 32_768;
const STOP_GRACE_MS = 300;

function killGroup(job, signal) {
  if (!job.pid) return;
  try {
    process.kill(-job.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") job.child.kill(signal);
  }
}

function groupAlive(job) {
  if (!job.pid) return false;
  try {
    process.kill(-job.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function publicJob(job) {
  return {
    id: job.id, command: job.command, cwd: job.cwd, pid: job.pid,
    state: job.state, startedAt: job.startedAt, endedAt: job.endedAt,
    exitCode: job.exitCode, signal: job.signal, message: job.message,
    logTruncated: { ...job.logTruncated },
  };
}

function appendLog(job, channel, chunk) {
  const combined = job.logs[channel] + chunk.toString("utf8");
  if (combined.length > MAX_LOG_CHARS) job.logTruncated[channel] = true;
  job.logs[channel] = combined.slice(-MAX_LOG_CHARS);
}

/** Owns short-lived shell jobs for exactly one Pi session. */
export class SessionJobs {
  constructor() {
    this.jobs = new Map();
    this.closed = false;
    this.onProcessExit = () => {
      for (const job of this.jobs.values()) if (job.state === "running" || job.state === "starting" || job.stopUnconfirmed) killGroup(job, "SIGKILL");
    };
    process.on("exit", this.onProcessExit);
  }

  list() { return [...this.jobs.values()].map(publicJob); }

  inspect(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return publicJob(job);
  }

  log(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return { ...publicJob(job), stdout: job.logs.stdout, stderr: job.logs.stderr };
  }

  async start({ command, cwd }) {
    if (this.closed) throw new Error("Session is ending");
    if (typeof command !== "string" || !command.trim() || command.includes("\0") || command.length > 4096) throw new Error("A nonempty shell command of at most 4096 characters is required");
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Absolute working directory is required");
    const active = [...this.jobs.values()].filter((job) => job.state === "running" || job.state === "starting").length;
    if (active >= MAX_ACTIVE) throw new Error(`At most ${MAX_ACTIVE} jobs may run in one session`);
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < MAX_HISTORY) break;
      if (job.state !== "running" && job.state !== "starting") this.jobs.delete(id);
    }
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const job = {
      id: randomUUID(), command, cwd, child, pid: child.pid ?? null,
      state: "starting", startedAt: new Date().toISOString(), endedAt: null,
      exitCode: null, signal: null, message: null,
      logs: { stdout: "", stderr: "" }, logTruncated: { stdout: false, stderr: false },
      stopRequested: false, stopUnconfirmed: false,
    };
    this.jobs.set(job.id, job);
    child.stdout.on("data", (chunk) => appendLog(job, "stdout", chunk));
    child.stderr.on("data", (chunk) => appendLog(job, "stderr", chunk));
    job.exited = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        job.endedAt = new Date().toISOString();
        job.exitCode = code;
        job.signal = signal;
        if (job.stopRequested) {
          job.state = "stopped";
          job.message = "Job stopped by request";
        } else if (job.message) {
          job.state = "failed";
        } else if (code === 0) {
          job.state = "succeeded";
        } else {
          job.state = "failed";
          job.message = signal ? `Job ended on ${signal}` : `Command exited with code ${code}`;
        }
        resolve();
      });
    });
    await new Promise((resolve) => {
      child.once("spawn", () => { job.state = "running"; resolve(); });
      child.once("error", (error) => { job.state = "failed"; job.message = `Could not start command: ${error.message}`; resolve(); });
    });
    return publicJob(job);
  }

  async stop(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (job.state !== "running" && job.state !== "starting") return { ...publicJob(job), outcome: "already_finished" };
    if (job.child.exitCode !== null || job.child.signalCode !== null) {
      await job.exited;
      return { ...publicJob(job), outcome: "already_finished" };
    }
    job.stopRequested = true;
    killGroup(job, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS));
    if (groupAlive(job)) killGroup(job, "SIGKILL");
    await Promise.race([job.exited, new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS))]);
    job.stopUnconfirmed = groupAlive(job) || job.state !== "stopped";
    if (job.stopUnconfirmed) job.message = "Stop could not be confirmed";
    return { ...publicJob(job), outcome: job.stopUnconfirmed ? "stop_unconfirmed" : "stopped" };
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.jobs.values()].filter((job) => job.state === "running" || job.state === "starting").map((job) => this.stop(job.id)));
    if (![...this.jobs.values()].some((job) => job.stopUnconfirmed)) process.off("exit", this.onProcessExit);
  }
}
