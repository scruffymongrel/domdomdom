// The release wrapper: `bun run release <patch|minor|major>`.
//
// .github/workflows/release.yml already makes the *remote* half of a release
// atomic — quality gate, bump, commit, tag, push, publish, plugin channel, one
// sequence or none of it. This closes the local half, which was never atomic at
// all. Two silent failures, both observed:
//
//   1. **Local main falls behind.** `gh workflow run` returns the moment the
//      dispatch is accepted, and nothing pulls back the chore(release) commit
//      CI creates. The next agent to open the repo builds on a stale base and
//      misreports the version. Three times in one session; caught each time
//      only because somebody happened to rebase.
//   2. **CI releases origin/main, not what you have.** If local is behind you
//      publish a commit you never ran. If local is ahead — unpushed work — you
//      publish without it. Neither says anything at the time.
//
// Guard 3 is the whole point: local main and origin/main byte-identical, or
// nothing happens. Everything else here is convenience — trigger, watch, pull,
// print. All three guards run before the first `gh` call, so a refusal costs
// nothing and can be exercised safely in a throwaway clone.
//
// Escape hatch: `gh workflow run release.yml -f bump=<bump>` still works and is
// the right move when this script is in the way (a re-run after a flaky CI
// step, a release from a machine without the checkout in the state it wants).
// It just makes the pull-back and the pre-flight comparison yours to remember,
// which is the failure this exists to remove.
//
// Dependency-free on purpose — node:child_process and `gh`, like every other
// script in here.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const WORKFLOW = 'release.yml'
const BUMPS = ['patch', 'minor', 'major']

// The run does not appear in `gh run list` the instant the dispatch is
// accepted; a few seconds is normal, and a busy Actions queue is slower.
const APPEAR_TIMEOUT_MS = 3 * 60_000
const APPEAR_POLL_MS = 3_000
// The whole release job — install, quality gate, dist build, the tarball smoke
// test across three runtimes, and whatever else release.yml gates.
const RUN_TIMEOUT_MS = 60 * 60_000
const RUN_POLL_MS = 10_000

const sleep = ms => new Promise(r => setTimeout(r, ms))

const die = (...lines) => {
  console.error(lines.join('\n'))
  process.exit(1)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd()
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trimEnd()
const ghJson = (...args) => JSON.parse(gh(...args))

const pkgVersion = () => JSON.parse(readFileSync('package.json', 'utf8')).version
const pkgName = () => JSON.parse(readFileSync('package.json', 'utf8')).name

// ---------------------------------------------------------------------------
// Argument
// ---------------------------------------------------------------------------

const bump = process.argv[2]

if (!BUMPS.includes(bump) || process.argv.length > 3) {
  die(
    `usage: bun run release <${BUMPS.join('|')}>`,
    '',
    'Refuses unless local main and origin/main are identical, then triggers',
    `${WORKFLOW}, waits for it, and pulls the release commit back.`,
  )
}

// ---------------------------------------------------------------------------
// Guards. Nothing below here talks to GitHub until all three have passed.
// ---------------------------------------------------------------------------

// 1. On main. The workflow refuses to release from anywhere else anyway, but it
//    refuses *after* the dispatch, in a log nobody is watching.
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') {
  die(
    `refusing: on branch '${branch}', not 'main'.`,
    'Releases run from main only. Land your work there first.',
  )
}

// Fetch before comparing, or every comparison below is against whatever
// origin/main happened to be the last time someone fetched.
console.log('fetching origin/main…')
try {
  execFileSync('git', ['fetch', 'origin', 'main'], { stdio: ['ignore', 'ignore', 'inherit'] })
} catch {
  die('refusing: `git fetch origin main` failed. Fix the remote, then retry.')
}

// 2. Clean tree. CI releases what is committed and pushed; anything else in the
//    working tree is work that will not be in the release, silently.
const dirty = git('status', '--porcelain')
if (dirty) {
  const lines = dirty.split('\n')
  const onlyUntracked = lines.every(l => l.startsWith('??'))
  die(
    onlyUntracked
      ? 'refusing: the working tree has untracked files.'
      : 'refusing: the working tree has uncommitted changes.',
    '',
    ...lines.map(l => `  ${l}`),
    '',
    onlyUntracked
      ? 'Untracked files are not in the release either, and nothing gitignored\n' +
        'shows up here — so this is real work that would be left out silently.\n' +
        'Commit and push it, or remove it.'
      : 'CI releases what is on origin/main. Commit and push, or stash.',
  )
}

// 3. The one that matters. `--left-right --count origin/main...main` gives
//    "<commits only on origin/main>\t<commits only on main>" — behind, ahead.
const [behind, ahead] = git('rev-list', '--left-right', '--count', 'origin/main...main')
  .split(/\s+/)
  .map(Number)

