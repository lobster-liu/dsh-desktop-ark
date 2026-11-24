/**
 * 语音设置（ArkTS 面）：与 Node 侧 `packages/speech-to-text-ohos/lib/voice-settings.js` 读同一份文件
 *
 * `<files>/runtime/voice-settings.json`。页面用它来决定：
 *   · 录音的「停顿多久算说完」（`pause` → VAD 静音阈值）；
 *   · 识别走云端还是系统离线（`recognizer`）；
 *   · 朗读走系统 TTS 还是云端合成（`voice`）。
 *
 * Node 侧的 `/_ohos/speech/settings` 也是同一份数据的读写入口（设置面板保存后两边即时一致）。
 */

import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

const TAG: string = 'VoiceSettings';

/** 云端服务（阿里云百炼默认值；换成别的 OpenAI 兼容服务只改 base/model）。 */
export interface CloudVoiceSettings {
  key: string;
  asrBase: string;
  asrModel: string;
  ttsBase: string;
  ttsModel: string;
  ttsVoice: string;
}

/** 语音设置。 */
export interface VoiceSettings {
  recognizer: string;
  voice: string;
  pause: string;
  cloud: CloudVoiceSettings;
}

/** 默认设置（与 Node 侧 `DEFAULT_SETTINGS` 一致）。 */
export function defaultVoiceSettings(): VoiceSettings {
  const cloud: CloudVoiceSettings = {
    key: '',
    asrBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    asrModel: 'qwen3-asr-flash',
    ttsBase: 'https://dashscope.aliyuncs.com/api/v1',
    ttsModel: 'qwen3-tts-flash',
    ttsVoice: 'Cherry'
  };
  const settings: VoiceSettings = { recognizer: 'auto', voice: 'system', pause: 'normal', cloud: cloud };
  return settings;
}

/** 设置文件路径。 */
export function voiceSettingsPath(context: common.UIAbilityContext): string {
  return `${context.filesDir}/runtime/voice-settings.json`;
}

/** 把任意 JSON 值收成字符串（缺字段时用回退值）。 */
function pick(source: Record<string, Object>, key: string, fallback: string): string {
  const value: Object | undefined = source[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  const text: string = String(value).trim();
  return text === '' ? fallback : text;
}

/** 读对象里的子对象。 */
function objectOf(source: Record<string, Object>, key: string): Record<string, Object> {
  const value: Object | undefined = source[key];
  if (value === undefined || value === null || typeof value !== 'object') {
    return {};
  }
  return value as Record<string, Object>;
}

/** 规范化：坏值一律回默认，保证 UI 与 Node 侧看到同一套值。 */
export function normalizeVoiceSettings(raw: Object | undefined): VoiceSettings {
  const fallback: VoiceSettings = defaultVoiceSettings();
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return fallback;
  }
  const source: Record<string, Object> = raw as Record<string, Object>;
  const cloudIn: Record<string, Object> = objectOf(source, 'cloud');
  let recognizer: string = pick(source, 'recognizer', fallback.recognizer);
  if (recognizer !== 'auto' && recognizer !== 'deepseek' && recognizer !== 'cloud' && recognizer !== 'system') {
    recognizer = fallback.recognizer;
  }
  let voice: string = pick(source, 'voice', fallback.voice);
  if (voice !== 'system' && voice !== 'cloud') {
    voice = fallback.voice;
  }
  let pause: string = pick(source, 'pause', fallback.pause);
  if (pause !== 'quick' && pause !== 'normal' && pause !== 'patient') {
    pause = fallback.pause;
  }
  const cloud: CloudVoiceSettings = {
    key: pick(cloudIn, 'key', fallback.cloud.key),
    asrBase: pick(cloudIn, 'asrBase', fallback.cloud.asrBase),
    asrModel: pick(cloudIn, 'asrModel', fallback.cloud.asrModel),
    ttsBase: pick(cloudIn, 'ttsBase', fallback.cloud.ttsBase),
    ttsModel: pick(cloudIn, 'ttsModel', fallback.cloud.ttsModel),
    ttsVoice: pick(cloudIn, 'ttsVoice', fallback.cloud.ttsVoice)
  };
  const settings: VoiceSettings = { recognizer: recognizer, voice: voice, pause: pause, cloud: cloud };
  return settings;
}

/** 读设置（文件缺失/损坏都回默认）。 */
export function readVoiceSettings(context: common.UIAbilityContext): VoiceSettings {
  const path: string = voiceSettingsPath(context);
  try {
    if (!fs.accessSync(path)) {
      return defaultVoiceSettings();
    }
    const text: string = fs.readTextSync(path);
    return normalizeVoiceSettings(JSON.parse(text) as Object);
  } catch (error) {
    const failed: BusinessError = error as BusinessError;
    hilog.warn(0x0000, TAG, 'read failed: %{public}s', failed.message);
    return defaultVoiceSettings();
  }
}

/** 写设置（目录不存在时自动建）。 */
export function writeVoiceSettings(context: common.UIAbilityContext, settings: VoiceSettings): boolean {
  const path: string = voiceSettingsPath(context);
  try {
    const dir: string = `${context.filesDir}/runtime`;
    if (!fs.accessSync(dir)) {
      fs.mkdirSync(dir);
    }
    const file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, JSON.stringify(settings));
    } finally {
      fs.closeSync(file);
    }
    return true;
  } catch (error) {
    const failed: BusinessError = error as BusinessError;
    hilog.error(0x0000, TAG, 'write failed: %{public}s', failed.message);
    return false;
  }
}

/**
 * 「停顿多久算说完」→ VAD 静音阈值（毫秒）。
 *
 * 与 DSH Go 的 `CallPause { quick: 0, normal: 400, patient: 1000 }` 对齐意图，但我们的
 * VAD 需要「至少这么久的静音才收尾」，所以整体上调一档：用户点「快」也能听清一句。
 */
export function pauseSilenceMs(pause: string): number {
  if (pause === 'quick') {
    return 500;
  }
  if (pause === 'patient') {
    return 1800;
  }
  return 900;
}

/** 设置项的中文标签（面板上显示用）。 */
export function pauseLabel(pause: string): string {
  if (pause === 'quick') {
    return '快（0.5 秒）';
  }
  if (pause === 'patient') {
    return '耐心（1.8 秒）';
  }
  return '普通（0.9 秒）';
}

/** 识别方式的中文标签。 */
export function recognizerLabel(mode: string): string {
  if (mode === 'system') {
    return '系统离线';
  }
  if (mode === 'cloud') {
    return '其他云端服务';
  }
  if (mode === 'deepseek') {
    return 'DeepSeek 账号';
  }
  return '自动（云端优先）';
}

/** 朗读方式的中文标签。 */
export function voiceLabel(mode: string): string {
  return mode === 'cloud' ? '云端合成' : '手机系统';
}
