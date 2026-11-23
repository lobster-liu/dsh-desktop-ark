import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import BuildProfile from 'BuildProfile';
import { Constants } from '../common/Constants';
import { DshRuntime, LaunchPhase, LaunchSnapshot } from '../app/DshRuntime';
import { HostCapabilities } from '../host/HostCapabilities';
/** 页面里读回来的会话状态（buildReadScript 的返回结构）。*/
interface PageReplyState {
  state?: string;
  reply?: string;
  items?: number;
}

/** `/_ohos/speech/cloud-asr` 的返回结构。*/
interface CloudRecognizeReply {
  ok?: boolean;
  text?: string;
  engine?: string;
  credential?: string;
  error?: CloudRecognizeError;
}

/** 云端识别的失败原因。*/
interface CloudRecognizeError {
  code?: string;
  message?: string;
}


/**
 * 单页外壳：ArkWeb 承载 dsh Web UI；启动期间叠加加。错误视图。
 *
 * 页面来源是本。HTTP（`http://127.0.0.1:<port>/`），不是 `file://`、也不是 `data:`。
 */
@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private runtime: DshRuntime = DshRuntime.get();
  private attached: boolean = false;
  private historyCleared: boolean = false;
  private pendingUrl: string = '';

  @State phase: string = LaunchPhase.IDLE;
  @State statusText: string = '正在启动…';
  @State detail: string = '';
  @State showOverlay: boolean = true;

  // 半双工通话（A 方案）：点「说话」录 6 。。识别 。送进当前会话 。等回。。朗读。
  @State callVisible: boolean = false;
  @State callState: string = 'idle';
  @State callStatus: string = '点「说话」，说完自动发送';
  @State callTranscript: string = '';
  @State callReply: string = '';

  aboutToAppear(): void {
    // 调试通道：debug 构建开。ArkWeb 远程调试（CDP），release 关闭。
    if (BuildProfile.DEBUG) {
      try {
        webview.WebviewController.setWebDebuggingAccess(true);
      } catch (error) {
        // 平台不支持时忽略：只影响调试，不影响功能。
      }
    }
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    this.runtime.launch(context, (snapshot: LaunchSnapshot): void => {
      this.phase = snapshot.phase;
      this.statusText = snapshot.message;
      this.detail = snapshot.detail;
      if (snapshot.url !== '') {
        this.pendingUrl = snapshot.url;
        this.showOverlay = false;
        this.loadPending();
      } else if (snapshot.phase === LaunchPhase.FAILED) {
        this.showOverlay = true;
      }
    });
  }

  private loadPending(): void {
    if (!this.attached || this.pendingUrl === '') {
      return;
    }
    try {
      this.controller.loadUrl(this.pendingUrl);
    } catch (error) {
      const message: string = error instanceof Error ? error.message : String(error);
      this.detail = `loadUrl 失败：${message}`;
      this.showOverlay = true;
    }
  }

  private openExternal(url: string): void {
    if (!url.startsWith('https://')) {
      return;
    }
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    context.openLink(url).catch((error: BusinessError): void => {
      this.detail = `外部打开失败：${error.message}`;
    });
  }

  private exitApp(): void {
    this.runtime.shutdown('user-exit');
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    context.terminateSelf().catch((error: BusinessError): void => {
      this.detail = `退出失败：${error.message}`;
    });
  }

  /**
   * 113-system-back：把系统返回转发。Web UI seam（`window.__dshSystemBack`，由
   * `@dsh-ohos/back` 。webserver/index-inject 注入）。seam 未就。页面未加载时静默降级
   * （记录日志，不做任何事）——返回键。`onBackPress` 统一消费，永不退出应用。
   */
  private dispatchSystemBack(): void {
    try {
      this.controller.runJavaScript('(window.__dshSystemBack ? window.__dshSystemBack() : false)')
        .then((result: string): void => {
          hilog.info(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, 'systemBack seam result: %{public}s', result);
        })
        .catch((error: BusinessError): void => {
          hilog.warn(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, 'systemBack runJavaScript failed: %{public}s', error.message);
        });
    } catch (error) {
      const message: string = error instanceof Error ? error.message : String(error);
      hilog.warn(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, 'systemBack dispatch error: %{public}s', message);
    }
  }

  /**
   * 113-system-back：系统返回一律消费（return true）——设置页/抽屉/弹窗。seam 关闭。
   * 首页/会话页无操作；应用永不因返回键退出。
   */
  onBackPress(): boolean {
    this.dispatchSystemBack();
    return true;
  }

  /**
   * 申请麦克风权限（`ohos.permission.MICROPHONE`）。
   *
   * ArkWeb 。`getUserMedia` 需要应用本身已获得该权限；用户第一次点录音时这里弹系统
   * 授权框，授权后页面上再点一次「重新录音」即可。已授权时不再弹窗。
   */
  private ensureMicrophonePermission(): void {
    const context: common.UIAbilityContext = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (!context) {
      return;
    }
    const manager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
    manager.requestPermissionsFromUser(context, ['ohos.permission.MICROPHONE'] as Permissions[])
      .then((result: Object): void => {
        hilog.info(Constants.HILOG_DOMAIN, Constants.HILOG_TAG,
          'microphone auth results: %{public}s', JSON.stringify(result));
      })
      .catch((error: BusinessError): void => {
        hilog.warn(Constants.HILOG_DOMAIN, Constants.HILOG_TAG,
          'microphone request failed: %{public}d %{public}s', error.code, error.message);
      });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }

  /**
   * 在页面里求值一。JS（ArkWeb `runJavaScript` 包成 Promise）。
   *
   * 注意：`runJavaScript` 返回的是**结果值的 JSON 文本**——脚。`return 'sent'` 拿到的是
   * `"sent"`（带引号）。这里统一剥掉一层字符串引号，否则调用方。`'sent'` 比对永远不成。
   * （真机曾表现为「发送失败："sent"」）。
   */
  private evalInPage(script: string): Promise<string> {
    return this.controller.runJavaScript(script).then((raw: string) => {
      const text: string = raw ?? '';
      if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        try {
          return JSON.parse(text) as string;
        } catch (error) {
          return text;
        }
      }
      return text;
    });
  }

  /**
   * 把一段文字塞。composer 并点发送。
   *
   * `e`document.execCommand('insertText')` 而不是直接改 `innerText`：React 的受控输入只
   * 真实 input 事件后更。state，直接改 DOM 会让发送出去的内容是空的（实测）。
   */
  /**
   * 直接把这一轮的文本发给会话（不。composer）。
   *
   * 早期版本是「往输入框里插文。+ 点发送按钮」，但输入框。**Lexical 编辑。*。
   * `execCommand('selectAll')`/`innerHTML` 都清不掉已有草稿，残留会和新的句子拼在一起；
   * 而且插文本会让输入框拿焦点、顶出软键盘和输入法语音助手（真机上「小艺」跳出来的原因）。
   * 现在改成用页面自带的会话接口：`localStorage['dsh.sessions.current']` 里有当前 sessionId =
   * `POST /api/session/prompt` 就是页面点击发送时走的那条请求（抓包确认）。
   *
   * 用同。XHR 是为了让 `runJavaScript` 能直接拿到状态码：返回。Promise 在这个桥上没。
   * await 语义，异。fetch 只能拿回 'started'。
   */
  /**
   * 首页 。会话视图的稳定路径：点侧栏里一。*真实会话**（跳过列表第一行的「新会话」）。
   *
   * 踩过的坑。
   * - 侧栏「新建会话」按。`.click()` 之后真机上什么都不发生，面板会一直判「没有打开的会话」。
   * - `[class*="sessionRow"]` 的第一项是「新会话」入口，点它反而回到首页。
   * - 侧栏收起时行元素 x 是负值（被移出可视区），。`.click()` 仍然有效，不用先展开侧栏。
   */
  private buildOpenSessionRowScript(): string {
    return `(() => {
      const rows = Array.prototype.slice.call(document.querySelectorAll('[class*="sessionRow"]'));
      if (rows.length === 0) { return 'no-row'; }
      const real = rows.filter((n) => {
        const t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
        return t.length > 0 && t !== '新会话';
      });
      const row = real.length > 0 ? real[0] : (rows.length > 1 ? rows[1] : null);
      if (!row) { return 'no-session'; }
      const inner = row.querySelector('[role="button"]') || row;
      inner.click();
      return 'clicked';
    })()`;
  }

  private buildSendScript(text: string): string {
    const literal: string = JSON.stringify(text);
    return `(() => {
      let sessionId = '';
      try {
        const raw = localStorage.getItem('dsh.sessions.current');
        if (raw) { sessionId = (JSON.parse(raw) || {}).sessionId || ''; }
      } catch (error) { return 'bad-session'; }
      if (!sessionId) return 'no-session';
      const uuid = () => (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0; const v = c === 'x' ? r : (r & 0x3) | 0x8; return v.toString(16);
          });
      const body = {
        type: 'client-request',
        rpcId: uuid(),
        method: 'session/prompt',
        payload: {
          args: {
            request: {
              requestId: uuid(),
              sessionId: sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: ${literal} }],
              clientTimeZone: 'Asia/Shanghai'
            }
          }
        }
      };
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/session/prompt', false);
        xhr.setRequestHeader('content-type', 'application/json');
        xhr.send(JSON.stringify(body));
        if (xhr.status >= 200 && xhr.status < 300) { return 'sent'; }
        return 'http-' + xhr.status + ':' + (xhr.responseText || '').slice(0, 120);
      } catch (error) {
        return 'xhr-failed:' + (error && error.message ? error.message : 'unknown');
      }
    })()`;
  }

  /**
   * 云端识别一条录音（DeepSeek ASR，账号代付）。
   *
   * 为什么走页面：账。token 只存在引擎里，取 token 与调用都。Host 侧完成，
   * 页面只把「录音文件路径」交。`/_ohos/speech/cloud-asr`（同源、同。XHR），
   * `eNode 侧读文件、套 WAV 头、带 `x-dsh-auth-token` 转发。失败时调用方回退离线识别拼在
   */
  private buildCloudRecognizeScript(path: string): string {
    const literal: string = JSON.stringify(path);
    return `(() => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/_ohos/speech/cloud-asr', false);
        xhr.setRequestHeader('content-type', 'application/json');
        xhr.send(JSON.stringify({ path: ${literal} }));
        return xhr.responseText || '';
      } catch (error) {
        return JSON.stringify({ ok: false, error: { code: 'xhr', message: String(error && error.message ? error.message : error) } });
      }
    })()`;
  }

  /**
   * 读当前会话最后一条助手消息。
   *
   * 会话 DOM：`[class*="_column"]` 下若。`[class*="flowItem"]`；用户那侧的条目里含
   * `[class*="userRow"]`，助手的条目。markdown 正文。`深度求索中` 出现即仍在生成。
   */
  private buildReadScript(): string {
    return `(() => {
      // 会话条目。class 每次构建都会换哈希前缀，所以先按稳定的语义片段找：
      // flowItem 是消息条目，userRow 只在用户那侧出现。找不到时再退回旧。_column 容器。
      let items = Array.from(document.querySelectorAll('[class*="flowItem"]'));
      if (items.length === 0) {
        const col = document.querySelector('[class*="_column"]');
        if (col) { items = Array.from(col.children); }
      }
      if (items.length === 0) return JSON.stringify({ state: 'no-column', reply: '', items: 0 });
      const thinking = (document.body.innerText || '').indexOf('深度求索中') >= 0;
      // 尾部还有「本轮费。。¥0.005 + 未定价用。/ 16:09 / 已完成，用时 2秒」这类条目，
      // 直接取最后一条会拿到费用行；按噪音正则跳过它们再取。
      const noise = /(本轮费用|深度求索中|已完成|^\\s*\\d{1,2}:\\d{2}\\s*$)/;
      let reply = '';
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.querySelector('[class*="userRow"]')) continue;
        const text = (item.innerText || '').trim();
        if (text.length < 2) continue;
        if (noise.test(text)) continue;
        reply = text; break;
      }
      return JSON.stringify({ state: thinking ? 'thinking' : 'done', reply: reply, items: items.length });
    })()`;
  }

  /**
   * 轮询页面，等本轮助手回复落地（`state === 'done'` 且正文与基线不同）。
   *
   * 为什么要基线：上一轮的回复还在页面上，发完新消息的头一两秒里最后一条助手条目仍。
   * 旧内容，只有它变了才说明本轮答复到了。
   */
  private async waitForReply(timeoutMs: number, baseline: string, baselineItems: number): Promise<string> {
    const deadline: number = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.sleep(1000);
      let raw: string = '';
      try {
        raw = await this.evalInPage(this.buildReadScript());
      } catch (error) {
        continue;
      }
      let parsed: PageReplyState | null = null;
      try {
        parsed = JSON.parse(raw) as PageReplyState;
      } catch (error) {
        parsed = null;
      }
      if (parsed === null) {
        continue;
      }
      const state: string = parsed.state ?? '';
      const reply: string = parsed.reply ?? '';
      const items: number = parsed.items ?? 0;
      // 条目数也要涨：只看「回复变了」会在上一轮还没渲染完时抢跑。
      if (state === 'done' && reply.length > 0 && reply !== baseline && items > baselineItems) {
        return reply;
      }
    }
    return '';
  }

  /**
   * 一轮半双工通话：录。。识别 。注入并发。。等回。。朗读。
   * 任一步失败就停在 `error` 状态并把原因显示在面板上。
   */
  private async runCallTurn(): Promise<void> {
    if (this.callState !== 'idle' && this.callState !== 'error') {
      return;
    }
    const context: common.UIAbilityContext = this.getUIContext().getHostContext() as common.UIAbilityContext;
    // 先掐掉上一轮还在念的回复：否则麦克风会把喇叭里的声音录进去，音频焦点也会打架。
    await HostCapabilities.stopSpeakForCall(context);
    // 首页没有会话视图时，自动打开最近的会话：让用户「先去点会话、再回来点说话」太别扭（真机踩过）。
    this.callState = 'listening';
    this.callStatus = '正在准备会话…';
    let sessionReady: boolean = false;
    try {
      const probe: string = await this.evalInPage(this.buildReadScript());
      const probeState: string = (JSON.parse(probe) as PageReplyState).state ?? '';
      sessionReady = probeState !== 'no-column';
      if (!sessionReady) {
        this.callStatus = '正在打开最近的会话…';
        const opened: string = await this.evalInPage(this.buildOpenSessionRowScript());
        if (opened !== 'clicked') {
          this.callState = 'error';
          this.callStatus = opened === 'no-row'
            ? '没有可用的会话：先在 DSH 里发过一条消息'
            : `打开会话失败：${opened}`;
          return;
        }
        for (let i = 0; i < 24; i++) {
          await this.sleep(250);
          const again: string = await this.evalInPage(this.buildReadScript());
          const nextState: string = (JSON.parse(again) as PageReplyState).state ?? '';
          if (nextState !== 'no-column') {
            sessionReady = true;
            break;
          }
        }
      }
    } catch (error) {
      sessionReady = false;
    }
    if (!sessionReady) {
      this.callState = 'error';
      this.callStatus = '没能打开会话：先在 DSH 里手动点开一个会话，再点「说话」';
      return;
    }
    this.callTranscript = '';
    this.callReply = '';
    this.callState = 'listening';
    this.callStatus = '正在听你说…（说完停 1 秒就自动结束，最长 30 秒）';
    // 「说多久录多久」：30 秒只是安全上限，实际按静音检测收尾（用户反馈固定 6 秒会截断）。
    const recorded = await HostCapabilities.recordForCall(context, 30000);
    if (!recorded.ok || recorded.path === undefined) {
      this.callState = 'error';
      this.callStatus = `录音失败：${recorded.error ?? '没有拿到音频'}`;
      return;
    }
    this.callState = 'recognizing';
    const stopNote: string = recorded.stopReason === 'empty' ? '没听到声音 · '
      : recorded.stopReason === 'max' ? '到 30 秒上限 · ' : '';
    const audioDetail: string =
      `${stopNote}${((recorded.durationMs ?? 0) / 1000).toFixed(1)}s · ${recorded.bytes ?? 0}B · 采样 ${recorded.sampleRate ?? 0}Hz · 峰值 ${recorded.peak ?? 0} · 来源 ${recorded.input ?? ''}`;
    // 云端优先：离线引擎的中文准确率有上限（同一段录音稳定错在同样的词），云。DeepSeek ASR
    // 由账号代付、约 1 秒出结果；拿不到文本再回退离线识别，保证离线也能用。
    this.callStatus = `正在识别（云端）…（${audioDetail}）`;
    let text: string = '';
    let engineNote: string = '云端';
    try {
      const raw: string = await this.evalInPage(this.buildCloudRecognizeScript(recorded.path));
      const cloud: CloudRecognizeReply = raw === '' ? {} : (JSON.parse(raw) as CloudRecognizeReply);
      if (cloud.ok === true && (cloud.text ?? '').trim() !== '') {
        text = (cloud.text ?? '').trim();
      } else {
        engineNote = `离线（云端不可用：${cloud.error?.message ?? '未返回文本'}）`;
      }
    } catch (error) {
      engineNote = '离线（云端调用失败）';
    }
    if (text === '') {
      this.callStatus = `正在识别（离线）…（${audioDetail}）`;
      const recognized = await HostCapabilities.recognizeForCall(context, recorded.path);
      text = (recognized.text ?? '').trim();
      if (text === '') {
        this.callState = 'error';
        this.callStatus = '没听清，再说一次（靠近手机、说完整一句）';
        return;
      }
      if (!recognized.ok) {
        this.callState = 'error';
        this.callStatus = `识别失败：${recognized.error ?? '未知原因'}`;
        return;
      }
    }
    this.callTranscript = text;
    this.callState = 'sending';
    this.callStatus = `正在发送给 DSH…（识别：${engineNote}）`;
    // 发之前记下页面上已有的最后一条回复与条目数，作为「本轮答复是否到了」的基线。
    let baseline: string = '';
    let baselineItems: number = 0;
    try {
      const before: string = await this.evalInPage(this.buildReadScript());
      const parsedBefore: PageReplyState = JSON.parse(before) as PageReplyState;
      baseline = parsedBefore.reply ?? '';
      baselineItems = parsedBefore.items ?? 0;
    } catch (error) {
      baseline = '';
      baselineItems = 0;
    }
    let sent: string = '';
    try {
      sent = await this.evalInPage(this.buildSendScript(text));
    } catch (error) {
      const failed: BusinessError = error as BusinessError;
      sent = failed.message;
    }
    if (sent !== 'sent') {
      this.callState = 'error';
      this.callStatus = `发送失败：${sent}`;
      return;
    }
    this.callState = 'waiting';
    this.callStatus = '等待 DSH 回复…';
    const reply: string = await this.waitForReply(120000, baseline, baselineItems);
    if (reply === '') {
      this.callState = 'error';
      this.callStatus = '没有等到回复（可到会话页查看）';
      return;
    }
    this.callReply = reply;
    this.callState = 'speaking';
    this.callStatus = '正在朗读回复…';
    const spoken = await HostCapabilities.speakForCall(context, reply.length > 1200 ? reply.slice(0, 1200) : reply);
    // 引擎。onComplete 会提前报（实。143 字在 +1.4s 就说完成，真实朗读约 30s），
    // 所以按字数估算的时长把「朗读中」保持住，别让用户以为读完了去点「说话」把它掐断。
    const waitMs: number = spoken.estimateMs !== undefined ? spoken.estimateMs : 3000;
    await this.sleep(waitMs);
    this.callState = 'idle';
    this.callStatus = '说完了，点「说话」继续';
  }

  /** 通话面板顶部的一句话状态（给用户看的当前阶段）。*/
  private stateLabel(): string {
    if (this.callState === 'listening') {
      return '正在听';
    }
    if (this.callState === 'recognizing') {
      return '正在识别';
    }
    if (this.callState === 'sending') {
      return '正在发送';
    }
    if (this.callState === 'waiting') {
      return '正在等回复';
    }
    if (this.callState === 'speaking') {
      return '正在朗读';
    }
    if (this.callState === 'error') {
      return '出错了';
    }
    return '待机';
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      // RenderMode.SYNC_RENDER：ASYNC_RENDER })Web 是独立图surface 节点，真机上系统输入
      // 窗口出现/关闭后该 surface 会脱离合成树（截图整片黑、DOM 仍正常），SYNC_RENDER 把内。
      // 作为画布节点与系统组件一起合成，规避该缺陷（HAD-W32 / API 26 实测）。
      Web({ src: $rawfile('boot.html'), controller: this.controller, renderMode: RenderMode.SYNC_RENDER })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(false)
        // 自动填充会拉起系。AutoFillAbility 窗口，真机上会让 Web 表面变黑（HAD-W32/API26 实测）。
        // 关闭后输入框仍可正常键入；调试亦可用 CDP。
        .enableAutoFill(false)
        // 语音输入：ArkWeb 。getUserMedia 只有在应用侧也持有麦克风权限时才能拿到音频流。
        // 页面发起请求时先把资源放行，并顺手向系统申请 `ohos.permission.MICROPHONE`。
        // 少了这一段，composer 会显示「麦克风权限未开启，请在浏览器和系统设置中允许访问。。
        .onPermissionRequest((event: OnPermissionRequestEvent): void => {
          const resources: Array<string> = event.request.getAccessibleResource();
          const wantsMic: boolean = resources.some((item: string) => item === 'ohos.permission.MICROPHONE');
          if (wantsMic) {
            this.ensureMicrophonePermission();
          }
          console.info(`[DSH_DESKTOP_ARK] 页面请求权限：${JSON.stringify(resources)}`);
          event.request.grant(resources);
        })
        // 导航围栏（FR-UI-003 / FR-103-008）：只放行本机服务；外链交给系统。
        .onLoadIntercept((event: OnLoadInterceptEvent): boolean => {
          const url: string = event.data.getRequestUrl();
          if (url === 'about:blank' || url.startsWith('http://127.0.0.1:') || url.startsWith('data:')) {
            return false;
          }
          this.openExternal(url);
          return true;
        })
        .onErrorReceive((event: OnErrorReceiveEvent): void => {
          // 只有**主文。*失败才算「页面打不开」。子资源失败（插件客户端模块、图标、API 请求。
          // 市场热挂。卸载瞬间。404/405）由 dsh 前端自己处理；把它们也当整页失败，会让一。
          // 插件装卸就弹出全屏「页面加载失败」，看起来像整个应用崩溃。
          const url: string = event.request.getRequestUrl();
          const info: string = event.error.getErrorInfo();
          if (!event.request.isMainFrame()) {
            console.warn(`[DSH_DESKTOP_ARK] 子资源加载失败（不影响页面）：${info} ${url}`);
            return;
          }
          this.detail = `页面加载失败：${info}`;
          this.showOverlay = true;
        })
        .onControllerAttached((): void => {
          this.attached = true;
          this.loadPending();
        })
        .onPageEnd((): void => {
          // 只清一次：清掉启动页（boot.html），不打。dsh 前端自身的回退栈。
          if (this.historyCleared) {
            return;
          }
          try {
            this.controller.clearHistory();
            this.historyCleared = true;
          } catch (error) {
            // 页面尚未形成历史时忽略；不影响功能。
          }
        })

      if (this.showOverlay) {
        Column({ space: 12 }) {
          Text('DSH Desktop Ark')
            .fontSize(20)
            .fontWeight(FontWeight.Medium)
          Text(this.phase)
            .fontSize(12)
            .fontColor('#888888')
          Text(this.statusText)
            .fontSize(16)
            .textAlign(TextAlign.Center)

          if (this.detail !== '') {
            Scroll() {
              Text(this.detail)
                .fontSize(12)
                .fontFamily('monospace')
                .width('100%')
                .copyOption(CopyOptions.LocalDevice)
            }
            .width('86%')
            .height(260)
            .borderRadius(8)
            .backgroundColor('#F5F5F5')
            .padding(12)
          }

          if (this.phase === LaunchPhase.FAILED) {
            Button('重启应用')
              .width(160)
              .onClick((): void => {
                this.exitApp();
              })
            Text('退出后重新打开应用即可重试（进程内运行时不可重启）')
              .fontSize(11)
              .fontColor('#888888')
              .textAlign(TextAlign.Center)
          }
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#FFFFFF')
      }

      // 通话入口：悬浮右上角。透明容器只让按钮接收点击，页面其余部分照常响应。
      if (!this.showOverlay && !this.callVisible) {
        Column() {
          // 毛玻璃圆。+ 线条话筒（不。emoji，跟随主题色，任何背景上都清楚）
          Stack({ alignContent: Alignment.Center }) {
            Circle()
              .width(46)
              .height(46)
              .fill('#00000000')
              .stroke('#2EFFFFFF')
              .strokeWidth(1)
            // 顶部高光带：制造水晶反。
            Image($r('app.media.ic_phone_line'))
              .width(28)
              .height(28)
              .objectFit(ImageFit.Contain)
              .draggable(false)
          }
          .width(52)
          .height(52)
          .clip(true)
          .borderRadius(26)
          .backgroundColor('#42FFFFFF')
          .radialGradient({ center: ['32%', '22%'], radius: '98%', colors: [['#A6FFFFFF', 0.0], ['#33FFFFFF', 0.45], ['#0FFFFFFF', 1.0]] })
          .border({ width: 1.2, color: '#8CFFFFFF' })
          .shadow({ radius: 16, color: '#59000000', offsetX: 0, offsetY: 6 })
          .onClick((): void => {
            this.callVisible = true;
            this.callState = 'idle';
            this.callStatus = '点「说话」，说完自动发送';
          })
        }
        .width('100%')
        .height('100%')
        .padding({ top: 54, left: 16, right: 18 })
        .alignItems(HorizontalAlign.End)
        .justifyContent(FlexAlign.Start)
        .hitTestBehavior(HitTestMode.Transparent)
      }

      // 半双工通话面板：录。。识别 。发。。等回。。朗读。
      if (this.callVisible) {
        Column() {
          Column({ space: 14 }) {
            Text('语音通话')
              .fontSize(20)
              .fontWeight(FontWeight.Medium)
            Text(`${this.stateLabel()} · ${this.callStatus}`)
              .fontSize(13)
              .fontColor('#0F766E')
              .textAlign(TextAlign.Center)

            if (this.callTranscript !== '') {
              Column({ space: 4 }) {
                Text('我说')
                  .fontSize(11)
                  .fontColor('#999999')
                  .width('100%')
                Text(this.callTranscript)
                  .fontSize(15)
                  .width('100%')
                  .textAlign(TextAlign.Start)
              }
              .width('100%')
              .padding(10)
              .borderRadius(10)
              .backgroundColor('#F2F7F6')
            }

            if (this.callReply !== '') {
              Scroll() {
                Column({ space: 4 }) {
                  Text('DSH')
                    .fontSize(11)
                    .fontColor('#999999')
                    .width('100%')
                  Text(this.callReply)
                    .fontSize(15)
                    .width('100%')
                    .textAlign(TextAlign.Start)
                }
                .width('100%')
              }
              .height(220)
              .width('100%')
              .padding(10)
              .borderRadius(10)
              .backgroundColor('#F5F5F5')
            }

            Row({ space: 12 }) {
              Button(this.callState === 'listening' ? '录音中…' : '说话')
                .width(150)
                .height(52)
                .backgroundColor('#0F766E')
                .fontColor('#FFFFFF')
                .enabled(this.callState === 'idle' || this.callState === 'error')
                .onClick((): void => {
                  this.runCallTurn();
                })
              Button('挂断')
                .width(110)
                .height(52)
                .backgroundColor('#E5E7EB')
                .fontColor('#111827')
                .enabled(this.callState !== 'listening' && this.callState !== 'speaking')
                .onClick((): void => {
                  this.callVisible = false;
                  this.callState = 'idle';
                  this.callStatus = '点「说话」，说完自动发送';
                  // 挂断时把还在念的回复停掉，否则离开面板后声音还在继续。
                  const context: common.UIAbilityContext =
                    this.getUIContext().getHostContext() as common.UIAbilityContext;
                  HostCapabilities.stopSpeakForCall(context);
                })
            }
            .margin({ top: 4 })

            Text('半双工：说完自动发送，等回复念完再点「说话」继续')
              .fontSize(11)
              .fontColor('#999999')
              .textAlign(TextAlign.Center)
          }
          .width('92%')
          .padding(20)
          .borderRadius(18)
          .backgroundColor('#FFFFFF')
          .shadow({ radius: 24, color: '#33000000', offsetY: 6 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .backgroundColor('#B3000000')
      }
    }
    .width('100%')
    .height('100%')
  }
}
