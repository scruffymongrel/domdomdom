// Locates a Node binary for the checks that genuinely need one.
//
// The toolchain runs on Bun — nothing here should require Node to be installed
// locally. But Node is a supported *target* runtime, so some checks have to
// actually execute it. Those skip with a notice when Node is absent and gate
// normally where it exists, which is every CI runner.
//
// Note this can't use process.execPath: under Bun that's the bun binary.
import { execFileSync } from 'node:child_process'

export function findNode() {
  try {
    const path = execFileSync('which', ['node'], { encoding: 'utf8' }).trim()
    return path || null
  } catch {
    return null
  }
}

// Returns a Node path, or null when the caller should skip.
//
// Skipping is a local-convenience affordance only. Under CI a missing Node is a
// hard failure: a check that quietly skips is how a broken npm+Node install
// shipped three releases in a row, and "setup-node didn't run" must not look
// the same as "passed".
export function requireNodeOrSkip(what) {
  const node = findNode()
  if (node) return node

  if (process.env.CI) {
    console.error(`${what}: no node on PATH and CI is set — refusing to skip silently`)
    process.exit(1)
  }

  console.log(`${what}: SKIPPED — no node on PATH (CI gates this; local Bun-only setups don't need it)`)
  return null
}
