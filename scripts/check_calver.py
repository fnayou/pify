"""Validate the private package's npm-compatible YYYY.M.PATCH CalVer metadata."""

import argparse
import json
from pathlib import Path
import re


PACKAGE_JSON = Path(__file__).resolve().parents[1] / "package.json"
CALVER = re.compile(r"^([1-9][0-9]{3})\.([1-9]|1[0-2])\.(0|[1-9][0-9]*)$")


def parse_calver(value: object) -> tuple[int, int, int] | None:
    if not isinstance(value, str):
        return None
    match = CALVER.fullmatch(value)
    if match is None:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-json", type=Path, default=PACKAGE_JSON)
    parser.add_argument("--previous-release", help="CalVer from the latest published release or tag, supplied by the release gate")
    args = parser.parse_args()
    try:
        version = json.loads(args.package_json.read_text(encoding="utf-8"))["version"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Cannot read package version from {args.package_json}: {error}")
        return 1
    current = parse_calver(version)
    if current is None:
        print(f"Invalid Pify CalVer {version!r}; expected npm-compatible YYYY.M.PATCH with month 1–12 and no leading zeros")
        return 1
    if args.previous_release is not None:
        previous = parse_calver(args.previous_release)
        if previous is None:
            print(f"Invalid previous release CalVer {args.previous_release!r}")
            return 1
        if current <= previous:
            print(f"Pify CalVer {version!r} must follow previous release {args.previous_release!r}")
            return 1
    print(f"Pify CalVer valid: {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
