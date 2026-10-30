/**
 * 显式记忆的**轮次级端口** —— 把 `ExplicitMemoryService` 接进对话链路。
 *
 * ============================================================================
 *  ⚠️ 这个模块的存在理由：一个「完整实现但从未被调用」的服务
 * ============================================================================
 * M4 的显式路径（`explicit-service.ts`）在服务层是完整的：
 * 记住 / 纠正 / 忘掉三条路径都有实现，`m4:verify` §13 与 `eval:m4`
 * 也都在测它们 —— **但那些测试都是直接调用服务**。
 *
 * 在真实库上实测的结果是：
 *
 *     $ tsx src/main.ts "记住，我现在上的大学是示例工程科技大学"
 *     苏沐薇: 记住了。示科。……
 *
 *     $ pnpm memory:list
 *     （没有匹配的记忆）
 *
 * 也就是说：`createExplicitMemoryService` 在全仓库**没有任何调用点**，
 * 而 `memoryExplicitEnabled` 这个开关读了 env、进了日志、
 * **从未被用来 gate 任何东西**。她说"记住了"纯粹是模型在接话。
 *
 * 这比计划书第 55 节描述的情况更糟。第 55 节说的是
 * "不能在 Memory Commit 失败时回答'记住了'"；
 * 而实际发生的是"**Commit 从未发生时**她回答了'记住了'"。
 * 用户会因此认为系统记住了，而这个错误不会自己暴露 ——
 * 没有报错、没有日志、没有一次红色。
 *
 * 注意 `explicit-service.ts` 第 217 行的注释：
 *     /** 按意图种类分派（`TurnGateway` 用这个） *\/
 *     handle(request)
 * 即设计意图本来就有，缺的是接线。
 *
 * ---------------------------------------------------------------------------
 *  为什么端口定义在这里，而不是让 TurnGateway 直接认识 ExplicitMemoryService
 * ---------------------------------------------------------------------------
 * 两层理由：
 *   1. `TurnGateway` 不该认识"记忆"这件事的细节（它只管一轮对话的编排）。
 *      它需要的只是一个"把这轮用户事件交给某个东西处理，并拿回一句
 *      **可以转述给模型的事实**"。
 *   2. 服务需要 `MemoryFoldPort` / validator / resolver 等一堆依赖，
 *      而那些只能在装配层（`main.ts`）接上 —— 领域层不许 import 持久化。
 *
 * 因此这里的形状是**最小面**：输入一句话与身份，输出一句事实。
 */

import {
  createExplicitMemoryIntentDetector,
  detectExplicitIntentFromEvent,
  targetHintsFrom,
  type ExplicitMemoryIntentDetector,
  type MemoryIntentContext,
} from './intent-detector.ts'
import type {
  ExplicitMemoryOutcome,
  ExplicitMemoryService,
} from './explicit-service.ts'
import type { EntityRef, ConversationEventId } from '../../contracts/index.ts'
import type { SemanticMemoryCommand } from '../semantic-entry.ts'

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** 本轮需要处理的用户事件（只取显式意图判定真正需要的字段） */
export interface ExplicitMemoryTurnEvent {
  /**
   * ⚠️ 用 `ConversationEventId` 而**不是** `string`。
   *
   * 第一版写的是 `string`，于是编译器立刻在下游报错：
   * `detectExplicitIntentFromEvent` 要求品牌类型。
   *
   * 那个报错是**对的**：把品牌类型放宽成 `string` 会让
   * "拿一个随便拼的字符串当事件 id"变成可写出来的表达式 ——
   * 而"证据必须指向真实事件"正是 M4 反污染的基础（MI-03）。
   * 端口在这一层放宽它，等于把下游的保证取消掉。
   */
  id: ConversationEventId
  actorType: string
  content: string
}

export interface ExplicitMemoryTurnRequest {
  semanticCommand?: SemanticMemoryCommand
  /** 记忆的拥有者（那条记忆存在于谁的记忆里） */
  owner: EntityRef
  /** 这句话讲的是谁 */
  speaker: EntityRef
  event: ExplicitMemoryTurnEvent
}

/**
 * 本轮显式记忆的**结果**，形态刻意是"一句可以转述给模型的事实"。
 *
 * 三种 `kind` 对应三种**必须不同的**回复行为：
 *   · `written`        —— 真的写入了，可以确认
 *   · `already_applied`—— 之前就记着了，要说"已经记着"而不是"记下了"
 *   · `not_written`    —— **没写入**，绝不能声称记住了（计划书第 55 节）
 *
 * 把它们合成一个"成功/失败"布尔会让第三种退化成"不承认"，
 * 而正确的行为是**如实说没记住**。
 */
