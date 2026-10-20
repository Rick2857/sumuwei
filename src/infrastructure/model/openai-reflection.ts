/**
 * 反思候选的 **OpenAI 兼容适配器** —— M11 WP10 缺的那块 provider。
 *
 * ============================================================================
 *  它只做四件事（与 `openai-goal-understanding.ts` 同形）
 * ============================================================================
 * ```text
 * ReflectionDraftCall → **恰好一次** POST {base}/chat/completions
 *   → 取 choices[0].message.content → 解析成 JSON 对象
 *   → 把**原始对象**交回内核（严格校验在**内核**，不在这里）
 * ```
 * 它**不**做：结构校验（`parseReflectionDraft` 在内核）、放行、写库、重试、降级重问。
 *
 * ============================================================================
 *  三条设计判据（都是本仓库踩过的坑）
 * ============================================================================
 * ```text
 * ① **提示词从契约派生**：`REFLECTION_SLOTS` / 字段白名单 / 必需字段 / 300 码点上界
 *    全部 import 进来现算 ⇒ 契约改一个字段，提示词**同一次改动**就跟着变。
 *    （手写会怎样：门量到的是**提示词的错**，不是模型的错 —— M10 WP9-B 踩过。）
 * ② **失败要分对桶**：网络 / HTTP / 没有 key ⇒ **抛**（内核映射 `transport`）；
 *    "给了东西但不是 JSON" ⇒ **返回原文**（内核判 `invalid`）。
 * ③ **反迎合写在提示词里**（`D32`）：明确"一次反馈不构成规律""不许把用户的恭维当证据"
 *    "不确定就少说" —— 这些是**事实约束**，不是措辞风格。
 * ```
 *
 * ⚠️ 凭证**只**从 `env.OPENAI_API_KEY` 取，**不回落**任何其它来源。
 */

import {
  REFLECTION_DRAFT_FIELD_ALLOWLIST,
  REFLECTION_DRAFT_MAX_TEXT_CODEPOINTS,
  REFLECTION_DRAFT_REQUIRED_FIELDS,
  REFLECTION_DRAFT_SCHEMA_VERSION,
  REFLECTION_DRAFT_SCOPE,
  REFLECTION_SLOTS,
  REVISION_INTENT_DOMAINS,
} from '../../kernel/contracts/reflection.ts'
import { REFLECTION_MAX_WINDOW_INPUTS } from '../../kernel/contracts/reflection-input.ts'
import type {
  ReflectionDraftCall,
  ReflectionDraftProvider,
} from '../../kernel/app/reflection/draft-port.ts'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'
/** 兜底硬超时（真正的期限由内核给，见 `call.deadlineMs`；`D30` 冻结 20 秒） */
const DEFAULT_TIMEOUT_MS = 20_000

export const OPENAI_REFLECTION_DRAFT_ID = 'openai-compatible-reflection-draft@1'
export const REFLECTION_DRAFT_PROMPT_VERSION = 'reflection-prompt@8'

export interface ReflectionProviderObservation {
  readonly outcome: 'returned' | 'transport_failed'
  readonly stage: 'fetch' | 'body' | 'content'
  readonly failure: 'http' | 'network' | 'body' | 'missing_content' | 'deadline' | 'cancelled' | null
  readonly httpStatus: number | null
  readonly firstByteMs: number | null
  readonly durationMs: number
}

export interface OpenAiReflectionDraftOptions {
  readonly env?: Record<string, string | undefined>
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly onObservation?: (observation: ReflectionProviderObservation) => void
}

