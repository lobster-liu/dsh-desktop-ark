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

/**
 * 每段合成的目标字符数：CosyVoice 的合成速度实测约 8 字/秒（200 字 ≈ 25 秒），
 * 一次塞整段会让页面等几十秒；切成小段并行合成再拼起来，首字节快得多。
 */
const COSY_CHUNK = 120
const QWEN_CHUNK = 300

/** 一次朗读最多合成多少字（超出部分截断，避免为一段超长回复等上一分钟）。 */
const SPOKEN_LIMIT = 1200

/** 单段合成的超时（毫秒）。 */
const CHUNK_TIMEOUT_MS = 90 * 1000

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
 * 把长文本切成适合单次合成的段：优先在句末标点断开，其次逗号，最后硬切。
 * @param {string} text
 * @param {number} size
 * @returns {string[]}
 */
export function splitSpeech(text, size) {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '') return []
  const budget = size > 20 ? size : 20
  const pieces = []
  let rest = clean.slice(0, SPOKEN_LIMIT)
  while (rest.length > budget) {
    const window = rest.slice(0, budget + 20)
    let cut = -1
    const stops = ['。', '！', '？', '；', '，', '、', '.', '!', '?', ';', ',', '\n']
    for (const mark of stops) {
      const at = window.lastIndexOf(mark)
      if (at >= budget * 0.5 && at > cut) cut = at
    }
    if (cut < 0) cut = budget - 1
    const piece = rest.slice(0, cut + 1).trim()
    if (piece !== '') pieces.push(piece)
    rest = rest.slice(cut + 1).trim()
  }
  if (rest !== '') pieces.push(rest)
  return pieces
}

/**
 * 解析 WAV：拿到 fmt 块与 data 块。
 * @param {Buffer} wav
 * @returns {{ fmt: Buffer, data: Buffer } | null}
 */
function parseWav(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    return null
  }
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const body = wav.subarray(offset + 8, Math.min(offset + 8 + size, wav.length))
    if (id === 'fmt ') fmt = body
    if (id === 'data') data = body
    offset += 8 + size + (size % 2)
  }
  if (fmt === null || data === null) return null
  return { fmt, data }
}

/**
 * 把多段 WAV 的 PCM 拼成一个 WAV（各段模型相同，格式一致）。
 * @param {Buffer[]} wavs
 * @returns {Buffer}
 */
export function concatWav(wavs) {
  const parsed = []
  for (const wav of wavs) {
    const parts = parseWav(wav)
    if (parts === null) return Buffer.concat(wavs)
    parsed.push(parts)
  }
  if (parsed.length === 0) return Buffer.alloc(0)
  const fmt = parsed[0].fmt
  const pcm = Buffer.concat(parsed.map((parts) => parts.data))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(fmt.length, 16)
  fmt.copy(header, 20)
  const dataAt = 20 + fmt.length
  header.write('data', dataAt, 'ascii')
  header.writeUInt32LE(pcm.length, dataAt + 4)
  return Buffer.concat([header.subarray(0, dataAt + 8), pcm])
}

/**
 * 合成一段文本（带超时）。
 * @param {string} spoken
 * @param {{ key: string, ttsBase: string, ttsModel: string, ttsVoice: string }} cloud
 * @param {boolean} cosy
 * @returns {Promise<{ bytes: Buffer, ext: string }>}
 */
async function synthesizeChunk(spoken, cloud, cosy) {
  const base = cloud.ttsBase.replace(/\/+$/, '')
  const model = cloud.ttsModel
  const url = cosy
    ? `${base}/services/audio/tts/SpeechSynthesizer`
    : `${base}/services/aigc/multimodal-generation/generation`
  const body = cosy
    ? { model, input: { text: spoken, voice: cloud.ttsVoice, format: 'wav', sample_rate: 24000 } }
    : { model, input: { text: spoken, voice: cloud.ttsVoice, language_type: 'Chinese' } }
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cloud.key}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS)
    })
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? `上游 ${CHUNK_TIMEOUT_MS / 1000} 秒无响应` : String(error?.message ?? error)
    throw new Error(`云端合成失败（${spoken.length} 字）：${reason}`)
  }
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
    const download = await fetch(audio.url, { signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS) })
    if (!download.ok) throw new Error(`下载合成音频失败 HTTP ${download.status}`)
    return { bytes: Buffer.from(await download.arrayBuffer()), ext: audio.ext }
  }
  if (audio.data !== '') {
    return { bytes: Buffer.from(audio.data, 'base64'), ext: 'wav' }
  }
  throw new Error(`云端没有返回音频：${raw.slice(0, 300)}`)
}

