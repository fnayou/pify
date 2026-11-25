"""Verify local memory approval and prompt activation through Pi 1.6.0 RPC."""

import hashlib
import json
import os
import tempfile
from pathlib import Path

from smoke_pi_memory import command, scope
from smoke_pi_models import RpcSession, assistant_text, start_server
from smoke_pi_workflow import run_pi


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def approval_scope(vault: Path, relative: str) -> str:
    digest = hashlib.sha256(f"{vault}\0{relative}".encode()).hexdigest()
    return f"memory/approval/{digest}"


def prompt_model(workspace: Path, env: dict[str, str]) -> str:
    session = RpcSession(workspace, env)
    try:
        session.send({"id": "model", "type": "set_model", "provider": "pify-local-fixture", "modelId": "fixture-local"})
        events = session.send({"id": "prompt", "type": "prompt", "message": "Reply READY_LOCAL."}, settled=True)
        return assistant_text(events)
    finally:
        session.close()


def main() -> None:
    server = start_server("local")
    try:
        with tempfile.TemporaryDirectory(prefix="pify-memory-approval-smoke-") as fixture:
            root = Path(fixture).resolve()
            agent = root / "agent"
            workspace = root / "workspace"
            vault = root / "vault"
            agent.mkdir()
            workspace.mkdir()
            env = os.environ.copy()
            env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})
            if run_pi(["--version"], workspace, env).strip() != "1.6.0":
                raise AssertionError("Pi 1.6.0 fixture required")
            run_pi(["install", str(PACKAGE_ROOT)], workspace, env)
            if command(workspace, env, "create", f"create {vault}", scope(vault)).get("status") != "created":
                raise AssertionError("Vault creation failed")
            relative = "01-global/preferences/approved.md"
            note = vault / relative
            note.write_text("PIFY_APPROVED_MEMORY_MARKER\n")
            (vault / "01-global/preferences/newly-synced.md").write_text("PIFY_UNAPPROVED_MEMORY_MARKER\n")
            preview = command(workspace, env, "review", f"review {relative}")
            if preview.get("scope") != "global" or preview.get("content") != "PIFY_APPROVED_MEMORY_MARKER\n":
                raise AssertionError(f"Review did not show the exact note: {preview}")
            denied = command(workspace, env, "denied", f"approve {relative} {preview['reviewCode']}")
            if denied.get("outcome") != "clarification_required":
                raise AssertionError(f"Headless approval did not fail closed: {denied}")
            approved = command(workspace, env, "approve", f"approve {relative} {preview['reviewCode']}", approval_scope(vault, relative))
            if approved.get("status") != "approved":
                raise AssertionError(f"Scoped local approval failed: {approved}")
            snapshot = command(workspace, env, "snapshot", "snapshot")
            if snapshot.get("entries") != [{"relativePath": relative, "scope": "global"}]:
                raise AssertionError(f"Unapproved note entered snapshot: {snapshot}")

            (agent / "models.json").write_text(json.dumps({"providers": {"pify-local-fixture": {
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions",
                "apiKey": "fixture-key", "models": [{"id": "fixture-local", "contextWindow": 8192, "maxTokens": 256}],
            }}}))
            if prompt_model(workspace, env) != "READY_LOCAL":
                raise AssertionError("Local model fixture did not answer")
            sent = json.dumps(server.bodies[-1]["messages"])
            if "PIFY_APPROVED_MEMORY_MARKER" not in sent or "PIFY_UNAPPROVED_MEMORY_MARKER" in sent:
                raise AssertionError("Pi sent unreviewed or omitted approved memory")

            note.write_text("PIFY_EDITED_MEMORY_MARKER\n")
            changed = command(workspace, env, "changed", "snapshot")
            if changed.get("entries") or not changed.get("inactive"):
                raise AssertionError(f"Edited note remained active: {changed}")
            if prompt_model(workspace, env) != "READY_LOCAL":
                raise AssertionError("Local model fixture did not answer after edit")
            sent = json.dumps(server.bodies[-1]["messages"])
            if "PIFY_APPROVED_MEMORY_MARKER" in sent or "PIFY_EDITED_MEMORY_MARKER" in sent:
                raise AssertionError("Pi sent inactive memory after edit")

            (vault / "02-projects/sample/context").mkdir(parents=True)
            moved = "02-projects/sample/context/approved.md"
            note.rename(vault / moved)
            project_preview = command(workspace, env, "project-review", f"review {moved}")
            if project_preview.get("scope") != "project" or project_preview.get("reviewCode") == preview["reviewCode"]:
                raise AssertionError("Scope move did not require new review")
            if command(workspace, env, "project-snapshot", "snapshot").get("entries"):
                raise AssertionError("Moved note was applied before new approval")
            print(f"Pify memory approval smoke passed on {os.uname().sysname}")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
