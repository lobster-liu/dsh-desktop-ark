/**
 * `@dsh-ohos/speech-to-text` — DSH 的语音转写 provider，用**鸿蒙系统语音识别**
 * （`@kit.CoreSpeechKit` 的 `speechRecognizer`，离线模型，系统自带）而不是随包的
 * SenseVoice。
 *
 * 为什么换 provider：上游 `dsh-experimental-speech-to-text-sensevoice` 通过
 * `sherpa-onnx-node` 的 `.node` 原生插件跑 ONNX 推理，而 sherpa-onnx 只为
 * darwin/linux/win 发布预编译二进制，**没有 OHOS 版本**（载荷里只有 .js），
 * libnode 里 `require('sherpa-onnx-node')` 必然失败。系统语音识别是设备自带的
 * 离线引擎，不需要下载 239MB 模型，也不需要原生扩展。
 *
 * 数据流（复用上游的整条链路，只替换 provider）：
 *   ArkWeb 页面 getUserMedia + MediaRecorder
 *     → 重采样成 16 kHz 单声道 PCM16 WAV（`dsh-experimental-client-ui-voice-input`）
 *     → base64 → `/api/…/transcribe`（`dsh-experimental-api-speech-to-text`）
 *     → `ctx.speechToText` 选中本 provider
 *     → 本模块：剥掉 WAV 头写成 .pcm，交给宿主桥 `speech.recognize`
 *     → ArkTS：`speechRecognizer` 逐块 `writeAudio` → `finish` → 文本
 *
 * @module @dsh-ohos/speech-to-text
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { invoke } from '@dsh-ohos/host-bridge'
import { registerMicTestRoute } from './mic-route.js'
import { registerSpeakRoute } from './speak-route.js'
import { registerRecordRoute } from './record-route.js'
import { registerRecognizeRoute } from './recognize-route.js'
import { registerCloudAsrRoute } from './cloud-asr-route.js'

/** Cordis 插件名。 */
export const name = 'speech-to-text-ohos'

/** 需要 `ctx.speechToText`（由上游 `@deepseek-ai/dsh-experimental-speech-to-text` 提供）。 */
export const inject = ['speechToText']

/** 注册进注册表的 provider id（profile 里 `defaultProvider` 用的是这个字符串）。 */
export const PROVIDER_ID = 'ohos-local'

/**
 * 系统引擎只支持中文离线识别；`auto` 是上游服务默认值，必须接受。
 * 其余语言如实不声明（`selectedProvider()` 会拒绝不支持的语种）。
 */
export const LANGUAGES = ['auto', 'zh', 'en']

/** 单次识别上限：60 秒 16 kHz 单声道 PCM16。 */
export const MAX_PCM_BYTES = 60 * 16_000 * 2

/** 引擎固定采样率（Hz）；只用于把字节数换算成秒数。 */
export const PCM_SAMPLE_RATE = 16_000

/** 宿主桥调用超时：识别是同步跑完的，给足余量。 */
export const RECOGNIZE_TIMEOUT_MS = 120_000

/** 语音识别失败。 */
export class SpeechRecognitionError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, hint?: string, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'SpeechRecognitionError'
    if (details.code !== undefined) this.code = details.code
    if (details.hint !== undefined) this.hint = details.hint
  }
}

/**
 * 运行目录（`<files>/runtime`）。`DSH_HOME` 指向 `<files>/dsh-home`，它的父目录就是
 * 应用沙箱的 files 目录 —— 与 `DshRuntime.ets` 交给 libnode 的 `homeDir` 一致，也是
 * ArkTS 侧 `speech.recognize` 认得的绝对路径。
 * @returns {string}
 */
export function runtimeDir() {
  const home = process.env.DSH_HOME ?? process.env.DSH_OHOS_HOME ?? ''
  return home === '' ? '' : join(dirname(home), 'runtime')
}

/**
 * 从规范化 WAV 里取出 PCM 数据段；不是 WAV 就原样当作 PCM。
 * @param {Uint8Array|Buffer} audio
 * @returns {Buffer}
 */
