"""Exercise reviewed text edits through official Pi RPC in isolated workspaces."""

import json
import os
import fcntl
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


def notice(events: list[dict]) -> dict:
    messages = [json.loads(event["message"]) for event in events
                if event.get("type") == "extension_ui_request" and event.get("method") == "notify"]
    if not messages:
        raise AssertionError(f"No Pify notification: {[event.get('type') for event in events]}")
    return messages[-1]


def command(rpc: RpcSession, message: str, number: int) -> dict:
    return notice(rpc.send({"id": f"edit-{number}", "type": "prompt", "message": message}, notification=True))


def check_mode(mode: str) -> None:
    with tempfile.TemporaryDirectory(prefix="pify-edit-smoke-") as temporary:
        root = Path(temporary)
        agent = root / "agent"
        workspace = root / "workspace"
        agent.mkdir()
        workspace.mkdir()
        for name in ("a.txt", "b.txt"):
            (workspace / name).write_text("old\n", encoding="utf-8")
        (workspace / "AGENTS.md").write_text("old instruction\n", encoding="utf-8")
        environment = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1"}
        rpc = RpcSession(workspace, environment, extra_args=[
            "--no-extensions", "-e", str(EXTENSION), "--pify-mode", mode,
            "--pify-scope", "a.txt,b.txt,AGENTS.md",
        ])
        try:
            preview = command(rpc, "/pify-edit preview old | new | a.txt,b.txt", 1)
            assert preview["status"] == "preview" and preview["risk"] == "high"
            assert [item["after"] for item in preview["files"]] == ["new\n", "new\n"]
            assert all((workspace / name).read_text() == "old\n" for name in ("a.txt", "b.txt"))
            assert command(rpc, "/pify-edit apply " + "0" * 20, 2)["status"] == "stale_preview"
            assert all((workspace / name).read_text() == "old\n" for name in ("a.txt", "b.txt"))
            assert command(rpc, "/pify-edit apply " + preview["reviewCode"], 3)["status"] == "applied"
            assert all((workspace / name).read_text() == "new\n" for name in ("a.txt", "b.txt"))
            high = command(rpc, "/pify-edit preview old | new | AGENTS.md", 4)
            assert high["status"] == "preview" and high["risk"] == "high"
            (workspace / "AGENTS.md").write_text("changed instruction\n", encoding="utf-8")
            assert command(rpc, "/pify-edit apply " + high["reviewCode"], 5)["status"] == "stale_preview"
            assert (workspace / "AGENTS.md").read_text() == "changed instruction\n"
        finally:
            rpc.close()

        (workspace / "a.txt").write_text("old\n", encoding="utf-8")
        unscoped = RpcSession(workspace, environment, extra_args=[
            "--no-extensions", "-e", str(EXTENSION), "--pify-mode", mode,
        ])
        try:
            preview = command(unscoped, "/pify-edit preview old | new | a.txt", 6)
            assert preview["risk"] == "ordinary"
            denied = command(unscoped, "/pify-edit apply " + preview["reviewCode"], 7)
            assert denied["outcome"] == "clarification_required"
            assert (workspace / "a.txt").read_text() == "old\n"
        finally:
            unscoped.close()


def check_tui_decision(mode: str, *, scoped: bool, apply: bool) -> None:
    with tempfile.TemporaryDirectory(prefix="pify-edit-tui-") as temporary:
        root = Path(temporary)
        agent = root / "agent"
        workspace = root / "workspace"
        agent.mkdir()
        workspace.mkdir()
        file = workspace / "a.txt"
        file.write_text("old\n", encoding="utf-8")
        environment = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"}
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
        args = [
            "pi", "--offline", "--no-mcp", "--no-context-files", "--no-session", "--approve",
            "--no-extensions", "-e", str(EXTENSION), "--pify-mode", mode,
        ]
        if scoped:
            args.extend(["--pify-scope", "a.txt"])
        process = subprocess.Popen(args, cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        output = bytearray()

        def until(marker: bytes, seconds: float = 10) -> None:
            deadline = time.monotonic() + seconds
            while marker not in output and time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], 0.2)
                if ready:
                    output.extend(os.read(master, 65536))
            if marker not in output:
                raise AssertionError(f"Pi TUI did not show {marker!r} in {mode}: {output[-1200:]!r}")

        try:
            until(f"Pify: {mode.title()}".encode())
            os.write(master, b"/pify-edit preview old | new | a.txt\r")
            until(b'"reviewCode":"')
            match = re.search(rb'"reviewCode":"([0-9a-f]{20})"', output)
            assert match, output[-1200:]
            assert file.read_text() == "old\n"
            os.write(master, b"/pify-edit apply " + match.group(1) + b"\r")
            until(b"Decline")
            os.write(master, b"\x1b[B\r" if apply else b"\r")
            expected = b'"status":"applied"' if apply and mode != "safe" else (
                b'"outcome":"clarification_required"' if apply else b'"status":"declined"')
            until(expected)
            assert file.read_text() == ("new\n" if apply and mode != "safe" else "old\n")
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            os.close(master)


if __name__ == "__main__":
    for selected_mode in ("safe", "balanced", "full"):
        check_mode(selected_mode)
        check_tui_decision(selected_mode, scoped=True, apply=False)
        check_tui_decision(selected_mode, scoped=False, apply=True)
        print(f"{selected_mode}: complete previews, approval, scope, stale refusal, and TUI decisions verified")
