#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
import { parseArgs } from 'node:util'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { evaluate, toCloneable, type EvaluateOptions, type EvaluateResult } from './index.ts'

const HELP = `domdomdom — evaluate JS against an HTML page (powered by happy-dom)

Usage:
  domdomdom [options] [URL_OR_PATH]
  echo "return 1+1" | domdomdom
  echo "return document.title" | domdomdom ./page.html
  domdomdom --html '<title>x</title>' --script ./query.js

Source (pick one):
  URL_OR_PATH               http(s) URL fetched via happy-dom; otherwise local HTML file
  --html <string>           inline HTML
  (none)                    about:blank

Code (pick one):
  (stdin)                   user code from stdin (default)
  --script <file>           read user code from a file

Other options:
  --inject <file>           preload a JS file in the window before user code (repeatable)
  --module                  evaluate as ES module (allows top-level import)
  --user-agent <ua>         override navigator.userAgent
  --viewport <WxH>          override page viewport, e.g. 1024x768
  --timeout <ms>            time limit; 0 disables; default 5000
  --prevent-timer-loops     drop timers rescheduled from the same call site
                            (happy-dom's guard; off by default, see below)
  --fail                    treat a non-2xx page as an error (like curl --fail)
  --no-console              drop console.* output instead of capturing it
  --json                    emit a single JSON line: { ok, result?, error?, logs, status }
  -h, --help                show this help
  -V, --version             print the package version and exit

Output (default):
  result               -> stdout (string passthrough; objects pretty-JSON; cycles handled)
  console.* messages   -> stderr, prefixed [log]/[warn]/[error]/[info]/[debug]
  errors               -> stderr ("EVAL ERROR: ...")

Exit codes: 0 ok | 1 eval error | 2 timeout | 3 setup/usage error | 4 HTTP error

HTTP status:
  --json always carries "status": the main document's final status after
  redirects, or null for --html, a local file or about:blank. WITHOUT --fail a
  404 still exits 0 with ok:true — check "status", not the exit code.

Timers:
  setTimeout/setInterval/requestAnimationFrame run normally; a page that never
  stops polling is caught by --timeout (exit 2). --prevent-timer-loops turns on
  happy-dom's loop guard, which fingerprints each call SITE by its stack and
  silently drops repeat timers from it — that also kills ordinary sequential
  awaited timers, so it is opt-in.

Limits:
  Synchronous infinite loops in user code block the timeout (host event loop
  shared with the page). Wrap in shell timeout for hard cap: timeout 5s domdomdom ...
`

interface Args {
  positional: string | undefined
  html: string | undefined
  script: string | undefined
  inject: string[]
  module: boolean
  userAgent: string | undefined
  viewport: { width: number; height: number } | undefined
  timeout: number
  preventTimerLoops: boolean
  quietConsole: boolean
  fail: boolean
  json: boolean
  help: boolean
}

/**
 * Filled in at build time is overkill; reading our own manifest is enough.
 *
 * This file ships at two different depths relative to package.json: as
 * source (cli.ts), sitting right next to it at the package root; as the
 * built dist/cli.js, one directory down. Try the sibling location first,
 * then the parent, so this resolves correctly whichever one is actually
 * running — including the built layout inside a consumer's node_modules,
 * where the source location doesn't exist at all.
 *
 * A plain function rather than an inline IIFE so tests can point it at a
 * synthetic URL and exercise the parent-fallback and not-found branches
 * directly — the real `import.meta.url` only ever takes one of those paths
 * in a given run.
 */
export function resolvePackageVersion(fromUrl: string | URL = import.meta.url): string {
  for (const rel of ['./package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, fromUrl), 'utf8'))
      if (typeof pkg.version === 'string') return pkg.version
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0'
}

export const PACKAGE_VERSION: string = resolvePackageVersion()

/** Streams the CLI uses for I/O. Injected so tests can drive runCli() in-process. */
export interface CliIO {
  argv: string[]
  stdin: AsyncIterable<Buffer | Uint8Array | string>
  stdout: { write(s: string): unknown }
  stderr: { write(s: string): unknown }
}

function parseViewport(s: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(s)
  if (!m) throw new Error(`--viewport must be WxH (e.g. 1024x768), got "${s}"`)
  return { width: Number(m[1]), height: Number(m[2]) }
}

function parseCli(argv: string[]): Args {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      html: { type: 'string' },
      script: { type: 'string' },
      inject: { type: 'string', multiple: true },
      module: { type: 'boolean' },
      'user-agent': { type: 'string' },
      viewport: { type: 'string' },
      timeout: { type: 'string' },
      'prevent-timer-loops': { type: 'boolean' },
      'no-console': { type: 'boolean' },
      fail: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  })
  return {
    positional: positionals[0],
    html: values.html,
    script: values.script,
    inject: values.inject ?? [],
    module: !!values.module,
    userAgent: values['user-agent'],
    viewport: values.viewport ? parseViewport(values.viewport) : undefined,
    timeout: values.timeout != null ? Number(values.timeout) : 5000,
    preventTimerLoops: !!values['prevent-timer-loops'],
    quietConsole: !!values['no-console'],
    fail: !!values.fail,
    json: !!values.json,
    help: !!values.help,
  }
}

async function readAll(stream: AsyncIterable<Buffer | Uint8Array | string>): Promise<string> {
  const parts: string[] = []
  for await (const chunk of stream) {
    parts.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
  }
  return parts.join('')
}

