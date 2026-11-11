"""Prove pinned Git version changes and partial-failure recovery in disposable Pi."""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from smoke_pi_git_package import commands, health, setup_report
from smoke_pi_package import run_pi


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SOURCE_PREFIX = "git:github.com/fnayou/pify@"


def git(args: list[str], cwd: Path | None = None) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, timeout=30)
    if result.returncode != 0:
        raise AssertionError(f"Git fixture failed: {result.stderr[-1000:]}")
    return result.stdout.strip()


def require_backup(backup: Path, commit: str) -> None:
    backed_up = git(["--git-dir", str(backup), "rev-parse", "--verify", "refs/heads/pify-backup^{commit}"])
    if backed_up != commit:
        raise AssertionError("Backup does not contain the recorded installed commit")
    git(["--git-dir", str(backup), "fsck", "--strict", "--no-reflogs"])


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-git-version-smoke-") as directory:
        root = Path(directory).resolve()
        if root.stat().st_mode & 0o077:
            raise AssertionError("Git backup parent is accessible to other users")
        mirror = root / "source.git"
        working = root / "synthetic-next"
        reviewed_old = root / "reviewed-old"
        agent = root / "agent"
        workspace = root / "workspace"
        other_package = root / "other-package"
        agent.mkdir()
        workspace.mkdir()
        other_package.mkdir()
        note = workspace / "user-note.md"
        note.write_text("Unrelated project note\n")
        (other_package / "package.json").write_text(json.dumps({
            "name": "existing-user-package", "version": "1.0.0", "private": True,
            "pi": {"extensions": [], "skills": [], "prompts": [], "themes": []},
        }))
        user_skill = agent / "skills" / "pify-debug" / "SKILL.md"
        user_skill.parent.mkdir(parents=True)
        user_skill.write_text("---\nname: pify-debug\ndescription: Existing user skill\n---\n")
        (agent / "auth.json").write_text("{}\n")
        (agent / "models.json").write_text('{"providers":{}}\n')

        git(["init", "--bare", str(mirror)])
        git(["--git-dir", str(mirror), "config", "receive.shallowUpdate", "true"])
        old = git(["rev-parse", "HEAD"], PACKAGE_ROOT)
        git(["push", str(mirror), f"{old}:refs/heads/pify-old"], PACKAGE_ROOT)
        git(["--git-dir", str(mirror), "symbolic-ref", "HEAD", "refs/heads/pify-old"])
        git(["clone", mirror.as_uri(), str(working)])
        manifest = working / "package.json"
        package = json.loads(manifest.read_text())
        old_version = package["version"]
        year, month, patch = map(int, old_version.split("."))
        next_version = f"{year}.{month}.{patch + 1}"
        package["version"] = next_version
        manifest.write_text(json.dumps(package, indent=2) + "\n")
        git(["config", "user.name", "Pify fixture"], working)
        git(["config", "user.email", "fixture@example.invalid"], working)
        git(["add", "package.json"], working)
        git(["commit", "-m", "test: synthetic next Pify version"], working)
        new = git(["rev-parse", "HEAD"], working)
        git(["push", str(mirror), f"{new}:refs/heads/pify-next"], working)
        git(["--git-dir", str(mirror), "symbolic-ref", "HEAD", "refs/heads/pify-next"])
        git(["checkout", "--detach", new], working)
        git(["clone", mirror.as_uri(), str(reviewed_old)])
        git(["checkout", old], reviewed_old)
        old_source = SOURCE_PREFIX + old
        new_source = SOURCE_PREFIX + new

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
        if run_pi(["--version"], workspace, env).strip() != "1.4.0":
            raise AssertionError("Official Pi 1.4.0 is required")
        run_pi(["install", str(other_package)], workspace, env)
        settings_file = agent / "settings.json"
        settings = json.loads(settings_file.read_text())
        settings["theme"] = "system"
        settings_file.write_text(json.dumps(settings))
        original_packages = settings["packages"]

        def current_user_state() -> tuple[bytes, ...]:
            return (user_skill.read_bytes(), (agent / "auth.json").read_bytes(),
                    (agent / "models.json").read_bytes(), note.read_bytes(),
                    (other_package / "package.json").read_bytes())

        user_state = current_user_state()

        run_pi(["--offline", "--no-mcp", "--no-session", "--mode", "rpc"], workspace, env,
               '{"id":"warm","type":"get_state"}\n')
        old_preview = setup_report(workspace, env, f"preview-git {old}", ["-e", str(reviewed_old), "--pify-preflight"])
        new_preview = setup_report(workspace, env, f"preview-git {new}", ["-e", str(working), "--pify-preflight"])
        if old_preview["status"] != "preview" or new_preview["status"] != "preview" or \
           old_preview["source"]["reviewCode"] == new_preview["source"]["reviewCode"]:
            raise AssertionError("Distinct pinned versions did not receive distinct review codes")

        checkout = agent / "git" / "github.com" / "fnayou" / "pify"
        marker = checkout.parent / ".pify.pi-update-incomplete"

        def assert_installed(source: str, commit: str, version: str, review_code: str) -> None:
            declared = json.loads(settings_file.read_text())
            if declared["packages"] != [*original_packages, source] or declared.get("theme") != "system":
                raise AssertionError("Version change altered the unrelated Pi declaration or theme")
            if (checkout / ".git" / "HEAD").read_text().strip() != commit or \
               json.loads((checkout / "package.json").read_text())["version"] != version:
                raise AssertionError("Pi checkout does not match the selected version")
            report = health(workspace, env)
            if report["install"]["status"] != "installed" or report["install"]["sourceKind"] != "git" or \
               report["pifyPackageVersion"] != version:
                raise AssertionError("Health did not match the selected Git version")
            if setup_report(workspace, env, f"verify-git {commit} {review_code}")["status"] != "verified":
                raise AssertionError("Installed Git runtime differs from its reviewed version")
            if marker.exists():
                raise AssertionError("Pi left an incomplete-update marker after success")
            if current_user_state() != user_state:
                raise AssertionError("Version change modified unrelated user files")

        run_pi(["install", old_source], workspace, env)
        assert_installed(old_source, old, old_version, old_preview["source"]["reviewCode"])

        update_preview = setup_report(
            workspace, env,
            f"preview-update-git {old} {old_preview['source']['reviewCode']} {new}",
            ["-e", str(working), "--pify-preflight"],
        )
        if update_preview.get("schema") != "pify.git-update-preview/v1" or \
           update_preview["piRegistration"]["action"] != "replace_pinned_git_declaration" or \
           update_preview["transition"] != {"fromCommit": old, "toCommit": new, "backupRequired": True} or \
           update_preview["source"]["reviewCode"] != new_preview["source"]["reviewCode"]:
            raise AssertionError(f"Unexpected reviewed Git version-change preview: {update_preview}")
        assert_installed(old_source, old, old_version, old_preview["source"]["reviewCode"])

        incomplete_backup = root / "incomplete-backup.git"
        git(["init", "--bare", str(incomplete_backup)])
        try:
            require_backup(incomplete_backup, old)
        except AssertionError:
            pass
        else:
            raise AssertionError("An incomplete backup was accepted before update")
        assert_installed(old_source, old, old_version, old_preview["source"]["reviewCode"])

        backup = root / "private-backup.git"
        git(["init", "--bare", str(backup)])
        git(["--git-dir", str(backup), "config", "receive.shallowUpdate", "true"])
        git(["push", str(backup), f"{old}:refs/heads/pify-backup"], checkout)
        require_backup(backup, old)

        run_pi(["install", new_source], workspace, env)
        assert_installed(new_source, new, next_version, new_preview["source"]["reviewCode"])
        run_pi(["install", old_source], workspace, env)
        assert_installed(old_source, old, old_version, old_preview["source"]["reviewCode"])

        failing_bin = root / "failing-bin"
        failing_bin.mkdir()
        npm = failing_bin / "npm"
        npm.write_text("#!/bin/sh\nexit 71\n")
        npm.chmod(0o755)
        failing_env = {**env, "PATH": str(failing_bin) + os.pathsep + env["PATH"]}
        failed = subprocess.run(["pi", "install", new_source], cwd=workspace, env=failing_env,
                                text=True, capture_output=True, timeout=30)
        if failed.returncode == 0 or "npm install" not in failed.stdout + failed.stderr:
            raise AssertionError("Forced dependency installation failure did not reach the partial-update seam")
        if json.loads(settings_file.read_text())["packages"] != [*original_packages, old_source] or \
           (checkout / ".git" / "HEAD").read_text().strip() != new or not marker.exists():
            raise AssertionError("Pi did not expose the expected incomplete version transition")
        if health(workspace, env)["install"]["status"] != "unknown":
            raise AssertionError("Health claimed the incomplete update was installed")
        if current_user_state() != user_state:
            raise AssertionError("Failed version change modified unrelated user files")
        blocked_preview = setup_report(
            workspace, env,
            f"preview-update-git {old} {old_preview['source']['reviewCode']} {new}",
            ["-e", str(working), "--pify-preflight"],
        )
        if blocked_preview.get("status") != "error" or "no longer matches" not in blocked_preview.get("message", ""):
            raise AssertionError("Incomplete Git update was accepted for another version change")

        unavailable_mirror = mirror.with_name("source-unavailable.git")
        mirror.rename(unavailable_mirror)
        unavailable_restore = subprocess.run(["pi", "install", old_source], cwd=workspace, env=env,
                                             text=True, capture_output=True, timeout=30)
        if unavailable_restore.returncode == 0 or "git fetch" not in unavailable_restore.stdout + unavailable_restore.stderr:
            raise AssertionError("Rollback unexpectedly succeeded without the offline backup")
        if health(workspace, env)["install"]["status"] != "unknown" or current_user_state() != user_state:
            raise AssertionError("Failed remote rollback changed the partial state or unrelated files")
        require_backup(backup, old)
        restore_env = {**env, "GIT_CONFIG_KEY_0": f"url.{backup.as_uri()}.insteadOf"}
        run_pi(["install", old_source], workspace, restore_env)
        assert_installed(old_source, old, old_version, old_preview["source"]["reviewCode"])
        run_pi(["remove", old_source], workspace, env)
        if checkout.exists() or json.loads(settings_file.read_text())["packages"] != original_packages or marker.exists():
            raise AssertionError("Pi removal left Pify installed or changed the unrelated package")
        if "pify-health" in commands(workspace, env):
            raise AssertionError("Pify command remained after removal")
        if current_user_state() != user_state:
            raise AssertionError("Pi removal modified unrelated user files")
    print(f"Pify Git version-change and offline rollback smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
