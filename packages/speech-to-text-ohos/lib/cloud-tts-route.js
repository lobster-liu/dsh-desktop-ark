/**
 * 云端朗读（Host 面）：`POST /_ohos/speech/cloud-tts` 合成，`GET /_ohos/speech/tts-audio?id=…` 取音频
 *
 * 为什么要绕一圈文件：两家云端（阿里云百炼 Qwen3-TTS / CosyVoice）都**先返回一个 24 小时有效的
 * OSS 签名 URL**（`output.audio.url`），而不是二进制音频流。页面里的 `Audio` 直接吃那个 URL 会
 * 撞 CORS / 跨域，所以由 Host 侧下载回字节、落进运行目录，再由页面同源拉 `/_ohos/speech/tts-audio`。
 *
 * 支持的模型（按模型名分流协议，`ttsBase` 可改成业务空间域名）：
 *  · `qwen3-tts-flash`（及 `qwen-tts` 系列）：`POST {ttsBase}/services/aigc/multimodal-generation/generation`
 *  · `cosyvoice-v3.5-flash` / `cosyvoice-v3-plus` …：`POST {ttsBase}/services/audio/tts/SpeechSynthesizer`
 *    （CosyVoice 必须用业务空间域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1`）
 *
 * @module @dsh-ohos/speech-to-text/cloud-tts-route
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readSettings } from './voice-settings.js'

/** 合成入口。 */
export const CLOUD_TTS_PATH = '/_ohos/speech/cloud-tts'

/** 音频回放入口（页面 `Audio` 用）。 */
export const TTS_AUDIO_PATH = '/_ohos/speech/tts-audio'

/** Qwen-TTS 单次上限（官方文档：600 字符）。 */
const QWEN_TEXT_LIMIT = 600

/** 临时音频保留时长（毫秒）：超时即删，避免沙箱里堆文件。 */
const KEEP_MS = 10 * 60 * 1000

/**
 * 发 JSON。
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
 * 读请求体 JSON。
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
 * 运行目录（`<files>/runtime`）。
 * @returns {string}
 */
function runtimeDir() {
  const home = process.env.DSH_HOME ?? process.env.DSH_OHOS_HOME ?? ''
  return home === '' ? '' : join(dirname(home), 'runtime')
}

/**
 * 清掉过期的临时音频。
 * @param {string} dir
 */
function sweep(dir) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.startsWith('tts-')) continue
    const file = join(dir, name)
    try {
      if (now - statSync(file).mtimeMs > KEEP_MS) unlinkSync(file)
    } catch {
      // 忽略：删不掉就留着，下一轮再试。
    }
  }
}

/**
 * 从上游错误体里提炼一句人能读的原因。
 * @param {string} raw
 * @returns {string}
 */
function reasonOf(raw) {
  if (!raw) {
    return ''
  }
  try {
    const parsed = JSON.parse(raw)
    const error = parsed?.error ?? parsed
    const code = String(error?.code ?? '')
    const message = String(error?.message ?? '')
    const joined = [code, message].filter((part) => part !== '').join(' · ')
    return joined === '' ? '' : `：${joined.slice(0, 240)}`
  } catch (failure) {
    return `：${raw.slice(0, 160)}`
  }
}

/**
 * 从阿里云响应里取音频：优先 URL，其次 Base64。
 * @param {unknown} parsed
 * @returns {{ url: string, data: string, ext: string }}
 */
function audioOf(parsed) {
  const audio = /** @type {any} */ (parsed)?.output?.audio ?? {}
  const url = typeof audio.url === 'string' ? audio.url : ''
  const data = typeof audio.data === 'string' ? audio.data : ''
  let ext = 'wav'
  if (url !== '') {
    const match = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(url)
    if (match !== null) ext = match[1].toLowerCase()
  }
  return { url, data, ext }
}

/**
 * 调用云端合成，返回音频字节。
 * @param {string} text
 * @param {{ key: string, ttsBase: string, ttsModel: string, ttsVoice: string }} cloud
 * @returns {Promise<{ bytes: Buffer, ext: string, model: string, ms: number, chars: number }>}
 */
