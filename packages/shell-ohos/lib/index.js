/**
 * `@dsh-ohos/shell` — `ctx.shell` provider for HarmonyOS.
 *
 * HarmonyOS has no PTY (`/dev/ptmx` is absent), so this executor runs one
 * long-lived `/system/bin/sh` and frames every call with a random sentinel line
 * (`@dsh-ohos/shell/framing`). The seam contract is the upstream one
 * (`packages/shell/shell/src/index.ts:64-94`, `types.ts:140-238`):
 * - `resolve()` fills/clamps the spec; `execute()` publishes the handle;
 * - `result()` rejects only for infrastructure failures — non-zero exits,
 *   timeouts, and aborts resolve, with `timedOut`/`aborted` mutually exclusive
 *   by first cause;
 * - `done` never rejects;
 * - `readOutput()` is consuming, `observed` readers are offset-based
 *   (non-consuming), and output stays readable after exit.
 *
 * Persistent-shell rules:
 * - each call runs in a subshell after `cd -- <workdir>`, so `cd`, variable
 *   assignments, and `exit` never leak into the next call;
 * - a timeout / abort / `kill()` terminates the shell and the next call gets a
 *   fresh one;
 * - a call that carries `stdin` runs as a one-shot child instead (feeding stdin
 *   into the multiplexed shell would corrupt the framing).
 *
 * @module @dsh-ohos/shell
 */

import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { tmpdir } from 'node:os'
import { Service } from '@deepseek-ai/cordis'
import { TailCollector, readerOf } from './output.js'
import { buildScript, FrameParser } from './framing.js'
import { runJsCommand } from './js-shell.js'

export { runJsCommand }

export { buildScript, FrameParser, quoteForPosixShell, BEGIN_PREFIX, END_PREFIX, CD_FAILED } from './framing.js'

/** Largest delay Node schedules without clamping it to one millisecond. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Default foreground timeout (`timeoutMs` config default). */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Upper bound applied to per-call timeout overrides (upstream `maxTimeoutMs`). */
export const MAX_TIMEOUT_MS = 600_000

/** Default stdout capture budget (upstream `maxOutputBytes`). */
export const MAX_OUTPUT_BYTES = 64_000

/** Per-stream spill cap (upstream `maxSpillBytes`). */
export const MAX_SPILL_BYTES = 64 * 1024 * 1024

/** SIGTERM → SIGKILL grace (upstream `graceMs`). */
export const GRACE_MS = 3_000

/** Default platform shell (must stay inside `/system/bin`). */
export const DEFAULT_SHELL_PATH = '/system/bin/sh'

/** Model-friendly environment overrides (`bash-local/src/index.ts:27-32`). */
export const ENV_OVERRIDES = Object.freeze({
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
})

const WORKSPACE_ENV = 'DSH_OHOS_WORKSPACE'

/**
 * Validate and default the plugin configuration. Only the keys declared by the
 * bundle row (`timeoutMs`, `shellPath`) are accepted.
 * @param {{ timeoutMs?: number, shellPath?: string }} [config]
 * @returns {{ timeoutMs: number, shellPath: string }}
 */
