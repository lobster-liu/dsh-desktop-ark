'use strict';
/**
 * dsh Host 启动器（等价于 `apps/desktop-host` 的精简版，去掉 Electron 专属逻辑）。
 *
 * 只做四件事：
 *   1) 从运行根解析上游包（`createRequire` 指向 `@deepseek-ai/dsh/package.json`）；
 *   2) `loadProfileDirectory` 载入 `<runRoot>/profiles/ohos`（用户 patch 来自 `$DSH_HOME/user-patch.yml`）；
 *   3) `runProfile` 启动 Web 应用（`--host 127.0.0.1 --port 0 --no-open`）；
 *   4) 用 `ctx.connection.authenticatedUrl()` 上报带一次性 token 的入口 URL。
 *
 * 失败时不抛给 bootstrap（那会被当作致命错误），而是写 `ready.json` 的失败态。
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

/**
 * @param {{
 *   runRoot: string,
 *   payloadRoot: string,
 *   assetDir: string,
 *   version: object,
 *   shims: Array<{marker: string, installed: boolean}>,
 *   sqlite: object,
 *   log: (line: string) => void,
 *   writeReady: (payload: object) => void
 * }} ctx
 */
/** pnpm 的 store 版本子目录名，例如 `.pnpm-store/v10` 里的 `v10`（两种分隔符都要认：开发机是 `\`）。 */
const STORE_VERSION_RE = /[\\/](v\d+)$/;

/**
 * 把 `node_modules/.modules.yaml` 里的 `storeDir` 对齐到本次的 store。
 *
 * 为什么必须做：pnpm 不读 `pnpm-workspace.yaml` 判断 store 位置，它读自己写下的这条安装记录。
 * 沿用了上一代 profile 之后，这条记录仍然指向上一个载荷代次里的 `.pnpm-store/v10`，
 * 而那个目录已经随升级被删除，于是插件市场里**任何**安装/更新/卸载都失败于
 * `ERR_PNPM_UNEXPECTED_STORE`（真机 2026-11-17 复现：19:13 还能装，21:33 起全挂）。
 * 只改 `pnpm-workspace.yaml` 是无效方向，改这条记录才对。
 *
 * 只重写 `storeDir` 一行，其余原样保留；文件不存在（还没装过插件）时什么都不做。
 *
 * @param {string} file - `<profile>/node_modules/.modules.yaml`
 * @param {string} storeDir - 本次生效的 store 根（不带版本子目录）
 * @param {(line: string) => void} log
 * @returns {boolean} 是否真的改写了
 */
