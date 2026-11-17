#!/usr/bin/env node
/**
 * 210-profile-carryover 的离线冒烟：不碰设备，纯临时目录验证 host.js 的 carryOverProfile。
 *
 * 场景：
 *   1) 旧载荷装过插件（package.json 有 dependencies、node_modules 里有包、有 pnpm-lock）→
 *      新载荷的 profile 应被沿用这几项，旧载荷目录被删掉，store 升到 payload 之外；
 *   2) 新 profile 已经装过插件 → 不覆盖；
 *   3) 旧载荷 profile 没装过插件 → 只迁移 store、不拷贝；
 *   4) keepPrevious → 保留旧载荷目录。
 *
 * 用法：`node scripts/test-payload-carryover.mjs`
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HOST = fileURLToPath(new URL('../entry/src/main/resources/resfile/dsh-payload/host.js', import.meta.url));
const { carryOverProfile } = require(HOST);

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

function sha(name) {
  return name.repeat(12).slice(0, 12);
}

/**
 * 造一个沙箱：<root>/files/payload/<sha12>/dsh/profiles/ohos。
 * options.profile = { deps: {...}, modules: [...], lock: boolean, store: boolean }
 */
function sandbox(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-carryover-'));
  const files = join(root, 'files');
  const payloadRoot = join(files, 'payload');
  const make = (name, profile) => {
    const profileDir = join(payloadRoot, name, 'dsh', 'profiles', 'ohos');
    mkdirSync(profileDir, { recursive: true });
    const pkg = {
      name: 'dsh-ohos-profile',
      version: '1.0.0',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: profile.deps ?? {},
    };
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    for (const module of profile.modules ?? []) {
      mkdirSync(join(profileDir, 'node_modules', module), { recursive: true });
      writeFileSync(join(profileDir, 'node_modules', module, 'package.json'), '{}\n');
    }
    if (profile.lock === true) {
      writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    }
    if (profile.store === true) {
      mkdirSync(join(profileDir, '.pnpm-store', 'v3', 'files'), { recursive: true });
      writeFileSync(join(profileDir, '.pnpm-store', 'v3', 'files', 'blob'), 'store-bytes\n');
    }
    return profileDir;
  };
  return { root, files, payloadRoot, storeDir: join(files, 'pnpm-store'), make };
}

function logs() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

// 1) 带插件的旧载荷 → 新载荷沿用。
{
  const box = sandbox();
  const oldDir = box.make(sha('a'), {
    deps: { 'dsh-cost-meter': '1.9.70' },
    modules: ['dsh-cost-meter', 'zod'],
    lock: true,
    store: true,
  });
  const newSha = sha('b');
  const newDir = box.make(newSha, {});
  const { lines, log } = logs();
  const result = carryOverProfile({
    payloadRoot: box.payloadRoot,
    profileDir: newDir,
    currentSha12: newSha,
    storeDir: box.storeDir,
    log,
  });

  const pkg = JSON.parse(readFileSync(join(newDir, 'package.json'), 'utf8'));
  check('1 carried', result.carried === true, JSON.stringify(result));
  check('1 from old sha', result.from === sha('a'), String(result.from));
  check('1 packages.json deps 沿用', pkg.dependencies['dsh-cost-meter'] === '1.9.70', JSON.stringify(pkg.dependencies));
  check('1 node_modules 沿用', existsSync(join(newDir, 'node_modules', 'dsh-cost-meter', 'package.json')));
  check('1 pnpm-lock 沿用', existsSync(join(newDir, 'pnpm-lock.yaml')));
  check('1 store 升到 payload 之外', existsSync(join(box.storeDir, 'v3', 'files', 'blob')));
  check('1 旧 profile 的 store 已移走', !existsSync(join(oldDir, '.pnpm-store')));
  check('1 旧载荷目录被删掉', !existsSync(join(box.payloadRoot, sha('a'))));
  check('1 新载荷目录还在', existsSync(join(box.payloadRoot, newSha)));
  check('1 有迁移日志', lines.some((line) => line.startsWith('profile-carryover: 沿用')), lines.join(' | '));
  rmSync(box.root, { recursive: true, force: true });
}

// 2) 新 profile 已经装过插件 → 不覆盖。
{
  const box = sandbox();
  box.make(sha('c'), { deps: { 'dsh-old': '1.0.0' }, modules: ['dsh-old'] });
  const newSha = sha('d');
  const newDir = box.make(newSha, { deps: { 'dsh-new': '2.0.0' }, modules: ['dsh-new'] });
  const { lines, log } = logs();
  const result = carryOverProfile({
    payloadRoot: box.payloadRoot,
    profileDir: newDir,
    currentSha12: newSha,
    storeDir: box.storeDir,
    log,
  });
  const pkg = JSON.parse(readFileSync(join(newDir, 'package.json'), 'utf8'));
  check('2 不覆盖', pkg.dependencies['dsh-new'] === '2.0.0' && pkg.dependencies['dsh-old'] === undefined, JSON.stringify(pkg.dependencies));
  check('2 carried=false', result.carried === false, JSON.stringify(result));
  check('2 有跳过日志', lines.some((line) => line.includes('跳过拷贝')), lines.join(' | '));
  rmSync(box.root, { recursive: true, force: true });
}

// 3) 旧 profile 没装插件 → 只迁移 store。
{
  const box = sandbox();
  box.make(sha('e'), { store: true });
  const newSha = sha('f');
  const newDir = box.make(newSha, {});
  const { log } = logs();
  const result = carryOverProfile({
    payloadRoot: box.payloadRoot,
    profileDir: newDir,
    currentSha12: newSha,
    storeDir: box.storeDir,
    log,
  });
  check('3 不拷贝', result.carried === false, JSON.stringify(result));
  check('3 store 仍然迁移', existsSync(join(box.storeDir, 'v3', 'files', 'blob')));
  rmSync(box.root, { recursive: true, force: true });
}

// 4) keepPrevious → 保留旧载荷目录（便于回滚）。
{
  const box = sandbox();
  const oldDir = box.make(sha('1'), { deps: { 'dsh-x': '1.0.0' }, modules: ['dsh-x'] });
  const newSha = sha('2');
  const newDir = box.make(newSha, {});
  const { log } = logs();
  carryOverProfile({
    payloadRoot: box.payloadRoot,
    profileDir: newDir,
    currentSha12: newSha,
    storeDir: box.storeDir,
    keepPrevious: true,
    log,
  });
  check('4 旧载荷保留', existsSync(oldDir));
  rmSync(box.root, { recursive: true, force: true });
}

// 5) 没有旧载荷 → 什么都不做（不能崩）。
{
  const box = sandbox();
  const newSha = sha('3');
  const newDir = box.make(newSha, {});
  const { log } = logs();
  const result = carryOverProfile({
    payloadRoot: box.payloadRoot,
    profileDir: newDir,
    currentSha12: newSha,
    storeDir: box.storeDir,
    log,
  });
  check('5 空载荷不崩', result.carried === false && result.removed.length === 0, JSON.stringify(result));
  rmSync(box.root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\npayload carry-over: 全部通过');
