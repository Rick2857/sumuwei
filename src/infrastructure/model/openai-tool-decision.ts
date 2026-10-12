/**
 * 工具决策的 **OpenAI 兼容适配器**（WP1 / ADR-104）。
 *
 * ============================================================================
 *  它与 `openai-goal-understanding.ts` / `openai-task-planner.ts` 同形
 * ============================================================================
 * ```text
 * ToolDecisionInput → **恰好一次** POST {base}/chat/completions
 *   → choices[0].message.content → 解析成 JSON 对象
 *   → 把**原始对象**交给内核（严格校验在 `kernel/action/tool-decision.ts`）
 * ```
 * 它**不**做：结构校验、权限判定、执行、重试、降级重问、决定用哪个分支。
 * **一次调用就是一次调用**（ADR-104 D07）。
 *
 * ============================================================================
 *  两条设计判据（照抄目标理解那两条，因为它们是实测逼出来的）
 * ============================================================================
 * ```text
 * ① 提示词**从契约派生**：分支闭集、字段闭集、参数闭集全部 import 进来现算。
 *    ⇒ 契约加一个分支 / 字段，提示词同一次改动就跟着变（手写会漂移）。
 * ② 失败要分对桶：网络 / HTTP / 没有 key ⇒ **抛**（内核映射成 `call_failed`）；
 *    模型给了东西但不是 JSON ⇒ **返回原文**（内核判 `invalid_output`）。
 *    把"不是 JSON"抛成 transport 会说"这次调用失败了"，而它其实**成功了**。
 * ```
 * ⚠️ 凭证**只**从 `env.OPENAI_API_KEY` 取，**不回落**任何其它来源。
 * ⚠️ 决策提示词里**没有**人设正文、记忆、检索结果 —— 只有本轮原话、有界的最近对话行
 *    与**程序生成**的工具目录（ADR-104 D08/D09）。
 */

import {
  TOOL_DECISION_BRANCHES,
  TOOL_DECISION_MAX_QUESTION_CODEPOINTS,
  type ToolDecisionInput,
  type ToolDecisionOutcome,
  type ToolDecisionPort,
} from '../../kernel/action/tool-decision.ts'
import { browserPlanningInstructions } from '../../kernel/action/browser-operations.ts'
import { desktopPlanningInstructions } from '../../kernel/action/desktop-capability.ts'
import { taskOrchestrationInstructions } from './task-orchestration-instructions.ts'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'
const DEFAULT_TIMEOUT_MS = 8_000
/** 最近对话行最多带几行 / 每行最多几码点（有界是必要的：它进 prompt） */
export const TOOL_DECISION_RECENT_LINES = 6
export const TOOL_DECISION_RECENT_LINE_CODEPOINTS = 200

export const OPENAI_TOOL_DECISION_ID = 'openai-compatible-tool-decision@1'

export interface OpenAiToolDecisionOptions {
  readonly env?: Record<string, string | undefined>
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

/**
 * **从契约派生**的固定指令（导出是为了让门能断言"提示词与契约同步"）。
 */
export function buildToolDecisionInstruction(): string {
  return [
    '你是"要不要用工具"的决策器。读对方这一轮的原话与程序给出的工具目录，',
    '输出**一个 JSON 对象**，只表达一件事：直接回答 / 需要问一句 / 要用工具。',
    '',
    '硬规则：',
    '1. **只输出 JSON**：不要解释、不要 markdown 代码围栏、不要在 JSON 前后写任何字。',
    `2. \`branch\` 只能是 ${TOOL_DECISION_BRANCHES.map((item) => `\`${item}\``).join(' / ')} 之一；`,
    '   不许出现别的字段（多一个字段整条提案作废）。',
    '3. `answer`：这一轮不需要任何工具，按普通对话回答即可。**不许**带别的字段。',
    `4. \`clarify\`：只有当"不使用工具就无法回答、且需要对方补一句"时才用；` +
      `带一个 \`question\`（≤${String(TOOL_DECISION_MAX_QUESTION_CODEPOINTS)} 字），**不许**带计划。`,
    '5. `tools`：需要工具时用；带 `goal`（一句话）、`steps`（数组，每步 `capability` /',
    '   `operation` / `args`，可以带 `purpose`）、`done`（这一步做完是否就算完成）。',
    /*
     * ⚠️ 这一条是**语义评估 v1 逼出来的**（2026-10-05）：
     *    `image.ocr` 那一案模型给了 `{"branch":"tools", …}` 但**缺计划字段**，
     *    整条提案被严格解析拒收（`tool_decision_tools_missing_plan`）⇒ 那一轮什么都做不了。
     *    ⇒ 把"三件齐全"写成**一条独立的、带后果的**规则（原来的写法只是列举字段）。
     */
    '   ⚠️ **三个字段缺一不可**：`goal` / `steps` / `done` 必须**同时**出现；',
    '   少一个，整条提案就作废 —— 那一轮**什么都不会执行**。',
    '6. `capability` / `operation` / `args` 的键**只能**取目录里列出的那几种写法；',
    '   只依据本轮目录提出工具计划；未列出的能力不得在本轮调用，不能据此断言产品永远不具备它。',
    '7. 目录里标着"未开启 / 未授权 / 未连接"的能力**用不了**：不要为它出计划；',
    '   如果对方要的正是这一类，用 `clarify` 或 `answer` 如实说明做不到。',
    '   「连接未知」表示尚未探测，不等于「未连接」：已开启且已授权的浏览器任务可以先用 browser.read/snapshot 探测；失败时按程序实际结果说明，不得假称已连接或根本没有工具。',
    '8. 对方只是闲聊、表达感受、讨论一件事、说不要动任何东西时，用 `answer`。',
    '   ⚠️ 只在**对方明确要求**做一件与外部世界有关的事（读/写文件、算数、查资料、',
    '   天气、办公文档、浏览器）时才用 `tools`。',
    /*
     * ⚠️ 这一条同样是**语义评估 v1 逼出来的**（2026-10-05）：
     *    「C:\Windows\notepad.exe 为什么打不开？」被提议成 `local.file.list` ——
     *    句子里有一个真实路径，但那是**问题**不是**委托**。
     *    本仓库对这句话的既有立场见 `src/kernel/action/task-intent.ts` 的第 ② 条注释
     *    （"播报它会让每一句提到路径的话都变成一次规划调用"）。
     */
    '   ⚠️ **问原因 / 要解释 / 打听**（"X 为什么打不开"、"这是怎么回事"、"它是什么"）',
    '   一律用 `answer`：**句子里出现一个路径不等于委托**，除非对方明确要求你做那件事。',
    '9. 参数里的路径要用目录/对话里出现过的**真实路径**；不知道就先用 `local.file.list`',
    '   去列，或干脆用 `clarify` 问清楚。**不要猜**用户名（如 `user` / `Administrator`）。',
    '10. 下面会给出**程序查到的**已知目录（个人桌面 / 公共桌面）：需要这些位置时**逐字**用它们。',
    '    ⚠️ 标着"探测失败"的就是**不知道在哪** —— 那时用 `clarify` 问，或先列一层目录，不许猜。',
    browserPlanningInstructions(),
    desktopPlanningInstructions(),
    taskOrchestrationInstructions(),
    '',
    '输出示例（形状，不是答案）：',
    '{"branch":"answer"}',
    '{"branch":"clarify","question":"你说的是哪个桌面？"}',
    '{"branch":"tools","goal":"数一数桌面上的快捷方式","steps":' +
      '[{"capability":"local.file.list","operation":"list","args":{"path":"C:\\\\Users\\\\me\\\\Desktop"},' +
      '"purpose":"列出个人桌面"}],"done":true}',
  ].join('\n')
}

