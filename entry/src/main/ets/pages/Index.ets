import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import BuildProfile from 'BuildProfile';
import { Constants } from '../common/Constants';
import { DshRuntime, LaunchPhase, LaunchSnapshot } from '../app/DshRuntime';
import { Probe } from '../app/Probe';
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
  // 页面加载尝试次数：加载失败会带着这个计数重试（最多 10 次），用于扛住
  // 「Host 刚 ready、监听还没接上连接」的窗口期。
  private loadAttempts: number = 0;

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
  // 每轮通话一个序号：点「挂断」就自增，让还在等待中的旧轮次在下一个 await 之后自行退出。
  // 用户要求「挂断要随时能按，不用等朗读念完」，所以按钮不再按状态禁用，靠这个序号收尾。
  private callTurnId: number = 0;

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
    // ArkWeb 会把 127.0.0.1 上的 Cookie 一路攒下来；积累过多后请求头超过 Node 的 16KB 上限，
    // 本地服务直接回 431，页面就停在 arkweb-error 白屏（2026-11-23 真机复现，重启也不恢复）。
    // 本地 DSH 的登录凭据在 URL token 与会话存储里，Cookie 用不上，启动时清一次。
    try {
      webview.WebCookieManager.clearAllCookiesSync();
    } catch (error) {
      hilog.warn(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, 'clearAllCookies 失败：%{public}s',
        error instanceof Error ? error.message : String(error));
    }
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
    const url: string = this.pendingUrl;
    this.loadAttempts++;
    const attempt: number = this.loadAttempts;
    // 加载前先探活：Host 刚写 ready.json 时监听可能还没开始接受连接，这时直接 loadUrl
    // 会落到 ArkWeb 的 arkweb-error 错误页（整页白屏，而且不会自己恢复——真机上出现过）。
    // 等它真能连上（HEAD 通）再加载，最多等 2 秒。
    Probe.waitFor(url, 8, 250).then((alive: boolean): void => {
      if (attempt !== this.loadAttempts) {
        // 期间又发起了新的加载，交给最新那一次。
        return;
      }
      if (!alive) {
        console.warn(`[DSH_DESKTOP_ARK] 探活未通过，仍然尝试加载：${url}`);
      }
      try {
        this.controller.loadUrl(url);
      } catch (error) {
        const message: string = error instanceof Error ? error.message : String(error);
        this.detail = `loadUrl 失败：${message}`;
        this.showOverlay = true;
      }
    });
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
      // 点会话行会让 composer 拿到焦点，把软键盘顶出来：语音通话用不到键盘，
      // 而且键盘弹起会盖住面板。点完立刻把焦点还回去（真机反馈「第一次点说话总弹键盘」）。
      try {
        const active = document.activeElement;
        if (active && typeof active.blur === 'function') { active.blur(); }
        if (document.body && typeof document.body.focus === 'function') { document.body.focus(); }
        if (window.getSelection) { window.getSelection().removeAllRanges(); }
      } catch (error) { /* 忽略：焦点操作失败不影响通话 */ }
      return 'clicked';
    })()`;
  }

  /** 把页面里的焦点收掉，避免软键盘被顶出来（语音通话全程不需要键盘）。*/
  private buildBlurScript(): string {
    return `(() => {
      try {
        const active = document.activeElement;
        if (active && typeof active.blur === 'function') { active.blur(); }
        if (document.body && typeof document.body.focus === 'function') { document.body.focus(); }
        if (window.getSelection) { window.getSelection().removeAllRanges(); }
        return 'blurred';
      } catch (error) {
        return 'blur-failed';
      }
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
  /** 这一轮是否还该继续（用户点过「挂断」就为 false）。*/
  private liveTurn(turnId: number): boolean {
    return turnId === this.callTurnId;
  }

  private async runCallTurn(): Promise<void> {
    // 朗读中也允许直接再说话：相当于「打断它、接着说」（用户要求「不要等念完才能继续」）。
    if (this.callState !== 'idle' && this.callState !== 'error' && this.callState !== 'speaking') {
      return;
    }
    const turnId: number = ++this.callTurnId;
    const context: common.UIAbilityContext = this.getUIContext().getHostContext() as common.UIAbilityContext;
    // 先掐掉上一轮还在念的回复：否则麦克风会把喇叭里的声音录进去，音频焦点也会打架。
    await HostCapabilities.stopSpeakForCall(context);
    if (!this.liveTurn(turnId)) {
      return;
    }
    this.callTranscript = '';
    this.callReply = '';
    this.callState = 'listening';
    this.callStatus = '正在听你说…（说完停 1 秒就自动结束，最长 30 秒）';
    // 先开录、再准备会话：会话探测/打开可能要几百毫秒到几秒，放在录音之前会把用户开口的
    // 头几个字整段丢掉（真机反馈「识别前边的拾音会缺失好几秒」）。录音在宿主侧跑，页面这边
    // 同时去开会话，两边并行。
    const recording = HostCapabilities.recordForCall(context, 30000);
    // 首页没有会话视图时，自动打开最近的会话：让用户「先去点会话、再回来点说话」太别扭（真机踩过）。
    let sessionReady: boolean = false;
    try {
      const probe: string = await this.evalInPage(this.buildReadScript());
      const probeState: string = (JSON.parse(probe) as PageReplyState).state ?? '';
      sessionReady = probeState !== 'no-column';
      if (!sessionReady) {
        const opened: string = await this.evalInPage(this.buildOpenSessionRowScript());
        if (opened === 'clicked') {
          for (let i = 0; i < 24; i++) {
            await this.sleep(250);
            const again: string = await this.evalInPage(this.buildReadScript());
            const nextState: string = (JSON.parse(again) as PageReplyState).state ?? '';
            if (nextState !== 'no-column') {
              sessionReady = true;
              break;
            }
          }
        } else {
          sessionReady = false;
        }
      }
    } catch (error) {
      sessionReady = false;
    }
    // 会话视图刚渲染完时 composer 可能又被自动聚焦（软键盘弹起来盖住面板），再收一次焦点。
    try {
      await this.evalInPage(this.buildBlurScript());
    } catch (error) {
      // 收不掉也不影响通话。
    }
    const recorded = await recording;
    if (!this.liveTurn(turnId)) {
      return;
    }
    if (!sessionReady) {
      this.callState = 'error';
      this.callStatus = '没能打开会话：先在 DSH 里手动点开一个会话，再点「说话」';
      return;
    }
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
    if (!this.liveTurn(turnId)) {
      return;
    }
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
    if (!this.liveTurn(turnId)) {
      return;
    }
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
    if (!this.liveTurn(turnId)) {
      return;
    }
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
          // 主文档加载失败：多半是 Host 端口刚换/监听刚起来，或 Cookie 攒多了让服务端回 431。
          // 重试前顺手清一次 Cookie（本地服务用不到 Cookie），比直接白屏好。
          if (this.loadAttempts < 10) {
            this.detail = `页面加载失败：${info}（重试中 ${this.loadAttempts}/10）`;
            try {
              webview.WebCookieManager.clearAllCookiesSync();
            } catch (error) {
              // 清不掉也照样重试。
            }
            setTimeout((): void => {
              this.loadPending();
            }, 400);
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
          // 透明玻璃球：整个球面（本体渐变 + 左上局部反光斑 + 高光核 + 右下内壁反射 + 描边 + 线条话筒）
          // 都画在 ic_phone_glass.svg 里，避免 ArkUI 各属性叠加时出现灰杠/不透材质。
          Image($r('app.media.ic_phone_glass'))
            .width(52)
            .height(52)
            .objectFit(ImageFit.Contain)
            .draggable(false)
            .clip(true)
            .borderRadius(26)
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

            Row({ space: 10 }) {
              Button(this.callState === 'listening' ? '录音中…'
                : this.callState === 'speaking' ? '打断并说话' : '说话')
                .layoutWeight(1)
                .height(52)
                .backgroundColor('#0F766E')
                .fontColor('#FFFFFF')
                .enabled(this.callState === 'idle' || this.callState === 'error' || this.callState === 'speaking')
                .onClick((): void => {
                  this.runCallTurn();
                })
              if (this.callState === 'speaking') {
                Button('停止朗读')
                  .layoutWeight(1)
                  .height(52)
                  .backgroundColor('#F59E0B')
                  .fontColor('#FFFFFF')
                  .onClick((): void => {
                    // 只掐掉朗读、不挂断：用户想接着说，不该把整通通话退出。
                    this.callTurnId++;
                    const context: common.UIAbilityContext =
                      this.getUIContext().getHostContext() as common.UIAbilityContext;
                    HostCapabilities.stopSpeakForCall(context);
                    this.callState = 'idle';
                    this.callStatus = '已停止朗读，点「说话」接着说';
                  })
              }
              Button('挂断')
                .layoutWeight(1)
                .height(52)
                .backgroundColor('#DC2626')
                .fontColor('#FFFFFF')
                .onClick((): void => {
                  // 任何时候都能挂断（用户反馈「不要等朗读念到最后才给按」）：
                  // 序号自增让还在跑的旧轮次在下一个 await 后自行退出，再掐掉朗读、收起面板。
                  this.callTurnId++;
                  this.callVisible = false;
                  this.callState = 'idle';
                  this.callStatus = '点「说话」，说完自动发送';
                  const context: common.UIAbilityContext =
                    this.getUIContext().getHostContext() as common.UIAbilityContext;
                  HostCapabilities.stopSpeakForCall(context);
                })
            }
            .margin({ top: 4 })

            Text('半双工：说完自动发送；读取回复时可点「停止朗读」或直接「打断并说话」，随时能挂断')
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
