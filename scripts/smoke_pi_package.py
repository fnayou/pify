"""Exercise the Pify package through official Pi in an isolated fixture."""

import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def run_pi(args: list[str], workspace: Path, env: dict[str, str], input_text: str | None = None) -> str:
    result = subprocess.run(
        ["pi", *args],
        cwd=workspace,
        env=env,
        input=input_text,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(f"pi {' '.join(args)} failed ({result.returncode}): {result.stderr}")
    return result.stdout


def snapshot(directory: Path) -> dict[str, bytes]:
    return {str(path.relative_to(directory)): path.read_bytes() for path in directory.rglob("*") if path.is_file()}


def run_health_rpc(workspace: Path, env: dict[str, str]) -> list[dict]:
    process = subprocess.Popen(
        ["pi", "--offline", "--no-mcp", "--no-session", "--mode", "rpc"],
        cwd=workspace, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    records = []
    pending = bytearray()
    try:
        assert process.stdin is not None and process.stdout is not None
        process.stdin.write(b'{"id":"health","type":"prompt","message":"/pify-health"}\n')
        process.stdin.flush()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            ready, _, _ = select.select([process.stdout], [], [], 0.2)
            if ready:
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                pending.extend(chunk)
                while b"\n" in pending:
                    line, _, remainder = pending.partition(b"\n")
                    pending = bytearray(remainder)
                    records.append(json.loads(line))
            if any(item.get("id") == "health" and item.get("type") == "response" for item in records) and any(
                item.get("type") == "extension_ui_request" and item.get("method") == "notify" for item in records
            ):
                break
        else:
            raise AssertionError(f"Pify health RPC timed out: {records}")
    finally:
        if process.stdin is not None:
            process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if process.returncode != 0:
        assert process.stderr is not None
        raise AssertionError(f"Pify health RPC failed ({process.returncode}): {process.stderr.read().decode()}")
    return records


def check_tui(workspace: Path, env: dict[str, str]) -> None:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    process = subprocess.Popen(
        ["pi", "--offline", "--no-mcp", "--no-session"],
        cwd=workspace,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    os.close(slave)
    output = bytearray()
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(f"Pi TUI exited during startup ({process.returncode}): {output[-500:]!r}")
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                output.extend(os.read(master, 65536))
            if output and time.monotonic() < deadline - 8:
                break
        if not output:
            raise AssertionError("Pi TUI produced no terminal output within 10 seconds")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        os.close(master)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-package-smoke-") as fixture:
        root = Path(fixture).resolve()
        agent = root / "agent"
        workspace = root / "workspace"
        agent.mkdir()
        workspace.mkdir()
        env = os.environ.copy()
        env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})

        version = run_pi(["--version"], workspace, env).strip()
        if version != "1.4.0":
            raise AssertionError(f"Pi 1.4.0 fixture required, got {version!r}")

        run_pi(["install", str(PACKAGE_ROOT)], workspace, env)
        listing = run_pi(["list"], workspace, env)
        if str(PACKAGE_ROOT) not in listing:
            raise AssertionError(f"Pify missing from pi list: {listing}")

        settings = json.loads((agent / "settings.json").read_text())
        packages = settings.get("packages", [])
        if len(packages) != 1 or not isinstance(packages[0], str):
            raise AssertionError(f"Expected one local Pi package declaration, got {packages!r}")
        resolved_package = (agent / packages[0]).resolve()
        if resolved_package != PACKAGE_ROOT:
            raise AssertionError(
                f"Pi package declaration resolves to {resolved_package}, expected {PACKAGE_ROOT}"
            )

        rpc = run_pi(
            ["--offline", "--no-mcp", "--no-session", "--mode", "rpc"],
            workspace,
            env,
            '{"id":"smoke","type":"get_state"}\n',
        )
        responses = [json.loads(line) for line in rpc.splitlines()]
        if not any(item.get("type") == "response" and item.get("command") == "get_state" and item.get("success") is True for item in responses):
            raise AssertionError(f"Pi did not start an RPC session: {rpc}")

        before_health = (snapshot(agent), snapshot(workspace))
        health_records = run_health_rpc(workspace, env)
        handled = [item for item in health_records if item.get("id") == "health" and item.get("type") == "response"]
        notices = [item for item in health_records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
        if len(handled) != 1 or handled[0].get("data", {}).get("disposition") != "handled" or len(notices) != 1:
            raise AssertionError(f"Pify health command was not handled: {health_records}")
        report = json.loads(notices[0]["message"])
        if report["compatibility"]["status"] != "verified" or report["install"]["status"] != "installed" or report["inventory"]["managed"]:
            raise AssertionError(f"Unexpected Pify health report: {report}")
        if (snapshot(agent), snapshot(workspace)) != before_health:
            raise AssertionError("Pify health command modified the isolated fixture")

        check_tui(workspace, env)
        if list(workspace.iterdir()):
            raise AssertionError("Pi created project configuration or another workspace artifact")
        native_files = {path.name for path in agent.iterdir()}
        if native_files != {"auth.json", "models-store.json", "settings.json"}:
            raise AssertionError(f"Unexpected agent configuration files: {sorted(native_files)}")
        print(f"Pify native Pi package smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
