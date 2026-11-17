/**
 * Builtin (no `execve`) command interpreter for HarmonyOS phone builds.
 *
 * On phones the app sandbox cannot even `stat` `/system/bin/sh` (SELinux denies
 * search on `system_file`), so `spawn('/system/bin/sh')` fails with `EACCES` and
 * every shell tool call dies before it starts. This module implements the small
 * POSIX surface an agent actually uses — pipelines, `&&`/`||`/`;`, quoting and
 * `>`/`>>` redirects — directly on top of `node:fs`, with no child process.
 *
 * Supported builtins: echo printf pwd cd ls cat head tail wc grep find mkdir
 * rmdir rm cp mv touch ln stat basename dirname realpath sort uniq tee env
 * printenv which uname date sleep node sh bash true false exit export
 *
 * Deliberately not supported (no process, no ELF loader): anything that needs a
 * real binary — `git`, `tar`, `curl`, `rg`, `bun`, native installers. They fail
 * with exit 127 and an explicit "builtin shell" message instead of a hang.
 *
 * @module @dsh-ohos/shell/js-shell
 */

import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Per-stream byte cap for one command's output (matches the seam default). */
export const JS_MAX_OUTPUT_BYTES = 64_000

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])

/**
 * Split a command line into raw tokens, keeping quotes and operators intact.
 * @param {string} command
 * @returns {string[]}
 */
function tokenize(command) {
  const tokens = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  const flush = () => {
    if (current !== '') {
      tokens.push(current)
      current = ''
    }
  }
  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && !inSingle) {
      escaped = true
      continue
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle
      current += char
      continue
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble
      current += char
      continue
    }
    if (!inSingle && !inDouble && WHITESPACE.has(char)) {
      flush()
      continue
    }
    current += char
  }
  flush()
  return tokens
}

/**
 * Remove shell quoting from one token.
 * @param {string} token
 * @returns {string}
 */
function unquote(token) {
  let out = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (const char of token) {
    if (escaped) {
      out += char
      escaped = false
      continue
    }
    if (char === '\\' && !inSingle) {
      escaped = true
      continue
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    out += char
  }
  if (escaped) out += '\\'
  return out
}

/**
 * Split one command line on top-level separators (`;`, `&&`, `||`, `|`).
 * @param {string} command
 * @returns {{ type: 'cmd', tokens: string[] } | { type: 'sep', op: string }[]}
 */
function splitTopLevel(command) {
  const parts = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  const push = () => {
    const trimmed = current.trim()
    if (trimmed !== '') parts.push({ type: 'cmd', source: trimmed })
    current = ''
  }
  const chars = [...command]
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && !inSingle) {
      current += char
      escaped = true
      continue
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle
      current += char
      continue
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble
      current += char
      continue
    }
    if (!inSingle && !inDouble) {
      const two = chars[index] + (chars[index + 1] ?? '')
      if (two === '&&' || two === '||') {
        push()
        parts.push({ type: 'sep', op: two })
        index += 1
        continue
      }
      if (char === ';' || char === '\n') {
        push()
        parts.push({ type: 'sep', op: ';' })
        continue
      }
      if (char === '|' && chars[index + 1] !== '|') {
        push()
        parts.push({ type: 'sep', op: '|' })
        continue
      }
    }
    current += char
  }
  push()
  return parts
}

/**
 * Split a pipeline stage into argv plus redirects.
 * @param {string} source
 * @returns {{ argv: string[], redirect: { out?: string, append?: boolean, err?: string } }}
 */
function parseStage(source) {
  const tokens = tokenize(source)
  const argv = []
  const redirect = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '>' || token === '>>' || token === '2>' || token === '2>>') {
      const target = tokens[index + 1]
      if (target === undefined) throw new Error('syntax error: redirect without a target')
      if (token.startsWith('2')) redirect.err = unquote(target)
      else {
        redirect.out = unquote(target)
        redirect.append = token === '>>'
      }
      index += 1
      continue
    }
    if (token === '2>&1') {
      redirect.merge = true
      continue
    }
    if (token.startsWith('>') && token.length > 1) {
      redirect.out = unquote(token.slice(1))
      continue
    }
    argv.push(unquote(token))
  }
  return { argv, redirect }
}

