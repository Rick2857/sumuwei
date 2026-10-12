/**
 * M7 WP6-B · Level 1 —— **关系状态播种器**（独立子进程；零模型调用）。
 *
 * 在空沙箱里把一个 Level 1 场景的目标关系状态**离线**铺出来：
 * ORIGIN 播种（与 main.ts 开机同一条实现 `seedRelationshipOrigin`）→
 * 按窗口注入事件（ConversationRecorder，归因与生产同形状）→
 * 每个窗口后跑一次真调度器（`maybeRunRelationshipEvaluation`）→
 * 读回终态写入 JSON。
 *
 * ⚠️ 全程走**放行链本尊**（提案 → Validator → applyAcceptedEvents），
 * 不直接改投影——投影是派生的（不变量②），直改 = 造假读数。
 *
 * 用法：tsx scripts/m7-level1-seed.ts --db-dir <沙箱> --scenario L1-S2 --out <json> [--user-name Alex]
 */
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { isProductionDir, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** 冻结事件文本（与长轨迹同款——一个概念一处实现，逐字一致） */
const ACCUSATION_TEXT = '你骗了我，你明明答应过不告诉别人的。'
const RETRACTION_TEXT = '对不起，我错怪你了，是我自己记错了。'
const THANKS_TEXT = '谢谢你昨晚听我说那些烦心事，今天感觉好多了。'

/** S4 的"久未互动"：R-2 落在 10 天前 ⇒ 读时侵蚀 ≈ 9 天 × 0.02 = 0.18 */
const ABSENCE_DAYS = 10

type SeedStep = { readonly inject: string; readonly schedulerNow?: 'real' | 'absent' }

const SCENARIO_STEPS: Record<string, readonly SeedStep[]> = {
  'L1-S1': [], // 基线：不播种——探针轮开机自播 ORIGIN（生产形状）
  'L1-S2': [
    { inject: ACCUSATION_TEXT },
    { inject: ACCUSATION_TEXT },
    { inject: ACCUSATION_TEXT },
  ],
  'L1-S3': [
    { inject: ACCUSATION_TEXT },
    { inject: RETRACTION_TEXT },
    { inject: ACCUSATION_TEXT },
    { inject: RETRACTION_TEXT },
    { inject: ACCUSATION_TEXT },
    { inject: RETRACTION_TEXT },
  ],
  'L1-S4': [{ inject: THANKS_TEXT, schedulerNow: 'absent' }],
}

async function seed(): Promise<void> {
  const dbDir = argValue('--db-dir')
  const scenario = argValue('--scenario')
  const out = argValue('--out')
  const userName = argValue('--user-name') ?? 'Alex'
  if (dbDir === undefined || scenario === undefined || out === undefined) {
    console.error('用法：tsx scripts/m7-level1-seed.ts --db-dir <沙箱> --scenario <L1-Sx> --out <json> [--user-name Alex]')
    process.exit(2)
  }
  const steps = SCENARIO_STEPS[scenario]
  if (steps === undefined) {
    console.error(`未知场景：${scenario}（已知 ${Object.keys(SCENARIO_STEPS).join('/')}）`)
    process.exit(3)
  }
  const resolved = resolve(dbDir)
  if (!existsSync(resolved)) {
    console.error(`沙箱目录不存在：${resolved}`)
    process.exit(3)
  }
  if (isProductionDir(resolved) || resolved === resolve(PRODUCTION_DB_DIR)) {
    console.error('拒绝：该路径被判成生产库')
    process.exit(3)
  }
  process.env.PGLITE_DATA_DIR = resolved
  process.env.PROJECT_LG_SANDBOX = resolved

  const { AgentRuntime, stringToUuid } = await import('@elizaos/core')
  const sqlPlugin = (await import('@elizaos/plugin-sql')).default
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb } = await import('../src/infrastructure/persistence/db.ts')
  const { asCharacterId, asConversationId } = await import('../src/kernel/contracts/ids.ts')
  const { ConversationRecorder } = await import('../src/infrastructure/runtime/conversation-recorder.ts')
  const {
    createCharacterAssistantTurnIngress,
    createHumanConsoleUserTurnIngress,
  } = await import('../src/infrastructure/runtime/conversation-attribution.ts')
  const { latestConversationSequence } = await import('../src/infrastructure/persistence/conversation-store.ts')
  const { seedRelationshipOrigin } = await import('../src/infrastructure/runtime/adapters.ts')
  const { maybeRunRelationshipEvaluation, relationshipOwnerOf } = await import(
    '../src/infrastructure/runtime/relationship-scheduler.ts'
  )
  const { getRelationshipProjection } = await import('../src/infrastructure/persistence/relationship-store.ts')
  const { entityRef } = await import('../src/kernel/contracts/entity.ts')

  const characterId = asCharacterId(character.id ?? character.name)
  const userId = stringToUuid(`user-${userName}`)

  const runtime = new AgentRuntime({
    character: character as never,
    plugins: [sqlPlugin],
    conversationLength: 16,
    settings: { OPENAI_API_KEY: 'placeholder', OPENAI_BASE_URL: '' },
  } as never)
  await initDatabase(runtime, sqlPlugin)
  const db = getRawDb(runtime)

  /* S1 不播种（探针轮开机自播）；其余场景先铺 ORIGIN（放行链本尊） */
  const originOutcome = steps.length === 0 ? undefined : await seedRelationshipOrigin(runtime, String(characterId), userId)
  if (steps.length > 0 && originOutcome !== undefined && !originOutcome.seeded) {
    throw new Error(`ORIGIN 播种未成功：${originOutcome.reason}（空沙箱上不应发生）`)
  }

  const conversationId = asConversationId(`level1-${scenario}`)
  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId,
    dryRun: false,
    userName,
    characterName: character.name,
    transport: 'm7-level1-seed',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    userId,
    userRef: userName,
  })

  /* 会话内序号必须连续（assertSequenceContiguous）：只写 user 事件 ⇒ 逐条 +1。
     （角色级序号的"预留助手号"空洞是允许的——那是 allocateSequenceRange 的事。） */
  let conversationSequence = (await latestConversationSequence(db, characterId, conversationId)) + 1
  const schedulerOutcomes: string[] = []
  for (const step of steps) {
    const outcome = await recorder.recordUserMessage(step.inject, conversationSequence)
    if (outcome.event === undefined) throw new Error(`注入失败：${step.inject.slice(0, 20)}…`)
    conversationSequence += 1
    const now = step.schedulerNow === 'absent' ? Date.now() - ABSENCE_DAYS * 24 * 60 * 60 * 1000 : Date.now()
    const scheduling = await maybeRunRelationshipEvaluation(db, {
      characterId,
      owner: relationshipOwnerOf(characterId),
      now,
    })
    schedulerOutcomes.push(`${scheduling.kind}`)
    if (scheduling.kind === 'held' || scheduling.kind === 'failed') {
      throw new Error(`窗口调度未消费（${scheduling.kind}）——播种中断，状态不达`)
    }
  }

  const projection = await getRelationshipProjection(db, characterId, entityRef('user', userId))
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        ok: true,
        scenario,
        steps: steps.length,
        schedulerOutcomes,
        projection:
          projection === undefined
            ? null
            : {
                trust: projection.state.trust,
                closeness: projection.state.closeness,
                revision: projection.revision,
                accusationsInCase: projection.state.accusationsInCase.length,
                lastInteractionAt: projection.state.lastInteractionAt,
              },
        readAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  console.log(`  播种完成：${scenario} · ${String(steps.length)} 步 · 调度 ${schedulerOutcomes.join('→')}`)
}

await seed()
