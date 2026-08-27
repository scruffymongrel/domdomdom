import { test, expect, describe } from 'bun:test'
import { resolve } from 'node:path'
import { evaluate, toCloneable } from '../index.ts'

const fixtureDir = resolve(import.meta.dir, 'fixtures')
const fixture = (name: string): string => resolve(fixtureDir, name)

describe('evaluate()', () => {
  test('returns expression result', async () => {
    const r = await evaluate('return 1 + 2')
    expect(r).toEqual({ ok: true, result: 3, logs: [], status: null })
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
      await server.stop()
    }
  })

  test('missing <script src> warns and proceeds', async () => {
    const r = await evaluate(
      'return document.title',
      { html: '<title>still-works</title><script src="./does-not-exist.js"></script>' },
    )
    expect(r.ok && r.result).toBe('still-works')
  })

  // Script extraction matches raw text, not a parsed DOM, so it has to respect
  // HTML comments in both directions: don't run what's commented out, and don't
  // treat `<!--` inside a script body as a comment.
  describe('commented-out scripts', () => {
    test('a commented-out <script src> is not fetched or executed', async () => {
      const r = await evaluate('return typeof window.PRELOADED', {
        html: '<!-- disabled: <script src="./preload.js"></script> -->',
        baseDir: fixtureDir,
      })
      expect(r.ok && r.result).toBe('undefined')
    })

    test('a comment mentioning a script tag does not swallow the real one after it', async () => {
      // The unclosed `<script src>` in prose used to pair with the *real* tag's
      // `</script>`, consuming it so the real script never ran.
      const r = await evaluate('return typeof window.PRELOADED', {
        html: '<!-- load it with <script src> like so -->'
          + '<script src="./preload.js"></script>',
        baseDir: fixtureDir,
      })
      expect(r.ok && r.result).toBe('string')
    })

    test('an unterminated comment swallows the rest of the document', async () => {
      const r = await evaluate('return typeof window.PRELOADED', {
        html: '<!-- oops <script src="./preload.js"></script>',
        baseDir: fixtureDir,
      })
      expect(r.ok && r.result).toBe('undefined')
    })

    test('`<!--` inside an attribute value does not hide a later script', async () => {
      // Comments only open in text context. Treating this as one would swallow
      // the rest of the document, dropping the bundle back to happy-dom's
      // wrapped-script path where top-level `var` never reaches window.
      const r = await evaluate('return window.bundleResult', {
        html: '<div title="<!--"></div><script src="./iife-bundle.js"></script>',
        baseDir: fixtureDir,
      })
      expect(r.ok && r.result).toEqual({ ok: true, version: '1.0.0' })
    })

    test('`<!--` inside a script body does not start a comment', async () => {
      // The reverse case, and why masking comments up front isn't enough.
      const r = await evaluate('return window.marker', {
        html: '<script>/* <!-- */ window.marker = "ran"</script>',
      })
      expect(r.ok && r.result).toBe('ran')
    })
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

  // happy-dom ships a `preventTimerLoops` guard that fingerprints each call
  // site by its `new Error().stack` and, from the second call with a
  // byte-identical stack, returns `{}`: no timer created, no error thrown, a
  // promise that never settles. An ordinary sequential loop is exactly that
  // shape — one line, scheduling over and over — so it died at 2 iterations.
  // The guard is off by default here (happy-dom's own default too) and
  // `timeout` is the safety net instead: a *host* timer, so it fires whatever
  // the page's own timers are doing. See AGENTS.md.
  describe('timers', () => {
    // One `setTimeout(...)` on one line, awaited 20 times. The exact case that
    // hung, and the reason the guard cannot be on by default.
    const sequential = (n: number): string =>
      `let count = 0
       for (let i = 0; i < ${n}; i++) {
         await new Promise(done => setTimeout(done, 1))
         count++
       }
       return count`

    test('20 sequential awaited setTimeouts from one call site all fire', async () => {
      const r = await evaluate(sequential(20), { timeout: 3000 })
      expect(r.ok && r.result).toBe(20)
    })

    test('repeated requestAnimationFrame from one call site keeps firing', async () => {
      const r = await evaluate(
        `let count = 0
         for (let i = 0; i < 10; i++) {
           await new Promise(done => requestAnimationFrame(done))
           count++
         }
         return count`,
        { timeout: 3000 },
      )
      expect(r.ok && r.result).toBe(10)
    })

    test('preventTimerLoops: true opts back into the cap (and the loop hangs)', async () => {
      const r = await evaluate(sequential(20), { timeout: 300, preventTimerLoops: true })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe('timeout')
    })

    test("preventTimerLoops accepts happy-dom's per-kind limits object", async () => {
      // Four iterations under a cap of five completes; `true` means a cap of
      // one, and the same four iterations hang.
      const raised = await evaluate(sequential(4), {
        timeout: 2000,
        preventTimerLoops: { timeout: 5 },
      })
      expect(raised.ok && raised.result).toBe(4)

      const capped = await evaluate(sequential(4), { timeout: 300, preventTimerLoops: true })
      expect(capped.ok).toBe(false)
    })

    // The flip's whole safety argument: with no cap, a page that never stops
    // scheduling is bounded by `timeout` alone. A tight self-rescheduling rAF
    // chain is the worst case — it reschedules from inside the frame callback,
    // as fast as happy-dom will let it — and the host timer still wins.
    test('a runaway rAF chain still ends in kind:"timeout", not a hang', async () => {
      const t0 = performance.now()
      const r = await evaluate(
        `const spin = () => requestAnimationFrame(spin)
         spin()
         return await new Promise(() => {})`,
        { timeout: 500 },
      )
      const elapsed = performance.now() - t0
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe('timeout')
      expect(elapsed).toBeGreaterThanOrEqual(500)
      expect(elapsed).toBeLessThan(3000)
    })

    test('a permanent setInterval poller is bounded by timeout too', async () => {
      const r = await evaluate(
        `setInterval(() => { window.__ticks = (window.__ticks ?? 0) + 1 }, 1)
         return await new Promise(() => {})`,
        { timeout: 400 },
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe('timeout')
    })
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
