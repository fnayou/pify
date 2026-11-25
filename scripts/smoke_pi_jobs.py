"""Exercise session-bound Pify jobs through official Pi 1.6.0 RPC."""

import json
import os
import select
import subprocess
import tempfile
import time
from pathlib import Path

from smoke_pi_workflow import PACKAGE_ROOT, notice, rpc, run_pi


class Session:
    def __init__(self, workspace: Path, env: dict[str, str], scope: str, mode: str = "balanced"):
        self.process = subprocess.Popen(
            ["pi", "--offline", "--no-mcp", "--no-session", "--mode", "rpc", "--approve",
             "--pify-mode", mode, "--pify-scope", scope],
            cwd=workspace, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.pending = bytearray()

    def prompt(self, request_id: str, message: str) -> dict:
        command = {"id": request_id, "type": "prompt", "message": message}
        assert self.process.stdin is not None and self.process.stdout is not None
        self.process.stdin.write(json.dumps(command).encode() + b"\n")
        self.process.stdin.flush()
        records = []
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.process.stdout], [], [], 0.2)
            if ready:
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    break
                self.pending.extend(chunk)
                while b"\n" in self.pending:
                    line, _, rest = self.pending.partition(b"\n")
                    self.pending = bytearray(rest)
                    records.append(json.loads(line))
            if any(item.get("type") == "response" and item.get("id") == request_id for item in records) and any(item.get("method") == "notify" for item in records):
                response = next(item for item in records if item.get("type") == "response" and item.get("id") == request_id)
                if not response.get("success") or response.get("data", {}).get("disposition") != "handled":
                    raise AssertionError(f"Job command was not handled: {records}")
                return notice(records)
        raise AssertionError(f"Timed out waiting for {request_id}: {records}")

    def close(self) -> None:
        assert self.process.stdin is not None and self.process.stderr is not None
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
            raise AssertionError("Pi did not stop its session-bound jobs on exit")
        if self.process.returncode != 0:
            raise AssertionError(f"Pi RPC exited {self.process.returncode}: {self.process.stderr.read().decode()}")


def group_alive(pid: int) -> bool:
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-jobs-smoke-") as temporary:
        root = Path(temporary).resolve()
        agent = root / "agent"
        workspace = root / "workspace"
        agent.mkdir()
        workspace.mkdir()
        env = os.environ.copy()
        env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})
        if run_pi(["--version"], workspace, env).strip() != "1.6.0":
            raise AssertionError("Pi 1.6.0 fixture required")
        run_pi(["install", str(PACKAGE_ROOT)], workspace, env)

        denied = notice(rpc(workspace, env, {"id": "denied", "type": "prompt", "message": "/pify-job start sleep 30"}))
        if denied.get("status") != "not_started" or denied.get("permission", {}).get("outcome") != "clarification_required":
            raise AssertionError(f"Headless start did not fail closed: {denied}")

        session = Session(workspace, env, "jobs/current-workspace")
        orphan_pid = None
        try:
            started = session.prompt("start", "/pify-job start printf ready; sleep 30")
            if started.get("state") != "running" or not started.get("pid"):
                raise AssertionError(f"Job did not start: {started}")
            job_id = started["id"]
            inspected = session.prompt("inspect", f"/pify-job inspect {job_id}")
            if inspected.get("id") != job_id or inspected.get("state") != "running":
                raise AssertionError(f"Job inspect failed: {inspected}")
            for _ in range(20):
                logged = session.prompt("log", f"/pify-job log {job_id}")
                if "ready" in logged.get("stdout", ""):
                    break
                time.sleep(0.05)
            else:
                raise AssertionError(f"Job log missing output: {logged}")
            listed = session.prompt("list", "/pify-job list")
            if len(listed) != 1 or listed[0]["id"] != job_id:
                raise AssertionError(f"Job list failed: {listed}")
            stopped = session.prompt("stop", f"/pify-job stop {job_id}")
            if stopped.get("outcome") != "stopped" or group_alive(started["pid"]):
                raise AssertionError(f"Job stop left a process: {stopped}")

            orphan = session.prompt("start-again", "/pify-job start sleep 30")
            orphan_pid = orphan["pid"]
        finally:
            session.close()
        if orphan_pid is None or group_alive(orphan_pid):
            raise AssertionError(f"Session exit left job group {orphan_pid} running")

        for mode in ("safe", "balanced", "full"):
            marker = workspace / f"nested-{mode}.txt"
            command = f"/pify-job start sh -c 'printf nested > {marker.name}'"
            unscoped = Session(workspace, env, "", mode)
            try:
                blocked = unscoped.prompt(f"unscoped-{mode}", command)
                if blocked.get("permission", {}).get("outcome") != "clarification_required" or marker.exists():
                    raise AssertionError(f"Unscoped nested command ran in {mode}: {blocked}")
            finally:
                unscoped.close()
            scoped = Session(workspace, env, "jobs/current-workspace", mode)
            try:
                result = scoped.prompt(f"scoped-{mode}", command)
                if mode == "safe":
                    if result.get("permission", {}).get("outcome") != "denied" or marker.exists():
                        raise AssertionError(f"Safe nested command ran: {result}")
                else:
                    if not result.get("id"):
                        raise AssertionError(f"Scoped nested command did not start in {mode}: {result}")
                    for attempt in range(40):
                        state = scoped.prompt(f"inspect-{mode}-{attempt}", f"/pify-job inspect {result['id']}")
                        if state.get("state") == "succeeded":
                            break
                        time.sleep(0.05)
                    else:
                        raise AssertionError(f"Nested command did not finish in {mode}: {state}")
                    if marker.read_text() != "nested":
                        raise AssertionError(f"Nested command output missing in {mode}")
            finally:
                scoped.close()
        print(f"Pify session jobs smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
