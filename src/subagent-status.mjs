export const SUBAGENT_STATUS_SCHEMA = "pify.subagents/status/v1";
export const SUBAGENT_STATUS_EVENT = "pify:subagents/status";

const ACTIVE_STATES = new Set(["starting", "running", "cancelling"]);
const plain = (value, limit) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").slice(0, limit);

function elapsed(job, nowMs) {
  const start = Date.parse(job.startedAt ?? job.queuedAt);
  const end = job.endedAt ? Date.parse(job.endedAt) : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

/** Stable, bounded worker status data. Full output stays behind inspect(id). */
export function subagentStatus(jobs, { sequence = 0, closed = false, nowMs = Date.now() } = {}) {
  const entries = [...jobs].map((job) => ({
    id: job.id,
    task: plain(job.task, 160),
    provider: plain(job.provider, 100),
    model: plain(job.model, 200),
    state: job.state,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    elapsedMs: elapsed(job, nowMs),
    activity: plain(job.activity, 160),
    activityAt: job.activityAt,
    error: ["failed", "timed_out"].includes(job.state) ? plain(job.message, 240) : null,
    cancelled: job.state === "cancelled" || job.state === "cancelling",
    resultAvailable: Boolean(job.output),
  }));
  const count = (state) => entries.filter((job) => job.state === state).length;
  return {
    schema: SUBAGENT_STATUS_SCHEMA,
    sequence,
    generatedAt: new Date(nowMs).toISOString(),
    session: closed ? "ending" : "active",
    counts: {
      total: entries.length,
      queued: count("queued"),
      active: entries.filter((job) => ACTIVE_STATES.has(job.state)).length,
      succeeded: count("succeeded"),
      failed: count("failed"),
      cancelled: count("cancelled"),
      timedOut: count("timed_out"),
    },
    jobs: entries,
  };
}
