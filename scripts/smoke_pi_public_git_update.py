"""Rehearse a public Git pin update in disposable Pi state; no release claim."""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from smoke_pi_git_package import health, setup_report
from smoke_pi_package import run_pi

A = "9faefeb17b55d6ec15d078eaa1325ee36bb8bab2"
B = "c8d5839b9467384bc32242826bb0aaa0cac30fad"
URL = "https://github.com/fnayou/pify.git"
SOURCE = "git:github.com/fnayou/pify@"


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
    with tempfile.TemporaryDirectory(prefix="pify-public-update-") as tmp:
        root = Path(tmp).resolve()
        require(root.stat().st_mode & 0o077 == 0, "Disposable root is not private")
        agent, workspace, reviewed = (root / name for name in ("agent", "workspace", "reviewed"))
        agent.mkdir()
        workspace.mkdir()
        (workspace / "user-note").write_text("keep\n")
        (agent / "auth.json").write_text("{}\n")
        (agent / "models.json").write_text('{"providers":{}}\n')
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
            "NPM_CONFIG_OFFLINE": "true",
            "NPM_CONFIG_CACHE": str(root / "npm-cache"),
        })
        env.pop("PI_PACKAGE_DIR", None)
        env.pop("PI_OFFLINE", None)
        require(run_pi(["--version"], workspace, env).strip() == "1.5.2", "Official Pi 1.5.2 is required")
        git(["clone", "--no-checkout", URL, str(reviewed)], root, env)
        git(["checkout", "--detach", A], reviewed, env)
        require(git(["rev-parse", "HEAD"], reviewed, env) == A, "Reviewed A checkout differs")
        git(["merge-base", "--is-ancestor", A, B], reviewed, env)
        changed = git(["diff", "--name-only", A, B], reviewed, env).splitlines()
        require(bool(changed) and all(path.startswith("docs/") for path in changed),
                "B changes more than documentation")
        old_preview = setup_report(workspace, env, f"preview-git {A}",
                                   ["-e", str(reviewed), "--pify-preflight"])
        require(old_preview["status"] == "preview", "A preview failed")
        old_code = old_preview["source"]["reviewCode"]
        run_pi(["install", SOURCE + A], workspace, env)
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
        check(A, old_code)
        git(["checkout", "--detach", B], reviewed, env)
        require(git(["rev-parse", "HEAD"], reviewed, env) == B, "Reviewed B checkout differs")
        update = setup_report(workspace, env, f"preview-update-git {A} {old_code} {B}",
                              ["--no-extensions", "-e", str(reviewed), "--pify-preflight"])
        require(update["status"] == "preview", "B update preview failed")
        require(update["transition"] == {"fromCommit": A, "toCommit": B, "backupRequired": True},
                "B update preview omitted the required backup")
        new_code = update["source"]["reviewCode"]
        check(A, old_code)
        backup = root / "backup.git"
        git(["init", "--bare", str(backup)], root, env)
        git(["--git-dir", str(backup), "config", "receive.shallowUpdate", "true"], root, env)
        git(["push", str(backup), f"{A}:refs/heads/pify-backup"], checkout, env)
        require(git(["--git-dir", str(backup), "rev-parse", "--verify",
                     "refs/heads/pify-backup^{commit}"], root, env) == A, "Backup does not contain A")
        git(["--git-dir", str(backup), "fsck", "--strict", "--no-reflogs"], root, env)
        run_pi(["install", SOURCE + B], workspace, env)
        check(B, new_code)
        restore = {**env, "GIT_CONFIG_COUNT": "1",
                   "GIT_CONFIG_KEY_0": f"url.{backup.as_uri()}.insteadOf",
                   "GIT_CONFIG_VALUE_0": "https://github.com/fnayou/pify"}
        run_pi(["install", SOURCE + A], workspace, restore)
        check(A, old_code)
        run_pi(["remove", SOURCE + A], workspace, env)
        require(not checkout.exists(), "Pi left the Pify checkout after removal")
        require(SOURCE + A not in json.loads(settings.read_text())["packages"],
                "Pi left the Pify declaration after removal")
        require((workspace / "user-note").read_text() == "keep\n", "Unrelated note changed")
    print(json.dumps({"platform": os.uname().sysname, "piVersion": "1.5.2",
                      "fromCommit": A, "toCommit": B, "status": "passed"}))


if __name__ == "__main__":
    main()
