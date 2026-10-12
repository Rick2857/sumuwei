/**
 * MemoryExtractionJob —— **后台抽取的任务化与断点续跑**（计划书第 63–69、162–163 节）。
 *
 * ⏩ **2026-10-07 裁定（用户）**：本文件**被 `ADR-117` / `ADR-118` 取代（保留实现）**。
 *
 * ```text
 * 能力已由**另一条路径**交付（不是本文件）：
 *   infrastructure/runtime/automatic-memory.ts
 *     → kernel/app/memory/pipeline.ts（同一套抽取链）+ 水位（job-store）
 *     → main.ts 的 构造 / open / drain / close 生命周期；.env 已激活（ADR-118）
 * ```
 *
 * ⚠️ **本文件的 job 入口仍然未接线**：`src/` 下 import 本文件 = 0；
 * `m4:test` 的 `memory-background(NOT-WIRED)` 断言与 M5.1.1 的 `wp9*` 门**照旧成立**
 * —— 本轮**没有**动它们，也**没有**改本文件的任何行为。
 * ⇒ 它是**未被使用的实现**，**不是**待补的生产缺口；保留它，是为了让那条链
 * （水位补洞 / 幂等键 / 断点续跑）与它的测试继续留在案。
 *
 * ⚠️ 将来若要真的把它接上：先读 `scripts/kernel-tests-memory.ts` 的那条反向断言
 * 与 [`docs/architecture/memory-lifecycle.md`](../../../../docs/architecture/memory-lifecycle.md) §3，
 * 两处都要**同步**改（那条断言的设计意图就是"接线时必须同时更新标签与文档"）。
 *
 * ============================================================================
 *  M4 使用 M2.5 的 Job 系统（计划书第 65 节）
 * ============================================================================
 *     MemoryExtractionJob：triggerKind = conversation
 *     输入：source event range
 *     并保存：processor / processorVersion / idempotencyKey
 *
 * 因此这里**不新建任务表**、不新建调度器。`character_jobs` /
 * `processed_operations` / `processor_watermarks` 三张表照用。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 本文件最重要的一条：水位必须**补洞**，不能只取最大值
 * ---------------------------------------------------------------------------
 * 计划书第 162–163 节：
 *
 *     如果某 Job 独立覆盖 Event 100–105，后续 106–110 可以继续。
 *     失败 100–105：需要能够重试。
 *     不要仅依赖一个全局整数导致中间洞丢失。
 *     因此推荐：Job Range + Status + High Water Mark 双重机制。
 *     High Water Mark 只代表：之前所有范围都已经完成。
 *
 * 现状的形状让这件事有一个**具体的**陷阱：
 *
 *     Job A = [100,105]  失败
 *     Job B = [106,110]  成功 → 若水位取"已完成的最大值"，它会变成 110
 *     而 100–105 **根本没做** —— 那 6 个事件永远不会被处理，
 *     而且**没有任何信号**：水位说"到 110 都完成了"。
 *
 * 这就是计划书说的"中间洞丢失"。因此本文件的水位推进是
 * **从 1 开始的连续前缀**，而不是最大值：
 *
 *     advanceWatermarkToContiguous()   ← 只推进到"能接上没有洞"的那一点
 *
 * `assertWatermarkAdvances()`（M2.5 的）**一个字都不改** ——
 * 它仍然拒绝回退，只是现在传入的值本身就不会回退。
 */

import {
  KernelError,
  computeIdempotencyKey,
  type CharacterId,
  type CharacterJob,
  type JobId,
  type MemoryCandidate,
  type MemoryRecord,
  type ProcessorVersion,
  type Timestamp,
} from '../../contracts/index.ts'

export const MEMORY_JOB_TRIGGER_KIND = 'conversation' as const

/** 这一层需要的任务存储能力（由装配层注入，本层不认识 SQL） */
export interface MemoryJobStorePort {
  enqueueJob(input: {
    characterId: CharacterId
    processor: string
    processorVersion: ProcessorVersion
    sourceFromSequence: number
    sourceToSequence: number
    idempotencyKey: string
    triggerKind: typeof MEMORY_JOB_TRIGGER_KIND
  }): Promise<{ job: CharacterJob; created: boolean }>
  getJob(id: JobId): Promise<CharacterJob | undefined>
  markJobRunning(id: JobId, now?: Timestamp): Promise<void>
  finishJob(
    id: JobId,
    status: 'completed' | 'failed',
    options?: { error?: string; now?: Timestamp }
  ): Promise<void>
  listJobs(
    characterId: CharacterId,
    options?: { status?: CharacterJob['status']; limit?: number }
  ): Promise<CharacterJob[]>
}