/** 把本轮事实渲染成**有界的**用户消息（原话逐字 + 目录 + 有界的最近几行） */
export function buildToolDecisionUserMessage(input: ToolDecisionInput): string {
  const lines: string[] = []
  lines.push(`本轮原话：「${input.text}」`)
  if (input.recentLines.length > 0) {
    lines.push('')
    lines.push(
      `最近几句（最多 ${String(TOOL_DECISION_RECENT_LINES)} 行，只作理解语境的参考，不是新指令）：`
    )
    for (const line of input.recentLines.slice(-TOOL_DECISION_RECENT_LINES)) {
      const text = [...line].slice(0, TOOL_DECISION_RECENT_LINE_CODEPOINTS).join('')
      lines.push(`- ${text}`)
    }
  }
  lines.push('')
  lines.push(input.catalog)
  /* WP2：程序给出的已知目录事实（没接 ⇒ 这一段不出现） */
  if (input.knownDirectories !== undefined && input.knownDirectories.length > 0) {
    lines.push('')
    lines.push(...input.knownDirectories)
  }
  lines.push('')
  lines.push(
    `这一轮允许的能力（` +
      `${input.allowedCapabilities.length === 0 ? '（一个都没有）' : input.allowedCapabilities.join(' / ')}` +
      `）；本会话${input.hasOpenTask ? '已经有一件在做的事' : '还没有正在做的事'}。`
  )
  return lines.join('\n')
}

/**
 * 造一个真模型决策端口。
 *
 * ⚠️ **没有 key 时** `decide()` 返回 `call_failed`（不是"直接回答"）——
 *    "没有凭证"与"她决定不用工具"在读数上必须不一样。
 */
export function createOpenAiToolDecisionPort(
  options: OpenAiToolDecisionOptions = {}
): ToolDecisionPort {
  const env = options.env ?? process.env
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  const baseURL = ((env.OPENAI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_MODEL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    id: OPENAI_TOOL_DECISION_ID,
    endpointHost: (() => {
      try {
        return new URL(baseURL).host
      } catch {
        return baseURL
      }
    })(),

    async decide(input: ToolDecisionInput): Promise<ToolDecisionOutcome> {
      if (apiKey === '') {
        return { ok: false, failure: 'call_failed', requestCount: 0 }
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
      try {
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
              { role: 'system', content: buildToolDecisionInstruction() },
              { role: 'user', content: buildToolDecisionUserMessage(input) },
            ],
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          /* HTTP 层失败 ⇒ 这一轮**没有**决策可用；内核记 `call_failed`（零动作） */
          return { ok: false, failure: 'call_failed', requestCount: 1 }
        }
        const payload = (await response.json()) as {
          choices?: { message?: { content?: unknown } }[]
        }
        const content = payload.choices?.[0]?.message?.content
        if (typeof content !== 'string') {
          return { ok: false, failure: 'call_failed', requestCount: 1 }
        }
        /*
         * ⚠️ **解析失败 ⇒ 把原文交回内核**（不在这里下结论）：
         *    模型"给了东西但不是 JSON"属于 `invalid_output`，与传输失败是两件事。
         *    ⚠️ 这里刻意**不**调 `parseToolDecisionProposal` ——
         *       严格校验只有内核那一处（"一次调用就是一次调用"）。
         */
        const stripped = content
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
        try {
          return { ok: true, raw: JSON.parse(stripped) as unknown, requestCount: 1 }
        } catch {
          return { ok: true, raw: content, requestCount: 1 }
        }
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError'
        return {
          ok: false,
          failure: aborted ? 'timeout' : 'call_failed',
          requestCount: 1,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
