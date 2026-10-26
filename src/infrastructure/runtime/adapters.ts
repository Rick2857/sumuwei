/**
 * ElizaOS Runtime 适配器。
 *
 * ============================================================================
 *  依赖方向的**唯一**跨越点
 * ============================================================================
 *
 *     Runtime / Transport  →  Application  →  Domain
 *                                                  ▲
 *                                      Infrastructure（本文件在最外层）
 *
 * 本文件是唯一同时认识"两边"的地方：
 *   · 一边是 Character Kernel 的契约（ContextCompileInput / ProjectionRevision）
 *   · 一边是 ElizaOS 的运行时概念（providers / composeState / useModel）
 *
 * 它导出的都是**纯函数式的小适配器**，而不是一个大对象：
 * 这样 main.ts 里能看清每一步在做什么，也方便单独测试
 * （例如"最近事件是否被正确投影成 Context line"不需要启动 runtime）。
 */


/* ⚠️ `ModelType` 已从 ElizaOS 独立出来（M12 · W2-③）；取值逐字抄自上游。 */
import type { AgentRuntime, Memory } from './eliza-types.ts'
import { ModelType } from './eliza-vocabulary.ts'

import {
  asCharacterId,
  asEntityId,
  createProposal,
  entityRef,
  type CharacterId,
  type ContextCompileInput,
  type ConversationId,
} from '../../kernel/contracts/index.ts'
import { createFullDomainEventRegistry, RELATIONSHIP_ORIGIN } from '../../kernel/contracts/domain-event.ts'
import {
  effectiveRelationship,
  renderRelationshipGuidance,
  RELATIONSHIP_ORIGIN_PROPOSAL_TYPE,
  type RelationshipOriginKind,
  type RelationshipOriginPayload,
} from '../../kernel/contracts/relationship.ts'
import { NEW_USER_INITIAL_RELATIONSHIP } from '../../kernel/contracts/scope.ts'
import {
  effectiveAffect,
  renderAffectGuidance,
} from '../../kernel/contracts/affect.ts'
import { validateRelationshipProposal } from '../../kernel/policies/relationship-validator.ts'
import { relationshipReducerFor } from '../../kernel/projections/relationship.ts'
import type { ConversationLine } from '../../kernel/context/sections.ts'
import { resolveCurrentState, renderStateBlock } from '../../state/provider.ts'
import { recentConversationEvents } from '../persistence/conversation-store.ts'
import {
  applyAcceptedEvents,
  getDomainEvent,
} from '../persistence/event-store.ts'
import { hasProcessedOperation } from '../persistence/job-store.ts'
import { getRelationshipProjection } from '../persistence/relationship-store.ts'
import { getAffectProjection } from '../persistence/affect-store.ts'
import {
  getBeliefOrigin,
  listBeliefsByStatus,
} from '../persistence/belief-store.ts'
import { createNativeMemoryStore } from '../persistence/memory-store.ts'
import { currentReadScope } from '../persistence/read-scope.ts'
import { sql } from 'drizzle-orm'
import { exec } from '../persistence/db.ts'
import { domainEventsFor } from '../persistence/event-store.ts'
import { getWatermark, listJobs } from '../persistence/job-store.ts'
import {
  applyInvalidationOverlay,
  recheckBeliefDependencies,
  type BeliefUsabilityVerdict,
} from '../../kernel/app/belief/eligibility.ts'
import {
  BELIEF_INTERACTION_EVALUATOR_NAME,
  BELIEF_INTERACTION_EVALUATOR_VERSION,
} from '../../kernel/app/belief/evaluator.ts'
import {
  BELIEF_MEMORY_RECONCILER_NAME,
  BELIEF_MEMORY_RECONCILER_VERSION,
} from '../../kernel/app/belief/job.ts'
import { createBeliefJobPorts } from './belief-scheduler.ts'
import { isEblReplacedInference, renderBeliefSection } from '../../kernel/contracts/belief-renderer.ts'
import type { BeliefSectionBuildResult } from '../../kernel/app/turn-gateway.ts'
import { readEblHumanContext } from './epistemic-human-context.ts'

// ---------------------------------------------------------------------------
// 关键状态 → Context section
// ---------------------------------------------------------------------------

/**
 * 把"她此刻的状态"渲染成 section 内容。
 *
 * 复用的是 M2 已经调好的确定性映射（`renderStateBlock`）——
 * **不新写一套措辞**。原因：那套措辞经过 L1-M2 验收，
 * 而且它是"数值 → 语义 → 行为倾向"的可审计链条，
 * 换一套就等于把 M2 的行为改掉（M2.5 不允许）。
 */
