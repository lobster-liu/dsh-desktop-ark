# 113 · 系统返回键行为（Ark · HarmonyOS Edition，spec.md）

> 状态：⬜ Planned（规格化）｜ 依据：需求 `113-system-back`（2026-11-11）
> 源码落点：`packages/back-ohos/`、`packages/bundle-ohos/cordis.patch.yml`、`entry/src/main/ets/pages/Index.ets`
> 宪法：C2 诚实降级 / C3 证据纪律 / C5 零补丁（上游源码）——seam 走 `webserver/index-inject`，不打上游补丁；本工程 `@dsh-ohos/bundle` 只允许「禁用 / 覆盖 config / 插入本工程行」三类操作。

## 一、问题陈述

`entry/src/main/ets/pages/Index.ets` 是单页 `@Entry`，ArkWeb 承载 dsh Web UI；**当前无任何返回拦截**：

- 页面栈仅一页（Index）；系统返回默认触发页面栈后退/应用终止 → 「直接退出返回到桌面」；
- `onPageEnd` 时 `controller.clearHistory()`（只清 boot.html，不打断 dsh 前端自身回退栈）。

期望（与三壳一致）：
| 场景 | 行为 |
|---|---|
| 设置页 | 退出设置页 |
| 抽屉 | 收回抽屉 |
| 弹窗 | 关闭弹窗 |
| 首页 / 会话页 | 不做任何操作 |

即：系统返回**永不退出应用**；只关闭最上层覆盖物，否则静默。

## 二、决策：载荷是否修改？补丁还是插件？

**需要修改载荷，采用「插件」方式（新增 `@dsh-ohos/back`）。**

- seam JS 与 Android/HOS 同源（顶层弹层 → Escape；抽屉 → 掩膜点击；否则无操作；幂等暴露 `window.__dshSystemBack(): boolean`）；
- Ark 装配：`packages/*-ohos/` 自动物化为 `@dsh-ohos/<name>`（`scripts/assemble-payload.mjs`，`manifest.name` 前缀判定），bundle insert 行由 FR-105-005 校验可解析；
- `webserver/index-inject` `kind:'script'` 为官方注入机制（`packages/client/web/src/apply-injections.ts`），既有 `branding-ohos`/`ui-responsive-android` 为同款先例。

## 三、功能需求

### FR-113-8 · 载荷 seam 注入（插件 `@dsh-ohos/back`）
- 新增 `packages/back-ohos/`：
  - `package.json`：`name=@dsh-ohos/back`、private、type module、main/exports→`lib/index.js`；
  - `lib/index.js`：`name='back-ohos'`、`inject=['webServer']`、`apply(ctx)` → `ctx.on('webserver/index-inject', table => table.push({ kind:'script', placement:'head', text: SEAM_JS }))`；
  - SEAM_JS：同构实现，语义选择器、审计标记 `DSH_OHOS_SYSTEM_BACK`。
- `packages/bundle-ohos/cordis.patch.yml` insert 追加 `- id: back-ohos / name: '@dsh-ohos/back'`。

### FR-113-9 · 页面返回拦截（Index.ets）
- 在 `@Entry` 组件实现 `onBackPress(): boolean`：
  - 调用 `this.controller.runJavaScript("(window.__dshSystemBack?window.__dshSystemBack():false)", ...)`（ArkWeb 页面 JS 执行，确认 API 签名后用 try/catch + hilog 记录，禁空 catch）；
  - **一律 `return true`（消费返回，不退出应用、不触发页面栈默认行为）**——满足「首页/会话页不做任何操作」且永不退出；
- loading/error 覆盖层期间同样 return true（无操作，不退出）。

### FR-113-10 · 返回不退出（约束）
- 系统返回永不触发 `terminateSelf()`；退出仅保留错误页「重启应用」按钮（既有）。
- `clearHistory()` 策略不变。

## 四、验收与测试
- 本机无鸿蒙真机 → **跳过真机测试**（需求注）；验收以"代码审查 + ArkTS/装配编译通过 + Android 同 seam 的 L1 证据"为准；
- 门禁：`node scripts/assemble-payload.mjs`（bundle insert 可解析、插件物化）；`scripts/build-hap.sh` 编译 eTS 通过（能构建则构建验证）。
- 证据纪律：宪法 C3。

## 五、边界
- 仅新增返回 seam 与页面 onBackPress；不改启动编排、导航围栏、clearHistory、错误页。
- ArkWeb `runJavaScript` 与 `onBackPress` 的 API 以 SDK（DevEco 6）实测为准，必要时按其 callback/promise 形态实现。
