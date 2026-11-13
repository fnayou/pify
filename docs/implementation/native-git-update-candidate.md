# Candidate backed-up pinned Git update

**Status, 2026-11-12:** The owner [approved the private backup and rollback policy](https://github.com/fnayou/pify/issues/137#issuecomment-6811769162) from [#137](https://github.com/fnayou/pify/issues/137). This is still a conditional candidate for the [Git distribution choice](../adr/0001-first-distribution-source.md) and [MVP gate #81](https://github.com/fnayou/pify/issues/81), not a supported user update or release instruction. Pify remains a bootstrap project. Applying it to an active Pi installation still requires a reviewed release source and the final gate decision.

## Preconditions and review

Start from the [native pinned-Git setup candidate](native-git-setup-candidate.md) in an isolated Pi agent directory. Record its full installed commit **A**, the A review code from the original preflight, and the exact `git:github.com/fnayou/pify@A` declaration. In an ordinary session, require `/pify-setup verify-git <A> <A-review-code>` to report `verified` and `/pify-health` to report `installed (git)`. Choose a distinct full commit **B** from the public repository and review its source before loading it. A changed A checkout, missing review code, conflicting declaration, or damaged Pi state stops the procedure.

The following commands describe the tested fixture order. Keep the variables in one shell and work from a disposable review directory. The example assumes the isolated setup already set `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`:

```sh
PIFY_OLD_COMMIT='PASTE_OLD_FULL_COMMIT'
PIFY_NEW_COMMIT='PASTE_NEW_FULL_COMMIT'
git clone --no-checkout https://github.com/fnayou/pify.git pify-next-reviewed
git -C pify-next-reviewed checkout --detach "$PIFY_NEW_COMMIT"
git -C pify-next-reviewed rev-parse HEAD
```

The commit variables above are placeholders; replace them with 40 lowercase hexadecimal characters before running a shell command. A synthetic B commit in the fixture is not a published version or a release candidate.

## Preview the A to B transition

Start a transient Pi session from the reviewed B checkout:

```sh
pi --no-extensions -e "$PWD/pify-next-reviewed" --pify-preflight
```

`--no-extensions` suppresses discovery of installed A while explicit `-e` still loads reviewed B; otherwise duplicate Pify tools and flags prevent Pi 1.5.2 from starting. Run `/pify-setup preview-update-git <A> <A-review-code> <B>` inside it. Require `replace_pinned_git_declaration`, exact A and B sources, `backupRequired: true`, the expected B runtime digest and review code, and no unresolved resource collision. The command checks that the installed A pin still matches its prior review. It does not inspect or create the backup, install B, approve a conflict, or write Pify state. Pi may initialize its own files while starting the transient session. Exit Pi before creating the backup.

## Approved backup location and retention

Choose a private backup root outside the Pi agent directory and every project. The default candidate is `$HOME/.pify-backups`; the user may select another absolute path without spaces before the update. Create it with mode 0700, require it to be owned by the current user and not a symlink, and stop if an existing directory is accessible to others. The root holds only backup records for explicit Pify Git updates; no process deletes them automatically.

After the read-only preview passes, use a fresh directory under that root for this transition. `mktemp` prevents reuse of an earlier backup path. Keep the backup and its recorded A commit after both success and rollback; deletion is a separate, explicit user decision. This policy favors recovery over automatic cleanup and uses storage proportional to retained Git objects. A Git-only backup does not include Pi settings, credentials, sessions, model configuration, or Pify's theme journal. Preserve those separately under a future release backup policy if they are required; this procedure does not claim to recover damaged settings or a lost backup.

```sh
PIFY_BACKUP_ROOT="$HOME/.pify-backups"
export PIFY_BACKUP_ROOT
(umask 077; mkdir -p "$PIFY_BACKUP_ROOT")
python3 - <<'PY'
import os
import stat
from pathlib import Path

root = Path(os.environ["PIFY_BACKUP_ROOT"])
info = root.lstat()
if not root.is_absolute() or " " in str(root) or not stat.S_ISDIR(info.st_mode) or \
        info.st_uid != os.getuid() or info.st_mode & 0o077:
    raise SystemExit("Backup root must be an owned, private, absolute directory without spaces")
resolved_root = root.resolve()
for forbidden in (Path(os.environ["PI_CODING_AGENT_DIR"]), Path.cwd()):
    resolved_forbidden = forbidden.resolve()
    if resolved_root == resolved_forbidden or resolved_root in resolved_forbidden.parents or \
            resolved_forbidden in resolved_root.parents:
        raise SystemExit("Backup root must be outside the Pi agent and review workspace")
PY
PIFY_BACKUP_DIR="$(mktemp -d "$PIFY_BACKUP_ROOT/$PIFY_OLD_COMMIT.XXXXXXXX")"
PIFY_BACKUP="$PIFY_BACKUP_DIR/source.git"
```

The permission check must pass before creating the backup. Keep a private mode-0600 change record in `PIFY_BACKUP_DIR` with A and B commits, both review codes, the backup path, Pi version, UTC time, and an outcome of `prepared`, `verified`, or `rolled_back`. Update the outcome only after the corresponding checks pass. Do not record credentials, model responses, or provider details. Do not create a new version, delete a prior backup, or change Pi settings automatically.

## Back up A before changing the pin

Exit Pi before copying the installed Git commit. Create a private bare mirror at the fresh `PIFY_BACKUP` path from the Pi-managed A checkout, then verify its ref and object integrity. A missing or failed backup stops the update:

```sh
(umask 077; git init --bare "$PIFY_BACKUP")
git --git-dir "$PIFY_BACKUP" config receive.shallowUpdate true
git -C "$PI_CODING_AGENT_DIR/git/github.com/fnayou/pify" push "$PIFY_BACKUP" "$PIFY_OLD_COMMIT:refs/heads/pify-backup"
git --git-dir "$PIFY_BACKUP" rev-parse --verify 'refs/heads/pify-backup^{commit}'
git --git-dir "$PIFY_BACKUP" fsck --strict --no-reflogs
```

Confirm the printed backup ref equals A. Keep the backup directory and private change record after the update. The backup holds the installed Git commit, not Pi settings, credentials, sessions, model configuration, or Pify's theme journal.

## Native update and verification

After a successful preview and verified backup, ask Pi's native package manager to replace the pin:

```sh
pi install "git:github.com/fnayou/pify@$PIFY_NEW_COMMIT"
pi list
pi
```

In the ordinary session, run `/pify-setup verify-git <B> <B-review-code>` and `/pify-health`. Require `verified`, `installed (git)`, the B declaration, and B's detached checkout before treating the update as complete. Pi owns the package mutation; it is outside Pify's permission gate and is not atomic across all failure phases. No automatic update occurs.

## Offline rollback after a failed change

If Pi fails after checking out B, the declaration can still name A. `/pify-health` may report `unknown` or the extension may not load. Stop other Pify actions, inspect `pi list` and the managed checkout, and retain the incomplete-update marker for diagnosis. After verifying the private backup still resolves to A and passes `git fsck`, reinstall A through Pi with a command-scoped local URL rewrite:

```sh
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0="url.file://$PIFY_BACKUP.insteadOf" \
GIT_CONFIG_VALUE_0="https://github.com/fnayou/pify" \
pi install "git:github.com/fnayou/pify@$PIFY_OLD_COMMIT"
```

The rewrite applies only to this invocation. In a new ordinary session, run `/pify-setup verify-git <A> <A-review-code>` and `/pify-health`; confirm the A checkout, exact A declaration, restored runtime bytes, and no incomplete-update marker. Retain the private backup and record after recovery. The [synthetic version-change smoke](../../scripts/smoke_pi_git_version_change.py) proves this path with the original source unavailable on macOS and Linux CI under Pi 1.5.2. It does not cover a corrupt settings file, lost backup, every npm failure phase, or an active-user migration. The owner approved the policy, but a reviewed release source and final [#81](https://github.com/fnayou/pify/issues/81) decision are still required before this becomes a supported user procedure. Keep [release policy #55](https://github.com/fnayou/pify/issues/55) open until its separate criteria pass.

## Disposable public-Git rehearsal

Run `python3 scripts/smoke_pi_public_git_update.py` with official Pi 1.5.2 on `PATH`. This check fetches reviewed development commit `9faefeb17b55d6ec15d078eaa1325ee36bb8bab2` from public GitHub as A and uses `c8d5839b9467384bc32242826bb0aaa0cac30fad` as B. It verifies that B is descended from A and changes only documentation. In a private temporary Pi agent, it previews and installs A, previews the A-to-B transition, verifies a Git backup of A, installs and verifies B, restores A through the backup, and removes Pify. It checks unrelated fixture files throughout. The temporary backup is deleted with the disposable fixture; the approved retention policy still applies to real user updates.

This passed on macOS and Linux with Pi 1.5.2 on 2026-11-13. It proves public Git transport and the backed-up native pin transition for these exact development commits. The synthetic version-change smoke above remains the evidence for a forced partial failure. Neither check selects a release pin or validates an active-user update.
