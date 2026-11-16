import assert from "node:assert/strict";
import test from "node:test";

import { createSubagentDashboard } from "../src/subagent-dashboard.mjs";
import { SUBAGENT_STATUS_SCHEMA, subagentStatus } from "../src/subagent-status.mjs";

const nowMs = Date.parse("2026-11-16T12:00:10.000Z");
const base = { queuedAt: "2026-11-16T12:00:00.000Z", startedAt: "2026-11-16T12:00:01.000Z",
  endedAt: null, provider: "fixture", model: "model", activity: "Running", activityAt: null,
  message: null, output: "", task: "task", stderr: "" };
const job = (id, state, extra = {}) => ({ ...base, id, state, ...extra });

test("status feed summarizes mixed outcomes without exposing results", () => {
  const jobs = [
    job("running", "running"),
    job("success", "succeeded", { endedAt: "2026-11-16T12:00:03.000Z", output: "private result" }),
    job("failure", "failed", { endedAt: "2026-11-16T12:00:04.000Z", message: "worker error" }),
    job("cancelled", "cancelled", { endedAt: "2026-11-16T12:00:05.000Z", message: "Subagent cancelled" }),
  ];
  const status = subagentStatus(jobs, { sequence: 7, nowMs });
  assert.equal(status.schema, SUBAGENT_STATUS_SCHEMA);
  assert.equal(status.sequence, 7);
  assert.deepEqual(status.counts, { total: 4, queued: 0, active: 1, succeeded: 1, failed: 1, cancelled: 1, timedOut: 0 });
  assert.equal(status.jobs[0].elapsedMs, 9000);
  assert.equal(status.jobs[1].elapsedMs, 2000);
  assert.equal(status.jobs[1].resultAvailable, true);
  assert.equal(status.jobs[2].error, "worker error");
  assert.equal(status.jobs[3].cancelled, true);
  assert.equal(JSON.stringify(status).includes("private result"), false);
});

test("dashboard shows mixed states and inspects completed output", () => {
  const jobs = [
    job("success", "succeeded", { endedAt: "2026-11-16T12:00:03.000Z", output: "completed answer" }),
    job("failure", "failed", { endedAt: "2026-11-16T12:00:04.000Z", message: "worker error", stderr: "diagnostic text" }),
    job("cancelled", "cancelled", { endedAt: "2026-11-16T12:00:05.000Z", message: "Subagent cancelled" }),
  ];
  let listener;
  let renders = 0;
  let closed = 0;
  const manager = {
    status: () => subagentStatus(jobs, { nowMs }),
    inspect: (id) => jobs.find((item) => item.id === id),
    subscribe: (fn) => { listener = fn; fn(); return () => { listener = null; }; },
  };
  const dashboard = createSubagentDashboard({ manager, tui: { requestRender: () => renders++ },
    theme: { fg: (_color, value) => value },
    keybindings: { matches: (data, key) => data === (key === "tui.select.cancel" ? "escape" : "enter") },
    done: () => closed++, intervalMs: 60_000 });
  try {
    const list = dashboard.render(120).join("\n");
    assert.match(list, /succeeded/);
    assert.match(list, /failed/);
    assert.match(list, /cancelled/);
    assert.match(list, /worker error/);
    dashboard.handleInput("enter");
    assert.match(dashboard.render(120).join("\n"), /completed answer/);
    dashboard.handleInput("escape");
    dashboard.handleInput("j");
    dashboard.handleInput("enter");
    const details = dashboard.render(120).join("\n");
    assert.match(details, /worker error/);
    assert.match(details, /diagnostic text/);
    listener();
    assert.ok(renders > 0);
    dashboard.handleInput("escape");
    dashboard.handleInput("escape");
    assert.equal(closed, 1);
  } finally { dashboard.dispose(); }
  assert.equal(listener, null);
});
