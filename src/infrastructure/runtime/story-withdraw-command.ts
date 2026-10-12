/**
 * **S8 / `L-S8-09`** —— `pnpm story:withdraw` 的执行体（用户入口的 DB 侧）。
 *
 * ============================================================================
 *  它做什么（**写操作**）
 * ============================================================================
 * ```text
 * ① 解析并校验（纯逻辑在 kernel/app/storyline/admin.ts，失败关闭）
 * ② **引用存在性检查**：被撤回的提交必须真的在账本里（查 `listCommits`）
 *    —— 否则会留下"悬空撤回事件"（撤回了不存在的东西，日后无法解释）
 * ③ 追加 `STORY_EXPERIENCE_RETRACTED`（幂等键 = 来源 + 理由）
 * ④ 回读：打印事件 id，并**重新解析该来源的根**，确认它现在报 `story_root_withdrawn`
 * ```
 *
 * ⚠️ 撤回**不**物理删除世界历史（`ADR-093 D12`）：本命令只追加一条事件，
 *    读时传播（`R-11`）负责让依赖它的槽不再入模。
 */

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import { STORY_EXPERIENCE_RETRACTED } from '../../kernel/contracts/story-events.ts'
import { parseStorySourceId } from '../../kernel/contracts/source-authority.ts'
import { expandLineage } from '../../kernel/app/reflection/lineage.ts'
import {
  STORY_WITHDRAW_USAGE,
  parseStoryWithdrawArgs,
  storyWithdrawIdempotencyKey,
  storyWithdrawPayloadOf,
} from '../../kernel/app/storyline/admin.ts'
import { appendDomainEvent, domainEventsFor } from '../persistence/event-store.ts'
import { latestDomainEventSequence } from '../persistence/reflection-input-source.ts'
import { createReflectionLineageLookup } from '../persistence/reflection-lineage-read.ts'
import { createStoryLedgerStore } from '../storyline/store/story-ledger-store.ts'
import type { RawDb } from '../persistence/db.ts'

export async function runStoryWithdrawCommand(input: {
  readonly db: RawDb
  readonly characterId: CharacterId
  /** `--story-withdraw` 之后的参数 */
  readonly argv: readonly string[]
  readonly now: () => number
}): Promise<number> {
  const parsed = parseStoryWithdrawArgs(input.argv)
  if (!parsed.ok) {
    console.error(`❌ ${parsed.code}：${parsed.detail}`)
    console.error(`   用法：${STORY_WITHDRAW_USAGE}`)
    return 2
  }
  const { request } = parsed
  const parts = parseStorySourceId(request.sourceId)!
  const ledger = createStoryLedgerStore(input.db)

  /* ② 引用存在性：撤回了不存在的东西 = 悬空事件 */
  const commits = await ledger.listCommits({ storyId: parts.storyId, runId: parts.runId })
  const target = commits.find((commit) => commit.commitId === request.sourceId)
  if (target === undefined) {
    console.error(
      `❌ story_withdraw_target_missing：账本里没有这条提交（storyId=${parts.storyId} runId=${parts.runId} commitId=${request.sourceId}）\n` +
        `   该 run 现有 ${String(commits.length)} 条提交 ⇒ **不写**（撤回了不存在的东西会留下悬空撤回事件）`
    )
    return 1
  }

  /* ③ 追加撤回事件（幂等：同来源同理由重复执行不产生第二条） */
  const payload = storyWithdrawPayloadOf({
    characterId: String(input.characterId),
    request,
    withdrawnAt: input.now(),
  })
  const before = await latestDomainEventSequence(input.db, input.characterId)
  const appended = await appendDomainEvent(
    input.db,
    input.characterId,
    {
      type: STORY_EXPERIENCE_RETRACTED,
      operation: 'story-withdraw',
      payload,
      sourceConversationEventIds: [],
      idempotencyKey: storyWithdrawIdempotencyKey(request),
      processor: 'story-withdraw',
      processorVersion: 'story-withdraw@1',
      scope: 'CHARACTER_INTERNAL',
    } as never,
    before + 1
  )
  const eventId = String((appended as { event?: { id?: unknown } }).event?.id ?? '')
  const total = (await domainEventsFor(input.db, input.characterId)).length

  /* ④ 回读：该来源的根现在必须报 `story_root_withdrawn` */
  const lineage = await expandLineage(
    createReflectionLineageLookup(input.db, { characterId: input.characterId }),
    [{ kind: 'story_event', id: request.sourceId }],
    { characterId: String(input.characterId) }
  )
  const withdrawnNow = lineage.rejections.some((row) => row.reason === 'story_root_withdrawn')

  console.log('')
  console.log('  故事体验撤回（认知使用资格；**不**删除世界历史）')
  console.log(`    来源        : ${request.sourceId}`)
  console.log(`    理由        : ${request.reason}${request.note === undefined ? '' : `（${request.note}）`}`)
  console.log(`    撤回事件 id : ${eventId === '' ? '(未返回)' : eventId}`)
  console.log(`    领域事件数  : ${String(total)}`)
  console.log(`    回读        : 该来源的根解析 = ${withdrawnNow ? '✅ story_root_withdrawn（撤回已生效）' : '⚠️ 未报 withdrawn（需查读时传播）'}`)
  console.log(`    ⚠️ 幂等：同来源 + 同理由重复执行不会产生第二条撤回事件`)
  return withdrawnNow ? 0 : 1
}
