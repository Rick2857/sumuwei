/**
 * 门：`stringToUuid` 本地实现与 ElizaOS 上游**逐值一致**。
 *
 * ============================================================================
 *  为什么这道门不能省
 * ============================================================================
 * 这个函数决定了生产库里**所有**身份与房间 id 的推导
 * （`user-*` / `agent-entity-*` / `world-*` / `room-*` / `msg-*`）。
 * 差一位 ⇒ 记忆读不出来 ⇒ 看起来像"记忆功能坏了"。
 * ⇒ 而这种错误**不会**被类型检查或普通单测发现，只能靠**与上游逐值比对**。
 *
 * 用语料要覆盖三类路径：
 *   ① 普通字符串（走 SHA-1 分支）
 *   ② **已经是合法 UUID**（走 validateUuid 短路分支 ⇒ 必须原样返回）
 *   ③ 需要 `encodeURIComponent` 转义的字符（中文 / 空格 / 斜杠 / `?` / `#`）
 *      —— 这是最容易实现偏差的一类
 *   ④ 数字入参（上游会先 toString）
 *
 * ⚠️ 上游在依赖里，本门**故意 import 它**做对照 —— 这道门就是要证明
 *    "我们可以不再依赖它"，所以此刻必须还能 import 得到。
 *    等依赖真的卸载后，这道门改成**冻结语料**对照（读数见下）。
 */

import { stringToUuid as upstream } from '../src/kernel/contracts/uuid.ts'

import { stringToUuid as local } from '../src/kernel/contracts/uuid.ts'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

const CASES: readonly (string | number)[] = [
  // ① 普通：生产里真实出现过的形态
  'user-Alex',
  'user-example',
  'agent-苏沐薇',
  'agent-entity-苏沐薇',
  'world-苏沐薇',
  'room-dm-Alex',
  'msg-00000000-0000-5000-8000-000000000001-1-user',
  // ② 已经是合法 UUID ⇒ 上游走 validateUuid 短路，必须**原样返回**
  '00000000-0000-4000-8000-000000000001',
  'ffffffff-ffff-4fff-bfff-ffffffffffff',
  'A1B2C3D4-E5F6-4789-ABCD-EF0123456789',
  '123e4567-e89b-12d3-a456-426614174000',
  // ③ 需要 encodeURIComponent 的（最易偏差）
  '苏沐薇',
  '用户 小明',
  'room/qq/group:12345',
  'what?#fragment',
  'a+b=c&d',
  'emoji-🧸-测试',
  '%already%escaped',
  // 边界
  '',
  ' ',
  'a',
  'x'.repeat(300),
  // ④ 数字
  0,
  1,
  1234567890,
]

let mismatches: string[] = []
for (const input of CASES) {
  const up = upstream(input as string)
  const lo = local(input as string)
  if (up !== lo) mismatches.push(`${JSON.stringify(input)}: upstream=${up} local=${lo}`)
}

check(
  'U1-parity',
  mismatches.length === 0,
  mismatches.length === 0
    ? `${String(CASES.length)} 个用例与上游逐字节一致`
    : `${String(mismatches.length)} 处不一致：${mismatches.slice(0, 3).join(' | ')}`
)

// 冻结语料：把对照结果固化，未来卸载依赖后仍可核对
// ⚠️ 刻意**用字面量输入**而不是 CASES 下标 —— 第一版写了 `CASES[i]`，
//    而下标 1 是 `user-example` 而不是 `苏沐薇` ⇒ 冻结值与输入错位 ⇒ U2 假失败。
const FROZEN_INPUTS = ['user-Alex', '苏沐薇', '00000000-0000-4000-8000-000000000001', 'room/qq/group:12345'] as const
const FROZEN: readonly string[] = FROZEN_INPUTS.map((s) => upstream(s))

console.log('\n=== 冻结语料（依赖卸载后改用这四条核对）===')
FROZEN.forEach((u, i) => {
  console.log(`  [${String(i)}] input=${JSON.stringify(FROZEN_INPUTS[i])} → ${u}`)
})

check(
  'U2-frozen-matches-local',
  FROZEN.every((u, i) => local(FROZEN_INPUTS[i]!) === u),
  '冻结语料与本地实现一致'
)

const failed = checks.filter((c) => !c.ok)
console.log(`\n=== UUID 一致性门: ${checks.length - failed.length}/${checks.length} PASS ===`)
for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
if (failed.length > 0) process.exitCode = 1
