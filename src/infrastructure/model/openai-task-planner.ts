/**
 * 任务规划器的 **OpenAI 兼容适配器**（第二批计划 §2.2）。
 *
 * ============================================================================
 *  它与 `openai-search-need-judge.ts` 是同一套形状，理由也一样
 * ============================================================================
 * ```text
 * TaskPlannerInput  →  恰好一次 POST {base}/chat/completions（固定指令 + 任务 + 已执行）
 *                   →  取 choices[0].message.content
 *                   →  parseTaskPlan（严格：未知字段 / 越权能力 / 白名单外参数一律拒）
 *                   →  TaskPlannerOutcome（一份可用计划，或闭集失败码 + 如实请求数）
 * ```
 * 复用**既有**环境变量（`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_SMALL_MODEL`）
 * ⇒ **不新增依赖、不新增凭证来源、不新增出站目标**。
 *
 * ⚠️ 隐私：失败信息**绝不**带回模型输出或任务原话，只报**闭集码 + 长度**。
 *    规划器的输出里会有用户要写进文件的内容 —— 那是**最不该**进 trace 的东西。
 *
 * ⚠️ 与判定器的一处**刻意差异**：规划器看到的是"用户要我做什么 + 我已经做了什么"，
 *    因此它的输入里**有**任务原话（那不奇怪：它就是任务本身）。
 *    但它**仍然没有**人设、记忆、检索历史、userId —— 端口形状里就没有它们的位置。
 */

import {
  MAX_STEPS_PER_PLAN,
  TASK_ARG_KEYS,
  type TaskPlan,
  type TaskPlannerFailure,
  type TaskPlannerInput,
  type TaskPlannerOutcome,
  type TaskPlannerPort,
  type TaskPlanParseCode,
  parseTaskPlan,
  extractTaskPlanJson,
  validateTaskPlan,
  toSafeTaskPlanParseCode,
} from '../../kernel/action/task-plan.ts'
import type { CapabilityRegistry } from '../../kernel/action/capability-registry.ts'
import { browserPlanningInstructions } from '../../kernel/action/browser-operations.ts'
import { desktopPlanningInstructions, isDesktopCapability } from '../../kernel/action/desktop-capability.ts'
import { taskOrchestrationInstructions } from './task-orchestration-instructions.ts'

export const OPENAI_TASK_PLANNER_ID = 'openai-chat-completions'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_SMALL_MODEL = 'deepseek-v4.1-flash'

/** 规划调用的硬超时（毫秒）。**与搜索判定器的 25000ms 无关**：这是另一件事。 */
export const TASK_PLANNER_TIMEOUT_MS = 45_000

/**
 * 规划调用的输出上限（token）。
 *
 * ⚠️ 它必须够大：一份计划里可以带**整个文档的正文**（`content`）。
 *    取值依据是同一端点上的实测教训（判定器 800 被思维链吃光 ⇒ 内容缺失）。
 *    首版给 **8000**，并把它当作**运行约束**而不是性能 SLA。
 */
export const TASK_PLANNER_MAX_TOKENS = 8_000

/** 已经执行过的步骤摘要最多带几条（防止把无限历史塞进 prompt） */
export const MAX_EXECUTED_IN_PROMPT = 40

export interface OpenAiTaskPlannerOptions {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxTokens?: number
  /** 能力登记表（解析计划时要问"这个操作存在吗"） */
  registry: CapabilityRegistry
  /** Opt-in up to three alternatives; ordinary planner output remains unchanged. */
  candidateCount?: 3
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown } }[]
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return ''
  }
}

/**
 * 固定指令（**程序常量**）。
 *
 * ⚠️ 它是"工具性规划"，不是"她在思考"：没有人格、没有称呼、没有情绪。
 *    输出的唯一消费者是 `parseTaskPlan`。
 */
