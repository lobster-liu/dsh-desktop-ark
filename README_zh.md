[English](./README.md) | 中文

# DSH Desktop · 鸿蒙版

> **官方 DeepSeek Harness（dsh）Web UI，原样未改**，运行在鸿蒙 2in1 / 平板上的**系统 ArkWeb** 里 —— 而 dsh Host 跑在**同一进程内嵌的真实 Node.js 运行时**上。没有 Electron、不自带浏览器内核、不重写 ArkUI。
>
> 它在**手机上**也能跑：0.2.2 已在 HUAWEI Pura X Max（`HOP-AL10`，HarmonyOS 7.0.0.111 / **API 26**，`deviceType=phone`）真机验证 —— 装机、载荷、对话、账号登录、文件导入、只读文件夹工作区全部可用。手机特有的限制在《能力一览》里标注，过程记录见 [`docs/020-手机形态实测记录.md`](docs/020-手机形态实测记录.md)。

<p align="center">
  <img src="https://img.shields.io/badge/release-0.2.2-4D6BFE" alt="版本">
  <img src="https://img.shields.io/badge/dsh-dsh--v0.2.2--rc.3-7C5CFF" alt="dsh 版本">
  <img src="https://img.shields.io/badge/HarmonyOS-API%2024%2B-0A59F7" alt="HarmonyOS API 24+">
  <img src="https://img.shields.io/badge/Node-v26.13.0-5FA04E" alt="Node 26.13.0">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F" alt="MIT">
</p>

## 你能得到什么

- **还是那个 dsh** —— 会话、工具、插件、设置、主题全都在，前端是上游原样；智能体宿主跑在本机，没有中转、没有 CORS、没有账号门槛。
- **不需要自带渲染器** —— 界面由系统 WebView 绘制，所以包里只有智能体运行时（载荷约 42 MB），不背浏览器内核。HAP 约 88 MB。
- **安装不需要受限权限** —— 默认构建是无 JIT 的 `compat` 形态，侧载不需要任何 ACL 绑定权限；另有 `jit` 形态供已获可写代码内存权限的设备使用。
- **上游零改动** —— 鸿蒙差异集中在一个 `ohos` profile、一层 bundle、若干 seam 插件和 6 个带标记的垫片里。升级 dsh 是重跑管线，不是重做补丁。
- **以本产品身份呈现** —— 自己的图标、名称与窗口标题；上游的"预览版说明"和 DeepSeek 首次配置不再自动弹出（两者在设置里仍可手动打开）。

## 鸿蒙上的两个版本

鸿蒙有**两个独立版本**，壳架构、未改动的 Web UI、数据面完全相同，差别只在**由谁提供 Node**：

| | **鸿蒙版**（本仓库） | **Electron on HarmonyOS 版**（[`dsh-desktop-hos`](../dsh-desktop-hos)） |
|---|---|---|
| 渲染 | 系统 **ArkWeb** —— 不随包带内核 | Electron 37 内置 Chromium |
| Node.js | 应用进程内 `libnode.so`（v26.13.0） | Electron 运行时内置（Node 22.17） |
| 运行时管线 | [`@fellow99/node-bridge`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-bridge) + [`@fellow99/node-runtime`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-runtime)（ohpm 中心仓包） | [`harmonypc-electron`](../harmonypc-electron) |
| 上游 dsh 补丁 | **0** —— profile + bundle 层 + 已审计垫片 | 13 个源码补丁 |
| 安装要求 | 无（默认无 JIT） | 需 JIT 受限权限（ACL） |
| 包体 | 约 88 MB | Electron 体量（数百 MB） |
| 成熟度 | 0.2.2 —— 已在 API 24（2in1）与 API 26（手机）两种形态真机验证 | 0.2.2 —— 已构建并签名（真机复验待做；0.2.0 基线） |

两者不互相替代：Electron 版用自带 Chromium 与 JIT 换来最接近桌面的保真度；本版用较小的包体与免权限安装换来"平台差异由垫片层兜住"。

## 能力一览

