"""Exercise Pi's commit-pinned Git package lifecycle in isolated agent fixtures."""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from smoke_pi_package import (
    check_installed_models_and_permissions, check_tui, rollback_theme,
    run_command_rpc, run_health_rpc, run_pi, snapshot,
)


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SOURCE_PREFIX = "git:github.com/fnayou/pify@"


def commands(workspace: Path, env: dict[str, str]) -> dict:
    output = run_pi(
        ["--offline", "--no-mcp", "--no-session", "--mode", "rpc"],
        workspace, env, '{"id":"commands","type":"get_commands"}\n',
    )
    responses = [json.loads(line) for line in output.splitlines()]
    matched = [item for item in responses if item.get("id") == "commands" and item.get("success") is True]
    if len(matched) != 1:
        raise AssertionError(f"Pi did not return commands: {responses}")
    return {item["name"]: item for item in matched[0]["data"]["commands"]}


def health(workspace: Path, env: dict[str, str]) -> dict:
    records = run_health_rpc(workspace, env)
    notices = [item for item in records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
    if len(notices) != 1:
        raise AssertionError(f"Pify health did not respond: {records}")
    return json.loads(notices[0]["message"])


def setup_report(workspace: Path, env: dict[str, str], command: str, extra_args: list[str] | None = None) -> dict:
    records = run_command_rpc(workspace, env, f"/pify-setup {command}", "git-setup", extra_args, require_response=False)
    notices = [item for item in records if item.get("type") == "extension_ui_request" and item.get("method") == "notify"]
    if len(notices) != 1:
        raise AssertionError(f"Pify Git setup did not respond: {records}")
    return json.loads(notices[0]["message"])


def state_without_git_metadata(agent: Path, workspace: Path) -> tuple[dict, dict]:
    installed = snapshot(agent)
    runtime_and_user_files = {
        name: contents for name, contents in installed.items()
        if not name.startswith("git/github.com/fnayou/pify/.git/")
    }
    return runtime_and_user_files, snapshot(workspace)


def exercise(root: Path, source: str, commit: str, mirror: Path, existing: bool) -> None:
    agent = root / "agent"
    workspace = root / "workspace"
    agent.mkdir(parents=True)
    workspace.mkdir()
    note = workspace / "user-note.md"
    note.write_text("Unrelated project note\n")
    env = os.environ.copy()
    env.update({
        "PI_CODING_AGENT_DIR": str(agent),
        "PI_CODING_AGENT_SESSION_DIR": str(root / "sessions"),
        "PI_TELEMETRY": "0",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": f"url.{mirror.as_uri()}.insteadOf",
        "GIT_CONFIG_VALUE_0": "https://github.com/fnayou/pify",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "NPM_CONFIG_AUDIT": "false",
        "NPM_CONFIG_FUND": "false",
        "NPM_CONFIG_OFFLINE": "true",
    })
    env.pop("PI_PACKAGE_DIR", None)
    env.pop("PI_OFFLINE", None)
    other_package = root / "other-package"
    expected_settings_after_remove = None
    other_state = None
    if existing:
        other_package.mkdir()
        (other_package / "package.json").write_text(json.dumps({
            "name": "existing-user-package", "version": "1.0.0", "private": True,
            "pi": {"extensions": [], "skills": [], "prompts": [], "themes": []},
        }))
        user_skill = agent / "skills" / "pify-debug" / "SKILL.md"
        user_skill.parent.mkdir(parents=True)
        user_skill.write_text("---\nname: pify-debug\ndescription: Existing user skill\n---\n")
        (agent / "auth.json").write_text("{}\n")
        (agent / "models.json").write_text('{"providers":{}}\n')
        run_pi(["install", str(other_package)], workspace, env)
        settings_file = agent / "settings.json"
        settings = json.loads(settings_file.read_text())
        settings["theme"] = "system"
        settings_file.write_text(json.dumps(settings))
        original_settings = json.loads(settings_file.read_text())
        other_state = {
            "skill": user_skill.read_bytes(), "auth": (agent / "auth.json").read_bytes(),
            "models": (agent / "models.json").read_bytes(),
            "other_package": (other_package / "package.json").read_bytes(),
        }

    reviewed = root / "reviewed"
    subprocess.run(["git", "clone", mirror.as_uri(), str(reviewed)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(reviewed), "checkout", commit], check=True, capture_output=True)
    run_pi(["--offline", "--no-mcp", "--no-session", "--mode", "rpc"], workspace, env,
           '{"id":"warm","type":"get_state"}\n')
    before_preview = (snapshot(agent), snapshot(workspace))
    preview = setup_report(workspace, env, f"preview-git {commit}", ["-e", str(reviewed), "--pify-preflight"])
    if preview.get("schema") != "pify.git-setup-preview/v1" or preview.get("status") != "preview" or \
       preview["source"]["commit"] != commit or preview["source"]["origin"] != "not_verified" or \
       preview["piRegistration"]["action"] != "add_pinned_git_declaration":
        raise AssertionError(f"Unexpected pinned Git preview: {preview}")
    if (snapshot(agent), snapshot(workspace)) != before_preview:
        raise AssertionError("Pinned Git preview changed the isolated fixture")

    run_pi(["install", source], workspace, env)
    listing = run_pi(["list"], workspace, env)
    if source not in listing:
        raise AssertionError(f"Pinned Git source missing from Pi list: {listing}")
    checkout = agent / "git" / "github.com" / "fnayou" / "pify"
    head = checkout / ".git" / "HEAD"
    if head.read_text().strip() != commit:
        raise AssertionError("Pi did not check out the requested Git commit")
    packages = json.loads((agent / "settings.json").read_text())["packages"]
    if packages.count(source) != 1:
        raise AssertionError(f"Pi did not declare the pinned Git source once: {packages}")
    loaded = commands(workspace, env)
    if loaded.get("pify-health", {}).get("source") != "extension":
        raise AssertionError("Pify health did not load from the Git package")
    if loaded.get("skill:pify-test-first", {}).get("sourceInfo", {}).get("origin") != "package":
        raise AssertionError("Pify skill did not load from the Git package")
    if existing and Path(loaded["skill:pify-debug"]["sourceInfo"]["path"]) != user_skill:
        raise AssertionError("Git install replaced an existing user skill")
    review_code = preview["source"]["reviewCode"]
    verified = setup_report(workspace, env, f"verify-git {commit} {review_code}")
    if verified.get("schema") != "pify.git-setup-verification/v1" or verified.get("status") != "verified" or \
       verified["source"]["path"] != str(checkout) or verified["source"]["runtimeDigest"] != preview["source"]["runtimeDigest"]:
        raise AssertionError(f"Installed Git source differs from reviewed bytes: {verified}")
    if existing:
        runtime_file = checkout / "src" / "setup-preview.mjs"
        original_runtime = runtime_file.read_bytes()
        runtime_file.write_bytes(original_runtime + b"\n// fixture-only change\n")
        try:
            if setup_report(workspace, env, f"verify-git {commit} {review_code}")["status"] != "mismatch":
                raise AssertionError("Changed Git runtime verified against the prior review")
        finally:
            runtime_file.write_bytes(original_runtime)
    before_health = (snapshot(agent), snapshot(workspace))
    report = health(workspace, env)
    if report["compatibility"]["status"] != "verified" or report["install"]["status"] != "installed" or report["install"]["sourceKind"] != "git":
        raise AssertionError(f"Pinned Git health is wrong: {report['install']}")
    if (snapshot(agent), snapshot(workspace)) != before_health:
        raise AssertionError("Git package health changed the isolated fixture")
    head.write_text("0" * 40 + "\n")
    if health(workspace, env)["install"]["status"] != "unknown":
        raise AssertionError("Mismatched Git commit was reported as installed")
    if setup_report(workspace, env, f"verify-git {commit} {review_code}")["status"] != "mismatch":
        raise AssertionError("Mismatched Git checkout verified against the prior review")
    head.unlink()
    if health(workspace, env)["install"]["status"] != "unknown":
        raise AssertionError("Missing Git commit was reported as installed")
    head.write_text(commit + "\n")

    if existing:
        check_tui(workspace, env)
        if json.loads((agent / "settings.json").read_text()).get("theme") != "system":
            raise AssertionError("Existing theme changed during ordinary Git session")
        other_state["models"] = check_installed_models_and_permissions(workspace, agent, env)
        settings_after_session = json.loads((agent / "settings.json").read_text())
        expected_settings_after_remove = {**settings_after_session, "packages": original_settings["packages"]}
    else:
        if (agent / "models.json").exists() or (agent / "extensions" / "rtk.ts").exists() or (workspace / ".pi").exists():
            raise AssertionError("Fresh Git fixture unexpectedly has optional integrations")
        check_tui(workspace, env, expected_theme="pify")
        journal = agent / "pify-state" / "theme-selection.json"
        transactions = json.loads(journal.read_text()).get("transactions", [])
        if len(transactions) != 1 or transactions[0]["approvalSource"] != "fresh-default":
            raise AssertionError("Fresh Git theme selection lacked its rollback journal")
        rollback_theme(workspace, env)
        if json.loads((agent / "settings.json").read_text()).get("theme") != "system":
            raise AssertionError("Fresh Git theme rollback did not restore system")
        if json.loads(journal.read_text())["transactions"][0]["status"] != "rolled-back":
            raise AssertionError("Fresh Git theme rollback left an active journal")
        check_tui(workspace, env)
        if json.loads((agent / "settings.json").read_text()).get("theme") != "system":
            raise AssertionError("Later Git session reselected Pify after rollback")

    run_pi(["update", source], workspace, env)
    if head.read_text().strip() != commit or health(workspace, env)["install"]["status"] != "installed":
        raise AssertionError("Same-pin Git update changed the installed package")
    if existing:
        before_failure = state_without_git_metadata(agent, workspace)
        unavailable_mirror = mirror.with_name("source-unavailable.git")
        mirror.rename(unavailable_mirror)
        try:
            failed = subprocess.run(["pi", "update", source], cwd=workspace, env=env,
                                    text=True, capture_output=True, timeout=30)
            if failed.returncode == 0 or "git fetch" not in failed.stdout + failed.stderr:
                raise AssertionError("Unavailable Git source did not fail during fetch")
            if head.read_text().strip() != commit or health(workspace, env)["install"]["status"] != "installed":
                raise AssertionError("Failed Git update lost the prior installed package")
            if state_without_git_metadata(agent, workspace) != before_failure:
                raise AssertionError("Failed Git update changed installed runtime or user files")
        finally:
            unavailable_mirror.rename(mirror)
        run_pi(["update", source], workspace, env)
        if head.read_text().strip() != commit or health(workspace, env)["install"]["status"] != "installed":
            raise AssertionError("Git update did not recover after the source returned")

    run_pi(["remove", source], workspace, env)
    if source in run_pi(["list"], workspace, env) or checkout.exists():
        raise AssertionError("Pi left the Git package installed after removal")
    if "pify-health" in commands(workspace, env):
        raise AssertionError("Pify command remained after Git package removal")
    if note.read_text() != "Unrelated project note\n":
        raise AssertionError("Pi changed the unrelated workspace")
    if existing:
        removed_settings = json.loads((agent / "settings.json").read_text())
        if removed_settings != expected_settings_after_remove:
            raise AssertionError("Pi removal changed unrelated settings after ordinary startup")
        current_other = {
            "skill": user_skill.read_bytes(), "auth": (agent / "auth.json").read_bytes(),
            "models": (agent / "models.json").read_bytes(),
            "other_package": (other_package / "package.json").read_bytes(),
        }
        if current_other != other_state:
            raise AssertionError("Pi changed unrelated existing-user files")
        if str(other_package) not in run_pi(["list"], workspace, env):
            raise AssertionError("Pi removal hid the unrelated package")
    elif json.loads((agent / "settings.json").read_text()).get("theme") != "system":
        raise AssertionError("Git package removal changed the restored theme")


def main() -> None:
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=PACKAGE_ROOT, text=True).strip()
    if len(commit) != 40 or any(character not in "0123456789abcdef" for character in commit):
        raise AssertionError("The checked-out Git commit is not a full lowercase hash")
    with tempfile.TemporaryDirectory(prefix="pify-git-package-smoke-") as directory:
        root = Path(directory).resolve()
        mirror = root / "source.git"
        subprocess.run(["git", "init", "--bare", str(mirror)], check=True, capture_output=True)
        subprocess.run(["git", "--git-dir", str(mirror), "config", "receive.shallowUpdate", "true"],
                       check=True, capture_output=True)
        pushed = subprocess.run(["git", "push", str(mirror), f"{commit}:refs/heads/pify-smoke"],
                                cwd=PACKAGE_ROOT, text=True, capture_output=True)
        if pushed.returncode != 0:
            raise AssertionError(f"Could not mirror the checked-out commit: {pushed.stderr[-1000:]}")
        subprocess.run(["git", "--git-dir", str(mirror), "symbolic-ref", "HEAD", "refs/heads/pify-smoke"],
                       check=True, capture_output=True)
        for name, existing in (("fresh", False), ("existing", True)):
            exercise(root / name, SOURCE_PREFIX + commit, commit, mirror, existing)
    print(f"Pify pinned Git package smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
