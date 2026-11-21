# Explicit release checks and backed-up updates

Pify remains a bootstrap project. No release source, tag, change record, or public update is approved. The [first-source decision](../adr/0001-first-distribution-source.md) chooses a full Git commit pin only after [MVP gate #81](https://github.com/fnayou/pify/issues/81) passes. The private package's current version is development metadata.

## Release candidate contract

Run [`check_release_candidate.py`](../../scripts/check_release_candidate.py) only for a deliberately selected release candidate. It is read-only: it creates no commit, tag, release, package, or update. Routine `task check` validates CalVer syntax but does not run a release check. CI exercises this command only against a disposable local Git fixture on macOS and Linux.

The candidate must be a clean repository root at a full commit matching canonical GitHub `main` during `prepare`. `package.json` must retain the private `@fnayou/pify` identity; its version and both lockfile versions must match. `YYYY.M.PATCH` uses an unpadded month and a release counter within that month. A dated `## [YYYY.M.PATCH] - YYYY-MM-DD` changelog section must follow `Unreleased`, contain a change bullet, and match the version's year and month. The external JSON record must name that exact version, date, `vYYYY.M.PATCH` tag, full Git source commit, and nonempty changes.

Create the record after committing the candidate, outside its worktree, so its source can name that commit without changing it. The record schema is:

```json
{
  "schema": "pify.release-record/v1",
  "version": "YYYY.M.PATCH",
  "date": "YYYY-MM-DD",
  "tag": "vYYYY.M.PATCH",
  "source": "git:github.com/fnayou/pify@<full-40-character-commit>",
  "changes": ["One reviewed user-visible change"]
}
```

The checker reads canonical GitHub tags with Git's system and global configuration disabled. `prepare` requires the candidate version to follow every prior CalVer tag and the new tag to be absent. If no earlier CalVer tag exists, pass `--first-release` explicitly. After a maintainer separately creates and pushes the reviewed tag, `verify-tag` requires it to resolve to the candidate commit. Repeat `--first-release` at verification only for the first release. A `--fixture-remote` override is for local tests and marks its result `fixtureOnly: true`; it is not release evidence.

```sh
python3 scripts/check_release_candidate.py --record /private/path/pify-release.json --first-release
python3 scripts/check_release_candidate.py --record /private/path/pify-release.json --first-release --phase verify-tag
```

For later releases, omit `--first-release`. Inspect the source and record, complete #81's supported journey, and obtain explicit publication approval before creating any public tag or release record. Keep the private record until that decision; the command never publishes it. `prepare` establishes a candidate, not permission to tag, publish, or install. `verify-tag` verifies a tag, not a released package or user migration.

## Explicit update and rollback

The owner-approved [pinned Git update candidate](native-git-update-candidate.md) is the transition contract: review old commit A and new commit B, preview B, make and verify a private Git backup of A, then explicitly ask Pi to install B. Verify B's declaration, checkout, review code, and health. If Pi partly changes the checkout or B fails, retain the evidence and use that verified backup to reinstall A through a command-scoped local URL rewrite; verify A afterward. Record the A/B commits, review codes, backup path, Pi version, UTC time, and `prepared`, `verified`, or `rolled_back` outcome in a private mode-0600 change record. Keep the backup until explicit deletion. No background update or automatic cleanup runs.

The [synthetic version-change smoke](../../scripts/smoke_pi_git_version_change.py) proves backup before A→B, a forced partial failure, and offline A rollback in disposable Pi agents on macOS and Linux. The Git-only backup excludes Pi settings, credentials, sessions, model configuration, and theme state. The candidate remains unavailable as a supported public update until #81 selects and validates an actual release source and user journey.