| 方面 | 状态 |
|---|---|
| dsh Web UI、会话、工具、技能、子 agent | ✅ 与上游一致 |
| 文件读 / 写 / 编辑、图片附件 | ✅ |
| 工作区选择：沙箱 + `文档` / `下载`（授权后可读写） | ✅ 2in1 / 平板 |
| 手机上用系统目录选择器挂工作区 | ✅ 可用，但**只读** —— 「安全访问」的授予不允许写文件 |
| 手机上 `文档` / `下载` 的**直接**目录权限 | ⚠️ 平台白名单（hilog：`isSupportDirectoryPG=false`、`configValue=3`），侧载包永远 `authResult=2`；请改用只读文件夹或「从文件导入」 |
| Git（21 个工具，纯 JS，设备无需 `git` 二进制） | ✅ |
| profile 内的本地插件、本产品品牌位 | ✅ |
| 插件市场（宿主通道：`dshmarket` + 进程内 pnpm） | ✅ 通道随包；UI 真机验收待补 |
| 升级后保留已装插件与 pnpm store | ✅ 0.2.2 起（[`docs/pnpm+dsh-market.md`](docs/pnpm+dsh-market.md) §3.7） |
| 命令执行（`bash`） | ✅ 手机上走**内置 JS shell**（`echo/ls/cat/grep/find/cp/mv/rm/管道/重定向/node` 等），外部二进制（`git`/`tar`/`rg`/`curl`/`bun`）不可用——应用域无法 `exec` |
| 内容搜索（`grep` / `glob`） | ⚠️ 需要纯 JS 后端（arm64 上没有 `ripgrep` 二进制） |
| 删除 / 移动 / 复制 / chmod | ⚠️ 上游 `ctx.fs` 尚无这些原语 |
| 托盘图标、窗口状态记忆、无边框窗口 | — 本版不提供 |

完整矩阵（每项能力、两个版本并列、含根因）见 [`docs/鸿蒙环境能力清单-0.2.1.md`](docs/鸿蒙环境能力清单-0.2.1.md)。

## 语音通话（半双工）

会话页右上角那颗玻璃球就是语音通话入口：说一句 → 识别 → 直接发进当前会话 → 回复念给你听。手机上已按真机调试到可用（`call-panel74` / `d1a2426`）：

| 环节 | 实现 |
|---|---|
| 录音 | VAD 自动收尾（停顿 `0.7 / 1.3 / 2.2 秒` 三档）+ 句尾补 `0.4 秒`；麦克风 `蓝牙耳机优先 / 自动 / 只用手机麦`；耳机麦先做 0.5 秒「叫醒」SCO 再录 |
| 识别 | 云端 `qwen3-asr-flash`（阿里云百炼业务空间域名）优先；未配置或失败回退系统离线引擎（2–6 秒一段、停顿优先切分） |
| 发送 | 页面内同步 XHR 直发 `POST /api/session/prompt`（`mode=queue`），不碰输入框 ⇒ 不弹软键盘 |
| 朗读 | 云端 `qwen3-tts-flash` / `cosyvoice-v3-flash`（分段并发 + 拼接 WAV）优先，失败回退系统 TTS；出口跟随系统（耳机/眼镜 A2DP 已验证） |
| 读回复 | 认「本轮费用」页脚为轮次结束，跳过思考块、过程状态行与上下文注入；240 秒窗口，超时也把已到的正文念出来 |

配置（识别方式 / 停顿档位 / 朗读来源 / 麦克风 / 实时字幕 / 云端 key·域名·模型·音色）在面板「设置」里，落盘到应用沙箱 `runtime/voice-settings.json`，ArkTS 与随包 Node 侧共读同一份。链路细节、构建步骤与排障清单见 [`docs/030-语音通话面板.md`](docs/030-语音通话面板.md)。

设置里打开「实时字幕」后，麦克风一直读、边说边在面板上出字（`640B / 20ms` 流式喂引擎，停顿够久自动发送），这是全双工的地基；宿主侧能力为 `speech.captionStart / captionSnapshot / captionStop`。

已知边界：**发送仍是半双工**（回复朗读期间麦克风关闭，避免把喇叭声录进去），全双工待做；系统 TTS 会截断长文本，所以长回复必须走云端朗读。

## 状态

`0.2.2`（`versionCode` 202）—— **已构建**（dsh-v0.2.2-rc.3 / Node 26.13.0）。**两种形态都已真机验证**：`0.2.1` 在 HarmonyOS 6.1.0.135 / API 24（2in1），`0.2.2` 在 **HUAWEI Pura X Max（`HOP-AL10`，HarmonyOS 7.0.0.111 / API 26，`deviceType=phone`）**。手机上已验证：零 ACL 装机、载荷自解包并 `ready`、垫片全部安装、`node:sqlite`/FTS5 可用、文本与图片对话、沙箱工作区 + 「从文件导入」、**用系统目录选择器挂只读工作区**、账号登录（经登录桥接交给系统浏览器）、市场里装卸插件，以及**升级后已装插件仍然保留**（见 [`docs/pnpm+dsh-market.md`](docs/pnpm+dsh-market.md) §3.7）。已知缺口与修复点见上面的能力清单。

