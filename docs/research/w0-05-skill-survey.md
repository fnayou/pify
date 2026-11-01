# W0-05: skill, instruction, research and document source survey (issue #16)

Retrieved 2026-11-01 via page fetch (summarised by a fetch model, not raw file reads). Nothing was installed or run. "Verified" = stated on the cited primary page. "Unverified" = not stated there; owner spot-check or follow-up needed. Pify is a bootstrap project; nothing here is released.

## 1. Skill collections (approved sources)

| Field | mattpocock/skills | fnayou/agent-skills |
|---|---|---|
| Source | https://github.com/mattpocock/skills | https://github.com/fnayou/agent-skills |
| License | MIT, (c) 2026 Matt Pocock. https://github.com/mattpocock/skills/blob/main/LICENSE | MIT, (c) 2026 Aymen Fnayou. https://github.com/fnayou/agent-skills/blob/main/LICENSE |
| Supported install | Per README, per agent: Claude Code `claude plugin install mattpocock-skills@claude-plugins-official`; Codex `codex plugin marketplace add mattpocock/skills` + `codex plugin add mattpocock-skills@mattpocock`; Copilot plugin marketplace; Gemini `gemini skills install <git url> --path skills/engineering` (and `skills/productivity`); any other agent `npx skills@latest add mattpocock/skills -a <agent>` | `./scripts/install` (symlinks each skill into `~/.agents/skills` and `~/.claude/skills` style targets; refuses to replace existing files/dirs/different symlinks). `./scripts/install --check`, `./scripts/verify` |
| Update | Plugins self-update (Claude, Codex, Copilot). Gemini: re-run install. skills.sh route: `npx skills@latest update`; re-run `add` to pick up new skills | No separate update command documented. Links point into the checkout; moving/deleting checkout breaks them |
| Pi mention | Only in the generic command comment: `-a <agent>  # cursor, opencode, devin, windsurf, amp, pi` | README: "Codex, OpenCode, and Pi discover the shared Agent Skills location." |
| Status | Not stated | Not stated; 20 commits, no releases/packages |
| Pify state | Install route for Pi = `npx skills` (verified in README). Pi-specific testing: UNVERIFIED | Install route = `./scripts/install` (verified). Pi load behaviour of its symlinks: UNVERIFIED |

Matt skills listed in README (27): engineering user-invoked: ask-matt, grill-with-docs, triage, improve-codebase-architecture, setup-matt-pocock-skills, to-spec, to-tickets, implement, implement-spec, wayfinder, retro. Engineering model-invoked: prototype, diagnosing-bugs, research, tdd, domain-modeling, codebase-design, code-review, pr, wizard. Productivity user-invoked: grill-me, handoff, teach, to-questionnaire, wait-what. Productivity model-invoked: grilling, writing-for-agents.

fnayou/agent-skills skills seen on README page (list may be partial): worktree-lanes, project-presentation, agent-browser.

Notes (verified): README says pick one install route per agent, "installing both gives you every skill twice". Experimental/in-progress classification of Matt skills: not stated on the page; UNVERIFIED (needs per-skill review).

### Install tool: `skills` CLI (used by the Matt generic route)
| Field | Value |
|---|---|
| Source | https://github.com/vercel-labs/skills |
| License | MIT |
| Install/usage | Node.js >= 22.20; `npx skills add <repo>`, `npx skills update`, `npx skills check`, `npx skills use` |
| Pi support | https://github.com/vercel-labs/skills/blob/main/docs/agents.md lists agent value `pi`: project `.agents/skills/`, global `~/.agents/skills/` |
| Caveats | Labelled Vercel Labs; experimental commands may change; telemetry opt-out via `DISABLE_TELEMETRY=1` / `DO_NOT_TRACK=1`. Collision/provenance behaviour: UNVERIFIED |
| Relation to `skills.sh` in Matt README | Assumed same tool; the README links https://skills.sh/mattpocock/skills. Not verified |

