"""Exercise manual release checks against a disposable Git tag history."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_release_candidate.py"


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class ReleaseCandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="pify-release-check-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "work"
        self.remote = self.root / "remote.git"
        self.record = self.root / "record.json"
        self.repo.mkdir()
        git(self.root, "init", "-q", "--bare", str(self.remote))
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "Pify fixture")
        git(self.repo, "config", "user.email", "fixture@example.test")
        self.version = "2026.11.5"
        (self.repo / "package.json").write_text(json.dumps({
            "name": "@fnayou/pify", "version": self.version, "private": True,
        }))
        (self.repo / "package-lock.json").write_text(json.dumps({
            "name": "@fnayou/pify", "version": self.version,
            "packages": {"": {"name": "@fnayou/pify", "version": self.version}},
        }))
        (self.repo / "CHANGELOG.md").write_text(
            "# Changelog\n\n## [Unreleased]\n\n## [2026.11.5] - 2026-11-21\n\n- Reviewed fixture change.\n"
        )
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "test: release candidate")
        self.commit = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "push", "-q", str(self.remote), "main")
        self.write_record()

    def write_record(self, **changes) -> None:
        record = {
            "schema": "pify.release-record/v1", "version": self.version,
            "date": "2026-11-21", "tag": f"v{self.version}",
            "source": f"git:github.com/fnayou/pify@{self.commit}",
            "changes": ["Reviewed fixture change"],
        }
        record.update(changes)
        self.record.write_text(json.dumps(record))

    def check(self, *args: str, first: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(SCRIPT), "--repo", str(self.repo),
                               "--record", str(self.record), "--fixture-remote", str(self.remote),
                               *(["--first-release"] if first else []), *args],
                              capture_output=True, text=True, check=False)

    def test_prepare_and_verify_tag_are_read_only(self) -> None:
        prepared = self.check()
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        report = json.loads(prepared.stdout)
        self.assertEqual(report["status"], "candidate_ready")
        self.assertEqual(report["source"], f"git:github.com/fnayou/pify@{self.commit}")
        self.assertTrue(report["fixtureOnly"])
        self.assertEqual(git(self.remote, "tag", "--list"), "")
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")
        git(self.repo, "tag", "-a", f"v{self.version}", "-m", "Fixture release tag")
        git(self.repo, "push", "-q", str(self.remote), f"v{self.version}")
        verified = self.check("--phase", "verify-tag")
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertEqual(json.loads(verified.stdout)["status"], "tag_verified")
        self.assertNotEqual(self.check().returncode, 0, "prepare must not accept an existing tag")

    def test_record_lock_and_dirty_worktree_fail_closed(self) -> None:
        self.write_record(source="git:github.com/fnayou/pify@" + "0" * 40)
        self.assertIn("Release record", self.check().stderr)
        self.write_record(date="2026-10-21")
        self.assertIn("date must match", self.check().stderr)
        self.write_record()
        lock = self.repo / "package-lock.json"
        value = json.loads(lock.read_text())
        value["version"] = "2026.11.4"
        lock.write_text(json.dumps(value))
        git(self.repo, "add", "package-lock.json")
        git(self.repo, "commit", "-qm", "test: mismatched lock")
        self.commit = git(self.repo, "rev-parse", "HEAD")
        self.write_record()
        git(self.repo, "push", "-q", str(self.remote), "main")
        self.assertIn("Package and lockfile versions", self.check().stderr)
        git(self.repo, "checkout", "--", "package-lock.json")
        (self.repo / "untracked.txt").write_text("unrelated\n")
        self.assertIn("worktree must be clean", self.check().stderr)

    def test_remote_history_sets_previous_version(self) -> None:
        git(self.repo, "tag", "v2026.11.4")
        git(self.repo, "push", "-q", str(self.remote), "v2026.11.4")
        self.assertIn("--first-release", self.check().stderr)
        result = self.check(first=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["previousTag"], "v2026.11.4")
        git(self.repo, "tag", "v2026.12.0")
        git(self.repo, "push", "-q", str(self.remote), "v2026.12.0")
        self.assertIn("must follow remote tag", self.check(first=False).stderr)

    def test_prepare_requires_candidate_on_remote_main(self) -> None:
        git(self.repo, "commit", "--allow-empty", "-qm", "test: unpublished candidate")
        self.commit = git(self.repo, "rev-parse", "HEAD")
        self.write_record()
        self.assertIn("must equal the reviewed remote main", self.check().stderr)

    def test_wrong_remote_tag_and_changelog_are_rejected(self) -> None:
        git(self.repo, "commit", "--allow-empty", "-qm", "test: wrong tag target")
        git(self.repo, "tag", f"v{self.version}")
        git(self.repo, "push", "-q", str(self.remote), f"v{self.version}")
        git(self.repo, "checkout", "--detach", self.commit)
        self.assertIn("must resolve to candidate commit", self.check("--phase", "verify-tag").stderr)
        git(self.repo, "tag", "-d", f"v{self.version}")
        changelog = self.repo / "CHANGELOG.md"
        changelog.write_text(changelog.read_text().replace("- Reviewed fixture change.", "No change bullet."))
        git(self.repo, "add", "CHANGELOG.md")
        git(self.repo, "commit", "-qm", "test: empty change section")
        self.commit = git(self.repo, "rev-parse", "HEAD")
        self.write_record()
        git(self.repo, "push", "-q", str(self.remote), "HEAD:main", "--force")
        self.assertIn("needs at least one change", self.check().stderr)


if __name__ == "__main__":
    unittest.main()
