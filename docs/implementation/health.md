# Read-only health report

Pify remains a bootstrap project. When its Pi extension is loaded, `/pify-health` reports the observed Pi version against the tested 1.4.0 target, whether Pi settings declare this Pify package, the private package metadata version, and resources with valid Pify provenance. RPC clients receive JSON; the Pi terminal shows a short text report.

The command reads Pi settings and Pify's ownership manifest. It does not create a manifest, change settings, probe a model endpoint, or require optional services. A missing setup reports `not_installed` with an empty inventory. An unreadable settings file or ownership manifest reports `unknown` or `unavailable` with a warning. A modified managed file appears under `conflicts`, not under `managed`. Files absent from valid Pify provenance are never listed as managed.

Each new managed record stores the private package version present when the change was prepared. Older records without a version report `null`; the command does not guess. The package metadata version is not a release announcement. Pi versions other than the pinned 1.4.0 target are `unverified`, not declared incompatible.
