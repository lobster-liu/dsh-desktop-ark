/**
 * 运行期授予的额外根（手机「安全访问」选中的目录）。
 *
 * 为什么需要单独一张表：固定根由 `DSH_OHOS_USER_ROOT` 拼出来（`…/Documents`、`…/Download`），
 * 而系统目录选择器返回的是**真实路径**（`…/HO_DATA_EXT_MISC/Documents`）。两者指向同一处，
 * 但字符串不同，围栏会把这个合法目录判成「越界」。选中一个可读目录后把它登记成额外根，
 * 围栏（`list` / `createDirectory`）就认它。
 *
 * 手机上这种授予是**只读**的（实测：可列目录、可建目录，建文件/删目录一律 Permission denied），
 * 所以根上带 `readOnly: true`，用于界面提示。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** @type {Array<{ id: string, name: string, path: string, kind: 'granted', readOnly: true }>} */
const grantedRoots = []

/**
 * 持久化文件（绝对路径）。为空表示不落盘（单元测试默认如此）。
 *
 * 为什么要落盘：登记表原本只在进程内存里，应用一重启就丢，界面上表现为「上次挂过的目录
 * 又变成越界」。落盘后仍要**按可用性复核**——系统给「安全访问」的授予只对本次运行有效，
 * 重启后目录可能已经读不动（见 `permission()` 的 `expired` 分支），所以登记只是"记住位置"，
 * 不等于"记住权限"。
 * @type {string}
 */
let storeFile = ''

function normalized(path) {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 指定持久化文件；传空字符串可关闭落盘（测试用）。
 * @param {{ file?: string }} [options]
 * @returns {string} 当前生效的持久化文件（未启用时为空串）
 */
export function configureGrantedRoots(options = {}) {
  const file = options.file
  storeFile = typeof file === 'string' && isAbsolute(file) ? file : ''
  return storeFile
}

/** @returns {string} 当前生效的持久化文件（未启用时为空串） */
export function grantedRootsFile() {
  return storeFile
}

function persist() {
  if (storeFile === '') return
  try {
    mkdirSync(dirname(storeFile), { recursive: true })
    const body = `${JSON.stringify({ version: 1, roots: grantedRoots.map((root) => ({ path: root.path, name: root.name })) }, null, 2)}\n`
    const temp = `${storeFile}.tmp`
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, storeFile)
  } catch (error) {
    console.warn(`workspace-picker: 无法保存授权目录（${storeFile}）：${error?.message ?? error}`)
  }
}

/**
 * 从持久化文件恢复登记表（开机一次）。文件不存在/损坏都只记日志，不抛错。
 * @param {{ file?: string }} [options] - 省略时沿用 `configureGrantedRoots()` 的设置
 * @returns {Array<{ id: string, name: string, path: string, kind: 'granted', readOnly: true }>}
 */
export function loadGrantedRoots(options = {}) {
  if (typeof options.file === 'string') configureGrantedRoots(options)
  if (storeFile === '' || !existsSync(storeFile)) return grantedRootList()
  try {
    const parsed = JSON.parse(readFileSync(storeFile, 'utf8'))
    const list = Array.isArray(parsed?.roots) ? parsed.roots : []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      if (typeof item.path !== 'string' || !isAbsolute(item.path)) continue
      registerGrantedRoot(item.path, typeof item.name === 'string' ? item.name : '')
    }
  } catch (error) {
    console.warn(`workspace-picker: 无法读取授权目录（${storeFile}）：${error?.message ?? error}`)
  }
  return grantedRootList()
}

/**
 * 忘掉一个额外根（目录已失效、或用户主动移除）。
 * @param {string} id
 * @returns {boolean} 是否真的移除了
 */
export function forgetGrantedRoot(id) {
  const index = grantedRoots.findIndex((root) => root.id === id)
  if (index < 0) return false
  grantedRoots.splice(index, 1)
  persist()
  return true
}

/** 默认持久化文件：`<DSH_HOME>/ohos-granted-roots.json`。 */
export const GRANTED_ROOTS_FILE_NAME = 'ohos-granted-roots.json'

/**
 * 用 `DSH_HOME` 拼出默认持久化文件路径（不是绝对路径时返回空串）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultGrantedRootsFile(env = process.env) {
  const home = env.DSH_HOME
  return typeof home === 'string' && isAbsolute(home) ? join(home, GRANTED_ROOTS_FILE_NAME) : ''
}

/**
 * 登记一个已获访问权的目录。
 * @param {string} path - 绝对路径
 * @param {string} [name] - 显示名；省略取末段
 * @returns {{ id: string, name: string, path: string, kind: 'granted', readOnly: true } | undefined}
 */
export function registerGrantedRoot(path, name = '') {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return undefined
  const target = normalized(path)
  const existing = grantedRoots.find((root) => normalized(root.path) === target)
  if (existing !== undefined) return existing
  const root = {
    id: `granted-${grantedRoots.length + 1}`,
    name: name !== '' ? name : basename(resolve(path)) || path,
    path: resolve(path),
    kind: 'granted',
    readOnly: true,
  }
  grantedRoots.push(root)
  persist()
  return root
}

/** @returns {Array<{ id: string, name: string, path: string, kind: 'granted', readOnly: true }>} */
export function grantedRootList() {
  return grantedRoots.map((root) => ({ ...root }))
}

/**
 * 清空登记表。默认同时清空持久化文件，避免下次启动又把它们读回来。
 * @param {{ persist?: boolean }} [options] - `persist: false` 只清内存（测试常用）
 */
export function clearGrantedRoots(options = {}) {
  grantedRoots.length = 0
  if (options.persist !== false) persist()
}
