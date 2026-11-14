import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fetchLmStudioInventory } from "../src/lmstudio-inventory.mjs";
import { applyModelSync, MODEL_SYNC_TARGETS, prepareModelSync } from "../src/model-sync.mjs";
import { permissionContext } from "../src/permissions.mjs";

const BASE = "http://127.0.0.1:1234/v1";
const permission = permissionContext({ authorizedPaths: MODEL_SYNC_TARGETS, callerId: "fixture-user" });

async function fixture(t, { models = [], userDefault, projectDefault, provider = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pify-model-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const projectDir = path.join(root, "project");
  await fs.mkdir(agentDir);
  await fs.mkdir(path.join(projectDir, ".pi"), { recursive: true });
  const config = {
    providers: {
      lmstudio: { baseUrl: BASE, api: "openai-completions", apiKey: "dummy-key", models, ...provider },
      unrelated: { baseUrl: "https://other.example/v1", apiKey: "PRIVATE_UNRELATED_KEY", models: [{ id: "other" }] },
    },
  };
  const modelsPath = path.join(agentDir, "models.json");
  const settingsPath = path.join(agentDir, "settings.json");
  const projectSettingsPath = path.join(projectDir, ".pi", "settings.json");
  await fs.writeFile(modelsPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(settingsPath, `${JSON.stringify(userDefault ?? { defaultProvider: "unrelated", defaultModel: "other" })}\n`, { mode: 0o600 });
  if (projectDefault) await fs.writeFile(projectSettingsPath, `${JSON.stringify(projectDefault)}\n`, { mode: 0o600 });
  return { agentDir, projectDir, modelsPath, settingsPath, projectSettingsPath, config };
}

function mockInventory({ compatible = [], native = [], status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const body = url.endsWith("/api/v1/models") ? { models: native } : { data: compatible.map((id) => ({ id })) };
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

async function plan(fixtureValue, fetchImpl, projectTrusted = true) {
  return prepareModelSync({ agentDir: fixtureValue.agentDir, projectDir: fixtureValue.projectDir, projectTrusted, fetchImpl });
}

test("preview reads only; apply keeps a reviewed manual entry and owns only new exact matches", async (t) => {
  const f = await fixture(t, { models: [{ id: "manual", name: "User name" }],
    projectDefault: { defaultProvider: "lmstudio", defaultModel: "manual" } });
  const mock = mockInventory({ compatible: ["manual", "new", "embedding", "unmatched"], native: [
    { key: "manual", type: "llm", display_name: "Server manual" },
    { key: "new", type: "llm", display_name: "New model" },
    { key: "embedding", type: "embedding" },
  ] });
  const beforeModels = await fs.readFile(f.modelsPath);
  const beforeSettings = await fs.readFile(f.settingsPath);
  const beforeProject = await fs.readFile(f.projectSettingsPath);
  const prepared = await plan(f, mock.fetchImpl);
  assert.equal(prepared.report.added.count, 1);
  assert.equal(prepared.report.ambiguous.count, 1);
  assert.deepEqual(prepared.report.unmatchedCompatible.sample, ["embedding", "unmatched"]);
  assert.deepEqual(await fs.readFile(f.modelsPath), beforeModels);
  await assert.rejects(fs.stat(path.join(f.agentDir, "pify-state")), { code: "ENOENT" });
  assert.equal((await applyModelSync(prepared, { permission: permissionContext() })).outcome, "clarification_required");
  assert.equal((await applyModelSync(prepared, { permission })).status, "clarification_required");
  assert.deepEqual(await fs.readFile(f.modelsPath), beforeModels);

  const applied = await applyModelSync(prepared, { permission, review: { id: "manual", decision: "keep" } });
  assert.equal(applied.status, "synced");
  assert.equal(applied.ambiguous.count, 0);
  const after = JSON.parse(await fs.readFile(f.modelsPath, "utf8"));
  assert.deepEqual(after.providers.lmstudio.models, [{ id: "manual", name: "User name" }, { id: "new", name: "New model" }]);
  assert.deepEqual(after.providers.unrelated, f.config.providers.unrelated);
  assert.deepEqual(await fs.readFile(f.settingsPath), beforeSettings);
  assert.deepEqual(await fs.readFile(f.projectSettingsPath), beforeProject);
  const sidecarPath = path.join(f.agentDir, "pify-state", "model-sync.json");
  const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
  assert.deepEqual(sidecar.owned.map((item) => item.id), ["new"]);
  assert.deepEqual(sidecar.reviewedManual.map((item) => item.id), ["manual"]);
  assert.equal(JSON.stringify(sidecar).includes("PRIVATE_UNRELATED_KEY"), false);
  assert.equal((await fs.stat(sidecarPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(sidecarPath))).mode & 0o777, 0o700);
  const repeated = await plan(f, mock.fetchImpl);
  assert.equal(repeated.report.ambiguous.count, 0);
  assert.equal((await applyModelSync(repeated, { permission })).status, "already_current");
  assert.equal(mock.calls.length, 4);
  assert.deepEqual(mock.calls.map((call) => call.url), [
    `${BASE}/models`, "http://127.0.0.1:1234/api/v1/models", `${BASE}/models`, "http://127.0.0.1:1234/api/v1/models",
  ]);
  assert.ok(mock.calls.every((call) => call.options.redirect === "error" && !call.options.headers.Authorization));
});

test("owned entries update, stale entries retire, drift and saved defaults remain untouched", async (t) => {
  const f = await fixture(t);
  const first = mockInventory({ compatible: ["owned"], native: [{ key: "owned", type: "llm", display_name: "First" }] });
  await applyModelSync(await plan(f, first.fetchImpl), { permission });
  const updated = mockInventory({ compatible: ["owned"], native: [{ key: "owned", type: "llm", display_name: "Second" }] });
  const updatePlan = await plan(f, updated.fetchImpl);
  assert.deepEqual(updatePlan.report.updated.sample, ["owned"]);
  await applyModelSync(updatePlan, { permission });
  let config = JSON.parse(await fs.readFile(f.modelsPath, "utf8"));
  assert.deepEqual(config.providers.lmstudio.models, [{ id: "owned", name: "Second" }]);

  await fs.writeFile(f.settingsPath, JSON.stringify({ defaultProvider: "lmstudio", defaultModel: "owned" }));
  const empty = mockInventory({ compatible: [], native: [] });
  const protectedPlan = await plan(f, empty.fetchImpl);
  assert.equal(protectedPlan.report.removed.count, 0);
  assert.match(protectedPlan.report.conflicts[0].reason, /selected default/);
  await applyModelSync(protectedPlan, { permission });
  config = JSON.parse(await fs.readFile(f.modelsPath, "utf8"));
  assert.deepEqual(config.providers.lmstudio.models, [{ id: "owned", name: "Second" }]);

  await fs.writeFile(f.settingsPath, JSON.stringify({ defaultModel: "owned" }));
  assert.equal((await plan(f, empty.fetchImpl)).report.removed.count, 0);

  await fs.writeFile(f.settingsPath, JSON.stringify({ defaultProvider: "unrelated", defaultModel: "other" }));
  const removal = await plan(f, empty.fetchImpl);
  assert.deepEqual(removal.report.removed.sample, ["owned"]);
  await applyModelSync(removal, { permission });
  config = JSON.parse(await fs.readFile(f.modelsPath, "utf8"));
  assert.deepEqual(config.providers.lmstudio.models, []);
  assert.deepEqual(config.providers.unrelated, f.config.providers.unrelated);

  await applyModelSync(await plan(f, first.fetchImpl), { permission });
  config = JSON.parse(await fs.readFile(f.modelsPath, "utf8"));
  config.providers.lmstudio.models[0].name = "Hand edit";
  await fs.writeFile(f.modelsPath, JSON.stringify(config));
  const drift = await plan(f, updated.fetchImpl);
  assert.equal(drift.report.updated.count, 0);
  assert.match(drift.report.conflicts[0].reason, /outside Pify/);
  await applyModelSync(drift, { permission });
  assert.equal(JSON.parse(await fs.readFile(f.modelsPath, "utf8")).providers.lmstudio.models[0].name, "Hand edit");
});

test("forced mid-commit failure restores prior bytes; changed settings block stale plans", async (t) => {
  const f = await fixture(t);
  const mock = mockInventory({ compatible: ["one"], native: [{ key: "one", type: "llm", display_name: "One" }] });
  const prepared = await plan(f, mock.fetchImpl);
  const before = await fs.readFile(f.modelsPath);
  await assert.rejects(applyModelSync(prepared, { permission, afterModelsWrite: () => { throw new Error("forced failure"); } }), /forced failure/);
  assert.deepEqual(await fs.readFile(f.modelsPath), before);
  const state = JSON.parse(await fs.readFile(path.join(f.agentDir, "pify-state", "model-sync.json"), "utf8"));
  assert.equal(state.pending, undefined);
  assert.deepEqual(state.owned, []);
  const retry = await plan(f, mock.fetchImpl);
  assert.equal((await applyModelSync(retry, { permission })).status, "synced");
  assert.equal((await plan(f, mock.fetchImpl)).report.added.count, 0);

  const changed = mockInventory({ compatible: ["one", "two"], native: [
    { key: "one", type: "llm" }, { key: "two", type: "llm" },
  ] });
  const stale = await plan(f, changed.fetchImpl);
  await fs.writeFile(f.settingsPath, JSON.stringify({ defaultProvider: "lmstudio", defaultModel: "one" }));
  await assert.rejects(applyModelSync(stale, { permission }), /changed after preview/);
  assert.equal(JSON.parse(await fs.readFile(f.modelsPath, "utf8")).providers.lmstudio.models.length, 1);
});

test("interrupted commit reports recovery and preserves concurrent edits", async (t) => {
  const f = await fixture(t);
  const mock = mockInventory({ compatible: ["one"], native: [{ key: "one", type: "llm" }] });
  const before = await fs.readFile(f.modelsPath);
  let proposed;
  await assert.rejects(applyModelSync(await plan(f, mock.fetchImpl), { permission, afterModelsWrite: async () => {
    proposed = await fs.readFile(f.modelsPath);
    await fs.writeFile(f.modelsPath, JSON.stringify({ providers: { ...f.config.providers, lmstudio: { ...f.config.providers.lmstudio, models: [{ id: "user-edit" }] } } }));
    throw new Error("interrupted after concurrent edit");
  } }), /requires recovery/);
  const pending = JSON.parse(await fs.readFile(path.join(f.agentDir, "pify-state", "model-sync.json"), "utf8"));
  assert.ok(pending.pending);
  assert.equal((await plan(f, mock.fetchImpl)).report.status, "recovery_required");
  await assert.rejects(applyModelSync(await plan(f, mock.fetchImpl), { permission }), /manual recovery required/);
  assert.equal(JSON.parse(await fs.readFile(f.modelsPath, "utf8")).providers.lmstudio.models[0].id, "user-edit");
  await fs.writeFile(f.modelsPath, proposed);
  const recovered = await applyModelSync(await plan(f, mock.fetchImpl), { permission });
  assert.equal(recovered.status, "recovered");
  assert.deepEqual(await fs.readFile(f.modelsPath), before);
  assert.equal((await plan(f, mock.fetchImpl)).report.status, "preview");
});

test("trusted project default protects removal; untrusted settings are not read", async (t) => {
  const f = await fixture(t, { projectDefault: { defaultProvider: "lmstudio", defaultModel: "owned" } });
  const listed = mockInventory({ compatible: ["owned"], native: [{ key: "owned", type: "llm" }] });
  await applyModelSync(await plan(f, listed.fetchImpl), { permission });
  const empty = mockInventory({ compatible: [], native: [] });
  assert.equal((await plan(f, empty.fetchImpl)).report.removed.count, 0);
  assert.equal((await plan(f, empty.fetchImpl, false)).report.removed.count, 1);
  await fs.rm(f.projectSettingsPath);
  await fs.symlink(path.join(f.agentDir, "models.json"), f.projectSettingsPath);
  assert.equal((await plan(f, empty.fetchImpl, false)).report.removed.count, 1);
  await assert.rejects(plan(f, empty.fetchImpl, true), /ELOOP|Unsafe/);
});

test("bounded authenticated requests reject non-loopback, malformed, and mismatched lists", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith("/api/v1/models") ?
      { models: [{ key: "different", type: "llm", display_name: "Different" }] } : { data: [{ id: "requested" }] }));
  };
  const provider = { baseUrl: BASE, api: "openai-completions", apiKey: "$FAKE_TOKEN", authHeader: true };
  const inventory = await fetchLmStudioInventory({ provider, fetchImpl, env: { FAKE_TOKEN: "test-token" } });
  assert.deepEqual(inventory.models, []);
  assert.deepEqual(inventory.unmatchedIds, ["requested"]);
  assert.ok(calls.every((call) => call.options.headers.Authorization === "Bearer test-token"));
  await assert.rejects(fetchLmStudioInventory({ provider: { ...provider, baseUrl: "http://remote.example/v1" }, fetchImpl }), /loopback/);
  await assert.rejects(fetchLmStudioInventory({ provider: { ...provider, apiKey: "!echo secret" }, fetchImpl }), /literal or environment-backed/);
  await assert.rejects(fetchLmStudioInventory({ provider, fetchImpl: async () => new Response("bad json"), env: { FAKE_TOKEN: "test-token" } }), /not valid JSON/);
  await assert.rejects(fetchLmStudioInventory({ provider, fetchImpl: async () => new Response("denied", { status: 401 }), env: { FAKE_TOKEN: "test-token" } }), /HTTP 401/);
  await assert.rejects(fetchLmStudioInventory({ provider, fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1)), env: { FAKE_TOKEN: "test-token" } }), /response limit/);
});
