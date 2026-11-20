import { SUBAGENT_STATUS_EVENT, SUBAGENT_STATUS_SCHEMA } from "./subagent-status.mjs";

export const SUBAGENT_FOOTER_KEY = "pify-subagents";

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 9999;
}

/** Only the stable status envelope contributes text to a user-owned footer. */
export function formatSubagentFooterStatus(snapshot) {
  if (snapshot?.schema !== SUBAGENT_STATUS_SCHEMA || snapshot.session !== "active") return null;
  const counts = snapshot.counts;
  if (!counts || !["active", "queued", "succeeded", "failed", "cancelled", "timedOut"].every((key) => count(counts[key]))) return null;
  const done = counts.succeeded + counts.failed + counts.cancelled + counts.timedOut;
  return `Agents: ${counts.active} active · ${counts.queued} queued · ${done} done`;
}

/** Subscribe without taking ownership of Pi's footer component. */
export function attachSubagentFooterAdapter({ events, setStatus }) {
  const unsubscribe = events.on(SUBAGENT_STATUS_EVENT, (snapshot) => {
    setStatus(SUBAGENT_FOOTER_KEY, formatSubagentFooterStatus(snapshot) ?? undefined);
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    setStatus(SUBAGENT_FOOTER_KEY, undefined);
  };
}
