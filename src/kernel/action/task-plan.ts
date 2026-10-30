/**
 * TaskPlan —— **有限动作计划**的端口与严格解析（第二批计划 §2.2）。
 *
 * ============================================================================
 *  这个文件里没有模型调用、没有网络、没有基础设施
 * ============================================================================
 * 与 `search-need-judge.ts` 完全同构的三样东西：
 * ```text
 * ① 端口形状（TaskPlannerPort）—— 装配层注入实现，测试注入 fixture
 * ② 固定指令与消息构造    —— prompt 是**程序常量**，不含人设 / 记忆 / 历史
 * ③ 严格解析（失败关闭）  —— 模型输出 → TaskPlan，未知字段一律丢弃整条计划
 * ```
 *
 * ============================================================================
 *  为什么解析必须"多一个字段就整条丢弃"
 * ============================================================================
 * 计划是**执行指令**，不是建议。一个被宽容解释过的计划意味着
 * "模型能在参数里塞进程序没打算让它控制的东西"。先例是 M5.5.1 判定器的同一条
 * 硬约束（真实模型第一次运行就栽在"多给了一个字段"上）。
 *
 * 本批在它之上再加一层**闭集参数校验**（`validateTaskPlan`）：
 * ```text
 * capability  必须 ∈ 任务授权的能力集合
 * operation   必须在登记表里存在
 * args 的键   必须 ∈ 该能力的**参数白名单**（见 `TASK_ARG_KEYS`）
 * args 的值   只能是 string / number / boolean / 受限对象（见下）
 * ```
 * 参数白名单是**结构性**的：模型没法给 `local.file.read` 传一个 `shell` 字段，
 * 因为那个键根本不在白名单里 ⇒ 校验失败 ⇒ 整条计划作废。
 *
 * ============================================================================
 *  载荷字段的特例（第二批的隐私边界）
 * ============================================================================
 * 两个字段**不允许**出现在最终 `args` 里，它们由任务执行环改写：
 * ```text
 * local.file.write 的 content   → 环放进私有暂存，换成 payloadRef + payloadFingerprint
 * office.generate  的 spec      → 环放进私有暂存，换成 specRef + specFingerprint
 * ```
 * ⇒ 账本里永远只有引用。计划**可以**给出 content/spec（那是模型的产物），
 *    但它们**不会**进入 `ActionRequest.arguments`（见 `task-loop.ts`）。
 */

import { KernelError } from '../contracts/ids.ts'
import type { CapabilityRegistry } from './capability-registry.ts'
import type { ActionForecast } from '../contracts/world-model.ts'
import type { PlanRuleDependency } from '../contracts/cognitive-collaboration.ts'

/** 计划里的一步（**只允许**这四个字段） */
export interface TaskPlanStep {
  capability: string
  operation: string
  args: Record<string, unknown>
  /** 这一步要达成什么（模型给的一句话；**只用于下一次规划的上下文，不落任何账**） */
  purpose?: string
}

export interface TaskPlan {
  /** 这一轮规划在做什么（模型给的一句话；**不落任何账**） */
  goal: string
  steps: readonly TaskPlanStep[]
  /** 模型自报"任务已经做完了"（**只是提示**：程序不据此宣布成功） */
  done: boolean
}

/**
 * 参数白名单（**闭集**）。
 *
 * ⚠️ 给一个能力加一个参数 = 改这张表 + 改对应适配器 + 加一条用例。
 *    这正是我们要的形状：新增一个"能被执行的东西"必须是一次显式改动。
 */
