/**
 * **S8 / `ADR-094` `D02.2②` + `ADR-107` `R-1b`** —— 模型"候选 `choiceId`"的**草稿契约**。
 *
 * ============================================================================
 *  它在链路里的位置
 * ============================================================================
 * ```text
 * 私有决策调用（`R-1b`）  →  **本模块判定形状**  →  `ingestStoryChoice()`  →  世界状态机
 *     模型只能提案              闭集：必须在 frontier 上        服务端绑定           唯一判定处
 * ```
 * ⚠️ **它是"两次表达"的第一层**，不是唯一判据：世界状态机（`advanceFromProposal`）
 *    仍然会独立判一次（非法选择一样拒收）。两层都失败关闭，**不互相替代**。
 *
 * ============================================================================
 *  三条纪律（与 `goal-proposal` / `agreement-model-draft` 同一条）
 * ============================================================================
 * ```text
 * ① **闭集**：`choiceId` 必须**逐字**是候选集合里的一个机器键（不是"看起来像"）
 * ② **`null` 是一个结论，不是错误**：模型说"本轮用户没有做选择" ⇒ `choiceId: null`
 *    （与 `agreement-model-draft` 的 `kind:'none'` 同型：沉默要能与失败分开）
 * ③ **未知字段一律拒收**：多一个字段就说明输出形状不是我们约定的那个
 * ```
 *
 * ⚠️ **`story-choice` 这个"受控值"是约定受控的，没有中央登记表**（`ADR-107` §2.5(1) 的登记事实）：
 *    `proposalType` 在仓库里是自由字符串，真正失败关闭的那一层判的是**目标事件类型**。
 *    本步**不**顺手建登记表（那会牵动别的里程碑的既有临时值）⇒ 这个常量**不**构成机器保证，
 *    它只是把 `D02.2④` 的字母落实成一个**可检索**的名字。**不主张**"提案类型受控"。
 *
 * ⚠️ 纯类型与纯函数：不 import 框架 / SQL / `node:*`。
 */

/** `D02.2④` 点名的受控值（**约定受控**，见文件头：没有登记表，不是机器保证） */
export const STORY_CHOICE_PROPOSAL_TYPE = 'story-choice'

export const STORY_CHOICE_DRAFT_SCHEMA_VERSION = 'story-choice-draft@1'

/** 模型**唯一**被允许生产的形状 */
export interface StoryChoiceDraft {
  readonly schemaVersion: string
  /** `null` = "本轮用户没有做选择"（一个**结论**，不是失败） */
  readonly choiceId: string | null
  /**
   * **用户原话里的逐字片段**（`L-S8-31` 的缓解面）。
   *
   * ⚠️ 为什么要有它：模型**会误解读**（用户没选、或选了别的，它给一个闭集内的键）
   *    ⇒ 那条提交会**冒充一次真实用户选择**（而 `user_choice` 是"唯一能成为习惯根的形态"）。
   *    要求它**同时**指出用户自己写的那些字符，程序再做**机械包含检查** ——
   *    这是**结构性**约束，**不是**语义判据（本仓库在措辞层**刻意没有**启发式守卫，`DR-11`）。
   *    ⇒ 与 `goal-proposal` 的 `span` / `spanFingerprint` 同一条纪律。
   *
   * ⚠️ **它买到什么、买不到什么**（必须一起读）：
   * ```text
   * 买到：模型必须**指认用户自己的字符**；指不出来就得给 `null`（弃权）。
   *       它挡掉的是"**脱离用户原话**去选"那一类失败（最常见的那种：它觉得用户"应该"选某个）。
   * 买不到：引用得**对不对** —— 模型照样可以引用一段**无关**的原话。
   *         ⇒ `L-S8-31` **不因本字段关闭**。
   * ```
   * `choiceId === null` 时它必须是 `null`（"没有选择"就没有可指认的原话）。
   */
  readonly quote: string | null
}

