"""Verify Pify stays usable when optional services are not configured."""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from smoke_pi_models import RpcSession


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def command(rpc: RpcSession, value: str, number: int) -> dict:
    events = rpc.send({"id": f"optional-{number}", "type": "prompt", "message": value}, notification=True)
    notices = [json.loads(event["message"]) for event in events
               if event.get("type") == "extension_ui_request" and event.get("method") == "notify"]
    assert len(notices) == 1, events
    return notices[0]


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-optional-absence-") as temporary:
        root = Path(temporary)
        agent = root / "agent"
        workspace = root / "workspace"
        home = root / "home"
        agent.mkdir()
        workspace.mkdir()
        home.mkdir()
        environment = {
            "PATH": os.environ["PATH"], "HOME": str(home), "PI_CODING_AGENT_DIR": str(agent),
            "PI_OFFLINE": "1", "TERM": "xterm-256color",
        }
        version = subprocess.run(["pi", "--version"], cwd=workspace, env=environment,
                                 capture_output=True, text=True, check=True).stdout.strip()
        assert version == "1.5.2", version
        subprocess.run(["pi", "install", str(PACKAGE_ROOT)], cwd=workspace, env=environment,
                       capture_output=True, text=True, check=True, timeout=30)
        assert not (agent / "models.json").exists()
        assert not (workspace / ".pi").exists()
        rpc = RpcSession(workspace, environment)
        try:
            health = command(rpc, "/pify-health", 1)
            assert health["compatibility"]["status"] == "verified", health
            assert health["install"]["status"] == "installed", health
            assert health["memoryVault"]["status"] == "unconfigured", health
            assert health["optionalServices"] == "not_checked", health
            assert len(health["bundledSkills"]) == 3, health
            memory = command(rpc, "/pify-memory status", 2)
            assert memory["status"] == "unconfigured", memory
            optimizations = command(rpc, "/pify-optimizations", 3)
            assert optimizations["rtk"]["agentPiHook"] == "absent", optimizations
            assert optimizations["caveman"]["agentPiPackage"] == "not_declared", optimizations
            assert optimizations["newTransformsEnabledByPify"] is False, optimizations
        finally:
            rpc.close()
        assert not (agent / "models.json").exists()
        assert not (workspace / ".pi").exists()
    print(f"Pify optional-service absence smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