function repairModulesStoreDir(file, storeDir, log) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return false;
  }
  const match = /^storeDir:[ \t]*(.+)$/m.exec(text);
  if (match === null) {
    return false;
  }
  const current = match[1].trim().replace(/^["']|["']$/g, '');
  const version = STORE_VERSION_RE.exec(current);
  const target = version === null ? storeDir : path.join(storeDir, version[1]);
  if (current === target || current === storeDir) {
    return false;
  }
  try {
    fs.writeFileSync(file, text.replace(match[0], `storeDir: ${target}`));
    log(`market: node_modules/.modules.yaml storeDir 修正为 ${target}（原值 ${current}）`);
    return true;
  } catch (error) {
    log(`market: cannot rewrite ${file} (continuing): ${error && error.message ? error.message : String(error)}`);
    return false;
  }
}

/**
 * 110-pnpm-integration / 201-dsh-market：把进程内 pnpm 的运行时前提准备好。
 *
 * 三件事，全部幂等，失败只记日志（它们不改变 Host 能否启动，只改变「能不能装插件」）：
 *   1) `DSH_PNPM_ENGINE` 指向随包物化的纯 JS pnpm 入口；
 *   2) profile 的 `pnpm-workspace.yaml` 缺失时创建（hoisted / copy / 不装 peer / 不跑脚本）；
 *   3) 建出 store 与 cache 目录（两者都必须落在沙箱内）。
 *
 * `storeDir` 必须是绝对路径：设备上 `process.cwd()` 是 `/`，相对路径会解析到沙箱外。
 *
 * @param {{ runRoot: string, profileDir: string, log: (line: string) => void }} options
 */
function configureMarketRuntime(options) {
  const { runRoot, profileDir, log } = options;
  const engine = path.join(runRoot, 'node_modules', 'dsh-market-pnpm', 'bin', 'pnpm.cjs');
  process.env.DSH_PNPM_ENGINE = engine;
  log(`market: DSH_PNPM_ENGINE=${engine}`);

  // 210-profile-carryover：store 放在 payload **之外**（`<files>/pnpm-store`），这样换载荷
  // 不必重新下载 284MB 的包内容；没有传入时退回旧行为（profile 内），保持兼容。
  const storeDir = typeof options.storeDir === 'string' && options.storeDir !== ''
    ? options.storeDir
    : path.join(profileDir, '.pnpm-store');
  const configFile = path.join(profileDir, 'pnpm-workspace.yaml');
  try {
    if (!fs.existsSync(configFile)) {
      // `autoInstallPeers: false`：缺 peer 时走 dsh 的运行时解析，所有插件共用安装里那一份 cordis
      // （与上游 app-boot 的 profile 模板同一语义）。`ignoreScripts`：平台既不能编译也不能 spawn。
      const body = [
        'packages:',
        '  - .',
        '',
        'nodeLinker: hoisted',
        'autoInstallPeers: false',
        'packageImportMethod: copy',
        'ignoreScripts: true',
        'minimumReleaseAge: 0',
        `storeDir: ${JSON.stringify(storeDir)}`,
        '',
      ].join('\n');
      fs.writeFileSync(configFile, body);
      log(`market: wrote pnpm config ${configFile} (storeDir=${storeDir})`);
    } else {
      // 已经存在就保留用户/市场的其它键，但 `storeDir` 必须落在**本次** profile 之下：
      // 开发机上跑过冒烟会把当时的绝对路径留在文件里，随包发出去后设备上会指向沙箱外，
      // 每次安装都失败且无法自愈。只重写这一行，其余原样保留。
      const current = fs.readFileSync(configFile, 'utf8');
      const match = /^storeDir:\s*(.+)$/m.exec(current);
      const configured = match === null ? '' : match[1].trim().replace(/^["']|["']$/g, '');
      if (configured !== storeDir) {
        const rewritten = match === null
          ? `${current.trimEnd()}\nstoreDir: ${JSON.stringify(storeDir)}\n`
          : current.replace(match[0], `storeDir: ${JSON.stringify(storeDir)}`);
        fs.writeFileSync(configFile, rewritten);
        log(`market: storeDir 修正为 ${storeDir}（原值 ${configured === '' ? '(未设置)' : configured}）`);
      } else {
        log(`market: pnpm config kept as-is ${configFile}`);
      }
    }
  } catch (error) {
    log(`market: pnpm config unavailable (continuing): ${error && error.message ? error.message : String(error)}`);
  }

  // 210-profile-carryover 的后半：沿用旧 profile 之后，pnpm 的安装记录还指着上一代的 store。
  repairModulesStoreDir(path.join(profileDir, 'node_modules', '.modules.yaml'), storeDir, log);

  for (const dir of [storeDir, path.join(profileDir, '.pnpm-cache')]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      log(`market: cannot create ${dir} (continuing): ${error && error.message ? error.message : String(error)}`);
    }
  }
}

/** 载荷目录名就是 sha12。 */
const PAYLOAD_DIR_RE = /^[0-9a-f]{12}$/;

/**
 * profile 里属于「用户装出来的东西」的文件：换载荷后必须沿用，否则等于每次升级清空插件。
 * 只搬这些，不搬 `cordis.yml`（静态 `[]`）与随包分发的其它文件。
 */
const CARRY_OVER_ENTRIES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'cordis.patch.yml',
  'node_modules',
  '.dsh-market',
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return undefined;
  }
}