export const TASK_ARG_KEYS: Readonly<Record<string, readonly string[]>> = {
  'workflow.skill': ['skill'],
  'library.search': ['query'],
  'project.search': ['query', 'limit', 'path', 'revision', 'section'],
  'self.capabilities': ['capability'],
  'research.arxiv': ['query', 'limit', 'paperId', 'section'],
  'local.file.list': ['path'],
  'local.file.read': ['path'],
  'local.file.write': ['path', 'content', 'scheme', 'expectedOriginalFingerprint'],
  'document.read': ['path'],
  'document.extract': ['path', 'reader', 'expectedInputFingerprint'],
  'document.profile': ['path'],
  'document.pages': ['path', 'firstPage', 'lastPage', 'prefixChars', 'reader', 'expectedInputFingerprint'],
  'image.ocr': ['path', 'languages'],
  'math.calculate': ['expression'],
  'web.read': ['url'],
  'web.search': ['query', 'limit', 'locale'],
  'weather.query': ['city', 'country', 'days', 'timezone'],
  'xidian.timetable': ['date', 'days'],
  'office.generate': ['path', 'format', 'spec', 'expectedOriginalFingerprint'],
  'news.read': ['feeds', 'since', 'until', 'limit'],
  'browser.read': [],
  'browser.operate': ['action', 'url', 'ref', 'text', 'value', 'waitMs'],
  /*
   * ★ 2026-10-09 / ADR-125：全工具档（用户 C 档授权）。
   *
   * ⚠️ `tool` 是上游工具名（闭集 = `ALLOWED_MCP_TOOLS` 那 72 个），
   *    `toolArgs` 是**JSON 对象字符串**（例如 `{"expression":"document.title"}`）——
   *    刻意不是对象：**本文件的 args 值只接受 string/number/boolean**，一个对象会让整条计划作废
   *    （2026-10-09 实测踩到：`browser-05` 全部判据都"没有结果"，根因就是这个）。
   *    解析与失败关闭在适配器里（解析不出来 / 不是对象 ⇒ `validation_failed`，一个包都不发）。
   */
  'browser.mcp': ['tool', 'toolArgs'],
  /*
   * ADR-106：桌面查看与操作。
   *
   * ⚠️ `desktop.operate` 的参数名刻意是**它看到过的东西**（`window` / `index` / `name`）
   *    加一个**闭集动作**（`action`）—— 没有坐标、没有快捷键、没有"任意调用"这种字段。
   *    `content` **不在** `TASK_ARG_KEYS` 之外：它就是 `TASK_STAGED_ARG_KEYS` 的成员，
   *    因此"要输入的正文"由执行环改写成私有暂存引用（正文不进 args、不进账本）。
   */
  'desktop.inspect': ['window', 'query'],
  'desktop.operate': ['action', 'window', 'index', 'name', 'content', 'handle'],
  'system.echo': ['text'],
  'sandbox.file.read': ['path'],
  'sandbox.file.write': ['path', 'content'],
  /*
   * post-Lv2 / ADR-110 `D05`：QQ 主动联系的目标发送能力。
   *
   * ⚠️ 只有 `text` —— **没有**收件人字段（收件人是"本人"，由本机绑定决定）。
   *    这一行不是"任务可用"的标记：本能力**不在** `TASK_CAPABILITY_IDS` 里，
   *    所以角色自行选择工具与任务执行环都规划不到它（计划 §7："本批新增 NONE"）。
   *    它在 `TASK_ARG_KEYS` 里是 `auditToolCatalog()` 的完整性要求（"无遗漏 / 无漂移"）。
   */
  'qq.private.message': ['text'],
  'local.reminder.message': ['text'],
  /*
   * post-Lv2 / ADR-156：主人授权群任务的两个能力（**群任务 P2**）。
   *
   * ⚠️ 只有 `text` / `media`：**没有**群号、收件人、群名这类字段 ——
   *    群号只能来自**任务授权事实**（适配器层的 `resolveAuthorization` 端口），
   *    任何请求方（包括模型）都提供不了。`media` 只是"这条任务允许的形态里这次想用哪种"。
   * ⚠️ 这两行**不是**"任务可用"的标记：两个能力都**不在** `TASK_CAPABILITY_IDS` 里，
   *    所以角色自行选择工具与任务执行环都规划不到它们。
   *    它们在表里是 `auditToolCatalog()` 的完整性要求（"无遗漏 / 无漂移"）——
   *    与上面的 `qq.private.message` 完全同一条理由。
   * ⚠️ 参数闭集与 `qq-group-capability.ts` 的 `QQ_GROUP_SEND_ARG_KEYS` /
   *    `QQ_GROUP_LIST_ARG_KEYS` 必须**逐字相同**（门断言这条）；这里写**字面量**而不是
   *    引用那个常量：本文件是 kernel 的纯表，`auditToolCatalog()` 拿它当比对基准，
   *    表跟着常量跑会让"表 → 声明"的漂移看不见。
   */
  'qq.group.message': ['text', 'media'],
  /* `qq.group.list`：只读机器人**实际所在**群（消歧用），**一个参数都不接受** */
  'qq.group.list': [],
}

