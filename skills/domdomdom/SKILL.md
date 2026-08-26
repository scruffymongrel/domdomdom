---
name: domdomdom
description: Use when the user wants to evaluate JS against an HTML page — query a fetched webpage's DOM, smoke-test a bundled script's `window.*` exports, extract structured data from local or remote HTML, or run any DOM-using snippet without spinning up a real browser. domdomdom is a happy-dom-powered CLI installed as `domdomdom` on PATH, with DOM XPath polyfilled in (so XPath-dependent pages such as htmx 4 execute). Reach for this before suggesting Playwright, jsdom, linkedom, or browser-MCP solutions for non-layout, non-screenshot, non-interactive tasks.
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
{ "ok": true, "result": <any>, "logs": [{"level": "log"|"warn"|"error"|"info"|"debug", "message": "..."}] }

// failure
{ "ok": false, "error": { "kind": "eval"|"timeout"|"setup", "message": "...", "stack": "..." }, "logs": [...] }
```

Exit codes: `0` ok &middot; `1` eval error &middot; `2` timeout &middot; `3` setup/usage. Use the exit code as a cheap pre-check.

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

`--inject <f>` (preload, repeatable) &middot; `--script <f>` (code from file) &middot; `--module` (ESM) &middot; `--user-agent <s>` &middot; `--no-console` (drop logs) &middot; `--viewport WxH`. Run `domdomdom --help` for the full list.

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

[^bbb]: `browsebrowsebrowse` is a sibling headless-Chrome CLI — same author, same marketplace as domdomdom — built for the layout/interaction work domdomdom deliberately doesn't do. It's under active development and not yet published; don't expect it installable today.

## Limits to remember

- **No layout.** Computed styles return `''` for unstyled elements.
- **Async timeout only.** `--timeout` won't kill a synchronous `while(true){}` (shared event loop). For a hard ceiling, wrap in shell `timeout`: `timeout 5s domdomdom ...`.
- **No bare specifiers** in `<script type="module">`. Relative imports work.
- **Stack traces** point at evaluated-script offsets, not the user's `.ts` source.

## When things go wrong

- **`ok: true` but `result: undefined`** — user's code didn't return. In multi-statement code, `return` is required.
- **`error.kind: "setup"`** — bad input: missing file, both `--html` and a positional source, malformed URL.
- **Empty `logs` unexpectedly** — check whether `--no-console` was passed.
