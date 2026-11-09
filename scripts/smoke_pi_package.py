"""Exercise the Pify package through official Pi in an isolated fixture."""

import fcntl
import json
import os
import pty
import secrets
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

from smoke_pi_models import RpcSession, assistant_text, start_server
from smoke_pi_permissions import permission_result


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


def verify_local_source(workspace: Path, env: dict[str, str], review_code: str) -> None:
    agent = Path(env["PI_CODING_AGENT_DIR"])
    before = (snapshot(agent), snapshot(workspace))
    records = run_command_rpc(
        workspace, env, f"/pify-setup verify {review_code}", "source-verify", require_response=False,
    )
    notices = [item for item in records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
    if len(notices) != 1:
        raise AssertionError(f"Pify source verification did not report a result: {records}")
    report = json.loads(notices[0]["message"])
    if report.get("schema") != "pify.setup-verification/v1" or report.get("status") != "verified" or report["source"]["path"] != str(PACKAGE_ROOT):
        raise AssertionError(f"Installed Pi source differs from the reviewed preview: {report}")
    if (snapshot(agent), snapshot(workspace)) != before:
        raise AssertionError("Pify source verification changed the isolated fixture")


def rollback_theme(workspace: Path, env: dict[str, str]) -> None:
    records = run_command_rpc(
        workspace, env, "/pify-theme rollback", "theme-rollback",
        ["--pify-scope", "settings.json"], require_response=False,
    )
    notices = [item for item in records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
    if len(notices) != 1 or json.loads(notices[0]["message"]).get("status") != "rolled-back":
        raise AssertionError(f"Fresh theme could not be rolled back before Pi removal: {records}")


def check_failed_theme_recovery(workspace: Path, agent: Path, env: dict[str, str]) -> None:
    settings_file = agent / "settings.json"
    journal_file = agent / "pify-state" / "theme-selection.json"
    settings_before = settings_file.read_bytes()
    journal_before = json.loads(journal_file.read_text())
    if json.loads(settings_before).get("theme") != "system":
        raise AssertionError("Theme failure fixture requires the restored system choice")
    original_mode = agent.stat().st_mode & 0o777
    rpc = RpcSession(workspace, env, extra_args=["--pify-scope", "settings.json"])
    try:
        rpc.send({"id": "theme-ready", "type": "get_state"})
        os.chmod(agent, 0o500)
        try:
            records = rpc.send({"id": "theme-failure", "type": "prompt", "message": "/pify-theme enable"}, notification=True)
        finally:
            os.chmod(agent, original_mode)
    finally:
        rpc.close()
    notices = [item for item in records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
    if len(notices) != 1:
        raise AssertionError(f"Failed theme command did not report a result: {records}")
    failure = json.loads(notices[0]["message"])
    if failure.get("status") != "conflict" or "EACCES" not in failure.get("reason", ""):
        raise AssertionError(f"Theme write did not fail after journal preparation: {failure}")
    if settings_file.read_bytes() != settings_before:
        raise AssertionError("Failed theme change modified the prior user setting")
    journal = json.loads(journal_file.read_text())
    if len(journal["transactions"]) != len(journal_before["transactions"]) + 1 or journal["transactions"][-1]["status"] != "active":
        raise AssertionError(f"Failed theme change left no recoverable journal: {journal}")
    if journal["transactions"][-1]["previous"] != {"present": True, "value": "system"}:
        raise AssertionError(f"Failed theme change recorded the wrong prior choice: {journal}")

    before_health = (snapshot(agent), snapshot(workspace))
    health_records = run_health_rpc(workspace, env)
    health_notices = [item for item in health_records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
    if len(health_notices) != 1:
        raise AssertionError(f"Pify health was unavailable after theme failure: {health_records}")
    health = json.loads(health_notices[0]["message"])
    if health["install"]["status"] != "installed" or health["compatibility"]["status"] != "verified":
        raise AssertionError(f"Pify health reported the wrong state after theme failure: {health}")
    if health["themeSelection"] != {"status": "available", "savedTheme": "system", "rollbackAvailable": True}:
        raise AssertionError(f"Pify health did not expose theme recovery after failure: {health}")
    if (snapshot(agent), snapshot(workspace)) != before_health:
        raise AssertionError("Pify health changed the fixture after theme failure")

    before_status = (snapshot(agent), snapshot(workspace))
    status_records = run_command_rpc(workspace, env, "/pify-theme status", "theme-status", require_response=False)
    status_notices = [item for item in status_records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
    if len(status_notices) != 1:
        raise AssertionError(f"Theme recovery status was unavailable: {status_records}")
    status = json.loads(status_notices[0]["message"])
    if status.get("theme") != "system" or status.get("rollbackAvailable") is not True:
        raise AssertionError(f"Theme recovery was not visible in the ordinary session: {status}")
    if (snapshot(agent), snapshot(workspace)) != before_status:
        raise AssertionError("Theme recovery status changed the isolated fixture")

    rollback_theme(workspace, env)
    if settings_file.read_bytes() != settings_before:
        raise AssertionError("Theme recovery changed the prior user setting")
    if json.loads(journal_file.read_text())["transactions"][-1]["status"] != "rolled-back":
        raise AssertionError("Theme recovery left an active journal")
    after_rollback = (snapshot(agent), snapshot(workspace))
    restored_records = run_health_rpc(workspace, env)
    restored_notices = [item for item in restored_records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
    if len(restored_notices) != 1:
        raise AssertionError(f"Pify health was unavailable after theme rollback: {restored_records}")
    restored = json.loads(restored_notices[0]["message"])
    if restored["themeSelection"] != {"status": "available", "savedTheme": "system", "rollbackAvailable": False}:
        raise AssertionError(f"Pify health still offered theme rollback after recovery: {restored}")
    if (snapshot(agent), snapshot(workspace)) != after_rollback:
        raise AssertionError("Pify health changed the fixture after theme rollback")


def check_tui(
    workspace: Path, env: dict[str, str], extra_args: list[str] | None = None,
    expected_theme: str | None = None,
) -> None:
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
    theme_ready = expected_theme is None
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(f"Pi TUI exited during startup ({process.returncode}): {output[-500:]!r}")
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                output.extend(os.read(master, 65536))
            if output:
                if expected_theme is None and time.monotonic() < deadline - 8:
                    break
                if expected_theme is not None:
                    agent = Path(env["PI_CODING_AGENT_DIR"])
                    journal = agent / "pify-state" / "theme-selection.json"
                    try:
                        saved = json.loads((agent / "settings.json").read_text())
                    except (FileNotFoundError, json.JSONDecodeError):
                        saved = {}
                    if saved.get("theme") == expected_theme and journal.is_file():
                        theme_ready = True
                        break
        if not output:
            raise AssertionError("Pi TUI produced no terminal output within 10 seconds")
        if not theme_ready:
            raise AssertionError(f"Pi TUI did not save the journaled {expected_theme} theme: {output[-500:]!r}")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        os.close(master)


def check_installed_models_and_permissions(workspace: Path, agent: Path, env: dict[str, str]) -> bytes:
    local = start_server("local")
    cloud = start_server("litellm")
    local_running = True
    try:
        models = {"providers": {
            "pify-local-fixture": {
                "baseUrl": f"http://127.0.0.1:{local.server_port}/v1", "api": "openai-completions",
                "apiKey": "fixture-key", "models": [{"id": "fixture-local", "contextWindow": 8192, "maxTokens": 256}],
            },
            "pify-litellm-fixture": {
                "baseUrl": f"http://127.0.0.1:{cloud.server_port}/v1", "api": "openai-completions",
                "apiKey": "fixture-key", "authHeader": True,
                "models": [{"id": "fixture-litellm", "contextWindow": 8192, "maxTokens": 256}],
            },
        }}
        models_file = agent / "models.json"
        models_file.write_text(json.dumps(models))
        models_before = models_file.read_bytes()
        rpc = RpcSession(workspace, env)
        try:
            rpc.send({"id": "local-model", "type": "set_model", "provider": "pify-local-fixture", "modelId": "fixture-local"})
            local_events = rpc.send({"id": "local-prompt", "type": "prompt", "message": "Reply READY_LOCAL."}, settled=True)
            if assistant_text(local_events) != "READY_LOCAL" or local.requests != [("/v1/chat/completions", "fixture-local")]:
                raise AssertionError("Local model failed after Pify package setup")

            local.shutdown()
            local.server_close()
            local_running = False
            rpc.send({"id": "cloud-model", "type": "set_model", "provider": "pify-litellm-fixture", "modelId": "fixture-litellm"})
            marker = f"PIFY_CLOUD_READY_{secrets.token_hex(8)}"
            cloud_events = rpc.send({"id": "cloud-prompt", "type": "prompt", "message": f"Reply with exactly {marker}."}, settled=True)
            if assistant_text(cloud_events) != marker or cloud.requests != [("/v1/chat/completions", "fixture-litellm")]:
                raise AssertionError("LiteLLM-compatible model failed after local endpoint stopped")

            health_events = rpc.send({"id": "integrated-health", "type": "prompt", "message": "/pify-health"}, notification=True)
            notices = [item for item in health_events if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
            if len(notices) != 1 or json.loads(notices[0]["message"])["install"]["status"] != "installed":
                raise AssertionError("Pify health unavailable after model selection")
        finally:
            rpc.close()

        permission_scope = "skills/pify-test-first/SKILL.md"
        other_skill = "skills/pify-debug/SKILL.md"
        for mode, expected in (("safe", "denied"), ("balanced", "approval_required"), ("full", "approval_required")):
            result = permission_result(workspace, env, mode, permission_scope, other_skill)
            if result["outcome"] != expected or result["mode"] != mode:
                raise AssertionError(f"Headless {mode} permission result changed after setup: {result}")
        if models_file.read_bytes() != models_before:
            raise AssertionError("Pify changed the user's model configuration")
        return models_before
    finally:
        if local_running:
            local.shutdown()
            local.server_close()
        cloud.shutdown()
        cloud.server_close()


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
        if any(len(preview["source"][field]) != 64 for field in ("declaredResourceDigest", "runtimeDigest", "reviewCode")) or {item["relativePath"] for item in preview["package"]["resources"]} != {
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

        fresh_agent = root / "fresh-agent"
        fresh_workspace = root / "fresh-workspace"
        fresh_agent.mkdir()
        fresh_workspace.mkdir()
        fresh_note = fresh_workspace / "notes.txt"
        fresh_note.write_text("Unrelated project note\n")
        fresh_env = {**env, "PI_CODING_AGENT_DIR": str(fresh_agent)}
        run_pi(["--offline", "--no-mcp", "--no-session", "--mode", "rpc"], fresh_workspace, fresh_env, '{"id":"warm","type":"get_state"}\n')
        fresh_before_preview = (snapshot(fresh_agent), snapshot(fresh_workspace))
        fresh_records = run_command_rpc(fresh_workspace, fresh_env, "/pify-setup preview", "preview", preflight_args, require_response=False)
        fresh_notices = [item for item in fresh_records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
        if len(fresh_notices) != 1:
            raise AssertionError(f"Fresh setup preflight failed: {fresh_records}")
        fresh_preview = json.loads(fresh_notices[0]["message"])
        if fresh_preview["piRegistration"]["action"] != "add_local_package_declaration" or fresh_preview["firstInteractiveTheme"]["action"] != "select_pify":
            raise AssertionError(f"Fresh setup preview had the wrong plan: {fresh_preview}")
        if any(len(fresh_preview["source"][field]) != 64 for field in ("runtimeDigest", "reviewCode")):
            raise AssertionError(f"Fresh setup preview omitted the runtime review code: {fresh_preview}")
        if (snapshot(fresh_agent), snapshot(fresh_workspace)) != fresh_before_preview:
            raise AssertionError("Fresh Pify setup preview changed the isolated fixture")
        check_tui(fresh_workspace, fresh_env, ["-e", str(PACKAGE_ROOT), "--pify-preflight"])
        fresh_settings = fresh_agent / "settings.json"
        if fresh_settings.exists() and "theme" in json.loads(fresh_settings.read_text()):
            raise AssertionError("Transient Pify preflight selected the fresh theme")
        if (fresh_agent / "pify-state").exists():
            raise AssertionError("Transient Pify preflight wrote Pify state")
        if str(PACKAGE_ROOT) in run_pi(["list"], fresh_workspace, fresh_env):
            raise AssertionError("Fresh transient preview registered Pify")

        run_pi(["install", str(PACKAGE_ROOT)], fresh_workspace, fresh_env)
        if str(PACKAGE_ROOT) not in run_pi(["list"], fresh_workspace, fresh_env):
            raise AssertionError("Fresh Pi install did not register Pify")
        fresh_installed_settings = json.loads(fresh_settings.read_text())
        fresh_packages = fresh_installed_settings.get("packages", [])
        if len(fresh_packages) != 1 or not isinstance(fresh_packages[0], str) or (fresh_agent / fresh_packages[0]).resolve() != PACKAGE_ROOT:
            raise AssertionError(f"Fresh Pi install registered unexpected packages: {fresh_installed_settings}")
        verify_local_source(fresh_workspace, fresh_env, fresh_preview["source"]["reviewCode"])
        before_fresh_health = (snapshot(fresh_agent), snapshot(fresh_workspace))
        fresh_health = run_health_rpc(fresh_workspace, fresh_env)
        fresh_health_responses = [item for item in fresh_health if item.get("id") == "health" and item.get("type") == "response"]
        fresh_health_notices = [item for item in fresh_health if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
        if len(fresh_health_responses) != 1 or fresh_health_responses[0].get("data", {}).get("disposition") != "handled" or len(fresh_health_notices) != 1:
            raise AssertionError(f"Fresh Pify health command failed: {fresh_health}")
        fresh_report = json.loads(fresh_health_notices[0]["message"])
        if fresh_report["install"]["status"] != "installed" or fresh_report["install"]["sourceKind"] != "local" or fresh_report["compatibility"]["status"] != "verified":
            raise AssertionError(f"Fresh Pify health reported the wrong state: {fresh_report}")
        if (snapshot(fresh_agent), snapshot(fresh_workspace)) != before_fresh_health:
            raise AssertionError("Fresh Pify health changed the isolated fixture")

        check_tui(fresh_workspace, fresh_env, expected_theme="pify")
        fresh_journal = json.loads((fresh_agent / "pify-state" / "theme-selection.json").read_text())
        transactions = fresh_journal.get("transactions", [])
        if len(transactions) != 1 or transactions[0]["approvalSource"] != "fresh-default" or transactions[0]["previous"] != {"present": False}:
            raise AssertionError(f"Fresh theme selection lacked the approved journal: {fresh_journal}")
        rollback_theme(fresh_workspace, fresh_env)
        if json.loads(fresh_settings.read_text()).get("theme") != "system":
            raise AssertionError("Fresh theme rollback did not save the explicit system choice")
        if json.loads((fresh_agent / "pify-state" / "theme-selection.json").read_text())["transactions"][0]["status"] != "rolled-back":
            raise AssertionError("Fresh theme rollback left an active journal")
        check_tui(fresh_workspace, fresh_env)
        if json.loads(fresh_settings.read_text()).get("theme") != "system":
            raise AssertionError("A later ordinary Pi session reselected Pify after rollback")
        run_pi(["remove", str(PACKAGE_ROOT)], fresh_workspace, fresh_env)
        if str(PACKAGE_ROOT) in run_pi(["list"], fresh_workspace, fresh_env):
            raise AssertionError("Fresh Pi removal left Pify registered")
        fresh_removed_settings = json.loads(fresh_settings.read_text())
        if fresh_removed_settings.get("packages") != [] or fresh_removed_settings.get("theme") != "system":
            raise AssertionError(f"Fresh Pi removal changed the restored choice: {fresh_removed_settings}")
        fresh_commands = run_pi(
            ["--offline", "--no-mcp", "--no-session", "--mode", "rpc"], fresh_workspace, fresh_env,
            '{"id":"commands","type":"get_commands"}\n',
        )
        fresh_responses = [json.loads(line) for line in fresh_commands.splitlines()]
        fresh_command_responses = [item for item in fresh_responses if item.get("id") == "commands" and item.get("success") is True]
        if len(fresh_command_responses) != 1:
            raise AssertionError(f"Pi did not return commands after fresh removal: {fresh_commands}")
        fresh_command_names = {item["name"] for item in fresh_command_responses[0]["data"]["commands"]}
        if "pify-health" in fresh_command_names or "skill:pify-test-first" in fresh_command_names:
            raise AssertionError(f"Fresh Pi removal left Pify commands: {sorted(fresh_command_names)}")
        if snapshot(fresh_workspace) != fresh_before_preview[1] or fresh_note.read_text() != "Unrelated project note\n":
            raise AssertionError("Fresh Pi setup changed the unrelated workspace")

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
        verify_local_source(workspace, env, preview["source"]["reviewCode"])
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
        if report["compatibility"]["status"] != "verified" or report["install"]["status"] != "installed" or report["install"]["sourceKind"] != "local" or report["inventory"]["managed"]:
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

        check_tui(workspace, env, expected_theme="pify")
        models_before = check_installed_models_and_permissions(workspace, agent, env)
        rollback_theme(workspace, env)
        check_failed_theme_recovery(workspace, agent, env)
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
        if (agent / "models.json").read_bytes() != models_before:
            raise AssertionError("Pi package removal changed the user's model configuration")
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
        if native_files != {"auth.json", "models-store.json", "models.json", "settings.json", "skills", "pify-state"}:
            raise AssertionError(f"Unexpected agent configuration files: {sorted(native_files)}")
        print(f"Pify native Pi package smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