/** 会被环改写成"暂存引用"的字段（**不允许**留在最终 args 里） */
export const TASK_STAGED_ARG_KEYS: readonly string[] = ['content', 'spec']

/**
 * 规划器**可见的引用参数**（2026-10-05 事故修复）。
 *
 * ============================================================================
 *  为什么需要一个"引用"这个概念
 * ============================================================================
 * 修复前，回给规划器的"已经执行过的步骤"只有 `local.file.list.list=success` ——
 * **没有路径、没有条目数**。于是模型既不知道"这个目录我已经列过了"，
 * 也不知道"用户的桌面到底叫什么"，只能反复列举同一个目录 + 猜用户名
 * （真模型实测：同一个 trace 里 12 次 `local.file.list`，其中
 *  `C:\Users\Public\Desktop` 列了 6 次，另外两次猜了 `C:\Users\user\Desktop` /
 *  `C:\Users\Administrator\Desktop`）。⇒ 规划器**永远收敛不了**。
 *
 * ⚠️ 只收**引用**（路径 / URL / 查询词），**绝不**收正文载荷：
 *    `content` / `spec` 由执行环改写成私有暂存引用（见 `stagePayloadArgs`），
 *    它们永远不得回到 prompt 里（那是用户要写进文件的内容）。
 */
export const TASK_PLANNER_REFERENCE_ARG_KEYS: readonly string[] = ['path', 'url', 'query', 'skill', 'paperId']

/**
 * 这一步是不是**完全由引用描述**（args 的键**全部**是引用键）。
 *
 * ============================================================================
 *  为什么它必须比 `taskStepReferenceOf` 更严（这是"进度闸"的安全边界）
 * ============================================================================
 * ```text
 * local.file.list  {path}            ⇒ 完全由引用描述 ⇒ 可以判"这一步已经做过"
 * local.file.write {path, content}   ⇒ **不是** —— 同一个路径 + **不同正文**是两件事！
 * ```
 * 如果拿"路径"当一个写步骤的身份，那么"再写一次同一个文件、内容是新的"会被判成
 * 重复 ⇒ 那一写**不会发生**，而用户以为它发生了。这是**绝不能**接受的方向，
 * 所以判据取**保守侧**：带载荷（`content` / `spec`）或任何额外参数的步骤
 * **永不**进进度闸（宁可多写一次，不可少写一次）。
 */
export function taskStepReferenceIsExclusive(args: Record<string, unknown>): boolean {
  const keys = Object.keys(args)
  if (keys.length === 0) return false
  return keys.every((key) => TASK_PLANNER_REFERENCE_ARG_KEYS.includes(key))
}

/**
 * 一条**单行、有界**的引用摘要（`path=C:\a\b` 形态）。
 *
 * 两个上界都是必要的：值来自模型的计划，它可以很长、可以带换行 ——
 * 而这段文本要回到下一轮的规划 prompt 里去。
 * 返回 `undefined` ⇒ 这一步没有可比较的引用（例如 `browser.read` 的空参数）。
 */
export function taskStepReferenceOf(args: Record<string, unknown>): string | undefined {
  for (const key of TASK_PLANNER_REFERENCE_ARG_KEYS) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const normalized = value
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (normalized === '') continue
    return `${key}=${normalized.length > 160 ? `${normalized.slice(0, 160)}…` : normalized}`
  }
  return undefined
}

