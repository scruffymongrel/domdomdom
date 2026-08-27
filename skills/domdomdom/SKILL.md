---
name: domdomdom
description: Use when the user wants to evaluate JS against an HTML page — query a fetched webpage's DOM, smoke-test a bundled script's `window.*` exports, extract structured data from local or remote HTML, or run any DOM-using snippet without spinning up a real browser. domdomdom is a happy-dom-powered CLI installed as `domdomdom` (and `ddd` from 0.3.0) on PATH, with DOM XPath polyfilled in (so XPath-dependent pages such as htmx 4 execute). Reach for this before Playwright, jsdom, linkedom or a browser MCP for non-layout, non-screenshot, non-interactive tasks — it needs no browser binary and is roughly 4x faster. When the task genuinely needs rendering, layout, computed styles, screenshots or interaction, use the sibling `browsebrowsebrowse` (`bbb`) CLI instead.
user-invocable: true
---

# domdomdom

Lightweight CLI for running JS against an HTML page. Powered by happy-dom — no browser binary, no Playwright, no MCP server. Runs on Node ≥20, Bun, or Deno ≥2.

## Install

Needs `domdomdom` on PATH: `bun add -g domdomdom` (or `npm i -g domdomdom`). If it's not installed, use `bunx domdomdom` (or `npx domdomdom`) as a drop-in, no-install fallback — same flags, same output, just prefix every invocation below with it instead of the bare command.

### Which runtime you are on

The bin ships compiled ESM with a `#!/usr/bin/env -S node` shebang. All three runtimes work, but they get in differently:

| Runtime | Global install | No-install |
| ------- | -------------- | ---------- |
| Node ≥ 20 | `npm i -g domdomdom`, then `domdomdom …` | `npx domdomdom …` |
| Bun | `bun add -g domdomdom`, then `domdomdom …` — **needs Node also present**, because the OS resolves the shebang | `bunx domdomdom …` (no Node needed) |
| Deno ≥ 2 | `deno install -g -A npm:domdomdom` — Deno writes its own shim, the shebang is never read | `deno run -A npm:domdomdom …` |

One gap worth knowing: on a **Bun-only machine with no Node on `PATH`**, a globally installed `domdomdom` cannot be run *directly* — use `bunx domdomdom …` instead. Everything else in this skill is identical on all three.

`deno install -g` installs one command, named after the package. For the short alias: `deno install -g -A --name ddd npm:domdomdom`.

### Version drift (plugin vs CLI)

This ships as two independent installs: the plugin (this skill, via `/plugin`) and the CLI (the `domdomdom`/`ddd` binary, via npm). They can drift.

- Skill mentions a flag/verb `domdomdom --help` doesn't have -> CLI is behind. Fix: `npm i -g domdomdom@latest` (or `bun add -g`, or prefix any command with `bunx domdomdom`/`npx domdomdom` to run latest with no install).
- `domdomdom --help` shows something this skill never mentions -> plugin is behind. Fix: `/plugin update`.

Compare versions directly with `domdomdom --version` against the plugin's version — see README for the full explanation.

## Invocation

Pipe the JS via stdin. Always use `--json` (parseable output) and `--timeout` (bound execution):

```sh
echo "<JS expression or block>" | domdomdom --json --timeout 3000 [SOURCE]
```

Source forms (pick one):

| Form                        | Meaning            |
| --------------------------- | ------------------ |
| `https://example.com`       | fetched URL        |
| `./local.html`              | local file         |
| `--html '<title>x</title>'` | inline HTML        |
| (omitted)                   | `about:blank`      |

Single-line expressions auto-`return`. Multi-line code: write `return` explicitly.

## Output shape

Stdout is **one line of JSON**. Branch on `.ok`.

```json
// success
{ "ok": true, "result": <any>, "logs": [{"level": "log"|"warn"|"error"|"info"|"debug", "message": "..."}], "status": <number|null> }

// failure
{ "ok": false, "error": { "kind": "eval"|"timeout"|"setup"|"http", "message": "...", "stack": "..." }, "logs": [...], "status": <number|null> }
```

