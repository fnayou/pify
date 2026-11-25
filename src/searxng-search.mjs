import { isIP } from "node:net";

export const SEARCH_LIMITS = Object.freeze({ queries: 3, candidates: 5, timeoutMs: 10_000, responseBytes: 256 * 1024 });
const SCHEMA = "pify.searxng-search/v1";

export function searchLimits(input = {}) {
  const limits = {};
  for (const key of Object.keys(SEARCH_LIMITS)) {
    const value = input[key] ?? SEARCH_LIMITS[key];
    if (!Number.isInteger(value) || value < 1 || value > SEARCH_LIMITS[key]) throw new Error(`Invalid SearXNG ${key} limit`);
    limits[key] = value;
  }
  return Object.freeze(limits);
}

function failure(status, extra = {}) {
  return { schema: SCHEMA, provider: "searxng", status, candidates: [], warnings: [], ...extra };
}

function loopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

export function searchEndpoint(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("SearXNG endpoint is required");
  if (/[\x00-\x1f\x7f]|(^|\/)\.{1,2}(\/|$)|%2f|%5c|%2e/i.test(value)) throw new Error("Invalid SearXNG endpoint path");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid SearXNG endpoint"); }
  if (url.username || url.password || url.search || url.hash || !url.hostname ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname)))) {
    throw new Error("SearXNG endpoint must be HTTPS or explicit loopback HTTP, without credentials, query, or fragment");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`;
  return url;
}

function publicUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || !host.includes(".") || /\.(local|internal|localhost|test|invalid)$/.test(host)) return null;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)) ||
        (a === 100 && b >= 64 && b <= 127)) return null;
  }
  if (isIP(host.replace(/^\[|\]$/g, "")) === 6) return null;
  url.hash = "";
  return url.href;
}

function text(value, max) {
  return typeof value === "string" ? value.slice(0, max).replace(/[\x00-\x1f\x7f]/g, " ") : "";
}

function engineWarnings(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((item) => {
    if (Array.isArray(item)) return item.slice(0, 2).map((part) => text(part, 120)).join(": ");
    return text(item, 120);
  }).filter(Boolean);
}

function candidates(body, query, retrievedAt, maxCandidates) {
  if (!body || typeof body !== "object" || !Array.isArray(body.results)) return null;
  const seen = new Set();
  const found = [];
  let discarded = 0;
  for (const item of body.results) {
    if (!item || typeof item !== "object") { discarded += 1; continue; }
    const url = publicUrl(item.url);
    if (!url || seen.has(url)) { discarded += 1; continue; }
    seen.add(url);
    found.push({ provider: "searxng", query, retrievedAt, url,
      title: text(item.title, 200), snippet: text(item.content, 500),
      engines: Array.isArray(item.engines) ? item.engines.slice(0, 5).map((engine) => text(engine, 80)).filter(Boolean)
        : typeof item.engine === "string" ? [text(item.engine, 80)] : [],
      publishedAt: typeof item.publishedDate === "string" ? text(item.publishedDate, 40) : null });
    if (found.length === maxCandidates) break;
  }
  return { found, discarded };
}

async function boundedBody(response, signal, maxBytes) {
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("Cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new RangeError("Response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export class SearxngSearch {
  #attempts = 0;
  #active = false;

  constructor({ endpoint, token = "", fetcher = fetch, limits = {} } = {}) {
    this.endpoint = endpoint;
    this.token = token;
    this.fetcher = fetcher;
    this.limits = searchLimits(limits);
  }

  async search({ query, approved = false, signal } = {}) {
    if (!this.endpoint) return failure("disabled");
    if (typeof query !== "string" || !query.trim() || query.length > 512 || /[\x00-\x1f\x7f]/.test(query)) return failure("invalid_query");
    if (/(^|\s)!\S/.test(query)) return failure("query_review_required", { reason: "SearXNG bang syntax can change engines" });
    if (!approved) return failure("approval_required");
    if (this.#active) return failure("busy");
    if (this.#attempts >= this.limits.queries) return failure("budget_exhausted");
    let url;
    try { url = searchEndpoint(this.endpoint); } catch { return failure("invalid_configuration"); }
    if (this.token && (typeof this.token !== "string" || /[\r\n]/.test(this.token))) return failure("invalid_configuration");
    this.#attempts += 1;
    this.#active = true;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), this.limits.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method: "POST", redirect: "manual", signal: controller.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: new URLSearchParams({ q: query, format: "json" }).toString(),
      });
      if (response.status >= 300 && response.status < 400) return failure("redirect_blocked");
      if (response.status === 403) return failure("forbidden");
      if (response.status === 429) {
        const raw = response.headers.get("retry-after");
        const seconds = raw && /^\d+$/.test(raw) ? Math.min(Number(raw), 3600) : null;
        return failure("rate_limited", { retryAfterSeconds: seconds });
      }
      if (response.status >= 500) return failure("server_error", { httpStatus: response.status });
      if (!response.ok) return failure("http_error", { httpStatus: response.status });
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) return failure("non_json_response");
      const raw = await boundedBody(response, controller.signal, this.limits.responseBytes);
      let body;
      try { body = JSON.parse(raw); } catch { return failure("malformed_response"); }
      const retrievedAt = new Date().toISOString();
      const normalized = candidates(body, query, retrievedAt, this.limits.candidates);
      if (!normalized) return failure("malformed_response");
      const { found, discarded } = normalized;
      const warnings = engineWarnings(body.unresponsive_engines);
      const engineFailed = warnings.length > 0;
      if (discarded) warnings.push(`${discarded} unsafe or duplicate result(s) discarded`);
      return { schema: SCHEMA, provider: "searxng",
        status: warnings.length ? found.length ? "partial" : engineFailed ? "engine_failure" : "invalid_results" : found.length ? "complete" : "empty",
        candidates: found, warnings };
    } catch (error) {
      if (signal?.aborted) return failure("cancelled");
      if (controller.signal.aborted) return failure("timeout");
      if (error instanceof RangeError) return failure("response_too_large");
      if (error instanceof TypeError && /certificate|tls|ssl/i.test(String(error.cause?.message ?? error.message))) return failure("tls_error");
      return failure("unavailable");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      this.#active = false;
    }
  }
}
