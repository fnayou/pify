# Optional memory vault scaffold

Pify remains a bootstrap project. The private Pi package supports `/pify-memory` for local vault selection. This creates directory structure only; it does not read notes into a session, approve instructions, sync a repository, or require Obsidian.

In an interactive Pi session, `/pify-memory` offers **Status**, **Create new vault**, **Connect existing vault**, and **Skip memory**. The explicit forms are `/pify-memory status`, `/pify-memory create <absolute path>`, `/pify-memory connect <absolute path>`, and `/pify-memory skip`. Create refuses an existing path. Connect preserves existing entries and adds missing scope directories after confirmation. A file or symlink at a scope path is a conflict. Skip clears the selected path but leaves every vault file untouched. The vault must be outside Pi's agent directory and the Pify package tree.

Scaffold version 1 creates empty `00-inbox/`, `01-global/` (`preferences/`, `environment/`, `workflows/`, `knowledge/`), `02-projects/`, `03-reference/` (`tools/`, `research/`, `procedures/`), and `99-archive/` directories. It creates no note, approval record, Obsidian configuration, or Git repository inside the vault. Future project folders are user data and are not created by this command.

The selected absolute path and its filesystem identity stay in private per-machine state at `<Pi agent directory>/pify-state/memory-vault.json` (`0700` directory, `0600` file). `/pify-memory status` and `/pify-health` report `unconfigured`, `skipped`, `available`, or `unavailable`. A missing, replaced, or changed selected vault reports `unavailable`; Pify never replaces it silently. Reconnect explicitly after a legitimate move or restore. Read-only status does not create state.

Headless create and connect require both exact Pify scope targets: `memory/vault-selection` and `memory/vault-path/<sha256>`, where the digest is SHA-256 of the canonical absolute vault path in UTF-8. Skip requires `memory/vault-selection`. Without scope, the command returns a structured clarification result. A completed directory scaffold can remain if a later state write fails; reconnect it explicitly after fixing the error. Vault content is outside Pify's package ownership and is never removed by package uninstall.

Reviewed activation of selected preference notes is described in [reviewed memory preferences](memory-approvals.md). Plain vault notes remain data until locally approved.