/** 一次规划最多给出多少步（防止"一次下发 500 步"绕过 30 次行动预算的意图） */
export const MAX_STEPS_PER_PLAN = 8

/** 单步 args 的 JSON 序列化上限（防"用一步塞进整个硬盘"） */
export const MAX_STEP_ARGS_BYTES = 2 * 1024 * 1024

export const TASK_PLANNER_FAILURES = [
  'empty_task',
  'timeout',
  'call_failed',
  'invalid_output',
] as const
export type TaskPlannerFailure = (typeof TASK_PLANNER_FAILURES)[number]

export const TASK_PLAN_PARSE_CODES = [
  'task_plan_empty',
  'task_plan_no_json_object',
  'task_plan_bad_json',
  'task_plan_not_object',
  'task_plan_unknown_field',
  'task_plan_bad_goal',
  'task_plan_bad_done',
  'task_plan_bad_steps',
  'task_plan_too_many_steps',
  'task_plan_step_not_object',
  'task_plan_step_unknown_field',
  'task_plan_step_bad_capability',
  'task_plan_step_bad_operation',
  'task_plan_step_bad_args',
  'task_plan_step_args_not_object',
  'task_plan_step_arg_key_not_allowed',
  'task_plan_step_arg_value_not_allowed',
  'task_plan_step_args_too_large',
  'task_plan_step_capability_not_authorized',
  'task_plan_step_operation_unknown',
  'unknown_parse_failure',
] as const
export type TaskPlanParseCode = (typeof TASK_PLAN_PARSE_CODES)[number]

export function toSafeTaskPlanParseCode(error: unknown): TaskPlanParseCode {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && (TASK_PLAN_PARSE_CODES as readonly string[]).includes(code)
    ? (code as TaskPlanParseCode)
    : 'unknown_parse_failure'
}

const STEP_FIELDS = new Set(['capability', 'operation', 'args', 'purpose'])
const PLAN_FIELDS = new Set(['goal', 'steps', 'done'])

