"""Rehearse a reviewed public Git pin update in disposable Pi state; no release claim."""

import argparse
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from smoke_pi_git_package import health, setup_report
from smoke_pi_package import run_pi

URL = "https://github.com/fnayou/pify.git"
SOURCE = "git:github.com/fnayou/pify@"
NON_RUNTIME_REHEARSAL_FILES = {
    "scripts/smoke_pi_public_git_update.py",
    ".github/workflows/live-github-update-smoke.yml",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def git(args: list[str], cwd: Path, env: dict[str, str]) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, env=env, text=True,
                            capture_output=True, timeout=120)
    if result.returncode:
        raise AssertionError(result.stderr[-800:])
    return result.stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("from_commit", help="reviewed full commit A on public main")
    parser.add_argument("to_commit", help="descendant full commit B on public main")
    args = parser.parse_args()
    if not all(re.fullmatch(r"[0-9a-f]{40}", commit) for commit in (args.from_commit, args.to_commit)):
        parser.error("both commits must be full lowercase Git hashes")
    old_commit, new_commit = args.from_commit, args.to_commit
    with tempfile.TemporaryDirectory(prefix="pify-public-update-") as tmp:
        root = Path(tmp).resolve()
        require(root.stat().st_mode & 0o077 == 0, "Disposable root is not private")
        agent, workspace, reviewed = (root / name for name in ("agent", "workspace", "reviewed"))
        agent.mkdir()
        workspace.mkdir()
        (workspace / "user-note").write_text("keep\n")
        (agent / "auth.json").write_text("{}\n")
        (agent / "models.json").write_text('{"providers":{}}\n')
        npm_user_config = root / "npm-user-config"
        npm_global_config = root / "npm-global-config"
        npm_user_config.write_text("")
        npm_global_config.write_text("")
        env = os.environ.copy()
        for key in tuple(env):
            if key.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")):
                env.pop(key)
        env.pop("GIT_CONFIG_PARAMETERS", None)
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
            "NPM_CONFIG_OFFLINE": "false",
            "NPM_CONFIG_CACHE": str(root / "npm-cache"),
            "NPM_CONFIG_USERCONFIG": str(npm_user_config),
            "NPM_CONFIG_GLOBALCONFIG": str(npm_global_config),
        })
        env.pop("PI_PACKAGE_DIR", None)
        env.pop("PI_OFFLINE", None)
        require(run_pi(["--version"], workspace, env).strip() == "1.6.0", "Official Pi 1.6.0 is required")
        git(["clone", "--no-checkout", URL, str(reviewed)], root, env)
        git(["checkout", "--detach", old_commit], reviewed, env)
        require(git(["rev-parse", "HEAD"], reviewed, env) == old_commit, "Reviewed A checkout differs")
        try:
            git(["merge-base", "--is-ancestor", old_commit, new_commit], reviewed, env)
        except AssertionError as error:
            raise AssertionError("B must descend from A") from error
        try:
            git(["merge-base", "--is-ancestor", new_commit, "refs/remotes/origin/main"], reviewed, env)
        except AssertionError as error:
            raise AssertionError("B must be reachable from public main") from error
        changed = git(["diff", "--name-only", old_commit, new_commit], reviewed, env).splitlines()
        require(bool(changed) and all(path.startswith("docs/") or path in NON_RUNTIME_REHEARSAL_FILES
                                      for path in changed), "B changes installed runtime or package metadata")
        old_preview = setup_report(workspace, env, f"preview-git {old_commit}",
                                   ["-e", str(reviewed), "--pify-preflight"])
        require(old_preview["status"] == "preview", "A preview failed")
        old_code = old_preview["source"]["reviewCode"]
        run_pi(["install", SOURCE + old_commit], workspace, env)
        checkout = agent / "git/github.com/fnayou/pify"
        settings = agent / "settings.json"
        def check(commit: str, code: str) -> None:
            require((checkout / ".git/HEAD").read_text().strip() == commit, "Managed checkout differs")
            require(SOURCE + commit in json.loads(settings.read_text())["packages"],
                    "Pi declaration differs")
            require(setup_report(workspace, env, f"verify-git {commit} {code}")["status"] == "verified",
                    "Installed source failed verification")
            require(health(workspace, env)["install"]["status"] == "installed", "Health is not installed")
            require((workspace / "user-note").read_text() == "keep\n", "Unrelated note changed")
            require((agent / "auth.json").read_text() == "{}\n", "Auth fixture changed")
            require((agent / "models.json").read_text() == '{"providers":{}}\n', "Models fixture changed")
        check(old_commit, old_code)
        git(["checkout", "--detach", new_commit], reviewed, env)
        require(git(["rev-parse", "HEAD"], reviewed, env) == new_commit, "Reviewed B checkout differs")
        update = setup_report(workspace, env, f"preview-update-git {old_commit} {old_code} {new_commit}",
                              ["--no-extensions", "-e", str(reviewed), "--pify-preflight"])
        require(update["status"] == "preview", "B update preview failed")
        require(update["transition"] == {"fromCommit": old_commit, "toCommit": new_commit, "backupRequired": True},
                "B update preview omitted the required backup")
        new_code = update["source"]["reviewCode"]
        check(old_commit, old_code)
        backup = root / "backup.git"
        git(["init", "--bare", str(backup)], root, env)
        git(["--git-dir", str(backup), "config", "receive.shallowUpdate", "true"], root, env)
        git(["push", str(backup), f"{old_commit}:refs/heads/pify-backup"], checkout, env)
        require(git(["--git-dir", str(backup), "rev-parse", "--verify",
                     "refs/heads/pify-backup^{commit}"], root, env) == old_commit, "Backup does not contain A")
        git(["--git-dir", str(backup), "fsck", "--strict", "--no-reflogs"], root, env)
        run_pi(["install", SOURCE + new_commit], workspace, env)
        check(new_commit, new_code)
        restore = {**env, "GIT_CONFIG_COUNT": "1",
                   "GIT_CONFIG_KEY_0": f"url.{backup.as_uri()}.insteadOf",
                   "GIT_CONFIG_VALUE_0": "https://github.com/fnayou/pify"}
        run_pi(["install", SOURCE + old_commit], workspace, restore)
        check(old_commit, old_code)
        run_pi(["remove", SOURCE + old_commit], workspace, env)
        require(not checkout.exists(), "Pi left the Pify checkout after removal")
        require(SOURCE + old_commit not in json.loads(settings.read_text())["packages"],
                "Pi left the Pify declaration after removal")
        require((workspace / "user-note").read_text() == "keep\n", "Unrelated note changed")
    print(json.dumps({"platform": os.uname().sysname, "piVersion": "1.6.0",
                      "fromCommit": old_commit, "toCommit": new_commit, "status": "passed"}))


if __name__ == "__main__":
    main()