Exit codes: `0` ok &middot; `1` eval error &middot; `2` timeout &middot; `3` setup/usage &middot; `4` HTTP error (`--fail` only).

### HTTP status is NOT in the exit code

`status` is the main document's **final** status after redirects, and `null` when nothing was fetched over HTTP (`--html`, a local file, `about:blank`). The key is always present.

**A 404 exits 0 with `ok: true`.** That is deliberate — a 404 body is a page, and scraping it is legitimate — but it means *the exit code is not a fetch check*. A missing page returns the site's "not found" HTML, and code that reads `.result` gets a plausible-looking string with nothing to signal it.

Two correct checks, pick one:

```sh
# 1. Read .status yourself, and decide.
echo 'document.title' | domdomdom --json https://example.com/maybe   # -> {"ok":true,...,"status":404}

# 2. Let --fail decide: non-2xx becomes ok:false, kind "http", exit 4.
echo 'document.title' | domdomdom --json --fail https://example.com/maybe
# -> {"ok":false,"error":{"kind":"http","status":404,"message":"HTTP 404 for ..."},"logs":[],"status":404}
```

`--fail` is opt-in and modelled on `curl --fail`. With it, the page's status is checked *before* your JS runs — a non-2xx never evaluates. It has no effect on `--html`, a local file or `about:blank`, where there is no status to fail on.

## Patterns

**Extract data from a fetched page**
```sh
echo 'return [...document.querySelectorAll("h2")].map(h => h.textContent.trim())' \
  | domdomdom --json --timeout 5000 https://news.ycombinator.com
```

**Verify a bundle attaches its export**
```sh
echo 'return typeof window.MyLib' | domdomdom --json ./dist/test.html
```

**Preload stubs before user code**
```sh
echo 'return await fetch("/api/x").then(r => r.json())' \
  | domdomdom --json --inject ./stubs.js ./page.html
```

## Useful flags

`--fail` (non-2xx is an error, exit 4) &middot; `--inject <f>` (preload, repeatable) &middot; `--script <f>` (code from file) &middot; `--module` (ESM) &middot; `--user-agent <s>` &middot; `--no-console` (drop logs) &middot; `--viewport WxH` &middot; `--prevent-timer-loops` (see Timers). Run `domdomdom --help` for the full list.

## XPath works (no flag)

`document.evaluate`, `XPathEvaluator` and `XPathResult` are polyfilled on every page before any page script runs — happy-dom itself ships no XPath at all. Two consequences worth knowing:

- You can use XPath in extraction snippets, not just CSS selectors.
- Pages whose own scripts need XPath execute normally. htmx 4 is the concrete case: it uses `new XPathEvaluator()` internally for `hx-on` matching, so on plain happy-dom an htmx-4 page dies with `ReferenceError: XPathEvaluator is not defined`.

```sh
echo 'return document.evaluate("//td[2]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.textContent' \
  | domdomdom --json --html '<table><tr><td>a</td><td>b</td></tr></table>'
```

XPath 1.0 only — no 2.0+ sequences, `for`/`let`, or richer types.

## Don't reach for this when

domdomdom is significantly cheaper than a real browser: no binary, no process, ~100-300ms — versus a real browser's ~1s cold start and ~180MB engine. When both would work, prefer domdomdom; reach for the alternatives below only when the task genuinely needs what they provide.

| Need                                            | Use instead |
| ------------------------------------------------ | ----------- |
| Layout, `getComputedStyle`, screenshots           | `browsebrowsebrowse` (`bbb`)[^bbb] |
| Click, scroll, type, navigation flows             | `browsebrowsebrowse` (`bbb`)[^bbb] |
| The user's own real, logged-in browser session    | claude-in-chrome |
| Hard isolation for untrusted JS                   | a real sandbox (container, or Cloudflare Sandbox) — not a browser automation tool, which isn't a security boundary |
| Parse HTML *without* executing scripts            | linkedom (faster) |

[^bbb]: `browsebrowsebrowse` is a sibling headless-Chrome CLI — same author, same marketplace as domdomdom — built for the layout/interaction work domdomdom deliberately doesn't do. Install it with `npm i -g browsebrowsebrowse` (or `bun add -g browsebrowsebrowse`), or run it with no install via `bunx browsebrowsebrowse`.

