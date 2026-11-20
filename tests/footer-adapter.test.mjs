import assert from "node:assert/strict";
import test from "node:test";

import { attachSubagentFooterAdapter, formatSubagentFooterStatus, SUBAGENT_FOOTER_KEY } from "../src/footer-adapter.mjs";
import { SUBAGENT_STATUS_EVENT, subagentStatus } from "../src/subagent-status.mjs";

test("footer counters use only bounded stable status counts", () => {
  const status = subagentStatus([], { nowMs: 0 });
  status.counts = { total: 6, queued: 1, active: 2, succeeded: 1, failed: 1, cancelled: 1, timedOut: 0 };
  status.jobs = [{ task: "private task", output: "private result" }];
  const label = formatSubagentFooterStatus(status);
  assert.equal(label, "Agents: 2 active · 1 queued · 3 done");
  assert.equal(label.includes("private"), false);
  assert.equal(formatSubagentFooterStatus({ ...status, schema: "other" }), null);
  assert.equal(formatSubagentFooterStatus({ ...status, counts: { ...status.counts, active: -1 } }), null);
  assert.equal(formatSubagentFooterStatus({ ...status, counts: { ...status.counts, queued: "1" } }), null);
  assert.equal(formatSubagentFooterStatus({ ...status, session: "ending" }), null);
});

test("adapter publishes only the namespaced status and clears it on removal", () => {
  let channel;
  let listener;
  let unsubscriptions = 0;
  const writes = [];
  const dispose = attachSubagentFooterAdapter({
    events: { on: (name, callback) => {
      channel = name;
      listener = callback;
      return () => { listener = null; unsubscriptions += 1; };
    } },
    setStatus: (key, value) => writes.push([key, value]),
  });
  assert.equal(channel, SUBAGENT_STATUS_EVENT);
  assert.deepEqual(writes, []);
  listener(subagentStatus([], { nowMs: 0 }));
  assert.deepEqual(writes, [[SUBAGENT_FOOTER_KEY, "Agents: 0 active · 0 queued · 0 done"]]);
  listener({ schema: "other" });
  assert.deepEqual(writes.at(-1), [SUBAGENT_FOOTER_KEY, undefined]);
  dispose();
  dispose();
  assert.equal(unsubscriptions, 1);
  assert.equal(listener, null);
  assert.deepEqual(writes.at(-1), [SUBAGENT_FOOTER_KEY, undefined]);
});