/**
 * **私有决策端口**（适配器面向的形状）。
 *
 * ⚠️ 它放在 `contracts/` 而**不是** `kernel/app/storyline/`：与每一个同类适配器一致
 *    （`openai-tool-decision` / `openai-agreement-understanding` / `openai-goal-understanding`
 *    都从 `kernel/contracts|action` 取自己的契约）。理由不只是"风格"：
 *    `m3.5:test` 的 `FC-T04`（"世界/故事实现只允许住在具名模块边界内"，`ADR-091 §2`）
 *    按路径匹配 `storyline/` —— 适配器一旦直接 import `kernel/app/storyline/*`，
 *    就得往那张"逐边登记"的白名单里再加一条 infra/model 边（那是一种**新的**条目形状）。
 *    ⇒ 让契约住在契约层，适配器就不必触碰故事边界。
 *
 * ⚠️ 端口**只发一次请求并返回原始输出**：它**不**判定形状（判定只有一处，在下面）。
 */
export interface StoryChoiceDecisionPort {
  /** 适配器标识（写进 trace 属性用；**不含**任何凭证） */
  readonly id?: string
  /** 端点主机名（写进 trace 属性用；**不含**路径与凭证） */
  readonly endpointHost?: string
  /**
   * 发**一次**请求。要求：自带硬期限（`deadlineMs`），到点即 abort。
   *
   * ⚠️ 实现方**不要**在这里判定输出形状 —— 解析失败请**原样**返回
   *    （与 `openai-agreement-understanding.ts` 同一条纪律）。
   */
  readonly call: (input: {
    readonly userMessage: string
    readonly deadlineMs: number
  }) => Promise<unknown>
}

export type StoryChoiceDraftParse =
  | { readonly ok: true; readonly choiceId: string | null }
  | { readonly ok: false; readonly code: string; readonly detail: string }

/** 草稿层的**闭集**解析码（与 `TOOL_DECISION_PARSE_CODES` 同型：失败也要能分类） */
export const STORY_CHOICE_DRAFT_PARSE_CODES = [
  'not_an_object',
  'schema_version_missing_or_unknown',
  'unknown_field',
  'choice_id_not_a_string_or_null',
  'choice_id_empty',
  'choice_id_not_on_frontier',
  'quote_not_a_string_or_null',
  'quote_empty',
  'quote_not_in_user_turn',
] as const

const ALLOWED_FIELDS: readonly string[] = ['schemaVersion', 'choiceId', 'quote']

/** 逐字引用的长度上界（码点）—— 它只是一段"指认"，不该是整轮原话 */
export const STORY_CHOICE_MAX_QUOTE_CODEPOINTS = 200

/**
 * 判定模型的原始输出（**失败关闭**）。
 *
 * ⚠️ 输入是 `unknown`：模型输出**不可信**，这里不做任何"尽力猜"的修补
 *    （不 trim 大小写、不模糊匹配、不取前缀）—— 机器键必须**逐字**相符。
 * ⚠️ `userText` **必须是**触发本轮的那条用户原话：逐字引用的包含检查只能对它做
 *    （对别的东西做就失去了"用户自己说过"的含义）。
 */