## Limits to remember

- **No layout — and it fails silently, not loudly.** `getBoundingClientRect()`, `offsetHeight` and `scrollHeight` return **`0`** instantly rather than throwing. Measured on a real page where Chrome reports `8670`, all three returned `0` in under 0.1ms. Computed styles are unreliable in the same way — sometimes `''`, sometimes a default, rather than the real cascade. So a layout-dependent check quietly passes or fails on a wrong number, with nothing to signal it. When the answer depends on rendered geometry, use `browsebrowsebrowse` (`bbb`).
- **`innerText` is a performance cliff — use `textContent`.** `innerText` is layout-dependent by definition, and with no layout engine it degrades badly on a large subtree. Measured on one 16KB element: `textContent` **1.5s**, `innerText` **28s** (~18x). Same call under `bbb`: 2.4s. So prefer `textContent`; if you specifically need `innerText`'s layout-aware line breaking on a big element, that is a reason to reach for `browsebrowsebrowse` instead.
- **Present but inert — feature detection will lie to you.** These exist, pass a `typeof` check, and then do nothing. Measured on a real page against Chrome:
  - **`IntersectionObserver` is a `function` and never fires.** This is the one that will cost you. Lazy-loaded images, infinite scroll and reveal-on-scroll are all built on it, so that content is simply *absent* — no error, no warning, an empty `[]` that looks like a correct answer. If a page renders its list on scroll, domdomdom cannot see the list.
  - `ResizeObserver` — same: constructs, observes, never fires.
  - `canvas.getContext('2d')` returns `null`, so any canvas work throws on the first property access rather than where the problem is.
  - `document.elementFromPoint()` returns `null` (it is a layout question).
  - `isSecureContext` is absent — a bare reference is a `ReferenceError`, not `undefined`. Guard with `typeof isSecureContext`.

  Verified working, so don't avoid the tool for these: `MutationObserver` fires, `requestAnimationFrame` fires — **repeatedly**, including a self-rescheduling chain (see Timers) — `matchMedia` evaluates correctly, plus `localStorage`, `customElements`, `attachShadow`, `structuredClone` and `crypto.randomUUID`.
- **Timers are uncapped; `--timeout` is the bound.** `setTimeout`, `setInterval` and `requestAnimationFrame` all run normally, so a page with a permanent poller or a rAF spinner **never goes idle** — you get a clean `kind: "timeout"` / exit 2 when `--timeout` expires, not an early answer. Budget `--timeout` for the wait you're willing to do. (`--prevent-timer-loops` turns on happy-dom's loop guard, which fingerprints each call *site* by its stack and silently drops repeat timers from it. That also kills ordinary sequential awaited timers and htmx's settle step, which is why it is off by default.)
- **Async timeout only.** `--timeout` won't kill a synchronous `while(true){}` (shared event loop). For a hard ceiling, wrap in shell `timeout`: `timeout 5s domdomdom ...`.
- **No bare specifiers** in `<script type="module">`. Relative imports work.
- **Stack traces** point at evaluated-script offsets, not the user's `.ts` source.

## When things go wrong

- **`ok: true` but `result: undefined`** — user's code didn't return. In multi-statement code, `return` is required.
- **A plausible result from a page you expected to exist** — check `status`. A 404 returns the site's not-found HTML with `ok: true` and exit 0. Re-run with `--fail`.
- **`error.kind: "setup"`** — bad input: missing file, both `--html` and a positional source, malformed URL.
- **`error.kind: "http"` / exit 4** — `--fail` was passed and the page was non-2xx. Your JS did not run.
- **`kind: "timeout"` on a page that polls** — expected, not a bug: an endless `setInterval`/rAF page never settles, so the timeout is the answer. Raise `--timeout`, or return early from your snippet instead of awaiting the page.
- **An empty list from a page that clearly has items** — likely `IntersectionObserver` (see Limits): the content is lazy-loaded and never triggers. Use `browsebrowsebrowse` (`bbb`).
- **Empty `logs` unexpectedly** — check whether `--no-console` was passed.
