/**
 * 语音合成路由（Host 面）：`POST /_ohos/speech/speak`
 *
 * 半双工通话要能把模型的回复念出来。录音采集、识别、条自动流程都在 ArkTS 侧
 * （`Index.ets` 的通话面板），但「朗读」这一步由这里暴露给页面/调试脚本，方便
 * 单独验证 TTS 是否可用（宿主能力 `speech.speak`）。
 *
 * 入参：`{ text: string, speed?: number, volume?: number, pitch?: number, lang?: string }`
 * 返回：`{ ok, chars?, error?, code? }`（原样透传宿主结果）
 *
 * @module @dsh-ohos/speech-to-text/speak-route
 */

import { invoke as invokeHost } from '@dsh-ohos/host-bridge'

/** 路由路径。 */
export const SPEAK_PATH = '/_ohos/speech/speak'

/** 朗读是阻塞到播完的：按字数给足余量（60 秒）。 */
const SPEAK_TIMEOUT_MS = 60_000

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
export function registerSpeakRoute(ctx) {
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
        path: SPEAK_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
            return
          }
          const body = await readJson(req)
          const text = typeof body.text === 'string' ? body.text : ''
          if (text.trim() === '') {
            sendJson(res, 400, { ok: false, error: { code: 'empty-text', message: 'body.text is required' } })
            return
          }
          const args = {
            text,
            speed: typeof body.speed === 'number' ? body.speed : undefined,
            volume: typeof body.volume === 'number' ? body.volume : undefined,
            pitch: typeof body.pitch === 'number' ? body.pitch : undefined,
            lang: typeof body.lang === 'string' ? body.lang : undefined
          }
          try {
            const reply = await invokeHost('speech.speak', args, { timeoutMs: SPEAK_TIMEOUT_MS })
            sendJson(res, 200, reply ?? { ok: false, error: 'empty-reply' })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }
      }),
    'speech-to-text-ohos: POST speak'
  )
}
