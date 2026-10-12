/**
 * M3 评测的**扩展面** —— 冻结类型没给、但评测确实需要的那几件事。
 *
 * ============================================================================
 *  为什么需要这个文件：`EvalRuntimeFacade` 的四条边界
 * ============================================================================
 * `evals/m3/types.ts` 里的 `EvalRuntimeFacade` 刻意做得很小（那是好事）：
 * 它只允许评测"跟她说话 / 看账本 / 看 Seed / 开新会话"。但 M3 有三类用例
 * 靠它做不出来，而它们又**必须**做：
 *
 *   1. **T6 用户确认**（计划书第 33/104 节）
 *      权威等级的提升条件是"第二条 User Event **回复了**她那条生成内容"。
 *      而 `say()` 是"普通用户说话"：它不建立 reply graph。
 *      要造出这个局面，评测必须能以**具名操作**再写一条事件
 *      （`appendUserStatement({ replyToEventId })`），而不是绕过账本直接 insert。
 *
 *   2. **真正的重启**（T1 / 计划书第 99 节）
 *      "重启"不是一轮对话，是**关掉运行环境再装配一次**。
 *
 *   3. **judge 需要模型**（计划书第 53 节）
 *      `judge` 检查的 rubric 是数据（在套件里），但"谁来执行它"必须由
 *      运行环境注入 —— 评测定义不能自己 new 一个 provider，否则
 *      `evals/**` 就会依赖 `@elizaos/core`，而那是运行时的事。
 *
 * ---------------------------------------------------------------------------
 *  为什么走 `EvalObservation.attributes` 而不是改 `types.ts`
 * ---------------------------------------------------------------------------
 * `EvalObservation.attributes` 与 `EvalRuntimeFacade.attributes` 是类型里
 * **已经存在**的自由元数据通道。用它传一个"运行环境句柄"是零成本扩展：
 *   · 断言仍然是 `(observation) => CheckResult` 的纯函数（读 attributes 也是读观测）
 *   · 换一个运行环境实现（未来的 HTTP test endpoint，计划书第 51 节）
 *     时，套件一个字都不用改
 *   · 不需要给冻结文件加方法，也就不需要第二套类型
 *
 * ⚠️ 唯一一条纪律：**读到 undefined 时必须优雅退化**。
 * 套件可能被别的东西（Promptfoo provider、未来的其它 runner）加载，
 * 那时没有运行环境句柄 —— 此时检查应当明确失败/跳过，而不是抛异常把整套炸掉。
 */

import type { EvalObservation } from '../types.ts'

// ---------------------------------------------------------------------------
// 模型调用面
// ---------------------------------------------------------------------------

/** 一次 judge 调用返回了什么（**含原始文本**：解析失败时要能把它留在报告里） */
export interface JudgeRawResult {
  /** 模型原始输出（不做任何猜测性修补） */
  raw: string
  durationMs: number
}

/**
 * 模型调用口。
 *
 * 刻意只暴露"把一段 prompt 变成一段文本"：
 * judge 的 prompt 怎么拼、分数怎么解析，都在评测侧，
 * 于是"评分逻辑"与"模型路由"分开 —— 换模型不影响评分门槛的定义。
 */
export type ModelInvoker = (prompt: string) => Promise<JudgeRawResult>

/**
 * **角色自己**的模型调用口（与 judge 的那个**分开**）。
 *
 * ============================================================================
 *  为什么必须是两个口，而不是共用一个
 * ============================================================================
 * 实测踩到过：第一版的 `sayOnce()` **从来不调模型** —— 它在任何模式下
 * 都返回合成串 `<m3-echo compiler=… sections=…>`。于是 live 档把
 * 那段合成串当成"她的回答"交给 judge 打分，judge 很诚实地给出
 * 0.05 并说明"回答只有一段系统编译标记，没有任何实际内容"。
 *
 * 而报告里那个 0.05 看起来像一个真实结论（"她价值取向不对"），
 * 实际上它只说明**评测没有真的让她说话**。这是 M3 评测里最严重的一类
 * 缺陷：**数字看起来合理，但量的是错的东西**。
 *
 * 两个口分开还有一个更重要的理由：它们要评的是**两个不同的东西**。
 *   · `ModelInvoker`      —— 给 judge：它要给出**分数**（JSON）
 *   · `CharacterModelInvoker` —— 给她：它要给出**她会说的话**（纯文本）
 * 混成一个会在某天让"她的回复"里出现 `{"score": ...}`，
 * 而那时 judge 会认真地去评那段 JSON。
 */
export type CharacterModelInvoker = (prompt: string) => Promise<JudgeRawResult>

// ---------------------------------------------------------------------------
// 运行环境句柄
// ---------------------------------------------------------------------------

/**
 * 评测侧能用的**额外**运行环境能力。
 *
 * 它是 `EvalRuntimeFacade` 的超集：凡是能用 facade 做的，仍然用 facade
 * （那样套件才与运行环境实现无关）；只有做不了的才落到这里。
 */
export interface M3RuntimePort {
  /** judge 用的模型口；离线（echo）模式下为 undefined */
  invokeModel?: ModelInvoker
  /**
   * 以**具名操作**往事实账本追加一条事件。
   *
   * 这是 T6/T7/T8 的关键：`appendUserStatement` 只接受"用户说了话"，
   * `actorType` 由方法名决定，`sourceKind` 由它推导 —— 因此评测
   * **写不出**来源错误的事件（这正是 `ConversationLedgerPort` 的设计意图）。
   */
  append(input: {
    kind: 'user' | 'character' | 'system' | 'tool'
    content: string
    /** 回复哪条事件（T6 的确认必须带上她那条生成的 id） */
    replyToEventId?: string
    /** system / tool 事件的名字（如 `scheduler` / `weather`） */
    source?: string
  }): Promise<EvalObservation>
  /** 当前这一轮之后账本里的最大角色级序号（评测用它划出"本轮新增"区间） */
  ledgerWatermark(): Promise<number>
}

