"""Exercise the Pify package through official Pi in an isolated fixture."""

import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def run_pi(args: list[str], workspace: Path, env: dict[str, str], input_text: str | None = None) -> str:
    result = subprocess.run(
        ["pi", *args],
        cwd=workspace,
        env=env,
        input=input_text,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(f"pi {' '.join(args)} failed ({result.returncode}): {result.stderr}")
    return result.stdout


def snapshot(directory: Path) -> dict[str, bytes]:
    return {str(path.relative_to(directory)): path.read_bytes() for path in directory.rglob("*") if path.is_file()}


def run_command_rpc(
    workspace: Path, env: dict[str, str], message: str, request_id: str,
    extra_args: list[str] | None = None, require_response: bool = True,
) -> list[dict]:
    process = subprocess.Popen(
        ["pi", "--offline", "--no-mcp", "--no-session", "--mode", "rpc", *(extra_args or [])],
        cwd=workspace, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    records = []
    pending = bytearray()
    try:
        assert process.stdin is not None and process.stdout is not None
        process.stdin.write((json.dumps({"id": request_id, "type": "prompt", "message": message}) + "\n").encode())
        process.stdin.flush()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            ready, _, _ = select.select([process.stdout], [], [], 0.2)
            if ready:
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                pending.extend(chunk)
                while b"\n" in pending:
                    line, _, remainder = pending.partition(b"\n")
                    pending = bytearray(remainder)
                    records.append(json.loads(line))
            notified = any(item.get("type") == "extension_ui_request" and item.get("method") == "notify" for item in records)
            responded = any(item.get("id") == request_id and item.get("type") == "response" for item in records)
            if notified and (responded or not require_response):
                break
        else:
            raise AssertionError(f"Pify command RPC timed out: {records}")
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
        raise AssertionError(f"Pify command RPC failed ({process.returncode}): {process.stderr.read().decode()}")
    return records


def run_health_rpc(workspace: Path, env: dict[str, str]) -> list[dict]:
    return run_command_rpc(workspace, env, "/pify-health", "health")


def check_tui(workspace: Path, env: dict[str, str], extra_args: list[str] | None = None) -> None:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    process = subprocess.Popen(
        ["pi", "--offline", "--no-mcp", "--no-session", *(extra_args or [])],
        cwd=workspace,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    os.close(slave)
    output = bytearray()
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(f"Pi TUI exited during startup ({process.returncode}): {output[-500:]!r}")
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                output.extend(os.read(master, 65536))
            if output and time.monotonic() < deadline - 8:
                break
        if not output:
            raise AssertionError("Pi TUI produced no terminal output within 10 seconds")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        os.close(master)


def main() -> None:
    package = json.loads((PACKAGE_ROOT / "package.json").read_text())
    catalog = json.loads((PACKAGE_ROOT / "skills" / "catalog.json").read_text())
    if {item["path"] for item in catalog["skills"]} != set(package["pi"]["skills"]):
        raise AssertionError("Skill catalog and Pi package declarations differ")
    for item in catalog["skills"]:
        skill = (PACKAGE_ROOT / item["path"] / "SKILL.md").read_text()
        if not all(
            field in skill for field in (
                f"name: {item['name']}",
                f"license: {item['license']}",
                f"source: {item['source']}",
                f"source-version: {item['sourceVersion']}",
            )
        ):
            raise AssertionError(f"Skill metadata and catalog differ: {item['name']}")
    with tempfile.TemporaryDirectory(prefix="pify-package-smoke-") as fixture:
        root = Path(fixture).resolve()
        agent = root / "agent"
        workspace = root / "workspace"
        other_package = root / "other-package"
        agent.mkdir()
        workspace.mkdir()
        other_package.mkdir()
        (other_package / "package.json").write_text(json.dumps({
            "name": "existing-user-package", "version": "1.0.0", "private": True,
            "pi": {"extensions": [], "skills": [], "prompts": [], "themes": []},
        }))
        user_skill = agent / "skills" / "pify-debug" / "SKILL.md"
        user_skill.parent.mkdir(parents=True)
        user_skill.write_text(
            "---\nname: pify-debug\ndescription: User's own debugging workflow.\n---\n\n# User skill\n"
        )
        user_skill_before = user_skill.read_bytes()
        env = os.environ.copy()
        env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})

        version = run_pi(["--version"], workspace, env).strip()
        if version != "1.4.0":
            raise AssertionError(f"Pi 1.4.0 fixture required, got {version!r}")

        run_pi(["install", str(other_package)], workspace, env)
        settings_before_pify = json.loads((agent / "settings.json").read_text())

        preflight_args = ["-e", str(PACKAGE_ROOT), "--pify-preflight"]
        run_pi(["--offline", "--no-mcp", "--no-session", "--mode", "rpc"], workspace, env, '{"id":"warm","type":"get_state"}\n')
        before_preflight = (snapshot(agent), snapshot(workspace))
        preflight_records = run_command_rpc(workspace, env, "/pify-setup preview", "preview", preflight_args, require_response=False)
        preflight_notices = [item for item in preflight_records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
        if len(preflight_notices) != 1:
            raise AssertionError(f"Expected one Pify setup preview: {preflight_records}")
        preview = json.loads(preflight_notices[0]["message"])
        if preview["schema"] != "pify.setup-preview/v1" or preview["piRegistration"]["action"] != "add_local_package_declaration":
            raise AssertionError(f"Unexpected setup preview: {preview}")
        if preview["firstInteractiveTheme"]["action"] != "select_pify" or preview["source"]["path"] != str(PACKAGE_ROOT):
            raise AssertionError(f"Unexpected setup source or theme: {preview}")
        if len(preview["source"]["declaredResourceDigest"]) != 64 or {item["relativePath"] for item in preview["package"]["resources"]} != {
            "extensions/pify-permissions.js", "skills/pify-debug", "skills/pify-test-first", "themes/pify.json"
        }:
            raise AssertionError(f"Setup preview omitted declared resources: {preview}")
        collisions = {item["relativePath"]: item["collision"]["status"] for item in preview["package"]["resources"]}
        if collisions.get("skills/pify-debug") != "present" or collisions.get("skills/pify-test-first") != "none":
            raise AssertionError(f"User skill collision not reported: {collisions}")
        if (snapshot(agent), snapshot(workspace)) != before_preflight:
            raise AssertionError("Pify setup preflight changed the isolated fixture")
        if str(PACKAGE_ROOT) in run_pi(["list"], workspace, env):
            raise AssertionError("Transient Pify preflight registered the package")

        fresh_agent = root / "fresh-preflight-agent"
        fresh_agent.mkdir()
        fresh_env = {**env, "PI_CODING_AGENT_DIR": str(fresh_agent)}
        fresh_records = run_command_rpc(workspace, fresh_env, "/pify-setup preview", "preview", preflight_args, require_response=False)
        fresh_notices = [item for item in fresh_records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
        if len(fresh_notices) != 1 or json.loads(fresh_notices[0]["message"])["piRegistration"]["action"] != "add_local_package_declaration":
            raise AssertionError(f"Fresh setup preflight failed: {fresh_records}")
        check_tui(workspace, fresh_env, ["-e", str(PACKAGE_ROOT), "--pify-preflight"])
        fresh_settings = fresh_agent / "settings.json"
        if fresh_settings.exists() and "theme" in json.loads(fresh_settings.read_text()):
            raise AssertionError("Transient Pify preflight selected the fresh theme")
        if (fresh_agent / "pify-state").exists():
            raise AssertionError("Transient Pify preflight wrote Pify state")

        run_pi(["install", str(PACKAGE_ROOT)], workspace, env)
        listing = run_pi(["list"], workspace, env)
        if str(PACKAGE_ROOT) not in listing:
            raise AssertionError(f"Pify missing from pi list: {listing}")

        settings = json.loads((agent / "settings.json").read_text())
        packages = settings.get("packages", [])
        if len(packages) != 2 or not all(isinstance(source, str) for source in packages):
            raise AssertionError(f"Expected existing and Pify package declarations, got {packages!r}")
        resolved_packages = {(agent / source).resolve() for source in packages}
        if resolved_packages != {other_package, PACKAGE_ROOT}:
            raise AssertionError(
                f"Pi package declarations resolve to {resolved_packages}, expected both packages"
            )
        if user_skill.read_bytes() != user_skill_before:
            raise AssertionError("Pi package install changed the existing user skill")

        rpc = run_pi(
            ["--offline", "--no-mcp", "--no-session", "--mode", "rpc"],
            workspace,
            env,
            '{"id":"smoke","type":"get_state"}\n{"id":"commands","type":"get_commands"}\n',
        )
        responses = [json.loads(line) for line in rpc.splitlines()]
        if not any(item.get("type") == "response" and item.get("command") == "get_state" and item.get("success") is True for item in responses):
            raise AssertionError(f"Pi did not start an RPC session: {rpc}")
        command_responses = [item for item in responses if item.get("id") == "commands" and item.get("success") is True]
        if len(command_responses) != 1:
            raise AssertionError(f"Pi did not return commands: {rpc}")
        commands = {item["name"]: item for item in command_responses[0]["data"]["commands"]}
        test_first = commands.get("skill:pify-test-first")
        if test_first is None or test_first["source"] != "skill" or test_first["sourceInfo"]["origin"] != "package":
            raise AssertionError(f"Pify skill did not load from its package: {test_first}")
        debug = commands.get("skill:pify-debug")
        if debug is None or Path(debug["sourceInfo"]["path"]) != user_skill:
            raise AssertionError(f"Existing user skill lost collision precedence: {debug}")

        before_health = (snapshot(agent), snapshot(workspace))
        health_records = run_health_rpc(workspace, env)
        handled = [item for item in health_records if item.get("id") == "health" and item.get("type") == "response"]
        notices = [item for item in health_records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
        if len(handled) != 1 or handled[0].get("data", {}).get("disposition") != "handled" or len(notices) != 1:
            raise AssertionError(f"Pify health command was not handled: {health_records}")
        report = json.loads(notices[0]["message"])
        if report["compatibility"]["status"] != "verified" or report["install"]["status"] != "installed" or report["inventory"]["managed"]:
            raise AssertionError(f"Unexpected Pify health report: {report}")
        bundled = {item["name"]: item for item in report["bundledSkills"]}
        if set(bundled) != {"pify-debug", "pify-test-first"} or any(
            item["sourceVersion"] != "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d" or item["license"] != "MIT"
            or not item["source"].startswith("https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/")
            for item in bundled.values()
        ):
            raise AssertionError(f"Bundled skill provenance missing: {bundled}")
        if (snapshot(agent), snapshot(workspace)) != before_health:
            raise AssertionError("Pify health command modified the isolated fixture")
        if user_skill.read_bytes() != user_skill_before:
            raise AssertionError("Pify health check changed the existing user skill")

        check_tui(workspace, env)
        rollback_records = run_command_rpc(
            workspace, env, "/pify-theme rollback", "theme-rollback",
            ["--pify-scope", "settings.json"], require_response=False,
        )
        rollback_notices = [item for item in rollback_records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
        if len(rollback_notices) != 1 or json.loads(rollback_notices[0]["message"]).get("status") != "rolled-back":
            raise AssertionError(f"Fresh theme could not be rolled back before Pi removal: {rollback_records}")
        if list(workspace.iterdir()):
            raise AssertionError("Pi created project configuration or another workspace artifact")

        settings_before_remove = json.loads((agent / "settings.json").read_text())
        run_pi(["remove", str(PACKAGE_ROOT)], workspace, env)
        if str(PACKAGE_ROOT) in run_pi(["list"], workspace, env):
            raise AssertionError("Pify remained in Pi's package list after removal")
        settings_after_remove = json.loads((agent / "settings.json").read_text())
        expected_settings = {**settings_before_remove, "packages": settings_before_pify["packages"]}
        if settings_after_remove != expected_settings:
            raise AssertionError(f"Pi removal changed unrelated settings: {settings_after_remove}")
        if str(other_package) not in run_pi(["list"], workspace, env):
            raise AssertionError("Pi removal hid the unrelated package")
        if user_skill.read_bytes() != user_skill_before:
            raise AssertionError("Pi package removal changed the existing user skill")
        after_remove = run_pi(
            ["--offline", "--no-mcp", "--no-session", "--mode", "rpc"],
            workspace,
            env,
            '{"id":"commands","type":"get_commands"}\n',
        )
        command_responses = [
            item for item in (json.loads(line) for line in after_remove.splitlines())
            if item.get("id") == "commands" and item.get("success") is True
        ]
        if len(command_responses) != 1:
            raise AssertionError(f"Pi did not return commands after removal: {after_remove}")
        command_names = {item["name"] for item in command_responses[0]["data"]["commands"]}
        if "pify-health" in command_names or "skill:pify-test-first" in command_names:
            raise AssertionError(f"Pify commands remained after removal: {sorted(command_names)}")
        if "skill:pify-debug" not in command_names:
            raise AssertionError("Pi package removal hid the existing user skill")
        native_files = {path.name for path in agent.iterdir()}
        if native_files != {"auth.json", "models-store.json", "settings.json", "skills", "pify-state"}:
            raise AssertionError(f"Unexpected agent configuration files: {sorted(native_files)}")
        print(f"Pify native Pi package smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
