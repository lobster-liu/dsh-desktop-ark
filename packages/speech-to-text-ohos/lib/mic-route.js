/**
 * 麦克风自检路由（Host 面）：`POST /_ohos/speech/mic-test`
 *
 * 存在的原因：ArkWeb 的 `getUserMedia` 在这台设备上拿到的 track 立刻 `ended`，
 * 前端的 `MediaRecorder.start()` 直接 `NotSupportedError`。要在不重编前端的前提下
 * 判断「是 ArkWeb 的音频参数被拒」还是「应用域根本录不到音」，需要一个能从页面直接
 * 触发的 ArkTS 侧抓音探针 —— 就是这个路由（调用宿主能力 `speech.micTest`）。
 *
 * 返回：`{ ok, frames, samples, peak, rms, error?, code? }`（原样透传宿主结果）。
 *
 * @module @dsh-ohos/speech-to-text/mic-route
 */

import { invoke as invokeHost } from '@dsh-ohos/host-bridge'

/** 路由路径。 */
export const MIC_TEST_PATH = '/_ohos/speech/mic-test'

/** 抓音最长 5 秒，留足余量。 */
const MIC_TEST_TIMEOUT_MS = 30_000

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
 * 注册路由（需要 `webServer` / `connection`）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerMicTestRoute(ctx) {
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
        path: MIC_TEST_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
            return
          }
          try {
            const reply = await invokeHost('speech.micTest', { durationMs: 1500 }, { timeoutMs: MIC_TEST_TIMEOUT_MS })
            sendJson(res, 200, reply ?? { ok: false, error: 'empty-reply' })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }
      }),
    'speech-to-text-ohos: POST mic-test'
  )
}
