import { test, expect, describe } from 'bun:test'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const ENTRY = resolve(ROOT, 'cli.ts')

interface CliResult {
  exit: number
  stdout: string
  stderr: string
}

function runCli(args: string[], stdin = ''): Promise<CliResult> {
  return new Promise((res, rej) => {
    const p = spawn('bun', [ENTRY, ...args], { cwd: ROOT })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', d => { stdout += d.toString() })
    p.stderr.on('data', d => { stderr += d.toString() })
    p.on('error', rej)
    p.on('close', exit => res({ exit: exit ?? -1, stdout, stderr }))
    if (stdin) p.stdin.write(stdin)
    p.stdin.end()
  })
}

describe('CLI', () => {
  test('expression auto-returns', async () => {
    const r = await runCli([], '1 + 2')
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('3')
  })

  test('multi-statement requires explicit return', async () => {
    const r = await runCli([], 'const x = 1; const y = 2; return x + y')
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('3')
  })

  test('--html source works', async () => {
    const r = await runCli(['--html', '<title>hi</title>'], 'return document.title')
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('hi')
  })

  test('console output goes to stderr in human mode', async () => {
    const r = await runCli([], 'console.log("a"); console.warn("b"); return 1')
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('1')
    expect(r.stderr).toContain('[log] a')
    expect(r.stderr).toContain('[warn] b')
  })

  test('--json captures logs', async () => {
    const r = await runCli(['--json'], 'console.log("x"); return {n: 1}')
    expect(r.exit).toBe(0)
    expect(r.stderr.trim()).toBe('')
    const parsed = JSON.parse(r.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.result).toEqual({ n: 1 })
    expect(parsed.logs).toEqual([{ level: 'log', message: 'x' }])
  })

  test('--json on throw exits 1', async () => {
    const r = await runCli(['--json'], 'throw new Error("nope")')
    expect(r.exit).toBe(1)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.kind).toBe('eval')
    expect(parsed.error.message).toBe('nope')
  })

  test('timeout exits 2', async () => {
    const r = await runCli(['--timeout', '200'], 'return new Promise(() => {})')
    expect(r.exit).toBe(2)
    expect(r.stderr).toContain('TIMEOUT')
  })

  test('unknown flag exits 3', async () => {
    const r = await runCli(['--no-such-flag'], '')
    expect(r.exit).toBe(3)
    expect(r.stderr).toContain('USAGE')
  })

  test('--help exits 0', async () => {
    const r = await runCli(['--help'], '')
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain('domdomdom')
    expect(r.stdout).toContain('Usage:')
  })

  test('local html file with IIFE bundle', async () => {
    const r = await runCli(
      [resolve(ROOT, 'test/fixtures/iife-page.html')],
      'return window.bundleResult',
    )
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, version: '1.0.0' })
  })

  test('--no-console drops logs', async () => {
    const r = await runCli(['--no-console'], 'console.log("hidden"); return 1')
    expect(r.exit).toBe(0)
    expect(r.stderr).not.toContain('hidden')
    expect(r.stdout.trim()).toBe('1')
  })

  test('--inject preloads file', async () => {
    const r = await runCli(
      ['--inject', resolve(ROOT, 'test/fixtures/preload.js')],
      'return window.PRELOADED',
    )
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('yes')
  })

  test('object result is JSON-pretty', async () => {
    const r = await runCli([], 'return { a: 1, b: [2, 3] }')
    expect(r.exit).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed).toEqual({ a: 1, b: [2, 3] })
  })

  test('cyclic result is handled (no crash)', async () => {
    const r = await runCli([], 'const o = {}; o.self = o; return o')
    expect(r.exit).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.self).toBe('[Circular]')
  })
})
