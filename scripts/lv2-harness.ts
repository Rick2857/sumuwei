/**
 * Lv2 —— **共用的真实轮次装配**（一处接线；`scripts/` 层，与 `m4-harness.ts` / `m10-harness.ts` 同级）。
 *
 * ============================================================================
 *  它为什么存在（以及它**没有**做什么）
 * ============================================================================
 * `Lv2-Acceptance-Plan.md` §1 要求："证明**同一套 LG 真实轮次装配**可以持续处理…"。
 * 而 `src/main.ts` 是一体化 CLI（只导出 `resolveIds`），脚本无法直接复用它的装配；
 * 已有 35 处 `new TurnGateway({...})` 各自只接自己那一小块（没有一个接满"显式记忆 + 目标/承诺 + 撤销遮蔽"）。
 *
 * ⇒ 本模块是 Lv2 这**一处**接线，接线形状**逐条抄生产**：
 * ```text
 *   显式记忆    createExplicitMemoryService（规则抽取器 + 生产同款冲突端口）
 *               → createExplicitMemoryTurnPort（生产就是从这一步进轮次的）
 *   目标/承诺   createM10TurnHarness 的端口 + createOpenAiGoalUnderstandingProvider（**真模型**）
 *   撤销遮蔽    computeWithdrawnEvidence（M9.1 D16 端口）
 *   最近对话    recentContextLinesFrom（与 main.ts 同一个读法）
 *   回复        网关 prompt → callModelText → 四条回复守卫（与 m11.1-behavior-worker 同序）
 * ```
 *
 * ⚠️ **没有接线的东西必须被点名**（`LV2_NOT_WIRED`）：关系块 / 情绪块 / 信念块 / 反思与行为调整 /
 *    摘要 / 搜索 / 动作。它们在本轮**未装配** ⇒ 与它们有关的案子只能证明"没有不该有的写入"，
 *    不能证明"该有的注入在场"。这一条会写进每份证据的 `config` 与 `limitation`（计划 §3：
 *    不许用"未触发"替代通过；也不许把"没接线"说成"没触发"）。
 *
 * ⚠️ 调用方**必须**先 `isolateDatabase()` 再调 `createLv2CaseEnvironment()`（本模块不隔离库）。
 */

import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { GOAL_PROPOSAL_SCHEMA_VERSION } from '../src/kernel/contracts/goal-proposal.ts'
import { computeWithdrawnEvidence } from '../src/infrastructure/persistence/withdrawn-evidence.ts'
import { applyAcceptedEvents, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { latestConversationSequence } from '../src/infrastructure/persistence/conversation-store.ts'
import { getTrace } from '../src/infrastructure/persistence/trace-store.ts'
import { listGoalStates } from '../src/infrastructure/persistence/goal-store.ts'
import { recentContextLinesFrom, callModelText } from '../src/infrastructure/runtime/adapters.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import { createExplicitMemoryService, type ExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import {
  createExplicitMemoryTurnPort,
  type ExplicitMemoryTurnPort,
} from '../src/kernel/app/memory/explicit-turn.ts'
import {
  createExplicitMemoryIntentDetector,
  type ExplicitMemoryIntentDetector,
} from '../src/kernel/app/memory/intent-detector.ts'
import {
  createRuleOnlyContentExtractor,
  type MemoryContentExtractor,
} from '../src/kernel/app/memory/content-extractor.ts'
import { createTargetMemoryResolver, LexicalSemanticJudge } from '../src/kernel/app/memory/target-resolver.ts'
import { listRecentExplicitWrites } from '../src/infrastructure/persistence/memory-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import type { WithdrawnSetResult } from '../src/kernel/contracts/withdrawn-evidence.ts'
import { commitmentFactRowsOf } from '../src/kernel/app/goal/commitment-facts.ts'
import { orderGoalsForFocus } from '../src/kernel/app/goal/invalidation.ts'
import { goalProposalOf } from '../src/kernel/policies/goal-validator.ts'
import { goalSpanFingerprint } from '../src/kernel/app/goal/understanding.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { applyResponseTruthPolicy } from '../src/kernel/app/memory/response-truth.ts'
import { applyActionClaimGuard } from '../src/kernel/action/claim-guard.ts'
import { applyExternalEvidenceReplyPolicy, searchFactOf } from '../src/kernel/action/external-evidence-reply.ts'
import { applySearchNeedReplyPolicy, searchNeedDiagnosticsOf } from '../src/kernel/action/search-need-reply.ts'
import { createOpenAiGoalUnderstandingProvider } from '../src/infrastructure/model/openai-goal-understanding.ts'
import { runConfiguredAgreementTail } from '../src/infrastructure/runtime/agreement-runtime.ts'
import { createLateWriteFence, type LateWriteFence } from '../src/kernel/app/reflection/late-write-fence.ts'
import { createOpenAiAgreementDraftProvider } from '../src/infrastructure/model/openai-agreement-understanding.ts'
import { AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION } from '../src/kernel/contracts/agreement-model-draft.ts'
import type { GoalUnderstandingProvider } from '../src/kernel/app/goal/understanding.ts'
import { createRealGoalUnderstandingRuntime } from '../src/infrastructure/goal/understanding-runtime.ts'
import { createM4Harness, type M4Harness } from './m4-harness.ts'
import { createM10TurnHarness, deterministicRuntime, type M10TurnHarness } from './m10-harness.ts'
import type {
  Lv2Prep,
  Lv2ProgramAssertion,
  Lv2ShortCase,
} from '../evals/lv2/short-cases.ts'

/** 本批次的候选配置（**逐条可核**；缺省值一律写出来，避免"看起来开着一半"）。 */
export const LV2_CANDIDATE_CONFIG = {
  /** M10.1 生产激活值 */
  goalTokens: 300,
  commitmentTokens: 300,
  /** ⚠️ 生产是 300；本批**未装配**行为调整 ⇒ 传 0（并列入 NOT WIRED） */
  adaptiveSelfTokens: 0,
  /** ⚠️ 生产是 400；本批**未装配**摘要端口 ⇒ 传 0（并列入 NOT WIRED） */
  rollupTokens: 0,
  explicitMemory: true,
  recall: true,
  goals: true,
  withdrawnMasking: true,
} as const

