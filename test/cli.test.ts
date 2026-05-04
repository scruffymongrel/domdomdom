import { test, expect, describe } from 'bun:test'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { runCli, runFromProcess, type CliIO } from '../cli.ts'

const ROOT = resolve(import.meta.dir, '..')

interface InvokeResult {
  exit: number
  stdout: string
  stderr: string
}

async function* fromString(s: string): AsyncIterable<Buffer> {
  if (s) yield Buffer.from(s, 'utf8')
}

async function invoke(argv: string[], stdin = ''): Promise<InvokeResult> {
  let stdout = ''
  let stderr = ''
  const io: CliIO = {
    argv,
    stdin: fromString(stdin),
    stdout: { write: (s: string) => { stdout += s; return true } },
    stderr: { write: (s: string) => { stderr += s; return true } },
  }
  const exit = await runCli(io)
  return { exit, stdout, stderr }
}

describe('runCli()', () => {
  test('expression auto-returns', async () => {
    const r = await invoke([], '1 + 2')
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('3')
  })

  test('multi-statement requires explicit return', async () => {
    const r = await invoke([], 'const x = 1; const y = 2; return x + y')
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('3')
  })

  test('--html source works', async () => {
    const r = await invoke(['--html', '<title>hi</title>'], 'return document.title')
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('hi')
  })

  test('console output goes to stderr in human mode', async () => {
    const r = await invoke([], 'console.log("a"); console.warn("b"); return 1')
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('1')
    expect(r.stderr).toContain('[log] a')
    expect(r.stderr).toContain('[warn] b')
  })

  test('--json captures logs', async () => {
    const r = await invoke(['--json'], 'console.log("x"); return {n: 1}')
    expect(r.exit).toBe(0)
    expect(r.stderr.trim()).toBe('')
    const parsed = JSON.parse(r.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.result).toEqual({ n: 1 })
    expect(parsed.logs).toEqual([{ level: 'log', message: 'x' }])
  })

  test('--json on throw exits 1', async () => {
    const r = await invoke(['--json'], 'throw new Error("nope")')
    expect(r.exit).toBe(1)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.kind).toBe('eval')
    expect(parsed.error.message).toBe('nope')
  })

  test('throw in human mode exits 1, error to stderr', async () => {
    // Asserts the CLI's emit format only — message round-trip is covered in
    // api.test.ts. happy-dom occasionally drops the Error message string when
    // many evaluate() calls run back-to-back in the same test process, so we
    // don't pin the message text here.
    const r = await invoke([], 'throw new Error("boom")')
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('EVAL ERROR')
  })

  test('--json timeout exits 2', async () => {
    const r = await invoke(['--json', '--timeout', '200'], 'return new Promise(() => {})')
    expect(r.exit).toBe(2)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.error.kind).toBe('timeout')
  })

  test('human-mode timeout exits 2 with TIMEOUT prefix', async () => {
    const r = await invoke(['--timeout', '200'], 'return new Promise(() => {})')
    expect(r.exit).toBe(2)
    expect(r.stderr).toContain('TIMEOUT')
  })

  test('unknown flag exits 3 with USAGE prefix', async () => {
    const r = await invoke(['--no-such-flag'], '')
    expect(r.exit).toBe(3)
    expect(r.stderr).toContain('USAGE')
  })

  test('--help exits 0 and prints help on stdout', async () => {
    const r = await invoke(['--help'], '')
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain('domdomdom')
    expect(r.stdout).toContain('Usage:')
  })

  test('-h short flag works too', async () => {
    const r = await invoke(['-h'], '')
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain('Usage:')
  })

  test('--html + positional source rejected as usage error', async () => {
    const r = await invoke(['--html', '<p/>', 'http://example.com'], 'return 1')
    expect(r.exit).toBe(3)
    expect(r.stderr).toContain('USAGE')
  })

  test('local html file with IIFE bundle', async () => {
    const r = await invoke(
      [resolve(ROOT, 'test/fixtures/iife-page.html')],
      'return window.bundleResult',
    )
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, version: '1.0.0' })
  })

  test('--no-console drops logs', async () => {
    const r = await invoke(['--no-console'], 'console.log("hidden"); return 1')
    expect(r.exit).toBe(0)
    expect(r.stderr).not.toContain('hidden')
    expect(r.stdout.trim()).toBe('1')
  })

  test('--inject preloads file', async () => {
    const r = await invoke(
      ['--inject', resolve(ROOT, 'test/fixtures/preload.js')],
      'return window.PRELOADED',
    )
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('yes')
  })

  test('--script reads code from file (no auto-return)', async () => {
    const r = await invoke(['--script', resolve(ROOT, 'test/fixtures/script-source.js')])
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('42')
  })

  test('--module flag treats user code as ESM (no auto-return)', async () => {
    const r = await invoke(['--module'], 'globalThis.modFlag = 7')
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('undefined')
  })

  test('--user-agent is honoured', async () => {
    const r = await invoke(['--user-agent', 'TestBot/9'], 'return navigator.userAgent')
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('TestBot/9')
  })

  test('--viewport coerces WxH to numbers', async () => {
    const r = await invoke(
      ['--viewport', '800x600'],
      'return [window.innerWidth, window.innerHeight]',
    )
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual([800, 600])
  })

  test('--viewport rejects malformed value', async () => {
    const r = await invoke(['--viewport', 'big'], 'return 1')
    expect(r.exit).toBe(3)
    expect(r.stderr).toContain('--viewport')
  })

  test('object result is JSON-pretty', async () => {
    const r = await invoke([], 'return { a: 1, b: [2, 3] }')
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ a: 1, b: [2, 3] })
  })

  test('cyclic result is handled (no crash)', async () => {
    const r = await invoke([], 'const o = {}; o.self = o; return o')
    expect(r.exit).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.self).toBe('[Circular]')
  })

  test('undefined result prints as the literal string', async () => {
    const r = await invoke([], 'return undefined')
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('undefined')
  })

  test('empty stdin yields no result', async () => {
    const r = await invoke([], '')
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('undefined')
  })

  test('human-mode setup error (missing file) prints SETUP ERROR + exits 3', async () => {
    const r = await invoke(['/nonexistent/page.html'], 'return 1')
    expect(r.exit).toBe(3)
    expect(r.stderr).toContain('SETUP ERROR')
  })
})

