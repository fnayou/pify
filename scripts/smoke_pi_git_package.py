"""Exercise Pi's commit-pinned Git package lifecycle in isolated agent fixtures."""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from smoke_pi_package import run_health_rpc, run_pi, snapshot


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
    settings_before = None
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
        settings_before = json.loads(settings_file.read_text())
        other_state = (user_skill.read_bytes(), (agent / "auth.json").read_bytes(),
                       (agent / "models.json").read_bytes(), (other_package / "package.json").read_bytes())

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
    before_health = (snapshot(agent), snapshot(workspace))
    report = health(workspace, env)
    if report["compatibility"]["status"] != "verified" or report["install"]["status"] != "installed" or report["install"]["sourceKind"] != "git":
        raise AssertionError(f"Pinned Git health is wrong: {report['install']}")
    if (snapshot(agent), snapshot(workspace)) != before_health:
        raise AssertionError("Git package health changed the isolated fixture")
    head.write_text("0" * 40 + "\n")
    if health(workspace, env)["install"]["status"] != "unknown":
        raise AssertionError("Mismatched Git commit was reported as installed")
    head.unlink()
    if health(workspace, env)["install"]["status"] != "unknown":
        raise AssertionError("Missing Git commit was reported as installed")
    head.write_text(commit + "\n")

    run_pi(["remove", source], workspace, env)
    if source in run_pi(["list"], workspace, env) or checkout.exists():
        raise AssertionError("Pi left the Git package installed after removal")
    if "pify-health" in commands(workspace, env):
        raise AssertionError("Pify command remained after Git package removal")
    if note.read_text() != "Unrelated project note\n":
        raise AssertionError("Pi changed the unrelated workspace")
    if existing:
        if json.loads((agent / "settings.json").read_text()) != settings_before:
            raise AssertionError("Pi removal changed unrelated settings")
        current_other = (user_skill.read_bytes(), (agent / "auth.json").read_bytes(),
                         (agent / "models.json").read_bytes(), (other_package / "package.json").read_bytes())
        if current_other != other_state:
            raise AssertionError("Pi changed unrelated existing-user files")
        if str(other_package) not in run_pi(["list"], workspace, env):
            raise AssertionError("Pi removal hid the unrelated package")


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
