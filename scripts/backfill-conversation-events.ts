/**
 * 回填演练脚本（沙箱）：把 `memories` 里的既有对话补进事实账本。
 *
 * ============================================================================
 *  用法
 * ============================================================================
 *   node_modules/.bin/tsx scripts/backfill-conversation-events.ts           # 预览（不改库）
 *   node_modules/.bin/tsx scripts/backfill-conversation-events.ts --apply   # 在**沙箱库**里写入
 *
 * ⚠️ 这个脚本永远只作用于**一次性副本库**（`isolateDatabase`）。
 *    要作用于真实对话库，请用主程序的 `--backfill-events`
 *    （它持有生产库写权限，见 src/main.ts）。
 *
 * 这样分工的理由：回填是一次性迁移，必须显式、可审计、有备份意识；
 * 让一个随手可跑的脚本直接改真实历史不是好主意。
 * 真正的回填逻辑在 `src/infrastructure/persistence/backfill.ts`（两处共用）。
 */

import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { ChannelType } from '../src/infrastructure/runtime/eliza-vocabulary.ts'
import { stringToUuid } from '../src/kernel/contracts/uuid.ts'



import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('backfill-events')

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { asConversationId } from '../src/kernel/contracts/index.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import { applyBackfill, planBackfill } from '../src/infrastructure/persistence/backfill.ts'
import { sql } from 'drizzle-orm'

const APPLY = process.argv.includes('--apply')
const userName = process.env.USER_NAME ?? 'Alex'

const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
await initDatabase(runtime)
await runtime.initialize()
const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character),
})
const db = kernel.stores.db

const userEntityId = stringToUuid(`user-${userName}`)
const options = {
  characterId: kernel.characterId,
  conversationId: asConversationId(`dm-${kernel.definition.slug}-${userEntityId.slice(0, 8)}`),
  roomId: stringToUuid(`room-dm-${userName}`),
  userEntityId,
  agentEntityId: stringToUuid(`agent-entity-${character.id ?? character.name}`),
  userName,
}

console.log('='.repeat(72))
console.log(`回填 memories → conversation_events${APPLY ? '（APPLY）' : '（预览）'}`)
console.log('='.repeat(72))

const plan = await planBackfill(db, options)

console.log(`\n房间里 ${plan.total + plan.skippedEmpty} 条消息，其中可回填 ${plan.total} 条（空内容跳过 ${plan.skippedEmpty} 条）`)
console.log(`  用户消息   : ${plan.userCount} 条  → actorType = 'user'`)
console.log(`  她的回复   : ${plan.characterCount} 条  → actorType = 'character'`)
console.log(`  账本现有   : ${plan.existingEvents} 条`)

if (plan.total > 0) {
  console.log(`\n前 4 条预览：`)
  for (const item of plan.items.slice(0, 4)) {
    const who = item.actorType === 'user' ? userName : character.name
    console.log(
      `  [${new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}] ${who}: ` +
        `${item.content.replace(/\n/g, ' / ').slice(0, 50)}`,
    )
  }
}

if (!APPLY) {
  console.log('\n（预览模式，未写入）真实库请用主程序：--backfill-events')
  await runtime.stop()
  process.exit(0)
}

const result = await applyBackfill(db, options, plan)
console.log(`\n写入 ${result.written} 条，幂等命中 ${result.deduplicated} 条`)
console.log(`账本：${result.before} → ${result.after} 条`)

console.log('\n=== 校验：按来源统计 ===')
for (const row of rowsOf(
  await db.execute(
    sql`select actor_type, count(*)::int as c from conversation_events
        where character_id = ${kernel.characterId} group by actor_type order by actor_type`,
  ),
)) {
  console.log(`  ${String(row.actor_type).padEnd(10)} : ${String(row.c)} 条`)
}

console.log('\n=== 校验：前 6 条（按序号）===')
for (const row of rowsOf(
  await db.execute(
    sql`select sequence, actor_type, content from conversation_events
        where character_id = ${kernel.characterId} order by sequence asc limit 6`,
  ),
)) {
  const who = String(row.actor_type) === 'user' ? userName : character.name
  console.log(
    `  #${String(row.sequence).padStart(3)} ${who}: ${String(row.content).replace(/\n/g, ' / ').slice(0, 46)}`,
  )
}

console.log('\n=== 幂等验证：再跑一次不应产生新行 ===')
const plan2 = await planBackfill(db, options)
const result2 = await applyBackfill(db, options, plan2)
console.log(`  第二次：写入 ${result2.written}，幂等命中 ${result2.deduplicated}，账本 ${result2.before} → ${result2.after}`)
const idempotent = result2.written === 0 && result2.after === result.after
console.log(`  ${idempotent ? '✅ 幂等成立' : '❌ 幂等被破坏'}`)

void ChannelType
await runtime.stop()
process.exit(idempotent ? 0 : 1)