/** 本批次**没有**装配的面（证据里必须点名，不许沉默）。 */
export const LV2_NOT_WIRED = [
  'relationship（关系注入块）',
  'affect（情绪注入块 + 同轮评估）',
  'belief（信念注入块 + 双流评估）',
  'reflection / adaptive-self（反思与行为调整）',
  'rollup-summary（会话摘要）',
  'web-search（联网查证）',
  'action（工具动作）',
] as const

export interface Lv2TurnReading {
  readonly currentInput: string
  readonly reply: string
  readonly controlReply: boolean
  readonly traceId: string
  /** 本节实际入模的 section id（按 compileTurn 的 packet） */
  readonly sectionIds: readonly string[]
  readonly promptSha256Prefix: string
  /** 只供 local/ 私有诊断使用，公开读数不得写入正文。 */
  readonly prompt: string
  /** 原始理解草案只进 local/，用于区分模型格式失败与内核拒收。 */
  readonly goalDrafts: readonly { readonly input: unknown; readonly output: unknown }[]
  readonly completed: boolean
  readonly modelDurationMs: number
  /** 本轮实际调用次数（理解 + 回复 + 慢路径）；失败调用也计入。 */
  readonly modelRequests: number
  readonly writeReality: {
    readonly goalEventTypes: readonly string[]
    readonly memoryOutcome: string | null
    readonly commitmentClaimCorrected: boolean
    readonly goalOutcome: string | null
    readonly goalOperation: string | null
    readonly goalRejectionCodes: readonly string[]
  }
  /** `double_trigger` 的第二投结论（无该故障面时 null） */
  readonly doubleTriggerSecondOutcome: string | null
  /** `LV2-D12` 慢路径的具名结论与本轮模型调用次数（未启用时为 null） */
  readonly slowPath: { readonly kind: string; readonly result: string | null; readonly modelCalls: number } | null
}

export interface Lv2Snapshot {
  /** 全部记忆（含非活跃）—— 断言自己挑需要的状态 */
  readonly memories: readonly {
    readonly id: string
    readonly status: string
    readonly predicate: string | null
    readonly value: string | null
    readonly canonicalKey: string | null
  }[]
  readonly goals: readonly { readonly statement: string; readonly status: string }[]
  readonly commitments: readonly { readonly statement: string; readonly status: string }[]
  readonly eventTypes: readonly string[]
  readonly withdrawnEventIds: readonly string[]
}

export interface Lv2CaseEnvironment {
  readonly h: M4Harness
  readonly goals: M10TurnHarness
  readonly characterId: string
  /** 执行 `prep[]`；返回 `sourceText → 事件 id`（撤销集断言要用它） */
  prepare(prep: readonly Lv2Prep[]): Promise<Record<string, string>>
  /** 跑**一轮**用户消息（真模型或控制回复）；`turnIndex` 进会话 id，保证两轮各自独立会话 */
  runTurn(text: string, options: { readonly control: boolean; readonly turnIndex: number }): Promise<Lv2TurnReading>
  snapshot(): Promise<Lv2Snapshot>
  close(): Promise<void>
}

const claim = (subject: M4Harness['user'], predicate: string, value: string) =>
  ({ kind: 'claim', subject, predicate, value }) as never

/** 显式记忆链的**一处**接线（运行器与诊断脚本共用；与 `main.ts` 的 `buildMemoryWriter` 同形）。 */
export interface Lv2MemoryPath {
  readonly service: ExplicitMemoryService
  readonly port: ExplicitMemoryTurnPort
  readonly detector: ExplicitMemoryIntentDetector
  readonly extractor: MemoryContentExtractor
}

export function createLv2MemoryPath(h: M4Harness): Lv2MemoryPath {
  const resolver = createTargetMemoryResolver({
    get: (id) => h.store.get(id),
    getActiveByCanonicalKey: (key) => h.store.getActiveByCanonicalKey(key),
    listBySubject: (owner, subject) => h.store.listBySubject(owner, subject),
    semanticJudge: new LexicalSemanticJudge(),
  })
  const extractor = createRuleOnlyContentExtractor()
  const service = createExplicitMemoryService({
    store: h.store,
    validator: h.validator,
    extractor,
    resolveTarget: (request) =>
      resolver.resolve({
        owner: request.owner,
        text: request.text,
        ...(request.canonicalKey !== undefined ? { canonicalKey: request.canonicalKey } : {}),
        ...(request.subject !== undefined ? { subject: request.subject } : {}),
        ...(request.hints !== undefined ? { hints: request.hints } : {}),
      }),
    commitEvents: async (accepted, now) =>
      (await applyAcceptedEvents(h.db, h.kernel.characterId, accepted, [], now)).domainEvents,
    conflict: {
      recordsInCanonicalSlot: async ({ canonicalKey }) => {
        const active = await h.store.getActiveByCanonicalKey(canonicalKey)
        const disputed = (await h.store.list({ owner: h.owner, status: 'disputed', limit: 500 })).filter(
          (record) => record.canonicalKey === canonicalKey,
        )
        return [...active, ...disputed]
      },
    },
    /*
     * ⚠️ **M6.1 WP5 / ADR-058 的兜底端口**：`main.ts:1774` 接了它，而本夹具第一版**漏了**
     *    ⇒ "更正到一个抽取器读不出来的新值"时兜底无法生效（旧值被撤、新值不落）。
     *    读法**逐字照抄**生产（同一个 `listRecentExplicitWrites`）。
     */
    recentExplicitWrites: ({ owner, speaker, triggerEventId }) =>
      listRecentExplicitWrites(h.db, { owner, speaker, triggerEventId }),
  })
  const detector = createExplicitMemoryIntentDetector()
  return { service, port: createExplicitMemoryTurnPort({ service, detector }), detector, extractor }
}

/** 本批次**已实现**的故障注入（其余 `fault` 一律 **fail closed**：运行器拒绝判定，不空过也不误红）。 */
export const LV2_IMPLEMENTED_FAULTS = ['provider_error', 'provider_timeout', 'double_trigger'] as const
export type Lv2ImplementedFault = (typeof LV2_IMPLEMENTED_FAULTS)[number]

