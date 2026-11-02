# W0-02: permission and headless enforcement feasibility

Status: bootstrap research for [issue #13](https://github.com/fnayou/pify/issues/13), reviewed against [spec #2](https://github.com/fnayou/pify/issues/2). Pify is a bootstrap project. Nothing here is implemented or released.

**Safe, Balanced and Full are Pify policy proposals. They are not Pi-native modes.** Pi 1.4.0 has no Safe/Balanced/Full setting. Pify behavior described below does not exist yet; it states what a future Pify could and could not promise.

## Evidence labels

- **Documented**: stated in the tagged Pi 1.4.0 docs listed under Sources. Not exercised here.
- **Observed**: from the read-only runs already recorded in [`pi-1.4.0-contract.md`](pi-1.4.0-contract.md) ([issue #12](https://github.com/fnayou/pify/issues/12) evidence report). Reused, not rerun.
- **Proposed**: a Pify design position for owner review.
- **Unverified**: not shown either way.

No new experiment was run for this report. No package was installed, no Pi configuration changed, no model called, no network used.

## Sources

Pinned to the `v1.4.0` tag of the official repository:

- [Security](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md)
- [CLI](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/cli.md)
- [RPC](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/rpc.md)
- [Extensions](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md)

Pify: [spec #2](https://github.com/fnayou/pify/issues/2) (permission decisions), [issue #12](https://github.com/fnayou/pify/issues/12) (Pi contract evidence), [issue #13](https://github.com/fnayou/pify/issues/13) (this task).

## 1. What Pi provides

| Fact | Label | Source |
|---|---|---|
| Pi reads, changes and executes with the starting OS account's permissions. It does not ask before every tool call. | Documented | Security |
| Extensions, package installers, language servers and child processes run with the same permissions unless an OS or virtualization boundary restricts them. | Documented | Security |
| Project trust gates project resources at startup. It is not a security boundary. | Documented | Security |
| Working directory sets discovery and the default tool location. It does not limit access to other accessible paths. | Documented | Security |
| A container, VM or sandbox protects host resources not exposed inside it. Exposed credentials and network stay reachable. A dedicated OS user narrows permissions but shares OS and network. | Documented | Security |
| `--approve` / `--no-approve` trust or ignore project-local config and resources for one command. They are not per-action approval. | Documented | CLI |
| `--tools` selects the tools declared to the model. `--no-tools` starts with all built-in, extension, custom and MCP tools disabled. Tool selection is not an OS sandbox. | Documented | CLI |
| `--mode` is an integration mode (interactive/json/rpc), not a permission mode. | Documented | CLI |
| RPC is a long-lived child process driven over JSONL. A response with `success:true` means command handling succeeded. It is not an authorization result or a model-run completion result. | Documented | RPC |
| RPC clients must handle startup failure, exit, cancellation, stderr and deadlines. | Documented | RPC |
| Extensions run inside Pi with the same OS permissions. Loaded extension code is trusted executable code. | Documented | Extensions |
| Isolated runs on macOS and Debian 13 with a throwaway `PI_CODING_AGENT_DIR`, an empty workspace and `--offline --no-approve --no-tools --no-session --mode rpc`, sending only `get_state`, each returned `success:true`, empty stderr and exit 0. No model was called. | Observed | `pi-1.4.0-contract.md` |

The observed runs show the flags were accepted and the isolated seam ran. They do **not** show that any permission is enforced.

## 2. Enforceable versus best-effort, per mode

All "enforceable" claims are **conditional**: they hold only if every relevant side-effect path goes through the Pify gate. Pi itself does not mediate side effects by default (Security). Any path that bypasses the gate is outside the guarantee: an extension, an installer, a language server, a child process spawned by a tool, or any tool not routed through Pify. Without an OS boundary, Pify cannot prevent Pi or its children from acting with the account's permissions. No OS boundary has been demonstrated, so every guarantee below is best-effort at the OS level (spec #2: describe enforcement as best-effort unless an actual OS boundary is demonstrated).

All labels in this table are **Proposed**; the "OS-level" column is **Documented** as unavailable by default.

| Mode | Enforceable within Pify mediation (only if all side-effect paths use the gate) | Best-effort or unavailable |
|---|---|---|
| **Safe** | Side-effect requests outside the explicit authorized scope are refused. No scope means no side effects (fail closed). Anything needing approval returns a structured outcome (section 3), never a terminal wait. | OS-level containment of Pi, extensions and child processes. Detecting side effects that bypass the gate. Network and credential restriction. |
| **Balanced** (default) | Same fail-closed floor as Safe. Actions inside the authorized scope proceed. Actions outside it return approval-required or clarification-required. | Same as Safe. Whether a classification of "in scope" matches what a tool actually does (for example a shell command) is a best-effort check. |
| **Full** | Proceeds without per-action approval inside the caller's authority. It never exceeds caller authority or external restrictions. Missing scope still fails closed for side effects. | Same as Safe. Full is not an OS escape: it grants no authority the caller lacks, and it adds no isolation. |

Notes:

- Tool selection (`--tools`, `--no-tools`) can reduce what the model is offered. It is not an enforcement boundary (CLI).
- Project trust flags are not approval and not a boundary (Security, CLI).
- A real boundary requires an OS or virtualization layer (container, VM, dedicated sandbox). Even then, anything exposed inside it, including credentials and network, stays reachable (Security). Whether Pify will use one is **unverified** and out of scope here.

## 3. Provisional approval and clarification result

**Provisional.** Illustrative only. Field names, types and completeness are not agreed. Owner to review against spec #2.

This is a Pify-level result. It is separate from the Pi RPC `success` field, which only reports that Pi handled a command. A Pi response of `success:true` must never be read as "approved", "authorized" or "run finished".

```json
{
  "schema": "pify.permission-result/provisional",
  "requestId": "req-0001",
  "outcome": "approval_required",
  "action": { "kind": "write_file", "target": "docs/example.md" },
  "scope": { "mode": "balanced", "authorized": ["docs/**"], "callerId": "caller-1" },
  "reason": "target is outside the authorized scope"
}
```

```json
{
  "schema": "pify.permission-result/provisional",
  "requestId": "req-0002",
  "outcome": "clarification_required",
  "action": { "kind": "run_command", "target": null },
  "scope": { "mode": "safe", "authorized": [], "callerId": "caller-1" },
  "missing": ["authorized scope", "command to run"]
}
```

Properties:

- `requestId` correlates the result to the request that produced it.
- `action` names the requested action. `scope` names the mode, the authorized scope and the caller.
- `reason` (approval) or `missing` (clarification) says why work stopped.
- The result is returned to the caller. Nothing waits on a terminal, a prompt or stdin.
- With no authorized scope, side effects are not performed (fail closed).

## 4. Caller trust limits

- Authority is monotonic: a worker receives no more authority than its caller. A child agent receives equal or narrower scope and permissions than its parent (spec #2). **Proposed.**
- Full cannot exceed caller authority or external restrictions (spec #2). Mode selects policy within that authority; it never widens it.
- A worker is not inherently read-only. Its limits come from what the caller grants.
- Pify cannot verify who a caller is or whether the caller's own authority is legitimate. Caller identity and claimed scope are inputs the gate takes as given. **Unverified** how Pify would authenticate them.
- Loaded extensions and packages are trusted code (Extensions, Security). A Pify gate cannot contain code that runs inside Pi with the same OS permissions.

## 5. MVP versus roadmap

Per spec #2, basic headless safety (explicit scope, fail closed, structured outcomes) is MVP. Lifecycle, concurrency and dashboard controls are roadmap and out of scope here.

## 6. Unresolved risks

1. Gate coverage is unproven. If any side-effect path skips the gate, every "enforceable" claim above fails for that path.
2. No OS boundary is demonstrated. All guarantees are best-effort until one is.
3. Shell and similar tools make "is this action in scope" a heuristic, not a proof.
4. Caller identity and scope authentication are undefined.
5. The result schema is provisional and untested against any Pify code, because none exists.
6. Only Pi 1.4.0 was examined; the tagged docs state no support range for other versions.
