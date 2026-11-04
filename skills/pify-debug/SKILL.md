---
name: pify-debug
description: Reproduce and diagnose a bug before fixing it. Use for failing, intermittent, or slow behavior.
license: MIT
compatibility: Pi 1.4.0 on macOS and Linux; no extra tools required
metadata:
  source: https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/diagnosing-bugs/SKILL.md
  source-version: 4ae2317ddb22b046e26455e4f9c9b3aaaf62212d
  adaptation: Pify's self-contained minimal workflow
---

# Diagnose a bug

1. Read the relevant project instructions and domain docs. Redact secrets from any evidence you share.
2. Build one small command or fixture that reproduces the reported symptom. Run it and record the failure.
3. Reduce the reproduction until each remaining part matters. For intermittent bugs, repeat the trigger to raise its reproduction rate.
4. List plausible causes and what observation would distinguish them. Inspect the narrowest code path or measure the affected behavior.
5. Fix the confirmed cause. Add a regression test at the interface that exposes the bug when that test can catch the reported symptom.
6. Re-run the original reproduction and focused tests. Remove temporary probes and report the cause, evidence, and any remaining limit.

If a safe reproduction needs access or data you lack, explain the attempted loop and request a redacted artifact or access.
