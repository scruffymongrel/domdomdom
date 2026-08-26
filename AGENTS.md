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

CI then runs: quality gate → Node smoke test → packed-tarball smoke test →
`npm version` (bump + `chore(release): vX.Y.Z` commit + annotated tag) → push →
`npm publish` via Trusted Publishing (OIDC) → build the plugin channel and
advance `release`.

**`release.yml` and `test.yml` must gate on the same checks.** A release that
can fail on a step PR CI never ran is a release that breaks at the worst moment
— the sibling repo learned that the hard way. Add a gate to one, add it to the
other.

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
- **The `plugin` branch is the plugin channel, and it is *built*, not
  fast-forwarded.** `scruffymongrel/claude-plugins` pins `ref: plugin`, and
  after a successful publish the workflow runs
  `scripts/build-plugin-channel.mjs` and pushes the result. Don't push to it by
  hand — that would ship plugin content for a version that isn't on npm.

  The script assembles a tree with git plumbing (`ls-tree` → `mktree` →
  `commit-tree`) containing **exactly** `.claude-plugin/`, `skills/`,
  `README.md` and `LICENSE`, and commits it as a child of the current channel
  tip. A child, not a rewrite: the push stays an ordinary fast-forward, so
  nothing ever needs `--force`, and the channel keeps a linear history of its
  own. It shares no history with `main` — the commit body records the source
  commit if you need to tie them together. If `plugin` doesn't exist (a fresh
  fork), the first commit is an orphan.
- **The plugin channel ships no `package.json` and no lockfile, deliberately.**
  Claude Code runs a dependency install in a plugin's root when it finds *both*
  a `package.json` and a supported lockfile — `bun.lock`/`bun.lockb` →
  `bun install --frozen-lockfile --ignore-scripts`, `package-lock.json`/
  `npm-shrinkwrap.json` → `npm ci --ignore-scripts`. With a `package.json` and
  no lockfile it is skipped, silently, with no log entry.

  The old channel was `git push origin HEAD:release`, so it carried the whole
  dev tree including `bun.lock`, and every single plugin install materialised
  ~46-50MB of `node_modules`. Those deps exist so a plugin's hooks and MCP
  servers can load them. **This plugin ships skills only — no hooks, no MCP
  servers** — so not one byte of it was ever loadable. `.claude-plugin/` is the
  only file a plugin actually requires; nothing requires a `package.json`, and
  nothing requires the channel `ref` to share history with the default branch.

  Dropping the manifest rather than only the lockfile is the point: with no
  `package.json` in the tree, a future maintainer cannot silently reintroduce
  the install by restoring a lockfile. `test/packaging.test.ts` builds the
  channel in a throwaway repo and asserts the exact path set plus the absence of
  a `package.json` and any lockfile. **Don't "restore" the dev tree** — the
  files it would add (`cli.ts`, `index.ts`, `test/`, `scripts/`, tsconfigs,
  `AGENTS.md`) are read by nobody in the plugin cache and one of them costs 46MB
  per user.