/**
 * 判断一个 profile 是否「已经装过插件」：package.json 里有 dependencies，或 node_modules 里
 * 有非点开头的包（随机载荷自带的 profile 两者都是空的）。
 */
function profileHasUserPlugins(profileDir) {
  const pkg = readJson(path.join(profileDir, 'package.json'));
  const deps = pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : [];
  if (deps.length > 0) {
    return true;
  }
  const modules = path.join(profileDir, 'node_modules');
  try {
    return fs.readdirSync(modules).some((name) => !name.startsWith('.'));
  } catch (error) {
    return false;
  }
}

/** 找出 payload 根下所有「旧载荷里的 profile」目录（不含当前 sha12 自己），新的在前。 */
function previousProfiles(payloadRoot, currentSha12) {
  let names = [];
  try {
    names = fs.readdirSync(payloadRoot);
  } catch (error) {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!PAYLOAD_DIR_RE.test(name) || name === currentSha12) {
      continue;
    }
    const profileDir = path.join(payloadRoot, name, 'dsh', 'profiles', 'ohos');
    if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
      continue;
    }
    let mtime = 0;
    try {
      mtime = fs.statSync(profileDir).mtimeMs;
    } catch (error) {
      mtime = 0;
    }
    found.push({ name, profileDir, mtime });
  }
  found.sort((left, right) => right.mtime - left.mtime);
  return found;
}

/**
 * 把 pnpm store 挪到 payload 之外（`<files>/pnpm-store`），同盘 rename 是瞬时的。
 * 目标已经非空时保留目标、不动来源（来源随旧载荷一起删掉即可）。
 */
function adoptStore(sourceStore, storeDir, log) {
  if (!fs.existsSync(sourceStore)) {
    return false;
  }
  try {
    const existing = fs.existsSync(storeDir) ? fs.readdirSync(storeDir).length : 0;
    if (existing > 0) {
      log(`profile-carryover: store 已存在 ${storeDir}（${existing} 项），沿用`);
      return true;
    }
    fs.mkdirSync(path.dirname(storeDir), { recursive: true });
    try {
      fs.renameSync(sourceStore, storeDir);
      log(`profile-carryover: store 迁移 ${sourceStore} -> ${storeDir}`);
    } catch (error) {
      fs.cpSync(sourceStore, storeDir, { recursive: true, force: true });
      log(`profile-carryover: store 复制 ${sourceStore} -> ${storeDir}（rename 失败：${error && error.message ? error.message : String(error)}）`);
    }
    return true;
  } catch (error) {
    log(`profile-carryover: store 迁移失败（继续）：${error && error.message ? error.message : String(error)}`);
    return false;
  }
}

/**
 * 210-profile-carryover：换载荷（sha12 变化）后沿用上一份 profile 里装好的插件。
 *
 * profile 必须留在运行根内（ESM 从它向上解析 `@dsh-ohos/*`），所以不能把 profile 移出去；
 * 只能在**新载荷刚解出来**的时候，把旧载荷 profile 里属于用户的那几项拷进来。拷贝成功后旧载荷
 * 目录整目录删掉（它只是缓存，HAP 里随时能再解一遍），把空间还回去。
 *
 * 全程 try/catch：任何一步失败都只记日志，Host 照常启动。
 *
 * @param {{ payloadRoot: string, profileDir: string, currentSha12: string, storeDir: string,
 *   keepPrevious?: boolean, log: (line: string) => void }} options
 * @returns {{ carried: boolean, from?: string, copied: string[], removed: string[] }}
 */