export async function renderCriticalStateSection(
  runtime: AgentRuntime,
  characterId: string,
  userId: string,
  opts: { relationshipAxes?: boolean; affectAxes?: boolean } = {}
): Promise<{ text: string; sourceRefs: string[] } | undefined> {
  const { state, decayNote } = await resolveCurrentState(runtime, characterId, userId)
  /*
   * M7 / ADR-064 D-6（桥接）：`relationshipAxes: false` = 关系轴退役——
   * trust/closeness 改由 M7 关系注入块唯一渲染（无双权威）。
   * M8 / ADR-066 M8-D12（桥接第二半）：`affectAxes: false` = 情绪轴退役——
   * valence/arousal 改由 M8 情绪注入块唯一渲染（无双权威）。
   * 两者缺省 true = M2 验收形态逐字不变（开关关闭时的回滚形态）。
   */
  const text = renderStateBlock(state, decayNote, opts)
  if (text.trim() === '') return undefined
  return {
    text,
    sourceRefs: [
      `projection:character-state:v${state.version}`,
      `projection:character-state:updated:${state.updatedAt}`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 最近事件 → Context line
// ---------------------------------------------------------------------------

/**
 * 从事实账本取最近事件并转成 Context line。
 *
 * 说话人解析在这里完成：**领域层不知道用户叫什么**，也不该知道。
 *
 * ---------------------------------------------------------------------------
 *  post-Lv2 / ADR-109 `D04`：**入口作用域**（`conversationId` 可选）
 * ---------------------------------------------------------------------------
 * ```text
 * 不传 conversationId ⇒ 该角色的**全部会话**（按角色级序号合并）—— M3 起的行为
 * 传   conversationId ⇒ 只有这一条会话 —— 近期窗口按入口分开
 * ```
 * ⚠️ 缺省**不传**是刻意的：`--dump-prompt`、干跑与所有既有门走的就是这条路，
 *    它们的行为必须与接线前**逐字相同**。装配层（`main.ts`）在
 *    `CHARACTER_ENTRY_SCOPED_CONVERSATIONS` 打开时才会传进来。
 * ⚠️ 数据里只有一条会话时（今天生产的真实形状），传与不传**返回同一批行** ——
 *    这正是"打开开关不改变单入口历史"的机器理由。
 */
export async function recentContextLinesFrom(
  runtime: AgentRuntime,
  options: {
    characterId: CharacterId
    userName: string
    characterName: string
    limit: number
    /** 只看这一条会话（不传 = 该角色的全部会话，M3 起的行为） */
    conversationId?: ConversationId
    imagesOnly?: boolean
  }
): Promise<ConversationLine[]> {
  const db = getDb(runtime)
  const events = await recentConversationEvents(db, {
    characterId: options.characterId,
    limit: options.limit,
    ...(options.imagesOnly ? { imagesOnly: true } : {}),
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
  })
  const names = new Map<string, string>()
  if (currentReadScope()?.context.room.kind === 'group') {
    const rows = await exec(db, sql`select user_id, display_name from user_identities`, 'group speaker names')
    rows.forEach(row => names.set(String(row.user_id), String(row.display_name ?? row.user_id)))
  }
  return events.map((event) => ({
    id: event.id,
    createdAt: event.createdAt,
    sequence: event.sequence,
    speaker:
      event.actorType === 'user'
        ? names.get(String(event.actorId)) ?? options.userName
        : event.actorType === 'character'
          ? options.characterName
          : '系统',
    text: event.content,
    ...(Array.isArray(event.metadata?.imageRefs) ? {
      conversationId: String(event.conversationId),
      imageRefs: event.metadata.imageRefs.filter((ref): ref is string => typeof ref === 'string' && /^image:sha256:[a-f0-9]{64}$/.test(ref)),
    } : {}),
    /*
     * M9.1 / ADR-072 D18：类别与回复指向进 ConversationLine。
     * · actorType：遮蔽判定区分 user 行（id 命中）与 assistant 行（replyTo 命中）；
     * · replyToEventId：她的回复行指向哪条用户事件（P03 派生面判据）。
     * 两者缺席时遮蔽函数按「不命中」处理（保守面：不遮 assistant 行）。
     */
    ...(event.actorType !== undefined ? { actorType: event.actorType } : {}),
    ...(event.replyToEventId !== undefined ? { replyToEventId: event.replyToEventId } : {}),
  }))
}

// ---------------------------------------------------------------------------
// Provider 白名单
// ---------------------------------------------------------------------------

/**
 * 新链路（ContextCompiler）实际使用的 provider。
 *
 * ============================================================================
 *  为什么要白名单，而不是"让所有 provider 都进"
 * ============================================================================
 * 不加白名单时，`composeState` 会把 bootstrap 注册的**全部** provider 塞进
 * `state.text`。实测一轮的贡献是：
 *
 *     ACTIONS(2545) CHARACTER(697) PROVIDERS(488) ANXIETY(323)
 *     CHARACTER_STATE(252) RECENT_MESSAGES(208) TIME(155) ROLES(93)
 *     SETTINGS(67) ACTION_STATE(37) CHOICE(34)        → prompt 8808 字符
 *
 * 其中三类对本项目**没有意义**：
 *   · `ACTIONS` / `ACTION_STATE` / `CHOICE` / `PROVIDERS` —— 是工具调用体系的
 *     提示词。苏沐薇现在没有任何 action（Lv2 才做），这几千字符只是噪声，
 *     还会诱导模型朝"输出动作"的方向走。
 *   · `ANXIETY` —— bootstrap 自带的一个心理状态 provider，与本项目自己的
 *     `CHARACTER_STATE`（情绪/关系）语义重复，且数值来源不同。
 *   · `SETTINGS` —— 见下。
 *
 * 加白名单后：贡献变成 CHARACTER / CHARACTER_STATE / RECENT_MESSAGES /
 * TIME / ROLES，prompt 8808 → 5308 字符（省约 40%）。
 *
 * ### 顺带修掉一个每次启动都刷的报错
 *
 * `SETTINGS` provider 把 DM 房间当作"首次引导(onboarding)"，然后去找
 * **属于该用户的、且 metadata.settings 已初始化**的 world。
 * 我们的 world 是 `ensureWorldExists` 用角色身份建的（owner = 角色，不是用户），
 * 所以它必然找不到，于是抛：
 *
 *     [PLUGIN:BOOTSTRAP:PROVIDER:SETTINGS] No world found for user during onboarding
 *     [PLUGIN:BOOTSTRAP:PROVIDER:SETTINGS] Critical error in settings provider
 *       (error=No server ownership found for onboarding)
 *
 * 这个 provider 只提供"服务器/世界级配置"，本项目从不使用，
 * 出错后返回空文本、不影响其余 provider（实测回复与记忆写入都正常）。
 * 但它每次启动刷两条 error，会掩盖真正的错误 —— 白名单把它排除掉，
 * 是**顺势**而非"为了消音而消音"：它确实不该在这条链路里。
 */
export const CONVERSATION_PROVIDERS = [
  'CHARACTER',
  'CHARACTER_STATE',
  'RECENT_MESSAGES',
  'TIME',
  'ROLES',
] as const

// ---------------------------------------------------------------------------
// 旧路径（M1 的 composeState + messageHandlerTemplate）
// ---------------------------------------------------------------------------

/*
 * ⚠️ **三个旧链路包装已随 M12 · W4 退役**（2026-10-19）。
 *
 * 它们全都只是 `buildTurnContext(…)` 的改名转发，而那个函数来自 ElizaOS
 * （其 `composePromptFromState` 需要 handlebars + 唯一名生成器）。
 * D2 已确立旧链路在**生产无调用者**；W4 删包后它也不可能存在。
 * ⇒ 保留这三个包装 = 保留三个必然编译失败的转发壳。
 * ⚠️ 代价（如实记）：`--dump-prompt --legacy` 的对照视图没了；
 *    依赖它的 L1/L2 上下文注入断言随之退役。
 */

// ---------------------------------------------------------------------------
// 模型调用
// ---------------------------------------------------------------------------

export interface ModelCallResult {
  text: string
  durationMs: number
}

/**
 * 调模型并返回**纯文本**。
 *
 * 既有的 openai-compatible provider 已经用 core 的 `parseKeyValueXml`
 * 从 `<response><text>` 里取过正文，所以这里拿到的通常已经是可读文本；
 * 但仍然做一次兜底剥离，避免不同模型版本偶尔吐回 XML 时把标签打进聊天。
 */
export async function callModelText(
  runtime: AgentRuntime,
  prompt: string,
  streaming: import('../../providers/openai-compatible.ts').StreamingTextOptions & { temperature?: number; maxTokens?: number } = {}
): Promise<ModelCallResult> {
  const started = Date.now()
  const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt, ...streaming })
  const durationMs = Date.now() - started
  const text = typeof raw === 'string' ? raw : String(raw)
  return { text: stripResponseWrapper(text), durationMs }
}

/**
 * 兜底剥离 `<response>…</response>` 外壳。
 *
 * 只在"整个回复就是一个 response 块"时生效，不会误伤正文里
 * 恰好提到 `<response>` 字样的正常对话。
 */
export function stripResponseWrapper(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('<response') || !trimmed.endsWith('</response>')) return text
  const match = /<text>([\s\S]*?)<\/text>/i.exec(trimmed)
  if (match) return match[1].trim()
  // 没有 <text> 就把标签全去掉，至少不要让她把 XML 念出来
  return trimmed
    .replace(/<\/?response[^>]*>/gi, '')
    .replace(/<(thought|actions|providers)>[\s\S]*?<\/\1>/gi, '')
    .trim()
}

