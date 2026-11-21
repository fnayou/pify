"""Keep public Pify entry points explicit about bootstrap and release status."""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {
    "README.md": (
        "Pify is in bootstrap",
        "no supported release or installable distribution",
        "Implemented in the repository (unreleased)",
        "Planned distribution",
    ),
    "website/index.md": (
        "This repository is in bootstrap",
        "no supported release or installable distribution",
        "Implemented in the repository (unreleased)",
        "Planned distribution",
    ),
    "website/getting-started.md": (
        "no released software or public install command",
        "These checks validate source work, not a released installation",
    ),
    "CONTRIBUTING.md": ("Pify is in bootstrap", "no supported release or installable distribution"),
    "SECURITY.md": ("Pify has no supported release yet",),
    "brand/generated/readme-banner.svg": ("Bootstrap project — no released distribution or features",),
}


def main() -> None:
    for relative, markers in REQUIRED.items():
        content = (ROOT / relative).read_text(encoding="utf-8").lower()
        for marker in markers:
            if marker.lower() not in content:
                raise SystemExit(f"{relative}: missing public status marker: {marker}")
    metadata = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if metadata.get("private") is not True:
        raise SystemExit("package.json: bootstrap package must remain private")
    print("Public entry points distinguish bootstrap work from a release")


if __name__ == "__main__":
    main()
