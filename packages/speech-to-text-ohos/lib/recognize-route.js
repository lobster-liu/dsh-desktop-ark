/**
 * 识别路由（Host 面）：`POST /_ohos/speech/recognize`
 *
 * 页面侧与调试脚本不用经过通话面板就能验证「一段 PCM 能不能识别成字」：
 * 先 `POST /_ohos/speech/record` 拿 `path`，再把它交给本路由。
 *
 * 入参：`{ path: string, language?: 'zh'|'en' }`
 * 返回：宿主 `SpeechRecognizeResult` 原样透传 `{ ok, text?, error?, code?, hint? }`
 *
 * @module @dsh-ohos/speech-to-text/recognize-route
 */

import { invoke as invokeHost } from '@dsh-ohos/host-bridge'

/** 路由路径。 */
export const RECOGNIZE_PATH = '/_ohos/speech/recognize'

/** 识别要按 40 ms/1280 B 的节奏喂音频，6 秒录音约需 7 秒，另留余量。 */
const RECOGNIZE_TIMEOUT_MS = 120_000

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
 * 读取请求体里的 JSON。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 注册路由（需要 `webServer` / `connection`）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerRecognizeRoute(ctx) {
  const connection = ctx.connection
  const rejected = (req, res) => {
    const rejection = connection?.requestRejection?.(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RECOGNIZE_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
            return
          }
          const body = await readJson(req)
          const path = typeof body.path === 'string' ? body.path : ''
          if (path === '') {
            sendJson(res, 400, { ok: false, error: { code: 'missing-path', message: 'body.path is required' } })
            return
          }
          const args = {
            path,
            language: typeof body.language === 'string' ? body.language : 'zh'
          }
          try {
            const reply = await invokeHost('speech.recognize', args, { timeoutMs: RECOGNIZE_TIMEOUT_MS })
            const result = typeof reply === 'string' ? JSON.parse(reply) : reply
            sendJson(res, 200, result ?? { ok: false, error: 'empty-reply' })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }
      }),
    'speech-to-text-ohos: POST recognize'
  )
}
