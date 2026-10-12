/**
 * Memory 投影的**补折叠**（recovery）—— M4 验收发现的缺口 S3-3。
 *
 * ============================================================================
 *  它修的是什么：一个**真实存在**的窗口，不是假想的
 * ============================================================================
 * M4 的写入是**两步**：
 *
 *     appendDomainEvent(...)   ← 事务 ①：领域事件落库（真源）
 *     applyMemoryEvent(...)    ← 事务 ②：把事件折叠进投影
 *
 * 两步之间进程如果死掉，库里就会留下一条**"已提交、未折叠"**的事件：
 * 事实**没有丢**（它在账本里），但 `memory_records` 里没有它 ——
 * 也就是说她会**暂时想不起来**，而且这件事**不会自愈**。
 *
 * 这不是推测。`m4:hardkill:verify` 用真实的 `taskkill /F` 杀在写入中间，
 * **实测复现了这个窗口**（留下 1 条孤儿 `MEMORY_*` 事件）。
 *
 * 为什么两步而不是一个大事务（那也能修掉这个窗口）：
 * `applyMemoryEvent` 由**每个**事件单独调用，而一批事件是
 * `applyAcceptedEvents` 一次写进去的。把它们并成一个大事务会改变
 * 既有的写入形状与乐观锁时序 —— 那个改动的影响面远大于"启动时扫一遍"。
 * 因此这里选**启动补折叠**：不动写入路径，只在读取之前把缺口补上。
 *
 * ---------------------------------------------------------------------------
 *  为什么后台路径本来就有恢复，而显式路径没有
 * ---------------------------------------------------------------------------
 *   · 后台抽取：事件由 job 驱动，job **没跑完就不会被标记完成**，
 *     水位也不会越过失败区间 → 重启后重试（`m4:faults` 已验）。
 *   · 显式路径（ADR-024，用户在等答复）：`validate → commit → fold` 同步完成，
 *     **没有** job 这一层。进程死在 commit 与 fold 之间时，没有任何组件会回头补。
 *
 * 本模块补的就是后者，并且对前者同样安全（幂等）。
 *
 * ---------------------------------------------------------------------------
 *  幂等与安全性
 * ---------------------------------------------------------------------------
 *  · 只处理 `type like 'MEMORY_%'` 且 `memory_events` 里**没有**对应行的事件
 *  · 按 `sequence` 升序折叠 —— 与 Replay 同一个顺序契约
 *  · 折叠前先用**纯 reducer** 预览：`changed === false` 时**只登记事件索引、
 *    不改投影**。这挡住的是一种真实存在的边缘状态：
 *    "投影已经反映过这条事件、而索引行缺失"——
 *    此时若无脑走 `applyMemoryEvent`，会出现"状态没变但 revision +1"。
 *  · 任何失败都被**如实收集**，不吞掉、也不让启动整个失败
 *    （她还能用；失败项由调用方大声记录，并且可以被再次扫到）
 */

import { sql } from 'drizzle-orm'

import {
  MEMORY_HANDLED_EVENT_TYPES,
  memoryIdOfEvent,
  reduceMemory,
} from '../../kernel/projections/memory.ts'
import type { DomainEvent, MemoryId } from '../../kernel/contracts/index.ts'
import { exec, type RawDb } from './db.ts'
import { rowToDomainEvent } from './event-store.ts'
import {
  appendMemoryEventLink,
  applyMemoryEvent,
  createNativeMemoryStore,
} from './memory-store.ts'

export interface MemoryRecoveryFailure {
  domainEventId: string
  type: string
  code: string
  message: string
}

export interface MemoryRecoverySummary {
  /** 扫到的"已提交、未折叠"事件数 */
  scanned: number
  /** 真的改了投影的条数 */
  refolded: number
  /** 投影已经反映过、只补登记索引的条数 */
  alreadyReflected: number
  /** 失败的条数（`failures` 里逐条给原因） */
  failed: number
  failures: MemoryRecoveryFailure[]
}

/**
 * 探针：**当前**有多少条"已提交、未折叠"的 MEMORY_* 事件（按 sequence 升序）。
 *
 * 它就是这条缺口的可观测形态：`0` 表示投影与事件流没有缝隙。
 * 单独导出是为了让测试与工具（`m4:hardkill`、`m4:restore`）能直接断言它，
 * 而不是只能间接看"某条记忆在不在"。
 */
export async function unfoldedMemoryEvents(db: RawDb): Promise<DomainEvent[]> {
  const rows = await exec(
    db,
    sql`select e.* from character_domain_events e
        where e.type like 'MEMORY_%'
          and not exists (
            select 1 from memory_events l where l.domain_event_id = e.id
          )
        order by e.sequence asc`,
    '扫描未折叠的 Memory 领域事件'
  )
  return rows
    .map((row) => rowToDomainEvent(row as unknown as Parameters<typeof rowToDomainEvent>[0]))
    .filter((event): event is DomainEvent => event !== undefined)
}

/**
 * 把"已提交、未折叠"的 Memory 领域事件补折叠进投影。
 *
 * 返回摘要而**不抛错**：这是启动路径上的**修复**动作，
 * 一条坏事件不该让她整个起不来（那会把"少了一条记忆"升级成"她不在线"）。
 * 失败项由调用方负责大声记录，并且**下次启动还会被扫到**。
 */
export async function recoverMemoryProjections(db: RawDb): Promise<MemoryRecoverySummary> {
  const orphans = await unfoldedMemoryEvents(db)
  const store = createNativeMemoryStore(db)

  const failures: MemoryRecoveryFailure[] = []
  let refolded = 0
  let alreadyReflected = 0

  for (const event of orphans) {
    const memoryId: MemoryId | undefined = memoryIdOfEvent(event)
    if (memoryId === undefined) {
      failures.push({
        domainEventId: String(event.id),
        type: event.type,
        code: 'memory_event_without_memory_id',
        message: `${event.type} 的 payload 里没有 memoryId / winnerId，无法折叠进任何投影`,
      })
      continue
    }

    try {
      /*
       * 先用**纯 reducer** 预览，而不是直接调 `applyMemoryEvent`。
       *
       * 理由：`applyMemoryEvent` 在 `changed === false` 时**仍然会**把
       * revision 推一格（它不读 `result.changed`），于是"投影本来就对、
       * 只是索引行缺失"这种状态会被写成"状态没变但版本 +1"。
       * 那不是数据损坏，但它让 revision 与事件流的关系变得不可解释 ——
       * 而 revision 正是乐观锁的判据。
       */
      const current = await store.get(memoryId)
      const preview = reduceMemory(current, event)

      if (MEMORY_HANDLED_EVENT_TYPES.includes(event.type) && preview.changed === false) {
        // 投影已经反映过这条事件：只补登记索引，不动投影
        await appendMemoryEventLink(db, memoryId, event)
        alreadyReflected += 1
        continue
      }

      await applyMemoryEvent(db, event, event.createdAt)
      refolded += 1
    } catch (error) {
      failures.push({
        domainEventId: String(event.id),
        type: event.type,
        code: String((error as { code?: string }).code ?? 'unknown'),
        message: String((error as { message?: string }).message ?? error),
      })
    }
  }

  return {
    scanned: orphans.length,
    refolded,
    alreadyReflected,
    failed: failures.length,
    failures,
  }
}
