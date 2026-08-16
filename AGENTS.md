# AGENTS.md

Guidance for coding agents working in this repo. Lives here rather than in
per-machine agent memory so it travels with the repo and applies in any
checkout. `CLAUDE.md` is a symlink to this file.

## Releasing to npm

**Releases are normally the agent's to run, not the maintainer's.** The whole
sequence is automated; drive it from the repo:

```sh
gh workflow run release.yml -f bump=patch|minor|major
gh run watch
```

CI then runs: quality gate → Node smoke test → `npm version` (bump +
`chore(release): vX.Y.Z` commit + annotated tag) → push → `npm publish` via
Trusted Publishing (OIDC).

Invariants — these are the ways to get it wrong:

- **Never hand-edit `version` in `package.json`.** CI owns it. Don't pre-bump a
  version "ready for release" either; the workflow bumps from whatever is on
  main, so a manual bump double-bumps.
- **`.claude-plugin/plugin.json` tracks `package.json`.** They're one artifact
  on one cadence — the plugin manifest ships inside the npm tarball — so the
  `version` npm lifecycle script syncs and stages it during `npm version`,
  landing both in the same release commit. Don't set it by hand; a test asserts
  they match, so drift fails CI.

  This is load-bearing, not hygiene: `plugin.json`'s `version` is the cache key
  Claude Code uses to decide whether a plugin update is available. If it stops
  changing, `/plugin update` silently skips the plugin and users stay on an old
  build no matter what else moves.
- **The `release` branch is the plugin channel.** `scruffymongrel/claude-plugins`
  pins `ref: release`, and the release workflow fast-forwards it after a
  successful publish. Don't push to it by hand — that would ship plugin content
  for a version that isn't on npm.
- **Never rename `.github/workflows/release.yml`.** npm's trusted publisher is
  keyed to repo *and workflow filename*. Renaming it breaks publishing with an
  auth error at the final step, after the version has already been bumped and
  pushed.
- `workflow_dispatch` only appears once the workflow is on the **default
  branch**. A release can't be triggered from a feature branch.
- Releases refuse to run anywhere but `main`.
- Publishing depends on a trusted publisher configured on npmjs.com (package →
  Settings → Trusted Publisher). That's a maintainer action; Claude can't do it.
- If `main` is branch-protected, the bot's `git push --follow-tags` fails
  *after* the bump but *before* publish. The workflow identity needs a bypass.

This replaced a fully manual process that had already drifted: the `v0.1.1` tag
sits on a different commit than its `chore(release): v0.1.1` commit. The point
of the automation is that the bump, tag and publish are inseparable.

## Checks

```sh
bun run quality      # tsc --noEmit + bun test (coverage gated, see bunfig.toml)
bun run smoke:node   # runs the shipped .ts bin under Node
```

- **Coverage is enforced at 100%** (lines + functions) on `index.ts` and
  `cli.ts` via `bunfig.toml`. New code needs tests or the build fails. Note the
  threshold keys are plural (`lines`/`functions`) — bun silently ignores the
  singular spellings, gating nothing.
- **Node is a supported runtime** (`engines.node >=23.6`) but `bun:test` can
  only exercise Bun. Anything touching module resolution, the bin, or a
  dependency's packaging needs `smoke:node` to stay honest — it runs in PR CI
  as its own job.

## Things that bite in this codebase

- `extractLocalScripts()` matches raw text, not a parsed DOM. It has to stay
  comment-aware in both directions: don't execute a commented-out
  `<script src>`, and don't treat `<!--` inside a script body or an attribute
  value as a comment. All four cases are tested.
- happy-dom needs patching before *any* page script runs — both missing JS
  built-ins and the DOM XPath API. That's why `setupWindow()` is the hook;
  `inject` runs too late, after embedded script tags have been evaluated.
