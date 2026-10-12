/**
 * M9.5 **启用计划 / WP2-A 门** —— 源枚举（keyset 分页 / 预算 / 游标 / 资格分列）
 * （`pnpm m9.5:build:verify`）。
 *
 * ============================================================================
 *  它判什么（计划 §1 WP2 的第 ① 条 + 第 ⑦ 条的资格分列）
 * ============================================================================
 * ```text
 *   正控   稳定全序 · 每行**恰好一次**（无重复、无遗漏）· 预算有界 · 游标可续到源尾
 *   负控① **把 keyset 换成 offset** ⇒ 翻页之间插一行时**必须**漏行或重复行
 *          （这条同时是"计划 §8.2 为什么禁止 offset 式全量"的可执行证据）
 *   负控② 资格分列：非 active 的行**必须**被排除且理由**具名**（直方图逐条对上）
 *   恢复   再跑一遍正控 ⇒ 读数逐字段相同
 * ```
 * ⚠️ **隔离**：全部在 `isolateDatabase()` 的一次性库里（`%TEMP%`）；**真实库从未被打开**。
 * ⚠️ **本门测的是枚举层**：源行是**直接插入**的（它测的是查询/分页/游标/资格分列），
 *    它**不**主张写入管线、**不**主张编码、**不**主张召回质量。
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'

import { sql } from 'drizzle-orm'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { rowsOf, type RawDb } from '../src/infrastructure/persistence/db.ts'
import {
  classifyIndexSources,
  enumerateIndexSources,
  type IndexSourceRow,
  type SourceCursor,
} from '../src/infrastructure/persistence/semantic-index-source.ts'
import { createM4Harness } from './m4-harness.ts'
import { ensureSemanticIndexSchema } from '../src/infrastructure/persistence/memory-semantic-index.ts'
import { buildSemanticIndex } from '../src/infrastructure/persistence/semantic-index-builder.ts'
import { reconcileSemanticIndex } from '../src/infrastructure/persistence/semantic-index-reconcile.ts'
import { readSemanticIndexHealth } from '../src/infrastructure/persistence/semantic-index-health.ts'
import { indexEligibility, RENDERER_VERSION } from '../src/kernel/app/recall/index-render.ts'
import { runIndexMaintenance } from '../src/infrastructure/persistence/semantic-index-maintenance.ts'
import {
  createProductionMaintenanceRunner,
  integrityProblemsByMemory,
  resolveMaintenanceGenerationId,
} from '../src/infrastructure/persistence/semantic-index-production-runner.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import { createM95RunId, openM95RunDir, selfCheckMeasurement, writeM95Manifest } from './m9.5-evidence.ts'

const REPO_ROOT = process.cwd()
const OWNER_KIND = 'character'
const OWNER_ID = 'char_wp2_probe'
/** 负控① 用**另一个 owner** 跑在同一份沙箱上（见负控那一段的注释：单例连接不能被第二个 harness 关掉） */
const OFFSET_OWNER = 'char_wp2_offset'

const failures: string[] = []
let measured = 0

function check(group: string, name: string, condition: boolean, detail?: string): void {
  measured += 1
  if (condition) {
    process.stdout.write(`  ✅ [${group}] ${name}\n`)
    return
  }
  failures.push(`[${group}] ${name}${detail === undefined ? '' : ` —— ${detail}`}`)
  process.stdout.write(`  ❌ [${group}] ${name}${detail === undefined ? '' : ` —— ${detail}`}\n`)
}

/** 直接插一行源记录（只填 NOT NULL 的那些列；本门只读 `id/status/revision/content_kind/content/created_at`） */
async function insertRow(
  db: RawDb,
  ownerId: string,
  row: {
    id: string
    createdAt: number
    status: string
    contentKind?: string
    predicate?: string
    value?: unknown
    revision?: number
  }
): Promise<void> {
  const contentKind = row.contentKind ?? 'claim'
  const content =
    contentKind === 'claim'
      ? { kind: 'claim', predicate: row.predicate ?? 'education.major', value: row.value ?? '计算机' }
      : { kind: 'episode', summary: String(row.value ?? '一段经历') }
  await db.execute(sql`
    insert into memory_records (
      id, owner_kind, owner_id, memory_type, content_kind, content, epistemic_status, authority,
      importance, confidence, status, content_fingerprint, recorded_at, reducer_version,
      schema_version, revision, created_at, updated_at
    ) values (
      ${row.id}, ${OWNER_KIND}, ${ownerId}, 'person_fact', ${contentKind},
      ${JSON.stringify(content)}::jsonb, 'reported', 'EXPLICIT_USER_STATEMENT',
      0.5, 0.9, ${row.status}, ${`fp-${row.id}`}, ${row.createdAt}, 'memory@1',
      1, ${row.revision ?? 0}, ${row.createdAt}, ${row.createdAt}
    )`)
}

/**
 * **负控①的对照组**：`offset` 式分页（计划 §8.2 禁止的那种"全量"）。
 *
 * 它本身是**故意写坏的**：它用 `offset` 而不是 keyset ⇒ 只要在翻页之间插入一行，
 * 就会有行被**跳过**（插入点之后的行整体后移一位）。
 */