// ---------------------------------------------------------------------------
// 关系（M7 / ADR-064 D-6）→ Context section + ORIGIN 播种
// ---------------------------------------------------------------------------

/**
 * 把"你们此刻的关系"渲染成 section 内容（M7 关系注入块）。
 *
 * 数据链：M7 关系投影 → `effectiveRelationship`（读时视图，当前疏远已结算、
 * 不回写）→ 契约层 `renderRelationshipGuidance`（确定性映射）。
 * 未建档 ⇒ `undefined` ⇒ 调用方产 0 个 section（prompt 安静）。
 */
export async function renderRelationshipSection(
  runtime: AgentRuntime,
  characterId: string,
  userId: string,
  now: number = Date.now()
): Promise<{ text: string; sourceRefs: string[] } | undefined> {
  const db = getDb(runtime)
  const projection = await getRelationshipProjection(
    db,
    asCharacterId(characterId),
    entityRef('user', userId)
  )
  if (projection === undefined) return undefined
  const effective = effectiveRelationship(projection.state, now)
  const text = renderRelationshipGuidance({
    effective,
    now,
    projection: { revision: projection.revision, updatedAt: projection.updatedAt },
  })
  if (text === undefined) return undefined
  return {
    text,
    sourceRefs: [
      `projection:relationship:r${projection.revision}`,
      `projection:relationship:updated:${projection.updatedAt}`,
    ],
  }
}

