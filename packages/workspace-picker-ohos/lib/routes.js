/**
 * 工作区选择对话框的 HTTP 路由（Host 面）。
 *
 * 为什么单独成路由而不是扩展 `directoryPicker/list`：上游的列表结果类型
 * （`DirectoryListing`）没有“需要授权”这一态，把授权塞进 list 的失败路径会让客户端
 * 无法区分「目录不存在」与「没有权限」。于是：
 *   - 列表/新建仍走 `ctx.directoryPicker` 原语（`list` / `createDirectory`）；
 *   - 授权状态与授权动作走本文件的路由（只查不申请 / 用户显式申请）。
 *
 * 全部路由先过 `ctx.connection.requestRejection(req)`（与 `open-in-app-ohos` 同口径），
 * 请求体限长 64 KB，响应一律 `cache-control: no-store`。
 *
 * 路由：
 *   GET  /_ohos/picker/roots              -> { roots: [{id,name,path,kind,permission,granted}] }
 *   POST /_ohos/picker/list               -> { ok, listing } | { ok:false, error }
 *   POST /_ohos/picker/create             -> { ok, path }    | { ok:false, error }
 *   POST /_ohos/picker/permission         -> { rootId, permission, granted, detail }
 *   POST /_ohos/picker/permission/request -> { rootId, permission, granted, detail }
 *   POST /_ohos/picker/import             -> { ok, dir, files, cancelled } | { ok:false, error }
 */

import { invoke as invokeHost, USER_CHOICE_TIMEOUT_MS } from '@dsh-ohos/host-bridge'
import { registerGrantedRoot } from './granted-roots.js'

/** 路由前缀（对话框客户端据此调用）。 */
export const PICKER_ROUTE_PREFIX = '/_ohos/picker'

/** 请求体上限：路径与目录名都是短字符串。 */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * 发送 JSON。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * 读取限长请求体。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string | null>} `null` = 超限
 */
function readBoundedBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 解析 JSON 请求体（非对象与空体都拒绝）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readJsonBody(req) {
  const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') return null
  const text = await readBoundedBody(req)
  if (text === null || text === '') return null
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 把 picker 的失败映射成路由响应（保留原 code/路径，不做统一化）。
 * @param {unknown} error
 */
function failurePayload(error) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'directory-unreadable',
      message: error instanceof Error ? error.message : String(error),
      path: typeof error?.path === 'string' ? error.path : '',
      permissionRequired: error?.permissionRequired === true,
      permission: typeof error?.permission === 'string' ? error.permission : '',
      // 设备上没有该目录（与「没授权」不同）：客户端显示「目录不存在」，不给授权按钮。
      missing: error?.missing === true,
    },
  }
}

/**
 * 注册全部路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 已注入 `webServer` / `connection` 的作用域
 * @param {import('./index.js').OhosDirectoryPicker} picker
 */
