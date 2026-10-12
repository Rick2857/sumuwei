/**
 * 后 Lv2 · WP3 —— **皮套状态契约与确定性映射**（纯函数，kernel 侧）。
 *
 * ============================================================================
 *  载体：计划 §6.1/§6.2（S2 身体）· ADR-091 §4 · 媒体交付契约 `M1`–`M4`
 * ============================================================================
 * 这一层回答的问题是：
 *
 * ```text
 *   她的**程序事实**（本轮走到哪一步） ⟶ 皮套该表现什么
 * ```
 *
 * 它**不做**联网、不做渲染、不 import 任何上游 —— 上游（Open-LLM-VTuber）只是在
 * 另一个进程里消费这份**受控词汇**的适配层（`INV-PL2-08`：皮套**不**重新定义她）。
 *
 * ---------------------------------------------------------------------------
 *  三条硬纪律（每一条都有对应的负控）
 * ---------------------------------------------------------------------------
 * ```text
 * ① 不许撒谎：状态只能由**程序事实**推出，不能由模型措辞推
 * ② 不许残留：结果交付完就回 `idle`；故障/中断**必须**压过 `speaking`
 *    （否则旧嘴型会继续动 —— 计划 §6.2 的 M3 判据）
 * ③ 不许悄悄扩词：表情/动作标识符来自**受控登记表**，未登记的**抛错**
 * ```
 *
 * ⚠️ **故意不做的**：这里没有"情绪 → 表情"的语义判断。情绪由 M8/M8.5 的既有投影给出
 * （`affect` 只进 prompt，**不复述数值**），本层只做"有没有情绪档位"这个**存在性**映射，
 * 并把档位原样透传为 `emotionKey` —— 语义解释留在它该在的地方。
 */

import { KernelError } from '../contracts/ids.ts'

// ---------------------------------------------------------------------------
// 受控词汇（皮套侧的状态）
// ---------------------------------------------------------------------------

/**
 * 皮套的**任务状态**（计划 §6.1 的六类，一条不多）。
 *
 * ⚠️ 排序即优先级：`failed` > `interrupted` > `tool_running` > `speaking` >
 * `thinking` > `listening` > `idle`。
 * 优先级**不是**排序偏好，而是"哪一条事实更重要"：
 *   一次失败的轮次**不能**被表现成"她还在说"。
 */
export type AvatarTaskState =
  /** 空闲：没有进行中的轮次，也没有在播放 */
  | 'idle'
  /** 在听：用户这一轮已提交、她还什么都没产出 */
  | 'listening'
  /** 在想：上下文已编译、模型调用进行中 */
  | 'thinking'
  /** 在说：**音频真的在播**（不是"合成完成"——媒体契约 §1 的三本账） */
  | 'speaking'
  /** 在跑动作：这一轮有尚未收敛的动作请求 */
  | 'tool_running'
  /** 被中断：用户打断 / 强信号停止 */
  | 'interrupted'
  /** 失败：这一轮以错误结束（工具失败 / 模型不可达 / 守卫抛错） */
  | 'failed'

export const AVATAR_TASK_STATES: readonly AvatarTaskState[] = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'tool_running',
  'interrupted',
  'failed',
]

/** 任务状态的优先级（数字越大越优先；见 {@link AvatarTaskState} 的说明） */
export const AVATAR_TASK_STATE_PRIORITY: Readonly<Record<AvatarTaskState, number>> = {
  failed: 60,
  interrupted: 50,
  tool_running: 40,
  speaking: 30,
  thinking: 20,
  listening: 10,
  idle: 0,
}

/** 皮套的**交付状态**（媒体契约 §1 的三本账 + 未知） */
export type AvatarDeliveryState = 'idle' | 'queued' | 'playing' | 'played' | 'cancelled' | 'unknown'

export const AVATAR_DELIVERY_STATES: readonly AvatarDeliveryState[] = [
  'idle',
  'queued',
  'playing',
  'played',
  'cancelled',
  'unknown',
]

/**
 * **受控登记表**：允许发给皮套的表情标识符。
 *
 * ⚠️ 为什么是封闭表而不是 `string`：皮套侧的资源是按名字找的，
 * 一个未登记的标识符在那边只会**静默**什么都不做（或回中性）——
 * 于是"表情没生效"和"我们发错了名字"在输出上分不开。
 * 登记表让"发错名字"在**她这一侧**就变成具名错误。
 */
