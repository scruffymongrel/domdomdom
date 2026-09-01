# domdomdom

Evaluate JavaScript against an HTML page from the command line. Pipe in code, get back the truth, cue dramatic chipmunk!

```sh
echo "return document.querySelectorAll('h1').length" | domdomdom https://example.com
```

Powered by [happy-dom](https://github.com/capricorn86/happy-dom). No browser binary, no Playwright install, no MCP server. Two TypeScript files, ~12KB on npm.

## Why this exists

happy-dom *almost* works on Bun out of the box. Then you hit four walls. domdomdom fixes them so you don't have to:

1. **Built-ins are missing.** happy-dom's BrowserWindow on Bun starts with `Object`, `Math`, `JSON`, `parseInt`, `SyntaxError` etc. set to `undefined`. Its `VMGlobalPropertyScript` tries to copy them from `globalThis`, but inside `Script.runInContext` `globalThis` refers to the (empty) inner scope. Every `querySelector` throws `TypeError` because `SyntaxError` isn't on `window`. domdomdom enumerates `Object.getOwnPropertyNames(globalThis)` from the host realm and assigns each to the page window.
2. **`file://` doesn't fetch.** `page.goto('file:///abs/path.html')` rejects. domdomdom reads HTML manually and uses `page.content =` plus `page.url =` to set up the page.
3. **IIFE bundles silently break.** happy-dom's HTML parser wraps every `<script>` body in `function anonymous($happy_dom) { ... }`. Top-level `var foo = (() => { ... })()` becomes a function-local — never reaches `window`. domdomdom extracts `<script src>` tags before `page.content` and runs them via `page.evaluate()` (uses `Script.runInContext` directly, preserves real script-top-level scope). That extraction works on raw text rather than a parsed DOM, so it skips over HTML comments explicitly — a commented-out `<script src>` is left alone rather than fetched and executed.
4. **ES modules can't import.** `<script type="module" src="./foo.js">` can't be fetched from disk. domdomdom maps a synthetic `http://` origin to the page directory via happy-dom's `virtualServers` so relative imports work.

Each of these is a one-line fix once you've found it. Finding them took an afternoon.

## When to use this vs. alternatives

domdomdom is significantly cheaper than a real browser when both would work: no binary, no process, nothing to download. Measured 2026-09-01 on an Apple M2 (macOS 26.3.1, node 26.3.0, bun 1.4.0, domdomdom 0.5.0, browsebrowsebrowse 0.2.0, Chrome 152.0.7977.64), median of 5 runs against a trivial inline page: domdomdom **0.25s**, `bbb` **0.87s** cold — about **3.5x** — and `bbb` additionally wants a ~190MB Chrome engine on disk that domdomdom never fetches. That is the easiest possible page, so both figures are floors; re-measure on your own hardware before leaning on them. Every other measurement in this file carries its own date.

| You want                                    | Use this           |
| ------------------------------------------- | ------------------ |
| Run a snippet against a real page, fast     | **domdomdom**      |
| Test code that uses `document`, `window`    | **domdomdom**      |
| Verify an IIFE bundle attaches to `window`  | **domdomdom**      |
| Layout, computed styles, screenshots        | `browsebrowsebrowse` (`bbb`) * |
| Click, scroll, type, navigation flows       | `browsebrowsebrowse` (`bbb`) * |
| The user's own real, logged-in browser session | claude-in-chrome |
| Run untrusted JS safely                     | a real sandbox (container, or Cloudflare Sandbox) — not a browser automation tool, which isn't a security boundary |
| Parse HTML without executing scripts        | linkedom (faster)  |
| Module bundling / build tooling             | bun build / esbuild |

\* `browsebrowsebrowse` is a sibling headless-Chrome CLI — same author, same marketplace as domdomdom — for the layout/interaction work domdomdom deliberately doesn't do. It's published on npm and in the same marketplace: `npm i -g browsebrowsebrowse` (or `bun add -g`).

## Install

```sh
# global install
bun add -g domdomdom
npm install -g domdomdom
deno install -g -A npm:domdomdom

# one-off, no install
bunx domdomdom ./page.html
npx domdomdom https://example.com
deno run -A npm:domdomdom https://example.com

# clone for development
git clone https://github.com/scruffymongrel/domdomdom && cd domdomdom && bun link
```

### Runtimes

The repo is TypeScript; the published package ships compiled ESM built at pack time. Three runtimes execute it, each with its own way in, and all three are gated by `bun run smoke:pack` in CI.

| Runtime | Install | Run |
| ------- | ------- | --- |
| **Node ≥ 20** | `npm i -g domdomdom` | `domdomdom …` / `ddd …` — the shipped bin's shebang is `#!/usr/bin/env -S node`, so this is the shebang path |
| **Bun** | `bun add -g domdomdom` | `bunx domdomdom …` — Bun's loader runs the file directly and never reads the shebang |
| **Deno ≥ 2** | `deno install -g -A npm:domdomdom` | `deno run -A npm:domdomdom …` |

`engines` claims **`node >=20.0.0` and nothing else** — happy-dom's own floor, asserted against its `package.json` by a test so the claim can't drift. That is deliberate: the shebang is the only thing the package controls, and it can only guarantee Node.

One real gap follows from that. On a **Bun-only machine with no Node on `PATH`**, `bun add -g domdomdom` puts `domdomdom` on `PATH` but running it *directly* fails — the OS resolves the shebang's interpreter before Bun gets a say. Use `bunx domdomdom …` there; it bypasses the shebang entirely and is covered by CI.

Deno needs neither Node nor the shebang: `deno install -g` writes its own `#!/bin/sh` shim that execs `deno run -A npm:domdomdom`, so the package's shebang is never consulted. It installs one command per invocation, named after the package; for the short alias use `deno install -g -A --name ddd npm:domdomdom` (both bins are the same file).

Through v0.2.0 the package shipped `.ts` source directly and claimed both runtimes executed it natively. They didn't: Node refuses to strip types for files under `node_modules`, so `npm i domdomdom` followed by running it under Node threw `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — broken since the first release, and invisible to CI because the tests ran the source from a checkout. Deno refuses for the same reason. Compiling fixed all of it, let the Node floor drop from 23.6 (a type-stripping artifact) to happy-dom's actual floor of 20, and is what makes Deno work at all.

v0.2.0 also shipped an sh/JS polyglot shebang that re-exec'd into `command -v bun || command -v node`, so a Bun-only box could run the bin directly. It was dropped: the same tarball, invoked the same way, ran under Bun on a machine with both runtimes and under Node on a Node-only one, silently. One shebang, one runtime, one thing to debug — and `bunx` covers the box the polyglot was for.

## CLI

```
domdomdom [options] [URL_OR_PATH]
```

| Source           | Interpretation                                    |
| ---------------- | ------------------------------------------------- |
| `http(s)://...`  | fetched via happy-dom                             |
| `./path.html`    | read from disk; relative scripts/modules resolved |
| `--html '<...>'` | inline HTML                                       |
| (none)           | `about:blank`                                     |

| Code source     | Interpretation                                       |
| --------------- | ---------------------------------------------------- |
| stdin           | default; auto-`return` if a single expression        |
| `--script <f>`  | read user code from a file (no auto-return)          |

### Flags

| Flag             | Effect                                                      |
| ---------------- | ----------------------------------------------------------- |
| `--inject <f>`   | preload a JS file in the window before user code; repeatable |
| `--module`       | evaluate user code as ES module (allows top-level `import`) |
| `--user-agent`   | override `navigator.userAgent`                              |
| `--viewport WxH` | override page viewport (e.g. `1024x768`)                    |
| `--timeout <ms>` | time limit; `0` disables; default `5000`                    |
| `--prevent-timer-loops` | opt into happy-dom's timer-loop guard; off by default (see [Timers](#timers)) |
| `--fail`         | treat a non-2xx page as an error, like `curl --fail`        |
| `--no-console`   | drop `console.*` output instead of capturing it             |
| `--json`         | emit one JSON line: `{ ok, result?, error?, logs, status }` |
| `-h, --help`     | show help                                                   |

### Output contract

**Default (human):** result on stdout, `console.*` on stderr (`[log]` / `[warn]` / etc), errors on stderr (`EVAL ERROR: ...`).

**`--json`:** single line on stdout, nothing else. Captured logs included.

**Exit codes:** `0` ok &middot; `1` eval error &middot; `2` timeout &middot; `3` setup/usage error &middot; `4` HTTP error (`--fail` only).

### HTTP status, and why the exit code is not a fetch check

Every `--json` line carries `status`: the main document's **final** HTTP status, after redirects. It is `null` — not omitted — whenever nothing was fetched over HTTP (`--html`, a local file, `about:blank`), so the shape is the same either way.

**Without `--fail`, a 404 is a success.** It exits `0` with `ok: true` and the not-found page's HTML in `result`, because a non-2xx body is still a page and querying it is a legitimate thing to do. The consequence is worth stating plainly: the exit code tells you whether *your JavaScript* ran, never whether the page was there.

```sh
echo 'document.title' | domdomdom --json https://example.com/nope
# {"ok":true,"result":"Page not found","logs":[],"status":404}   exit 0

echo 'document.title' | domdomdom --json --fail https://example.com/nope
# {"ok":false,"error":{"kind":"http","status":404,"message":"HTTP 404 for https://example.com/nope"},"logs":[],"status":404}   exit 4
```

`--fail` is opt-in, and checks the status *before* evaluating your code — failing fast is the point, so on a non-2xx your JS never runs. It does nothing for sources that have no status.

### Examples

```sh
# one-liner expression against about:blank
echo "1 + 2" | domdomdom

# query a real page
echo "return [...document.querySelectorAll('a')].map(a => a.href).slice(0, 5)" \
  | domdomdom https://news.ycombinator.com

# verify an IIFE bundle exposes its export on window
echo "return typeof window.MyLib" | domdomdom ./dist/test.html

# preload a stub before running test code
echo "return fetch('/api/x').then(r => r.json())" | \
  domdomdom --inject ./test/stubs.js

# structured output for an agent
echo "return document.title" | domdomdom --json https://example.com
# {"ok":true,"result":"Example Domain","logs":[]}
```

## Library

Same engine, programmatic:

```ts
import { evaluate } from 'domdomdom'

const r = await evaluate('return document.title', {
  html: '<title>hi</title>',
  timeout: 1000,
})
if (r.ok) console.log(r.result)
```

### `evaluate(code, opts?)`

```ts
interface EvaluateOptions {
  source?: string         // URL or local file path
  html?: string           // inline HTML (mutually exclusive with source)
  baseDir?: string        // resolve <script src> and inject paths against this
  timeout?: number        // ms; 0 disables; default 5000
  module?: boolean        // treat user code as ES module
  inject?: string[]       // preload JS files in window before user code
  userAgent?: string      // navigator.userAgent override
  viewport?: { width: number; height: number }
  quietConsole?: boolean  // drop console.* instead of capturing
  failOnHttpError?: boolean // non-2xx becomes an 'http' error; code never runs
  preventTimerLoops?: boolean | { timeout?: number; requestAnimationFrame?: number }
                          // happy-dom's timer-loop guard; off by default
}

// `status` is the main document's final HTTP status after redirects, and null
// when nothing was fetched over HTTP (html, a local file, about:blank).
type EvaluateResult =
  | { ok: true;  result: unknown; logs: ConsoleEntry[]; status: number | null }
  | { ok: false; error: EvaluateError; logs: ConsoleEntry[]; status: number | null }

type EvaluateError =
  | { kind: 'eval';    message: string; stack?: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'setup';   message: string; stack?: string }
  | { kind: 'http';    message: string; status: number }
```

### `isHttpFailure(status)` / `httpErrorMessage(status, url)`

The `--fail` decision and its wording, exported so a caller can apply the same
rule. `isHttpFailure` is `curl --fail`'s: 2xx passes, everything else does not,
and `null` (no HTTP request) is never a failure. Both are duplicated verbatim in
`browsebrowsebrowse` — the two CLIs publish one contract.

### `toCloneable(value)`

JSON-stringify-safe transform. Cycles → `"[Circular]"`. Functions, BigInt, Symbol, undefined → tagged strings. DOM nodes → plain objects. Use this if you want a result you can post over a wire.

## Agent integration

domdomdom was built for LLM agents to drive — `--json` plus stdin/stdout-only contracts mean it works behind a plain Bash tool without an MCP server, persistent browser, or context overhead. The repo ships an [Agent Skill](https://agentskills.io/) at `skills/domdomdom/SKILL.md` that teaches the agent when to reach for the tool and how to read its output.

### Claude Code

domdomdom is a Claude Code plugin (`.claude-plugin/plugin.json` in this repo) listed in the `scruffymongrel` marketplace. From inside Claude Code:

```text
/plugin marketplace add scruffymongrel/claude-plugins
/plugin install domdomdom@scruffymongrel
```

Restart Claude Code. The skill auto-loads when the user's prompt matches its trigger ("evaluate JS against this page", "test if the bundle exposes X on window", "extract X from this HTML", etc.). Users can also invoke explicitly with `/domdomdom`.

### Keeping the plugin and CLI in sync

domdomdom installs as two separate artifacts from one repo at one version: this plugin, which ships the skill only (from the `scruffymongrel` marketplace, pinned to the `plugin` branch), and the npm package, which ships the `domdomdom`/`ddd` binaries. They install and upgrade independently, so they can drift — see AGENTS.md for the channel-split invariant behind this.

**Upgrade both, as a pair:**

- **Plugin** — `/plugin update` in Claude Code (opens the plugin manager; pick `domdomdom@scruffymongrel` from the Installed tab), or `claude plugin update domdomdom@scruffymongrel` from the shell. Run `/reload-plugins` (or restart) to pick it up in the current session.
- **CLI** — `npm i -g domdomdom@latest` / `bun add -g domdomdom@latest` / `deno install -g -A npm:domdomdom@latest`, reinstalling over the existing global link.

**Which one is stale?** `domdomdom --version` reports the installed CLI's version directly; compare it against the plugin's version, visible from `/plugin`'s Installed tab. The same behavioral check catches it too: if this skill (or this README) describes a flag or verb `domdomdom --help` doesn't list, the CLI is behind — upgrade it from npm. If `domdomdom --help` shows something this doc never mentions, the plugin is behind — update it through `/plugin`.

**One direction only.** The release workflow advances the `plugin` branch — the plugin channel — only *after* `npm publish` succeeds (see "Releasing" below and AGENTS.md). So npm is never behind the plugin; only the reverse can happen, and only because a user hasn't updated the plugin on their machine yet.

**Quick fix:** `bunx domdomdom`, `npx domdomdom`, and `deno run -A npm:domdomdom` always fetch latest by default, sidestepping CLI staleness entirely — reach for one of these when you're not sure which side has drifted.

### Other agents (Cursor, Aider, Codex CLI, Copilot, etc.)

The skill follows the [Agent Skills open standard](https://agentskills.io/specification) — an emerging cross-agent format that's just `SKILL.md` with YAML frontmatter. After installing domdomdom (`npm i -g domdomdom`), the skill ships at `$(npm root -g)/domdomdom/skills/domdomdom/`. Copy it into your agent's skill directory:

```sh
cp -r "$(npm root -g)/domdomdom/skills/domdomdom" <your-agent>/skills/
# or, from a clone:
cp -r ./skills/domdomdom <your-agent>/skills/
```

For agents without skill support, paste this into your system prompt (covers ~90% of usage):

> To execute JS against an HTML page, pipe code via stdin to `domdomdom --json --timeout <ms>` followed by the URL/path or `--html '<...>'`. Single-line expressions auto-`return`; multi-line code requires `return` explicitly. Parse stdout as JSON; check `.ok` first. Captured `console.*` output is in `logs[]`. A non-2xx page still returns `.ok: true` and exit 0 — read `.status` (the final HTTP status, `null` for non-HTTP sources), or pass `--fail` to turn a non-2xx into `.ok: false` with exit 4.

### Output contract for agents

Stdout is one JSON line. Branch on `.ok`:

```json
// success
{ "ok": true, "result": <any>, "logs": [{ "level": "log"|"warn"|"error"|"info"|"debug", "message": "..." }], "status": <number|null> }

// failure
{ "ok": false, "error": { "kind": "eval"|"timeout"|"setup"|"http", "message": "...", "stack": "..." }, "logs": [...], "status": <number|null> }
```

Exit codes (`0` ok / `1` eval / `2` timeout / `3` setup / `4` HTTP) give a cheap pre-check before parsing — for *evaluation*. They say nothing about the HTTP response: **without `--fail` a 404 is `ok: true` and exit 0**, so read `status`, or pass `--fail` and let exit 4 mean it.

### When to reach for it

Verifying a built bundle exposes its export on `window` &middot; extracting structured data from a fetched HTML page &middot; running a DOM snippet without spinning up Playwright &middot; smoke-testing `<script>` evaluation in CI.

### When not to

Layout or screenshots — use `browsebrowsebrowse` (`bbb`), a sibling headless-Chrome CLI (same author/marketplace; `npm i -g browsebrowsebrowse`). Click/scroll/type/navigation flows — same, `bbb`. The user's own real, logged-in browser session — claude-in-chrome. Untrusted-code isolation — a real sandbox (container, or Cloudflare Sandbox); browser automation tools aren't a security boundary.

## Timers

`setTimeout`, `setInterval` and `requestAnimationFrame` run uncapped, and
`--timeout` is what bounds them.

happy-dom ships a `preventTimerLoops` guard that fingerprints every timer call
by its `new Error().stack` and, from the **second** call with a byte-identical
stack, returns without creating one — no timer, no error, a promise that never
settles. Ordinary code has that shape: `for (…) await new Promise(r =>
setTimeout(r, 1))` is one call site, and it stopped dead at 2 iterations. htmx 4
awaits its settle delay from a single call site too, so a page doing repeat
swaps from one code path (a poller, a repeated handler) hung its whole request
pipeline. domdomdom therefore leaves the guard **off**, which is happy-dom's own
default.

The visible consequence: **a page with a permanent poller or a `requestAnimationFrame`
spinner never goes idle**, so `--timeout` decides when you get an answer. That is
a clean `kind: "timeout"` and exit `2` — a bounded wait with an honest error,
instead of a silently dropped timer and a hang. Give such pages a `--timeout`
you're happy to wait out.

`--prevent-timer-loops` opts back in. The API takes limits as well as a boolean:
`preventTimerLoops: { timeout: 5, requestAnimationFrame: 2 }` raises the
per-call-site cap for each kind.

> happy-dom's finer-grained caps (`maxTimeout`, `maxIntervalTime`,
> `maxIntervalIterations`) are deliberately not surfaced. They all default to
> `-1` (off) and truncating a legitimate long poll would put back exactly the
> silently-wrong answer this removes; `--timeout` is the backstop.

## Limits

- **No layout, and it fails silently rather than loudly.** happy-dom doesn't render, so `getBoundingClientRect()`, `offsetHeight` and `scrollHeight` return **`0`** — instantly, without throwing. Measured 2026-08-26 on a real page where Chrome reports `8670`, all three returned `0` in under 0.1ms; not re-run since. `getComputedStyle()` is unreliable in the same way: sometimes `''`, sometimes a default, rather than the real cascade. The danger is that these are *fast and confident*, so a layout-dependent assertion quietly passes or fails on a wrong number. For anything depending on rendered geometry, use `browsebrowsebrowse` (`bbb`) — the sibling headless-Chrome CLI for this class of task.
- **`innerText` is a performance cliff — reach for `textContent`.** `innerText` is layout-dependent by definition, so with no layout engine happy-dom pays for it in software, and **the cost scales with the size of the subtree**. Measured **in-page** — timed inside the evaluated snippet, so process startup and the page fetch are excluded — on one **25,057-character** element, median of 3, 2026-09-01: `textContent` **~0.9ms** against `innerText` **~40.7s** (runs: 43.7s / 38.7s / 40.7s). That is a ratio of roughly **40,000x**, and it is not a typo. The same element under `bbb`, which has a real layout engine: `textContent` 0.2ms, `innerText` 1.2ms. End to end, an `innerText` call on an element that size is a `--timeout` you will have to wait out.

  Two things this note used to get wrong, both worth knowing. It reported "~18x" from a wall-clock `textContent` of 1.5s against a wall-clock `innerText` of 28s — but the 1.5s was almost entirely process startup and page fetch, not `textContent`, so mixing the two scales understated the cliff by three orders of magnitude. And the 28s drifted upward on its own as the target page grew past the "16KB" it was first measured against. Scaling with element size is the durable finding here; any single number is an example of it, not a constant.

  `textContent` is the right default — and needing real `innerText` semantics on a big element is itself a reason to use `bbb`.
- **Present but inert — feature detection lies.** Several APIs exist, answer a `typeof` check, and then do nothing. Measured 2026-08-27 on a real page, contrasted against Chrome; not re-run since:
  - **`IntersectionObserver` is a `function` and never fires.** The most valuable one to know. Lazy-loaded images, infinite scroll and reveal-on-scroll never trigger, so that content is simply absent — no error, no warning, just a shorter list that looks like a correct answer.
  - `ResizeObserver` — identical: constructs, observes, never fires.
  - `canvas.getContext('2d')` returns `null`.
  - `document.elementFromPoint()` returns `null` (it is a layout question).
  - `isSecureContext` is absent entirely — a bare reference throws `ReferenceError` rather than being `undefined`. Guard with `typeof`.

  What *does* work, so the tool isn't over-avoided: `MutationObserver` fires, `requestAnimationFrame` fires — **repeatedly**, including a chain that reschedules itself (it used to fire only once per call site; see [Timers](#timers)) — `matchMedia` evaluates correctly, and `localStorage`, `customElements`, `attachShadow`, `structuredClone` and `crypto.randomUUID` all behave.
- **Synchronous infinite loops.** `timeout` catches *async* hangs (long fetches, unresolved promises, slow setIntervals). It can't kill a `while(true){}` because the host event loop is shared with the page's V8 isolate. Wrap the CLI in `timeout 5s domdomdom ...` for a hard ceiling.
- **Bare module specifiers.** `import 'lodash'` from inside a `<script type="module">` won't resolve — happy-dom needs a `resolveNodeModules` config, which we don't currently surface. Relative imports (`import './foo.js'`) work.
- **Source maps.** Stack traces refer to evaluated-script offsets, not your original `.ts` files.
- **`outerHTML` round-trips drop reactive inline styles.** If a custom element sets inline styles in `attributeChangedCallback` (e.g. `this.style.display = 'grid'`), assigning `outerHTML` can clobber pre-existing inline styles in the markup. Real browsers preserve them. Don't trust `el.style.getPropertyValue(...)` after a happy-dom `outerHTML` round-trip if the SUT has reactive style assignments.

## XPath support

happy-dom doesn't implement the DOM XPath API (`document.evaluate`, `window.XPathEvaluator`) — a real gap, since it's standard in every browser. This surfaced concretely: htmx 4 uses `new XPathEvaluator().createExpression(...)` internally for `hx-on` attribute matching, so without a polyfill domdomdom can't execute an htmx-4 page at all (`ReferenceError: XPathEvaluator is not defined`).

domdomdom polyfills it with [wicked-good-xpath](https://github.com/google/wicked-good-xpath) (Google's pure-JS XPath 1.0 engine, MIT — formerly powered Selenium-on-IE), patched for three happy-dom-specific quirks; see `installXPath()` in `index.ts` for the details. **No flag needed** — it's installed on every window before any page script runs, the same way missing JS built-ins are, because a page that uses XPath should just work.

```sh
echo 'return document.evaluate("//td[2]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.textContent' \
  | domdomdom --html '<table><tr><td>a</td><td>b</td></tr></table>'
# b
```

Covers DOM XPath 1.0 (`document.evaluate`, `createExpression`, `createNSResolver`, the `XPathEvaluator` constructor, `XPathResult` type constants). No XPath 2.0+ (sequences, `for`/`let`, richer type system) — wicked-good-xpath doesn't implement it and nothing found in htmx 4 needs it.

## Development

```sh
bun install
bun test            # coverage runs and is gated by bunfig.toml
bun run typecheck   # tsc --noEmit
bun run quality     # both
bun run build       # compile dist/ (also runs automatically via prepack)
bun run smoke:node  # run the CLI from the checkout under Node
bun run smoke:pack  # pack, install the tarball, run it under Node, Bun AND Deno
```

Coverage is **enforced**, not just reported: `bunfig.toml` sets `coverageThreshold = { lines = 1.0, functions = 1.0 }`, so `bun test` (and therefore CI) fails if line or function coverage on `index.ts` / `cli.ts` drops below 100%. Note the keys are plural — bun silently ignores `line`/`function`, which gates nothing.

The test suite runs under Bun only, but Node is a supported runtime, so `smoke:node` drives the CLI under Node as a separate CI job.

`smoke:pack` is the one that matters for packaging: it packs the tarball, installs it into a scratch project, and runs the *installed* binary under all three runtimes — plus both bin aliases through the `node_modules/.bin` shebang path, with only Node on `PATH`. Testing the checkout alone is what let a broken Node install ship three times.

Developing domdomdom needs only Bun — the scripts run under `bun`, the build uses `bunx tsc`, and packing uses `bun pm pack`. The checks that execute Node or Deno skip with a notice if that runtime isn't installed, and hard-fail instead when `CI` is set so a missing runtime can't pass silently.

## Releasing

Releases are fully automated — there are no manual steps and no npm token.

```sh
bun run release patch|minor|major
```

CI runs the quality gate, the dist-target test suite, the Node smoke test and the packed-tarball smoke test, then bumps the version, commits, tags, pushes and publishes to npm via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), with provenance attestation. It refuses to run anywhere but `main`. `release.yml` and `test.yml` gate on the same checks on purpose — a release must not be able to fail on something PR CI never ran.

`scripts/release.mjs` wraps that dispatch, and the wrapper is the point rather than the convenience: CI releases whatever is on `origin/main`, so it **refuses unless local `main` and `origin/main` are identical** — behind means publishing a commit you never ran, ahead means publishing without your unpushed work, and both used to be silent. On success it pulls the release commit back, which the bare `gh workflow run release.yml -f bump=…` never did; local `main` then sat a commit behind until someone noticed. The raw dispatch is still there as an escape hatch (see AGENTS.md), but it leaves the `git pull --ff-only origin main` to you.

The same run builds the `plugin` branch, which is the Claude Code plugin channel — the marketplace pins `ref: plugin`, so the plugin ships when npm does, with no separate step. It isn't a copy of `main`: `scripts/build-plugin-channel.mjs` commits a tree of exactly `.claude-plugin/`, `skills/`, `README.md` and `LICENSE`, with no `package.json` and no lockfile — Claude Code installs dependencies into any plugin root that has both, and a skills-only plugin has no hooks or MCP servers that could ever load them.

Don't bump `version` in `package.json` by hand — CI owns it, and a manual bump double-bumps. Don't rename `.github/workflows/release.yml` either; npm's trusted publisher is keyed to the repo *and* the workflow filename.

## License

[MIT](LICENSE).
