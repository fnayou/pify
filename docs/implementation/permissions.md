# Pify permission contract

Pify remains a bootstrap project. Safe, Balanced, and Full are Pify modes, not Pi permission modes. Balanced is the default. The package extension shows the active mode through Pi's namespaced status entry and `/pify-permission` command. In RPC mode, the command emits a JSON permission result through Pi's `notify` event. It does not ask a terminal question or wait for stdin.

An exact resource path must appear in the caller's explicit `authorizedPaths` before a Pify side effect runs. No scope returns `clarification_required` in every mode. An out-of-scope path returns `denied` in Safe, or `approval_required` in Balanced and Full. Neither result performs the action. Full grants no authority beyond the caller's scope. `deriveWorkerPermission` rejects a wider worker mode or path set.

The Pify-mediated side-effect paths include:

| Path | Side effect | Gate |
| --- | --- | --- |
| `applyAdoption` | Promote exact managed files and write private state | `adopt` for every planned file |
| `rollbackAdoption` | Restore or remove exact transaction files | `rollback` for every transaction target |
| `uninstallManagedFiles` | Restore adopted files or remove created files | `uninstall` for every eligible managed file |
| `/pify-delegate start` | Start a session-bound Pi worker | `agents/task-start`; the worker inherits equal or narrower Pify scope and tools |
| `/pify-job start` | Dispatch a shell job and its nested commands | `jobs/current-workspace` in Balanced or Full; denied in Safe |
| Pi's model-facing `bash` tool | Dispatch a shell command and its nested commands | `commands/shell` in Balanced or Full; denied in Safe |
| Pi's interactive `!` and `!!` commands and RPC `bash` | Dispatch a shell command and its nested commands | `commands/shell` in Balanced or Full; denied in Safe |
| `/pify-edit apply` | Replace exact text in named workspace files after a complete preview | Exact file paths plus explicit review approval in every mode |

The shell gate checks the dispatch before any shell syntax runs. A nested `sh -c`, subshell, pipeline, or command substitution therefore needs the same initial authorization. Pify does not parse the command or independently authorize each descendant. A permitted shell can execute arbitrary code with the Pi process's OS authority. In Safe, the covered shell entry points are blocked even with explicit scope; use Pi's read-only tools instead. In Balanced and Full, headless callers must declare the exact target shown above. `/pify-permission commands/shell` and `/pify-permission jobs/current-workspace` report the same decision as execution. A blocked model tool call carries the structured Pify result in its reason; blocked interactive and RPC Bash commands return it as output with exit code 126.

Read-only previews need no scope. The [reviewed text edit workflow](edit-previews.md) checks approval and scope separately from its read-only preview. The lower-level `managed-state.mjs` primitives remain importable for internal recovery and are not a security boundary. Pify's [task subagents](subagents.md) inherit the same shell gate with equal or narrower mode and scope. Other Pi built-in tools, including `edit` and `write`, other extensions and their direct process calls, package installers, and language servers do not pass through this shell gate. Pi and extensions retain the starting OS account's permissions. Without an OS or virtualization boundary, these checks are best effort and cannot contain unmediated code or authenticate a caller's claimed scope. The `--pify-scope` flag is a caller declaration, not proof of authorization.

For untrusted work, optionally run the entire Pi process inside a container, VM, or OS sandbox. Expose only the task workspace; leave home directories, credentials, and host sockets outside it. Restrict network access when the task does not need it, and use narrow, short-lived credentials when it does. A dedicated OS account can narrow file access but still shares the host and network. Test the chosen boundary with harmless file and network probes before relying on it. Pi's project trust, `--approve`, working directory, and tool list are not OS isolation. See Pi's [isolation guidance](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/containerization.md) for setup options.

The result schema is `pify.permission-result/v1`. It carries a Pify request ID, mode, caller ID, declared scope, action, exact targets, and `allowed`, `denied`, `approval_required`, or `clarification_required` outcome. A blocked call returns this result without prompting. The result is distinct from Pi RPC's `success` field, which reports command handling only. An `allowed` check does not promise that the resource-specific workflow can perform the action.

The [choice command](choices.md) uses the same result envelope for a missing detail. Its `choose` action has no file targets and grants no side-effect authority; a later action must pass its own permission check.

This contract targets the pinned Pi 1.5.2 fixture. The smoke tests check default and selected modes with and without scope, plus nested shell jobs, model Bash tools, interactive commands, and RPC Bash on macOS and Linux.