/**
 * `attributes` 里的键。
 *
 * ============================================================================
 *  为什么是**字符串**而不是 Symbol
 * ============================================================================
 * 第一版用的是 `Symbol.for('project-lg.m3.eval.runtime-port')`，理由是
 * "字符串会和用例自己的元数据撞名，而 Symbol 不可能被误写"。
 * 那个理由本身没错，但它漏掉了两个更要紧的事实：
 *
 *   1. **JSON 会丢掉 Symbol 键。** 报告要写进 `--json` 文件、
 *      要经 Promptfoo 的 provider 传出去（那是**子进程 + JSON**），
 *      而 Symbol 键在 `JSON.stringify` 时**静默消失** ——
 *      症状是"本地跑没问题，走 Promptfoo 就变成拿不到运行环境句柄"。
 *      一个只在部分运行方式下生效的通道，比一个可能撞名的通道危险得多。
 *
 *   2. **跨 realm 的 Symbol 相等性靠注册表。** `Symbol.for` 保证同一
 *      realm 内相等，但评测可能被编译/打包成另一份模块实例，
 *      那时 `Symbol.for` 仍然相等（它走全局注册表）—— 这一条其实没问题，
 *      但"这一条没问题"会让人以为整体没问题，而问题在第 1 条。
 *
 * 因此改成**带命名空间的字符串**：`__m3_runtime_port__`。
 * 撞名风险用一个足够具体的名字消掉，而它能在 JSON 里活下来。
 */
export const M3_RUNTIME_PORT = '__m3_runtime_port__'

/** 从观测里取运行环境句柄（拿不到时返回 undefined，**不抛**） */
export function runtimePortOf(observation: EvalObservation): M3RuntimePort | undefined {
  return portFrom(observation)
}

/**
 * 从任何带 `attributes` 的东西里取运行环境句柄。
 *
 * 观测与 facade **共用同一个通道**（`attributes`），因此装置里既能
 * `portFrom(facade)`（准备阶段），检查里也能 `runtimePortOf(observation)`
 * （判定阶段）。这不是巧合：两者的 attributes 本来就是同一份，
 * 由引擎在建立观测时原样带过去。
 */
export function portFrom(holder: {
  attributes?: Record<string, unknown>
}): M3RuntimePort | undefined {
  const port = holder.attributes?.[M3_RUNTIME_PORT]
  return isRuntimePort(port) ? port : undefined
}

function isRuntimePort(value: unknown): value is M3RuntimePort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as M3RuntimePort).append === 'function' &&
    typeof (value as M3RuntimePort).ledgerWatermark === 'function'
  )
}

// ---------------------------------------------------------------------------
// judge 契约
// ---------------------------------------------------------------------------

export interface JudgeRequest {
  /** 评的是哪条检查（进报告） */
  checkId: string
  /**
   * 评分提示词（来自套件里的 rubric，已做变量替换）。
   *
   * ⚠️ 它**只描述 trait direction**（计划书第 64 节）：
   * 允许措辞不同，只判"这个倾向在这场处境里有没有表现出来"。
   */
  prompt: string
}

export interface JudgeOutcome {
  status: 'scored' | 'skipped'
  score?: number
  /** 人类可读结论（评分理由 / 跳过原因 / 解析失败的说明） */
  detail: string
  /** 模型原始输出（**解析失败时一定要留着**，否则没法改进 rubric） */
  raw?: string
  durationMs?: number
}

/**
 * judge 输出的**失败安全**解析（计划书第 53 节：不能把整套 Gate 交给模型）。
 *
 * 解析失败 → `skipped`，不是 0 分，也不是抛异常：
 *   · 记 0 分会把"模型今天话多"变成"她人格漂移"，制造假警报；
 *   · 抛异常会中断整套评测，让后面十几个用例失去结果；
 *   · `skipped` 是诚实的：这次没测到，报告里看得见，而且原始输出还在。
 */
export function parseJudgeOutput(raw: string): JudgeOutcome {
  const text = stripFences(raw)
  if (text.trim() === '') {
    return { status: 'skipped', detail: 'judge 返回空输出', raw }
  }

  // 形状 1（首选）：JSON 对象
  const json = extractJsonObject(text)
  if (json) {
    const score = coerceScore(json.score)
    if (score !== undefined) {
      return {
        status: 'scored',
        score,
        detail: typeof json.reason === 'string' && json.reason.trim() !== ''
          ? json.reason.trim()
          : `judge 给出 ${score}`,
        raw,
      }
    }
  }

  // 形状 2（兜底）：正文里的 "SCORE: 0.8" / "得分：0.8"
  const matched = /(?:score|得分|评分)\s*[:：=]?\s*(0(?:\.\d+)?|1(?:\.0+)?)/i.exec(text)
  if (matched) {
    const score = coerceScore(matched[1])
    if (score !== undefined) {
      return { status: 'scored', score, detail: `judge 文本里解析到 ${score}`, raw }
    }
  }

  return {
    status: 'skipped',
    detail: 'judge 输出无法解析成分数（已保留原始输出，请据此改 rubric）',
    raw,
  }
}

/** 剥掉 markdown 代码围栏 ```json … ``` */
function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  return fenced ? fenced[1] : text
}

function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** 0..1 之间的分数；越界或非数字 → undefined（宁可 skipped 也不猜） */
function coerceScore(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return undefined
  if (numeric < 0 || numeric > 1) return undefined
  return numeric
}
