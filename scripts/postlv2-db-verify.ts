/**
 * 后 Lv2 · `PL2-AI-01` 结清门（`pnpm postlv2:db:verify`）。
 *
 * ============================================================================
 *  用户 2026-10-03 **当轮显式授权**："授权一次只读检查"
 * ============================================================================
 * 它回答一个**具体**问题：
 * ```text
 *   第 7 轮那次未授权打开（北京 15:23）**有没有把真实库升级到 v11**？
 * ```
 *
 * ---------------------------------------------------------------------------
 *  这个门的前两版都**量错了东西**，两处都值得留在案里
 * ---------------------------------------------------------------------------
 * ```text
 * 第一版：经生产状态机打开真实库 → 被**迁移闸**正确拦下（代码 v11 / 库 v10）。
 *         那一趟本身给出一个读数（库不是 v11）并留下 pre-open 快照，但也说明
 *         "打开真实库"这条路在当前代码版本下根本走不通 ⇒ 换成读快照副本。
 * 第二版：用 `initDatabase` 打开快照副本 → 读到 **v11**，差点写成"库被升级了"。
 *         真因：`initDatabase` 会**把待应用的迁移施加到它打开的库上** ——
 *         那个 v11 是我自己在副本上造成的。**量具改变了被测对象。**
 * ```
 * 第三版（本文件）因此立了两条硬约束：
 * ```text
 * ③ 只用**原始只读连接**（`PGlite(dataDir, { readOnly: true })`），
 *    **不** import `initDatabase` / plugin-sql / AgentRuntime —— 任何会跑迁移的东西一律不进这个进程。
 * ② 版本从 `character_schema_migrations` 表**逐行读**（表名是实测出来的，不是猜的）。
 * ④ "代码最新版本"**从迁移清单读**（`latestSchemaVersion()`），**不手写常量** ——
 *    手写的那一版在 `R-40` 里被实测证明会印出假结论。
 * ```
 *
 * ⚠️ **本门不主张**："那次打开没有写任何东西"。`INV-DB-02` 说打开就会写
 * （`pg_control`/WAL/`postmaster.pid`），而目录 mtime 确实被改过 —— 那部分由
 * `PL2-AI-01` 的事故记录承担。本门只回答 schema 有没有被升级。
 *
 * ---------------------------------------------------------------------------
 *  ⏩ **2026-10-04 修订（登记册 §0p `R-40`）：两处"假前提"已修**
 * ---------------------------------------------------------------------------
 * ```text
 * ① `LATEST_SCHEMA_VERSION` 原是**手写常量 11**，而迁移清单早已到 0013（真库在授权下到 v13）
 *    ⇒ 它印出的"代码最新是 v11"是错的。现在从迁移清单读（`latestSchemaVersion()`）。
 * ② 那句散文"而代码最新是 v11 ⇒ **v11 从未被应用到真实库**"是**过度外推**：
 *    本门读的是**历史时点快照**，它只能主张"**在该时点快照上** v11 那一行不存在"。
 *    现在按快照口径措辞，并把"代码当前最新 / 真库其后到 v13"分列成**不属本门主张**的背景。
 * ③ 两个快照 id 已被保留策略剪掉（`snapshot_dir_missing`）⇒ 加 `PL2_DB_SNAPSHOTS` 覆盖，
 *    并把这种状态判成**具名的** `SNAPSHOTS PRUNED`（不是笼统的 MEASUREMENT INVALID）。
 * ```
 * ⇒ 修法**不扩大**本门的主张，只移除假前提与过度外推。
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(process.cwd())
const SNAPSHOT_ROOT = resolve(process.env.PGLITE_SNAPSHOT_DIR ?? join(REPO_ROOT, 'data/snapshots'))

/*
 * ⚠️ 快照 id **逐字**来自目录列表，不是构造出来的。
 * 两份都读，是因为"单点读数"分不清"库一直没变"与"那次打开正好把它改了"。
 *
 * ⚠️ 2026-10-04：快照根有**保留策略**，下面这两个 id 已被剪掉 ⇒ 允许用
 *    `PL2_DB_SNAPSHOTS=<id1>,<id2>` 覆盖（顺序 = 事故时点 / 复核时点）。
 */