/**
 * Resolve a path argument against the shell's current directory.
 * @param {string} cwd
 * @param {string} target
 */
function resolvePath(cwd, target) {
  if (target.startsWith('/')) return path.posix.normalize(target)
  return path.posix.normalize(path.posix.join(cwd, target))
}

const TRIM_NEWLINE = (text) => text.replace(/\n+$/, '')

/**
 * Format one directory entry the way `ls -l` prints it.
 */
async function statLine(entryPath, name) {
  try {
    const info = await fs.lstat(entryPath)
    const kind = info.isDirectory() ? 'd' : info.isSymbolicLink() ? 'l' : '-'
    const size = String(info.size).padStart(8)
    const stamp = new Date(info.mtimeMs).toISOString().slice(0, 19).replace('T', ' ')
    return `${kind}rw-r--r-- ${size} ${stamp} ${name}${info.isDirectory() ? '/' : ''}`
  } catch {
    return `----------        0                     ${name}`
  }
}

/**
 * `ls` with `-l`, `-a`, `-1`.
 */
async function builtinLs(args, io) {
  let long = false
  let all = false
  const targets = []
  for (const arg of args) {
    if (arg === '-l' || arg === '-la' || arg === '-al') {
      long = true
      all = arg.length > 2 ? true : all
    } else if (arg === '-a') all = true
    else if (!arg.startsWith('-')) targets.push(arg)
  }
  const target = targets[0] ?? '.'
  const full = resolvePath(io.cwd, target)
  let info
  try {
    info = await fs.stat(full)
  } catch (error) {
    io.err(`ls: ${target}: ${error.code === 'ENOENT' ? 'No such file or directory' : error.message}\n`)
    return 1
  }
  if (!info.isDirectory()) {
    io.out(`${long ? await statLine(full, path.posix.basename(full)) : target}\n`)
    return 0
  }
  let names = await fs.readdir(full)
  if (!all) names = names.filter((name) => !name.startsWith('.'))
  names.sort((a, b) => a.localeCompare(b))
  if (names.length === 0) return 0
  if (long) {
    const lines = []
    for (const name of names) lines.push(await statLine(path.posix.join(full, name), name))
    io.out(`${lines.join('\n')}\n`)
    return 0
  }
  io.out(`${names.join('\n')}\n`)
  return 0
}

/**
 * `cat` for one or more files (or stdin).
 */
async function builtinCat(args, io) {
  const files = args.filter((arg) => !arg.startsWith('-'))
  if (files.length === 0) {
    io.out(io.stdin)
    return 0
  }
  let code = 0
  for (const file of files) {
    const full = resolvePath(io.cwd, file)
    try {
      io.out(await fs.readFile(full, 'utf8'))
    } catch (error) {
      io.err(`cat: ${file}: ${error.code === 'ENOENT' ? 'No such file or directory' : error.message}\n`)
      code = 1
    }
  }
  return code
}

/**
 * Byte/line/word counting.
 */
async function builtinWc(args, io) {
  const files = args.filter((arg) => !arg.startsWith('-'))
  const sources = files.length === 0 ? [{ name: '', text: io.stdin }] : []
  for (const file of files) {
    try {
      sources.push({ name: file, text: await fs.readFile(resolvePath(io.cwd, file), 'utf8') })
    } catch (error) {
      io.err(`wc: ${file}: ${error.message}\n`)
      return 1
    }
  }
  for (const source of sources) {
    const lines = source.text === '' ? 0 : source.text.split('\n').length - (source.text.endsWith('\n') ? 1 : 0)
    const words = source.text.split(/\s+/).filter(Boolean).length
    const suffix = source.name === '' ? '' : ` ${source.name}`
    io.out(`${String(lines).padStart(7)} ${String(words).padStart(7)} ${String(source.text.length).padStart(7)}${suffix}\n`)
  }
  return 0
}