/** 字段的人话说明（只列契约里真的允许出现的那些） */
const FIELD_NOTES: Readonly<Record<string, string>> = {
  schemaVersion: `固定写成 ${JSON.stringify(REFLECTION_DRAFT_SCHEMA_VERSION)}`,
  focusQuestion: '这次要问自己的问题（≤300 码点，一句话）',
  explanation: `候选**解释**（≤${String(REFLECTION_DRAFT_MAX_TEXT_CODEPOINTS)} 码点；它是解释，不是事实）`,
  supportHandles: '支持它的 handle id —— **只能**从程序给出的集合里选，**不得编造**',
  counterHandles: '与它相反的证据 handle id（没有就给空数组；**不许**把支持项填进来）',
  scope: `固定写成 ${JSON.stringify(REFLECTION_DRAFT_SCOPE)}（当前角色与当前用户）`,
  suggestedSlot: `只有稳定处置依据充分才建议，从这三个封闭槽位里选：${REFLECTION_SLOTS.join(' | ')}；一次即时补救不填该字段`,
  revisionIntent:
    `如果要提请**别的域**修订，给 {domain, targetId, expectedRevision}；` +
    `domain 只能是 ${REVISION_INTENT_DOMAINS.join(' | ')}；` +
    '⚠️ **只给坐标**，不要把那个域的提案正文写进来（形状归那个域自己定义）',
}

/**
 * **从契约生成**提示词（导出是为了让门能断言"提示词与契约同步"）。
 */
export function buildReflectionInstruction(includeComparison = false): string {
  const fields = REFLECTION_DRAFT_FIELD_ALLOWLIST.map(
    (field) => `- ${field}：${FIELD_NOTES[field] ?? '（见契约）'}`
  ).join('\n')
  return [
    '你是"自我反思"的候选生成器。读下面这段**有界**的对话与来源读数，输出**一个 JSON 对象**。',
    '',
    '硬规则：',
    '1. **只输出 JSON**：不要解释、不要 markdown 代码围栏、不要在 JSON 前后写任何字。',
    '2. **不许编造 id**：`supportHandles` / `counterHandles` 只能从程序给出的 handle 集合里选。',
    '3. **不许产出闭集以外的值**：未知字段、未知枚举一律算非法输出。',
    `4. **只能写这 ${String(REFLECTION_DRAFT_FIELD_ALLOWLIST.length)} 个字段**：`,
    REFLECTION_DRAFT_FIELD_ALLOWLIST.join(' | '),
    `5. **必填**：${REFLECTION_DRAFT_REQUIRED_FIELDS.join(' | ')}`,
    '6. suggestedSlot / revisionIntent 是可选字段；不适用就完全省略，不写 null、空字符串或占位值。',
    '',
    '反迎合与证据纪律（这是本产品的硬要求，不是风格建议）：',
    '· **一次反馈不构成规律**：只有一个来源（或只在一个会话里出现）时，**不要**声称"她总是这样"；',
    '· **不要为了让她显得体贴而编造解释**：没有支持的洞见就少说，宁可给更弱的解释；',
    '· **用户自己的话只能证明"他说过"**：它不能证明外部事实；',
    '· **她（助手）自己说过的话不是证据**：不能拿她的话当"用户报告"；',
    '· **程序结果不等于用户意思**：系统跑出来的成功/失败不是用户的评价；',
    ...(includeComparison ? [
      '· **辅助比较材料不是证据**：程序给的"当时预测 / 实际发生"对照只用来帮你指出具体偏差，',
      '  **不许**把它写进 supportHandles / counterHandles，**也不许**把它当成一条独立经历；',
      '  目标或承诺声明表示意图，不是对世界的预测；结局受阻不证明成功判据被反驳。',
    ] : []),
    '· **有反例就如实写进 `counterHandles`**：不许把相反的证据藏起来；',
    '· **不确定就降低主张**：宁可只描述"这次是什么情况"，不要上升为她的性格。',
    '· suggestedSlot 是有充分依据时的稳定处置建议，不是每次都必须三选一；依据已遗忘、属于别的用户、只有一个经历被反复转述，或直接冲突未解决时，省略该字段，只说明当前限制。',
    '· 不得把助手自己的推测当成用户报告来建议稳定调整；说明这次说过什么不等于已具备成长依据。',
    '· 先判断是否能建议稳定处置，再选槽：至少三件可用且独立的支持经历、跨至少两个会话、没有未解决的相反要求。缺少依据时省略suggestedSlot；不能把“这次该承认错误”改写成稳定的acknowledge_correction_first。',
    '· 分别判断一条用户报告中的事件和要求：若它明确报告又发生了一个新的同类情境，同时要求某种处置，它可以支持该处置；没有处理结果不等于没有新经历。只提出当前要求而未报告新情境，或重述同一件旧事，不增加独立支持经历。不要仅凭不同id或会话数认定经历独立。',
    '· 已遮蔽或撤回的旧反馈、他人的反馈、助手自述猜测、同一经历的复述不能用“先承认更正”兜底；即使你在explanation中正确写了风险或停止沿用，仍必须省略suggestedSlot。当前用户要求停止旧做法这一句话本身不是三件独立支持经历。',
    '· supportHandles与counterHandles围绕所建议的处置方式判定：先前按该方式正确处理的成功经历是支持，不是反例；一次犯错后用户要求采用该方式也是支持。真正反例是同类条件下要求相反处置且未协调的证据，不能仅因“已经做对了”把成功实例放进counterHandles。',
    '· 一个有界窗口可以合并多个会话的来源。来源会话数由程序读数给出，不能因这些行在同一个窗口就说它们属于同一会话；缺失读数也不能自行断言只有一个会话。会话数只是结构读数，不代表经历独立、内容印证或用户事实已成立。',
    '· revisionIntent 只有程序明确给出既有目标的 domain / targetId / 当前正整数 revision 时才填写；未提供这些坐标就省略，不能新编 targetId，不能把行动名称写成 expectedRevision。',
    '',
    '字段说明：',
    fields,
    '',
    '输出形状示例：',
    JSON.stringify({ schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION, focusQuestion: '需要核对哪种处置方式？',
      explanation: '说明来源支持与限制。', supportHandles: [], counterHandles: [], scope: REFLECTION_DRAFT_SCOPE }),
    '这是完整对象的形状示例，数组须按实际证据填写；是否追加可选字段仍按上述门槛判断。不要输出 JSON Schema、type 字段或不完整对象。',
  ].join('\n')
}

