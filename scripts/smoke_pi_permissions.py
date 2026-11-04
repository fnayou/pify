"""Exercise Pify's permission command through pinned Pi's headless RPC mode."""

import json
import os
import subprocess
import tempfile
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def run(args: list[str], workspace: Path, env: dict[str, str], input_text: str | None = None) -> str:
    result = subprocess.run(
        ["pi", *args], cwd=workspace, env=env, input=input_text, text=True,
        capture_output=True, timeout=30, check=False,
    )
    if result.returncode != 0:
        raise AssertionError(f"pi failed ({result.returncode}): {result.stderr}\n{result.stdout}")
    return result.stdout


def permission_result(workspace: Path, env: dict[str, str], mode: str | None, scope: str, target: str = "skills/pify.md") -> dict:
    command = {"id": f"check-{mode}", "type": "prompt", "message": f"/pify-permission {target}"}
    flags = [] if mode is None else ["--pify-mode", mode]
    output = run(
        ["--offline", "--no-mcp", "--no-session", "--mode", "rpc", *flags, "--pify-scope", scope],
        workspace, env, json.dumps(command) + "\n",
    )
    records = [json.loads(line) for line in output.splitlines()]
    expected_mode = mode or "balanced"
    statuses = [item for item in records if item.get("type") == "extension_ui_request" and item.get("method") == "setStatus" and item.get("statusKey") == "pify"]
    if not any(item.get("statusText") == f"Pify: {expected_mode.title()}" for item in statuses):
        raise AssertionError(f"Pify mode was not visible: {records}")
    handled = [item for item in records if item.get("id") == command["id"] and item.get("type") == "response"]
    if len(handled) != 1 or handled[0].get("success") is not True or handled[0].get("data", {}).get("disposition") != "handled":
        raise AssertionError(f"Pify command was not handled: {records}")
    notices = [item for item in records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
    if len(notices) != 1:
        raise AssertionError(f"Expected one structured Pify notice: {records}")
    return json.loads(notices[0]["message"])


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-permission-smoke-") as fixture:
        root = Path(fixture).resolve()
        agent = root / "agent"
        workspace = root / "workspace"
        agent.mkdir()
        workspace.mkdir()
        env = os.environ.copy()
        env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1"})
        if run(["--version"], workspace, env).strip() != "1.4.0":
            raise AssertionError("Pi 1.4.0 fixture required")
        run(["install", str(PACKAGE_ROOT)], workspace, env)
        default = permission_result(workspace, env, None, "")
        if default["mode"] != "balanced" or default["outcome"] != "clarification_required":
            raise AssertionError(f"Balanced must be the default: {default}")
        for mode in ("safe", "balanced", "full"):
            missing = permission_result(workspace, env, mode, "")
            if missing["outcome"] != "clarification_required" or missing["mode"] != mode:
                raise AssertionError(f"Missing scope must fail closed in {mode}: {missing}")
            allowed = permission_result(workspace, env, mode, "skills/pify.md")
            if allowed["outcome"] != "allowed" or allowed["mode"] != mode:
                raise AssertionError(f"Explicit exact scope was not allowed in {mode}: {allowed}")
            outside = permission_result(workspace, env, mode, "skills/other.md")
            expected = "denied" if mode == "safe" else "approval_required"
            if outside["outcome"] != expected:
                raise AssertionError(f"Out-of-scope action was not blocked in {mode}: {outside}")
        unspecified = permission_result(workspace, env, "balanced", "skills/pify.md", "")
        if unspecified["outcome"] != "clarification_required":
            raise AssertionError(f"Missing action target did not request clarification: {unspecified}")
        if list(workspace.iterdir()):
            raise AssertionError("Permission checks changed the workspace")
        print(f"Pify headless permission smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
