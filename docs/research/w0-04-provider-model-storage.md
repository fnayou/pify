# W0-04: Provider, model storage, and LM Studio sync feasibility

**Status:** research only. Pify remains a bootstrap project; this report proposes no released sync behavior.

## Findings

### Pi storage roles and model selection

Pi separates provider credentials, endpoint/model configuration, startup preferences, and session state:

| Data | Pi location | Role |
|---|---|---|
| Credentials | `<agent-dir>/auth.json` | Saved API keys and OAuth credentials. `/login` stores credentials here; provider environment variables are an alternative. Keep this file private. ([Providers](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/providers.md#L12-L18), [Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md#L17-L18)) |
| Compatible endpoints and model declarations | `<agent-dir>/models.json` | Configures provider IDs, API/base URL, model IDs, and optional configured metadata or overrides. An `apiKey` in this file is also a credential source, so treat the file as potentially secret-bearing. ([Models](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md#L45-L67), [Models Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models-configuration.md#L9-L57)) |
| Dynamic provider catalog store | `<agent-dir>/models-store.json` by default | Pi source calls this a JSON-backed store “for dynamically refreshed provider catalogs”; it reads/writes entries by provider ID. Source does not establish that this file is the selected default, `models.json`, or a live inventory from a local server. ([Pi `models-store.ts`](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/models-store.ts#L46-L52), [read/write](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/models-store.ts#L120-L135)) |
| Startup defaults | `<agent-dir>/settings.json` | `defaultProvider` and `defaultModel` are startup AI provider and model ID settings. `/model` `Ctrl+S` saves a selection as default for new sessions. ([Settings](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/settings.md#L12-L15), [Models](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md#L29)) |
| Active/resumed session model | Session record | A session records model changes; resume restores its recorded model without changing defaults for new sessions. Therefore runtime/session selection is not evidence of the persistent startup default. ([Models](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md#L35)) |

`<agent-dir>` defaults to `~/.pi/agent` and can be overridden with `PI_CODING_AGENT_DIR`. ([Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md#L4), [L10](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md#L10))

Pi’s models configuration schema permits fields including `reasoning`, `input`, `contextWindow`, `maxTokens`, and `cost`. Those fields describe declared configuration; their presence alone does not prove the remote endpoint honors them. ([Models Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models-configuration.md#L36-L53))

### Setup examples

**Local: LM Studio through OpenAI-compatible API.** Start LM Studio’s server from the Developer tab or with `lms server start`. The server page gives no port or base URL; the OpenAI-compatibility page uses `http://localhost:1234/v1` in its examples (assuming port 1234). Query `GET http://localhost:1234/v1/models` (documented as listing “the models visible to the server”; with Just-In-Time loading it may include all downloaded models, not only loaded ones), then use a returned model ID as the Pi model `id`. Pi lists LM Studio among servers configured as compatible endpoints in `models.json`. ([LM Studio server](https://lmstudio.ai/docs/developer/core/server), [OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat), [list models](https://lmstudio.ai/docs/developer/openai-compat/models), [Pi model configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md#L43-L47))

This example assumes LM Studio’s default, where API authentication is off: LM Studio “does not require authentication for API requests” by default. Users can turn on **Require Authentication** (API tokens) in Server Settings on the Developers page; once enabled, requests need a valid token, sent as `Authorization: Bearer <token>`. ([LM Studio authentication](https://lmstudio.ai/docs/developer/core/authentication))

Minimal Pi shape for default authentication-off (insert the exact ID returned by the local endpoint):

```json
{
  "providers": {
    "lmstudio": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions",
      "apiKey": "lm-studio",
      "models": [{ "id": "<ID_FROM_GET_V1_MODELS>" }]
    }
  }
}
```

Pi’s `models.json` provider and model fields support this shape; it mirrors Pi’s own Ollama example. Pi documents that, for that example, a dummy `apiKey` makes the model available to Pi. The `lm-studio` value is a placeholder for the default authentication-off setup, not a credential. If LM Studio authentication is enabled, a valid API token is required ([LM Studio authentication](https://lmstudio.ai/docs/developer/core/authentication)); this report has **not verified** how Pi sends an authenticated request to LM Studio (for example whether `apiKey` becomes the Bearer token), so that setup is out of scope here. ([Pi example](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md#L49-L65), [Models Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models-configuration.md#L9-L35))

The LM Studio pages cited do not document the `GET /v1/models` response body. The `id` field used above follows the OpenAI list-models convention and is **UNVERIFIED** against LM Studio docs; confirm it against a live response before use.

LM Studio documents a separate native `GET /api/v1/models` endpoint. It returns a `models` array whose entries have fields such as `type` (`llm`, `embedding`, or `decision`), `publisher`, `key`, `display_name`, quantization, `max_context_length`, and `capabilities`; this is distinct from OpenAI-compatible `GET /v1/models`. Because the list includes embedding models, entries are not all usable as chat models. Do not substitute one API’s response schema for the other. ([LM Studio REST API overview](https://lmstudio.ai/docs/developer/rest), [native list models](https://lmstudio.ai/docs/developer/rest/list))

**Cloud: Anthropic.** Run Pi `/login`, choose Anthropic, and follow its provider flow; Pi saves the resulting credential in `auth.json`. Alternatively, set `ANTHROPIC_API_KEY` before starting Pi. Do not put real credentials in project files or reports. ([Pi Providers](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/providers.md#L12-L27))

### Metadata evidence boundary

| Metadata | Verifiable source | Limit |
|---|---|---|
| OpenAI-compatible model ID | LM Studio `GET /v1/models` response | Establishes the server-returned ID, not behavior or capability. The LM Studio page documents the request only, not the response schema, so the ID field name is **UNVERIFIED**. ([LM Studio list models](https://lmstudio.ai/docs/developer/openai-compat/models)) |
| Native LM Studio inventory metadata | `GET /api/v1/models`: documented fields include type, publisher, key, display name, architecture, quantization, size, parameter string, loaded instances, max context, format, and capabilities (`vision`, `trained_for_tool_use`, `reasoning`). | Treat as endpoint-reported data, not independent testing. `architecture`, `capabilities`, and `description` are optional and absent for embedding models; `max_context_length` can be null. Missing optional fields are not proof of absence. ([LM Studio native list models](https://lmstudio.ai/docs/developer/rest/list)) |
| Pi model metadata | Bundled Pi catalog (which Pi can overlay with newer pi.dev data) or explicitly configured fields in `models.json`; the configuration schema defines allowed field names and meanings. | A manually configured value is a declaration, not proof of endpoint support. Omitted fields take schema defaults (`reasoning` false, `contextWindow` 128000, `maxTokens` 16384), which are not measurements. ([Pi models](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md#L15), [schema reference](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models-configuration.md#L36-L53)) |
| Capability inferred from an ID/name | **UNVERIFIED.** | Names such as “vision”, “reasoning”, or parameter-count suffixes are guesses unless backed by structured provider metadata or a documented test. No model behavior is established by its ID alone. |

### Proposed Pify ownership marker — not implemented

If Pify later writes managed model entries, attach explicit versioned ownership metadata to each managed provider/model configuration. Candidate shape:

```json
"_pify": {
  "schemaVersion": 1,
  "scope": "user-agent-models",
  "providerId": "lmstudio",
  "modelId": "exact-server-model-id",
  "configIdentity": "stable-hash-of-canonical-provider-and-model-config",
  "provenance": {
    "kind": "lm-studio-openai-model-list",
    "endpoint": "http://localhost:1234/v1",
    "observedAt": "<timestamp>"
  }
}
```

**Proposal:** Bind marker to exact provider/model config identity, ownership scope, marker schema version, and source provenance. Never infer Pify ownership from display name, model ID, or provider ID. Preserve user-owned entries. On collisions, hand edits, missing/invalid marker, or identity mismatch, skip automatic overwrite/delete and surface a conflict for review. A copied or forged marker cannot prove who made a change; detect drift by comparing the canonical config identity, and treat drift as unowned until reviewed. The exact field location and compatibility with Pi’s `models.json` schema are **UNVERIFIED** and require implementation-level validation before adoption.

## Feasibility boundary

The cited docs establish endpoint configuration and model-list APIs. They do not establish a Pi-to-LM-Studio sync contract, automatic refresh behavior, reliable capability parity, ownership semantics, or safe reconciliation rules. **UNVERIFIED:** no live server was queried for this report. Any sync design must verify observed endpoint data and preserve hand-edited or unmarked configuration.

## Sources

Pi links are pinned to v1.4.0. LM Studio links below are current documentation, accessed 2026-11-02.

- [Pi: Choose a Model](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md)
- [Pi: Providers](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/providers.md)
- [Pi: Models Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models-configuration.md)
- [Pi: Settings Reference](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/settings.md)
- [Pi: Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md)
- [Pi source: `models-store.ts`](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/models-store.ts)
- [LM Studio: OpenAI Compatibility Endpoints](https://lmstudio.ai/docs/developer/openai-compat)
- [LM Studio: OpenAI-compatible List Models](https://lmstudio.ai/docs/developer/openai-compat/models)
- [LM Studio: Server](https://lmstudio.ai/docs/developer/core/server)
- [LM Studio: Authentication](https://lmstudio.ai/docs/developer/core/authentication)
- [LM Studio: REST API overview](https://lmstudio.ai/docs/developer/rest)
- [LM Studio: Native List Models](https://lmstudio.ai/docs/developer/rest/list)
