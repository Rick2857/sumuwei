/**
 * M9.5 —— 「语义索引到底**建没建**」真实库**只读**读回（一次性诊断，2026-09-30）。
 *
 * ============================================================================
 *  为什么要读这一次
 * ============================================================================
 * 用户提问：M9.5 的语义召回开关 `CHARACTER_MEMORY_SEMANTIC_ENABLED=true` +
 * `CHARACTER_MEMORY_SEMANTIC_MODE=shadow` —— 那么"观察档"**真的在算分**吗？
 * 三种可能在**静态代码里分不出来**，必须读一次真实库：
 *
 * ```text
 * （a）索引已建（有已发布的代 + 向量）  ⇒ 观察档真的在算分，只差"切换"那一步
 * （b）索引没建                        ⇒ 探针每轮返回 `not_indexed`，观察档**没有对照可记**
 * （c）从没跑过                        ⇒ 读数上与 (b) 相同（本脚本用"有没有版本登记行/代"
 *                                        尽量把两者再分开一层）
 * ```
 *
 * 为什么静态读代码只到"可能"这一步（本次已核）：
 * ```text
 * · `ensureSemanticIndexSchema()` —— 建表/登记版本的**唯一**入口 ——
 *   在 `src/**` 里**只被 M9.5 自己的实验室脚本调用**（`scripts/m9.5-*-verify.ts`，
 *   全部跑在隔离库上）；`src/main.ts` 的启动路径**从不调用它**。
 * · `createSemanticProbe` **是**接在生产路径上的（`src/main.ts:1206`）。
 * · 探针的第一件事就是找 `build_state = 'published'` 的代；一个都没有 ⇒
 *   立刻 `not_indexed`，**连 134 MiB 的编码模型都不加载**（`semantic-probe.ts:183-186`）。
 * ⇒ 但"代码里没人建"不等于"库里没有"（历史上别的会话/手工跑过实验室脚本就是反例），
 *   所以结论只能由**读回**给出，不能由"我读过代码"给出。
 * ```
 *
 * ============================================================================
 *  安全边界（一条都没放松）
 * ============================================================================
 * ```text
 * ① 本脚本是**真实库 opener** ⇒ 走 INC-01 生产状态机
 *    （租约 → pre-open verified snapshot → token → 打开 → 停服务 → 关连接 →
 *      closed check → post-close 快照 → 释放租约），与
 *    `verify-m4-real-db.ts` / `m9-activation-readback.ts` 同源。
 * ② 「只读」是**构造上**成立的：唯一的执行口 `rows()` 拒绝一切非 SELECT 语句。
 * ③ **不 import `src/main.ts`**（模块加载会无条件跑完整 CLI）。
 * ④ 插件集与 main.ts 相同，但 `createPersistentCharacterPlugin` **只注册一个 provider**
 *    —— 没有 `init`、没有处理器 ⇒ 开库**不会**触发信念/情绪/目标等域追赶
 *    （那些在 `src/main.ts` 的聊天路径里，本脚本不加载它）。
 * ⑤ ★ **零删除**：见下面 `READBACK_KEEP` 那段 —— 这是本次唯一一处**偏离生产缺省**的地方，
 *    偏离方向是**少删**（保留窗口 10 → 30），且带**前置拒绝**与**事后断言**两道网。
 * ```
 *
 * 跑法：`pnpm exec tsx scripts/m9.5-semantic-index-readback.ts`
 */

import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { existsSync, readdirSync } from 'node:fs'

import { stringToUuid } from '../src/kernel/contracts/uuid.ts'





import { character } from '../src/character/index.ts'
import { allowProductionDatabase, initDatabase } from '../src/db/index.ts'
import { isProductionDir } from '../src/dev/sandbox.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { isSemanticMode } from '../src/kernel/contracts/recall.ts'
import { createVerifiedSnapshot } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  lastVerifiedSnapshotId,
  prepareProductionOpen,
  productionDataDirOf,
  productionSnapshotRootOf,
  type ProductionOpenDeps,
  type ProductionOpenHandle,
} from '../src/infrastructure/persistence/production-open-guard.ts'
import {
  closeDatabaseConnection,
  createRuntimeShutdown,
  isDatabaseClosed,
  stopRuntimeServices,
} from '../src/infrastructure/persistence/runtime-shutdown.ts'
import {
  currentSchemaVersion,
  exec,
  getRawDb,
  type RawDb,
} from '../src/infrastructure/persistence/db.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'

