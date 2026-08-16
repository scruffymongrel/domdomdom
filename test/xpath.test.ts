import { test, expect, describe } from 'bun:test'
import { resolve } from 'node:path'
import { evaluate } from '../index.ts'

const fixture = (name: string): string => resolve(import.meta.dir, 'fixtures', name)

// happy-dom doesn't implement window.XPathEvaluator / document.evaluate (the
// DOM Level 3 XPath API). `xpath: true` polyfills it via wicked-good-xpath —
// see index.ts's installXPath() for the three happy-dom-specific adjustments
// that make it work. This is the gap that blocked htmx 4.0.0-beta6 from
// executing under domdomdom at all (see ~/jig/app-jsx/NOTES.md).
describe('xpath: true', () => {
  test('document.evaluate is undefined without xpath: true', async () => {
    const r = await evaluate('return typeof document.evaluate', {
      html: '<p>x</p>',
    })
    expect(r.ok && r.result).toBe('undefined')
  })

  test('document.evaluate("//td[2]", ...) resolves the right node', async () => {
    const r = await evaluate(
      `const result = document.evaluate(
         '//td[2]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null,
       )
       return result.singleNodeValue.textContent`,
      { html: '<table><tr><td>a</td><td>b</td></tr></table>', xpath: true },
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
      {
        html: '<table><tr><td data-x="1">hit</td><td>miss</td></tr></table>',
        xpath: true,
      },
    )
    expect(r.ok && r.result).toEqual(['hit'])
  })

  test('window.XPathEvaluator constructor works standalone (htmx\'s call shape)', async () => {
    const r = await evaluate(
      `const expr = new XPathEvaluator().createExpression('//button[@data-x]')
       const iter = expr.evaluate(document)
       return iter.iterateNext()?.textContent ?? null`,
      { html: '<button data-x="1">go</button>', xpath: true },
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
      { html: '<table><tr><td>a</td><td>b</td></tr></table>', xpath: true },
    )
    expect(r.ok && r.result).toBe('b')
  })

  test('htmx 4.0.0-beta6 throws ReferenceError without xpath: true (baseline)', async () => {
    const r = await evaluate('return 1', {
      source: fixture('htmx-page.html'),
      timeout: 3000,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('setup')
      expect(r.error.message).toContain('XPathEvaluator is not defined')
    }
  })

  test('htmx 4.0.0-beta6 boots under domdomdom with xpath: true', async () => {
    const r = await evaluate(
      `return {
         htmx: typeof window.htmx,
         process: typeof window.htmx?.process,
       }`,
      { source: fixture('htmx-page.html'), xpath: true, timeout: 3000 },
    )
    expect(r.ok && r.result).toEqual({ htmx: 'object', process: 'function' })
  })
})
