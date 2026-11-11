---
status: accepted
---

# Use a full Git commit for Pify's first supported distribution

When the Waves 1–2 MVP gate passes, Pify's first supported source will be `git:github.com/fnayou/pify@<full-commit>` through official Pi, with a reviewed public commit and an explicit release record. This chooses a source contract; it does not make the current bootstrap package a release. A full pin is the only portable source whose preview, ordinary Pi install, health, removal, and backed-up update candidate have been exercised through Pi 1.4.0. Keep `@fnayou/pify` as the private npm identity for later, separately approved publication.

## Considered options

| Source | Current evidence | First-release consequence |
| --- | --- | --- |
| Full GitHub commit pin | Native Pi 1.4.0 install and removal passed in isolated macOS/Linux mirror fixtures. A real GitHub fetch, preview, ordinary verification, and removal passed on macOS. A synthetic A→B change has read-only preview, backup, failure detection, and offline A recovery. | Use one immutable source string in the release record and setup guide. Require source review before Pi loads code, exact post-install verification, and a private backup before an explicit update. |
| `npm:@fnayou/pify@<version>` | The repository manifest is private. Health has synthetic npm declaration tests; no reviewed registry artifact or native registry install has been validated. | Publishing would need a separate artifact review, registry ownership and version-history checks, package access decision, and explicit authorization. |
| Local directory | Private development setup is tested on macOS and Linux, with path-bound review. | A local path does not provide one portable public source identity and can change in place. |

## Consequences and gate

The product and repository remain named Pify. The private npm name remains `@fnayou/pify`; this decision does not reserve, publish, or rename anything on npm. Pi owns Git package registration, fetching, and removal. Pify's review code binds the full commit and bounded runtime bytes, but verification runs after Pi loads extension code. The preflight does not attest GitHub origin, signed provenance, untracked files outside its runtime roots, or external dependencies. A GitHub URL can be rewritten by Git configuration; the release procedure must review the source and record the exact commit and fetched transport evidence.

The Git commit is the source identity, not the product version. A release still needs valid `YYYY.M.PATCH` metadata, an authoritative version-history check, a tag, and a change record. The first install depends on GitHub availability; an already installed pin can be backed up locally for a later offline rollback.

Before public installation instructions or a release, [MVP gate #81](https://github.com/fnayou/pify/issues/81) must pass the complete fresh and existing user journey on macOS and Linux, including the real hosted-model path and approved backed-up user update procedure. [Release policy #55](https://github.com/fnayou/pify/issues/55) still needs an authoritative version and change record. The selected commit must be named only after that review; no current development commit is declared a release here. npm publication remains a separate decision.