/** 把有界窗口渲染成用户消息（只给 id / 角色 / 有界文本；工具输出不进窗口） */
export function buildReflectionUserMessage(call: ReflectionDraftCall): string {
  const sessions = new Map<string, string>()
  const window = call.window
    .slice(0, REFLECTION_MAX_WINDOW_INPUTS)
    .map((entry) => {
      let session = ''
      if (entry.conversationId !== undefined && entry.conversationId !== '') {
        if (!sessions.has(entry.conversationId)) sessions.set(entry.conversationId, `S${sessions.size + 1}`)
        session = `，来源会话${sessions.get(entry.conversationId)}`
      }
      return `- [${entry.id}] ${entry.kind}（${entry.sourceClass}${session}）：${entry.text}`
    })
    .join('\n')
  const handles = call.handles
    .map((handle) => `- ${handle.id}（${handle.kind}）`)
    .join('\n')
  const counters =
    call.counterHandles.length === 0
      ? '（程序没有发现反例）'
      : call.counterHandles.map((handle) => `- ${handle.id}`).join('\n')
  /*
   * ⚠️ **比较材料是单独一段**，与"合法依据"**物理分开**（三域应用方案 §4）。
   *    它**不是证据**：不能被引用进 `supportHandles` / `counterHandles`。
   *    段落标题逐字写明"不是证据" —— 提示词里的标签是**事实约束**，不是风格建议。
   * ⚠️ 缺省（没有比较材料）⇒ 这一段**整个不出现** ⇒ prompt 基线逐字不变。
   */
  const comparisonSection =
    call.comparisons === undefined || call.comparisons.length === 0
      ? []
      : [
          '',
          '**辅助比较材料（不是证据）**：下面是程序给出的"当时预测 / 实际发生"对照，',
          '用来帮你指出**具体**的偏差。它**不能**被写进 supportHandles / counterHandles，',
          '也不能单独构成一条依据 —— 只有上面窗口里的来源才是依据。',
          ...call.comparisons.map(
            (row) =>
              `- [${row.comparisonId}] ${row.outcomeKind} · ${row.outcomeCode}\n` +
              `  原定意图：${row.predictedText}\n` +
              `  实际发生：${row.actualText}` +
              (row.reviewCriterion === undefined
                ? '\n  待复核的成功判据：（未提供）'
                : `\n  待复核的成功判据：${row.reviewCriterion}`)
          ),
        ]
  return [
    '合法 handle 集合（`supportHandles` / `counterHandles` 只能从这里选）：',
    handles === '' ? '（空）' : handles,
    '',
    '程序发现的反例 handle：',
    counters,
    ...comparisonSection,
    '',
    `触发原因码（程序给）：${call.triggerReasonCodes.join(', ') || '（无）'}`,
    ...(call.sourceConversationCount === undefined ? [] : [`来源会话数（程序结构读数，不代表内容印证）：${call.sourceConversationCount}`]),
    '',
    '有界窗口：',
    window === '' ? '（空）' : window,
  ].join('\n')
}

