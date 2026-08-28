// HTTP status reporting and the `--fail` flag.
//
// The bug these exist to prevent: a 404 used to look exactly like a success.
// `{"ok":true,"result":"Page not found · GitHub","logs":[...]}` and exit 0 —
// the status appeared nowhere but a console line. Every assertion below is
// against a real socket, because the interesting cases (a redirect chain, a
// body served with a non-2xx status) are only interesting once HTTP is real.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import {
  evaluate,
  isHttpFailure,
  httpErrorMessage,
  exitCodeFor,
  runCli,
  type CliIO,
} from './subject.ts'
import { startFixtures, type Fixtures } from './fixtures/server.ts'

let fx: Fixtures
beforeAll(() => {
  fx = startFixtures()
})
afterAll(() => fx.stop())

async function* fromString(s: string): AsyncIterable<Buffer> {
  if (s) yield Buffer.from(s, 'utf8')
}

async function invoke(argv: string[], stdin = ''): Promise<{ exit: number; json: any; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const io: CliIO = {
    argv,
    stdin: fromString(stdin),
    stdout: { write: (s: string) => { stdout += s; return true } },
    stderr: { write: (s: string) => { stderr += s; return true } },
  }
  const exit = await runCli(io)
  return { exit, json: stdout.startsWith('{') ? JSON.parse(stdout) : undefined, stderr }
}

describe('isHttpFailure()', () => {
  test('2xx passes', () => {
    expect(isHttpFailure(200)).toBe(false)
    expect(isHttpFailure(201)).toBe(false)
    expect(isHttpFailure(299)).toBe(false)
  })

  test('everything else fails', () => {
    expect(isHttpFailure(199)).toBe(true)
    expect(isHttpFailure(300)).toBe(true)
    expect(isHttpFailure(404)).toBe(true)
    expect(isHttpFailure(500)).toBe(true)
  })

  // A null status means no HTTP request happened at all — there is nothing
  // to fail on, so --fail must be inert rather than fail-closed.
  test('null is not a failure', () => {
    expect(isHttpFailure(null)).toBe(false)
  })

  test('the message names the status and the URL', () => {
    expect(httpErrorMessage(404, 'https://x/y')).toBe('HTTP 404 for https://x/y')
  })
})

describe('exitCodeFor()', () => {
  const at = (kind: string): number =>
    exitCodeFor({ ok: false, error: { kind, message: 'x', status: 404 } as never, logs: [], status: null })

  test('maps every kind to its own code', () => {
    expect(exitCodeFor({ ok: true, result: 1, logs: [], status: null })).toBe(0)
    expect(at('eval')).toBe(1)
    expect(at('timeout')).toBe(2)
    expect(at('setup')).toBe(3)
    expect(at('http')).toBe(4)
  })
})

describe('status in the result', () => {
  test('a 200 reports 200', async () => {
    const r = await evaluate('return document.title', { source: fx.url('/') })
    expect(r).toMatchObject({ ok: true, result: 'ok', status: 200 })
  })

  // The regression that motivated all of this: without --fail a 404 is still a
  // perfectly good page to scrape, and stays ok:true.
  test('a 404 still succeeds, but says 404', async () => {
    const r = await evaluate('return document.title', { source: fx.url('/404') })
    expect(r).toMatchObject({ ok: true, result: 'not found', status: 404 })
  })

  test('a 500 says 500', async () => {
    const r = await evaluate('return document.title', { source: fx.url('/500') })
    expect(r).toMatchObject({ ok: true, status: 500 })
  })

  test('a redirect reports the FINAL status, not the 302', async () => {
    const r = await evaluate('return document.title', { source: fx.url('/redirect') })
    expect(r).toMatchObject({ ok: true, result: 'ok', status: 200 })
  })

  test('a redirect that lands on a 404 reports 404', async () => {
    const r = await evaluate('return 1', { source: fx.url('/redirect-to-404') })
    expect(r).toMatchObject({ ok: true, status: 404 })
  })

  test('non-HTTP sources report null: inline html, a local file, about:blank', async () => {
    expect(await evaluate('return 1', { html: '<title>x</title>' })).toMatchObject({ status: null })
    expect(await evaluate('return 1')).toMatchObject({ status: null })
    const file = new URL('./fixtures/iife-page.html', import.meta.url).pathname
    expect(await evaluate('return 1', { source: file })).toMatchObject({ status: null })
  })

  test('status survives onto the failure shape', async () => {
    const r = await evaluate('throw new Error("nope")', { source: fx.url('/404') })
    expect(r).toMatchObject({ ok: false, status: 404 })
    expect(r.ok === false && r.error.kind).toBe('eval')
  })
})

