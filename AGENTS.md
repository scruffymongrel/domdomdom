# AGENTS.md

Guidance for coding agents working in this repo. Lives here rather than in
per-machine agent memory so it travels with the repo and applies in any
checkout. `CLAUDE.md` is a symlink to this file.

## Writing docs in this repo

These rules govern the rest of this file, and the README, the skill, and the
comments in the source. They are here because one session produced an unusual
amount of drift, all of it in prose: a `--config` claim that was wrong on the
current bun, a `bunfig.dist.toml` comment restating reasoning this file had
already corrected, three "not yet published" claims about a package that had
been on npm for hours, a skill asserting an alias didn't exist that had shipped,
and a stale Node floor.

- **A claim that can be a test shouldn't be a sentence.** Nearly all of that
  drift was in *assertable* claims — things a machine could have checked. This
  repo already does it in places: `engines.node` is asserted against happy-dom's
  own `package.json` rather than written down, and `test/packaging.test.ts`
  asserts the skill contains its install command. Generalise it. If prose
  asserts something checkable — a version floor, a string that must appear in a
  file, a flag that exists, an ordering of steps in a workflow — write the
  check, and let the prose explain *why* it is that way. Prose that restates a
  passing test cannot drift into a lie; prose that stands alone always can. The
  reasoning is the half worth writing by hand, because it is the half no test
  can hold.
- **Stable part near the code, volatile part in one place.** The comment nearest
  the code is the one that gets read, so it has to say something — but a claim
  duplicated in two files drifts, and the copy that gets forgotten is the one
  left wrong. Split by rate of change: the local comment carries the **rule**
  ("coverage is off for this run — see AGENTS.md for why"), and AGENTS.md
  carries the reasoning and the measurements. Rules are stable; reasoning rots.
  `bunfig.dist.toml` is the concrete case that broke this way — it grew a second
  full copy of the coverage and `--config` argument, so when the `--config`
  behaviour turned out to be wrong there were two places to correct, and only
  one of them was in front of anyone.
- **Stamp a measured claim with what it was measured against.** The `--config`
  note models the form: *"Measured on bun 1.4.0 (`34cbb9a40`); the behaviour has
  evidently changed at least once, so re-measure before trusting this."* A
  stamped claim invites re-measurement; an unstamped one invites belief, and the
  next reader has no way to tell a fact from a fact that expired. Same for
  anything time-relative: "unpublished as of 2026-08-26" beats "not yet
  published", because it makes staleness visible instead of invisible.

  **The bench for this repo**, so no claim has to restate it: Apple M2, macOS
  26.3.1, node 26.3.0, bun 1.4.0, deno 2.9.5, domdomdom 0.5.0,
  browsebrowsebrowse 0.2.0, Chrome 152.0.7977.64. Figures below dated
  **2026-09-01** were taken there. An older date on a figure means exactly that
  — measured then, not re-run since — and is worth more than a fresh-looking
  number nobody took. `README.md` and `skills/domdomdom/SKILL.md` ship without
  this file (neither the npm tarball nor the plugin channel carries it), so they
  each restate the bench once, at the top of their own cost section, and nowhere
  else.
- **Don't assert another project's status when you can link to it.** The "not
  yet published" claims were assertions about `browsebrowsebrowse` — a sibling
  repo one directory away, with a canonical source of truth (its `package.json`,
  its npm page, its `main`). Point at the source, or go and check it. Don't
  snapshot it into prose here, where nothing will ever revisit it.

## Releasing to npm

**Releases are normally the agent's to run, not the maintainer's.** The whole
sequence is automated; drive it from the repo:

```sh
bun run release patch|minor|major
```

**`scripts/release.mjs` is the documented path**, and it exists because the
automation used to stop at the network boundary. `release.yml`'s own comment
promises the release is "one sequence or none of it — nothing to remember,
nothing to get out of order", and that was true of the *remote* half only. The
local half was not automated at all, and failed two ways, both silently:

- **Local `main` falls a commit behind.** `gh workflow run` returns the moment
  the dispatch is accepted, and nothing pulls back the `chore(release)` commit
  CI creates. Observed three times in one session: each time the next agent
  built on a stale base and misreported the version, and each time it was caught
  only because somebody happened to rebase.
- **CI releases `origin/main`, not what you have.** If local is behind, you
  publish a commit you never ran. If local is *ahead* — unpushed work — you
  publish without it. Nothing says so either way.

