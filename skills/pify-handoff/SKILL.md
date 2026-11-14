---
name: pify-handoff
description: Write a private Markdown handoff so another agent can resume the current task.
argument-hint: What should the next session focus on?
disable-model-invocation: true
license: MIT
compatibility: Pi 1.5.2 on macOS and Linux; no extra tools required
metadata:
  source: https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/handoff/SKILL.md
  source-version: 4ae2317ddb22b046e26455e4f9c9b3aaaf62212d
  adaptation: Pify's private, redacted task handoff
---

# Hand off a task

1. Summarize the current task for a fresh agent. Use the user's arguments to focus the next session. Reference existing issues, commits, docs, or diffs instead of copying them.
2. Draft a Markdown note with **Task**, **Current state**, **Blockers**, **Next steps**, and **References**. State what was verified, what remains uncertain, and the first action the next agent should take. Add **Suggested skills** only when useful.
3. Redact credentials, tokens, passwords, private endpoints, personal data, and sensitive local content before writing. Replace each sensitive value with `[REDACTED]`; keep the fact needed to continue. Inspect quoted commands, URLs, logs, and filenames for hidden values. If you cannot make the note safe, stop and ask the user for a safe summary.
4. Save the note in a new private file under the operating system's temporary directory, outside the workspace and Pi's session or memory paths. Use file mode `0600`. Read it back and check every section and every sensitive value again. If the check fails, remove the file and fix the draft before retrying.
5. Return the absolute path and a one-line summary. Tell the next agent to read the note; it is a portable snapshot, not durable memory or a replacement for Pi's native session resume.
