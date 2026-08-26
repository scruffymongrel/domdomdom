// Locates the target-runtime binaries for the checks that genuinely need one.
//
// The toolchain runs on Bun — nothing here should require Node or Deno to be
// installed locally. But both are supported *target* runtimes: the shipped bin's
// shebang is node, and Deno runs the same compiled ESM via `deno run -A`. Some
// checks therefore have to actually execute them. Those skip with a notice when
// the runtime is absent, and gate normally where it exists, which is every CI
// runner.
//
// Note this can't use process.execPath: under Bun that's the bun binary.
import { execFileSync } from 'node:child_process'

/** Absolute path to `name` on PATH, or null when it isn't installed. */
export function findRuntime(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

// Returns the runtime's path, or null when the caller should skip.
//
// Skipping is a local-convenience affordance only. Under CI a missing runtime is
// a hard failure: a check that quietly skips is how a broken npm+Node install
// shipped three releases in a row, and "setup-node didn't run" must not look the
// same as "passed".
export function requireRuntimeOrSkip(name, what) {
  const found = findRuntime(name)
  if (found) return found

  if (process.env.CI) {
    console.error(`${what}: no ${name} on PATH and CI is set — refusing to skip silently`)
    process.exit(1)
  }

  console.log(
    `${what}: SKIPPED — no ${name} on PATH (CI gates this; local Bun-only setups don't need it)`,
  )
  return null
}

export const findNode = () => findRuntime('node')
export const requireNodeOrSkip = what => requireRuntimeOrSkip('node', what)
export const requireDenoOrSkip = what => requireRuntimeOrSkip('deno', what)
