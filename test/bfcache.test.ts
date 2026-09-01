/**
 * The back/forward-cache lifecycle: `--bfcache` / `bfcache: true`, plus the
 * `PageTransitionEvent` fix that applies to every run.
 *
 * Two bugs are being held down here, and both used to be silent:
 *
 * 1. happy-dom aliases `PageTransitionEvent` to `Event`, so `persisted` was
 *    dropped by a constructor that accepted it without complaint. Every
 *    `if (event.persisted)` branch in a page was dead code.
 * 2. happy-dom never dispatches `pageshow` at all, so a page whose setup lives
 *    in a pageshow handler never ran it.
 *
 * The socket assertions run against a real WebSocket server, because severing
 * has to work on happy-dom's actual `WebSocket` — whose `readyState` is a
 * private field, and whose dispatch re-enters itself — and a mock would assert
 * our own shape into existence rather than that one.
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { evaluate, runCli, INDEX_PATH, type CliIO } from './subject.ts'
import { startWsFixture, type WsFixture } from './fixtures/ws-server.ts'

let ws: WsFixture
beforeAll(() => {
  ws = startWsFixture()
})
afterAll(() => ws.stop())

/** Page code that records the lifecycle, opens a socket, then restores. */
const socketPage = (restore: string): string => `
  const events = []
  const socket = new WebSocket(${'`'}${'${'}URL}${'`'})
  socket.addEventListener('open', () => events.push('open'))
  socket.addEventListener('message', e => events.push('message:' + e.data))
  socket.addEventListener('error', () => events.push('error'))
  socket.addEventListener('close', e => events.push(\`close:\${e.code}:\${e.wasClean}\`))
  addEventListener('pageshow', e => { if (e.persisted) events.push('pageshow') })
  await new Promise(r => setTimeout(r, 100))
  const report = ${restore}
  return { events, report, readyState: socket.readyState }
`

const withSocket = (restore: string): string =>
  socketPage(restore).replace('${URL}', ws.url)

describe('PageTransitionEvent (applies to every run)', () => {
  // The bug: happy-dom's `PageTransitionEvent = Event` accepts the init and
  // throws away the one field the whole API exists for.
  test('carries persisted instead of dropping it', async () => {
    const r = await evaluate(`
      const e = new PageTransitionEvent('pageshow', { persisted: true })
      return { persisted: e.persisted, present: 'persisted' in e, isEvent: e instanceof Event }
    `)
    expect(r.ok && r.result).toEqual({ persisted: true, present: true, isEvent: true })
  })

  test('persisted defaults to false', async () => {
    const r = await evaluate(`return new PageTransitionEvent('pageshow').persisted`)
    expect(r.ok && r.result).toBe(false)
  })

  test('is no longer the Event constructor itself', async () => {
    const r = await evaluate('return PageTransitionEvent === Event')
    expect(r.ok && r.result).toBe(false)
  })
})

describe('initial pageshow (applies to every run)', () => {
  // A page that does its setup inside a pageshow handler used to never set up.
  test('fires once after load, with persisted false', async () => {
    const r = await evaluate('return window.__seen', {
      html: `<script>
        window.__seen = []
        addEventListener('pageshow', e => window.__seen.push(e.persisted))
      </script>`,
    })
    expect(r.ok && r.result).toEqual([false])
  })

  // The documented trap: user code runs *after* load, so the load's pageshow is
  // already gone by then. Both shipped docs show the listener registered inside
  // the page for exactly this reason, and an example that promised
  // [false, true] from user code shipped once before being caught by running
  // the published package.
  test('a listener registered in user code sees only the restore', async () => {
    const r = await evaluate(
      `const seen = []
       addEventListener('pageshow', e => seen.push(e.persisted))
       await __bfcache.restore()
       return seen`,
      { bfcache: true },
    )
    expect(r.ok && r.result).toEqual([true])
  })

  test('a listener registered by the page sees the load and the restore', async () => {
    const r = await evaluate('await __bfcache.restore(); return window.seen', {
      bfcache: true,
      html: `<script>window.seen = []; addEventListener('pageshow', e => seen.push(e.persisted))</script>`,
    })
    expect(r.ok && r.result).toEqual([false, true])
  })

  test('a throwing pageshow handler is reported, not turned into a setup error', async () => {
    const r = await evaluate('return 1', {
      html: `<script>addEventListener('pageshow', () => { throw new Error('nope') })</script>`,
    })
    expect(r.ok && r.result).toBe(1)
  })
})

describe('__bfcache installation', () => {
  test('absent unless asked for', async () => {
    const r = await evaluate('return typeof window.__bfcache')
    expect(r.ok && r.result).toBe('undefined')
  })

  test('present with bfcache: true', async () => {
    const r = await evaluate(
      `return Object.keys(window.__bfcache).sort()`,
      { bfcache: true },
    )
    expect(r.ok && r.result).toEqual(['deliverCloses', 'hide', 'restore', 'sever', 'show'])
  })
})

describe('restore choreography', () => {
  test('fires the full sequence in browser order', async () => {
    const r = await evaluate(
      `
      const order = []
      addEventListener('pagehide', e => order.push('pagehide:' + e.persisted))
      addEventListener('pageshow', e => order.push('pageshow:' + e.persisted))
      document.addEventListener('freeze', () => order.push('freeze'))
      document.addEventListener('resume', () => order.push('resume'))
      document.addEventListener('visibilitychange', () =>
        order.push(\`vis:\${document.visibilityState}:\${document.hidden}\`))
      await __bfcache.restore()
      return order
    `,
      { bfcache: true },
    )
    expect(r.ok && r.result).toEqual([
      'vis:hidden:true',
      'pagehide:true',
      'freeze',
      'resume',
      'pageshow:true',
      'vis:visible:false',
    ])
  })

  // visibilityState and `hidden` are separate getters in happy-dom; moving one
  // without the other leaves the page reading a contradiction.
  test('visibilityState and hidden move together', async () => {
    const r = await evaluate(
      `
      __bfcache.hide()
      const frozen = [document.visibilityState, document.hidden]
      __bfcache.show()
      return { frozen, live: [document.visibilityState, document.hidden] }
    `,
      { bfcache: true },
    )
    expect(r.ok && r.result).toEqual({ frozen: ['hidden', true], live: ['visible', false] })
  })
})

describe('socket severing', () => {
  // The three orderings a real restore can produce and a real browser will
  // never let you pick between.
  test("sockets: 'before' — the stale close lands ahead of pageshow", async () => {
    const r = await evaluate(withSocket(`await __bfcache.restore()`), { bfcache: true })
    expect(r.ok && (r.result as any).events).toEqual(['open', 'close:1006:false', 'pageshow'])
    expect(r.ok && (r.result as any).report).toEqual({ severed: 1, delivered: 1 })
  })

  test("sockets: 'after' — the stale close lands behind pageshow", async () => {
    const r = await evaluate(withSocket(`await __bfcache.restore({ sockets: 'after' })`), {
      bfcache: true,
    })
    expect(r.ok && (r.result as any).events).toEqual(['open', 'pageshow', 'close:1006:false'])
  })

  test("sockets: 'never' — the close is never delivered at all", async () => {
    const r = await evaluate(withSocket(`await __bfcache.restore({ sockets: 'never' })`), {
      bfcache: true,
    })
    expect(r.ok && (r.result as any).events).toEqual(['open', 'pageshow'])
    expect(r.ok && (r.result as any).report).toEqual({ severed: 1, delivered: 0 })
  })

  test("sockets: 'never' plus deliverCloses() — the caller picks the moment", async () => {
    const r = await evaluate(
      withSocket(`await __bfcache.restore({ sockets: 'never' })`).replace(
        'return {',
        `events.push('gap'); const late = __bfcache.deliverCloses(); return { late,`,
      ),
      { bfcache: true },
    )
    expect(r.ok && (r.result as any).late).toBe(1)
    expect(r.ok && (r.result as any).events).toEqual([
      'open',
      'pageshow',
      'gap',
      'close:1006:false',
    ])
  })

  test("sockets: 'keep' — the socket survives and still echoes", async () => {
    const r = await evaluate(
      withSocket(`await __bfcache.restore({ sockets: 'keep' })`).replace(
        'return {',
        `socket.send('ping'); await new Promise(r => setTimeout(r, 100)); return {`,
      ),
      { bfcache: true },
    )
    expect(r.ok && (r.result as any).events).toContain('message:ping')
    expect(r.ok && (r.result as any).report).toEqual({ severed: 0, delivered: 0 })
    expect(r.ok && (r.result as any).readyState).toBe(1)
  })

  // The dirty shape is the point: reconnect logic keys off the close code, and
  // a page-initiated close() produces the polite 1000 that never actually
  // occurs when a frozen page's connection dies.
  test('the close is 1006 / not clean, never a polite 1000', async () => {
    const r = await evaluate(withSocket(`await __bfcache.restore()`), { bfcache: true })
    const events = (r.ok && (r.result as any).events) as string[]
    expect(events).toContain('close:1006:false')
    expect(events.some(e => e.startsWith('close:1000'))).toBe(false)
  })

  test("error is opt-in and precedes the close when asked for", async () => {
    const r = await evaluate(
      withSocket(`await __bfcache.restore({ error: true })`),
      { bfcache: true },
    )
    expect(r.ok && (r.result as any).events).toEqual([
      'open',
      'error',
      'close:1006:false',
      'pageshow',
    ])
  })

  test('a severed socket reads CLOSED, discards sends and delivers nothing further', async () => {
    const r = await evaluate(
      withSocket(`__bfcache.sever()`).replace(
        'return {',
        `socket.send('swallowed')
         socket.dispatchEvent(new MessageEvent('message', { data: 'ghost' }))
         return {`,
      ),
      { bfcache: true },
    )
    expect(r.ok && (r.result as any).readyState).toBe(3)
    expect(r.ok && (r.result as any).report).toBe(1)
    // No 'message:ghost', and the send neither threw nor reached the server.
    expect(r.ok && (r.result as any).events).toEqual(['open'])
  })

  test('severing an already-closed socket is a no-op', async () => {
    const r = await evaluate(
      withSocket(`__bfcache.sever()`).replace(
        'return {',
        `const second = __bfcache.sever(); return { second,`,
      ),
      { bfcache: true },
    )
    expect(r.ok && (r.result as any).second).toBe(0)
  })

  test('a page that swaps in its own WebSocket opts out, and sever() says so', async () => {
    const r = await evaluate(
      `window.WebSocket = function () {}
       const before = new WebSocket('ws://example.invalid')
       return __bfcache.sever()`,
      { bfcache: true },
    )
    expect(r.ok && r.result).toBe(0)
  })

  // A severed socket must actually tear its transport down. An abandoned one
  // holds a live TCP connection, and with it the host event loop — the same
  // never-exits failure the evaluate() race guards against.
  test('severing releases the transport and lets the process exit', async () => {
    const child = Bun.spawn(
      [
        'bun',
        '-e',
        `import { evaluate } from '${INDEX_PATH}'
         const r = await evaluate(\`
           const s = new WebSocket('${ws.url}')
           await new Promise(r => setTimeout(r, 100))
           return __bfcache.restore()
         \`, { bfcache: true })
         console.log('returned', JSON.stringify(r.ok && r.result))`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const exited = await Promise.race([
      child.exited,
      new Promise<'HUNG'>(r => setTimeout(() => r('HUNG'), 8000)),
    ])
    if (exited === 'HUNG') child.kill()
    expect(exited).toBe(0)
    expect(await new Response(child.stdout).text()).toContain('"severed":1')
  }, 15000)
})

describe('--bfcache flag', () => {
  async function* fromString(s: string): AsyncIterable<Buffer> {
    if (s) yield Buffer.from(s, 'utf8')
  }

  async function invoke(argv: string[], stdin: string): Promise<any> {
    let stdout = ''
    const io: CliIO = {
      argv,
      stdin: fromString(stdin),
      stdout: { write: (s: string) => { stdout += s; return true } },
      stderr: { write: () => true },
    }
    await runCli(io)
    return JSON.parse(stdout)
  }

  test('installs the helper', async () => {
    const out = await invoke(['--bfcache', '--json'], 'return typeof __bfcache.restore')
    expect(out.result).toBe('function')
  })

  test('omitting it leaves the page clean', async () => {
    const out = await invoke(['--json'], 'return typeof window.__bfcache')
    expect(out.result).toBe('undefined')
  })

  test('help documents it', async () => {
    let stdout = ''
    await runCli({
      argv: ['--help'],
      stdin: fromString(''),
      stdout: { write: (s: string) => { stdout += s; return true } },
      stderr: { write: () => true },
    })
    expect(stdout).toContain('--bfcache')
    expect(stdout).toContain("sockets: 'after'")
  })
})
