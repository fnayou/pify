import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { searchLocal } from "../src/search.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pify-search-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const outside = path.join(root, "outside-mount");
  await Promise.all([fs.mkdir(project), fs.mkdir(outside)]);
  await fs.writeFile(path.join(project, "alpha.txt"), "warning: alpha\nstructured {\"ok\":true}\n");
  await fs.writeFile(path.join(project, "beta.txt"), "warning: beta\n");
  await fs.writeFile(path.join(outside, "remote.txt"), "warning: remote\n");
  await fs.symlink(outside, path.join(project, "linked-mount"));
  return { project, outside };
}

test("filename and content search stay inside a named scope and skip linked mounts", async (t) => {
  const { project, outside } = await fixture(t);
  const names = await searchLocal({ cwd: project, mode: "filename", query: ".txt" });
  assert.deepEqual(names.results.map((item) => item.path).sort(), ["alpha.txt", "beta.txt"]);
  assert.equal(names.partial, false);
  const content = await searchLocal({ cwd: project, mode: "content", query: "warning:" });
  assert.deepEqual(content.results.map((item) => [item.path, item.line, item.text]).sort(), [
    ["alpha.txt", 1, "warning: alpha"], ["beta.txt", 1, "warning: beta"],
  ]);
  const namedMount = await searchLocal({ cwd: project, scope: outside, mode: "content", query: "warning:" });
  assert.deepEqual(namedMount.results.map((item) => item.path), ["remote.txt"]);
  await assert.rejects(searchLocal({ cwd: project, scope: "linked-mount", mode: "filename", query: ".txt" }), /real directory/);
});

test("result, deadline, and output limits report partial results", async (t) => {
  const { project } = await fixture(t);
  await Promise.all(Array.from({ length: 64 }, (_, index) => fs.writeFile(path.join(project, `bulk-${index}.log`), "large directory fixture\n")));
  const names = await searchLocal({ cwd: project, mode: "filename", query: ".log", limit: 5 });
  assert.equal(names.results.length, 5);
  assert.equal(names.limitReached, true);
  const limited = await searchLocal({ cwd: project, mode: "content", query: "warning:", limit: 1 });
  assert.equal(limited.results.length, 1);
  assert.equal(limited.limitReached, true);
  assert.equal(limited.partial, true);

  const slow = path.join(project, "slow-rg");
  await fs.writeFile(slow, "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
  const timed = await searchLocal({ cwd: project, mode: "filename", query: "x", timeoutMs: 20, rgPath: slow });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.partial, true);

  await fs.writeFile(path.join(project, "huge.txt"), `needle${"x".repeat(140_000)}\n`);
  const oversized = await searchLocal({ cwd: project, mode: "content", query: "needle" });
  assert.equal(oversized.outputLimitReached, true);
  assert.equal(oversized.partial, true);
  await assert.rejects(searchLocal({ cwd: project, mode: "content", query: "x", limit: 201 }), /limit must/);
});