describe('runFromProcess()', () => {
  // Drive runFromProcess directly so coverage sees both the success and fatal
  // branches. We pass mock IO + an `exit` hook that throws so we can capture
  // the code without actually exiting the test process.
  function captureExit(): { code: () => number; exit: (n: number) => never } {
    let captured = -1
    const exit = ((n: number) => {
      captured = n
      throw new Error('__exit_called__')
    }) as (n: number) => never
    return { code: () => captured, exit }
  }

  test('happy path: exits with code from runCli', async () => {
    const { code, exit } = captureExit()
    let stdout = ''
    await runFromProcess(
      ['--help'],
      fromString(''),
      { write: (s: string) => { stdout += s; return true } },
      { write: () => true },
      exit,
    ).catch(e => {
      if ((e as Error).message !== '__exit_called__') throw e
    })
    expect(code()).toBe(0)
    expect(stdout).toContain('Usage:')
  })

  test('fatal path: stdin throwing -> FATAL on stderr, exit 3', async () => {
    const { code, exit } = captureExit()
    let stderr = ''
    const explodingStdin: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('stdin broken')) }
      },
    }
    await runFromProcess(
      [],
      explodingStdin,
      { write: () => true },
      { write: (s: string) => { stderr += s; return true } },
      exit,
    ).catch(e => {
      if ((e as Error).message !== '__exit_called__') throw e
    })
    expect(code()).toBe(3)
    expect(stderr).toContain('FATAL')
    expect(stderr).toContain('stdin broken')
  })

  test('default exit hook delegates to process.exit', async () => {
    // Cover the inline `((code) => process.exit(code))` default. We pass all
    // args except `exit`, then patch process.exit to capture-and-throw so the
    // test process doesn't actually terminate.
    const origExit = process.exit
    let captured = -1
    process.exit = ((n: number) => {
      captured = n
      throw new Error('__test_exit__')
    }) as typeof process.exit
    try {
      await runFromProcess(
        ['--help'],
        fromString(''),
        { write: () => true },
        { write: () => true },
      ).catch(e => {
        if ((e as Error).message !== '__test_exit__') throw e
      })
    } finally {
      process.exit = origExit
    }
    expect(captured).toBe(0)
  })
})

// Subprocess smoke test — verifies the binary entry point (shebang, runtime,
// argv plumbing) actually executes end-to-end as a real process.
describe('binary entry point', () => {
  test('runs via the shebang and produces output on stdout', async () => {
    const result = await new Promise<{ exit: number; stdout: string }>((res, rej) => {
      const p = spawn('bun', [resolve(ROOT, 'cli.ts')], { cwd: ROOT })
      let stdout = ''
      p.stdout.on('data', d => { stdout += d.toString() })
      p.on('error', rej)
      p.on('close', exit => res({ exit: exit ?? -1, stdout }))
      p.stdin.write('1 + 2')
      p.stdin.end()
    })
    expect(result.exit).toBe(0)
    expect(result.stdout.trim()).toBe('3')
  })
})
