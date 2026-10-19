/**
 * M8.5 WP13 —— **生产激活程序**（计划 §22.2 的机器面；零模型调用）。
 *
 * 在**真实库**上执行语义切换的三步（与 WP11 演练 `m8.5-live-drill.ts` 同一程序）：
 * ```text
 *  ① 分路（按激活前投影初始态，Activation-Candidate §3）：
 *     seeded_fresh —— 从未建档（今天的真实生产态：ADR-067 激活后没有真实聊天）
 *       ⇒ seedAffectOrigin(@2) 直接播种；空历史上 A==B 无意义，如实记 vacuous
 *     replayed —— 已建档（真实词形历史存在）
 *       ⇒ rebuildAffectProjectionV2 受控重放 + A==B 判据（不成立 ⇒ 拒绝，不推边界）
 *  ② markAffectSemanticCutover：切换边界 = 激活时账本尾（§24③：边界前来源
 *     定义上永不语义重评；激活 ADR 另行记录文档值）
 *  ③ 语义 scanner/worker 水位预置到边界（ADR-068 R-6：预置 ⇒ 首个语义 boot
 *     的追赶从边界起步，激活读数确定；否则长历史扫描瞬态会埋葬未发现的语义工作）
 * ```
 *
 * 纪律（失败关闭，全部在写之前）：
 *  - **顺序闸**：`CHARACTER_AFFECT_SEMANTIC_MODE` 已是 `semantic` ⇒ 拒绝（exit 6）
 *    ——程序必须先于 `.env` 开关；开关已开意味着顺序错了，继续跑会掩盖它。
 *  - **一次性闸**：切换边界水位已存在（>0）⇒ 拒绝（exit 5）——重跑会把边界
 *    推进到更晚的账本尾，埋葬两次运行之间的新来源。中断恢复走 replayed 分路
 *    （播种已落、边界未落 ⇒ 重放空历史 + A==B 平凡成立 + 补边界），天然安全。
 *  - 真实库路径走 INC-01 状态机（租约 → pre-open verified snapshot → token →
 *    打开 → WP3 唯一收尾 → post-close 快照 → 释放租约）；副本/沙箱路径不走
 *    状态机（`PGLITE_DATA_DIR` + `PROJECT_LG_SANDBOX` 双闸，同 drill）。
 *
 * 用法：
 *   pnpm m8.5:activate                          # 生产激活（真实库）
 *   $env:PGLITE_DATA_DIR='<副本>'; $env:PROJECT_LG_SANDBOX='1'; pnpm m8.5:activate
 *                                               # 副本演练（同一程序，不走状态机）
 *
 * 读数落 `artifacts/m8.5/activation-<ts>/activation.json`（生产）或
 * `artifacts/m8.5/local/activation-rehearsal-<ts>/activation.json`（演练，gitignored）。
 */
import 'dotenv/config'

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/*
 * 顺序闸必须在任何数据库动作之前（连 import 都不碰库）。
 * dotenv 已加载：读到的就是 `.env` 的真实值。
 */
const modeEnv = process.env.CHARACTER_AFFECT_SEMANTIC_MODE ?? null
if (modeEnv === 'semantic') {
  console.error(
    '拒绝：CHARACTER_AFFECT_SEMANTIC_MODE 已是 semantic——激活程序必须先于 .env 开关运行。\n' +
      '  正确顺序：本程序 → .env 设 semantic → 首次语义启动。请先把该变量改回/删掉再激活。'
  )
  process.exit(6)
}

const { isProductionDir } = await import('../src/dev/sandbox.ts')
const { productionDataDirOf } = await import(
  '../src/infrastructure/persistence/production-open-guard.ts'
)
const { allowProductionDatabase, initDatabase } = await import('../src/db/index.ts')

const dataDir = productionDataDirOf()
const sandboxed = process.env.PROJECT_LG_SANDBOX !== undefined
const isProduction = !sandboxed && isProductionDir(dataDir)
const target: 'production' | 'rehearsal' = isProduction ? 'production' : 'rehearsal'

if (!sandboxed && !isProduction) {
  console.error(
    `拒绝：目标既不是生产库也不是显式沙箱（PGLITE_DATA_DIR='${process.env.PGLITE_DATA_DIR ?? ''}' → ${dataDir}）。\n` +
      '  生产激活不要设任何变量直接跑；副本演练必须同时设 PGLITE_DATA_DIR + PROJECT_LG_SANDBOX。'
  )
  process.exit(3)
}

