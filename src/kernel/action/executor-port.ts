/**
 * CapabilityAdapter —— 适配器端口（M4.5 §14 / ADR-030）。
 *
 * ============================================================================
 *  适配器不认识"谁想执行"、也不认识"该不该执行"
 * ============================================================================
 * `execute()` 拿到的输入里**没有** `requestedBy`、**没有**策略结论。
 * 它只做一件事：把一次已经判定为"该做"的操作做出来。
 *
 * 这不只是洁癖 —— 它是"权限判定只有一个地方"的结构性保证：
 * 如果适配器能看到"用户想让我删这个文件"，它总有一天会自己判断
 * "用户都说了那就删吧"，而那正是 M4.5 要排除的东西。
 *
 * 真实实现住在 `src/infrastructure/action/adapters/`（MI-13：kernel 不 import 基础设施），
 * 并且**沙箱根在适配器构造时注入**（`createSandboxFilesystemAdapter({ root })`）——
 * 适配器自己不允许推导"沙箱在哪"。
 */

import type { ActionId, Timestamp } from '../contracts/ids.ts'
import type { ExternalEvidence } from '../contracts/external-evidence.ts'
import type { TurnContent } from '../contracts/turn-content.ts'
import type { ActionEffect, ActionEvidence, ActionRequest, ActionTarget } from './action-request.ts'
import type { ActionFailure } from './errors.ts'

export interface AdapterExecuteInput {
  actionId: ActionId
  operation: string
  /** 已经解析好、并且已经判定为确定的目标 */
  target: ActionTarget
  /** 原始参数（路径、内容…） */
  args: Record<string, unknown>
  /**
   * post-Lv2 / ADR-110 `D05`：这条动作的**幂等键**（= `ActionRequest.idempotencyKey`）。
   *
   * ```text
   * 为什么适配器需要它：主动投递的"这一次机会"必须有一个**程序给的**稳定键 ——
   *   它要写进实例行、要当投递关联 id、要保证重试不会变成两次发送。
   * 为什么不放 args：args 的闭集是**给模型看的**，模型写不进去的字段不该混在里面。
   *   实测教训：第一版把它塞进 args（`__occurrenceKey`），能力自己的闭集检查
   *   **当场拒绝**（`参数只有 text，收到 __occurrenceKey`）—— 那个拒绝是对的。
   * ```
   * ⚠️ 它是 `ActionRequest` 上的字段，**模型没有任何路径能写它**；
   *    缺省 `undefined` ⇒ 老适配器逐字不变（本字段是**追加**的）。
   */
  idempotencyKey?: string
  /** 时钟（注入以便测试固定时间；适配器不得直接读 `Date.now()`） */
  now: () => Timestamp
}

/**
 * 适配器的成功返回。
 *
 * `partial` 是 §28 要求的形状：写 3 个文件成功 2 个时，
 * 结果**不能**是"成功" —— 它必须带着 `completed / total` 一起回来，
 * 于是回复层能说"只完成了一部分"。
 */
export interface AdapterOutcome {
  effect?: ActionEffect
  evidence?: readonly ActionEvidence[]
  /**
   * M5.5：这一次调用产生的**当轮外部证据**（内存载体，**含摘要**）。
   *
   * ⚠️ 它**不**进账本、不进 trace：那两处只收 `evidence[]` 里每条
   *    `ActionEvidence.externalEvidence`（引用，无正文）。见 ADR-045 `D-8`。
   *    只有 `web.search` 这类会产出外部证据的适配器才填它。
   */
  externalEvidence?: readonly ExternalEvidence[]
  /**
   * 实用能力加装：这一次调用**实际取得的当轮内容**（计算 / 文档 / 网页正文 / OCR）。
   *
   * ⚠️ 与 `externalEvidence` 同一条边界：它是**当轮内存载体**（含正文），
   *    账本 / trace / 开发者面只收 `toTurnContentRef()`（无正文的引用）。
   *    只有四项实用能力适配器才填它 —— 旧适配器不填 ⇒ 形状与旧路径逐字不变。
   */
  turnContent?: readonly TurnContent[]
  partial?: {
    completed: number
    total: number
    detail?: string
  }
}

export interface CapabilityAdapter {
  /** 必须与登记的能力 id 完全一致（Gateway 据此查表） */
  readonly capabilityId: string
  execute(input: AdapterExecuteInput): Promise<AdapterOutcome>
}

/**
 * 适配器可以**主动**返回一个归一失败（不抛异常）。
 *
 * 两条路都可以（抛 `ActionFailureError` 或返回这个），但都必须归一 ——
 * 见 `errors.ts`：账本里不允许出现"原始错误字符串"。
 */
export interface AdapterFailureOutcome {
  failure: ActionFailure
}

export function isAdapterFailure(
  outcome: AdapterOutcome | AdapterFailureOutcome
): outcome is AdapterFailureOutcome {
  return (outcome as AdapterFailureOutcome).failure !== undefined
}

/**
 * 把适配器收集到的证据规整成数组。
 *
 * 存在的理由：`AdapterOutcome` 允许 `readonly ActionEvidence[]`，
 * 而账本要写 JSON —— 一次显式拷贝避免把调用方的可变数组交给持久层。
 */
export function evidenceOf(outcome: AdapterOutcome): ActionEvidence[] {
  return outcome.evidence === undefined ? [] : [...outcome.evidence]
}

/** 拆开适配器的参数（只认字符串参数，其余一律缺省） */
export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/** 请求的稳定一行摘要（日志与账本用；**不含参数内容**） */
export function describeActionRequest(request: ActionRequest): string {
  return `${request.capability}.${request.operation} by=${request.requestedBy.kind}`
}