- **The plugin channel and the npm channel ship different content, on
  purpose.** The plugin cache
  (`~/.claude/plugins/cache/scruffymongrel/domdomdom/<version>/`) is a git
  clone of the built `plugin` branch: the manifest and the skill, and never a
  built binary — `dist/` is gitignored and isn't in the channel tree either
  way. The npm tarball is the mirror image: `files:` in `package.json` ships
  `dist/` (built at pack time via `prepack`) plus the plugin manifest, not the
  raw `.ts`. Two channels, one repo, deliberately asymmetric — the plugin's
  only job is delivering the skill, not making `domdomdom` runnable on its own.

  This is a trap for a future agent: seeing "the plugin has no `dist/`" reads
  like a packaging bug, and the obvious "fix" — un-gitignore `dist/`, or add
  it to the `plugin` branch — would ship build artifacts into a channel that
  was never meant to carry them, for no benefit (the plugin doesn't run
  `dist/`; it only ships the skill that tells an agent to reach for the CLI).
  If `dist/` genuinely needs to reach the plugin cache someday, that's a
  deliberate distribution change to design, not a gitignore tweak.

  This is also the root cause of a real gap in `skills/domdomdom/SKILL.md`:
  the skill assumed `domdomdom` was on PATH, but installing the plugin alone
  never puts it there — only `bun add -g domdomdom` (or `npm i -g domdomdom`,
  or the `bunx domdomdom` no-install fallback) does. The skill now documents
  that install step and the fallback explicitly, but the underlying reason is
  this channel split: the plugin's `dist/`-less clone structurally cannot ship
  a runnable binary, by design.
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
bun run smoke:node   # runs the CLI from the checkout under Node
bun run smoke:pack   # packs, installs the tarball, runs it under Node, Bun AND Deno
bun run build        # compile dist/ (runs automatically via prepack)
```

- **Coverage is enforced at 100%** (lines + functions) on `index.ts` and
  `cli.ts` via `bunfig.toml`. New code needs tests or the build fails. Note the
  threshold keys are plural (`lines`/`functions`) — bun silently ignores the
  singular spellings, gating nothing.
- **The toolchain is Bun-only. Never add a step that requires Node locally.**
  Scripts run under `bun`, the build shells out to `bunx tsc`, and packing uses
  `bun pm pack` / `bun add` rather than npm. Node is a *target* runtime, not a
  build dependency.
- **One runtime story, and it is true.** `engines` claims `node >=20.0.0` and
  nothing else — that is happy-dom's own floor, asserted against its
  `package.json` by a test — and the shipped shebang is
  `#!/usr/bin/env -S node`. That is the honest scope of the shebang, which is
  the only thing the package controls.

  Three runtimes execute the built CLI and `smoke:pack` gates all three: Node
  through the shebang, Bun through its own loader (`bunx domdomdom`), and Deno
  through `deno run -A` (`deno install -g` writes its own `/bin/sh` shim that
  execs `deno run npm:domdomdom`, so the shebang is never consulted there
  either). Running under a runtime is not the same as `engines` claiming it: a
  Bun-only box with no Node on PATH cannot execute the installed bin
  *directly*, `bunx` is the answer there, and `engines` must not pretend
  otherwise. Don't add a `bun` or `deno` key to `engines`; a test asserts `node`
  is the only one.

  **Don't bring back the polyglot shebang.** Through v0.2.0 the build wrote an
  sh/JS polyglot that re-exec'd into `command -v bun || command -v node`, so a
  Bun-only box could run the bin directly. It reads as strictly more capable and
  it isn't: the same tarball, invoked the same way, ran under Bun on a machine
  with both runtimes and under Node on a Node-only one, silently. A bug that
  only reproduces on one of your users' machines, with no flag in the command to
  point at it. `bunx` covers the box it was for.
- **`bun:test` can only exercise Bun**, so the Node- and Deno-executing checks
  are scripts, not tests. They skip with a notice when that runtime isn't
  installed — but hard-fail instead when `CI` is set, so a broken `setup-node`
  or `setup-deno` can't masquerade as a pass. Anything touching module
  resolution, the bin, or a dependency's packaging needs these to stay honest;
  both run in PR CI.
- **Test the artifact, not the checkout.** `smoke:node` runs the CLI from the
  repo, where Node's type stripping is permitted; that difference hid a bug
  that shipped three times — Node refuses to strip types under `node_modules`,
  so the `.ts` bin threw on every npm+Node install from v0.1.0 to v0.2.0 with CI
  green throughout. The package now ships compiled JS, and `smoke:pack`
  installs the real tarball and gates on all three runtimes. When you change
  anything about packaging, trust `smoke:pack` and nothing else.
- **`dist/` is built, gitignored, and never hand-edited.** `prepack` builds it,
  so `npm pack` and `npm publish` always compile fresh. Source stays `.ts`.

## Things that bite in this codebase

- `extractLocalScripts()` matches raw text, not a parsed DOM. It has to stay
  comment-aware in both directions: don't execute a commented-out
  `<script src>`, and don't treat `<!--` inside a script body or an attribute
  value as a comment. All four cases are tested.
- happy-dom needs patching before *any* page script runs — both missing JS
  built-ins and the DOM XPath API. That's why `setupWindow()` is the hook;
  `inject` runs too late, after embedded script tags have been evaluated.
