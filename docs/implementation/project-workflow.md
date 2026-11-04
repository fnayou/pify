# Per-project development workflow

Pify is a bootstrap project. The full ticket and architecture workflow is opt-in for each project. The Pify package does not advertise this workflow globally.

Start Pi from the project root. `/pify-workflow status` reads the current project's state. In the Pi terminal, `/pify-workflow enable` shows the exact destination and asks for confirmation. In headless RPC mode, the caller must explicitly set `--pify-scope skills/pify-development-workflow/SKILL.md` before sending `/pify-workflow enable`; without that scope, the command returns a structured `clarification_required` result and writes nothing.

Enabling creates only `.pi/skills/pify-development-workflow/SKILL.md` in the current project. It refuses a different file, symlink, hard link, or unsafe parent at that path. It never edits `AGENTS.md`, `CONTRIBUTING.md`, `.pi/APPEND_SYSTEM.md`, or another project. A matching file already present reports `already_enabled`; Pify does not infer ownership from identical content.

Run `/reload` or start a new Pi session after enabling. Pi requires project trust before it loads `.pi/skills`. Declining trust leaves the skill unloaded. The skill asks for an issue and relevant design decision during code changes; it tells Pi to answer read-only questions directly. Projects without the skill file do not advertise this workflow.

`/pify-health` reports `enabled`, `disabled`, or `conflict` for the current project's exact skill path. A modified file reports `conflict`; Pify preserves it. The health report does not treat the project file as an agent-directory managed resource.

Pi contracts: [project configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md), [project trust](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md), and [skill discovery](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/skills.md).
