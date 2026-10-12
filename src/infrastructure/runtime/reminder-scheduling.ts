import type { RawDb } from '../persistence/db.ts'
import { advanceOccurrence, advanceRepeatSchedule, finishIntent, getIntent, getOccurrence, latestOccurrenceForIntent, listAttemptedReminderOccurrenceKeys, listPendingIntents, reserveOccurrence, type NotificationIntentRecord } from '../persistence/notification-store.ts'
/* ★ S3 ③（ADR-129 D05）：续发的判据是冻结纯函数（键一致性/上限/销账/暂停优先级都在里面） */
import { nextRepeatOccurrence } from '../../kernel/app/reminder/repeat-policy.ts'
import { reminderOccurrenceKey } from '../../kernel/contracts/notification.ts'
import { decideReminderDue } from '../../kernel/contracts/notification-intake.ts'
import type { ChatChannel } from '../../kernel/contracts/chat-channel.ts'
import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type { QqDeliveryRegistry } from '../../kernel/app/notification-delivery.ts'
import { deliverReminder } from '../../kernel/app/proactive-reminder.ts'

/** One list/dispatch implementation for coexistence and standalone entries. */
export function createReminderScheduling(input: {
  db: RawDb; characterId: CharacterId; channels: readonly ChatChannel[]
  registry: (channel: ChatChannel) => QqDeliveryRegistry
  execute: (channel: ChatChannel, request: { occurrenceKey: string; text: string }) => Promise<{ outcome: 'executed' | 'refused'; code?: string; actionId?: string }>
  reading: (reading: unknown) => void
  /*
   * ★ S3 ③ 缺口 B（ADR-129 D05「任何回复即销账」）：**最近一次真实入站**的时刻。
   *
   * ⚠️ 这个读数现在只在**关心机会预检**那条路里算（在 `main.ts`）⇒ 续发要判"投递之后他回过没有"，
   *    就必须把它**喂进来**（判据本身早已冻结：`decideReminderRepeat({ settledByReply })`）。
   * ⚠️ 缺席（`undefined`）= **判不了** ⇒ 调用方按既有行为办（不续发）。
   *    与其它读数的三态纪律一致：**缺席绝不等于"没有回复"**。
   */
  lastInboundAt?: () => Promise<number>
  /*
   * ★ S3 ③（ADR-129 D05）：**停机/暂停优先于重复** —— 暂停状态的读数口。
   *
   * ⚠️ 暂停是**落库**的状态（`notification_control`），现在只在关心机会预检那条路里读
   *    ⇒ 续发要判"现在能不能发"，就必须把它喂进来（判据里的优先级已冻结在 `decideReminderRepeat`）。
   * ⚠️ 缺席（`undefined`）= **判不了** ⇒ 调用方按既有行为办；
   *    ⚠️ 实现提醒续发**之前**必须把真读数接上 —— 否则会出现"暂停了还继续发"（D05 明令优先）。
   */
  paused?: () => Promise<boolean>
  /**
   * ★ 可注入的续发间隔（毫秒；缺席 ⇒ 冻结常量 60_000，行为逐字不变）。
   * 存在的理由：**行为级门要在秒级观测到第二条**（否则一道门得等 60 秒）。
   * ⚠️ 生产装配从 flags 读（缺省 60_000）⇒ 不设那个环境变量时行为与改动前完全相同。
   */
  repeatIntervalMs?: number
}) {
  const intents = new Map<string, NotificationIntentRecord>()
  return {
    async listPendingReminders() {
      const pending = await listPendingIntents(input.db, input.characterId, { kind: 'reminder', limit: 500 })
      const attempted = new Set(await listAttemptedReminderOccurrenceKeys(input.db, input.characterId))
      intents.clear()
      const due: { occurrenceKey: string; dueAt: number }[] = []
      for (const intent of pending) {
        if (!input.channels.includes(intent.deliveryChannel)
          || input.registry(intent.deliveryChannel).currentGeneration() === null) continue
        const baseKey = reminderOccurrenceKey({ intentId: String(intent.id), planVersion: intent.planVersion, dueAt: intent.scheduledAt })
        /*
         * ==================================================================
         *  ★ S3 ③（ADR-129 D05）：**续发的排期与恢复收在这一处**（规格 §1.2c）
         * ==================================================================
         *  ⚠️ 非 `until_reply` ⇒ 下面第一条分支，**逐字保持旧行为**（attempted/代次过滤也照旧）。
         *  ⚠️ 键一律由**同一个冻结函数**算出（`nextRepeatOccurrence` 内部也用它）——
         *     键算错只有两种坏结局：撞上幂等（续发永不发生）或差一点（重复投递）。
         */
        if (intent.repeatMode !== 'until_reply') {
          if (attempted.has(baseKey)) continue
          intents.set(baseKey, intent)
          due.push({ occurrenceKey: baseKey, dueAt: intent.scheduledAt })
          continue
        }
        const { occurrence, count } = await latestOccurrenceForIntent(input.db, intent.id)
        if (occurrence === undefined) {
          /* 第一条还没发过 ⇒ 仍按原排期 */
          if (attempted.has(baseKey)) continue
          intents.set(baseKey, intent)
          due.push({ occurrenceKey: baseKey, dueAt: intent.scheduledAt })
          continue
        }
        const lastInbound = (await input.lastInboundAt?.()) ?? 0
        const armed = nextRepeatOccurrence({
          intentId: String(intent.id), planVersion: intent.planVersion, mode: intent.repeatMode,
          attempt: count, deliveredAt: occurrence.dueAt,
          /* 销账：投递**之后**他回过任何一句（D05"任何回复即销账"） */
          settledByReply: lastInbound > occurrence.dueAt,
          /* 暂停优先（D05）：缺席 = 判不了 = 不当作暂停 */
          paused: (await input.paused?.()) === true,
          /* ★ 可注入间隔：缺席时不传 ⇒ 策略里回落到冻结常量 60_000 */
          ...(input.repeatIntervalMs === undefined ? {} : { intervalMs: input.repeatIntervalMs }),
        })
        /* 上限/销账/暂停 ⇒ stop；键已被尝试过 ⇒ 跳过（**防重复投递**） */
        if (armed.kind === 'stop' || attempted.has(armed.occurrenceKey)) continue
        /*
         * ★ (a)（用户 2026-10-10 裁定）：**把意图自己的排期一起前移**。
         *
         * 为什么必须在这一步：`reserveOccurrence` 带一条一致性 EXISTS ——
         *   **实例的 dueAt 必须等于意图的 scheduled_at**（notification-store.ts:502-505）。
         * 续发实例的 dueAt = 上次 + 60s ≠ 原 `scheduled_at` ⇒ 插不进去 ⇒ `created:false`
         * ⇒ **续发排上了却永远发不出去**（由夹具自检抓出的真缺陷）。
         * `advanceRepeatSchedule` 是**窄口**：只动 `until_reply`、`scheduled_at = from`（乐观并发）、
         * 只许前移 ⇒ 并发臂两次不会跳过一拍（第二次返回 false，这一拍就不排，下一次 tick 再算）。
         */
        const advanced = await advanceRepeatSchedule(input.db, {
          intentId: intent.id, fromDueAt: occurrence.dueAt, toDueAt: armed.dueAt,
        })
        if (!advanced) continue
        intents.set(armed.occurrenceKey, intent)
        due.push({ occurrenceKey: armed.occurrenceKey, dueAt: armed.dueAt })
      }
      return due
    },
    async onReminderDue(due: { occurrenceKey: string; dueAt: number }) {
      const cached = intents.get(due.occurrenceKey)
      if (!cached) return
      const intent = await getIntent(input.db, cached.id)
      if (!intent || intent.status !== 'pending' || intent.planVersion !== cached.planVersion) return
      const registry = input.registry(intent.deliveryChannel)
      const decision = decideReminderDue({ dueAt: intent.scheduledAt, now: Date.now() })
      if (decision.action === 'expire') {
        /*
         * ==================================================================
         *  ★ S4 ②（ADR-129 D07/D08）：把"**错过**"与"**过期**"分开
         * ==================================================================
         *  判据是一个**可推导事实**（不靠猜"当时核心在不在"）：
         *    · 该意图**从未产生过实例**（= 到期那一刻什么都没做，核心当时不在）
         *      ⇒ `missed` —— 它正是**补说**的对象（D08：下次对话逐条补说，≤10 条）；
         *    · **有过实例**（尝试过但没送成 / 被取消 / 作废）
         *      ⇒ `expired` —— 不是"错过"，**不**进补说候选。
         *  ⚠️ 只用 `reminder_expired` 那一路改终态；`reminder_not_due_yet`（还没到点）**什么都不做**。
         */
        if (decision.code === 'reminder_expired') {
          const attempts = (await latestOccurrenceForIntent(input.db, intent.id)).count
          await finishIntent(input.db, intent.id, attempts === 0 ? 'missed' : 'expired')
        }
        input.reading({ occurrenceKey: due.occurrenceKey, channel: intent.deliveryChannel, code: decision.code })
        return
      }
      const result = await deliverReminder({ occurrenceKey: due.occurrenceKey, intentText: intent.text!,
        store: {
          reserveOccurrence: async () => {
            const result = await reserveOccurrence(input.db, { occurrenceKey: due.occurrenceKey, intentId: intent.id,
              expectedPlanVersion: intent.planVersion, characterId: input.characterId, kind: 'reminder', dueAt: due.dueAt,
              permissionVersion: intent.permissionVersion, policyVersion: intent.policyVersion })
            return { created: result.created, state: result.occurrence?.state }
          },
          advanceReminder: async request => await advanceOccurrence(input.db, request.occurrenceKey, request),
        },
        dispatch: registry,
        action: { execute: async request => await input.execute(intent.deliveryChannel, request) },
        generation: registry.currentGeneration(),
      })
      input.reading({ occurrenceKey: due.occurrenceKey, channel: intent.deliveryChannel, ...result })
    },
  }
}

