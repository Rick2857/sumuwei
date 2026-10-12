/**
 * M9 WP0-R —— **L-M8-13 修复验证**（`pnpm m9:wp0r:verify`）。
 *
 * ============================================================================
 *  要测的命题
 * ============================================================================
 * 准入实验（m9:wp0:admission 的 E1/E2）在基线时刻复现了 M7 关系评估器的
 * 双缺陷；本门验证修复后的**期望行为**——同一批场景、相反的期望：
 *
 *   R1  tool 事件进窗口 ⇒ 不再抛错穿透：调度器完整返回，job 级读数
 *       `skippedToolEvents` 如实计数（跳过是可审计读数，不是静默丢弃）。
 *   R2  消费段失败（域事件写被注入拦下）⇒ job 行**如实落 failed**（旧形状
 *       楔在 running）⇒ 同窗重试：failed 幂等键允许重建 ⇒ 恢复恰一次应用。
 *   R3  试算期失败（窗口读被注入拦下）⇒ **不抛**（旧形状穿透）⇒ 无 job 行
 *       ⇒ 去掉注入后同窗恢复。
 *   R4  finishJob('failed') 自身失败（库已坏形状）⇒ 主错误不被掩盖
 *       （报告的是评估失败，不是记录失败）；任务行留原状 = 已文档化边界。
 *   R5  completed 之后 advanceWatermark 失败 ⇒ catch 把行翻成 failed ⇒
 *       同窗重试：提案全部幂等命中 ⇒ 新建=0（零重复）⇒ 水位补推进。
 *   R6  **攒尾窗策略原样保留**（这是 M7 的设计，不是缺陷）：零提案窗口
 *       持有（held）不消费；语义命中后连同持有事件一次消费。
 *
 * 对照关系：E1b ↔ R1 · E2b/E2c ↔ R2 · （旧形状无对应）↔ R3/R4/R5 ·
 * 策略面 ↔ R6。修复不得改变 M7 的 hold-to-accumulate（与 M8 的
 * "每窗必消费"不同——那是 Affect 的策略，不是这里的）。
 *
 * ============================================================================
 *  硬边界
 * ============================================================================
 *  · `isolateDatabase()` 一次性沙箱；真实库从不被打开。
 *  · 失败注入 = 有界 SQL 文本标记拦截（m8-e2e 的 withFailing 同款），
 *    只拦匹配语句，其余照旧，事务一并包装。
 *  · 全部走**真实生产函数**（maybeRunRelationshipEvaluation /
 *    runRelationshipEvaluation / seedRelationshipOrigin / 真账本 ingress）。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m9-wp0r-verify', { keep: false })

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { seedRelationshipOrigin } from '../src/infrastructure/runtime/adapters.ts'
import {
  createRelationshipJobPorts,
  maybeRunRelationshipEvaluation,
  relationshipOwnerOf,
} from '../src/infrastructure/runtime/relationship-scheduler.ts'
import {
  relationshipEvaluationIdempotencyKey,
  runRelationshipEvaluation,
} from '../src/kernel/app/relationship/job.ts'
import {
  RELATIONSHIP_EVALUATOR_NAME,
  RELATIONSHIP_EVALUATOR_VERSION,
} from '../src/kernel/app/relationship/evaluator.ts'
import { createConversationLedger } from '../src/infrastructure/persistence/ledger.ts'
import { countDomainEvents } from '../src/infrastructure/persistence/event-store.ts'
import {
  findJobByIdempotencyKey,
  finishJob,
  getWatermark,
} from '../src/infrastructure/persistence/job-store.ts'
import { latestCharacterEventSequence } from '../src/infrastructure/persistence/conversation-store.ts'
import { asConversationId } from '../src/kernel/contracts/index.ts'
import type { RawDb } from '../src/infrastructure/persistence/db.ts'
import { createM9RunId, openM9RunDir, writeM9Manifest } from './m9-evidence.ts'

const REPO_ROOT = resolve(process.cwd())

// ---------------------------------------------------------------------------
// 检查条目
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
function record(id: string, label: string, expected: string, actual: string, pass: boolean): void {
  checks.push({ id, label, expected, actual, pass })
}

// ---------------------------------------------------------------------------
// 有界失败注入（m8-e2e 同款）
// ---------------------------------------------------------------------------

function sqlTextOf(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      if (chunk !== null && typeof chunk === 'object' && 'value' in chunk) {
        const value = (chunk as { value: unknown }).value
        if (typeof value === 'string') return value
        if (Array.isArray(value)) {
          return value.filter((v): v is string => typeof v === 'string').join('')
        }
      }
      return ''
    })
    .join('\n')
}

/** 有界失败注入：只拦匹配 `marker` 的语句，其余照旧（事务一并包装） */
function withFailing(real: RawDb, marker: RegExp, tag: string): RawDb {
  const guard = (handle: RawDb): RawDb => ({
    execute: async (query: unknown) => {
      if (marker.test(sqlTextOf(query))) {
        throw new Error(`m9-wp0r-injected-${tag}`)
      }
      return handle.execute(query)
    },
  })
  return {
    ...guard(real),
    ...(real.transaction !== undefined
      ? {
          transaction: <T>(fn: (tx: RawDb) => Promise<T>) =>
            real.transaction!((tx) => fn(guard(tx))),
        }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db
  const characterId = kernel.characterId
  const USER = 'm9-wp0r-user'

  // 与生产 open 路径同形：先建档（IMPACT 放行的前提——validator ⑤b）
  const seeded = await seedRelationshipOrigin(runtime, characterId, USER)
  if (!seeded.seeded && seeded.reason !== 'already') {
    throw new Error(`关系建档失败：${seeded.reason}`)
  }

  const ledger = createConversationLedger({
    db,
    attribution: [createHumanConsoleUserTurnIngress()],
  })
  const conversationId = asConversationId('m9-wp0r-verify')

  const T0 = Date.UTC(2026, 8, 27, 8, 0, 0)
  let now = T0
  const tick = (ms = 1000): number => {
    now += ms
    return now
  }
  let seq = 0
  const seedUser = async (content: string): Promise<void> => {
    seq += 1
    await ledger.appendUserStatement({
      characterId,
      conversationId,
      conversationSequence: seq,
      userId: USER,
      content,
      createdAt: tick(),
    })
  }
  const seedTool = async (content: string): Promise<void> => {
    seq += 1
    await ledger.appendToolEvent({
      characterId,
      conversationId,
      conversationSequence: seq,
      toolName: 'web-search',
      content,
      createdAt: tick(),
    })
  }

  const sched = (d: RawDb, at?: number) =>
    maybeRunRelationshipEvaluation(d, {
      characterId,
      owner: relationshipOwnerOf(characterId),
      now: at ?? tick(),
    })
  const watermarkNow = async (): Promise<number> =>
    (await getWatermark(db, characterId, RELATIONSHIP_EVALUATOR_NAME, RELATIONSHIP_EVALUATOR_VERSION))
      ?.processedThroughSequence ?? 0

  // =========================================================================
  // R1：tool 事件进窗口 ⇒ 不抛、不楔死；跳过数如实可读
  // =========================================================================
  {
    await seedUser('谢谢你最近一直陪我。') // R-2 命中（r2-thanks）
    await seedTool('搜索结果摘要：谢谢你……（外部内容）')
    // 播种后、调度前捕获窗口界（R1a 消费后水位前进；R1b 要重跑**同一窗**验跳过计数）
    const fromR1 = (await watermarkNow()) + 1
    const toR1 = await latestCharacterEventSequence(db, characterId)
    let threw = false
    let kind = '(未运行)'
    try {
      const outcome = await sched(db)
      kind = outcome.kind
    } catch (error) {
      threw = true
      kind = `throw: ${(error as Error).message}`
    }
    const wm = await watermarkNow()
    record(
      'R1a',
      'PRE-02(a) 修复：tool 事件进窗口，调度器完整返回（不抛、不穿透）',
      'kind ∈ {flushed, held}（对照：修前 E1b 抛 tool_event_not_extractable_in_m4 穿透）',
      `${kind} · 水位=${String(wm)}`,
      !threw && (kind === 'flushed' || kind === 'held'),
    )

    // job 级读数：重跑**同一窗**（幂等去重，但 skippedToolEvents 如实计数窗口内的 tool 事件）
    const ports = createRelationshipJobPorts(db)
    const jobOutcome = await runRelationshipEvaluation(ports, {
      characterId,
      owner: relationshipOwnerOf(characterId),
      fromSequence: fromR1,
      toSequence: toR1,
      now: tick(),
    })
    record(
      'R1b',
      'job 级 skippedToolEvents 读数：窗口内 1 条 tool 事件被跳过且如实计数',
      'skippedToolEvents === 1',
      `skippedToolEvents=${String(jobOutcome.skippedToolEvents)} · proposals=${String(jobOutcome.proposals)}`,
      jobOutcome.skippedToolEvents === 1,
    )
  }

  // =========================================================================
  // R2：消费段失败 ⇒ job 行如实落 failed ⇒ 同窗重试恢复恰一次
  // =========================================================================
  {
    await seedUser('多亏有你帮我理清了思路。') // R-2 命中（r2-merit）
    const domainBefore = await countDomainEvents(db, characterId)
    const wmBefore = await watermarkNow()
    const failed = await sched(
      withFailing(db, /insert\s+into\s+character_domain_events/, 'eval-write')
    )
    // 找到本窗的 job 行（按幂等键）
    const key = relationshipEvaluationIdempotencyKey({
      characterId,
      processor: RELATIONSHIP_EVALUATOR_NAME,
      processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
      sourceFromSequence: wmBefore + 1,
      sourceToSequence: await latestCharacterEventSequence(db, characterId),
    })
    const jobRow = await findJobByIdempotencyKey(db, key)
    const wmAfterFailure = await watermarkNow()
    // 恢复：去掉注入 ⇒ 同窗重试（failed 键允许重建）
    const recovered = await sched(db)
    const domainAfterRecovery = await countDomainEvents(db, characterId)
    const wmAfterRecovery = await watermarkNow()
    record(
      'R2',
      "PRE-02(b) 修复：消费段失败 ⇒ job 行落 failed（旧形状楔 running）⇒ 同窗重试恢复恰一次",
      "failed · 行=failed · 恢复 flushed 新建=1 · 零重复 · 水位前进",
      `${failed.kind}${failed.kind === 'failed' ? `（${failed.error.slice(0, 36)}）` : ''} · 行=${jobRow?.status ?? '(无)'} · 水位 ${String(wmBefore)}→${String(wmAfterFailure)}→${String(wmAfterRecovery)} · 域事件 ${String(domainBefore)}→${String(domainAfterRecovery)} · 恢复=${recovered.kind}${recovered.kind === 'flushed' ? `（新建=${String(recovered.createdEvents)}）` : ''}`,
      failed.kind === 'failed' &&
        failed.error.includes('m9-wp0r-injected-eval-write') &&
        jobRow?.status === 'failed' &&
        wmAfterFailure === wmBefore &&
        recovered.kind === 'flushed' &&
        recovered.createdEvents === 1 &&
        domainAfterRecovery - domainBefore === 1 &&
        wmAfterRecovery > wmBefore,
    )
  }

  // =========================================================================
  // R3：试算期失败 ⇒ 不抛、无 job 行 ⇒ 去注入后同窗恢复
  // =========================================================================
  {
    await seedUser('有你真好，最近顺心多了。') // R-2 命中（r2-lucky）
    const wmBefore = await watermarkNow()
    let threw = false
    let kind = '(未运行)'
    let errText = ''
    try {
      const outcome = await sched(
        withFailing(db, /from conversation_events[\s\S]*sequence >= /, 'window-load')
      )
      kind = outcome.kind
      if (outcome.kind === 'failed') errText = outcome.error
    } catch (error) {
      threw = true
      kind = `throw: ${(error as Error).message}`
    }
    const key = relationshipEvaluationIdempotencyKey({
      characterId,
      processor: RELATIONSHIP_EVALUATOR_NAME,
      processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
      sourceFromSequence: wmBefore + 1,
      sourceToSequence: await latestCharacterEventSequence(db, characterId),
    })
    const jobRow = await findJobByIdempotencyKey(db, key)
    const recovered = await sched(db)
    record(
      'R3',
      '试算期失败（dry-run 在 try 内）：不抛 ⇒ kind=failed ⇒ 无 job 行 ⇒ 去注入后同窗恢复',
      '不抛 · failed · 无 job 行 · 恢复 flushed（对照：修前 dry-run 在 try 外，异常穿透）',
      `${threw ? '抛了' : kind}${errText !== '' ? `（${errText.slice(0, 36)}）` : ''} · job行=${jobRow === undefined ? '无' : jobRow.status} · 恢复=${recovered.kind}`,
      !threw &&
        kind === 'failed' &&
        errText.includes('m9-wp0r-injected-window-load') &&
        jobRow === undefined &&
        recovered.kind === 'flushed',
    )
  }

  // =========================================================================
  // R4：finishJob('failed') 自身失败 ⇒ 主错误不被掩盖；行留原状（文档化边界）
  // =========================================================================
  {
    await seedUser('辛苦了，改得好快。') // R-2 命中（r2-effort）
    const wmBefore = await watermarkNow()
    // 双注入：评估写失败（主错误）+ finishJob 语句失败（记录失败）。
    // finishJob 的结构特征 = update character_jobs + finished_at（markJobRunning
    // 是 started_at、enqueueJob 是 insert——三者可区分；参数值不进 SQL 文本，
    // 首轮量具按 /set status = failed/ 匹配参数渲染 ⇒ 未触发，校准为结构标记）。
    const injected = withFailing(
      withFailing(db, /insert\s+into\s+character_domain_events/, 'eval-write'),
      /update\s+character_jobs[\s\S]*finished_at/,
      'finish-failed',
    )
    const failed = await sched(injected)
    const key = relationshipEvaluationIdempotencyKey({
      characterId,
      processor: RELATIONSHIP_EVALUATOR_NAME,
      processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
      sourceFromSequence: wmBefore + 1,
      sourceToSequence: await latestCharacterEventSequence(db, characterId),
    })
    const jobRow = await findJobByIdempotencyKey(db, key)
    record(
      'R4',
      "finishJob('failed') 自身失败（库已坏形状）：主错误如实上报（不被记录失败掩盖）· 行留原状 = 文档化边界",
      "failed · 错误=eval-write（非 finish-failed）· 行=running（留原状）",
      `${failed.kind}${failed.kind === 'failed' ? `（错误=${failed.error.slice(0, 36)}）` : ''} · 行=${jobRow?.status ?? '(无)'}`,
      failed.kind === 'failed' &&
        failed.error.includes('m9-wp0r-injected-eval-write') &&
        !failed.error.includes('finish-failed') &&
        jobRow?.status === 'running',
    )
    // R4 收尾：把楔住的行手工翻成 failed（模拟运维自愈），再去注入恢复——
    // 证明"行留原状"不是死局：failed 后同窗重试照常走通。
    if (jobRow !== undefined) {
      await finishJob(db, jobRow.id, 'failed', { error: 'r4-manual-heal', now: tick() })
    }
    const recoveredR4 = await sched(db)
    record(
      'R4b',
      'R4 边界的出口：行转 failed 后，同窗重试照常恢复（"留原状"不是死局）',
      '恢复 flushed 新建=1',
      `恢复=${recoveredR4.kind}${recoveredR4.kind === 'flushed' ? `（新建=${String(recoveredR4.createdEvents)}）` : ''}`,
      recoveredR4.kind === 'flushed' && recoveredR4.createdEvents === 1,
    )
  }

  // =========================================================================
  // R5：completed 之后 advanceWatermark 失败 ⇒ 行翻 failed ⇒ 恢复零重复
  // =========================================================================
  {
    await seedUser('我相信你能处理好这件事。') // R-2 命中（r2-trust）
    const domainBefore = await countDomainEvents(db, characterId)
    const wmBefore = await watermarkNow()
    const failed = await sched(
      withFailing(db, /insert\s+into\s+processor_watermarks/, 'watermark-write')
    )
    const key = relationshipEvaluationIdempotencyKey({
      characterId,
      processor: RELATIONSHIP_EVALUATOR_NAME,
      processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
      sourceFromSequence: wmBefore + 1,
      sourceToSequence: await latestCharacterEventSequence(db, characterId),
    })
    const jobRow = await findJobByIdempotencyKey(db, key)
    const domainAfterFailure = await countDomainEvents(db, characterId)
    const wmAfterFailure = await watermarkNow()
    // 恢复：同窗重试——提案幂等键全部命中（processed_operations 已随成功的事务落盘）
    const recovered = await sched(db)
    const domainAfterRecovery = await countDomainEvents(db, characterId)
    const wmAfterRecovery = await watermarkNow()
    record(
      'R5',
      'completed 后水位写失败 ⇒ catch 把行翻 failed ⇒ 同窗重试零重复（新建=0）⇒ 水位补推进',
      'failed · 行=failed · 域事件已落且恢复零新增 · 恢复 flushed 新建=0 · 水位前进',
      `${failed.kind}${failed.kind === 'failed' ? `（${failed.error.slice(0, 36)}）` : ''} · 行=${jobRow?.status ?? '(无)'} · 域事件 ${String(domainBefore)}→${String(domainAfterFailure)}→${String(domainAfterRecovery)} · 水位 ${String(wmBefore)}→${String(wmAfterFailure)}→${String(wmAfterRecovery)} · 恢复=${recovered.kind}${recovered.kind === 'flushed' ? `（新建=${String(recovered.createdEvents)}）` : ''}`,
      failed.kind === 'failed' &&
        failed.error.includes('m9-wp0r-injected-watermark-write') &&
        jobRow?.status === 'failed' &&
        domainAfterFailure - domainBefore === 1 &&
        wmAfterFailure === wmBefore &&
        recovered.kind === 'flushed' &&
        recovered.createdEvents === 0 &&
        domainAfterRecovery === domainAfterFailure &&
        wmAfterRecovery > wmBefore,
    )
  }

  // =========================================================================
  // R6：攒尾窗策略原样保留（M7 的设计，不是缺陷）
  // =========================================================================
  {
    await seedUser('今天天气不错。') // 无规则命中 ⇒ 零提案
    const wmBefore = await watermarkNow()
    const held = await sched(db)
    const wmHeld = await watermarkNow()
    await seedUser('谢谢你听我说这些。') // R-2 命中 ⇒ 连同持有事件一次消费
    const flushed = await sched(db)
    const wmFlushed = await watermarkNow()
    record(
      'R6',
      '攒尾窗保持：零提案窗口持有（held 不消费、水位不动）；语义命中后连同持有事件一次消费',
      'held → flushed · 持有时水位不动 · 消费时前进',
      `${held.kind}${held.kind === 'held' ? `（尾窗=${String(held.tailEvents)}）` : ''} → ${flushed.kind}${flushed.kind === 'flushed' ? `（新建=${String(flushed.createdEvents)}）` : ''} · 水位 ${String(wmBefore)}→${String(wmHeld)}→${String(wmFlushed)}`,
      held.kind === 'held' &&
        wmHeld === wmBefore &&
        flushed.kind === 'flushed' &&
        wmFlushed > wmHeld,
    )
  }

  // =========================================================================
  // 证据落盘
  // =========================================================================
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM9RunId({ wpId: 'wp0r-verify', headShort: head })
  const dir = openM9RunDir(REPO_ROOT, runId)
  const passed = checks.filter((c) => c.pass).length
  const failedCount = checks.length - passed
  const payload = {
    schema: 'm9-wp0r-verify@1',
    runId,
    head,
    checks,
    summary: {
      total: checks.length,
      passed,
      failed: failedCount,
      verdict: failedCount === 0 ? 'WP0-R FIX VERIFIED' : 'WP0-R FIX NOT VERIFIED',
    },
  }
  writeFileSync(join(dir, 'wp0r-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM9Manifest(dir, {
    runId,
    wp: 'wp0r',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'fix-verify',
    counts: { total: checks.length, passed, failed: failedCount },
    phases: ['single'],
    supersedes: null,
    notes: 'L-M8-13 修复验证：R1-R5 = 准入 E1/E2 的修复后期望；R6 = 攒尾窗策略保持',
    databaseScope: 'isolated',
    mode: 'offline',
  })
  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
    console.log(`      期望 ${c.expected}`)
    console.log(`      实测 ${c.actual}`)
  }
  console.log(`verdict: ${payload.summary.verdict}（${passed}/${checks.length}）`)
  process.exitCode = failedCount === 0 ? 0 : 1
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
