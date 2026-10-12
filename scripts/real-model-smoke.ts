/**
 * 真实模型端到端 smoke（行为层，不是契约层）。
 *
 * ============================================================================
 *  它与 eval-scenarios.ts 的分工
 * ============================================================================
 *   eval-scenarios（echo 模式）  → 断言**链路**：序号、幂等、重放、来源隔离。
 *                                   offline、deterministic，每次提交都能跑。
 *   本脚本（real 模式）          → 断言**行为**：她答得像不像苏沐薇、
 *                                   ContextCompiler 接管后有没有把 XML 念出来、
 *                                   人格有没有跑偏。
 *                                   需要 API Key，跑得慢，属于 PR 的轻量集。
 *
 * 全部在一次性副本库上跑（isolateDatabase），**真实对话库绝不被碰**。
 * 跑法：node_modules/.bin/tsx scripts/real-model-smoke.ts
 */

// .env 必须在任何读 process.env 的模块之前加载（与 main.ts 同一约定）。
// 隔离本身由 bootHarness() 负责：它会先清掉 plugin-sql 的进程级数据库单例，
// 再为本次运行指定一次性数据目录（真实对话库绝不被碰）。
import 'dotenv/config'

import { character } from '../src/character/index.ts'
import {
  assertInvariants,
  bootHarness,
  type InvariantViolation,
} from '../evals/harness/runner.ts'
import { cleanupSandbox } from '../src/dev/sandbox.ts'

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
const record = (name: string, ok: boolean, detail = ''): void => {
  checks.push({ name, ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const PROMPTS = [
  '我今天面试挂了，不太想说话。',
  '你怎么不说话。',
  '我下周三要考高数，有点慌。',
]

console.log('='.repeat(72))
console.log('真实模型端到端 smoke（M2.5 链路 + ContextCompiler v1）')
console.log('='.repeat(72))

if (!process.env.OPENAI_API_KEY) {
  console.error('缺少 OPENAI_API_KEY：这个 smoke 需要真实模型，请在 .env 里配置。')
  process.exit(2)
}

const { agent, kernel } = await bootHarness('real-smoke', { modelMode: 'real' })
let sandboxDir: string | undefined = agent.dataDir

try {
  for (const [index, text] of PROMPTS.entries()) {
    const turn = await agent.say(text)
    console.log(`\n  turn ${index + 1}`)
    console.log(`    用户: ${text}`)
    console.log(`    她  : ${turn.reply.replace(/\n/g, ' / ')}`)
    console.log(
      `    上下文: ${turn.packet.sections.map((s) => s.id).join(' + ')} ` +
        `(~${turn.packet.estimatedTokens} tokens, ${turn.modelDurationMs}ms)`,
    )
  }

  const run = await agent.buildRun('REAL-SMOKE', 0)
  const generated = agent.captured.filter((t) => t.reply.trim() !== '')

  console.log('\n=== 断言 ===')
  record(
    '每一轮都产生了非空回复',
    generated.length === PROMPTS.length,
    `${generated.length}/${PROMPTS.length}`,
  )

  const xmlLeak = agent.captured.filter((t) => /<response>|<thought>|<actions>/i.test(t.reply))
  record(
    '回复里没有 XML 结构泄漏（她不是在念模板）',
    xmlLeak.length === 0,
    xmlLeak.length > 0 ? xmlLeak[0].reply.slice(0, 80) : '干净',
  )

  const contextLeak = agent.captured.filter((t) =>
    /seed-identity|critical-state|recent-conversation|ContextCompiler|section/.test(t.reply),
  )
  record(
    '回复里没有复述上下文条目名（她在说话，不是在汇报）',
    contextLeak.length === 0,
    contextLeak.length > 0 ? contextLeak[0].reply.slice(0, 80) : '干净',
  )

  const allHaveSeed = agent.captured.every((t) =>
    t.packet.sections.some((s) => s.id === 'seed-identity'),
  )
  record('每一轮上下文都带 Seed Identity', allHaveSeed)

  const traces = await kernel.stores.traceWriter.recent(kernel.characterId, 10)
  record(
    '每一轮都留下了 trace（输入事件 / Context 版本 / 输出事件）',
    traces.length === PROMPTS.length,
    `${traces.length} 条`,
  )
  const tracesWithSections = traces.filter((t) => t.contextSectionIds.length > 0)
  record(
    'trace 记录了实际使用的 section',
    tracesWithSections.length === traces.length,
    `${tracesWithSections.length}/${traces.length}`,
  )

  const domainCount = run.domainEvents.length
  record(
    '慢路径为每轮用户消息产生了 domain event',
    domainCount === PROMPTS.length,
    `${domainCount} 条`,
  )

  const violations: InvariantViolation[] = assertInvariants(run)
  record(
    '跨场景不变量全部成立（来源隔离 / 序号 / 溯源 / 幂等）',
    violations.length === 0,
    violations.length > 0
      ? violations.map((v) => `[${v.code}] ${v.message}`).join(' | ')
      : '无违反',
  )

  // 人格（人工可读的旁证，不做硬断言）：她不该自我介绍了三遍
  const introduces = agent.captured.filter((t) => /我是苏沐薇|我叫苏沐薇/.test(t.reply))
  record(
    '没有反复自我介绍（人格锚点在起作用，而不是每轮重新生成）',
    introduces.length <= 1,
    `${introduces.length} 次`,
  )
} finally {
  await kernel.stores.traceWriter.recent(kernel.characterId, 1).catch(() => undefined)
  if (sandboxDir) cleanupSandbox(sandboxDir)
  sandboxDir = undefined
}

const passed = checks.filter((c) => c.ok).length
const failed = checks.length - passed
console.log(`\n${'='.repeat(72)}`)
console.log(`真实模型 smoke：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  for (const check of checks.filter((c) => !c.ok)) {
    console.log(`  - ${check.name} → ${check.detail}`)
  }
}
console.log('='.repeat(72))

void character
process.exit(failed === 0 ? 0 : 1)