export function buildTaskPlannerInstruction(allowedCapabilities: readonly string[]): string {
  const lines: string[] = []
  for (const capability of allowedCapabilities) {
    const keys = TASK_ARG_KEYS[capability] ?? []
    lines.push(`- ${capability}  参数：${keys.length === 0 ? '（无）' : keys.join(', ')}`)
  }
  return [
    '你是一个"把用户任务拆成有限动作步骤"的规划器。你只输出一个 JSON 对象。',
    '',
    '只输出 JSON，不要输出任何其它文字，不要用代码块围栏。字段恰好是：',
    '  goal: 字符串，一句话说明这一轮在做什么',
    `  steps: 数组，最多 ${String(MAX_STEPS_PER_PLAN)} 步`,
    '  done: 布尔，表示任务是否已经全部完成',
    '',
    'steps 里每一项的字段恰好是：',
    '  capability: 字符串，必须**逐字**取自下面的清单',
    '  operation: 字符串，必须与下面清单里该能力的操作一致',
    '  args: 对象，键必须**只能**取自该能力的参数清单',
    '  purpose: 字符串（可选），一句话说明这一步要达成什么',
    '',
    '允许的能力（括号里是该能力允许的参数名）：',
    ...lines,
    '',
    'operation 取值：',
    ...(allowedCapabilities.includes('document.extract') ? ['document.extract=read，reader 仅为 markitdown 或 pdfminer；只读用户明确给出的 PDF 路径。'] : []),
    ...(allowedCapabilities.includes('document.profile') ? ['document.profile=inspect，只读 path 的结构，不返回正文；部分检查或失败时文本层未知。'] : []),
    ...(allowedCapabilities.includes('document.pages') ? ['document.pages=read，firstPage/lastPage 为从 1 开始的物理页，最多 4 页、总 1200 字符；reader 仅 pdfplumber/pdfminer，可选 prefixChars 每页前缀。只读明确请求范围，截断不能说整页已读完。'] : []),
    '  local.file.list=list · local.file.read=read · local.file.write=write ·',
    '  document.read=read · image.ocr=recognize · math.calculate=evaluate ·',
    '  web.read=read · weather.query=forecast · office.generate=generate ·',
    '  news.read=read · browser.read=snapshot · browser.operate=act',
    ...(allowedCapabilities.includes('workflow.skill') ? ['  workflow.skill=load（skill 只能 personal-library / writing-collaboration；只需加载一次）'] : []),
    ...(allowedCapabilities.includes('library.search') ? ['  library.search=search（query 用少量关键词，空串列资料；按真实返回路径深读）'] : []),
    ...(allowedCapabilities.includes('research.arxiv') ? ['  research.arxiv=search / abstract / read / cite；search 只用 query/limit，其余用 paperId，read 可加 section。paperId 如 1706.03762，不要给 URL。'] : []),
    ...(allowedCapabilities.includes('browser.operate') ? [browserPlanningInstructions()] : []),
    ...(allowedCapabilities.some(isDesktopCapability) ? [desktopPlanningInstructions()] : []),
    taskOrchestrationInstructions(),
    '',
    '硬约束（逐条都能被机器校验；多一个字段整条计划都会被丢弃）：',
    '· 你的回复必须是**一个** JSON 对象，且是唯一输出：不要解释、不要前后缀、不要代码块围栏。',
    '· 顶层**只能**有 goal / steps / done 三个字段。steps 的每一项**只能**有上面四个字段。',
    '· 任何清单之外的能力名、任何该能力参数清单之外的参数名，都会让**整条计划**作废。',
    '· 路径必须是**本机绝对路径**（形如 C:\\目录\\文件.txt）。相对路径会被如实拒绝。',
    '· **两个正文参数不要混**（实测过模型会混）：',
    '    local.file.write 用 `content`（要写进文件的**纯文本**正文）；',
    '    office.generate 用 `spec`（**结构化对象**，形如',
    '      {"title":"…","blocks":[{"type":"paragraph","text":"…"}]} /',
    '      {"sheets":[{"name":"Sheet1","columns":[…],"rows":[[…]]}]} /',
    '      {"title":"…","slides":[{"title":"…","bullets":[…]}]}）；',
    '    **不要把 content 用在 office.generate 上**，那样整条计划会被作废。',
    '· office.generate 只支持 docx / xlsx / pptx；PPT 最多 20 页、表格最多 10000 单元格、',
    '  文档正文最多 50000 字符，超限会被拒收整条。',
    '· 不确定就少给几步、把 done 设为 false —— 程序会在看到实际结果后再问你一次。',
    '· 一次只做该做的事：需要读 2 个输入就写 2 步，不要用一步假装做了两件事。',
    /*
     * ⚠️ 这两条是 **2026-10-05 事故**逼出来的（同一个目录被列 6 次、12 次行动烧光、
     *    整轮因为当轮内容超上限而失败）。摘要里现在带 `path=` / `url=` / `query=`
     *    这些**引用**，因此"是不是已经做过"第一次成为模型能判断的问题。
     */
    '· 已经执行过的步骤里带 `path=` / `url=` / `query=`（那是引用）：**同一个引用已经成功过就不要重复**；',
    '  需要换一个做法就换一个引用或换一个能力，否则如实把 done 设为 true 并结束。',
    '· 凭已有结果就能回答用户时，steps 给空数组、done 设为 true —— 不要为了"再确认一次"重复列举或重复读取。',
    '· 找不到用户要的东西时**不要猜名字**（例如不要用 user / Administrator 去凑一个用户名）：',
    '  把已经拿到的引用列出来、如实说找不到，比反复换猜测更省事，也更不容易答错。',
    '· 正确示例：{"goal":"读取输入并生成一份报告","steps":[{"capability":"local.file.read","operation":"read","args":{"path":"C:\\\\work\\\\input.txt"},"purpose":"取得输入内容"}],"done":false}',
  ].join('\n')
}

