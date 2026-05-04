---
name: domdomdom
description: Use when the user wants to evaluate JS against an HTML page — query a fetched webpage's DOM, smoke-test a bundled script's `window.*` exports, extract structured data from local or remote HTML, or run any DOM-using snippet without spinning up a real browser. domdomdom is a Bun + happy-dom CLI installed as `domdomdom` on PATH. Reach for this before suggesting Playwright, jsdom, linkedom, or browser-MCP solutions for non-layout, non-screenshot, non-interactive tasks.
user-invocable: true
---

# domdomdom

Lightweight CLI for running JS against an HTML page. Powered by happy-dom — no browser binary, no Playwright, no MCP server.

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

## Don't reach for this when

| Need                                    | Use instead          |
| --------------------------------------- | -------------------- |
| Layout, `getComputedStyle`, screenshots | Playwright           |
| Click, scroll, type, navigation flows   | Playwright           |
| Hard isolation for untrusted JS         | Playwright sandbox   |
| Parse HTML *without* executing scripts  | linkedom (faster)    |

## Limits to remember

- **No layout.** Computed styles return `''` for unstyled elements.
- **Async timeout only.** `--timeout` won't kill a synchronous `while(true){}` (shared event loop). For a hard ceiling, wrap in shell `timeout`: `timeout 5s domdomdom ...`.
- **No bare specifiers** in `<script type="module">`. Relative imports work.
- **Stack traces** point at evaluated-script offsets, not the user's `.ts` source.

## When things go wrong

- **`ok: true` but `result: undefined`** — user's code didn't return. In multi-statement code, `return` is required.
- **`error.kind: "setup"`** — bad input: missing file, both `--html` and a positional source, malformed URL.
- **Empty `logs` unexpectedly** — check whether `--no-console` was passed.
