# Pify permission contract

Pify remains a bootstrap project. Safe, Balanced, and Full are Pify modes, not Pi permission modes. Balanced is the default. The package extension shows the active mode through Pi's namespaced status entry and `/pify-permission` command. In RPC mode, the command emits a JSON permission result through Pi's `notify` event. It does not ask a terminal question or wait for stdin.

An exact resource path must appear in the caller's explicit `authorizedPaths` before a Pify side effect runs. No scope returns `clarification_required` in every mode. An out-of-scope path returns `denied` in Safe, or `approval_required` in Balanced and Full. Neither result performs the action. Full grants no authority beyond the caller's scope. `deriveWorkerPermission` rejects a wider worker mode or path set.

The Pify-mediated side-effect paths are:

| Path | Side effect | Gate |
| --- | --- | --- |
| `applyAdoption` | Promote exact managed files and write private state | `adopt` for every planned file |
| `rollbackAdoption` | Restore or remove exact transaction files | `rollback` for every transaction target |
| `uninstallManagedFiles` | Restore adopted files or remove created files | `uninstall` for every eligible managed file |

Read-only previews need no scope. The lower-level `managed-state.mjs` primitives remain importable for internal recovery and are not a security boundary. Pi's built-in tools, RPC `bash`, other extensions, package installers, language servers, and child processes do not pass through this gate. Pi and extensions retain the starting OS account's permissions. Without an OS or virtualization boundary, these checks are best effort and cannot contain unmediated code or authenticate a caller's claimed scope. The `--pify-scope` flag is a caller declaration, not proof of authorization.

The result schema is `pify.permission-result/v1`. It carries a Pify request ID, mode, caller ID, declared scope, action, exact targets, and `allowed`, `denied`, `approval_required`, or `clarification_required` outcome. A blocked call returns this result without prompting. The result is distinct from Pi RPC's `success` field, which reports command handling only. An `allowed` check does not promise that the resource-specific workflow can perform the action.

The [choice command](choices.md) uses the same result envelope for a missing detail. Its `choose` action has no file targets and grants no side-effect authority; a later action must pass its own permission check.

This contract targets the pinned Pi 1.4.0 fixture. The headless smoke test checks default and selected modes with and without scope on macOS and Linux.
