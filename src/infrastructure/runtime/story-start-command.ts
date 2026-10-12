/**
 * **S8 / `L-S8-30` + `ADR-107` `R-2a′`** —— `pnpm story:start` 的执行体（用户入口的 DB 侧）。
 *
 * ============================================================================
 *  它做什么（**写操作**：写一条世界提交）
 * ============================================================================
 * ```text
 * ① 解析并校验（纯逻辑在 kernel/app/storyline/admin.ts，失败关闭）
 * ② **显式告警**（`cognitive-integrity` §2 的 "Explicit Warning"）：先说清它改变什么
 * ③ 走 kernel 的 `startStoryRun()`：单活跃 run 判据 → 既有开局路径 → 幂等
 * ④ **回读**：从账本读回那一条，确认 eventType/revision/绑定形状都如声明
 * ```
 *
 * ⚠️ 它**不**替用户做任何选择（`D02.4`）：只写 `STORY_STARTED` 一条，`choice_id` 为空。
 * ⚠️ 它**不**自动开始任何故事：必须由人显式敲这条命令（`D02.2①`）。
 * ⚠️ 它**不**打开真实库以外的任何东西：DB 由 `main.ts` 的生产开库路径（租约 → 快照 → token）给。
 *
 * ⚠️ 与 `story-withdraw` 的一处**刻意不同**：撤回是往**领域事件流**追加一条；
 *    开局是往**世界账本**写第一条提交。两者是两套账（`ADR-093 D01`），不要混。
 */

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import { STORY_START_USAGE, parseStoryStartArgs } from '../../kernel/app/storyline/admin.ts'
import {
  activeStoryRunOf,
  startStoryRun,
  storyRunStatusesOf,
} from '../../kernel/app/storyline/run-lifecycle.ts'
import { JICHUANG_PACK } from '../../content/storyline/jichuang-interview-two/story-pack.ts'
import { createStoryLedgerStore } from '../storyline/store/story-ledger-store.ts'
import type { RawDb } from '../persistence/db.ts'

export async function runStoryStartCommand(input: {
  readonly db: RawDb
  readonly characterId: CharacterId
  /** `--story-start` 之后的参数 */
  readonly argv: readonly string[]
  readonly now: () => number
}): Promise<number> {
  const parsed = parseStoryStartArgs(input.argv)
  if (!parsed.ok) {
    console.error(`❌ ${parsed.code}：${parsed.detail}`)
    console.error(`   用法：${STORY_START_USAGE}`)
    return 2
  }
  const { runId } = parsed.request
  const ledger = createStoryLedgerStore(input.db)
  const pack = JICHUANG_PACK

  /* ② 显式告警（不是装饰：这一条写进去之后，后续用户选择就能变成她的情绪/关系/反思状态） */
  console.log('')
  console.log('  ⚠️ 显式开始一次故事 run（写操作）')
  console.log(`    角色        : ${String(input.characterId)}`)
  console.log(`    故事        : ${pack.storyId}@v${String(pack.storyVersion)}（服务端内容包，不由参数指定）`)
  console.log(`    runId       : ${runId}（服务端身份；重复用同一 runId 是幂等的，开新故事要换一个）`)
  console.log('    它改变什么  : 写一条 STORY_STARTED（revision 1）。此后**用户自己做的选择**')
  console.log('                  可以经三个消费者（affect / relationship / reflection）形成状态。')
  console.log('    它不做什么  : 不替用户选择、不自动推进剧情、不直接写任何情绪/关系投影。')
  console.log('    绑定        : interactionKind=system（STORY_STARTED **不允许** user_choice —— 开局不是一次用户选择）')
  console.log('    ⚠️ 前置      : 故事认知消费受 CHARACTER_STORY_COGNITION_ENABLED 控制（代码缺省 false）')

  /* ③ 走 kernel 的单活跃 run 判据 + 既有开局路径 */
  const outcome = await startStoryRun({ ledger, pack, runId, now: input.now() })
  if (!outcome.ok) {
    console.error(`❌ ${outcome.code}：${outcome.detail}`)
    /* 具名拒收 ⇒ **零写入**：把"没写成"说清楚，不复述任何"看起来像成功"的话 */
    return 1
  }

  /* ④ 回读：不信内存里的返回值，从账本读回那一条 */
  const stored = await ledger.readCommit(outcome.commitId)
  const statuses = await storyRunStatusesOf({ ledger, pack })
  const active = await activeStoryRunOf({ ledger, pack })
  const okReadback =
    stored !== undefined &&
    stored.eventType === 'STORY_STARTED' &&
    stored.revision === 1 &&
    stored.runId === runId &&
    stored.binding.actorKind === 'system' &&
    stored.binding.interactionKind === 'system' &&
    stored.binding.interactionRef === undefined &&
    stored.binding.anchorConversationEventId === undefined &&
    stored.choiceId === undefined

  console.log('')
  console.log(`    提交        : ${outcome.status === 'appended' ? '已写入' : '已存在（幂等命中，未写第二行）'}`)
  console.log(`    commitId    : ${outcome.commitId}`)
  console.log(`    revision    : ${String(outcome.revision)}`)
  console.log(`    回读        : ${okReadback ? '✅ STORY_STARTED @1 · system 绑定 · 无 choice_id · 无伪造会话字段' : '❌ 与声明不符（见下）'}`)
  if (!okReadback) {
    console.error(
      `       实测：type=${String(stored?.eventType)} revision=${String(stored?.revision)} ` +
        `actorKind=${String(stored?.binding.actorKind)} interactionKind=${String(stored?.binding.interactionKind)} ` +
        `interactionRef=${String(stored?.binding.interactionRef)} anchor=${String(stored?.binding.anchorConversationEventId)} ` +
        `choiceId=${String(stored?.choiceId)}`
    )
  }
  console.log(`    活跃 run    : ${active === undefined ? '（无）' : `${active.runId}（${String(active.commits)} 条提交）`}`)
  console.log(
    `    全部 run    : ${
      statuses.length === 0
        ? '（无）'
        : statuses
            .map(
              (status) =>
                `${status.runId}(${String(status.commits)}${status.folded ? '' : '·账本有缺口'}${
                  status.terminal ? '·终局' : '·活跃'
                })`
            )
            .join(' · ')
    }`
  )
  console.log('    ⚠️ 此后每轮由 `CHARACTER_STORY_COGNITION_ENABLED` 决定是否消费（代码缺省 false）')
  return okReadback ? 0 : 1
}
