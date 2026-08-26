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
// tuned for running the .ts directly from a checkout (node-only, needs
// --experimental-strip-types). The built file is plain JS, so that flag is
// meaningless — but engines declares both node >=20 and bun >=1.3, and a
// plain `#!/usr/bin/env -S node ...` shebang can't honor that: a machine with
// only bun installed (no node) can't execute the bin directly, because the OS
// resolves the shebang's interpreter itself, before bun ever gets a say.
// `bunx`/`bun x` sidestep this (they run the file through Bun's own loader,
// ignoring the shebang entirely) but a direct `bun add -g` + bare invocation
// does not.
//
// This is the standard sh/JS polyglot shebang: `/bin/sh` runs first (its path
// is absolute, so it doesn't depend on PATH), picks whichever runtime is
// actually installed, and re-execs the same file into it. `':' //` is a
// no-op in both languages — sh sees `: //` (the no-op builtin with a
// throwaway arg) then `; exec ...`; JS sees a discarded string literal
// followed by a `//` comment that swallows the rest of the line. Keep
// --no-warnings=ExperimentalWarning for node (silences happy-dom's
// "localStorage is not available" warning); bun ignores unknown flags, so
// passing it unconditionally is harmless there.
const cli = 'dist/cli.js'
const src = readFileSync(cli, 'utf8')
const shebang = [
  '#!/bin/sh',
  '\':\' //; exec "$(command -v bun || command -v node)" --no-warnings=ExperimentalWarning "$0" "$@"',
].join('\n')
writeFileSync(cli, src.replace(/^#![^\n]*/, shebang))

console.log('built dist/')
