/**
 * 门：薄宿主退役项的**回归锁**（guard-timers + ElizaOS 生产路径）。
 *
 * ============================================================================
 *  退役了什么、为什么
 * ============================================================================
 * ① `src/infrastructure/runtime/guard-timers.ts` —— 已**退役并从 src 删除**。
 *    它是对 `@elizaos/core@1.7.2` 的猴子补丁：`registerService` 为每个服务建一个
 *    30 秒"初始化超时"定时器却从不清除，导致每次 CLI 都要白等 30 秒。
 *    薄宿主 `initialize()` **不注册任何服务**，结构上就不建那些定时器 ⇒ 补丁无对象。
 *
 * ② ElizaOS **运行时**已不在生产路径上（宿主换成薄宿主），
 *    但**依赖仍在** `package.json`（115 个脚本仍 import 它）——
 *    所以这道门只锁"生产路径不再依赖"，**不**锁"依赖已卸载"。
 *
 * ============================================================================
 *  为什么要有这道门（这不是形式主义）
 * ============================================================================
 * 退役一个补丁的风险是"它悄悄回来"：任何人为了"修某个慢 CLI"都可能把
 * `withGuardTimersUnrefed` 加回去，或者把 `CHARACTER_THIN_HOST` 关掉后
 * 又开始依赖那个补丁。⇒ 必须有机器判据把它们按住。
 *
 * ⚠️ 判据纪律（L-QQP-09）：**剥注释再判**，否则本文件自己的说明文字
 *    就会把判据撑爆（同型坑本仓库已复发多次）。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** 剥掉块注释与行注释 —— 判据只看真代码 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join('\n')
}

// ---------------------------------------------------------------------------
// R1 · guard-timers.ts 已从 src 退役
// ---------------------------------------------------------------------------
{
  const retired = join(SRC, 'infrastructure/runtime/guard-timers.ts')
  check(
    'R1-guard-timers-removed',
    !existsSync(retired),
    existsSync(retired) ? 'guard-timers.ts 仍在 src/（已退役，不应存在）' : 'guard-timers.ts 已从 src/ 移除'
  )
}

// ---------------------------------------------------------------------------
// R2 · src/ 里不再有任何调用者
// ---------------------------------------------------------------------------
{
  const files = walk(SRC)
  const callers = files.filter((f) => /guard-timers|withGuardTimersUnrefed/.test(codeOnly(readFileSync(f, 'utf8'))))
  check(
    'R2-no-callers',
    callers.length === 0,
    callers.length === 0
      ? `src/ 内 ${files.length} 个文件已无任何调用者`
      : `仍有调用者：${callers.map((f) => f.replace(SRC, '')).join(', ')}`
  )
}

// ---------------------------------------------------------------------------
// R3 · 薄宿主 initialize() 结构上不建定时器（这是"补丁无对象"的根据）
// ---------------------------------------------------------------------------
{
  const thin = readFileSync(join(SRC, 'infrastructure/runtime/thin-host.ts'), 'utf8')
  const initBody = /async initialize\(\)[^{]*\{([\s\S]*?)\n  \}/.exec(thin)?.[1] ?? ''
  const buildsTimer = /setTimeout|setInterval/.test(initBody)
  check(
    'R3-thin-initialize-no-timer',
    !buildsTimer,
    buildsTimer ? '薄宿主 initialize() 里出现了 setTimeout/setInterval' : '薄宿主 initialize() 不建任何定时器 ⇒ 补丁确实无对象'
  )
}

// ---------------------------------------------------------------------------
// R4 · 薄宿主开关缺省 off（换宿主不能变成"无声的默认"）
// ---------------------------------------------------------------------------
{
  const factory = codeOnly(readFileSync(join(SRC, 'infrastructure/runtime/thin-host-factory.ts'), 'utf8'))
  const defaultOff = /export const THIN_HOST_ENV = 'CHARACTER_THIN_HOST'/.test(factory) &&
    /return false/.test(factory.slice(factory.indexOf('function thinHostEnabled')))
  check('R4-switch-default-off', defaultOff, 'CHARACTER_THIN_HOST 缺省 off（未设变量 ⇒ 仍用 ElizaOS）')
}

// ---------------------------------------------------------------------------
// R5 · 生产入口按开关选用宿主，且**只替换绑定**不提前 return
// ---------------------------------------------------------------------------
{
  const main = codeOnly(readFileSync(join(SRC, 'main.ts'), 'utf8'))
  const usesSwitch = /thinHostEnabled\(\)/.test(main)
  const ternary = /const runtime: AgentRuntime = thinHostEnabled\(\)/.test(main)
  const earlyReturn = /if\s*\(\s*thinHostEnabled\(\)\s*\)\s*\{[^}]*return\s+thin/.test(main)
  check('R5-main-uses-switch', usesSwitch && ternary, 'main.ts 用三元式按开关替换 runtime 绑定')
  check('R5-main-no-early-return', !earlyReturn, 'main.ts 没有 `if (thinHostEnabled()) { … return thin }` 提前返回')
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n=== thinhost 退役回归锁: ${checks.length - failed.length}/${checks.length} PASS ===`)
for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
if (failed.length > 0) process.exitCode = 1
