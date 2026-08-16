// Smoke-tests the package the way users actually get it: `npm pack`, install
// the tarball into a scratch project, run the installed bin.
//
// This exists because scripts/smoke-node.mjs runs cli.ts from the repo
// checkout, and that difference hid a real failure: Node refuses to strip types
// for files under node_modules, so the npm-installed .ts bin threw
// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING under Node while the checkout
// worked fine — broken from v0.1.0 through v0.2.0 with CI green throughout.
//
// The package now ships compiled JS (see scripts/build.mjs), so both runtimes
// must work and both are asserted. `bun pm pack` triggers prepack, so the tarball
// under test is always freshly built rather than whatever dist/ happened to
// contain.
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireNodeOrSkip } from './node-bin.mjs'

const HTML = '<table><tr><td>a</td><td>b</td></tr></table>'
const CODE =
  'return document.evaluate("//td[2]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.textContent'

const dir = mkdtempSync(join(tmpdir(), 'domdomdom-pack-'))
let failed = false

try {
  // bun pm pack, not npm pack: the toolchain shouldn't need Node installed.
  // It runs prepack the same way, so the tarball is always freshly built.
  execSync(`bun pm pack --destination "${dir}"`, { stdio: 'ignore' })
  const tgz = readdirSync(dir).find(f => f.endsWith('.tgz'))
  if (!tgz) throw new Error('bun pm pack produced no tarball')

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch', private: true }))
  execSync(`bun add "${join(dir, tgz)}"`, { cwd: dir, stdio: 'ignore' })

  const bin = join(dir, 'node_modules', 'domdomdom', 'dist', 'cli.js')

  // Node is a target runtime, not a toolchain requirement — skip its half when
  // Node isn't installed. CI always has it, so the gate still holds there.
  const node = requireNodeOrSkip('installed package via node')

  for (const [runtime, argv] of [
    ['bun', ['bun', bin]],
    ...(node ? [['node', [node, bin]]] : []),
  ]) {
    let result
    try {
      const out = execFileSync(argv[0], [...argv.slice(1), '--json', '--html', HTML], {
        input: CODE,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      result = JSON.parse(out).result === 'b' ? 'ok' : `wrong result: ${out.trim()}`
    } catch (e) {
      const msg = `${e.stderr ?? e.message}`
      result = msg.includes('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING')
        ? 'FAILS: Node will not type-strip under node_modules'
        : `FAILS: ${msg.split('\n')[0]}`
    }

    console.log(`installed package via ${runtime}: ${result}`)
    if (result !== 'ok') failed = true
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
