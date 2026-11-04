# Contributing to Pify

Pify is in bootstrap. This repository has a private Pi development package and tests, but no supported release or installable distribution. GitHub Issues track the approved roadmap.

## Start with an issue

Search [GitHub Issues](https://github.com/fnayou/pify/issues) before opening a new one. For a bug, describe what happened and how to reproduce it, without sharing secrets. For a proposal, describe the user need and the smallest useful outcome. Discuss scope in the issue before starting substantial work. Security reports follow [SECURITY.md](SECURITY.md), not the public issue flow.

## Send a focused pull request

- Link the issue and keep the pull request to one agreed scope.
- Explain the change, how you checked it, and any remaining limits.
- Keep documentation honest: planned features remain planned until implemented and validated.
- Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `<type>[optional scope]: <description>`, for example `docs: clarify bootstrap status`.

Follow the [code of conduct](CODE_OF_CONDUCT.md) in issues, pull requests, and other project spaces.

## Run review checks

Install Task and the pinned dependencies in `requirements-docs.txt`, then run `task check` on macOS or Linux. It verifies generated brand assets, builds the docs in strict mode, and validates the private package's `YYYY.M.D` version metadata. The metadata is not a release announcement. Run `node --test tests/*.test.mjs` for the JavaScript unit tests.
