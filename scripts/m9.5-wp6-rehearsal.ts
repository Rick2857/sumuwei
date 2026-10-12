/**
 * M9.5 **启用计划 / WP6** —— **生产副本预演**（`pnpm exec tsx scripts/m9.5-wp6-rehearsal.ts`）
 *
 * ```text
 * 预演什么（计划 §20.1 的档）：在**真实库的副本**上跑
 *   ① 全量索引（**真编码器** + 真资产）  ② 健康读回  ③ 重启重放（新进程再读一次，代/水位是否自洽）
 *   ④ 切换（published 原子切换）        ⑤ 故障注入（编码器失败 ⇒ 不发布、水位被挡）
 *   ⑥ 回滚预演（把 published 代置 unavailable ⇒ 探针应回到"没有已发布代"）
 * ⚠️ **不打开真实库**：副本由调用方先 `cpSync` 到 `%TEMP%`（本脚本只**读**那个副本）；
 *    再把副本**灌进 `isolateDatabase()` 的沙箱**里启动 —— 于是走的是**既有**的启动路径，
 *    不新写任何"直连真实库"的入口（计划 §19.3 逐字禁止）。
 * ```
 *
 * 用法：
 *   $env:PROJECT_LG_WP6_COPY='<副本目录>'; pnpm exec tsx scripts/m9.5-wp6-rehearsal.ts
 * 缺省副本 = `%TEMP%\m95-wp6-copy`（第 15 轮取的那份）。
 */

import 'dotenv/config'

import { cpSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import { createM4Harness } from './m4-harness.ts'
import { ensureSemanticIndexSchema } from '../src/infrastructure/persistence/memory-semantic-index.ts'
import { buildSemanticIndex } from '../src/infrastructure/persistence/semantic-index-builder.ts'
import { readSemanticIndexHealth } from '../src/infrastructure/persistence/semantic-index-health.ts'
import { createEncoderIndexPort } from '../src/infrastructure/persistence/semantic-index-encoder-port.ts'
import { createEncoderClient } from '../src/infrastructure/semantic/encoder-client.ts'
import {
  embeddingFingerprintOf,
  loadEmbeddingManifest,
} from '../src/infrastructure/semantic/embedding-manifest.ts'
import { sql } from 'drizzle-orm'

const REPO_ROOT = process.cwd()
const COPY = process.env.PROJECT_LG_WP6_COPY ?? join(process.env.TEMP ?? '/tmp', 'm95-wp6-copy')
const OUT = join(REPO_ROOT, 'artifacts', 'm9.5', 'wp6-rehearsal.json')
const NAMESPACE = 'wp6-rehearsal'

if (!existsSync(COPY)) {
  process.stdout.write(`❌ 副本不存在：${COPY}（先 cpSync 真实库）\n`)
  process.exit(3)
}

const manifest = loadEmbeddingManifest(join(REPO_ROOT, 'evals/m9.5/embedding-manifest.json'))
const fingerprint = embeddingFingerprintOf(manifest)
const readings: Record<string, unknown> = {}

await resetPluginSqlConnection()
/*
 * ⚠️ **真进程重启**（WP6 补①）：`isolateDatabase` 的 `runId` 是**为跨进程续跑设计的**
 * （"同一 id 会复用目录"）⇒ 两个进程因此能落在**同一个**库上：
 *   `--phase build`  造库（把副本灌进沙箱）+ 跑索引
 *   `--phase read`   **只读**（不灌副本）⇒ 读到的就是上一个进程留下的状态
 * ⚠️ `keep: true`：跨进程期间不能自动清理；收尾由调用方负责（它在 `%TEMP%` 下）。
 */
const phaseArg = process.argv.indexOf('--phase')
const PHASE = phaseArg >= 0 ? String(process.argv[phaseArg + 1]) : 'all'
const sandbox =
  PHASE === 'all'
    ? isolateDatabase('m95-wp6-rehearsal', { keep: false })
    : isolateDatabase('m95-wp6-rehearsal', { runId: 'wp6-restart', keep: true })
if (PHASE !== 'read') {
  /* 把**副本**灌进沙箱目录（而不是把 env 指向副本）⇒ 复用既有启动路径 */
  for (const entry of readdirSync(COPY)) {
    cpSync(join(COPY, entry), join(sandbox.dir, entry), { recursive: true })
  }
}
process.stdout.write(`副本 ${COPY}\n  → 沙箱 ${sandbox.dir}（phase=${PHASE}）\n`)

const h = await createM4Harness({ label: 'm95-wp6-rehearsal' })
const client = createEncoderClient({
  manifest,
  repoRoot: REPO_ROOT,
  localModelPath: join(REPO_ROOT, 'artifacts', 'm9.5', 'local', 'embedding-lab', 'models'),
  deadlineMs: 120_000,
})

try {
  /* `--phase read`：**第二个进程**只读上一个进程留下的状态（真重启的判据） */
  if (PHASE === 'read') {
    const health = await readSemanticIndexHealth(h.db, NAMESPACE)
    const persisted = {
      phase: 'read',
      sandboxDir: sandbox.dir,
      publishedGenerationId: health.publishedGenerationId,
      publishedFingerprint: health.publishedFingerprint,
      generations: health.generations.map((g) => ({
        id: g.generationId,
        state: g.buildState,
        indexed: g.indexed,
        watermark: g.processedWatermark,
      })),
      staleOrOrphaned: health.staleOrOrphaned,
    }
    mkdirSync(join(REPO_ROOT, 'artifacts', 'm9.5'), { recursive: true })
    writeFileSync(
      join(REPO_ROOT, 'artifacts', 'm9.5', 'wp6-restart-read.json'),
      `${JSON.stringify(persisted, null, 2)}\n`,
      'utf8'
    )
    process.stdout.write(`${JSON.stringify(persisted, null, 2)}\n\n证据：artifacts/m9.5/wp6-restart-read.json\n`)
    await client.close()
    await h.stop()
    process.exit(0)
  }

  const warm = await client.warmup()
  readings.warmup = { ok: warm.ok, coldLoadMs: warm.coldLoadMs }
  await ensureSemanticIndexSchema(h.db, { now: 1 })

  const sources = rowsOf(
    await h.db.execute(sql`select status, count(*)::int as c from memory_records group by status`)
  ).map((raw) => {
    const row = raw as Record<string, unknown>
    return `${String(row.status)}=${String(row.c)}`
  })
  readings.sourceByStatus = sources

  /*
   * ⚠️ **owner 必须从数据里读，不能写死**（2026-10-01 实测）：
   * 第一版把 `ownerId` 写死成 `char_sumuwei`，于是副本里明明有 `active=1`，
   * 枚举却返回 **0 条** —— 整个预演"跑通了但什么都没量到"。
   * ⇒ 从 `memory_records` 里取**真实**的 owner（取第一条即可：本项目单角色）。
   */
  const ownerRow = rowsOf(
    await h.db.execute(sql`select owner_kind, owner_id from memory_records order by created_at asc limit 1`)
  )[0] as Record<string, unknown> | undefined
  if (ownerRow === undefined) {
    throw new Error('副本里一条 memory_records 都没有 ⇒ 预演没有意义')
  }
  const ownerKind = String(ownerRow.owner_kind)
  const ownerId = String(ownerRow.owner_id)
  readings.owner = { ownerKind, ownerId }

  const port = createEncoderIndexPort(client, { modelFingerprint: fingerprint })
  const base = {
    db: h.db,
    namespace: NAMESPACE,
    ownerKind,
    ownerId,
    generationId: 'wp6-gen-1',
    rendererVersion: 'semantic-render@1',
    encoder: port,
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
  } as const

  /* ① 全量索引（真编码器） */
  const built = await buildSemanticIndex(base)
  readings.build = built
  readings.healthAfterBuild = await readSemanticIndexHealth(h.db, NAMESPACE)

  /* ③ 重启重放：**同一个库**重新读一次（新连接由 harness 的 stop/再起近似） */
  readings.healthAfterRestart = await readSemanticIndexHealth(h.db, NAMESPACE)

  /* ⑤ 故障注入：编码器失败 ⇒ 不发布、水位被挡 */
  const failing = await buildSemanticIndex({
    ...base,
    generationId: 'wp6-gen-fail',
    encoder: { modelFingerprint: fingerprint, encode: async () => ({ ok: false, reason: 'injected_failure' }) },
  })
  readings.faultInjected = failing

  /* ⑥ 回滚预演：把已发布代置 unavailable ⇒ 探针应回到"没有已发布代" */
  await h.db.execute(
    sql`update memory_semantic_generations set build_state = 'unavailable' where namespace = ${NAMESPACE} and build_state = 'published'`
  )
  readings.healthAfterRollback = await readSemanticIndexHealth(h.db, NAMESPACE)
} finally {
  await client.close()
  await h.stop()
}

mkdirSync(join(REPO_ROOT, 'artifacts', 'm9.5'), { recursive: true })
writeFileSync(OUT, `${JSON.stringify({ copy: COPY, fingerprint, readings }, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(readings, null, 2)}\n\n证据：${OUT}\n`)