export const AVATAR_EXPRESSION_IDS: readonly string[] = [
  'neutral',
  'smile',
  'thinking',
  'sorry',
  'surprised',
  'listening',
]

export function isKnownAvatarExpression(value: unknown): value is string {
  return typeof value === 'string' && AVATAR_EXPRESSION_IDS.includes(value)
}

// ---------------------------------------------------------------------------
// 输入：**程序事实**（不是措辞）
// ---------------------------------------------------------------------------

/**
 * 一轮的**程序事实**（由装配层从既有读数收集；本层不读库、不读 trace）。
 *
 * ⚠️ 每个字段都必须是**已经发生**的程序事实。特别地：
 *   · `audioPlaying` 来自**客户端上报的播放事实**，不是"TTS 合成完成"；
 *   · `pendingActionCount` 来自动作账本，不是"模型说它要查一下"。
 */
export interface AvatarTurnFacts {
  /** 这一轮开始了吗（用户输入已提交） */
  turnStarted: boolean
  /** 上下文是否已编译（模型调用即将/已经开始） */
  contextCompiled: boolean
  /** 这一轮是否已结束（回复已提交 / 明确失败） */
  turnFinished: boolean
  /** 尚未收敛的动作请求数（>0 ⇒ 在跑动作） */
  pendingActionCount: number
  /** 这一轮是否以失败结束（含工具失败 / 模型故障 / 守卫抛错） */
  failed: boolean
  /** 用户是否打断 / 是否收到强信号停止 */
  interrupted: boolean
}

/** 交付事实（**客户端上报**，不是服务端推测；媒体契约 §1） */
export interface AvatarDeliveryFacts {
  delivery: AvatarDeliveryState
  /** 正在播放的那一段的 id（`playing` 时应有；没有 ⇒ 视为未知） */
  playingSegmentId?: string
}

/** 情绪/关系的**存在性**读数（值本身不在这里解释） */
export interface AvatarMoodFacts {
  /** M8/M8.5 投影给出的情绪档位键（原样透传；缺省 ⇒ 不表现情绪） */
  emotionKey?: string
  /** 这一轮情绪是否**真的应用**了（`false` ⇒ 不得用情绪表情冒充） */
  affectAppliedThisTurn: boolean
}

