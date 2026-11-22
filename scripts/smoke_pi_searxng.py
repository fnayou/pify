"""Check SearXNG tool opt-in and headless denial in isolated Pi 1.5.2."""

import json
import os
import select
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


class FixtureHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/search":
            self.server.search_calls += 1
            self.send_error(500)
            return
        assert self.path == "/v1/chat/completions"
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.model_calls.append(body)
        if len(self.server.model_calls) == 1:
            assert any(tool["function"]["name"] == "pify_web_search" for tool in body["tools"])
            chunks = [
                {"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_search", "type": "function", "function": {"name": "pify_web_search", "arguments": '{"query":"public topic"}'}}]}, "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
            ]
        else:
            chunks = [
                {"choices": [{"index": 0, "delta": {"role": "assistant", "content": "DONE"}, "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ]
        data = ("".join("data: " + json.dumps({"id": "fixture", "object": "chat.completion.chunk", "created": 1,
            "model": "fixture", **chunk}) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def run_pi(agent, workspace, port, args):
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_CODING_AGENT_SESSION_DIR": str(agent / "sessions"),
        "PI_OFFLINE": "1", "PI_TELEMETRY": "0", "TERM": "xterm-256color"}
    process = subprocess.Popen(["pi", "--offline", "--no-mcp", "--no-session", "--no-extensions",
        "--no-skills", "--no-context-files", "-e", str(PACKAGE_ROOT), "--mode", "rpc", *args],
        cwd=workspace, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        assert process.stdin and process.stdout
        process.stdin.write(b'{"id":"model","type":"set_model","provider":"fixture","modelId":"fixture"}\n')
        process.stdin.write(b'{"id":"prompt","type":"prompt","message":"Search public topic."}\n')
        process.stdin.flush()
        pending = bytearray()
        events = []
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            ready, _, _ = select.select([process.stdout], [], [], 0.2)
            if not ready:
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            pending.extend(chunk)
            while b"\n" in pending:
                line, _, rest = pending.partition(b"\n")
                pending = bytearray(rest)
                event = json.loads(line)
                events.append(event)
                if event.get("type") == "agent_settled":
                    tool = [item for item in events if item.get("type") == "tool_execution_end" and item.get("toolName") == "pify_web_search"]
                    assert len(tool) == 1, [item.get("type") for item in events]
                    value = json.loads(tool[0]["result"]["content"][0]["text"])
                    return value
        raise AssertionError("Pi did not settle after the fixture tool call")
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        assert process.returncode == 0, process.stderr.read().decode()


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    server.model_calls = []
    server.search_calls = 0
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="pify-searxng-pi-") as temp:
            agent = Path(temp) / "agent"
            workspace = Path(temp) / "workspace"
            agent.mkdir()
            workspace.mkdir()
            env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1"}
            version = subprocess.run(["pi", "--version"], env=env, cwd=workspace, text=True,
                capture_output=True, check=True).stdout.strip()
            assert version == "1.5.2", version
            (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions",
                "apiKey": "fixture-key", "models": [{"id": "fixture", "contextWindow": 8192, "maxTokens": 128}],
            }}}))
            off = run_pi(agent, workspace, server.server_port, [])
            assert off["status"] == "disabled", off
            server.model_calls.clear()
            blocked = run_pi(agent, workspace, server.server_port, ["--pify-research", "--pify-search-provider", "searxng",
                "--pify-searxng-endpoint", f"http://127.0.0.1:{server.server_port}", "--pify-scope", "network/searxng"])
            assert blocked["status"] == "approval_required", blocked
            assert server.search_calls == 0
            print(f"Pi 1.5.2 SearXNG opt-in/headless smoke passed on {os.uname().sysname}")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