/**
 * `grep` over files or stdin: `-i`, `-n`, `-r`, `-v`, `-c`, `-F`.
 */
async function builtinGrep(args, io) {
  const flags = new Set()
  const positional = []
  for (const arg of args) {
    if (arg.startsWith('-') && arg.length > 1) for (const flag of arg.slice(1)) flags.add(flag)
    else positional.push(arg)
  }
  if (positional.length === 0) {
    io.err('grep: missing pattern\n')
    return 2
  }
  const pattern = positional.shift()
  const insensitive = flags.has('i')
  const matcher = flags.has('F')
    ? (line) => (insensitive ? line.toLowerCase().includes(pattern.toLowerCase()) : line.includes(pattern))
    : (() => {
        let regex
        try {
          regex = new RegExp(pattern, insensitive ? 'i' : '')
        } catch (error) {
          io.err(`grep: bad pattern: ${error.message}\n`)
          return null
        }
        return (line) => regex.test(line)
      })()
  if (matcher === null) return 2
  const recursive = flags.has('r')
  const files = positional.length === 0 && !recursive ? ['-'] : positional
  const withNames = files.length > 1 || recursive
  let matches = 0
  let code = 1
  const emit = (line, label, lineNumber) => {
    matches += 1
    code = 0
    if (flags.has('c')) return
    const prefix = label === undefined || !withNames ? '' : `${label}:`
    const numbered = flags.has('n') ? `${lineNumber}:` : ''
    io.out(`${prefix}${numbered}${line}\n`)
  }
  const scanText = (text, label) => {
    const lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    lines.forEach((line, index) => {
      const hit = matcher(line)
      const keep = flags.has('v') ? !hit : hit
      if (keep) emit(line, label, index + 1)
    })
  }
  const walk = async (dir) => {
    const names = await fs.readdir(dir)
    for (const name of names.sort()) {
      const full = path.posix.join(dir, name)
      const info = await fs.lstat(full)
      if (info.isDirectory()) {
        if (recursive) await walk(full)
        continue
      }
      try {
        scanText(await fs.readFile(full, 'utf8'), path.posix.relative(io.cwd, full))
      } catch {
        // Unreadable files are skipped, like `grep -s`.
      }
    }
  }
  for (const file of files) {
    if (file === '-') scanText(io.stdin, undefined)
    else {
      const full = resolvePath(io.cwd, file)
      try {
        const info = await fs.stat(full)
        if (info.isDirectory()) {
          if (recursive) await walk(full)
          else io.err(`grep: ${file}: Is a directory\n`)
          continue
        }
        scanText(await fs.readFile(full, 'utf8'), file)
      } catch (error) {
        io.err(`grep: ${file}: ${error.code === 'ENOENT' ? 'No such file or directory' : error.message}\n`)
        code = 2
      }
    }
  }
  if (flags.has('c')) io.out(`${matches}\n`)
  return code
}

/**
 * `find <path> [-name <glob>] [-type f|d] [-maxdepth <n>]`.
 */
async function builtinFind(args, io) {
  const roots = []
  let nameGlob
  let typeFilter
  let maxDepth = Number.POSITIVE_INFINITY
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-name') nameGlob = args[++index]
    else if (arg === '-type') typeFilter = args[++index]
    else if (arg === '-maxdepth') maxDepth = Number.parseInt(args[++index] ?? '0', 10)
    else if (!arg.startsWith('-')) roots.push(arg)
  }
  if (roots.length === 0) roots.push('.')
  const toRegExp = (glob) => {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    return new RegExp(`^${escaped}$`)
  }
  const matcher = nameGlob === undefined ? undefined : toRegExp(nameGlob)
  let code = 0
  const walk = async (full, depth) => {
    let info
    try {
      info = await fs.lstat(full)
    } catch {
      return
    }
    const base = path.posix.basename(full)
    const typeOk = typeFilter === undefined ? true : typeFilter === 'd' ? info.isDirectory() : info.isFile()
    const nameOk = matcher === undefined ? true : matcher.test(base)
    if (typeOk && nameOk) io.out(`${path.posix.relative(io.cwd, full) || '.'}\n`)
    if (!info.isDirectory() || depth >= maxDepth) return
    let names
    try {
      names = await fs.readdir(full)
    } catch {
      return
    }
    for (const name of names.sort()) await walk(path.posix.join(full, name), depth + 1)
  }
  for (const root of roots) await walk(resolvePath(io.cwd, root), 0)
  return code
}