function carryOverProfile(options) {
  const { payloadRoot, profileDir, currentSha12, storeDir, keepPrevious, log } = options;
  const result = { carried: false, from: undefined, copied: [], removed: [] };
  try {
    const candidates = previousProfiles(payloadRoot, currentSha12);
    if (candidates.length === 0) {
      log('profile-carryover: 没有旧载荷，跳过');
      return result;
    }
    // 先把 store 挪出去：即使这一份 profile 已经装过插件，store 也应该升到 payload 之外。
    adoptStore(path.join(candidates[0].profileDir, '.pnpm-store'), storeDir, log);
    adoptStore(path.join(profileDir, '.pnpm-store'), storeDir, log);

    const target = candidates.find((candidate) => profileHasUserPlugins(candidate.profileDir));
    if (target === undefined) {
      log(`profile-carryover: 旧 profile 里没有装过插件（${candidates.map((c) => c.name).join(', ')}）`);
    } else if (profileHasUserPlugins(profileDir)) {
      log('profile-carryover: 新 profile 已经装过插件，跳过拷贝');
    } else {
      for (const entry of CARRY_OVER_ENTRIES) {
        const source = path.join(target.profileDir, entry);
        if (!fs.existsSync(source)) {
          continue;
        }
        const destination = path.join(profileDir, entry);
        try {
          fs.rmSync(destination, { recursive: true, force: true });
          fs.cpSync(source, destination, { recursive: true, force: true, dereference: false });
          result.copied.push(entry);
        } catch (error) {
          log(`profile-carryover: 拷贝 ${entry} 失败（继续）：${error && error.message ? error.message : String(error)}`);
        }
      }
      result.carried = result.copied.length > 0;
      result.from = target.name;
      log(`profile-carryover: 沿用 ${target.name} 的 profile（${result.copied.join(', ') || '无'}）`);
    }

    if (keepPrevious === true) {
      log('profile-carryover: keepPrevious 打开，保留旧载荷目录');
      return result;
    }
    for (const candidate of candidates) {
      const dir = path.join(payloadRoot, candidate.name);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        result.removed.push(candidate.name);
      } catch (error) {
        log(`profile-carryover: 删除旧载荷 ${candidate.name} 失败（继续）：${error && error.message ? error.message : String(error)}`);
      }
    }
    if (result.removed.length > 0) {
      log(`profile-carryover: 已清理旧载荷 ${result.removed.join(', ')}`);
    }
  } catch (error) {
    log(`profile-carryover: 失败（继续）：${error && error.message ? error.message : String(error)}`);
  }
  return result;
}

