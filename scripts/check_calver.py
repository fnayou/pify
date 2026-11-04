"""Validate the private package's npm-compatible YYYY.M.D CalVer metadata."""

import argparse
from datetime import date
import json
from pathlib import Path
import re


PACKAGE_JSON = Path(__file__).resolve().parents[1] / "package.json"
CALVER = re.compile(r"^([1-9][0-9]{3})\.([1-9]|1[0-2])\.([1-9]|[12][0-9]|3[01])$")


def valid_calver(value: object) -> bool:
    if not isinstance(value, str):
        return False
    match = CALVER.fullmatch(value)
    if match is None:
        return False
    try:
        date(*(int(part) for part in match.groups()))
    except ValueError:
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-json", type=Path, default=PACKAGE_JSON)
    args = parser.parse_args()
    try:
        version = json.loads(args.package_json.read_text(encoding="utf-8"))["version"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Cannot read package version from {args.package_json}: {error}")
        return 1
    if not valid_calver(version):
        print(f"Invalid Pify CalVer {version!r}; expected npm-compatible YYYY.M.D with a real date and no leading zeros")
        return 1
    print(f"Pify CalVer valid: {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
