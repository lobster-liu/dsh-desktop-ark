import { BusinessError } from '@kit.BasicServicesKit';
import { abilityAccessCtrl, bundleManager, common, PermissionRequestResult, Permissions, Want } from '@kit.AbilityKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { speechRecognizer, textToSpeech } from '@kit.CoreSpeechKit';
import { audio } from '@kit.AudioKit';
import { HostBridge } from '@fellow99/node-bridge';
import { Constants } from '../common/Constants';
import { resolve as resolveNodeMode } from '../common/NodeMode';

interface NameArgs {
  name?: string;
}

interface NamesArgs {
  names?: string[];
}

interface UriArgs {
  uri?: string;
}

/** `fs.pickFiles` 入参：把用户选中的文件**拷贝**进沙箱目录后返回落点。 */
interface PickFilesArgs {
  targetDir?: string;
  maxCount?: number;
}

interface PickedFile {
  name: string;
  path: string;
  size: number;
}

interface PickFilesResult {
  ok: boolean;
  dir: string;
  files: PickedFile[];
  cancelled: boolean;
}

/** `fs.pickFolder` 的单个结果：uri、映射出的真实路径、是否可读。 */
interface FolderProbe {
  uri: string;
  mapped: string;
  /** 映射路径可读（`fs.accessSync`）。libnode 只认路径，这个才是工作区能不能用的判据。 */
  pathReadable: boolean;
  /** 映射路径里能列出的条目数（-1 表示列不出来）。 */
  pathEntries: number;
  pathError?: string;
}

interface PickFolderResult {
  ok: boolean;
  cancelled: boolean;
  probes: FolderProbe[];
  error?: string;
}

/**
 * `speech.recognize` 入参：`path` 指向 **PCM16 / 16 kHz / 单声道** 裸数据文件。
 *
 * 为什么走文件而不是把音频塞进 JSON：一次 30 秒录音是 ~960 KB 的 PCM，
 * base64 后 1.3 MB 会让信箱里的单个请求文件过大；写文件再把路径交给 ArkTS 更稳。
 */
interface SpeechRecognizeArgs {
  path?: string;
  language?: string;
}

interface SpeechRecognizeResult {
  ok: boolean;
  text?: string;
  error?: string;
  code?: string;
  hint?: string;
}

/** `speech.micTest` 入参：抓多久、用哪种采样率。 */
interface MicTestArgs {
  durationMs?: number;
  sampleRate?: number;
}

/** `speech.micTest` 结果：样本层面的证据（frames > 0 且 samples > 0 才算真拿到音频）。 */
interface MicTestResult {
  ok: boolean;
  frames: number;
  samples: number;
  peak: number;
  rms: number;
  error?: string;
  code?: string;
}

/** `speech.record` 入参：录多久（毫秒），或「说多久录多久」。 */
interface RecordArgs {
  durationMs?: number;
  mode?: string;
  /** 自适应模式：说到停顿就自动停（默认开启）。 */
  autoStop?: boolean;
  /** 最长录多久（默认 30000ms，上限 120000ms）。 */
  maxMs?: number;
  /** 说完多久没声音就停（默认 900ms）。 */
  silenceMs?: number;
  /** 至少检测到这么多毫秒的人声才允许自动停（默认 400ms）。 */
  minVoicedMs?: number;
  /** 人声判定阈值（RMS，0-32767）；不给就按本底噪声自适应。 */
  threshold?: number;
  /** 蓝牙优先时，蓝牙麦多少毫秒内没听到人声就回落手机麦（默认 2500ms）。 */
  probeMs?: number;
  /** 麦克风策略：auto（手机麦优先）/ bluetooth（蓝牙优先）/ phone（只用手机麦）。 */
  mic?: string;
}

/** 一次录音的停止原因：说完自动停 / 到了时长上限 / 字节上限。 */
interface CaptureOptions {
  autoStop: boolean;
  maxMs: number;
  silenceMs: number;
  minVoicedMs: number;
  threshold: number;
  /**
   * 蓝牙优先用：这么多毫秒内一句话都没听到就收尾（stopReason = silent-probe），
   * 调用方随即改用手机麦重录同一段，避免把开头几个字丢在静音的蓝牙通路上。
   */
  probeMs?: number;
}

/** `speech.record` 结果：PCM 文件落在应用沙箱里。 */
interface RecordResult {
  ok: boolean;
  input?: string;
  path?: string;
  bytes?: number;
  durationMs?: number;
  sampleRate?: number;
  peak?: number;
  rms?: number;
  /** 停下来的原因：silence（说完）/ max（到上限）/ bytes（到字节上限）。 */
  stopReason?: string;
  /** 检测到人声的累计毫秒。 */
  voicedMs?: number;
  error?: string;
  code?: string;
}

/** `speech.speak` 入参：要朗读的文本与语音参数。 */
interface SpeakArgs {
  text?: string;
  speed?: number;
  volume?: number;
  pitch?: number;
  lang?: string;
}

/** `speech.speak` 结果：朗读结束（或失败）时返回。 */
/** 一次录音的结果统计（内部用）。 */
interface CaptureStats {
  bytes: number;
  peak: number;
  rms: number;
  rate: number;
  /** silence / max / bytes。 */
  stopReason: string;
  voicedMs: number;
  totalMs: number;
}
interface SpeakResult {
  ok: boolean;
  chars?: number;
  estimateMs?: number;
  error?: string;
  code?: string;
}

/** `image.normalize` 入参（与 `packages/attachment-image-ohos` 的调用面一致） */
interface ImageNormalizeArgs {
  data?: string;
  format?: string;
  quality?: number;
  rotate?: boolean;
  colourspace?: string;
  width?: number;
  height?: number;
  fit?: string;
  withoutEnlargement?: boolean;
  sourceFormat?: string;
}

/** `image.normalize` 成功信封（调用方要 base64 + 实际尺寸） */
interface ImageNormalizeResult {
  ok: boolean;
  data: string;
  format: string;
  width: number;
  height: number;
  channels: number;
}

interface LogArgs {
  level?: string;
  msg?: string;
}

/** 失败信封（封闭错误码集合，见 specs/overall-data-model.md §4.2） */
interface CapabilityError {
  ok: boolean;
  error: string;
  hint: string;
}

/** 成功但无载荷 */
interface OkResult {
  ok: boolean;
}

interface PermissionCheckResult {
  ok: boolean;
  granted: boolean;
}

interface PermissionReply {
  ok: boolean;
  authResults: number[];
  permissions: string[];
  /** 请求了几项（用于区分「平台返回空数组」与「参数没送到」） */
  requested: number;
  /** 平台返回的条目数；0 表示系统没有产生任何授权应答（多半是拒绝弹窗） */
  answered: number;
}

interface AppFacts {
  bundleName: string;
  versionName: string;
  versionCode: number;
}

interface NodeFacts {
  expected: string;
  abi: number;
}

interface PathFacts {
  filesDir: string;
  resourceDir: string;
  payloadRoot: string;
  assetRoot: string;
  dshHome: string;
  workspace: string;
  mailbox: string;
}

interface UserDirFact {
  id: string;
  path: string;
  available: boolean;
}

interface CapabilityStatus {
  name: string;
  status: string;
}

interface RuntimeFacts {
  schema: number;
  app: AppFacts;
  node: NodeFacts;
  paths: PathFacts;
  userDirs: UserDirFact[];
  jitless: boolean;
  capabilities: CapabilityStatus[];
}

/**
 * 宿主能力面（`specs/overall-data-model.md` §4）。
 *
 * 纪律：
 * - 入参与返回值都是 JSON **字符串**；
 * - 处理器永不抛异常（异常统一映射为 `internal`）；
 * - 未实现的能力注册为 `not-implemented` + 可执行提示，不返回伪成功。
 */
export class HostCapabilities {
  /**
   * 系统语音识别对 `writeAudio` 的硬约束：每次只能 640 或 1280 字节，且按 20/40 ms 的节奏送；
   * 一次性灌整个录音会被服务端判成 `1002200004 Finish recognition failed`。
   */
  private static readonly SPEECH_CHUNK_BYTES: number = 640;
  private static readonly SPEECH_CHUNK_PACE_MS: number = 20;
  /**
   * 单个识别会话喂给引擎的音频长度。
   *
   * 离线引擎一次只认得好几秒（真机实测：12.9 秒整段喂进一个会话，只回「状况。」三个字，
   * 而同一段音频云端 ASR 能听出整句）；把长录音切成几秒一段、每段单独开会话再拼文本，
   * 比让引擎硬扛整段稳。切分点的音素损失远小于整段崩掉。
   */
  /** 切段时优先落在停顿上：至少喂满 2 秒才开始找停顿，最多 6 秒硬切。 */
  private static readonly SPEECH_SEGMENT_MIN_BYTES: number = 16000 * 2 * 2;
  private static readonly SPEECH_SEGMENT_MAX_BYTES: number = 16000 * 2 * 6;
  /** 判定为「停顿」的块均方根（int16 采样，安静时通常 < 300）。 */
  private static readonly SPEECH_PAUSE_RMS: number = 400;

  /** 一块 PCM16 的均方根：用来找句间停顿，把识别会话切在没人说话的地方。 */
  private static chunkRms(bytes: Uint8Array): number {
    const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples: number = Math.floor(bytes.byteLength / 2);
    let sum: number = 0;
    for (let i = 0; i < samples; i++) {
      const value: number = view.getInt16(i * 2, true);
      sum += value * value;
    }
    if (samples === 0) {
      return 0;
    }
    return Math.sqrt(sum / samples);
  }

  /**
   * 蓝牙优先的重试闸门与上次可用的设备。
   *
   * 策略：每轮先让蓝牙麦说话（probeMs 内听到人声就一直用它，开头几个字也不丢）；
   * 听不到就当场切手机麦重录同一段，并且 5 分钟内不再浪费这 2.5 秒。
   */
  private static btRetryAt: number = 0;
  /** 上次听到人声的蓝牙设备 id；-1 表示还没有。 */
  private static btCandidateId: number = -1;

