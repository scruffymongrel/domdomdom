import { test, expect, describe } from 'bun:test'
import { resolve } from 'node:path'
import { evaluate, toCloneable } from '../index.ts'

const fixture = (name: string): string => resolve(import.meta.dir, 'fixtures', name)

describe('evaluate()', () => {
  test('returns expression result', async () => {
    const r = await evaluate('return 1 + 2')
    expect(r).toEqual({ ok: true, result: 3, logs: [] })
  })

  test('reads document.title from inline html', async () => {
    const r = await evaluate('return document.title', { html: '<title>hi</title>' })
    expect(r.ok && r.result).toBe('hi')
  })

  test('querySelector works (covers happy-dom SyntaxError patch)', async () => {
    const r = await evaluate(
      'return document.querySelectorAll("p").length',
      { html: '<p>a</p><p>b</p><p>c</p>' },
    )
    expect(r.ok && r.result).toBe(3)
  })

  test('async/await result', async () => {
    const r = await evaluate('return await Promise.resolve(42)')
    expect(r.ok && r.result).toBe(42)
  })

  test('throw -> ok:false with message + stack', async () => {
    const r = await evaluate('throw new Error("boom")')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('eval')
      expect(r.error.message).toBe('boom')
      if (r.error.kind === 'eval') expect(r.error.stack).toBeTruthy()
    }
  })

  test('console capture', async () => {
    const r = await evaluate(
      'console.log("a", 1); console.warn("w"); console.error({k:1}); return null',
    )
    expect(r.ok && r.logs).toEqual([
      { level: 'log', message: 'a 1' },
      { level: 'warn', message: 'w' },
      { level: 'error', message: '{"k":1}' },
    ])
  })

  test('quietConsole drops logs', async () => {
    const r = await evaluate('console.log("ignored"); return 1', { quietConsole: true })
    expect(r.ok && r.logs).toEqual([])
    expect(r.ok && r.result).toBe(1)
  })

  test('async hang -> timeout error', async () => {
    const t0 = performance.now()
    const r = await evaluate('return await new Promise(() => {})', { timeout: 200 })
    const elapsed = performance.now() - t0
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('timeout')
    expect(elapsed).toBeGreaterThanOrEqual(200)
    expect(elapsed).toBeLessThan(800)
  })

  test('IIFE bundle: top-level var lands on window', async () => {
    const r = await evaluate('return window.bundleResult', { source: fixture('iife-page.html') })
    expect(r.ok && r.result).toEqual({ ok: true, version: '1.0.0' })
  })

  test('ES module script with relative import loads from disk', async () => {
    const r = await evaluate(
      'return window.modOutput',
      { source: fixture('module-page.html'), timeout: 3000 },
    )
    expect(r.ok && r.result).toEqual({ greeting: 'hello from module', doubled: 42 })
  })

  test('inject runs before user code', async () => {
    const r = await evaluate('return window.PRELOADED', {
      inject: [fixture('preload.js')],
    })
    expect(r.ok && r.result).toBe('yes')
  })

  test('userAgent override', async () => {
    const r = await evaluate('return navigator.userAgent', { userAgent: 'TestBot/9' })
    expect(r.ok && r.result).toBe('TestBot/9')
  })

  test('source + html together -> setup error', async () => {
    const r = await evaluate('return 1', { html: '<p>x</p>', source: 'http://example.com' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('setup')
  })

  test('built-ins are present in page context (Math, JSON, parseInt)', async () => {
    const r = await evaluate('return [typeof Math, typeof JSON, typeof parseInt]')
    expect(r.ok && r.result).toEqual(['object', 'object', 'function'])
  })

  test('http URL via Bun.serve', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('<title>served</title><h1>hi</h1>', {
        headers: { 'content-type': 'text/html' },
      }),
    })
    try {
      const r = await evaluate(
        'return [document.title, document.querySelector("h1").textContent]',
        { source: server.url.toString(), timeout: 3000 },
      )
      expect(r.ok && r.result).toEqual(['served', 'hi'])
    } finally {
      server.stop()
    }
  })

  test('missing <script src> warns and proceeds', async () => {
    const r = await evaluate(
      'return document.title',
      { html: '<title>still-works</title><script src="./does-not-exist.js"></script>' },
    )
    expect(r.ok && r.result).toBe('still-works')
  })

  test('console.log with BigInt (JSON.stringify throws → String fallback)', async () => {
    const r = await evaluate('console.log(10n); return 1')
    expect(r.ok && r.logs[0]?.message).toBe('10')
  })

  test('timeout: 0 disables the limit', async () => {
    const r = await evaluate(
      'return await new Promise(r => setTimeout(() => r("ok"), 50))',
      { timeout: 0 },
    )
    expect(r.ok && r.result).toBe('ok')
  })

  test('runner appendChild failure -> setup error', async () => {
    const r = await evaluate('return 1', { inject: [fixture('break-head.js')] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('setup')
      expect(r.error.message).toContain('appendChild blocked')
    }
  })
})

describe('toCloneable()', () => {
  test('handles plain objects', () => {
    expect(toCloneable({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' })
  })

  test('replaces functions with tagged string', () => {
    const r = toCloneable({ fn: function named() {} }) as { fn: string }
    expect(r.fn).toBe('[Function: named]')
  })

  test('replaces BigInt and undefined', () => {
    expect(toCloneable({ n: 10n, u: undefined })).toEqual({ n: '10n', u: '[undefined]' })
  })

  test('handles cycles', () => {
    const o: { self?: unknown } = {}
    o.self = o
    const r = toCloneable(o) as { self: string }
    expect(r.self).toBe('[Circular]')
  })

  test('passes Date through (lossy: ISO string via JSON.stringify)', () => {
    const d = new Date('2026-01-01T00:00:00Z')
    expect(toCloneable(d)).toBe('2026-01-01T00:00:00.000Z')
  })

  test('falls back to String() when JSON.stringify throws', () => {
    const o = { toJSON() { throw new Error('nope') } }
    expect(toCloneable(o)).toBe('[object Object]')
  })
})
