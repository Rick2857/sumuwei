/**
 * M10.1 WP2b —— **约定识别的真模型 provider**（慢路径的唯一一处模型调用）。
 *
 * ============================================================================
 *  它做什么 / 不做什么
 * ============================================================================
 * ```text
 * 做  ：把**程序渲染好的有界窗口**（`renderAgreementWindow`，每行 `[序号] 说话者：正文`）
 *       连同**从契约派生的字段说明**交给模型，取回一个 JSON。
 * 不做：**不解析、不校验、不写**。它只把原文交回去 —— 形状闸与语义闸都在
 *       `recognizeAgreement`（`contracts/agreement-model-draft.ts`）与 WP1 的校验器里。
 *       ⚠️ "模型说的"与"程序认的"必须分在两个地方：合在一起就没法断言"是谁拒的"。
 * ```
 *
 * 三条硬边界（与 `openai-goal-understanding.ts` 同源）：
 * ```text
 * ① **没有 key ⇒ 抛**（不静默返回 `none`）："没有凭证"与"这一段没有约定"必须不一样。
 * ② **网络/超时 ⇒ 抛**（内核把它记成 transport，不是 invalid、也不是 none）。
 * ③ **JSON 解析失败 ⇒ 返回原文**（**不**抛）：模型"给了东西但不是 JSON"属于 `invalid`，
 *    抛出去会被记成 transport —— 那是**说错了原因**。
 * ```
 */

import {
  AGREEMENT_MODEL_DRAFT_FIELDS,
  AGREEMENT_MODEL_DRAFT_KINDS,
  AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION,
} from '../../kernel/contracts/agreement-model-draft.ts'
import {
  AGREEMENT_CONTENT_MAX_CODEPOINTS,
  AGREEMENT_CRITERION_MAX_CODEPOINTS,
  AGREEMENT_DUE_BASIS_MAX_CODEPOINTS,
} from '../../kernel/contracts/agreement-input.ts'
import { renderAgreementWindow } from '../../kernel/app/agreement/inputs.ts'
import type { AgreementWindowInput } from '../../kernel/contracts/agreement-input.ts'

export const OPENAI_AGREEMENT_UNDERSTANDING_ID = 'openai-compatible-agreement-understanding@1'
export const AGREEMENT_INSTRUCTION_VERSION = 'agreement-instruction@1'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'
const DEFAULT_TIMEOUT_MS = 25_000

export interface OpenAiAgreementOptions {
  readonly env?: Record<string, string | undefined>
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

/** 约定识别的 provider（`call` 只交回**原文**） */
export interface AgreementDraftProvider {
  readonly name: string
  readonly version: string
  call(input: {
    readonly window: AgreementWindowInput
    readonly signal: AbortSignal
    readonly deadlineMs: number
  }): Promise<unknown>
}

/**
 * **从契约派生**的提示词（导出是为了让门能断言"提示词与契约同步"）。
 *
 * ⚠️ 它只列**闭集里的字段**与上界；加字段时这里补一句说明即可。
 */
export function buildAgreementInstruction(): string {
  const fields = AGREEMENT_MODEL_DRAFT_FIELDS.join(' · ')
  return [
    '你在读一段**最近的对话**，任务是：判断其中有没有一条**双方合意**的约定。',
    '',
    '硬规则：',
    `1. **只输出一个 JSON 对象**，字段**只能**是：[${fields}]，\`schemaVersion\` 固定写成 ${JSON.stringify(
      AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION
    )}。`,
    `2. \`kind\` 取值：${AGREEMENT_MODEL_DRAFT_KINDS.map((kind) => `\`${kind}\``).join(' / ')}。` +
      '**没有**双方合意的约定就输出 `{"schemaVersion":"' +
      AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION +
      '","kind":"none"}`。',
    '3. **必须指出处**：`proposedBySeq` 是"提出"那一行的**方括号序号**，`acceptedBySeq` 是"接受"那一行的序号。',
    '   ⚠️ **序号只能取自已给的行**，不许编；**提出与接受必须是不同说话者**（自说自话不是合意）；',
    '   **提出必须早于接受**；**引用到"已知内容被遮蔽"的行就直接放弃**（输出 `none`）。',
    '4. `content` 是约定内容（≤' +
      String(AGREEMENT_CONTENT_MAX_CODEPOINTS) +
      ' 码点），`criterion` 是**可核对**的判据（≤' +
      String(AGREEMENT_CRITERION_MAX_CODEPOINTS) +
      ' 码点，例如"他到楼下，由他报告"）。',
    '5. ⚠️ **不要猜绝对时刻**：需要说明时间口径就写 `dueBasis`（人话，≤' +
      String(AGREEMENT_DUE_BASIS_MAX_CODEPOINTS) +
      ' 码点，例如"明天上午"），**不要**编日期时间。',
    '6. ⚠️ **宁可不写**：含糊、玩笑、单方陈述、只是提到一件事 —— 都不算约定，输出 `none`。',
    '',
    '对话（每行：`[序号] 说话者：正文`；"已知内容被遮蔽"的行不可作为依据）：',
  ].join('\n')
}

/**
 * 造一个真模型 provider。
 *
 * ⚠️ **没有 key 时** `call()` 直接**抛**（`M10.1` 的 `D02`：慢路径要么真跑，要么如实失败）。
 */
export function createOpenAiAgreementDraftProvider(
  options: OpenAiAgreementOptions = {}
): AgreementDraftProvider {
  const env = options.env ?? process.env
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  const baseURL = ((env.OPENAI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_MODEL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    name: OPENAI_AGREEMENT_UNDERSTANDING_ID,
    version: AGREEMENT_INSTRUCTION_VERSION,

    async call(input): Promise<unknown> {
      if (apiKey === '') {
        throw new Error('OPENAI_API_KEY 缺失 ⇒ 约定识别不调用模型（不回落任何其它凭证来源）')
      }
      const budgetMs = Math.max(1, Math.min(timeoutMs, input.deadlineMs))
      const controller = new AbortController()
      const onAbort = (): void => controller.abort()
      input.signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), budgetMs)
      let response: Response
      try {
        response = await doFetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: 'system', content: buildAgreementInstruction() },
              {
                role: 'user',
                content: `${renderAgreementWindow(input.window)}\n\n（程序读数：共 ${String(
                  input.window.facts.entryCount
                )} 行；她 ${String(input.window.facts.characterCount)} 行 / 用户 ${String(
                  input.window.facts.userCount
                )} 行）`,
              },
            ],
          }),
          signal: controller.signal,
        })
      } catch (error) {
        throw new Error(
          `约定识别请求失败：${error instanceof Error ? error.message : String(error)}`
        )
      } finally {
        clearTimeout(timer)
        input.signal.removeEventListener('abort', onAbort)
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`约定识别 HTTP ${String(response.status)}：${body.slice(0, 200)}`)
      }
      const payload = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[]
      }
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw new Error('约定识别响应里没有 choices[0].message.content')
      }
      const stripped = content
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
      try {
        return JSON.parse(stripped) as unknown
      } catch {
        /* ⚠️ 解析失败**返回原文**（不抛）：那是 `invalid`，不是 transport */
        return content
      }
    },
  }
}
