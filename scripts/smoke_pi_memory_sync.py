"""Exercise private-memory PR push and fast-forward pull through Pi RPC."""

import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

from smoke_pi_memory import command, scope
from smoke_pi_workflow import run_pi


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REMOTE = "https://github.com/fnayou/pify-memory-fixture.git"


def git(path: Path, env: dict[str, str], *args: str) -> str:
    return subprocess.run(["git", *args], cwd=path, env=env, check=True, capture_output=True, text=True).stdout.strip()


def sync_scope(vault: Path, action: str) -> str:
    return f"memory/sync-{action}/{hashlib.sha256(str(vault).encode()).hexdigest()}"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-memory-sync-smoke-") as fixture:
        root = Path(fixture).resolve()
        bare, vault, second, reviewer = (root / name for name in ("remote.git", "vault", "second", "reviewer"))
        agent, second_agent, workspace = (root / name for name in ("agent", "second-agent", "workspace"))
        for folder in (agent, second_agent, workspace):
            folder.mkdir()
        git(root, os.environ, "init", "--bare", "--initial-branch=main", str(bare))
        config = root / "gitconfig"
        config.write_text(f'[url "file://{bare}"]\n\tinsteadOf = {REMOTE}\n')
        bin_dir = root / "bin"
        bin_dir.mkdir()
        gh = bin_dir / "gh"
        gh.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
state = Path(os.environ['PIFY_TEST_GH_STATE'])
args = sys.argv[1:]
if args[:2] == ['repo', 'view']:
    print('true')
elif args[:2] == ['pr', 'list']:
    print(json.dumps(json.loads(state.read_text()) if state.exists() else []))
elif args[:2] == ['pr', 'create']:
    url = 'https://github.com/fnayou/pify-memory-fixture/pull/1'
    state.write_text(json.dumps([{'number': 1, 'url': url}]))
    print(url)
else:
    sys.exit('Unexpected gh command: ' + ' '.join(args))
""")
        gh.chmod(0o755)
        env = os.environ.copy()
        env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color",
                    "PATH": f"{bin_dir}{os.pathsep}{env['PATH']}", "GIT_CONFIG_GLOBAL": str(config),
                    "GIT_CONFIG_NOSYSTEM": "1", "PIFY_TEST_GH_STATE": str(root / "gh-state.json")})
        if run_pi(["--version"], workspace, env).strip() != "1.5.2":
            raise AssertionError("Pi 1.5.2 fixture required")
        run_pi(["install", str(PACKAGE_ROOT)], workspace, env)
        if command(workspace, env, "create", f"create {vault}", scope(vault)).get("status") != "created":
            raise AssertionError("Vault creation failed")
        git(vault, env, "init", "--initial-branch=main")
        git(vault, env, "config", "user.name", "Pify Test")
        git(vault, env, "config", "user.email", "pify-test@example.invalid")
        git(vault, env, "commit", "--allow-empty", "-m", "initial")
        git(vault, env, "remote", "add", "origin", REMOTE)
        git(vault, env, "push", "-u", "origin", "main")
        git(root, env, "clone", str(bare), str(second))
        git(second, env, "remote", "set-url", "origin", REMOTE)

        relative = "01-global/preferences/shared.md"
        (vault / relative).write_text("PIFY_SYNC_MARKER\n")
        (vault / ".obsidian").mkdir()
        (vault / ".obsidian" / "workspace.md").write_text("Excluded state\n")
        preview = command(workspace, env, "preview", "push-preview")
        if [change["relativePath"] for change in preview["changes"]] != [relative]:
            raise AssertionError(f"Push preview included wrong files: {preview}")
        denied = command(workspace, env, "denied", f"push {preview['reviewCode']}")
        if denied.get("outcome") != "clarification_required":
            raise AssertionError(f"Unscoped push was allowed: {denied}")
        pushed = command(workspace, env, "push", f"push {preview['reviewCode']}", sync_scope(vault, "push"))
        if pushed.get("status") != "pr_opened" or git(vault, env, "ls-remote", "--heads", "origin", "main").split()[0] == git(vault, env, "rev-parse", "HEAD"):
            raise AssertionError(f"Push skipped PR review: {pushed}")

        git(root, env, "clone", str(bare), str(reviewer))
        git(reviewer, env, "fetch", "origin", pushed["branch"])
        git(reviewer, env, "merge", "--ff-only", "FETCH_HEAD")
        git(reviewer, env, "push", "origin", "main")
        second_env = {**env, "PI_CODING_AGENT_DIR": str(second_agent)}
        run_pi(["install", str(PACKAGE_ROOT)], workspace, second_env)
        if command(workspace, second_env, "connect", f"connect {second}", scope(second)).get("status") != "connected":
            raise AssertionError("Second vault connection failed")
        pulled = command(workspace, second_env, "pull", "pull", sync_scope(second, "pull"))
        if pulled.get("status") != "fast_forwarded" or (second / relative).read_text() != "PIFY_SYNC_MARKER\n":
            raise AssertionError(f"Pull did not fast-forward: {pulled}")
        if command(workspace, second_env, "snapshot", "snapshot").get("entries"):
            raise AssertionError("Pulled note activated without local approval")
        print(f"Pify memory sync smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
