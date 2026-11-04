import { randomUUID } from "node:crypto";

const MODES = ["safe", "balanced", "full"];
const RESULT_SCHEMA = "pify.permission-result/v1";

function exactPath(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every((part) => part && part !== "." && part !== "..");
}

export function permissionContext({ mode = "balanced", authorizedPaths = [], callerId = "local" } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Invalid Pify permission mode: ${mode}`);
  if (!Array.isArray(authorizedPaths) || authorizedPaths.some((item) => !exactPath(item))) {
    throw new Error("Authorized paths must be a list of exact resource paths");
  }
  if (typeof callerId !== "string" || !callerId) throw new Error("Caller id is required");
  return Object.freeze({ mode, authorizedPaths: Object.freeze([...new Set(authorizedPaths)]), callerId });
}

export function deriveWorkerPermission(parent, { mode = parent.mode, authorizedPaths = parent.authorizedPaths, callerId } = {}) {
  parent = permissionContext(parent);
  const child = permissionContext({ mode, authorizedPaths, callerId });
  if (MODES.indexOf(child.mode) > MODES.indexOf(parent.mode)) throw new Error("Worker mode exceeds caller mode");
  if (child.authorizedPaths.some((item) => !parent.authorizedPaths.includes(item))) throw new Error("Worker scope exceeds caller scope");
  return child;
}

function resultBase({ permission, requestId, action }) {
  const { mode, authorizedPaths, callerId } = permissionContext(permission);
  const targets = action?.targets;
  return {
    schema: RESULT_SCHEMA,
    requestId,
    mode,
    callerId,
    scope: { authorizedPaths },
    action: { kind: action?.kind ?? null, targets: Array.isArray(targets) ? targets : [] },
  };
}

export function clarificationResult({ permission = permissionContext(), requestId = randomUUID(), question, options = [] }) {
  return {
    ...resultBase({ permission, requestId, action: { kind: "choose", targets: [] } }),
    outcome: "clarification_required",
    missing: [question],
    options,
  };
}

export function authorizePifyAction({ permission = permissionContext(), requestId = randomUUID(), action }) {
  const base = resultBase({ permission, requestId, action });
  const { mode, scope: { authorizedPaths } } = base;
  const targets = action?.targets;
  if (!action?.kind || !Array.isArray(targets) || targets.length === 0 || targets.some((item) => !exactPath(item))) {
    return { ...base, outcome: "clarification_required", missing: ["exact action targets"] };
  }
  if (authorizedPaths.length === 0) {
    return { ...base, outcome: "clarification_required", missing: ["explicit authorized scope"] };
  }
  const outside = targets.filter((item) => !authorizedPaths.includes(item));
  if (outside.length) {
    return {
      ...base,
      outcome: mode === "safe" ? "denied" : "approval_required",
      reason: "action target is outside caller scope",
      outside,
    };
  }
  return { ...base, outcome: "allowed" };
}

export function modeLabel(permission) {
  const { mode } = permissionContext(permission);
  return `Pify: ${mode[0].toUpperCase()}${mode.slice(1)}`;
}