/**
 * Copy a file or directory tree.
 */
async function copyTree(source, target) {
  const info = await fs.lstat(source)
  if (info.isDirectory()) {
    await fs.mkdir(target, { recursive: true })
    for (const name of await fs.readdir(source)) await copyTree(path.posix.join(source, name), path.posix.join(target, name))
    return
  }
  await fs.copyFile(source, target)
}

/**
 * Dispatch one simple command (no pipeline) to a builtin.
 * @param {string[]} argv
 * @param {Record<string, any>} io
 * @returns {Promise<number>}
 */
async function dispatch(argv, io) {
  const [name, ...args] = argv
  if (name === undefined) return 0
  switch (name) {
    case 'echo': {
      const newline = !args.includes('-n')
      const body = TRIM_NEWLINE(args.filter((arg) => arg !== '-n').join(' '))
      io.out(`${body}${newline ? '\n' : ''}`)
      return 0
    }
    case 'printf': {
      const format = args[0] ?? ''
      io.out(format.replace(/\\n/g, '\n').replace(/\\t/g, '\t'))
      return 0
    }
    case 'pwd':
      io.out(`${io.cwd}\n`)
      return 0
    case 'cd': {
      const target = resolvePath(io.cwd, args[0] ?? '/')
      try {
        const info = await fs.stat(target)
        if (!info.isDirectory()) {
          io.err(`cd: ${args[0] ?? '/'}: Not a directory\n`)
          return 1
        }
        io.cwd = target
        return 0
      } catch (error) {
        io.err(`cd: ${args[0] ?? '/'}: ${error.code === 'ENOENT' ? 'No such file or directory' : error.message}\n`)
        return 1
      }
    }
    case 'ls':
      return builtinLs(args, io)
    case 'cat':
      return builtinCat(args, io)
    case 'head':
    case 'tail': {
      let count = 10
      const files = []
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '-n') count = Number.parseInt(args[++index] ?? '10', 10)
        else files.push(args[index])
      }
      const text = files.length === 0 ? io.stdin : await fs.readFile(resolvePath(io.cwd, files[0]), 'utf8').catch(() => '')
      const lines = text.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      const slice = name === 'head' ? lines.slice(0, count) : lines.slice(-count)
      io.out(slice.length === 0 ? '' : `${slice.join('\n')}\n`)
      return 0
    }
    case 'wc':
      return builtinWc(args, io)
    case 'grep':
      return builtinGrep(args, io)
    case 'find':
      return builtinFind(args, io)
    case 'mkdir': {
      const recursive = args.includes('-p')
      const targets = args.filter((arg) => !arg.startsWith('-'))
      if (targets.length === 0) {
        io.err('mkdir: missing operand\n')
        return 1
      }
      for (const target of targets) {
        try {
          await fs.mkdir(resolvePath(io.cwd, target), { recursive })
        } catch (error) {
          io.err(`mkdir: ${target}: ${error.message}\n`)
          return 1
        }
      }
      return 0
    }
    case 'rmdir': {
      let code = 0
      for (const target of args.filter((arg) => !arg.startsWith('-'))) {
        try {
          await fs.rmdir(resolvePath(io.cwd, target))
        } catch (error) {
          io.err(`rmdir: ${target}: ${error.message}\n`)
          code = 1
        }
      }
      return code
    }
    case 'rm': {
      const recursive = args.some((arg) => arg.startsWith('-') && /r/i.test(arg))
      const force = args.some((arg) => arg.startsWith('-') && /f/i.test(arg))
      let code = 0
      for (const target of args.filter((arg) => !arg.startsWith('-'))) {
        try {
          await fs.rm(resolvePath(io.cwd, target), { recursive, force })
        } catch (error) {
          io.err(`rm: ${target}: ${error.message}\n`)
          code = 1
        }
      }
      return code
    }
    case 'cp': {
      const recursive = args.some((arg) => arg.startsWith('-') && /r/i.test(arg))
      const rest = args.filter((arg) => !arg.startsWith('-'))
      if (rest.length < 2) {
        io.err('cp: missing destination\n')
        return 1
      }
      const targets = rest.slice(-1)
      for (const source of rest.slice(0, -1)) {
        const from = resolvePath(io.cwd, source)
        let to = resolvePath(io.cwd, targets[0])
        try {
          const toInfo = await fs.stat(to).catch(() => undefined)
          if (toInfo?.isDirectory()) to = path.posix.join(to, path.posix.basename(from))
          const fromInfo = await fs.lstat(from)
          if (fromInfo.isDirectory() && !recursive) {
            io.err(`cp: -r not specified; omitting directory '${source}'\n`)
            return 1
          }
          await copyTree(from, to)
        } catch (error) {
          io.err(`cp: ${source}: ${error.message}\n`)
          return 1
        }
      }
      return 0
    }
    case 'mv': {
      const rest = args.filter((arg) => !arg.startsWith('-'))
      if (rest.length < 2) {
        io.err('mv: missing destination\n')
        return 1
      }
      try {
        const to = resolvePath(io.cwd, rest[rest.length - 1])
        for (const source of rest.slice(0, -1)) await fs.rename(resolvePath(io.cwd, source), to)
        return 0
      } catch (error) {
        io.err(`mv: ${error.message}\n`)
        return 1
      }
    }
    case 'touch': {
      let code = 0
      for (const target of args.filter((arg) => !arg.startsWith('-'))) {
        const full = resolvePath(io.cwd, target)
        try {
          const handle = await fs.open(full, 'a')
          await handle.close()
          const now = new Date()
          await fs.utimes(full, now, now)
        } catch (error) {
          io.err(`touch: ${target}: ${error.message}\n`)
          code = 1
        }
      }
      return code
    }
    case 'ln': {
      const symbolic = args.includes('-s')
      const rest = args.filter((arg) => !arg.startsWith('-'))
      if (rest.length < 2) {
        io.err('ln: missing target\n')
        return 1
      }
      try {
        const linkPath = resolvePath(io.cwd, rest[1])
        if (symbolic) await fs.symlink(rest[0], linkPath)
        else await fs.link(resolvePath(io.cwd, rest[0]), linkPath)
        return 0
      } catch (error) {
        io.err(`ln: ${error.message}\n`)
        return 1
      }
    }
    case 'stat': {
      const target = args.filter((arg) => !arg.startsWith('-'))[0]
      if (target === undefined) {
        io.err('stat: missing operand\n')
        return 1
      }
      const full = resolvePath(io.cwd, target)
      try {
        const info = await fs.stat(full)
        io.out(`  File: ${full}\n  Size: ${info.size}\n  Mode: ${info.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--'}\nModify: ${new Date(info.mtimeMs).toISOString()}\n`)
        return 0
      } catch (error) {
        io.err(`stat: ${target}: ${error.message}\n`)
        return 1
      }
    }
    case 'basename':
      io.out(`${path.posix.basename(args[0] ?? '')}\n`)
      return 0
    case 'dirname':
      io.out(`${path.posix.dirname(args[0] ?? '')}\n`)
      return 0
    case 'realpath': {
      try {
        io.out(`${await fs.realpath(resolvePath(io.cwd, args[0] ?? '.'))}\n`)
        return 0
      } catch (error) {
        io.err(`realpath: ${error.message}\n`)
        return 1
      }
    }
    case 'sort': {
      const reverse = args.includes('-r')
      const lines = io.stdin.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      lines.sort((a, b) => a.localeCompare(b))
      if (reverse) lines.reverse()
      io.out(lines.length === 0 ? '' : `${lines.join('\n')}\n`)
      return 0
    }
    case 'uniq': {
      const lines = io.stdin.split('\n').filter((line, index, all) => index === 0 || line !== all[index - 1])
      io.out(lines.length === 0 ? '' : `${lines.join('\n')}\n`)
      return 0
    }
    case 'tee': {
      io.out(io.stdin)
      for (const target of args.filter((arg) => !arg.startsWith('-'))) {
        await fs.writeFile(resolvePath(io.cwd, target), io.stdin)
      }
      return 0
    }
    case 'env':
    case 'printenv': {
      const entries = Object.entries(io.env).sort(([a], [b]) => a.localeCompare(b))
      if (name === 'printenv' && args[0] !== undefined) {
        io.out(`${io.env[args[0]] ?? ''}\n`)
        return io.env[args[0]] === undefined ? 1 : 0
      }
      io.out(`${entries.map(([key, value]) => `${key}=${value}`).join('\n')}\n`)
      return 0
    }
    case 'which': {
      const candidate = args[0]
      const known = BUILTIN_NAMES.has(candidate)
      io.out(known ? `builtin:${candidate}\n` : '')
      return known ? 0 : 1
    }
    case 'uname':
      io.out(`${args.includes('-a') ? `HarmonyOS ${io.env.OS_VERSION ?? ''} ` : ''}DshDesktopArk\n`)
      return 0
    case 'date':
      io.out(`${new Date().toISOString()}\n`)
      return 0
    case 'sleep': {
      const seconds = Number.parseFloat(args[0] ?? '0')
      if (Number.isFinite(seconds) && seconds > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 30) * 1000))
      return 0
    }
    case 'node': {
      const script = args[0]
      if (script === undefined) {
        io.err('node: this builtin needs a script path (no REPL in the builtin shell)\n')
        return 1
      }
      const full = resolvePath(io.cwd, script)
      const savedArgv = process.argv
      const savedLog = console.log
      const savedError = console.error
      process.argv = [process.execPath, full, ...args.slice(1)]
      console.log = (...values) => io.out(`${values.map(String).join(' ')}\n`)
      console.error = (...values) => io.err(`${values.map(String).join(' ')}\n`)
      try {
        await import(pathToFileURL(full).href)
        return 0
      } catch (error) {
        io.err(`${error?.stack ?? error}\n`)
        return 1
      } finally {
        process.argv = savedArgv
        console.log = savedLog
        console.error = savedError
      }
    }
    case 'sh':
    case 'bash': {
      const dashC = args.indexOf('-c')
      const script = dashC >= 0 ? args[dashC + 1] : undefined
      if (script === undefined) {
        io.err('bash: only `-c <script>` is supported in the builtin shell\n')
        return 2
      }
      return runScript(script, io)
    }
    case 'true':
      return 0
    case 'false':
      return 1
    case 'exit':
      return args[0] === undefined ? 0 : Number.parseInt(args[0], 10)
    case 'export':
      return 0
    default: {
      const message = `shell-ohos: '${name}' is not available in the builtin shell (no process execution on this device); builtins: ${[...BUILTIN_NAMES].sort().join(' ')}`
      io.err(`${message}\n`)
      return 127
    }
  }
}

