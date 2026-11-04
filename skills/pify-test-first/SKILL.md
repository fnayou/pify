---
name: pify-test-first
description: Build or fix behavior with a red-green-refactor loop. Use when the user requests test-first work or integration tests.
license: MIT
compatibility: Pi 1.4.0 on macOS and Linux; no extra tools required
metadata:
  source: https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/tdd/SKILL.md
  source-version: 4ae2317ddb22b046e26455e4f9c9b3aaaf62212d
  adaptation: Pify's self-contained minimal workflow
---

# Test first

1. Read the relevant project instructions and domain docs. Name the user-visible behavior to prove.
2. Choose a public interface that exposes that behavior. State what the test will catch and what it will miss.
3. Write one test with an expected result from the requirement or a worked example. Run it and confirm it fails for the intended reason.
4. Add the smallest behavior that passes. Run the same test again.
5. Repeat one behavior at a time. Keep tests independent of private implementation details and avoid mocks of internal collaborators.
6. Refactor only after the behavior passes. Run focused tests again, then report the red and green evidence.

When a test cannot exercise the real behavior, explain the missing test seam before adding a test that would give false confidence.
