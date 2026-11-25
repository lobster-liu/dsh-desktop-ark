/**
 * 录音路由（Host 面）：`POST /_ohos/speech/record`
 *
 * 用途一：给「声学回环」自测用 —— 让喇叭念一句（`/_ohos/speech/speak`）的同时从
 * 麦克风录回来（本路由），再把 PCM 交给 `speech.recognize`，就能在没有真人说话的
 * 情况下验证采集与识别链路。
 * 用途二：页面侧调试时可以直接录音拿电平统计（字节数 / 采样率 / 峰值 / RMS）。
 *
 * 入参：`{ durationMs?: number }`（默认 6000，宿主侧夹在 1000–20000）
 * 返回：宿主 `RecordResult` 原样透传 `{ ok, path, bytes, durationMs, sampleRate, peak, rms, error?, code? }`
 *
 * @module @dsh-ohos/speech-to-text/record-route
 */

import { invoke as invokeHost } from '@dsh-ohos/host-bridge'

/** 路由路径。 */
export const RECORD_PATH = '/_ohos/speech/record'

/** 录音是阻塞到时长结束的：多给 15 秒余量。 */
const RECORD_TIMEOUT_MS = 40_000

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
export function registerRecordRoute(ctx) {
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
        path: RECORD_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
            return
          }
          const body = await readJson(req)
          const durationMs = typeof body.durationMs === 'number' ? body.durationMs : 6000
          // 调试时经常要试「哪路麦克风」：把面板用的那几个参数一起透传，才能在不点面板的情况下复现。
          const args = {
            durationMs,
            ...(typeof body.maxMs === 'number' ? { maxMs: body.maxMs } : {}),
            ...(typeof body.silenceMs === 'number' ? { silenceMs: body.silenceMs } : {}),
            ...(typeof body.minVoicedMs === 'number' ? { minVoicedMs: body.minVoicedMs } : {}),
            ...(typeof body.autoStop === 'boolean' ? { autoStop: body.autoStop } : {}),
            ...(typeof body.mic === 'string' ? { mic: body.mic } : {})
          }
          try {
            const reply = await invokeHost('speech.record', args, { timeoutMs: RECORD_TIMEOUT_MS })
            const result = typeof reply === 'string' ? JSON.parse(reply) : reply
            sendJson(res, 200, result ?? { ok: false, error: 'empty-reply' })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }
      }),
    'speech-to-text-ohos: POST record'
  )
}