  private static delay(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(resolve, ms);
    });
  }
  /**
   * 注册全部能力（重复注册同名会覆盖，库的注册表语义）。
   * @param host - 库提供的宿主桥
   * @param context - UIAbility 上下文
   */
  static install(host: HostBridge, context: common.UIAbilityContext): void {
    host.register('runtime.facts', (_args: string): string => HostCapabilities.facts(context));
    host.register('log.hilog', (args: string): string => HostCapabilities.hilog(args));
    host.register('perm.check', (args: string): string => HostCapabilities.checkPermission(context, args));
    host.register('perm.request', (args: string): Promise<string> => HostCapabilities.requestPermission(context, args));
    host.register('perm.openAppInfo', (_args: string): Promise<string> => HostCapabilities.openAppInfo(context));
    host.register('shell.openExternal', (args: string): Promise<string> => HostCapabilities.openExternal(context, args));
    // 图像规范化（S4 的像素后端）：SharpPipeline 的每个像素操作都走这里。
    host.register('image.normalize', (args: string): Promise<string> => HostCapabilities.normalizeImage(context, args));
    // 系统文件选择器（手机形态下「文档/下载」目录授权被平台白名单挡住时的唯一可行入口）。
    host.register('fs.pickFiles', (args: string): Promise<string> => HostCapabilities.pickFiles(context, args));
    // 目录选择：手机形态能否选中「文档」下的某个文件夹并直接当工作区用，见 pickFolder 注释。
    host.register('fs.pickFolder', (args: string): Promise<string> => HostCapabilities.pickFolder(context, args));
    // 语音转写：DSH 的 speech provider 把录音写成 PCM 文件，这里交给系统离线识别引擎。
    host.register('speech.recognize', (args: string): Promise<string> => HostCapabilities.recognizeSpeech(context, args));
    host.register('speech.micTest', (args: string): Promise<string> => HostCapabilities.micTest(context, args));
    // 通话录音：把麦克风 PCM 直接写进沙箱文件，随后交给 speech.recognize。
    host.register('speech.record', (args: string): Promise<string> => HostCapabilities.record(context, args));
    // 语音合成：半双工通话里把模型的回复念出来（系统离线 TTS）。
    host.register('speech.speak', (args: string): Promise<string> => HostCapabilities.speak(context, args));
    host.register('speech.speakStop', (args: string): Promise<string> => HostCapabilities.stopSpeak());

    // 已注册但未实现：显式返回 not-implemented（宪法 C2）。
    HostCapabilities.notImplemented(host, 'fs.saveFile', '导出将在 P2 提供');
    HostCapabilities.notImplemented(host, 'notify.show', '通知桥将在 P2 接入 NotificationKit');
    HostCapabilities.notImplemented(host, 'clipboard.readImage', '剪贴板图片将在 P2 接入 pasteboard');
    HostCapabilities.notImplemented(host, 'clipboard.writeText', '剪贴板文本将在 P2 接入 pasteboard');
    HostCapabilities.notImplemented(host, 'power.keepAwake', '长时任务已由 backgroundModes 提供，运行锁将在 P2 接入');
  }

  /**
   * 图像规范化：base64 进 → 解码/缩放/编码 → base64 出。
   *
   * 契约与 `packages/attachment-image-ohos`（S4 的 sharp 替身）一致：
   * `{data, format, quality, width?, height?, withoutEnlargement?}` →
   * `{ok:true, data, format, width, height, channels}`。
   *
   * 像素操作全部在 ArkTS 侧（`@kit.ImageKit`）：jitless 下 WASM 不可用，纯 JS 解码大图
   * 代价过高；设备原生解码既快又能复用系统 ImageKit。
   */
  private static async normalizeImage(context: common.UIAbilityContext, args: string): Promise<string> {
    let source: image.ImageSource | null = null;
    let pixelMap: image.PixelMap | null = null;
    let packer: image.ImagePacker | null = null;
    try {
      const parsed: ImageNormalizeArgs = JSON.parse(args) as ImageNormalizeArgs;
      HostCapabilities.appLog(context, 'image.normalize in: ' + args.length + 'B format=' + String(parsed.format)
        + ' w=' + String(parsed.width) + ' h=' + String(parsed.height)
        + ' noEnlarge=' + String(parsed.withoutEnlargement));
      if (parsed.data === undefined || parsed.data === '') {
        const bad: CapabilityError = { ok: false, error: 'bad-args', hint: 'image.normalize 需要 data(base64)' };
        return JSON.stringify(bad);
      }
      const helper: util.Base64Helper = new util.Base64Helper();
      const bytes: Uint8Array = helper.decodeSync(parsed.data);
      const buffer: ArrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      source = image.createImageSource(buffer);
      const info: image.ImageInfo = await source.getImageInfo();
      const target: image.Size = HostCapabilities.fitInside(info.size, parsed);
      const decoding: image.DecodingOptions = { desiredSize: target, editable: false };
      pixelMap = await source.createPixelMap(decoding);
      HostCapabilities.appLog(context, 'image.normalize decode: src=' + info.size.width + 'x' + info.size.height
        + ' target=' + target.width + 'x' + target.height);

      const requested: string = HostCapabilities.packFormat(parsed.format);
      const quality: number = HostCapabilities.clampQuality(parsed.quality);
      packer = image.createImagePacker();
      let out: ArrayBuffer;
      let usedFormat: string = requested;
      try {
        const option: image.PackingOption = { format: requested, quality: quality };
        out = await packer.packing(pixelMap, option);
      } catch (encodeError) {
        // 部分设备不支持 WebP/PNG 编码 ⇒ 退 JPEG，并**如实**回报实际格式（不伪装）。
        usedFormat = 'image/jpeg';
        const fallback: image.PackingOption = { format: usedFormat, quality: quality };
        out = await packer.packing(pixelMap, fallback);
      }
      const encoded: string = helper.encodeToStringSync(new Uint8Array(out));
      HostCapabilities.appLog(context, 'image.normalize out: ' + out.byteLength + 'B format=' + usedFormat);
      const result: ImageNormalizeResult = {
        ok: true,
        data: encoded,
        format: HostCapabilities.formatName(usedFormat),
        width: target.width,
        height: target.height,
        channels: 4
      };
      return JSON.stringify(result);
    } catch (error) {
      HostCapabilities.appLog(context, 'image.normalize failed: ' + (error instanceof Error ? error.message : String(error)));
      return HostCapabilities.internal('image.normalize', error);
    } finally {
      if (pixelMap !== null) {
        try { await pixelMap.release(); } catch (e) { }
      }
      if (source !== null) {
        try { await source.release(); } catch (e) { }
      }
      if (packer !== null) {
        try { await packer.release(); } catch (e) { }
      }
    }
  }

  /** `fit: 'inside'` + `withoutEnlargement`（与 sharp 的默认语义一致）。 */
  private static fitInside(size: image.Size, args: ImageNormalizeArgs): image.Size {
    let targetW: number = size.width;
    let targetH: number = size.height;
    const w: number | undefined = args.width;
    const h: number | undefined = args.height;
    const hasW: boolean = w !== undefined && w > 0;
    const hasH: boolean = h !== undefined && h > 0;
    if (hasW || hasH) {
      const rw: number = hasW ? (w as number) / size.width : Number.POSITIVE_INFINITY;
      const rh: number = hasH ? (h as number) / size.height : Number.POSITIVE_INFINITY;
      const ratio: number = Math.min(rw, rh);
      const noEnlarge: boolean = args.withoutEnlargement !== false;
      const scale: number = noEnlarge ? Math.min(1, ratio) : ratio;
      if (Number.isFinite(scale)) {
        targetW = Math.max(1, Math.round(size.width * scale));
        targetH = Math.max(1, Math.round(size.height * scale));
      }
    }
    const result: image.Size = { width: targetW, height: targetH };
    return result;
  }

  private static packFormat(name: string | undefined): string {
    if (name === 'png') {
      return 'image/png';
    }
    if (name === 'webp') {
      return 'image/webp';
    }
    return 'image/jpeg';
  }

  private static formatName(mime: string): string {
    if (mime === 'image/png') {
      return 'png';
    }
    if (mime === 'image/webp') {
      return 'webp';
    }
    return 'jpeg';
  }

  private static clampQuality(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
      return 85;
    }
    return Math.max(1, Math.min(100, Math.round(value)));
  }

  /** 追加一行到 `app.log`（与 Node 侧同一份文件；诊断用，失败不影响业务）。 */
  private static appLog(context: common.UIAbilityContext, line: string): void {
    try {
      const path: string = Constants.appLogPath(context);
      const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.APPEND | fs.OpenMode.WRITE_ONLY);
      try {
        fs.writeSync(file.fd, new Date().toISOString() + ' HOST ' + line + String.fromCharCode(10));
      } finally {
        fs.closeSync(file);
      }
    } catch (e) {
      // 诊断写入失败不能影响能力调用
    }
  }

  /**
   * 系统离线语音识别（`@kit.CoreSpeechKit` 的 `speechRecognizer`）。
   *
   * 为什么不用随包的 SenseVoice：`sherpa-onnx-node` 只为 darwin/linux/win 发布
   * 原生 `.node`，没有 OHOS 版本；libnode 里 `require()` 必然失败。系统引擎是设备
   * 自带的离线模型（目前只支持 `zh-CN`），不需要下载 239 MB 权重。
   *
   * 音频契约：`path` 指向 PCM16 / 16000 Hz / 单声道裸数据（无 WAV 头），
   * 由 Node 侧 `@dsh-ohos/speech-to-text` 剥头后落盘。
   */
  /**
   * 麦克风自检：用 ArkTS `AudioCapturer` 直接抓一小段 PCM，报告帧数与峰值。
   *
   * 为什么要单独试一次：ArkWeb 的 `getUserMedia` 在这台设备上会走到
   * `AudioCapturer` 创建失败（hilog `CapturerInClientInner: Init stream failed: -62980116`），
   * 拿到的 track 立刻 `ended`，前端 `MediaRecorder.start()` 直接 `NotSupportedError`。
   * 只有用 ArkTS 侧独立抓一次，才能判断是「ArkWeb 的参数不被接受」还是
   * 「应用域根本拿不到麦克风」——两者的修法完全不同。
   */
  private static async micTest(context: common.UIAbilityContext, args: string): Promise<string> {
    let durationMs: number = 1500;
    let useSixteenKilo: boolean = false;
    try {
      const parsed: MicTestArgs = JSON.parse(args.length > 0 ? args : '{}') as MicTestArgs;
      if (typeof parsed.durationMs === 'number' && parsed.durationMs > 0) {
        durationMs = Math.min(parsed.durationMs, 5000);
      }
      useSixteenKilo = parsed.sampleRate === 16000;
    } catch (error) {
      const ignored: BusinessError = error as BusinessError;
      console.info(`[${Constants.HILOG_TAG}] speech.micTest 参数解析失败：${ignored.message}`);
    }
    const allowed: boolean = await HostCapabilities.ensureMicrophone(context);
    if (!allowed) {
      const denied: MicTestResult = {
        ok: false, frames: 0, samples: 0, peak: 0, rms: 0,
        error: 'microphone-permission', code: 'permission'
      };
      return JSON.stringify(denied);
    }
    const streamInfo: audio.AudioStreamInfo = {
      samplingRate: useSixteenKilo ? audio.AudioSamplingRate.SAMPLE_RATE_16000 : audio.AudioSamplingRate.SAMPLE_RATE_48000,
      channels: audio.AudioChannel.CHANNEL_1,
      sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
      encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
    };
    const capturerInfo: audio.AudioCapturerInfo = {
      source: audio.SourceType.SOURCE_TYPE_MIC,
      capturerFlags: 0
    };
    const options: audio.AudioCapturerOptions = { streamInfo, capturerInfo };
    let capturer: audio.AudioCapturer | null = null;
    let frames: number = 0;
    let samples: number = 0;
    let peak: number = 0;
    let sumSquares: number = 0;
    try {
      capturer = await audio.createAudioCapturer(options);
      capturer.on('readData', (buffer: ArrayBuffer): void => {
        frames += 1;
        const view: Int16Array = new Int16Array(buffer);
        samples += view.length;
        for (let i = 0; i < view.length; i++) {
          const value: number = view[i] / 32768;
          const magnitude: number = Math.abs(value);
          if (magnitude > peak) {
            peak = magnitude;
          }
          sumSquares += value * value;
        }
      });
      await capturer.start();
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, durationMs);
      });
      await capturer.stop();
      const rms: number = samples > 0 ? Math.sqrt(sumSquares / samples) : 0;
      const result: MicTestResult = {
        ok: samples > 0, frames, samples,
        peak: Math.round(peak * 10000) / 10000,
        rms: Math.round(rms * 10000) / 10000
      };
      console.info(`[${Constants.HILOG_TAG}] speech.micTest frames=${frames} samples=${samples} peak=${result.peak}`);
      return JSON.stringify(result);
    } catch (error) {
      const failed: BusinessError = error as BusinessError;
      const result: MicTestResult = {
        ok: false, frames, samples, peak: 0, rms: 0,
        error: failed.message, code: String(failed.code)
      };
      console.error(`[${Constants.HILOG_TAG}] speech.micTest 失败：${failed.code} ${failed.message}`);
      return JSON.stringify(result);
    } finally {
      if (capturer !== null) {
        try {
          capturer.release();
        } catch (error) {
          const ignored: BusinessError = error as BusinessError;
          console.info(`[${Constants.HILOG_TAG}] speech.micTest release 失败：${ignored.message}`);
        }
      }
    }
  }

  /**
   * 通话录音：录 `durationMs` 毫秒的单声道 16 kHz PCM16，写进 `<filesDir>/runtime/call-<ts>.pcm`。
   *
   * 为什么由 ArkTS 录而不是复用页面的 `MediaRecorder`：半双工通话的状态机在 ArkTS 侧
   * （`Index.ets` 的通话面板），录音结果要立刻交给系统识别引擎；页面侧录音还需要把
   * base64 传回宿主，多一次大块拷贝。这里录完直接给 `speech.recognize` 一个文件路径。
   */
  private static async record(context: common.UIAbilityContext, args: string): Promise<string> {
    try {
      await HostCapabilities.ensureMicrophone(context);
      const parsed: RecordArgs = JSON.parse(args) as RecordArgs;
      // 「说多久录多久」：maxMs 只是安全上限，真正的收尾靠静音检测。
      const maxMs: number = Math.min(Math.max(parsed.maxMs ?? parsed.durationMs ?? 30000, 1000), 120000);
      const options: CaptureOptions = {
        autoStop: parsed.autoStop ?? true,
        maxMs: maxMs,
        silenceMs: Math.min(Math.max(parsed.silenceMs ?? 900, 300), 4000),
        minVoicedMs: Math.min(Math.max(parsed.minVoicedMs ?? 400, 100), 4000),
        threshold: Math.max(parsed.threshold ?? 0, 0)
      };
      const runtimeDir: string = `${context.filesDir}/runtime`;
      if (!fs.accessSync(runtimeDir)) {
        fs.mkdirSync(runtimeDir);
      }
      const path: string = `${runtimeDir}/call-${Date.now()}.pcm`;
      const candidates: audio.AudioDeviceDescriptor[] = HostCapabilities.inputCandidates(context);
      const mode: string = parsed.mode ?? '';
      if (mode !== '') {
        return await HostCapabilities.recordTrial(context, path, maxMs, candidates, mode);
      }
      const phones: audio.AudioDeviceDescriptor[] = HostCapabilities.pickDevices(candidates, false);
      const bluetooths: audio.AudioDeviceDescriptor[] = HostCapabilities.pickDevices(candidates, true);
      const phone: audio.AudioDeviceDescriptor | null = phones.length > 0 ? phones[0] : null;
      // 麦克风策略（语音设置里可切）：
      //   auto（默认）  手机麦立刻开录；只有手机麦一个音节都没听到时才回头试蓝牙（罕见路径）。
      //   bluetooth     蓝牙优先：直接拿蓝牙麦开录，逐个设备真录，谁先听到人声就整轮用它。
      //                 真机取证（2026-11-23T14:03Z）：蓝牙麦 id=2587 收过 peak=23819、
      //                 voiced=8540ms 的整句；当时之所以能成功，是那一轮把设备挑对了。
      //                 现在蓝牙设备列表里常混着历史配对残留（id 2581/2584/2587 等），
      //                 不做「逐个试」就必然经常挑到死通道，看起来像「蓝牙又不行了」。
      //   phone         只用手机麦。
      const mic: string = parsed.mic ?? 'auto';
      let stats: CaptureStats | null = null;
      let input: string = 'phone';
      if (mic === 'bluetooth') {
        // 蓝牙麦的 SCO 链路经常是「睡着」的：系统在 CALL_INPUT_DEVICES 里根本不列它。
        // 真机取证（2026-11-25T02:25Z）：连着耳机时设备列表只有 type=15（手机麦）；
        // 但只要先做一次 VOICE_COMMUNICATION 采集，下一次枚举里就冒出 type=7 id=3822。
        // 所以蓝牙优先的第一步是「叫醒」，而不是直接去找设备。
        const session: audio.AudioSessionManager | null = await HostCapabilities.beginVoiceSession(context);
        // 会话一激活，`CALL_INPUT_DEVICES` 里通常就能看到蓝牙麦（panel64 真机日志：usage=8 type=7）。
        // 所以先直接枚举，只有枚举不到才去叫醒 —— 叫醒要额外丢 0.3 秒，正是「开头几个字没录到」的来源。
        const preparedAt: number = Date.now();
        HostCapabilities.logAllInputs(context);
        // 会话刚激活时设备列表偶尔还没刷新（真机日志里 usages=2/8 都列不到 type=7），
        // 等一口气再枚举，比直接叫醒（要多丢 0.3 秒）划算得多。
        await HostCapabilities.delay(120);
        let awake: audio.AudioDeviceDescriptor[] = HostCapabilities.pickDevices(
          HostCapabilities.listInputs(context, false), true);
        if (awake.length === 0) {
          await HostCapabilities.wakeSco(context);
          awake = HostCapabilities.pickDevices(HostCapabilities.listInputs(context, false), true);
          HostCapabilities.appLog(context, `speech.record 蓝牙叫醒后候选 ${awake.length} 个`);
        } else {
          HostCapabilities.appLog(context, `speech.record 蓝牙已在列表里，直接录（准备 ${Date.now() - preparedAt}ms）`);
        }
        const ordered: audio.AudioDeviceDescriptor[] = HostCapabilities.orderBluetooths(
          awake.length > 0 ? awake : bluetooths);
        for (let i = 0; i < ordered.length; i++) {
          if (stats !== null) {
            break;
          }
          const attempt: CaptureStats = await HostCapabilities.captureSpeech(context, path, options, ordered[i],
            audio.SourceType.SOURCE_TYPE_VOICE_COMMUNICATION);
          HostCapabilities.appLog(context,
            `speech.record 蓝牙尝试 id=${ordered[i].id} peak=${attempt.peak} voiced=${attempt.voicedMs}ms reason=${attempt.stopReason}`);
          if (attempt.voicedMs > 0) {
            stats = attempt;
            input = 'bluetooth';
            HostCapabilities.btCandidateId = ordered[i].id;
            HostCapabilities.btRetryAt = 0;
          }
        }
        if (stats === null) {
          HostCapabilities.appLog(context, 'speech.record 蓝牙麦全都没听到人声，改用手机麦');
        }
        await HostCapabilities.endVoiceSession(context, session);
      }
      if (stats === null) {
        stats = await HostCapabilities.captureSpeech(context, path, options, phone,
          audio.SourceType.SOURCE_TYPE_VOICE_RECOGNITION);
        input = 'phone';
      }
      if (mic === 'auto' && stats.voicedMs === 0 && bluetooths.length > 0
        && Date.now() >= HostCapabilities.btRetryAt) {
        HostCapabilities.appLog(context, 'speech.record 手机麦没听到人声，回头再试蓝牙麦');
        const ordered: audio.AudioDeviceDescriptor[] = HostCapabilities.orderBluetooths(bluetooths);
        const retryMaxMs: number = Math.min(maxMs, 8000);
        const retryOptions: CaptureOptions = {
          autoStop: true,
          maxMs: retryMaxMs,
          silenceMs: options.silenceMs,
          minVoicedMs: 200,
          threshold: 0
        };
        for (let i = 0; i < ordered.length; i++) {
          const attempt: CaptureStats = await HostCapabilities.captureSpeech(context, path, retryOptions,
            ordered[i], audio.SourceType.SOURCE_TYPE_VOICE_COMMUNICATION);
          HostCapabilities.appLog(context,
            `speech.record 蓝牙重试 id=${ordered[i].id} peak=${attempt.peak} voiced=${attempt.voicedMs}ms reason=${attempt.stopReason}`);
          if (attempt.voicedMs > 0) {
            stats = attempt;
            input = 'bluetooth';
            HostCapabilities.btCandidateId = ordered[i].id;
            HostCapabilities.btRetryAt = 0;
            break;
          }
        }
        if (input !== 'bluetooth') {
          // 走不通：5 分钟内不再为了它多花时间。
          HostCapabilities.btCandidateId = -1;
          HostCapabilities.btRetryAt = Date.now() + 300000;
        }
      }
      const finalStats: CaptureStats = stats !== null ? stats : {
        bytes: 0, totalMs: 0, rate: 16000, peak: 0, rms: 0, voicedMs: 0, stopReason: 'empty'
      };
      const result: RecordResult = {
        ok: finalStats.bytes > 0,
        path: path,
        bytes: finalStats.bytes,
        durationMs: finalStats.totalMs,
        sampleRate: finalStats.rate,
        peak: finalStats.peak,
        rms: finalStats.rms,
        input: input,
        stopReason: finalStats.stopReason,
        voicedMs: finalStats.voicedMs
      };
      HostCapabilities.appLog(context,
        `speech.record done: ${finalStats.bytes}B ${finalStats.totalMs}ms stop=${finalStats.stopReason} voiced=${finalStats.voicedMs}ms rate=${finalStats.rate} peak=${finalStats.peak} rms=${finalStats.rms} input=${input} -> ${path}`);
      return JSON.stringify(result);
    } catch (error) {
      const failed: BusinessError = error as BusinessError;
      const result: RecordResult = { ok: false, error: failed.message, code: String(failed.code) };
      HostCapabilities.appLog(context, `speech.record failed: ${failed.code} ${failed.message}`);
      return JSON.stringify(result);
    }
  }

  /** 列出通话输入设备（`CALL_INPUT_DEVICES` 才含带麦的蓝牙设备；`MEDIA_*` 只有 A2DP 放音）。 */
  private static inputCandidates(context: common.UIAbilityContext): audio.AudioDeviceDescriptor[] {
    return HostCapabilities.listInputs(context, true);
  }

  /** 列输入设备；`verbose` 控制是否逐条写日志（叫醒后再枚举时不想刷屏）。 */
  private static listInputs(context: common.UIAbilityContext,
    verbose: boolean): audio.AudioDeviceDescriptor[] {
    const out: audio.AudioDeviceDescriptor[] = [];
    try {
      const inputs: audio.AudioDeviceDescriptors = audio.getAudioManager().getRoutingManager()
        .getAvailableDevices(audio.DeviceUsage.CALL_INPUT_DEVICES);
      for (let i = 0; i < inputs.length; i++) {
        const device: audio.AudioDeviceDescriptor = inputs[i];
        out.push(device);
        if (verbose) {
          HostCapabilities.appLog(context, `speech.record 输入候选 type=${device.deviceType} id=${device.id}`);
        }
      }
    } catch (error) {
      const ignored: BusinessError = error as BusinessError;
      console.info(`[${Constants.HILOG_TAG}] 查询输入设备失败：${ignored.message}`);
    }
    return out;
  }

  /**
   * 把蓝牙 SCO 链路「叫醒」。
   *
   * 真机现象：戴着耳机时 `CALL_INPUT_DEVICES` 里可能一个蓝牙设备都不列；但只要跑过一次
   * `SOURCE_TYPE_VOICE_COMMUNICATION` 的采集，下一次枚举就会出现 `type=7`。
   * 这里故意录 0.3 秒丢掉，只为了把这个链路拉起来（时间越短，用户开头的字丢得越少）。
   */
  private static async wakeSco(context: common.UIAbilityContext): Promise<void> {
    const path: string = `${context.filesDir}/runtime/sco-wake.pcm`;
    const options: CaptureOptions = {
      autoStop: false, maxMs: 300, silenceMs: 900, minVoicedMs: 400, threshold: 0
    };
    try {
      const stats: CaptureStats = await HostCapabilities.captureSpeech(context, path, options, null,
        audio.SourceType.SOURCE_TYPE_VOICE_COMMUNICATION);
      HostCapabilities.appLog(context, `speech.record 蓝牙叫醒 peak=${stats.peak} rms=${stats.rms}`);
    } catch (error) {
      const failed: BusinessError = error as BusinessError;
      HostCapabilities.appLog(context, `speech.record 蓝牙叫醒失败：${failed.code} ${failed.message}`);
    }
  }

  /**
   * 激活「通话」音频会话。
   *
   * 这是让系统把 SCO 挂出来的关键：只做一次 `SOURCE_TYPE_VOICE_COMMUNICATION` 采集有时还不够，
   * 会话场景设成 `AUDIO_SESSION_SCENE_VOICE_COMMUNICATION` 之后，音频策略才会把蓝牙耳机
   * 当成通话终端（含麦克风）。失败不影响录音，只是蓝牙大概不会出现。
   */
  private static async beginVoiceSession(context: common.UIAbilityContext): Promise<audio.AudioSessionManager | null> {
    try {
      const session: audio.AudioSessionManager = audio.getAudioManager().getSessionManager();
      const strategy: audio.AudioSessionStrategy = {
        concurrencyMode: audio.AudioConcurrencyMode.CONCURRENCY_MIX_WITH_OTHERS
      };
      await session.activateAudioSession(strategy);
      try {
        session.setAudioSessionScene(audio.AudioSessionScene.AUDIO_SESSION_SCENE_VOICE_COMMUNICATION);
      } catch (sceneError) {
        const ignored: BusinessError = sceneError as BusinessError;
        HostCapabilities.appLog(context, `speech.record 设置通话场景失败：${ignored.code} ${ignored.message}`);
      }
      HostCapabilities.appLog(context, 'speech.record 通话音频会话已激活');
      return session;
    } catch (error) {
      const failed: BusinessError = error as BusinessError;
      HostCapabilities.appLog(context, `speech.record 激活通话会话失败：${failed.code} ${failed.message}`);
      return null;
    }
  }

  /** 结束通话音频会话（不结束会一直占着通话通路，放音会变小声）。 */
  private static async endVoiceSession(context: common.UIAbilityContext,
    session: audio.AudioSessionManager | null): Promise<void> {
    if (session === null) {
      return;
    }
    try {
      await session.deactivateAudioSession();
      HostCapabilities.appLog(context, 'speech.record 通话音频会话已结束');
    } catch (error) {
      const failed: BusinessError = error as BusinessError;
      HostCapabilities.appLog(context, `speech.record 结束通话会话失败：${failed.code} ${failed.message}`);
    }
  }

  /** 把所有输入设备（媒体输入 + 通话输入）打一遍日志，用来判断耳机到底有没有挂上来。 */
  private static logAllInputs(context: common.UIAbilityContext): void {
    const usages: number[] = [audio.DeviceUsage.MEDIA_INPUT_DEVICES, audio.DeviceUsage.CALL_INPUT_DEVICES];
    for (let u = 0; u < usages.length; u++) {
      const usage: audio.DeviceUsage = usages[u] as audio.DeviceUsage;
      try {
        const devices: audio.AudioDeviceDescriptors =
          audio.getAudioManager().getRoutingManager().getAvailableDevices(usage);
        for (let i = 0; i < devices.length; i++) {
          const device: audio.AudioDeviceDescriptor = devices[i];
          HostCapabilities.appLog(context,
            `speech.record 输入清单 usage=${usage} type=${device.deviceType} id=${device.id} name=${device.displayName}`);
        }
      } catch (error) {
        const failed: BusinessError = error as BusinessError;
        HostCapabilities.appLog(context, `speech.record 枚举输入 usage=${usage} 失败：${failed.code} ${failed.message}`);
      }
    }
  }

  /**
   * 把「朗读」的音频通路指到耳机上。
   *
   * 真机问题（2026-11-25）：戴着只暴露通话通路（SCO/HFP）的眼镜耳机时，系统 TTS 走媒体通路，
   * 声音直接从手机外放出来。`selectOutputDevice` 是「指定媒体播放设备」的接口，把当前可用的
   * 蓝牙输出挑一个指过去即可；没有蓝牙输出就保持系统默认（也就不要再动它）。
   */
  private static async routeSpeakOutput(context: common.UIAbilityContext): Promise<void> {
    try {
      const routing: audio.AudioRoutingManager = audio.getAudioManager().getRoutingManager();
      const usages: number[] = [audio.DeviceUsage.MEDIA_OUTPUT_DEVICES, audio.DeviceUsage.CALL_OUTPUT_DEVICES];
      let sco: audio.AudioDeviceDescriptor | null = null;
      let a2dp: audio.AudioDeviceDescriptor | null = null;
      for (let u = 0; u < usages.length; u++) {
        const usage: audio.DeviceUsage = usages[u] as audio.DeviceUsage;
        let devices: audio.AudioDeviceDescriptors = [];
        try {
          devices = routing.getAvailableDevices(usage);
        } catch (listError) {
          const failed: BusinessError = listError as BusinessError;
          HostCapabilities.appLog(context, `speech.speak 枚举输出 usage=${usage} 失败：${failed.code}`);
          continue;
        }
        for (let i = 0; i < devices.length; i++) {
          const device: audio.AudioDeviceDescriptor = devices[i];
          HostCapabilities.appLog(context,
            `speech.speak 输出候选 usage=${usage} type=${device.deviceType} id=${device.id}`);
          if (device.deviceType === audio.DeviceType.BLUETOOTH_SCO && sco === null) {
            sco = device;
          } else if (device.deviceType === audio.DeviceType.BLUETOOTH_A2DP && a2dp === null) {
            a2dp = device;
          }
        }
      }
      const target: audio.AudioDeviceDescriptor | null = sco !== null ? sco : a2dp;
      if (target === null) {
        HostCapabilities.appLog(context, 'speech.speak 没有蓝牙输出，按系统默认通路朗读');
        return;
      }
      // 26.0.0 的增强路由接口在 AudioDeviceEnhanceManager 上（不在 AudioRoutingManager 上）。
      const enhance: audio.AudioDeviceEnhanceManager = audio.getAudioManager().getDeviceEnhanceManager();
      if (!enhance.isEnhancedRoutingSupported()) {
        HostCapabilities.appLog(context, 'speech.speak 本机不支持增强路由，朗读仍走系统默认');
        return;
      }
      await enhance.selectOutputDevice(target);
      HostCapabilities.appLog(context, `speech.speak 朗读已指到 type=${target.deviceType} id=${target.id}`);
    } catch (error) {
      const failed: BusinessError = error as BusinessError;
      HostCapabilities.appLog(context, `speech.speak 指定输出设备失败：${failed.code} ${failed.message}`);
    }
  }

  /** 按类型筛设备：蓝牙（SCO，可能多个）或手机麦（MIC）。 */
  private static pickDevices(devices: audio.AudioDeviceDescriptor[],
    wantBluetooth: boolean): audio.AudioDeviceDescriptor[] {
    const target: audio.DeviceType = wantBluetooth ? audio.DeviceType.BLUETOOTH_SCO : audio.DeviceType.MIC;
    const out: audio.AudioDeviceDescriptor[] = [];
    for (let i = 0; i < devices.length; i++) {
      if (devices[i].deviceType === target) {
        out.push(devices[i]);
      }
    }
    return out;
  }

  /** 只要一个设备时用（诊断模式沿用旧的单设备入口）。 */
  private static pickDevice(devices: audio.AudioDeviceDescriptor[],
    wantBluetooth: boolean): audio.AudioDeviceDescriptor | null {
    const list: audio.AudioDeviceDescriptor[] = HostCapabilities.pickDevices(devices, wantBluetooth);
    return list.length > 0 ? list[0] : null;
  }

  /**
   * 蓝牙设备按「上次真的听到人声的那个」排在最前，其余保持系统顺序。
   *
   * 真机里同时能看到多个 BLUETOOTH_SCO 设备（历史配对残留），其中只有一个真的在收音频；
   * 之前固定取第一个，一旦第一个是死通道，就表现为「蓝牙又收不到音了」。
   */
  private static orderBluetooths(bluetooths: audio.AudioDeviceDescriptor[]): audio.AudioDeviceDescriptor[] {
    const out: audio.AudioDeviceDescriptor[] = [];
    let cached: audio.AudioDeviceDescriptor | null = null;
    for (let i = 0; i < bluetooths.length; i++) {
      if (bluetooths[i].id === HostCapabilities.btCandidateId) {
        cached = bluetooths[i];
      }
    }
    if (cached !== null) {
      out.push(cached);
    }
    for (let i = 0; i < bluetooths.length; i++) {
      if (cached === null || bluetooths[i].id !== cached.id) {
        out.push(bluetooths[i]);
      }
    }
    return out;
  }
  /** 列出通话输入设备（`CALL_INPUT_DEVICES` 才含带麦的蓝牙设备；`MEDIA_*` 只有 A2DP 放音）。 */
  /** 诊断用：按不同「设备 × 采集源」组合录一段，比较峰值，判断蓝牙麦到底走哪条路。 */
  private static async recordTrial(context: common.UIAbilityContext, path: string, durationMs: number,
    candidates: audio.AudioDeviceDescriptor[], mode: string): Promise<string> {
    const bluetooth: audio.AudioDeviceDescriptor | null = HostCapabilities.pickDevice(candidates, true);
    const phone: audio.AudioDeviceDescriptor | null = HostCapabilities.pickDevice(candidates, false);
    let device: audio.AudioDeviceDescriptor | null = null;
    let source: audio.SourceType = audio.SourceType.SOURCE_TYPE_MIC;
    if (mode === 'bt-explicit') {
      device = bluetooth;
      source = audio.SourceType.SOURCE_TYPE_VOICE_COMMUNICATION;
    } else if (mode === 'bt-auto') {
      device = null;
      source = audio.SourceType.SOURCE_TYPE_VOICE_COMMUNICATION;
    } else if (mode === 'phone-explicit') {
      device = phone;
      source = audio.SourceType.SOURCE_TYPE_MIC;
    }
    const stats: CaptureStats = await HostCapabilities.captureToFile(context, path, durationMs, device, source);
    HostCapabilities.appLog(context,
      `speech.trial mode=${mode} peak=${stats.peak} rms=${stats.rms} rate=${stats.rate}`);
    const result: RecordResult = {
      ok: stats.bytes > 0, path: path, bytes: stats.bytes, durationMs: durationMs,
      sampleRate: stats.rate, peak: stats.peak, rms: stats.rms, input: mode
    };
    return JSON.stringify(result);
  }

  /** 录一段固定时长的 PCM 到文件（探测蓝牙麦这类内部用途）。 */
  private static async captureToFile(context: common.UIAbilityContext, path: string, durationMs: number,
    device: audio.AudioDeviceDescriptor | null, source: audio.SourceType): Promise<CaptureStats> {
    const fixed: CaptureOptions = {
      autoStop: false,
      maxMs: durationMs,
      silenceMs: 900,
      minVoicedMs: 400,
      threshold: 0
    };
    return await HostCapabilities.captureSpeech(context, path, fixed, device, source);
  }

  /**
   * 录 PCM，直到「说完」或到上限。
   *
   * 用户的原话是「录音长短的问题」：固定 6 秒必然把一句话的后半截截掉、或者白等 4 秒静音。
   * 这里按块算 RMS，检测到人声后一旦静音超过 silenceMs 就收尾；阈值不写死，跟着本底噪声走，
   * 否则安静房间里的呼吸声、吵闹环境里的底噪都会让判定失灵。
   */
  private static async captureSpeech(context: common.UIAbilityContext, path: string,
    options: CaptureOptions,
    device: audio.AudioDeviceDescriptor | null, source: audio.SourceType): Promise<CaptureStats> {
    const target: fs.File = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    let capturer: audio.AudioCapturer | null = null;
    let bytes: number = 0;
    let peak: number = 0;
    let sumSquares: number = 0;
    let samples: number = 0;
    let voicedMs: number = 0;
    let silenceRunMs: number = 0;
    let noiseFloor: number = 80;
    let stopReason: string = 'max';
    let done: boolean = false;
    let totalMs: number = 0;
    try {
      const recorder: audio.AudioCapturer = await audio.createAudioCapturer({
        streamInfo: {
          samplingRate: 16000,
          channels: audio.AudioChannel.CHANNEL_1,
          sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
          encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
        },
        capturerInfo: {
          source: source,
          capturerFlags: 0
        }
      });
      capturer = recorder;
      if (device !== null) {
        await audio.getAudioManager().getDeviceEnhanceManager().selectInputDeviceForAudioCapturer(recorder, device);
        HostCapabilities.appLog(context, 'speech.record 输入设备 type=' + device.deviceType);
      }
      // 设备不一定按请求的 16 kHz 出流（多数手机原生 48 kHz）。识别引擎按 16 kHz 解读 PCM，
      // 若实际采样率更高而原样落盘，音频在引擎里会被「快放」，结果就是 0 个字。
      const streamInfo: audio.AudioStreamInfo = recorder.getStreamInfoSync();
      const rate: number = streamInfo.samplingRate;
      const ratio: number = rate > 16000 ? Math.round(rate / 16000) : 1;
      const limit: number = 16000 * 2 * 120;
      recorder.on('readData', (buffer: ArrayBuffer): void => {
        if (done || bytes >= limit) {
          return;
        }
        try {
          let chunk: ArrayBuffer = buffer;
          if (ratio > 1) {
            const input: Int16Array = new Int16Array(buffer);
            const outLength: number = Math.floor(input.length / ratio);
            const output: Int16Array = new Int16Array(outLength);
            for (let i = 0; i < outLength; i++) {
              output[i] = input[i * ratio];
            }
            chunk = output.buffer as ArrayBuffer;
          }
          const view: Int16Array = new Int16Array(chunk);
          let chunkSquares: number = 0;
          for (let i = 0; i < view.length; i++) {
            const value: number = view[i];
            const magnitude: number = value < 0 ? -value : value;
            if (magnitude > peak) {
              peak = magnitude;
            }
            chunkSquares += value * value;
            sumSquares += value * value;
            samples += 1;
          }
          fs.writeSync(target.fd, chunk);
          bytes += chunk.byteLength;
          totalMs = Math.round((bytes / 32000) * 1000);
          const chunkMs: number = view.length > 0 ? (view.length / 16000) * 1000 : 0;
          const chunkRms: number = view.length > 0 ? Math.sqrt(chunkSquares / view.length) : 0;
          // 阈值跟着本底噪声走：安静时门槛低、吵闹时门槛高，避免环境一变就失灵。
          if (chunkRms < noiseFloor) {
            noiseFloor = noiseFloor * 0.7 + chunkRms * 0.3;
          }
          const threshold: number = options.threshold > 0 ? options.threshold : Math.max(300, noiseFloor * 3);
          if (chunkRms >= threshold) {
            voicedMs += chunkMs;
            silenceRunMs = 0;
          } else {
            silenceRunMs += chunkMs;
          }
          if (!options.autoStop) {
            if (totalMs >= options.maxMs) {
              stopReason = 'max';
              done = true;
            }
            return;
          }
          if (voicedMs >= options.minVoicedMs && silenceRunMs >= options.silenceMs) {
            stopReason = 'silence';
            done = true;
          } else if (options.probeMs !== undefined && options.probeMs > 0 && voicedMs === 0
            && totalMs >= options.probeMs) {
            // 蓝牙优先：这段通路上一直没人声，交给调用方换设备重录。
            stopReason = 'silent-probe';
            done = true;
          } else if (voicedMs === 0 && silenceRunMs >= 2500) {
            // 一句话都没说：别硬等满 30 秒。
            stopReason = 'empty';
            done = true;
          } else if (totalMs >= options.maxMs) {
            stopReason = 'max';
            done = true;
          } else if (bytes >= limit) {
            stopReason = 'bytes';
            done = true;
          }
        } catch (error) {
          const ignored: BusinessError = error as BusinessError;
          console.info(`[${Constants.HILOG_TAG}] speech.record 写入失败：${ignored.message}`);
        }
      });
      await recorder.start();
      const startedAt: number = Date.now();
      // 轮询等收尾：readData 在同一个 JS 线程上回调，delay 让出控制权它才会跑。
      while (!done && Date.now() - startedAt < options.maxMs + 500) {
        await HostCapabilities.delay(80);
      }
      await recorder.stop();
      const rmsRaw: number = samples > 0 ? Math.sqrt(sumSquares / samples) : 0;
      const stats: CaptureStats = {
        bytes: bytes,
        peak: peak,
        rms: Math.round(rmsRaw * 10) / 10,
        rate: rate,
        stopReason: stopReason,
        voicedMs: Math.round(voicedMs),
        totalMs: totalMs
      };
      HostCapabilities.appLog(context,
        `speech.capture 收尾 reason=${stopReason} total=${totalMs}ms voiced=${Math.round(voicedMs)}ms noise=${Math.round(noiseFloor)}`);
      return stats;
    } finally {
      if (capturer !== null) {
        try {
          capturer.release();
        } catch (error) {
          const ignored: BusinessError = error as BusinessError;
          console.info(`[${Constants.HILOG_TAG}] speech.record release 失败：${ignored.message}`);
        }
      }
      try {
        fs.closeSync(target);
      } catch (error) {
        const ignored: BusinessError = error as BusinessError;
        console.info(`[${Constants.HILOG_TAG}] speech.record close 失败：${ignored.message}`);
      }
    }
  }

  /**
   * 语音合成：用系统离线 TTS 朗读一段文本，读到 `onComplete` 才返回。
   * 入参 `{text, speed?, volume?, pitch?, lang?}`；空文本直接返回成功（调用方通常已过滤）。
   * 用于半双工通话：模型回复 → 这里 → 扬声器。
   */
  /** 复用的 TTS 引擎。每次朗读都 create/shutdown 会把长文本截断（真机现象：只读半句）。 */
  private static ttsEngine: textToSpeech.TextToSpeechEngine | null = null;
  private static ttsLanguage: string = '';

  private static async ensureTtsEngine(language: string): Promise<textToSpeech.TextToSpeechEngine> {
    const cached: textToSpeech.TextToSpeechEngine | null = HostCapabilities.ttsEngine;
    if (cached !== null && HostCapabilities.ttsLanguage === language) {
      return cached;
    }
    if (cached !== null) {
      try {
        cached.shutdown();
      } catch (error) {
        const ignored: BusinessError = error as BusinessError;
        console.info(`[${Constants.HILOG_TAG}] 旧 TTS 引擎关闭失败：${ignored.message}`);
      }
      HostCapabilities.ttsEngine = null;
    }
    const created: textToSpeech.TextToSpeechEngine =
      await textToSpeech.createEngine({ language: language, person: 0, online: 1 });
    HostCapabilities.ttsEngine = created;
    HostCapabilities.ttsLanguage = language;
    return created;
  }

  /** 打断当前朗读（挂断/静音时用）。 */
  private static async stopSpeak(): Promise<string> {
    const engine: textToSpeech.TextToSpeechEngine | null = HostCapabilities.ttsEngine;
    if (engine !== null) {
      try {
        engine.stop();
      } catch (error) {
        const ignored: BusinessError = error as BusinessError;
        console.info(`[${Constants.HILOG_TAG}] speech.speak stop 失败：${ignored.message}`);
      }
    }
    const ok: SpeakResult = { ok: true, chars: 0 };
    return JSON.stringify(ok);
  }

  private static async speak(context: common.UIAbilityContext, args: string): Promise<string> {
    let engine: textToSpeech.TextToSpeechEngine | null = null;
    try {
      const parsed: SpeakArgs = JSON.parse(args) as SpeakArgs;
      const text: string = (parsed.text ?? '').trim();
      if (text === '') {
        const empty: SpeakResult = { ok: true, chars: 0 };
        return JSON.stringify(empty);
      }
      const language: string = parsed.lang !== undefined && parsed.lang.startsWith('en') ? 'en-US' : 'zh-CN';
      // 先把朗读通路指到耳机：只支持通话（SCO）的眼镜/耳机不指定的话，系统 TTS 会从手机外放出来。
      await HostCapabilities.routeSpeakOutput(context);
      // 复用引擎：每次 create/shutdown 会把长文本截断（真机只读半句）。
      engine = await HostCapabilities.ensureTtsEngine(language);
      const target: textToSpeech.TextToSpeechEngine = engine;
      const requestId: string = 'dsh-speak-' + Date.now();
      const startedAt: number = Date.now();
      let failure: string = '';
      let settled: boolean = false;
      const finished = new Promise<void>((resolve) => {
        const done = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        target.setListener({
          onStart: (_id: string, _response: textToSpeech.StartResponse): void => {
            HostCapabilities.appLog(context, `speech.speak onStart +${Date.now() - startedAt}ms`);
          },
          onComplete: (_id: string, _response: textToSpeech.CompleteResponse): void => {
            HostCapabilities.appLog(context, `speech.speak onComplete +${Date.now() - startedAt}ms`);
            done();
          },
          onStop: (_id: string, _response: textToSpeech.StopResponse): void => {
            HostCapabilities.appLog(context, `speech.speak onStop +${Date.now() - startedAt}ms`);
            done();
          },
          onError: (_id: string, errorCode: number, errorMessage: string): void => {
            failure = errorCode + ' · ' + errorMessage;
            HostCapabilities.appLog(context, `speech.speak onError +${Date.now() - startedAt}ms ${failure}`);
            done();
          }
        });
      });
      // speed/volume/pitch 必须是数字：传字符串时原生侧 GetValueInt64 失败，
      // 引擎会提前报 onComplete（真机：只读半句就停）。
      const params: textToSpeech.SpeakParams = {
        requestId: requestId,
        extraParams: {
          'speed': parsed.speed ?? 1,
          'volume': parsed.volume ?? 2,
          'pitch': parsed.pitch ?? 1,
          'languageContext': language
        }
      };
            target.speak(text, params);
      // 引擎的 onComplete 会提前（实测 143 字在 +1.4s 就报完成，真音频约 30s，之后还会再来一次
      // 「迟到」的 onComplete），所以只等一小段时间捞「立刻失败」，朗读时长按字数估算交给调用方。
      await Promise.race([finished, HostCapabilities.delay(800)]);
      if (failure !== '') {
        HostCapabilities.appLog(context, 'speech.speak failed: ' + failure);
        const bad: SpeakResult = { ok: false, error: failure, code: 'speak-failed' };
        return JSON.stringify(bad);
      }
      HostCapabilities.appLog(context, 'speech.speak done: ' + text.length + ' chars');
      const estimateMs: number = Math.max(1500, Math.round(text.length / 4.5 * 1000));
      HostCapabilities.appLog(context, 'speech.speak estimate ' + estimateMs + 'ms for ' + text.length + ' chars');
      const ok: SpeakResult = { ok: true, chars: text.length, estimateMs: estimateMs };
      return JSON.stringify(ok);
    } catch (error) {
      const failed: BusinessError = error as BusinessError;
      HostCapabilities.appLog(context, 'speech.speak error: ' + failed.message);
      const bad: SpeakResult = { ok: false, error: failed.message, code: String(failed.code) };
      return JSON.stringify(bad);
    } finally {
      // 故意不 shutdown：引擎留着下一次复用。之前每轮都 shutdown，长回复会在
      // 第一段合成后被打断（真机现象：只读完半句就停）。
    }
  }

  /**
   * 给 ArkTS 页面（通话面板）用的直调入口：录音 / 识别 / 朗读。
   *
   * 页面在 ArkTS 侧，不走宿主桥的 JSON 字符串协议，所以这里给一层类型化的薄包装。
   */
  static async recordForCall(context: common.UIAbilityContext, maxMs: number, silenceMs: number = 900,
    mic: string = 'auto'): Promise<RecordResult> {
    // autoStop：说话一停就收尾，maxMs 只当安全上限（面板给 30 秒）；
    // silenceMs 由「语音设置」里的停顿档位决定（快 500 / 普通 900 / 耐心 1800）。
    // mic 由「麦克风」档位决定（自动 / 蓝牙优先 / 只用手机麦）。
    const raw: string = await HostCapabilities.record(context,
      JSON.stringify({ maxMs: maxMs, autoStop: true, silenceMs: silenceMs, minVoicedMs: 400, mic: mic }));
    return JSON.parse(raw) as RecordResult;
  }

  static async recognizeForCall(context: common.UIAbilityContext, path: string): Promise<SpeechRecognizeResult> {
    const raw: string = await HostCapabilities.recognizeSpeech(context, JSON.stringify({ path, language: 'zh' }));
    return JSON.parse(raw) as SpeechRecognizeResult;
  }

  static async stopSpeakForCall(context: common.UIAbilityContext): Promise<SpeakResult> {
    const raw: string = await HostCapabilities.stopSpeak();
    return JSON.parse(raw) as SpeakResult;
  }

  static async speakForCall(context: common.UIAbilityContext, text: string): Promise<SpeakResult> {
    const raw: string = await HostCapabilities.speak(context, JSON.stringify({ text, lang: 'zh' }));
    return JSON.parse(raw) as SpeakResult;
  }

  private static async recognizeSpeech(context: common.UIAbilityContext, args: string): Promise<string> {
    let engine: speechRecognizer.SpeechRecognitionEngine | null = null;
    let fd: number = -1;
    try {
      const parsed: SpeechRecognizeArgs = JSON.parse(args) as SpeechRecognizeArgs;
      const path: string = parsed.path ?? '';
      if (path === '') {
        const bad: SpeechRecognizeResult = {
          ok: false, error: 'bad-args', code: 'bad-args',
          hint: 'speech.recognize 需要 path（PCM16 / 16 kHz / 单声道裸数据）'
        };
        return JSON.stringify(bad);
      }
      const allowed: boolean = await HostCapabilities.ensureMicrophone(context);
      if (!allowed) {
        const denied: SpeechRecognizeResult = {
          ok: false, error: '麦克风权限未授予', code: 'mic-denied',
          hint: '请在系统设置里允许本应用使用麦克风后重试'
        };
        HostCapabilities.appLog(context, 'speech.recognize: mic denied');
        return JSON.stringify(denied);
      }
      let size: number = 0;
      try {
        size = fs.statSync(path).size;
      } catch (statError) {
        const missing: SpeechRecognizeResult = {
          ok: false, error: '录音文件不可读', code: 'speech-no-audio', hint: '找不到待识别的 PCM 文件'
        };
        return JSON.stringify(missing);
      }
      if (size <= 0) {
        const empty: SpeechRecognizeResult = { ok: false, error: '录音为空', code: 'speech-empty' };
        return JSON.stringify(empty);
      }
      HostCapabilities.appLog(context, 'speech.recognize in: ' + size + 'B lang=' + String(parsed.language));

      const created: speechRecognizer.SpeechRecognitionEngine = await speechRecognizer.createEngine({
        language: 'zh-CN',
        online: 1,
        // long 模式比 short 更耐心：不会说两句就判定说完，适合整句/长句。
        extraParams: { recognizerMode: 'long', locate: 'CN' }
      });
      // 必须回填到外层变量：`finally` 里要靠它 shutdown，否则引擎每调一次识别就泄漏一个实例，
      // 多轮之后新引擎 startListening 会立刻失败（1002200010）。
      engine = created;
      const audioInfo: speechRecognizer.AudioInfo = {
        audioType: 'pcm',
        sampleRate: 16000,
        soundChannel: 1,
        sampleBit: 16
      };
      const fileHandle = fs.openSync(path, fs.OpenMode.READ_ONLY);
      fd = typeof fileHandle === 'number' ? fileHandle : fileHandle.fd;
      // SDK 契约：每次 writeAudio 只能是 640 或 1280 字节，且按 20/40 ms 的节奏喂；
      // 一次性塞完会被判成 finish 失败（1002200004）。单次识别上限 60 秒。
      const chunkSize: number = HostCapabilities.SPEECH_CHUNK_BYTES;
      const paceMs: number = HostCapabilities.SPEECH_CHUNK_PACE_MS;
      const maxBytes: number = 16000 * 2 * 60;
      const buffer: ArrayBuffer = new ArrayBuffer(chunkSize);
      let read: number = fs.readSync(fd, buffer);
      let sent: number = 0;
      let collected: string = '';
      let sessions: number = 0;
      // 引擎一段会自己收尾（onComplete），一整个会话装不下长句；收尾时若文件还有剩余，
      // 就换一个新会话接着喂，把几段文本拼起来才是完整一句（DSH Go 的 HmsStreamingAsr 用同样做法）。
      while (read > 0 && sent < maxBytes && sessions < 60) {
        sessions += 1;
        const sessionId: string = 'dsh-' + Date.now() + '-' + sessions;
        let interim: string = '';
        let finalText: string = '';
        let resolved = false;
        let started = false;
        let failure: string = '';
        let bytesThisSession: number = 0;
        const finished = new Promise<void>((resolve) => {
          const wrapper = () => {
            if (!resolved) {
              resolved = true;
              resolve();
            }
          };
          created.setListener({
            onStart: (_sessionId: string, _eventMessage: string): void => {
              started = true;
            },
            onEvent: (_sessionId: string, _eventCode: number, _eventMessage: string): void => {
            },
            onResult: (_sessionId: string, result: speechRecognizer.SpeechRecognitionResult): void => {
              if (result.result.length === 0) {
                return;
              }
              // isFinal 才是句子边界；isLast 不代表物理收尾（DSH Go 的注释写得很清楚）。
              if (result.isFinal) {
                finalText = result.result;
              } else {
                interim = result.result;
              }
            },
            onComplete: (_sessionId: string, _eventMessage: string): void => {
              wrapper();
            },
            onError: (_sessionId: string, errorCode: number, errorMessage: string): void => {
              failure = errorCode + ' · ' + errorMessage;
              wrapper();
            }
          });
        });
        created.startListening({ sessionId: sessionId, audioInfo: audioInfo, extraParams: {
          recognitionMode: 1,
          maxAudioDuration: 60000,
          recognizerOption: { enablePartialResult: true }
        } });
        // 等 onStart 确认引擎真正启动，避免过早 writeAudio 导致 1002200010
        let waited: number = 0;
        while (!started && waited < 3000) {
          await HostCapabilities.delay(50);
          waited += 50;
        }
        let restarts: number = 0;
        while (read > 0 && sent < maxBytes) {
          // 引擎会在检测到说完时自行结束（onComplete），此后继续写会抛 1002200010。
          if (resolved) {
            break;
          }
          const room: number = Math.min(read, maxBytes - sent);
          const chunk: Uint8Array = new Uint8Array(buffer.slice(0, room));
          let attempts: number = 0;
          let written: boolean = false;
          while (!written && attempts < 3) {
            attempts += 1;
            try {
              created.writeAudio(sessionId, chunk);
              written = true;
            } catch (error) {
              const failed: BusinessError = error as BusinessError;
              const message: string = `${failed.code} · ${failed.message}`;
              if (resolved) {
                // 会话已由引擎自己收尾，这里不是错误。
                break;
              }
              HostCapabilities.appLog(context, 'speech.recognize writeAudio 失败：' + message);
              if (message.indexOf('1002200010') < 0 || restarts >= 3) {
                throw error as Error;
              }
              restarts += 1;
              started = false;
              created.startListening({ sessionId: sessionId, audioInfo: audioInfo, extraParams: {
          recognitionMode: 1,
          maxAudioDuration: 60000,
          recognizerOption: { enablePartialResult: true }
        } });
              let retryWait: number = 0;
              while (!started && retryWait < 3000) {
                await HostCapabilities.delay(50);
                retryWait += 50;
              }
            }
          }
          if (written) {
            sent += room;
            bytesThisSession += room;
          }
          if (bytesThisSession >= HostCapabilities.SPEECH_SEGMENT_MIN_BYTES &&
            HostCapabilities.chunkRms(chunk) < HostCapabilities.SPEECH_PAUSE_RMS) {
            // 落在句间停顿上换会话：硬切会把词切成两半（实测「状况」被切成「不。况。」）。
            break;
          }
          if (bytesThisSession >= HostCapabilities.SPEECH_SEGMENT_MAX_BYTES) {
            // 一直没停顿就按 6 秒硬切：喂得太长引擎会整段崩（12.9 秒只回「状况。」）。
            break;
          }
          await HostCapabilities.delay(paceMs);
          if (resolved) {
            break;
          }
          read = fs.readSync(fd, buffer);
        }
        if (!resolved) {
          created.finish(sessionId);
        }
        await finished;
        const piece: string = (finalText.length > 0 ? finalText : interim).trim();
        if (piece.length > 0) {
          collected += piece;
        }
        if (failure !== '') {
          HostCapabilities.appLog(context, 'speech.recognize 本段错误（已保留文本）：' + failure);
        }
        // 这一段一个字节都没喂进去（引擎一启动就收尾）时再循环也没意义，直接收工。
        if (bytesThisSession === 0) {
          break;
        }
        if (read <= 0 || sent >= maxBytes) {
          break;
        }
      }
      HostCapabilities.appLog(context,
        `speech.recognize sent ${sent}B（sessions=${sessions}）`);
      const text: string = collected.trim();
      if (text.length > 0) {
        HostCapabilities.appLog(context, 'speech.recognize out: ' + text.length + ' chars');
        const done: SpeechRecognizeResult = { ok: true, text: text };
        return JSON.stringify(done);
      }
      HostCapabilities.appLog(context, 'speech.recognize out: 0 chars');
      const empty: SpeechRecognizeResult = { ok: true, text: '' };
      return JSON.stringify(empty);
    } catch (error) {
      const message: string = error instanceof Error ? error.message : String(error);
      HostCapabilities.appLog(context, 'speech.recognize error: ' + message);
      const failed: SpeechRecognizeResult = { ok: false, error: message, code: 'speech-failed' };
      return JSON.stringify(failed);
    } finally {
      if (fd >= 0) {
        try { fs.closeSync(fd); } catch (closeError) { }
      }
      if (engine !== null) {
        try {
          engine.shutdown();
        } catch (shutdownError) {
          const ignored: BusinessError = shutdownError as BusinessError;
          console.info(`[${Constants.HILOG_TAG}] speech.recognize shutdown 失败：${ignored.message}`);
        }
      }
    }
  }

  /** 申请麦克风权限；已授权时不弹窗（`requestPermissionsFromUser` 对已授权项直接返回 0）。 */
  private static async ensureMicrophone(context: common.UIAbilityContext): Promise<boolean> {
    try {
      const manager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      const result: PermissionRequestResult =
        await manager.requestPermissionsFromUser(context, ['ohos.permission.MICROPHONE']);
      if (result.authResults.length === 0) {
        return false;
      }
      return result.authResults[0] === 0;
    } catch (error) {
      return false;
    }
  }

  private static notImplemented(host: HostBridge, name: string, hint: string): void {
    host.register(name, (_args: string): string => {
      const payload: CapabilityError = { ok: false, error: 'not-implemented', hint };
      return JSON.stringify(payload);
    });
  }

  private static facts(context: common.UIAbilityContext): string {
    try {
      const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT
      );
      const app: AppFacts = {
        bundleName: info.name,
        versionName: info.versionName,
        versionCode: info.versionCode
      };
      const node: NodeFacts = { expected: 'v24.2.0', abi: 137 };
      const paths: PathFacts = {
        filesDir: context.filesDir,
        resourceDir: context.resourceDir,
        payloadRoot: Constants.payloadRoot(context),
        assetRoot: Constants.assetRoot(context),
        dshHome: Constants.dshHome(context),
        workspace: Constants.workspaceRoot(context),
        mailbox: Constants.mailboxDir(context)
      };
      const payload: RuntimeFacts = {
        schema: 1,
        app,
        node,
        paths,
        userDirs: HostCapabilities.userDirs(),
        capabilities: HostCapabilities.capabilities(),
        // 119-jitless：如实上报本次进程形态（compat ⇒ true），不得写死
        jitless: resolveNodeMode().jitless()
      };
      return JSON.stringify(payload);
    } catch (error) {
      return HostCapabilities.internal('runtime.facts', error);
    }
  }

  private static userDirs(): UserDirFact[] {
    const result: UserDirFact[] = [];
    for (let i = 0; i < Constants.USER_DIRS.length; i++) {
      const name: string = Constants.USER_DIRS[i];
      const dirPath: string = Constants.USER_ROOT + '/' + name;
      const fact: UserDirFact = {
        id: name.toLowerCase(),
        path: dirPath,
        available: HostCapabilities.exists(dirPath)
      };
      result.push(fact);
    }
    return result;
  }

  private static exists(path: string): boolean {
    try {
      // 只报存在性（整体数据模型 §5）；权限/可见性问题由真实读写暴露。
      return fs.accessSync(path);
    } catch (error) {
      return false;
    }
  }

  private static capabilities(): CapabilityStatus[] {
    const implemented: string[] = [
      'runtime.facts', 'log.hilog', 'perm.check', 'perm.request', 'perm.openAppInfo', 'shell.openExternal',
      'image.normalize', 'fs.pickFiles'
    ];
    const pending: string[] = [
      'fs.pickFolder', 'fs.saveFile', 'notify.show',
      'clipboard.readImage', 'clipboard.writeText', 'power.keepAwake'
    ];
    const result: CapabilityStatus[] = [];
    for (let i = 0; i < implemented.length; i++) {
      const entry: CapabilityStatus = { name: implemented[i], status: 'implemented' };
      result.push(entry);
    }
    for (let i = 0; i < pending.length; i++) {
      const entry: CapabilityStatus = { name: pending[i], status: 'not-implemented' };
      result.push(entry);
    }
    return result;
  }

  /** 诊断日志（hilog；权限相关只记状态与数量，不记用户数据）。 */
  private static log(message: string): void {
    hilog.info(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, '%{public}s', message);
  }

  private static hilog(args: string): string {
    try {
      const parsed: LogArgs = JSON.parse(args) as LogArgs;
      const message: string = parsed.msg ?? '';
      const level: string = parsed.level ?? 'info';
      if (level === 'error') {
        hilog.error(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, '%{public}s', message);
      } else if (level === 'warn') {
        hilog.warn(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, '%{public}s', message);
      } else {
        hilog.info(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, '%{public}s', message);
      }
      const ok: OkResult = { ok: true };
      return JSON.stringify(ok);
    } catch (error) {
      return HostCapabilities.internal('log.hilog', error);
    }
  }

  private static checkPermission(context: common.UIAbilityContext, args: string): string {
    try {
      const parsed: NameArgs = JSON.parse(args) as NameArgs;
      const name: string = parsed.name ?? '';
      if (name === '') {
        const bad: CapabilityError = { ok: false, error: 'bad-args', hint: 'name is required' };
        return JSON.stringify(bad);
      }
      const tokenId: number = HostCapabilities.tokenId();
      const manager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      const status: abilityAccessCtrl.GrantStatus = manager.checkAccessTokenSync(tokenId, name as Permissions);
      const payload: PermissionCheckResult = {
        ok: true,
        granted: status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED
      };
      HostCapabilities.log(`perm.check：${name} status=${status} tokenId=${tokenId}`);
      return JSON.stringify(payload);
    } catch (error) {
      return HostCapabilities.internal('perm.check', error);
    }
  }

  private static async requestPermission(context: common.UIAbilityContext, args: string): Promise<string> {
    try {
      const parsed: NamesArgs = JSON.parse(args) as NamesArgs;
      const names: string[] = parsed.names ?? [];
      if (names.length === 0) {
        const bad: CapabilityError = { ok: false, error: 'bad-args', hint: 'names is required' };
        return JSON.stringify(bad);
      }
      const manager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      HostCapabilities.log(`perm.request：申请 ${names.length} 项 ${JSON.stringify(names)}`);
      const result: PermissionRequestResult =
        await manager.requestPermissionsFromUser(context, names as Permissions[]);
      const authResults: number[] = result.authResults ?? [];
      const answeredPermissions: string[] = result.permissions ?? [];
      // 空数组是重要事实（系统没给任何应答），必须连"申请了几项"一起回传，否则调用方
      // 无法区分"平台拒绝受理"与"参数没送到"（真机上就是这样被误读的）。
      HostCapabilities.log(`perm.request：应答 ${answeredPermissions.length} 项 authResults=${JSON.stringify(authResults)}`);
      const payload: PermissionReply = {
        ok: true,
        authResults: authResults,
        permissions: answeredPermissions,
        requested: names.length,
        answered: answeredPermissions.length
      };
      return JSON.stringify(payload);
    } catch (error) {
      return HostCapabilities.internal('perm.request', error);
    }
  }

  /**
   * 系统文件选择器（`fs.pickFiles`）：用户选中的文件被**拷贝**进 `targetDir`（默认
   * `<workspace>/imports`），返回落点。
   *
   * 存在理由：手机形态下平台只向白名单应用开放「文档/下载」目录授权
   * （`AuthorizationDialogBase.isSupportDirectoryPG=false`，实测 `authResult=2`），
   * 而系统文件选择器对第三方应用始终可用 —— 它给的是**单次文件授权**，所以这里落到沙箱里，
   * 之后 Node 侧读写再无障碍。
   */
  private static async pickFiles(context: common.UIAbilityContext, args: string): Promise<string> {
    let target: string = Constants.workspaceRoot(context) + '/imports';
    try {
      const parsed: PickFilesArgs = JSON.parse(args) as PickFilesArgs;
      if (parsed.targetDir !== undefined && parsed.targetDir !== '') {
        target = parsed.targetDir;
      }
      const max: number = parsed.maxCount !== undefined && parsed.maxCount > 0 ? Math.min(parsed.maxCount, 50) : 20;
      const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
      options.maxSelectNumber = max;
      options.selectMode = picker.DocumentSelectMode.FILE;
      const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
      HostCapabilities.log('fs.pickFiles：打开系统文件选择器 max=' + max);
      const uris: string[] = await documentPicker.select(options);
      if (uris.length === 0) {
        const empty: PickFilesResult = { ok: true, dir: target, files: [], cancelled: true };
        return JSON.stringify(empty);
      }
      if (!fs.accessSync(target)) {
        fs.mkdirSync(target, true);
      }
      const files: PickedFile[] = [];
      for (let i = 0; i < uris.length; i++) {
        const uri: string = uris[i];
        const name: string = HostCapabilities.uniqueName(target, HostCapabilities.baseName(uri));
        const dest: string = target + '/' + name;
        const source = fs.openSync(uri, fs.OpenMode.READ_ONLY);
        try {
          fs.copyFileSync(source.fd, dest);
        } finally {
          fs.closeSync(source);
        }
        const stat = fs.statSync(dest);
        const file: PickedFile = { name: name, path: dest, size: stat.size };
        files.push(file);
      }
      HostCapabilities.log('fs.pickFiles：导入 ' + files.length + ' 个文件 -> ' + target);
      const payload: PickFilesResult = { ok: true, dir: target, files: files, cancelled: false };
      return JSON.stringify(payload);
    } catch (error) {
      // 用户取消时 picker 抛 BusinessError（13900020 / 13900042，各版本不一）——
      // 取消不是失败，回 cancelled:true，避免界面弹「导入失败」。
      const message: string = error instanceof Error ? error.message : String(error);
      const code: number = (error as BusinessError).code;
      if (code === 13900020 || code === 13900042 || message.indexOf('cancel') >= 0 || message.indexOf('Cancel') >= 0) {
        HostCapabilities.log('fs.pickFiles：用户取消');
        const cancelled: PickFilesResult = { ok: true, dir: target, files: [], cancelled: true };
        return JSON.stringify(cancelled);
      }
      return HostCapabilities.internal('fs.pickFiles', error);
    }
  }

  /**
   * 目录选择（实验）：验证手机形态能否用「安全访问」选中一个**文件夹**并把它当工作区。
   *
   * 要回答两件事：① 系统选择器在 phone 上是否真的支持 `DocumentSelectMode.FOLDER`
   * （`@ohos.file.picker.d.ts` 的注释写着 *Only 2-in-1 devices are supported*，但本机
   * `/system/etc/syscap.json` 里确实带 `...UserFileService.FolderSelection`）；
   * ② 选中后 Node 侧能不能用**真实路径**读到它（picker 给的是 `file://docs/...` URI，
   * 而 libnode 只认路径）。所以把 uri、映射出的路径、以及两种读法的探测结果一起回传。
   */
  private static async pickFolder(context: common.UIAbilityContext, _args: string): Promise<string> {
    const probes: FolderProbe[] = [];
    try {
      const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 1;
      options.selectMode = picker.DocumentSelectMode.FOLDER;
      const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
      HostCapabilities.log('fs.pickFolder：打开目录选择器');
      const uris: string[] = await documentPicker.select(options);
      for (let i = 0; i < uris.length; i++) {
        probes.push(HostCapabilities.probeFolder(uris[i]));
      }
      const result: PickFolderResult = { ok: true, cancelled: uris.length === 0, probes: probes };
      return JSON.stringify(result);
    } catch (error) {
      const message: string = error instanceof Error ? error.message : String(error);
      const code: number = (error as BusinessError).code;
      if (code === 13900020 || code === 13900042 || message.indexOf('cancel') >= 0 || message.indexOf('Cancel') >= 0) {
        const cancelled: PickFolderResult = { ok: true, cancelled: true, probes: probes };
        return JSON.stringify(cancelled);
      }
      const failed: PickFolderResult = {
        ok: false,
        cancelled: false,
        probes: probes,
        error: 'code=' + code + ' ' + message,
      };
      return JSON.stringify(failed);
    }
  }

  /**
   * 把一个目录 uri 映射成 libnode 认的真实路径，并确认它可读。
   *
   * 为什么只探读不探写：手机上的「安全访问」给的是**只读**授予（建目录可以，落文件、删文件
   * 一律 `Permission denied`，实测见 docs/ACL配置.md §8），所以这里不再往用户目录里写探针文件。
   */
  private static probeFolder(uri: string): FolderProbe {
    const probe: FolderProbe = {
      uri: uri,
      mapped: HostCapabilities.uriToPath(uri),
      pathReadable: false,
      pathEntries: -1,
    };
    try {
      probe.pathReadable = fs.accessSync(probe.mapped);
    } catch (error) {
      probe.pathError = error instanceof Error ? error.message : String(error);
    }
    try {
      // libnode 只认路径，所以真正要紧的是「映射出的路径能不能当普通目录用」。
      const names: string[] = fs.listFileSync(probe.mapped);
      probe.pathEntries = names.length;
    } catch (error) {
      probe.pathError = (probe.pathError ?? '') + ' | list: ' + (error instanceof Error ? error.message : String(error));
    }
    return probe;
  }

  /** `file://docs/storage/Users/currentUser/Documents/x` → `/storage/Users/currentUser/Documents/x`。 */
  private static uriToPath(uri: string): string {
    const marker: string = 'file://docs';
    if (uri.indexOf(marker) === 0) {
      return uri.substring(marker.length);
    }
    if (uri.indexOf('file://') === 0) {
      return uri.substring('file://'.length);
    }
    return uri;
  }

  /** URI 末段作为文件名（去掉 query / 百分号编码）。 */
  private static baseName(uri: string): string {
    let text: string = uri;
    const query: number = text.indexOf('?');
    if (query >= 0) {
      text = text.substring(0, query);
    }
    const slash: number = text.lastIndexOf('/');
    const raw: string = slash >= 0 ? text.substring(slash + 1) : text;
    let name: string = raw;
    try {
      name = decodeURIComponent(raw);
    } catch (error) {
      name = raw;
    }
    return name === '' ? 'imported' : name;
  }

  /** 目标目录里重名时追加 `-1`、`-2`…，绝不覆盖用户已有的文件。 */
  private static uniqueName(dir: string, name: string): string {
    if (!fs.accessSync(dir + '/' + name)) {
      return name;
    }
    const dot: number = name.lastIndexOf('.');
    const stem: string = dot > 0 ? name.substring(0, dot) : name;
    const ext: string = dot > 0 ? name.substring(dot) : '';
    for (let i = 1; i < 1000; i++) {
      const candidate: string = stem + '-' + i + ext;
      if (!fs.accessSync(dir + '/' + candidate)) {
        return candidate;
      }
    }
    return stem + '-' + Date.now() + ext;
  }

  private static async openAppInfo(context: common.UIAbilityContext): Promise<string> {
    try {
      const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT
      );
      const want: Want = {
        action: 'ohos.settings.application.details',
        parameters: { bundleName: info.name }
      };
      await context.startAbility(want);
      const ok: OkResult = { ok: true };
      return JSON.stringify(ok);
    } catch (error) {
      return HostCapabilities.internal('perm.openAppInfo', error);
    }
  }

  private static async openExternal(context: common.UIAbilityContext, args: string): Promise<string> {
    try {
      const parsed: UriArgs = JSON.parse(args) as UriArgs;
      const uri: string = parsed.uri ?? '';
      if (!uri.startsWith('https://')) {
        const refused: CapabilityError = {
          ok: false,
          error: 'not-implemented',
          hint: 'only https links are allowed in 000-scaffold'
        };
        return JSON.stringify(refused);
      }
      await context.openLink(uri);
      const ok: OkResult = { ok: true };
      return JSON.stringify(ok);
    } catch (error) {
      return HostCapabilities.internal('shell.openExternal', error);
    }
  }

  private static tokenId(): number {
    const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
      bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION
    );
    return info.appInfo.accessTokenId;
  }

  private static internal(name: string, error: Object): string {
    const message: string = error instanceof Error ? error.message : String(error);
    const payload: CapabilityError = { ok: false, error: 'internal', hint: `${name}: ${message}` };
    return JSON.stringify(payload);
  }
}
