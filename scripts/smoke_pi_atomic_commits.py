"""Exercise reviewed Git commits through Pi RPC in an isolated repository."""

import json
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

from smoke_pi_models import RpcSession


EXTENSION = Path(__file__).resolve().parents[1] / "extensions" / "pify-permissions.js"


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def command(rpc: RpcSession, message: str, number: int) -> dict:
    events = rpc.send({"id": f"commit-{number}", "type": "prompt", "message": message}, notification=True)
    notices = [json.loads(event["message"]) for event in events
               if event.get("type") == "extension_ui_request" and event.get("method") == "notify"]
    assert notices, events
    return notices[-1]


def check_tui_decline(workspace: Path, agent: Path, original: str) -> None:
    environment = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"}
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
    process = subprocess.Popen([
        "pi", "--offline", "--no-mcp", "--no-context-files", "--no-session", "--approve",
        "--no-extensions", "-e", str(EXTENSION), "--pify-mode", "balanced",
    ], cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def until(marker: bytes) -> None:
        deadline = time.monotonic() + 10
        while marker not in output and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                output.extend(os.read(master, 65536))
        assert marker in output, output[-1200:]

    try:
        until(b"Pify: Balanced")
        groups = [{"message": "fix: declined revision", "paths": ["feature.txt"]}]
        os.write(master, ("/pify-commit preview " + json.dumps(groups, separators=(",", ":")) + "\r").encode())
        until(b'"reviewCode":"')
        match = re.search(rb'"reviewCode":"([0-9a-f]{20})"', output)
        assert match, output[-1200:]
        os.write(master, b"/pify-commit apply " + match.group(1) + b"\r")
        until(b"Create commits")
        os.write(master, b"\r")
        until(b'"status":"declined"')
        assert git(workspace, "rev-parse", "HEAD") == original
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        os.close(master)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-commit-smoke-") as temporary:
        root = Path(temporary)
        workspace = root / "work"
        remote = root / "remote.git"
        agent = root / "agent"
        workspace.mkdir()
        agent.mkdir()
        git(root, "init", "-q", "--bare", str(remote))
        git(workspace, "init", "-q", "-b", "main")
        git(workspace, "config", "user.name", "Pify Fixture")
        git(workspace, "config", "user.email", "pify@example.test")
        for name in ("feature.txt", "guide.txt", "unrelated.txt", "unstaged.txt"):
            (workspace / name).write_text("before\n", encoding="utf-8")
        git(workspace, "add", "-A")
        git(workspace, "commit", "-qm", "chore: baseline")
        git(workspace, "remote", "add", "origin", str(remote))
        git(workspace, "push", "-q", "origin", "main")
        original = git(workspace, "rev-parse", "HEAD")
        (workspace / "feature.txt").write_text("feature after\n", encoding="utf-8")
        (workspace / "guide.txt").write_text("guide after\n", encoding="utf-8")
        (workspace / "unrelated.txt").write_text("unrelated staged\n", encoding="utf-8")
        git(workspace, "add", "unrelated.txt")
        (workspace / "unstaged.txt").write_text("unrelated unstaged\n", encoding="utf-8")
        groups = [
            {"message": "feat: update feature", "paths": ["feature.txt"]},
            {"message": "docs: update guide", "paths": ["guide.txt"]},
        ]
        environment = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1"}
        args = ["--no-extensions", "-e", str(EXTENSION), "--pify-mode", "safe",
                "--pify-scope", "git/commits/feature.txt,git/commits/guide.txt"]
        rpc = RpcSession(workspace, environment, extra_args=args)
        try:
            preview = command(rpc, "/pify-commit preview " + json.dumps(groups, separators=(",", ":")), 1)
            assert preview["status"] == "preview"
            assert [item["after"] for group in preview["groups"] for item in group["files"]] == ["feature after\n", "guide after\n"]
            assert git(workspace, "rev-parse", "HEAD") == original
            assert command(rpc, "/pify-commit apply " + "0" * 20, 2)["status"] == "stale_preview"
            committed = command(rpc, "/pify-commit apply " + preview["reviewCode"], 3)
            assert committed["status"] == "committed" and committed["pushed"] is False
            assert len(committed["commits"]) == 2
            assert git(workspace, "log", "-2", "--format=%s").splitlines() == ["docs: update guide", "feat: update feature"]
            assert git(workspace, "diff", "--cached", "--name-only") == "unrelated.txt"
            assert git(workspace, "diff", "--name-only") == "unstaged.txt"
            assert git(remote, "rev-parse", "refs/heads/main") == original
        finally:
            rpc.close()

        (workspace / "feature.txt").write_text("next revision\n", encoding="utf-8")
        unscoped = RpcSession(workspace, environment, extra_args=["--no-extensions", "-e", str(EXTENSION), "--pify-mode", "safe"])
        try:
            preview = command(unscoped, "/pify-commit preview " + json.dumps([groups[0]], separators=(",", ":")), 4)
            denied = command(unscoped, "/pify-commit apply " + preview["reviewCode"], 5)
            assert denied["outcome"] == "clarification_required"
            assert git(remote, "rev-parse", "refs/heads/main") == original
        finally:
            unscoped.close()

        check_tui_decline(workspace, agent, git(workspace, "rev-parse", "HEAD"))

    print("Pi: reviewed groups, exact scope, TUI decline, preserved staging, and no push verified")


if __name__ == "__main__":
    main()