/** Receipt authority is bound to both channel and connection; payloads cannot switch either. */
export async function reportReminderForChannel(db: RawDb, channel: ChatChannel, registry: QqDeliveryRegistry, report: Parameters<QqDeliveryRegistry['report']>[0]) {
  const occurrence = await getOccurrence(db, report.deliveryId)
  const intent = occurrence?.intentId ? await getIntent(db, occurrence.intentId) : undefined
  if (intent?.deliveryChannel !== channel && !(channel === 'qq_private' && occurrence?.kind === 'care')) return { accepted: false, code: 'reminder_receipt_wrong_channel' }
  return await registry.report(report)
}

/** A local receipt must acknowledge an item actually sent on this connection. */
export function bindLocalReminderConnection(db: RawDb, channel: 'avatar' | 'cli', registry: QqDeliveryRegistry, sink: Parameters<QqDeliveryRegistry['openConnection']>[0]) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const settling = new Set<Promise<void>>()
  const unknown = async (id: string) => {
    pending.delete(id)
    if ((await getOccurrence(db, id))?.state === 'dispatching') await reportReminderForChannel(db, channel, registry,
      { deliveryId: id, status: 'delivery_unknown', reason: 'local_receipt_missing' })
  }
  const generation = registry.openConnection(out => {
    const written = sink!(out)
    if (written.written) {
      const timer = setTimeout(() => {
        const work = unknown(out.deliveryId).catch(() => { console.error('[reminder] local_receipt_settlement_failed') })
        settling.add(work)
        void work.finally(() => settling.delete(work))
      }, 10_000)
      timer.unref()
      pending.set(out.deliveryId, timer)
    }
    return written
  })
  return {
    async report(report: Parameters<QqDeliveryRegistry['report']>[0]) {
      if (!pending.has(report.deliveryId)) return { accepted: false, code: 'reminder_receipt_not_sent_on_connection' }
      const result = await reportReminderForChannel(db, channel, registry, { ...report, generation })
      if (result.accepted) { clearTimeout(pending.get(report.deliveryId)); pending.delete(report.deliveryId) }
      return result
    },
    async close() {
      for (const [id, timer] of pending) { clearTimeout(timer); await unknown(id) }
      await Promise.all(settling)
      registry.closeConnection(generation)
    },
  }
}