// Auto-return: try parsing the user's code as an expression first. If that
// works, wrap it so its value flows back to the caller. Otherwise treat it as
// a statement block (user must `return` themselves). Cheaper and more robust
// than regex sniffing — catches e.g. template literals containing newlines.
function wrapForReturn(code: string): string {
  const trimmed = code.trim()
  if (!trimmed) return ''
  try {
    new Function(`return (${trimmed})`)
    return `return (${trimmed})`
  } catch {
    return code
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(toCloneable(value), null, 2)
}

/**
 * The exit-code contract, in one place so the two emitters cannot disagree:
 * 0 ok, 1 eval, 2 timeout, 3 setup/usage, 4 HTTP. Mirrored exactly by
 * browsebrowsebrowse's `exitCodeFor()`; each code stays diagnostic, so a new
 * failure mode gets a new number rather than borrowing one.
 */
export function exitCodeFor(result: EvaluateResult): number {
  if (result.ok) return 0
  switch (result.error.kind) {
    case 'timeout':
      return 2
    case 'setup':
      return 3
    case 'http':
      return 4
    default:
      return 1
  }
}

function emitHuman(result: EvaluateResult, io: CliIO): number {
  for (const { level, message } of result.logs) {
    io.stderr.write(`[${level}] ${message}\n`)
  }
  if (!result.ok) {
    const e = result.error
    if (e.kind === 'timeout') io.stderr.write(`TIMEOUT: ${e.message}\n`)
    else if (e.kind === 'setup') io.stderr.write(`SETUP ERROR: ${e.message}\n${e.stack ?? ''}\n`)
    else if (e.kind === 'http') io.stderr.write(`HTTP ERROR: ${e.message}\n`)
    else io.stderr.write(`EVAL ERROR: ${e.stack ?? e.message}\n`)
    return exitCodeFor(result)
  }
  if (result.result === undefined) io.stdout.write('undefined\n')
  else io.stdout.write(safeStringify(result.result) + '\n')
  return 0
}

function emitJson(result: EvaluateResult, io: CliIO): number {
  const payload = result.ok
    ? { ok: true, result: toCloneable(result.result), logs: result.logs, status: result.status }
    : { ok: false, error: result.error, logs: result.logs, status: result.status }
  io.stdout.write(JSON.stringify(payload) + '\n')
  return exitCodeFor(result)
}

/**
 * Run the CLI with the given I/O. Returns the exit code instead of calling
 * process.exit, so tests can drive it in-process.
 */
export async function runCli(io: CliIO): Promise<number> {
  let args: Args
  try {
    args = parseCli(io.argv)
  } catch (e) {
    io.stderr.write(`USAGE: ${(e as Error).message}\n\n${HELP}`)
    return 3
  }

  if (args.help) {
    io.stdout.write(HELP)
    return 0
  }

  if (args.html != null && args.positional != null) {
    io.stderr.write('USAGE: pass either --html or a positional URL/path, not both\n')
    return 3
  }

  const code = args.script != null
    ? readFileSync(args.script, 'utf8')
    : await readAll(io.stdin)

  // CLI consumers usually type a one-liner expression; only auto-return when
  // the user piped code via stdin and didn't ask for module mode.
  const userCode = args.module || args.script ? code : wrapForReturn(code)

  const opts: EvaluateOptions = {
    timeout: args.timeout,
    module: args.module,
    inject: args.inject,
    userAgent: args.userAgent,
    viewport: args.viewport,
    quietConsole: args.quietConsole,
    failOnHttpError: args.fail,
    preventTimerLoops: args.preventTimerLoops,
  }
  if (args.html != null) opts.html = args.html
  else if (args.positional != null) opts.source = args.positional

  const result = await evaluate(userCode, opts)
  return args.json ? emitJson(result, io) : emitHuman(result, io)
}

/**
 * Binary entry-point logic. Defaults all I/O streams and the exit hook to the
 * real `process.*` so calling `runFromProcess()` with no args matches what the
 * shipped binary does. Tests can inject mocks to drive it in-process.
 */
export async function runFromProcess(
  argv: string[] = process.argv.slice(2),
  stdin: AsyncIterable<Buffer | Uint8Array | string> = process.stdin,
  stdout: { write(s: string): unknown } = process.stdout,
  stderr: { write(s: string): unknown } = process.stderr,
  exit: (code: number) => never = ((code: number) => process.exit(code)) as (code: number) => never,
): Promise<never> {
  // Handled before parseArgs (inside runCli), which rejects unknown options —
  // same reason bbb, our sibling CLI, does this early rather than as a flag.
  if (argv[0] === '--version' || argv[0] === '-V') {
    stdout.write(PACKAGE_VERSION + '\n')
    return exit(0)
  }
  let code: number
  try {
    code = await runCli({ argv, stdin, stdout, stderr })
  } catch (e) {
    stderr.write(`FATAL: ${(e as Error).stack ?? String(e)}\n`)
    return exit(3)
  }
  return exit(code)
}

// Run when invoked as a script (i.e. via the shebang). Skipped when this
// module is imported by tests.
//
// Compare *real* paths: when the binary is invoked through a symlink (e.g.
// $HOME/.bun/bin/domdomdom -> .../cli.ts) Node sets process.argv[1] to the
// symlink while import.meta.url resolves to the real file. Bun coalesces them
// already, so this matters specifically for npx/Node users.
/** Exported for testing only; the binary entry block at module load uses it. */
export function isEntrypoint(argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
if (isEntrypoint()) runFromProcess()
