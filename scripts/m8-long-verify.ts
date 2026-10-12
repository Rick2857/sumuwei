/**
 * M8 WP7 —— **1×500 长轨迹门**（`pnpm m8:long:verify`）：稳定性 / 可重放证据。
 *
 * 跑 `m8-long-trajectory.ts` 生成的冻结轨迹（m8-long-corpus@1），隔离库 +
 * 真 TurnGateway + 真调度器 + 真放行链。断言面（计划 §11.5 逐条）：
 *
 *   ① 中性/正向/负向/恢复/长间隔都出现且行为正确（长间隔 = 读时衰减，
 *      canonical 不写回，域事件零增长）；
 *   ② 重复消息（同文本多处出现）+ 重启探针（再调度 no_tail、revision 不动）；
 *   ③ 边界附近 delta：敌意块**真的碰到** v=−1.0 / a=1.0 夹紧（不是附近看看）；
 *   ④ 每轮最多一个 impact（主导规则族去重；全程 impactProposals ≤ 1）；
 *   ⑤ projection rebuild === 在线投影（`rebuildAffectProjection` 逐字段一致——
 *      "投影是缓存"的可执行证明，SC-005 / 不变量②）；
 *   ⑥ −1 ≤ v ≤ 1、0 ≤ a ≤ 1 全程成立（每轮检查）；
 *   ⑦ 失败注入后的 retry 不重复（注入轮零落库；恢复恰一次；域事件总数
 *      === 各窗 createdEvents 之和——无重复无丢失）；
 *   ⑧ M7 relationship 保有自身投影与规则（独立 revision；Affect 事件不混入）。
 *
 * ⚠️ 开跑闸：`checkM8TrajectoryInvariants` 不过 ⇒ MEASUREMENT INVALID，
 * 一轮都不跑（量具有效性先于读数——INV-M45-06）。
 * 长轨迹是稳定性/可重放证据，不是"情绪智能"的主观证明（计划 §11.5）。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8-long-verify', { keep: false })

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  maybeRunAffectEvaluation,
  seedAffectOrigin,
} from '../src/infrastructure/runtime/affect-scheduler.ts'
import {
  renderAffectSection,
  renderCriticalStateSection,
  renderRelationshipSection,
  seedRelationshipOrigin,
} from '../src/infrastructure/runtime/adapters.ts'
import {
  getAffectProjection,
  rebuildAffectProjection,
} from '../src/infrastructure/persistence/affect-store.ts'
import { getRelationshipProjection } from '../src/infrastructure/persistence/relationship-store.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { effectiveAffect } from '../src/kernel/contracts/affect.ts'
import { SECTION_IDS } from '../src/kernel/context/sections.ts'
import { asConversationId } from '../src/kernel/contracts/index.ts'
import type { RawDb } from '../src/infrastructure/persistence/db.ts'
import { createM8RunId, openM8RunDir, writeM8Manifest } from './m8-evidence.ts'
import {
  buildM8Trajectory,
  checkM8TrajectoryInvariants,
  M8_LONG_CORPUS_VERSION,
  type M8TurnScript,
} from './m8-long-trajectory.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

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
const near = (a: number, b: number, tolerance = 1e-3): boolean => Math.abs(a - b) < tolerance

/** drizzle SQL 文本提取（WP6 的教训：StringChunk.value 是 string[]） */
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

