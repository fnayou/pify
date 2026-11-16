"""Verify Pi subagents queue, cancel, and leave the parent RPC responsive."""

import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from smoke_pi_models import RpcSession, start_server
from smoke_pi_workflow import run_pi


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def prompt(session: RpcSession, name: str, command: str) -> dict:
    events = session.send({"id": name, "type": "prompt", "message": f"/pify-delegate {command}"}, notification=True)
    notices = [item for item in events if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
    if len(notices) != 1:
        raise AssertionError(f"Expected one subagent notice: {events}")
    return json.loads(notices[0]["message"])


def wait_state(session: RpcSession, job_id: str, state: str, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = prompt(session, f"inspect-{time.monotonic_ns()}", f"inspect {job_id}")
        if result.get("state") == state:
            return result
        time.sleep(0.05)
    raise AssertionError(f"Subagent {job_id} never reached {state}: {result}")


def main() -> None:
    server = start_server("local")
    try:
        with tempfile.TemporaryDirectory(prefix="pify-subagent-smoke-") as fixture:
            root = Path(fixture).resolve()
            agent, workspace, bin_dir = (root / name for name in ("agent", "workspace", "bin"))
            for folder in (agent, workspace, bin_dir):
                folder.mkdir()
            original_pi = shutil.which("pi")
            if not original_pi:
                raise AssertionError("Pi executable required")
            env = os.environ.copy()
            env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})
            if run_pi(["--version"], workspace, env).strip() != "1.5.2":
                raise AssertionError("Pi 1.5.2 fixture required")
            run_pi(["install", str(PACKAGE_ROOT)], workspace, env)
            agent.joinpath("models.json").write_text(json.dumps({"providers": {
                provider: {"baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions",
                           "apiKey": "fixture-key", "models": [{"id": "fixture-local", "contextWindow": 8192, "maxTokens": 256}]}
                for provider in ("fixture-a", "fixture-b")
            }}))
            wrapper = bin_dir / "pi"
            wrapper.write_text("""#!/usr/bin/env python3
import json, os, signal, sys, time
real = os.environ['PIFY_TEST_REAL_PI']
if os.environ.get('PIFY_SUBAGENT_CHILD') != '1':
    os.execv(real, [real, *sys.argv[1:]])
task = sys.argv[-1]
if 'PIFY_REAL_' in task:
    os.execv(real, [real, *sys.argv[1:]])
if 'PIFY_STUCK_' in task:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True:
        time.sleep(1)
time.sleep(1)
print(json.dumps({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'fixture worker done'}],'stopReason':'stop'}}), flush=True)
print(json.dumps({'type':'agent_settled','aborted':False}), flush=True)
""")
            wrapper.chmod(0o755)
            env.update({"PIFY_TEST_REAL_PI": original_pi, "PATH": f"{bin_dir}{os.pathsep}{env['PATH']}"})

            denied = RpcSession(workspace, env)
            try:
                denied.send({"id": "model", "type": "set_model", "provider": "fixture-a", "modelId": "fixture-local"})
                result = prompt(denied, "unscoped", "start PIFY_QUICK_unscoped")
                if result.get("outcome") != "clarification_required":
                    raise AssertionError(f"Unscoped delegation started: {result}")
            finally:
                denied.close()

            session = RpcSession(workspace, env, extra_args=["--pify-scope", "agents/task-start,files/a"])
            try:
                session.send({"id": "model", "type": "set_model", "provider": "fixture-a", "modelId": "fixture-local"})
                first = prompt(session, "first", "start PIFY_STUCK_first | files/a")
                second = prompt(session, "second", "start PIFY_STUCK_second | files/a")
                third = prompt(session, "third", "start PIFY_QUICK_third | files/a")
                if first.get("state") != "running" or second.get("state") != "running" or third.get("state") != "queued":
                    raise AssertionError(f"Per-provider limit failed: {first}, {second}, {third}")
                if third.get("scope") != ["files/a"]:
                    raise AssertionError(f"Worker scope widened: {third}")
                start = time.monotonic()
                session.send({"id": "parent-state", "type": "get_state"})
                if time.monotonic() - start > 2:
                    raise AssertionError("Stuck subagent blocked the parent RPC session")

                session.send({"id": "other-model", "type": "set_model", "provider": "fixture-b", "modelId": "fixture-local"})
                other = prompt(session, "other", "start PIFY_QUICK_other | files/a")
                if other.get("state") != "running" or other.get("provider") != "fixture-b":
                    raise AssertionError(f"Other provider was blocked by fixture-a: {other}")
                cancelled = prompt(session, "cancel", f"cancel {first['id']}")
                if cancelled.get("outcome") != "cancelled":
                    raise AssertionError(f"Cancellation did not stop the worker: {cancelled}")
                wait_state(session, third["id"], "succeeded")
                wait_state(session, other["id"], "succeeded")
                prompt(session, "cancel-second", f"cancel {second['id']}")

                session.send({"id": "back-to-a", "type": "set_model", "provider": "fixture-a", "modelId": "fixture-local"})
                real = prompt(session, "real", "start PIFY_REAL_answer READY_LOCAL | files/a")
                finished = wait_state(session, real["id"], "succeeded", timeout=10)
                if "READY_LOCAL" not in finished.get("output", ""):
                    raise AssertionError(f"Actual Pi child did not answer: {finished}")
                print(f"Pify subagent smoke passed on {os.uname().sysname}")
            finally:
                session.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
