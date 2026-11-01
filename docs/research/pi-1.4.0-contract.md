# Pi 1.4.0 contract evidence

Status: bootstrap research for [issue #12](https://github.com/fnayou/pify/issues/12). Pify has no released features; this page records what was checked about the Pi runtime, not anything Pify ships.

Checked on 2026-11-01 on macOS. Pi 1.4.0 is the verified target. This report asserts no support range for other Pi versions, because the tagged documentation states none.

## Sources

All links point at the `v1.4.0` tag of the official repository. The release was published on 2026-10-21.

- [Release v1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0)
- [Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md)
- [Command line](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/cli.md)
- [Pi packages](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/packages.md)
- [Extensions](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md)
- [Security and project trust](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md)
- [RPC mode](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/rpc.md)

## How evidence is labeled

- **Observed**: run against the locally installed `pi` 1.4.0.
- **Documented**: stated in the tagged documentation above and not exercised.
- **Unverified**: not shown either way.

## Observed

- `pi --version` prints `1.4.0`.
- `pi --help` lists the commands `install`, `remove`, `uninstall`, `update`, `list`, `config`, `auth` and `mcp`. It also lists the flags `--offline`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, `--no-context-files`, `--no-mcp`, `--no-approve`, `--no-tools`, `--no-session` and `--mode`, and the environment variables `PI_CODING_AGENT_DIR` and `PI_OFFLINE`.
- With an isolated agent directory, `pi list` reports `No packages installed.` and `pi install --help` prints usage without installing anything.
- The RPC reproduction below started the runtime, answered one `get_state` request with `success:true`, and exited with code 0 after stdin reached end of file. No model was called.
- The `get_state` response described an unconfigured placeholder model with the model name `unknown`, thinking level `off`, no streaming, no compaction in progress, and zero messages. The response contained no credentials.
- After the checks, the isolated agent directory contained `auth.json` and `models-store.json`, each two bytes. Their creator and the command that created them were not proven.

## Reproduce offline RPC get_state

The command starts Pi in RPC mode against a throwaway agent directory and an empty working directory, sends one documented request, and closes stdin. It makes no model call and installs nothing.

```sh
FIXTURE="$(mktemp -d)"
mkdir "$FIXTURE/agent" "$FIXTURE/workspace"
printf '{"id":"req-1","type":"get_state"}\n' > "$FIXTURE/get_state.jsonl"
cd "$FIXTURE/workspace"
PI_CODING_AGENT_DIR="$FIXTURE/agent" PI_OFFLINE=1 pi --offline \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-mcp --no-approve --no-tools --no-session \
  --mode rpc < "$FIXTURE/get_state.jsonl"
echo "exit=$?"
```

Expected on 1.4.0: one JSONL line with `"type":"response"`, `"command":"get_state"` and `"success":true`, then `exit=0`. The record shape and the stdin-close shutdown come from the RPC documentation.

Reproduction limits:

- The observed run used an agent directory that already held the two files named above. Starting from a freshly created empty agent directory, as in the command, was not run.
- The response field names are observed values. They were not checked against the RPC command reference.
- Delete the temporary directory when done.

## Documented, not exercised

Package mechanism ([packages](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/packages.md)):

- A package is a directory or npm package that can declare resources under a `pi` key in `package.json`, with `extensions`, `skills`, `prompts` and `themes` arrays that accept globs and exclusions.
- Without a manifest, Pi discovers `extensions/`, `skills/`, `prompts/` and `themes/` directories inside the package.
- Sources are `npm:`, `git:`, an `https://` git URL, or a local path. Versioned npm specifications, git tags and commits are pinned.
- Host-provided packages such as `@earendil-works/pi-coding-agent` belong in `peerDependencies`, not `dependencies`.

Extension mechanism ([extensions](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md)):

- An extension is a TypeScript or JavaScript module whose default export is a factory that receives an `ExtensionAPI` object.
- The documented registration calls include `pi.on()`, `pi.registerTool()`, `pi.registerCommand()`, `pi.registerFlag()`, `pi.registerShortcut()`, `pi.registerProvider()` and `pi.registerMcpServer()`.
- Extensions run inside the Pi process with the same operating system permissions. The documentation defers exact signatures to a type file on the `main` branch, which is not pinned to 1.4.0.

Configuration and trust ([configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/configuration.md), [security](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md), [CLI](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/cli.md)):

- `PI_CODING_AGENT_DIR` sets the agent directory, which defaults to `~/.pi/agent`. Project configuration lives in `.pi` and loads only after project trust is granted.
- Trust is decided by a command-line `--approve` or `--no-approve`, then extensions, then a saved decision, then the `defaultProjectTrust` setting.
- Context files such as `AGENTS.md` and `CLAUDE.md` load regardless of trust unless `--no-context-files` is set.

## Unverified

- Installing a package, and package discovery from a manifest.
- Loading an extension and calling any registration API.
- Whether the resource-disabling flags change behavior. Pi accepted them without error, and `get_state` does not expose their effect.
- Project trust behavior, including the saved-decision file location when the agent directory is overridden.
- A prompted run against a real model, and any RPC command other than `get_state`.
- Session persistence. `--no-session` was used throughout.
- A repeat on Linux.
- The user's real Pi configuration was not diffed. Every Pi command set `PI_CODING_AGENT_DIR` to the throwaway directory and no install ran, but no before-and-after comparison of the default agent directory was taken.

## Drift risks

- The extension type declarations that define exact signatures are linked from the documentation on `main`, not on the tag. Re-read them at the tag before depending on a signature.
