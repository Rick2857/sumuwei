/**
 * M11 **反思草案契约**（ADR-085 §4.1 / §4.6 · `D06` · `D30` · `D32`）。
 *
 * ============================================================================
 *  这个文件是什么、不是什么
 * ============================================================================
 *  · **是**：模型（或固定 provider）在这个里程碑里被允许产出的**有界**形状 ——
 *    焦点问题 + 候选解释 + 支持/反例 handle + 范围 + 可选槽位 + 可选跨域待审意图；
 *    以及**严格**的结构校验器（未知字段即非法，不当"没提议"）。
 *  · **不是**：授权 / 持久化 / 采纳。放行口在 WP4 的策略里，它看的是**程序侧**记录，
 *    不是本文件的草案。
 *
 * ============================================================================
 *  四条硬边界（都是判据，不是注释）
 * ============================================================================
 * ① **闭集**：字段名、枚举值、槽位都在受控登记表里。未知字段 ⇒ `draft_unknown_field`
 *    （**不当**"没提议"—— 把故障读成"她没想法"是最坏的失败模式）。
 * ② **不得编造程序事实**：草案里**没有** `roots` / `rootCount` / `owner` / `revision` /
 *    `authority` / `confidence` 这些字段的位置。它们不是"暂时没实现"，而是**不允许**
 *    —— 模型自报根数就等于让它自己决定门槛（`D06`）。
 * ③ **handle 只能引用程序给的那些**：`supportHandles` / `counterHandles` 必须是
 *    调用方传入集合的**子集**；出现未提供的 id ⇒ `handle_not_provided`。
 * ④ **长度与槽位是冻结值**：自由文本 ≤ **300 码点**（`D30`）；槽位是三选一闭集（`D09`）。
 *
/**
 * ⚠️ 纯契约 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 */

import type { LineageHandleKind } from './reflection-lineage.ts'

/** 草案 schema 版本（改形状必须升版本） */
export const REFLECTION_DRAFT_SCHEMA_VERSION = 'reflection-draft@1'

// ---------------------------------------------------------------------------
// 三个行为槽（`D09`：v1 封闭集合，实施时**不得**顺手扩大）
// ---------------------------------------------------------------------------

export type ReflectionSlot =
  | 'clarify_when_ambiguous'
  | 'acknowledge_correction_first'
  | 'recheck_goal_before_next_step'

export const REFLECTION_SLOTS: readonly ReflectionSlot[] = [
  'clarify_when_ambiguous',
  'acknowledge_correction_first',
  'recheck_goal_before_next_step',
]