export function buildTaskPlannerMessages(
  input: TaskPlannerInput
): { role: 'system' | 'user'; content: string }[] {
  const executed =
    input.executed.length === 0
      ? '（还没有执行过任何步骤）'
      : input.executed.slice(-MAX_EXECUTED_IN_PROMPT).join('\n')
  const failures = input.failures.length === 0 ? '（没有失败）' : input.failures.slice(-20).join('\n')
  /*
   * WP2 / ADR-104 `D14`：**实际内容**与**程序事实**。
   *
   * ⚠️ 两块都只在调用方给了的时候才出现（缺省 ⇒ 这一段逐字与第二批的旧 prompt 相同）
   *    —— 于是"没接线"和"接了线但额度为 0"在证据上分得开。
   * ⚠️ 内容块用的是**与注入 prompt 同一套渲染器**产出的文本（`renderTurnContentEntry`），
   *    因此"我看到的"与"她看到的"是同一份东西，不是两份各自转述的摘要。
   */
  const sections: string[] = [
    '用户任务（逐字）：',
    input.task,
    '',
    '已经执行过的步骤（能力.操作 [引用]=结果状态；引用形如 path=… / url=… / query=…）：',
    executed,
    '',
    '其中失败的（能力.操作=失败码）：',
    failures,
    '',
    `本任务还可以执行 ${String(input.remainingActions)} 次动作。`,
  ]
  if (input.content !== undefined && input.content.length > 0) {
    sections.push(
      '',
      '已经真的读到的内容（**这是实际内容，不是摘要**；引用编号与来源见每一条的开头）：',
      input.content.join('\n\n'),
      '',
      '⚠️ 依据上面这些**实际内容**决定下一步：能回答就给空 steps + done=true；',
      '   还缺什么就针对**缺的那一点**再来一步，不要重复已经读到的同一个东西。'
    )
  }
  if (input.evidence !== undefined && input.evidence.length > 0) {
    sections.push(
      '',
      '已经查到的**外部来源**（这是程序给出的命中行；深读某一条就用它逐字的 URL）：',
      input.evidence.join('\n\n'),
      '',
      '⚠️ 要读正文就用上面的 URL 调 `web.read`；**不要**改写 URL、也不要凭印象编一个。'
    )
  }
  if (input.knownDirectories !== undefined && input.knownDirectories.length > 0) {
    sections.push('', ...input.knownDirectories)
  }
  sections.push(
    '',
    '请给出**接下来**要做的那几步（已经做过的不必重复，除非它失败了需要换一种做法）。'
  )
  return [
    { role: 'system', content: buildTaskPlannerInstruction(input.allowedCapabilities) },
    { role: 'user', content: sections.join('\n') },
  ]
}