export interface AvatarStateInput {
  facts: AvatarTurnFacts
  delivery: AvatarDeliveryFacts
  mood?: AvatarMoodFacts
  /**
   * 皮套资源**实际可选**的表情（缺省 = 全部登记项）。
   *
   * ⚠️ 计划 §6.2 的 M2 判据："缺对应资源时**回到中性**，不卡住轮次"。
   * 因此这里传的是**这次皮套真的有的**那一组，而不是"我们希望它有的"。
   */
  availableExpressions?: readonly string[]
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

export interface AvatarReading {
  task: AvatarTaskState
  delivery: AvatarDeliveryState
  /** 最终发出的表情（**一定**在 `availableExpressions` 里；缺资源时是 `neutral`） */
  expression: string
  /** 表情是不是因为"资源缺失"而回落到中性（可审计，不是静默降级） */
  expressionFellBack: boolean
  /** 情绪档位（原样透传；`undefined` = 本轮不表现情绪） */
  emotionKey?: string
  /** 正在播放的段 id（`speaking` 时应有） */
  playingSegmentId?: string
  /** 这一读数是**凭什么**算出来的（进 trace；只有枚举标签与计数） */
  basis: readonly string[]
}

/**
 * 把程序事实映射成一条**确定性**的皮套读数。
 *
 * 纯函数：同样输入永远同样输出（没有时钟、没有随机、没有 I/O）。
 */
export function avatarReadingOf(input: AvatarStateInput): AvatarReading {
  const { facts, delivery } = input
  const basis: string[] = []

  // --- ① 任务状态：按**优先级**取第一条成立的事实 ---------------------------
  let task: AvatarTaskState = 'idle'
  if (facts.failed) {
    task = 'failed'
    basis.push('turn_failed')
  } else if (facts.interrupted) {
    task = 'interrupted'
    basis.push('user_interrupted')
  } else if (facts.pendingActionCount > 0) {
    task = 'tool_running'
    basis.push(`pending_actions:${String(facts.pendingActionCount)}`)
  } else if (delivery.delivery === 'playing') {
    /*
     * ⚠️ `speaking` 的判据是**客户端上报的播放事实**，不是"我们生成了音频"。
     * 合成完成只证明有音频文件（媒体契约 §1 的禁止等价替换表）。
     */
    task = 'speaking'
    basis.push('audio_playing')
  } else if (facts.turnStarted && facts.contextCompiled && !facts.turnFinished) {
    task = 'thinking'
    basis.push('model_call_pending')
  } else if (facts.turnStarted && !facts.turnFinished) {
    task = 'listening'
    basis.push('turn_started')
  } else {
    basis.push('no_active_turn')
  }

  /*
   * --- ② 交付状态：与任务状态**分开**（三本账不许互相代替）--------------
   * ⚠️ 明确一条：`failed`/**`interrupted`** 时**不得**表现成 `playing` ——
   *    否则旧嘴型会继续动。这里把交付状态**向下压**成 `cancelled`，
   *    并记进 basis（可审计，不是静默改写）。
   */
  let effectiveDelivery = delivery.delivery
  if ((task === 'failed' || task === 'interrupted') && effectiveDelivery === 'playing') {
    effectiveDelivery = 'cancelled'
    basis.push('delivery_downgraded_by_interruption')
  }

  // --- ③ 表情：情绪只在**真的应用了**的时候才用 -----------------------------
  const available = input.availableExpressions ?? AVATAR_EXPRESSION_IDS
  let desired = 'neutral'
  const mood = input.mood
  if (task === 'failed') desired = 'sorry'
  else if (task === 'interrupted') desired = 'neutral'
  else if (task === 'listening') desired = 'listening'
  else if (task === 'thinking' || task === 'tool_running') desired = 'thinking'
  else if (task === 'speaking') {
    /*
     * 说话时用情绪表情 —— **但**只在 `affectAppliedThisTurn === true` 时。
     * `false` / 缺省 ⇒ 中性：拿一个没应用的档位去演情绪，就是让皮套替她撒谎。
     */
    if (mood?.affectAppliedThisTurn === true && mood.emotionKey !== undefined) desired = 'smile'
    else desired = 'neutral'
  }
  if (!isKnownAvatarExpression(desired)) {
    throw new KernelError(
      'validation_error',
      'avatar_unknown_expression_desired',
      `映射想发出未登记的表情 ${desired}：受控登记表是 ${JSON.stringify(AVATAR_EXPRESSION_IDS)}`
    )
  }

  let expression = desired
  let expressionFellBack = false
  if (!available.includes(desired)) {
    /*
     * 计划 §6.2 `M2`：**缺对应资源时回到中性，不卡住轮次**。
     * 回落要**记下来** —— "她这次没表情"与"这个皮套没有那张脸"是两件事。
     */
    expression = 'neutral'
    expressionFellBack = true
    basis.push(`expression_unavailable:${desired}`)
  }

  return {
    task,
    delivery: effectiveDelivery,
    expression,
    expressionFellBack,
    ...(mood?.emotionKey !== undefined && task === 'speaking' && mood.affectAppliedThisTurn === true
      ? { emotionKey: mood.emotionKey }
      : {}),
    ...(effectiveDelivery === 'playing' && delivery.playingSegmentId !== undefined
      ? { playingSegmentId: delivery.playingSegmentId }
      : {}),
    basis,
  }
}

/**
 * 两条读数是否**表现相同**（用于"只发变化"的适配层；幂等的判据）。
 *
 * ⚠️ 有意**比较 basis**：基础事实变了但表现恰好相同的两帧，
 * 在 trace 上仍然是两件不同的事，不该被当成"没变化"。
 */
export function sameAvatarReading(a: AvatarReading, b: AvatarReading): boolean {
  return (
    a.task === b.task &&
    a.delivery === b.delivery &&
    a.expression === b.expression &&
    a.expressionFellBack === b.expressionFellBack &&
    a.emotionKey === b.emotionKey &&
    a.playingSegmentId === b.playingSegmentId &&
    a.basis.join('|') === b.basis.join('|')
  )
}

/**
 * 皮套**只消费**本层的读数；它**不**重新定义苏沐薇（`INV-PL2-08`）。
 *
 * 这张表就是"皮套能收到什么"的唯一答案；新增通道必须先加进这里。
 */
export const AVATAR_READING_FIELDS: readonly (keyof AvatarReading)[] = [
  'task',
  'delivery',
  'expression',
  'expressionFellBack',
  'emotionKey',
  'playingSegmentId',
  'basis',
]
