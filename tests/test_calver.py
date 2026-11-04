"""Exercise the version gate through its command-line interface."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_calver.py"


class CalVerGateTests(unittest.TestCase):
    def check_version(self, version: object) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory(prefix="pify-calver-test-") as directory:
            package = Path(directory) / "package.json"
            package.write_text(json.dumps({"version": version}), encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(SCRIPT), "--package-json", str(package)],
                text=True, capture_output=True, check=False,
            )

    def test_valid_calendar_versions(self) -> None:
        for version in ("2026.11.4", "2024.2.29", "2030.1.1"):
            with self.subTest(version=version):
                result = self.check_version(version)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_invalid_or_non_npm_calendar_versions(self) -> None:
        for version in ("2026.11.04", "2026.02.9", "2026.13.1", "2026.2.29", "2026.11.4.1", "v2026.11.4", "2026.11.4-rc.1", "1.2.3", 2026):
            with self.subTest(version=version):
                result = self.check_version(version)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Invalid Pify CalVer", result.stdout)


if __name__ == "__main__":
    unittest.main()