export function isReflectionSlot(value: unknown): value is ReflectionSlot {
  return typeof value === 'string' && (REFLECTION_SLOTS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// 跨域待审意图（`D13`：只提议，不提交）
// ---------------------------------------------------------------------------

export type RevisionIntentDomain = 'memory' | 'belief' | 'goal' | 'commitment'

export const REVISION_INTENT_DOMAINS: readonly RevisionIntentDomain[] = [
  'memory',
  'belief',
  'goal',
  'commitment',
]

/**
 * 模型可以建议"目标领域的某一项应当被修订"，但**不得**提交它。
 *
 * ⚠️ 它**没有** `proposal` 正文字段：建议内容由目标领域的既有形状表达，
 *    本里程碑不替别的领域定义提案结构（`D13`：不绕过领域归属）。
 */
export interface ReflectionRevisionIntent {
  readonly domain: RevisionIntentDomain
  readonly targetId: string
  /** 期望版本（乐观锁；目标领域在读时复核） */
  readonly expectedRevision: number
}

// ---------------------------------------------------------------------------
// 拒收理由（闭集 + 逐条可达性事实）
// ---------------------------------------------------------------------------

/**
 * ⚠️ 前六条是**验收契约 §3.3 冻结的集合**；第七条 `draft_schema_unknown` 是
 *    **WP3 追加**的（判据变更记录见验收契约 §3.3 的追加说明）：形状版本不认识时
 *    必须与"JSON 坏了"分开——两者的修法完全不同。
 */
export type ReflectionDraftRejectionReason =
  | 'draft_invalid_json'
  | 'draft_empty'
  | 'draft_unknown_field'
  | 'draft_too_long'
  | 'unknown_slot'
  | 'handle_not_provided'
  | 'draft_schema_unknown'

export const REFLECTION_DRAFT_REJECTION_REASONS: readonly ReflectionDraftRejectionReason[] = [
  'draft_invalid_json',
  'draft_empty',
  'draft_unknown_field',
  'draft_too_long',
  'unknown_slot',
  'handle_not_provided',
  'draft_schema_unknown',
]

export interface ReflectionDraftRejectionFact {
  readonly reachable: boolean
  readonly producer: string
  readonly howToReach: string
}

export const REFLECTION_DRAFT_REJECTION_FACTS: Readonly<
  Record<ReflectionDraftRejectionReason, ReflectionDraftRejectionFact>
> = {
  draft_invalid_json: {
    reachable: true,
    producer: 'reflection.ts · parseReflectionDraft · JSON.parse 抛错或顶层不是对象',
    howToReach: 'provider 返回的不是合法 JSON（含被截断的输出）',
  },
  draft_empty: {
    reachable: true,
    producer: 'reflection.ts · validateReflectionDraft · 必需字段缺失或全为空白',
    howToReach: '模型返回 `{}` / 空解释 / 只有空白的焦点问题',
  },
  draft_unknown_field: {
    reachable: true,
    producer: 'reflection.ts · validateReflectionDraft · 出现闭集外的字段名',
    howToReach: '模型顺手多写 `rootCount` / `authority` / `confidence` 之类（**必须**拒绝，见 §0②）',
  },
  draft_too_long: {
    reachable: true,
    producer: 'reflection.ts · validateReflectionDraft · 自由文本超过 300 码点（`D30`）',
    howToReach: '模型写了一段长篇解释',
  },
  unknown_slot: {
    reachable: true,
    producer: 'reflection.ts · validateReflectionDraft · suggestedSlot 不在三槽闭集',
    howToReach: '模型自创槽位（例如 `always_be_nice`）',
  },
  handle_not_provided: {
    reachable: true,
    producer: 'reflection.ts · validateReflectionDraft · support/counter handle 不在程序给的集合里',
    howToReach: '模型编造一个 handle id（`D06`：只选程序提供的）',
  },
  draft_schema_unknown: {
    reachable: true,
    producer: 'reflection.ts · validateReflectionDraft · schemaVersion 缺失或与常量不等',
    howToReach: 'prompt 版本与解析器版本错配（**不是**"JSON 坏了"）',
  },
}

// ---------------------------------------------------------------------------
// 草案形状（闭集）
// ---------------------------------------------------------------------------

/** 程序给模型看的 handle（**只有** id 与类型 —— 不给正文，也不给权限） */
export interface ReflectionHandle {
  /**
   * ⚠️ **S8 / ADR-093 `D04`**：kind 的类型**只有一处定义**
   * （`LineageHandleKind`）。S8 追加 `story_event` 之后，这里若继续写死一个
   * 四值 union，两者会漂移 —— 而漂移的表现是"输入里有故事 handle、草案却认为它非法"。
   */
  readonly kind: LineageHandleKind
  readonly id: string
}

/** 草案的对象形状（`schemaVersion` 之外全是模型要产出的内容）。 */
export interface ReflectionDraft {
  readonly schemaVersion: typeof REFLECTION_DRAFT_SCHEMA_VERSION
  /** 焦点问题（结构化借鉴 Generative Agents 的 focus question） */
  readonly focusQuestion: string
  /** 候选解释（≤ 300 码点；它是**解释**，不是事实） */
  readonly explanation: string
  /** 支持它的 handle（必须是程序提供集合的子集） */
  readonly supportHandles: readonly string[]
  /** 反例 handle（同上；**必须**可与支持并存） */
  readonly counterHandles: readonly string[]
  /** 适用范围（v1 只允许当前 character/user 的处置范围） */
  readonly scope: 'current_character_user'
  /** 建议的行为槽（可选；三选一） */
  readonly suggestedSlot?: ReflectionSlot
  /** 跨域待审意图（可选；只提议不提交） */
  readonly revisionIntent?: ReflectionRevisionIntent
}

/**
 * 允许出现的字段名（**闭集**）。
 *
 * ⚠️ 这张表就是"模型不得编造程序事实"的机器判据：`roots` / `rootCount` / `owner` /
 *    `revision` / `authority` / `confidence` **不在表里** ⇒ 出现即 `draft_unknown_field`。
 */
export const REFLECTION_DRAFT_FIELD_ALLOWLIST: readonly string[] = [
  'schemaVersion',
  'focusQuestion',
  'explanation',
  'supportHandles',
  'counterHandles',
  'scope',
  'suggestedSlot',
  'revisionIntent',
]

/** 必需字段（缺任何一个 ⇒ `draft_empty`） */
export const REFLECTION_DRAFT_REQUIRED_FIELDS: readonly string[] = [
  'schemaVersion',
  'focusQuestion',
  'explanation',
  'supportHandles',
  'counterHandles',
  'scope',
]

/** 自由文本上界（`D30` 的冻结值：单条候选解释 ≤ 300 汉字） */
export const REFLECTION_DRAFT_MAX_TEXT_CODEPOINTS = 300

/** v1 只允许这一个范围值（`D32`：槽的 scope 由程序固定） */
export const REFLECTION_DRAFT_SCOPE = 'current_character_user' as const

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export interface ReflectionDraftContext {
  /** 程序提供给模型的 handle（草案只能引用其中的 id） */
  readonly handles: readonly ReflectionHandle[]
  /** 上界（缺省 = `REFLECTION_DRAFT_MAX_TEXT_CODEPOINTS`；测试可注入更小的值） */
  readonly maxTextCodepoints?: number
}

export type ReflectionDraftResult =
  | { readonly ok: true; readonly draft: ReflectionDraft }
  | {
      readonly ok: false
      readonly reason: ReflectionDraftRejectionReason
      readonly detail: string
    }

function fail(reason: ReflectionDraftRejectionReason, detail: string): ReflectionDraftResult {
  return { ok: false, reason, detail }
}

/** 码点数（不是 UTF-16 长度 —— 一个 emoji 不该被算成两个） */
export function codepointLength(text: string): number {
  return [...text].length
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * 校验一个**已解析**的草案对象。
 *
 * 顺序（先到先拒，理由码不合并）：schemaVersion → 未知字段 → 必需字段/空白 →
 * 文本上界 → 范围 → 槽位 → handle 子集 → 跨域意图。
 */
export function validateReflectionDraft(
  raw: unknown,
  context: ReflectionDraftContext
): ReflectionDraftResult {
  if (!isPlainObject(raw)) {
    return fail('draft_invalid_json', `草案顶层不是对象（收到 ${Array.isArray(raw) ? 'array' : typeof raw}）`)
  }

  if (raw.schemaVersion !== REFLECTION_DRAFT_SCHEMA_VERSION) {
    return fail(
      'draft_schema_unknown',
      `schemaVersion 必须是 ${REFLECTION_DRAFT_SCHEMA_VERSION}（收到 ${JSON.stringify(raw.schemaVersion)}）`
    )
  }

  for (const key of Object.keys(raw)) {
    if (!REFLECTION_DRAFT_FIELD_ALLOWLIST.includes(key)) {
      return fail(
        'draft_unknown_field',
        `出现闭集外的字段 ${JSON.stringify(key)}（模型不得自报程序事实：根数 / 归属 / 版本 / 权限）`
      )
    }
  }

  for (const field of REFLECTION_DRAFT_REQUIRED_FIELDS) {
    if (!(field in raw)) return fail('draft_empty', `缺少必需字段 ${field}`)
  }

  const focusQuestion = raw.focusQuestion
  const explanation = raw.explanation
  if (typeof focusQuestion !== 'string' || focusQuestion.trim() === '') {
    return fail('draft_empty', 'focusQuestion 为空')
  }
  if (typeof explanation !== 'string' || explanation.trim() === '') {
    return fail('draft_empty', 'explanation 为空（空解释不是"没有洞见"，是无效输出）')
  }

  const max = context.maxTextCodepoints ?? REFLECTION_DRAFT_MAX_TEXT_CODEPOINTS
  if (codepointLength(focusQuestion) > max) {
    return fail('draft_too_long', `focusQuestion ${String(codepointLength(focusQuestion))} 码点超过上界 ${String(max)}`)
  }
  if (codepointLength(explanation) > max) {
    return fail('draft_too_long', `explanation ${String(codepointLength(explanation))} 码点超过上界 ${String(max)}`)
  }

  if (raw.scope !== REFLECTION_DRAFT_SCOPE) {
    return fail(
      'draft_empty',
      `scope 必须是 ${REFLECTION_DRAFT_SCOPE}（v1 不允许"永远这样做"这类扩大范围）`
    )
  }

  const supportHandles = raw.supportHandles
  const counterHandles = raw.counterHandles
  if (!isStringArray(supportHandles)) return fail('draft_empty', 'supportHandles 必须是字符串数组')
  if (!isStringArray(counterHandles)) return fail('draft_empty', 'counterHandles 必须是字符串数组')

  if (raw.suggestedSlot !== undefined && !isReflectionSlot(raw.suggestedSlot)) {
    return fail('unknown_slot', `suggestedSlot ${JSON.stringify(raw.suggestedSlot)} 不在三槽闭集`)
  }

  const provided = new Set(context.handles.map((handle) => handle.id))
  for (const id of [...supportHandles, ...counterHandles]) {
    if (!provided.has(id)) {
      return fail(
        'handle_not_provided',
        `引用了程序未提供的 handle ${JSON.stringify(id)}（模型只能选程序给的那些）`
      )
    }
  }

  let revisionIntent: ReflectionRevisionIntent | undefined
  if (raw.revisionIntent !== undefined) {
    if (!isPlainObject(raw.revisionIntent)) {
      return fail('draft_empty', 'revisionIntent 必须是对象')
    }
    const domain = raw.revisionIntent.domain
    const targetId = raw.revisionIntent.targetId
    const expectedRevision = raw.revisionIntent.expectedRevision
    if (!REVISION_INTENT_DOMAINS.includes(domain as RevisionIntentDomain)) {
      return fail('draft_empty', `revisionIntent.domain ${JSON.stringify(domain)} 不在闭集`)
    }
    if (typeof targetId !== 'string' || targetId.trim() === '') {
      return fail('draft_empty', 'revisionIntent.targetId 为空')
    }
    if (!Number.isInteger(expectedRevision) || (expectedRevision as number) <= 0) {
      return fail('draft_empty', `revisionIntent.expectedRevision ${String(expectedRevision)} 必须是正整数`)
    }
    revisionIntent = {
      domain: domain as RevisionIntentDomain,
      targetId,
      expectedRevision: expectedRevision as number,
    }
  }

  return {
    ok: true,
    draft: {
      schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION,
      focusQuestion,
      explanation,
      supportHandles: [...supportHandles],
      counterHandles: [...counterHandles],
      scope: REFLECTION_DRAFT_SCOPE,
      ...(raw.suggestedSlot === undefined
        ? {}
        : { suggestedSlot: raw.suggestedSlot as ReflectionSlot }),
      ...(revisionIntent === undefined ? {} : { revisionIntent }),
    },
  }
}

/**
 * 从 provider 的**原始文本**到草案：JSON 解析失败与非对象都归 `draft_invalid_json`。
 *
 * ⚠️ 解析失败**不重试、不修补**（"补一个看起来合理的 draft"正是本里程碑要防的
 *    自证错误）：调用方按 `D30` 记一次失败并留给下一次合法触发。
 */
export function parseReflectionDraft(
  rawText: string,
  context: ReflectionDraftContext
): ReflectionDraftResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText) as unknown
  } catch (error) {
    return fail(
      'draft_invalid_json',
      `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`
    )
  }
  return validateReflectionDraft(parsed, context)
}
