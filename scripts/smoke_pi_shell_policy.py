"""Check nested Bash dispatch through model, RPC, interactive, and job paths."""

import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from smoke_pi_models import RpcSession
from smoke_pi_workflow import PACKAGE_ROOT, run_pi


class ShellModel(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path != "/v1/chat/completions" or body["model"] != "fixture-shell":
            raise AssertionError(f"Unexpected model request: {self.path}, {body['model']}")
        followup = any(message.get("role") == "tool" for message in body["messages"])
        if followup:
            deltas = [
                {"role": "assistant", "content": "shell check done"},
                {},
            ]
            finishes = [None, "stop"]
        else:
            deltas = [
                {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_nested", "type": "function",
                    "function": {"name": "bash", "arguments": json.dumps({
                        "command": "sh -c 'printf nested > tool-marker.txt'",
                    })}}]},
                {},
            ]
            finishes = [None, "tool_calls"]
        chunks = [
            {"id": "chatcmpl-shell", "object": "chat.completion.chunk", "created": 1,
             "model": "fixture-shell", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            for delta, finish in zip(deltas, finishes)
        ]
        payload = ("".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args) -> None:
        pass


def check_user_bash(workspace: Path, env: dict[str, str], mode: str, scope: str, allowed: bool) -> None:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    process = subprocess.Popen(
        ["pi", "--offline", "--no-mcp", "--no-context-files", "--no-session", "--approve",
         "--pify-mode", mode, "--pify-scope", scope],
        cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    os.close(slave)
    output = bytearray()
    try:
        deadline = time.monotonic() + 10
        while f"Pify: {mode.title()}".encode() not in output and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                output.extend(os.read(master, 65536))
        if f"Pify: {mode.title()}".encode() not in output:
            raise AssertionError(f"Pi TUI did not start in {mode}: {output[-500:]!r}")
        os.write(master, b"!sh -c 'printf nested > bang-marker.txt'\r")
        marker = workspace / "bang-marker.txt"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                output.extend(os.read(master, 65536))
            if marker.exists() or b"pify.permission-result/v1" in output:
                break
        if allowed:
            if not marker.exists() or marker.read_text() != "nested":
                raise AssertionError(f"Scoped interactive Bash did not run in {mode}: {output[-1000:]!r}")
        elif marker.exists() or b"pify.permission-result/v1" not in output:
            raise AssertionError(f"Interactive Bash was not blocked in {mode}: {output[-1000:]!r}")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        os.close(master)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), ShellModel)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="pify-shell-smoke-") as fixture:
            root = Path(fixture).resolve()
            agent = root / "agent"
            agent.mkdir()
            env = os.environ.copy()
            env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})
            workspace = root / "setup"
            workspace.mkdir()
            if run_pi(["--version"], workspace, env).strip() != "1.6.0":
                raise AssertionError("Pi 1.6.0 fixture required")
            run_pi(["install", str(PACKAGE_ROOT)], workspace, env)
            agent.joinpath("models.json").write_text(json.dumps({"providers": {"fixture-provider": {
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions",
                "apiKey": "fixture-key", "models": [{"id": "fixture-shell", "contextWindow": 8192, "maxTokens": 256}],
            }}}))
            for mode in ("safe", "balanced", "full"):
                for scope in ("", "commands/shell"):
                    workspace = root / f"{mode}-{scope or 'unscoped'}".replace("/", "-")
                    workspace.mkdir()
                    session = RpcSession(workspace, env, enable_tools=True, extra_args=[
                        "--approve", "--tools", "bash", "--pify-mode", mode, "--pify-scope", scope,
                    ])
                    try:
                        session.send({"id": "model", "type": "set_model", "provider": "fixture-provider", "modelId": "fixture-shell"})
                        events = session.send({"id": "prompt", "type": "prompt", "message": "Run the fixture command."}, settled=True)
                    finally:
                        session.close()
                    if not any(item.get("type") == "tool_execution_start" and item.get("toolName") == "bash" for item in events):
                        raise AssertionError(f"Pi did not request Bash in {mode}, {scope}: {events}")
                    marker = workspace / "tool-marker.txt"
                    allowed = mode != "safe" and bool(scope)
                    if allowed and marker.read_text() != "nested":
                        raise AssertionError(f"Scoped Bash did not run in {mode}")
                    if not allowed and marker.exists():
                        raise AssertionError(f"Nested Bash escaped {mode} policy with scope {scope!r}")
                    if not allowed and "pify.permission-result/v1" not in json.dumps(events):
                        raise AssertionError(f"Blocked Bash lost the structured policy result in {mode}: {events}")
            for mode in ("safe", "balanced", "full"):
                for scope in ("", "commands/shell"):
                    rpc_workspace = root / f"rpc-{mode}-{scope or 'unscoped'}".replace("/", "-")
                    rpc_workspace.mkdir()
                    rpc = RpcSession(rpc_workspace, env, extra_args=[
                        "--approve", "--pify-mode", mode, "--pify-scope", scope,
                    ])
                    try:
                        records = rpc.send({"id": "rpc-bash", "type": "bash", "command": "sh -c 'printf nested > rpc-marker.txt'"})
                    finally:
                        rpc.close()
                    response = next(item["data"] for item in records if item.get("id") == "rpc-bash")
                    marker = rpc_workspace / "rpc-marker.txt"
                    if mode != "safe" and scope:
                        if response.get("exitCode") != 0 or marker.read_text() != "nested":
                            raise AssertionError(f"Scoped RPC Bash did not run in {mode}: {response}")
                    elif marker.exists() or response.get("exitCode") != 126 or json.loads(response["output"])["schema"] != "pify.permission-result/v1":
                        raise AssertionError(f"RPC Bash escaped the policy in {mode}, {scope}: {response}")
            for mode, scope, allowed in (("safe", "commands/shell", False),
                                         ("balanced", "", False),
                                         ("balanced", "commands/shell", True),
                                         ("full", "commands/shell", True)):
                workspace = root / f"interactive-{mode}-{scope or 'unscoped'}".replace("/", "-")
                workspace.mkdir()
                check_user_bash(workspace, env, mode, scope, allowed)
            print(f"Pify shell policy smoke passed on {os.uname().sysname}")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
