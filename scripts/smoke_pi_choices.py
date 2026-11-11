"""Check Pify choice prompts and headless clarification in official Pi 1.5.2."""

import fcntl
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

from smoke_pi_workflow import PACKAGE_ROOT, notice, rpc, run_pi


COMMAND = "/pify-choose Which environment? | staging | production"


def check_tui(workspace: Path, env: dict[str, str]) -> None:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    process = subprocess.Popen(
        ["pi", "--offline", "--no-mcp", "--no-session", "--approve"],
        cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    os.close(slave)
    output = bytearray()
    try:
        startup_deadline = time.monotonic() + 10
        while time.monotonic() < startup_deadline:
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                output.extend(os.read(master, 65536))
            if b"Pify: Balanced" in output:
                break
        else:
            raise AssertionError(f"Pi TUI did not start: {output[-500:]!r}")
        os.write(master, COMMAND.encode() + b"\r")
        prompt_deadline = time.monotonic() + 5
        while time.monotonic() < prompt_deadline:
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                output.extend(os.read(master, 65536))
            if b"Which environment?" in output and b"staging" in output and b"production" in output and b"escape/ctrl+c" in output:
                return
        raise AssertionError(f"Pi TUI did not show choice prompt: {output[-1000:]!r}")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        os.close(master)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-choices-smoke-") as temporary:
        root = Path(temporary).resolve()
        agent = root / "agent"
        workspace = root / "workspace"
        agent.mkdir()
        workspace.mkdir()
        env = os.environ.copy()
        env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})
        if run_pi(["--version"], workspace, env).strip() != "1.5.2":
            raise AssertionError("Pi 1.5.2 fixture required")
        run_pi(["install", str(PACKAGE_ROOT)], workspace, env)
        records = rpc(workspace, env, {"id": "choice", "type": "prompt", "message": COMMAND})
        result = notice(records)
        if result.get("schema") != "pify.permission-result/v1" or result.get("outcome") != "clarification_required":
            raise AssertionError(f"Headless choice did not request clarification: {result}")
        if result.get("missing") != ["Which environment?"] or result.get("options") != ["staging", "production"]:
            raise AssertionError(f"Clarification lost its choices: {result}")
        if any(item.get("method") == "select" for item in records):
            raise AssertionError("Headless choice waited for keyboard selection")
        check_tui(workspace, env)
        print(f"Pify choices smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
