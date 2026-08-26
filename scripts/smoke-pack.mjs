// Smoke-tests the package the way users actually get it: pack it, install the
// tarball into a scratch project, run the installed bin.
//
// This exists because scripts/smoke-node.mjs runs cli.ts from the repo
// checkout, and that difference hid a real failure: Node refuses to strip types
// for files under node_modules, so the npm-installed .ts bin threw
// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING under Node while the checkout
// worked fine — broken from v0.1.0 through v0.2.0 with CI green throughout.
//
// The package now ships compiled JS (see scripts/build.mjs), so every runtime we
// claim must work and every one is asserted here: Node, Bun and Deno. `bun pm
// pack` triggers prepack, so the tarball under test is always freshly built
// rather than whatever dist/ happened to contain.
//
// Two passes:
//
//   1. Each runtime invoked explicitly against dist/cli.js. That is what
//      `bunx domdomdom` and `deno run -A npm:domdomdom` do — neither reads the
//      shebang, they hand the file to their own loader.
//   2. The bin aliases (`domdomdom`, `ddd`) executed directly through the
//      node_modules/.bin symlink, with **only Node** on PATH. That is the
//      shebang path, and node-only is the honest scope of it: the shipped
//      shebang is `#!/usr/bin/env -S node`, so a bun-only box with no Node
//      cannot run the installed bin directly. `bunx domdomdom` covers that box,
//      and engines claims node and nothing else for the same reason.
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { requireNodeOrSkip, requireDenoOrSkip } from './runtimes.mjs'

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

  // Node and Deno are target runtimes, not toolchain requirements — skip their
  // halves when they aren't installed. CI has both, so the gate still holds
  // there.
  const node = requireNodeOrSkip('installed package via node')
  const deno = requireDenoOrSkip('installed package via deno')

  for (const [runtime, argv] of [
    ['bun', ['bun', bin]],
    ...(node ? [['node', [node, bin]]] : []),
    // -A because happy-dom reads the page source and may fetch; Deno's default
    // is deny-all, and the documented invocation is `deno run -A`.
    ...(deno ? [['deno', [deno, 'run', '-A', bin]]] : []),
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
        ? 'FAILS: the runtime will not type-strip under node_modules'
        : `FAILS: ${msg.split('\n')[0]}`
    }

    console.log(`installed package via ${runtime}: ${result}`)
    if (result !== 'ok') failed = true
  }

  // Second pass: the *bin aliases* themselves, each invoked the way a package
  // manager's PATH entry invokes them — as the node_modules/.bin symlink,
  // executed directly so the OS reads the shebang, rather than
  // `<runtime> path/to/cli.js`. Node's directory is the only runtime on PATH
  // (plus /usr/bin for `env` itself), so this proves the shebang resolves with
  // no other runtime installed, and that `ddd` reaches the same working bin.
  if (node) {
    for (const name of ['domdomdom', 'ddd']) {
      const binPath = join(dir, 'node_modules', '.bin', name)
      let result
      try {
        const out = execFileSync(binPath, ['--json', '--html', HTML], {
          input: CODE,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: [dirname(node), '/usr/bin', '/bin'].join(':') },
        })
        result = JSON.parse(out).result === 'b' ? 'ok' : `wrong result: ${out.trim()}`
      } catch (e) {
        result = `FAILS: ${(e.stderr ?? e.message).toString().split('\n')[0]}`
      }

      console.log(`bin alias '${name}' via node-only PATH: ${result}`)
      if (result !== 'ok') failed = true
    }
  }

  // The plugin manifest and the skill ship inside the tarball; a `files:` typo
  // would otherwise only be noticed by someone installing the plugin.
  const files = readdirSync(join(dir, 'node_modules', 'domdomdom'))
  const wanted = ['dist', 'skills', '.claude-plugin', 'README.md', 'LICENSE']
  const missing = wanted.filter(f => !files.includes(f))
  console.log(`tarball contents: ${missing.length === 0 ? 'ok' : `missing ${missing.join(', ')}`}`)
  if (missing.length > 0) failed = true
} finally {
  rmSync(dir, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
