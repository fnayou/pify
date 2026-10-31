# Repository instructions

- Treat this `AGENTS.md` as the primary repository instruction file.
- Describe Pify as a bootstrap project. Planned features are not released until implemented and validated.
- Keep local source handoffs private. Exclude them from commits, pull requests, and published artifacts.
- Write only in the current worktree lane. In Herdr, use the `herdr-workers` skill; for linked worktrees, use the `worktree-lanes` skill.
- Follow the issue-first flow in [CONTRIBUTING.md](CONTRIBUTING.md). Keep changes scoped and report validation.

## Agent skills

### Issue tracker

GitHub Issues in `fnayou/pify`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context domain docs: root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