export type ExplicitMemoryTurnResult =
  | {
      kind: 'written'
      intent: ExplicitMemoryOutcome['intent']
      memoryId: string
      /** 人类可读的一句话（供模型转述；**不含**内部 id） */
      summary: string
    }
  | {
      kind: 'already_applied'
      intent: ExplicitMemoryOutcome['intent']
      summary: string
    }
  | {
      kind: 'not_written'
      intent: ExplicitMemoryOutcome['intent']
      reason: string
      /**
       * 放行口的拒绝码（**只有码，没有消息**）。
       *
       * 它进 trace，因此必须保证不含内容（计划书第 110 节）。
       * 没有它，trace 里只有 `rejected_by_policy` 一个词，
       * 排查时只能靠猜哪个闸拒的。
       */
      codes?: readonly string[]
      summary: string
    }

export interface ExplicitMemoryTurnPort {
  /**
   * 处理本轮用户事件里的显式记忆指令。
   *
   * 返回 `undefined` = **这一轮没有显式记忆指令**（绝大多数轮次）。
   * 那是正常结果，而不是失败 —— 因此它不会产生任何 context section，
   * 也就不会影响普通对话的 prompt（M3.5 的逐字节基线因此不受影响）。
   */
  handleTurn(request: ExplicitMemoryTurnRequest): Promise<ExplicitMemoryTurnResult | undefined>
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export interface CreateExplicitMemoryTurnOptions {
  service: ExplicitMemoryService
  /** 意图判定器。缺省 = 规则优先（离线安全） */
  detector?: ExplicitMemoryIntentDetector
  readIntentContext?: (request: ExplicitMemoryTurnRequest) => Promise<MemoryIntentContext>
}

/**
 * 把 `ExplicitMemoryService` 包成轮次级端口。
 *
 * 它做两件事，都很薄：
 *   1. 先判**有没有显式意图**（规则优先，绝大多数轮次在这里就返回 `undefined`）
 *   2. 有则交给服务处理，并把 `ExplicitMemoryOutcome` 翻成
 *      "可以转述给模型的事实"
 *
 * ⚠️ 它**不**捕获服务的异常。原因：服务内部的失败已经被分类成
 *    `ExplicitMemoryOutcome.ok === false`（那是一个**结论**，不是异常）。
 *    真正的异常（例如数据库连接炸了）应该向上冒 ——
 *    在 `TurnGateway` 那一层被转成 `not_written`，
 *    因为那一层才知道"这一轮整体已经失败了"。
 *    在这里吞掉它会让"数据库不可用"看起来像"这句话没听懂"。
 */
export function createExplicitMemoryTurnPort(
  options: CreateExplicitMemoryTurnOptions
): ExplicitMemoryTurnPort {
  const detector = options.detector ?? createExplicitMemoryIntentDetector()

  return {
    async handleTurn(request) {
      /*
       * 非用户事件**不处理**（而不是判定后忽略）。
       *
       * `detectExplicitIntentFromEvent` 本身会对非用户事件抛错
       * （`explicit_intent_from_non_user`）—— 那是 M4 反污染的入口闸。
       * 这里提前返回 `undefined` 而不是让它抛：TurnGateway 会对
       * assistant / system 事件也调用本端口，而"她自己的话"
       * 不该让整轮崩掉。真正的保护仍在服务入口。
       */
      if (request.event.actorType !== 'user') return undefined

      const recent = request.semanticCommand ? undefined : await options.readIntentContext?.(request)
      const intent = request.semanticCommand ? { kind: request.semanticCommand.kind, payload: request.semanticCommand.payload,
        sourceText: request.event.content, detectedBy: 'classifier' as const, matched: 'unified-semantic-entry' }
        : await detectExplicitIntentFromEvent(detector, request.event, recent)

      if (intent === undefined) return undefined

      const outcome = await options.service.handle({
        owner: request.owner,
        intent,
        triggerEventId: request.event.id,
        speaker: request.speaker,
        /*
         * ⚠️ M4.1：这一行以前**不存在**，而那正是 D1 能发生的原因之一。
         *
         * `targetHintsFrom()` 是实现完整、有测试的函数 ——
         * 但全仓库只有 `verify-m4-persistence.ts`（验收脚本）调用过它。
         * 也就是说生产里的目标解析**从来拿不到 hints**：
         *   · 第 4 步的词面打分因此永远失效（`scoreByHints` 拿不到提示词）
         *   · 于是"该 subject 下只剩一条就取它"成了唯一还在工作的路径
         *
         * 这与本项目另外三处"实现了但没接线"是同一个形状
         * （显式服务没人调用、生产内核没注册 MEMORY_*、后台抽取没有消费者）。
         */
        hints: targetHintsFrom(intent),
        ...(request.semanticCommand?.targetId ? { targetMemoryId: request.semanticCommand.targetId } : {}),
      })

      return translate(outcome, request.event.content)
    },
  }
}

/**
 * 把服务结论翻成"可以转述给模型的事实"。
 *
 * ⚠️ 这里的措辞是**面向模型的行为指令**，不是日志。
 *    它必须让"没写入"这件事在输出里**不可能被忽略** ——
 *    因为模型看到"记住"这个动作时，默认倾向是回答"好，我记住了"。
 *    一个温和的措辞（"写入遇到问题"）会被那个倾向盖过去。
 *
 * M9.1 起导出：`m9.1:test`（纯函数门）直接断言 D09 的新映射
 * （`performed:'dispute'` → `not_written` + `marked_disputed`）。
 */
export function translate(
  outcome: ExplicitMemoryOutcome,
  sourceText: string
): ExplicitMemoryTurnResult {
  /** 取用户要求记住的那部分内容（去掉指令外壳） */
  const payload = sourceText.trim()

  const actionLabel = (() => {
    switch (outcome.intent) {
      case 'remember':
        return '记住'
      case 'correct':
        return '更新'
      case 'forget':
        return '撤销'
      case 'dispute':
        return '标记存疑'
      default:
        return '处理'
    }
  })()

  if (outcome.ok) {
    /*
     * D09（M9.1 / ADR-072）：dispute 的 ok:true 只表示「存疑标记」生效，
     * **没有写入新内容**。翻译为 `not_written` + `marked_disputed`：
     * `executed = kind !== 'not_written'` 因此为 false ——
     * 模型不得用「记住了 / 改好了」这类成功口吻（R03：更正被判为矛盾时，
     * 旧读数是 written ⇒ 假成功）。否决「新 kind」方案：会稀释
     * `executed` 的既有测试契约（C9）。
     */
    if (outcome.performed === 'dispute') {
      return {
        kind: 'not_written',
        intent: outcome.intent,
        reason: 'marked_disputed',
        summary:
          `对方刚刚要求你${actionLabel}一件事，系统把相关记忆**标为存疑**了` +
          '（没有写入新内容，也没有直接改写旧内容）。\n' +
          '**不要**说"记住了 / 改好了"。如实说明：这条现在标为存疑，' +
          '需要对方再说清楚一点才能更新。',
      }
    }
    return {
      kind: 'written',
      intent: outcome.intent,
      memoryId: String(outcome.memoryId),
      summary:
        `对方刚刚明确要求你${actionLabel}一件事，系统**已经完成**。` +
        `你可以自然地确认。`,
    }
  }

  if (outcome.reason === 'already_applied') {
    return {
      kind: 'already_applied',
      intent: outcome.intent,
      summary:
        `对方刚刚明确要求你${actionLabel}一件事，而系统发现这件事**之前已经生效过了**` +
        '（不是这一次新写的）。确认时要说"已经记着了"，不要说"记下了"。',
    }
  }

  /*
   * ⚠️ 计划书第 55 节的核心：**没写入就不能说记住了**。
   *
   * 这一条必须写成"不要声称成功"这样的**禁令**，而不是"写入失败"
   * 这样的事实描述 —— 后者给了模型"那我自己圆一下"的空间。
   */
  return {
    kind: 'not_written',
    intent: outcome.intent,
    reason: outcome.reason,
    ...(outcome.codes !== undefined ? { codes: outcome.codes } : {}),
    summary:
      `对方刚刚明确要求你${actionLabel}一件事（"${payload.slice(0, 60)}"），` +
      `但系统**没有**完成（原因：${outcome.reason}）。\n` +
      '**不要**说已经记住 / 已经更新 / 已经忘掉。' +
      '按原因如实回应：听不懂内容就问清楚；找不到旧记忆就说你没找到；' +
      '系统故障就说明这次没记上、稍后再试。',
  }
}