/** Names the builtin interpreter can run. */
export const BUILTIN_NAMES = new Set([
  'echo', 'printf', 'pwd', 'cd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'mkdir', 'rmdir', 'rm',
  'cp', 'mv', 'touch', 'ln', 'stat', 'basename', 'dirname', 'realpath', 'sort', 'uniq', 'tee', 'env',
  'printenv', 'which', 'uname', 'date', 'sleep', 'node', 'sh', 'bash', 'true', 'false', 'exit', 'export',
])

/**
 * Run one pipeline stage, feeding `input` and returning its stdout.
 * @param {string} source
 * @param {Record<string, any>} io
 * @param {string} input
 * @returns {Promise<{ code: number, out: string, err: string, redirect: Record<string, any> }>}
 */
async function runStage(source, io, input) {
  const { argv, redirect } = parseStage(source)
  const outBuffer = []
  const errBuffer = []
  const stageIo = {
    cwd: io.cwd,
    env: io.env,
    stdin: input,
    out: (text) => outBuffer.push(text),
    err: (text) => errBuffer.push(text),
  }
  let code
  try {
    code = await dispatch(argv, stageIo)
  } catch (error) {
    errBuffer.push(`${argv[0] ?? 'shell'}: ${error?.message ?? error}\n`)
    code = 1
  }
  if (stageIo.cwd !== io.cwd) io.cwd = stageIo.cwd
  io.lastExit = code
  const out = outBuffer.join('')
  const err = errBuffer.join('')
  return { code, out, err, redirect }
}