/* 显式放行（中央闸仍要求 pre-open token；沙箱路径不受影响） */
allowProductionDatabase()

const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')const { character } = await import('../src/character/index.ts')
const { getRawDb } = await import('../src/infrastructure/persistence/db.ts')
const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
const { getAffectProjection, rebuildAffectProjectionV2 } = await import(
  '../src/infrastructure/persistence/affect-store.ts'
)
const { markAffectSemanticCutover } = await import(
  '../src/infrastructure/runtime/affect-semantic-scheduler.ts'
)
const { seedAffectOrigin } = await import('../src/infrastructure/runtime/affect-scheduler.ts')
const { getWatermark, advanceWatermark } = await import(
  '../src/infrastructure/persistence/job-store.ts'
)
const {
  AFFECT_SEMANTIC_SCANNER_NAME,
  AFFECT_SEMANTIC_WORKER_NAME,
} = await import('../src/kernel/app/affect/semantic-worker.ts')
const {
  AFFECT_SEMANTIC_SCANNER_PROCESSOR,
  AFFECT_SEMANTIC_WORKER_PROCESSOR,
  AFFECT_SEMANTIC_CUTOVER_NAME,
  AFFECT_SEMANTIC_CUTOVER_PROCESSOR,
} = await import('../src/kernel/contracts/affect-semantic.ts')

export interface ActivationReading {
  readonly ok: boolean
  readonly reason?: string
  readonly target: 'production' | 'rehearsal'
  /** seeded_fresh = 从未建档 ⇒ @2 直接播种（A==B 对空历史 vacuous）；replayed = 受控重放 + A==B */
  readonly path: 'replayed' | 'seeded_fresh' | 'refused'
  readonly before: {
    readonly originated: boolean
    readonly valence: number | null
    readonly arousal: number | null
    readonly revision: number | null
    readonly reducerVersion: string | null
    readonly lastInteractionAt: number | null
  } | null
  readonly after: {
    readonly originated: boolean
    readonly valence: number | null
    readonly arousal: number | null
    readonly revision: number | null
    readonly reducerVersion: string | null
    readonly lastInteractionAt: number | null
  } | null
  readonly appliedEvents: number | null
  readonly cutoverSequence: number | null
  readonly aEqualB: boolean
  readonly watermarks: {
    readonly scanner: number | null
    readonly worker: number | null
    readonly cutover: number | null
  }
  readonly modeEnv: string | null
  readonly activatedAt: string
}

const characterId = asCharacterId(character.id ?? character.name)
const runtime = createThinHostRuntime({
      character: character,
      settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'placeholder',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
  },
      conversationLength: 16,
    })

const snapshotOf = (row: Awaited<ReturnType<typeof getAffectProjection>>) =>
  row === undefined
    ? null
    : {
        originated: row.state.originated,
        valence: row.state.valence,
        arousal: row.state.arousal,
        revision: row.revision,
        reducerVersion: row.reducerVersion,
        lastInteractionAt: row.state.lastInteractionAt,
      }

/* ---- 开库：生产走 INC-01 状态机；演练直开（同 drill 的双闸） ---- */
let productionHandle: Awaited<
  ReturnType<
    typeof import('../src/infrastructure/persistence/production-open-guard.ts').prepareProductionOpen
  >
> | undefined

if (isProduction) {
  const {
    prepareProductionOpen,
    productionSnapshotRootOf,
    lastVerifiedSnapshotId,
  } = await import('../src/infrastructure/persistence/production-open-guard.ts')
  const {
    stopRuntimeServices,
    closeDatabaseConnection,
    isDatabaseClosed,
  } = await import('../src/infrastructure/persistence/runtime-shutdown.ts')
  const handle = await prepareProductionOpen({
    dataDir,
    snapshotRoot: productionSnapshotRootOf(),
    operationKind: 'affect_semantic_activate',
    deps: {
      openDatabase: async () => {
        await initDatabase(runtime)
      },
      stopServices: () => stopRuntimeServices(runtime),
      closeDatabase: async () => await closeDatabaseConnection(runtime),
      isDatabaseClosed: () => isDatabaseClosed(runtime),
      lastVerifiedSnapshotId: () => lastVerifiedSnapshotId(productionSnapshotRootOf()),
    },
  })
  await handle.open()
  productionHandle = handle
  console.log(`[inc-01] 生产状态机：${handle.reading.states.join(' → ')}（租约+pre-open 快照已验）`)
} else {
  await initDatabase(runtime)
  console.log(`演练模式：目标 ${dataDir}（不走 INC-01 状态机）`)
}

