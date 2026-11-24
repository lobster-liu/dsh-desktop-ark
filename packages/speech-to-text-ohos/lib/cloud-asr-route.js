/**
 * 云端识别路由（Host 面）：`POST /_ohos/speech/cloud-asr`
 *
 * 系统离线引擎（`@kit.CoreSpeechKit`）的中文准确率有明显上限：同一段真机录音，
 * 离线引擎稳定给出 `什么信息还让我说识来识去？ Apple，你为什么语？`，而 DeepSeek
 * 云端 ASR 是同一个账号已经付过费的模型（DSH Go 的 `/dsh-go/v1/speech/asr` 就是这么做的，
 * 见 `runtime/bridge/dsh-go-bridge/lib/speech.js`）：**账号 token 不出引擎**，由 Host 侧
 * 用 `ctx.account.resolveToken()` 取一次性凭证，再以 `x-dsh-auth-token` 头转发。
 *
 * 入参：`{ path: string, language?: string }`（应用沙箱里的 16 kHz 单声道 PCM16 文件）
 * 或 `{ audioBase64: string }`。
 * 返回：`{ ok: true, text, engine: 'cloud', credential, ms }`；
 * 失败：`{ ok: false, error: { code, message } }`（调用方据此回退离线识别）。
 *
 * @module @dsh-ohos/speech-to-text/cloud-asr-route
 */

import { readFileSync } from 'node:fs'
import { readSettings, resolveRecognizer } from './voice-settings.js'

/** 路由路径。 */
export const CLOUD_ASR_PATH = '/_ohos/speech/cloud-asr'

/** 云端接口的官方源（不含路径）。 */
const OFFICIAL_ORIGIN = 'https://api.deepseek.com'

/** 上游上限：8 MiB / 120 秒。 */
const MAX_BYTES = 8 * 1024 * 1024

/** 云端 ASR 的采样率要求（16 kHz 单声道）。 */
const SAMPLE_RATE = 16_000

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
 * 从上游错误体里提炼一句人能读的原因（百炼的 `Model.AccessDenied` 之类）。
 * @param {string|undefined} detail
 * @returns {string}
 */
function upstreamMessage(detail) {
  if (!detail) {
    return ''
  }
  try {
    const parsed = JSON.parse(detail)
    const error = parsed?.error ?? parsed
    const code = String(error?.code ?? '')
    const message = String(error?.message ?? '')
    return [code, message].filter((part) => part !== '').join(' · ').slice(0, 240)
  } catch (failure) {
    return String(detail).slice(0, 160)
  }
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
 * 给裸 PCM16 套上 44 字节 WAV 头（云端只收 WAV/OGG）。
 * @param {Buffer} pcm
 * @returns {Buffer}
 */
export function wavOf(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * 把规范化 WAV 剥成裸 PCM；已是 PCM 就原样返回。
 * @param {Buffer} audio
 * @returns {Buffer}
 */
export function pcmOfAudio(audio) {
  const isWave = audio.length > 44
    && audio.toString('ascii', 0, 4) === 'RIFF'
    && audio.toString('ascii', 8, 12) === 'WAVE'
  return isWave ? audio.subarray(44) : audio
}

/**
 * 取这次请求该用的凭证。
 *
 * 顺序与 DSH Go 的桥一致：**账号优先**（免配置、已付费），其次本机 API key。
 * 两者都没有时返回 `{}`，调用方据此报 `speech/no-credential`。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} url
 * @returns {Promise<{ credential: 'account'|'api-key'|'none', headers: Record<string,string> }>}
 */
async function credentialFor(ctx, url) {
  try {
    const account = ctx.get('account')
    const token = await account?.resolveToken?.(url)
    if (typeof token === 'string' && token !== '') {
      return { credential: 'account', headers: { 'x-dsh-auth-token': token } }
    }
  } catch {
    // 未登录 / 账号服务不可用：继续试 API key。
  }
  for (const name of ['DEEPSEEK_API_KEY', 'DSH_DEEPSEEK_API_KEY']) {
    if (typeof process.env[name] !== 'string' || process.env[name] === '') continue
    return { credential: 'api-key', headers: { authorization: `Bearer ${process.env[name]}` } }
  }
  return { credential: 'none', headers: {} }
}

/**
 * 把 WAV 发给云端 ASR，返回识别文本。
 * @param {Buffer} wav
 * @param {{ ctx: unknown, origin?: string }} options
 * @returns {Promise<{ text: string, credential: string, status: number }>}
 */
export async function transcribeCloud(wav, options) {
  const ctx = /** @type {import('@deepseek-ai/cordis').Context} */ (options.ctx)
  const origin = options.origin ?? OFFICIAL_ORIGIN
  const url = `${origin.replace(/\/$/, '')}/v1/tools/asr`
  const { credential, headers } = await credentialFor(ctx, url)
  if (credential === 'none') {
    return { text: '', credential, status: 401 }
  }
  const boundary = `----dsh${Date.now().toString(16)}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\n`
    + 'Content-Type: audio/wav\r\n\r\n',
    'utf8'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const body = Buffer.concat([head, wav, tail])
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
      accept: 'application/json'
    },
    body
  })
  const raw = Buffer.from(await response.arrayBuffer()).toString('utf8')
  if (!response.ok) {
    return { text: '', credential, status: response.status, detail: raw.slice(0, 400) }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { text: '', credential, status: 502, detail: 'not-json' }
  }
  const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
  return { text, credential, status: response.status }
}

