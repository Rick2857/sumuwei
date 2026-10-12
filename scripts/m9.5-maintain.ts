/**
 * M9.5 **启用计划 / WP4 接线** —— **显式维护命令**（`pnpm m9.5:maintain --data-dir <路径>`）。
 *
 * ============================================================================
 *  用户 2026-10-01 裁定：接线形态 = **显式命令**（不是启动时自动跑、不是后台周期任务）
 * ============================================================================
 * ```text
 * 为什么这样最保守：它**不改变任何自动行为** —— 没有它，系统与今天逐字相同；
 * 有它，运维就有了一个**可重复、有判据**的入口（满足 `D-3` 的"自动化维护"字面）。
 * ```
 *
 * ⚠️ **它拒绝维护真实库**（那是 `WP7-A` 的事，需 §20.1 逐条批准）：
 *    目标解析后若落在 `data/pglite` 上 ⇒ **具名拒绝**，并指向 WP7-A。
 * ⚠️ **它维护的是目标的副本，不是目标本身**：目标被 `cpSync` 进 `isolateDatabase()` 的沙箱，
 *    维护在沙箱里跑 ⇒ 这条命令**结构上无法写坏任何给定的库**（包括副本）。
 *    真正的"原地维护"要等 WP7 那套租约/快照纪律 ⇒ **如实登记为未做**。
 *
 * 用法：
 *   pnpm m9.5:maintain --data-dir "$env:TEMP\m95-wp6-copy"
 */

import 'dotenv/config'

import { cpSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { createM4Harness } from './m4-harness.ts'
import { ensureSemanticIndexSchema } from '../src/infrastructure/persistence/memory-semantic-index.ts'
import { runIndexMaintenance } from '../src/infrastructure/persistence/semantic-index-maintenance.ts'
import { readSemanticIndexHealth } from '../src/infrastructure/persistence/semantic-index-health.ts'
import { createEncoderIndexPort } from '../src/infrastructure/persistence/semantic-index-encoder-port.ts'
import { createEncoderClient } from '../src/infrastructure/semantic/encoder-client.ts'
import { embeddingFingerprintOf, loadEmbeddingManifest } from '../src/infrastructure/semantic/embedding-manifest.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import { sql } from 'drizzle-orm'

const REPO_ROOT = process.cwd()
const NAMESPACE = 'production'
const argIndex = process.argv.indexOf('--data-dir')
const rawTarget = argIndex >= 0 ? process.argv[argIndex + 1] : undefined

if (rawTarget === undefined) {
  process.stdout.write('❌ 必须显式给出 `--data-dir <路径>`（本命令**不猜**目标）\n')
  process.exit(2)
}
const target = resolve(rawTarget)
const production = resolve(join(REPO_ROOT, 'data', 'pglite'))
if (target === production) {
  process.stdout.write(
    `❌ **拒绝维护真实库**（${target}）。\n` +
      '   真实库上的索引构建属 M9.5 启用计划的 **WP7-A**，需计划 §20.1 的逐条批准\n' +
      '   （租约 → pre-open verified snapshot → token → 当轮批准）。本命令只服务副本/隔离库。\n'
  )
  process.exit(2)
}
if (!existsSync(target)) {
  process.stdout.write(`❌ 目标不存在：${target}\n`)
  process.exit(2)
}

const manifest = loadEmbeddingManifest(join(REPO_ROOT, 'evals/m9.5/embedding-manifest.json'))
const fingerprint = embeddingFingerprintOf(manifest)

await resetPluginSqlConnection()
const sandbox = isolateDatabase('m95-maintain', { keep: false })
for (const entry of readdirSync(target)) cpSync(join(target, entry), join(sandbox.dir, entry), { recursive: true })
process.stdout.write(`目标 ${target}\n  → 副本灌进沙箱 ${sandbox.dir}（**目标本身不会被写**）\n`)

const h = await createM4Harness({ label: 'm95-maintain' })
const client = createEncoderClient({
  manifest,
  repoRoot: REPO_ROOT,
  localModelPath: join(REPO_ROOT, 'artifacts', 'm9.5', 'local', 'embedding-lab', 'models'),
  deadlineMs: 120_000,
})

try {
  await client.warmup()
  await ensureSemanticIndexSchema(h.db, { now: 1 })
  const owner = rowsOf(
    await h.db.execute(sql`select owner_kind, owner_id from memory_records order by created_at asc limit 1`)
  )[0] as Record<string, unknown> | undefined
  if (owner === undefined) {
    process.stdout.write('⚠️ 目标库里一条 memory_records 都没有 ⇒ 无可维护\n')
    process.exit(0)
  }
  const run = await runIndexMaintenance({
    db: h.db,
    namespace: NAMESPACE,
    ownerKind: String(owner.owner_kind),
    ownerId: String(owner.owner_id),
    generationId: 'maintain-gen-1',
    rendererVersion: 'semantic-render@1',
    encoder: createEncoderIndexPort(client, { modelFingerprint: fingerprint }),
    tokenizerFingerprint: 'tok@1',
    pooling: manifest.pooling,
    normalize: manifest.normalize,
    dtype: manifest.dtype,
    dimension: manifest.dimension,
    now: () => 1,
    pageLimit: 200,
    budget: 2000,
    batchLimit: 200,
    maxAttempts: 3,
    integrityProblemsOf: () => [] as string[],
  })
  const health = await readSemanticIndexHealth(h.db, NAMESPACE)
  const out = {
    generatedAt: new Date().toISOString(),
    target,
    maintainedCopyOnly: true,
    fingerprint,
    summary: run.summary,
    build: run.build,
    reconcile: run.reconcile,
    health,
  }
  mkdirSync(join(REPO_ROOT, 'artifacts', 'm9.5'), { recursive: true })
  writeFileSync(join(REPO_ROOT, 'artifacts', 'm9.5', 'maintain-last.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
  process.stdout.write(`\n${run.summary}\n已发布代：${String(health.publishedGenerationId)}\n证据：artifacts/m9.5/maintain-last.json\n`)
} finally {
  await client.close()
  await h.stop()
}
