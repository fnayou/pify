# Reviewed atomic commits

Pify remains a bootstrap project. `/pify-commit preview <JSON groups>` shows the complete before and after text for each selected file and returns a review code. The model-facing `pify_commit_preview` tool can produce the same read-only report. No preview stages, commits, or pushes. A commit requires the user's explicit `/pify-commit apply <reviewCode>` request. In the TUI, Pify shows the full preview again and asks the user to choose **Create commits**; **Decline** is the default. Headless callers must provide the review code and exact `--pify-scope git/commits/<repo-relative-path>` entries. Safe mode requires the same predeclared scope in the TUI.

Groups are an ordered JSON array of Conventional Commit subjects and exact file paths:

```json
[
  {"message":"feat: add parser","paths":["src/parser.mjs"]},
  {"message":"docs: explain parser","paths":["docs/parser.md"]}
]
```

Pify accepts 1 to 8 groups and at most 24 distinct paths. Each file must be a regular UTF-8 text file of at most 8,192 bytes, or a deletion of one. The complete preview is capped at 65,536 bytes. It refuses symlinks, ignored new files, unmerged paths, active Git operations, detached HEAD, stale review codes, and changes made after preview. Selected paths are interpreted relative to the current directory and shown relative to the repository root.

Each group becomes one commit on the current branch. Pify builds its tree in a private Git index, writes selected blobs without filters, and updates the branch. It then updates only those paths in the real index; unrelated staged and unstaged changes stay in place. Git hooks and signing do not run. Pify never pushes. The result lists commit IDs and paths. A later group or index update can fail after earlier commits exist; `partial` reports exactly which commits were created. Inspect `git status` and the reported commits before retrying. The batch is not a transaction across groups, and the checks are not an OS sandbox against concurrent processes.

The real-Git unit tests cover grouped history, preserved staging, remote isolation, stale previews, additions, deletions, and partial index failure. The Pi RPC smoke checks the command flow and headless scope on macOS and Linux.
