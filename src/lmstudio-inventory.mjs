const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS = 500;

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
}

export function lmStudioBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("LM Studio baseUrl must be an absolute URL"); }
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") {
    throw new Error("LM Studio baseUrl must be a loopback HTTP(S) URL ending in /v1, without credentials or query");
  }
  return `${url.origin}/v1`;
}

function tokenFor(provider, env) {
  if (provider.authHeader !== true) return null;
  const value = provider.apiKey;
  if (typeof value !== "string" || !value || value.startsWith("!")) throw new Error("LM Studio sync needs a literal or environment-backed API token");
  if (!value.startsWith("$")) return value;
  const name = value.slice(1);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !env[name]) throw new Error("LM Studio API token environment variable is unavailable");
  return env[name];
}

async function getJson(url, headers, fetchImpl) {
  const response = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`LM Studio model list returned HTTP ${response.status}`);
  if (!response.body) throw new Error("LM Studio model list returned no body");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new Error("LM Studio model list exceeds 1 MiB response limit");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("LM Studio model list is not valid JSON"); }
}

/** Reconcile only IDs observed in both compatible and native LLM lists. */
export async function fetchLmStudioInventory({ provider, fetchImpl = fetch, env = process.env }) {
  const baseUrl = lmStudioBaseUrl(provider.baseUrl);
  if (provider.api !== "openai-completions") throw new Error("LM Studio provider must use openai-completions");
  const token = tokenFor(provider, env);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const compatible = await getJson(`${baseUrl}/models`, headers, fetchImpl);
  const native = await getJson(`${new URL(baseUrl).origin}/api/v1/models`, headers, fetchImpl);
  if (!Array.isArray(compatible?.data) || !Array.isArray(native?.models) ||
      compatible.data.length > MAX_MODELS || native.models.length > MAX_MODELS) {
    throw new Error("LM Studio model list has an unsupported response shape or count");
  }
  const compatibleIds = new Set();
  for (const item of compatible.data) {
    if (!validId(item?.id) || compatibleIds.has(item.id)) throw new Error("LM Studio compatible model IDs are invalid or repeated");
    compatibleIds.add(item.id);
  }
  const nativeByKey = new Map();
  for (const item of native.models) {
    if (!validId(item?.key) || !["llm", "embedding", "decision"].includes(item.type) || nativeByKey.has(item.key)) {
      throw new Error("LM Studio native model keys or types are invalid or repeated");
    }
    nativeByKey.set(item.key, item);
  }
  const models = [];
  const unmatchedIds = [];
  for (const id of compatibleIds) {
    const item = nativeByKey.get(id);
    if (!item || item.type !== "llm") { unmatchedIds.push(id); continue; }
    const model = { id };
    if (typeof item.display_name === "string" && item.display_name.trim() && item.display_name.length <= 160 &&
        !/[\x00-\x1f]/.test(item.display_name)) {
      model.name = item.display_name;
    }
    models.push(model);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { baseUrl, models, unmatchedIds: unmatchedIds.sort() };
}
