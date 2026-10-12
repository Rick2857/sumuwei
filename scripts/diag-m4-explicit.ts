/**
 * 诊断：显式记忆路径**为什么没写成**。
 *
 * 用法：
 *   tsx scripts/diag-m4-explicit.ts "记住，我现在上的大学是示例工程科技大学"
 *   tsx scripts/diag-m4-explicit.ts "记住，我不吃香菜"
 *
 * 它把显式路径拆成**可单独观察**的步骤，逐步打印：
 *   ① 意图判定（有没有识别出显式指令、命中哪条规则）
 *   ② 内容抽取（抽出了什么结构化内容，或为什么没有）
 *   ③ 目标解析（只在纠正 / 忘掉时需要，本脚本不连库因此只说明）
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 * 真库实测：用户说「记住，我现在上的大学是示例工程科技大学」，
 * 修复接线之后她**如实说"没记上"**（计划书第 55 节的行为对了），
 * 但写入本身失败了 —— 而失败原因只以一句话进了 context，
 * **没有落在任何日志里**。
 *
 * 一份"只告诉你失败了"的路径无法被排查。这个脚本把中间步骤摊开：
 * 是听不懂（`content_unresolved`）？放行被拒（`rejected_by_policy`）？
 * 还是落库炸了（`persistence_failed`）？三者要修的地方完全不同。
 *
 * 纯离线：不连库、不调模型、不写任何东西。
 */

import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { createExplicitMemoryIntentDetector } from '../src/kernel/app/memory/intent-detector.ts'
import { entityRef } from '../src/kernel/contracts/index.ts'

const text = process.argv
  .slice(2)
  .filter((a) => !a.startsWith('--'))
  .join(' ')

if (text.trim() === '') {
  console.error('用法：tsx scripts/diag-m4-explicit.ts "记住，……"')
  process.exit(2)
}

console.log('='.repeat(72))
console.log('显式记忆路径诊断（离线：不连库、不调模型）')
console.log('='.repeat(72))
console.log(`  输入：${text}`)
console.log('')

let failedAt: string | undefined

// ---------------------------------------------------------------------------
// ① 意图判定
// ---------------------------------------------------------------------------

const detector = createExplicitMemoryIntentDetector()
const intent = await detector.detect(text)

console.log('① 意图判定')
if (intent === undefined) {
  failedAt = '① 意图判定'
  console.log('  ❌ 没有识别出显式记忆意图')
  console.log('     这句话会走**后台路径**，而后台抽取默认关闭')
  console.log('     → 它不会被记住，而系统也不会声称记住了（没有指令）')
  console.log('     修法：往 `MEMORY_INTENT_RULES` 补关键词。')
} else {
  console.log(`  ✅ kind=${intent.kind}  命中「${intent.matched}」（${intent.detectedBy}）`)
  console.log(`     payload（去掉指令外壳后的内容）："${intent.payload}"`)
}
console.log('')

// ---------------------------------------------------------------------------
// ② 内容抽取
// ---------------------------------------------------------------------------

if (intent !== undefined && failedAt === undefined) {
  const extractor = createRuleOnlyContentExtractor()
  const owner = entityRef('character', 'diag-probe')
  const speaker = entityRef('user', 'diag-probe')

  const extracted = await extractor.extract({
    text: intent.payload,
    owner,
    speaker,
  })

  console.log(`② 内容抽取（规则抽取器 ${extractor.name}，显式路径的缺省）`)
  if (extracted === undefined) {
    failedAt = '② 内容抽取'
    console.log('  ❌ 抽不出结构化内容 → 服务会返回 `content_unresolved`')
    console.log('     这不是系统故障，而是"这句话没被听懂"。')
    console.log('     修法二选一：')
    console.log('       · 往 `content-extractor.ts` 的槽位线索表补这个说法')
    console.log('       · 换成 `ChainedContentExtractor`（规则 → LLM 兜底）')
  } else {
    console.log(`  ✅ 抽出：${JSON.stringify(extracted)}`)
  }
  console.log('')
}

// ---------------------------------------------------------------------------
// ③ 目标解析
// ---------------------------------------------------------------------------

if (failedAt === undefined && intent !== undefined) {
  console.log('③ 目标解析')
  if (intent.kind === 'remember') {
    console.log('  （remember 不需要 —— 它建立新记忆，不指向旧条）')
  } else {
    console.log(`  ${intent.kind} 需要解析"用户指的是哪一条"，五级梯子：`)
    console.log('    明确 id → canonical key → subject+predicate → 小候选集 → 语义判别')
    console.log('  ⚠️ 本脚本**不连库**，因此不实际执行；连库诊断见下方提示。')
  }
  console.log('')
}

// ---------------------------------------------------------------------------

console.log('='.repeat(72))
console.log('结论')
console.log('='.repeat(72))

if (failedAt === undefined) {
  console.log('  意图与抽取**都成功** → 失败发生在更后面：')
  console.log('    · 放行口拒绝（权威 / 证据 / payload / 幂等）—— 码如 `rejected_by_policy`')
  console.log('    · 落库异常 —— 码 `persistence_failed`')
  console.log('  这两者需要**连库**才能观察。下一步：')
  console.log('    tsx scripts/verify-m4-persistence.ts   # 它覆盖了 §13 的三条显式路径')
  console.log('  或对真库那一条打开 trace 看 `memory_explicit_write` 的 status。')
} else {
  console.log(`  卡在：${failedAt}`)
  console.log('  这是一个**离线可复现**的问题 —— 不需要连库就能修。')
}
