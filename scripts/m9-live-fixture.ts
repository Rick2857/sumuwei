/**
 * M9 WP9 —— **L14 夹具步**（零模型；被 m9-live-level1.ts spawn）。
 *
 * 在**副本**上追加 3 条受验证测试 ingress 的用户对话事件（2 条夹具会话），
 * 让下一进程的 open-catchup 由**生产评估器**真实形成 B-INFERRED
 * （3 根 × 2 会话，阈值齐）。与 e2e 同款 console ingress 归因——
 * 计划允许「受验证的测试 ingress」；本脚本不直接写信念（不越过评估器）。
 *
 * 纪律：只开隔离/副本库（双闸；生产路径拒绝）；事件正文来自冻结语料
 * （CORPUS_FIXTURE），本脚本不自造文本。
 *
 * 用法：tsx scripts/m9-live-fixture.ts --db-dir <副本>
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { isProductionDir, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { CORPUS_FIXTURE } from './m9-live-corpus.ts'

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const dbDir = argValue('--db-dir')
  if (dbDir === undefined) {
    console.error('用法：tsx scripts/m9-live-fixture.ts --db-dir <副本>')
    process.exit(2)
  }
  const resolved = resolve(dbDir)
  if (!existsSync(resolved)) {
    console.error(`副本目录不存在：${resolved}`)
    process.exit(3)
  }
  if (isProductionDir(resolved) || resolved === resolve(PRODUCTION_DB_DIR)) {
    console.error('拒绝：该路径被判成生产库')
    process.exit(3)
  }

  /* 双闸必须在碰数据库之前设好 */
  process.env.PGLITE_DATA_DIR = resolved
  process.env.PROJECT_LG_SANDBOX = resolved

  const { AgentRuntime } = await import('@elizaos/core')
  const sqlPlugin = (await import('@elizaos/plugin-sql')).default
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb } = await import('../src/infrastructure/persistence/db.ts')
  const { asCharacterId, asConversationId } = await import('../src/kernel/contracts/ids.ts')
  const { appendConversationEvent } = await import(
    '../src/infrastructure/persistence/conversation-store.ts'
  )
  const { createHumanConsoleUserTurnIngress } = await import(
    '../src/infrastructure/runtime/conversation-attribution.ts'
  )
  const { resolveIds } = await import('../src/main.ts')

  const characterId = asCharacterId(character.id ?? character.name)
  const userName = process.env.USER_NAME ?? 'Alex'
  const { userId } = resolveIds(userName)
  const ingress = createHumanConsoleUserTurnIngress()

  const runtime = new AgentRuntime({
    character: character as never,
    plugins: [sqlPlugin],
    conversationLength: 16,
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'placeholder',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
    },
  } as never)
  await initDatabase(runtime, sqlPlugin)
  const db = getRawDb(runtime)

  /* 每条夹具会话自己的序号计数 */
  const counters = new Map<string, number>()
  let now = Date.now()
  for (const event of CORPUS_FIXTURE.events) {
    const seq = (counters.get(event.conversation) ?? 0) + 1
    counters.set(event.conversation, seq)
    now += 500
    const { event: appended } = await appendConversationEvent(db, {
      characterId,
      conversationId: asConversationId(event.conversation),
      conversationSequence: seq,
      type: 'user_message',
      actorType: 'user',
      actorId: userId,
      content: event.text,
      createdAt: now,
      trustedAttribution: ingress.attest({
        characterId: String(characterId),
        presenterActorId: userId,
        userId,
      }),
    })
    console.log(`  夹具事件 ${event.conversation}#${String(seq)} → 序号 ${String(appended.sequence)}：「${event.text}」`)
  }
  console.log(`夹具追加完成：${String(CORPUS_FIXTURE.events.length)} 条 / ${String(CORPUS_FIXTURE.conversations.length)} 会话`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
