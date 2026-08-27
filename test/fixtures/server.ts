/**
 * Fixture HTTP server for the status / `--fail` tests.
 *
 * Real sockets rather than a mocked fetch: the thing under test is what
 * happy-dom's `page.goto()` reports back after it has actually spoken HTTP,
 * including the status *after* a redirect chain — which a stub of the fetch
 * layer would simply assert into existence.
 *
 * Every route here is exercised by `test/http.test.ts`; nothing in this file is
 * dead, so it does not drag the coverage gate down.
 */

export interface Fixtures {
  url: (path: string) => string
  stop: () => void
}

const page = (title: string): Response =>
  new Response(`<!doctype html><title>${title}</title><body><h1>${title}</h1></body>`, {
    status: title === 'not found' ? 404 : title === 'boom' ? 500 : 200,
    headers: { 'content-type': 'text/html' },
  })

export function startFixtures(): Fixtures {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname === '/404') return page('not found')
      if (pathname === '/500') return page('boom')
      // A 302 into a 200. `status` must report the destination's status, not
      // the redirect's — otherwise every redirected page looks like a failure.
      if (pathname === '/redirect') {
        return new Response(null, { status: 302, headers: { location: '/' } })
      }
      // A redirect that lands on a 404: the final status is the one that counts.
      if (pathname === '/redirect-to-404') {
        return new Response(null, { status: 302, headers: { location: '/404' } })
      }
      return page('ok')
    },
  })

  return {
    url: (path: string) => `http://127.0.0.1:${server.port}${path}`,
    stop: () => void server.stop(true),
  }
}