## 构建

前置：DevEco **Command Line Tools**（SDK API 24）与同级子模块 `../deepseek-harness`。Node 运行时来自 OpenHarmony 三方库中心仓：[`@fellow99/node-bridge`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-bridge)（API + NAPI 引导件）与 [`@fellow99/node-runtime@26.13.0`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-runtime)（`libnode.so` 引擎，SHA-256 由随包 `runtime.lock.json` 锁定），`ohpm install` 自动拉取。

```bash
node scripts/assemble-payload.mjs --deploy --apply   # ① 物化 dsh 运行树
bash scripts/build-hap.sh           # ② ohpm install → 载荷归档 + HAP 构建/签名
hdc app install -r entry/build/default/outputs/default/entry-default-signed.hap
```

`OHOS_CLT` 可覆盖工具链根目录，**两种布局都支持**：Command Line Tools（`<root>/bin` + `<root>/sdk` + `<root>/tool/node`），或 DevEco Studio 安装根（`<root>/tools/{hvigor,ohpm,node}/bin` + `<root>/sdk` + `<root>/jbr`）。`node scripts/verify-upstream.mjs` 校验上游锁定未被破坏（tag、工作树干净、patch id、品牌与引导门禁）。

### 签名（遇到「签名失败」先看这里）

`assembleHap` 的 `hap-sign-tool.jar` 用的是 **`PATH` 里第一个 `java`**（hvigor 任务不钉 JDK）。机器上若另装了 JDK（sdkman/Temurin、Adoptium…），签名会报一个与 HAP 完全无关的误导性错误：

```
Failed :entry:default@SignHap...
ERROR: 11012006 File IO failed
Error Message: Invalid CEN header (invalid zip64 extra data field size)
```

所以 `scripts/build-hap.sh` 会自带把 DevEco 的 **JBR** 前置到 `PATH`（并用 `cygpath -u` 转成 POSIX 形式，否则 MSYS bash 找不到 `java.exe`），同时导出 `JAVA_HOME`。若你自己直接调 `hvigorw`，也要同样处理。

签名材料**不入库**：要么让 DevEco Studio 生成签名（它会把 `app.signingConfigs` 写进 `build-profile.json5` —— **不要提交该文件**，构建完回退），要么用 `signing.debug.local.json` / `signing.release.local.json`（gitignored）提供**明文**口令（`certpath`、`storeFile`、`profile`、`keyAlias`、`keyPassword`、`storePassword`、`signAlg`）—— DevEco 生成的加密口令串只在 `build-profile.json5` 内联路径下能解。

`bash scripts/build-hap.sh --debug` 产出 `entry-default-signed.hap`，可在调试证书匹配的设备上 `hdc app install -r` 直装；`--release` 需 release profile，且只能经 AppGallery 分发。

## 文档

| 文档 | 回答什么 |
|---|---|
| [能力清单 0.2.2](docs/鸿蒙环境能力清单-0.2.1.md) | 能做什么、不能做什么，与 Electron 版如何对标 |
| [工程规划](docs/000-工程规划.md) | 为什么是这个架构、否决了什么、垫片白名单 |
| [真机调试记录](docs/010-真机调试记录.md) | 真机上踩了什么坑、怎么定位的 |
| [手机形态实测记录](docs/020-手机形态实测记录.md) | 在手机上跑这一版：`--jitless` 自检、登录、只读文件夹工作区、实测数字 |
| [语音通话面板](docs/030-语音通话面板.md) | 玻璃球通话：录音/VAD、云端与离线识别、云端朗读、读回复判据、设置文件、排障清单 |
| [JIT 与 ACL](docs/ACL配置.md) · [无 JIT 决策](docs/119-jitless-方案决策.md) | 两种运行时形态各自的代价 |
| [规格文档](specs/README.md) | 14 个规格模块（013、101–108、110、119、202、204、205）与门禁 |

## 相关工程

- [`dsh-desktop`](../dsh-desktop) —— Windows / Linux / macOS 的 Electron 桌面壳
- [`dsh-desktop-hos`](../dsh-desktop-hos) —— Electron on HarmonyOS 版
- [`@fellow99/node-bridge`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-bridge) / [`@fellow99/node-runtime`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-runtime) —— 以 ohpm 包形态在应用进程内嵌 Node（`node::Start`）
- [`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) —— 被封装的上游智能体宿主

## 许可证

[MIT](./LICENSE)