export async function synthesizeCloud(text, cloud) {
  const startedAt = Date.now()
  const base = cloud.ttsBase.replace(/\/+$/, '')
  const model = cloud.ttsModel
  const cosy = /^cosyvoice/i.test(model)
  const spoken = cosy ? text : text.slice(0, QWEN_TEXT_LIMIT)
  const url = cosy
    ? `${base}/services/audio/tts/SpeechSynthesizer`
    : `${base}/services/aigc/multimodal-generation/generation`
  const body = cosy
    ? { model, input: { text: spoken, voice: cloud.ttsVoice, format: 'wav', sample_rate: 24000 } }
    : { model, input: { text: spoken, voice: cloud.ttsVoice, language_type: 'Chinese' } }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cloud.key}`,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify(body)
  })
  const raw = Buffer.from(await response.arrayBuffer()).toString('utf8')
  if (!response.ok) {
    throw new Error(`云端合成失败 HTTP ${response.status}${reasonOf(raw)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('云端合成返回了非 JSON 内容')
  }
  const audio = audioOf(parsed)
  if (audio.url !== '') {
    const download = await fetch(audio.url)
    if (!download.ok) throw new Error(`下载合成音频失败 HTTP ${download.status}`)
    const bytes = Buffer.from(await download.arrayBuffer())
    return { bytes, ext: audio.ext, model, ms: Date.now() - startedAt, chars: spoken.length }
  }
  if (audio.data !== '') {
    return {
      bytes: Buffer.from(audio.data, 'base64'),
      ext: cosy ? 'wav' : 'wav',
      model,
      ms: Date.now() - startedAt,
      chars: spoken.length
    }
  }
  throw new Error(`云端没有返回音频：${raw.slice(0, 300)}`)
}

/**
 * 注册合成与回放两条路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerCloudTtsRoute(ctx) {
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
        path: CLOUD_TTS_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
            return
          }
          const body = await readJson(req)
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (text === '') {
            sendJson(res, 400, { ok: false, error: { code: 'missing-text', message: 'body.text is required' } })
            return
          }
          const settings = readSettings()
          const cloud = settings.cloud
          if (cloud.key === '') {
            sendJson(res, 401, {
              ok: false,
              error: { code: 'speech/no-cloud-tts', message: '还没有配置云端服务的 API Key（语音设置里填）' }
            })
            return
          }
          const dir = runtimeDir()
          if (dir === '') {
            sendJson(res, 500, { ok: false, error: { code: 'no-runtime-dir', message: '找不到运行目录' } })
            return
          }
          try {
            mkdirSync(dir, { recursive: true })
            sweep(dir)
            const result = await synthesizeCloud(text, cloud)
            const id = `tts-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
            const name = `${id}.${result.ext === '' ? 'wav' : result.ext}`
            writeFileSync(join(dir, name), result.bytes)
            sendJson(res, 200, {
              ok: true,
              id: name,
              url: `${TTS_AUDIO_PATH}?id=${encodeURIComponent(name)}`,
              bytes: result.bytes.length,
              chars: result.chars,
              ms: result.ms,
              model: result.model
            })
          } catch (error) {
            sendJson(res, 502, {
              ok: false,
              error: { code: 'speech/cloud-tts-failed', message: String(error?.message ?? error) }
            })
          }
        }
      }),
    'speech-to-text-ohos: POST cloud tts'
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: TTS_AUDIO_PATH,
        handler: (req, res) => {
          if (rejected(req, res)) return
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const id = url.searchParams.get('id') ?? ''
          const dir = runtimeDir()
          if (!/^tts-[a-z0-9-]+\.(wav|mp3|pcm|ogg)$/i.test(id) || dir === '') {
            sendJson(res, 400, { ok: false, error: { code: 'bad-id', message: 'id 不合法' } })
            return
          }
          const file = join(dir, id)
          if (!existsSync(file)) {
            sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '音频已过期，请重新朗读' } })
            return
          }
          const lower = id.toLowerCase()
          const type = lower.endsWith('.mp3')
            ? 'audio/mpeg'
            : lower.endsWith('.ogg')
              ? 'audio/ogg'
              : lower.endsWith('.pcm')
                ? 'audio/L16'
                : 'audio/wav'
          res.statusCode = 200
          res.setHeader('content-type', type)
          res.setHeader('cache-control', 'no-store')
          res.end(readFileSync(file))
        }
      }),
    'speech-to-text-ohos: GET tts audio'
  )
}