/**
 * 一次 ORIGIN 播种的"来源与值"。
 *
 * ⚠️ **一处实现**：原主人设定基线（`SETTING_BASELINE`）与新用户起始值
 * （`NEW_USER_BASELINE`，U1/WP3 `ADR-136`）**共用同一条放行链与幂等**，
 * 只在这份 spec 上分叉 —— 否则两条播种路径迟早会漂移（"两个装配会漂移"的老教训）。
 */
interface RelationshipOriginSeedSpec {
  readonly trust: number
  readonly closeness: number
  readonly originKind: RelationshipOriginKind
  readonly basis: string
  /** 成功时的人读理由（既有调用点的读数逐字保留） */
  readonly seededReason: string
}

/** 原主人设定基线（ADR-064 U-M7-02）：0.85 / 0.60，来自"十几年共同长大"的角色设定 */
const RELATIONSHIP_OWNER_SEED_SPEC: RelationshipOriginSeedSpec = {
  trust: 0.85,
  closeness: 0.6,
  originKind: 'SETTING_BASELINE',
  basis:
    '用户授权的角色设定基线（ADR-064 U-M7-02：从小一起长大、对我很信赖 → trust 0.85；' +
    '同校、日常能见面 → closeness 0.60，刻意不拉满）',
  seededReason: 'ORIGIN 建档完成（SETTING_BASELINE 0.85/0.60）',
}

/**
 * 播种一条 RELATIONSHIP_ORIGIN（提案 → Validator → applyAcceptedEvents，**不绕任何一环**）。
 *
 * 幂等：已有投影 ⇒ no-op。被放行口拒绝 ⇒ **不播种**（失败关闭），如实报告理由。
 */
async function applyRelationshipOriginSeed(
  runtime: AgentRuntime,
  characterId: string,
  userId: string,
  spec: RelationshipOriginSeedSpec,
  now: number
): Promise<{ seeded: boolean; reason: string }> {
  const db = getDb(runtime)
  const cid = asCharacterId(characterId)
  const target = entityRef('user', userId)
  const existing = await getRelationshipProjection(db, cid, target)
  if (existing !== undefined) {
    return { seeded: false, reason: `投影已存在（r${existing.revision}）` }
  }

  const registry = createFullDomainEventRegistry()
  const deps = {
    registry,
    // ORIGIN 无对话来源（凭据是授权不是对话）：证据查找恒空，Validator 的
    // 证据分支只对 IMPACT 提案生效，这里给一个诚实的空实现。
    evidence: { findEvents: async () => [] },
    processed: { hasProcessed: (key: string) => hasProcessedOperation(db, key) },
    relationships: {
      getRelationshipState: async (id: CharacterId, key: { target: string }) =>
        (await getRelationshipProjection(db, id, entityRef('user', key.target)))?.state,
    },
    events: {
      getDomainEvent: async (id: { toString(): string }) => {
        const event = await getDomainEvent(db, id as never)
        return event === undefined ? undefined : { id: event.id, type: event.type }
      },
    },
  }

  const payload: RelationshipOriginPayload = {
    key: { owner: asEntityId(characterId), target: userId as never },
    targetKind: 'user',
    trust: spec.trust,
    closeness: spec.closeness,
    originKind: spec.originKind,
    basis: spec.basis,
  }
  const proposal = createProposal({
    characterId: cid,
    proposalType: RELATIONSHIP_ORIGIN_PROPOSAL_TYPE,
    sourceConversationEventIds: [],
    payload: { userId, basis: payload.basis },
    targetEvents: [{ type: RELATIONSHIP_ORIGIN, operation: 'create', payload }],
    processor: 'relationship-origin-seeder',
    processorVersion: 'relationship-origin-seeder@1',
  })
  const outcome = await validateRelationshipProposal(deps, proposal)
  if (!outcome.accepted) {
    const codes = outcome.rejected.map((r) => r.code).join(', ')
    // 失败关闭：播种被拒 = 不播种（不绕过放行口），如实报告
    return { seeded: false, reason: `放行口拒绝：${codes}` }
  }
  await applyAcceptedEvents(
    db,
    cid,
    outcome.acceptedEvents,
    [relationshipReducerFor(entityRef('character', asEntityId(characterId)), target)],
    now
  )
  return { seeded: true, reason: spec.seededReason }
}