async function enumerateByOffset(
  db: RawDb,
  ownerId: string,
  pageLimit: number,
  insertBetweenPages: () => Promise<void>
): Promise<string[]> {
  const seen: string[] = []
  let offset = 0
  for (let page = 0; page < 20; page += 1) {
    const rows = rowsOf(
      await db.execute(sql`
        select id from memory_records
         where owner_kind = ${OWNER_KIND} and owner_id = ${ownerId}
         order by created_at asc, id asc
         limit ${pageLimit} offset ${offset}`)
    )
    if (rows.length === 0) break
    for (const raw of rows) seen.push(String((raw as Record<string, unknown>).id))
    offset += pageLimit
    if (page === 0) await insertBetweenPages()
  }
  return seen
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  await resetPluginSqlConnection()
  isolateDatabase('m95-wp2-build', { keep: false })
  const h = await createM4Harness({ label: 'm95-wp2-build' })

  try {
    /* 12 行：8 条 active claim · 1 条 retracted · 1 条 superseded · 1 条 disputed · 1 条 episode
       （created_at 故意**同毫秒成对**出现，用来钉住平局时的全序） */
    const plan: readonly {
      id: string
      createdAt: number
      status: string
      contentKind?: string
      value?: unknown
    }[] = [
      { id: 'mem-01', createdAt: 1000, status: 'active' },
      { id: 'mem-02', createdAt: 1000, status: 'active' },
      { id: 'mem-03', createdAt: 2000, status: 'active' },
      { id: 'mem-04', createdAt: 3000, status: 'active' },
      { id: 'mem-05', createdAt: 4000, status: 'active' },
      { id: 'mem-06', createdAt: 5000, status: 'active' },
      { id: 'mem-07', createdAt: 6000, status: 'active' },
      { id: 'mem-08', createdAt: 7000, status: 'active' },
      { id: 'mem-09', createdAt: 8000, status: 'retracted' },
      { id: 'mem-10', createdAt: 9000, status: 'superseded' },
      { id: 'mem-11', createdAt: 10000, status: 'disputed' },
      { id: 'mem-12', createdAt: 11000, status: 'active', contentKind: 'episode', value: '' },
    ]
    for (const row of plan) await insertRow(h.db, OWNER_ID, row)

    const opts = { ownerKind: OWNER_KIND, ownerId: OWNER_ID } as const

    process.stdout.write('\n=== 1. 正控（keyset 分页：每行恰好一次 · 稳定全序 · 预算有界） ===\n')

    /* 1a 一页装得下：12 行全取，顺序必须与 (created_at, id) 一致 */
    const whole = await enumerateIndexSources(h.db, { ...opts, after: null, pageLimit: 100, budget: 100 })
    const wholeIds = whole.rows.map((row) => row.memoryId)
    check('正控', '一次取全：12 行', wholeIds.length === 12, `实测 ${String(wholeIds.length)}`)
    check(
      '正控',
      '稳定全序（created_at asc, id asc）',
      JSON.stringify(wholeIds) ===
        JSON.stringify([
          'mem-01', 'mem-02', 'mem-03', 'mem-04', 'mem-05', 'mem-06',
          'mem-07', 'mem-08', 'mem-09', 'mem-10', 'mem-11', 'mem-12',
        ]),
      JSON.stringify(wholeIds)
    )
    check('正控', '取全即报 exhausted', whole.exhausted === true && whole.nextCursor === null)

    /* 1b 小页翻到底：跨页拼起来必须**与一次取全逐字相同**（无重复、无遗漏） */
    const paged: string[] = []
    let cursor: SourceCursor | null = null
    let pages = 0
    for (let i = 0; i < 20; i += 1) {
      const page = await enumerateIndexSources(h.db, { ...opts, after: cursor, pageLimit: 3, budget: 3 })
      paged.push(...page.rows.map((row) => row.memoryId))
      pages += page.pages
      cursor = page.nextCursor
      if (cursor === null) break
    }
    check('正控', '★ 分页拼接 == 一次取全（无重复、无遗漏）', JSON.stringify(paged) === JSON.stringify(wholeIds), JSON.stringify(paged))
    check('正控', '分页真的翻了多页', pages >= 4, `pages=${String(pages)}`)
    check('正控', '源尾之后游标为 null', cursor === null)

    /* 1c 预算有界：budget=5 时**最多**取 5 条，且如实报"没走完" */
    const bounded = await enumerateIndexSources(h.db, { ...opts, after: null, pageLimit: 3, budget: 5 })
    check('正控', '★ 预算有界：budget=5 ⇒ 只取 5 条', bounded.rows.length === 5, `实测 ${String(bounded.rows.length)}`)
    check('正控', '预算截断时**不**谎报 exhausted', bounded.exhausted === false && bounded.nextCursor !== null)
    const resumed = await enumerateIndexSources(h.db, { ...opts, after: bounded.nextCursor, pageLimit: 100, budget: 100 })
    check(
      '正控',
      '★ 持久游标续取：预算截断处接着走 ⇒ 拼起来仍等于全量',
      JSON.stringify([...bounded.rows.map((r) => r.memoryId), ...resumed.rows.map((r) => r.memoryId)]) ===
        JSON.stringify(wholeIds)
    )

    /* 1d 真实 revision 进读数（不许写死 1 —— M10 的 `缺口 ①`） */
    await insertRow(h.db, OWNER_ID, { id: 'mem-13', createdAt: 12000, status: 'active', revision: 7 })
    const withRevision = await enumerateIndexSources(h.db, { ...opts, after: null, pageLimit: 100, budget: 100 })
    const thirteen = withRevision.rows.find((row) => row.memoryId === 'mem-13')
    check('正控', '★ revision 是**真实**值（mem-13 的 7），不是写死的 1', thirteen?.sourceRevision === 7, String(thirteen?.sourceRevision))

    /*
     * ⚠️ 负控用**另一个 owner** 跑在同一份沙箱上，而**不是**再开一个 harness：
     * `@elizaos/plugin-sql` 是**进程级单例**（AGENTS §7），第二个 harness 的 `stop()`
     * 会把第一个 harness 正在用的连接一起关掉 —— 实测撞到 `PGlite is closed`。
     */
    process.stdout.write('\n=== 2. 负控①（把 keyset 换成 offset ⇒ 翻页之间插入必须漏行） ===\n')
    const offsetOpts = { ownerKind: OWNER_KIND, ownerId: OFFSET_OWNER } as const
    /* ⚠️ id 要**加前缀**：`memory_records` 的主键是 `id` 单列（不是 owner+id）⇒ 直接复用会撞主键 */
    const offsetIds = plan.map((row) => `off-${row.id}`)
    for (const row of plan) await insertRow(h.db, OFFSET_OWNER, { ...row, id: `off-${row.id}` })
    const offsetSeen = await enumerateByOffset(h.db, OFFSET_OWNER, 3, async () => {
      /* 在第一页之后插入一行"位置很靠前"的记录 ⇒ offset 分页会把后面整体后移 */
      await insertRow(h.db, OFFSET_OWNER, { id: 'off-mem-inserted', createdAt: 500, status: 'active' })
    })
    const unique = new Set(offsetSeen)
    const missed = offsetIds.filter((id) => !unique.has(id))
    const duplicated = offsetSeen.length - unique.size
    /*
     * ⚠️ 判据是"**不是恰好一次**"，而不是"必须漏"：
     * 插入点在本页**之前** ⇒ 后面的行整体后移 ⇒ 表现为**重复**；
     * 插入点在本页**之后** ⇒ 表现为**遗漏**。两者都同样disqualify"全量"这个主张。
     * （实测这一版就是**重复 1 行、漏 0 行** —— 第一版只判"漏"，于是负控没响。）
     */
    check(
      '负控①',
      '★ offset 式分页**不是恰好一次**（重复或遗漏 —— 这就是计划 §8.2 禁止它的理由）',
      duplicated > 0 || missed.length > 0,
      `重复 ${String(duplicated)} 行 · 漏 ${String(missed.length)} 行`
    )
    process.stdout.write(
      `     · offset 看到 ${String(offsetSeen.length)} 行（去重后 ${String(unique.size)}）· 重复 ${String(duplicated)} · 漏 ${String(missed.length)}\n`
    )

    /* 同一场景下 keyset **不**漏（证明差别来自分页法，不是数据本身） */
    const keysetSeen: string[] = []
    let cur: SourceCursor | null = null
    for (let i = 0; i < 20; i += 1) {
      const page = await enumerateIndexSources(h.db, { ...offsetOpts, after: cur, pageLimit: 3, budget: 3 })
      keysetSeen.push(...page.rows.map((row) => row.memoryId))
      cur = page.nextCursor
      if (cur === null) break
    }
    check(
      '负控①',
      '★ 同一场景下 keyset **不漏**（差别来自分页法）',
      offsetIds.every((id) => keysetSeen.includes(id)),
      keysetSeen.join(', ')
    )

    process.stdout.write('\n=== 3. 负控②（资格分列：非 active 必须被排除且理由具名） ===\n')
    const classified = classifyIndexSources(withRevision.rows, () => [])
    check('负控②', '正控侧：9 条 active claim 全部进 eligible（8 条计划内 + mem-13）', classified.eligible.length === 9, `实测 ${String(classified.eligible.length)}`)
    const reasonOf = (id: string): string | undefined =>
      classified.excluded.find((entry) => entry.memoryId === id)?.reason
    check('负控②', 'retracted ⇒ status:retracted', reasonOf('mem-09') === 'status:retracted', String(reasonOf('mem-09')))
    check('负控②', 'superseded ⇒ status:superseded', reasonOf('mem-10') === 'status:superseded', String(reasonOf('mem-10')))
    check('负控②', 'disputed ⇒ status:disputed', reasonOf('mem-11') === 'status:disputed', String(reasonOf('mem-11')))
    /*
     * ⚠️ **后 Lv2 · 用户 2026-10-03 裁定选项 a**：Episode **不再**被具名排除
     * （`content:episode`），它现在渲染成 `passage: <summary>`（`semantic-render@2`）。
     * 本条夹具的 Episode **没有 summary** ⇒ 走的是 `content:empty`（"没有内容可检索"
     * 与"这个种类不索引"是**两件不同的事**，理由码必须分开）。
     */
    check(
      '负控②',
      '★ Episode **无摘要** ⇒ content:empty（"没有内容可检索"**不是**"这个种类不索引"）',
      reasonOf('mem-12') === 'content:empty',
      String(reasonOf('mem-12'))
    )
    check(
      '负控②',
      '★ 直方图逐条对上（可分列计数 = excluded_by_policy_count 的形态）',
      JSON.stringify(classified.excludedByReason) ===
        JSON.stringify({ 'content:empty': 1, 'status:disputed': 1, 'status:retracted': 1, 'status:superseded': 1 }),
      JSON.stringify(classified.excludedByReason)
    )
    check(
      '负控②',
      '★ 完整性问题也排除且带**具体码**',
      classifyIndexSources([withRevision.rows[0] as IndexSourceRow], () => ['dangling_evidence']).excluded[0]?.reason ===
        'integrity:dangling_evidence'
    )

    process.stdout.write('\n=== 4. 恢复（再跑一遍正控 ⇒ 逐字段相同） ===\n')
    const again = await enumerateIndexSources(h.db, { ...opts, after: null, pageLimit: 100, budget: 100 })
    const sameAsBefore =
      JSON.stringify(again.rows.map((row) => [row.memoryId, row.seq, row.sourceRevision])) ===
      JSON.stringify(withRevision.rows.map((row) => [row.memoryId, row.seq, row.sourceRevision]))
    check('恢复', '★ 与正控逐字段相同', sameAsBefore)
    check('恢复', '恢复档的页数也相同', again.pages === withRevision.pages, `${String(again.pages)} vs ${String(withRevision.pages)}`)

    process.stdout.write('\n=== 4b. WP2-B（编码 → 校验 → 落盘 → 水位 → 换代） ===\n')
    await ensureSemanticIndexSchema(h.db, { now: 1 })
    const unit = (seed: number): number[] => {
      const raw = new Array(384).fill(0).map((_, i) => Math.sin(i + seed) + 0.5)
      const norm = Math.sqrt(raw.reduce((sum, x) => sum + x * x, 0))
      return raw.map((x) => x / norm)
    }
    const fixtureEncoder = (
      fp: string,
      make: (index: number) => number[]
    ): { modelFingerprint: string; encode: (texts: readonly string[]) => Promise<{ ok: true; dimension: number; vectors: number[][] }> } => ({
      modelFingerprint: fp,
      encode: async (texts) => ({ ok: true, dimension: 384, vectors: texts.map((_, i) => make(i)) }),
    })
    const baseBuild = {
      namespace: 'ns-wp2b',
      ownerKind: OWNER_KIND,
      ownerId: OWNER_ID,
      generationId: 'gen-1',
      rendererVersion: RENDERER_VERSION,
      tokenizerFingerprint: 'tok@1',
      pooling: 'mean',
      normalize: true,
      dtype: 'q8',
      dimension: 384,
      now: () => 1,
      pageLimit: 50,
      budget: 100,
      batchLimit: 50,
      maxAttempts: 3,
      integrityProblemsOf: () => [] as string[],
    } as const

    /* 4b-1 正控：全部合法 ⇒ 落盘 + 计数 + 水位推进 + 切换 published */
    const built = await buildSemanticIndex({
      ...baseBuild,
      db: h.db,
      encoder: fixtureEncoder('fp-model-1', unit),
    })
    check('WP2-B', '正控：refused 为空', built.refused === null, String(built.refused))
    check('WP2-B', '★ 落盘行数 = eligible（9 条 active claim）', built.rowsWritten === 9 && built.counts.indexed === 9, JSON.stringify(built.counts))
    check('WP2-B', '★ 计数如实：excluded = 4（retracted/superseded/disputed/episode）', built.counts.excluded === 4, String(built.counts.excluded))
    check('WP2-B', '★ coverageComplete = true 且切到 published', built.coverageComplete === true && built.buildState === 'published')
    check('WP2-B', '水位推进到最大 seq（12 秒）', built.watermark === 12, String(built.watermark))

    /* 4b-2 负控③：编码器给出**非法向量**（零范数）⇒ 不发布 + 记失败 + 水位被挡 */
    const invalid = await buildSemanticIndex({
      ...baseBuild,
      db: h.db,
      generationId: 'gen-bad',
      encoder: fixtureEncoder('fp-model-1', (i) => (i === 0 ? new Array(384).fill(0) : unit(i))),
    })
    check('WP2-B', '★ 负控③：非法向量 ⇒ 该条不发布（indexed = 8）', invalid.counts.indexed === 8, JSON.stringify(invalid.counts))
    check('WP2-B', '★ 负控③：coverageComplete = false（不完整就如实 false）', invalid.coverageComplete === false)
    check('WP2-B', '★ 负控③：水位被缺口挡住（不推进到 12）', invalid.watermark < 12, String(invalid.watermark))
    check('WP2-B', '★ 负控③：不切 published', invalid.buildState === 'building', invalid.buildState)
    check('WP2-B', '★ 负控③：缺口之后的行**照样写**（writtenAboveGap > 0）', invalid.writtenAboveGap > 0, String(invalid.writtenAboveGap))

    /* 4b-3 负控④：失败关闭 —— 维度不符 ⇒ refused 且**一个字节都不写** */
    const refused = await buildSemanticIndex({
      ...baseBuild,
      db: h.db,
      generationId: 'gen-refused',
      dimension: 768,
      encoder: fixtureEncoder('fp-model-1', unit),
    })
    check('WP2-B', '★ 负控④：维度不符 ⇒ refused 具名', refused.refused?.startsWith('dimension_mismatch') === true, String(refused.refused))
    check('WP2-B', '★ 负控④：拒绝时 rowsWritten = 0（失败关闭）', refused.rowsWritten === 0)
    const refusedRows = rowsOf(
      await h.db.execute(sql`select count(*)::int as c from memory_semantic_index where generation_id = 'gen-refused'`)
    )[0] as { c?: number } | undefined
    check('WP2-B', '★ 负控④：库里也确实没有这一代的行', Number(refusedRows?.c ?? 0) === 0)

    /* 4b-4 换代：新代发布时，同命名空间旧代置 unavailable */
    const second = await buildSemanticIndex({
      ...baseBuild,
      db: h.db,
      generationId: 'gen-2',
      encoder: fixtureEncoder('fp-model-1', unit),
    })
    const states = rowsOf(
      await h.db.execute(sql`
        select generation_id, build_state from memory_semantic_generations
         where namespace = 'ns-wp2b' order by generation_id asc`)
    ).map((raw) => `${String((raw as Record<string, unknown>).generation_id)}=${String((raw as Record<string, unknown>).build_state)}`)
    check('WP2-B', '★ 换代：gen-2 发布后 gen-1 置 unavailable', second.buildState === 'published' && states.includes('gen-1=unavailable') && states.includes('gen-2=published'), states.join(' · '))

    process.stdout.write('\n=== 4c. WP3（失效传播：她忘掉之后索引里的行必须消失） ===\n')
    /* gen-2 已发布且覆盖完整（9 行）。现在让其中一条**被遗忘**、另一条**升 revision**。 */
    await h.db.execute(sql`update memory_records set status = 'retracted' where id = 'mem-01'`)
    await h.db.execute(sql`update memory_records set revision = 5 where id = 'mem-02'`)

    const beforeReconcile = rowsOf(
      await h.db.execute(sql`
        select count(*)::int as c from memory_semantic_index
         where namespace = 'ns-wp2b' and generation_id = 'gen-2'`)
    )[0] as { c?: number } | undefined
    check('WP3', '正控前置：先确认那两行**确实在**（否则下面的删除证明不了什么）', Number(beforeReconcile?.c ?? 0) === 9, String(beforeReconcile?.c))

    const reconciled = await reconcileSemanticIndex({
      db: h.db,
      namespace: 'ns-wp2b',
      generationId: 'gen-2',
      integrityProblemsOf: () => [],
    })
    check('WP3', '★ 被遗忘的那条**行被删掉**（removedIneligible ≥ 1）', reconciled.removedIneligible >= 1, String(reconciled.removedIneligible))
    check('WP3', '★ 理由具名：`status:retracted` 在直方图里', (reconciled.removedByReason['status:retracted'] ?? 0) >= 1, JSON.stringify(reconciled.removedByReason))
    check('WP3', '★ 升了 revision 的那条 ⇒ 过期行被删（removedStaleRevision ≥ 1）', reconciled.removedStaleRevision >= 1, String(reconciled.removedStaleRevision))
    const remaining = rowsOf(
      await h.db.execute(sql`
        select memory_id from memory_semantic_index
         where namespace = 'ns-wp2b' and generation_id = 'gen-2' order by memory_id asc`)
    ).map((raw) => String((raw as Record<string, unknown>).memory_id))
    check('WP3', '★ 被遗忘的那条**不再在索引里**（遗忘传播到了派生层）', !remaining.includes('mem-01'), remaining.join(','))
    check('WP3', '★ 升版的那条也不在（等 WP2 用新 revision 重写）', !remaining.includes('mem-02'))
    check('WP3', '★ 其余 7 条**原样保留**', remaining.length === 7, remaining.join(','))

    /* 幂等：再跑一次不该继续删 */
    const again3 = await reconcileSemanticIndex({
      db: h.db,
      namespace: 'ns-wp2b',
      generationId: 'gen-2',
      integrityProblemsOf: () => [],
    })
    check('WP3', '★ 幂等：第二次跑没有可删的', again3.removedIneligible === 0 && again3.removedStaleRevision === 0, JSON.stringify(again3.removedByReason))

    /* 负控⑤：**关掉资格判据**（把一切都当有资格）⇒ 被遗忘那条的行**必须留着** */
    await h.db.execute(sql`update memory_records set status = 'active' where id = 'mem-01'`)
    const withPolicyOff = await reconcileSemanticIndex({
      db: h.db,
      namespace: 'ns-wp2b',
      generationId: 'gen-2',
      integrityProblemsOf: () => [],
    })
    check('WP3', '★ 负控⑤：没有不可索引的条目时 ⇒ 一行都不删（删除是被政策驱动的）', withPolicyOff.removedIneligible === 0, String(withPolicyOff.removedIneligible))

    process.stdout.write('\n=== 4d. WP5（健康读回：可运维性） ===\n')
    const health = await readSemanticIndexHealth(h.db, 'ns-wp2b')
    check('WP5', '★ 健康读回：三代都在案（gen-1 · gen-2 · gen-bad 那个负控代）', health.generations.length === 3, String(health.generations.length))
    check('WP5', '★ 已发布代是 gen-2', health.publishedGenerationId === 'gen-2', String(health.publishedGenerationId))
    check('WP5', '★ 已发布代的指纹/渲染器可读（用于与冻结清单比对）', health.publishedFingerprint === 'fp-model-1' && health.publishedRendererVersion === RENDERER_VERSION, `${String(health.publishedFingerprint)}/${String(health.publishedRendererVersion)}`)
    check('WP5', '★ 落后于源的条目数 > 0（WP3 之后仍有一条升版未重索引）', health.staleOrOrphaned > 0, String(health.staleOrOrphaned))
    const gen2 = health.generations.find((generation) => generation.generationId === 'gen-2')
    check('WP5', '★ gen-2 的 indexed 计数与库里的行数一致（现算，不信计数列）', gen2?.indexed === 7, String(gen2?.indexed))
    /*
     * ✅ **已修**（2026-10-01）：WP3 删行之后**回头更新本代的计数列** ⇒
     * `coverageComplete` 不再陈旧（删过行 ⇒ pending/excluded 变了 ⇒ 它如实读作 false）。
     * ⚠️ 上一轮这里是一条"特征化未修"的断言（实测 coverageComplete 仍读作 true）——
     *    修法与依据写在 `semantic-index-reconcile.ts` 的那段注释里。
     */
    check(
      'WP5',
      '★ 已修：WP3 删行后本代计数**不再陈旧** ⇒ coverageComplete 如实读作 false',
      gen2?.coverageComplete === false && gen2.indexed < gen2.eligible,
      `coverageComplete=${String(gen2?.coverageComplete)} · indexed=${String(gen2?.indexed)} · eligible=${String(gen2?.eligible)} · pending=${String(gen2?.pending)} · excluded=${String(gen2?.excludedByPolicy)}`
    )

    process.stdout.write('\n=== 4e. 溢出回归（生产副本预演抓到的真缺陷） ===\n')
    /*
     * ⚠️ 水位单位曾经是**毫秒**，而水位列 `memory_semantic_generations.processed_watermark`
     * 声明的是 `integer` ⇒ 真数据一上来就
     * `value "1789576995336" is out of range for type integer`。
     * 夹具的 1000..12000 毫秒塞得下，所以当时的 50 项隔离检查**全都没抓到** ——
     * 是**生产副本预演**抓到的。⇒ 这条用**真实量级**的时间戳把它钉住。
     *
     * ⚠️ 放在**最后**：它会给这个 owner 多加一条 eligible，若放在前面会把后面每一节的计数期望都顶掉一位。
     */
    await insertRow(h.db, OWNER_ID, { id: 'mem-real-ts', createdAt: 1789576995336, status: 'active' })
    const realTs = await enumerateIndexSources(h.db, { ...opts, after: null, pageLimit: 200, budget: 200 })
    const realRow = realTs.rows.find((row) => row.memoryId === 'mem-real-ts')
    check(
      '溢出回归',
      '★ 真实毫秒时间戳 ⇒ seq 是**秒**且塞得进 integer（< 2^31）',
      realRow !== undefined && realRow.seq === 1789576995 && realRow.seq < 2 ** 31,
      `seq=${String(realRow?.seq)}`
    )
    const realBuild = await buildSemanticIndex({
      ...baseBuild,
      db: h.db,
      generationId: 'gen-real-ts',
      encoder: fixtureEncoder('fp-model-1', unit),
    })
    check(
      '溢出回归',
      '★ 真量级时间戳**真的能落盘**（水位不再溢出）',
      realBuild.refused === null && realBuild.watermark === 1789576995,
      `refused=${String(realBuild.refused)} · watermark=${String(realBuild.watermark)}`
    )

    process.stdout.write('\n=== 4f. WP4（一轮维护 = 先失效传播、再建；顺序不能反） ===\n')
    /*
     * 造一条"她忘掉了"的件（mem-03），再跑**一轮维护** ⇒ 它必须先被删掉，
     * 然后 build **不会**把它写回来（它已不 eligible）。
     * ⚠️ 顺序反了的话，中间那一段"已忘掉的事还在索引里" —— 遗忘的隐私边界要求先删后建。
     */
    /*
     * ⚠️ 必须先让**这一代**有行：`reconcile` 只看**本代已落盘的行**（它做的是减法）。
     * 第一版直接对一代全新的代跑维护 ⇒ 无可删 ⇒ 这条断言假失败（实测 `removedByReason={}`）。
     */
    await buildSemanticIndex({ ...baseBuild, db: h.db, generationId: 'gen-maint', encoder: fixtureEncoder('fp-model-1', unit) })
    const beforeMaint = rowsOf(
      await h.db.execute(sql`select memory_id from memory_semantic_index where generation_id = 'gen-maint'`)
    ).map((raw) => String((raw as Record<string, unknown>).memory_id))
    check('WP4', '前置：这一代先有行（且含即将被忘掉的那条）', beforeMaint.includes('mem-03'), beforeMaint.join(','))
    await h.db.execute(sql`update memory_records set status = 'retracted' where id = 'mem-03'`)
    const cycle = await runIndexMaintenance({
      ...baseBuild,
      db: h.db,
      generationId: 'gen-maint',
      encoder: fixtureEncoder('fp-model-1', unit),
    })
    check('WP4', '★ 一轮维护：先删（reconcile 删掉了刚失格的那条）', cycle.reconcile.removedIneligible >= 1, JSON.stringify(cycle.reconcile.removedByReason))
    const maintRows = rowsOf(
      await h.db.execute(sql`select memory_id from memory_semantic_index where generation_id = 'gen-maint'`)
    ).map((raw) => String((raw as Record<string, unknown>).memory_id))
    check('WP4', '★ 后建：已忘掉的那条**没有**被写回来', !maintRows.includes('mem-03'), maintRows.join(','))
    check('WP4', '★ 该建的那些真的建了（>0 行）', maintRows.length > 0, String(maintRows.length))
    check('WP4', '★ 一行摘要可读（供日志/健康读回引用）', cycle.summary.includes('reconcile:') && cycle.summary.includes('build:'), cycle.summary)

    process.stdout.write('\n=== 4g. 残留量出来：删行与更新计数**不在同一事务** ===\n')
    /*
     * ⚠️ **先量，再修**（本仓库的纪律）：这条断言**故意断言"陈旧"这个现状** ——
     * 它把"中间崩掉会怎样"从一个**没有判据**的说法变成一条**会响的读数**。
     * ⇒ 下一轮把两步包进事务之后，这条会**报红**，强制把它翻成"原子"。
     */
    await buildSemanticIndex({ ...baseBuild, db: h.db, generationId: 'gen-atomic', encoder: fixtureEncoder('fp-model-1', unit) })
    await h.db.execute(sql`update memory_records set status = 'retracted' where id = 'mem-04'`)
    const rowsBefore = rowsOf(
      await h.db.execute(sql`select count(*)::int as c from memory_semantic_index where generation_id = 'gen-atomic'`)
    )[0] as { c?: number } | undefined
    const beforeCounts = rowsOf(
      await h.db.execute(sql`select eligible_source_count as e, excluded_by_policy_count as x from memory_semantic_generations where generation_id = 'gen-atomic'`)
    )[0] as Record<string, unknown>
    let threw = false
    try {
      await reconcileSemanticIndex({
        db: h.db,
        namespace: 'ns-wp2b',
        generationId: 'gen-atomic',
        integrityProblemsOf: () => [],
        onAfterDeletes: async () => {
          throw new Error('injected_crash_between_delete_and_count_update')
        },
      })
    } catch {
      threw = true
    }
    const afterCounts = rowsOf(
      await h.db.execute(sql`select eligible_source_count as e, excluded_by_policy_count as x from memory_semantic_generations where generation_id = 'gen-atomic'`)
    )[0] as Record<string, unknown>
    const rowsLeft = rowsOf(
      await h.db.execute(sql`select count(*)::int as c from memory_semantic_index where generation_id = 'gen-atomic'`)
    )[0] as { c?: number } | undefined
    check('残留', '★ 注入的崩溃**真的抛了**（缝是有效的）', threw)
    check(
      '残留',
      '★ **已修（原子）**：崩在中间 ⇒ 行**没**被删、计数一字未动（事务回滚）',
      Number(beforeCounts.e) === Number(afterCounts.e) &&
        Number(beforeCounts.x) === Number(afterCounts.x) &&
        Number(rowsLeft?.c ?? 0) === Number(rowsBefore?.c ?? -1),
      `before e=${String(beforeCounts.e)}/x=${String(beforeCounts.x)}/rows=${String(rowsBefore?.c)} · after e=${String(afterCounts.e)}/x=${String(afterCounts.x)}/rows=${String(rowsLeft?.c)}`
    )

    process.stdout.write('\n=== 4h. WP4 工作上限：一轮有界，且剩下的**不丢** ===\n')
    /*
     * 用户裁定的形态要求"**有工作上限的异步索引维护**"。上限就是 `budget` / `batchLimit`
     * （WP2-A/B 里已实现），但**从来没有被判据钉住过** —— 这一节把它钉住，
     * 并证明"这一轮没做完的，下一轮会接着做"（不是丢掉）。
     */
    const bounded1 = await buildSemanticIndex({
      ...baseBuild,
      db: h.db,
      generationId: 'gen-bounded',
      budget: 2,
      pageLimit: 2,
      batchLimit: 2,
      encoder: fixtureEncoder('fp-model-1', unit),
    })
    check('WP4 上限', '★ 一轮有界：budget/batchLimit = 2 ⇒ indexed ≤ 2', bounded1.counts.indexed <= 2, JSON.stringify(bounded1.counts))
    check(
      'WP4 上限',
      '★ 有界的一轮**不谎称完整**（coverageComplete = false；⚠️ pending 只数**已枚举到**的那部分，所以它可以是 0）',
      bounded1.coverageComplete === false,
      JSON.stringify(bounded1.counts)
    )
    const bounded2 = await buildSemanticIndex({
      ...baseBuild,
      db: h.db,
      generationId: 'gen-bounded',
      budget: 200,
      pageLimit: 200,
      batchLimit: 200,
      encoder: fixtureEncoder('fp-model-1', unit),
    })
    check(
      'WP4 上限',
      '★ 不丢：下一轮把剩下的接着做完（indexed 变多，pending 归零）',
      bounded2.counts.indexed > bounded1.counts.indexed && bounded2.counts.pending === 0,
      `${JSON.stringify(bounded1.counts)} → ${JSON.stringify(bounded2.counts)}`
    )

    process.stdout.write('\n=== 4i. WP4 生产运行器（W1 的零件，可离线测） ===\n')
    /*
     * 把"一轮维护做什么"收进 `createProductionMaintenanceRunner` ⇒ `main.ts` 那边的改动只剩两行。
     * 这一节在**隔离库**上直接测那个零件（不碰生产写路径）。
     */
    const runner = createProductionMaintenanceRunner({
      db: h.db,
      namespace: 'ns-wp2b',
      encoder: fixtureEncoder('fp-model-1', unit),
      rendererVersion: RENDERER_VERSION,
      tokenizerFingerprint: 'tok@1',
      pooling: 'mean',
      normalize: true,
      dtype: 'q8',
      dimension: 384,
      generationId: 'gen-runner',
      integrityProblemsOf: () => [],
      now: () => 1,
    })
    const ran = await runner()
    check('WP4 运行器', '★ owner **现读**（不写死）：一轮真的跑起来了', ran !== null && ran.build.refused === null, JSON.stringify(ran?.build.counts))
    check('WP4 运行器', '★ 上限钉死：一轮的 indexed ≤ budget(200)', (ran?.build.counts.indexed ?? 0) <= 200, String(ran?.build.counts.indexed))
    check('WP4 运行器', '★ 一轮里有 reconcile + build 两段（摘要可读）', (ran?.summary ?? '').includes('reconcile:') && (ran?.summary ?? '').includes('build:'), ran?.summary)

    /* 代的选择：已有 published ⇒ 复用；没有 ⇒ 新建。
       ⚠️ 断言**不要写死代名** —— 上面几节换过代（`gen-bounded` 发布时 `gen-2` 被置 unavailable），
       写死会假失败（实测踩到）。判据是"与**当前已发布**的那一代一致"。 */
    const publishedNow = rowsOf(
      await h.db.execute(sql`
        select generation_id from memory_semantic_generations
         where namespace = 'ns-wp2b' and build_state = 'published'
         order by published_at desc nulls last, created_at desc limit 1`)
    )[0] as Record<string, unknown> | undefined
    const genReuse = await resolveMaintenanceGenerationId(h.db, 'ns-wp2b')
    check(
      'WP4 运行器',
      '★ 代的选择：复用**当前已发布**的那一代（增量补行，不每轮换代）',
      publishedNow !== undefined && genReuse === String(publishedNow.generation_id),
      `${genReuse} vs ${String(publishedNow?.generation_id)}`
    )
    const genFresh = await resolveMaintenanceGenerationId(h.db, 'ns-nonexistent')
    check('WP4 运行器', '★ 没有已发布代 ⇒ 起一个新的 building 代', genFresh.startsWith('maint-ns-nonexistent-'), genFresh)

    process.stdout.write('\n=== 4k. WP6 补②：半建代**不会被查询**（探针只认 published） ===\n')
    /*
     * 探针的判据（`semantic-probe.ts:113-121` 逐字）：`where build_state = 'published'`
     * ⇒ **半建代（`building`）结构上就进不了候选**。
     * 这里造一个**停在 building 的代**（有界的一轮），然后断言：
     *   ① 它确实是 `building`（不是 published）· ② 它**不在** published 集合里。
     * ⚠️ 更强的形式是**真的调一次探针**（要 manifest + encoder 夹具）；本条断的是**使它不被服务的那个数据状态**。
     */
    const halfBuilt = await buildSemanticIndex({
      ...baseBuild,
      db: h.db,
      generationId: 'gen-halfbuilt',
      budget: 1,
      pageLimit: 1,
      batchLimit: 1,
      encoder: fixtureEncoder('fp-model-1', unit),
    })
    const halfState = rowsOf(
      await h.db.execute(sql`select build_state from memory_semantic_generations where generation_id = 'gen-halfbuilt'`)
    )[0] as Record<string, unknown> | undefined
    check('WP6 半建代', '★ 有界的一轮 ⇒ 该代停在 building（没发布）', halfBuilt.buildState === 'building' && String(halfState?.build_state) === 'building', `${halfBuilt.buildState}/${String(halfState?.build_state)}`)
    const servedGenerations = rowsOf(
      await h.db.execute(sql`
        select generation_id from memory_semantic_generations
         where namespace = 'ns-wp2b' and build_state = 'published'`)
    ).map((raw) => String((raw as Record<string, unknown>).generation_id))
    check('WP6 半建代', '★ 半建代**不在**探针会读的那个集合里（`build_state = published`）', !servedGenerations.includes('gen-halfbuilt'), servedGenerations.join(','))
    check('WP6 半建代', '★ 已发布集合非空（对照组：这条判据不是靠"什么都没有"通过的）', servedGenerations.length > 0, servedGenerations.join(','))

    process.stdout.write('\n=== 4l. 持久游标（存的一半：本轮枚举到哪一行） ===\n')
    /*
     * 计划 §1 WP2 的第 ① 条要"持久游标"。本轮做**存**这一半（读回续跑是下一步，那是行为变更）。
     * ⚠️ 上一轮在这里撞过 `column "source_cursor" does not exist` —— 真因是"新建路径没跑升级链"
     *    （已修 + 已补断言）；现在那一列在**新建的库上**也有 ✓。
     * ⚠️ 位置纪律：本段必须在**空库那一段之前**（那段 `stop()` 会关掉进程级单例连接）。
     */
    const cursorRow = rowsOf(
      await h.db.execute(sql`select source_cursor from memory_semantic_generations where generation_id = 'gen-bounded'`)
    )[0] as Record<string, unknown> | undefined
    check(
      'WP2 游标',
      '★ 跑完一轮 ⇒ `source_cursor` 被写下来（形如 `<createdAt>:<id>`）',
      typeof cursorRow?.source_cursor === 'string' && /^\d+:.+$/.test(String(cursorRow.source_cursor)),
      String(cursorRow?.source_cursor)
    )
    check(
      'WP2 游标',
      '★ 它是**真实位置**（`createdAt` 落在夹具的量级里，不是随手一个数）',
      Number(String(cursorRow?.source_cursor).split(':')[0]) > 1_000_000_000,
      String(cursorRow?.source_cursor)
    )

    process.stdout.write('\n=== 4m. 持久游标（**读回续跑**：游标在末尾 ⇒ 再跑一轮不重复编码） ===\n')
    /*
     * ★ 这条判据证明"续跑"**真的生效**：`gen-bounded` 上一轮已把游标写到**源的最后一行** ⇒
     *   同一代再跑一轮，枚举应当**为空** ⇒ `indexed = 0`（而不是把 9 条又编码一遍）。
     * ⚠️ 若游标被忽略（例如解析失败静默降级），这一轮会重新索引 ⇒ 判据红。
     * ⚠️ 位置纪律：必须在**空库那一段之前**（那段 stop() 会关掉进程级单例连接）。
     */
    const resumeRound = await buildSemanticIndex({
      ...baseBuild,
      db: h.db,
      generationId: 'gen-bounded',
      budget: 200,
      pageLimit: 200,
      batchLimit: 200,
      encoder: fixtureEncoder('fp-model-1', unit),
    })
    check(
      'WP2 游标',
      '★ **续跑生效**：游标已在源末尾 ⇒ 再跑一轮**枚举为空**（`eligible = 0`，不重复编码）',
      /*
       * ⚠️ 第一版断言写成 `indexed === 0` ⇒ **红了**（实测 `{eligible:0, indexed:8}`）。
       * 读出来：`indexed` 是**这一代现有的行数**（跨轮累计），**不是**"本轮写了几行" ——
       * 名字容易让人误读成后者。⇒ 判据改断 `eligible === 0`（枚举真的为空 = 续跑真的生效）。
       */
      resumeRound.counts.eligible === 0,
      JSON.stringify(resumeRound.counts)
    )
    check(
      'WP2 游标',
      '★ 对照：那一代此前**确实**有行（证明上一条不是"本来就没有源"）',
      (cursorRow?.source_cursor ?? '') !== '' && resumeRound.counts.eligible === 0,
      `eligible=${String(resumeRound.counts.eligible)} cursor=${String(cursorRow?.source_cursor)}`
    )

    process.stdout.write('\n=== 4n. WP6 补②b：换代断电点 `N4`（两条语句之间抛 ⇒ 事务回滚） ===\n')
    /*
     * ★ **证明回滚**，而不是只断言"代码里有 transaction"：
     *   在"旧代已降、新代未发"之间抛 ⇒ 事务应回滚 ⇒ **旧代必须仍是 published**。
     * ⚠️ 位置纪律：必须在**空库那一段之前**（那段 stop() 会关掉进程级单例连接）。
     */
    const beforeN4 = rowsOf(
      await h.db.execute(sql`
        select generation_id, build_state from memory_semantic_generations
         where namespace = 'ns-wp2b' and build_state = 'published'`)
    ).map((raw) => String((raw as Record<string, unknown>).generation_id))
    let n4Threw = false
    try {
      await buildSemanticIndex({
        ...baseBuild,
        db: h.db,
        generationId: 'gen-n4',
        budget: 200,
        pageLimit: 200,
        batchLimit: 200,
        encoder: fixtureEncoder('fp-model-1', unit),
        onAfterSwapDemote: async () => {
          throw new Error('injected_n4_power_loss')
        },
      })
    } catch {
      n4Threw = true
    }
    const afterN4 = rowsOf(
      await h.db.execute(sql`
        select generation_id, build_state from memory_semantic_generations
         where namespace = 'ns-wp2b' and build_state = 'published'`)
    ).map((raw) => String((raw as Record<string, unknown>).generation_id))
    check('WP6 N4', '★ 注入的断电确实发生了（抛出来了）', n4Threw)
    check(
      'WP6 N4',
      '★ **回滚**：崩在两条之间 ⇒ **旧代仍是 published**（不是"一代都没有"）',
      JSON.stringify(afterN4) === JSON.stringify(beforeN4) && afterN4.length > 0,
      `before=${beforeN4.join(',')} after=${afterN4.join(',')}`
    )
    check(
      'WP6 N4',
      '★ 新代**没有**被发出去（它仍停在 building）',
      rowsOf(
        await h.db.execute(sql`select build_state from memory_semantic_generations where generation_id = 'gen-n4'`)
      ).every((raw) => String((raw as Record<string, unknown>).build_state) !== 'published')
    )

    /* ⚠️ 空库那一段**必须放在最后**：它 `stop()` 掉的 harness 会关掉**进程级单例**连接
       （`@elizaos/plugin-sql` 单例）⇒ 之后再碰 `h.db` 就是 `PGlite is closed`（实测踩到）。 */
    await resetPluginSqlConnection()
    isolateDatabase('m95-wp2b-empty', { keep: false })
    const hEmpty = await createM4Harness({ label: 'm95-wp2b-empty' })
    const runnerEmpty = createProductionMaintenanceRunner({
      db: hEmpty.db,
      namespace: 'ns-empty',
      encoder: fixtureEncoder('fp-model-1', unit),
      rendererVersion: RENDERER_VERSION,
      tokenizerFingerprint: 'tok@1',
      pooling: 'mean',
      normalize: true,
      dtype: 'q8',
      dimension: 384,
      generationId: 'gen-empty',
      integrityProblemsOf: () => [],
      now: () => 1,
    })
    const emptyRun = await runnerEmpty()
    check('WP4 运行器', '★ 空库 ⇒ 什么都不做（返回 null，不是错误）', emptyRun === null, JSON.stringify(emptyRun))
    await hEmpty.stop()

    process.stdout.write('\n=== 4j. WP4 完整性适配（按 owner 的读数 ⇒ 按记忆的问题列表） ===\n')
    /*
     * 第三个坑的落地：形状不同（四个数组 vs 一个函数）⇒ 必须有这一层映射。
     * 没有它就只能传空数组，那等于**静默关掉**"链断/完整性不合格 ⇒ 不索引"
     * —— 而那是 `D-1` 修订后**仍然保留**的那一半政策。
     */
    const byMemory = integrityProblemsByMemory({
      danglingEvidenceLinks: [{ memoryId: 'm-a', evidenceId: 'e-1' }],
      danglingMemoryEvents: [{ memoryId: 'm-a', domainEventId: 'd-1' }],
      memoriesWithoutLiveEvidence: [{ memoryId: 'm-b', status: 'active' }],
      memoriesWithoutLiveEvents: [{ memoryId: 'm-c', status: 'active' }],
    })
    check('WP4 完整性', '★ 同一条记忆的多个问题**合并**（m-a 两条）', JSON.stringify(byMemory('m-a')) === JSON.stringify(['dangling_evidence_link', 'dangling_memory_event']), JSON.stringify(byMemory('m-a')))
    check('WP4 完整性', '★ 具名问题码（m-b / m-c 各一条）', JSON.stringify(byMemory('m-b')) === JSON.stringify(['no_live_evidence']) && JSON.stringify(byMemory('m-c')) === JSON.stringify(['no_live_events']))
    check('WP4 完整性', '★ 没有问题的记忆 ⇒ 空数组（不是 undefined）', JSON.stringify(byMemory('m-none')) === JSON.stringify([]))
    check(
      'WP4 完整性',
      '★ **接线**：把适配结果喂给资格政策 ⇒ 链断的那条**真的被排除**且理由带码',
      (() => {
        const verdict = indexEligibility({
          record: {
            status: 'active',
            content: { kind: 'claim', predicate: 'education.major', value: '计算机' },
          } as never,
          integrityProblems: byMemory('m-a'),
        })
        return verdict.eligible === false && verdict.reason === 'integrity:dangling_evidence_link'
      })()
    )

    process.stdout.write('\n=== 5. 计数自检（measuredCount > 0） ===\n')
    const selfCheck = selfCheckMeasurement({ measuredCount: measured, notRunCount: 0, failedCount: failures.length })
    process.stdout.write(`  ${selfCheck.verdict} —— ${selfCheck.reason}\n`)
    if (selfCheck.verdict !== 'PASS') failures.push(`self_check_${selfCheck.verdict}：${selfCheck.reason}`)

    /* ---- 落盘 ---- */
    const head = (() => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      } catch {
        return ''
      }
    })()
    const runId = createM95RunId({ wpId: 'wp2-build', headShort: head.slice(0, 12) })
    const runDir = openM95RunDir(REPO_ROOT, runId)
    const tree = sourceTreeReading(REPO_ROOT)
    const verdict = failures.length === 0 ? 'PASS' : 'FAIL'
    const manifestPath = writeM95Manifest(runDir, {
      schemaVersion: 'm9.5-wp2-build-verify@1',
      runId,
      stage: 'wp2',
      lane: 'offline',
      startedAt,
      completedAt: new Date().toISOString(),
      head,
      headShort: head.slice(0, 12),
      branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirtyPaths: dirtyPaths(REPO_ROOT),
      sourceTreeHash: tree.treeSha256,
      sourceTreeHashDefinition: tree.definition,
      gateVersion: 'm9.5:build:verify@1',
      dbKind: 'synthetic',
      isolationProof: {
        method: 'isolateDatabase() 一次性沙箱（%TEMP%）；真实库从未被打开',
        dbTouched: true,
      },
      configHash: { span: 'WP2-A 源枚举', owner: `${OWNER_KIND}/${OWNER_ID}`, rows: withRevision.rows.length },
      command: [{ cmd: 'pnpm m9.5:build:verify', exitCode: failures.length === 0 ? 0 : 3 }],
      exitCode: failures.length === 0 ? 0 : 3,
      completion: 'complete',
      usable: verdict === 'PASS',
      measuredCount: measured,
      notRunCount: 0,
      counts: { total: measured, passed: measured - failures.length, failed: failures.length },
      toolVersions: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
      },
      supersedes: null,
      verdict,
      rows: withRevision.rows.length,
      eligible: classified.eligible.length,
      excluded: classified.excluded.length,
      excludedByReason: classified.excludedByReason,
      selfCheck,
      failures,
      scope: {
        verifies:
          '源枚举层：稳定全序 · keyset 分页（无重复/无遗漏）· 预算有界 · 持久游标 · ' +
          '真实 revision · 资格分列（具名理由 + 直方图）。',
        notVerifies:
          '**不**测编码（WP2-B）· **不**测落盘 / 水位持久化 / 换代（WP2-B）· ' +
          '**不**测失效传播（WP3）· **不**主张召回质量。',
      },
    })
    process.stdout.write(
      [
        '',
        '──────────────────────────────────────────────────────────────',
        `M9.5 / WP2-A 源枚举门：${verdict}`,
        `  检查 ${String(measured)} 项 · 失败 ${String(failures.length)}`,
        ...failures.map((line) => `  ✗ ${line}`),
        `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
        `  清单：${manifestPath}`,
        '',
      ].join('\n')
    )
    if (failures.length > 0) process.exitCode = 3
  } finally {
    await h.stop()
  }
}

await main()