export function isImplementedFault(fault: string | undefined): fault is Lv2ImplementedFault {
  return fault !== undefined && (LV2_IMPLEMENTED_FAULTS as readonly string[]).includes(fault)
}

/**
 * 把故障注入包在**真 provider** 外面（只注入；正常路径的语义一个字不改）。
 *
 * ⚠️ `runGoalTurn` **不抛**（`goal/turn.ts` 的性质 ③：任何内部异常都变成
 *    `outcome: 'transport_failed'` 并如实进 trace）⇒ 让 provider 抛错，链就会
 *    **如实降级**而不是崩掉：这正是 C11-02/03 要测的那条路径。
 */
function withFault(
  provider: GoalUnderstandingProvider,
  fault: Lv2ImplementedFault | undefined,
): GoalUnderstandingProvider {
  if (fault === undefined || fault === 'double_trigger') return provider
  return {
    name: `${provider.name}+fault(${fault})`,
    version: provider.version,
    async call() {
      if (fault === 'provider_error') {
        throw new Error('injected_provider_error：提供方报错（C11-02 的故障面）')
      }
      /* `provider_timeout`：拒绝形状与运行器的 deadline 同族（链的结论同样是 `transport_failed`） */
      await new Promise((resolve) => setTimeout(resolve, 1))
      throw new Error('injected_provider_timeout：提供方超时（C11-03 的故障面）')
    },
  }
}

