"""Prove the optional adapter adds counters without changing a custom footer file."""

import fcntl
import hashlib
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "extensions" / "pify-footer-adapter.js"


def run_footer(workspace: Path, agent: Path, footer: Path, *, adapter: bool) -> bytes:
    environment = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"}
    args = [
        "pi", "--offline", "--no-mcp", "--no-context-files", "--no-session", "--approve",
        "--no-extensions", "-e", str(ROOT), "-e", str(footer),
    ]
    if adapter:
        args.extend(["-e", str(ADAPTER)])
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
    process = subprocess.Popen(args, cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def until(marker: bytes, seconds: float = 12) -> None:
        deadline = time.monotonic() + seconds
        while marker not in output and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                output.extend(os.read(master, 65536))
        if marker not in output:
            raise AssertionError(f"Pi footer did not show {marker!r}: {output[-1200:]!r}")

    try:
        until(b"USER FOOTER none")
        os.write(master, b"/pify-delegate status\r")
        until(b'pify.subagents/status/v1')
        if adapter:
            until(b"USER FOOTER Agents: 0 active")
        elif b"USER FOOTER Agents:" in output:
            raise AssertionError("Counters appeared without the opt-in adapter")
        return bytes(output)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        os.close(master)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pify-footer-adapter-") as temporary:
        root = Path(temporary)
        workspace = root / "workspace"
        agent = root / "agent"
        workspace.mkdir()
        agent.mkdir()
        footer = root / "user-footer.js"
        footer.write_text("""
export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((_tui, _theme, data) => ({
      render() { return [`USER FOOTER ${data.getExtensionStatuses().get("pify-subagents") ?? "none"}`]; },
      invalidate() {},
    }));
  });
}
""", encoding="utf-8")
        original = hashlib.sha256(footer.read_bytes()).digest()
        run_footer(workspace, agent, footer, adapter=False)
        assert hashlib.sha256(footer.read_bytes()).digest() == original
        run_footer(workspace, agent, footer, adapter=True)
        assert hashlib.sha256(footer.read_bytes()).digest() == original
        run_footer(workspace, agent, footer, adapter=False)
        assert hashlib.sha256(footer.read_bytes()).digest() == original
    print("Custom footer unchanged; counters appear only while adapter is loaded")


if __name__ == "__main__":
    main()
