# W0-08: Architecture proposal and owner decision package

**Status:** proposed for [issue #19](https://github.com/fnayou/pify/issues/19). Pify is a bootstrap project. This package approves no implementation or released behavior by itself.

**Evidence cut:** Pi v1.4.0; Wave 0 reports W0-01 through W0-07; Wave 1–8 GitHub tickets as read on 2026-11-03. “Observed” means exercised in an isolated fixture. “Documented” means a cited upstream source says it. “Proposed” is a Pify design for owner review. “Unverified” remains a gate in the named implementation ticket.

## Architecture proposal

1. **Runtime and package.** Use the official Pi runtime and its standard user and project configuration. Distribute Pify resources through a Pi package, subject to an isolated package-install test. Do not add a wrapper runtime or parallel user configuration. Pi CLI and RPC startup were observed on macOS and Linux; package installation and resource loading remain unverified. [W0-01]
2. **Ownership and transactions.** Keep a Pify-owned provenance manifest and transaction journal as bookkeeping, separate from Pi credentials, sessions, and user settings. Before writing, inventory exact paths, preview the change, resolve conflicts, and back up only approved paths. Recheck state before promotion. Rollback and uninstall act only on unchanged, provenance-matched Pify resources. Never traverse symlink targets. Manifest location, protection, retention, and recovery format remain W1-02/W1-03 design gates. [W0-03]
3. **Authority.** Safe, Balanced (default), and Full are proposed Pify policies. A Pify gate can refuse mediated actions outside caller scope and return structured approval or clarification results in headless use. It cannot constrain Pi, extensions, installers, child processes, or shell effects that bypass that gate. Without an OS boundary, enforcement is best-effort. W1-04 must prove its covered paths and preserve equal-or-narrower worker authority. [W0-02]
4. **Models.** Use Pi `models.json` for compatible endpoints and `auth.json` or provider environment variables for credentials. User `settings.json` holds startup defaults; trusted project `.pi/settings.json` can override user settings. Session selection is separate. W2-03 must exercise one local OpenAI-compatible endpoint and one cloud provider in isolated fixtures. Later LM Studio sync is explicit, preserves the effective selected default, and changes only entries proven Pify-owned by a validated sidecar; a conflicting or unverifiable change stops for review. The merged W0-04 report's inline marker is a proposal whose Pi schema compatibility remains unverified. [W0-04] [Pi configuration]
5. **Skills and optional tools.** Start with a small pinned, reviewed skill set. Install source/version provenance and preserve user-owned skills. Broader collections, research, document readers, and optimization tools stay optional until each ticket validates licensing, Pi compatibility, output bounds, privacy, and rollback. W0-05 surveyed candidates but did not test them; W0-07 found no verified selective context-pruning candidate. [W0-05] [W0-07]
6. **Memory and execution roadmap.** Keep an optional vault outside Pi-native instruction paths. A local approval registry may gate only Pify's own activation; it cannot stop Pi's native context-file loading. Subagents must inherit no wider authority than their caller, expose cancellation and results, and feed a dashboard independently of footer integration. Any footer adapter is opt-in and uses a namespaced status contribution, not ownership of the user's footer. Activation and subagent contracts require later validation. [W0-06] [W0-07]

## Feasibility matrix

| Slice | Evidence now | Decision for this plan | Required proof before claiming behavior |
|---|---|---|---|
| Native Pi runtime and package | Pi 1.4.0 CLI/RPC observed on macOS and Linux; package and extension APIs documented, package load unverified. [W0-01] | Propose one native Pi package. | W1-01 fixture installs package, loads resources, and starts normal sessions on both platforms. |
| Ownership, adoption, rollback | Provenance and transaction model is proposed; paper walkthroughs only. [W0-03] | Require exact ownership and scoped backup before mutation. | W1-02/W1-03 prove conflicts, symlinks, interrupted updates, rollback, and uninstall preserve unrelated state. |
| Permission and headless scope | Pi has process authority; Safe/Balanced/Full are not Pi modes. [W0-02] | Permit only a bounded Pify-mediated guarantee; state OS limits. | W1-04 tests every covered side-effect path and structured headless results; W7-03 hardens later. |
| Local and cloud models | Pi storage and LM Studio APIs documented; no live model call or sync test. [W0-04] | MVP keeps normal Pi selection; sync remains later and explicit. | W2-03 proves both provider paths; W4-01 proves ownership, default preservation, atomicity, and metadata. |
| Skills and document/research tools | Sources surveyed; Pi loading, tool safety, and several licenses or formats unverified. [W0-05] | Pin a minimal verified skill set; defer broad integrations. | W2-02 and W3-05/W4-02/W5-01/W5-02 validate candidate behavior and provenance. |
| Memory trust | Pi native discovery is documented; local registry and activation are proposals. [W0-06] | Vault is optional and outside native instruction discovery. | W6-01/W6-02 prove unapproved, moved, edited, or synced entries stay inactive. |
| Subagents, dashboard, footer | Pi lifecycle and examples documented; Pify authority, status feed, and adapter untested. [W0-07] | Prefer native APIs; instrument child state; keep footer separate. | W7-01/W7-02/W7-06 prove scope, cancellation, results, and untouched user footer. |
| Output and context optimization | Candidate licenses and maintenance surveyed; fidelity and Pi compatibility untested. [W0-07] | Preserve existing setups; enable no new lossy transform by default. | W2-07 proves exact payload safety or records an unavailable candidate; later adoption needs its own gate. |

## Risk register

| Risk | Severity | Evidence and effect | Gate / response |
|---|---|---|---|
| R1: unmediated side effects bypass a Pify mode | High | Pi and extensions run with process authority; shell classification is heuristic. [W0-02] | W1-04 maps every covered path, returns headless denial, and states best-effort limits; use OS isolation for untrusted work. |
| R2: wrong ownership or drift damages user state | High | Manifest, backup, rollback, and symlink rules are untested proposals. [W0-03] | W1-02/W1-03 require provenance, exact-path preview, digest recheck, scoped backup, and partial-recovery reporting. |
| R3: native packaging differs from documented contract | High | CLI/RPC fixture ran; no package was installed. [W0-01] | W1-01 is first implementation gate; verify package resource loading on macOS and Linux before wider work. |
| R4: model sync changes a selected default or unowned entry | High | W0-04 establishes storage roles but no live sync; project settings can override user defaults. [W0-04] [Pi configuration] | W4-01 must resolve effective defaults, preserve or stop on selected-model changes, and prove sidecar identity and rollback. |
| R5: third-party skills or readers bring unsafe behavior or licensing | Medium | W0-05 is a source survey, with untested Pi loading and incomplete archive/tool review. [W0-05] | W2-02 pins a minimal set; later tickets test licenses, collision behavior, bounds, and file safety. |
| R6: memory content becomes trusted instruction by location | High | Pi loads some context files regardless of project trust. [W0-06] | Keep vault out of native paths; W6-02 validates a local, content-and-scope-bound activation gate. |
| R7: subagents widen authority or hang the parent | High | Tagged Pi capability/example exists, but Pify authority and lifecycle are unverified. [W0-07] | W7-01 enforces inherited scope, bounded concurrency, cancellation, and terminal outcomes. |
| R8: lossy optimization alters commands or evidence | Medium | RTK/Caveman candidates have no Pify fidelity proof; no verified selective pruning candidate. [W0-07] | W2-07 leaves them off unless golden-output and recovery checks pass. |
| R9: version or platform drift makes claims stale | Medium | Only Pi 1.4.0 was exercised; reports distinguish documented from observed. [W0-01] | Pin tested versions, rerun fixture and strict docs checks, and require W8-01 cross-platform review. |

## Wave 1–8 ticket map

Every row records the proposed point value and direct blocker list. “Confirm” retains the current issue values. “Clarify” or “Re-estimate” proposes the change described below; no GitHub ticket is edited by this document. Every ticket remains blocked transitively by W0-08, and the dependency graph has no missing code or cycle.

| Wave | Ticket | Points | Direct blockers | Proposal |
|---|---|---:|---|---|
| 1 | [W1-01 #20](https://github.com/fnayou/pify/issues/20) — Pify package installs into official Pi in an isolated fixture | 5 | W0-08 | Confirm |
| 1 | [W1-02 #21](https://github.com/fnayou/pify/issues/21) — Ownership manifest and scoped pre-change backup | 5 | W1-01 | Confirm |
| 1 | [W1-03 #22](https://github.com/fnayou/pify/issues/22) — Safe adoption, rollback, and uninstall for an existing Pi setup | 8 | W1-02 | Confirm |
| 1 | [W1-04 #23](https://github.com/fnayou/pify/issues/23) — Minimum permission modes and headless fail-closed contract | 8 | W1-01 | Clarify mediated-only guarantee |
| 1 | [W1-05 #24](https://github.com/fnayou/pify/issues/24) — Taskfile checks, strict docs build, and CalVer validation in CI | 2 | W0-08 | Confirm |
| 2 | [W2-01 #25](https://github.com/fnayou/pify/issues/25) — Read-only health check, install status, and inventory | 3 | W1-02 | Confirm |
| 2 | [W2-02 #26](https://github.com/fnayou/pify/issues/26) — Minimal verified skill set installs with provenance | 5 | W1-02 | Confirm |
| 2 | [W2-03 #27](https://github.com/fnayou/pify/issues/27) — Provider-neutral model path: local endpoint and one cloud provider | 8 | W1-01 | Confirm |
| 2 | [W2-04 #28](https://github.com/fnayou/pify/issues/28) — Per-project opt-in development workflow setup | 5 | W2-02 | Confirm |
| 2 | [W2-05 #29](https://github.com/fnayou/pify/issues/29) — Accurate onboarding docs and placeholder brand assets with drift check | 8 | W1-05 | Confirm |
| 2 | [W2-06 #30](https://github.com/fnayou/pify/issues/30) — New-install brand theme with existing theme and footer preserved | 5 | W1-03 | Confirm |
| 2 | [W2-07 #31](https://github.com/fnayou/pify/issues/31) — Existing optimization integrations verified; Caveman stays gated | 5 | W1-01 | Clarify optional, gated outcome |
| 3 | [W3-01 #32](https://github.com/fnayou/pify/issues/32) — Bounded filename and content search | 3 | W1-01 | Confirm |
| 3 | [W3-02 #33](https://github.com/fnayou/pify/issues/33) — Session-bound background jobs with inspect, log, and stop | 3 | W1-04 | Confirm |
| 3 | [W3-03 #34](https://github.com/fnayou/pify/issues/34) — Interactive choices and structured clarification | 2 | W1-04 | Confirm |
| 3 | [W3-04 #35](https://github.com/fnayou/pify/issues/35) — Portable redacted task handoff | 2 | W0-08 | Confirm |
| 3 | [W3-05 #36](https://github.com/fnayou/pify/issues/36) — Bounded read-only document and data inspection | 8 (was 3) | W1-01 | Re-estimate: 8 from 3 |
| 4 | [W4-01 #37](https://github.com/fnayou/pify/issues/37) — Explicit LM Studio synchronization with sidecar ownership | 8 | W1-02, W1-03, W2-03 (adds W1-02, W1-03) | Add W1-02 and W1-03 blockers; clarify default guard |
| 4 | [W4-02 #38](https://github.com/fnayou/pify/issues/38) — Cited multi-source research with budgets, off switch, and privacy boundary | 8 | W1-04, W2-03 | Confirm |
| 5 | [W5-01 #39](https://github.com/fnayou/pify/issues/39) — Full supported skill collections install | 8 | W2-02 | Confirm |
| 5 | [W5-02 #40](https://github.com/fnayou/pify/issues/40) — Explicit skill check and update with provenance and snapshots | 8 | W5-01 | Confirm |
| 5 | [W5-03 #41](https://github.com/fnayou/pify/issues/41) — Selective cross-agent instruction-file recognition | 5 | W1-01 | Confirm |
| 5 | [W5-04 #42](https://github.com/fnayou/pify/issues/42) — Per-project workflow state in health check and clean opt-out | 5 | W2-01, W2-04 | Confirm |
| 6 | [W6-01 #43](https://github.com/fnayou/pify/issues/43) — Optional empty vault scaffold with create, connect, or skip | 8 | W1-02 | Confirm |
| 6 | [W6-02 #44](https://github.com/fnayou/pify/issues/44) — Local approval registry and reviewed preference snapshot | 8 | W6-01 | Confirm |
| 6 | [W6-03 #45](https://github.com/fnayou/pify/issues/45) — Private memory repository push and pull with manual PR merge | 8 | W6-02 | Confirm |
| 6 | [W6-04 #46](https://github.com/fnayou/pify/issues/46) — Reviewed memory-to-skill draft promotion | 5 | W6-02 | Confirm |
| 7 | [W7-01 #47](https://github.com/fnayou/pify/issues/47) — Task-scoped subagents with inherited scope, cancellation, and concurrency limits | 8 | W1-04, W2-03 | Confirm |
| 7 | [W7-02 #48](https://github.com/fnayou/pify/issues/48) — Subagent status feed and inspectable dashboard | 8 | W7-01 | Confirm |
| 7 | [W7-03 #49](https://github.com/fnayou/pify/issues/49) — Advanced permission policy hardening | 8 | W1-04 | Confirm |
| 7 | [W7-04 #50](https://github.com/fnayou/pify/issues/50) — Git conflict resolution with validation and no implicit commit or push | 8 | W1-04 | Confirm |
| 7 | [W7-05 #51](https://github.com/fnayou/pify/issues/51) — Risk-aware bulk and high-impact edit previews | 5 | W1-04 | Confirm |
| 7 | [W7-06 #52](https://github.com/fnayou/pify/issues/52) — Opt-in footer adapter over stable status data | 3 | W7-02 | Confirm |
| 7 | [W7-07 #53](https://github.com/fnayou/pify/issues/53) — Explicitly authorized atomic commits | 5 | W1-04 | Confirm |
| 8 | [W8-01 #54](https://github.com/fnayou/pify/issues/54) — Cross-platform validation, security review, and drift hardening | 8 | W2-01, W2-05, W7-03 | Confirm |
| 8 | [W8-02 #55](https://github.com/fnayou/pify/issues/55) — Explicit release checks, updates with rollback, and CalVer change records | 5 | W1-03, W8-01 | Confirm |

**Point totals:** Wave 1 28; Wave 2 39; Wave 3 **18 proposed** (13 current); Wave 4 16; Wave 5 26; Wave 6 29; Wave 7 45; Wave 8 13. Total **214 proposed** (209 current). W3-05 increases from 3 to 8 points because its single ticket spans PDF, three Office formats, CSV/JSON, archives, SQLite, file metadata, bounded output, and read-only safety; W0-05 did not settle the archive or SQLite tool path. Keep the approved format scope within that one provisional ticket. [W0-05] [#36]

**Scope and dependency revisions proposed for owner approval:**

- **W1-04 / #23:** Keep 8 points and W1-01 blocker. State that Safe/Balanced/Full guarantees apply only to Pify-mediated paths; report OS-level limits. [W0-02]
- **W2-07 / #31:** Keep 5 points and W1-01 blocker. Treat “no compatible candidate” as a valid finding; preserve existing user configuration and leave new optimization disabled. No selective context-pruning candidate was verified. [W0-07]
- **W3-05 / #36:** Keep the full one-ticket scope and W1-01 blocker; raise estimate from 3 to 8 points. [W0-05]
- **W4-01 / #37:** Keep 8 points and W2-03 blocker. Add W1-02 and W1-03 as direct blockers because sidecar ownership and atomic rollback depend on those contracts. Explicitly test project/user default precedence and preserve-or-stop on selected-model changes. [W0-03] [W0-04]

All other ticket scopes, direct blockers, and point values are proposed unchanged. The existing `needs-info` labels remain appropriate until each implementation ticket gets its detailed design and acceptance proof. Owner approval of this package does not itself validate any product behavior.

## Owner decision and handoff

The owner must review this package and the linked Wave 0 evidence, then record **approve** or **reject** on [issue #19](https://github.com/fnayou/pify/issues/19). The decision should name the architecture, the ticket-map revisions above, any conditions, and whether Wave 1 implementation may begin. A rejection returns the package for revision. No Wave 1–8 implementation starts before an explicit approval.

Open implementation choices can remain ticket gates: manifest format/location and recovery retention (W1-02/W1-03); exact Pify mediation coverage and result schema (W1-04); local/cloud endpoint behavior (W2-03); sidecar compatibility and default preservation (W4-01); memory activation (W6-02); and subagent API/authority (W7-01). Approval accepts these as unresolved work, not as validated claims.

## Validation for this package

- Compare all 36 rows with the issue tracker, including blocker codes and point sums.
- Check every architectural claim and risk against a linked Wave 0 report; treat an upstream source statement as documented until exercised.
- Run `git diff --check` and the strict documentation build before the review PR is merged.

[W0-01]: pi-1.4.0-contract.md
[W0-02]: w0-02-permission-feasibility.md
[W0-03]: w0-03-adoption-rollback-design.md
[W0-04]: w0-04-provider-model-storage.md
[W0-05]: w0-05-skill-survey.md
[W0-06]: w0-06-memory-trust.md
[W0-07]: w0-07-execution-feasibility.md
[Pi configuration]: https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md
[#36]: https://github.com/fnayou/pify/issues/36