/*
 * ============================================================================
 *  ⚠️ 显式放行真实库 —— "只读"由下面那个 `rows()` 在构造上保证
 * ============================================================================
 * 与 `verify-m4-real-db.ts` 的注释同源：只调 `allowProductionDatabase()`
 * 而不加语句闸，等于把守卫关掉、换成一个注释里的承诺。
 */
allowProductionDatabase()

const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')

const realDataDir = productionDataDirOf()
const realSnapshotRoot = productionSnapshotRootOf()

/* ---------------------------------------------------------------------------
 * ★ 零删除（本次唯一一处偏离生产缺省的地方，方向是"少删"）
 * ---------------------------------------------------------------------------
 * 生产的 pre-open 快照用 `PRODUCTION_SNAPSHOT_KEEP`（= 10），而
 * `createVerifiedSnapshot()` 在**晋升成功之后**调 `pruneSnapshots(root, keep)`，
 * 它会把 `pglite-*` 目录按名字降序取 `slice(keep)` 之后的部分
 * **`rmSync(…, {recursive:true})` 真删掉**（`production-db-safety.ts:762-771`）。
 *
 * 实测：本机此刻恰好有 **10** 份已验证快照（目录 + 同名 `.manifest.json` 都在）
 * ⇒ 再来一份就是第 11 份 ⇒ 按缺省 `keep=10` 会删掉**最旧的那一份**。
 * 而 AGENTS §5.1 ③ 逐字写着「**删除旧快照 = 需要单独授权**」——
 * 本轮用户授权的只是"做一次只读读回"，**没有**授权删快照。
 *
 * ⇒ 因此本次把保留窗口抬到 30（保守方向：**多留**，不是少留；先例 =
 *   `pnpm inc-01:first-snapshot` 用 `--keep 30` 换"零删除"），并加两道网：
 *     ① **前置拒绝**：快照数 ≥ 30 就**不开库**（这样 prune 永远不可能触发）；
 *     ② **事后断言**：两次快照的 `prunedSnapshots` 必须都是空，否则本条判红。
 */
const READBACK_KEEP = 30

const guarded = process.env.PROJECT_LG_SANDBOX === undefined && isProductionDir(realDataDir)

/** 与 `pruneSnapshots()` 的候选定义**逐字一致**（目录 + `pglite-` 前缀） */
function snapshotDirs(): string[] {
  if (!existsSync(realSnapshotRoot)) return []
  return readdirSync(realSnapshotRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('pglite-'))
    .map((entry) => entry.name)
    .sort()
}

const snapshotsBefore = snapshotDirs()

console.log('='.repeat(74))
console.log('M9.5 语义索引「建没建」只读读回（真实库）')
console.log('='.repeat(74))
console.log(`  数据目录：${realDataDir}`)
console.log(`  快照根  ：${realSnapshotRoot}`)
console.log(
  `  开库前已验证快照：${String(snapshotsBefore.length)} 份 · 本次保留窗口 ${String(READBACK_KEEP)}（零删除）`
)

if (guarded && snapshotsBefore.length >= READBACK_KEEP) {
  console.error(
    `\n❌ 拒绝运行：已有 ${String(snapshotsBefore.length)} 份快照 ≥ 保留窗口 ${String(READBACK_KEEP)}，` +
      '本次开库会触发剪旧快照，而"删快照"需要单独授权。'
  )
  process.exit(1)
}

const failures: string[] = []
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (ok) {
    console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`)
  } else {
    console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`)
    failures.push(label)
  }
}

/*
 * ============================================================================
 *  ⚠️ `report()` —— **只报不判**（本次读回最容易写错的一处）
 * ============================================================================
 * 「索引建没建」是**被观测的答案**，不是**要守的性质**。把它写成 `check()` 的
 * 等号，就是 `verify-m4-real-db.ts:283-303` 逐字警告过的那个错：
 * **把一个偶然状态写成了契约** —— 那边的第一版断言"四张表都为空"，
 * 接线修好、真库出现记忆之后，那条断言立刻变红，而它红得**没有信息量**。
 *
 * 这里同理：如果真库里**真的**建好了索引（情形 a），断言 `published === 0`
 * 会让这份脚本**失败** —— 那等于"答案不对就报错"，而不是"读数如实地报出来"。
 * ⇒ 因此 C 组（索引内容）一律走 `report()`：进日志、不定生死。
 *    会进 `failures` 的只有**要守的性质**：配置解析契约（A）、
 *    schema 到位（B）、量尺非空（D）、零删除（Z）。
 */
function report(label: string, detail = ''): void {
  console.log(`  🔎 ${label}${detail ? `  — ${detail}` : ''}`)
}

/* ---------------------------------------------------------------------------
 * 装配（与 main.ts 同一组插件；不 import main.ts）
 * ------------------------------------------------------------------------- */
