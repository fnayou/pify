"""Exercise the version gate through its command-line interface."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_calver.py"


class CalVerGateTests(unittest.TestCase):
    def check_version(self, version: object, previous_release: str | None = None) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory(prefix="pify-calver-test-") as directory:
            package = Path(directory) / "package.json"
            package.write_text(json.dumps({"version": version}), encoding="utf-8")
            command = [sys.executable, str(SCRIPT), "--package-json", str(package)]
            if previous_release is not None:
                command.extend(("--previous-release", previous_release))
            return subprocess.run(
                command,
                text=True, capture_output=True, check=False,
            )

    def test_valid_release_counter_versions(self) -> None:
        for version in ("2026.11.0", "2026.11.1", "2026.2.29", "2026.2.32", "2026.2.100"):
            with self.subTest(version=version):
                result = self.check_version(version)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_invalid_or_non_npm_release_counter_versions(self) -> None:
        for version in ("0000.11.1", "999.11.1", "10000.11.1", "2026.0.1", "2026.13.1", "2026.02.9", "2026.11.04", "2026.11.-1", "2026.11.1.1", "v2026.11.1", "2026.11.1-rc.1", "1.2.3", 2026):
            with self.subTest(version=version):
                result = self.check_version(version)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Invalid Pify CalVer", result.stdout)

    def test_release_counter_increases_from_previous_release(self) -> None:
        for previous, current in (("2026.11.4", "2026.11.5"), ("2026.11.42", "2026.12.0"), ("2026.12.42", "2027.1.0")):
            with self.subTest(previous=previous, current=current):
                result = self.check_version(current, previous)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_release_counter_rejects_same_decrease_and_backdating(self) -> None:
        for previous, current in (("2026.11.4", "2026.11.4"), ("2026.11.4", "2026.11.3"), ("2026.11.4", "2026.10.100"), ("2026.12.4", "2025.12.100")):
            with self.subTest(previous=previous, current=current):
                result = self.check_version(current, previous)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("must follow previous release", result.stdout)

    def test_invalid_previous_release_fails_closed(self) -> None:
        result = self.check_version("2026.11.5", "2026.11.04")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Invalid previous release CalVer", result.stdout)


if __name__ == "__main__":
    unittest.main()
