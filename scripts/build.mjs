// Builds dist/ for publishing.
//
// The package used to ship .ts source directly, which read as a virtue — no
// build step, both runtimes execute it natively — but it never actually worked
// for npm-installed Node users: Node refuses to strip types for files under
// node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the bin threw
// on every run from v0.1.0 through v0.2.0. Compiling to JS fixes that, makes
// the tarball ~3x smaller, and drops engines.node from >=23.6 (a type-stripping
// requirement, not a real one) to >=20.0.0, which is happy-dom's own floor. It
// is also what buys Deno support: Deno runs the compiled ESM fine and would
// refuse the .ts for the same node_modules reason Node does.
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

// bun build carries the source shebang through verbatim, and cli.ts's is tuned
// for running the .ts directly from a checkout (node, --experimental-strip-
// types). The built file is plain JS, so that flag is meaningless here.
//
// The shebang says node and nothing else, matching engines. A previous build
// wrote an sh/JS polyglot that re-exec'd into `command -v bun || command -v
// node`, so a bun-only machine could run the bin directly — but the cost was
// nondeterminism: the same tarball, invoked the same way, ran under Bun on a
// machine with both runtimes and under Node on a node-only one, silently. One
// shebang, one runtime, one thing to debug.
//
// The other two runtimes are still supported, they just don't go through the
// shebang: `bunx domdomdom` runs the file through Bun's own loader, and Deno
// generates its own `#!/bin/sh` shim that execs `deno run npm:domdomdom` (it
// never reads this line at all). scripts/smoke-pack.mjs gates all three.
//
// --no-warnings=ExperimentalWarning is load-bearing, not a leftover from the
// .ts-shipping era: index.ts snapshots the host realm by enumerating and
// *reading* every globalThis property, which trips Node's lazy localStorage
// getter and prints "ExperimentalWarning: localStorage is not available" to
// stderr on every run. stderr is part of the output contract (it carries
// captured console.*), so that has to stay quiet. Verified by removing the flag
// under Node 26.3.0 and watching the warning appear.
const cli = 'dist/cli.js'
const src = readFileSync(cli, 'utf8')
writeFileSync(
  cli,
  src.replace(/^#![^\n]*/, '#!/usr/bin/env -S node --no-warnings=ExperimentalWarning'),
)

console.log('built dist/')
