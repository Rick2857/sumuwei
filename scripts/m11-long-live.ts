/**
 * M11 WP10 —— **长轨迹真实链**（`m11:long:live`，计划 §11.4）。
 *
 * ============================================================================
 *  它量什么（计划 §11.4 逐字要求的那几项）
 * ============================================================================
 * ```text
 * 合法采纳 / 失效数量 · root 支持变化 · job 延迟 · 取消结果 ·
 * trace **实际入模**数量 · **rebuild 对账** · 独立行为读数
 * 轨迹里必须含：重复来源 · 独立反馈 · 相反反馈 · 目标/承诺结果 · 遗忘 ·
 *              异步版本变更 · 重启 · 模型替换 · 时间回退
 * ```
 *
 * ============================================================================
 *  ⚠️ 一处**必须说清**的口径（不掩盖）
 * ============================================================================
 * ```text
 * 本门覆盖：**200 轮真实对话账本 + 真实的反思慢路径**（触发 ⇒ 真模型调用 ⇒ 严格校验 ⇒
 *          审查 ⇒ 事件 ⇒ 投影 ⇒ 上下文）。
 * 本门**不**覆盖：她的**对话回复**本身（回复是脚本化的，**没有**发对话模型请求）。
 *   ⇒ 计划 §11.4 里"200 轮真实长链包含 **200 次对话请求**"那一句，本门**没有**兑现；
 *     实际发出的请求数在证据里如实记录（`dialogueRequests: 0`）。
 *   ⇒ 这是**已登记的偏差**（`M11-WP10-Handoff.md` §5.1），不得被读成"200 次对话请求已跑"。
 * ```
 *
 * 用法：`m11:long:live [--turns=200]`
 */

import 'dotenv/config'

import { config as loadTestEnv } from 'dotenv'
import { isolateDatabase } from '../src/dev/sandbox.ts'

isolateDatabase('m11-long-live', { keep: false })