if (behind > 0 && ahead > 0) {
  die(
    `refusing: main has diverged from origin/main (${behind} behind, ${ahead} ahead).`,
    'CI would release origin/main — a tree that is neither what you have nor',
    'what you meant. Reconcile first:  git pull --rebase origin main',
  )
}
if (behind > 0) {
  die(
    `refusing: main is ${behind} commit(s) behind origin/main.`,
    'CI releases origin/main, so you would publish commits you never ran',
    '(and this is exactly how a stale local base goes unnoticed). Run:',
    '  git pull --ff-only origin main',
  )
}
if (ahead > 0) {
  die(
    `refusing: main is ${ahead} commit(s) ahead of origin/main.`,
    'CI releases origin/main, so your unpushed work would not be in the',
    'release — and nothing would say so. Run:',
    '  git push origin main',
  )
}

const head = git('rev-parse', '--short', 'HEAD')
const before = pkgVersion()
console.log(`main and origin/main agree at ${head}; releasing ${pkgName()}@${before} (${bump})`)

// ---------------------------------------------------------------------------
// Trigger, and find the run we triggered
// ---------------------------------------------------------------------------

// Capture the newest run id *first*. `gh run list` right after a dispatch will
// happily hand back the previous release's run, and watching that one reports a
// success that has nothing to do with this release.
const newestRunId = () => {
  const runs = ghJson('run', 'list', '--workflow', WORKFLOW, '--limit', '1', '--json', 'databaseId')
  return runs.length > 0 ? runs[0].databaseId : 0
}

let baseline
try {
  baseline = newestRunId()
} catch {
  die('refusing: could not list workflow runs. Is `gh` authenticated (`gh auth status`)?')
}

try {
  gh('workflow', 'run', WORKFLOW, '-f', `bump=${bump}`)
} catch (e) {
  die(`failed to dispatch ${WORKFLOW}:`, `${e.stderr ?? e.message}`.trimEnd())
}
console.log(`dispatched ${WORKFLOW} (bump=${bump}); waiting for the run to appear…`)

let run
const appearBy = Date.now() + APPEAR_TIMEOUT_MS
while (!run) {
  await sleep(APPEAR_POLL_MS)
  const runs = ghJson(
    'run', 'list', '--workflow', WORKFLOW, '--limit', '10',
    '--json', 'databaseId,status,conclusion,url',
  )
  // Ids increase, so anything above the baseline is newer than our dispatch.
  // Take the oldest of those: ours is the first new run, not the last.
  run = runs.filter(r => r.databaseId > baseline).sort((a, b) => a.databaseId - b.databaseId)[0]
  if (!run && Date.now() > appearBy) {
    die(
      `no new ${WORKFLOW} run appeared within ${APPEAR_TIMEOUT_MS / 1000}s.`,
      'The dispatch may still be queued. Check `gh run list --workflow=release.yml`',
      'before dispatching again — a second release would double-bump.',
    )
  }
}

console.log(`run ${run.databaseId}: ${run.url}`)

// ---------------------------------------------------------------------------
// Wait
// ---------------------------------------------------------------------------

let status = ''
const finishBy = Date.now() + RUN_TIMEOUT_MS
let final = run

while (final.status !== 'completed') {
  if (final.status !== status) {
    status = final.status
    console.log(`  ${status}…`)
  }
  if (Date.now() > finishBy) {
    die(
      `gave up waiting after ${RUN_TIMEOUT_MS / 60_000} minutes; the run is still ${final.status}.`,
      `Watch it: gh run watch ${run.databaseId}`,
      'Not pulling — check what CI actually did before touching local main.',
    )
  }
  await sleep(RUN_POLL_MS)
  final = ghJson('run', 'view', String(run.databaseId), '--json', 'status,conclusion,url')
}

if (final.conclusion !== 'success') {
  die(
    `release run ${final.conclusion}: ${run.url}`,
    'Not pulling. Nothing was published unless the log says otherwise — but note',
    'the workflow pushes the bump commit *before* publishing, so a failure at the',
    'publish step can still leave a new commit and tag on origin/main.',
    `Read the log first: gh run view ${run.databaseId} --log-failed`,
  )
}

console.log('run succeeded; pulling the release commit back')

// ---------------------------------------------------------------------------
// Pull, and report
// ---------------------------------------------------------------------------

// The reason this script exists. --ff-only, never a merge: if it can't fast
// forward, someone pushed while CI was running and that needs a human, not a
// merge commit invented here.
try {
  execFileSync('git', ['pull', '--ff-only', 'origin', 'main'], { stdio: 'inherit' })
} catch {
  die(
    '',
    'PUBLISHED, BUT THE PULL FAILED.',
    '',
    `${pkgName()} was released — the run succeeded — but local main could not`,
    'fast-forward, so someone pushed to origin/main while CI was running.',
    'Local main is now stale, which is the exact state this wrapper exists to',
    'prevent. Reconcile before doing anything else:',
    '  git pull --rebase origin main',
  )
}

const after = pkgVersion()
if (after === before) {
  die(
    `the run succeeded but package.json is still ${after}.`,
    'The pull was a no-op, so the release commit is not here. Check',
    `${run.url} and \`git log origin/main\` before releasing again.`,
  )
}

console.log('')
console.log(`published ${pkgName()}@${after}`)
console.log(`https://www.npmjs.com/package/${pkgName()}/v/${after}`)
