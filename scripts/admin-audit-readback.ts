/**
 * A1 / **只读读回**：从**真实库**读动作账本里 `admin.jobs.admit` 的记录，核对归因。
 *
 * ============================================================================
 *  它为什么存在（WP3 的最后一格）
 * ============================================================================
 * ```text
 * WP3 的缺口是：管理动作的审计 `initiator` 恒为 `Unknown(RUNTIME_UNRESOLVED)`
 *   （全仓只有一个建 writer 的地方没传身份：`main.ts:7936`；控制面没有已认证入口）。
 * 写面接上之后，**管理动作经管理控制台发起** ⇒ initiator 应当是
 *   `SERVICE/admin-console`（用户 2026-10-14 裁定的位次），且**有据**（已认证会话）。
 * ⚠️ 这条读数**必须从库里读回**，**不能**从 HTTP 响应里自证（响应是我们自己写的）。
 *
 * ⚠️ **只读**：它只做一条 `select`（**不走** `listRecords`：那个端口只返回无归因字段的 `ExecutionRecordView`），
 *    **不**开迁移、**不**写任何行；跑完即关连接。
 * ⚠️ 身份核对照旧：`initDatabase` 会核对 `LG_PG_EXPECT_*`，不符 ⇒ **拒绝开库**。
 *
 * 跑法：`node tsx scripts/admin-audit-readback.ts [--limit 5] [--capability admin.jobs.admit]`
 */
import 'dotenv/config'

/** payload 是 json 文本；解析不了就**如实**当作没有 effect（不猜） */
const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const argOf = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : fallback
}
const limit = Number(argOf('--limit', '5'))
const capability = argOf('--capability', 'admin.jobs.admit')

const { AgentRuntime } = await import('@elizaos/core')
const sqlPlugin = (await import('@elizaos/plugin-sql')).default
const { character } = await import('../src/character/index.ts')
const { initDatabase } = await import('../src/db/index.ts')
const { initKernel } = await import('../src/kernel/app/kernel.ts')
const { characterDefinitionFromCharacter } = await import('../src/infrastructure/runtime/seed-projection.ts')
const { closeDatabaseConnection } = await import('../src/infrastructure/persistence/runtime-shutdown.ts')

/*
 * ⚠️ 开库**逐字照抄**只读探针（`scripts/postgresql-cutover-probe.ts`）那套：
 *   AgentRuntime(settings 里带 POSTGRES_URL 等) → initDatabase → runtime.initialize()
 *   → initKernel（拿 stores.db 与 characterId）→ 收尾 closeDatabaseConnection
 * ⚠️ `2026-10-14` 实测教训：`--migrate` 那条路当年**漏了**播种（连到 `template1` ⇒ 被身份核对拒绝）；
 *    这里**显式**播种，避免重复那个坑。
 */
const runtime = new AgentRuntime({
  character: character as never,
  plugins: [],
  settings: {
    ...(process.env.POSTGRES_URL ? { POSTGRES_URL: process.env.POSTGRES_URL } : {}),
    ...(process.env.CHARACTER_DB_BACKEND ? { CHARACTER_DB_BACKEND: process.env.CHARACTER_DB_BACKEND } : {}),
    ...(process.env.PGLITE_DATA_DIR ? { PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR } : {}),
    ...(process.env.LG_PG_EXPECT_DATABASE ? { LG_PG_EXPECT_DATABASE: process.env.LG_PG_EXPECT_DATABASE } : {}),
    ...(process.env.LG_PG_EXPECT_DATABASE_PREFIX
      ? { LG_PG_EXPECT_DATABASE_PREFIX: process.env.LG_PG_EXPECT_DATABASE_PREFIX }
      : {}),
  },
})

try {
  await initDatabase(runtime, sqlPlugin as never)
  await runtime.initialize()
  const kernel = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character as never) })
  const { exec } = await import('../src/infrastructure/persistence/db.ts')
  const { sql } = await import('drizzle-orm')
  /*
   * ⚠️ 走**只读 SQL**，不走 `listRecords`：端口只返回 `ExecutionRecordView`
   *    （execution-ledger.ts:231，**没有**归因字段）⇒ 拿不到 initiator。
   * ⚠️ 列名**照实查过**（`information_schema.columns`，2026-10-14）：这张表是**每事件一行**
   *    （`sequence` / `event_type` / `payload`），**没有** `executed` / `effect_kind` /
   *    `effect_fingerprint` 列（effect 在 `payload` 里）⇒ 第一版照抄"折叠记录"的列名直接查失败。
   * ⚠️ 只 `select`，**不**开迁移、**不**写；**参数取值绝不回显**（`D09`）。
   */
  const rows = await exec(
    kernel.stores.db,
    sql`select action_id, sequence, event_type, capability, operation, status, idempotency_key,
                initiator_kind, initiator_id, initiator_unknown_reason, payload
           from character_action_events
          where capability = ${capability}
          order by sequence desc
          limit ${Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 50) : 5}`,
    '读回动作账本的归因'
  )
  const shaped = rows.map((row) => {
    /* effect 只取 `kind` / `fingerprint`（jobId）两格；**不回 params** */
    const payload = (typeof row.payload === 'string' ? safeJson(row.payload) : row.payload) as
      | { effect?: { kind?: unknown; fingerprint?: unknown } }
      | undefined
    return {
      actionId: String(row.action_id),
      sequence: Number(row.sequence),
      eventType: String(row.event_type),
      capability: String(row.capability),
      operation: String(row.operation),
      status: String(row.status),
      /** 三态如实：`kind`/`id` 为空且 reason 非空 ⇒ UNKNOWN（**不**猜成某个人） */
      initiator: row.initiator_kind === null || row.initiator_kind === undefined
        ? `UNKNOWN(${String(row.initiator_unknown_reason ?? 'UNKNOWN')})`
        : `${String(row.initiator_kind)}/${String(row.initiator_id ?? '')}`,
      idempotencyKey: row.idempotency_key ?? null,
      effectKind: payload?.effect?.kind ?? null,
      /** ⚠️ 只回 jobId（effect 指纹）；**不回参数取值** */
      effectFingerprint: payload?.effect?.fingerprint ?? null,
    }
  })
  console.log(JSON.stringify({ ok: true, capability, count: shaped.length, records: shaped }, null, 2))
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
    /* ⚠️ 第一版把**任何**失败都标成"身份核对不通过" ⇒ 那会把 SQL/列名错误误报成保护生效，
       比不报更坏。现在只在该说的场合说，其余如实给出原错误。 */
    hint: /身份|identity|期望/.test(error instanceof Error ? error.message : String(error))
      ? '身份核对不通过 ⇒ **拒绝开库**（保护，不是故障）；也不要为了"读一下"去改 LG_PG_EXPECT_*'
      : '这是查询/列名/连接类错误（**不是**身份核对）；按原错误排查，别归错因',
  }, null, 2))
  process.exitCode = 1
} finally {
  await closeDatabaseConnection(runtime)
}