/** 从模型输出里取出那个 JSON 对象（容忍代码块围栏与前后少量文字，其余失败关闭） */
export function extractTaskPlanJson(raw: string): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new KernelError('validation_error', 'task_plan_empty', '规划器返回了空内容')
  }
  const withoutFence = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new KernelError(
      'validation_error',
      'task_plan_no_json_object',
      '规划器输出里找不到一个 JSON 对象'
    )
  }
  try {
    return JSON.parse(withoutFence.slice(start, end + 1))
  } catch {
    throw new KernelError('validation_error', 'task_plan_bad_json', '规划器输出的 JSON 解析失败')
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * UTF-8 字节数（**不用 `Buffer`**：kernel 不依赖 Node 运行时对象，
 * 这样这条判定在离线与将来换运行时都成立）。
 */
function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * 参数值的**形状**校验（递归）。
 *
 * ⚠️ `insideSpec` 是**实测逼出来**的（2026-10-04 的真模型 live）：第一版用
 *    "键名必须等于 `spec`"来判断"这个对象能不能是对象"，于是
 *    `spec.blocks[0]`（一个**嵌套在 spec 里**的块对象）被拒 ⇒
 *    办公生成的计划整条作废（`task_plan_step_arg_value_not_allowed`）。
 *    ⇒ 判据改成"**我们已经在 spec 里面了吗**"，而不是"这个键叫不叫 spec"。
 */
function validateArgValue(
  key: string,
  value: unknown,
  depth: number,
  insideSpec: boolean
): void {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return
  if (value === null) return
  if (Array.isArray(value)) {
    if (depth > 8) {
      throw new KernelError('validation_error', 'task_plan_step_arg_value_not_allowed', `${key} 嵌套过深`)
    }
    for (const item of value) validateArgValue(key, item, depth + 1, insideSpec)
    return
  }
  if (isPlainObject(value)) {
    /*
     * ⚠️ 对象只允许出现在**结构化规格**里（`spec` 及其子树）。
     *    允许任意位置的对象会让"参数白名单"变成一句空话：模型可以在一个合法键下
     *    藏任意结构，而适配器可能把它当代码解释。
     */
    if (!insideSpec && key !== 'spec') {
      throw new KernelError(
        'validation_error',
        'task_plan_step_arg_value_not_allowed',
        `${key} 不允许是对象（只有 spec 的子树允许结构化对象）`
      )
    }
    if (depth > 8) {
      throw new KernelError('validation_error', 'task_plan_step_arg_value_not_allowed', 'spec 嵌套过深')
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      validateArgValue(childKey, childValue, depth + 1, insideSpec || key === 'spec')
    }
    return
  }
  throw new KernelError(
    'validation_error',
    'task_plan_step_arg_value_not_allowed',
    `${key} 的值类型不支持：${typeof value}`
  )
}

/**
 * 解析 + **校验**一份计划（纯函数，失败关闭）。
 *
 * `registry` 与 `allowedCapabilities` 都是必需的：前者回答"这个操作存在吗"，
 * 后者回答"这个任务被允许碰它吗"。两个问题缺一个，计划就可以越权。
 *
 * ⚠️ 这里刻意收 `allowedCapabilities` 而不是整个 `TaskAuthorization`：
 *    校验**只需要**这一份清单，收整个授权对象会让校验器有资格去读任务原话、
 *    预算、时限 —— 而"校验器能读到什么"就是它将来会用来做判断的东西。
 */
export function parseTaskPlan(
  raw: string,
  options: { registry: CapabilityRegistry; allowedCapabilities: readonly string[] }
): TaskPlan {
  return validateTaskPlan(extractTaskPlanJson(raw), options)
}

export function validateTaskPlan(
  value: unknown,
  options: { registry: CapabilityRegistry; allowedCapabilities: readonly string[] }
): TaskPlan {
  if (!isPlainObject(value)) {
    throw new KernelError('validation_error', 'task_plan_not_object', '计划必须是一个 JSON 对象')
  }
  for (const key of Object.keys(value)) {
    if (!PLAN_FIELDS.has(key)) {
      throw new KernelError('validation_error', 'task_plan_unknown_field', `计划里有未知字段：${key}`)
    }
  }
  const goal = value.goal
  if (typeof goal !== 'string' || goal.trim() === '') {
    throw new KernelError('validation_error', 'task_plan_bad_goal', '计划缺少非空 goal')
  }
  const done = value.done
  if (typeof done !== 'boolean') {
    throw new KernelError('validation_error', 'task_plan_bad_done', '计划缺少布尔 done')
  }
  const stepsRaw = value.steps
  if (!Array.isArray(stepsRaw)) {
    throw new KernelError('validation_error', 'task_plan_bad_steps', '计划缺少数组 steps')
  }
  if (stepsRaw.length > MAX_STEPS_PER_PLAN) {
    throw new KernelError(
      'validation_error',
      'task_plan_too_many_steps',
      `一次规划最多 ${String(MAX_STEPS_PER_PLAN)} 步，收到 ${String(stepsRaw.length)}`
    )
  }

  const allowed = new Set(options.allowedCapabilities)
  const steps: TaskPlanStep[] = []
  for (const item of stepsRaw) {
    if (!isPlainObject(item)) {
      throw new KernelError('validation_error', 'task_plan_step_not_object', '步骤必须是对象')
    }
    for (const key of Object.keys(item)) {
      if (!STEP_FIELDS.has(key)) {
        throw new KernelError(
          'validation_error',
          'task_plan_step_unknown_field',
          `步骤里有未知字段：${key}`
        )
      }
    }
    const capability = item.capability
    if (typeof capability !== 'string' || capability.trim() === '') {
      throw new KernelError('validation_error', 'task_plan_step_bad_capability', '步骤缺少 capability')
    }
    if (!allowed.has(capability)) {
      throw new KernelError(
        'validation_error',
        'task_plan_step_capability_not_authorized',
        `本任务没有被授权使用 ${capability}`
      )
    }
    const operation = item.operation
    if (typeof operation !== 'string' || operation.trim() === '') {
      throw new KernelError('validation_error', 'task_plan_step_bad_operation', '步骤缺少 operation')
    }
    if (options.registry.getOperation(capability, operation) === undefined) {
      throw new KernelError(
        'validation_error',
        'task_plan_step_operation_unknown',
        `${capability} 没有声明操作 ${operation}`
      )
    }
    if (item.args !== undefined && !isPlainObject(item.args)) {
      throw new KernelError('validation_error', 'task_plan_step_args_not_object', '步骤的 args 必须是对象')
    }
    const args = (item.args ?? {}) as Record<string, unknown>
    const allowedKeys = TASK_ARG_KEYS[capability]
    for (const [key, argValue] of Object.entries(args)) {
      if (allowedKeys === undefined || !allowedKeys.includes(key)) {
        throw new KernelError(
          'validation_error',
          'task_plan_step_arg_key_not_allowed',
          `${capability} 不接受参数 ${key}`
        )
      }
      validateArgValue(key, argValue, 0, false)
    }
    const bytes = utf8ByteLength(JSON.stringify(args))
    if (bytes > MAX_STEP_ARGS_BYTES) {
      throw new KernelError(
        'validation_error',
        'task_plan_step_args_too_large',
        `步骤参数 ${String(bytes)} 字节，超过上限 ${String(MAX_STEP_ARGS_BYTES)}`
      )
    }
    const purpose = item.purpose
    if (purpose !== undefined && typeof purpose !== 'string') {
      throw new KernelError('validation_error', 'task_plan_step_unknown_field', 'purpose 必须是字符串')
    }
    steps.push({
      capability,
      operation,
      args,
      ...(typeof purpose === 'string' ? { purpose } : {}),
    })
  }

  return { goal, steps, done }
}

export interface TaskPlannerMessage {
  role: 'system' | 'user'
  content: string
}

export interface TaskPlannerInput {
  /** 原始任务原话（**逐字**） */
  task: string
  /**
   * **本任务**的 trace id（ADR-151 步骤 D）。
   *
   * ⚠️ 它让消费方能只读**这一次任务**里的**受信观察**（例如本任务读到的条件值），
   *    而**不是**"任意历史读数"或候选自述。
   * ⚠️ 它**不**进模型提示（模型规划器不渲染它）。
   */
  traceId?: string
  /** 已经执行过的步骤摘要（**只有闭集事实**：能力.操作 + 状态码 + 计数） */
  executed: readonly string[]
  /** 那一步"没做成"的**闭集码**（不是原始错误文本） */
  failures: readonly string[]
  /** 本任务还能用几次行动 */
  remainingActions: number
  /** 本任务被授权的能力清单（模型只能从这里挑） */
  allowedCapabilities: readonly string[]
  /**
   * WP2 / ADR-104 `D14`：**已经取到的实际内容**（有界；已过预算选择）。
   *
   * ==========================================================================
   *  为什么必须有它（这是"看结果再决定下一步"的另一半）
   * ==========================================================================
   * ```text
   * 修复前：回给规划器的只有 `local.file.list path=C:\x=success` ——
   *   **没有条目**。于是模型既不知道目录里有什么，也无法"依据实际内容选下一步"，
   *   只能反复列举（实测同一个目录被列 6 次）或直接猜内容。
   * 修复后：这些行就是**真的读到的东西**（与注入 prompt 的那一份**同一套渲染**：
   *   `renderTurnContentEntry`），份数与 token 由 `selectTurnContentContext` 在
   *   **额度内**选出 —— 估算的就是注入的。
   * ```
   * ⚠️ 它**不是**"把文件正文塞进 prompt"的许可：额度由装配层给（缺省 0 ⇒ 这一项不出现，
   *    逐字旧行为），且每一份都带着 `scope`（"只读到一部分"必须显示出来）。
   */
  content?: readonly string[]
  /**
   * **本任务已成功的受信读回执**（路径 + 内容指纹；F2 准备读 / 真值派生）。
   *
   * ⚠️ 只由执行环从**真实成功的读动作**填（`ActionResult.effect.fingerprint`，Gateway 产出）——
   *    不是候选自述、不是模型给的标签、不是夹具预知。
   * ⚠️ 缺省为空 ⇒ 规划器输入**逐字段**与旧档相同（F1 及既有调用点不受影响）。
   * ⚠️ 它**不进**模型提示（`buildTaskPlannerMessages` 不渲染它）⇒ 不会成为第二套"读到的东西"。
   */
  trustedReads?: readonly { readonly path: string, readonly fingerprint: string }[]
  /**
   * WP3：**已经拿到的外部证据**（搜索命中；有界，已过预算选择）。
   *
   * ==========================================================================
   *  为什么它必须有（否则"搜索后深读"这条场景**走不通**）
   * ==========================================================================
   * ```text
   * 修复前：`web.search` 的命中进的是 `ActionResult.externalEvidence`，
   *   而重新规划只看得到 `web.search query=…=success` —— **没有 URL、没有标题**。
   *   ⇒ 模型没法"依据搜索结果决定深读哪一个"（计划书 §6 明确要求覆盖这条场景）。
   * 修复后：与"当轮内容回传"同形（同一套选择器 / 渲染器）：
   *   `selectExternalEvidenceContext` + `renderExternalEvidenceEntry`。
   * ```
   * ⚠️ 额度同样由装配层给（缺省 0 ⇒ 这一项不出现，逐字旧行为）。
   */
  evidence?: readonly string[]
  /**
   * WP2：**程序给出的已知目录事实**（个人桌面 / 公共桌面，含重定向后的实际路径）。
   *
   * ⚠️ 它们是**事实**，不是建议：由 `renderKnownDirectoriesForModel` 渲染，
   *    模型不得自己拼 `user` / `Administrator`（那正是要修的故障）。
   */
  knownDirectories?: readonly string[]
  /**
   * 本任务允许读取的**有界条件标记**（ADR-151 R1 §3；**可选**）。
   *
   * ⚠️ 只有**新的两行入口**才有：程序从"原始请求 + 受信声明"生成，挂在本任务授权上。
   * ⚠️ 规划器**只能**据此安排一次条件读；它**不能**自己扩大路径或次数。
   */
  observation?: {
    readonly targetPath: string
    readonly conditionPath: string
    /** 本任务已经尝试过条件读（⇒ 不许再安排第二次读）。 */
    readonly attempted: boolean
  }
  signal?: AbortSignal
}

export interface TaskPlannerOutcomeOk {
  ok: true
  plan: TaskPlan
  requestCount: number
  /** Validated alternatives from an explicitly requested candidate-generation call. */
  candidates?: readonly TaskPlan[]
  /** Trusted simulation adapter metadata, never part of the model's TaskPlan JSON. */
  simulation?: { dependency: PlanRuleDependency; forecast: ActionForecast }
}
export interface TaskPlannerOutcomeFail {
  ok: false
  failure: TaskPlannerFailure
  requestCount: number
  parseFailureCode?: TaskPlanParseCode
}
export type TaskPlannerOutcome = TaskPlannerOutcomeOk | TaskPlannerOutcomeFail

/**
 * 规划器端口。
 *
 * ⚠️ 与判定器端口同一条纪律：输入面**只有** `TaskPlannerInput` 里的字段 ——
 *    人设、记忆、检索历史、userId 在类型上就进不来。
 *    规划器看到的是"用户要我做什么 + 我已经做了什么"，不是"她是谁"。
 */
export interface TaskPlannerPort {
  readonly id: string
  readonly endpointHost: string
  plan(input: TaskPlannerInput): Promise<TaskPlannerOutcome>
}

export function describeTaskPlanner(planner: { id: string; endpointHost: string }): string {
  return `task planner = ${planner.id} @ ${planner.endpointHost}`
}
