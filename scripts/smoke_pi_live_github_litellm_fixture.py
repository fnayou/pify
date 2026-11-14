"""Exercise the private hosted or local option against a loopback server."""

import argparse
import os
import pty
import re
import select
import subprocess
import sys
import time
from pathlib import Path

from smoke_pi_models import start_server


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("commit", help="full public GitHub commit to install in disposable Pi")
    parser.add_argument("--local", action="store_true", help="exercise the loopback local-model option")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.commit):
        parser.error("commit must be a full lowercase Git hash")

    server = start_server("litellm")
    server.expected_key = "not-needed" if args.local else "fixture-key"
    master, slave = pty.openpty()
    process = subprocess.Popen(
        [sys.executable, str(PACKAGE_ROOT / "scripts" / "smoke_pi_live_github.py"), args.commit,
         "--live-local" if args.local else "--live-litellm"],
        cwd=PACKAGE_ROOT, env=os.environ.copy(), stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    os.close(slave)
    prompts = [
        ((b"Local" if args.local else b"LiteLLM") + b" OpenAI base URL (hidden, ending /v1): ",
         f"http://127.0.0.1:{server.server_port}/v1\n".encode()),
        ((b"Local chat model ID" if args.local else b"Hosted chat model alias") + b" (hidden): ",
         b"fixture-litellm\n"),
    ]
    if not args.local:
        prompts.append((b"LiteLLM virtual key (hidden): ", b"fixture-key\n"))
    output = bytearray()
    position = 0
    try:
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if process.poll() is not None:
                break
            if not select.select([master], [], [], 0.2)[0]:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
            if position < len(prompts) and prompts[position][0] in output:
                os.write(master, prompts[position][1])
                position += 1
        else:
            raise AssertionError("Integrated LiteLLM fixture timed out")
        process.wait(timeout=5)
        while select.select([master], [], [], 0)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
        result = output.decode(errors="replace")
        expected_gateway = "local" if args.local else "litellm"
        if process.returncode != 0 or position != len(prompts) or \
           '"status": "passed"' not in result or '"journey": "fresh-and-existing-git"' not in result or \
           f'"gateway": "{expected_gateway}"' not in result:
            raise AssertionError(f"Integrated LiteLLM fixture failed ({process.returncode}); child output redacted")
        if any(private in result for private in ("fixture-key", "fixture-litellm", "127.0.0.1")):
            raise AssertionError("Integrated LiteLLM report exposed private fixture inputs")
        if server.requests != [("/v1/chat/completions", "fixture-litellm")]:
            raise AssertionError("Integrated LiteLLM fixture did not receive exactly one chat request")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        server.shutdown()
        server.server_close()
    print(f"Pify integrated GitHub and {'local' if args.local else 'LiteLLM'} fixture passed: {args.commit} {os.uname().sysname}")


if __name__ == "__main__":
    main()
