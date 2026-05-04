import { Browser } from 'happy-dom'
import { resolve, dirname } from 'node:path'
import { readFileSync } from 'node:fs'

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
}

export type EvaluateError =
  | { kind: 'eval'; message: string; stack?: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'setup'; message: string; stack?: string }

export type EvaluateResult =
  | { ok: true; result: unknown; logs: ConsoleEntry[] }
  | { ok: false; error: EvaluateError; logs: ConsoleEntry[] }

interface PendingScript {
  src: string
  content: string
}

const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
const SRC_ATTR_RE = /\bsrc=["']([^"']+)["']/i
const TYPE_MODULE_RE = /\btype=["']module["']/i
const ABS_URL_RE = /^(https?:)?\/\//i
const LOCAL_HOST = 'http://__domdomdom_local__'

// Pull `<script src>` tags out of the HTML so we can run their contents via
// page.evaluate() (Script.runInContext) instead of letting happy-dom's HTML
// parser wrap them in `function anonymous(...)` — that wrapper makes top-level
// `var foo = ...` a local instead of a window property, breaking tsup/esbuild
// IIFE bundles. Module scripts are left alone: they have their own scope and
// happy-dom handles them via its module loader (paired with the virtual server
// in evaluate() so http(s) imports map onto the file system).
function extractLocalScripts(
  html: string,
  baseDir: string,
): { html: string; scripts: PendingScript[] } {
  const scripts: PendingScript[] = []
  const stripped = html.replace(SCRIPT_TAG_RE, (match, attrs: string) => {
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
  })
  return { html: stripped, scripts }
}

// happy-dom's BrowserWindow on Bun starts with all JS built-ins (Object, Math,
// JSON, parseInt, etc.) set to undefined. happy-dom's VMGlobalPropertyScript is
// meant to copy them from globalThis, but inside Script.runInContext globalThis
// refers to the (empty) inner scope. Copy them from the host realm explicitly.
function patchBuiltins(window: object): void {
  const win = window as Record<string, unknown>
  const host = globalThis as unknown as Record<string, unknown>
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (win[name] !== undefined) continue
    try {
      win[name] = host[name]
    } catch {
      /* read-only, ignore */
    }
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

function setupError(e: unknown, logs: ConsoleEntry[]): EvaluateResult {
  const err = e as { message?: string; stack?: string }
  return {
    ok: false,
    error: { kind: 'setup', message: err.message ?? String(e), stack: err.stack },
    logs,
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
        await page.goto(opts.source)
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

    for (const f of opts.inject ?? []) {
      const path = resolve(baseDir, f)
      page.evaluate(readFileSync(path, 'utf8'))
    }

    await page.waitUntilComplete()
  } catch (e) {
    await safeClose(browser)
    return setupError(e, logs)
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
    return setupError(e, logs)
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
    }
  }
  const result = w[resultKey]
  await safeClose(browser)
  return { ok: true, result, logs }
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
