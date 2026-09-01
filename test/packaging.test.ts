import { test, expect, describe } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const read = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(root, p), 'utf8'))

describe('packaging', () => {
  // The npm package and the Claude Code plugin are one artifact on one release
  // cadence — plugin.json ships inside the tarball. They're kept in step
  // automatically by the `version` lifecycle script; this catches a drift that
  // got in some other way (a hand-edit, a bad merge) on the next CI run rather
  // than at release time.
  test('plugin.json version tracks package.json version', () => {
    const pkg = read('package.json')
    const plugin = read('.claude-plugin/plugin.json')
    expect(plugin.version).toBe(pkg.version)
  })

  // engines.node claims exactly what the shipped shebang actually runs.
  // happy-dom sets the real floor; claiming anything lower would be a lie that
  // only surfaces on a user's machine, and pinning it here means the claim
  // can't drift when happy-dom raises it.
  test('engines.node matches happy-dom’s own floor', () => {
    const pkg = read('package.json') as { engines: Record<string, string> }
    const dep = read('node_modules/happy-dom/package.json') as {
      engines: Record<string, string>
    }
    expect(pkg.engines.node).toBe(dep.engines.node)
    // One runtime story, and it matches the shebang the build writes. Bun and
    // Deno run the built CLI too (smoke:pack proves it), but neither goes
    // through this shebang, so engines must not pretend to guarantee them.
    expect(Object.keys(pkg.engines)).toEqual(['node'])
    expect(readFileSync(resolve(root, 'scripts/build.mjs'), 'utf8')).toContain(
      '#!/usr/bin/env -S node',
    )
  })

  // The floor above is pinned to happy-dom's own package.json, but the docs
  // restate the *number* by hand — and a hand-copied version is exactly what
  // goes stale when the dependency raises its floor. (Rule 1 of "Writing docs
  // in this repo": a claim that can be a test shouldn't be a sentence.)
  test('the docs state the same Node floor as package.json', () => {
    const floor = (read('package.json') as { engines: { node: string } }).engines.node
    for (const doc of ['AGENTS.md', 'README.md']) {
      expect(readFileSync(resolve(root, doc), 'utf8')).toContain(`node ${floor}`)
    }
    // The README's runtime table abbreviates ("Node ≥ 20"), so match the
    // prefix rather than the whole version.
    const abbrev =
      readFileSync(resolve(root, 'README.md'), 'utf8').match(/Node ≥ ([\d.]+)/)?.[1] ?? ''
    expect(abbrev).not.toBe('')
    expect(floor.replace(/^>=/, '').startsWith(abbrev)).toBe(true)
  })

  // `bun run release` is the documented path and the raw `gh workflow run` is
  // the escape hatch, because CI releases origin/main rather than what you
  // have. If the script or the docs go, the invariant goes silently with them.
  test('the release wrapper exists and is what the docs tell you to run', () => {
    const pkg = read('package.json') as { scripts: Record<string, string> }
    expect(pkg.scripts.release).toBe('bun scripts/release.mjs')
    expect(existsSync(resolve(root, 'scripts/release.mjs'))).toBe(true)
    for (const doc of ['AGENTS.md', 'README.md']) {
      expect(readFileSync(resolve(root, doc), 'utf8')).toContain('bun run release patch|minor|major')
    }
  })

  // The README quotes the threshold line verbatim, including the plural keys
  // that are the whole trap (`line`/`function` are silently ignored). A quote
  // that isn't checked is just a claim.
  test('the README quotes bunfig.toml’s coverage threshold verbatim', () => {
    const line = 'coverageThreshold = { lines = 1.0, functions = 1.0 }'
    expect(readFileSync(resolve(root, 'bunfig.toml'), 'utf8')).toContain(line)
    expect(readFileSync(resolve(root, 'README.md'), 'utf8')).toContain(line)
  })

  test('both bin aliases point at the built CLI', () => {
    const pkg = read('package.json') as { bin: Record<string, string> }
    expect(pkg.bin).toEqual({
      domdomdom: 'dist/cli.js',
      ddd: 'dist/cli.js',
    })
  })

  // The plugin cache is a git clone of the built `plugin` branch, which ships
  // the skill and the manifest and no binary, so installing the plugin never
  // puts `domdomdom` on PATH. The skill has to say how to install the CLI or it
  // will tell an agent to run a command that does not exist.
  test('the skill documents how to install the binary', () => {
    const skill = readFileSync(resolve(root, 'skills/domdomdom/SKILL.md'), 'utf8')
    expect(skill).toContain('npm i -g domdomdom')
    expect(skill).toContain('bunx domdomdom')
  })

  // The plugin (skill) and the npm package (binary) install and upgrade
  // independently, so they can drift silently. Both docs need to say how to
  // upgrade each one and how to recognise which one is behind.
  test('the skill documents the plugin/CLI upgrade dance', () => {
    const skill = readFileSync(resolve(root, 'skills/domdomdom/SKILL.md'), 'utf8')
    expect(skill).toContain('/plugin update')
    expect(skill).toContain('npm i -g domdomdom@latest')
  })

  test('the README documents the plugin/CLI upgrade dance', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    expect(readme).toContain('/plugin update')
    expect(readme).toContain('npm i -g domdomdom@latest')
    expect(readme).toMatch(/only \*after\* `npm publish` succeeds/)
  })
})