export function pcmOf(audio) {
  const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio.buffer ?? audio, audio.byteOffset ?? 0, audio.byteLength)
  const isWave = buffer.length > 44
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WAVE'
    && buffer.toString('ascii', 36, 40) === 'data'
  return isWave ? buffer.subarray(44) : buffer
}

/**
 * 把一段 PCM 交给 ArkTS 的 `speech.recognize`。
 * @param {Buffer} pcm
 * @param {string} language
 * @param {{ signal?: AbortSignal, invoke?: typeof invoke, dir?: string }} [options]
 * @returns {Promise<string>} 识别文本（可能为空串）
 */
export async function recognize(pcm, language, options = {}) {
  if (pcm.length === 0) throw new SpeechRecognitionError('没有可识别的音频', { code: 'speech-empty' })
  if (pcm.length > MAX_PCM_BYTES) {
    throw new SpeechRecognitionError(`录音过长（${pcm.length} 字节 > ${MAX_PCM_BYTES}）`, { code: 'speech-too-long' })
  }
  const dir = options.dir ?? runtimeDir()
  if (dir === '') throw new SpeechRecognitionError('找不到运行目录（DSH_HOME 未设置）', { code: 'speech-no-home' })
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `voice-${Date.now()}-${randomBytes(3).toString('hex')}.pcm`)
  writeFileSync(file, pcm, { mode: 0o600 })
  const call = options.invoke ?? invoke
  try {
    const reply = await call('speech.recognize', { path: file, language }, {
      timeoutMs: RECOGNIZE_TIMEOUT_MS,
      signal: options.signal
    })
    if (reply?.ok === false) {
      throw new SpeechRecognitionError(
        String(reply.error ?? '系统语音识别失败'),
        { code: String(reply.code ?? 'speech-failed'), hint: reply.hint === undefined ? undefined : String(reply.hint) }
      )
    }
    return typeof reply?.text === 'string' ? reply.text.trim() : ''
  } finally {
    rmSync(file, { force: true })
  }
}

/**
 * 挂载 provider。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => {
    const unregister = ctx.speechToText.register({
      info: {
        id: PROVIDER_ID,
        name: '系统语音识别（HarmonyOS 离线）',
        location: 'host-local',
        languages: LANGUAGES
      },
      transcribe: async (input, signal) => {
        signal?.throwIfAborted?.()
        const pcm = pcmOf(input.audio)
        const startedAt = Date.now()
        const text = await recognize(pcm, input.language, { signal })
        signal?.throwIfAborted?.()
        // 上游 `Transcript` 契约（packages/experimental/speech-to-text/src/types.ts:108）：
        // 必须返回 { text, audioSeconds, inferenceSeconds }，只返回字符串会让消费端
        // `result.value.text` 变成 undefined，前端随后 `undefined.replace(...)` 崩掉
        // （2026-11-23 真机页面报 “Cannot read properties of undefined (reading 'replace')”）。
        return {
          text,
          audioSeconds: pcm.length / (PCM_SAMPLE_RATE * 2),
          inferenceSeconds: (Date.now() - startedAt) / 1000
        }
      }
    })
    return async () => {
      await unregister()
    }
  })
  ctx.inject(['webServer', 'connection'], (scoped) => registerMicTestRoute(scoped))
  ctx.inject(['webServer', 'connection'], (scoped) => registerSpeakRoute(scoped))
  ctx.inject(['webServer', 'connection'], (scoped) => registerRecordRoute(scoped))
  ctx.inject(['webServer', 'connection'], (scoped) => registerRecognizeRoute(scoped))
  ctx.inject(['webServer', 'connection'], (scoped) => registerCloudAsrRoute(scoped))
}

/**
 * 注意：**不要**再 `export default apply`。
 *
 * Cordis 加载插件时若拿到 `default`，就只把那个函数当插件、丢掉同模块的
 * `inject` / `name` 导出；于是 `ctx.speechToText` 变成「未声明注入」的属性读取，
 * 直接抛 `cannot get property "speechToText" without inject`
 * （2026-11-23 真机 node.log 实证）。同目录其它 seam 插件也只做命名导出。
 */
