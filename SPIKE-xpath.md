# Spike: XPath support (`--xpath`)

Branch: `xpath-spike`. Not merged — for Andy's review.

**Question:** can domdomdom gain XPath support (`window.XPathEvaluator` /
`document.evaluate`) despite happy-dom not implementing it, enough that htmx
4.0.0-beta6 executes under domdomdom?

Origin: discovered in the jig project (`~/jig/app-jsx/NOTES.md`) —
`domdomdom` couldn't execute jig's vendored htmx 4.0.0-beta6 build at all
(`ReferenceError: XPathEvaluator is not defined`), the second confirmed
happy-dom gap after `@layer`.

## Verdict: GREEN on both gates

**Gate (a) — basic XPath probe:** GREEN. `document.evaluate("//td[2]", ...)`
resolves the right node under domdomdom with `xpath: true` / `--xpath`.

**Gate (b) — htmx 4.0.0-beta6 executes:** GREEN. Loading the real vendored
build (`test/fixtures/htmx-4.0.0-beta6.min.js`, copied read-only from
`~/jig/app-jsx/public/vendor/htmx/htmx.min.js`, unmodified — md5-verified
identical) via `<script src>` in a page fixture, with `xpath: true`:
`window.htmx` is an `object` and `window.htmx.process` is a `function` — htmx
boots. Without the flag, the exact baseline failure from jig's NOTES.md
reproduces verbatim: `ReferenceError: XPathEvaluator is not defined`.

## What htmx actually needed

Much narrower than full DOM XPath. htmx 4 uses XPath in exactly one place (the
`hx-on` attribute matcher), with two call shapes:

```js
this.#d = (new XPathEvaluator).createExpression(
  `.//*[@*[${...}starts-with(name(), "hx-on")...}]]`,
)
// ...later, per element being processed:
let i = this.#d.evaluate(e)   // note: no `type` argument
for (; s = i.iterateNext(); ) r.push(s)
```

So: `new XPathEvaluator()`, `.createExpression(exprString)`,
`.evaluate(contextNode)` with the `type` argument *omitted*, and
`.iterateNext()`. No `document.evaluate()` call, no `XPathResult` constants,
no NS resolver, no XPath 2.0+ features (sequences, `for`/`let`, richer
types).

## Dependency and license

[`wicked-good-xpath`](https://github.com/google/wicked-good-xpath)
(npm `wicked-good-xpath@1.3.0`), MIT, Google-authored pure-JS DOM Level 3
XPath 1.0 implementation — the library that used to power Selenium-on-IE and
`document.evaluate` polyfills generally. ~29KB, no runtime dependencies of its
own, no transitive dependency growth. Added to `dependencies` (not dev-only,
since it's pulled in conditionally at runtime by `evaluate({ xpath: true })`).

The `xpath` npm package (the fallback candidate) wasn't needed — WGX worked
once patched for happy-dom's quirks (below), so there was no reason to reach
for a second candidate.

## Why WGX doesn't just work — three happy-dom-specific patches

Found by direct experimentation against a happy-dom window (not by reading
WGX's source cold):

1. **happy-dom exposes a `window.Document` that isn't the class actually
   backing `window.document`.** `window.document`'s prototype chain
   (`HTMLDocument → Document → Node → EventTarget → Object`) never reaches
   `window.Document.prototype` — `window.Document` is a distinct synthetic
   subclass happy-dom uses for something else internally. WGX's `install()`
   auto-dispatches to `target.Document.prototype` when present, so calling it
   with the real `window` silently patches the wrong class and
   `document.evaluate` stays `undefined`. Fix: pass a bare `{ document }`
   shim instead of `window` — with no `.Document` property on the shim, WGX's
   dispatch logic falls through to patching `document` directly, which is
   what `window.document` actually uses.
2. **WGX's `XPathExpression#evaluate` has no default for its `type`
   parameter.** The DOM XPath spec declares it `optional unsigned short type
   = 0`, so browsers auto-detect the result type when a caller omits it —
   which is exactly what htmx's `expr.evaluate(contextNode)` (no second
   arg) relies on. WGX's internal implementation checks `0 == type`, and
   `0 == undefined` is `false` in JS, so an omitted argument skips
   auto-detection and falls through to `throw Error("Unknown XPathResult
   type.")`. Confirmed by direct reproduction before touching any repo code.
   Fixed by wrapping the returned expression/evaluate functions to substitute
   `type ?? 0`.
3. **No global `XPathEvaluator` constructor.** WGX only patches `document`
   (`document.evaluate`, `.createExpression`, `.createNSResolver`) per its
   README instructions — it doesn't add a standalone `window.XPathEvaluator`,
   which real browsers expose as the general interface `Document`
   implements. htmx calls `new XPathEvaluator()` directly. Synthesized a
   thin constructor whose prototype methods delegate to the (now-patched)
   `document`.

