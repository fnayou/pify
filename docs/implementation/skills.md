# Minimal bundled skills

Pify is still a bootstrap project. This private package declares two skills for Pi 1.4.0: `pify-debug` and `pify-test-first`. They are adapted, self-contained instructions from the pinned `mattpocock/skills` source recorded in `skills/catalog.json` and in each skill's frontmatter. The upstream MIT notice is in `skills/LICENSE.mattpocock`. No scripts, external integrations, or install-time commands are bundled.

Pi loads them from the package through `package.json`'s `pi.skills` list. Pify does not copy them into a user's skill directory. Existing user skill files are never replaced. If a user skill shares a name, Pi's first-discovered rule chooses one and emits a collision warning; the package does not promise precedence. `/pify-health` shows bundled source and commit revision when Pi settings declare this package. The package's private version is separate from the pinned upstream revision.