/** 这一层需要的水位能力 */
export interface MemoryWatermarkPort {
  getWatermark(
    characterId: CharacterId,
    processor: string,
    processorVersion: ProcessorVersion
  ): Promise<{ processedThroughSequence: number } | undefined>
  advanceWatermark(
    characterId: CharacterId,
    processor: string,
    processorVersion: ProcessorVersion,
    throughSequence: number,
    now?: Timestamp
  ): Promise<{ processedThroughSequence: number }>
}

// ---------------------------------------------------------------------------
// 幂等键（计划书第 69 节）
// ---------------------------------------------------------------------------

/**
 * Memory 抽取任务的幂等键。
 *
 * 计划书第 69 节的建议形状：
 *
 *     character + processor + processorVersion + eventRange + operation
 *     → hash
 *
 * 这正是 M2.5 的 `computeIdempotencyKey()`。**复用它**（不另写一个哈希）
 * 有两个好处：键的形状只有一处定义；而 `processorVersion` 已经被编进键，
 * 因此 `@2` 不会被 `@1` 的记录拦住（计划书第 66–67 节：
 * "改了 Prompt / Schema 就必须升级 @2"）。
 *
 * 与显式路径的键的**关键区别**：这里**不带 memoryId**。
 * 显式路径一次只处理一条记忆（键必须带它否则多条候选会撞键，审计 §6 F4）；
 * 而后台抽取是**一次处理一段事件区间**，整批是一个工作单元 ——
 * 因此键由区间唯一确定，重复排期同一区间会被 `character_jobs` 的
 * 部分唯一索引挡住（`status in ('pending','running','completed')`）。
 */
export function memoryExtractionIdempotencyKey(input: {
  characterId: CharacterId
  processor: string
  processorVersion: ProcessorVersion
  fromSequence: number
  toSequence: number
}): string {
  return computeIdempotencyKey({
    characterId: input.characterId,
    processor: input.processor,
    processorVersion: input.processorVersion,
    sourceFromSequence: input.fromSequence,
    sourceToSequence: input.toSequence,
    operation: 'extract',
  })
}

// ---------------------------------------------------------------------------
// 入队
// ---------------------------------------------------------------------------

export interface EnqueueMemoryExtractionInput {
  characterId: CharacterId
  processor: string
  processorVersion: ProcessorVersion
  /** 闭区间。装配层通常取"上一批之后到最新一条" */
  fromSequence: number
  toSequence: number
}

/**
 * 排一个抽取任务。
 *
 * 空区间（`from > to`）→ 抛错而不是"排一个什么都不做的任务"：
 * 一个空任务会让水位推进到 `to`，而 `to` 之前的事件其实没被处理 ——
 * 那是"中间洞"的另一种造法。
 */
export async function enqueueMemoryExtractionJob(
  store: MemoryJobStorePort,
  input: EnqueueMemoryExtractionInput
): Promise<{ job: CharacterJob; created: boolean }> {
  if (!Number.isSafeInteger(input.fromSequence) || input.fromSequence < 1) {
    throw new KernelError(
      'validation_error',
      'bad_source_range',
      `抽取任务的起始序号必须是 >= 1 的安全整数，收到 ${input.fromSequence}`
    )
  }
  if (input.toSequence < input.fromSequence) {
    throw new KernelError(
      'validation_error',
      'empty_source_range',
      `抽取任务的事件区间为空：[${input.fromSequence}, ${input.toSequence}]。` +
        '排一个什么都不做的任务会让水位越过它 —— 那是"中间洞"的另一种造法',
      { from: input.fromSequence, to: input.toSequence }
    )
  }

  return store.enqueueJob({
    characterId: input.characterId,
    processor: input.processor,
    processorVersion: input.processorVersion,
    sourceFromSequence: input.fromSequence,
    sourceToSequence: input.toSequence,
    idempotencyKey: memoryExtractionIdempotencyKey(input),
    triggerKind: MEMORY_JOB_TRIGGER_KIND,
  })
}