## 2. Pi native skill discovery (Pi is MIT: https://github.com/earendil-works/pi)

Source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md

| Item | Finding |
|---|---|
| Discovery | Directories containing `SKILL.md`, found recursively in user and project skills dirs; also `~/.agents/skills/` and project `.agents/skills/` (searched from cwd up through ancestors, stopping at repo root) |
| User/project dirs | `<agent-dir>/skills/` and `.pi/skills/` (configuration.md). Default agent dir `~/.pi/agent` |
| Format | `SKILL.md` with frontmatter. Required `name` (<=64, lowercase/digits/hyphens) and `description` (<=1024). Optional `license`, `compatibility`, `metadata`, `allowed-tools` (experimental), `disable-model-invocation` |
| Collisions | "Name collisions keep the first discovered skill and produce a warning." |
| Precedence between locations | NOT defined in docs fetched. UNVERIFIED |
| Commands | `enableSkillCommands` (default true) registers `/skill:name` |
| Settings | `skills` array of files/dirs; user paths resolve from agent dir, project paths from `.pi`; globs, `!pattern`, `+path`, `-path` (settings.md) |
| Packages | `pi install npm:...`, `pi install git:...`, local path; `pi list`, `pi remove`, `pi update --extensions`; `-l` for project scope; conventional `skills/` dir or `pi` manifest in `package.json`; versions/tags pinned. https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md |
| Trust | Project `.pi/skills` and project `.agents/skills` need project trust; decline skips them. https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md |
| Security | Skills can direct the model to run programs; review third-party source first (packages.md) |

## 3. Instruction-file formats and precedence (Pi)

Sources: configuration.md and security.md in the same docs dir.

| File | Where | Effect | Trust |
|---|---|---|---|
| `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` | agent dir, cwd, parent dirs | Context files; apply in their dir and below | Loaded regardless of trust unless context loading disabled |
| `AGENTS.override.md` | any dir | Replaces `AGENTS.md`/`CLAUDE.md` in the SAME dir only | same |
| `SYSTEM.md` | `<agent-dir>/` or `.pi/` | Replaces default system prompt | `.pi/` needs trust |
| `APPEND_SYSTEM.md` | `<agent-dir>/` or `.pi/` | Adds to system prompt | `.pi/` needs trust |

Verified precedence: trusted project `.pi/` SYSTEM/APPEND file beats the same-named agent-dir file; same-name files are not combined. Within one dir, `AGENTS.override.md` over AGENTS/CLAUDE.

