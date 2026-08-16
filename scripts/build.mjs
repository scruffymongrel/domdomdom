// Builds dist/ for publishing.
//
// The package used to ship .ts source directly, which read as a virtue — no
// build step, both runtimes execute it natively — but it never actually worked
// for npm-installed Node users: Node refuses to strip types for files under
// node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the bin threw
// on every run from v0.1.0 through v0.2.0. Compiling to JS fixes that, makes
// the tarball ~3x smaller, and drops engines.node from >=23.6 (a type-stripping
// requirement, not a real one) to >=20, which is happy-dom's own floor.
//
// Contributors are unaffected: everything in the repo is still .ts, and this
// runs at pack/publish time via the `prepack` script.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })

rmSync('dist', { recursive: true, force: true })

// --splitting keeps index's module state in one shared chunk rather than
// inlining a second copy into cli.js. index.ts snapshots host built-ins at
// module load, so two copies would mean two snapshots.
run('bun', [
  'build', './index.ts', './cli.ts',
  '--outdir', 'dist',
  '--target', 'node',
  '--format', 'esm',
  '--splitting',
  // Real dependencies, not bundled — consumers install them from package.json.
  '--external', 'happy-dom',
  '--external', 'wicked-good-xpath',
])

// Types for library consumers, who got them for free back when we shipped .ts.
// bunx, not npx: nothing in the local toolchain should require Node.
run('bunx', ['tsc', '-p', 'tsconfig.build.json'])

// bun build carries the source shebang through verbatim, and cli.ts's is
// tuned for running the .ts directly from a checkout. The built file is plain
// JS, so --experimental-strip-types is meaningless — but keep
// --no-warnings=ExperimentalWarning, or happy-dom's "localStorage is not
// available" warning hits stderr on every single run.
const cli = 'dist/cli.js'
const src = readFileSync(cli, 'utf8')
const shebang = '#!/usr/bin/env -S node --no-warnings=ExperimentalWarning'
writeFileSync(cli, src.replace(/^#![^\n]*/, shebang))

console.log('built dist/')