The wrapper's one real invariant closes both: it `git fetch`es and then refuses
unless you are on `main`, the tree is clean, and `git rev-list --left-right
--count origin/main...main` is `0 0` — naming which way they differ and what to
run. Everything after that is convenience: it triggers the workflow, waits for
that specific run (capturing the newest run id *before* dispatching, because a
new run doesn't appear instantly and `gh run list` will otherwise hand back the
*previous* release's), pulls the release commit back with `--ff-only`, and
prints the published version and its npm URL. On a failed run it exits non-zero
and does not pull.

**The escape hatch is the raw dispatch**, for when the wrapper is in the way —
re-running after a flaky CI step, or releasing from a checkout you can't get
clean:

```sh
gh workflow run release.yml -f bump=patch|minor|major
gh run watch
git pull --ff-only origin main   # the wrapper's whole point; don't skip it
```

CI then runs: quality gate → dist-target test suite → Node smoke test →
packed-tarball smoke test →
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
  a full `node_modules` — **46MB**, measured 2026-09-01 from this repo's own
  lockfile. That figure tracks the dependency tree, so re-measure it rather
  than treating it as a constant. Those deps exist so a plugin's hooks and MCP
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
  `AGENTS.md`) are read by nobody in the plugin cache and one of them — the
  lockfile — costs every user the `node_modules` install measured above.
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
bun run test:dist    # the same suite again, against the compiled dist/
bun run smoke:node   # runs the CLI from the checkout under Node
bun run smoke:pack   # packs, installs the tarball, runs it under Node, Bun AND Deno
bun run build        # compile dist/ (runs automatically via prepack)
```

- **Coverage is enforced at 100%** (lines + functions) on `index.ts` and
  `cli.ts` via `bunfig.toml`. New code needs tests or the build fails. Note the
  threshold keys are plural (`lines`/`functions`) — bun silently ignores the
  singular spellings, gating nothing.
- **The suite is dual-target: it runs once against the source and once against
  the shipped build.** Every test imports its subject from `test/subject.ts`
  rather than from `../index.ts` / `../cli.ts` directly. That module re-exports
  the public surface from either the `.ts` source or `dist/*.js`, switched by
  `DOMDOMDOM_TEST_DIST=1`; its import specifiers are computed rather than
  literal so `tsc` doesn't try to resolve `dist/`, which exists only after a
  build. **A new test imports from `./subject.ts`.** Importing `../index.ts`
  directly still compiles and still passes — it just quietly runs the source
  under both targets, which is the failure mode this whole gate exists to
  remove.

  ```sh
  bun run test:dist   # bun run build && DOMDOMDOM_TEST_DIST=1 bun test --config=bunfig.dist.toml
  ```

  Why it earns its place: `quality` has only ever exercised the `.ts` source
  while npm ships compiled `dist/`, and that exact gap let a broken npm+Node
  install survive three releases with CI green. `smoke:pack` proves the built
  binary *runs*; this proves it still *behaves* — every assertion, not one
  smoke assertion. Both `test.yml` and `release.yml` run it, per the invariant
  above.

  - **`subject.ts` exports `TARGET`** (`'src'` or `'dist'`). When a failure
    reproduces under one target only, that constant is what tells you which.
    It also exports `CLI_PATH` and `INDEX_PATH` — absolute paths to the module
    actually under test — for the handful of tests that must *name* the file
    rather than import it (spawning the bin as a child, symlinking it, feeding
    it to `isEntrypoint()`). Hardcoding `resolve(ROOT, 'cli.ts')` in those is
    the over-fit: under `DOMDOMDOM_TEST_DIST=1` it either fails outright
    (`isEntrypoint`, which compares against its own `import.meta.url`) or, far
    worse, passes by silently running the source in a dist run.
  - **The dist run needs its own bunfig, and `--config` needs the `=`.**
    `bunfig.toml`'s 100% threshold is meaningful only against the source; under
    `DOMDOMDOM_TEST_DIST=1` neither `index.ts` nor `cli.ts` is loaded, so the
    gate lands on bundler output including a content-hashed chunk whose name
    changes every build. `bunfig.dist.toml` turns coverage off for that run;
    the src run keeps the gate. `bun test --config=bunfig.dist.toml` applies
    the file — `bun test --config bunfig.dist.toml`, with a space, does **not**
    (bun 1.4 swallows the path as a test-name filter and matches nothing).
    Proof the file is live: the `=` form prints no coverage table, the default
    `bun test` does.
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

## The shared surface with browsebrowsebrowse

`bbb` is the sibling headless-Chrome CLI, and the two publish **one** contract:
JS on stdin, `--json` producing one line of `{ok, result, logs, status}`,
`--timeout`, `--viewport`, `--user-agent`, `--fail`, and exit codes `0` ok /
`1` eval / `2` timeout / `3` setup / `4` http. An agent that can drive one drives
the other with no new rules. **Don't drift that surface without changing both.**

`--prevent-timer-loops` is deliberately **not** part of that contract: it
toggles a happy-dom setting that has no Chrome analogue, so it is
domdomdom-only, like `--html` and `--inject`. Don't "sync" it to `bbb`.

`--bfcache` is domdomdom-only for the opposite reason — Chrome has the real
thing. `bbb` could one day drive an actual back/forward navigation and read
`notRestoredReasons`; a *simulation* of the restore would be strictly worse
there, so don't port this one across. The division of labour is: domdomdom
answers "does the page handle the restore", `bbb` is where "would this page be
cached at all" would live if anyone needs it. Both docs are written to keep
those apart — see the honest-labelling rule below.

`isHttpFailure()` and `httpErrorMessage()` are duplicated verbatim in `bbb`'s
`src/pure/http.ts`. A shared package between the two repos would be a third
thing to version for two functions; the duplication is the cheaper trade, but it
only works if you change both.

## Things that bite in this codebase

- **`page.goto()`'s return value is the only honest source of the HTTP status.**
  happy-dom hands back the `Response` it already fetched, after redirects, so
  reading `.status` from it costs nothing — and it is `null` for navigations
  that issue no request (`about:blank`, `javascript:`, a hash change). Never add
  a second request to "check" a URL: it is a different request and can get a
  different answer.
- **Bailing out mid-load floods `logs`.** Closing the browser while the
  document's subresources are in flight aborts every one of them, and each
  abort arrives as a `console.error`. Those lines are artefacts of our own
  bail-out, not of the page, so the `--fail` path snapshots `logs` *before*
  `safeClose()`. That fix is unaffected by anything below and still correct.

  **The mechanism is stable; the count is not.** How many lines you get scales
  with how many subresources happen to be in flight at the moment the browser
  closes, so it varies by page, by network and by run. One measured example, a
  real GitHub 404 on 2026-09-01: **10 lines without `--fail`, 2 with**. This
  file previously said "~120 spurious lines", unstamped, which was over by
  more than 10x against that page — a good illustration of why a volatile
  count belongs in an example rather than in the rule.
- **`preventTimerLoops` is OFF, deliberately — don't reinstate it as
  "hardening".** happy-dom's guard fingerprints every `setTimeout` /
  `requestAnimationFrame` call by its `new Error().stack` string and, on the
  second call from a byte-identical stack, returns `{}`: no timer created, no
  error thrown, the promise never settles. A stack is a *call site*, not a
  runaway loop, so ordinary code is what it kills — a bare happy-dom `Window`
  running 20 sequential awaited `setTimeout`s from one line completes 20/20
  with the guard off and hangs at exactly **2/20** with it on. htmx 4 awaits
  `this.timeout(settleDelay)` from a single call site on every id-matched swap,
  so an htmx page doing repeat swaps from one code path (a poller,
  `hx-trigger every`, a re-entered handler) hung its whole request pipeline.
  The line arrived uncommented in the squashed initial commit, was not one of
  that commit's enumerated fixes, and is a deviation from happy-dom's own
  default (`lib/browser/DefaultBrowserSettings.js`: `preventTimerLoops: false`).
  It is now `opts.preventTimerLoops ?? false`, opt-in via `--prevent-timer-loops`.

  **`--timeout` is the safety net, and it is the right one.** The race at the
  end of `evaluate()` uses the *host* `setTimeout`, so it fires regardless of
  what the page's own timers are doing: a tight self-rescheduling rAF chain and
  a permanent `setInterval` poller both return a clean `kind: "timeout"` just
  past the budget (measured 2026-08-27: 2.12s and 2.14s against 2000ms; not
  re-run since). Tests in `test/api.test.ts`'s `timers` block hold both ends of
  this down.

  happy-dom's finer-grained caps — `maxTimeout`, `maxIntervalTime`,
  `maxIntervalIterations` — are dedup-free and would not have this failure
  mode, but they are **deliberately not surfaced and not defaulted on**: they
  all default to `-1` upstream, and a cap that silently truncates a legitimate
  long poll reintroduces exactly the silent-wrong-answer failure this fix
  removes. A bounded wait with an honest error beats a quietly short one.
- **Both sides of the `evaluate()` race must be released, or the host event
  loop never drains.** The completion side polls `while (!w[doneKey])` every
  5ms; once the timer wins and `safeClose()` runs, `doneKey` can never be set,
  so that loop spins forever. The timer side is the mirror image: uncleared, it
  holds the loop for the rest of its budget after completion wins. Hence the
  `abandoned` flag and the `clearTimeout`. **Don't remove either as dead code** —
  the CLI hides the bug because `runFromProcess()` calls `process.exit`, so it
  is invisible to every in-process test; a library caller leaks one poller per
  timed-out call and the process never exits (measured 2026-08-27:
  `evaluate()` returned, the process was still alive at 2 minutes). Turning
  `preventTimerLoops` off made this matter more, not less — never-idle pages
  now reach the timeout instead of being silently stopped.
  `test/api.test.ts`'s "lets the process exit" spawns a child precisely because
  in-process the runner keeps the loop alive and a leak looks identical to a
  clean exit.
- **`PageTransitionEvent` is `Event`, and `pageshow` never fires — both
  silently.** happy-dom sets `PageTransitionEvent = Event`
  (`lib/window/BrowserWindow.js`, measured on happy-dom 20.9.0, 2026-09-01), so
  `new PageTransitionEvent('pageshow', { persisted: true })` constructs happily
  and `'persisted' in event` is `false`. And happy-dom exposes
  `onpageshow`/`onpagehide` while dispatching neither. Together those made every
  `if (event.persisted)` restore branch dead code *and* every page that sets
  itself up inside a `pageshow` handler a no-op — with nothing thrown either
  way. `installPageTransitionEvent()` and the post-load `pageshow` in
  `evaluate()` fix both **unconditionally**, like the XPath polyfill: real
  browsers do this, so a page that relies on it should just work. Tests assert
  the fixed behaviour, so if happy-dom ever ships a genuine
  `PageTransitionEvent` the guard hands over to it rather than shadowing it.
- **happy-dom's `dispatchEvent` re-enters itself, so you cannot suppress events
  by replacing it.** It walks the composed path and then calls
  `event[PropertySymbol.target].dispatchEvent(event)` *again* to run the
  listeners. A suppressor installed as an own `dispatchEvent` therefore eats the
  inner call too — including events you dispatched yourself through a saved
  reference to the original. This cost real debugging time on the socket
  severing in `installBfcache()`: the injected close reported delivered, threw
  nothing, and reached no listener, because `dispatchEvent`'s return value is a
  boolean nobody reads. The fix is to suppress by **event identity** (a
  `WeakSet` of events we injected) rather than by call, so the re-entrant pass
  is transparent. Any future "swallow events from X" needs the same shape.
- **`--bfcache` is lifecycle simulation, and the docs must not let that blur.**
  It fires the choreography a restore performs on the live document; it does not
  and cannot model eligibility, freeze semantics or timer suspension, because
  those are browser behaviour rather than page behaviour and there is no session
  history to navigate back through. The one thing it does that a real browser
  cannot is *choose* whether a severed socket's close lands before `pageshow`,
  after it, or never — which is the whole reason it exists, since that race is
  where reconnect logic actually breaks and no browser lets you pick a side.
  A passing run is **"lifecycle-verified under domdomdom"**, never "bfcache
  eligible"; `test/packaging.test.ts` asserts both shipped docs still say so,
  because an overclaim here is exactly the drift that costs someone a
  production incident.

  The severed close is deliberately dirty (`1006`, `wasClean: false`) — a
  connection killed under a frozen page is an abnormal closure, and reconnect
  logic keys off the code, so a polite `1000` would test the one shape that never
  occurs. The `error` event ahead of it is opt-in (`{ error: true }`) rather than
  a default, because whether a browser delivers one in this case is **not
  measured** — an unmeasured default would be exactly the kind of invented
  precision this file exists to prevent.
- **A WebSocket still connecting when the browser closes kills the process, and
  it is not ours.** happy-dom registers `once('error')` on the underlying `ws`
  instance and nulls its own reference to it in `#close`, so a socket torn down
  mid-connect can emit an error nobody is listening for — Node's EventEmitter
  then throws `Unhandled error. (ErrorEvent)` and the process dies with a V8
  internals stack trace, no `{ok:false}`, nothing an agent can parse. Reproduced
  on **bare happy-dom 20.9.0, with no domdomdom in the picture** (2026-09-01):
  two `new window.WebSocket(url)` and an immediate `browser.close()` prints
  "closed cleanly" and *then* exits 1. A page that waits for its sockets to
  settle first does not hit it.

  Bisected against `--bfcache` specifically, because severing looked like the
  obvious culprit and isn't: sever-then-reconnect exits 0, while two plain
  sockets with the flag off exit 1. Worth knowing anyway, because `--bfcache`
  exists to test reconnect logic and so invites exactly the pages that trigger
  it. **Unfixed, deliberately** — the fix means reaching for happy-dom's
  internal `PropertySymbol.webSocket` to attach a permanent error listener, and
  patching a third-party class unconditionally is a bigger commitment than the
  bug currently justifies. Re-measure against a newer happy-dom before assuming
  it is still there.
- `extractLocalScripts()` matches raw text, not a parsed DOM. It has to stay
  comment-aware in both directions: don't execute a commented-out
  `<script src>`, and don't treat `<!--` inside a script body or an attribute
  value as a comment. All four cases are tested.
- happy-dom needs patching before *any* page script runs — both missing JS
  built-ins and the DOM XPath API. That's why `setupWindow()` is the hook;
  `inject` runs too late, after embedded script tags have been evaluated.