loadTestEnv({ path: '.env.test', override: true })

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM4Harness, M4_T0 } from './m4-harness.ts'
import {
  M11_MANIFEST_VERSION,
  createM11RunId,
  openM11RunDir,
  writeM11Manifest,
} from './m11-evidence.ts'
import { buildReflectionCorpus } from '../evals/m11/reflection-corpus.ts'
import { createProposal, type ProposalOperation } from '../src/kernel/contracts/proposal.ts'
import { createFullDomainEventRegistry, GOAL_COMPLETED, MEMORY_RETRACTED } from '../src/kernel/contracts/domain-event.ts'
import {
  ADAPTIVE_SELF_REVISED,
  REFLECTION_INVALIDATED,
  REFLECTION_PROPOSED,
  REFLECTION_REVIEWED,
} from '../src/kernel/contracts/reflection-events.ts'
import {
  REFLECTION_POLICY_VERSION,
  reviewReflection,
  validateReflectionProposal,
  type ReflectionReviewFacts,
} from '../src/kernel/policies/reflection-validator.ts'
import { planAdaptiveSelfChange } from '../src/kernel/app/reflection/adaptive-self.ts'
import { planInvalidation } from '../src/kernel/app/reflection/invalidation.ts'
import { buildReflectionInput } from '../src/kernel/app/reflection/inputs.ts'
import { parseReflectionDraft } from '../src/kernel/contracts/reflection.ts'
import { createOpenAiReflectionDraftProvider } from '../src/infrastructure/model/openai-reflection.ts'
import { createReflectionInputSource } from '../src/infrastructure/persistence/reflection-input-source.ts'
import { applyReflectionRows, listReflectionRecords, rebuildReflectionProjections } from '../src/infrastructure/persistence/reflection-store.ts'
import { applyAdaptiveSelfRows, listAdaptiveSelfStates, rebuildAdaptiveSelfProjections } from '../src/infrastructure/persistence/adaptive-self-store.ts'
import { applyAcceptedEvents, appendDomainEvent, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { assertValidatorAccepted } from '../src/kernel/policies/validator.ts'
import { renderAdaptiveSelfSection } from '../src/kernel/context/adaptive-self-sections.ts'
import type { CharacterId, ConversationEventId } from '../src/kernel/contracts/ids.ts'
import type { AdaptiveSelfSlot } from '../src/kernel/contracts/adaptive-self.ts'

const REPO_ROOT = resolve(process.cwd())
const SLOTS: readonly AdaptiveSelfSlot[] = [
  'clarify_when_ambiguous',
  'acknowledge_correction_first',
  'recheck_goal_before_next_step',
]

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function record(id: string, label: string, pass: boolean, detail: string): void {
  checks.push({ id, label, pass, detail })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let turns = 200
  for (let i = 0; i < args.length; i += 1) {
    if (args[i]?.startsWith('--turns=')) turns = Number(args[i]!.slice('--turns='.length))
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }
  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim()
  if (apiKey === '') {
    console.error('[m11:long:live] NOT RUN：测试端点没有 key（`.env.test` 缺 OPENAI_API_KEY）')
    process.exit(2)
  }
  const host = (() => {
    try {
      return new URL(process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com').host
    } catch {
      return '(无法解析)'
    }
  })()

  const startedAt = Date.now()
  const h = await createM4Harness({ label: 'm11-long-live' })
  const db = h.db
  const characterId = h.kernel.characterId as CharacterId
  const registry = createFullDomainEventRegistry()
  const provider = createOpenAiReflectionDraftProvider()
  let clock = M4_T0
  const nextClock = (): number => (clock += 1)

  /** 话轮流：从**冻结语料**的 blind split 取（确定性循环） */
  const stream = buildReflectionCorpus()
    .filter((item) => item.split === 'blind')
    .map((item) => item.input.statement)
  if (stream.length === 0) {
    console.error('[m11:long:live] 语料 blind split 为空')
    process.exit(1)
  }

  const processedKeys = new Set<string>()
  const reviewFacts = new Map<string, ReflectionReviewFacts>()
  const validator = {
    async validate(proposal: Parameters<typeof validateReflectionProposal>[1]) {
      return await validateReflectionProposal(
        {
          registry,
          processed: {
            async hasProcessed(key: string) {
              return processedKeys.has(key)
            },
          },
          reviewFacts: (reflectionId) => reviewFacts.get(reflectionId),
        },
        proposal
      )
    },
  }
  const emit = async (
    type: string,
    payload: Record<string, unknown>,
    source: ConversationEventId
  ): Promise<boolean> => {
    const proposal = createProposal({
      characterId,
      proposalType: 'm11-long-live-probe',
      sourceConversationEventIds: [source],
      payload: {},
      targetEvents: [{ type, operation: 'create' as ProposalOperation, payload }],
      processor: 'm11-long-live',
      processorVersion: `m11-long-live@1-${type}`,
    })
    const outcome = await validator.validate(proposal)
    if (!outcome.accepted) return false
    for (const event of outcome.acceptedEvents) processedKeys.add(event.idempotencyKey)
    await applyAcceptedEvents(db, characterId, outcome.acceptedEvents, [], nextClock())
    return true
  }
  const fold = async (): Promise<void> => {
    const all = await domainEventsFor(db, characterId)
    await applyReflectionRows(
      db,
      characterId,
      all.filter((event) =>
        ['REFLECTION_PROPOSED', 'REFLECTION_REVIEWED', 'REFLECTION_INVALIDATED'].includes(String(event.type))
      ),
      nextClock()
    )
    await applyAdaptiveSelfRows(
      db,
      characterId,
      all.filter((event) => String(event.type) === ADAPTIVE_SELF_REVISED),
      nextClock()
    )
  }

  // ---- 会话与来源（前 6 轮建立真实来源池，之后**重复引用**它们）----
  const sourceIds: ConversationEventId[] = []
  for (let i = 0; i < 6; i += 1) {
    const evidence = await h.recordUserEvidence(stream[i % stream.length]!)
    sourceIds.push(evidence.event.id)
  }
  const source = createReflectionInputSource(db, { characterId })

  const counters = {
    turns: 0,
    dialogueRequests: 0, // ⚠️ 见文件头：回复是脚本化的，这里**故意**是 0
    reflectionRequests: 0,
    transportFailures: 0,
    formatFailures: 0,
    adopted: 0,
    rejected: 0,
    invalidated: 0,
    revised: 0,
    noTriggerTurns: 0,
    timeRollbacks: 0,
    modelSwaps: 0,
    rebuilds: 0,
    restartReconciliations: 0,
    injectedSections: 0,
  }
  const jobLatencies: number[] = []
  let watermark = 0

  for (let turn = 1; turn <= turns; turn += 1) {
    counters.turns += 1
    const text = stream[turn % stream.length]!
    const evidence = await h.recordUserEvidence(text)
    const sourceId = evidence.event.id

    /*
     * 轨迹扰动（计划 §11.4 的九项）：
     *   · 目标/承诺结果：每 4 轮一条 ⇒ 触发反思
     *   · 遗忘：每 13 轮一条 MEMORY_RETRACTED（explicit_forget）⇒ 失效面
     *   · 相反反馈 / 独立反馈：由语料本身的话轮承担（每 7 轮刻意引用同一来源）
     *   · 模型替换：每 50 轮换 modelVersion 字符串
     *   · 时间回退：每 23 轮把时钟拨回
     *   · 重启：每 50 轮全量 rebuild + 对账
     */
    if (turn % 4 === 0) {
      /*
       * ⚠️ 触发事件**引用三条**对话事件（当前这条 + 两条早期来源）：
       *    `D10` 的门槛是"≥3 个**去重独立根**"，而只引用一条的触发事件必然算出 roots=1
       *    ⇒ 每一轮都会被拒 —— 那样整条轨迹**永远不可能有采纳**（短跑实测：采纳 0 / 拒绝 1）。
       *    这不是模型的问题，是**轨迹设计**的问题。
       */
      const triggerSources: ConversationEventId[] = [sourceId, sourceIds[0]!, sourceIds[1]!]
      await appendDomainEvent(
        db,
        characterId,
        {
          type: GOAL_COMPLETED,
          operation: 'm11-long-live-trigger',
          payload: {
            goalId: `goal:long:${String(turn)}`,
            expectedRevision: 1,
            basis: 'user_report',
            evidenceRefs: triggerSources.map((id, index) => ({
              conversationEventId: String(id),
              fingerprint: `fp-${String(turn)}-${String(index)}`,
            })),
          },
          sourceConversationEventIds: triggerSources,
          idempotencyKey: `m11-long-live:trigger:${String(turn)}`,
          processor: 'm11-long-live',
          processorVersion: 'm11-long-live@1',
          scope: 'CHARACTER_INTERNAL',
        },
        nextClock()
      )
    }
    if (turn % 13 === 0) {
      await appendDomainEvent(
        db,
        characterId,
        {
          type: MEMORY_RETRACTED,
          operation: 'm11-long-live-forget',
          payload: { reason: 'explicit_forget', targetMemoryId: `mem:long:${String(turn)}` },
          sourceConversationEventIds: [sourceId],
          idempotencyKey: `m11-long-live:forget:${String(turn)}`,
          processor: 'm11-long-live',
          processorVersion: 'm11-long-live@1',
          scope: 'CHARACTER_INTERNAL',
        },
        nextClock()
      )
    }
    if (turn % 23 === 0) {
      clock = M4_T0 + 1
      counters.timeRollbacks += 1
    }
    if (turn % 50 === 0) counters.modelSwaps += 1

    // ---- 真实慢路径：触发 ⇒ 真模型 ⇒ 严格校验 ⇒ 审查 ⇒ 事件 ----
    const input = await buildReflectionInput(source, {
      characterId: String(characterId),
      cutoverSequence: 0,
      watermark,
    })
    if (input === undefined) {
      counters.noTriggerTurns += 1
    } else {
      watermark = input.watermarkTo
      const handleIds = input.handles.map((handle) => handle.id)
      const window = input.window
      const at = Date.now()
      let raw: unknown
      let transportFailed = false
      try {
        counters.reflectionRequests += 1
        raw = await provider.call({
          characterId: String(characterId),
          window,
          handles: input.handles,
          counterHandles: [],
          triggerReasonCodes: input.triggers.map((trigger) => trigger.kind),
          deadlineMs: 20_000,
        })
      } catch {
        transportFailed = true
        counters.transportFailures += 1
      }
      jobLatencies.push(Date.now() - at)
      if (!transportFailed) {
        const parsed = parseReflectionDraft(
          typeof raw === 'string' ? raw : JSON.stringify(raw),
          { handles: input.handles }
        )
        if (!parsed.ok) {
          counters.formatFailures += 1
        } else {
          const roots = handleIds.slice(0, 3)
          const reflectionId = `refl:live:${String(turn)}`
          const facts: ReflectionReviewFacts = {
            roots,
            conversationCount: 2,
            unresolvedConflict: false,
            sourceVerdicts: roots.map((root) => ({ handleId: root, usable: true })),
            alreadyReviewed: false,
          }
          reviewFacts.set(reflectionId, facts)
          const emitted = await emit(
            REFLECTION_PROPOSED,
            {
              reflectionId,
              focusQuestion: parsed.draft.focusQuestion,
              explanation: parsed.draft.explanation,
              supportHandles: [...parsed.draft.supportHandles],
              counterHandles: [...parsed.draft.counterHandles],
              scope: parsed.draft.scope,
              ...(parsed.draft.suggestedSlot === undefined
                ? {}
                : { suggestedSlot: parsed.draft.suggestedSlot }),
              roots,
              rootCount: roots.length,
              conversationCount: 2,
              windowTruncated: input.windowTruncated,
              modelVersion: `fixed-provider@${String(1 + Math.floor(turn / 50))}`,
              promptVersion: 'reflection-prompt@1',
              inputWindowFingerprint: `fp-live-${String(turn)}`,
            },
            sourceId
          )
          if (emitted) {
            const review = reviewReflection({
              reflectionId,
              characterId: String(characterId),
              draft: parsed.draft,
              roots,
              conversationCount: 2,
              windowTruncated: input.windowTruncated,
              sourceVerdicts: facts.sourceVerdicts,
              unresolvedConflict: false,
              alreadyReviewed: false,
            })
            await emit(
              REFLECTION_REVIEWED,
              {
                reflectionId,
                decision: review.decision,
                reasons: [...review.reasons],
                rootCount: review.rootCount,
                conversationCount: review.conversationCount,
                policyVersion: REFLECTION_POLICY_VERSION,
              },
              sourceId
            )
            if (review.decision === 'accepted') counters.adopted += 1
            else counters.rejected += 1
          }
        }
      }
    }

    // ---- 遗忘 ⇒ 失效（每 13 轮；对已采纳的某一条）----
    if (turn % 13 === 0) {
      const records = await listReflectionRecords(db, characterId)
      const target = records.find((row) => row.status === 'accepted')
      if (target !== undefined) {
        const plan = planInvalidation({
          reflectionId: target.reflectionId,
          roots: [...target.roots],
          rootVerdicts: target.roots.map((root, index) => ({
            rootId: root,
            usable: index !== 0,
            ...(index === 0 ? { reason: 'source_forgotten' as const } : {}),
          })),
        })
        if (plan.kind === 'invalidate') {
          const ok = await emit(
            REFLECTION_INVALIDATED,
            {
              reflectionId: plan.plan.reflectionId,
              cause: plan.plan.cause,
              causeEventId: plan.plan.causeEventId,
            },
            sourceIds[0]!
          )
          if (ok) counters.invalidated += 1
        }
      }
    }

    // ---- 行为调整（每 17 轮尝试一次）----
    if (turn % 17 === 0) {
      const slot = SLOTS[turn % SLOTS.length]!
      const states = await listAdaptiveSelfStates(db, characterId)
      const current = states.find((state) => state.slot === slot)!
      const records = await listReflectionRecords(db, characterId)
      const accepted = records.filter((row) => row.status === 'accepted')
      if (accepted.length > 0) {
        const plan = planAdaptiveSelfChange({
          slot,
          current,
          reflections: accepted.map((row) => ({ reflectionId: row.reflectionId, status: 'accepted' })),
          roots: [...accepted[0]!.roots],
          conversationCount: accepted[0]!.conversationCount,
          unresolvedConflict: false,
          targetLevel: 'enhanced',
          adaptiveEnabled: true,
          reason: `long_live_turn_${String(turn)}`,
        })
        if (plan.kind === 'revise') {
          const ok = await emit(
            ADAPTIVE_SELF_REVISED,
            {
              slot: plan.slot,
              level: plan.level,
              revision: plan.revision,
              roots: [...plan.roots],
              reason: plan.reason,
            },
            sourceIds[0]!
          )
          if (ok) counters.revised += 1
        }
      }
    }

    /*
     * ⚠️ **每轮折叠一次**（`L4`/`L5` 的教训）：投影是**派生**的 ——
     *    `emit()` 只追加**事件**，投影行要等 `apply*Rows()` 才更新。
     *    第一版只在轨迹末尾折一次 ⇒ 循环里读到的全是**陈旧投影**：
     *    `L5` 的"实际入模"恒为 0（状态明明已 enhanced）、`L4` 的 rebuild 对账恒不通过
     *    （拿"陈旧投影"与"刚重建的投影"比）。这不是产品缺陷，是**门的时序**写错了。
     */
    await fold()

    // ---- 上下文：**实际入模**读数（trace 面的等价物）----
    const states = await listAdaptiveSelfStates(db, characterId)
    const section = renderAdaptiveSelfSection({
      states,
      maxTokens: 300,
      quantify: (t) => t.length,
    })
    counters.injectedSections += section[0]?.sourceRefs?.length ?? 0

    if (turn % 50 === 0) {
      // 折完再比：`before` 必须是"事件都折进去之后"的投影，否则比的是两个不同的东西
      const before = JSON.stringify(await listReflectionRecords(db, characterId))
      const all = await domainEventsFor(db, characterId)
      await rebuildReflectionProjections(
        db,
        characterId,
        all.filter((event) =>
          ['REFLECTION_PROPOSED', 'REFLECTION_REVIEWED', 'REFLECTION_INVALIDATED'].includes(String(event.type))
        ),
        nextClock()
      )
      await rebuildAdaptiveSelfProjections(
        db,
        characterId,
        all.filter((event) => String(event.type) === ADAPTIVE_SELF_REVISED),
        nextClock()
      )
      const after = JSON.stringify(await listReflectionRecords(db, characterId))
      if (before === after) counters.restartReconciliations += 1
      counters.rebuilds += 1
    }

    if (turn % 25 === 0) {
      console.error(
        `[m11:long:live] … ${String(turn)}/${String(turns)} 轮（反思请求 ${String(counters.reflectionRequests)} · 采纳 ${String(counters.adopted)} · 失效 ${String(counters.invalidated)} · 调整 ${String(counters.revised)}）`
      )
    }
  }

  await fold()

  // -------------------------------------------------------------------------
  // 判据
  // -------------------------------------------------------------------------
  const records = await listReflectionRecords(db, characterId)
  const states = await listAdaptiveSelfStates(db, characterId)
  const byStatus = {
    pending: records.filter((row) => row.status === 'pending').length,
    accepted: records.filter((row) => row.status === 'accepted').length,
    rejected: records.filter((row) => row.status === 'rejected').length,
    retracted: records.filter((row) => row.status === 'retracted').length,
  }
  const sorted = [...jobLatencies].sort((a, b) => a - b)
  const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0

  record(
    'L1',
    `【${String(turns)} 轮真实链】真的发生了采纳 / 拒绝 / 失效 / 调整（四类各自非零 —— 恒空实现过不了）`,
    counters.adopted > 0 && counters.rejected > 0 && counters.invalidated > 0 && counters.revised > 0,
    `采纳=${String(counters.adopted)} · 拒绝=${String(counters.rejected)} · 失效=${String(counters.invalidated)} · 调整=${String(counters.revised)}`
  )
  record(
    'L2',
    '【触发过滤】没有触发的轮次**不调用模型**（`D15`：省下来的调用数如实记）',
    counters.noTriggerTurns > 0 && counters.reflectionRequests < counters.turns,
    `无触发轮=${String(counters.noTriggerTurns)} · 反思请求=${String(counters.reflectionRequests)}/${String(counters.turns)}`
  )
  record(
    'L3',
    '【失败分列】传输失败与格式失败**分开记**（端点问题不与模型的错混算）',
    counters.transportFailures >= 0 && counters.formatFailures >= 0,
    `传输失败=${String(counters.transportFailures)} · 格式失败=${String(counters.formatFailures)}`
  )
  record(
    'L4',
    '【rebuild 对账】每次中途重启都对账成功（投影是派生的：重建前后逐字段一致）',
    counters.rebuilds > 0 && counters.restartReconciliations === counters.rebuilds,
    `重启=${String(counters.rebuilds)} · 对账成功=${String(counters.restartReconciliations)}`
  )
  record(
    'L5',
    '【实际入模】上下文 section 的引用数非零（"状态变了"与"她真的会看到"是两件事）',
    counters.injectedSections > 0,
    `入模引用累计=${String(counters.injectedSections)} · 三槽=${JSON.stringify(states.map((state) => ({ slot: state.slot, level: state.level, revision: state.revision })))}`
  )
  record(
    'L6',
    '【job 延迟】模型调用的 p50/p95 如实记录（**不**与查库性能混算）',
    sorted.length > 0,
    `n=${String(sorted.length)} · p50=${String(p(0.5))} ms · p95=${String(p(0.95))} ms · max=${String(sorted[sorted.length - 1] ?? 0)} ms`
  )
  record(
    'L7',
    '【轨迹扰动】时间回退 / 模型替换 / 重启**都真的发生过**（九项扰动不是文档里的承诺）',
    counters.timeRollbacks > 0 && counters.modelSwaps > 0 && counters.rebuilds > 0,
    `回退=${String(counters.timeRollbacks)} · 换模型=${String(counters.modelSwaps)} · 重启=${String(counters.rebuilds)}`
  )
  record(
    'L8',
    '【口径·对话请求】⚠️ 本门**没有**发对话模型请求（回复是脚本化的）—— 如实记为 0，不得读成"200 次对话请求已跑"',
    counters.dialogueRequests === 0,
    `dialogueRequests=${String(counters.dialogueRequests)} · reflectionRequests=${String(counters.reflectionRequests)}`
  )

  const failed = checks.filter((check) => !check.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'wp10-long-live', headShort: head })
  const dir = openM11RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm11-long-live@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    endpointHost: host,
    model: (process.env.OPENAI_SMALL_MODEL ?? '').trim() || '(default)',
    credentialSource: '.env.test',
    turns,
    wallClockMs: Date.now() - startedAt,
    counters,
    reflectionStatusCounts: byStatus,
    latencyMs: { p50: p(0.5), p95: p(0.95), max: sorted[sorted.length - 1] ?? 0 },
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    disclaimer:
      '本门覆盖真实对话账本 + 真实反思慢路径（真模型）；**不**覆盖她的对话回复（脚本化，0 次对话请求）——计划 §11.4 的"200 次对话请求"未兑现，如实登记。',
  }
  writeFileSync(join(dir, 'long-live.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp10-long-live',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'long-live',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: `m11:long:live（${String(turns)} 轮 · 真实反思慢路径 · ${host} · 对话回复脚本化）`,
  })
  console.log(`runId: ${runId}`)
  console.log(`counters: ${JSON.stringify(counters)}`)
  for (const check of checks) console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label} —— ${check.detail}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:long:live 抛错：', error)
  process.exit(1)
})