/**
 * 并发跑一组异步任务，保持结果顺序。
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @returns {Promise<T[]>}
 */
async function mapLimit(tasks, limit) {
  const results = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const index = next
      next += 1
      results[index] = await tasks[index]()
    }
  }
  const workers = []
  for (let i = 0; i < Math.min(limit, tasks.length); i += 1) workers.push(worker())
  await Promise.all(workers)
  return results
}

/**
 * 调用云端合成，返回音频字节。长文本按标点切成小段，并发合成后拼接。
 * @param {string} text
 * @param {{ key: string, ttsBase: string, ttsModel: string, ttsVoice: string }} cloud
 * @returns {Promise<{ bytes: Buffer, ext: string, model: string, ms: number, chars: number, chunks: number }>}
 */
export async function synthesizeCloud(text, cloud) {
  const startedAt = Date.now()
  const model = cloud.ttsModel
  const cosy = /^cosyvoice/i.test(model)
  const pieceSize = cosy ? COSY_CHUNK : Math.min(QWEN_CHUNK, QWEN_TEXT_LIMIT)
  const pieces = splitSpeech(text, pieceSize)
  if (pieces.length === 0) {
    throw new Error('没有可朗读的文本')
  }
  const audios = await mapLimit(
    pieces.map((piece, index) => async () => {
      try {
        const audio = await synthesizeChunk(piece, cloud, cosy)
        return audio.bytes
      } catch (error) {
        const message = String(error?.message ?? error)
        console.warn(`[speech-to-text-ohos] 合成第 ${index + 1}/${pieces.length} 段失败：${message}`)
        throw new Error(message)
      }
    }),
    3
  )
  const bytes = audios.length === 1 ? audios[0] : concatWav(audios)
  return {
    bytes,
    ext: 'wav',
    model,
    ms: Date.now() - startedAt,
    chars: pieces.join('').length,
    chunks: audios.length
  }
}

/**
 * 注册合成与回放两条路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
/**
 * 把回复文本收成「念得出来」的形状。
 *
 * 真机教训（2026-11-25）：模型偶尔只回一个表情（😄 / 👌），CosyVoice 和 Qwen 都会回
 * `HTTP 400 InvalidParameter · Please ensure input text is valid`，面板于是红字报
 * 「云端合成失败」。这种文本本来也没什么可念的，先剥掉代码块、Markdown 标记和表情符号，
 * 再判断还剩没剩下能读的字。
 */
const SPEAKABLE_CHAR = /[0-9A-Za-z\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/

export function speakableText(text) {
  let clean = String(text ?? '')
  clean = clean.replace(/```[\s\S]*?```/g, ' ')
  clean = clean.replace(/`([^`\n]*)`/g, '$1')
  clean = clean.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  clean = clean.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  clean = clean.replace(/^[ \t]*[#>*+-]+[ \t]*/gm, ' ')
  clean = clean.replace(/[*_~]{1,3}/g, '')
  clean = clean.replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}]/gu, ' ')
  clean = clean.replace(/[ \t\r\n]+/g, ' ')
  return clean.trim()
}

export function hasSpeakableText(text) {
  return SPEAKABLE_CHAR.test(speakableText(text))
}

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
          const raw = typeof body.text === 'string' ? body.text : ''
          if (raw.trim() === '') {
            sendJson(res, 400, { ok: false, error: { code: 'missing-text', message: 'body.text is required' } })
            return
          }
          // 只有表情/符号的回复：上游一定 400，提前挡掉，让面板「静默跳过朗读」。
          if (!hasSpeakableText(raw)) {
            sendJson(res, 422, {
              ok: false,
              error: {
                code: 'speech/no-speakable-text',
                message: '这段回复里没有可朗读的文字（只有表情或符号）'
              }
            })
            return
          }
          const text = speakableText(raw)
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
              chunks: result.chunks,
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