// The plugin distribution channel — the `plugin` branch — is *built*, not
// fast-forwarded from main. Claude Code runs a dependency install in a plugin
// root that holds both a package.json and a supported lockfile (bun.lock ->
// `bun install --frozen-lockfile --ignore-scripts`), and the old
// `git push origin HEAD:release` shipped both, so every plugin install
// materialised a whole node_modules — for a plugin with no hooks and no MCP
// servers, i.e. nothing that could ever load them. AGENTS.md carries the
// measured size; it moves with the dependency tree, so it is not repeated here.
//
// These tests are the guard on exactly that. If the built tree ever regains a
// package.json or a lockfile, the waste is back and this fails.
describe('plugin channel', () => {
  const script = resolve(root, 'scripts/build-plugin-channel.mjs')
  const expected = ['.claude-plugin/plugin.json', 'LICENSE', 'README.md', 'skills/thing/SKILL.md']
  const LOCKFILES = /(^|\/)(bun\.lock|bun\.lockb|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()

  // A throwaway repo shaped like this one: the four channel paths, plus the dev
  // tree the channel must leave behind.
  const fixture = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-channel-'))
    const write = (path: string, body: string): void => {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), body)
    }
    write('.claude-plugin/plugin.json', '{"name":"thing","version":"9.9.9"}\n')
    write('skills/thing/SKILL.md', '# skill\n')
    write('README.md', '# readme\n')
    write('LICENSE', 'MIT\n')
    write('package.json', '{"name":"thing","version":"9.9.9"}\n')
    write('bun.lock', '{}\n')
    write('AGENTS.md', '# agents\n')
    write('index.ts', 'export {}\n')
    write('tsconfig.json', '{}\n')
    write('test/thing.test.ts', 'export {}\n')
    write('scripts/build.mjs', '// build\n')
    write('.github/workflows/release.yml', 'name: release\n')
    git(dir, 'init', '--quiet', '--initial-branch=main')
    git(dir, 'add', '-A')
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init')
    return dir
  }

  const build = (cwd: string): string =>
    execFileSync('bun', [script], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })

  const withFixture = (fn: (dir: string) => void): void => {
    const dir = fixture()
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('the built tree holds the channel paths and nothing else', () => {
    withFixture(dir => {
      build(dir)
      const files = git(dir, 'ls-tree', '-r', '--name-only', 'plugin').split('\n')
      expect([...files].sort()).toEqual([...expected].sort())
    })
  })

  // Named separately from the exact-tree assertion above because this is the
  // reason the whole script exists: no manifest, no lockfile, no install.
  test('the built tree has no package.json and no lockfile', () => {
    withFixture(dir => {
      build(dir)
      const files = git(dir, 'ls-tree', '-r', '--name-only', 'plugin').split('\n')
      expect(files.filter(f => f === 'package.json' || LOCKFILES.test(f))).toEqual([])
    })
  })

  test('the channel commit names the released version', () => {
    withFixture(dir => {
      build(dir)
      expect(git(dir, 'log', '-1', '--format=%s', 'plugin')).toBe('chore(plugin): v9.9.9')
    })
  })

  test('creates the channel as an orphan when the branch does not exist yet', () => {
    withFixture(dir => {
      build(dir)
      expect(git(dir, 'rev-list', '--count', 'plugin')).toBe('1')
      expect(git(dir, 'log', '-1', '--format=%P', 'plugin')).toBe('')
    })
  })

  test('extends an existing channel, so the push never needs --force', () => {
    withFixture(dir => {
      // The channel as it was before this change: a fast-forward of main.
      const before = git(dir, 'rev-parse', 'HEAD')
      git(dir, 'branch', 'plugin', before)

      build(dir)
      expect(git(dir, 'log', '-1', '--format=%P', 'plugin')).toBe(before)
      // Throws if the old tip isn't an ancestor — i.e. if a push would be rejected.
      git(dir, 'merge-base', '--is-ancestor', before, 'plugin')

      // Rerunnable: a second run is a valid child of the first, same tree.
      const first = git(dir, 'rev-parse', 'plugin')
      build(dir)
      expect(git(dir, 'log', '-1', '--format=%P', 'plugin')).toBe(first)
      expect(git(dir, 'rev-parse', 'plugin^{tree}')).toBe(git(dir, 'rev-parse', `${first}^{tree}`))
    })
  })

  test('the release workflow builds the channel instead of fast-forwarding main', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain('bun scripts/build-plugin-channel.mjs')
    expect(workflow).not.toContain('HEAD:plugin')
    // Still after the publish: the channel must never point at a version that
    // isn't on npm.
    expect(workflow.indexOf('npm publish')).toBeLessThan(workflow.indexOf('build-plugin-channel'))
  })
})
