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

import { basename, isAbsolute, resolve } from 'node:path'

/** @type {Array<{ id: string, name: string, path: string, kind: 'granted', readOnly: true }>} */
const grantedRoots = []

function normalized(path) {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
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
  return root
}

/** @returns {Array<{ id: string, name: string, path: string, kind: 'granted', readOnly: true }>} */
export function grantedRootList() {
  return grantedRoots.map((root) => ({ ...root }))
}

/** 测试用：清空登记表。 */
export function clearGrantedRoots() {
  grantedRoots.length = 0
}
