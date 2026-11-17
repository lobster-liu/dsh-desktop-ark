[中文](./README_zh.md) | English

# DSH Desktop · HarmonyOS Edition

> The **official DeepSeek Harness (dsh) Web UI, unmodified**, running on HarmonyOS 2in1 / tablet inside the system **ArkWeb** — with the dsh Host on a **real Node.js runtime embedded in the same process**. No Electron, no bundled Chromium, no ArkUI rewrite.
>
> It also runs on **phones**: 0.2.2 is device-verified on a HUAWEI Pura X Max (`HOP-AL10`, HarmonyOS 7.0.0.111 / **API 26**, `deviceType=phone`) — install, payload, conversations, account sign-in, file import and a read-only folder workspace all work. Phone-specific limits are marked in *Capabilities at a glance* and recorded in [`docs/020-手机形态实测记录.md`](docs/020-手机形态实测记录.md).

<p align="center">
  <img src="https://img.shields.io/badge/release-0.2.2-4D6BFE" alt="Version">
  <img src="https://img.shields.io/badge/dsh-dsh--v0.2.2--rc.3-7C5CFF" alt="dsh version">
  <img src="https://img.shields.io/badge/HarmonyOS-API%2024%2B-0A59F7" alt="HarmonyOS API 24+">
  <img src="https://img.shields.io/badge/Node-v26.13.0-5FA04E" alt="Node 26.13.0">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F" alt="MIT">
</p>

## What you get

- **The same dsh you already know** — sessions, tools, plugins, settings, themes. The frontend is upstream, untouched; the agent host runs locally, so there is no relay, no CORS, no account gate.
- **Nothing to render with** — the system WebView draws the UI, so the package ships only the agent runtime (≈42 MB payload) instead of a browser engine. The HAP is ≈88 MB.
- **Installs without restricted permissions** — the default build is JIT-free (`compat`), so side-loading needs no ACL-bound permission. A `jit` variant exists for devices granted the writable-code-memory permission.
- **Zero upstream changes** — HarmonyOS differences live in an `ohos` profile, one bundle layer, seam plugins and six audited shims. Upgrading dsh means re-running the pipeline, not re-doing patches.
- **Branded as this product** — own icon, name and window title; the upstream preview notice and the DeepSeek first-run dialog no longer open by themselves (both remain reachable in Settings).

## Two HarmonyOS editions

HarmonyOS gets **two independent editions** with the same shell architecture, the same unmodified Web UI and the same data plane; the difference is **which runtime provides Node**:

| | **HarmonyOS Edition** (this repo) | **Electron on HarmonyOS Edition** ([`dsh-desktop-hos`](../dsh-desktop-hos)) |
|---|---|---|
| Renderer | The system **ArkWeb** — nothing bundled | Chromium, shipped inside Electron 37 |
| Node.js | `libnode.so` started in the app's own process (v26.13.0) | Inside the Electron runtime (Node 22.17) |
| Runtime plumbing | [`@fellow99/node-bridge`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-bridge) + [`@fellow99/node-runtime`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-runtime) (ohpm) | [`harmonypc-electron`](../harmonypc-electron) |
| Upstream dsh patches | **0** — profile + bundle layer + audited shims | 13 source patches |
| Install requirement | none (JIT-free default) | JIT restricted permission (ACL) |
| Package size | ≈88 MB | Electron-sized (hundreds of MB) |
| Maturity | 0.2.2 — built (0.2.1 device-verified on HarmonyOS 6.1.0.135 / API 24) | 0.2.2 — built & signed (on-device re-verification pending; 0.2.0 baseline) |

Neither replaces the other: the Electron edition buys maximum desktop fidelity at the cost of a bundled Chromium and JIT; this edition buys a small payload and a permission-free install at the cost of covering platform gaps in the shim layer.

## Capabilities at a glance

| Area | State |
|---|---|
| dsh Web UI, sessions, tools, skills, subagents | ✅ works as upstream |
| File read / write / edit, image attachments | ✅ |
| Workspace picker: sandbox + `Documents` / `Downloads` (grant → read/write) | ✅ on 2in1 / tablet |
| Workspace from a folder picked in the system picker (phone) | ✅ works, **read-only** — the "safe access" grant does not allow writing files |
| `Documents` / `Downloads` **direct** directory permission (phone) | ⚠️ platform-whitelisted (hilog: `isSupportDirectoryPG=false`, `configValue=3`); a side-loaded build always gets `authResult=2` — use the read-only folder or *From file* import instead |
| Git (21 tools, pure JS, no `git` binary needed) | ✅ |
| Local plugins loaded from the profile, own branding | ✅ |
| Plugin marketplace (host channel: `dshmarket` + in-process pnpm) | ✅ channel ships; UI not yet device-verified |
| Installed plugins + pnpm store survive a payload upgrade | ✅ since 0.2.2 ([`docs/pnpm+dsh-market.md`](docs/pnpm+dsh-market.md) §3.7) |
| Command execution (`bash`) | ⚠️ executor ships; a path-resolution fix is pending |
| Content search (`grep` / `glob`) | ⚠️ needs a pure-JS backend (no `ripgrep` binary on arm64) |
| Delete / move / copy / chmod | ⚠️ upstream `ctx.fs` has no such primitives yet |
| Tray icon, window-state memory, frameless window | — not in this edition |

