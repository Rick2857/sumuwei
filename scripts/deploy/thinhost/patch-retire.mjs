/**
 * 给**服务器当前版本**的 main.ts 打「退役 guard-timers」补丁。
 *
 * ⚠️ 为什么用脚本而不是覆盖（第一轮事故的教训）：
 *    本机工作树比服务器新（引用服务器没有的模块）⇒ 整体覆盖会让核心起不来。
 *    本脚本只删两处，其余逐字节不动；失败关闭（锚点找不到即非零退出）。
 *
 * 删两处：
 *   ① import { withGuardTimersUnrefed } from './infrastructure/runtime/guard-timers.ts'
 *   ② const initialized = await withGuardTimersUnrefed(() => runtime.initialize())
 *      + 它后面那段 if (initialized.report.unrefed > 0) { logger.info(...) }
 */

import { readFileSync, writeFileSync } from 'node:fs'

const target = process.argv[2]
if (!target) { console.error('用法：node patch-retire.mjs <server-main.ts>'); process.exit(2) }

let src = readFileSync(target, 'utf8')
const before = src
const EOL = src.includes('\r\n') ? '\r\n' : '\n'

// --- 失败关闭：已经退役过就别再打 ---
if (!src.includes('withGuardTimersUnrefed')) {
  console.error('拒绝：这个文件里没有 withGuardTimersUnrefed（可能已退役过）')
  process.exit(3)
}

// --- ① 删 import 整行 ---
const importLine = "import { withGuardTimersUnrefed } from './infrastructure/runtime/guard-timers.ts'"
if (!src.includes(importLine)) {
  console.error(`拒绝：找不到 import 行${EOL === '\r\n' ? '（注意 CRLF）' : ''}`)
  process.exit(4)
}
src = src.replace(`${importLine}${EOL}`, '')

// --- ② 删调用 + 紧随的 if 块 ---
const lines = src.split(/\r?\n/)
const callIdx = lines.findIndex((l) => l.includes('withGuardTimersUnrefed(() => runtime.initialize())'))
if (callIdx === -1) { console.error('拒绝：找不到 withGuardTimersUnrefed 调用行'); process.exit(5) }

// 该行及其**上面**的说明注释块（本轮写的退役说明要保留，旧的补丁说明要删）
// 先往上吞掉紧邻的旧注释块（以 "  // ⚠️ `withGuardTimersUnrefed` 不是装饰" 开头的那段）
let start = callIdx
while (start > 0 && /^\s*(\/\/|\/\*|\*)/.test(lines[start - 1])) start -= 1

// 往下吞掉 if (initialized.report...) {...} 整块
let end = callIdx + 1
if (lines[end] !== undefined && /if \(initialized\.report\.unrefed > 0\)/.test(lines[end])) {
  let depth = 0
  while (end < lines.length) {
    depth += (lines[end].match(/\{/g) ?? []).length
    depth -= (lines[end].match(/\}/g) ?? []).length
    end += 1
    if (depth <= 0) break
  }
}

const replacement = [
  '  // ⚠️ 2026-10-18：`withGuardTimersUnrefed` 已**退役**（补丁文件也从 src/ 删除）。',
  '  //    退役理由不是"补丁失效"，是**对象不存在**：那个猴子补丁针对的是',
  '  //    `@elizaos/core` 的 `registerService` 为每个服务建的 30s 孤儿定时器，',
  '  //    而薄宿主 `initialize()` **不注册任何服务**，结构上就不建那些定时器。',
  '  //    ⇒ 留着它反而是"每启动一次就把全局 setTimeout 换一轮"的无谓猴子补丁。',
  '  //    回归锁：`pnpm cli:exit:verify`（仍断言快速退出 + 负控 30s）与',
  '  //    `pnpm thinhost:retirement:verify`（断言补丁不被重新引入）。',
  '  const initialized = await runtime.initialize()',
  '  void initialized',
]

lines.splice(start, end - start, ...replacement)
const patched = lines.join(EOL)

if (patched === before) { console.error('拒绝：没有产生任何变化'); process.exit(6) }
writeFileSync(target, patched, 'utf8')

console.log(JSON.stringify({
  patched: true,
  eol: EOL === '\r\n' ? 'CRLF' : 'LF',
  removedLines: end - start,
  insertedLines: replacement.length,
  linesBefore: before.split(/\r?\n/).length,
  linesAfter: lines.length,
  stillMentions: /withGuardTimersUnrefed/.test(patched.replace(/\/\/[^\n]*/g, '')),
}, null, 2))
