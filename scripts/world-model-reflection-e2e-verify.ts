/**
 * 三域应用方案 §4 —— **反思域比较材料的隔离整链**（阶段 3 的数据库面）。
 *
 * ============================================================================
 *  它测什么
 * ============================================================================
 * 在**隔离的、schema 完整的**库上跑真链：
 * ```text
 * 触发（目标结局） → 输入装配 → **比较材料装配** → 草案（离线 provider）
 *                → 严格校验 → 来源复核 → 采纳 → 槽位调整 → 实际入模
 * ```
 * 并带两条**负控**：来源被遗忘（遮蔽 ⇒ 比较整条作废）· 模型调用期间来源失效
 * （二次复核 ⇒ 不保存过期草案）。
 *
 * ============================================================================
 *  三条不许破的边界
 * ============================================================================
 * ① **比较不是证据**：它**不产生** handle / 根 / 触发 ⇒ 门槛读数与旧档**逐字相同**
 *    （根 3 · 会话 2 · 采纳 · 槽位 `enhanced`）。
 * ② 隔离 PostgreSQL：复用现有 test-harness，独立容器/卷/随机端口与测试身份。
 *    缺少 Docker 或镜像时失败关闭，没有 PGlite 回退。
 * ③ 零真实模型：离线 provider 只测机制，不测行为收益。
 */

import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { runPreparedPgGate, runPreparedPgGateInInstance } from './postgresql/test-harness.ts'

if (process.env.LG_WORLD_MODEL_PG_CHILD !== '1') {
  const attempt = resolve('artifacts/post-lv2/local/world-model-reflection-e2e', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(attempt, { recursive: true })
  writeFileSync(resolve(attempt, 'verification.json'), JSON.stringify({ status: 'RUNNING', backend: 'postgres' }) + '\n')
  process.env.LG_WORLD_MODEL_RUN_DIR = attempt
  process.env.LG_WORLD_MODEL_PG_CHILD = '1'
  /*
   * ⚠️ **仿真内没有 docker CLI** ⇒ 宿主模式那套"自己起一次性容器"用不了。
   *    ⇒ 仿真里改用**同一个专用隔离实例**（`LG_SIM_PGTEST_ADMIN_URL`），
   *      准备阶段逐条相同（显式迁移 + 身份核对 + `lg_test_` 前缀）。
   *    宿主模式（不给那个变量）**逐字保留**既有行为。
   */
  const simAdminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  if (simAdminUrl !== '') {
    await runPreparedPgGateInInstance(simAdminUrl, 'worldmodel-reflection', 'scripts/world-model-reflection-e2e-verify.ts')
  } else {
    await runPreparedPgGate('worldmodel-reflection', 'scripts/world-model-reflection-e2e-verify.ts')
  }
  process.exit(0)
}

// ⚠️ 必须在**任何**碰数据库的 import 之前（AGENTS §7）
const sandbox = isolateDatabase('world-model-reflection-e2e', {
  postgres: { url: process.env.LG_TEST_PG_URL ?? '' },
})
if (sandbox.backend !== 'postgres') throw new Error('world_model_requires_isolated_postgres')

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createM4Harness, M4_T0 } from './m4-harness.ts'
import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createHumanConsoleUserTurnIngress, createCharacterAssistantTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { runReflectionWindow } from '../src/infrastructure/runtime/reflection-runner.ts'
import { createReflectionComparisonSource } from '../src/infrastructure/persistence/reflection-comparison-source.ts'
import { readReflectionSourceSnapshot } from '../src/infrastructure/persistence/reflection-source-read.ts'
import { createReflectionInputSource } from '../src/infrastructure/persistence/reflection-input-source.ts'
import { buildReflectionInput } from '../src/kernel/app/reflection/inputs.ts'
import { appendDomainEvent } from '../src/infrastructure/persistence/event-store.ts'
import { listReflectionRecords } from '../src/infrastructure/persistence/reflection-store.ts'
import { listAdaptiveSelfStates, getAdaptiveSelfState } from '../src/infrastructure/persistence/adaptive-self-store.ts'
import { readUsableAdaptiveSelfStates } from '../src/infrastructure/runtime/reflection-current-state.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { invalidateReflectionSources } from '../src/infrastructure/runtime/reflection-invalidation.ts'
import { createLateWriteFence } from '../src/kernel/app/reflection/late-write-fence.ts'
import { latestDomainEventSequence } from '../src/infrastructure/persistence/reflection-input-source.ts'
import { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE } from '../src/kernel/contracts/reflection.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'
import type { ReflectionOutcomeComparison } from '../src/kernel/app/reflection/outcome-comparison.ts'

