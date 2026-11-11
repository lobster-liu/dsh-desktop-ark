# 113 · 系统返回键行为（Ark 版，tasks.md）

> 对应：`spec.md` / `plan.md` ｜ 状态：⬜
> 真机：无（跳过测试，需求注）。

- [ ] T1. `packages/back-ohos/package.json`（`@dsh-ohos/back`，private，ESM）
- [ ] T2. `packages/back-ohos/lib/seam.js`（SEAM_JS 同 android 同源、标记 `DSH_OHOS_SYSTEM_BACK`）
- [ ] T3. `packages/back-ohos/lib/index.js`（`name`/`inject:['webServer']`/`apply` → `webserver/index-inject` kind script）
- [ ] T4. `packages/back-ohos/README.md`
- [ ] T5. `packages/bundle-ohos/cordis.patch.yml` insert 追加 `back-ohos` / `@dsh-ohos/back`
- [ ] T6. `entry/.../pages/Index.ets`：`onBackPress(): boolean` → `controller.runJavaScript(...)` → `return true`（try/catch + hilog）
- [ ] T7. 装配验证：`node scripts/assemble-payload.mjs` 通过
- [ ] T8. 编译验证：`bash scripts/build-hap.sh`（能构建则构建；作为本机最高验证）
- [ ] T9. 代码审查（Step 3.5）+ `lsp_diagnostics` 无新增错误
