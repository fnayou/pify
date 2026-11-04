"""Verify Pify leaves command output intact through official Pi 1.4.0."""

import json
import os
import tempfile
from pathlib import Path

from smoke_pi_workflow import notice, rpc, run_pi


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
GOLDEN_COMMANDS = {
    "command": "printf '%s\\n' 'git status --short'",
    "structured": "printf '%s\\n' '{\"ok\":true,\"count\":2,\"items\":[\"a\",\"b\"]}'",
    "warning": "printf '%s\\n' 'warning: keep this detail' >&2; exit 7",
}
GOLDEN_RESULTS = {
    "command": {"output": "git status --short\n", "exitCode": 0, "cancelled": False, "truncated": False},
    "structured": {"output": '{"ok":true,"count":2,"items":["a","b"]}\n', "exitCode": 0, "cancelled": False, "truncated": False},
    "warning": {"output": "warning: keep this detail\n", "exitCode": 7, "cancelled": False, "truncated": False},
}


def fixture(root: Path, name: str, install_pify: bool) -> tuple[Path, Path, dict[str, str]]:
    agent = root / f"{name}-agent"
    workspace = root / f"{name}-workspace"
    agent.mkdir()
    workspace.mkdir()
    (agent / "settings.json").write_text(json.dumps({"compaction": {"enabled": False}}) + "\n")
    extensions = agent / "extensions"
    extensions.mkdir()
    (extensions / "rtk.ts").write_text("export default function () {}\n")
    env = os.environ.copy()
    env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})
    if run_pi(["--version"], workspace, env).strip() != "1.4.0":
        raise AssertionError("Pi 1.4.0 fixture required")
    if install_pify:
        original_hook = (extensions / "rtk.ts").read_bytes()
        run_pi(["install", str(PACKAGE_ROOT)], workspace, env)
        if (extensions / "rtk.ts").read_bytes() != original_hook:
            raise AssertionError("Pify package install changed the existing hook")
    return agent, workspace, env


def bash_result(workspace: Path, env: dict[str, str], name: str, command: str) -> dict:
    records = rpc(workspace, env, {"id": name, "type": "bash", "command": command})
    response = next(item for item in records if item.get("type") == "response" and item.get("id") == name)
    return response.get("data", {})


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-optimization-smoke-") as temporary:
        root = Path(temporary).resolve()
        _, base_workspace, base_env = fixture(root, "baseline", False)
        pify_agent, pify_workspace, pify_env = fixture(root, "pify", True)
        report = notice(rpc(pify_workspace, pify_env, {"id": "inspect", "type": "prompt", "message": "/pify-optimizations"}))
        if report["rtk"]["agentPiHook"] != "present" or report["rtk"]["compatibility"] != "unverified":
            raise AssertionError(f"Existing RTK hook not reported safely: {report['rtk']}")
        if report["caveman"]["enabledByPify"] or report["newTransformsEnabledByPify"]:
            raise AssertionError("Pify enabled an optimization transform")
        if report["nativeCompaction"] != {"status": "disabled", "source": "agent"}:
            raise AssertionError(f"Existing Pi compaction setting changed: {report['nativeCompaction']}")
        for name, command in GOLDEN_COMMANDS.items():
            base = bash_result(base_workspace, base_env, name, command)
            pify = bash_result(pify_workspace, pify_env, name, command)
            if base != GOLDEN_RESULTS[name]:
                raise AssertionError(f"Pi baseline changed for {name}: {base!r}")
            if pify != base:
                raise AssertionError(f"Pify changed {name} output: baseline={base!r}, pify={pify!r}")
        if (pify_agent / "extensions" / "rtk.ts").read_text() != "export default function () {}\n":
            raise AssertionError("Pify changed user hook after command execution")
        print(f"Pify optimization pass-through smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