export async function createLv2CaseEnvironment(input: {
  label: string
  conversationId: string
  /**
   * `true` = **控制档**：目标理解端口也用脚本化 provider（**一个字节都不出网**）。
   *
   * ⚠️ 这个参数是**被一次真实事故逼出来的**：第一版只在"回复"那一层分控制/真实，
   *    而**目标域的理解端口**无论哪一档都用 `createOpenAiGoalUnderstandingProvider()` ⇒
   *    "0 次模型请求"的 preflight 实际上**真的出了网**（72 案 × 1 轮 = 72 次），
   *    而且因为没经 `pnpm with-test-model`，用的可能是 `.env` 的**生产 key**。
   *    ⇒ 修法：控制档**整条链**都不许有真 provider（见 §incident 的登记）。
   */
  control: boolean
  /** `LV2-D12`：本档是否跑**约定识别慢路径**（逐轮；与生产 `main.ts` 的轮次管线同位置）。 */
  slowPath?: boolean
  /** 本案例要求的故障注入（缺省 = 无）。**只接受已实现的那三种**（调用方先 fail closed）。 */
  fault?: Lv2ImplementedFault
  /** 仅用于实验端口故障控制；缺省接真实只读撤销集。 */
  withdrawnCompute?: () => Promise<WithdrawnSetResult>
}): Promise<Lv2CaseEnvironment> {
  const h = await createM4Harness({
    label: input.label,
    /* LV2-D10 ③：按**生产配置**（.env 的 CHARACTER_MEMORY_RESTATEMENT_ENABLED=true）
       注入放行口开关；缺了它，'同内容重述复活'在本批次里是关的（与生产不同形）。 */
    validatorFeatures: { restatementRevivalEnabled: true },
  })
  const characterId = h.kernel.characterId
  const goals = createM10TurnHarness({ db: h.db, characterId, userId: h.userId })
  let modelRequests = 0
  const goalDrafts: { input: unknown; output: unknown }[] = []
  const baseProvider: GoalUnderstandingProvider = input.control
    ? {
        name: 'lv2-control-goal',
        version: 'lv2-control@2',
        /*
         * 控制档的草案：**有活跃目标就报完成，否则什么都不做**。
         *
         * ⚠️ 第一版一律返回 `none` ⇒ "注入了故障所以没写成"与"控制档本来就不写"在读数上**长得一样**，
         *    于是 C11-02/03 会为**错误的理由**通过。第二版让它**会写**：
         *    这样"有故障 ⇒ 没写成 / 没故障 ⇒ 写成了"才是一对**有区分力**的对照（C11-04 的教训同族）。
         */
        async call() {
          const states = await goals.listStates()
          const active = states.find((state) => String(state.goal.status) === 'active')
          if (active === undefined) {
            return { schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: 'none' as const, span: { start: 0, end: 0 } }
          }
          return {
            schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
            operation: 'report_complete' as const,
            span: { start: 0, end: 1 },
            targetGoalId: String(active.goal.goalId),
          }
        },
      }
    : createOpenAiGoalUnderstandingProvider()
  const goalProvider = withFault(input.control ? baseProvider : {
    ...baseProvider,
    async call(call) {
      modelRequests += 1
      const output = await baseProvider.call(call)
      goalDrafts.push({ input: call.input, output })
      return output
    },
  }, input.fault)
  const goalRuntime = input.control ? deterministicRuntime() : createRealGoalUnderstandingRuntime()

  const memoryWriter = createLv2MemoryPath(h).port
  const recall = createRecallTurnPort({
    service: createMemoryRecallService({ port: createMemoryRetrievalStore({
      store: h.store,
      integrity: owner => memoryIntegrityProblems(h.db, owner),
      rootReadings: ids => rootReadingsByMemory(h.db, ids),
    }) }),
    budget: DEFAULT_CONTEXT_BUDGET,
    now: () => Date.now(),
  })
  const agreementFence = createLateWriteFence()
  const agreementAbort = new AbortController()
  let agreementInitialized = false

  let clock = 1_800_000_000_000
  /** prep 会话的序号（自推一格） */
  let prepSequence = 0
  /** `double_trigger` 的第二投结论（读数；其他故障面下为 null） */
  let doubleTriggerSecondOutcome: string | null = null
  const sources: Record<string, string> = {}

  const conversationId = asConversationId(`${input.conversationId}-live`)
  const recorderFor = (suffix: string): ConversationRecorder =>
    new ConversationRecorder({
      db: h.db,
      characterId,
      conversationId: suffix === 'live' ? conversationId : asConversationId(`${input.conversationId}-${suffix}`),
      dryRun: false,
      userId: h.userId,
      userName: 'Alex',
      characterName: '苏沐薇',
      transport: 'lv2-short-live',
      attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    })

  /** prep 用的确定性一轮（**不调模型**）：草案由夹具给出。 */
  async function scriptedTurn(
    text: string,
    draft: Record<string, unknown>,
    voice: { lastAssistantEventId?: string; lastAssistantText?: string } = {},
  ): Promise<{ outcome: string; sourceEventId: string }> {
    /*
     * ⚠️ prep 的会话序号由**本函数自己**推进（prep 不产生助手事件 ⇒ 一格一格走就行）。
     *    写死 `1` 会让 `seed_goal_completed` / `seed_commitment_closed` 的第二轮撞上第一轮的
     *    用户事件（`recordUserMessage` 的幂等探测把它当成本轮输入）—— 与
     *    `m4-harness.nextTurnSequence` 注释里记的那个坑**同族**。
     */
    prepSequence += 1
    const recorded = await recorderFor('prep').recordUserMessage(text, prepSequence)
    const sourceEventId = String(recorded.event!.id)
    sources[text] = sourceEventId
    const result = await goals.turn({
      currentInput: text,
      sourceEventId,
      now: ++clock,
      provider: {
        name: 'lv2-prep-scripted',
        version: 'lv2-prep@1',
        async call() {
          return draft
        },
      },
      runtime: deterministicRuntime(),
      ...(voice.lastAssistantEventId === undefined || voice.lastAssistantText === undefined
        ? {}
        : { lastAssistantEventId: voice.lastAssistantEventId, lastAssistantText: voice.lastAssistantText }),
    })
    return { outcome: String(result.outcome), sourceEventId }
  }

  async function seedMemory(memoryType: 'person_fact' | 'preference' | 'episode', predicate: string | undefined, value: string | undefined, sourceText: string, reuseExistingSource = false): Promise<void> {
    if (reuseExistingSource && sources[sourceText] === undefined) throw new Error('prep：要复用的原始来源尚未记录')
    const evidence = reuseExistingSource ? { ref: { kind: 'conversation_event' as const, id: sources[sourceText]! } } : await h.recordUserEvidence(sourceText)
    sources[sourceText] = String(evidence.ref.id)
    /*
     * ⚠️ `episode` 走**另一个内容家族**（`kind: 'episode'` + `participants` + `eventRefs`）：
     *    第一版给它塞了 `claim`，被放行口当场判死（"episode 属于 Episode 家族，但 content.kind = claim"）。
     *    形状抄 `m4-harness.buildStandardCorpus` 的 ⑤。
     */
    const candidate =
      memoryType === 'episode'
        ? h.makeCandidate(
            'episode',
            {
              kind: 'episode',
              summary: sourceText,
              participants: [h.user],
              eventRefs: [evidence.ref.id],
            } as never,
            { sourceRefs: [evidence.ref], epistemicStatus: 'observed' } as never,
          )
        : h.makeCandidate(
            memoryType,
            claim(h.user, predicate ?? 'note', value ?? sourceText),
            { sourceRefs: [evidence.ref] },
          )
    const record = await h.commitAndFold(candidate, ++clock)
    if (record === null) throw new Error(`prep：记忆未被放行：${sourceText}`)
  }

  async function prepare(prep: readonly Lv2Prep[]): Promise<Record<string, string>> {
    for (const step of prep) {
      switch (step.kind) {
        case 'seed_explicit_memory_corrected': {
          for (const text of [step.firstSourceText, step.correctionText]) {
            const recorded = await recorderFor('live').recordUserMessage(text,
              (await latestConversationSequence(h.db, characterId, conversationId)) + 1)
            sources[text] = String(recorded.event!.id)
            const result = await memoryWriter.handleTurn({ event: recorded.event!, owner: h.owner, speaker: h.user })
            if (result?.kind !== 'written') throw new Error(`prep：显式更正准备未写入（${result?.kind ?? 'no_intent'}）`)
          }
          break
        }
        case 'seed_memory':
          await seedMemory(step.memoryType, step.predicate, step.value, step.sourceText, step.reuseExistingSource)
          break
        case 'seed_memory_corrected': {
          await seedMemory(step.memoryType, step.predicate, step.oldValue, step.firstSourceText)
          const before = (await h.store.getActiveByCanonicalKey(
            (await h.store.listBySubject(h.owner, h.user)).find((record) => record.status === 'active' && contentOf(record).predicate === step.predicate)?.canonicalKey ?? '',
          ))
          const old = (await h.store.listBySubject(h.owner, h.user)).find(
            (record) => record.status === 'active' && contentOf(record).predicate === step.predicate,
          )
          if (old === undefined) throw new Error(`prep：更正找不到原记录（${step.predicate}）`)
          const evidence = await h.recordUserEvidence(step.correctionText)
          sources[step.correctionText] = String(evidence.event.id)
          const next = await h.commitAndFold(
            h.makeCandidate(step.memoryType, claim(h.user, step.predicate, step.newValue), { sourceRefs: [evidence.ref] }),
            ++clock,
          )
          if (next === null) throw new Error(`prep：更正的新值未被放行（${step.predicate}）`)
          void before
          await h.applyStateChange(
            'supersede',
            String(evidence.event.id),
            { memoryId: old.id, supersededBy: next.id, validUntil: ++clock, reason: step.correctionText },
            ++clock,
          )
          break
        }
        case 'seed_memory_forgotten': {
          await seedMemory(step.memoryType, step.predicate, step.value, step.sourceText)
          const target = (await h.store.listBySubject(h.owner, h.user)).find(
            (record) => record.status === 'active' && contentOf(record).predicate === step.predicate,
          )
          if (target === undefined) throw new Error(`prep：遗忘找不到目标（${step.predicate}）`)
          const forget = await h.recordUserEvidence(step.forgetText)
          sources[step.forgetText] = String(forget.event.id)
          await h.applyStateChange(
            'retract',
            String(forget.event.id),
            { memoryId: target.id, reason: 'explicit_forget', note: step.forgetText },
            ++clock,
          )
          break
        }
        case 'seed_goal':
          await scriptedTurn(step.sourceText, {
            schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
            operation: 'create',
            span: spanOf(step.sourceText),
            statement: step.statement,
            origin: 'user_requested',
          })
          break
        case 'seed_goal_completed': {
          await scriptedTurn(step.sourceText, {
            schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
            operation: 'create',
            span: spanOf(step.sourceText),
            statement: step.statement,
            origin: 'user_requested',
          })
          const row = (await goals.listStates()).find((state) => state.goal.statement === step.statement)
          if (row === undefined) throw new Error(`prep：目标没有建出来（${step.statement}）`)
          await scriptedTurn(step.reportText, {
            schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
            operation: 'report_complete',
            span: spanOf(step.reportText),
            targetGoalId: String(row.goal.goalId),
          })
          break
        }
        case 'seed_commitment': {
          await scriptedTurn(step.sourceText, {
            schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
            operation: 'create',
            span: spanOf(step.sourceText),
            statement: step.statement,
            origin: 'user_requested',
            commitment: { scope: step.statement, criterion: { kind: 'user_report' } },
          })
          break
        }
        case 'seed_commitment_closed': {
          await scriptedTurn(step.sourceText, {
            schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
            operation: 'create',
            span: spanOf(step.sourceText),
            statement: step.statement,
            origin: 'user_requested',
            commitment: { scope: step.statement, criterion: { kind: 'user_report' } },
          })
          const row = (await goals.listStates()).find((state) => state.goal.statement === step.statement)
          if (row === undefined) throw new Error(`prep：目标没有建出来（${step.statement}）`)
          const commitment = row.commitment
          if (commitment === null || commitment === undefined) {
            throw new Error(`prep：承诺没有建出来（${step.statement}）`)
          }
          const report = await h.recordUserEvidence(step.reportText)
          sources[step.reportText] = String(report.event.id)
          const sourceId = String(report.event.id)
          const closed = await goals.applyProposal(
            goalProposalOf({
              proposalId: `lv2-prep-fulfill-${step.statement}`,
              operation: 'complete',
              characterId: String(characterId),
              processor: 'lv2-prep',
              processorVersion: 'lv2-prep@1',
              sourceConversationEventIds: [sourceId],
              sourceQualifications: [{ eventId: sourceId, qualification: 'ESTABLISHED' }],
              targets: [
                {
                  type: 'GOAL_COMPLETED',
                  operation: 'update',
                  scope: 'CHARACTER_INTERNAL',
                  payload: {
                    characterId: String(characterId),
                    goalId: String(row.goal.goalId),
                    expectedRevision: row.goal.revision,
                    basis: 'user_report',
                    evidenceRefs: [
                      { conversationEventId: sourceId, span: spanOf(step.reportText), fingerprint: goalSpanFingerprint(step.reportText) },
                    ],
                  },
                },
                {
                  type: 'COMMITMENT_FULFILLED',
                  operation: 'update',
                  scope: 'CHARACTER_INTERNAL',
                  payload: {
                    characterId: String(characterId),
                    goalId: String(row.goal.goalId),
                    commitmentId: String(commitment.commitmentId),
                    expectedRevision: commitment.revision,
                    basis: 'user_report',
                    resultRefs: [{ conversationEventId: sourceId, fingerprint: goalSpanFingerprint(step.reportText) }],
                  },
                },
              ],
            }),
            ++clock,
          )
          if (!closed.accepted) throw new Error(`prep：结清被拒（${closed.rejectedCodes.join(',')}）`)
          break
        }
        case 'seed_turns': {
          const recorder = recorderFor('window')
          let sequence = 0
          let lastUserEventId: string | undefined
          for (const line of step.lines) {
            sequence += 1
            if (line.actor === 'user') {
              const recorded = await recorder.recordUserMessage(line.text, sequence)
              sources[line.text] = String(recorded.event!.id)
              lastUserEventId = String(recorded.event!.id)
            } else {
              /*
               * ⚠️ 角色行**必须**带 `replyToEventId`（M3 的账本不变量：这条回复在回应什么）。
               *    第一版传 `undefined` ⇒ 被账本当场拒（"assistant_message 必须带 replyToEventId"）。
               */
              if (lastUserEventId === undefined) throw new Error('seed_turns：角色行前面没有用户行')
              await recorder.recordAssistantMessage({
                text: line.text,
                conversationSequence: sequence,
                characterSequence: sequence,
                replyToEventId: lastUserEventId as never,
              })
            }
          }
          break
        }
      }
    }
    return { ...sources }
  }

  async function runTurn(
    text: string,
    options: { control: boolean; turnIndex: number },
  ): Promise<Lv2TurnReading> {
    const requestsBefore = modelRequests
    /* 首启边界在本案 prep 之后、真实对话之前建立，避免单轮用例只做 cutover。 */
    if (input.slowPath === true && !agreementInitialized) {
      await runAgreementSlowPath({ h }, { control: options.control, fence: agreementFence, signal: agreementAbort.signal })
      agreementInitialized = true
    }
    const recorder = recorderFor('live')
    /*
     * ⚠️ 会话内序号要**从这个会话自己的账本**推（`latestConversationSequence` + 1）：
     *    · 写死 `1`：多轮案的第二轮会撞上第一轮的助手事件 ⇒ `observation_input_mismatch`（真不变量抓到）
     *    · 用 `h.nextTurnSequence`：那个计数器是**夹具自己那条会话**的，与本案会话无关 ⇒ 序号跳空被拒
     *    ⇒ 只有"按本会话 max 推下一格"两边都对。
     */
    const conversationSequence = (await latestConversationSequence(h.db, characterId as never, conversationId as never)) + 1
    const gateway = new TurnGateway({
      kernel: h.kernel,
      definition: h.kernel.definition,
      identity: h.kernel.identitySnapshot,
      recorder,
      conversationSequence: () => conversationSequence,
      recentLimit: 16,
      slowPathEnabled: false,
      userId: h.userId,
      recallBudget: {
        ...DEFAULT_CONTEXT_BUDGET,
        goalTokens: LV2_CANDIDATE_CONFIG.goalTokens,
        commitmentTokens: LV2_CANDIDATE_CONFIG.commitmentTokens,
        adaptiveSelfTokens: LV2_CANDIDATE_CONFIG.adaptiveSelfTokens,
        rollupTokens: LV2_CANDIDATE_CONFIG.rollupTokens,
      },
      memoryWriter,
      memoryExplicitEnabled: LV2_CANDIDATE_CONFIG.explicitMemory,
      recall,
      recallEnabled: LV2_CANDIDATE_CONFIG.recall,
      commitmentFactRows: async () => commitmentFactRowsOf(await listGoalStates(h.db, characterId)),
    })
    /*
     * ⚠️ **不要自己先记一遍用户消息**：`beginTurn(userText)` **自己就会落库**（`turn-gateway.ts:845`）。
     *    第一版手动记 + beginTurn 再记一次 ⇒ 第二轮撞上
     *    "显式输入与该轮 Observation 派生出的文本不一致"（`observation_input_mismatch`，
     *    那是**真不变量**：显式输入与事件派生的文本必须一致，失败关闭）。
     * ⚠️ 会话内序号必须**连续**：`conversationSequence()` 用一个跨轮的计数器（beginTurn 里调一次）。
     */
    const turn = await gateway.beginTurn(text)
    const sourceEventId = String(turn.userEvent?.id ?? '')
    if (sourceEventId !== '') sources[text] = sourceEventId
    const recentLines = await recentContextLinesFrom(h.runtime, {
      characterId: characterId as never,
      userName: 'Alex',
      characterName: '苏沐薇',
      limit: 18,
    })
    /*
     * ⚠️ `runGoalTurn` 是**compileTurn** 的选项，不是构造器选项（与 `src/main.ts:2277` 同一处）。
     *    在构造器里传它会被 TS 拒（真实踩到过）。
     */
    let goalReading: { outcome: string; operation: string | null; rejectionCodes: readonly string[] } | undefined
    const runGoalTurn = async (info: {
      readonly currentInput: string
      readonly sourceEventId: string
      readonly lastAssistantEventId?: string
      readonly lastAssistantText?: string
    }) => {
      /* 撤销集**每轮重算**（与 `goal-input-store.ts` 的 D16 端口同一条：读时派生，不缓存） */
      const withdrawn = await computeWithdrawnEvidence(h.db, h.store, h.owner)
      const goalTurn = await goals.turn({
        currentInput: info.currentInput,
        sourceEventId: info.sourceEventId,
        now: ++clock,
        provider: goalProvider,
        runtime: goalRuntime,
        withdrawnEventIds: new Set(withdrawn.withdrawnEventIds),
        ...(info.lastAssistantEventId === undefined || info.lastAssistantText === undefined
          ? {}
          : { lastAssistantEventId: info.lastAssistantEventId, lastAssistantText: info.lastAssistantText }),
      })
      /*
       * **`double_trigger`**：同一个用户事件被**再投一次**（第二个处理器也扫到了它）。
       * 期望：只写一次终态（幂等）—— 第二次的结论记进读数，供断言与复核。
       */
      if (input.fault === 'double_trigger') {
        const second = await goals.turn({
          currentInput: info.currentInput,
          sourceEventId: info.sourceEventId,
          now: ++clock,
          provider: goalProvider,
          runtime: goalRuntime,
          withdrawnEventIds: new Set(withdrawn.withdrawnEventIds),
        })
        doubleTriggerSecondOutcome = String(second.outcome)
      }
      goalReading = { outcome: goalTurn.outcome, operation: goalTurn.trace.proposal.operation ?? null,
        rejectionCodes: goalTurn.trace.validation.rejectionCodes }
      const states = await listGoalStates(h.db, characterId)
      return {
        turn: goalTurn,
        contextState: {
          ordered: orderGoalsForFocus(states.map((state) => state.goal)).ordered.map((goal) => ({
            goal,
            rowKey: `goal:${String(goal.goalId)}`,
          })),
          withdrawnEventIds: new Set(withdrawn.withdrawnEventIds),
        },
      }
    }
    const packet = await gateway.compileTurn({
      turn,
      currentInput: text,
      recentLines,
      runGoalTurn,
      ...(LV2_CANDIDATE_CONFIG.withdrawnMasking
        ? { withdrawnMasking: { compute: input.withdrawnCompute ?? (() => computeWithdrawnEvidence(h.db, h.store, h.owner)) } }
        : {}),
    })
    const prompt = gateway.promptFor(packet)
    let reply = ''
    let modelDurationMs = 0
    let completed = false
    const commitmentClaimCorrected = false
    let slowPathReading: Lv2SlowPathReading | undefined
    try {
      let response: { text: string; durationMs: number }
      if (options.control) {
        response = { text: '（离线运行器控制回复：只验管线，不计读数）', durationMs: 0 }
      } else {
        modelRequests += 1
        response = await callModelText(h.runtime, prompt)
      }
      const memoryTruth = applyResponseTruthPolicy({ result: turn.memoryWriteResult, replyText: response.text })
      const actionTruth = applyActionClaimGuard({
        results: turn.actionResults?.flatMap((row) => (row.result ? [row.result] : [])) ?? [],
        replyText: memoryTruth.replyText,
      })
      const search = searchFactOf(turn.actionResults)
      const evidenceTruth = applyExternalEvidenceReplyPolicy({
        ...(search ? { search } : {}),
        ...(turn.externalEvidenceInContext ? { reality: turn.externalEvidenceInContext } : {}),
        replyText: actionTruth.replyText,
      })
      reply = applySearchNeedReplyPolicy({
        ...searchNeedDiagnosticsOf(turn.actionResults),
        searchState: evidenceTruth.state,
        replyText: evidenceTruth.replyText,
      }).replyText
      modelDurationMs = response.durationMs
      await gateway.completeTurn({ turn, replyText: reply, modelDurationMs })
      completed = true
      /*
       * `LV2-D12`：约定识别**慢路径**在回复之后跑（与生产同序：`src/main.ts` 的轮次管线里也是这个位置）。
       * 控制档用桩 provider ⇒ **0 次模型调用**；真实档用生产同款 provider，并**逐次计数**（两档分开记账）。
       */
      if (input.slowPath === true) {
        slowPathReading = await runAgreementSlowPath({ h }, { control: options.control, fence: agreementFence, signal: agreementAbort.signal })
      }
    } catch (error) {
      reply = `<transport_failed: ${(error as Error).message}>`
    }
    return {
      currentInput: text,
      reply,
      controlReply: options.control,
      traceId: String(turn.traceId),
      sectionIds: packet.sections.map((section) => section.id),
      promptSha256Prefix: sha(prompt),
      prompt,
      goalDrafts: goalDrafts.splice(0),
      completed,
      modelDurationMs,
      modelRequests: modelRequests - requestsBefore + (slowPathReading?.modelCalls ?? 0),
      writeReality: {
        goalEventTypes: turn.goalWriteReality?.acceptedEventTypes ?? [],
        memoryOutcome: turn.memoryWriteResult?.kind ?? null,
        commitmentClaimCorrected,
        goalOutcome: goalReading?.outcome ?? null,
        goalOperation: goalReading?.operation ?? null,
        goalRejectionCodes: goalReading?.rejectionCodes ?? [],
      },
      doubleTriggerSecondOutcome,
      slowPath:
        slowPathReading === undefined
          ? null
          : { kind: slowPathReading.kind, result: slowPathReading.result, modelCalls: slowPathReading.modelCalls },
    }
  }

  async function snapshot(): Promise<Lv2Snapshot> {
    const records = await h.store.list({ owner: h.owner, limit: 500 })
    const states = await goals.listStates()
    const events = await domainEventsFor(h.db, characterId)
    const withdrawn = await computeWithdrawnEvidence(h.db, h.store, h.owner)
    return {
      memories: records.map((record) => ({
        id: String(record.id),
        status: String(record.status),
        predicate: contentOf(record).predicate,
        value: contentOf(record).value,
        canonicalKey: record.canonicalKey ?? null,
      })),
      goals: states.map((state) => ({ statement: state.goal.statement, status: String(state.goal.status) })),
      commitments: states
        .filter((state) => state.commitment !== undefined && state.commitment !== null)
        .map((state) => ({ statement: state.goal.statement, status: String(state.commitment!.status) })),
      eventTypes: events.map((event) => String(event.type)),
      withdrawnEventIds: [...withdrawn.withdrawnEventIds],
    }
  }

  return {
    h,
    goals,
    characterId: String(characterId),
    prepare,
    runTurn,
    snapshot,
    async close() {
      agreementFence.close()
      agreementAbort.abort()
      await h.stop()
    },
  }
}

