import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const read = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(root, p), 'utf8'))

describe('packaging', () => {
  // The npm package and the Claude Code plugin are one artifact on one release
  // cadence — plugin.json ships inside the tarball. They're kept in step
  // automatically by the `version` lifecycle script; this catches a drift that
  // got in some other way (a hand-edit, a bad merge) on the next CI run rather
  // than at release time.
  test('plugin.json version tracks package.json version', () => {
    const pkg = read('package.json')
    const plugin = read('.claude-plugin/plugin.json')
    expect(plugin.version).toBe(pkg.version)
  })
})