const SNAPSHOT_OVERRIDE = (process.env.PL2_DB_SNAPSHOTS ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter((item) => item !== '')

const DEFAULT_SNAPSHOTS = {
  /** 第 7 轮那次打开**当时**的 pre-open 快照（目录 mtime = 北京 15:23:36，WAL mtime = 15:23:41） */
  atIncident: 'pglite-2026-10-03T07-23-35-901Z-fbfb1e846ddc',
  /** 今天复核时的 pre-open 快照（目录 mtime = 北京 16:49:00） */
  atRecheck: 'pglite-2026-10-03T08-48-59-356Z-f95cc8766235',
} as const

const SNAPSHOTS =
  SNAPSHOT_OVERRIDE.length === 2
    ? { atIncident: SNAPSHOT_OVERRIDE[0] as string, atRecheck: SNAPSHOT_OVERRIDE[1] as string }
    : DEFAULT_SNAPSHOTS

/**
 * 代码里的最新迁移版本 —— **从迁移清单读**（**不手写**）。
 *
 * ⚠️ `R-40` 的教训：手写的 `11` 在真实库到 v13 之后仍然被印成"代码最新"，
 *    于是一句错误的前提推出了错误结论。清单是权威源，常量不是。
 *    `migrations.ts` 只依赖两个叶子模块（`KernelError` / `SEMANTIC_INDEX_DDL`），
 *    不会跑迁移 ⇒ 不违反本文件的硬约束 ①。
 */
const { latestSchemaVersion } = await import('../src/infrastructure/persistence/migrations.ts')
const LATEST_SCHEMA_VERSION = latestSchemaVersion()

interface SnapshotReading {
  id: string
  exists: boolean
  openedReadOnly: boolean
  appliedMigrations: { version: number; name: string }[]
  schemaVersion: number | null
  conversationEvents: number | null
  memories: number | null
  error?: string
}

const assertReadOnly = (statement: string): void => {
  const head = statement.trim().slice(0, 6).toLowerCase()
  if (!head.startsWith('select')) {
    throw new Error(`拒绝非 SELECT 语句：${statement.slice(0, 100)}`)
  }
}

async function readSnapshot(id: string): Promise<SnapshotReading> {
  const source = join(SNAPSHOT_ROOT, id)
  const base: SnapshotReading = {
    id,
    exists: existsSync(source),
    openedReadOnly: false,
    appliedMigrations: [],
    schemaVersion: null,
    conversationEvents: null,
    memories: null,
  }
  if (!base.exists) return { ...base, error: 'snapshot_dir_missing' }

  const copyDir = mkdtempSync(join(tmpdir(), 'pl2db-'))
  try {
    cpSync(source, join(copyDir, 'data'), { recursive: true })
    const require = createRequire(import.meta.url)
    const entry = pathToFileURL(require.resolve('@electric-sql/pglite')).href
    const pglite = (await import(entry)) as {
      PGlite: new (path: string, options?: { readOnly?: boolean }) => unknown
    }
    const db = new pglite.PGlite(join(copyDir, 'data'), { readOnly: true }) as {
      waitReady: Promise<void>
      query: (statement: string) => Promise<{ rows: Record<string, unknown>[] }>
      close: () => Promise<void>
    }
    await db.waitReady
    const query = async (statement: string): Promise<Record<string, unknown>[]> => {
      assertReadOnly(statement)
      return (await db.query(statement)).rows
    }

    const rows = await query('select version, name from character_schema_migrations order by version asc')
    const appliedMigrations = rows.map((row) => ({
      version: Number(row['version']),
      name: String(row['name']),
    }))
    const schemaVersion = appliedMigrations.reduce<number | null>(
      (max, item) => (max === null || item.version > max ? item.version : max),
      null
    )
    const countOf = async (table: string): Promise<number> => {
      const result = await query(`select count(*)::int as n from ${table}`)
      return Number(result[0]?.['n'] ?? 0)
    }
    const reading: SnapshotReading = {
      ...base,
      openedReadOnly: true,
      appliedMigrations,
      schemaVersion,
      conversationEvents: await countOf('conversation_events'),
      memories: await countOf('memories'),
    }
    await db.close()
    return reading
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }
  } finally {
    try {
      rmSync(copyDir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响读数 */
    }
  }
}

console.log('='.repeat(74))
console.log('后 Lv2 —— PL2-AI-01 结清：快照**只读**对读（原始只读连接；不打开真实库）')
console.log('='.repeat(74))

const readings: SnapshotReading[] = []
for (const [label, id] of Object.entries(SNAPSHOTS)) {
  const reading = await readSnapshot(id)
  readings.push(reading)
  console.log(
    `\n${label}：${id}\n` +
      `  只读打开=${String(reading.openedReadOnly)} · schema=v${String(reading.schemaVersion)} · ` +
      `已应用迁移=${reading.appliedMigrations.length} 条 · ` +
      `conversation_events=${String(reading.conversationEvents)} · memories=${String(reading.memories)}` +
      (reading.error !== undefined ? `\n  ⚠️ ${reading.error}` : '')
  )
}

const [atIncident, atRecheck] = readings
const bothReadable =
  atIncident?.openedReadOnly === true &&
  atRecheck?.openedReadOnly === true &&
  atIncident.schemaVersion !== null &&
  atRecheck.schemaVersion !== null
const V10 = 10
/*
 * ⚠️ **判据修正（2026-10-03，清 `L-S8-25`）**：本门原来的期望把"S8 还没跑"编码成了
 *    `STILL_V10`，于是"真实库已按**显式授权**迁移到 v13"会被读成失败。
 *    它真正要守的性质不是"版本恰好等于 10"，而是：
 *      ① 两份快照都**可只读打开**且**彼此一致**（不一致 = 有人动过其中一份）；
 *      ② 版本落在一个**已知**取值上（迁移前的基线 v10，或代码当前最新版本）。
 *    "被测试静默迁移"与"被授权显式迁移"**无法只凭版本号区分**，
 *    因此本条不再声称能区分二者 —— 那是 `INC-01` 快照/租约机制与激活记录的职责。
 */
/** 判定三态分列（不合成一个"OK"）—— 外加一态：**快照已被保留策略剪掉，本门这次没测成** */
const snapshotsPresent =
  atIncident?.exists === true && atRecheck?.exists === true
const verdict = !snapshotsPresent
  ? 'SNAPSHOTS PRUNED'
  : !bothReadable
    ? 'MEASUREMENT INVALID'
    : atIncident?.schemaVersion === V10 && atRecheck?.schemaVersion === V10
      ? 'STILL_V10'
      : atIncident?.schemaVersion === atRecheck?.schemaVersion &&
          (atIncident?.schemaVersion === LATEST_SCHEMA_VERSION || atIncident?.schemaVersion === V10)
        ? atIncident?.schemaVersion === V10
          ? 'STILL_V10'
          : 'AT_CURRENT'
        : 'UNEXPECTED'

/*
 * ⚠️ `measured_count > 0` 自证：这里"测到的项" = 真的逐行读出来的已应用迁移条数。
 * 读到 0 条 ⇒ MEASUREMENT INVALID（而不是"版本 0 ⇒ 通过"）。
 */
const measuredCount =
  (atIncident?.appliedMigrations.length ?? 0) + (atRecheck?.appliedMigrations.length ?? 0)
const gateValid = measuredCount > 0
/** ⚠️ `SNAPSHOTS PRUNED` **优先**：它是更具体的结论（快照被保留策略剪掉），不许被笼统的 INVALID 盖掉 */
const finalVerdict =
  verdict === 'SNAPSHOTS PRUNED' ? verdict : gateValid ? verdict : 'MEASUREMENT INVALID'

let head = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变结论 */
}
const runId = `postlv2-db-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
/*
 * ⚠️ `evidence` **按结论分支**（`R-40` 的第二处假前提）：
 *    旧版无论测没测成都无条件印"而代码最新是 v11 ⇒ v11 从未被应用到真实库"——
 *    ① 前提错（代码早已到 13）② 外推过头（本门读的是**历史时点快照**，只能主张**该时点**上那一行不存在）。
 */
const snapshotSummary = (reading: SnapshotReading | undefined): string =>
  reading === undefined
    ? '（缺）'
    : `v${String(reading.schemaVersion)}（${String(reading.appliedMigrations.length)} 条，最后一条 ${
        reading.appliedMigrations.at(-1)?.name ?? '—'
      }）`

const settledEvidence =
  finalVerdict === 'SNAPSHOTS PRUNED'
    ? `本次**没有拿到可读的快照对** ⇒ 这道门**这次没有重测**（不是"测出来是 v11"）。` +
      `缺失：atIncident=${SNAPSHOTS.atIncident}（exists=${String(atIncident?.exists)}） · ` +
      `atRecheck=${SNAPSHOTS.atRecheck}（exists=${String(atRecheck?.exists)}）。` +
      `快照受保留策略约束，允许用 \`PL2_DB_SNAPSHOTS=<id1>,<id2>\` 指定仍存在的两份对重跑。` +
      `**已入库的旧读数（含 2026-10-03 那次）不因本结论改写。**`
    : finalVerdict === 'MEASUREMENT INVALID'
      ? `两份快照存在但**读不出一致/可用的版本**（只读打开或行数不足）⇒ 本门没能出结论（不是"通过"）。`
      : `两份快照的 \`character_schema_migrations\` 分别是 ${snapshotSummary(atIncident)} 与 ` +
        `${snapshotSummary(atRecheck)}：**在该时点的快照上** v11 那一行不存在` +
        `（${String(atIncident?.appliedMigrations.length)} 条，最后一条 ${String(atIncident?.appliedMigrations.at(-1)?.name)}）` +
        `⇒ 那次打开**没有把库升到 v11**。` +
        `⚠️ 本门只主张**快照时点**上如此；代码当前最新 = v${String(LATEST_SCHEMA_VERSION)}（从迁移清单读，不手写），` +
        `其后真实库在**显式授权**下到 v13 —— 那属激活记录与 \`INC-01\`，**不在本门主张内**。`

