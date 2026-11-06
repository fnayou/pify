# Proposed native Pi setup lifecycle

**Status:** Design proposal for [#89](https://github.com/fnayou/pify/issues/89), part of the open [MVP gate #81](https://github.com/fnayou/pify/issues/81). Pify is a bootstrap project. This is not a supported installation guide or a release claim.

## Ownership and entrypoints

Pi owns package registration and resource loading. Its documented commands are `pi install <source>`, `pi list`, `pi config`, and `pi remove <source>`. A local package loads from its path without copying its resources. A pinned npm version or git ref can be used only after that source is released and reviewed. The current private package declares one extension, two skills, and one theme; it declares no prompt templates. See the pinned [Pi 1.4.0 package](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/packages.md) and [CLI](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/cli.md) contracts.

Pify owns only side effects performed by its extension after Pi loads it. Current examples are theme selection in agent settings and an opt-in project workflow file. The regular-file adoption module has no selected package resource to copy into the agent directory. Package resources must stay in Pi's package loader; copying them solely to use the adoption module would create duplicate ownership and a second removal path.

The proposed pre-install entrypoint is a read-only `/pify-setup preview` command in a transient Pi session started with `pi -e <reviewed-source> --pify-preflight`. Pi documents `-e` as loading a package for one invocation without adding it to settings. The proposed `--pify-preflight` flag suppresses Pify's fresh-theme selection for this preview session only. The command would report the exact source and package resources, the Pi package declaration that `pi install` would add, user resource collisions and their load precedence, and the planned first-session Pify theme selection when no saved theme exists. It must not call `pi install`, write Pify state, or ask for credentials. Transient Pi startup itself may initialize Pi-owned files; this is a Pify no-write promise, not a whole-process no-write promise. Running an extension executes its code, so the source must be reviewed before preflight.

The user then explicitly runs `pi install <same-reviewed-source>`, starts an ordinary Pi session, and runs `/pify-health`. The source identity and reviewed content digest must still match the preview; a changed local path or ref requires a new preview. `pi install` changes Pi's package declaration outside Pify's permission gate. Pify does not claim to approve or roll back Pi's internal package operation. [Issue #30](https://github.com/fnayou/pify/issues/30) requires the first ordinary interactive session to select the Pify theme when Pi has no saved theme. A user who declines that default must make an explicit `system` or personal theme choice through Pi before the first installed session. On an existing Pi setup, a same-name user skill must remain untouched and retain the observed Pi precedence; no Pify file adoption is needed for that collision.

## Optional changes and removal

After installation, any optional Pify-managed change needs a fresh exact preview and explicit choice. `/pify-theme status` and `/pify-theme enable` already cover a later saved theme choice in a terminal. An explicitly enabled theme has a journaled rollback through `/pify-theme rollback`; a later personal theme change blocks that rollback and remains untouched. The approved fresh-theme default also needs a journaled rollback path before this lifecycle is supported. `/pify-workflow enable` is a separate project opt-in, not part of personal package setup. The generic file-adoption module remains internal until a real resource and user need justify its interface.

If a Pify-managed change fails, the ordinary session must report the failed target and recovery state. The user checks `/pify-health` and the relevant status command, then retries rollback only when the recorded digest or prior theme still matches. A drifted file or theme remains in place with a conflict result for manual review. The current package has no regular-file adoption target and therefore no file conflict approval to request; a future target must use the existing exact-path preview and approval rules before it is added to this lifecycle. If native `pi install` fails, inspect `pi list` and Pi's own error before retrying; Pify cannot claim transactional recovery for Pi's package manager.

Uninstall order is: inspect `/pify-health` and `/pify-theme status`; roll back a journaled theme selection if desired; exit Pi; run `pi remove <same-source>`; then verify `pi list` and the unrelated Pi state. The package extension is unavailable after removal, so theme rollback must happen first. Pify's private recovery journal and backups are retained for inspection. A drifted file or theme is preserved and reported for manual review, never overwritten to force a clean status.

Headless Pify commands must return the existing structured `clarification_required`, `approval_required`, or `denied` result when exact scope or approval is missing. They must not prompt or mutate. Pi's own `install`, `remove`, and `update` commands remain outside that gate. Automatic package updates and a release update/rollback procedure remain [#55](https://github.com/fnayou/pify/issues/55) work; this proposal does not approve `pi update` for Pify.

## Gaps before this can be supported

- `/pify-setup preview` and `--pify-preflight` do not exist. Their report, collision check, source digest check, and no-write behavior need implementation and isolated Pi 1.4.0 proof.
- First interactive startup currently selects the Pify theme when no theme key exists. Transient interactive preview would trigger that selection without the proposed preflight flag. The automatic choice also has no theme journal to roll back. Preserve #30's fresh default while adding preview suppression and a recoverable selection record.
- `/pify-health` currently recognizes a local-path package declaration only. It needs source-aware identity checks before an npm or git distribution can report install status accurately.
- No supported published source, user setup guide, or tested package update/recovery path exists. Keep the first usable release blocked by #81 and #55.

Do not use the proposed transient preflight on an active Pi setup before its flag and no-write behavior are implemented and verified.

## Acceptance plan

Use official Pi 1.4.0 in separate fresh and existing temporary agent directories and workspaces on macOS and Linux. Do not use an active Pi installation. Record the source, Pi version, platform, and redacted results.

1. Snapshot the existing fixture, including an unrelated Pi package, same-name user skill, personal theme, credentials, sessions, and project files. Run transient preflight and verify the Pify-owned portion is unchanged. Compare the preview with the reviewed package manifest and actual `pi install` declaration.
2. Install the same source through Pi. Start ordinary TUI and RPC sessions. Check `pi list`, `/pify-health`, resource precedence, no duplicate package resources, and preservation of unrelated state. The fresh fixture must show the theme plan before install, then apply the approved #30 default and offer rollback. A fixture with explicit `system` or personal theme must retain that choice.
3. Exercise optional theme approval and rollback, a denied headless request with no exact scope, and a forced failure after the theme journal is prepared. Verify the ordinary-session error and recovery path, plus preservation of a later user theme edit. If a real regular-file adoption resource is introduced, add its preview, exact conflict approval, failed apply, rollback, and uninstall to this same journey.
4. Remove Pify through Pi after Pify-managed rollback. Verify no unrelated package, skill, setting, credential, session, or project file changed. Record any Pi-owned files that Pi itself creates or retains.

The local-model and hosted-model paths, permission modes, and optional-service checks still need to be combined with this lifecycle in #81's final acceptance run. One owner-run hosted result on macOS is already recorded there; it does not prove the full setup journey.