export function recognizeStoryChoiceDraft(input: {
  /** 模型原始输出（可能是任何东西：字符串、数组、null、坏 JSON 的结果） */
  readonly raw: unknown
  /** 本轮**合法**的候选机器键（服务端从内容包 frontier 算出） */
  readonly candidates: readonly string[]
  /** **触发本轮的用户原话**（服务端给；`quote` 的包含检查只能对它做） */
  readonly userText: string
}): StoryChoiceDraftParse {
  const { raw, candidates, userText } = input
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'not_an_object',
      detail: `模型输出不是一个 JSON 对象（收到 ${Array.isArray(raw) ? '数组' : typeof raw}）`,
    }
  }
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== STORY_CHOICE_DRAFT_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'schema_version_missing_or_unknown',
      detail:
        `schemaVersion 必须是 ${STORY_CHOICE_DRAFT_SCHEMA_VERSION}，` +
        `收到 ${JSON.stringify(record.schemaVersion)}`,
    }
  }
  const extra = Object.keys(record).filter((key) => !ALLOWED_FIELDS.includes(key))
  if (extra.length > 0) {
    return {
      ok: false,
      code: 'unknown_field',
      detail: `出现约定之外的字段：${JSON.stringify(extra.sort())}（多一个字段就说明形状不是约定的那个）`,
    }
  }
  const value = record.choiceId
  const quote = record.quote
  if (value === null) {
    /* "没有选择"就必须没有可指认的原话 —— 带一段引用是形状不自洽 */
    if (quote !== null) {
      return {
        ok: false,
        code: 'quote_not_a_string_or_null',
        detail: `choiceId 是 null 时 quote 也必须是 null，收到 ${JSON.stringify(quote)}`,
      }
    }
    return { ok: true, choiceId: null }
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      code: 'choice_id_not_a_string_or_null',
      detail: `choiceId 必须是字符串或 null，收到 ${JSON.stringify(value)}`,
    }
  }
  if (value.trim() === '') {
    return { ok: false, code: 'choice_id_empty', detail: 'choiceId 是空串：要么给机器键，要么给 null' }
  }
  if (!candidates.includes(value)) {
    return {
      ok: false,
      code: 'choice_id_not_on_frontier',
      detail:
        `choiceId ${JSON.stringify(value)} 不在本轮的候选集合里` +
        `（${JSON.stringify([...candidates])}）—— 闭集，不模糊匹配`,
    }
  }
  /*
   * ⚠️ **逐字引用**（`L-S8-31`）：给了选择就**必须**指认用户自己写的那些字符。
   *    机械包含检查 —— 不看含义、不做启发式（`DR-11`）。
   */
  if (quote === null || quote === undefined) {
    return {
      ok: false,
      code: 'quote_not_a_string_or_null',
      detail: '给了 choiceId 就必须同时给出用户在**本轮原话**里的逐字引用（`quote`）；指不出来就该给 null 弃权',
    }
  }
  if (typeof quote !== 'string') {
    return {
      ok: false,
      code: 'quote_not_a_string_or_null',
      detail: `quote 必须是字符串或 null，收到 ${JSON.stringify(quote)}`,
    }
  }
  if (quote.trim() === '') {
    return { ok: false, code: 'quote_empty', detail: 'quote 是空串：要么指认一段用户原话，要么给 null 弃权' }
  }
  if ([...quote].length > STORY_CHOICE_MAX_QUOTE_CODEPOINTS) {
    return {
      ok: false,
      code: 'quote_empty',
      detail: `quote 最长 ${String(STORY_CHOICE_MAX_QUOTE_CODEPOINTS)} 码点（它只是一段指认，不该是整轮原话）`,
    }
  }
  if (!userText.includes(quote)) {
    return {
      ok: false,
      code: 'quote_not_in_user_turn',
      detail:
        `quote ${JSON.stringify(quote)} **不是**本轮用户原话的片段 —— ` +
        '逐字引用必须来自用户自己写下的字符（机械包含检查；不看含义）',
    }
  }
  return { ok: true, choiceId: value }
}

/** ADR-115：日常话题判定与选择共用一次调用，旧选择契约保持原样。 */
export const STORY_DAILY_DRAFT_SCHEMA_VERSION = 'story-daily-draft@1'

export function recognizeStoryDailyDraft(input: {
  readonly raw: unknown
  readonly candidates: readonly string[]
  readonly userText: string
}):
  | { readonly ok: true; readonly related: boolean; readonly choiceId: string | null }
  | { readonly ok: false; readonly code: string; readonly detail: string } {
  const raw = input.raw
  const bad = (code: string, detail: string) => ({ ok: false as const, code, detail })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('not_an_object', '日常故事判定必须是对象')
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== STORY_DAILY_DRAFT_SCHEMA_VERSION) return bad('schema_version_missing_or_unknown', '日常故事判定版本不符')
  if (Object.keys(record).some(key => !['schemaVersion', 'related', 'choiceId', 'quote'].includes(key))) return bad('unknown_field', '日常故事判定含未知字段')
  if (typeof record.related !== 'boolean') return bad('related_not_boolean', 'related 必须是布尔值')
  if (!record.related && (record.choiceId !== null || record.quote !== null)) return bad('unrelated_with_choice', '无关轮不得夹带选择或引用')
  if (record.related && (typeof record.quote !== 'string' || record.quote.trim() === '' ||
      [...record.quote].length > STORY_CHOICE_MAX_QUOTE_CODEPOINTS || !input.userText.includes(record.quote))) {
    return bad('quote_not_in_user_turn', '相关话题必须指认本轮用户原话里的非空逐字片段')
  }
  const parsed = recognizeStoryChoiceDraft({
    raw: { schemaVersion: STORY_CHOICE_DRAFT_SCHEMA_VERSION, choiceId: record.choiceId,
      quote: record.choiceId === null ? null : record.quote },
    candidates: input.candidates, userText: input.userText,
  })
  return parsed.ok ? { ok: true, related: record.related, choiceId: parsed.choiceId } : parsed
}
