# Bootstrap theme selection

Pify is a bootstrap project. The private Pi package declares `themes/pify.json`, an original role mapping using the repository's Catppuccin Macchiato Red palette. It does not include a footer component or replace another extension's footer. The theme is tested against Pi 1.4.0; this is not a public release.

On the first interactive session after package installation, the Pify extension selects `pify` only when the agent-level `settings.json` has no `theme` key and Pi's active theme is still `system`. Pi's `setTheme()` saves that selection. A saved theme, including an explicit `system` choice, is preserved. An already active project or temporary theme is preserved.

`/pify-theme status` shows the saved choice and whether Pify has an approved change to roll back. `/pify-theme enable` asks for confirmation before replacing a saved theme in the Pi terminal. Headless callers need the exact `--pify-scope settings.json`; without it, the command returns a structured clarification and writes nothing. The command records the prior `theme` value, caller, and approval source in a private Pify journal before changing only that setting. `/pify-theme rollback` restores the prior theme; when the previous key was absent, it selects `system` explicitly so the fresh-install default does not reapply. Other settings and user-managed footer resources are preserved. A later personal theme change blocks rollback rather than being overwritten.

The journal is `pify-state/theme-selection.json` in the agent directory, separate from the regular-file ownership manifest. It remains for review after rollback. Theme selection does not adopt or own Pi's entire settings file. Concurrent settings writers are outside this bootstrap contract.

Pi contracts: [theme files and selection](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/themes.md) and [settings](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/settings.md).