const db = getRawDb(runtime)
const now = Date.now()

const wmOf = async (name: string, processor: string): Promise<number | null> => {
  const wm = await getWatermark(db, characterId, name, processor)
  return wm?.processedThroughSequence ?? null
}

const refuse = async (reason: string, code: number, partial: Partial<ActivationReading>) => {
  const reading: ActivationReading = {
    ok: false,
    reason,
    target,
    path: 'refused',
    before: null,
    after: null,
    appliedEvents: null,
    cutoverSequence: null,
    aEqualB: false,
    watermarks: { scanner: null, worker: null, cutover: null },
    modeEnv,
    activatedAt: new Date().toISOString(),
    ...partial,
  }
  const outDir =
    target === 'production'
      ? `artifacts/m8.5/activation-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17)}`
      : `artifacts/m8.5/local/activation-rehearsal-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17)}`
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, 'activation.json'), JSON.stringify(reading, null, 2), 'utf8')
  console.error(`拒绝：${reason}（读数落 ${outDir}/activation.json）`)
  /* 收尾仍走唯一句柄——拒绝也不能留下打开的库 */
  const { createRuntimeShutdown } = await import(
    '../src/infrastructure/persistence/runtime-shutdown.ts'
  )
  await createRuntimeShutdown(runtime, {
    afterRun: async (shutdownReading) => {
      if (productionHandle !== undefined) {
        await productionHandle.finish({
          closed: shutdownReading.closed,
          detail: `refused: ${reason}`,
          afterClose: true,
        })
      }
    },
  }).shutdown()
  process.exit(code)
}

/* ---- 一次性闸：边界已标记 ⇒ 激活是一次性操作，拒绝重跑 ---- */
const cutoverBefore = await wmOf(AFFECT_SEMANTIC_CUTOVER_NAME, AFFECT_SEMANTIC_CUTOVER_PROCESSOR)
if ((cutoverBefore ?? 0) > 0) {
  await refuse(
    `切换边界已存在（affect-semantic-cutover@1 = ${String(cutoverBefore)}）——激活是一次性操作；` +
      '重跑会把边界推进到更晚的账本尾、埋葬其间的新来源。如需排查请用只读入口。',
    5,
    { watermarks: { scanner: null, worker: null, cutover: cutoverBefore } }
  )
}

/* ---- ① 分路 ---- */
const before = await getAffectProjection(db, characterId)
const beforeSnap = snapshotOf(before)

let path: 'replayed' | 'seeded_fresh'
let appliedEvents = 0
let aEqualB = true

if (before === undefined || !before.state.originated) {
  path = 'seeded_fresh'
  const seed = await seedAffectOrigin(db, {
    characterId,
    activationId: target === 'production' ? 'm8.5-production-activation' : 'm8.5-activation-rehearsal',
    affectReducerVersion: 2,
    now,
  })
  if (seed.kind !== 'seeded' && seed.kind !== 'already') {
    await refuse(`@2 播种失败（${seed.kind}）`, 4, { before: beforeSnap })
  }
  console.log(
    `  分路 seeded_fresh：@2 播种（${seed.kind}${seed.kind === 'seeded' ? `，ORIGIN 边界=${String(seed.cutoverSequence)}` : ''}）`
  )
} else {
  path = 'replayed'
  const rebuild = await rebuildAffectProjectionV2(db, characterId, now)
  const afterRebuild = await getAffectProjection(db, characterId)
  aEqualB =
    afterRebuild !== undefined &&
    afterRebuild.revision === before.revision &&
    Math.abs(afterRebuild.state.valence - before.state.valence) < 1e-12 &&
    Math.abs(afterRebuild.state.arousal - before.state.arousal) < 1e-12 &&
    afterRebuild.state.lastInteractionAt === before.state.lastInteractionAt
  appliedEvents = rebuild.appliedEvents
  if (!aEqualB) {
    await refuse(
      'A==B 不成立：@2 重放与 @1 在线投影存在字段漂移——边界不推进（失败关闭）',
      4,
      { before: beforeSnap, appliedEvents, aEqualB: false }
    )
  }
  console.log(`  分路 replayed：@2 受控重放 ${String(appliedEvents)} 事件，A==B 成立`)
}