/** 从 `MemoryRecord` 里取 `{predicate, value}`（`episode` 没有谓词 ⇒ null）。 */
function contentOf(record: { content?: unknown; canonicalKey?: string | null }): {
  predicate: string | null
  value: string | null
} {
  const content = record.content as { predicate?: unknown; value?: unknown } | undefined
  return {
    predicate: typeof content?.predicate === 'string' ? content.predicate : null,
    value: typeof content?.value === 'string' ? content.value : null,
  }
}

function spanOf(text: string): { start: number; end: number } {
  return { start: 0, end: [...text].length }
}

function sha(text: string): string {
  // 轻量指纹：只用于"这一轮的 prompt 是哪一份"（不进任何判据）
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/* ---------------------------------------------------------------------------
 * 断言求值（**纯函数**：吃一份快照，吐一条判定）
 * ------------------------------------------------------------------------- */

export interface Lv2AssertionContext {
  readonly sourceEventIds: Readonly<Record<string, string>>
  readonly beforeEventTypes: readonly string[]
  readonly beforeCommitmentRows: number
  readonly lastTurn?: Lv2TurnReading
  readonly identityFingerprint: string
  readonly beforeIdentityFingerprint: string
}

export interface Lv2AssertionResult {
  readonly kind: string
  readonly pass: boolean
  readonly expected: string
  readonly observed: unknown
}

export function evaluateAssertion(
  assertion: Lv2ProgramAssertion,
  snapshot: Lv2Snapshot,
  context: Lv2AssertionContext,
): Lv2AssertionResult {
  const active = snapshot.memories.filter((record) => record.status === 'active')
  switch (assertion.kind) {
    case 'active_memory_value': {
      const found = active.filter((record) => record.predicate === assertion.predicate)
      const pass =
        assertion.value === null
          ? found.length === 0
          : found.some((record) => record.value === assertion.value)
      return {
        kind: assertion.kind,
        pass,
        expected: `槽位 ${assertion.predicate} 当前值 ${assertion.value === null ? '为空' : `= ${assertion.value}`}`,
        observed: found.map((record) => record.value),
      }
    }
    case 'active_memory_value_anywhere': {
      const pass = active.some((record) => record.value === assertion.value)
      return {
        kind: assertion.kind,
        pass,
        expected: `存在活跃记忆 = ${assertion.value}`,
        observed: active.map((record) => `${String(record.predicate)}=${String(record.value)}`).slice(0, 12),
      }
    }
    case 'no_active_memory_value_anywhere': {
      const hits = active.filter((record) => record.value === assertion.value)
      return {
        kind: assertion.kind,
        pass: hits.length === 0,
        expected: `没有任何活跃记忆 = ${assertion.value}`,
        observed: hits.map((record) => `${String(record.predicate)}=${String(record.value)}`),
      }
    }
    case 'active_memory_value_not': {
      const found = active.filter((record) => record.predicate === assertion.predicate)
      const pass = found.length > 0 && found.every((record) => record.value !== assertion.value)
      return {
        kind: assertion.kind,
        pass,
        expected: `槽位 ${assertion.predicate} 有活跃值且 ≠ ${assertion.value}`,
        observed: found.map((record) => record.value),
      }
    }
    case 'memory_status': {
      const found = snapshot.memories.filter((record) => record.predicate === assertion.predicate)
      const statuses = found.map((record) => String(record.status))
      const pass =
        assertion.status === 'none' ? found.length === 0 : statuses.includes(assertion.status)
      return { kind: assertion.kind, pass, expected: `${assertion.predicate} 状态 = ${assertion.status}`, observed: statuses }
    }
    case 'goal_status': {
      const found = snapshot.goals.filter((goal) => goal.statement === assertion.statement)
      const statuses = found.map((goal) => goal.status)
      const pass = assertion.status === 'none' ? found.length === 0 : statuses.includes(assertion.status)
      return { kind: assertion.kind, pass, expected: `目标「${assertion.statement}」= ${assertion.status}`, observed: statuses }
    }
    case 'goal_status_matching': {
      const found = snapshot.goals.filter((goal) => goal.statement.includes(assertion.contains))
      const pass = found.some((goal) => goal.status === assertion.status)
      return {
        kind: assertion.kind,
        pass,
        expected: `存在含「${assertion.contains}」的目标且状态 = ${assertion.status}`,
        observed: found.map((goal) => `${goal.statement}:${goal.status}`),
      }
    }
    case 'commitment_status': {
      const found = snapshot.commitments.filter((entry) => entry.statement === assertion.statement)
      const statuses = found.map((entry) => entry.status)
      const pass = assertion.status === 'none' ? found.length === 0 : statuses.includes(assertion.status)
      return { kind: assertion.kind, pass, expected: `承诺「${assertion.statement}」= ${assertion.status}`, observed: statuses }
    }
    case 'commitment_status_matching': {
      const found = snapshot.commitments.filter((entry) => entry.statement.includes(assertion.contains))
      const pass = found.some((entry) => entry.status === assertion.status)
      return {
        kind: assertion.kind,
        pass,
        expected: `存在含「${assertion.contains}」的承诺且状态 = ${assertion.status}`,
        observed: found.map((entry) => `${entry.statement}:${entry.status}`),
      }
    }
    case 'commitment_rows': {
      const pass = snapshot.commitments.length === assertion.expected
      return { kind: assertion.kind, pass, expected: `承诺行 = ${String(assertion.expected)}`, observed: snapshot.commitments.length }
    }
    case 'event_delta': {
      const before = context.beforeEventTypes.filter((type) => type === assertion.eventType).length
      const after = snapshot.eventTypes.filter((type) => type === assertion.eventType).length
      const pass = after - before === assertion.delta
      return { kind: assertion.kind, pass, expected: `${assertion.eventType} +${String(assertion.delta)}`, observed: after - before }
    }
    case 'event_delta_prefix': {
      const before = context.beforeEventTypes.filter((type) => type.startsWith(assertion.prefix)).length
      const after = snapshot.eventTypes.filter((type) => type.startsWith(assertion.prefix)).length
      const pass = after - before === assertion.delta
      return { kind: assertion.kind, pass, expected: `${assertion.prefix}* +${String(assertion.delta)}`, observed: after - before }
    }
    case 'withdrawn_contains_source': {
      const id = context.sourceEventIds[assertion.sourceText]
      const pass = id !== undefined && snapshot.withdrawnEventIds.includes(id)
      return {
        kind: assertion.kind,
        pass,
        expected: `撤销集包含「${assertion.sourceText}」`,
        observed: { sourceEventId: id ?? null, withdrawnCount: snapshot.withdrawnEventIds.length },
      }
    }
    case 'identity_unchanged': {
      const pass = context.identityFingerprint === context.beforeIdentityFingerprint
      return { kind: assertion.kind, pass, expected: '身份指纹未变', observed: context.identityFingerprint }
    }
    case 'section_present': {
      const pass = context.lastTurn?.sectionIds.includes(assertion.sectionId) === true
      return { kind: assertion.kind, pass, expected: `section ${assertion.sectionId} 在场`, observed: context.lastTurn?.sectionIds ?? [] }
    }
    case 'section_absent': {
      const pass = context.lastTurn?.sectionIds.includes(assertion.sectionId) !== true
      return { kind: assertion.kind, pass, expected: `section ${assertion.sectionId} 不在场`, observed: context.lastTurn?.sectionIds ?? [] }
    }
    case 'capability_set_unchanged': {
      /*
       * 能力集合在本批次是**常量**（`LV2_NOT_WIRED` 之外的都没装）：
       * 断言退化成"没有出现任何能力/工具相关事件"。它不是空断言 ——
       * 若某一轮真的写入了 capability/adapter 事件，这里会红。
       */
      const forbidden = snapshot.eventTypes.filter(
        (type) => type.startsWith('CAPABILITY') || type.startsWith('ADAPTER') || type.startsWith('ACTION_'),
      )
      return { kind: assertion.kind, pass: forbidden.length === 0, expected: '能力集合未变（无能力/适配器/动作事件）', observed: forbidden }
    }
  }
}

/** 本轮相对上一份快照的"新增事件类型"（`event_delta` 用它做基线）。 */
export function caseIdentityFingerprint(caseId: string, conversationId: string, round: number): string {
  return sha(`${caseId}|${conversationId}|${String(round)}`)
}

/**
 * `LV2-D12`：**约定识别的慢路径**（快慢两档的"慢"那一档）。
 *
 * 规格来源：`docs/lv2/Lv2-WP1-Freeze-Record.md` 的 `LV2-D12` 节（对照 `src/main.ts:2975` 逐字）。
 * ⚠️ 两档**分别判定** —— 慢路径成功不能替代快路径失败。
 * ⚠️ 控制档用**桩 provider**（返回 `{kind:'none'}`）⇒ 0 次模型调用；真实档用生产同款
 *    `createOpenAiAgreementDraftProvider()`，并**逐次计数**（供两档分开记账）。
 */
export interface Lv2SlowPathReading {
  readonly enabled: boolean
  readonly kind: string
  readonly result: string | null
  readonly modelCalls: number
}

export async function runAgreementSlowPath(
  environment: Pick<Lv2CaseEnvironment, 'h'>,
  options: { readonly control: boolean; readonly fence: LateWriteFence; readonly signal: AbortSignal },
): Promise<Lv2SlowPathReading> {
  const db = environment.h.db
  const characterId = environment.h.kernel.characterId
  const activeUserId = environment.h.userId
  let modelCalls = 0
  const provider = options.control
    ? {
        name: 'lv2-control-agreement',
        version: 'lv2-control@1',
        async call(): Promise<unknown> {
          return { schemaVersion: AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION, kind: 'none' }
        },
      }
    : (() => {
        const real = createOpenAiAgreementDraftProvider() as unknown as {
          name: string
          version: string
          call: (input: never) => Promise<unknown>
        }
        return {
          name: real.name,
          version: real.version,
          async call(input: never): Promise<unknown> {
            modelCalls += 1
            return real.call(input)
          },
        }
      })()
  const withdrawn = await computeWithdrawnEvidence(db, environment.h.store, environment.h.owner)
  const outcome = await runConfiguredAgreementTail(db, {
    characterId,
    activeUserId,
    enabled: true,
    provider,
    fence: options.fence,
    signal: options.signal,
    withdrawnEventIds: new Set(withdrawn.withdrawnEventIds),
  })
  return { enabled: true, kind: outcome.kind, result: 'result' in outcome ? outcome.result : null, modelCalls }
}