// ---------------------------------------------------------------------------
// 水位补洞（计划书第 162–163 节）
// ---------------------------------------------------------------------------

export interface ContiguousFrontier {
  /** 从 1 开始连续完成到哪一点（0 = 一个都没完成） */
  throughSequence: number
  /** 阻断点：这个序号所在的任务还没完成（没有洞时为 undefined） */
  blockedAt?: { from: number; to: number; status: CharacterJob['status'] }
}

/**
 * 算出"从 1 开始连续完成"的前缀末端。
 *
 * ============================================================================
 *  算法（纯函数，可穷举测试）
 * ============================================================================
 * 按 `sourceFromSequence` **升序遍历全部任务**（不只是 completed 的），
 * 用一个 frontier 从 `startingAt` 开始推进：
 *
 *     for job of 全部任务（升序）:
 *       · job.from > frontier + 1  → **跳不过去**，停止（后面更远的更接不上）
 *       · job.from <= frontier + 1：
 *           - completed  → frontier = max(frontier, job.to)
 *           - 未完成     → **停在这里**，frontier 不动（它覆盖的事件还没处理完）
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 为什么必须遍历**全部**任务而不是只遍历 completed（实测踩到过）
 * ---------------------------------------------------------------------------
 * 第一版只看 completed，于是下面这个场景算错了：
 *
 *     Job A = [1,5]    failed
 *     Job B = [6,10]   completed
 *
 * 第一版的做法是"从 completed 里找能接上 1 的" —— 但 A 不在 completed 里，
 * 所以它只看到 B；B.from=6 接不上 frontier=0，于是它把 blockedAt 设成 B
 * 并把 frontier 回退到 `B.from - 1 = 5`。**正确答案是 0**：
 * 从 1 开始的那一段（A 覆盖的）根本没有任何东西完成过。
 *
 * 而"5"是一个**看起来合理但错**的数字：它声称 1–5 处理完了，
 * 而它们全失败了。这正是计划书第 162 节要防的那种"中间洞丢失"，
 * 只不过方向相反 —— 不是水位太高，而是它在一个从未开始的区间上"有进度"。
 *
 * 遍历全部任务就不会有这个问题：A 会先被看到（from=1 接得上 frontier=0），
 * 而它是 failed → **停在那里，frontier 保持 0**。
 *
 * ---------------------------------------------------------------------------
 *  三条取舍
 * ---------------------------------------------------------------------------
 * **取舍 1：只有 completed 的任务会推进 frontier。**
 * failed / pending / running 都会**阻断** —— 这正是本函数与"取最大值"的
 * 全部区别。
 *
 * **取舍 2：允许区间重叠。** 重跑会造出重叠区间（`[100,105]` 跑两次）。
 * 若要求严格首尾相接，一次重跑会让水位**永久卡住**，而那比"洞丢失"更糟：
 * 它让水位缓慢停止前进，且没有任何错误。
 *
 * **取舍 3：接不上就停止遍历。** 任务按 from 升序，因此后面的任务
 * from 更大，更接不上 —— `break` 是安全的，且它保证"水位永不越过洞"。
 */
export function contiguousFrontierFrom(
  jobs: readonly CharacterJob[],
  options: { startingAt?: number } = {}
): ContiguousFrontier {
  const startingAt = options.startingAt ?? 0

  const ordered = [...jobs].sort((a, b) => a.sourceFromSequence - b.sourceFromSequence)

  let frontier = startingAt
  let blockedAt: ContiguousFrontier['blockedAt']

  for (const job of ordered) {
    // 接不上：中间有洞，停在这里（后面的 from 更大，更接不上）
    if (job.sourceFromSequence > frontier + 1) break

    if (job.status === 'completed') {
      // 允许重叠：frontier 取更远的那个末端
      frontier = Math.max(frontier, job.sourceToSequence)
      continue
    }

    /*
     * 未完成但落在可达范围内 → 它覆盖的事件还没处理完，水位停住。
     *
     * ⚠️ 两种情况，处理不同：
     *
     *   (a) 起点在 frontier **之外**（`from > frontier`）——
     *       它是一个真正的"洞"，水位保持 frontier 即可
     *
     *   (b) 起点在 frontier **之内**（`from <= frontier`）——
     *       它被某个更大的已完成区间**包住**了，例如
     *       A=[1,5] completed、B=[3,4] failed。此时 frontier 已经被 A
     *       推到了 5，但 B 覆盖的 3–4 **没有**处理完 ——
     *       因此必须把 frontier **压回** `B.from - 1`。
     *
     * 不处理 (b) 的后果：水位声称 3–4 已处理，而它们失败了。
     * 那与"取最大值"是同一个错误，只是更隐蔽（它藏在一个更大的成功区间里）。
     */
    blockedAt = {
      from: job.sourceFromSequence,
      to: job.sourceToSequence,
      status: job.status,
    }
    if (job.sourceFromSequence <= frontier) {
      frontier = Math.max(startingAt, job.sourceFromSequence - 1)
    }
    break
  }

  return { throughSequence: frontier, ...(blockedAt !== undefined ? { blockedAt } : {}) }
}