/**
 * 从 chat 响应的 `choices[0].message.content` 里取文本（可能是字符串或分段数组）。
 * @param {unknown} parsed
 * @returns {string}
 */
function chatTextOf(parsed) {
  const content = /** @type {any} */ (parsed)?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const pieces = []
    for (const part of content) {
      if (typeof part?.text === 'string') pieces.push(part.text)
      else if (typeof part === 'string') pieces.push(part)
    }
    return pieces.join('').trim()
  }
  // 阿里云原生形态：output.text / output.choices[0].message.content
  const native = /** @type {any} */ (parsed)?.output
  if (typeof native?.text === 'string') return native.text.trim()
  const nested = native?.choices?.[0]?.message?.content
  if (typeof nested === 'string') return nested.trim()
  return ''
}

/**
 * 自定义云端识别（「其他云端服务」），两种协议：
 *  · 百炼 Qwen3-ASR：OpenAI 兼容 `POST {base}/chat/completions`，音频以 Base64 data URI 放进消息；
 *  · 其他 OpenAI 兼容服务：`POST {base}/audio/transcriptions`（multipart `file` + `model`）。
 *
 * @param {Buffer} wav
 * @param {{ key: string, asrBase: string, asrModel: string }} cloud
 * @returns {Promise<{ text: string, credential: string, status: number, detail?: string, protocol?: string }>}
 */
export async function transcribeCustom(wav, cloud) {
  const base = cloud.asrBase.replace(/\/+$/, '')
  const model = cloud.asrModel
  const auth = { authorization: `Bearer ${cloud.key}` }
  const qwen = /^qwen/i.test(model)
  if (qwen) {
    const url = `${base}/chat/completions`
    const body = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` } }
          ]
        }
      ],
      stream: false,
      asr_options: { language: 'zh' }
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    })
    const raw = Buffer.from(await response.arrayBuffer()).toString('utf8')
    if (!response.ok) {
      return { text: '', credential: 'api-key', status: response.status, detail: raw.slice(0, 400), protocol: 'qwen-chat' }
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { text: '', credential: 'api-key', status: 502, detail: 'not-json', protocol: 'qwen-chat' }
    }
    return { text: chatTextOf(parsed), credential: 'api-key', status: response.status, protocol: 'qwen-chat' }
  }
  const url = `${base}/audio/transcriptions`
  const boundary = `----dsh${Date.now().toString(16)}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\n`
    + 'Content-Type: audio/wav\r\n\r\n',
    'utf8'
  )
  const modelField = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}`,
    'utf8'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const body = Buffer.concat([head, wav, modelField, tail])
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...auth,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
      accept: 'application/json'
    },
    body
  })
  const raw = Buffer.from(await response.arrayBuffer()).toString('utf8')
  if (!response.ok) {
    return { text: '', credential: 'api-key', status: response.status, detail: raw.slice(0, 400), protocol: 'transcriptions' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { text: '', credential: 'api-key', status: 502, detail: 'not-json', protocol: 'transcriptions' }
  }
  let text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
  if (text === '') text = chatTextOf(parsed)
  return { text, credential: 'api-key', status: response.status, protocol: 'transcriptions' }
}

