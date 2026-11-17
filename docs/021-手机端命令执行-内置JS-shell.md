# 21. 手机端的命令执行：内置 JS shell（2026-11-17，Pura X Max / API 26）

## 结论先行

手机上**没有**可以 spawn 的 shell。应用域对 `/system/bin` 下的二进制连 `stat`/`access` 都被
SELinux 拒绝（`EACCES: permission denied, stat '/system/bin/sh'`），`execve` 必然失败：

```
Error: cannot start "bash": spawn /system/bin/sh EACCES
```

所以 `@dsh-ohos/shell` 不再把 `/system/bin/sh` 当唯一执行体，而是**在进程内跑一个 POSIX 子集**
（`packages/shell-ohos/lib/js-shell.js`，纯 JS，无子进程）。策略是自动探测：

1. 首次 `execute()` 时 `probeNative()`：真 spawn 一次 `/system/bin/sh -c 'exit 0'`，1.5s 内算可用；
2. 真拒绝（`EACCES`/`ENOENT`/`EPERM`）⇒ `engine = 'js'` 并**永久降级**（同一进程内不再重试）；
3. `onGone` 里看到这三类 errno 也会触发降级（兜住探测期竞态）；
4. `DSH_OHOS_SHELL_MODE=js|native` 可强制引擎（联调/测试用）。

第一次降级时 shell 会在 stderr 附带一行说明，让模型知道「为什么不能跑外部命令」：

```
/system/bin/sh cannot start on this device (EACCES: the app domain may not execute system binaries);
running the command with the builtin JS shell instead — pipelines, redirects and file commands work,
but no external binary (git, tar, rg, curl, bun …) can run.
```

## 能力

- 语法：`;`、`&&`、`||`、`|` 管道、`>` / `>>` / `2>` / `2>&1`、单双引号、反斜杠转义、相对路径。
- 内建命令（`BUILTIN_NAMES`）：
  `echo printf pwd cd ls cat head tail wc grep find mkdir rmdir rm cp mv touch ln stat basename dirname
  realpath sort uniq tee env printenv which uname date sleep node sh bash true false exit export`
  - `grep` 支持 `-i -n -r -v -c -F`；`find` 支持 `-name -type -maxdepth`；`rm/cp` 支持 `-r -f`。
  - `node <file>` 用 `import(pathToFileURL(...))` 在进程内执行脚本，并捕获 `console.log/error`
    与 `process.argv`；`sh -c "…"` / `bash -c "…"` 等价于再跑一行脚本。
- 输出上限 `JS_MAX_OUTPUT_BYTES = 64_000`，超出标记 `truncated`。
- 未知命令返回 **127**，并在 stderr 列出全部内建命令 —— 不假装成「命令不存在」。

## 不能做的事（不要误导用户）

| 想要 | 现实 |
|---|---|
| `git` / `tar` / `rg` / `curl` / `bun` / `python` | 外部二进制，无法 exec，永远不可用 |
| 安装 Bun / Node 二进制 | Bun 无 HarmonyOS 目标且无法执行；要用 JS 直接 `node script.mjs` |
| 完整 POSIX 语义 | 只是子集：没有 glob 展开、没有 `$VAR` 展开、没有 job control、没有 `sudo` |

`grep`/`glob` **工具**（`@vscode/ripgrep` 在 arm64 载荷里没有 `bin/rg`）仍不可用，仍需纯 JS seam；
内置 shell 里的 `grep` 只解决「模型想跑一行命令」的场景。

## 测试

- `node packages/shell-ohos/test/js-shell.mjs`：11 例（echo/exit code、cd+ls、cat/head/tail/wc+管道、
  grep 四种 flag+递归、`>`/`>>`、cp/mv/rm/find、`&&`/`||` 短路、引号、真二进制 127、缺失文件的
  POSIX 错误、内建名单）。
- `node packages/shell-ohos/test/smoke.mjs`：`DSH_OHOS_SHELL_MODE=native` 固定引擎（否则探测会多一次
  spawn，打乱 `spawned[0]` 断言），并有一例断言 `engine='js'` 时输出正确且 `spawned.length === 0`。

## 真机证据（2026-11-17）

会话里让模型执行 `echo OKMARK` + `ls`：

```
OKMARK
dsh-ohos-pnpm-store-fix.md
dshmarket-diagnosis-issue.md
```

`node.log` 同轮出现 `subprocess-ohos: skip stat/access for system binary /system/bin/sh (Error: EACCES …);
will let spawn decide`（`@dsh-ohos/subprocess` 的前置校验对系统二进制直接放行，让内核给出真实 errno）。