/**
 * 把水位推进到"连续完成的前缀"。
 *
 * **这是唯一允许推进水位的函数。** 直接调 `advanceWatermark(throughSequence = 已完成的最大值)`
 * 会造出"中间洞丢失"，而那个缺陷：
 *   · 不报错
 *   · 让水位看起来正常前进
 *   · 只是有 6 个事件永远不会被处理
 *
 * 因此把正确算法收在一个函数里，让"算错水位"在结构上不可能发生。
 */
export async function advanceWatermarkByGaps(
  store: MemoryJobStorePort,
  watermarks: MemoryWatermarkPort,
  input: {
    characterId: CharacterId
    processor: string
    processorVersion: ProcessorVersion
    now?: Timestamp
  }
): Promise<ContiguousFrontier & { before: number; advanced: boolean }> {
  const before = (
    await watermarks.getWatermark(input.characterId, input.processor, input.processorVersion)
  )?.processedThroughSequence ?? 0

  // 取足够多的已完成任务（水位的正确性依赖**完整**的区间历史，
  // 因此这里不设小 limit；实际上限由 `listJobs` 的实现决定）
  const jobs = await store.listJobs(input.characterId, { limit: 500 })
  const frontier = contiguousFrontierFrom(jobs)

  if (frontier.throughSequence > before) {
    await watermarks.advanceWatermark(
      input.characterId,
      input.processor,
      input.processorVersion,
      frontier.throughSequence,
      input.now
    )
    return { ...frontier, before, advanced: true }
  }
  return { ...frontier, before, advanced: false }
}

// ---------------------------------------------------------------------------
// 运行一个抽取任务
// ---------------------------------------------------------------------------

export interface MemoryJobRunResult {
  jobId: JobId
  status: 'completed' | 'failed' | 'skipped'
  /** `skipped` 的原因（任务已经被别的 worker 拿走了） */
  skippedReason?: string
  candidates: number
  accepted: number
  rejected: number
  created: MemoryRecord[]
  error?: string
}

export interface RunMemoryExtractionJobDeps {
  store: MemoryJobStorePort
  /** 抽取 → 值评估 → 放行 → 提交 → 折叠。由装配层提供（见 `pipeline.ts`） */
  processRange: (input: {
    fromSequence: number
    toSequence: number
  }) => Promise<{
    candidates: number
    accepted: number
    rejected: number
    created: MemoryRecord[]
  }>
  now?: () => Timestamp
}

/**
 * 跑一个抽取任务。
 *
 * ============================================================================
 *  失败**绝不影响聊天**（计划书第 63 / 144 / 147 节）
 * ============================================================================
 *     后台 extraction：fail → retry；聊天本身正常。
 *     LLM Timeout：job retry；不能影响聊天主链。
 *
 * 因此这个函数**不抛**：它把失败写进 job 的 `status = 'failed'` 与
 * `lastError`，然后正常返回。调用方（后台 worker / 命令）拿到的是一个结果对象，
 * 而不是一个异常 —— 因为异常会沿着调用链往上传，而这条链的另一端
 * 可能正是"用户刚说完话"的那一刻。
 *
 * ⚠️ 但**显式路径**不适用这条：那条路上的失败必须让调用方知道
 * （计划书第 55 节：不能假成功）。两者的区别是**谁在等结果**：
 * 后台没有人等，显式有。
 */