/** 有界失败注入：只拦 domain event 写入（含事务内） */
function withFailingDomainEventWrites(real: RawDb): RawDb {
  const guard = (handle: RawDb): RawDb => ({
    execute: async (query: unknown) => {
      if (/insert\s+into\s+character_domain_events/.test(sqlTextOf(query))) {
        throw new Error('m8-long-injected-store-failure')
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
  // ---- 开跑闸：语料不变量先于一切读数 ----
  const { turns } = buildM8Trajectory()
  const invariants = checkM8TrajectoryInvariants(turns)
  if (!invariants.ok) {
    console.error(`MEASUREMENT INVALID：长轨迹语料不变量破损——`)
    for (const problem of invariants.problems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log(`语料指纹 ${invariants.fingerprint}（${M8_LONG_CORPUS_VERSION}）——开跑闸通过`)

  const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db
  const characterId = kernel.characterId
  const USER = 'm8-long-user'
  const conversationId = asConversationId('m8-long-gateway-conv')

  const T0 = Date.UTC(2026, 8, 28, 4, 0, 0)
  let now = T0

  // ---- 建档（Affect cutover=0 + Relationship 基线——⑧ 的并存前提）----
  await seedAffectOrigin(db, { characterId, activationId: 'm8-long-act-1', now: T0 })
  await seedRelationshipOrigin(runtime, String(characterId), USER, T0)

  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId,
    dryRun: false,
    userName: USER,
    characterName: character.name,
    transport: 'm8-long-verify',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    userId: USER,
    userRef: USER,
  })
  let gatewaySeq = 1
  const gateway = new TurnGateway({
    kernel,
    definition: kernel.definition,
    identity: kernel.identitySnapshot,
    recorder,
    conversationSequence: () => gatewaySeq,
    recentLimit: 16,
    slowPathEnabled: false,
    dryRun: false,
    userId: USER,
  })

  // ---- 全程跟踪量 ----
  let expectedCreatedTotal = 0 // 各窗 createdEvents 之和（⑦ 的对账面）
  let maxImpactPerEval = 0 // ④
  let boundsViolations = 0 // ⑥
  let vMin = 0
  let vMax = 0
  let aMin = 0
  let aMax = 0
  let clampHitValence = false // ③：v 真的到过 −1（或 +1）
  let clampHitArousal = false // ③：a 真的到过 1
  let restartProbesOk = 0 // ②
  let gapDecayOk = 0 // ①
  const checkpointSnapshots: Record<string, unknown>[] = []
  let failureInjected: string | undefined
  let failureRecoveredCreated = 0

  const evalNow = (activeDb: RawDb = db) =>
    maybeRunAffectEvaluation(activeDb, { characterId, activeUserId: USER, now })

  for (const turn of turns) {
    now += turn.timeJumpMs + 2_000

    // ② 重启探针：再调度 ⇒ no_tail 且 revision 不动（状态从盘上读，不漂移）
    if (turn.kind === 'restart_probe') {
      const before = await getAffectProjection(db, characterId)
      const probe = await evalNow()
      const after = await getAffectProjection(db, characterId)
      if (
        probe.kind === 'no_tail' &&
        before?.revision === after?.revision &&
        near(before?.state.valence ?? 0, after?.state.valence ?? 0, 1e-12)
      ) {
        restartProbesOk += 1
      }
    }

    // ① 长间隔：跳变后、本轮 impact 前，读时视图必须已衰减（canonical 不动）
    if (turn.kind === 'long_gap') {
      const projection = await getAffectProjection(db, characterId)
      if (projection !== undefined && projection.state.lastAffectEventAt !== null) {
        const canonicalV = projection.state.valence
        const effective = effectiveAffect(projection.state, now)
        // 12h = 3 个 valence 半衰期 ⇒ effective ≤ canonical × 0.125（容差放宽到 0.2）
        if (
          effective !== undefined &&
          effective.decayApplied &&
          Math.abs(effective.valence) <= Math.max(Math.abs(canonicalV) * 0.2, 0.01)
        ) {
          gapDecayOk += 1
        }
      } else {
        gapDecayOk += 1 // 无 impact 锚点也如实计数（首段 gap 前 v=0）
      }
    }

    const gatewayTurn = await gateway.beginTurn(turn.userText)
    gatewaySeq = gatewayTurn.conversationSequence + 2

    // ⑦ 失败注入位：同轮评估注入 store 写失败（零落库；恢复在轮后追赶）
    const isFailureTurn = turn.kind === 'failure_retry'
    const scheduling = isFailureTurn
      ? await evalNow(withFailingDomainEventWrites(db))
      : await evalNow()
    if (isFailureTurn) {
      failureInjected = scheduling.kind === 'failed' ? scheduling.error : `（意外：${scheduling.kind}）`
    }

    // 每轮：渲染 section（读时视图）+ 轴界检查（⑥）
    const applied = scheduling.kind === 'failed' ? false : true
    const section = await renderAffectSection(runtime, String(characterId), now, applied)
    if (section === undefined) {
      boundsViolations += 1 // 未建档或无有效状态 = 轨迹级缺陷
    }
    const projection = await getAffectProjection(db, characterId)
    if (projection !== undefined) {
      const { valence, arousal } = projection.state
      if (valence < -1 - 1e-9 || valence > 1 + 1e-9 || arousal < -1e-9 || arousal > 1 + 1e-9) {
        boundsViolations += 1
      }
      vMin = Math.min(vMin, valence)
      vMax = Math.max(vMax, valence)
      aMin = Math.min(aMin, arousal)
      aMax = Math.max(aMax, arousal)
      if (near(valence, -1, 1e-6) || near(valence, 1, 1e-6)) clampHitValence = true
      if (near(arousal, 1, 1e-6)) clampHitArousal = true
    }

    // ④ 每轮最多一个 impact
    if (scheduling.kind === 'flushed') {
      maxImpactPerEval = Math.max(maxImpactPerEval, scheduling.impactProposals)
      expectedCreatedTotal += scheduling.createdEvents
      if (isFailureTurn) failureRecoveredCreated = scheduling.createdEvents
    }

    // 检查点：真编译一轮（prompt 组装面在长轨迹上也有样本）+ 快照
    if (turn.checkpoint) {
      const packet = await gateway.compileTurn({
        turn: gatewayTurn,
        currentInput: turn.userText,
        recentLines: [],
        stateSection: await renderCriticalStateSection(runtime, String(characterId), USER),
        ...(section !== undefined ? { affectSection: section } : {}),
        clockEpochMs: now,
      })
      const affectInPacket = packet.sections.some((s) => s.id === SECTION_IDS.affect)
      if (!affectInPacket) boundsViolations += 1
      checkpointSnapshots.push({
        index: turn.index,
        kind: turn.kind,
        valence: projection?.state.valence,
        arousal: projection?.state.arousal,
        revision: projection?.revision,
        affectInPacket,
      })
    }

    await gateway.completeTurn({ turn: gatewayTurn, replyText: '嗯，我在听。' })

    // 轮后追赶：消费助手回复（assistant 永远不是情绪证据——0 提案）
    const post = await evalNow()
    if (post.kind === 'flushed') {
      maxImpactPerEval = Math.max(maxImpactPerEval, post.impactProposals)
      expectedCreatedTotal += post.createdEvents
      if (isFailureTurn) failureRecoveredCreated = post.createdEvents
    }
  }

  // ===========================================================================
  // 收口断言
  // ===========================================================================

  // ⑦ 域事件对账：AFFECT 事件总数 === 1（ORIGIN）+ 各窗 createdEvents 之和
  const affectEvents = (await domainEventsFor(db, characterId)).filter((e) =>
    String(e.type).startsWith('AFFECT_')
  )
  const touchCount = affectEvents.filter((e) => String(e.type) === 'AFFECT_TOUCH').length
  const impactCount = affectEvents.filter((e) => String(e.type) === 'AFFECT_IMPACT').length
  record(
    'L-COUNT',
    '失败注入后的 retry 不重复：注入轮零落库（failed）· 恢复恰一次（轮后追赶 created=2）· AFFECT 域事件总数 === ORIGIN(1) + 各窗 createdEvents 之和',
    `注入=failed · 恢复 created=2 · 事件数 1+${String(expectedCreatedTotal)}`,
    `注入=${String(failureInjected)} · 恢复 created=${String(failureRecoveredCreated)} · 实际 ORIGIN=${String(affectEvents.length - touchCount - impactCount)} TOUCH=${String(touchCount)} IMPACT=${String(impactCount)} 总=${String(affectEvents.length)} 对账=1+${String(expectedCreatedTotal)}`,
    failureInjected !== undefined &&
      failureInjected.includes('m8-long-injected-store-failure') &&
      failureRecoveredCreated === 2 &&
      affectEvents.length === 1 + expectedCreatedTotal
  )

  // ③④⑥ 边界 / 单 impact / 轴界
  record(
    'L-BOUNDS',
    '边界夹紧（v 真到 −1 · a 真到 1）· 每轮最多 1 impact · 全程 −1≤v≤1 且 0≤a≤1 · 检查点 packet 都有 affect 块',
    'clamp(v)=是 clamp(a)=是 · maxImpact≤1 · 越界=0',
    `v∈[${vMin.toFixed(3)},${vMax.toFixed(3)}] a∈[${aMin.toFixed(3)},${aMax.toFixed(3)}] · clamp(v)=${String(clampHitValence)} clamp(a)=${String(clampHitArousal)} · maxImpact=${String(maxImpactPerEval)} · 越界/缺块=${String(boundsViolations)}`,
    clampHitValence &&
      clampHitArousal &&
      maxImpactPerEval <= 1 &&
      boundsViolations === 0 &&
      vMin >= -1 - 1e-9 &&
      vMax <= 1 + 1e-9 &&
      aMin >= -1e-9 &&
      aMax <= 1 + 1e-9
  )

  // ⑤ rebuild === 在线（"投影是缓存"的可执行证明）
  const online = await getAffectProjection(db, characterId)
  const rebuild = await rebuildAffectProjection(db, characterId, now)
  const rebuilt = rebuild.projection
  const rebuildEqual =
    online !== undefined &&
    rebuilt.revision === online.revision &&
    near(rebuilt.state.valence, online.state.valence, 1e-12) &&
    near(rebuilt.state.arousal, online.state.arousal, 1e-12) &&
    rebuilt.state.cutoverSequence === online.state.cutoverSequence &&
    rebuilt.state.originated === online.state.originated &&
    String(rebuilt.lastDomainEventId ?? '') === String(online.lastDomainEventId ?? '')
  record(
    'L-REBUILD',
    'projection rebuild 与在线投影一致（删行重放逐字段一致——SC-005/不变量②；rebuild 折叠事件数 = 在线 revision）',
    'rebuild === online（v/a/cutover/originated/lastEventId/revision 全等）',
    `revision ${String(online?.revision)}→${String(rebuilt.revision)} · v ${String(online?.state.valence)}→${String(rebuilt.state.valence)} · a ${String(online?.state.arousal)}→${String(rebuilt.state.arousal)} · 相等=${String(rebuildEqual)} · 折叠事件=${String(rebuild.appliedEvents)}`,
    rebuildEqual && rebuild.appliedEvents === online?.revision
  )

  // ⑧ M7 relationship 保有自身投影
  const relationship = await getRelationshipProjection(db, characterId, {
    kind: 'user',
    id: USER,
  } as never)
  const relationshipSection = await renderRelationshipSection(
    runtime,
    String(characterId),
    USER,
    now
  )
  record(
    'L-M7',
    'M7 relationship 保有自身投影与规则：独立投影行（revision>0）· 关系 section 可渲染 · Affect 事件零混入（rebuild 已证 affect 只折叠 AFFECT_*）',
    'relationship 投影在 · section 在 · affect rebuild 纯净',
    `relationship revision=${String(relationship?.revision)} · section=${String(relationshipSection !== undefined)} · affect 事件=${String(affectEvents.length)}（全部 AFFECT_*）`,
    relationship !== undefined &&
      relationship.revision > 0 &&
      relationshipSection !== undefined &&
      affectEvents.every((e) => String(e.type).startsWith('AFFECT_'))
  )

  // ①② 长间隔衰减 / 重启探针 / 恢复方向
  const snapshotAt = (index: number): (typeof checkpointSnapshots)[number] | undefined =>
    checkpointSnapshots.find((s) => s.index === index)
  const at209 = snapshotAt(209)
  const at212 = snapshotAt(212)
  const recoveryDirection =
    at209 !== undefined && at212 !== undefined
      ? Number(at212.valence) > Number(at209.valence) + 0.2
      : false
  record(
    'L-ARC',
    '轨迹弧线：长间隔读时衰减（2/2 处）· 重启探针 no_tail 且不漂移（4/4）· 敌意块触底后修复块拉回（v(212) > v(209)+0.2）',
    'gap=2 · restart=4 · 恢复方向=是',
    `gap=${String(gapDecayOk)} · restart=${String(restartProbesOk)} · v(209)=${String(at209?.valence)} v(212)=${String(at212?.valence)} · 恢复=${String(recoveryDirection)}`,
    gapDecayOk === 2 && restartProbesOk === 4 && recoveryDirection
  )

  // ===========================================================================
  // 汇总 + 证据
  // ===========================================================================

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const stagesValid =
    affectEvents.length > 0 &&
    touchCount > 0 &&
    impactCount > 0 &&
    checkpointSnapshots.length > 0 &&
    clampHitValence
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const argOf = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag)
    return index >= 0 ? process.argv[index + 1] : undefined
  }
  const supersedes = argOf('--supersedes') ?? null
  const supersedesReason = argOf('--supersedes-reason')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  const runId = createM8RunId({ wpId: 'long-verify', headShort: head })
  const dir = openM8RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm8-long-verify@1',
    corpusVersion: M8_LONG_CORPUS_VERSION,
    corpusFingerprint: invariants.fingerprint,
    runId,
    capturedAt: new Date().toISOString(),
    head,
    branch: 'feature/m7-relationship',
    databaseKind: 'isolated (isolateDatabase m8-long-verify)',
    modelClassification: 'offline（无模型调用——回复正文为固定文本）',
    turns: turns.length,
    checkpoints: checkpointSnapshots,
    counts: {
      affectEvents: affectEvents.length,
      touch: touchCount,
      impact: impactCount,
      expectedCreatedTotal,
      vRange: [vMin, vMax],
      aRange: [aMin, aMax],
    },
    checks,
    verdict,
    ...(supersedes !== null ? { supersedes, supersedesReason: supersedesReason ?? '(未注明)' } : {}),
  }
  writeFileSync(join(dir, 'long-trajectory.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM8Manifest(dir, {
    runId,
    wp: 'long-verify',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'long-trajectory',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes,
    notes:
      supersedes !== null
        ? `M8 WP7 1×500 长轨迹（取代 ${supersedes}：${supersedesReason ?? '未注明'}）`
        : `M8 WP7 1×500 长轨迹（${M8_LONG_CORPUS_VERSION}，指纹 ${invariants.fingerprint}）：隔离库 + 真网关 + 边界夹紧 + rebuild 对账`,
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(
    `轨迹：${String(turns.length)} 轮 · TOUCH=${String(touchCount)} IMPACT=${String(impactCount)} · v∈[${vMin.toFixed(3)},${vMax.toFixed(3)}] a∈[${aMin.toFixed(3)},${aMax.toFixed(3)}]`
  )
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
