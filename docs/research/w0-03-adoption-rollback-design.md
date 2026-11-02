# W0-03: adoption, ownership, backup, and rollback design

Status: bootstrap research for [issue #14](https://github.com/fnayou/pify/issues/14), aligned with [product spec #2](https://github.com/fnayou/pify/issues/2). Pify remains a bootstrap project; these are design proposals, not implemented or released behavior. No Pi setup was inspected or changed for this report.

## Evidence labels

- **Documented**: stated in official Pi v1.4.0 documentation.
- **Observed**: recorded in [`pi-1.4.0-contract.md`](pi-1.4.0-contract.md), not repeated here.
- **Proposed**: Pify behavior for owner review; not implemented.
- **Unknown**: not established by the allowed evidence.

## Relevant upstream facts and limits

- **Documented:** Pi packages distribute extensions, skills, prompt templates, and themes as a unit; packages can be directories or npm packages and declare resource paths. [Pi packages](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/packages.md)
- **Documented:** Pi has user configuration under its agent directory (default `~/.pi/agent`) and project configuration under `.pi`; project config loads after trust is granted. [Pi configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md)
- **Documented:** Pi settings can combine resource lists, and project settings override agent-directory settings. [Pi settings](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/settings.md)
- **Documented:** Pi exposes package `install`, `remove`, `uninstall`, `update`, and `list` commands. [Pi CLI](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/cli.md)
- **Documented:** Pi and extensions/processes run with the starting account’s OS permissions unless an OS or virtualization boundary restricts them. [Pi security](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md)
- **Observed:** isolated Pi 1.4.0 runs recorded in the contract report created `auth.json` and `models-store.json` in a fresh agent directory. Their creation mechanism and complete contents were not established. [Contract evidence](pi-1.4.0-contract.md)
- **Unknown:** the cited Pi documentation does not specify Pify ownership markers, scoped backups, conflict previews, rollback guarantees, or uninstall behavior. Pi package commands are not evidence for those Pify guarantees.

## Proposed ownership and state model

Ownership is explicit recorded provenance, never inferred from a filename, directory, theme name, symlink target, or location alone. **Proposed:** maintain a Pify manifest for each managed path, recording canonical target, resource kind, owning package/release, expected content digest, and whether Pify created or adopted it. A path lacking valid matching provenance is user-owned or unknown and must be preserved. Adoption requires a preview and explicit owner choice; it does not silently transfer ownership.

Track each path as `unmanaged`, `candidate`, `managed`, `conflict`, or `recovery-needed`. A successful operation records ownership only after content is installed and verified. Modified or missing managed content becomes a conflict; do not overwrite, restore, or delete it automatically. Pify state and generated artifacts must remain distinct from Pi settings, credentials, and session data. **Proposed.**

## Scoped backup and symlink rules

- **Proposed:** back up only exact in-scope regular files or directories that Pify will replace or remove, after preview. Store relative paths, content, metadata needed to restore, and a transaction manifest. Do not archive a parent tree wholesale.
- **Proposed:** exclude credentials, auth/provider tokens, sessions/transcripts, caches, unrelated Pi settings, and any path not in the approved change set. If a candidate resource contains mixed content and cannot be safely separated, refuse automatic backup and ask for a narrower decision.
- **Proposed:** never follow symlinks when scanning, copying, restoring, or deleting. Exclude symlink targets, whether inside or outside the configured root. Preserve existing links by default. If a symlink itself is an intended managed entry, preview the link path and target text and require explicit approval; never operate on its target.
- **Unknown:** Pi’s docs do not describe backup or symlink semantics for Pify. Filesystem race handling, permissions, extended attributes, hard links, and special files need implementation-level decisions and validation.

## Preflight, conflict, rollback, and uninstall

**Proposed preflight:** enumerate exact paths and classify ownership; show create/replace/keep/skip actions, conflicts, backup scope, and excluded paths. Resolve ambiguous ownership and changed managed files before any write. Recheck expected state immediately before mutation; abort the whole plan if it drifted. Keep unrelated resources unchanged.

**Proposed transaction:** create and verify the scoped backup first; stage new content separately; then promote only approved paths and record provenance. On failure, restore only paths changed by this transaction and only when their current content still matches the transaction’s installed digest. If state drifted, preserve it, mark `recovery-needed`, and report manual recovery steps. Never claim rollback succeeded until restored content verifies.

**Proposed uninstall:** preview exact Pify-owned paths and any Pify-owned setting entries. Remove only unchanged paths with valid provenance; preserve user-owned, unknown, modified, and unrelated resources. Restore a prior file only when it was backed up by the corresponding transaction and the current path still matches Pify’s recorded installed state. Preserve personal themes and Pi settings unless an owner-approved exact change record proves Pify created that specific value. Leave credentials, sessions, and external symlink targets untouched.

## Paper walkthroughs

1. **Fresh install:** scan in scope; preview empty destinations and excluded paths; install approved resources; verify content; then record provenance. No ownership is inferred for anything outside the created set.
2. **Existing setup:** user has user-owned skills, a personal theme, and an external symlink. Preview identifies all as existing resources without valid Pify provenance; preserve them. Offer adoption only for individually selected compatible paths. Keep the theme and link unchanged; never follow the link.
3. **Conflict:** an intended destination already contains unowned or modified content. Preview identifies the conflict and proposed choices. Default to keep/skip; replace only after explicit owner selection and scoped backup. Abort if content changes after preview.
4. **Symlink:** a candidate path is a symlink to an external directory. Report the link without traversing it; exclude its target from discovery, backup, update, rollback, and uninstall. Preserve the link unless owner explicitly approves management of the link entry itself.
5. **Failed update:** backup exact replaceable managed paths, stage the update, then encounter a write or verification failure. Stop further changes; restore verified transaction-owned changes only where current content still matches. Preserve unrelated paths and report any recovery-needed paths.
6. **Rollback:** show transaction, targets, expected current digests, and restoration plan first. Restore only recorded prior content for paths still matching the transaction’s installed digest. Leave changed destinations untouched and report partial recovery; do not label partial recovery complete.
7. **Uninstall:** preview provenance-matched unchanged Pify paths and recorded settings entries. Remove those exact resources; restore eligible prior content under the same digest checks. Keep user skills, personal theme, unknown files, credentials, sessions, unrelated Pi settings, and external link targets.

## Open decisions for owner review

1. What provenance record is authoritative, where is it stored, and how is it protected from edits or loss?
2. Does adoption transfer ownership, create a reversible shared-ownership record, or remain unsupported in MVP?
3. Which resource types and Pi settings are in the initial managed scope? Are project-local resources eligible?
4. Which backup metadata must be preserved, where are backups stored, and what retention/cleanup policy applies?
5. How should Pify handle mixed-content directories, dangling links, hard links, special files, and permission errors?
6. Should one conflict block the whole transaction or permit explicitly selected independent paths to proceed?
7. What recovery journal format and user command support interrupted rollback and retries?
8. How should theme setting changes be recorded and reversed while preserving later user selections?
9. What does uninstall do with backups and provenance records, and how does it prove those artifacts belong to Pify?
10. Which filesystem and Pi versions must implementation validate before making rollback guarantees?

## Acceptance mapping

- Ownership does not rely on names or locations alone: explicit provenance model above.
- Scoped backup excludes credentials, sessions, and external symlink targets: backup rules above.
- Failed update, rollback, and uninstall preserve unrelated resources: preflight and walkthroughs above.
- Owner review decisions listed explicitly: open decisions above.
