/**
 * 语音设置（Host 面）：`GET/POST /_ohos/speech/settings`
 *
 * 设置存在应用沙箱的 `<files>/runtime/voice-settings.json` 里，ArkTS 页面与 Node 侧读同一份：
 *   · 页面（`VoiceSettings.ets`）读它来决定「停顿多久算说完」与走系统还是云端朗读；
 *   · 本模块的云端路由读它来决定识别/朗读走哪家服务。
 *
 * 与 DSH Go 的设置项（`devdump\dsh-go-app\app\lib\speech\speech_settings.dart`、
 * `app\lib\state\voice_settings.dart`）对齐，但只保留我们真能用的：
 *   · `recognizer`：auto | deepseek | cloud | system（识别方式）
 *   · `voice`：system | cloud（朗读用系统 TTS 还是云端语音合成）
 *   · `pause`：quick | normal | patient（停顿多久算说完，映射到录音 VAD 的静音阈值）
 *   · `cloud`：自定义「其他云端服务」（阿里云百炼默认值），OpenAI 兼容 / 百炼协议都能走
 *
 * @module @dsh-ohos/speech-to-text/voice-settings
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 路由路径（GET 读、POST 存）。 */
export const VOICE_SETTINGS_PATH = '/_ohos/speech/settings'

/** 默认设置：阿里云百炼的 OpenAI 兼容识别 + Qwen3-TTS 朗读。 */
export const DEFAULT_SETTINGS = {
  recognizer: 'auto',
  voice: 'system',
  pause: 'normal',
  mic: 'auto',
  caption: 'off',
  cloud: {
    key: '',
    asrBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    asrModel: 'qwen3-asr-flash',
    ttsBase: 'https://dashscope.aliyuncs.com/api/v1',
    ttsModel: 'qwen3-tts-flash',
    ttsVoice: 'Cherry'
  }
}

/** 允许的取值：读盘时逐项校验，坏值一律回默认。 */
const RECOGNIZERS = ['auto', 'deepseek', 'cloud', 'system']
const VOICES = ['system', 'cloud']
const PAUSES = ['quick', 'normal', 'patient']
/** 麦克风策略：auto（手机麦优先）/ bluetooth（蓝牙耳机优先）/ phone（只用手机麦）。 */
const MICS = ['auto', 'bluetooth', 'phone']
/** 实时字幕开关：on 边说边显字（流式识别）/ off 录完再识别。 */
const CAPTIONS = ['on', 'off']

/**
 * 运行目录（`<files>/runtime`），与 `runtimeDir()` 一致：`DSH_HOME` 是 `<files>/dsh-home`。
 * @returns {string}
 */
function runtimeDir() {
  const home = process.env.DSH_HOME ?? process.env.DSH_OHOS_HOME ?? ''
  return home === '' ? '' : join(dirname(home), 'runtime')
}

/**
 * 设置文件路径。
 * @returns {string}
 */
export function settingsFile() {
  const dir = runtimeDir()
  return dir === '' ? '' : join(dir, 'voice-settings.json')
}

/**
 * 把任意外部值收成一个字符串。
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 业务空间专属域名（`https://ws-xxxx.cn-beijing.maas.aliyuncs.com/...`）与公共域名是两套 key：
 * 用户只填了识别 Base 时，把朗读 Base 一起挪到同一个域名下（仍是 `/api/v1`），省得两边对不上报 403。
 * @param {string} asrBase
 * @param {string} ttsBase
 * @returns {string}
 */
export function deriveTtsBase(asrBase, ttsBase) {
  const fallback = DEFAULT_SETTINGS.cloud.ttsBase
  try {
    const asr = new URL(asrBase)
    const tts = new URL(ttsBase === '' ? fallback : ttsBase)
    const publicHost = 'dashscope.aliyuncs.com'
    if (asr.origin !== tts.origin && tts.hostname === publicHost && asr.hostname !== publicHost) {
      return `${asr.origin}/api/v1`
    }
    return ttsBase === '' ? fallback : ttsBase
  } catch (error) {
    return ttsBase === '' ? fallback : ttsBase
  }
}

/**
 * 校验并补全设置（坏值回默认）。
 * @param {unknown} raw
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function normalizeSettings(raw) {
  const input = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const cloudIn = input.cloud !== null && typeof input.cloud === 'object'
    ? /** @type {Record<string, unknown>} */ (input.cloud)
    : {}
  const recognizer = RECOGNIZERS.includes(String(input.recognizer)) ? String(input.recognizer) : DEFAULT_SETTINGS.recognizer
  const voice = VOICES.includes(String(input.voice)) ? String(input.voice) : DEFAULT_SETTINGS.voice
  const pause = PAUSES.includes(String(input.pause)) ? String(input.pause) : DEFAULT_SETTINGS.pause
  const mic = MICS.includes(String(input.mic)) ? String(input.mic) : DEFAULT_SETTINGS.mic
  const caption = CAPTIONS.includes(String(input.caption)) ? String(input.caption) : DEFAULT_SETTINGS.caption
  const asrBase = text(cloudIn.asrBase) || DEFAULT_SETTINGS.cloud.asrBase
  return {
    recognizer,
    voice,
    pause,
    mic,
    caption,
    cloud: {
      key: text(cloudIn.key),
      asrBase,
      asrModel: text(cloudIn.asrModel) || DEFAULT_SETTINGS.cloud.asrModel,
      ttsBase: deriveTtsBase(asrBase, text(cloudIn.ttsBase)),
      ttsModel: text(cloudIn.ttsModel) || DEFAULT_SETTINGS.cloud.ttsModel,
      ttsVoice: text(cloudIn.ttsVoice) || DEFAULT_SETTINGS.cloud.ttsVoice
    }
  }
}

/**
 * 读设置（文件不存在 / 坏 JSON 都回默认）。
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function readSettings() {
  const file = settingsFile()
  if (file === '' || !existsSync(file)) return normalizeSettings({})
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return normalizeSettings({})
  }
}

/**
 * 写设置（`patch` 与现有值深合并后落盘），返回合并后的完整设置。
 * @param {Record<string, unknown>} patch
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function writeSettings(patch) {
  const file = settingsFile()
  if (file === '') throw new Error('找不到运行目录（DSH_HOME 未设置）')
  const before = readSettings()
  const next = normalizeSettings({
    ...before,
    ...patch,
    cloud: { ...before.cloud, ...(patch?.cloud !== null && typeof patch?.cloud === 'object' ? patch.cloud : {}) }
  })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return next
}

/**
 * 这次识别该用哪家服务。
 *
 * `auto`：云端自定义服务配好了（有 key + 模型）就用它，否则用 DeepSeek 账号（原行为）。
 * @param {typeof DEFAULT_SETTINGS} settings
 * @returns {'system'|'cloud'|'deepseek'}
 */
export function resolveRecognizer(settings) {
  if (settings.recognizer === 'system') return 'system'
  const ready = settings.cloud.key !== '' && settings.cloud.asrModel !== ''
  if (settings.recognizer === 'cloud') return 'cloud'
  if (settings.recognizer === 'auto') return ready ? 'cloud' : 'deepseek'
  return 'deepseek'
}

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
 * 注册设置路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerVoiceSettingsRoute(ctx) {
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
        path: VOICE_SETTINGS_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, settings: readSettings() })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use GET or POST' } })
            return
          }
          const body = await readJson(req)
          try {
            const settings = writeSettings(body)
            sendJson(res, 200, { ok: true, settings })
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              error: { code: 'settings-write-failed', message: String(error?.message ?? error) }
            })
          }
        }
      }),
    'speech-to-text-ohos: voice settings'
  )
}