/**
 * Execute a full command line: `;`, `&&`, `||`, `|`, redirects.
 * @param {string} command
 * @param {Record<string, any>} io
 * @returns {Promise<number>} exit code
 */
export async function runScript(command, io) {
  const parts = splitTopLevel(command)
  let code = 0
  let skipNext = false
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part.type === 'sep') {
      if (part.op === '&&' && code !== 0) skipNext = true
      if (part.op === '||' && code === 0) skipNext = true
      continue
    }
    if (skipNext) {
      skipNext = false
      continue
    }
    // Collect a pipeline: consecutive cmd parts joined by `|`.
    const stages = [part.source]
    while (parts[index + 1]?.type === 'sep' && parts[index + 1].op === '|' && parts[index + 2]?.type === 'cmd') {
      stages.push(parts[index + 2].source)
      index += 2
    }
    let input = ''
    let last = { code: 0, out: '', err: '', redirect: {} }
    for (const stage of stages) {
      last = await runStage(stage, io, input)
      input = last.out
      if (last.err !== '') io.err(last.err)
    }
    const { redirect } = last
    if (redirect.out !== undefined) {
      const target = resolvePath(io.cwd, redirect.out)
      try {
        if (redirect.append) await fs.appendFile(target, last.out)
        else await fs.writeFile(target, last.out)
      } catch (error) {
        io.err(`shell: ${redirect.out}: ${error.message}\n`)
        last = { ...last, code: 1 }
      }
    } else if (last.out !== '') io.out(last.out)
    if (redirect.err !== undefined) {
      io.err('shell: `2>` redirect is not supported in the builtin shell\n')
    }
    code = last.code
  }
  return code
}