/**
 * 启动时播种**原主人**的 RELATIONSHIP_ORIGIN（用户授权基线，ADR-064 U-M7-02）。
 *
 * ⚠️ 只在 `CHARACTER_RELATIONSHIP_CONTEXT_ENABLED` 打开时由 main.ts 调用
 *    （缺省 off：首次打开会写一条 ORIGIN 域事件，属激活行为，先例 ADR-048）。
 * ✅ U1/WP3 的引入**没有**改这条路径的行为：它只是把 spec 提到外面（值/理由逐字相同）。
 */
export async function seedRelationshipOrigin(
  runtime: AgentRuntime,
  characterId: string,
  userId: string,
  now: number = Date.now()
): Promise<{ seeded: boolean; reason: string }> {
  return applyRelationshipOriginSeed(runtime, characterId, userId, RELATIONSHIP_OWNER_SEED_SPEC, now)
}

/**
 * 播种**新用户**首次建档的起始关系（U1 / WP3；`ADR-136` **方案 A**，2026-10-14 原主人裁定）。
 *
 * ```text
 * 值      = NEW_USER_INITIAL_RELATIONSHIP（0.2 / 0.2，一处定义）
 * 来源种类 = NEW_USER_BASELINE —— **既不是** SETTING_BASELINE（用户授权的设定），
 *            **也不是** INTERACTION_DERIVED（首见没有任何互动证据）
 * 时机     = 首次**幂等建档成功**时（`R-WP3-3`）
 * ```
 *
 * ⚠️ 它**不**继承原主人的 0.85/0.60，也**不**重置任何既有关系（幂等：已有投影 ⇒ no-op）。
 * ⚠️ 接线（谁在什么时候调它）属 U1-WP2b-2b；本函数只是**能力**，不在生产链路上被调用。
 */
export async function seedRelationshipOriginForNewUser(
  runtime: AgentRuntime,
  characterId: string,
  userId: string,
  now: number = Date.now()
): Promise<{ seeded: boolean; reason: string }> {
  return applyRelationshipOriginSeed(
    runtime,
    characterId,
    userId,
    {
      trust: NEW_USER_INITIAL_RELATIONSHIP.trust,
      closeness: NEW_USER_INITIAL_RELATIONSHIP.closeness,
      originKind: 'NEW_USER_BASELINE',
      basis:
        '新档案的初始关系值（系统在该用户首次建档时给出的起点 —— ' +
        '既不是用户授权的角色设定基线，也不是由真实互动推导而来）',
      seededReason:
        `ORIGIN 建档完成（NEW_USER_BASELINE ${String(NEW_USER_INITIAL_RELATIONSHIP.trust)}/` +
        `${String(NEW_USER_INITIAL_RELATIONSHIP.closeness)}）`,
    },
    now
  )
}

/**
 * M7 关系投影的**只读读回**（`--inspect` 追加块；WP5 交付的 Inspector/读回）。
 *
 * 展示：投影本体 + 读时视图（当前疏远已结算）+ 信封（revision / originKind /
 * 在案指控数 / 锚点）。未建档 ⇒ 一行如实说明（诊断面：没有投影也是信息）。
 * 纯读，不写任何东西。
 */
