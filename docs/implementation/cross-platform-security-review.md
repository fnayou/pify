# Cross-platform validation and security review

**Review date:** 2026-11-21. Pify remains a bootstrap project. This review covers the private package and its Pify-mediated paths at Pi 1.5.2. It is not a release approval or a claim that Pi, third-party extensions, or the host account are sandboxed.

## Validation evidence

| Acceptance check | Evidence | Limit |
| --- | --- | --- |
| macOS and Linux | The [merged #163 CI run](https://github.com/fnayou/pify/actions/runs/44895746551) passed all five checks, including package smoke and 107 Node tests, on commit `bef5ad392c4ff5297cdb583dd52821495494454d`. The current [package smoke matrix](../../.github/workflows/package-smoke.yml) runs on both platforms for every PR. | This is isolated fixture evidence, not an active-user installation or release. This review's added checks must pass in its own PR matrix. |
| Optional services absent | [`smoke_pi_optional_absence.py`](../../scripts/smoke_pi_optional_absence.py) installs the private package into a fresh Pi agent, starts Pi offline with no model or project configuration and an allowlisted environment without provider keys, and checks health, unconfigured memory, and inactive optional optimization hooks. | It does not prove that all possible provider or host combinations work; live local and hosted model evidence belongs to [MVP gate #81](https://github.com/fnayou/pify/issues/81). |
| Public status drift | [`check_public_status.py`](../../scripts/check_public_status.py) runs through `task check` on both platforms. It requires bootstrap and unreleased markers in the README, published site, contribution and security pages, and banner; it checks `package.json` remains private. | Required markers cannot detect every contradictory sentence. A human must review changed public prose. |
| Dependency advisory snapshot | `npm audit --omit=dev --json` reported zero known advisories for the installed production tree on 2026-11-21. The pinned direct dependency was `pdfjs-dist@6.5.438`. | Advisory status changes over time; this snapshot is not a future guarantee. |

## Focused security review

| Surface | Review result | Finding or remaining limit |
| --- | --- | --- |
| Pify permissions and shell dispatch | Exact resource paths and Safe/Balanced/Full outcomes are checked in [`permissions.mjs`](../../src/permissions.mjs), unit tests, and Pi smoke. The shell gate blocks dispatch in Safe mode. | **Recorded boundary:** `--pify-scope` is a caller declaration, not authentication. An allowed shell has the Pi account's OS authority. Pi built-in tools and other extensions do not pass this gate. See [permission contract](permissions.md). |
| File reads and writes | Inspection caps input/output and rejects final-component links; reviewed edits, conflicts, commits, and managed state have scope, stale-state, or recovery checks. Existing tests cover hostile archives, links, and drift. | **Recorded boundary:** concurrent processes can replace paths after checks. The SQLite inspector reopens a named path for read-only querying after its initial file check. Run untrusted work behind an OS or VM boundary; these checks do not prevent all races. |
| Subprocesses and Git | Pify's reviewed commits use a private index and never push; conflict resolution does not commit; memory sync checks a private GitHub origin before a PR push. Shell jobs require their own Pify scope. | **Recorded boundary:** a permitted shell job runs arbitrary commands as the Pi account. Git source pins and runtime review codes do not prove signed upstream provenance. The first supported source remains a decision under [#81](https://github.com/fnayou/pify/issues/81). |
| Network and optional services | LM Studio inventory accepts loopback URLs, bounded responses, and no redirects. Memory sync is explicit and checks the remote is private. The new absence smoke requires no optional service. | Pi's normal model providers and `gh`/Git transport have their own trust and credential boundaries. This review does not sign off a live provider or publication path. |

No new actionable defect was found in the reviewed Pify-mediated paths. The recorded boundaries above remain open as design limits, with release decisions tracked by [#81](https://github.com/fnayou/pify/issues/81) and [#55](https://github.com/fnayou/pify/issues/55). Public README and site copy still separate repository-implemented, unreleased work from the planned distribution. Keep the first release blocked until those gates have their own evidence and approval.
