"""Resolve a real Git merge conflict through Pi without commit or push."""

import json
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


def git(cwd: Path, *args: str, expected: int = 0) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, check=False)
    if result.returncode != expected:
        raise AssertionError(f"git {args[0]} exited {result.returncode}: {result.stderr}")
    return result.stdout.strip()


def command(workspace: Path, env: dict[str, str], name: str, text: str, scope: str | None = None) -> dict:
    return notice(rpc(workspace, env, {"id": name, "type": "prompt", "message": f"/pify-conflict {text}"}, scope=scope))


def check_tui_decline(repo: Path, env: dict[str, str], original: bytes) -> None:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    process = subprocess.Popen(
        ["pi", "--offline", "--no-mcp", "--no-session", "--approve"],
        cwd=repo, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    os.close(slave)
    output = bytearray()
    try:
        deadline = time.monotonic() + 10
        while b"Pify: Balanced" not in output and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                output.extend(os.read(master, 65536))
        if b"Pify: Balanced" not in output:
            raise AssertionError(f"Pi TUI did not start: {output[-500:]!r}")
        os.write(master, b"/pify-conflict resolve data.json | theirs\r")
        deadline = time.monotonic() + 5
        while b"Stage this Git conflict resolution?" not in output and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                output.extend(os.read(master, 65536))
        if b"Stage this Git conflict resolution?" not in output:
            raise AssertionError(f"Pi TUI did not show the conflict review: {output[-1000:]!r}")
        os.write(master, b"\x1b")
        time.sleep(0.2)
        if (repo / "data.json").read_bytes() != original:
            raise AssertionError("Declined TUI conflict resolution changed the file")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        os.close(master)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-git-conflict-smoke-") as fixture:
        root = Path(fixture).resolve()
        agent, repo, remote = (root / name for name in ("agent", "repo", "remote.git"))
        agent.mkdir()
        repo.mkdir()
        env = os.environ.copy()
        env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})
        if run_pi(["--version"], repo, env).strip() != "1.5.2":
            raise AssertionError("Pi 1.5.2 fixture required")
        run_pi(["install", str(PACKAGE_ROOT)], repo, env)

        git(repo, "init", "-q", "-b", "main")
        git(repo, "config", "user.name", "Fixture")
        git(repo, "config", "user.email", "fixture@example.test")
        git(repo, "config", "merge.conflictstyle", "diff3")
        target = repo / "data.json"
        target.write_text('{"value":"base"}\n')
        git(repo, "add", "data.json")
        git(repo, "commit", "-qm", "base")
        git(repo, "branch", "side")
        git(repo, "switch", "-q", "side")
        target.write_text('{"value":"theirs"}\n')
        git(repo, "commit", "-qam", "theirs")
        git(repo, "switch", "-q", "main")
        target.write_text('{"value":"ours"}\n')
        git(repo, "commit", "-qam", "ours")
        git(root, "init", "--bare", "-q", str(remote))
        git(repo, "remote", "add", "origin", str(remote))
        git(repo, "push", "-q", "-u", "origin", "main")
        head = git(repo, "rev-parse", "HEAD")
        remote_head = git(root, "--git-dir", str(remote), "rev-parse", "refs/heads/main")
        git(repo, "merge", "side", expected=1)
        conflicted = target.read_bytes()
        unrelated = repo / "unrelated.txt"
        unrelated.write_text("keep staged\n")
        git(repo, "add", "unrelated.txt")
        unrelated_index = git(repo, "ls-files", "-s", "--", "unrelated.txt")

        listed = command(repo, env, "list", "list")
        if listed.get("status") != "listed" or [item["path"] for item in listed.get("conflicts", [])] != ["data.json"]:
            raise AssertionError(f"Git conflict list was wrong: {listed}")
        preview = command(repo, env, "preview", "preview data.json | theirs")
        if preview.get("status") != "ready" or preview.get("hunks") != 1 or "json_parse" not in preview.get("validation", []):
            raise AssertionError(f"Git conflict preview was not validated: {preview}")
        if preview.get("projectTests") != "not_run" or target.read_bytes() != conflicted:
            raise AssertionError("Preview changed the file or overstated project testing")
        denied = command(repo, env, "unscoped", "resolve data.json | theirs")
        if denied.get("outcome") != "clarification_required" or target.read_bytes() != conflicted:
            raise AssertionError(f"Unscoped conflict resolution changed the file: {denied}")
        check_tui_decline(repo, env, conflicted)
        resolved = command(repo, env, "resolve", "resolve data.json | theirs", scope="git/conflicts/data.json")
        if resolved.get("status") != "resolved" or not resolved.get("staged"):
            raise AssertionError(f"Git conflict was not resolved: {resolved}")
        if json.loads(target.read_text()) != {"value": "theirs"} or git(repo, "ls-files", "-u", "--", "data.json"):
            raise AssertionError("Resolved file or index is invalid")
        if git(repo, "ls-files", "-s", "--", "unrelated.txt") != unrelated_index:
            raise AssertionError("Unrelated staged file changed")
        if git(repo, "rev-parse", "HEAD") != head or git(root, "--git-dir", str(remote), "rev-parse", "refs/heads/main") != remote_head:
            raise AssertionError("Conflict resolution changed history or remote")
        if command(repo, env, "after", "list")["conflicts"]:
            raise AssertionError("Resolved conflict still appears unmerged")
        print(f"Pify Git conflict smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
