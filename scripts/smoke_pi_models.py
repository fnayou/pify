"""Exercise Pi's local and Anthropic model paths with isolated protocol fixtures."""

import json
import os
import select
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


class ModelHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        server = self.server
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        request_path = urlsplit(self.path).path
        server.requests.append((request_path, body["model"]))
        if server.kind == "local":
            assert request_path == "/v1/chat/completions"
            assert body["model"] == "fixture-local"
            assert body["stream"] is True
            chunks = [
                {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1, "model": "fixture-local", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "READY_LOCAL"}, "finish_reason": None}]},
                {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1, "model": "fixture-local", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}},
            ]
            payload = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        else:
            assert request_path == "/v1/messages"
            assert body["model"] == "fixture-cloud"
            assert body["stream"] is True
            assert self.headers.get("x-api-key") == "fixture-key"
            events = [
                ("message_start", {"type": "message_start", "message": {"id": "msg_fixture", "type": "message", "role": "assistant", "model": "fixture-cloud", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0}}}),
                ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "READY_CLOUD"}}),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 2}}),
                ("message_stop", {"type": "message_stop"}),
            ]
            payload = "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events)
        data = payload.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args) -> None:
        pass


def start_server(kind: str) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
    server.kind = kind
    server.requests = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class RpcSession:
    def __init__(self, workspace: Path, env: dict[str, str]):
        self.process = subprocess.Popen(
            ["pi", "--offline", "--no-mcp", "--no-tools", "--no-session", "--mode", "rpc"],
            cwd=workspace, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.pending = bytearray()

    def send(self, command: dict, *, settled: bool = False, notification: bool = False) -> list[dict]:
        assert self.process.stdin is not None and self.process.stdout is not None
        self.process.stdin.write(json.dumps(command).encode() + b"\n")
        self.process.stdin.flush()
        events = []
        response_seen = False
        notification_seen = False
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            while b"\n" in self.pending:
                line, _, remainder = self.pending.partition(b"\n")
                self.pending = bytearray(remainder)
                event = json.loads(line)
                events.append(event)
                if event.get("id") == command["id"] and event.get("type") == "response":
                    if not event.get("success"):
                        raise AssertionError(f"Pi RPC {command['type']} failed: {event.get('error')}")
                    response_seen = True
                if event.get("type") == "extension_ui_request" and event.get("method") == "notify":
                    notification_seen = True
                if settled and event.get("type") == "agent_settled":
                    assert response_seen, f"Pi RPC {command['type']} settled without a response"
                    return events
                if not settled and response_seen and (not notification or notification_seen):
                    return events
            ready, _, _ = select.select([self.process.stdout], [], [], 0.2)
            if ready:
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    break
                self.pending.extend(chunk)
        raise AssertionError(f"Pi RPC {command['type']} timed out; events: {[item.get('type') for item in events]}")

    def close(self) -> None:
        if self.process.stdin is not None:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        if self.process.returncode != 0:
            assert self.process.stderr is not None
            raise AssertionError(f"Pi RPC exited {self.process.returncode}: {self.process.stderr.read().decode()}")


def assistant_text(events: list[dict]) -> str:
    messages = [event["message"] for event in events if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant"]
    if not messages or messages[-1].get("stopReason") != "stop":
        raise AssertionError(f"Pi did not finish a model response: {messages[-1] if messages else None}")
    return "".join(block.get("text", "") for block in messages[-1]["content"] if block["type"] == "text")


def main() -> None:
    local = start_server("local")
    cloud = start_server("cloud")
    local_running = True
    try:
        with tempfile.TemporaryDirectory(prefix="pify-model-smoke-") as fixture:
            root = Path(fixture)
            agent = root / "agent"
            workspace = root / "workspace"
            agent.mkdir()
            workspace.mkdir()
            env = os.environ.copy()
            env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})
            version = subprocess.run(["pi", "--version"], cwd=workspace, env=env, text=True, capture_output=True, timeout=10, check=True).stdout.strip()
            assert version == "1.4.0", f"Expected Pi 1.4.0, got {version}"
            subprocess.run(["pi", "install", str(PACKAGE_ROOT)], cwd=workspace, env=env, text=True, capture_output=True, timeout=30, check=True)
            (agent / "models.json").write_text(json.dumps({"providers": {
                "pify-local-fixture": {"baseUrl": f"http://127.0.0.1:{local.server_port}/v1", "api": "openai-completions", "apiKey": "fixture-key", "models": [{"id": "fixture-local", "contextWindow": 8192, "maxTokens": 256}]},
                "anthropic": {"baseUrl": f"http://127.0.0.1:{cloud.server_port}", "apiKey": "fixture-key", "models": [{"id": "fixture-cloud", "api": "anthropic-messages", "contextWindow": 8192, "maxTokens": 256}]},
            }}))
            rpc = RpcSession(workspace, env)
            try:
                rpc.send({"id": "local-model", "type": "set_model", "provider": "pify-local-fixture", "modelId": "fixture-local"})
                local_events = rpc.send({"id": "local-prompt", "type": "prompt", "message": "Reply READY_LOCAL."}, settled=True)
                assert assistant_text(local_events) == "READY_LOCAL"
                assert local.requests == [("/v1/chat/completions", "fixture-local")]

                local.shutdown()
                local.server_close()
                local_running = False
                rpc.send({"id": "cloud-model", "type": "set_model", "provider": "anthropic", "modelId": "fixture-cloud"})
                cloud_events = rpc.send({"id": "cloud-prompt", "type": "prompt", "message": "Reply READY_CLOUD."}, settled=True)
                assert assistant_text(cloud_events) == "READY_CLOUD"
                assert cloud.requests == [("/v1/messages", "fixture-cloud")]
                health_events = rpc.send({"id": "health", "type": "prompt", "message": "/pify-health"}, notification=True)
                notices = [item for item in health_events if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
                assert len(notices) == 1
                health = json.loads(notices[0]["message"])
                assert health["install"]["status"] == "installed"
                assert health["compatibility"]["status"] == "verified"
            finally:
                rpc.close()
    finally:
        if local_running:
            local.shutdown()
            local.server_close()
        cloud.shutdown()
        cloud.server_close()
    print(f"Pify local and Anthropic provider smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
