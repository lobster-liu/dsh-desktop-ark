/**
 * 补齐登录所需的**构建期常量**（`{}.DSH_CLIENT_*` → 字面量）。
 *
 * 背景：客户端 bundle 里 `process.env.DSH_CLIENT_*` 被 browser 垫片替换成了空对象字面量
 * `{}`（只做了 `process.env` → `{}`，没有做 `define` 替换），于是
 * `accountClientMetadata(locale, {}.DSH_CLIENT_VERSION)` 拿到的永远是 `undefined`，
 * `ui-settings-account` 的 `start()` 会同步抛
 * `account: this client build carries no DSH_CLIENT_VERSION` —— 表现为点「登录」后
 * 一个请求都不发、界面直接弹「登录失败」。这里把 8 处占位替换成字面量。
 *
 * 登录桥接（`window.open` 垫片）不在这里做：它是 `@dsh-ohos/branding` 的源码行为，
 * 由 `syncOhosPackages()` 同步进 payload；本模块只做**断言**，避免两份会漂移的实现。
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ENV = {
  DSH_CLIENT_VERSION: '0.2.2-rc.3',
  DSH_CLIENT_COMMIT_HASH: '38a6a5c9',
  DSH_CLIENT_GIT_DIRTY: 'false',
  DSH_CLIENT_BUILD_PROFILE: 'production',
  DSH_CLIENT_TITLE: 'DSH Desktop',
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (name.endsWith('.js')) yield path
  }
}

/**
 * 在 payload 上打常量补丁，并断言登录桥接已在 branding 里。
 *
 * @param {string} root - payload 根（其下有 `dsh/`），或已经指向 `dsh/` 那一层
 * @param {(line: string) => void} [log]
 * @returns {{ patchedFiles: number, patchedConstants: number }}
 */
export function patchPayloadLogin(root, log = () => {}) {
  const nested = join(root, 'dsh', 'node_modules', '@deepseek-ai')
  const dshRoot = existsSync(nested) ? join(root, 'dsh') : root
  const modules = join(dshRoot, 'node_modules', '@deepseek-ai')
  let patchedFiles = 0
  let patchedConstants = 0
  for (const file of walk(modules)) {
    const before = readFileSync(file, 'utf8')
    if (!before.includes('{}.DSH_CLIENT_')) continue
    let count = 0
    const after = before.replace(/\{\}\.(DSH_CLIENT_[A-Z_]+)/g, (match, name) => {
      if (ENV[name] === undefined) throw new Error(`unknown client constant ${name} in ${file}`)
      count += 1
      return JSON.stringify(ENV[name])
    })
    writeFileSync(file, after)
    patchedFiles += 1
    patchedConstants += count
    log(`客户端常量：${file.slice(root.length)} 替换 ${count} 处`)
  }

  const leftover = [...walk(modules)].filter((file) => readFileSync(file, 'utf8').includes('{}.DSH_CLIENT_'))
  if (leftover.length > 0) throw new Error(`仍有未解析的客户端常量：${leftover.join(', ')}`)

  const brandingPath = join(dshRoot, 'node_modules', '@dsh-ohos', 'branding', 'lib', 'index.js')
  if (!readFileSync(brandingPath, 'utf8').includes('dsh-ohos-login-bridge')) {
    throw new Error('branding 里没有登录桥接：先同步 @dsh-ohos/* 源码包（syncOhosPackages）')
  }
  return { patchedFiles, patchedConstants }
}