UNVERIFIED (not in docs fetched): whether AGENTS.md and CLAUDE.md in one dir are both loaded or one wins; concatenation order and parent-walk order; the flag/setting that disables context loading (security.md mentions "unless you disable context loading" without naming it). Also not found: Cursor and Copilot instruction files in Pi. Pi native support for them: UNVERIFIED (no evidence; spec 8.3 selective detection would be Pify's own work).

## 4. Research tools (spec 6.4: configurable web search + page retrieval; Firecrawl deferred)

| Tool | License | Install / use | Compat | Provenance | State |
|---|---|---|---|---|---|
| Firecrawl https://github.com/mendableai/firecrawl | AGPL-3.0 primarily; SDKs and some UI MIT (directories not listed on page) | Self-host guide: https://docs.firecrawl.dev/contributing/self-host ; `docker-compose.yaml`, `SELF_HOST.md` in repo | Self-host vs cloud feature parity UNVERIFIED | Upstream repo | DEFERRED per spec until owner's self-hosted instance exists. Not fetched beyond README |
| SearXNG https://github.com/searxng/searxng | AGPL-3.0 | Install guide at docs.searxng.org (not fetched) | JSON API availability UNVERIFIED | Upstream repo | Implied candidate only (privacy-preserving generic search). UNVERIFIED for Pify |
| Hosted search APIs (Brave, Tavily, Exa, etc.) | not surveyed | not surveyed | not surveyed | not surveyed | NOT SURVEYED; spec says "configurable", no provider named |

AGPL note: using Firecrawl or SearXNG as a separate self-run service differs from bundling; legal effect for Pify not assessed. Owner decision.

## 5. Document/data reading tools (spec 6.3: PDF, DOCX/XLSX/PPTX, CSV/JSON, archives, SQLite)

| Tool | License | Install | Formats (per page) | Platform | State |
|---|---|---|---|---|---|
| MarkItDown https://github.com/microsoft/markitdown | MIT | `pip install 'markitdown[all]'` or extras e.g. `[pdf,docx,pptx]`; also uv, conda, Docker | PDF, DOCX, PPTX, XLSX, CSV, JSON, XML, HTML, ZIP, images, audio, EPUB, YouTube | Python 3.10-3.14; Unix-style setup shown, Windows not documented; macOS/Linux explicit support not stated | Candidate. Runs with process privileges; page advises input sanitising. Bounded-output and archive-safety behaviour UNVERIFIED |
| Docling https://github.com/docling-project/docling | Code MIT; models have own licenses (not itemised) | `pip install docling` | PDF, DOCX, PPTX, XLSX, HTML, EPUB, images, audio, etc.; outputs Markdown/JSON | Python >= 3.10; macOS, Linux, Windows; x86_64 and arm64 | Candidate. Model download size/offline setup UNVERIFIED |
| Pandoc https://github.com/jgm/pandoc | GPL-2.0-or-later | See INSTALL.md (Homebrew, releases listed) | Reads docx, pptx, xlsx, odt, csv/tsv, json, epub etc. PDF is output only, NOT input | linux/macos/windows dirs in repo; platform list not stated | Candidate for Office/text; cannot read PDF |
| Poppler https://poppler.freedesktop.org/ | Not stated on page (UNVERIFIED; repo license file not read) | Distro packages; source tarball | Page does not mention `pdftotext` (UNVERIFIED) | Unofficial CI lists macOS and Windows; official CI Debian/Ubuntu/Fedora | Candidate for PDF text only if license and tool confirmed |
| SQLite https://www.sqlite.org/copyright.html | Public Domain | Not surveyed (`sqlite3` CLI availability on target machines UNVERIFIED) | SQLite DBs | not surveyed | Candidate; spec wants read-only default (a Pify setting) |
| CSV/JSON, archives | Not surveyed: no tool picked | n/a | n/a | n/a | NOT SURVEYED (zip/tar safety tooling open) |

## 6. Claim state summary

Verified from primary pages: MIT licenses of both skill repos, `skills` CLI, Pi, MarkItDown, Docling code; install commands quoted above; Pi skill/context discovery facts quoted above; Pandoc GPL-2.0+ and no PDF input; SQLite public domain; Firecrawl and SearXNG AGPL-3.0.

Unverified or open: Pi behaviour with Matt's `npx skills` output and fnayou symlinks (no live test, by rule); skill-location precedence; AGENTS.md vs CLAUDE.md co-loading and ordering; context-disable flag; Cursor/Copilot instruction handling; Poppler license/pdftotext; Docling model licenses; SearXNG JSON API; Firecrawl parity; hosted search providers; archive tooling; macOS/Linux compatibility of MarkItDown (not explicitly stated).

Method caveat: pages were read through a fetch-and-summarise tool. Owner spot-check against raw LICENSE files and docs is advised (matches issue test plan).

## 7. Exact sources

- https://github.com/mattpocock/skills (+ /blob/main/LICENSE)
- https://github.com/fnayou/agent-skills (+ /blob/main/LICENSE)
- https://github.com/vercel-labs/skills (+ /blob/main/docs/agents.md)
- https://github.com/earendil-works/pi (README, license)
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/{skills,settings,configuration,packages,security,usage,index}.md
- https://github.com/microsoft/markitdown
- https://github.com/docling-project/docling
- https://github.com/jgm/pandoc
- https://poppler.freedesktop.org/
- https://www.sqlite.org/copyright.html
- https://github.com/mendableai/firecrawl
- https://github.com/searxng/searxng