async function start(ctx) {
  const { runRoot, version, shims, sqlite, compat, log, writeReady } = ctx;
  const dshHome = process.env.DSH_HOME || path.join(process.env.HOME || '/', 'dsh-home');
  // profile 留在运行根内：ESM 从该目录向上只会在 <runRoot>/node_modules 命中 @dsh-ohos/*。
  const projectDir = path.join(runRoot, 'profiles', 'ohos');
  const userPatch = path.join(dshHome, 'user-patch.yml');
  const dshManifest = path.join(runRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  // `runRoot` = `<files>/payload/<sha12>/dsh` → payload 根、以及 payload 之外的持久目录。
  const payloadRoot = path.dirname(path.dirname(runRoot));
  const storeDir = path.join(path.dirname(payloadRoot), 'pnpm-store');
  // 210-profile-carryover：换载荷后沿用上一份 profile 装好的插件（并顺手把旧载荷目录删掉）。
  // 必须在 runProfile 之前：profile 的组合与行配置在 runProfile 内一次性读取。
  carryOverProfile({
    payloadRoot,
    profileDir: projectDir,
    currentSha12: version.sha12 || path.basename(path.dirname(runRoot)),
    storeDir,
    keepPrevious: process.env.DSH_OHOS_KEEP_PREVIOUS_PAYLOAD === '1',
    log
  });
  // 012/201：进程内 pnpm 的运行时前提（引擎入口 + profile pnpm 配置）。必须在 runProfile 之前，
  // 因为 profile 的组合与行配置在 runProfile 内一次性读取。
  configureMarketRuntime({ runRoot, profileDir: projectDir, storeDir, log });

  writeReady({ phase: 'starting', sha12: version.sha12, shims: shims.map((s) => s.marker), compat });

  if (!fs.existsSync(dshManifest)) {
    writeReady({
      phase: 'payload-missing',
      diagnostic: `缺少上游包：${dshManifest}`,
      shims: shims.map((s) => s.marker),
      compat
    });
    return;
  }

  let appBoot;
  let profileBoot;
  try {
    const requireFromRun = createRequire(dshManifest);
    appBoot = await import(pathToFileURL(requireFromRun.resolve('@deepseek-ai/dsh-app-boot')).href);
    profileBoot = await import(pathToFileURL(requireFromRun.resolve('@deepseek-ai/dsh/profile-boot')).href);
  } catch (error) {
    const message = error && error.stack ? error.stack : String(error);
    log(`host: resolve upstream failed: ${message}`);
    writeReady({ phase: 'failed', diagnostic: `解析上游包失败：${message}`, shims: shims.map((s) => s.marker), compat });
    return;
  }

  try {
    const profile = appBoot.loadProfileDirectory('dsh', projectDir, dshManifest);
    appBoot.reportSkippedBundles('dsh', profile);
    log(`host: profile loaded from ${projectDir}`);

    const application = profileBoot.runProfile({
      environment: appBoot.loadLayeredEnv('dsh'),
      profile: 'ohos',
      resolvedProfile: { profile, installAnchor: dshManifest },
      patchFiles: userPatch !== '' && fs.existsSync(userPatch) ? [userPatch] : [],
      args: ['--no-open', '--host', '127.0.0.1', '--port', '0']
    });

    const { ctx: hostCtx } = await application;
    // 上游只提供 loopback 端口（dsh-web-app 的 localWebUrl 口径就是 http://127.0.0.1:<port>）；
    // 不要臆造 `webServer.protocol` 之类的字段（不存在 → `Invalid URL`）。
    const port = hostCtx.webServer.port;
    if (!Number.isInteger(port) || port <= 0) {
      const diagnostic = `webServer.port 非法：${String(port)}`;
      log(`host: ${diagnostic}`);
      writeReady({ phase: 'failed', diagnostic, shims: shims.map((s) => s.marker), compat });
      return;
    }
    const origin = `http://127.0.0.1:${String(port)}`;
    const url = hostCtx.connection.authenticatedUrl(origin);
    const token = new URL(url).searchParams.get('token') || '';
    if (token === '') {
      const diagnostic = 'authenticatedUrl 未携带一次性 token';
      log(`host: ${diagnostic}`);
      writeReady({ phase: 'failed', diagnostic, shims: shims.map((s) => s.marker), compat });
      return;
    }

    writeReady({
      phase: 'ready',
      url,
      origin,
      token,
      pid: process.pid,
      sha12: version.sha12,
      shims: shims.map((s) => s.marker),
      sqlite,
      // 119-jitless：形态事实（active / webAssembly / fetch / selfcheck）随公告对外可见。
      compat,
      roots: {
        payload: runRoot,
        dshHome,
        workspace: process.env.DSH_OHOS_WORKSPACE || '',
        readonly: process.env.NODE_BRIDGE_READONLY_ROOT || ''
      }
    });
    log(`host: ready at ${origin} (token length=${token.length})`);
  } catch (error) {
    const message = error && error.stack ? error.stack : String(error);
    log(`host: runProfile failed: ${message}`);
    writeReady({ phase: 'failed', diagnostic: `启动 dsh Host 失败：${message}`, shims: shims.map((s) => s.marker), compat });
  }
}

module.exports = { start, carryOverProfile, configureMarketRuntime, repairModulesStoreDir };
