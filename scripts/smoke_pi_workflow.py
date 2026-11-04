"""Verify one-project workflow opt-in through official Pi 1.4.0."""

import json
import os
import select
import subprocess
import tempfile
import time
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
RESOURCE = "skills/pify-development-workflow/SKILL.md"


def run_pi(args: list[str], workspace: Path, env: dict[str, str], input_text: str | None = None) -> str:
    result = subprocess.run(
        ["pi", *args], cwd=workspace, env=env, input=input_text, text=True,
        capture_output=True, timeout=30, check=False,
    )
    if result.returncode != 0:
        raise AssertionError(f"Pi failed ({result.returncode}): {result.stderr}")
    return result.stdout


def rpc(workspace: Path, env: dict[str, str], command: dict, scope: str | None = None, trust: bool = True) -> list[dict]:
    args = ["--offline", "--no-mcp", "--no-session", "--mode", "rpc", "--approve" if trust else "--no-approve"]
    if scope is not None:
        args.extend(["--pify-scope", scope])
    process = subprocess.Popen(["pi", *args], cwd=workspace, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    records = []
    pending = bytearray()
    try:
        assert process.stdin is not None and process.stdout is not None
        process.stdin.write(json.dumps(command).encode() + b"\n")
        process.stdin.flush()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            ready, _, _ = select.select([process.stdout], [], [], 0.2)
            if not ready:
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            pending.extend(chunk)
            while b"\n" in pending:
                line, _, remainder = pending.partition(b"\n")
                pending = bytearray(remainder)
                records.append(json.loads(line))
            response_seen = any(item.get("id") == command["id"] and item.get("type") == "response" for item in records)
            notification_seen = any(item.get("type") == "extension_ui_request" and item.get("method") == "notify" for item in records)
            if response_seen and (command["type"] != "prompt" or notification_seen):
                break
    finally:
        if process.stdin is not None:
            process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if process.returncode != 0:
        assert process.stderr is not None
        raise AssertionError(f"Pi RPC exited {process.returncode}: {process.stderr.read().decode()}")
    responses = [item for item in records if item.get("id") == command["id"] and item.get("type") == "response"]
    if len(responses) != 1 or responses[0].get("success") is not True:
        raise AssertionError(f"Pi did not handle {command['type']}: {records}")
    return records


def notice(records: list[dict]) -> dict:
    notices = [item for item in records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
    if len(notices) != 1:
        raise AssertionError(f"Expected one Pify notice: {records}")
    return json.loads(notices[0]["message"])


def commands(workspace: Path, env: dict[str, str], trust: bool) -> dict:
    records = rpc(workspace, env, {"id": "commands", "type": "get_commands"}, trust=trust)
    response = next(item for item in records if item.get("id") == "commands")
    return {item["name"]: item for item in response["data"]["commands"]}


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-workflow-smoke-") as fixture:
        root = Path(fixture).resolve()
        agent = root / "agent"
        first = root / "first"
        second = root / "second"
        agent.mkdir()
        first.mkdir()
        second.mkdir()
        (first / "AGENTS.md").write_text("first project instructions\n")
        (first / ".pi").mkdir()
        (first / ".pi" / "APPEND_SYSTEM.md").write_text("existing system instructions\n")
        (second / "AGENTS.md").write_text("second project instructions\n")
        env = os.environ.copy()
        env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})
        if run_pi(["--version"], first, env).strip() != "1.4.0":
            raise AssertionError("Pi 1.4.0 fixture required")
        run_pi(["install", str(PACKAGE_ROOT)], first, env)

        denied = notice(rpc(first, env, {"id": "denied", "type": "prompt", "message": "/pify-workflow enable"}))
        if denied.get("outcome") != "clarification_required" or (first / ".pi" / RESOURCE).exists():
            raise AssertionError(f"Headless workflow enable did not fail closed: {denied}")
        enabled = notice(rpc(first, env, {"id": "enable", "type": "prompt", "message": "/pify-workflow enable"}, scope=RESOURCE))
        if enabled.get("status") != "enabled":
            raise AssertionError(f"Scoped project opt-in failed: {enabled}")
        skill_file = first / ".pi" / RESOURCE
        if not skill_file.is_file():
            raise AssertionError("Project workflow skill was not created")
        if (first / "AGENTS.md").read_text() != "first project instructions\n" or (first / ".pi" / "APPEND_SYSTEM.md").read_text() != "existing system instructions\n":
            raise AssertionError("Opt-in changed an existing project file")
        if sorted(path.name for path in second.iterdir()) != ["AGENTS.md"]:
            raise AssertionError("Opt-in changed the second project")

        loaded = commands(first, env, trust=True).get("skill:pify-development-workflow")
        if loaded is None or Path(loaded["sourceInfo"]["path"]) != skill_file:
            raise AssertionError(f"Trusted first project did not load its workflow skill: {loaded}")
        if "skill:pify-development-workflow" in commands(first, env, trust=False):
            raise AssertionError("Declined project trust loaded the workflow skill")
        if "skill:pify-development-workflow" in commands(second, env, trust=True):
            raise AssertionError("Unopted second project advertised the workflow skill")
        if notice(rpc(second, env, {"id": "status", "type": "prompt", "message": "/pify-workflow status"}))["status"] != "disabled":
            raise AssertionError("Unopted second project did not report disabled status")

        for workspace, expected in ((first, "enabled"), (second, "disabled")):
            report = notice(rpc(workspace, env, {"id": f"health-{expected}", "type": "prompt", "message": "/pify-health"}))
            if report["projectWorkflow"]["status"] != expected:
                raise AssertionError(f"Wrong project workflow health state: {report['projectWorkflow']}")
        if (second / "AGENTS.md").read_text() != "second project instructions\n":
            raise AssertionError("Second project instructions changed")
        print(f"Pify project workflow smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
