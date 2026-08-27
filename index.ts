import { Browser } from 'happy-dom'
import { resolve, dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import wgxpath from 'wicked-good-xpath'

export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug'

export interface ConsoleEntry {
  level: ConsoleLevel
  message: string
}

export interface EvaluateOptions {
  /** URL (http/https) or local file path. Mutually exclusive with `html`. */
  source?: string
  /** Inline HTML. Mutually exclusive with `source`. */
  html?: string
  /** Base directory for resolving `<script src>` and `inject` paths. Defaults to CWD or dirname(source). */
  baseDir?: string
  /** Hard time limit in ms. 0 disables. Default 5000. */
  timeout?: number
  /** Treat user code as an ES module (allows top-level await, import). */
  module?: boolean
  /** Files (relative to baseDir) to load and run in the window before user code. */
  inject?: string[]
  /** Override navigator.userAgent. */
  userAgent?: string
  /** Override default page viewport. */
  viewport?: { width: number; height: number }
  /** If true, console.* calls are dropped instead of captured. */
  quietConsole?: boolean
  /**
   * Opt in to `curl --fail` behaviour: a non-2xx main-document status becomes a
   * failure instead of a page to scrape, and the user's code is never run.
   * Off by default — a 404 body is perfectly legitimate to query.
   */
  failOnHttpError?: boolean
}

export type EvaluateError =
  | { kind: 'eval'; message: string; stack?: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'setup'; message: string; stack?: string }
  | { kind: 'http'; message: string; status: number }

/**
 * `status` is the main document's **final** HTTP status, after redirects, and
 * `null` whenever there was no HTTP request to have one: `--html`, a local
 * file, `about:blank`. The key is always present rather than conditionally
 * omitted — one shape is easier to parse than two.
 */
export type EvaluateResult =
  | { ok: true; result: unknown; logs: ConsoleEntry[]; status: number | null }
  | { ok: false; error: EvaluateError; logs: ConsoleEntry[]; status: number | null }

/**
 * Is this status one `--fail` should refuse? Mirrors `curl --fail`: 2xx passes,
 * everything else does not. A `null` status means there was no HTTP request at
 * all, and there is nothing to fail on.
 *
 * Shared verbatim with browsebrowsebrowse's `src/pure/http.ts` — the two CLIs
 * publish one exit-code contract and it has to mean the same thing in both.
 */
export function isHttpFailure(status: number | null): boolean {
  return status !== null && (status < 200 || status > 299)
}

/** The message carried by an `http` error. Same wording in both tools. */
export function httpErrorMessage(status: number, url: string): string {
  return `HTTP ${status} for ${url}`
}

interface PendingScript {
  src: string
  content: string
}

const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
const SRC_ATTR_RE = /\bsrc=["']([^"']+)["']/i
const TYPE_MODULE_RE = /\btype=["']module["']/i
const ABS_URL_RE = /^(https?:)?\/\//i
const LOCAL_HOST = 'http://__domdomdom_local__'

// Is the `<!--` at `i` a real comment opener, or just those characters sitting
// inside a tag (e.g. `<div title="<!--">`)? Comments only open in text context,
// so if the nearest `<` before `i` is later than the nearest `>`, we're still
// inside a tag and this isn't a comment. A heuristic — it can be fooled by a
// quoted `>` in an attribute value — but it costs two indexOf calls and keeps
// stray `<!--` in markup from swallowing the scripts that follow it.
function opensComment(html: string, i: number): boolean {
  // Start of document is text context. Guarded explicitly because
  // lastIndexOf(c, -1) clamps the search to index 0 rather than finding nothing.
  if (i === 0) return true
  return html.lastIndexOf('<', i - 1) <= html.lastIndexOf('>', i - 1)
}

// Decide what to do with one matched <script> tag: return '' to extract it
// (its content goes into `scripts` to be run via page.evaluate()), or the tag
// unchanged to leave it in the HTML for happy-dom to handle.
function takeScript(match: string, attrs: string, baseDir: string, scripts: PendingScript[]): string {
  if (TYPE_MODULE_RE.test(attrs)) return match
  const srcMatch = SRC_ATTR_RE.exec(attrs)
  if (!srcMatch) return match
  const src = srcMatch[1]!
  if (ABS_URL_RE.test(src)) return match
  try {
    const file = resolve(baseDir, src)
    scripts.push({ src, content: readFileSync(file, 'utf8') })
    return ''
  } catch {
    process.stderr.write(`[domdomdom] could not read ${src}\n`)
    return match
  }
}

// Pull `<script src>` tags out of the HTML so we can run their contents via
// page.evaluate() (Script.runInContext) instead of letting happy-dom's HTML
// parser wrap them in `function anonymous(...)` — that wrapper makes top-level
// `var foo = ...` a local instead of a window property, breaking tsup/esbuild
// IIFE bundles. Module scripts are left alone: they have their own scope and
// happy-dom handles them via its module loader (paired with the virtual server
// in evaluate() so http(s) imports map onto the file system).
//
// We scan rather than a single .replace() because this matches on raw text, not
// a parsed DOM, and has to respect HTML comments: a commented-out
// `<!-- <script src="./x.js"></script> -->` must NOT be extracted and run (real
// browsers never load it), and prose inside a comment that merely mentions a
// script tag must not swallow the real tag that follows it. Masking comments out
// up front would be simpler but breaks the reverse case — `<!--` is legal inside
// a script body, where it must not start a comment. So walk left to right and
// let whichever construct opens first consume its own span.
function extractLocalScripts(
  html: string,
  baseDir: string,
): { html: string; scripts: PendingScript[] } {
  const scripts: PendingScript[] = []
  let out = ''
  let pos = 0

  while (pos < html.length) {
    SCRIPT_TAG_RE.lastIndex = pos
    const m = SCRIPT_TAG_RE.exec(html)
    if (!m) break

    let commentAt = html.indexOf('<!--', pos)
    while (commentAt !== -1 && !opensComment(html, commentAt)) {
      commentAt = html.indexOf('<!--', commentAt + 4)
    }
    if (commentAt !== -1 && commentAt < m.index) {
      // Comment opens first — copy it through verbatim and don't look inside.
      // An unterminated comment runs to the end of the document, same as a
      // browser's parser treats it.
      const end = html.indexOf('-->', commentAt + 4)
      const stop = end === -1 ? html.length : end + 3
      out += html.slice(pos, stop)
      pos = stop
      continue
    }

    out += html.slice(pos, m.index) + takeScript(m[0], m[1]!, baseDir, scripts)
    pos = m.index + m[0].length
  }

  return { html: out + html.slice(pos), scripts }
}

// happy-dom's BrowserWindow on Bun starts with all JS built-ins (Object, Math,
// JSON, parseInt, etc.) set to undefined. happy-dom's VMGlobalPropertyScript is
// meant to copy them from globalThis, but inside Script.runInContext globalThis
// refers to the (empty) inner scope. Copy them from the host realm explicitly.
//
// Snapshot the host built-ins at module-load time rather than reading
// globalThis on every call: in a long-lived process (e.g. a bun test run) other
// code can mutate global state between evaluate() calls — we observed
// Error.prototype.message picking up an empty default after unrelated tests,
// which then propagated into pages and stripped error messages.
const HOST_BUILTINS: Record<string, unknown> = (() => {
  const snap: Record<string, unknown> = {}
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    snap[name] = (globalThis as unknown as Record<string, unknown>)[name]
  }
  return snap
})()

function patchBuiltins(window: object): void {
  const win = window as Record<string, unknown>
  for (const name in HOST_BUILTINS) {
    if (win[name] !== undefined) continue
    try {
      win[name] = HOST_BUILTINS[name]
    } catch {
      /* read-only, ignore */
    }
  }
}

interface XPathCapableWindow {
  document: {
    evaluate: (...args: unknown[]) => unknown
    createExpression: (
      expression: string,
      resolver?: unknown,
    ) => { evaluate: (...args: unknown[]) => unknown }
    createNSResolver: (node: unknown) => unknown
  }
  XPathEvaluator?: unknown
  XPathResult?: unknown
}

// happy-dom doesn't implement window.XPathEvaluator / document.evaluate (the
// DOM Level 3 XPath API). htmx 4 uses `new XPathEvaluator().createExpression(...)`
// internally (for hx-on attribute matching) and throws ReferenceError without
// it. wicked-good-xpath (Google's pure-JS XPath 1.0 engine, MIT — formerly
// powered Selenium-on-IE) polyfills document.evaluate over standard DOM
// traversal, but needs three adjustments to work against happy-dom:
//
// 1. happy-dom's `window.Document` is a distinct synthetic subclass from the
//    class actually backing `window.document` (`window.document`'s prototype
//    chain never reaches `window.Document.prototype`). wgxpath.install()
//    auto-dispatches to `window.Document.prototype` when present, silently
//    patching the wrong class. Passing a bare `{ document }` shim (no
//    `.Document` property) starves that branch so it falls through to
//    patching `document` directly, as an own property — which is what
//    `window.document` actually uses.
// 2. wgxpath's XPathExpression#evaluate has no default for its `type` param.
//    Spec-compliant callers that omit it (relying on the WebIDL `optional
//    unsigned short type = 0` default, e.g. htmx's `expr.evaluate(node)`) hit
//    "Unknown XPathResult type." instead of getting auto-detection. Wrap it
//    to apply that default ourselves.
// 3. Real browsers expose a global `XPathEvaluator` constructor — the
//    interface `Document` implements, but also usable standalone. wgxpath
//    only patches `document`, so synthesize the constructor from it.
//
// Applied to every window unconditionally, like patchBuiltins() — XPath is
// standard in every real browser, so a page that uses it should just work.
// It's called from setupWindow() rather than layered on via `inject` because
// htmx constructs its XPathEvaluator at script-parse time: injects run after
// embedded `<script src>` tags have already been extracted and evaluated, so
// they'd be too late. setupWindow() covers embedded scripts, injects and user
// code alike, matching the browser guarantee that window.XPathEvaluator
// exists before any page script runs.
//
// wgxpath.install() guards internally with `if (!d.evaluate || force)`, so it
// already defers to a native document.evaluate should happy-dom ever ship
// one. The wrappers below don't guard, though: a happy-dom that implemented
// `evaluate` but not `createExpression` would throw here on every run. Narrow,
// but this is on the hot path for every invocation now.
function installXPath(window: object): void {
  const win = window as XPathCapableWindow
  // wgxpath.install(target) also sets `target.XPathResult` as a side effect —
  // on the real target, not on `win`, since we hand it the `{ document }`
  // shim rather than `win` itself (see point 1 above). Recover it from there.
  const shim: { document: XPathCapableWindow['document']; XPathResult?: unknown } = {
    document: win.document,
  }
  wgxpath.install(shim)
  if (!win.XPathResult) win.XPathResult = shim.XPathResult

  const nativeCreateExpression = win.document.createExpression.bind(win.document)
  win.document.createExpression = (expression: string, resolver?: unknown) => {
    const expr = nativeCreateExpression(expression, resolver)
    const nativeEvaluate = expr.evaluate.bind(expr)
    expr.evaluate = (...args: unknown[]) => {
      const [contextNode, type, result] = args
      return nativeEvaluate(contextNode, type ?? 0, result)
    }
    return expr
  }

  const nativeEvaluate = win.document.evaluate.bind(win.document)
  win.document.evaluate = (...args: unknown[]) => {
    const [expression, contextNode, resolver, type, result] = args
    return nativeEvaluate(expression, contextNode, resolver, type ?? 0, result)
  }

  if (!win.XPathEvaluator) {
    function XPathEvaluator(this: unknown): void {}
    XPathEvaluator.prototype.createExpression = (expression: string, resolver?: unknown) =>
      win.document.createExpression(expression, resolver)
    XPathEvaluator.prototype.createNSResolver = (node: unknown) => win.document.createNSResolver(node)
    XPathEvaluator.prototype.evaluate = (...args: unknown[]) => win.document.evaluate(...args)
    win.XPathEvaluator = XPathEvaluator
  }
}

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

function captureConsole(
  window: { console: Record<ConsoleLevel, (...args: unknown[]) => void> },
  logs: ConsoleEntry[],
  drop: boolean,
): void {
  const levels: ConsoleLevel[] = ['log', 'warn', 'error', 'info', 'debug']
  for (const level of levels) {
    window.console[level] = drop
      ? () => {}
      : (...args: unknown[]) => logs.push({ level, message: args.map(fmtArg).join(' ') })
  }
}

function resolveModuleDir(opts: EvaluateOptions): string | null {
  if (opts.source && !ABS_URL_RE.test(opts.source)) return dirname(resolve(opts.source))
  if (opts.html != null) return opts.baseDir ?? process.cwd()
  return null
}

async function safeClose(browser: { close(): Promise<void> }): Promise<void> {
  try {
    await browser.close()
  } catch {
    /* ignore */
  }
}

function setupError(e: unknown, logs: ConsoleEntry[], status: number | null): EvaluateResult {
  const err = e as { message?: string; stack?: string }
  return {
    ok: false,
    error: { kind: 'setup', message: err.message ?? String(e), stack: err.stack },
    logs,
    status,
  }
}

/**
 * Run `code` against a happy-dom page.
 *
 * The host event loop is shared with the page's VM context, so:
 * - `timeout` catches async hangs (long fetches, unresolved promises) — the
 *   common case.
 * - Synchronous infinite loops will block the timer too. To enforce a hard
 *   ceiling on those, wrap the CLI in `timeout 5s domdomdom ...` at the shell.
 */
export async function evaluate(
  code: string,
  opts: EvaluateOptions = {},
): Promise<EvaluateResult> {
  const logs: ConsoleEntry[] = []
  const timeoutMs = opts.timeout ?? 5000
  // The main document's final HTTP status, or null when nothing was fetched
  // over HTTP (inline --html, a local file, about:blank).
  let status: number | null = null

  // For local-file evaluation, route `<script type="module" src="./x.js">`
  // imports through happy-dom's fetch layer by mapping a synthetic origin to
  // the page directory on disk. file:// can't be fetched directly.
  const moduleDir = resolveModuleDir(opts)

  // Every navigation (page.goto, page.content) creates a fresh BrowserFrame
  // window, replacing whatever we patched earlier. Use beforeContentCallback so
  // built-ins and console hooks are reapplied on every load — covers about:blank,
  // local files, and remote URLs uniformly.
  const setupWindow = (w: object): void => {
    patchBuiltins(w)
    captureConsole(w as never, logs, !!opts.quietConsole)
    installXPath(w)
  }

  const settings: Record<string, unknown> = {
    enableJavaScriptEvaluation: true,
    suppressInsecureJavaScriptEnvironmentWarning: true,
    fetch: {
      disableSameOriginPolicy: true,
      ...(moduleDir
        ? { virtualServers: [{ url: LOCAL_HOST, directory: moduleDir }] }
        : {}),
    },
    timer: { preventTimerLoops: true },
    navigation: { beforeContentCallback: setupWindow },
  }
  if (opts.userAgent) settings.navigator = { userAgent: opts.userAgent }
  if (opts.viewport) settings.viewport = opts.viewport

  const browser = new Browser({ settings: settings as never })
  const page = browser.newPage()

  // beforeContentCallback fires only on navigation. The initial about:blank
  // window has no navigation event, so patch it directly for code that uses
  // no source/html.
  setupWindow(page.mainFrame.window)

  const baseDir = opts.baseDir
    ?? (opts.source && !ABS_URL_RE.test(opts.source) ? dirname(resolve(opts.source)) : process.cwd())

  try {
    if (opts.html != null && opts.source != null) {
      throw new Error('Pass either `html` or `source`, not both')
    }

    if (opts.html != null) {
      const { html: stripped, scripts } = extractLocalScripts(opts.html, baseDir)
      for (const s of scripts) page.evaluate(s.content)
      page.content = stripped
    } else if (opts.source) {
      if (ABS_URL_RE.test(opts.source)) {
        // happy-dom's goto() hands back the Response it already fetched — so
        // this is the status of the navigation itself, after any redirects, and
        // costs no second request. It is null for navigations that never issue
        // one (about:, javascript:, a same-document hash change).
        const response = await page.goto(opts.source)
        status = response?.status ?? null
      } else {
        const path = resolve(opts.source)
        const html = readFileSync(path, 'utf8')
        const { html: stripped, scripts } = extractLocalScripts(html, dirname(path))
        // Virtual-server origin lets module scripts inside the page resolve
        // their relative imports against the on-disk directory.
        page.url = `${LOCAL_HOST}/${path.split('/').pop()}`
        for (const s of scripts) page.evaluate(s.content)
        page.content = stripped
      }
    }

    // Failing fast is the whole point of --fail: once the status is known to be
    // bad, don't inject, don't wait for the page to settle, and don't run the
    // user's code. The document itself has already been parsed by goto(), which
    // is unavoidable — the status arrives with it.
    if (opts.failOnHttpError && isHttpFailure(status)) {
      const code = status as number
      // Snapshot the logs *before* closing. Tearing the browser down while the
      // document's subresources are still in flight aborts every one of them,
      // and each abort arrives as a console error — artefacts of our own
      // bail-out, not of the page. On a real 404 that was ~120 spurious lines.
      const result: EvaluateResult = {
        ok: false,
        error: { kind: 'http', status: code, message: httpErrorMessage(code, opts.source as string) },
        logs: logs.slice(),
        status,
      }
      await safeClose(browser)
      return result
    }

    for (const f of opts.inject ?? []) {
      const path = resolve(baseDir, f)
      page.evaluate(readFileSync(path, 'utf8'))
    }

    await page.waitUntilComplete()
  } catch (e) {
    await safeClose(browser)
    return setupError(e, logs, status)
  }

  const window = page.mainFrame.window
  const resultKey = '__r_' + Math.random().toString(36).slice(2)
  const errorKey = '__e_' + Math.random().toString(36).slice(2)
  const doneKey = '__d_' + Math.random().toString(36).slice(2)

  const wrapped = `;(async () => {
  try {
    globalThis['${resultKey}'] = await (async () => { ${code} })()
  } catch (e) {
    globalThis['${errorKey}'] = e
  } finally {
    globalThis['${doneKey}'] = true
  }
})();`

  try {
    const runner = window.document.createElement('script')
    if (opts.module) runner.setAttribute('type', 'module')
    runner.textContent = wrapped
    window.document.head.appendChild(runner)
  } catch (e) {
    await safeClose(browser)
    return setupError(e, logs, status)
  }

  // page.waitUntilComplete() resolves when the script tag's synchronous body
  // finishes running — it doesn't track promises pending inside our async IIFE.
  // Poll for the doneKey to know when user code has actually settled. Race
  // against a host timer so async hangs (unresolved promises, slow fetches)
  // don't run forever. NB: synchronous busy loops in user code will block this
  // host timer too — wrap the CLI in `timeout 5s ...` for those.
  const w = window as unknown as Record<string, unknown>
  const completion = (async (): Promise<'done'> => {
    while (!w[doneKey]) await new Promise(r => setTimeout(r, 5))
    return 'done'
  })()
  const timer =
    timeoutMs > 0
      ? new Promise<'timeout'>(r => setTimeout(() => r('timeout'), timeoutMs))
      : new Promise<never>(() => {})
  const winner = await Promise.race([completion, timer])

  if (winner === 'timeout') {
    await safeClose(browser)
    return {
      ok: false,
      error: { kind: 'timeout', message: `Evaluation timed out after ${timeoutMs}ms` },
      logs,
      status,
    }
  }

  const err = w[errorKey]
  if (err !== undefined) {
    const e = err as { stack?: string; message?: string }
    await safeClose(browser)
    return {
      ok: false,
      error: { kind: 'eval', message: e.message ?? String(err), stack: e.stack },
      logs,
      status,
    }
  }
  const result = w[resultKey]
  await safeClose(browser)
  return { ok: true, result, logs, status }
}

/**
 * JSON-stringify-safe transform for arbitrary values. Cycles become
 * "[Circular]"; functions, BigInt, Symbol and undefined become tagged
 * strings; DOM nodes drop to plain objects (own enumerable props only).
 * Used by the CLI to render results without crashing on unrepresentable
 * types.
 */
export function toCloneable(value: unknown): unknown {
  const seen = new WeakSet<object>()
  const replacer = (_key: string, v: unknown): unknown => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function') return `[Function: ${(v as Function).name || 'anonymous'}]`
      if (typeof v === 'bigint') return `${(v as bigint).toString()}n`
      if (typeof v === 'symbol') return (v as symbol).toString()
      if (typeof v === 'undefined') return '[undefined]'
      return v
    }
    if (seen.has(v as object)) return '[Circular]'
    seen.add(v as object)
    return v
  }
  try {
    return JSON.parse(JSON.stringify(value, replacer))
  } catch {
    return String(value)
  }
}