/**
 * 按设置里选中的「识别方式」决定走哪条路。
 *
 * `system` 时调用方应直接用系统离线引擎（这里不发请求）；`cloud` 走用户配的云端服务；
 * `deepseek` 走账号凭证（原行为）。
 *
 * @param {Buffer} wav
 * @param {{ ctx: unknown }} options
 * @returns {Promise<{ provider: 'system'|'cloud'|'deepseek', text: string, credential: string, status: number, detail?: string, protocol?: string }>}
 */
export async function transcribeWithSettings(wav, options) {
  const settings = readSettings()
  const provider = resolveRecognizer(settings)
  if (provider === 'system') {
    return { provider, text: '', credential: 'none', status: 0 }
  }
  if (provider === 'cloud') {
    const result = await transcribeCustom(wav, settings.cloud)
    return { provider, ...result }
  }
  const result = await transcribeCloud(wav, options)
  return { provider, ...result }
}

/**
 * 注册路由（需要 `webServer` / `connection`；`account` 取不到就降级）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerCloudAsrRoute(ctx) {
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
        path: CLOUD_ASR_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
            return
          }
          const body = await readJson(req)
          /** @type {Buffer} */
          let pcm
          try {
            if (typeof body.path === 'string' && body.path !== '') {
              pcm = pcmOfAudio(readFileSync(body.path))
            } else if (typeof body.audioBase64 === 'string' && body.audioBase64 !== '') {
              pcm = pcmOfAudio(Buffer.from(body.audioBase64, 'base64'))
            } else {
              sendJson(res, 400, { ok: false, error: { code: 'missing-audio', message: 'body.path or body.audioBase64 is required' } })
              return
            }
          } catch (error) {
            sendJson(res, 400, { ok: false, error: { code: 'read-failed', message: String(error?.message ?? error) } })
            return
          }
          if (pcm.length === 0) {
            sendJson(res, 400, { ok: false, error: { code: 'empty-audio', message: 'recording is empty' } })
            return
          }
          const startedAt = Date.now()
          try {
            const result = await transcribeWithSettings(wavOf(pcm), { ctx })
            if (result.provider === 'system') {
              sendJson(res, 409, {
                ok: false,
                provider: result.provider,
                error: { code: 'speech/provider-system', message: '识别方式设置为「系统离线」，请直接在设备上识别' }
              })
              return
            }
            if (result.credential === 'none') {
              sendJson(res, 401, {
                ok: false,
                provider: result.provider,
                error: { code: 'speech/no-credential', message: '没有可用于云端识别的账号或 API key' }
              })
              return
            }
            if (result.status !== 200) {
              const reason = upstreamMessage(result.detail)
              sendJson(res, 502, {
                ok: false,
                provider: result.provider,
                error: {
                  code: 'speech/upstream',
                  message: `云端识别失败 HTTP ${result.status}${reason === '' ? '' : '：' + reason}`
                },
                detail: result.detail ?? ''
              })
              return
            }
            if (result.text === '') {
              sendJson(res, 502, {
                ok: false,
                provider: result.provider,
                error: { code: 'speech/empty-text', message: '云端没有返回文本' },
                detail: result.detail ?? ''
              })
              return
            }
            sendJson(res, 200, {
              ok: true,
              text: result.text,
              engine: 'cloud',
              provider: result.provider,
              protocol: result.protocol ?? 'account',
              credential: result.credential,
              ms: Date.now() - startedAt,
              bytes: pcm.length
            })
          } catch (error) {
            sendJson(res, 502, {
              ok: false,
              error: { code: 'speech/cloud-failed', message: String(error?.message ?? error) }
            })
          }
        }
      }),
    'speech-to-text-ohos: POST cloud asr'
  )
}
