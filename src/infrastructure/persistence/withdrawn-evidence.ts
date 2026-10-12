/**
 * 撤销证据读端口（M9.1 / ADR-072 D16）—— F-1 修复的数据面。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 *  `withdrawnSetCore`（contracts，语义权威）的**薄读适配器**：
 *  从记忆库读 retracted / superseded 记录与 MEMORY_RETRACTED 事件，
 *  拼出纯核输入。不新增表/列（ADR-072 §9 文件边界）。
 *
 *  消费方：turn-gateway 的遮蔽判定（经 main.ts 注入的 compute 回调，D15）。
 *  量具（`scripts/m9.1-fixtures.ts` 的 computeWithdrawnSet）**委托本端口**——
 *  「参考语义与生产语义一致」由共享代码直接保证。
 *
 * ============================================================================
 *  两条读取路径（P08 的语义要求）
 * ============================================================================
 *  路径 1（记录面）：当前 retracted / superseded 记录的**现值** sourceRefs。
 *    覆盖「撤了且没复活」的常态（P01/P02/P03/P09）。
 *
 *  路径 2（事件面）：**每一条** MEMORY_RETRACTED 事件的「撤回时来源」——
 *    该事件之前最近一条 MEMORY_CREATED 的 payload.record.sourceRefs
 *    （ADR-072 §3.2：旧证据仍在旧事件 payload）。覆盖「遗忘后重新告知」：
 *    复活把记录的 sourceRefs 换成新证据（M4 语义），但用户对**旧行**的
 *    遗忘言语行为没有被撤销——旧行仍遮蔽（P08②：旧来源仍禁用），
 *    新行不遮蔽（P08①：新来源可用）。多次遗忘各自成立（每次言语行为
 *    独立记账），重复来源由纯核的集合语义自然去重。
 *
 *  路径 2 的原因分类取自 RETRACTED 事件 payload（与路径 1 同源）；
 *  D17 的范围语义（explicit_forget 并链 / 其他仅自身）由纯核统一执行。
 *
 *  失败语义：读取抛错由调用方（gateway）按 D19 处理（压制整段 Recent +
 *  具名 trace 原因）；数据不完整（reason 缺失 / 孤儿 / 链截断）由纯核给出具名缺口。
 */
import type { EntityRef } from '../../kernel/contracts/entity.ts'
import type { MemoryCreatedPayload, MemoryRetractedPayload } from '../../kernel/contracts/domain-event.ts'
import type { DomainEvent } from '../../kernel/contracts/domain-event.ts'
import {
  withdrawnSetCore,
  type SupersededBySlot,
  type WithdrawnReason,
  type WithdrawnRecordInput,
  type WithdrawnSetResult,
} from '../../kernel/contracts/withdrawn-evidence.ts'
import type { MemoryStorePort } from './memory-store.ts'
import type { RawDb } from './db.ts'

/** 读一条记忆的事件史（升序）——store.history 的直通 */
async function historyOf(store: MemoryStorePort, memoryId: string): Promise<DomainEvent[]> {
  return store.history(memoryId as never)
}

/** 撤回时来源：该撤回事件之前最近一条 CREATE 的记录快照 sourceRefs（ADR-072 §3.2）。
 *  按 **id** 定位撤回事件在事件史中的位置——不能按对象身份（两条读取路径
 *  各自解析，引用相等必然失配——e2e 二轮实测踩过）。 */
function retractionTimeSources(
  events: readonly DomainEvent[],
  retractionId: string
): WithdrawnRecordInput | undefined {
  const retractionIndex = events.findIndex((e) => String(e.id) === retractionId)
  for (let i = retractionIndex - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type !== 'MEMORY_CREATED') continue
    const record = (event.payload as MemoryCreatedPayload).record
    return {
      id: String(record.id),
      ...(record.canonicalKey !== undefined ? { canonicalKey: record.canonicalKey } : {}),
      sourceRefs: record.sourceRefs,
    }
  }
  return undefined
}

/**
 * 撤销集计算（D16 端口本体）。
 *
 * @param db    原始库句柄（读 character_domain_events——路径 2 的事件面）
 * @param store 记忆库端口（只读操作：list / history）
 * @param owner 记忆属主（character）
 */
export async function computeWithdrawnEvidence(
  db: RawDb,
  store: MemoryStorePort,
  owner: EntityRef
): Promise<WithdrawnSetResult> {
  /* ---- 路径 1：当前 retracted / superseded 的现值（记录面） ---- */
  const retracted = await store.list({ owner, status: 'retracted', limit: 500 })
  const superseded = await store.list({ owner, status: 'superseded', limit: 500 })

  const reasonById = new Map<string, WithdrawnReason | undefined>()
  for (const record of retracted) {
    const events = await historyOf(store, String(record.id))
    const retraction = [...events].reverse().find((e) => e.type === 'MEMORY_RETRACTED')
    reasonById.set(
      String(record.id),
      retraction === undefined
        ? undefined
        : (retraction.payload as MemoryRetractedPayload).reason
    )
  }

  const supersededBySlot: SupersededBySlot = new Map()
  for (const record of superseded) {
    if (record.canonicalKey === undefined) continue
    const list = supersededBySlot.get(record.canonicalKey) ?? []
    list.push({
      id: String(record.id),
      canonicalKey: record.canonicalKey,
      sourceRefs: record.sourceRefs,
    } satisfies WithdrawnRecordInput)
    supersededBySlot.set(record.canonicalKey, list)
  }

  const retractedInputs: WithdrawnRecordInput[] = retracted.map((r) => ({
    id: String(r.id),
    ...(r.canonicalKey !== undefined ? { canonicalKey: r.canonicalKey } : {}),
    sourceRefs: r.sourceRefs,
  }))

  /* ---- 路径 2：每条 MEMORY_RETRACTED 的撤回时来源（事件面；P08②） ---- */
  const { domainEventsFor } = await import('./event-store.ts')
  const allEvents = await domainEventsFor(db, owner.id as never)
  for (const event of allEvents) {
    if (event.type !== 'MEMORY_RETRACTED') continue
    const payload = event.payload as MemoryRetractedPayload
    const events = await historyOf(store, String(payload.memoryId))
    const virtual = retractionTimeSources(events, String(event.id))
    if (virtual === undefined) continue
    retractedInputs.push(virtual)
    if (!reasonById.has(virtual.id)) {
      reasonById.set(virtual.id, payload.reason)
    }
  }

  return withdrawnSetCore({
    retracted: retractedInputs,
    reasonById,
    supersededBySlot,
  })
}