const runtime = createThinHostRuntime({
    character: character,
    settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
    conversationLength: 16,
  })

/** 两次快照实际删掉的快照名（必须是空） */
const prunedByThisRun: string[] = []
const snapshotDeps: NonNullable<ProductionOpenDeps['createSnapshot']> = async (input) => {
  const result = await createVerifiedSnapshot({
    sourceDir: realDataDir,
    snapshotRoot: realSnapshotRoot,
    lease: input.lease,
    keep: READBACK_KEEP,
  })
  if (result.prunedSnapshots !== undefined) prunedByThisRun.push(...result.prunedSnapshots)
  return result
}

let db: RawDb
let openHandle: ProductionOpenHandle | undefined

if (guarded) {
  openHandle = await prepareProductionOpen({
    dataDir: realDataDir,
    snapshotRoot: realSnapshotRoot,
    operationKind: 'real_db_verify',
    deps: {
      openDatabase: async () => {
        await initDatabase(runtime)
      },
      stopServices: () => stopRuntimeServices(runtime),
      closeDatabase: async () => await closeDatabaseConnection(runtime),
      isDatabaseClosed: () => isDatabaseClosed(runtime),
      lastVerifiedSnapshotId: () => lastVerifiedSnapshotId(realSnapshotRoot),
      /* ★ 零删除的那一处（见 READBACK_KEEP 段） */
      createSnapshot: snapshotDeps,
    },
  })
  await openHandle.open()
  console.log(
    `  生产状态机：${openHandle.reading.states.join(' → ')}` +
      `（pre-open 快照 ${openHandle.reading.preOpenSnapshotId ?? '未记录'}）`
  )
} else {
  await initDatabase(runtime)
  console.log('  ⚠️ 非生产目录（沙箱/副本）—— 未走生产状态机')
}

db = getRawDb(runtime)

/** 唯一执行口：**只允许 SELECT**（构造上的只读，不是约定） */
async function rows(sql: string): Promise<Record<string, unknown>[]> {
  const head = sql.trim().slice(0, 12).toLowerCase()
  if (!head.startsWith('select')) {
    throw new Error(
      `m9.5-semantic-index-readback 是**只读**脚本，拒绝执行非 SELECT 语句：${sql.slice(0, 120)}`
    )
  }
  return exec(db, sql, 'm9.5-semantic-index-readback')
}

function sqlLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function n(value: unknown): number {
  return Number(value ?? 0)
}

/* ===========================================================================
 * A. 配置读回（非机密）
 * ========================================================================= */
console.log('')
console.log('A. 配置读回（非机密；绝不打印凭据取值）')
const flags = readKernelFlags()
const envSemantic = process.env.CHARACTER_MEMORY_SEMANTIC_ENABLED
const envMode = process.env.CHARACTER_MEMORY_SEMANTIC_MODE

check(
  'A1 语义召回总开关：`.env` 的原始值与 flags 解析结果一致',
  (envSemantic === undefined ? false : ['1', 'true', 'yes', 'on'].includes(envSemantic.trim().toLowerCase())) ===
    flags.memorySemanticRecallEnabled,
  `CHARACTER_MEMORY_SEMANTIC_ENABLED=${envSemantic ?? '（未设）'} ⇒ flags=${String(flags.memorySemanticRecallEnabled)}`
)
/*
 * 断言的是**解析契约**（flags.ts:436-441 逐字）：
 *   未设 ⇒ `shadow`（先观察）· 合法值 ⇒ 原样 · **非法值 ⇒ `off`**（失败关闭）。
 * ⚠️ 期望值用**仓库自己的** `isSemanticMode()` 算（与 flags.ts 同一个谓词）——
 *    不在这里再抄一份词表，否则词表改了这份脚本会**假红**。
 */
const expectedMode: string =
  envMode === undefined ? 'shadow' : isSemanticMode(envMode) ? envMode : 'off'
check(
  'A2 模式解析符合契约（未设⇒shadow · 合法⇒原样 · 非法⇒off）',
  flags.memorySemanticMode === expectedMode,
  `CHARACTER_MEMORY_SEMANTIC_MODE=${envMode ?? '（未设）'} ⇒ flags=${flags.memorySemanticMode}（期望 ${expectedMode}）`
)
report(
  'A3 生效档位如实报出（本脚本**不改**它）',
  `enabled=${String(flags.memorySemanticRecallEnabled)} · mode=**${flags.memorySemanticMode}**` +
    `（${flags.memorySemanticMode === 'shadow' ? '观察：算分/记对照，**不**参与排序' : flags.memorySemanticMode === 'on' ? '生效：语义分数**参与**排序' : '关'}）`
)