const checks: { caseId: string; pass: boolean; observed: unknown }[] = []
const check = (caseId: string, pass: boolean, observed: unknown): void => {
  checks.push({ caseId, pass, observed })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${caseId}${pass ? '' : ' — ' + JSON.stringify(observed)}`)
}
let clock = M4_T0

async function main(): Promise<void> {
  const h = await createM4Harness({ label: 'world-model-reflection-e2e' })
  try {
  const characterId = h.kernel.characterId
  /**
   * 比较材料的取数**工厂**（见 `reflection-runner.ts` 的说明）：
   * 二次复核发生在事务内 ⇒ 必须能按**当前读面**重建（否则单连接后端上死锁）。
   */
  const comparisonSource = (db: typeof h.db) =>
    createReflectionComparisonSource(db, { characterId, activeUserId: h.userId })

  const draft = (call: ReflectionDraftCall, support = call.handles.map(handle => handle.id)) => ({
    schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION,
    focusQuestion: '对象含糊时是否先核对？',
    explanation: '候选解释，不是外部事实。',
    supportHandles: support,
    counterHandles: [],
    scope: REFLECTION_DRAFT_SCOPE,
    suggestedSlot: 'clarify_when_ambiguous',
  })

  /** 记录 provider 实际看到的比较材料（**只读**调用面）。 */
  const seen: ReflectionOutcomeComparison[][] = []
  const provider = {
    name: 'world-model-reflection-e2e-offline',
    version: 'world-model-reflection-e2e@1',
    async call(call: ReflectionDraftCall) {
      seen.push([...(call.comparisons ?? [])])
      return draft(call)
    },
  }

  /**
   * 种一个场景：3 个独立根 · 2 个会话 · 1 个目标结局触发。
   *
   * ⚠️ 目标**创建**事件也在种（`GOAL_CREATED`）—— 它是"当时预测什么"的来源
   *    （比较材料要读它）；它的 `sourceRefs` 指向那三条真实对话事件。
   */
  async function seed(
    caseId: string,
    options: {
      outcome: 'completed' | 'blocked'
      /**
       * `separate` ⇒ 目标的 `sourceRefs` 指向**第 4 条**对话事件（不是那三个根）。
       *
       * ⚠️ 这是**为了把两件事分开测**：遗忘那条"声明来源"只应当让**比较材料**作废，
       *    **不**应当让反思窗口的根失效 —— 否则测到的只是"来源失效 ⇒ 整窗拒绝"，
       *    测不到"比较材料自己会被遮蔽掉"。
       */
      declaration?: 'roots' | 'separate'
      /**
       * 在**取水位之前**做的事（例如"遗忘"）。
       *
       * ⚠️ 为什么要有这个钩子（2026-10-20 实测）：`MEMORY_RETRACTED` 自己就是一个
       *    **触发**，它的来源是那条"忘掉…"的用户发言 —— 若它落在**窗口里**，
       *    整窗会因为那条来源的归因不成立而**在调模型前被拒**（`来源当前不可用`），
       *    于是测到的不是"比较材料被遮蔽"，而是"窗口里有别的坏来源"。
       *    ⇒ 把遗忘放在**水位之前**：它仍然生效（撤销集是全账本的），但不进窗口。
       */
      beforeGoal?: (context: { ids: readonly string[]; declarationIds: readonly string[] }) => Promise<void>
    } = { outcome: 'completed' }
  ) {
    const ids: string[] = []
    const recorders = Array.from({ length: 2 }, (_, session) => new ConversationRecorder({
      db: h.db,
      characterId,
      conversationId: asConversationId(`${caseId}-s-${session}`),
      dryRun: false,
      userId: h.userId,
      userName: 'Alex',
      characterName: '苏沐薇',
      transport: 'world-model-reflection-e2e',
      attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    }))
    for (let i = 0; i < 3; i += 1) {
      const evidence = await recorders[i % 2]!.recordUserMessage('隔离用反馈：对象含糊时先核对。', Math.floor(i / 2) + 1)
      ids.push(String(evidence.event!.id))
    }
    let declarationIds = ids
    if (options.declaration === 'separate') {
      const declaration = await recorders[0]!.recordUserMessage('这次的目标是把周报写清楚并交付。', 3)
      declarationIds = [String(declaration.event!.id)]
    }
    // ⚠️ 水位在**这里**取：钩子里做的事（例如遗忘）留在窗口之外（见 beforeGoal 的说明）
    if (options.beforeGoal !== undefined) {
      await options.beforeGoal({ ids, declarationIds })
    }
    const watermark = await latestDomainEventSequence(h.db, characterId)
    const goalId = `goal:${caseId}`
    await appendDomainEvent(
      h.db,
      characterId,
      {
        type: 'GOAL_CREATED',
        operation: 'world-model-reflection-e2e-fixture',
        payload: {
          characterId: String(characterId),
          mutation: 'explicit',
          goal: {
            goalId,
            characterId: String(characterId),
            owner: { kind: 'character', id: String(characterId) },
            statement: '把这次的周报写清楚并交付',
            successCriterion: { kind: 'user_report' },
            status: 'active',
            origin: 'user_requested',
            priority: 'normal',
            revision: 1,
            sourceRefs: declarationIds.map(id => ({ conversationEventId: id, fingerprint: `fp-${id}` })),
            time: { recordedAt: ++clock },
          },
        },
        sourceConversationEventIds: ids as never,
        idempotencyKey: `world-model-reflection-e2e:${caseId}:created`,
        processor: 'world-model-reflection-e2e',
        processorVersion: 'world-model-reflection-e2e@1',
        scope: 'CHARACTER_INTERNAL',
      },
      ++clock
    )
    await appendDomainEvent(
      h.db,
      characterId,
      {
        type: options.outcome === 'completed' ? 'GOAL_COMPLETED' : 'GOAL_BLOCKED',
        operation: 'world-model-reflection-e2e-fixture',
        payload: options.outcome === 'completed'
          ? {
              characterId: String(characterId),
              goalId,
              expectedRevision: 1,
              basis: 'user_report',
              evidenceRefs: [{ conversationEventId: ids[0]!, fingerprint: `fp-${ids[0]!}` }],
            }
          : {
              characterId: String(characterId),
              goalId,
              expectedRevision: 1,
              reasonCode: 'capability_unavailable',
              note: '隔离用夹具：目标受阻',
            },
        sourceConversationEventIds: ids as never,
        idempotencyKey: `world-model-reflection-e2e:${caseId}:outcome`,
        processor: 'world-model-reflection-e2e',
        processorVersion: 'world-model-reflection-e2e@1',
        scope: 'CHARACTER_INTERNAL',
      },
      ++clock
    )
    return { watermark, ids, goalId, declarationIds }
  }

  // -------------------------------------------------------------------------
  // A 组：主链（目标完成）
  // -------------------------------------------------------------------------
  const fixture = await seed('completed')
  console.log('[gate] seeded')
  const outcome = await runReflectionWindow(h.db, {
    characterId,
    activeUserId: h.userId,
    watermark: fixture.watermark,
    adaptiveEnabled: true,
    provider,
    now: () => ++clock,
    comparisonSource,
  })
  console.log('[gate] reflection window done:', outcome.kind)
  const record = (await listReflectionRecords(h.db, characterId)).find(row => row.reflectionId === outcome.reflectionId)

  // A1：比较材料**真的**被装配并交给了 provider
  const comparisons = seen.at(-1) ?? []
  check(
    'A1-comparison-assembled-and-delivered',
    comparisons.length === 1 &&
      comparisons[0]!.outcomeKind === 'goal' &&
      comparisons[0]!.outcomeCode === 'completed' &&
      comparisons[0]!.predictedText === '把这次的周报写清楚并交付' &&
      comparisons[0]!.actualText === '（程序事实：目标已完成）' &&
      comparisons[0]!.reviewCriterion === undefined,
    { comparisons }
  )

  // A2：比较**不改变**门槛读数（根 3 · 会话 2）与采纳结论
  check(
    'A2-comparison-does-not-change-roots-or-threshold',
    outcome.kind === 'accepted' &&
      record?.status === 'accepted' &&
      record?.rootCount === 3 &&
      record?.conversationCount === 2,
    { outcome: outcome.kind, record: { status: record?.status, rootCount: record?.rootCount, conversationCount: record?.conversationCount } }
  )

  // A3：槽位真的被调整了
  const slot = await getAdaptiveSelfState(h.db, characterId, 'clarify_when_ambiguous')
  check('A3-slot-adjusted', slot.level === 'enhanced' && slot.revision === 1, { level: slot.level, revision: slot.revision })

  // A4：实际入模（上下文 section 带槽位引用）
  const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot, recorder: h.recorder,
    conversationSequence: h.nextTurnSequence, recentLimit: 16, slowPathEnabled: false,
    userId: h.userId, recallBudget: { ...DEFAULT_CONTEXT_BUDGET, adaptiveSelfTokens: 800 } })
  const turn = await gateway.beginTurn('隔离检查：核对当前对象。')
  const packet = await gateway.compileTurn({ turn, currentInput: '隔离检查：核对当前对象。', recentLines: [],
    buildAdaptiveSelfStates: () => readUsableAdaptiveSelfStates(h.db, characterId, h.userId) })
  const section = packet.sections.filter(row => row.id === 'adaptive-self')
  check('A4-real-gateway-packet-contains-adaptive-section',
    section.some(row => (row.sourceRefs?.length ?? 0) > 0),
    { refs: section.flatMap(row => row.sourceRefs ?? []) })
  await gateway.completeTurn({ turn, replyText: '离线占位回复。', modelDurationMs: 0 })

  // A5：失败结局携带待复核判据，不能证明假设已被反驳。
  const blockedFixture = await seed('blocked', { outcome: 'blocked' })
  const blockedOutcome = await runReflectionWindow(h.db, {
    characterId,
    activeUserId: h.userId,
    watermark: blockedFixture.watermark,
    adaptiveEnabled: true,
    provider,
    now: () => ++clock,
    comparisonSource,
  })
  const blockedComparisons = seen.at(-1) ?? []
  check(
    'A5-blocked-outcome-carries-review-criterion',
    blockedComparisons.length === 1 &&
      blockedComparisons[0]!.outcomeCode === 'blocked' &&
      blockedComparisons[0]!.reviewCriterion === '（成功判据：由用户报告确认）' &&
      blockedComparisons[0]!.actualText === '（程序事实：目标受阻）',
    { comparisons: blockedComparisons, outcome: blockedOutcome.kind }
  )

  // -------------------------------------------------------------------------
  // B 组：负控 —— 遮蔽与并发失效
  // -------------------------------------------------------------------------
  // B1：**声明来源**被遗忘 ⇒ 比较**整条作废**（装配层就不给），反思**照常**跑
  /*
   * ⚠️ 目标的 `sourceRefs` 指向**第 4 条**对话事件（`declaration: 'separate'`）——
   *    这样"遗忘那条声明来源"只让**比较材料**作废，**不**让窗口的 3 个根失效。
   *    否则测到的只是"来源失效 ⇒ 整窗拒绝"，测不到比较材料自己的遮蔽判据。
   */
  const forgottenFixture = await seed('forgotten', {
    outcome: 'completed',
    declaration: 'separate',
    /*
     * ⚠️ 遗忘放在**水位之前**（见 `beforeGoal` 的说明）：它仍然生效
     *    （撤销集是全账本的），但 `MEMORY_RETRACTED` 那个**触发**不进本轮窗口。
     */
    beforeGoal: async ({ declarationIds }) => {
      const memory = await h.commitAndFold(
        h.makeCandidate(
          'person_fact',
          { kind: 'claim', subject: h.user, predicate: 'world.model.preference', value: '先核对' } as never,
          { sourceRefs: [{ kind: 'conversation_event', id: declarationIds[0]! }] }
        ),
        ++clock
      )
      if (memory === null) throw new Error('来源记忆夹具被拒')
      const forgetEvent = await h.recordUserEvidence('忘掉那条偏好。')
      await h.applyStateChange('retract', String(forgetEvent.event.id), { memoryId: memory.id, reason: 'explicit_forget' }, ++clock)
    },
  })
  const beforeSeen = seen.length
  const forgottenOutcome = await runReflectionWindow(h.db, {
    characterId,
    activeUserId: h.userId,
    watermark: forgottenFixture.watermark,
    adaptiveEnabled: true,
    provider,
    now: () => ++clock,
    comparisonSource,
  })
  const forgottenRecord = (await listReflectionRecords(h.db, characterId))
    .find(row => row.reflectionId === forgottenOutcome.reflectionId)
  const providerCalled = seen.length === beforeSeen + 1
  const deliveredComparisons = providerCalled ? (seen.at(-1) ?? []) : []
  // 诊断读数：这些来源现在到底被判成什么（失败时用来定位，不是判据）
  const diagnostics = await createReflectionComparisonSource(h.db, { characterId, activeUserId: h.userId })
    .usabilityOf(forgottenFixture.declarationIds)
  // 诊断：三个**根**现在还可不可以用（失败时用来定位）
  const rootSnapshot = await readReflectionSourceSnapshot(
    h.db,
    characterId,
    forgottenFixture.ids.map(id => ({ id, kind: 'conversation_event' as const })),
    { activeUserId: h.userId }
  )
  // 诊断：**runner 实际交进去的那些 handle** 的可用性（窗口里还有 domain_event）
  const builtForDiagnostics = await buildReflectionInput(
    createReflectionInputSource(h.db, { characterId }),
    { characterId: String(characterId), cutoverSequence: 0, watermark: forgottenFixture.watermark }
  )
  const handleSnapshot = builtForDiagnostics === undefined
    ? undefined
    : await readReflectionSourceSnapshot(h.db, characterId, builtForDiagnostics.handles, { activeUserId: h.userId })
  check(
    'B1-forgotten-declaration-source-drops-the-comparison',
    diagnostics.every(row => !row.usable) &&
      deliveredComparisons.length === 0 &&
      providerCalled &&
      forgottenOutcome.kind === 'accepted' &&
      forgottenRecord?.rootCount === 3,
    { comparisons: deliveredComparisons, outcome: forgottenOutcome.kind, providerCalled,
      detail: forgottenOutcome.detail, diagnostics,
      roots: { usable: rootSnapshot.usable, verdicts: rootSnapshot.sourceVerdicts,
        conversationCount: rootSnapshot.conversationCount, roots: rootSnapshot.roots.length },
      handles: handleSnapshot === undefined ? 'no-input' : {
        usable: handleSnapshot.usable,
        verdicts: handleSnapshot.sourceVerdicts,
        handles: builtForDiagnostics?.handles.length,
      },
      record: { status: forgottenRecord?.status, rootCount: forgottenRecord?.rootCount } }
  )

  // B2：模型调用**期间**来源失效 ⇒ 二次复核拒收（不保存过期草案）
  const pendingFixture = await seed('forget-during-model')
  const pendingMemory = await h.commitAndFold(
    h.makeCandidate(
      'person_fact',
      { kind: 'claim', subject: h.user, predicate: 'world.model.pending', value: '核对' } as never,
      { sourceRefs: [{ kind: 'conversation_event', id: pendingFixture.ids[0]! }] }
    ),
    ++clock
  )
  if (pendingMemory === null) throw new Error('来源记忆夹具被拒')
  const staleOutcome = await runReflectionWindow(h.db, {
    characterId,
    activeUserId: h.userId,
    watermark: pendingFixture.watermark,
    adaptiveEnabled: true,
    comparisonSource,
    now: () => ++clock,
    provider: {
      ...provider,
      async call(call: ReflectionDraftCall) {
        const event = await h.recordUserEvidence('忘掉新的那条偏好。')
        await h.applyStateChange('retract', String(event.event.id), { memoryId: pendingMemory.id, reason: 'explicit_forget' }, ++clock)
        return draft(call)
      },
    },
  })
  check(
    'B2-source-invalidated-during-call-rejects',
    staleOutcome.kind === 'rejected' && staleOutcome.eventsWritten === 0,
    { kind: staleOutcome.kind, eventsWritten: staleOutcome.eventsWritten, detail: staleOutcome.detail }
  )

  // B3：**不**配比较材料 ⇒ 行为与今天逐字相同（没有比较、门槛读数不变）
  const plainFixture = await seed('no-comparison')
  const plainOutcome = await runReflectionWindow(h.db, {
    characterId,
    activeUserId: h.userId,
    watermark: plainFixture.watermark,
    adaptiveEnabled: true,
    provider,
    now: () => ++clock,
  })
  const plainRecord = (await listReflectionRecords(h.db, characterId)).find(row => row.reflectionId === plainOutcome.reflectionId)
  check(
    'B3-without-comparison-source-behavior-unchanged',
    plainOutcome.kind === 'accepted' && plainRecord?.rootCount === 3 && plainRecord?.conversationCount === 2,
    { kind: plainOutcome.kind, rootCount: plainRecord?.rootCount, conversationCount: plainRecord?.conversationCount }
  )

  const external = await seed('aux-outside-roots', { outcome: 'blocked', declaration: 'separate' })
  const outside = await runReflectionWindow(h.db, {
    characterId, activeUserId: h.userId, watermark: external.watermark, adaptiveEnabled: true,
    comparisonSource, now: () => ++clock,
    provider: { ...provider, async call(call: ReflectionDraftCall) { return draft(call, external.ids) } },
  })
  check('B4-auxiliary-source-cannot-escape-persisted-root-coverage',
    outside.kind === 'rejected' && outside.eventsWritten === 0, { kind: outside.kind, detail: outside.detail })

  const acceptedState = await getAdaptiveSelfState(h.db, characterId, 'clarify_when_ambiguous')
  const supportId = acceptedState.roots[0]!
  const withdrawnMemory = await h.commitAndFold(h.makeCandidate('person_fact',
    { kind: 'claim', subject: h.user, predicate: 'world.model.withdrawal', value: '回归夹具' } as never,
    { sourceRefs: [{ kind: 'conversation_event', id: supportId }] }), ++clock)
  if (!withdrawnMemory) throw new Error('withdrawal_fixture_rejected')
  const forget = await h.recordUserEvidence('忘掉回归夹具那条。')
  await h.applyStateChange('retract', String(forget.event.id), { memoryId: withdrawnMemory.id, reason: 'explicit_forget' }, ++clock)
  const afterWithdrawal = await readUsableAdaptiveSelfStates(h.db, characterId, h.userId)
  await invalidateReflectionSources(h.db, characterId, createLateWriteFence(), h.userId)
  const afterInvalidation = await getAdaptiveSelfState(h.db, characterId, 'clarify_when_ambiguous')
  check('B5-forgetting-after-acceptance-stops-injection-and-reverts-slot',
    !afterWithdrawal.some(state => state.slot === 'clarify_when_ambiguous') && afterInvalidation.level === 'baseline',
    { usable: afterWithdrawal.length, level: afterInvalidation.level })

  // -------------------------------------------------------------------------
  // 隔离自证：实验目录 ≠ 生产目录
  // -------------------------------------------------------------------------
  check(
    'Z1-isolated-from-production',
    sandbox.backend === 'postgres' && sandbox.postgresTarget?.includes('/lg_test_') === true,
    { backend: sandbox.backend, target: sandbox.postgresTarget }
  )

  // -------------------------------------------------------------------------
  // 证据
  // -------------------------------------------------------------------------
  const failed = checks.filter(row => !row.pass)
  const out = process.env.LG_WORLD_MODEL_RUN_DIR!
  const files = [
    'scripts/world-model-reflection-e2e-verify.ts',
    'scripts/postgresql/test-harness.ts',
    'src/kernel/app/reflection/outcome-comparison.ts',
    'src/infrastructure/runtime/reflection-runner.ts',
    'src/infrastructure/persistence/reflection-comparison-source.ts',
    'src/infrastructure/model/openai-reflection.ts',
    'src/kernel/app/turn-gateway.ts',
    'src/infrastructure/runtime/reflection-current-state.ts',
    'src/infrastructure/runtime/reflection-invalidation.ts',
    'src/kernel/policies/reflection-validator.ts',
  ]
  writeFileSync(
    resolve(out, 'verification.json'),
    JSON.stringify(
      {
        schema: 'world-model-reflection-e2e@1',
        status: failed.length === 0 ? 'PASS' : 'FAIL',
        checks,
        backend: 'postgres',
        backendNote: '独立容器、独立卷、随机端口与测试库；迁移后开库，核对身份后执行，结束清理。',
        productionLibraryOpened: false,
        realModelCalls: 0,
        evidenceClass: 'offline_isolated_end_to_end_mechanism',
        sourceHashes: Object.fromEntries(
          files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])
        ),
      },
      null,
      2
    ) + '\n'
  )
  console.log(
    JSON.stringify({
      status: failed.length === 0 ? 'PASS' : 'FAIL',
      checks: checks.length,
      failed: failed.length,
      output: out,
    })
  )
  if (failed.length > 0) process.exitCode = 1
  } finally {
    await h.stop()
  }
}

await main()
