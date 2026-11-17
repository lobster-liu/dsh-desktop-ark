#!/usr/bin/env node
/**
 * 单独给已物化的 payload 打登录常量补丁（装配链里由 `package-payload.mjs` 自动调用，
 * 一般不需要手跑；调试时可用它重放）。
 *
 * 用法：node scripts/patch-payload-login.mjs <payload-root>
 *   <payload-root> 形如 build/payload-stage（其下有 dsh/）。
 */
import { patchPayloadLogin } from './lib/payload-login.mjs'

const root = process.argv[2]
if (!root) throw new Error('usage: node patch-payload-login.mjs <payload-root>')

const { patchedFiles, patchedConstants } = patchPayloadLogin(root, (line) => console.log(`[patch-payload-login] ${line}`))
console.log(
  `[patch-payload-login] 客户端常量 ${patchedConstants} 处 / ${patchedFiles} 个文件，leftover=0；branding 登录桥接在位`,
)
