# W0-06: memory trust and instruction-loading feasibility (issue #17)

Retrieved 2026-11-02 by reading the Pi v1.4.0 docs as raw files. This is source-based research. **No tests or runtime experiments were run**, and Pi was not installed. Pify is a bootstrap project; nothing here is implemented or released.

Labels used below:

- **Documented fact**: stated on a cited Pi v1.4.0 page.
- **Proposal**: a Pify design idea. It is not implemented or validated.
- **Unverified**: not stated by a source, or needs an owner check or a later experiment.

Requirements source: the approved Pify spec, [issue #2](https://github.com/fnayou/pify/issues/2), Memory decision (ROADMAP). It asks for an optional, empty, portable Markdown vault. Approval state stays local to each machine and outside synced memory content. Only reviewed content and scope may enter automatically applied preferences. Private sync stays separate and manual. It also says: never promise control over instructions Pi already loads natively without proof.

## 1. Pi native loading behavior (documented fact)

| Topic | Fact | Source |
|---|---|---|
| User context files | The agent dir (default `~/.pi/agent`) can hold `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` or `CLAUDE.MD`, applied across working directories. | [Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md) |
| Context discovery | Pi loads context files from the agent dir, the working directory and its parents. A file applies when Pi runs in its directory or anywhere below. `AGENTS.override.md` replaces `AGENTS.md`/`CLAUDE.md` only in the same directory. | [Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md) |
| Context vs trust | "Context-file discovery does not require project trust." `AGENTS.md`, `CLAUDE.md` and the override file load regardless of trust unless context loading is disabled. | [Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md), [Security](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md) |
| What trust protects | Trust gates `.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, and project `.agents/skills` in the cwd or an ancestor. A bare `.pi` directory does not need trust. | [Security](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md) |
| What trust does not do | Trust does not limit tool calls; tools still use the OS permissions of the Pi process. Folder content can still influence the model. Pi treats instructions in a folder as untrusted input even when trust is declined. | [Security](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md) |
| Trust is not a full startup boundary | The project `sessionDir` setting is read before trust is resolved. | [Security](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md) |
| Trust decision source | A command-line `--approve` or `--no-approve` override applies first. Otherwise: a `project_trust` handler in a user-level or CLI extension (first yes/no wins), then a saved decision for the directory or a parent (closest wins), then `defaultProjectTrust` (default `"ask"`; agent-dir settings only). In print/JSON/RPC modes, when no command-line override, extension decision or saved decision applies, `defaultProjectTrust` decides: `"always"` loads protected resources; `"ask"` and `"never"` skip them. | [Security](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md), [Settings](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/settings.md) |
| Skills at startup | Pi scans skill locations and adds each skill's name, description and path to the system prompt, not the full text. | [Skills](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/skills.md) |
| Skills on use | The model reads `SKILL.md` when a task matches; `/skill:name` forces loading. It can miss a relevant skill. | [Skills](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/skills.md) |
| Skill locations | User and project skills dirs, `~/.agents/skills/`, and project `.agents/skills/` from the cwd up to the repo root; directories with `SKILL.md` are found recursively. Where a skill sits decides whether it is discoverable. | [Skills](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/skills.md) |
| System prompt files | `<agent-dir>/SYSTEM.md` replaces and `APPEND_SYSTEM.md` adds to the system prompt. The project versions (`.pi/`) are trust-gated. | [Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md) |
| Extensions | An extension runs inside the Pi process with the same OS permissions and can inspect prompts, tool calls, files, credentials and session history. Project extensions load only after trust. | [Extensions](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md), [Security](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md) |

Limits of this table: it does not say how context files are merged, ordered or size-limited in the prompt, or whether a setting that disables context loading exists beyond the phrase in Security. All of that is **unverified**.

## 2. What this means for a Pify vault

- Pi's native loading is separate from any Pify memory activation. Pi loads what it finds by its own rules, whatever Pify thinks is approved.
- Vault files are not automatically loaded by Pi's documented discovery only if they sit where that discovery does not look: not in the agent dir as a context or system file, not in an ancestor or cwd context file, not under a skills location, not in a trusted `.pi` resource path. Files outside those paths can still be read by the user, by tools, or by extensions (which share the Pi process's OS permissions), so this is not isolation.
- A vault file placed or linked into any of those locations becomes native Pi input. Context files need no trust.
- A Pify approval record cannot stop Pi from loading existing instructions. It cannot stop other tools, other extensions, or manual edits and copies.
- Any claim of control over native loading needs proof. None exists in this report.

## 3. Proposal: local approval registry

**Proposal, not implemented, not validated.** The path and schema are a sketch for owner review.

- Location: `~/.config/pify/memory-approvals.json`.
- It must be outside any synced vault or repository and never committed, so that syncing or pulling memory cannot carry approvals.
- Scope and content are separate facts. Approving content does not approve a scope, and the reverse.
- The registry records approval state only. By itself it controls nothing in Pi. Only Pify code that reads it and does the activation (mechanism below) could use it.

Candidate record fields (all proposed and unverified; names and shapes are not settled):

| Field | Purpose |
|---|---|
| `schemaVersion` | Allow format changes. |
| `entryDigest` | Hash of the exact approved content. Detects content edits only. A digest alone cannot detect a move or a scope change. |
| `entryLocation` | Canonical vault-relative path of the entry. This is the approval binding that detects path moves. |
| `entryId` (optional) | Stable entry identity only. It does not detect a move unless `entryLocation` is also recorded. Whether to keep it is undecided. |
| `scope` | One of global, project, reference, inbox, as approved. |
| `projectId` | Project identity, required when `scope` is project, so approval for one project does not carry to another. Form undecided. |
| `source` / provenance | Where the entry came from (vault path, import, sync, suggestion). |
| `approver` | Local user identity. |
| `approvedAt` | Timestamp. |

Invalidation rules (proposal): a content edit invalidates the `entryDigest` match. Activation requires the entry's current path to match the recorded `entryLocation`; a move invalidates that binding. A scope change, or a change of project, invalidates the `scope`/`projectId` binding. Any single mismatch means the entry is not activated until re-reviewed.

This matches the spec's test intent: unapproved, modified, moved or newly synced content is not activated automatically. How an optional `entryId` would survive sync and rename is unverified.

## 4. Proposal: scope matrix

**Proposal.** The exact Pify activation mechanism is **unverified and not implemented**.

| Scope | Proposed loading behavior | Pi facts it depends on |
|---|---|---|
| Global | Vault content is not automatically loaded by Pi's documented discovery, and Pify does not activate it unless approved (users, tools and extensions can still read it). Approved user-level instructions placed in Pi's agent dir can apply broadly across every working directory, so activation must be explicit. | Agent-dir context files apply across working directories (Configuration). |
| Project | A project vault is not automatically loaded by Pi's documented discovery when outside Pi's resource and context paths (users, tools and extensions can still read it). Trusted `.pi` resources load after trust; project context files can load without trust. | Trust gates `.pi/*` and `.agents/skills`; context files are exempt (Security). |
| Reference | Read-only source material, loaded only when explicitly selected. Keep it outside discoverable instruction and resource paths. | Skill and context discovery is path-based (Skills, Configuration). |
| Inbox | Untrusted quarantine. Never auto-activate. Require review and explicit scope approval before promotion. | Folder content is untrusted input even without trust (Security). |

## 5. Can gate / cannot gate

**Can gate (Pify-owned behavior, proposal):**

- Whether Pify itself activates a vault entry into its own applied preferences.
- Whether an entry's digest and scope match a local approval before activation.
- Promotion of inbox entries and scope changes through review.
- Where Pify writes or links vault content, and refusing to write into native Pi instruction paths without explicit approval.
- Sync actions that Pify performs (explicit, manual; no auto-merge).

**Cannot gate (not controlled by a Pify registry):**

- Instructions Pi already loads natively: agent-dir and ancestor/cwd context files, system-prompt files.
- Context files in a folder, with or without project trust.
- Other tools, other extensions, other agents, or manual user edits that read or write the same files.
- Prompt injection and model influence from any file content.
- OS-level actions of the Pi process; project trust does not constrain them either.
- Trust decisions made by user-level extensions or settings outside Pify.

## 6. Open items for owner review

- Activation mechanism (unverified): how Pify applies approved entries without using a native Pi instruction path.
- Context-file merge order, size limits and the exact way to disable context loading (unverified).
- Whether to ever write approved global content into the agent dir (a native path), and with what disclosure.
- Registry file permissions, locking and corruption handling (unverified, not designed).

The owner reviews the boundary claims in sections 1, 2 and 5. This ticket is evidence gathering only.

## Sources (all pinned to Pi v1.4.0)

- Configuration: https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md
- Security / project trust: https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md
- Skills: https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/skills.md
- Extensions: https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md
- Settings: https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/settings.md
- Pify spec (requirements): https://github.com/fnayou/pify/issues/2