export function createOpenAiTaskPlanner(options: OpenAiTaskPlannerOptions): TaskPlannerPort {
  const env = options.env ?? process.env
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  const baseURL = ((env.OPENAI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_SMALL_MODEL
  const timeoutMs = options.timeoutMs ?? TASK_PLANNER_TIMEOUT_MS
  const maxTokens = options.maxTokens ?? TASK_PLANNER_MAX_TOKENS
  const registry = options.registry

  const failed = (
    failure: TaskPlannerFailure,
    requestCount: number,
    parseFailureCode?: TaskPlanParseCode
  ): TaskPlannerOutcome => ({
    ok: false,
    failure,
    requestCount,
    ...(parseFailureCode !== undefined ? { parseFailureCode } : {}),
  })

  return {
    id: OPENAI_TASK_PLANNER_ID,
    endpointHost: hostOf(baseURL),

    async plan(input): Promise<TaskPlannerOutcome> {
      if (typeof input.task !== 'string' || input.task.trim() === '') {
        return failed('empty_task', 0)
      }
      // 没有被授权任何能力 ⇒ 一个动作都做不了，连请求都不发
      if (input.allowedCapabilities.length === 0) return failed('call_failed', 0)
      if (apiKey === '') return failed('call_failed', 0)

      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      const onCallerAbort = (): void => controller.abort()
      if (input.signal?.aborted === true) controller.abort()
      else input.signal?.addEventListener('abort', onCallerAbort, { once: true })

      try {
        const response = await doFetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: options.candidateCount === 3
              ? [{ role: 'system', content: '只输出 JSON：{"candidates":[plan,...]}，含1到3份完整候选，最佳放第一。每份 plan 恰好 goal 字符串、done 布尔、steps 数组，最多4步。每步恰好 capability、operation、args 三个字段；例如 {"capability":"sandbox.file.write","operation":"write","args":{"path":"example.txt","content":"原文"}}。只允许 sandbox.file.write/write，args 恰好 path/content；sandbox.file.read/read，args 恰好 path。路径逐字采用任务给定相对路径，正文逐字采用指定字符串解码后的内容。每份计划均须包含最终真实读回；不要声称已执行。只有已执行摘要证明目标已完成时，才给 steps=[]/done=true 的收尾计划。' }, buildTaskPlannerMessages(input)[1]!]
              : buildTaskPlannerMessages(input),
            temperature: 0,
            max_tokens: maxTokens,
            stream: false,
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        })
        if (!response.ok) return failed('call_failed', 1)

        const abortedSignal = new Promise<'aborted'>((resolvePromise) => {
          if (controller.signal.aborted) resolvePromise('aborted')
          else controller.signal.addEventListener('abort', () => resolvePromise('aborted'), { once: true })
        })
        const raced = await Promise.race([
          response
            .json()
            .then((value) => ({ kind: 'body' as const, value: value as ChatCompletionResponse }))
            .catch(() => ({ kind: 'bad' as const })),
          abortedSignal.then(() => ({ kind: 'aborted' as const })),
        ])
        if (raced.kind === 'aborted') {
          return failed(timedOut ? 'timeout' : 'call_failed', 1)
        }
        if (raced.kind === 'bad') return failed('invalid_output', 1, 'task_plan_bad_json')
        const content = raced.value.choices?.[0]?.message?.content
        if (typeof content !== 'string') return failed('invalid_output', 1, 'task_plan_not_object')

        try {
          if (options.candidateCount === 3) {
            const pool = extractTaskPlanJson(content) as { candidates?: unknown[] }
            if (!pool || Object.keys(pool).length !== 1 || !Array.isArray(pool.candidates) || pool.candidates.length < 1 || pool.candidates.length > 3) {
              return failed('invalid_output', 1)
            }
            const candidates = pool.candidates.map(value => validateTaskPlan(value, { registry, allowedCapabilities: input.allowedCapabilities }))
            return { ok: true, plan: candidates[0]!, candidates, requestCount: 1 }
          }
          const plan: TaskPlan = parseTaskPlan(content, {
            registry,
            allowedCapabilities: input.allowedCapabilities,
          })
          return { ok: true, plan, requestCount: 1 }
        } catch (error) {
          /*
           * ⚠️ 解析失败**只**记白名单里的码：模型输出可能整段抄了要写进文件的内容，
           *    绝不能落进 trace / 账本 / 证据。
           */
          return failed('invalid_output', 1, toSafeTaskPlanParseCode(error))
        }
      } catch {
        return failed(timedOut ? 'timeout' : 'call_failed', 1)
      } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onCallerAbort)
      }
    },
  }
}

export function describeOpenAiTaskPlanner(
  planner: TaskPlannerPort,
  env: NodeJS.ProcessEnv = process.env
): string {
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_SMALL_MODEL
  return (
    `task planner @ ${planner.endpointHost} · model=${model} · ` +
    `≤${String(MAX_STEPS_PER_PLAN)} 步/次 · ${String(TASK_PLANNER_TIMEOUT_MS)}ms`
  )
}