export async function runMemoryExtractionJob(
  deps: RunMemoryExtractionJobDeps,
  jobId: JobId
): Promise<MemoryJobRunResult> {
  const now = deps.now ?? (() => Date.now())

  const job = await deps.store.getJob(jobId)
  if (job === undefined) {
    return {
      jobId,
      status: 'failed',
      candidates: 0,
      accepted: 0,
      rejected: 0,
      created: [],
      error: `任务 ${String(jobId)} 不存在`,
    }
  }

  // --- 状态闸：只有 pending 能开始 ---------------------------------------
  try {
    await deps.store.markJobRunning(jobId, now())
  } catch (error) {
    /*
     * 不是 pending → **skipped，不是 failed**。
     *
     * 这一步同时是"重复 worker"的保护：两个 worker 同时抢同一个任务时，
     * 只有一个能把 pending → running（`markJobRunning` 的
     * `where status = 'pending'`），另一个会在这里失败。
     * 那不是故障，是**正确的互斥**，因此它不该把任务标成 failed ——
     * 那会把另一个 worker 正在做的事标成失败。
     */
    return {
      jobId,
      status: 'skipped',
      skippedReason: error instanceof Error ? error.message : String(error),
      candidates: 0,
      accepted: 0,
      rejected: 0,
      created: [],
    }
  }

  // --- 处理 ---------------------------------------------------------------
  try {
    const outcome = await deps.processRange({
      fromSequence: job.sourceFromSequence,
      toSequence: job.sourceToSequence,
    })
    await deps.store.finishJob(jobId, 'completed', { now: now() })
    return {
      jobId,
      status: 'completed',
      candidates: outcome.candidates,
      accepted: outcome.accepted,
      rejected: outcome.rejected,
      created: outcome.created,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 失败也写进 job（而不是抛出去）：那条链的另一端可能是用户刚说完话
    try {
      await deps.store.finishJob(jobId, 'failed', { error: message, now: now() })
    } catch {
      /* 连失败都写不进去时不再往上抛：那会把后台故障变成前台故障 */
    }
    return {
      jobId,
      status: 'failed',
      candidates: 0,
      accepted: 0,
      rejected: 0,
      created: [],
      error: message,
    }
  }
}

// ---------------------------------------------------------------------------
// 重试 policy（计划书第 146 节的"retry within policy"）
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_JOB_ATTEMPTS = 3

/**
 * 还能不能重试。
 *
 * 计划书第 146 节：
 *
 *     如果 extractor 返回 invalid schema → retry within policy
 *     仍失败 → job failed。不能自动尝试猜 JSON。
 *
 * "within policy"需要一个**上界**，否则一次持续失败的抽取会无限重试，
 * 而每次重试都调一次模型 —— 它会把"抽不出候选"变成一个静默的
 * 费用与延迟黑洞。因此上界是必要的，且它必须**可配置**（不同模型的
 * 稳定性差异很大）。
 */
export function canRetryMemoryJob(
  job: CharacterJob,
  maxAttempts = DEFAULT_MAX_JOB_ATTEMPTS
): boolean {
  return job.retryCount < maxAttempts
}

/**
 * 待处理的任务（按区间升序 = **按因果顺序**）。
 *
 * 升序很重要：后台抽取的语义是"随着时间推移，她逐渐理解过去"。
 * 若乱序处理，一次从旧区间抽出的候选可能 supersede 掉从新区间抽出的——
 * 而那会让"最新的事实"变成"更早的那条"。
 */
export async function pendingMemoryJobs(
  store: MemoryJobStorePort,
  characterId: CharacterId,
  options: { statuses?: CharacterJob['status'][]; limit?: number } = {}
): Promise<CharacterJob[]> {
  const statuses = options.statuses ?? ['pending', 'failed']
  const all: CharacterJob[] = []
  for (const status of statuses) {
    all.push(...(await store.listJobs(characterId, { status, limit: options.limit ?? 100 })))
  }
  return all.sort((a, b) => a.sourceFromSequence - b.sourceFromSequence)
}

/** 便于调用方：把一批候选的统计压成一行（进 trace） */
export function summarizeJobOutcome(result: MemoryJobRunResult): string {
  return (
    `${String(result.jobId)} [${result.status}] ` +
    `candidates=${result.candidates} accepted=${result.accepted} rejected=${result.rejected} ` +
    `created=${result.created.length}${result.error ? ` error=${result.error.slice(0, 80)}` : ''}`
  )
}

/** 让候选类型参与推导（避免未使用 import 的告警） */
export type { MemoryCandidate }
