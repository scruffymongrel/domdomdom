# domdomdom

Evaluate JavaScript against an HTML page from the command line. Pipe in code, get back the truth, cue dramatic chipmunk!

```sh
echo "return document.querySelectorAll('h1').length" | domdomdom https://example.com
```

Powered by [happy-dom](https://github.com/capricorn86/happy-dom). No browser binary, no Playwright install, no MCP server. ~170MB of Chromium it ain't — it's one Bun script.

## Why this exists

happy-dom *almost* works on Bun out of the box. Then you hit four walls. domdomdom fixes them so you don't have to:

1. **Built-ins are missing.** happy-dom's BrowserWindow on Bun starts with `Object`, `Math`, `JSON`, `parseInt`, `SyntaxError` etc. set to `undefined`. Its `VMGlobalPropertyScript` tries to copy them from `globalThis`, but inside `Script.runInContext` `globalThis` refers to the (empty) inner scope. Every `querySelector` throws `TypeError` because `SyntaxError` isn't on `window`. domdomdom enumerates `Object.getOwnPropertyNames(globalThis)` from the host realm and assigns each to the page window.
2. **`file://` doesn't fetch.** `page.goto('file:///abs/path.html')` rejects. domdomdom reads HTML manually and uses `page.content =` plus `page.url =` to set up the page.
3. **IIFE bundles silently break.** happy-dom's HTML parser wraps every `<script>` body in `function anonymous($happy_dom) { ... }`. Top-level `var foo = (() => { ... })()` becomes a function-local — never reaches `window`. domdomdom extracts `<script src>` tags before `page.content` and runs them via `page.evaluate()` (uses `Script.runInContext` directly, preserves real script-top-level scope).
4. **ES modules can't import.** `<script type="module" src="./foo.js">` can't be fetched from disk. domdomdom maps a synthetic `http://` origin to the page directory via happy-dom's `virtualServers` so relative imports work.

Each of these is a one-line fix once you've found it. Finding them took an afternoon.

## When to use this vs. alternatives

| You want                                    | Use this           |
| ------------------------------------------- | ------------------ |
| Run a snippet against a real page, fast     | **domdomdom**      |
| Test code that uses `document`, `window`    | **domdomdom**      |
| Verify an IIFE bundle attaches to `window`  | **domdomdom**      |
| Layout, computed styles, screenshots        | Playwright         |
| Run untrusted JS safely                     | Playwright (sandbox) or a worker pool |
| Parse HTML without executing scripts        | linkedom (faster)  |
| Module bundling / build tooling             | bun build / esbuild |

## Install

```sh
# global install
bun add -g github:scruffymongrel/domdomdom
npm install -g github:scruffymongrel/domdomdom

# one-off, no install
bunx github:scruffymongrel/domdomdom ./page.html
npx github:scruffymongrel/domdomdom https://example.com

# clone for development
git clone https://github.com/scruffymongrel/domdomdom && cd domdomdom && bun link
```

### Runtime requirements

- **Bun** ≥ 1.3 — works out of the box.
- **Node** ≥ 23.6 (LTS: 24+) — uses Node's built-in TypeScript stripping. The shebang silences the experimental-feature warning automatically. Node 22 LTS users need `node --experimental-strip-types` set in `NODE_OPTIONS`, or just install via Bun.

No build step. The published package ships `.ts` source directly; both runtimes execute it natively.

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
| `--no-console`   | drop `console.*` output instead of capturing it             |
| `--json`         | emit one JSON line: `{ ok, result?, error?, logs }`         |
| `-h, --help`     | show help                                                   |

### Output contract

**Default (human):** result on stdout, `console.*` on stderr (`[log]` / `[warn]` / etc), errors on stderr (`EVAL ERROR: ...`).

**`--json`:** single line on stdout, nothing else. Captured logs included.

**Exit codes:** `0` ok &middot; `1` eval error &middot; `2` timeout &middot; `3` setup/usage error.

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
}

type EvaluateResult =
  | { ok: true;  result: unknown; logs: ConsoleEntry[] }
  | { ok: false; error: EvaluateError; logs: ConsoleEntry[] }

type EvaluateError =
  | { kind: 'eval';    message: string; stack?: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'setup';   message: string; stack?: string }
```

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

### Other agents (Cursor, Aider, Codex CLI, Copilot, etc.)

The skill follows the [Agent Skills open standard](https://agentskills.io/specification) — an emerging cross-agent format that's just `SKILL.md` with YAML frontmatter. To use it with any agent that supports the standard, copy the skill folder into that agent's skill directory:

```sh
# After cloning or installing domdomdom
cp -r skills/domdomdom <your-agent>/skills/
```

For agents without skill support, paste this into your system prompt (covers ~90% of usage):

> To execute JS against an HTML page, pipe code via stdin to `domdomdom --json --timeout <ms>` followed by the URL/path or `--html '<...>'`. Single-line expressions auto-`return`; multi-line code requires `return` explicitly. Parse stdout as JSON; check `.ok` first. Captured `console.*` output is in `logs[]`.

### Output contract for agents

Stdout is one JSON line. Branch on `.ok`:

```json
// success
{ "ok": true, "result": <any>, "logs": [{ "level": "log"|"warn"|"error"|"info"|"debug", "message": "..." }] }

// failure
{ "ok": false, "error": { "kind": "eval"|"timeout"|"setup", "message": "...", "stack": "..." }, "logs": [...] }
```

Exit codes (`0` ok / `1` eval / `2` timeout / `3` setup) give a cheap pre-check before parsing.

### When to reach for it

Verifying a built bundle exposes its export on `window` &middot; extracting structured data from a fetched HTML page &middot; running a DOM snippet without spinning up Playwright &middot; smoke-testing `<script>` evaluation in CI.

### When not to

Layout, screenshots, click/scroll interaction, or untrusted-code isolation. Use Playwright.

## Limits

- **No layout.** `getComputedStyle().getPropertyValue('height')` returns `''` for unstyled elements. happy-dom doesn't render. For layout-dependent assertions, use Playwright.
- **Synchronous infinite loops.** `timeout` catches *async* hangs (long fetches, unresolved promises, slow setIntervals). It can't kill a `while(true){}` because the host event loop is shared with the page's V8 isolate. Wrap the CLI in `timeout 5s domdomdom ...` for a hard ceiling.
- **Bare module specifiers.** `import 'lodash'` from inside a `<script type="module">` won't resolve — happy-dom needs a `resolveNodeModules` config, which we don't currently surface. Relative imports (`import './foo.js'`) work.
- **Source maps.** Stack traces refer to evaluated-script offsets, not your original `.ts` files.
- **`outerHTML` round-trips drop reactive inline styles.** If a custom element sets inline styles in `attributeChangedCallback` (e.g. `this.style.display = 'grid'`), assigning `outerHTML` can clobber pre-existing inline styles in the markup. Real browsers preserve them. Don't trust `el.style.getPropertyValue(...)` after a happy-dom `outerHTML` round-trip if the SUT has reactive style assignments.

## Development

```sh
bun install
bun test            # 33 tests
bun run typecheck   # tsc --noEmit
bun run quality     # both
```

## License

MIT.
