/**
 * 给**服务器当前版本**的 main.ts 打薄宿主接线补丁。
 *
 * ⚠️ 为什么用脚本而不是直接拷本机文件：
 *    上一轮事故的根因就是"用本机文件整体覆盖服务器文件"——
 *    本机工作树比服务器新（引用服务器上没有的模块）⇒ 核心起不来。
 *    本脚本只在服务器版 `main.ts` 上**插入两处**：
 *      ① 一行 import
 *      ② `buildRuntime()` 里 `new AgentRuntime(...)` 之前的一段薄宿主分支
 *    其余**逐字节不动**。
 *
 * 用法：node patch-server-main.mjs <server-main.ts>
 * 失败关闭：任何一处锚点找不到 / 已打过补丁 ⇒ 非零退出，不产出文件。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const target = process.argv[2]
if (!target) {
  console.error('用法：node patch-server-main.mjs <server-main.ts>')
  process.exit(2)
}

let src = readFileSync(target, 'utf8')
const before = src
// ⚠️ 服务器文件可能是 CRLF（从 Windows 侧部署而来）。锚点匹配必须**行尾无关**，
//    否则第一版就因为 `}\r\n)` 匹配不上而失败退出（EXIT=5）。
const EOL = src.includes('\r\n') ? '\r\n' : '\n'
const lines = (s) => s.split(/\r?\n/)
console.log(`EOL=${EOL === '\r\n' ? 'CRLF' : 'LF'}`)

// --- 失败关闭：已经打过补丁就别再打 ---
if (src.includes('thin-host-factory.ts')) {
  console.error('拒绝：这个文件已经打过薄宿主补丁')
  process.exit(3)
}

// --- ① import ---
const IMPORT_ANCHOR = "import { ConversationRecorder } from './infrastructure/runtime/conversation-recorder.ts'"
if (!src.includes(IMPORT_ANCHOR)) {
  console.error(`拒绝：找不到 import 锚点\n  ${IMPORT_ANCHOR}`)
  process.exit(4)
}
src = src.replace(
  IMPORT_ANCHOR,
  `${IMPORT_ANCHOR}${EOL}import { createThinHostRuntime, thinHostEnabled } from './infrastructure/runtime/thin-host-factory.ts'`
)

// --- ② buildRuntime 里的薄宿主分支：按**行**定位，避免行尾差异 ---
const all = lines(src)
const startIdx = all.findIndex((l) => l === '  const runtime = new AgentRuntime({')
if (startIdx === -1) {
  console.error('拒绝：找不到 new AgentRuntime 行')
  process.exit(5)
}
// 确认紧随其后的 5 行是那组参数（防止匹配到别处）
const expected = ['    character,', '    plugins,', '    conversationLength: CONVERSATION_LENGTH,', '    settings,', '  })']
for (let i = 0; i < expected.length; i += 1) {
  if (all[startIdx + 1 + i] !== expected[i]) {
    console.error(`拒绝：第 ${String(startIdx + 2 + i)} 行不是预期内容：${JSON.stringify(all[startIdx + 1 + i])}`)
    process.exit(7)
  }
}

const branch = [
  '  /*',
  '   * 薄宿主选择（thinhost，2026-10-18）—— 缺省仍是 ElizaOS，本段逐字不变',
  '   *',
  '   * 实测（本机 + Linux 服务器配对，docs/post-lv2/ThinHost-Replacement-Attribution-2026-10-18.md）：',
  '   *   · 稳态空闲 CPU 1.019% → 0.009% 单核',
  '   *   · 上游 30s 守卫定时器 2 → 0',
  '   *   · 内存与启动时间基本持平（不虚报这两项）',
  '   *',
  '   * ⚠️⚠️ 这里**只能替换 runtime 这个绑定，绝不能提前 return**。',
  '   *    第一版写成 `if (thinHostEnabled()) { … return thin }` ⇒ 后面的',
  '   *    initDatabase / 生产状态机 / buildKernel 全部被跳过 ⇒',
  '   *    getRawDb() 抛 no_db_handle ⇒ 核心起不来（真实发生过一次故障）。',
  '   *    薄宿主同样要经 openDatabase() 注册适配器、走租约与 pre-open 快照。',
  '   */',
  '  const runtime: AgentRuntime = thinHostEnabled()',
  '    ? (() => {',
  '        const thin = createThinHostRuntime({',
  '          character: { name: character.name, id: character.id },',
  '          agentId: stringToUuid(`agent-${character.name}`),',
  '          settings,',
  '          conversationLength: CONVERSATION_LENGTH,',
  '        })',
  "        logger.info('[thin-host] 已选用薄 Node 宿主（ElizaOS 不参与本进程）')",
  '        return thin',
  '      })()',
  '    : new AgentRuntime({',
  '        character,',
  '        plugins,',
  '        conversationLength: CONVERSATION_LENGTH,',
  '        settings,',
  '      })',
]

// ⚠️ 必须是**替换**那 6 行，不是**插入**。
//    第一版用 splice 插入却没删原声明 ⇒ esbuild 报
//    `The symbol "runtime" has already been declared`（真实发生过一次故障）。
all.splice(startIdx, expected.length + 1, ...branch)
const patched = all.join(EOL)
writeFileSync(target, patched, 'utf8')
console.log(JSON.stringify({
  patched: true,
  eol: EOL === '\r\n' ? 'CRLF' : 'LF',
  linesBefore: lines(before).length,
  linesAfter: all.length,
  at: startIdx + 1,
  replacedLines: expected.length + 1,
}, null, 2))