/* ---- ② 切换边界 ---- */
const cutover = await markAffectSemanticCutover(db, characterId, now)
console.log(`  切换边界：affect-semantic-cutover@1 = ${String(cutover.cutoverSequence)}`)

/* ---- ③ 水位预置（ADR-068 R-6） ---- */
const preadvance = async (name: string, processor: string): Promise<void> => {
  const current = await wmOf(name, processor)
  if (cutover.cutoverSequence > 0 && (current ?? 0) < cutover.cutoverSequence) {
    await advanceWatermark(db, characterId, name, processor, cutover.cutoverSequence, now)
  }
}
await preadvance(AFFECT_SEMANTIC_SCANNER_NAME, AFFECT_SEMANTIC_SCANNER_PROCESSOR)
await preadvance(AFFECT_SEMANTIC_WORKER_NAME, AFFECT_SEMANTIC_WORKER_PROCESSOR)

/* ---- 读数 ---- */
const after = await getAffectProjection(db, characterId)
const afterSnap = snapshotOf(after)
const watermarks = {
  scanner: await wmOf(AFFECT_SEMANTIC_SCANNER_NAME, AFFECT_SEMANTIC_SCANNER_PROCESSOR),
  worker: await wmOf(AFFECT_SEMANTIC_WORKER_NAME, AFFECT_SEMANTIC_WORKER_PROCESSOR),
  cutover: await wmOf(AFFECT_SEMANTIC_CUTOVER_NAME, AFFECT_SEMANTIC_CUTOVER_PROCESSOR),
}
const cutoverReadbackOk =
  cutover.cutoverSequence > 0
    ? watermarks.cutover === cutover.cutoverSequence
    : watermarks.cutover === null || watermarks.cutover === 0
const ok =
  after?.state.originated === true &&
  (path === 'seeded_fresh' || aEqualB) &&
  cutoverReadbackOk &&
  (path === 'replayed' ? appliedEvents >= 0 : true)

const reading: ActivationReading = {
  ok,
  reason: ok ? undefined : '激活后读数异常（建档/边界回读不完整）',
  target,
  path,
  before: beforeSnap,
  after: afterSnap,
  appliedEvents,
  cutoverSequence: cutover.cutoverSequence,
  aEqualB,
  watermarks,
  modeEnv,
  activatedAt: new Date().toISOString(),
}

const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17)
const outDir =
  target === 'production'
    ? `artifacts/m8.5/activation-${stamp}`
    : `artifacts/m8.5/local/activation-rehearsal-${stamp}`
mkdirSync(outDir, { recursive: true })
writeFileSync(resolve(outDir, 'activation.json'), JSON.stringify(reading, null, 2), 'utf8')

console.log('')
console.log(`  激活${ok ? '完成' : '读数异常'}：`)
console.log(`    分路 = ${path}${path === 'replayed' ? `（重放 ${String(appliedEvents)} 事件，A==B=${String(aEqualB)}）` : '（A==B 对空历史 vacuous）'}`)
console.log(`    投影 = ${afterSnap ? `@${String(afterSnap.reducerVersion)} r${String(afterSnap.revision)} v=${String(afterSnap.valence)} a=${String(afterSnap.arousal)} originated=${String(afterSnap.originated)}` : '(无)'}`)
console.log(`    边界 = ${String(cutover.cutoverSequence)}（回读 ${String(watermarks.cutover)}）`)
console.log(`    水位 = scanner ${String(watermarks.scanner)} · worker ${String(watermarks.worker)}`)
console.log(`    读数 = ${outDir}/activation.json`)

/* ---- 收尾：WP3 唯一句柄 + 状态机 finish ---- */
const { createRuntimeShutdown } = await import(
  '../src/infrastructure/persistence/runtime-shutdown.ts'
)
await createRuntimeShutdown(runtime, {
  afterRun: async (shutdownReading) => {
    if (productionHandle !== undefined) {
      await productionHandle.finish({
        closed: shutdownReading.closed,
        detail: `m8.5 affect semantic activation (${path}, cutover=${String(cutover.cutoverSequence)}, ok=${String(ok)})`,
        afterClose: true,
      })
    }
  },
}).shutdown()

process.exit(ok ? 0 : 4)
