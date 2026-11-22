import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { SEARCH_LIMITS, SearxngSearch, searchEndpoint, searchLimits } from "../src/searxng-search.mjs";

const requests = [];
let handler = (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ results: [] })); };
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
  handler(req, res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());
const endpoint = `http://127.0.0.1:${server.address().port}`;

function mock(status, body, headers = {}) {
  handler = (_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
}

test("explicit endpoint, exact approved POST, bounded candidate provenance and duplicate filtering", async () => {
  requests.length = 0;
  mock(200, { results: [
    { url: "https://example.org/a", title: "A", content: "source candidate", engines: ["general"] },
    { url: "https://example.org/a#fragment", title: "duplicate" },
    { url: "http://127.0.0.1/private", title: "unsafe" },
    { url: "https://example.org/b", title: "B", engine: "other" },
  ], unresponsive_engines: [["engine-x", "timeout"]] });
  const search = new SearxngSearch({ endpoint, token: "mock-secret" });
  assert.equal((await search.search({ query: "public topic" })).status, "approval_required");
  assert.equal(requests.length, 0);
  const result = await search.search({ query: "public topic", approved: true });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.candidates.map((item) => item.url), ["https://example.org/a", "https://example.org/b"]);
  assert.equal(result.candidates[0].query, "public topic");
  assert.equal(result.candidates[0].provider, "searxng");
  assert.match(result.candidates[0].retrievedAt, /^\d{4}-/);
  assert.deepEqual(result.warnings, ["engine-x: timeout", "2 unsafe or duplicate result(s) discarded"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/search");
  assert.equal(requests[0].body, "q=public+topic&format=json");
  assert.equal(requests[0].headers.authorization, "Bearer mock-secret");
  assert.ok(!JSON.stringify(result).includes("mock-secret"));
});

test("off, invalid endpoint, and engine bang make no request", async () => {
  requests.length = 0;
  assert.equal((await new SearxngSearch().search({ query: "public", approved: true })).status, "disabled");
  assert.equal((await new SearxngSearch({ endpoint: "http://example.org" }).search({ query: "public", approved: true })).status, "invalid_configuration");
  assert.equal((await new SearxngSearch({ endpoint }).search({ query: "public !google", approved: true })).status, "query_review_required");
  assert.equal(requests.length, 0);
  assert.throws(() => searchEndpoint("https://user:pass@example.org"));
  assert.throws(() => searchEndpoint("https://example.org/../private"));
  assert.equal((await new SearxngSearch({ endpoint }).search({ query: "a\nb", approved: true })).status, "invalid_query");
});

test("empty and engine failure stay distinct", async () => {
  const search = new SearxngSearch({ endpoint });
  mock(200, { results: [] });
  assert.equal((await search.search({ query: "a", approved: true })).status, "empty");
  mock(200, { results: [], unresponsive_engines: [["engine", "blocked"]] });
  assert.equal((await search.search({ query: "b", approved: true })).status, "engine_failure");
});

test("unsafe-only results are not reported as a clean empty search", async () => {
  mock(200, { results: [{ url: "http://192.168.1.5/private", title: "private" }] });
  const result = await new SearxngSearch({ endpoint }).search({ query: "public", approved: true });
  assert.equal(result.status, "invalid_results");
  assert.equal(result.candidates.length, 0);
});

test("operator can lower limits but never raise caps", async () => {
  assert.throws(() => searchLimits({ queries: 4 }));
  mock(200, { results: [{ url: "https://example.org/a" }, { url: "https://example.org/b" }] });
  const search = new SearxngSearch({ endpoint, limits: { queries: 1, candidates: 1 } });
  assert.equal((await search.search({ query: "a", approved: true })).candidates.length, 1);
  assert.equal((await search.search({ query: "b", approved: true })).status, "budget_exhausted");
});

test("HTTP failures, redirect block, and failed-attempt budget", async () => {
  const search = new SearxngSearch({ endpoint });
  mock(403, {});
  assert.equal((await search.search({ query: "a", approved: true })).status, "forbidden");
  mock(429, {}, { "Retry-After": "17" });
  const limited = await search.search({ query: "b", approved: true });
  assert.equal(limited.status, "rate_limited");
  assert.equal(limited.retryAfterSeconds, 17);
  mock(302, {}, { Location: "https://other.example/search" });
  assert.equal((await search.search({ query: "c", approved: true })).status, "redirect_blocked");
  assert.equal((await search.search({ query: "d", approved: true })).status, "budget_exhausted");
  assert.equal(SEARCH_LIMITS.queries, 3);
});

test("malformed, non-JSON, server, and oversized responses fail explicitly", async () => {
  mock(200, "<html/>", { "Content-Type": "text/html" });
  assert.equal((await new SearxngSearch({ endpoint }).search({ query: "a", approved: true })).status, "non_json_response");
  mock(200, "{broken");
  assert.equal((await new SearxngSearch({ endpoint }).search({ query: "a", approved: true })).status, "malformed_response");
  mock(500, {});
  assert.equal((await new SearxngSearch({ endpoint }).search({ query: "a", approved: true })).status, "server_error");
  mock(200, { results: [], padding: "x".repeat(SEARCH_LIMITS.responseBytes) });
  assert.equal((await new SearxngSearch({ endpoint }).search({ query: "a", approved: true })).status, "response_too_large");
});

test("cancellation and TLS errors have explicit states", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal((await new SearxngSearch({ endpoint }).search({ query: "a", approved: true, signal: controller.signal })).status, "cancelled");
  const error = new TypeError("fetch failed", { cause: new Error("certificate verification failed") });
  const search = new SearxngSearch({ endpoint, fetcher: async () => { throw error; } });
  assert.equal((await search.search({ query: "a", approved: true })).status, "tls_error");
});

test("timeout and concurrent calls do not escape the attempt budget", async () => {
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const search = new SearxngSearch({ endpoint, limits: { timeoutMs: 5, queries: 1 },
    fetcher: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      stalled.then(() => reject(new Error("released")));
    }) });
  const first = search.search({ query: "a", approved: true });
  assert.equal((await search.search({ query: "b", approved: true })).status, "busy");
  assert.equal((await first).status, "timeout");
  release();
  assert.equal((await search.search({ query: "c", approved: true })).status, "budget_exhausted");
});
