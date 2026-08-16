// Smoke-tests the package the way users actually get it: `npm pack`, install
// the tarball into a scratch project, run the installed bin.
//
// This exists because scripts/smoke-node.mjs runs cli.ts from the repo
// checkout, and that difference hides a real failure — Node refuses to strip
// types for files under node_modules, so an npm-installed domdomdom throws
// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING under Node while the checkout
// works fine. Testing the checkout gave false confidence through v0.1.0,
// v0.1.1 and v0.2.0.
//
// Bun strips types anywhere, so it runs the installed package happily. Both
// runtimes are asserted separately below: Bun is expected to pass, and Node is
// reported rather than asserted until the packaging question is settled.
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HTML = '<table><tr><td>a</td><td>b</td></tr></table>'
const CODE =
  'return document.evaluate("//td[2]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.textContent'

const dir = mkdtempSync(join(tmpdir(), 'domdomdom-pack-'))
let failed = false

try {
  const packed = JSON.parse(execSync('npm pack --json', { encoding: 'utf8' }))[0].filename
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch', private: true }))
  execSync(`npm i "${process.cwd()}/${packed}" --silent --no-audit --no-fund`, { cwd: dir })
  rmSync(packed, { force: true })

  const bin = join(dir, 'node_modules', 'domdomdom', 'cli.ts')

  for (const [runtime, argv] of [
    ['bun', ['bun', bin]],
    ['node', [process.execPath, '--experimental-strip-types', '--no-warnings=ExperimentalWarning', bin]],
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
    // Bun is the runtime the published .ts package genuinely supports, so only
    // that one gates the build. Node is printed for visibility; flip this to a
    // hard failure once the package ships something Node can execute.
    if (runtime === 'bun' && result !== 'ok') failed = true
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
  for (const f of readdirSync('.')) if (f.startsWith('domdomdom-') && f.endsWith('.tgz')) rmSync(f)
}

process.exit(failed ? 1 : 0)