const artifact = {
  runId,
  gate: 'postlv2:db:verify',
  milestone: 'post-lv2 / PL2-AI-01 settlement (read-only snapshot cross-check)',
  authorization: '用户 2026-10-03 当轮显式授权：授权一次只读检查',
  generatedAt: new Date().toISOString(),
  source: { head },
  method:
    '对读两份 pre-open verified 快照的**副本**，经 `PGlite(dataDir, { readOnly: true })` 原始只读连接；' +
    '本进程**不** import 任何会跑迁移的模块（`initDatabase` / plugin-sql / AgentRuntime）。' +
    '真实库目录在本门里**一次都不打开**。',
  codeLatestSchemaVersion: LATEST_SCHEMA_VERSION,
  snapshots: { atIncident, atRecheck },
  measuredCount,
  verdict: finalVerdict,
  settledFinding: {
    id: 'PL2-AI-01',
    question: '第 7 轮那次未授权打开是否把真实库升级到了 v11？',
    answer: finalVerdict,
    evidence: settledEvidence,
    earlierInvalidReading:
      '本门的第二版读到 v11 并一度按"库被升级"理解 —— 那是**量具造成的**：' +
      '`initDatabase` 会把待应用迁移施加到它打开的库上，而它打开的是我的副本。已废弃该读数（不写进结论）。',
  },
  notClaimed: [
    '不主张"那次打开没有写任何东西"：INV-DB-02 说打开就会写 pg_control/WAL，目录 mtime 确实被改过（见 PL2-AI-01 事故记录）',
    '不主张快照与此刻的真实库逐字节相同：快照是当时点的复制品，其后真实库仍可能被别的会话改动',
    '不主张数据内容正确：只读 schema 版本、迁移行与两项计数',
  ],
}
writeFileSync(join(outDir, 'db-verify.json'), JSON.stringify(artifact, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}（已应用迁移行数之和）`)
console.log(`  codeLatestSchemaVersion = v${String(LATEST_SCHEMA_VERSION)}（**从迁移清单读**，不手写）`)
console.log(`  ${finalVerdict === 'STILL_V10' || finalVerdict === 'AT_CURRENT' ? '✅' : '⚠️'} postlv2:db:verify = ${finalVerdict}`)
console.log(`  PL2-AI-01：${artifact.settledFinding.evidence}`)
console.log(`  证据：artifacts/post-lv2/${runId}/db-verify.json`)
process.exit(finalVerdict === 'STILL_V10' || finalVerdict === 'AT_CURRENT' ? 0 : 1)
