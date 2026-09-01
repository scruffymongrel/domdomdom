/**
 * Fixture WebSocket server for the `--bfcache` socket tests.
 *
 * A real socket rather than a stub, for the same reason the HTTP fixtures are
 * real: severing has to work against happy-dom's actual `WebSocket` — whose
 * `readyState` is a private field and whose transport is `ws` — and a mock
 * would assert our own shape into existence rather than that one.
 *
 * It echoes, so a test can prove a severed socket has genuinely stopped
 * delivering rather than merely stopped being listened to.
 */

export interface WsFixture {
  url: string
  stop: () => void
}

export function startWsFixture(): WsFixture {
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response('expected websocket', { status: 426 })),
    websocket: {
      message: (ws, message) => void ws.send(message),
    },
  })

  return {
    url: `ws://127.0.0.1:${server.port}/`,
    stop: () => void server.stop(true),
  }
}