/**
 * 造一个真模型 provider。
 *
 * ⚠️ **没有 key 时** `call()` 直接**抛**（不静默返回空候选）：
 *    "没有凭证"与"她想不出洞见"在输出上必须不一样。
 */
export function createOpenAiReflectionDraftProvider(
  options: OpenAiReflectionDraftOptions = {}
): ReflectionDraftProvider {
  const env = options.env ?? process.env
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  const baseURL = ((env.OPENAI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_MODEL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    name: OPENAI_REFLECTION_DRAFT_ID,
    version: model,
    promptVersion: REFLECTION_DRAFT_PROMPT_VERSION,

    async call(call: ReflectionDraftCall): Promise<unknown> {
      if (apiKey === '') {
        throw new Error('OPENAI_API_KEY 缺失 ⇒ 反思候选不调用模型（不回落任何其它凭证来源）')
      }
      const budgetMs = Math.max(1, Math.min(timeoutMs, call.deadlineMs))
      const controller = new AbortController()
      const signal = call.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, call.signal])
      if (signal.aborted) throw new Error('reflection_provider_cancelled')
      const timer = setTimeout(() => controller.abort(), budgetMs)
      let abortListener: () => void = () => {}
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new Error('reflection_provider_cancelled_or_deadline'))
        signal.addEventListener('abort', abortListener, { once: true })
      })
      const started = performance.now()
      const observation: { stage: ReflectionProviderObservation['stage']; outcome: ReflectionProviderObservation['outcome']; failure: ReflectionProviderObservation['failure'] } =
        { stage: 'fetch', outcome: 'transport_failed', failure: null }
      let httpStatus: number | null = null
      let firstByteMs: number | null = null
      try {
        return await Promise.race([(async () => {
        const response = await doFetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: buildReflectionInstruction((call.comparisons?.length ?? 0) > 0) },
              { role: 'user', content: buildReflectionUserMessage(call) },
            ],
          }),
          signal,
        })
      firstByteMs = performance.now() - started
      httpStatus = response.status
      if (!response.ok) {
        observation.failure = 'http'
        throw new Error(`反思候选 HTTP ${String(response.status)}`)
      }
      observation.stage = 'body'
      const payload = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[]
      }
      observation.stage = 'content'
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        observation.failure = 'missing_content'
        throw new Error('反思候选响应里没有 choices[0].message.content')
      }
      observation.outcome = 'returned'
      const stripped = content
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
      try {
        return JSON.parse(stripped) as unknown
      } catch {
        /* ⚠️ 不是 JSON ⇒ **返回原文**（内核判 `invalid`，不是 `transport`） */
        return content
      }
        })(), aborted])
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abortListener)
        options.onObservation?.({ ...observation, httpStatus, firstByteMs, durationMs: performance.now() - started,
          failure: observation.outcome === 'returned' ? null : controller.signal.aborted ? 'deadline' : call.signal?.aborted ? 'cancelled' :
            observation.failure ?? (observation.stage === 'body' ? 'body' : 'network') })
      }
    },
  }
}
