/**
 * Offline smoke test for the builtin JS shell (`lib/js-shell.js`).
 *
 * The interpreter is what runs commands on phones, where `/system/bin/sh`
 * cannot be spawned (the app domain has no search permission on
 * `system_file`, so `execve` returns EACCES). These cases pin the behaviours
 * the `bash` tool relies on: exit codes, pipelines, `&&`/`||`, redirects,
 * quoting, and the honest failure for binaries that need a real process.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runJsCommand, BUILTIN_NAMES } from '../lib/js-shell.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-js-shell-'))
const inside = (name) => path.join(root, name)

async function run(command, options = {}) {
  return runJsCommand(command, { cwd: root.replaceAll('\\', '/'), ...options })
}

test('echo and exit codes', async () => {
  const ok = await run('echo dsh-ok')
  assert.equal(ok.exitCode, 0)
  assert.equal(ok.stdout, 'dsh-ok\n')
  const bad = await run('false')
  assert.equal(bad.exitCode, 1)
})

test('pwd, mkdir -p, cd and ls', async () => {
  await fs.mkdir(inside('sub'), { recursive: true })
  await fs.writeFile(inside('sub/a.txt'), 'alpha\n')
  const listed = await run('cd sub && pwd && ls')
  assert.equal(listed.exitCode, 0)
  assert.match(listed.stdout, /a\.txt/)
  const long = await run('ls -l sub')
  assert.match(long.stdout, /a\.txt/)
})

test('cat, head, tail, wc and pipelines', async () => {
  await fs.writeFile(inside('lines.txt'), 'one\ntwo\nthree\n')
  const head = await run('head -n 2 lines.txt')
  assert.equal(head.stdout, 'one\ntwo\n')
  const tail = await run('tail -n 1 lines.txt')
  assert.equal(tail.stdout, 'three\n')
  const counted = await run('cat lines.txt | grep t | wc -l')
  assert.match(counted.stdout, /2/)
})

test('grep flags: -n, -i, -c, -v and recursion', async () => {
  await fs.mkdir(inside('grepdir'), { recursive: true })
  await fs.writeFile(inside('grepdir/one.txt'), 'Alpha\nbeta\n')
  await fs.writeFile(inside('grepdir/two.txt'), 'gamma\nalpha\n')
  const recursive = await run('grep -r alpha grepdir')
  assert.equal(recursive.exitCode, 0)
  assert.match(recursive.stdout, /two\.txt:alpha/)
  assert.doesNotMatch(recursive.stdout, /one\.txt/)
  const recursiveInsensitive = await run('grep -r -i alpha grepdir')
  assert.match(recursiveInsensitive.stdout, /one\.txt:Alpha/)
  assert.match(recursiveInsensitive.stdout, /two\.txt:alpha/)
  const insensitive = await run('grep -i -c alpha grepdir/two.txt')
  assert.equal(insensitive.stdout.trim(), '1')
  const inverted = await run('grep -v alpha grepdir/two.txt')
  assert.equal(inverted.stdout, 'gamma\n')
})

test('redirects write files', async () => {
  const written = await run('echo hello > out.txt')
  assert.equal(written.exitCode, 0)
  assert.equal(await fs.readFile(inside('out.txt'), 'utf8'), 'hello\n')
  await run('echo again >> out.txt')
  assert.equal(await fs.readFile(inside('out.txt'), 'utf8'), 'hello\nagain\n')
})

test('cp, mv, rm and find', async () => {
  await fs.writeFile(inside('cp-src.txt'), 'x')
  assert.equal((await run('cp cp-src.txt cp-dst.txt')).exitCode, 0)
  assert.equal(await fs.readFile(inside('cp-dst.txt'), 'utf8'), 'x')
  assert.equal((await run('mv cp-dst.txt moved.txt')).exitCode, 0)
  assert.equal(await fs.readFile(inside('moved.txt'), 'utf8'), 'x')
  const found = await run('find . -name "*.txt"')
  assert.match(found.stdout, /moved\.txt/)
  assert.equal((await run('rm -f moved.txt')).exitCode, 0)
  await assert.rejects(fs.stat(inside('moved.txt')))
})

test('&& and || short-circuit on the exit code', async () => {
  const both = await run('true && echo yes')
  assert.equal(both.stdout, 'yes\n')
  const skipped = await run('false && echo no')
  assert.equal(skipped.stdout, '')
  const fallback = await run('false || echo fallback')
  assert.equal(fallback.stdout, 'fallback\n')
})

test('quoting keeps spaces together', async () => {
  const quoted = await run('echo "a  b" \'c d\'')
  assert.equal(quoted.stdout, 'a  b c d\n')
})

test('a real binary fails honestly instead of hanging', async () => {
  const result = await run('git status')
  assert.equal(result.exitCode, 127)
  assert.match(result.stderr, /not available in the builtin shell/)
  assert.match(result.stderr, /builtins:/)
})

test('unknown and missing paths report a POSIX-ish error', async () => {
  const missing = await run('cat nope.txt')
  assert.equal(missing.exitCode, 1)
  assert.match(missing.stderr, /No such file or directory/)
})

test('builtin list covers the documented surface', () => {
  for (const name of ['echo', 'ls', 'cat', 'grep', 'find', 'mkdir', 'rm', 'cp', 'mv', 'node', 'bash']) {
    assert.ok(BUILTIN_NAMES.has(name), `${name} must be a builtin`)
  }
})
