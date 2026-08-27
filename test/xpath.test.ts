import { test, expect, describe } from 'bun:test'
import { resolve } from 'node:path'
import { evaluate } from '../index.ts'

const fixture = (name: string): string => resolve(import.meta.dir, 'fixtures', name)

// happy-dom doesn't implement window.XPathEvaluator / document.evaluate (the
// DOM Level 3 XPath API). domdomdom polyfills it on every window via
// wicked-good-xpath — see index.ts's installXPath() for the three
// happy-dom-specific adjustments that make it work. This is the gap that
// blocked htmx 4.0.0-beta6 from executing under domdomdom at all
// (see ~/jig/app-jsx/NOTES.md).
describe('xpath', () => {
  test('document.evaluate is available by default (no opt-in)', async () => {
    const r = await evaluate(
      `return {
         evaluate: typeof document.evaluate,
         evaluator: typeof XPathEvaluator,
         // XPathResult is a constructor in browsers too, carrying the type
         // constants as statics — not a plain namespace object.
         result: typeof XPathResult,
         firstOrderedNode: XPathResult.FIRST_ORDERED_NODE_TYPE,
       }`,
      { html: '<p>x</p>' },
    )
    expect(r.ok && r.result).toEqual({
      evaluate: 'function',
      evaluator: 'function',
      result: 'function',
      firstOrderedNode: 9,
    })
  })

  test('document.evaluate("//td[2]", ...) resolves the right node', async () => {
    const r = await evaluate(
      `const result = document.evaluate(
         '//td[2]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null,
       )
       return result.singleNodeValue.textContent`,
      { html: '<table><tr><td>a</td><td>b</td></tr></table>' },
    )
    expect(r.ok && r.result).toBe('b')
  })

  test('createExpression(...).evaluate(node) with omitted type auto-detects (no throw)', async () => {
    // Mirrors htmx 4's exact call shape: `expr.evaluate(contextNode)`, relying
    // on the spec's implicit `type = 0` default rather than passing it.
    const r = await evaluate(
      `const expr = document.createExpression('//td[@data-x]')
       const iter = expr.evaluate(document)
       const nodes = []
       let n
       while ((n = iter.iterateNext())) nodes.push(n.textContent)
       return nodes`,
      { html: '<table><tr><td data-x="1">hit</td><td>miss</td></tr></table>' },
    )
    expect(r.ok && r.result).toEqual(['hit'])
  })

  test('window.XPathEvaluator constructor works standalone (htmx\'s call shape)', async () => {
    const r = await evaluate(
      `const expr = new XPathEvaluator().createExpression('//button[@data-x]')
       const iter = expr.evaluate(document)
       return iter.iterateNext()?.textContent ?? null`,
      { html: '<button data-x="1">go</button>' },
    )
    expect(r.ok && r.result).toBe('go')
  })

  test('XPathEvaluator#evaluate and createNSResolver work directly (full interface, not just createExpression)', async () => {
    const r = await evaluate(
      `const evaluator = new XPathEvaluator()
       const resolver = evaluator.createNSResolver(document)
       const result = evaluator.evaluate(
         '//td[2]', document, resolver, XPathResult.STRING_TYPE, null,
       )
       return result.stringValue`,
      { html: '<table><tr><td>a</td><td>b</td></tr></table>' },
    )
    expect(r.ok && r.result).toBe('b')
  })

  // The polyfill has to be in place before the page's own <script src> tags
  // run, not just before user code — htmx instantiates XPathEvaluator at
  // script-parse time. This probe records availability from inside a page
  // script, so a regression in *when* installXPath() runs fails here with a
  // clearer signal than the htmx boot test below.
  test('XPath is installed before the page\'s own scripts execute', async () => {
    const r = await evaluate('return window.__xpathAtParseTime', {
      source: fixture('xpath-probe-page.html'),
    })
    expect(r.ok && r.result).toEqual({ evaluator: 'function', evaluate: 'function' })
  })

  test('htmx 4.0.0-beta6 boots under domdomdom', async () => {
    const r = await evaluate(
      `return {
         htmx: typeof window.htmx,
         process: typeof window.htmx?.process,
       }`,
      { source: fixture('htmx-page.html'), timeout: 3000 },
    )
    expect(r.ok && r.result).toEqual({ htmx: 'object', process: 'function' })
  })

  // Booting is not the same as working. Every htmx swap whose new content
  // shares an id with the target awaits `htmx.timeout(settleDelay)` — one
  // `setTimeout` call site, hit once per swap. Under happy-dom's
  // `preventTimerLoops` guard the second call from an identical stack returns
  // `{}`: the settle promise never resolves and the request pipeline stops
  // dead, silently. Two swaps issued from the *same* call site (a loop here; a
  // poller or a repeated event handler in the wild) is the shape that hangs, so
  // that is the shape this asserts. See AGENTS.md.
  test('htmx 4 completes two id-matched swaps from one call site', async () => {
    const r = await evaluate(
      `const settled = []
       document.addEventListener('htmx:after:settle', () => {
         settled.push(document.getElementById('target').textContent.trim())
       })
       for (let i = 0; i < 2; i++) {
         await window.htmx.ajax('GET', './htmx-fragment.html', {
           target: '#target',
           swap: 'innerHTML',
         })
       }
       return settled`,
      { source: fixture('htmx-page.html'), timeout: 5000 },
    )
    expect(r.ok && r.result).toEqual(['swapped', 'swapped'])
  })
})
