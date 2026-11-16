"""Verify optional empty vault setup through official Pi 1.5.2 RPC."""

import hashlib
import os
import tempfile
from pathlib import Path

from smoke_pi_workflow import notice, rpc, run_pi


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def scope(path: Path) -> str:
    digest = hashlib.sha256(str(path).encode()).hexdigest()
    return f"memory/vault-selection,memory/vault-path/{digest}"


def command(workspace: Path, env: dict[str, str], name: str, value: str, authorization: str | None = None) -> dict:
    return notice(rpc(workspace, env, {"id": name, "type": "prompt", "message": f"/pify-memory {value}"}, scope=authorization))


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-memory-smoke-") as fixture:
        root = Path(fixture).resolve()
        agent = root / "agent"
        workspace = root / "workspace"
        vault = root / "vault"
        existing = root / "existing"
        agent.mkdir()
        workspace.mkdir()
        existing.mkdir()
        (existing / "personal.md").write_text("private note\n")
        env = os.environ.copy()
        env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})
        if run_pi(["--version"], workspace, env).strip() != "1.5.2":
            raise AssertionError("Pi 1.5.2 fixture required")
        run_pi(["install", str(PACKAGE_ROOT)], workspace, env)

        denied = command(workspace, env, "denied", f"create {vault}")
        if denied.get("outcome") != "clarification_required" or vault.exists():
            raise AssertionError(f"Unscoped vault creation did not fail closed: {denied}")
        created = command(workspace, env, "create", f"create {vault}", scope(vault))
        if created.get("status") != "created" or sorted(path.name for path in vault.iterdir()) != [
            "00-inbox", "01-global", "02-projects", "03-reference", "99-archive"
        ]:
            raise AssertionError(f"Vault was not created empty with separate scopes: {created}")
        health = notice(rpc(workspace, env, {"id": "health", "type": "prompt", "message": "/pify-health"}))
        if health["memoryVault"]["status"] != "available":
            raise AssertionError(f"Health missed selected vault: {health['memoryVault']}")

        vault.rename(root / "offline")
        unavailable = command(workspace, env, "unavailable", "status")
        if unavailable.get("status") != "unavailable" or vault.exists():
            raise AssertionError(f"Missing vault was silently replaced: {unavailable}")
        connected = command(workspace, env, "connect", f"connect {existing}", scope(existing))
        if connected.get("status") != "connected" or (existing / "personal.md").read_text() != "private note\n":
            raise AssertionError(f"Connect changed existing notes: {connected}")
        if not (existing / "00-inbox").is_dir() or not (existing / "01-global").is_dir() or not (existing / "02-projects").is_dir() or not (existing / "03-reference").is_dir():
            raise AssertionError("Connect omitted scope folders")
        skipped = command(workspace, env, "skip", "skip", "memory/vault-selection")
        if skipped.get("status") != "skipped" or command(workspace, env, "status", "status")["status"] != "skipped":
            raise AssertionError(f"Skip did not disable memory selection: {skipped}")
        if (existing / "personal.md").read_text() != "private note\n":
            raise AssertionError("Skip changed existing notes")
        print(f"Pify memory vault smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
