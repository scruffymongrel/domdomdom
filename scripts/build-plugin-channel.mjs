// Builds the Claude Code plugin distribution channel — the `plugin` branch.
//
// The channel used to be a fast-forward of main (`git push origin HEAD:release`),
// which shipped the entire dev tree into every user's plugin cache. That is not
// free: Claude Code runs a dependency install in a plugin's root when it finds
// **both** a package.json and a supported lockfile (bun.lock/bun.lockb ->
// `bun install --frozen-lockfile --ignore-scripts`, package-lock.json/
// npm-shrinkwrap.json -> `npm ci --ignore-scripts`). We shipped both, so every
// install materialised ~46-50MB of node_modules. Those deps exist so a plugin's
// hooks and MCP servers can load them; this plugin ships skills only — no hooks,
// no MCP servers — so all of it was waste.
//
// So the channel is built rather than fast-forwarded: a purpose-built tree with
// exactly the files a skills-only plugin needs, and specifically **no
// package.json at all**. Dropping the manifest, not just the lockfile, is the
// point — with no package.json a future maintainer cannot silently reintroduce
// the install by restoring a lockfile.
//
// The commit is a normal child of the current channel tip, so the branch keeps a
// linear history and the push is an ordinary fast-forward — no force, ever. The
// channel therefore shares no history with main; the commit body records the
// source commit so the two can still be tied together.
//
// Run it, then push:
//
//   bun scripts/build-plugin-channel.mjs
//   git push origin plugin:plugin
//
// `--dry-run` builds the objects and reports them without moving the branch.
import { execFileSync } from 'node:child_process'

const BRANCH = 'plugin'

// Everything the plugin channel ships, and nothing else. `.claude-plugin/` is
// the only file Claude Code actually requires; skills/ is the payload; README
// and LICENSE are what a human landing in the plugin cache needs.
const CHANNEL_PATHS = ['.claude-plugin', 'skills', 'README.md', 'LICENSE']

// A lockfile next to a package.json is what triggers the install. Neither may
// ever appear in the built tree, at any depth.
const FORBIDDEN = new Set([
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
])

const ZERO = '0'.repeat(40)
const dryRun = process.argv.includes('--dry-run')

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd()
const gitStdin = (input, ...args) =>
  execFileSync('git', args, { encoding: 'utf8', input }).trimEnd()
const rev = ref => {
  try {
    return git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
  } catch {
    return null
  }
}
const fail = message => {
  console.error(`build-plugin-channel: ${message}`)
  process.exit(1)
}

const source = git('rev-parse', 'HEAD')

// Build the tree straight out of HEAD's tree with plumbing: no checkout, no
// working-tree mutation, nothing that can pick up a stray untracked file.
const entries = new Map(
  git('ls-tree', source)
    .split('\n')
    .filter(Boolean)
    .map(line => [line.split('\t')[1], line]),
)

const missing = CHANNEL_PATHS.filter(path => !entries.has(path))
if (missing.length) fail(`${source} is missing channel paths: ${missing.join(', ')}`)

const tree = gitStdin(CHANNEL_PATHS.map(path => entries.get(path)).join('\n') + '\n', 'mktree')

// The whole point of this script, asserted against the object it just wrote
// rather than against the intent above.
const files = git('ls-tree', '-r', '--name-only', tree).split('\n').filter(Boolean)
for (const file of files) {
  const [top] = file.split('/')
  if (!CHANNEL_PATHS.includes(top)) fail(`built tree contains an unexpected path: ${file}`)
  if (FORBIDDEN.has(file.split('/').pop())) fail(`built tree contains ${file}`)
}

// Name the released version, matching the chore(release): vX.Y.Z convention.
// Read from the commit rather than the working tree so it is the version that
// was actually released.
const { version } = JSON.parse(git('show', `${source}:package.json`))
if (!version) fail(`${source}:package.json has no version`)

// Parent selection. In CI there is no local `plugin` branch: actions/checkout
// with **fetch-depth: 0** fetches `+refs/heads/*:refs/remotes/origin/*`, so the
// channel tip arrives as refs/remotes/origin/plugin. That depth is load-bearing
// here — a shallow checkout would not fetch the channel at all, this would build
// an orphan, and the push would be rejected as a non-fast-forward. (Rejected, not
// clobbered: nothing here forces, so the failure mode is a red step rather than a
// destroyed channel.)
//
// A rerun within one job leaves a local branch behind, so prefer whichever of the
// two is ahead, and fall back to an orphan where the channel does not exist yet.
const local = rev(`refs/heads/${BRANCH}`)
const remote = rev(`refs/remotes/origin/${BRANCH}`)
let parent = local ?? remote
if (local && remote) {
  const localIsAhead = (() => {
    try {
      git('merge-base', '--is-ancestor', remote, local)
      return true
    } catch {
      return false
    }
  })()
  if (!localIsAhead) {
    console.warn(
      `build-plugin-channel: local ${BRANCH} (${local.slice(0, 12)}) is not a descendant of ` +
        `origin/${BRANCH} (${remote.slice(0, 12)}); building on origin/${BRANCH}`,
    )
    parent = remote
  }
}

// A missing parent on a repo that plainly has a remote is much more likely to be
// a bad checkout than a genuinely new channel, and the difference is invisible
// until the push fails. Say so.
if (!parent) {
  let hasOrigin = true
  try {
    git('remote', 'get-url', 'origin')
  } catch {
    hasOrigin = false
  }
  if (hasOrigin) {
    console.warn(
      `build-plugin-channel: no ${BRANCH} branch and no origin/${BRANCH} — creating the ` +
        'channel from scratch. If the branch does exist on the remote, this checkout did ' +
        'not fetch it (needs fetch-depth: 0) and the push will be rejected.',
    )
  }
}

const message =
  `chore(plugin): v${version}\n\n` +
  `Built from ${source.slice(0, 12)} by scripts/build-plugin-channel.mjs.\n` +
  `Ships ${CHANNEL_PATHS.join(', ')} and nothing\n` +
  `else — no package.json and no lockfile, so installing this plugin never\n` +
  `runs a dependency install.\n`

const commit = gitStdin(
  message,
  'commit-tree',
  tree,
  ...(parent ? ['-p', parent] : []),
  '-F',
  '-',
)

console.log(`source     ${source}`)
console.log(`tree       ${tree}`)
console.log(`parent     ${parent ?? '(none — creating the channel as an orphan)'}`)
console.log(`commit     ${commit}`)
console.log(`files      ${files.length}`)
for (const file of files) console.log(`           ${file}`)

if (dryRun) {
  console.log(`dry run — ${BRANCH} not moved`)
  process.exit(0)
}

// Pass the expected old value so a concurrent writer can't be clobbered.
git('update-ref', `refs/heads/${BRANCH}`, commit, local ?? ZERO)
console.log(`${BRANCH} -> ${commit} (v${version})`)
