/**
 * 「一条到点的提醒，从**实例尚未存在**走到**交给外壳**」（post-Lv2 / ADR-110 `D07`/`D08`）。
 *
 * ============================================================================
 *  为什么它单独成模块
 * ============================================================================
 * ```text
 * 它的五步里有**四步是库写入**（占用 → evaluating → prepared → dispatching），
 * 而"写库那一段"必须能被判据层**真的跑一遍**（隔离库 + 真 store），
 * 不能只是 main.ts 里的一段 inline 代码 —— inline 的东西门看不见。
 * ⇒ 这里只吃端口；装配层给真 store / 真网关的端口，门给夹具端口。
 * ```
 *
 * ============================================================================
 *  五步（每一步失败都有具名理由）
 * ============================================================================
 * ```text
 * ① `reserveOccurrence()`  —— **插入成功才算占用**（唯一入口；`L-QQP-01` 的探针同伴）
 *    ⚠️ 幂等：同一 `occurrenceKey` 第二次 ⇒ `created=false`，**不**报错、**不**重发
 *    已被别的状态占着 ⇒ 具名拒绝（**不**覆盖）
 * ② `pending → evaluating`  —— 迁移表要求（`pending → prepared` **不在表里**）
 * ③ `evaluating → prepared` —— **候选正文在这一步落库**（`reminderTemplateText` 由程序给）
 * ④ `dispatchProactiveText()` —— 先 `dispatching` 再经真网关（见那个模块的顺序说明）
 * ⑤ 结局：`dispatching`（等回执）/ `failed_confirmed`（本地确定没发出）
 * ```
 *
 * ⚠️ **本轮的措辞由程序模板给出**（`reminderTemplateText`）：那是 ADR-110 `D03` 里
 *    "`silence` ⇒ `deliver_template`"的那一支。**模型选措辞那一步还没接线** ——
 *    已登记（`L-QQP-04`），不假装它存在。
 */
import type { NotificationOccurrenceState } from '../contracts/notification.ts'
import { reminderTemplateText } from '../contracts/proactive-proposal.ts'
import {
  dispatchProactiveText,
  type ProactiveActionPort,
  type ProactiveDispatchPort,
} from './proactive-delivery.ts'

/** 持久层端口（权威在 `notification-store`） */
export interface ReminderStorePort {
  /**
   * 占用一个实例（**插入成功才算占用**）。
   *
   * ⚠️ `created=false` 是**常态**（同一机会第二次进来），不是失败 —— 也不是"可以重发"。
   */
  reserveOccurrence(input: { occurrenceKey: string }): Promise<{
    created: boolean
    /** 现状（`created=false` 时给出；认不出来 ⇒ `undefined`） */
    state?: NotificationOccurrenceState
  }>
  advanceReminder(input: {
    occurrenceKey: string
    to: NotificationOccurrenceState
    text?: string
  }): Promise<{ ok: boolean; code?: string; state?: NotificationOccurrenceState }>
}

export interface DeliverReminderOutcome {
  /** 这一句**交给外壳了**（**不**等于送达；平台结局由回执写） */
  readonly dispatched: boolean
  readonly code?: string
  readonly state?: NotificationOccurrenceState
  readonly actionId?: string
  /** 这一次调用有没有**创建**实例（`false` = 这个机会先前就占着了） */
  readonly occurrenceCreated: boolean
}

export const REMINDER_TEMPLATE_PROCESSOR = 'qq-proactive-reminder-template'

export async function deliverReminder(input: {
  readonly occurrenceKey: string
  /** 已校验的提醒内容（**不是**模型生成的；见文件头的 `L-QQP-04`） */
  readonly intentText: string
  readonly store: ReminderStorePort
  readonly dispatch: ProactiveDispatchPort
  readonly action: ProactiveActionPort
  readonly generation: number | null
}): Promise<DeliverReminderOutcome> {
  const occurrenceKey = String(input.occurrenceKey ?? '').trim()
  if (occurrenceKey === '') {
    return { dispatched: false, code: 'reminder_without_occurrence_key', occurrenceCreated: false }
  }

  /* ① 占用（幂等：第二次进来 `created=false`） */
  const reserved = await input.store.reserveOccurrence({ occurrenceKey })

  /*
   * ⚠️ 已经**走过**这条链的实例不许再走一遍：`created=false` 时看现状 ——
   *    只有 `pending` / `evaluating` / `prepared` 才继续（其余都是已定案或正在飞）。
   */
  if (!reserved.created && reserved.state !== undefined) {
    const resumable: readonly NotificationOccurrenceState[] = ['pending', 'evaluating', 'prepared']
    if (!resumable.includes(reserved.state)) {
      return {
        dispatched: false,
        code: `reminder_occurrence_${reserved.state}`,
        state: reserved.state,
        occurrenceCreated: false,
      }
    }
  }

  /* ②③ 走到 `prepared`（`pending → prepared` 不在迁移表里，必须分两步） */
  if (reserved.state === undefined || reserved.state === 'pending') {
    const evaluating = await input.store.advanceReminder({ occurrenceKey, to: 'evaluating' })
    if (!evaluating.ok) {
      return { dispatched: false, code: evaluating.code ?? 'reminder_evaluating_refused', state: evaluating.state, occurrenceCreated: reserved.created }
    }
  }
  if (reserved.state !== 'prepared') {
    const prepared = await input.store.advanceReminder({
      occurrenceKey,
      to: 'prepared',
      /* ⚠️ 候选正文**只**在这一步写；它由程序模板给（`D03` 的 `deliver_template` 那一支） */
      text: reminderTemplateText(input.intentText),
    })
    if (!prepared.ok) {
      return { dispatched: false, code: prepared.code ?? 'reminder_prepared_refused', state: prepared.state, occurrenceCreated: reserved.created }
    }
  }

  /* ④⑤ 交给外壳（先 dispatching 再执行；失败 ⇒ failed_confirmed） */
  const dispatched = await dispatchProactiveText({
    occurrenceKey,
    text: reminderTemplateText(input.intentText),
    kind: 'reminder',
    generation: input.generation,
    dispatch: input.dispatch,
    action: input.action,
  })
  return {
    dispatched: dispatched.dispatched,
    ...(dispatched.code === undefined ? {} : { code: dispatched.code }),
    ...(dispatched.state === undefined ? {} : { state: dispatched.state }),
    ...(dispatched.actionId === undefined ? {} : { actionId: dispatched.actionId }),
    occurrenceCreated: reserved.created,
  }
}