/**
 * Run one command line to completion without any child process.
 * @param {string} command
 * @param {{ cwd: string, env?: Record<string, string>, stdin?: Buffer | string, maxBytes?: number, isCancelled?: () => boolean }} options
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, truncated: boolean }>}
 */
export async function runJsCommand(command, options) {
  const maxBytes = options.maxBytes ?? JS_MAX_OUTPUT_BYTES
  const stdoutParts = []
  const stderrParts = []
  let size = 0
  let truncated = false
  const push = (parts, text) => {
    if (text === '') return
    if (size + text.length > maxBytes) {
      truncated = true
      const room = Math.max(0, maxBytes - size)
      if (room > 0) {
        parts.push(text.slice(0, room))
        size += room
      }
      return
    }
    parts.push(text)
    size += text.length
  }
  const stdin = options.stdin === undefined ? '' : Buffer.isBuffer(options.stdin) ? options.stdin.toString('utf8') : String(options.stdin)
  const io = {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin,
    out: (text) => push(stdoutParts, text),
    err: (text) => push(stderrParts, text),
  }
  let exitCode = 0
  try {
    exitCode = await runScript(command, io)
  } catch (error) {
    push(stderrParts, `shell-ohos: ${error?.message ?? error}\n`)
    exitCode = 1
  }
  if (options.isCancelled?.() === true) exitCode = 1
  return { exitCode, stdout: stdoutParts.join(''), stderr: stderrParts.join(''), truncated }
}

export default runJsCommand
