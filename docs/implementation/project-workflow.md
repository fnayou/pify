# Per-project development workflow

Pify is a bootstrap project. The full ticket and architecture workflow is opt-in for each project. The Pify package does not advertise this workflow globally.

Start Pi from the project root. `/pify-workflow status` reads the current project's state. In the Pi terminal, `/pify-workflow enable` shows the exact destination and asks for confirmation. `/pify-workflow disable` asks before moving that project's workflow skill out of Pi discovery. In headless RPC mode, either change requires `--pify-scope skills/pify-development-workflow/SKILL.md`; without that exact scope, the command returns `clarification_required` and writes nothing.

Enabling creates `.pi/skills/pify-development-workflow/SKILL.md` in the current project and records its digest and canonical project path in private agent state. It refuses a different file, symlink, hard link, or unsafe parent at that path. It never edits `AGENTS.md`, `CONTRIBUTING.md`, `.pi/APPEND_SYSTEM.md`, or another project. An explicit enable can register an identical skill created before the private index existed; Pify does not infer ownership from identical content during a read-only check.

Disabling renames the exact recorded skill to `SKILL.pify-disabled.md` in the same project directory. Pi discovers directories containing `SKILL.md`, so the preserved copy is no longer advertised. Pify refuses a changed skill or an existing disabled-path collision. A later explicit enable restores the bytes. No project file is deleted. A failed index update leaves an observable mismatch; retry the same action after fixing the error.

Run `/reload` or start a new Pi session after enabling. Pi requires project trust before it loads `.pi/skills`. Declining trust leaves the skill unloaded. The skill asks for an issue and relevant design decision during code changes; it tells Pi to answer read-only questions directly. Projects without the skill file do not advertise this workflow.

`/pify-health` reports `enabled`, `disabled`, or `conflict` for the current project's exact skill path. It also lists indexed project paths and their verified states; a moved, missing, or edited skill appears as a conflict. The index is mode `0600` under a `0700` agent-state directory. A modified file is preserved. The health report does not treat project files as agent-directory managed resources.

Pi contracts: [project configuration](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/configuration.md), [project trust](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/security.md), and [skill discovery](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/skills.md).
