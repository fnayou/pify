"""Verify reviewed procedure promotion stays an inactive skill draft in Pi."""

import hashlib
import os
import tempfile
from pathlib import Path

from smoke_pi_memory import command, scope
from smoke_pi_workflow import commands, run_pi


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def approval_scope(vault: Path, relative: str) -> str:
    return f"memory/approval/{hashlib.sha256(f'{vault}\0{relative}'.encode()).hexdigest()}"


def draft_scope(vault: Path, relative: str, destination: Path) -> str:
    return f"memory/skill-draft/{hashlib.sha256(f'{vault}\0{relative}\0{destination}'.encode()).hexdigest()}"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-skill-draft-smoke-") as fixture:
        root = Path(fixture).resolve()
        agent, workspace, vault = (root / name for name in ("agent", "workspace", "vault"))
        agent.mkdir()
        workspace.mkdir()
        parent = workspace / ".pi" / "skills"
        parent.mkdir(parents=True)
        destination = parent / "check-build"
        env = os.environ.copy()
        env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"})
        if run_pi(["--version"], workspace, env).strip() != "1.5.2":
            raise AssertionError("Pi 1.5.2 fixture required")
        run_pi(["install", str(PACKAGE_ROOT)], workspace, env)
        if command(workspace, env, "create", f"create {vault}", scope(vault)).get("status") != "created":
            raise AssertionError("Memory vault creation failed")

        relative = "03-reference/procedures/check-build.md"
        source = vault / relative
        original = "# Check build\n\nRun focused tests first.\n"
        source.write_text(original)
        unapproved = command(workspace, env, "unapproved", f"draft-preview {relative} | {destination}")
        if unapproved.get("status") != "conflict" or destination.exists():
            raise AssertionError(f"Unapproved procedure produced a draft: {unapproved}")
        review = command(workspace, env, "review", f"review {relative}")
        if review.get("scope") != "procedure":
            raise AssertionError(f"Procedure was not reviewable: {review}")
        approved = command(workspace, env, "approve", f"approve {relative} {review['reviewCode']}", approval_scope(vault, relative))
        if approved.get("status") != "approved":
            raise AssertionError(f"Procedure approval failed: {approved}")
        if command(workspace, env, "snapshot", "snapshot").get("entries"):
            raise AssertionError("Approved procedure entered the prompt snapshot")
        preview = command(workspace, env, "preview", f"draft-preview {relative} | {destination}")
        if preview.get("status") != "review" or "Run focused tests first." not in preview.get("content", ""):
            raise AssertionError(f"Draft preview failed: {preview}")
        denied = command(workspace, env, "denied", f"draft {relative} | {destination} | {preview['reviewCode']}")
        if denied.get("outcome") != "clarification_required" or destination.exists():
            raise AssertionError(f"Unscoped draft creation was allowed: {denied}")
        created = command(workspace, env, "draft", f"draft {relative} | {destination} | {preview['reviewCode']}",
                          draft_scope(vault, relative, destination))
        draft = destination / "SKILL.pify-draft.md"
        if created.get("status") != "draft_created" or not draft.is_file() or (destination / "SKILL.md").exists():
            raise AssertionError(f"Draft did not stay inactive: {created}")
        if source.read_text() != original or "Run focused tests first." not in draft.read_text():
            raise AssertionError("Draft changed the source or omitted its procedure")
        if "skill:check-build" in commands(workspace, env, trust=True):
            raise AssertionError("Pi advertised the draft as an active skill")
        print(f"Pify skill draft smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