export function registerPickerRoutes(ctx, picker) {
  const connection = ctx.connection
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    throw new Error('workspace-picker: ctx.connection.requestRejection is required')
  }
  const rejected = (req, res) => {
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** 根清单 + 每个根的授权状态（`granted: null` = 无法判定）。 */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${PICKER_ROUTE_PREFIX}/roots`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use GET' } })
            return
          }
          const roots = []
          for (const root of picker.rootsDescriptor()) {
            const state = await picker.permission(root.id)
            roots.push({
              ...root,
              granted: state.granted,
              result: state.result,
              missing: state.result === 'missing',
              permissionDetail: state.detail,
            })
          }
          sendJson(res, 200, { routes: PICKER_ROUTE_PREFIX, roots })
        },
      }),
    'workspace-picker: GET roots',
  )

  /** 列一层目录（失败时带 permissionRequired，客户端据此渲染授权按钮）。 */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${PICKER_ROUTE_PREFIX}/list`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
            return
          }
          const body = await readJsonBody(req)
          if (body === null) {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'body must be a JSON object' } })
            return
          }
          const path = typeof body.path === 'string' ? body.path : undefined
          try {
            const listing = await picker.list(path)
            sendJson(res, 200, { ok: true, listing })
          } catch (error) {
            sendJson(res, 200, failurePayload(error))
          }
        },
      }),
    'workspace-picker: POST list',
  )

  /** 新建一个子目录。 */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${PICKER_ROUTE_PREFIX}/create`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
            return
          }
          const body = await readJsonBody(req)
          if (body === null || typeof body.path !== 'string' || typeof body.name !== 'string') {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'body needs string path and name' } })
            return
          }
          try {
            const created = await picker.createDirectory(body.path, body.name)
            sendJson(res, 200, { ok: true, path: created })
          } catch (error) {
            sendJson(res, 200, failurePayload(error))
          }
        },
      }),
    'workspace-picker: POST create',
  )

  /** 查权限（**只查不申请**）。 */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${PICKER_ROUTE_PREFIX}/permission`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
            return
          }
          const body = await readJsonBody(req)
          if (body === null || typeof body.rootId !== 'string') {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'body needs string rootId' } })
            return
          }
          sendJson(res, 200, await picker.permission(body.rootId))
        },
      }),
    'workspace-picker: POST permission',
  )

  /** 申请权限（用户点「请求权限」才会走到这里，会弹系统授权窗）。 */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${PICKER_ROUTE_PREFIX}/permission/request`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
            return
          }
          const body = await readJsonBody(req)
          if (body === null || typeof body.rootId !== 'string') {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'body needs string rootId' } })
            return
          }
          sendJson(res, 200, await picker.requestPermission(body.rootId))
        },
      }),
    'workspace-picker: POST permission/request',
  )

  /**
   * 用**系统文件选择器**把手机上的文件导入沙箱工作区。
   *
   * 为什么需要它：手机形态下平台只向白名单应用开放「文档/下载」目录授权
   * （系统日志 `isSupportDirectoryPG=false` ⇒ `authResult=2`），任何第三方应用都申请不到
   * 目录权限；而文件选择器给的是单次文件授权，且对所有应用可用。选中后由 ArkTS 侧
   * （`fs.pickFiles`）把文件拷贝进沙箱，之后 Node 侧读写不再需要任何权限。
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${PICKER_ROUTE_PREFIX}/import`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
            return
          }
          const body = await readJsonBody(req)
          if (body === null) {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'body must be a JSON object' } })
            return
          }
          const args = {}
          if (typeof body.targetDir === 'string' && body.targetDir !== '') args.targetDir = body.targetDir
          if (typeof body.maxCount === 'number' && Number.isFinite(body.maxCount)) args.maxCount = body.maxCount
          try {
            const reply = await invokeHost('fs.pickFiles', args, { timeoutMs: USER_CHOICE_TIMEOUT_MS })
            if (reply?.ok !== true) {
              sendJson(res, 200, {
                ok: false,
                error: {
                  code: 'import-failed',
                  message: typeof reply?.hint === 'string' ? reply.hint : 'fs.pickFiles did not answer ok:true',
                },
              })
              return
            }
            sendJson(res, 200, {
              ok: true,
              dir: typeof reply.dir === 'string' ? reply.dir : '',
              cancelled: reply.cancelled === true,
              files: Array.isArray(reply.files) ? reply.files : [],
            })
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: {
                code: 'import-failed',
                message: error instanceof Error ? error.message : String(error),
              },
            })
          }
        },
      }),
    'workspace-picker: POST import',
  )

  /**
   * 只读工作区（`POST /_ohos/picker/pick-folder`）。
   *
   * 手机形态下目录权限被平台白名单挡住（见 docs/ACL配置.md §7），但设备 syscap 里带
   * `SystemCapability.FileManagement.UserFileService.FolderSelection`，系统选择器确实能选
   * **文件夹**。选中后拿到的是 `file://docs/...` URI，而 libnode 只认路径，所以宿主把 URI
   * 映射成真实路径并回 `{ ok, cancelled, probes: [{ uri, mapped, pathReadable, pathEntries }] }`。
   *
   * 「安全访问」在手机上只给**只读**授予，所以选中的目录按只读工作区挂载：这里把它登记成
   * 额外根（否则后续 list 会被固定根围栏判成越界），并把结果原样透传给客户端。
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${PICKER_ROUTE_PREFIX}/pick-folder`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
            return
          }
          try {
            const reply = await invokeHost('fs.pickFolder', {}, { timeoutMs: USER_CHOICE_TIMEOUT_MS })
            const payload = reply ?? { ok: false, error: { code: 'pick-failed', message: 'no reply' } }
            // 选中的目录要登记成额外根，否则后续 list 会被「固定根」围栏判成越界：
            // 系统给的是真实路径（…/HO_DATA_EXT_MISC/Documents），固定根是 …/Documents。
            if (payload.ok === true && Array.isArray(payload.probes)) {
              for (const probe of payload.probes) {
                if (probe !== null && typeof probe === 'object' && probe.pathReadable === true && typeof probe.mapped === 'string') {
                  registerGrantedRoot(probe.mapped)
                }
              }
            }
            sendJson(res, 200, payload)
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: { code: 'pick-failed', message: error instanceof Error ? error.message : String(error) },
            })
          }
        },
      }),
    'workspace-picker: POST pick-folder',
  )
}