describe('failOnHttpError', () => {
  test('a non-2xx becomes an http failure and the code never runs', async () => {
    const r = await evaluate('globalThis.__ran = true; return 1', {
      source: fx.url('/404'),
      failOnHttpError: true,
    })
    expect(r).toMatchObject({
      ok: false,
      status: 404,
      error: { kind: 'http', status: 404, message: `HTTP 404 for ${fx.url('/404')}` },
    })
  })

  test('a 2xx is unaffected', async () => {
    const r = await evaluate('return document.title', { source: fx.url('/'), failOnHttpError: true })
    expect(r).toMatchObject({ ok: true, result: 'ok', status: 200 })
  })

  test('a redirect to a 2xx is unaffected', async () => {
    const r = await evaluate('return 1', { source: fx.url('/redirect'), failOnHttpError: true })
    expect(r).toMatchObject({ ok: true, status: 200 })
  })

  // Nothing was fetched, so there is nothing to fail on.
  test('has no effect on a non-HTTP source', async () => {
    const r = await evaluate('return document.title', {
      html: '<title>inline</title>',
      failOnHttpError: true,
    })
    expect(r).toMatchObject({ ok: true, result: 'inline', status: null })
  })
})

describe('CLI', () => {
  test('--json carries status on success', async () => {
    const r = await invoke(['--json', fx.url('/')], 'document.title')
    expect(r.exit).toBe(0)
    expect(r.json).toMatchObject({ ok: true, result: 'ok', status: 200 })
  })

  // The whole point of the feature, stated as the contract an agent reads.
  test('a 404 without --fail is exit 0 and ok:true — status is the check', async () => {
    const r = await invoke(['--json', fx.url('/404')], 'document.title')
    expect(r.exit).toBe(0)
    expect(r.json).toMatchObject({ ok: true, status: 404 })
  })

  test('--fail turns a 404 into exit 4', async () => {
    const r = await invoke(['--json', '--fail', fx.url('/404')], 'document.title')
    expect(r.exit).toBe(4)
    expect(r.json).toMatchObject({
      ok: false,
      status: 404,
      error: { kind: 'http', status: 404 },
    })
    expect(r.json.logs).toBeArray()
  })

  test('--fail turns a 500 into exit 4', async () => {
    const r = await invoke(['--json', '--fail', fx.url('/500')], 'document.title')
    expect(r.exit).toBe(4)
    expect(r.json.error.status).toBe(500)
  })

  test('--fail leaves a 2xx at exit 0', async () => {
    const r = await invoke(['--json', '--fail', fx.url('/')], 'document.title')
    expect(r.exit).toBe(0)
    expect(r.json).toMatchObject({ ok: true, status: 200 })
  })

  test('--fail leaves a 302->200 chain at exit 0', async () => {
    const r = await invoke(['--json', '--fail', fx.url('/redirect')], 'document.title')
    expect(r.exit).toBe(0)
    expect(r.json).toMatchObject({ ok: true, status: 200 })
  })

  test('human mode reports HTTP ERROR on stderr and exits 4', async () => {
    const r = await invoke(['--fail', fx.url('/404')], 'document.title')
    expect(r.exit).toBe(4)
    expect(r.stderr).toContain('HTTP ERROR: HTTP 404 for')
  })

  test('--json carries status: null for a non-HTTP source', async () => {
    const r = await invoke(['--json', '--html', '<title>x</title>'], 'document.title')
    expect(r.exit).toBe(0)
    expect(r.json).toMatchObject({ ok: true, status: null })
  })
})
