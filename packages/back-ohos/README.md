# @dsh-ohos/back —— 系统返回键 seam（Ark 版）

> 需求：`specs/113-system-back/` ｜ 审计标记：`DSH_OHOS_SYSTEM_BACK`

## 是什么

Host 半边插件：经 [`webserver/index-inject`](../../../deepseek-harness/packages/client/web/src/apply-injections.ts) 下发 `kind:'script'` 页面脚本身，让系统「返回」键在 Web UI 内按上下文执行：

| 场景 | seam 行为 |
|---|---|
| 顶层弹层（设置页 / 通用对话框 / 菜单） | 派发 `Escape` → dsh `useModalLayer` 关闭最上层 |
| 窄屏侧栏抽屉展开 | 点击 `[data-sidebar-mask]` 掩膜收回（防御回退）|
| 首页 / 会话页 | 无操作（返回 `false`）|

页面只暴露 `window.__dshSystemBack(): boolean`。

## 机制与纪律

- **上游零补丁**：与 `@dsh-ohos/branding` 同款注入机制；语义选择器，抗上游重建。
- 本版 dsh UI 中抽屉（`data-shortcut-modal="sidebar"`）、设置（`data-shortcut-modal="settings"`）均为 aria-modal 对话框，统一由 `useModalLayer` 顶层 Escape 关闭——与 Android 版同构，源码/真机（Android L1）双验证。

## 接线

- `packages/bundle-ohos/cordis.patch.yml` insert 行：`- id: back-ohos / name: '@dsh-ohos/back'`。
- `scripts/assemble-payload.mjs` 自动物化 `packages/*-ohos/` → `node_modules/@dsh-ohos/`，FR-105-005 校验 insert 可解析。
- Ark 壳：`entry/src/main/ets/pages/Index.ets` 的 `onBackPress(): boolean` → `controller.runJavaScript(...)` → `return true`。

## 验证
- 无鸿蒙真机（跳过）；以装配/编译（assemble-payload + build-hap）为门禁；Android 同 seam 的 L1 证据为行为等价凭证。