/* ===========================================================================
 * B. 派生 schema（表建出来了没有）
 * ========================================================================= */
console.log('')
console.log('B. 派生 schema（M10 迁移 0010 之后应当已在）')
const schemaVersion = await currentSchemaVersion(db)
const migrationRows = await rows('select version from character_schema_migrations order by version')
const versions = migrationRows.map((row) => n(row.version))
check(
  'B1 kernel schema 版本 ≥ 10（迁移 0010 = 派生索引建表已应用）',
  schemaVersion >= 10,
  `version=${String(schemaVersion)} · 已应用=[${versions.join(',')}]`
)

const tableRows = await rows(
  "select table_name from information_schema.tables where table_schema = 'public'"
)
const presentTables = new Set(tableRows.map((row) => String(row.table_name)))
const SEMANTIC_TABLES = [
  'memory_semantic_meta',
  'memory_semantic_generations',
  'memory_semantic_index',
  'memory_semantic_failures',
] as const
for (const table of SEMANTIC_TABLES) {
  check(`B2 表 ${table} 存在`, presentTables.has(table))
}

/*
 * ⚠️ 只查"表在不在"不够 —— `memory_semantic_index.embedding` 是 `vector(384)`，
 *    它要求数据库**真的有向量类型**。若哪天 pgvector 不可用，建表会失败或退化成别的类型，
 *    而"表存在"这句仍然绿。所以这里查**列的类型**本身。
 */
const embeddingColumn = await rows(
  `select data_type, udt_name from information_schema.columns
   where table_schema = 'public' and table_name = 'memory_semantic_index' and column_name = 'embedding'`
)
const udt = String(embeddingColumn[0]?.udt_name ?? '')
check(
  'B3 向量列真的建成了向量类型（embedding = vector）',
  udt.toLowerCase() === 'vector',
  `udt_name=${udt === '' ? '（查不到该列）' : udt}`
)

const indexRows = await rows(`select indexname from pg_indexes where schemaname = 'public'`)
const indexNames = new Set(indexRows.map((row) => String(row.indexname)))
check('B4 复合索引 memory_semantic_index_scope 存在', indexNames.has('memory_semantic_index_scope'))

/* ===========================================================================
 * C. 索引内容（★ 本次的判定性读数）
 * ========================================================================= */
console.log('')
console.log('C. 索引内容（★ 判定"建没建"）')

const metaRows = await rows('select id, index_schema_version, updated_at from memory_semantic_meta')
report(
  'C1 `memory_semantic_meta` 版本登记行（0 行 ⇒ `ensureSemanticIndexSchema()` 从未在真库上跑过；' +
    '迁移 0010 **刻意不写**这一行）',
  `rows=${String(metaRows.length)}${metaRows.length > 0 ? ` · version=${String(metaRows[0]?.index_schema_version)}` : '（无登记行）'}`
)

const generationRows = await rows(
  'select build_state, count(*)::int as c from memory_semantic_generations group by build_state order by build_state'
)
const generationTotal = generationRows.reduce((sum, row) => sum + n(row.c), 0)
report(
  'C2 `memory_semantic_generations` 总行数（0 ⇒ 从没有过"代"）',
  `total=${String(generationTotal)}` +
    (generationRows.length > 0
      ? ` · ${generationRows.map((row) => `${String(row.build_state)}=${String(row.c)}`).join(' / ')}`
      : '')
)

/*
 * ★ 这一条是探针的实际入口条件：`semantic-probe.ts:184-186` 只认
 *   `namespace = <characterId> and build_state = 'published'`，0 个就 `not_indexed`。
 */
const publishedRows = await rows(
  `select generation_id, dimension, model_fingerprint from memory_semantic_generations
   where namespace = ${sqlLit(characterId)} and build_state = 'published' order by generation_id`
)
report(
  'C3 ★ **已发布**的代（namespace=角色）（0 ⇒ 探针每轮返回 `not_indexed`，观察档无对照可记）',
  `published=${String(publishedRows.length)}（namespace=${characterId}）`
)

const embeddingRows = await rows(
  `select count(*)::int as c from memory_semantic_index where namespace = ${sqlLit(characterId)}`
)
const embeddingTotal = n(embeddingRows[0]?.c)
report('C4 `memory_semantic_index` 向量行数（namespace=角色）', `rows=${String(embeddingTotal)}`)

const failureRows = await rows('select count(*)::int as c from memory_semantic_failures')
report('C5 `memory_semantic_failures` 行数', `rows=${String(n(failureRows[0]?.c))}`)