The complete matrix — every capability, both editions side by side, with root causes and fix points — is [`docs/鸿蒙环境能力清单-0.2.1.md`](docs/鸿蒙环境能力清单-0.2.1.md).

## Status

`0.2.2` (`versionCode` 202) — **built** for dsh-v0.2.2-rc.3 on Node 26.13.0. Device-verified on **two forms**: `0.2.1` on HarmonyOS 6.1.0.135 / API 24 (2in1) and `0.2.2` on a **HUAWEI Pura X Max (`HOP-AL10`, HarmonyOS 7.0.0.111 / API 26, `deviceType=phone`)**. On the phone: installs with zero ACLs, the payload self-extracts and reports `ready`, all shims install, `node:sqlite`/FTS5 available, text and image conversations, workspace picker with sandbox + *From file* import, a **read-only workspace from the system folder picker**, account login (browser-based, via the login bridge), plugin install/uninstall through the marketplace, and **installed plugins survive a payload upgrade** (see [`docs/pnpm+dsh-market.md`](docs/pnpm+dsh-market.md) §3.7). Known gaps and their fix points are listed in the capability inventory above.

## Build

Prerequisites: DevEco **Command Line Tools** (SDK API 24) and the sibling submodule `../deepseek-harness`. The Node runtime is pulled from the OpenHarmony ohpm central repository: [`@fellow99/node-bridge`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-bridge) (API + NAPI bootstrap) and [`@fellow99/node-runtime@26.13.0`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-runtime) (the `libnode.so` engine, SHA-256-locked by the bundled `runtime.lock.json`).

```bash
node scripts/assemble-payload.mjs --deploy --apply   # ① materialize the dsh runtime
bash scripts/build-hap.sh           # ② ohpm install → payload archive + HAP build/sign
hdc app install -r entry/build/default/outputs/default/entry-default-signed.hap
```

`OHOS_CLT` overrides the toolchain root and accepts **either** layout: Command Line Tools (`<root>/bin` + `<root>/sdk` + `<root>/tool/node`) or a DevEco Studio install (`<root>/tools/{hvigor,ohpm,node}/bin` + `<root>/sdk` + `<root>/jbr`). `node scripts/verify-upstream.mjs` proves the upstream pin is intact (tag, clean tree, patch ids, brand/onboarding gates).

### Signing (read this before wondering why a signed HAP fails)

`assembleHap` runs `hap-sign-tool.jar` via **whatever `java` is first on `PATH`** — the hvigor task does not pin a JDK. If the machine also has another JDK (sdkman/Temurin, Adoptium, …), signing dies with a misleading error that has nothing to do with the HAP:

```
Failed :entry:default@SignHap...
ERROR: 11012006 File IO failed
Error Message: Invalid CEN header (invalid zip64 extra data field size)
```

`scripts/build-hap.sh` therefore prepends DevEco's bundled **JBR** (with `cygpath -u`, otherwise MSYS bash cannot resolve `java.exe`) and exports `JAVA_HOME`. If you invoke `hvigorw` yourself, do the same or you will hit that error.

Signing material is **never committed**. Either let DevEco Studio generate it (it writes `app.signingConfigs` into `build-profile.json5` — do not commit that file; revert it after building), or provide `signing.debug.local.json` / `signing.release.local.json` (gitignored) with **plaintext** passwords (`certpath`, `storeFile`, `profile`, `keyAlias`, `keyPassword`, `storePassword`, `signAlg`) — DevEco's encrypted password strings only decrypt on the inline `build-profile.json5` path.

Run `bash scripts/build-hap.sh --debug` to get `entry-default-signed.hap`, which installs on a device whose debug profile matches (`hdc app install -r …`). `--release` needs a release profile and can only ship through AppGallery.

## Docs

| Document | What it answers |
|---|---|
| [Capability inventory 0.2.2](docs/鸿蒙环境能力清单-0.2.1.md) | What works, what does not, and how this compares to the Electron edition |
| [Engineering plan](docs/000-工程规划.md) | Why this architecture, what was rejected, and the shim whitelist |
| [On-device notes](docs/010-真机调试记录.md) | What broke on the device and how it was diagnosed |
| [Phone-form test record](docs/020-手机形态实测记录.md) | Running this edition on a phone: `--jitless` self-check, login, read-only folder workspace, measured numbers |
| [JIT and ACL](docs/ACL配置.md) · [JIT-less decision](docs/119-jitless-方案决策.md) | The two runtime forms and what each costs |
| [Specifications](specs/README.md) | 14 spec modules (013, 101–108, 110, 119, 202, 204, 205) with plans and gates |

## Related

- [`dsh-desktop`](../dsh-desktop) — Electron shell for Windows / Linux / macOS
- [`dsh-desktop-hos`](../dsh-desktop-hos) — Electron on HarmonyOS Edition
- [`@fellow99/node-bridge`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-bridge) / [`@fellow99/node-runtime`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-runtime) — the ohpm packages that embed Node (`node::Start`) in-process
- [`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) — the wrapped agent host

## License

[MIT](./LICENSE)
