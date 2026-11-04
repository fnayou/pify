# Regular-file adoption contract

Pify is still a bootstrap project. This module API is not a released Pi command or installer. It manages only exact regular files under the agent directory's `extensions`, `skills`, `prompts`, and `themes` directories. It does not edit Pi settings, credentials, sessions, or project files.

`previewAdoption({ agentDir, resources })` returns one entry per requested file and does not create Pify state. Each resource has a relative path and string or Buffer content. The caller must show the complete preview before calling `applyAdoption`. A pre-existing unowned file appears as a conflict. The caller must pass that exact path in `approvedConflicts` after an explicit user choice. Changed previews, symlinks, hard links, unsupported files, and drift stop the operation.

`applyAdoption` requires a permission context with an explicit exact-path scope. It creates a private manifest and scoped backup before each promotion. It rechecks the planned content and prior digest. On failure, it attempts rollback in reverse order and reports any `recovery-needed` path in the thrown error's `recovery` field. A successful result contains transaction IDs for later `rollbackAdoption`. Rollback restores prior content and mode only when the current content still matches the installed digest. If someone edited the file, Pify preserves it and reports `recovery-needed`.

`previewUninstall` lists recorded files as `restore`, `remove`, or `conflict`. `uninstallManagedFiles` requires that exact preview and an explicit permission scope. It unwinds each intact transaction chain: adopted files return to their prior content; created files are removed. Conflicted files stay in place and produce a `partial` result. Other Pi data is outside the manifest and is never scanned or removed.

The private `pify-state` journal and backups remain after rollback or uninstall for recovery. Cleanup and retention need a separate decision before deletion. Concurrent writers, directory resources, symlink entries, special modes, and extended attributes are outside this contract.
