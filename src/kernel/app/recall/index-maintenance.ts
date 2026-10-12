/**
 * M9.5 WP5 —— **派生索引的增量维护核心**（水位 / 缺口 / 重试 / 终态）。
 *
 * ============================================================================
 *  它只做一件事，但那一件事是 WP5 的全部要害
 * ============================================================================
 * ```text
 * 计划 §8.3 第 3 条逐字：「第 40 条失败、第 41 条成功，不得把水位直接写为 41 并遗漏 40。」
 * 第 7 条：「`published` 不等于永远完整；新记忆未索引时显式报告 pending」。
 * ⇒ 于是这个模块的**唯一职责**是：给定一批已尝试的结果，算出
 *      · 哪些行**真的可以写**（成功的那些 —— 包括缺口之后的，
 *        因为"水位不推进"不等于"后面的行不写"）
 *      · **连续已处理水位**推到哪（**遇到第一个未成功的就停**）
 *      · 失败项的**尝试次数与终态**（终态 ≠ 可以跳过水位）
 *      · `pendingCount` / `failedCount` / `coverageComplete`
 * ```
 *
 * ============================================================================
 *  为什么是**纯函数**（没有数据库、没有模型）
 * ============================================================================
 * ```text
 * 这一层最容易出的错是**算错水位**，而算错的表现是"少索引了几条、但一切看起来正常"
 * —— 那是最难查的一类缺陷。把它做成纯函数，就能用穷举的输入把边界钉死
 * （缺口的第一个/中间/最后一个位置；重试刚好到上限；缺口之后还有成功的）。
 * ⇒ 落盘与编码在**调用方**；本模块不 import 数据库、不 import 推理运行时。
 * ```
 */

/** 一条待索引的源记录（`seq` = 权威事件/记录的稳定位置，单调增） */
export interface SourceItem {
  readonly seq: number
  readonly memoryId: string
  readonly sourceRevision: number
}

/** 一次编码尝试的结果 */
export interface Attempt {
  readonly item: SourceItem
  readonly ok: boolean
  /** 失败原因（具名；见契约 §2.4 的失败分类） */
  readonly reason?: string
}

export interface FailureRecord {
  readonly memoryId: string
  readonly seq: number
  readonly reason: string
  readonly attempts: number
  /** 到达 `maxAttempts` 之后的**终态**：仍然**不能**被水位跳过 */
  readonly terminal: boolean
}

export interface MaintenanceState {
  /** **连续**已处理水位：它之前的每一条都已有当前处理结果 */
  readonly processedWatermark: number
  readonly failures: readonly FailureRecord[]
  /** 本代身份（换代后旧代不得继续喂水位） */
  readonly generationId: string
  readonly modelFingerprint: string
  readonly indexSchemaVersion: number
}

export interface MaintenancePlan {
  /** 真的可以落盘的行（成功的；**含缺口之后**的那些） */
  readonly rowsToWrite: readonly SourceItem[]
  readonly nextWatermark: number
  readonly failures: readonly FailureRecord[]
  /** 水位是否被缺口挡住（true ⇒ 不能宣称"已处理到本批末尾"） */
  readonly gapBlocked: boolean
  readonly gapAtSeq: number | null
  readonly pendingCount: number
  readonly failedCount: number
  /** 成功落盘但位于缺口**之后**的行数（它们不会推进水位） */
  readonly writtenAboveGap: number
  /** 覆盖完整 = 无待处理**且**无失败（**不是** `row count == 期望`） */
  readonly coverageComplete: boolean
  readonly haltReason: string | null
}

export interface PlanInput {
  readonly state: MaintenanceState
  /** 本批的尝试结果（顺序任意；本函数会按 seq 升序归一） */
  readonly attempts: readonly Attempt[]
  /** 本批最多处理多少条（有界；`<=0` 视为非法） */
  readonly batchLimit: number
  /** 一条最多尝试几次后进终态 */
  readonly maxAttempts: number
  /** 源记录总数（用于算 pending；缺省 = 水位 + 失败 + 本批） */
  readonly sourceTotal?: number
}

/**
 * 规划一批维护动作。
 *
 * 三条**必须**成立的规则（`pnpm m9.5:lifecycle:verify` 逐条出证据）：
 * ```text
 * ① 水位**只**在"从当前水位起连续成功"时推进；遇到第一个未成功即停。
 * ② 缺口**之后**成功的行**照样写**（它们的向量是有效的），但**不**推进水位。
 * ③ 失败达到 `maxAttempts` ⇒ `terminal: true`；**终态仍挡住水位**
 *    —— "这条永久失败"与"这条可以跳过"是两件事（后者只能由显式排除政策决定）。
 * ```
 */
