// Every test imports its subject from here, so the whole suite can run twice:
// once against the TypeScript source, once against the compiled dist/ that
// users actually install.
//
// Why bother: the suite has only ever exercised the .ts source, while npm ships
// something else. That exact gap is how a broken npm+Node install survived
// three releases with CI green. smoke:pack proves the built binary *runs*; this
// proves it still *behaves* — every assertion, not one smoke assertion.
//
// The specifiers are computed rather than literal so tsc doesn't try to resolve
// dist/, which exists only after a build.
import type { CliIO } from '../cli.ts'

const useDist = process.env.DOMDOMDOM_TEST_DIST === '1'

const index = (await import(
  useDist ? '../dist/index.js' : '../index.ts'
)) as typeof import('../index.ts')

const cli = (await import(
  useDist ? '../dist/cli.js' : '../cli.ts'
)) as typeof import('../cli.ts')

/** 'dist' or 'src' — handy when a failure only reproduces against one target. */
export const TARGET = useDist ? 'dist' : 'src'

export const { evaluate, toCloneable } = index
export const { runCli, runFromProcess, isEntrypoint } = cli
export type { CliIO }
