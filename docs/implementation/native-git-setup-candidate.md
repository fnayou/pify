# Candidate native Pi setup from a pinned Git commit

**Status, 2026-11-12:** [ADR-0001](../adr/0001-first-distribution-source.md) selects a full Git commit as the first supported source only after [MVP gate #81](https://github.com/fnayou/pify/issues/81) passes. This remains a development candidate, not a supported installation guide or release. Pify remains a bootstrap project. No package has been published. The steps below describe the native Pi entrypoint tested in disposable agent directories; they are not approval to change an active Pi installation.

## Source review and preflight

Choose a full commit from the public `fnayou/pify` repository and review its source before loading it. The current recorded candidate is `9faefeb17b55d6ec15d078eaa1325ee36bb8bab2`; it was tested with official Pi 1.5.2 on macOS and Linux. A later commit needs a new preview and acceptance run. In a disposable workspace, use the exact source:

```sh
PIFY_COMMIT=9faefeb17b55d6ec15d078eaa1325ee36bb8bab2
git clone --no-checkout https://github.com/fnayou/pify.git pify-reviewed
git -C pify-reviewed checkout --detach "$PIFY_COMMIT"
git -C pify-reviewed rev-parse HEAD
git -C pify-reviewed remote get-url origin
```

Confirm the printed commit and remote match the intended values. Review the loaded extension and package resources. Keep the following commands in the same shell, and point Pi at an isolated agent and session directory before starting the transient checkout:

```sh
PIFY_AGENT_DIR="$PWD/pify-agent"
mkdir -p "$PIFY_AGENT_DIR"
export PI_CODING_AGENT_DIR="$PIFY_AGENT_DIR"
export PI_CODING_AGENT_SESSION_DIR="$PWD/pify-sessions"
pi -e "$PWD/pify-reviewed" --pify-preflight
```

Run `/pify-setup preview-git <full-commit>` inside that session. Record its review code, runtime digest, declared resources, agent collisions, Pi registration action, and first-session theme plan. The preview does not install Pify. Pi executes the transient extension before the command runs and may initialize its own files. Stop if the source differs, registration reports a conflict, or any collision needs a decision not yet made. The command reports GitHub origin as `not_verified`; the separate clone and remote checks provide live transport evidence, not a signature or full provenance attestation.

## Native installation and verification

After reviewing the same commit and preview, exit the transient session. The package manager step is Pi-owned and lies outside Pify's permission gate:

```sh
pi install "git:github.com/fnayou/pify@$PIFY_COMMIT"
pi list
pi
```

In the ordinary Pi session, run `/pify-setup verify-git <full-commit> <review-code>`, then `/pify-health`. Require `verified` and `installed (git)` for the exact pin. Verification happens after Pi has loaded the package; it cannot prevent execution of changed code. If either check fails, stop and inspect the Pi declaration, checkout, and health before using optional Pify actions. A fresh session without a saved theme selects Pify and records a rollback journal. An existing `system` or personal theme stays selected. A user who does not want the fresh default must set an explicit theme through Pi before the first installed interactive session.

## Rollback and removal

Use `/pify-theme status` in the ordinary session. If Pify selected the fresh theme and rollback is wanted, run `/pify-theme rollback` before removal. A later personal theme edit blocks Pify rollback and remains untouched. Exit Pi, then use the same source for native removal:

```sh
pi remove "git:github.com/fnayou/pify@$PIFY_COMMIT"
pi list
```

Check that unrelated packages, user skills, settings, credentials, sessions, and project files remain. Pi owns package registration and removal; Pify owns only its extension changes and journal. Native removal does not erase retained Pify recovery records. A version change needs a separate [read-only update preview and scoped Git backup](native-git-update-candidate.md) before asking Pi to replace the pin. Its backup policy is owner-approved, but the update sequence remains conditional on a reviewed release source and the final MVP gate decision.

## Evidence and remaining gate

The [`smoke_pi_live_github.py`](../../scripts/smoke_pi_live_github.py) [passed](https://github.com/fnayou/pify/actions/runs/43119841151) fresh and existing disposable agents on macOS and Linux with Pi 1.5.2 and commit `9faefeb17b55d6ec15d078eaa1325ee36bb8bab2`. It checked transient preview, exact native install, ordinary verification and health, skills and collision precedence, TUI startup, fresh theme rollback and a later session, native removal, and unrelated-state preservation. The earlier [Pi 1.4.0 run](https://github.com/fnayou/pify/actions/runs/43013184734) remains historical evidence for its own commit. An optional [private hosted-model check](models.md#hosted-model-inside-the-reviewed-git-setup-candidate) passed in this Git journey with a loopback fixture. The owner then confirmed passing remote hosted routes in the same reviewed Git journey on [macOS](https://github.com/fnayou/pify/issues/81#issuecomment-6809922371) and [Linux](https://github.com/fnayou/pify/issues/81#issuecomment-6828602166). The mirror-backed package smoke covers the joined path on macOS and Linux. The backup policy is [owner-approved](https://github.com/fnayou/pify/issues/137#issuecomment-6811769162); the supported setup and update decision and final gate review remain before this can be called supported.
