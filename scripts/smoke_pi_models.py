"""Exercise Pi model paths with fixtures or one private live LiteLLM validation."""

import argparse
import getpass
import ipaddress
import json
import os
import re
import secrets
import select
import subprocess
import sys
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
        if server.kind in {"local", "litellm"}:
            assert request_path == "/v1/chat/completions"
            expected_model = "fixture-local" if server.kind == "local" else "fixture-litellm"
            assert body["model"] == expected_model
            assert body["stream"] is True
            if server.kind == "litellm":
                assert self.headers.get("Authorization") == "Bearer fixture-key"
                reply = re.search(r"PIFY_CLOUD_READY_[0-9a-f]+", json.dumps(body["messages"][-1]["content"]))
                assert reply is not None
                reply_text = reply.group()
            else:
                reply_text = "READY_LOCAL"
            chunks = [
                {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1, "model": expected_model, "choices": [{"index": 0, "delta": {"role": "assistant", "content": reply_text}, "finish_reason": None}]},
                {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1, "model": expected_model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}},
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
    def __init__(self, workspace: Path, env: dict[str, str], *, offline: bool = True, timeout: int = 30, extra_args: list[str] | None = None):
        self.timeout = timeout
        self.process = subprocess.Popen(
            ["pi", *(["--offline"] if offline else []), "--no-mcp", "--no-tools", "--no-context-files", "--no-session", "--mode", "rpc", *(extra_args or [])],
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
        deadline = time.monotonic() + self.timeout
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


def validate_litellm_inputs(base_url: str, model: str, key: str) -> None:
    parsed = urlsplit(base_url)
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Use a LiteLLM base URL without credentials, query, or fragment")
    try:
        loopback = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        loopback = parsed.hostname == "localhost"
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise ValueError("Use HTTPS, or HTTP on loopback only")
    if not parsed.path.rstrip("/").endswith("/v1"):
        raise ValueError("Use the LiteLLM OpenAI-compatible base URL ending in /v1")
    if not model or any(character.isspace() for character in model):
        raise ValueError("Enter one exact LiteLLM chat model alias")
    if not key:
        raise ValueError("A LiteLLM virtual key is required")


def run_litellm_in_agent(agent: Path, workspace: Path, env: dict[str, str],
                         base_url: str, model: str, key: str) -> None:
    validate_litellm_inputs(base_url, model, key)
    models_file = agent / "models.json"
    previous = models_file.read_bytes() if models_file.exists() else None
    previous_mode = models_file.stat().st_mode & 0o777 if previous is not None else None
    config = {"providers": {"pify-litellm-validation": {
        "baseUrl": base_url.rstrip("/"), "api": "openai-completions",
        "apiKey": "$PIFY_LITELLM_API_KEY", "authHeader": True,
        "models": [{"id": model, "contextWindow": 8192, "maxTokens": 128}],
    }}}
    try:
        models_file.write_text(json.dumps(config), encoding="utf-8")
        models_file.chmod(0o600)
        model_env = {**env, "PIFY_LITELLM_API_KEY": key, "TERM": "xterm-256color"}
        model_env.pop("PI_OFFLINE", None)
        rpc = RpcSession(workspace, model_env, offline=False, timeout=90)
        try:
            rpc.send({"id": "cloud-model", "type": "set_model", "provider": "pify-litellm-validation", "modelId": model})
            expected = f"PIFY_CLOUD_READY_{secrets.token_hex(8)}"
            events = rpc.send({"id": "cloud-prompt", "type": "prompt", "message": f"Reply with exactly {expected}."}, settled=True)
            if expected not in assistant_text(events):
                raise AssertionError("Hosted model did not return the one-use validation phrase")
            health_events = rpc.send({"id": "health", "type": "prompt", "message": "/pify-health"}, notification=True)
            notices = [item for item in health_events if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
            if len(notices) != 1:
                raise AssertionError("Pify health was unavailable after the model response")
            health = json.loads(notices[0]["message"])
            if health["install"]["status"] != "installed" or health["compatibility"]["status"] != "verified":
                raise AssertionError("Pify health did not recognize the isolated package")
        finally:
            rpc.close()
    finally:
        if previous is None:
            models_file.unlink(missing_ok=True)
        else:
            models_file.write_bytes(previous)
            models_file.chmod(previous_mode)


def validate_litellm(base_url: str, model: str, key: str) -> dict[str, str]:
    validate_litellm_inputs(base_url, model, key)
    with tempfile.TemporaryDirectory(prefix="pify-live-cloud-") as fixture:
        root = Path(fixture)
        agent = root / "agent"
        workspace = root / "workspace"
        agent.mkdir()
        workspace.mkdir()
        env = os.environ.copy()
        env.update({
            "PI_CODING_AGENT_DIR": str(agent),
            "PI_CODING_AGENT_SESSION_DIR": str(root / "sessions"),
            "PI_TELEMETRY": "0",
            "TERM": "xterm-256color",
        })
        env.pop("PI_OFFLINE", None)
        env.pop("PI_PACKAGE_DIR", None)
        version = subprocess.run(
            ["pi", "--version"], cwd=workspace, env=env, text=True,
            capture_output=True, timeout=10, check=True,
        ).stdout.strip()
        if version != "1.4.0":
            raise RuntimeError(f"Pi 1.4.0 required; found {version}")
        subprocess.run(
            ["pi", "install", str(PACKAGE_ROOT)], cwd=workspace, env={**env, "PI_OFFLINE": "1"},
            text=True, capture_output=True, timeout=30, check=True,
        )
        run_litellm_in_agent(agent, workspace, env, base_url, model, key)
    return {"status": "passed", "gateway": "litellm", "protocol": "openai-completions", "piVersion": version, "platform": os.uname().sysname}


def fixture_main() -> None:
    local = start_server("local")
    cloud = start_server("cloud")
    litellm = start_server("litellm")
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
        report = validate_litellm(f"http://127.0.0.1:{litellm.server_port}/v1", "fixture-litellm", "fixture-key")
        assert report["status"] == "passed"
        assert all(value not in json.dumps(report) for value in ("fixture-key", "fixture-litellm", "127.0.0.1"))
        assert litellm.requests == [("/v1/chat/completions", "fixture-litellm")]
        try:
            validate_litellm("http://example.com/v1", "fixture-litellm", "fixture-key")
        except ValueError:
            pass
        else:
            raise AssertionError("Live validation accepted an unencrypted remote endpoint")
    finally:
        if local_running:
            local.shutdown()
            local.server_close()
        cloud.shutdown()
        cloud.server_close()
        litellm.shutdown()
        litellm.server_close()
    print(f"Pify local, Anthropic, and LiteLLM-compatible provider smoke passed on {os.uname().sysname}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live-litellm", action="store_true", help="prompt for a private gateway key and test one hosted chat model")
    args = parser.parse_args()
    if not args.live_litellm:
        fixture_main()
        return 0
    if not sys.stdin.isatty():
        parser.error("--live-litellm requires an interactive terminal for hidden key input")
    base_url = input("LiteLLM OpenAI base URL (ending /v1): ").strip()
    model = input("Hosted chat model alias: ").strip()
    key = getpass.getpass("LiteLLM virtual key (hidden): ")
    try:
        report = validate_litellm(base_url, model, key)
    except Exception as error:
        print(f"Pify live cloud validation failed ({type(error).__name__}); no endpoint, key, or response details printed.", file=sys.stderr)
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
