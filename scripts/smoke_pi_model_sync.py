"""Exercise explicit Pify model sync through Pi RPC and an isolated loopback server."""

import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from smoke_pi_package import run_command_rpc


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


class InventoryHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.headers.get("Authorization") != "Bearer fixture-token":
            self.send_error(401)
            return
        if self.path == "/v1/models":
            body = {"data": [{"id": "fixture-chat"}]}
        elif self.path == "/api/v1/models":
            body = {"models": [{"key": "fixture-chat", "type": "llm", "display_name": "Fixture chat"}]}
        else:
            self.send_error(404)
            return
        self.server.paths.append(self.path)
        payload = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args) -> None:
        pass


def command_result(workspace: Path, env: dict[str, str]) -> dict:
    records = run_command_rpc(
        workspace, env, "/pify-model-sync apply", "model-sync",
        ["-e", str(PACKAGE_ROOT), "--pify-scope", "models.json,pify-state/model-sync.json"],
    )
    notices = [item for item in records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
    if len(notices) != 1:
        raise AssertionError(f"Expected one model sync result; got {[item.get('type') for item in records]}")
    return json.loads(notices[0]["message"])


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), InventoryHandler)
    server.paths = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="pify-model-sync-smoke-") as fixture:
            root = Path(fixture)
            agent = root / "agent"
            workspace = root / "workspace"
            agent.mkdir()
            workspace.mkdir()
            models_file = agent / "models.json"
            settings_file = agent / "settings.json"
            models_file.write_text(json.dumps({"providers": {
                "lmstudio": {"baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions", "apiKey": "$PIFY_TEST_TOKEN", "authHeader": True, "models": []},
                "other": {"apiKey": "PRIVATE_FIXTURE_VALUE", "models": [{"id": "other-model"}]},
            }}))
            settings_file.write_text(json.dumps({"defaultProvider": "other", "defaultModel": "other-model"}))
            models_file.chmod(0o600)
            settings_file.chmod(0o600)
            settings_before = settings_file.read_bytes()
            env = os.environ.copy()
            env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "PIFY_TEST_TOKEN": "fixture-token", "TERM": "xterm-256color"})
            first = command_result(workspace, env)
            if first.get("status") != "synced" or first.get("added", {}).get("count") != 1 or "fixture-token" in json.dumps(first):
                raise AssertionError(f"Unexpected first sync: {first}")
            models = json.loads(models_file.read_text())
            if models["providers"]["lmstudio"]["models"] != [{"id": "fixture-chat", "name": "Fixture chat"}]:
                raise AssertionError("Pify-owned model was not added")
            if models["providers"]["other"] != {"apiKey": "PRIVATE_FIXTURE_VALUE", "models": [{"id": "other-model"}]} or settings_file.read_bytes() != settings_before:
                raise AssertionError("Sync changed unrelated provider or saved default")
            sidecar = agent / "pify-state" / "model-sync.json"
            if sidecar.stat().st_mode & 0o777 != 0o600 or sidecar.parent.stat().st_mode & 0o777 != 0o700:
                raise AssertionError("Pify model sync state is not private")
            first_bytes = models_file.read_bytes()
            second = command_result(workspace, env)
            if second.get("status") != "already_current" or models_file.read_bytes() != first_bytes:
                raise AssertionError(f"Repeated sync was not idempotent: {second}")
            if server.paths != ["/v1/models", "/api/v1/models"] * 2:
                raise AssertionError(f"Wrong LM Studio endpoints: {server.paths}")
        print(f"Pify model sync Pi RPC smoke passed on {os.uname().sysname}")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