const wmRows = await rows(
  "select processor from processor_watermarks where processor like '%semantic%' order by processor"
)
report(
  'C6 语义相关的处理器水位（0 ⇒ 没有任何"语义索引"后台消费者）',
  `processors=[${wmRows.map((row) => String(row.processor)).join(', ')}]`
)

/* ===========================================================================
 * D. 量尺自检（§6.8：measured_count > 0 —— 证明这次确实量到了一个非空的产品）
 * ========================================================================= */
console.log('')
console.log('D. 量尺自检（这次量的东西本身不是空的）')
const memoryRows = await rows(
  "select count(*)::int as c from memory_records where status = 'active'"
)
const activeMemories = n(memoryRows[0]?.c)
check(
  'D1 真库有 active 记忆（> 0）—— 否则"索引为空"这句话没有意义',
  activeMemories > 0,
  `active 记忆=${String(activeMemories)}（若建索引，这是**最多**会覆盖的条数）`
)
const ledgerRows = await rows('select count(*)::int as c from conversation_events')
check('D2 真库有对话事件（> 0）', n(ledgerRows[0]?.c) > 0, `conversation_events=${String(n(ledgerRows[0]?.c))}`)

/* ===========================================================================
 * Z. 零删除自证
 * ========================================================================= */
console.log('')
console.log('Z. 零删除自证（AGENTS §5.1 ③：删旧快照需单独授权，本次没有）')
check(
  'Z1 本次两次快照**一份都没删**（`prunedSnapshots` 全空）',
  prunedByThisRun.length === 0,
  `pruned=[${prunedByThisRun.join(', ')}] · 保留窗口=${String(READBACK_KEEP)}`
)

/* ---------------------------------------------------------------------------
 * 分类结论
 * ------------------------------------------------------------------------- */
const classification =
  publishedRows.length > 0 && embeddingTotal > 0
    ? 'A · 索引**已建**（有已发布的代 + 向量）'
    : generationTotal > 0 || metaRows.length > 0
      ? 'B · 派生 schema 被"确保"过，但**没有可服务的已发布代**'
      : 'C · **从未建过索引**（表只由 M10 迁移 0010 建出：无版本登记行、无代、无向量）'

console.log('')
console.log('-'.repeat(74))
console.log(`分类结论：${classification}`)
console.log(
  publishedRows.length > 0 && embeddingTotal > 0
    ? '  ⇒ 观察档（shadow）**真的在算分**，只差把模式改成 `on` 那一步。'
    : '  ⇒ 探针每轮返回 `not_indexed`（连编码模型都不会加载）；`shadow` 分支只在**拿到分数**时才算对照\n' +
        '     （`memory-retrieval-store.ts:305-320`）⇒ **观察档目前没有任何对照被记下来**。'
)
console.log(
  `  上下文：真库 active 记忆 ${String(activeMemories)} 条；若要真建索引，需先有"建代 + 灌向量"的\n` +
    '  构建器（`ensureSemanticIndexSchema()` 只建表/登记版本，**不灌数据**）——那是 M9.5 那条线自己的事。'
)

/* ---------------------------------------------------------------------------
 * 收尾（唯一路径：stop → close → closed check → post-close 快照 → 释放租约）
 * ------------------------------------------------------------------------- */
await createRuntimeShutdown(runtime, {
  afterRun: async (reading) => {
    if (openHandle === undefined) return
    const result = await openHandle.finish({
      closed: reading.closed,
      detail: reading.note,
      afterClose: true,
    })
    console.log(
      `  生产状态机收尾：${result.states.join(' → ')}` +
        `（cleanClose=${String(result.cleanClose)}，post-close 快照 ${result.postCloseSnapshotId ?? '未记录'}）`
    )
  },
}).shutdown()

const snapshotsAfter = snapshotDirs()
check(
  'Z2 开库前后快照份数没有减少（本次只**新增**恢复点，不删）',
  snapshotsAfter.length >= snapshotsBefore.length,
  `${String(snapshotsBefore.length)} → ${String(snapshotsAfter.length)} 份`
)

console.log('')
console.log('='.repeat(74))
if (failures.length > 0) {
  console.log(`M9.5 语义索引只读读回：**${String(checks - failures.length)} / ${String(checks)} 通过**`)
  console.log('失败项：')
  for (const failure of failures) console.log(`  - ${failure}`)
  console.log(`\n分类结论：${classification}`)
  console.log('='.repeat(74))
  process.exit(1)
}
console.log(`M9.5 语义索引只读读回：${String(checks)} 项全部通过`)
console.log(`分类结论：${classification}`)
console.log('='.repeat(74))
