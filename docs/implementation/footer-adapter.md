# Optional subagent footer adapter

Pify remains a bootstrap project. The adapter is a separate extension at `extensions/pify-footer-adapter.js`. It is absent from `package.json`'s declared extensions, so ordinary Pify sessions do not load it. In a reviewed local checkout, opt in for one Pi session with `pi -e /absolute/path/to/pify/extensions/pify-footer-adapter.js` alongside the main Pify extension. Remove that `-e` argument on the next launch to remove the adapter.

The adapter listens only to the versioned `pify:subagents/status` event. It formats bounded active, queued, and completed counts, then publishes them as Pi's `pify-subagents` extension status. It subscribes in TUI sessions and clears its status and listener on shutdown. No subagent task, output, error, or provider text enters the footer label. `/pify-delegate status` starts the session status feed if no subagent task has run yet.

Pi's `setFooter` API replaces the whole footer. The adapter does not call it or edit any footer file. A custom footer can display the adapter status through Pi's documented `footerData.getExtensionStatuses()` map:

```js
const counters = footerData.getExtensionStatuses().get("pify-subagents");
```

A footer that already renders extension statuses needs no change. A footer that ignores them will continue to do so until its owner chooses to display this key. Removing the adapter leaves the custom footer file and its original rendering code unchanged.

The isolated Pi smoke loads a custom footer without the adapter, with it, and without it again. It checks the counter's visibility and compares the footer file's digest after every run on macOS and Linux.
