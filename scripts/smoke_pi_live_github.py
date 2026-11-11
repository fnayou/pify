"""Exercise one public GitHub commit through native Pi in a disposable agent."""

import argparse
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from smoke_pi_git_package import commands, health, setup_report
from smoke_pi_package import check_tui, run_pi, snapshot


GITHUB_URL = "https://github.com/fnayou/pify.git"
SOURCE_PREFIX = "git:github.com/fnayou/pify@"


def git(args: list[str], cwd: Path, env: dict[str, str]) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, env=env, text=True,
                            capture_output=True, timeout=120)
    if result.returncode != 0:
        raise AssertionError(f"GitHub source check failed: {result.stderr[-1000:]}")
    return result.stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("commit", help="full lowercase commit already reachable from public GitHub")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.commit):
        parser.error("commit must be a full lowercase Git hash")

    with tempfile.TemporaryDirectory(prefix="pify-live-github-smoke-") as directory:
        root = Path(directory).resolve()
        if root.stat().st_mode & 0o077:
            raise AssertionError("Disposable Pi agent parent is accessible to other users")
        agent = root / "agent"
        workspace = root / "workspace"
        other_package = root / "other-package"
        reviewed = root / "reviewed"
        for path in (agent, workspace, other_package):
            path.mkdir()
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
        npm_user_config = root / "npm-user-config"
        npm_global_config = root / "npm-global-config"
        npm_user_config.write_text("")
        npm_global_config.write_text("")

        env = os.environ.copy()
        for key in tuple(env):
            if key.startswith("GIT_CONFIG_KEY_") or key.startswith("GIT_CONFIG_VALUE_"):
                env.pop(key)
        env.pop("GIT_CONFIG_PARAMETERS", None)
        env.pop("GIT_CONFIG", None)
        env.update({
            "PI_CODING_AGENT_DIR": str(agent),
            "PI_CODING_AGENT_SESSION_DIR": str(root / "sessions"),
            "PI_TELEMETRY": "0",
            "GIT_CONFIG_COUNT": "0",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "NPM_CONFIG_AUDIT": "false",
            "NPM_CONFIG_FUND": "false",
            "NPM_CONFIG_OFFLINE": "true",
            "NPM_CONFIG_USERCONFIG": str(npm_user_config),
            "NPM_CONFIG_GLOBALCONFIG": str(npm_global_config),
            "NPM_CONFIG_CACHE": str(root / "npm-cache"),
        })
        env.pop("PI_PACKAGE_DIR", None)
        env.pop("PI_OFFLINE", None)
        if run_pi(["--version"], workspace, env).strip() != "1.4.0":
            raise AssertionError("Official Pi 1.4.0 is required")

        git(["clone", "--no-checkout", GITHUB_URL, str(reviewed)], root, env)
        git(["checkout", "--detach", args.commit], reviewed, env)
        if git(["rev-parse", "HEAD"], reviewed, env) != args.commit or \
           git(["remote", "get-url", "origin"], reviewed, env) != GITHUB_URL:
            raise AssertionError("Reviewed checkout does not match the GitHub source and requested commit")

        run_pi(["install", str(other_package)], workspace, env)
        settings_file = agent / "settings.json"
        settings = json.loads(settings_file.read_text())
        settings["theme"] = "system"
        settings_file.write_text(json.dumps(settings))
        original_packages = settings["packages"]
        user_state = (user_skill.read_bytes(), (agent / "auth.json").read_bytes(),
                      (agent / "models.json").read_bytes(), note.read_bytes(),
                      (other_package / "package.json").read_bytes())

        run_pi(["--offline", "--no-mcp", "--no-session", "--mode", "rpc"], workspace, env,
               '{"id":"warm","type":"get_state"}\n')
        before_preview = (snapshot(agent), snapshot(workspace))
        preview = setup_report(workspace, env, f"preview-git {args.commit}",
                               ["-e", str(reviewed), "--pify-preflight"])
        if preview.get("status") != "preview" or preview["source"]["commit"] != args.commit or \
           preview["piRegistration"]["action"] != "add_pinned_git_declaration":
            raise AssertionError(f"Unexpected GitHub source preview: {preview}")
        if (snapshot(agent), snapshot(workspace)) != before_preview:
            raise AssertionError("GitHub source preview changed the fixture")

        source = SOURCE_PREFIX + args.commit
        run_pi(["install", source], workspace, env)
        checkout = agent / "git" / "github.com" / "fnayou" / "pify"
        if json.loads(settings_file.read_text())["packages"] != [*original_packages, source] or \
           (checkout / ".git" / "HEAD").read_text().strip() != args.commit:
            raise AssertionError("Native Pi install did not declare and check out the exact GitHub pin")
        loaded = commands(workspace, env)
        if loaded.get("pify-health", {}).get("source") != "extension" or \
           loaded.get("skill:pify-test-first", {}).get("sourceInfo", {}).get("origin") != "package" or \
           Path(loaded["skill:pify-debug"]["sourceInfo"]["path"]) != user_skill:
            raise AssertionError("Installed package resources or user skill precedence are wrong")
        review_code = preview["source"]["reviewCode"]
        if setup_report(workspace, env, f"verify-git {args.commit} {review_code}")["status"] != "verified" or \
           health(workspace, env)["install"]["status"] != "installed":
            raise AssertionError("GitHub pin failed ordinary-session verification or health")
        check_tui(workspace, env)
        after_session = json.loads(settings_file.read_text())
        if after_session.get("theme") != "system":
            raise AssertionError("Existing user theme changed during ordinary Pi startup")

        run_pi(["remove", source], workspace, env)
        expected_settings = {**after_session, "packages": original_packages}
        if checkout.exists() or json.loads(settings_file.read_text()) != expected_settings or \
           "pify-health" in commands(workspace, env):
            raise AssertionError("Pi removal left Pify installed or changed unrelated settings")
        if (user_skill.read_bytes(), (agent / "auth.json").read_bytes(),
            (agent / "models.json").read_bytes(), note.read_bytes(),
            (other_package / "package.json").read_bytes()) != user_state:
            raise AssertionError("GitHub package lifecycle changed unrelated user files")
    print(f"Pify live GitHub pin smoke passed: {args.commit} Pi 1.4.0 {os.uname().sysname}")


if __name__ == "__main__":
    main()
