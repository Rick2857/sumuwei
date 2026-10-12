/**
 * M10 `G-2`：兑现判定端口的**生产实现**（`GoalCompletionPorts`）。
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 * ```text
 * `runGoalTurn` 的四个端口里，`completion`（`report_complete` 路径要用的证据端口）
 * **在生产里从来没有实现过** —— `m10-e2e-verify.ts` 用的是一份**伪造事件的桩**
 * （`{id:'ev', qualification:'ESTABLISHED'}`）。那是**测试**的接法：
 * 把桩搬进生产就等于"**她凭伪造事件判定兑现完成**"。
 * ⇒ 这个文件把那三个查表接到**真的存储**上（`L-M10-67` 的施工单 ①）。
 * ```
 *
 * ============================================================================
 *  三条设计判据
 * ============================================================================
 * ```text
 * ① **只按 id 查，不搜索**：端口收的是**证据 id**（提案里给的），本层不去"找找看有没有
 *    别的能算证据的东西" —— 那会把"结构检查"变成"内容联想"。
 * ② **查不到就是查不到**：id 不存在 ⇒ **不产出那条读数**（不补一个默认值、不猜）。
 *    调用方（`judgeGoalCompletion`）会把缺失读成 `completion_evidence_missing`。
 * ③ **资格由程序推**（`sourceQualificationOf(originReadingOfEvent(event))`）——
 *    不是由内容猜，也不是由 actor_type 反推（那是 D01 的形状）。
 * ```
 */

import { sourceQualificationOf } from '../../kernel/contracts/attribution.ts'
import { originReadingOfEvent } from '../persistence/qualification-read.ts'
import { getConversationEvent } from '../persistence/conversation-store.ts'
import { createActionLedgerStore, foldRecord } from '../action/action-ledger-store.ts'
import type { RawDb } from '../persistence/db.ts'
import type { ConversationEventId, CharacterId, ActionId } from '../../kernel/contracts/ids.ts'
import type {
  GoalActionResultReading,
  GoalAssistantEventReading,
  GoalCompletionPorts,
  GoalUserEventReading,
} from '../../kernel/app/goal/completion.ts'

/**
 * 把兑现判定端口接到真存储上。
 *
 * ⚠️ **零缓存、零批处理技巧**：id 有几个就查几次 —— 兑现判定是**低频**路径
 *    （只在 `report_complete` 那一轮跑），为它做一个缓存只会引入"读到旧状态"的风险。
 */
export function createProductionGoalCompletionPorts(options: {
  readonly db: RawDb
  readonly characterId: CharacterId
}): GoalCompletionPorts {
  const { db, characterId } = options
  const ledger = createActionLedgerStore(db)

  return {
    /* ---- ① 用户侧：那条"她说完成了"的原话，以及它的受信资格 ---- */
    conversation: {
      findEvents: async (ids: readonly string[]): Promise<readonly GoalUserEventReading[]> => {
        const readings: GoalUserEventReading[] = []
        for (const id of ids) {
          const event = await getConversationEvent(db, id as ConversationEventId)
          if (event === undefined) continue
          /* 判据 ③：资格**由程序推**（读不出来 ⇒ `UNCONFIRMED_ORIGIN`，失败关闭） */
          const reading = originReadingOfEvent(event)
          readings.push({
            id: String(event.id),
            characterId: String(event.characterId),
            actorType: String(event.actorType),
            qualification: sourceQualificationOf(reading),
          })
        }
        return readings
      },
    },

    /* ---- ② 助手侧：她说过什么（`content` 与"回应的是哪条"） ---- */
    assistant: {
      findAssistantEvents: async (
        ids: readonly string[],
      ): Promise<readonly GoalAssistantEventReading[]> => {
        const readings: GoalAssistantEventReading[] = []
        for (const id of ids) {
          const event = await getConversationEvent(db, id as ConversationEventId)
          if (event === undefined) continue
          readings.push({
            id: String(event.id),
            characterId: String(event.characterId),
            actorType: String(event.actorType),
            ...(event.replyToEventId !== undefined
              ? { replyToEventId: String(event.replyToEventId) }
              : {}),
            text: event.content,
          })
        }
        return readings
      },
    },

    /* ---- ③ 动作侧：**执行了没有**由账本说了算（`executed`），不由回复口吻说了算 ---- */
    actions: {
      findActions: async (ids: readonly string[]): Promise<readonly GoalActionResultReading[]> => {
        const readings: GoalActionResultReading[] = []
        for (const id of ids) {
          const events = await ledger.getEventsByActionId(characterId, id as ActionId)
          if (events.length === 0) continue
          const record = foldRecord(events)
          if (record === undefined) continue
          readings.push({
            actionId: String(record.actionId),
            characterId: String(characterId),
            capability: record.capability,
            operation: record.operation,
            accepted: record.accepted,
            /* ⚠️ 这一行是"她真的做了没有"的**唯一**依据（适配器是否被调用过） */
            executed: record.executed,
            status: String(record.status),
          })
        }
        return readings
      },
    },
  }
}
