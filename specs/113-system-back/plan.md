# 113 · 系统返回键行为（Ark 版，plan.md）

> 对应：`spec.md` ｜ 状态：⬜ Planned

## 一、方案要点

1. **插件 `@dsh-ohos/back`**
   - `packages/back-ohos/{package.json, lib/index.js, lib/seam.js, README.md}`；
   - `lib/index.js`：`name='back-ohos'`/`inject=['webServer']`/`apply()` → `index-inject` kind:script。
2. **bundle insert**：`packages/bundle-ohos/cordis.patch.yml` 追加 `- id: back-ohos / name: '@dsh-ohos/back'`；`assemble-payload.mjs` 自动物化 + FR-105-005 校验。
3. **Index.ets**：实现 `onBackPress(): boolean` → `controller.runJavaScript(...)` → `return true`；API 以 DevEco SDK 为准（try/catch + hilog，不空 catch）。
4. **装配/编译验证**：`node scripts/assemble-payload.mjs` → `bash scripts/build-hap.sh`（能构建则构建，作为无真机下的最高验证层级）。
5. **真机**：无设备，跳过；文档如实标注。

## 二、风险与对策

| 风险 | 对策 |
|---|---|
| `runJavaScript` API 签名（callback vs promise）不确定 | 以 DevEco SDK 类型定义为准；try/catch + hilog，语义降级为"仅日志、不退出" |
| `onBackPress` 在 ArkWeb 页面顶层回车时的行为差异 | return true 无条件消费；若页面有自定义返回需要再按用例细化 |
| 合成 Escape 未关闭弹层（同 android 风险） | 前端已核无 isTrusted 守卫；备选：模拟点击设置关闭按钮/掩膜 |

## 三、改动文件清单

| 文件 | 动作 |
|---|---|
| `packages/back-ohos/package.json` | 新增（`@dsh-ohos/back`）|
| `packages/back-ohos/lib/index.js` | 新增（host 半边 + SEAM_JS 内联）|
| `packages/back-ohos/lib/seam.js` | 新增（可读 seam 源码，供 index.js 引用内联）|
| `packages/back-ohos/README.md` | 新增 |
| `packages/bundle-ohos/cordis.patch.yml` | insert 追加 `back-ohos` |
| `entry/src/main/ets/pages/Index.ets` | 新增 `onBackPress()` + `runJavaScript` 调用 |
