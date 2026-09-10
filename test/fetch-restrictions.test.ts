/**
 * happy-dom's `Response`/`Headers` skip the Fetch spec's reject-on-malformed-
 * input branches — construction succeeds where a real browser throws. ddd
 * takes these classes from happy-dom wholesale (see AGENTS.md, "The shared
 * surface with browsebrowsebrowse") and adds no validation of its own, so the
 * gap is happy-dom's, not ddd's — and it's out of scope for ddd to shim, per
 * the same section.
 *
 * These tests pin the *current, non-conforming* behavior on purpose — they are
 * not testing that ddd is correct, they're testing that this known gap hasn't
 * silently changed shape. If one of them starts failing, happy-dom has started
 * enforcing that restriction. That's a welcome failure: update this file and
 * the "Restrictions ddd doesn't enforce" section of skills/domdomdom/SKILL.md
 * to match, rather than "fixing" the test back to green.
 *
 * Reported by a consumer, 2026-09-09, against ddd 0.6.1 / happy-dom 20.9.0;
 * reproduced against real Chrome via `bbb` at the same date, which throws in
 * every case below except the control.
 */
import { test, expect, describe } from 'bun:test'
import { evaluate } from './subject.ts'

describe('Fetch restrictions happy-dom does not enforce (pinned, not desired)', () => {
  // Fetch spec: a Response with status 204, 205 or 304 must not have a body.
  // 101 gets there for a different reason — it fails the status-range check
  // below before the null-body check is ever reached — but the net effect
  // (construction should fail) is the same, so it's included here too.
  for (const status of [101, 204, 205, 304]) {
    test(`Response with status ${status} and a body does not throw`, async () => {
      const r = await evaluate(
        `try { new Response('x', {status:${status}}); return 'NO THROW' } catch(e) { return 'THREW' }`,
      )
      expect(r.ok && r.result).toBe('NO THROW')
    })
  }

  // Fetch spec: Response status must be in [200, 599].
  for (const status of [199, 600]) {
    test(`Response status ${status} outside [200,599] does not throw`, async () => {
      const r = await evaluate(
        `try { new Response('x', {status:${status}}); return 'NO THROW' } catch(e) { return 'THREW' }`,
      )
      expect(r.ok && r.result).toBe('NO THROW')
    })
  }

  test('Headers.set() with a syntactically invalid name does not throw', async () => {
    const r = await evaluate(`
      try {
        const h = new Headers()
        h.set('bad header', 'x')
        return 'NO THROW, val=' + h.get('bad header')
      } catch (e) { return 'THREW' }
    `)
    expect(r.ok && r.result).toBe('NO THROW, val=x')
  })

  // Control: this restriction IS enforced today, on both ddd and real Chrome
  // (different exception type — DOMException here, TypeError in Chrome). If
  // this one ever flips to "NO THROW", something changed upstream in how
  // happy-dom handles Request construction generally, not just these gaps.
  test('Request GET with a body still throws (control)', async () => {
    const r = await evaluate(`
      try {
        new Request('http://x/', {method:'GET', body:'x'})
        return 'NO THROW'
      } catch (e) { return 'THREW: ' + e.constructor.name }
    `)
    expect(r.ok && r.result).toBe('THREW: DOMException')
  })
})