All three are implemented in `installXPath()` in `index.ts`, with inline
comments at each point. None of this required forking WGX or vendoring its
source — all three are patches applied from the host side after
`wgxpath.install()` runs, in the same style as the existing `patchBuiltins()`
fix for happy-dom's missing globals.

## Design: opt-in, wired at the earliest hook

`xpath?: boolean` on `EvaluateOptions`; `--xpath` on the CLI. Off by default —
extra dependency, extra window patch, most callers don't need it.

Installed inside `setupWindow()` (alongside `patchBuiltins()` and
`captureConsole()`), which fires via happy-dom's `beforeContentCallback` on
every navigation *before* `page.content` is assigned. This matters: htmx's
`new XPathEvaluator()` call happens synchronously at script-parse time (the
IIFE ends with `return new class { constructor() { ...
XPathEvaluator... } }`, instantiated the instant the script runs). A page
loading htmx via an ordinary `<script src>` tag (as jig's does) needs the
polyfill in place *before* that script executes — which rules out wiring
`--xpath` through the `--inject` mechanism (injects run after embedded
`<script src>` tags are already extracted and evaluated). Hooking
`setupWindow()` instead means the polyfill is present for every code path:
embedded scripts, `--inject` files, and user code alike, matching how real
browsers guarantee `window.XPathEvaluator` before any page script runs.

## Gate/RED conditions that did NOT occur

- WGX did not fail to run over happy-dom's DOM outright — it uses only
  standard DOM traversal APIs (`parentNode`, `nextSibling`, `attributes`,
  etc.), all present in happy-dom. The failure modes were narrower and
  fixable: wrong prototype target, missing default parameter, missing
  constructor — not missing DOM primitives.
- htmx needed nothing beyond XPath 1.0's node-set iteration. No XPath 2.0+
  features (sequences, `for`, `let`, union types) appear anywhere in the
  4.0.0-beta6 build.

## Tests

`test/xpath.test.ts`, 7 new tests (67 total, up from 60), `describe('xpath:
true', ...)` block matching the existing `test/api.test.ts` style:

- `document.evaluate` is `undefined` without `xpath: true` (negative control)
- `document.evaluate("//td[2]", ...)` with explicit `XPathResult` type
  (gate a)
- `createExpression(...).evaluate(node)` with **omitted** type — htmx's exact
  call shape — doesn't throw and auto-detects
- `new XPathEvaluator()` works standalone (not just via `document`)
- `XPathEvaluator#evaluate` / `#createNSResolver` exercised directly (keeps
  100% function coverage — see below)
- htmx 4.0.0-beta6 throws the documented `ReferenceError` without the flag
  (baseline / regression guard)
- htmx 4.0.0-beta6 boots (`window.htmx` is an object, `.process` is a
  function) with the flag

`bun run quality` (typecheck + full suite): 67 pass, 0 fail, 100% line +
function coverage on `index.ts` and `cli.ts` (unchanged from before this
spike — the new code is fully exercised).

`wicked-good-xpath` ships no type declarations (last touched 2016, no
`@types` package). Added a 6-line ambient shim, `wicked-good-xpath.d.ts`,
declaring only the `install()` function actually used, added to package.json
`files` so it ships with the published package if this lands.

## What's not covered by this spike

- The agent-facing skill doc (`skills/domdomdom/SKILL.md`) doesn't mention
  `--xpath` yet — left alone to keep the spike scoped to the engine/CLI;
  worth a follow-up pass if this merges.
- Only exercised against the one htmx 4.0.0-beta6 build vendored in jig.
  Other XPath call shapes (namespace-prefixed expressions, snapshot types,
  boolean/number results) aren't exercised by htmx and aren't covered by
  these tests beyond the one direct `createNSResolver`/`STRING_TYPE`
  coverage test — WGX's own DOM-L3-XPath-1.0 conformance is assumed, not
  re-verified here.

## Files touched

- `index.ts` — `installXPath()`, `xpath` option, wired into `setupWindow()`
- `cli.ts` — `--xpath` flag
- `wicked-good-xpath.d.ts` — new, ambient module shim
- `package.json` — new dependency, `files` entry
- `README.md` — flag table, `EvaluateOptions` doc, new "XPath support"
  section, test count
- `test/xpath.test.ts` — new
- `test/fixtures/htmx-page.html` — new
- `test/fixtures/htmx-4.0.0-beta6.min.js` — new (copied from jig, unmodified,
  0BSD-licensed; `test/fixtures/htmx-4.0.0-beta6.LICENSE` alongside it)

## How to review / merge

```sh
cd ~/_/domdomdom
git log main..xpath-spike --oneline
git diff main...xpath-spike
bun run quality   # 67 pass, 100% coverage
```

Nothing on `main` was touched — this branch has its own commits on top of
`main`'s tip. Merge with a normal `git merge xpath-spike` (or squash) once
reviewed; no rebasing was done, so the branch is a clean, reviewable diff
against `main`.