export function normalizeConfig(config = {}) {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`shell-ohos: timeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const shellPath = config.shellPath ?? DEFAULT_SHELL_PATH
  if (typeof shellPath !== 'string' || !isAbsolute(shellPath)) {
    throw new Error(`shell-ohos: shellPath must be an absolute path, got ${JSON.stringify(config.shellPath)}`)
  }
  return { timeoutMs, shellPath }
}

function workspaceRoot(env = process.env) {
  const value = env[WORKSPACE_ENV]
  return typeof value === 'string' && isAbsolute(value) ? value : undefined
}

function clampTimeout(requested, fallback, max, name) {
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
    throw new Error(`${name} must be a positive finite number`)
  }
  return Math.min(requested ?? fallback, max)
}

function assertPositiveFinite(name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`shell-ohos: ${name} must be a positive finite number`)
}

/** Project a settled collector into the seam's `CollectedOutput`. */
function finalOutput(collector) {
  return collector.finalize()
}

/**
 * `ctx.shell` for HarmonyOS.
 */
export class OhosShellExecutor extends Service {
  static inject = ['subprocess']

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ timeoutMs?: number, shellPath?: string }} [config]
   */
  constructor(ctx, config) {
    super(ctx, 'shell')
    this.config = normalizeConfig(config)
    /** Persistent shell handle (undefined = not started / dead). */
    this.shell = undefined
    this.shellDead = true
    /** The execution currently bound to the persistent shell. */
    this.current = undefined
    /** Serialization queue: one command at a time on the shared shell. */
    this.queue = Promise.resolve()
    this.disposed = false
    /** `undefined` = not probed yet; `native` = real `/system/bin/sh`; `js` = builtin interpreter. */
    this.engine = undefined
    const forced = process.env.DSH_OHOS_SHELL_MODE
    if (forced === 'js' || forced === 'native') this.engine = forced
    /** Set once the builtin-shell notice has been emitted. */
    this.engineNoticeSent = false
    ctx.effect(() => () => this.dispose(), 'shell-ohos teardown')
  }

  /**
   * Resolve a request into a fully-specified spec.
   * `workdir` defaults to `DSH_OHOS_WORKSPACE`; `process.cwd()` is never used
   * (on device it is `/`).
   * @param {Record<string, any>} request
   * @returns {Record<string, any>}
   */
  resolve(request) {
    if (request === null || typeof request !== 'object' || typeof request.command !== 'string') {
      throw new Error('shell-ohos: request.command must be a string')
    }
    const timeoutMs = clampTimeout(request.timeoutMs, this.config.timeoutMs, MAX_TIMEOUT_MS, 'shell-ohos: request.timeoutMs')
    const stdoutMaxBytes = request.stdoutMaxBytes ?? MAX_OUTPUT_BYTES
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    const workdir = request.workdir ?? workspaceRoot()
    if (typeof workdir !== 'string' || !isAbsolute(workdir)) {
      throw new Error('shell-ohos: workdir is required (request.workdir or DSH_OHOS_WORKSPACE); process.cwd() is never used')
    }
    return {
      command: request.command,
      workdir,
      timeoutMs,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /**
   * The sandbox mode this executor applies by default: none. The
   * `@dsh-ohos/sandbox` provider reports `sandbox: 'none'`; this executor never
   * rewrites argv or claims confinement.
   * @returns {undefined}
   */
  get sandboxMode() {
    return undefined
  }

  /**
   * Execute one resolved spec.
   * @param {Record<string, any>} spec
   * @returns {Promise<Record<string, any>>} the live execution handle.
   */
  async execute(spec) {
    const execution = this.createExecution(spec)
    const run = () => this.runExecution(execution)
    this.queue = this.queue.then(run, run).catch(() => {})
    return execution.proc
  }

  /**
   * Build the execution record and its public handle.
   * @param {Record<string, any>} spec
   * @returns {{ proc: Record<string, any>, spec: Record<string, any> }}
   */
  createExecution(spec) {
    if (spec === null || typeof spec !== 'object') throw new Error('shell-ohos: execute requires a resolved spec')
    if (!isAbsolute(spec.workdir)) throw new Error('shell-ohos: spec.workdir must be absolute')
    if (spec.onExpiry !== 'kill' && spec.onExpiry !== 'none') throw new Error(`shell-ohos: invalid onExpiry ${JSON.stringify(spec.onExpiry)}`)

    const spillDir = tmpdir()
    const stdout = new TailCollector(spec.stdoutMaxBytes, 'stdout', { maxBytes: MAX_SPILL_BYTES, dir: spillDir })
    const stderr = new TailCollector(MAX_OUTPUT_BYTES, 'stderr', { maxBytes: MAX_SPILL_BYTES, dir: spillDir })
    let stdoutOffset = 0
    let stderrOffset = 0
    let settled = false
    let providerError
    let timer
    let timedOut = false
    let aborted = false
    let deliveredSignal = null
    let doneResolve
    const done = new Promise(resolve => {
      doneResolve = resolve
    })

    const exec = {
      spec,
      nonce: randomBytes(12).toString('hex'),
      parser: undefined,
      stdout,
      stderr,
      handle: undefined,
      settled: false,
    }
    exec.parser = new FrameParser(exec.nonce)

    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      observed: { stdout: readerOf(stdout), stderr: readerOf(stderr) },
      done,
      readOutput: () => {
        const out = stdout.readFrom(stdoutOffset)
        const err = stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        const delta = out.text + (err.text.length > 0 ? `${separator}[stderr]\n${err.text}` : '')
        return {
          delta,
          lossy: out.lossy || err.lossy,
          ...(out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {}),
          ...(err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {}),
        }
      },
      kill: () => {
        if (proc.status !== 'running') return false
        deliveredSignal = 'SIGTERM'
        proc.status = 'killed'
        terminate()
        settle(null)
        return true
      },
      result: () => {
        resultPromise ??= done.then(() => {
          if (providerError !== undefined) throw providerError
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            timedOut,
            aborted: !timedOut && aborted,
            timeoutMs: spec.timeoutMs,
            stdout: finalOutput(stdout),
            stderr: finalOutput(stderr),
          }
        })
        return resultPromise
      },
    }
    let resultPromise

    const settle = (exitCode, signalName) => {
      if (settled) return
      settled = true
      exec.settled = true
      if (timer !== undefined) clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
      proc.exitCode = exitCode ?? null
      proc.signal = signalName ?? deliveredSignal ?? null
      if (proc.status === 'running') proc.status = deliveredSignal !== null || signalName !== null ? 'killed' : 'completed'
      stdout.seal()
      stderr.seal()
      if (this.current === exec) this.current = undefined
      doneResolve()
      exec.onSettled?.()
    }
    const fail = error => {
      if (settled) return
      providerError = error
      deliveredSignal = null
      proc.status = 'killed'
      settle(null, null)
    }
    const terminate = () => {
      if (exec.handle !== undefined) {
        try {
          exec.handle.terminate()
        } catch {
          // Termination races exit; the settle path owns the outcome.
        }
      }
      this.killShell()
    }
    const onAbort = () => {
      if (settled) return
      aborted = true
      deliveredSignal = 'SIGTERM'
      proc.status = 'killed'
      terminate()
      settle(null, 'SIGTERM')
    }

    exec.settle = settle
    exec.fail = fail
    exec.terminate = terminate
    exec.armDeadline = () => {
      if (spec.onExpiry !== 'kill') return
      timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        deliveredSignal = 'SIGTERM'
        proc.status = 'killed'
        terminate()
        settle(null, 'SIGTERM')
      }, spec.timeoutMs)
    }
    exec.attachSignal = () => {
      if (spec.signal === undefined) return
      if (spec.signal.aborted) {
        onAbort()
        return
      }
      spec.signal.addEventListener('abort', onAbort, { once: true })
    }
    return { proc, spec, exec, onAbort }
  }

  /**
   * Run one queued execution to settlement.
   * @param {{ proc: Record<string, any>, spec: Record<string, any>, exec: Record<string, any>, onAbort: () => void }} state
   * @returns {Promise<void>}
   */
  async runExecution(state) {
    const { proc, spec, exec } = state
    if (this.disposed) {
      exec.fail(new Error('shell-ohos: executor disposed before the command started'))
      return
    }
    if (proc.status !== 'running') return
    exec.attachSignal()
    if (exec.settled) return
    exec.armDeadline()
    try {
      const engine = this.engine ?? (await this.resolveEngine())
      if (engine === 'js') await this.runJs(exec)
      else if (spec.stdin !== undefined) await this.runOneShot(exec)
      else await this.runPersistent(exec)
    } catch (error) {
      exec.fail(error)
    }
  }

  /**
   * Decide once whether this device can start a real `/system/bin/sh`.
   *
   * Phone builds cannot: the app domain has no search permission on
   * `system_file`, so even `stat('/system/bin/sh')` fails with `EACCES` and
   * `execve` does too. The builtin JS interpreter then runs the command in
   * process instead of failing every call.
   * @returns {Promise<'native' | 'js'>}
   */
  async resolveEngine() {
    const forced = process.env.DSH_OHOS_SHELL_MODE
    if (forced === 'js' || forced === 'native') {
      this.engine = forced
      return forced
    }
    if (this.engine !== undefined) return this.engine
    const available = await this.probeNative()
    this.engine = available ? 'native' : 'js'
    if (!available) {
      this.ctx.logger?.info?.('shell-ohos: /system/bin/sh unusable on this device; falling back to the builtin JS shell')
    }
    return this.engine
  }

  /**
   * Try one trivial spawn to see whether a native shell can start at all.
   * @returns {Promise<boolean>}
   */
  async probeNative() {
    const workspace = workspaceRoot()
    if (workspace === undefined) return false
    let handle
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [this.config.shellPath, '-c', 'exit 0'],
        cwd: workspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
        graceMs: 2_000,
      })
    } catch {
      return false
    }
    try {
      const outcome = await Promise.race([
        handle.done.then(result => result?.exitCode === 0, () => false),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 1_500)),
      ])
      // A shell that neither exits nor fails within the probe window is treated
      // as usable: a real refusal (EACCES from execve) arrives in milliseconds.
      return outcome === 'timeout' ? true : outcome === true
    } catch {
      return false
    }
  }

  /**
   * Run one command with the builtin interpreter (no child process).
   * @param {Record<string, any>} exec
   * @returns {Promise<void>}
   */
  async runJs(exec) {
    const { spec } = exec
    if (!this.engineNoticeSent) {
      this.engineNoticeSent = true
      exec.stderr.push(
        Buffer.from(
          `${this.config.shellPath} cannot start on this device (EACCES: the app domain may not execute system binaries); `
            + 'running the command with the builtin JS shell instead — pipelines, redirects and file commands work, '
            + 'but no external binary (git, tar, rg, curl, bun …) can run.\n',
          'utf8',
        ),
      )
    }
    const outcome = await runJsCommand(spec.command, {
      cwd: spec.workdir,
      env: this.envFor(spec),
      stdin: spec.stdin,
      maxBytes: spec.stdoutMaxBytes,
      isCancelled: () => exec.settled,
    })
    if (exec.settled) return
    if (outcome.stdout !== '') exec.stdout.push(Buffer.from(outcome.stdout, 'utf8'))
    if (outcome.stderr !== '') exec.stderr.push(Buffer.from(outcome.stderr, 'utf8'))
    exec.settle(outcome.exitCode, null)
  }

  /**
   * One-shot child for calls that carry stdin (framing cannot multiplex stdin).
   * @param {Record<string, any>} exec
   */
  async runOneShot(exec) {
    const { spec } = exec
    const handle = this.ctx.subprocess.spawn({
      argv: [this.config.shellPath, '-c', spec.command],
      cwd: spec.workdir,
      stdio: {
        stdin: { data: spec.stdin },
        stdout: { maxBytes: spec.stdoutMaxBytes },
        stderr: { maxBytes: MAX_OUTPUT_BYTES },
      },
      graceMs: GRACE_MS,
      signal: spec.signal,
      env: this.envFor(spec),
    })
    exec.handle = handle
    handle.stdout?.on('data', chunk => exec.stdout.push(chunk))
    handle.stderr?.on('data', chunk => exec.stderr.push(chunk))
    const outcome = await handle.done
    exec.settle(outcome.exitCode, outcome.signal)
  }

  /**
   * Frame one command onto the persistent shell and wait for its sentinel.
   * @param {Record<string, any>} exec
   */
  async runPersistent(exec) {
    const { spec } = exec
    this.current = exec
    const shell = this.ensureShell()
    const script = buildScript({ nonce: exec.nonce, workdir: spec.workdir, command: spec.command })
    if (shell.stdin === undefined || shell.stdin.destroyed) throw new Error('shell-ohos: the persistent shell has no stdin')
    if (exec.settled) return
    const awaited = new Promise(resolve => {
      exec.onSettled = resolve
    })
    shell.stdin.write(script, 'utf8')
    if (exec.settled) return
    await awaited
  }

  /** Environment handed to the persistent shell / one-shot child. */
  envFor(spec) {
    return { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }
  }

  /**
   * Start (or reuse) the persistent `/system/bin/sh`.
   * @returns {Record<string, any>} the subprocess handle.
   */
  ensureShell() {
    if (this.shell !== undefined && !this.shellDead) return this.shell
    const workspace = workspaceRoot()
    if (workspace === undefined) {
      throw new Error('shell-ohos: DSH_OHOS_WORKSPACE is not set; the persistent shell needs an absolute cwd')
    }
    const handle = this.ctx.subprocess.spawn({
      argv: [this.config.shellPath],
      cwd: workspace,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: GRACE_MS,
      env: { ...ENV_OVERRIDES, PS1: '' },
    })
    this.shell = handle
    this.shellDead = false
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')

    handle.stdout?.on('data', chunk => {
      const text = outDecoder.write(chunk)
      if (text !== '') this.onShellStdout(text)
    })
    handle.stderr?.on('data', chunk => {
      const text = errDecoder.write(chunk)
      if (text !== '') this.current?.stderr.push(Buffer.from(text, 'utf8'))
    })
    const onGone = error => {
      this.shellDead = true
      if (this.shell === handle) this.shell = undefined
      if (error !== undefined && /EACCES|ENOENT|EPERM/.test(String(error?.message ?? ''))) this.engine = 'js'
      const current = this.current
      if (current !== undefined && !current.settled) {
        current.fail(error ?? new Error('shell-ohos: the persistent shell exited before the command finished'))
      }
    }
    handle.done.then(() => onGone(undefined), error => onGone(error))
    return handle
  }

  /**
   * Feed decoded stdout into the current frame parser.
   * @param {string} text
   */
  onShellStdout(text) {
    const current = this.current
    if (current === undefined || current.settled) return
    const parsed = current.parser.push(text)
    if (parsed.body !== '') current.stdout.push(Buffer.from(parsed.body, 'utf8'))
    if (parsed.completed) {
      const exitCode = parsed.exitCode ?? 0
      if (exitCode === 125) current.stderr.push(Buffer.from(`shell-ohos: cannot change directory to ${current.spec.workdir}\n`, 'utf8'))
      current.settle(exitCode, null)
      current.onSettled?.()
    }
  }

  /** Terminate the persistent shell (idempotent). */
  killShell() {
    const shell = this.shell
    this.shell = undefined
    this.shellDead = true
    if (shell === undefined) return
    try {
      shell.terminate()
    } catch {
      // Already exited.
    }
  }

  /** Terminate everything the executor owns (fiber teardown). */
  dispose() {
    this.disposed = true
    const current = this.current
    if (current !== undefined && !current.settled) current.kill?.()
    this.killShell()
    this.current?.settle?.(null, null)
  }
}

export default OhosShellExecutor
