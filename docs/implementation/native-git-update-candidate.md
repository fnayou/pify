# Candidate backed-up pinned Git update

**Status, 2026-11-11:** This is a disposable-fixture procedure for [MVP gate #81](https://github.com/fnayou/pify/issues/81), not an approved user update or release instruction. Pify remains a bootstrap project. It uses native Pi package operations and a private Git backup; it must not be applied to an active Pi installation until the release and backup policy is approved.

## Preconditions and review

Start from the [native pinned-Git setup candidate](native-git-setup-candidate.md) in an isolated Pi agent directory. Record its full installed commit **A**, the A review code from the original preflight, and the exact `git:github.com/fnayou/pify@A` declaration. In an ordinary session, require `/pify-setup verify-git <A> <A-review-code>` to report `verified` and `/pify-health` to report `installed (git)`. Choose a distinct full commit **B** from the public repository and review its source before loading it. A changed A checkout, missing review code, conflicting declaration, or damaged Pi state stops the procedure.

The following commands describe the tested fixture order. Keep the variables in one shell. Use a new, absent private backup path without spaces and outside the Pi agent and any real project; never reuse an earlier backup path. The example assumes the isolated setup already set `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`:

```sh
PIFY_OLD_COMMIT='PASTE_OLD_FULL_COMMIT'
PIFY_NEW_COMMIT='PASTE_NEW_FULL_COMMIT'
PIFY_BACKUP="$PWD/pify-backup-$PIFY_OLD_COMMIT.git"
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

`--no-extensions` suppresses discovery of installed A while explicit `-e` still loads reviewed B; otherwise duplicate Pify tools and flags prevent Pi 1.4.0 from starting. Run `/pify-setup preview-update-git <A> <A-review-code> <B>` inside it. Require `replace_pinned_git_declaration`, exact A and B sources, `backupRequired: true`, the expected B runtime digest and review code, and no unresolved resource collision. The command checks that the installed A pin still matches its prior review. It does not inspect or create the backup, install B, approve a conflict, or write Pify state. Pi may initialize its own files while starting the transient session. Exit Pi before creating the backup.

## Back up A before changing the pin

Exit Pi before copying the installed Git commit. Create a private bare mirror from the Pi-managed A checkout, then verify its ref and object integrity. A missing or failed backup stops the update:

```sh
(umask 077; git init --bare "$PIFY_BACKUP")
git --git-dir "$PIFY_BACKUP" config receive.shallowUpdate true
git -C "$PI_CODING_AGENT_DIR/git/github.com/fnayou/pify" push "$PIFY_BACKUP" "$PIFY_OLD_COMMIT:refs/heads/pify-backup"
git --git-dir "$PIFY_BACKUP" rev-parse --verify 'refs/heads/pify-backup^{commit}'
git --git-dir "$PIFY_BACKUP" fsck --strict --no-reflogs
```

Confirm the printed backup ref equals A. This backup holds the installed Git commit, not Pi settings, credentials, sessions, model configuration, or Pify's theme journal. Keep those resources separate and private under any later approved release backup policy.

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

The rewrite applies only to this invocation. In a new ordinary session, run `/pify-setup verify-git <A> <A-review-code>` and `/pify-health`; confirm the A checkout, exact A declaration, restored runtime bytes, and no incomplete-update marker. The [synthetic version-change smoke](../../scripts/smoke_pi_git_version_change.py) proves this path with the original source unavailable on macOS and Linux CI. It does not cover a corrupt settings file, lost backup, every npm failure phase, or an active-user migration. Keep [release policy #55](https://github.com/fnayou/pify/issues/55) and the MVP gate open until those steps and a supported distribution are approved.
