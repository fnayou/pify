"""Explicit, read-only Pify Git release check. Never creates tags or publishes."""

import argparse
from datetime import date
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from check_calver import parse_calver


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CANONICAL_REMOTE = "https://github.com/fnayou/pify.git"
SOURCE_PREFIX = "git:github.com/fnayou/pify@"
OID = re.compile(r"[0-9a-f]{40}")
TAG_LINE = re.compile(r"([0-9a-f]{40})\trefs/tags/(v[^\s]+?)(\^\{\})?")


class CheckError(Exception):
    pass


def git(args: list[str], cwd: Path) -> str:
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0"})
    try:
        result = subprocess.run(["git", "-c", "core.fsmonitor=false", *args], cwd=cwd, env=environment,
                                capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CheckError(f"Git {args[0]} could not complete: {error}") from error
    if result.returncode or len(result.stdout) > 256_000:
        raise CheckError(f"Git {args[0]} failed or exceeded its output limit: {result.stderr.strip()[:300]}")
    return result.stdout.strip()


def object_version(path: Path, label: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise CheckError(f"Cannot read {label}: {error}") from error
    if not isinstance(value, dict):
        raise CheckError(f"{label} must be a JSON object")
    return value


def candidate(repo: Path, record_path: Path) -> tuple[str, str, date]:
    if git(["rev-parse", "--show-toplevel"], repo) != str(repo):
        raise CheckError("Repository path must be the Git worktree root")
    if git(["status", "--porcelain", "--untracked-files=all"], repo):
        raise CheckError("Release candidate worktree must be clean")
    commit = git(["rev-parse", "--verify", "HEAD"], repo)
    if not OID.fullmatch(commit):
        raise CheckError("Release source needs one full 40-character Git commit")
    package = object_version(repo / "package.json", "package.json")
    lock = object_version(repo / "package-lock.json", "package-lock.json")
    version = package.get("version")
    parsed = parse_calver(version)
    if parsed is None or package.get("name") != "@fnayou/pify" or package.get("private") is not True:
        raise CheckError("Package identity, privacy, or YYYY.M.PATCH CalVer is invalid")
    packages = lock.get("packages")
    root_lock = packages.get("") if isinstance(packages, dict) else None
    if lock.get("name") != package["name"] or lock.get("version") != version or \
            not isinstance(root_lock, dict) or root_lock.get("name") != package["name"] or \
            root_lock.get("version") != version:
        raise CheckError("Package and lockfile versions must match")
    if record_path.resolve().is_relative_to(repo):
        raise CheckError("Commit-bound release record must be outside the candidate worktree")
    record = object_version(record_path, "release record")
    required = {"schema", "version", "date", "tag", "source", "changes"}
    if set(record) != required or record["schema"] != "pify.release-record/v1" or \
            record["version"] != version or record["tag"] != f"v{version}" or \
            record["source"] != SOURCE_PREFIX + commit or not isinstance(record["changes"], list) or \
            not record["changes"] or any(not isinstance(item, str) or not item.strip() or
                                          len(item) > 200 or "\n" in item for item in record["changes"]):
        raise CheckError("Release record must match the exact version, tag, source commit, and nonempty changes")
    try:
        release_date = date.fromisoformat(record["date"])
    except (TypeError, ValueError) as error:
        raise CheckError("Release record needs a valid ISO date") from error
    if (release_date.year, release_date.month) != parsed[:2]:
        raise CheckError("Release record date must match the CalVer year and month")
    try:
        changelog = (repo / "CHANGELOG.md").read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise CheckError(f"Cannot read CHANGELOG.md: {error}") from error
    heading = re.compile(rf"(?m)^## \[{re.escape(version)}\] - {release_date.isoformat()}$")
    matches = list(heading.finditer(changelog))
    if len(matches) != 1 or "## [Unreleased]" not in changelog[:matches[0].start()]:
        raise CheckError("Changelog needs one dated CalVer section after Unreleased")
    section = changelog[matches[0].end():].split("\n## [", 1)[0]
    if not re.search(r"(?m)^- \S", section):
        raise CheckError("Dated changelog section needs at least one change")
    return version, commit, release_date


def remote_tags(remote: str) -> dict[str, str]:
    output = git(["ls-remote", "--tags", remote], Path(tempfile.gettempdir()))
    tags = {}
    for line in output.splitlines():
        match = TAG_LINE.fullmatch(line)
        if match and parse_calver(match[2][1:]) is not None:
            name = match[2]
            if match[3] or name not in tags:
                tags[name] = match[1]
    return tags


def remote_main(remote: str) -> str:
    output = git(["ls-remote", "--heads", remote, "main"], Path(tempfile.gettempdir()))
    match = re.fullmatch(r"([0-9a-f]{40})\trefs/heads/main", output)
    if match is None:
        raise CheckError("Remote main is unavailable or does not resolve to one commit")
    return match[1]


def check(repo: Path, record_path: Path, phase: str, first_release: bool, fixture_remote: Path | None) -> dict:
    version, commit, release_date = candidate(repo, record_path)
    remote = fixture_remote.resolve().as_uri() if fixture_remote else CANONICAL_REMOTE
    tags = remote_tags(remote)
    current_tag = f"v{version}"
    older = [(parse_calver(name[1:]), name) for name in tags if name != current_tag]
    previous = max(older, default=None)
    if bool(previous) == first_release:
        raise CheckError("Use --first-release only when the remote has no earlier CalVer tags")
    if previous and parse_calver(version) <= previous[0]:
        raise CheckError(f"Candidate {version} must follow remote tag {previous[1]}")
    if phase == "prepare" and remote_main(remote) != commit:
        raise CheckError("Candidate commit must equal the reviewed remote main commit")
    if phase == "prepare" and current_tag in tags:
        raise CheckError(f"Remote tag {current_tag} already exists")
    if phase == "verify-tag" and tags.get(current_tag) != commit:
        raise CheckError(f"Remote tag {current_tag} must resolve to candidate commit {commit}")
    return {"schema": "pify.release-check/v1", "status": "candidate_ready" if phase == "prepare" else "tag_verified",
            "version": version, "date": release_date.isoformat(), "tag": current_tag,
            "source": SOURCE_PREFIX + commit, "previousTag": previous[1] if previous else None,
            "fixtureOnly": fixture_remote is not None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=PROJECT_ROOT)
    parser.add_argument("--record", type=Path, required=True, help="External JSON record bound to this exact commit")
    parser.add_argument("--phase", choices=("prepare", "verify-tag"), default="prepare")
    parser.add_argument("--first-release", action="store_true")
    parser.add_argument("--fixture-remote", type=Path, help="Local bare remote for tests only")
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.repo.resolve(), args.record, args.phase, args.first_release, args.fixture_remote)))
        return 0
    except CheckError as error:
        print(f"Release check blocked: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