export function planIndexMaintenance(input: PlanInput): MaintenancePlan {
  if (!Number.isInteger(input.batchLimit) || input.batchLimit <= 0) {
    throw new Error(`batchLimit 必须是正整数（收到 ${String(input.batchLimit)}）`)
  }
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts <= 0) {
    throw new Error(`maxAttempts 必须是正整数（收到 ${String(input.maxAttempts)}）`)
  }

  const ordered = [...input.attempts].sort((a, b) => a.item.seq - b.item.seq)
  const failuresById = new Map(input.state.failures.map((item) => [item.memoryId, item]))
  const rowsToWrite: SourceItem[] = []
  const succeededSeqs = new Set<number>()

  let writtenAboveGap = 0
  let processedThisBatch = 0

  /* 已失败但**没**出现在本批里的项，要原样保留（否则重放会"忘记"缺口） */
  const touched = new Set<string>()

  for (const attempt of ordered) {
    if (attempt.item.seq <= input.state.processedWatermark) continue
    if (processedThisBatch >= input.batchLimit) break
    processedThisBatch += 1
    touched.add(attempt.item.memoryId)

    if (attempt.ok) {
      rowsToWrite.push(attempt.item)
      succeededSeqs.add(attempt.item.seq)
      /* 成功即清掉这条的历史失败记录 */
      failuresById.delete(attempt.item.memoryId)
      continue
    }

    const previous = failuresById.get(attempt.item.memoryId)
    const attempts = (previous?.attempts ?? 0) + 1
    failuresById.set(attempt.item.memoryId, {
      memoryId: attempt.item.memoryId,
      seq: attempt.item.seq,
      reason: attempt.reason ?? 'unknown',
      attempts,
      terminal: attempts >= input.maxAttempts,
    })
  }

  const failures = [...failuresById.values()]
    .filter((record) => record.seq > input.state.processedWatermark)
    .sort((a, b) => a.seq - b.seq)

  /*
   * ⚠️ **走表法**（这是本模块最容易写错的地方，且第一版就写错了）：
   *
   * 第一版只在**本批**里发现缺口（"本次尝试里有失败 ⇒ 设 gapAtSeq"），于是
   * **跨批携带**的已知失败被忽略 —— 「上一批 40 失败、这一批 41 成功」会把水位推到 41，
   * 正是计划 §8.3 第 3 条禁止的那件事。单批探针掩盖了它（`terminal-failure` 探针才抓到）。
   *
   * 正确的算法：把所有"相关位置"（本批成功 + 已知失败，且都在当前水位之上）按升序走一遍，
   * 一路是成功就推进水位，**遇到第一个失败即停**。
   * 这样"本批内的缺口"与"跨批携带的缺口"用的是同一段代码。
   */
  const relevantSeqs = [...new Set<number>([...succeededSeqs, ...failures.map((record) => record.seq)])]
    .filter((seq) => seq > input.state.processedWatermark)
    .sort((a, b) => a - b)
  const failingSeqs = new Set(failures.map((record) => record.seq))

  let watermark = input.state.processedWatermark
  for (const seq of relevantSeqs) {
    if (failingSeqs.has(seq)) break
    watermark = seq
  }
  const gapAtSeq = failures.length > 0 ? (failures[0] as FailureRecord).seq : null

  /* 成功但落在水位之后（被缺口挡住）的行数 —— 它们**照样写**，只是不推进水位 */
  for (const seq of succeededSeqs) {
    if (seq > watermark) writtenAboveGap += 1
  }

  const sourceTotal = input.sourceTotal ?? Math.max(watermark, ...ordered.map((a) => a.item.seq), 0)
  const pendingCount = Math.max(0, sourceTotal - watermark - failures.length)
  const failedCount = failures.length

  return {
    rowsToWrite,
    nextWatermark: watermark,
    failures,
    gapBlocked: failures.length > 0,
    gapAtSeq,
    pendingCount,
    failedCount,
    writtenAboveGap,
    coverageComplete: pendingCount === 0 && failedCount === 0,
    haltReason:
      failures.length === 0
        ? null
        : `水位被 seq=${String(gapAtSeq)} 挡住（失败或终态）⇒ 不能宣称"已处理到本批末尾"`,
  }
}

/**
 * 重放同一批（模拟"写成功但水位未推进就断电"之后的重启）：
 * 期望**只**给出尚未写入的行，且**不**推进水位越过缺口。
 */
export function replayIsIdempotent(input: PlanInput, alreadyWritten: readonly string[]): MaintenancePlan {
  const written = new Set(alreadyWritten)
  const filtered: PlanInput = {
    ...input,
    attempts: input.attempts.filter((attempt) => !written.has(attempt.item.memoryId)),
  }
  return planIndexMaintenance(filtered)
}

/** 换代检查：旧代不得继续喂水位（计划 §8.3 第 6 条：禁止不同模型空间混排）。 */
export function assertSameGeneration(
  state: MaintenanceState,
  batch: { readonly generationId: string; readonly modelFingerprint: string; readonly indexSchemaVersion: number }
): void {
  if (state.generationId !== batch.generationId) {
    throw new Error(
      `禁止跨代维护：状态属于 ${state.generationId}，本批属于 ${batch.generationId}（旧代不得继续喂水位）`
    )
  }
  if (state.modelFingerprint !== batch.modelFingerprint) {
    throw new Error(
      `禁止混排：状态模型指纹 ${state.modelFingerprint}，本批 ${batch.modelFingerprint}（模型换代必须新 generation）`
    )
  }
  if (state.indexSchemaVersion !== batch.indexSchemaVersion) {
    throw new Error(
      `派生 schema 版本不一致：状态 ${String(state.indexSchemaVersion)}，本批 ${String(batch.indexSchemaVersion)}`
    )
  }
}
