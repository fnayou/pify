"""Verify Pify theme selection through official Pi 1.4.0 in isolated fixtures."""

import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

from smoke_pi_workflow import notice, rpc, run_pi


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SCOPE = "settings.json"


def tui_status(workspace: Path, env: dict[str, str], expected_theme: str, theme_option: str | None = None) -> None:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    args = ["pi", "--offline", "--no-mcp", "--no-skills", "--no-session"]
    if theme_option is not None:
        args.extend(["--use-theme", theme_option])
    process = subprocess.Popen(
        args, cwd=workspace, env=env,
        stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    os.close(slave)
    output = bytearray()
    probe = Path(env["PIFY_THEME_PROBE"])
    try:
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if probe.is_file():
                actual = probe.read_text()
                if actual != expected_theme:
                    raise AssertionError(f"Pi selected {actual!r}, expected {expected_theme!r}")
                return
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                output.extend(os.read(master, 65536))
            if process.poll() is not None:
                break
        raise AssertionError(f"Pi TUI did not write theme probe: {output[-800:]!r}")
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        os.close(master)


def fixture(root: Path, name: str, settings: dict) -> tuple[Path, Path, dict[str, str]]:
    agent = root / f"{name}-agent"
    workspace = root / f"{name}-workspace"
    agent.mkdir()
    workspace.mkdir()
    (agent / "settings.json").write_text(json.dumps(settings) + "\n")
    (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
        "baseUrl": "http://127.0.0.1:1/v1", "api": "openai-completions", "apiKey": "fixture-key",
        "models": [{"id": "fixture-model", "contextWindow": 8192, "maxTokens": 256}],
    }}}) + "\n")
    extensions = agent / "extensions"
    extensions.mkdir()
    (extensions / "theme-probe.js").write_text(
        'import fs from "node:fs";\n'
        'export default function (pi) {\n'
        '  pi.on("session_start", (_event, ctx) => {\n'
        '    if (ctx.mode === "tui") setTimeout(() => fs.writeFileSync(process.env.PIFY_THEME_PROBE, ctx.ui.theme.name ?? ""), 300);\n'
        '  });\n'
        '}\n'
    )
    env = os.environ.copy()
    env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color", "PIFY_THEME_PROBE": str(root / f"{name}-theme-probe.txt")})
    if run_pi(["--version"], workspace, env).strip() != "1.4.0":
        raise AssertionError("Pi 1.4.0 fixture required")
    run_pi(["install", str(PACKAGE_ROOT)], workspace, env)
    return agent, workspace, env


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-theme-smoke-") as temporary:
        root = Path(temporary).resolve()
        fresh_agent, fresh_workspace, fresh_env = fixture(root, "fresh", {})
        if "theme" in json.loads((fresh_agent / "settings.json").read_text()):
            raise AssertionError("Pi package install unexpectedly chose a theme")
        tui_status(fresh_workspace, fresh_env, "pify")
        fresh_saved = json.loads((fresh_agent / "settings.json").read_text())
        if fresh_saved.get("theme") != "pify":
            raise AssertionError(f"Fresh TUI did not save Pify theme: {fresh_saved.get('theme')!r}")
        fresh_journal = json.loads((fresh_agent / "pify-state" / "theme-selection.json").read_text())
        if len(fresh_journal["transactions"]) != 1 or fresh_journal["transactions"][0]["approvalSource"] != "fresh-default" or fresh_journal["transactions"][0]["previous"] != {"present": False}:
            raise AssertionError(f"Fresh TUI did not journal the automatic selection: {fresh_journal}")
        fresh_status = notice(rpc(fresh_workspace, fresh_env, {"id": "status", "type": "prompt", "message": "/pify-theme status"}))
        if not fresh_status.get("rollbackAvailable"):
            raise AssertionError(f"Fresh theme rollback unavailable: {fresh_status}")
        fresh_rollback = notice(rpc(fresh_workspace, fresh_env, {"id": "rollback", "type": "prompt", "message": "/pify-theme rollback"}, scope=SCOPE))
        if fresh_rollback.get("status") != "rolled-back":
            raise AssertionError(f"Fresh theme rollback failed: {fresh_rollback}")
        if json.loads((fresh_agent / "settings.json").read_text()).get("theme") != "system":
            raise AssertionError("Fresh theme rollback did not save system")
        Path(fresh_env["PIFY_THEME_PROBE"]).unlink()
        tui_status(fresh_workspace, fresh_env, "system")

        temporary_agent, temporary_workspace, temporary_env = fixture(root, "temporary", {})
        tui_status(temporary_workspace, temporary_env, "dark", theme_option="dark")
        if "theme" in json.loads((temporary_agent / "settings.json").read_text()):
            raise AssertionError("One-run theme choice changed saved settings")

        personal_agent, personal_workspace, personal_env = fixture(root, "personal", {"theme": "personal", "footerLink": "user-footer"})
        themes = personal_agent / "themes"
        themes.mkdir()
        personal = json.loads((PACKAGE_ROOT / "themes" / "pify.json").read_text())
        personal["name"] = "personal"
        (themes / "personal.json").write_text(json.dumps(personal) + "\n")
        tui_status(personal_workspace, personal_env, "personal")
        before = (personal_agent / "settings.json").read_bytes()
        denied = notice(rpc(personal_workspace, personal_env, {"id": "denied", "type": "prompt", "message": "/pify-theme enable"}))
        if denied.get("outcome") != "clarification_required" or (personal_agent / "settings.json").read_bytes() != before:
            raise AssertionError(f"Unscoped theme switch changed settings: {denied}")
        selected = notice(rpc(personal_workspace, personal_env, {"id": "select", "type": "prompt", "message": "/pify-theme enable"}, scope=SCOPE))
        if selected.get("status") != "selected" or selected.get("previousTheme") != "personal":
            raise AssertionError(f"Scoped theme switch failed: {selected}")
        saved = json.loads((personal_agent / "settings.json").read_text())
        if saved["theme"] != "pify" or saved["footerLink"] != "user-footer":
            raise AssertionError(f"Theme switch changed personal footer: {saved}")
        rolled_back = notice(rpc(personal_workspace, personal_env, {"id": "rollback", "type": "prompt", "message": "/pify-theme rollback"}, scope=SCOPE))
        if rolled_back.get("status") != "rolled-back":
            raise AssertionError(f"Theme rollback failed: {rolled_back}")
        saved = json.loads((personal_agent / "settings.json").read_text())
        if saved["theme"] != "personal" or saved["footerLink"] != "user-footer":
            raise AssertionError(f"Theme rollback did not restore personal settings: {saved}")
        print(f"Pify theme smoke passed on {os.uname().sysname}")


if __name__ == "__main__":
    main()
