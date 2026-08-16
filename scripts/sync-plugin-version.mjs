// Keeps .claude-plugin/plugin.json's version in step with package.json's.
//
// Wired to the `version` npm lifecycle script, which runs after `npm version`
// has bumped package.json but *before* it commits — so staging the plugin
// manifest here lands it in the same chore(release) commit. That means the two
// versions cannot drift regardless of who cuts the release or how, which is the
// point: they already drifted once (package 0.1.1 vs plugin 0.1.0) because
// keeping them in step was a manual step nobody remembered.
//
// They track deliberately. The plugin and the npm package are the same artifact
// released on the same cadence — plugin.json ships inside the tarball — and the
// skill documents the CLI's behaviour, so a library change can change what the
// plugin promises. A no-op bump on an unrelated patch is a much smaller cost
// than a version that silently means nothing.
import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const path = '.claude-plugin/plugin.json'
const raw = readFileSync(path, 'utf8')
const plugin = JSON.parse(raw)

if (plugin.version === pkg.version) {
  console.log(`plugin.json already at ${pkg.version}`)
  process.exit(0)
}

const before = plugin.version
plugin.version = pkg.version

// Preserve the file's existing shape: 2-space indent, trailing newline.
const trailing = raw.endsWith('\n') ? '\n' : ''
writeFileSync(path, JSON.stringify(plugin, null, 2) + trailing)

console.log(`plugin.json ${before} -> ${pkg.version}`)
