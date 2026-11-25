# Reviewed procedure to skill draft

Pify remains a bootstrap project. A locally approved note under `03-reference/procedures/` can become an inactive skill draft. Procedure approval is separate from preference activation: approved procedures never enter Pify's model prompt snapshot.

Review the procedure with `/pify-memory review <vault-relative note.md>`, then approve it with `/pify-memory approve <note>`. Approval checks the same local vault, file identity, content hash, and change time used for preferences. Editing, replacing, or revoking the note stops later promotion until it is reviewed and approved again.

Choose an absolute destination directory whose final name is a lowercase skill slug. Its parent must exist. `/pify-memory draft-preview <procedure> | <absolute directory>` shows the exact draft content and a review code. `/pify-memory draft <procedure> | <absolute directory>` confirms the content interactively. Headless use adds `| <review-code>` and the exact `memory/skill-draft/<sha256>` Pify scope target. The digest covers the selected vault's canonical path, the vault-relative procedure path, and the canonical destination directory, joined by NUL bytes.

Pify creates the chosen directory if needed and writes `SKILL.pify-draft.md` without replacing existing files. The draft has a skill name matching the directory and `disable-model-invocation: true` in its frontmatter. The isolated Pi 1.6.0 smoke does not advertise this draft filename as a skill. The source note stays unchanged. Pify does not rename the draft to `SKILL.md`, install it, commit it, or publish it. Review the draft and activate or publish it explicitly outside this command.

The Pi RPC smoke checks an approved and unapproved procedure, exact authorization, the chosen path, unchanged source, empty prompt snapshot, and absence from Pi's skill command list on macOS and Linux.
