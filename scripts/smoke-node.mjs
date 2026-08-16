// Smoke-tests the shipped CLI under Node. The bun:test suite can't do this —
// it imports `bun:test` — yet Node is a supported runtime (engines.node
// >=23.6) and the bin is a .ts file run through --experimental-strip-types.
//
// This exercises the parts most likely to break there specifically: type
// stripping on the bin, happy-dom under Node, and wicked-good-xpath — a 2016
// CommonJS package whose dist ends in `.call(global)` — resolving through Node
// ESM. htmx booting is a good single assertion for all of it, since it needs
// the XPath polyfill installed before script extraction runs the page's own
// script tag.
//
// KNOWN GAP — this runs cli.ts from the repo checkout, which is NOT how users
// get it. Node refuses to strip types for files under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so `npm i domdomdom` followed
// by running it under Node fails even though this passes. See
// scripts/smoke-pack.mjs, which installs the packed tarball and catches that
// class of bug; this file only covers the checkout path.
import { execFileSync } from 'node:child_process'

const out = execFileSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--no-warnings=ExperimentalWarning',
    'cli.ts',
    '--json',
    'test/fixtures/htmx-page.html',
  ],
  { input: 'return typeof window.htmx', encoding: 'utf8' },
)

let parsed
try {
  parsed = JSON.parse(out)
} catch {
  console.error(`node smoke: CLI did not emit JSON\n${out}`)
  process.exit(1)
}

if (!parsed.ok || parsed.result !== 'object') {
  console.error(`node smoke: expected htmx to boot, got ${JSON.stringify(parsed)}`)
  process.exit(1)
}

console.log(`node smoke ok (${process.version})`)
