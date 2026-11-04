import assert from "node:assert/strict";
import test from "node:test";

import { requestChoice } from "../src/choices.mjs";
import { permissionContext } from "../src/permissions.mjs";

const permission = permissionContext({ mode: "balanced", callerId: "fixture" });
const request = { question: "Which environment?", options: ["staging", "production"], permission };

test("interactive choice shows the supplied options and records the selected value", async () => {
  const calls = [];
  const result = await requestChoice({ ...request, select: async (title, options) => {
    calls.push({ title, options });
    return "staging";
  } });
  assert.deepEqual(calls, [{ title: request.question, options: request.options }]);
  assert.deepEqual([result.schema, result.outcome, result.selection], ["pify.permission-result/v1", "allowed", "staging"]);
  assert.deepEqual(result.action, { kind: "choose", targets: [] });
  assert.deepEqual(result.missing, []);
});

test("headless and cancelled choices return structured clarification without a prompt", async () => {
  const headless = await requestChoice(request);
  assert.equal(headless.outcome, "clarification_required");
  assert.deepEqual(headless.missing, [request.question]);
  assert.deepEqual(headless.options, request.options);
  assert.equal(headless.mode, "balanced");
  assert.deepEqual(headless.scope, { authorizedPaths: [] });
  const cancelled = await requestChoice({ ...request, select: async () => undefined });
  assert.equal(cancelled.outcome, "clarification_required");
  assert.equal(cancelled.reason, "Selection cancelled");
});