export async function renderRelationshipReadback(
  runtime: AgentRuntime,
  characterId: string,
  userId: string,
  now: number = Date.now()
): Promise<string> {
  const db = getDb(runtime)
  const projection = await getRelationshipProjection(
    db,
    asCharacterId(characterId),
    entityRef('user', userId)
  )
  if (projection === undefined) {
    return ['M7 关系投影（owner → target）', '──────────────────────────────', '', '  （未建档——该目标没有关系投影行）'].join('\n')
  }
  const effective = effectiveRelationship(projection.state, now)
  const bar = (value: number): string => {
    const filled = Math.round(Math.max(0, Math.min(1, value)) * 10)
    return '█'.repeat(filled) + '░'.repeat(10 - filled)
  }
  const absenceHours =
    effective.lastInteractionAt !== null ? (now - effective.lastInteractionAt) / 3_600_000 : null
  return [
    'M7 关系投影（owner → target）',
    '──────────────────────────────',
    '',
    `  目标       user:${userId}`,
    `  来源       ${effective.originKind ?? '（无）'} · 投影 r${projection.revision} · reducer ${projection.reducerVersion}`,
    `  Trust      ${bar(effective.trust)}  ${effective.trust.toFixed(2)}`,
    `  Closeness  ${bar(effective.closeness)}  ${effective.closeness.toFixed(2)}（读时视图：当前疏远已结算）`,
    `  在案指控   ${effective.accusationsInCase.length} 条`,
    `  锚点       ${absenceHours === null ? '（无）' : `距上次关系证据 ${absenceHours < 48 ? `${absenceHours.toFixed(1)} 小时` : `${(absenceHours / 24).toFixed(1)} 天`}`}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// M8：情绪投影 → Context section / 读回
// ---------------------------------------------------------------------------

/**
 * M8 / ADR-066 §8.1：把"她此刻的情绪"渲染成 section 内容。
 *
 * 与 `renderRelationshipSection` 同构：读投影 → 读时衰减视图（`effectiveAffect`，
 * **永不写回**）→ 契约层的确定性渲染（`renderAffectGuidance`，桶位 + 行为行，
 * 无原始数值）。未建档 ⇒ `undefined` ⇒ 0 个 section（prompt 安静）。
 *
 * `appliedThisTurn`：本轮同轮评估是否成功（reply-truth 的渲染面）——
 * `false` ⇒ 渲染器追加如实边界行（ADR-066 §6.2：失败不得冒充成功）。
 */
export async function renderAffectSection(
  runtime: AgentRuntime,
  characterId: string,
  now: number = Date.now(),
  appliedThisTurn: boolean | 'unknown' = 'unknown'
): Promise<{ text: string; sourceRefs: string[] } | undefined> {
  const db = getDb(runtime)
  const projection = await getAffectProjection(db, asCharacterId(characterId))
  if (projection === undefined) return undefined
  const effective = effectiveAffect(projection.state, now)
  if (effective === undefined) return undefined
  const text = renderAffectGuidance({ effective, appliedThisTurn })
  return {
    text,
    sourceRefs: [
      `projection:affect:r${projection.revision}`,
      `projection:affect:updated:${projection.updatedAt}`,
    ],
  }
}

/**
 * M8 情绪投影的**只读读回**（`--inspect` 追加块；ADR-066 §8.1 的 Level 2 面）。
 *
 * 三段式（ADR-066 §8.1）：投影本体（canonical）+ 读时视图（effective，
 * 衰减已结算）+ legacy 对照（M2 状态里的情绪轴——M8 激活后退役，如实标注）。
 * 未建档 ⇒ 一行如实说明。纯读，不写任何东西。
 */
export async function renderAffectReadback(
  runtime: AgentRuntime,
  characterId: string,
  now: number = Date.now()
): Promise<string> {
  const db = getDb(runtime)
  const projection = await getAffectProjection(db, asCharacterId(characterId))
  if (projection === undefined) {
    return ['M8 情绪投影（affect:character）', '──────────────────────────────', '', '  （未建档——该角色没有情绪投影行）'].join('\n')
  }
  const state = projection.state
  const effective = effectiveAffect(state, now)
  const bar = (value: number, min: number, max: number): string => {
    const filled = Math.round(Math.max(0, Math.min(1, (value - min) / (max - min))) * 10)
    return '█'.repeat(filled) + '░'.repeat(10 - filled)
  }
  const hoursSince =
    state.lastInteractionAt !== null ? Math.max(0, (now - state.lastInteractionAt) / 3_600_000) : null
  const lines: string[] = [
    'M8 情绪投影（affect:character）',
    '──────────────────────────────',
    '',
    `  来源       ${state.originKind} · 投影 r${projection.revision} · reducer ${projection.reducerVersion}`,
    `  cutover    序号 ${String(state.cutoverSequence)}（此序号及之前的事件不重放——M8-D05）`,
    `  Valence    ${bar(state.valence, -1, 1)}  ${state.valence.toFixed(3)}（域内权威）`,
    `  Arousal    ${bar(state.arousal, 0, 1)}  ${state.arousal.toFixed(3)}（域内权威）`,
  ]
  if (effective !== undefined) {
    lines.push(
      '',
      '  读时视图（衰减已结算，永不写回）',
      `  · 此刻状态：${effective.valenceBucket}，${effective.arousalBucket}` +
        `（v=${effective.valence.toFixed(3)} · a=${effective.arousal.toFixed(3)}${effective.decayApplied ? ' · 已衰减' : ' · 无衰减'}）`,
      `  · 距上次交互：${effective.hoursSinceInteraction === null ? '（无锚点）' : `${effective.hoursSinceInteraction.toFixed(1)} 小时`}`,
    )
  } else {
    lines.push('', '  读时视图：（未建档，无有效状态）')
  }
  lines.push(
    '',
    `  锚点       交互 ${hoursSince === null ? '（无）' : `距上次 touch ${hoursSince < 48 ? `${hoursSince.toFixed(1)} 小时` : `${(hoursSince / 24).toFixed(1)} 天`}`} · ` +
      `情绪 ${state.lastAffectEventAt === null ? '（无）' : `距上次 impact ${((now - state.lastAffectEventAt) / 3_600_000).toFixed(1)} 小时`}`,
    '  legacy     M2 状态块的情绪轴已退役（M8-D12：Affect 投影是唯一情绪权威）',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// M9 WP7：信念注入块构造器 + 开发者面读回
// ---------------------------------------------------------------------------

/**
 * 信念注入块构造器（网关 `buildBeliefSection` 回调的装配侧实现）。
 *
 * 链路（ADR-070 §5.1–§5.3 + §7 + §9.3）：
 *   active+disputed 投影行 → 资格回查（批量 · 确切 ID · 失败关闭）→
 *   同轮遮蔽 overlay → 相关性过滤 + Memory 同根去重 + D17 预算渲染。
 *
 * 返回 `undefined` = 不产 section（未建档 / 零候选 / 一条都放不下）。
 * 任何读取异常向上抛（网关 catch 成 absent——失败关闭，不猜）。
 */
export async function buildBeliefContextSection(
  runtime: AgentRuntime,
  input: {
    characterId: string
    /** 唯一 active user（资格四条之一 + v1 主体相关性过滤） */
    activeUserId: string
    /** 本轮召回实际选中的 Memory id（同根去重的判据；召回没跑 = 空数组） */
    selectedMemoryIds: readonly string[]
    /** 本轮刚失效的 Memory id（同轮遮蔽；来自 Memory 操作路径的程序结果） */
    invalidatedMemoryIds?: readonly string[]
    /**
     * token 量化器。缺省 = ContextCompiler 的缺省公式（`ceil(len/2)`，
     * contracts/context.ts:419）——装配层没有注入真实 tokenizer 之前，
     * 信念条目的预算口径必须与编译器裁剪口径**同一个数**，否则
     * "渲染器说 400 内"与"编译器把它裁了"会用两把尺子。
     */
    quantifier?: (text: string) => number
    /** 覆盖 D17 缺省预算（400） */
    tokenBudget?: number
    epistemicHuman?: { currentEventId?: string }
  },
): Promise<BeliefSectionBuildResult | undefined> {
  const db = getDb(runtime)
  const cid = asCharacterId(input.characterId)
  const epistemic = input.epistemicHuman ? await readEblHumanContext(db, cid, input.activeUserId, input.epistemicHuman.currentEventId) : undefined

  // 未建档 ⇒ 没有信念生活史 ⇒ 安静（与"建档了但没有可用判断"区分开）
  const originRow = await getBeliefOrigin(db, cid)
  if (originRow === undefined || !originRow.state.originated) return undefined

  const candidates = (await listBeliefsByStatus(db, cid, ['active', 'disputed']))
    // User-approved retirement: disabling EBL must not silently revive the older inference outlet.
    .filter(belief => !isEblReplacedInference(belief))
  if (candidates.length === 0 && !epistemic?.presentation.candidate) return undefined

  // 资格回查（§5.2：批量 · 确切 ID · 失败关闭）——端口与调度器同源
  const ports = createBeliefJobPorts(db)
  let verdicts: Map<string, BeliefUsabilityVerdict>
  try {
    verdicts = await recheckBeliefDependencies(
      {
        characterId: input.characterId,
        evidence: {
          findEvents: (ids) =>
            ports.findConversationEvents(ids as never[] as readonly never[]),
        },
        memory: { findMemories: (ids) => ports.findMemories(ids) },
        origin: { getBeliefOrigin: (c) => ports.belief.getBeliefOrigin(asCharacterId(c)) },
        policy: { activeUserId: input.activeUserId },
      },
      candidates,
    )
  } catch {
    return undefined
  }

  // 同轮遮蔽（§5.3）：本轮刚失效的依赖 ⇒ 立即不可用（不等写侧收敛）
  const overlaid = applyInvalidationOverlay(
    verdicts,
    candidates,
    { invalidatedMemoryIds: input.invalidatedMemoryIds ?? [] },
  )
  const usable = candidates.filter((b) => overlaid.get(String(b.beliefId))?.usable === true)
  if (usable.length === 0 && !epistemic?.presentation.candidate) return undefined

  // 同根去重判据：本轮选中 Memory 的会话证据根（§9.3——正文已由记忆承载）
  const memoryStore = createNativeMemoryStore(db)
  const coveredRoots = new Set<string>()
  /*
   * ⚠️ **批量读**（`R-48`）：这里原来逐个 `memoryStore.get()`（4 次查询/条）——
   *    而它就在**每一轮对话**的路径上（`selectedMemoryIds` = 本轮召回的选中集合），
   *    所以真实轮次的代价 = `119 + 4×|召回集合|`。`getMany()` 与逐个 `get()` 逐条等价。
   */
  const selectedRecords = await memoryStore.getMany(input.selectedMemoryIds as never)
  for (const record of selectedRecords) {
    if (record === null) continue
    for (const ref of record.sourceRefs) {
      // EvidenceKind 的合法值是 'conversation_event'（contracts/memory.ts EVIDENCE_KINDS）。
      // 第一版写成 'conversation'——永假 ⇒ §9.3 同根去重在装配层从未生效
      // （WP7 门直测 renderBeliefSection 绕过了这段推导，全绿；WP8 e2e B36 抓出）。
      if (String(ref.kind) === 'conversation_event') coveredRoots.add(String(ref.id))
    }
  }

  const rendered = renderBeliefSection({
    candidates: usable.map((belief) => ({
      belief,
      memoryCoveredRootIds: [...coveredRoots],
    })),
    subject: { kind: 'user', id: input.activeUserId },
    quantifier: input.quantifier ?? ((text: string) => Math.ceil(text.length / 2)),
    ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
    ...(epistemic ? { epistemic: epistemic.presentation } : {}),
  })
  if (rendered === undefined) return undefined

  return {
    text: rendered.text,
    sourceRefs: rendered.sourceRefs,
    usedBeliefIds: rendered.usedBeliefIds,
    droppedBeliefIds: rendered.droppedBeliefIds,
    candidateCount: epistemic ? rendered.usedBeliefIds.length + rendered.droppedBeliefIds.length : usable.length,
    ...(epistemic?.presentation.candidate && rendered.usedBeliefIds.includes(epistemic.presentation.candidate.claimId)
      && epistemic.confirmIncluded ? { confirmIncluded: epistemic.confirmIncluded } : {}),
  }
}

/**
 * 开发者面读回（M9 WP7 任务 4：belief / source / history / job / watermark）。
 *
 * 只读、面向开发者（`--belief-status`）；与 `renderAffectReadback` 同一形状。
 * 回答 §10.1 的诊断问题：哪条信念、reported 还是 inferred、根在哪、
 * 依赖哪条 Memory、两条流的 job 与水位停在哪。
 */
export async function renderBeliefReadback(
  runtime: AgentRuntime,
  characterId: string,
): Promise<string> {
  const db = getDb(runtime)
  const cid = asCharacterId(characterId)
  const lines: string[] = ['M9 信念域读回（belief）', '──────────────────────────────', '']

  const originRow = await getBeliefOrigin(db, cid)
  if (originRow === undefined || !originRow.state.originated) {
    lines.push('  （未建档——该角色没有信念域 origin 行）')
    return lines.join('\n')
  }
  const origin = originRow.state
  lines.push(
    `  origin      activationId=${origin.activationId} · cutover=${String(origin.cutoverSequence)}（此序号及之前不重放） · policy=${origin.policyVersion}`,
  )

  const beliefs = await listBeliefsByStatus(db, cid, [
    'active',
    'disputed',
    'superseded',
    'retracted',
  ])
  lines.push('', `  信念行      共 ${String(beliefs.length)} 条（含终态）：`)
  for (const b of beliefs) {
    const slot = `${String(b.proposition.predicate)}@${String(b.proposition.scopeKey)}`
    lines.push(
      `  · [${String(b.status)}/${String(b.epistemicKind)}] ${slot} = ${String(b.proposition.value)}` +
        ` · 根 ${String(b.evidenceRootIds.length)} 条 · 依赖 Memory ${String(b.dependsOnMemoryIds.length)} 条` +
        ` · 规则 ${String(b.ruleId)}@${String(b.ruleVersion)}`,
    )
    for (const root of b.evidenceRootIds.slice(0, 5)) {
      lines.push(`      根 ${String(root)}`)
    }
    for (const mem of b.dependsOnMemoryIds.slice(0, 5)) {
      lines.push(`      依赖 mem ${String(mem)}`)
    }
  }

  // 修订史（BELIEF_* 事件流——"什么时候被更正/撤回"）
  const events = await domainEventsFor(db, cid)
  const beliefEvents = events.filter((e) => String(e.type).startsWith('BELIEF_'))
  const byType = new Map<string, number>()
  for (const e of beliefEvents) {
    const t = String(e.type)
    byType.set(t, (byType.get(t) ?? 0) + 1)
  }
  lines.push(
    '',
    `  事件流      共 ${String(beliefEvents.length)} 条 BELIEF_*：` +
      [...byType.entries()].map(([t, n]) => `${t}×${String(n)}`).join(' · '),
  )

  // 双流 job + watermark（§10.1："job 是否失败，watermark 是否停滞"）
  const streams: [string, string, string][] = [
    ['interaction', BELIEF_INTERACTION_EVALUATOR_NAME, BELIEF_INTERACTION_EVALUATOR_VERSION],
    ['memory', BELIEF_MEMORY_RECONCILER_NAME, BELIEF_MEMORY_RECONCILER_VERSION],
  ]
  const recentJobs = await listJobs(db, cid, { limit: 100 })
  lines.push('', '  双流水位 / 最近 job：')
  for (const [label, name, version] of streams) {
    const wm = await getWatermark(db, cid, name, version)
    const jobs = recentJobs.filter((job) => String(job.processor) === name).slice(0, 3)
    const latest = jobs[0]
    lines.push(
      `  · ${label}      水位=${String(wm?.processedThroughSequence ?? '（无）')}` +
        ` · 最近 job=${latest ? `${String(latest.status)}(${String(latest.id)})` : '（无）'}`,
    )
    for (const job of jobs) {
      if (job.status === 'failed') {
        lines.push(`      failed job ${String(job.id)}：${String(job.lastError ?? '(无错误信息)')}`)
      }
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function getDb(runtime: AgentRuntime) {
  const holder = runtime as unknown as {
    adapter?: { db?: { execute: (q: unknown) => Promise<unknown> } }
  }
  const db = holder.adapter?.db
  if (!db?.execute) {
    throw new Error('拿不到数据库句柄：plugin-sql 尚未注册适配器')
  }
  return db
}
