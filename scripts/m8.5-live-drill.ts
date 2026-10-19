/**
 * M8.5 WP11 —— **激活演练子进程**（被 `m8.5-live-level1.ts` spawn；也可独立执行）。
 *
 * 在**生产副本**上执行 §22.2 的机器面激活程序（零模型调用），按副本初始态分路：
 * ```text
 *  分路 B（已建档——真实词形历史存在）：
 *   ① 读激活前投影（@1）
 *   ② rebuildAffectProjectionV2：@2 受控重放整条词形账本
 *   ③ A==B 判据：重放前后 valence/arousal/revision/lastInteractionAt 逐字段一致
 *     （"投影是缓存"不变量②在真实生产历史上的活体证明）
 *   ④ markAffectSemanticCutover：切换边界 = 演练时账本尾
 *  分路 A（从未建档——今天的真实生产态：ADR-067 激活后没有真实聊天，ORIGIN
 *   从未播种）：@2 直接播种 + 边界。空历史上 A==B 无意义，如实记 vacuous；
 *   这正是 WP13 真实激活将面对的初始态。
 *  ⑤ 第三步（两路共用，工程选择随 ADR-068 R-6 记录）：语义 scanner/worker
 *    水位预置到边界——边界前来源定义上永不评估（§24③），扫描它们只是
 *    激活瞬态（批次 32/跳；长历史要多轮，期间切换模式会埋葬未发现的
 *    语义工作——第一跑 live 的实错发现）。预置 ⇒ 激活读数确定。
 *  ⑥ 落盘 JSON 读数（path/before/after/cutoverSequence/aEqualB/ok）
 * ```
 *
 * 纪律：只开副本（PGLITE_DATA_DIR + PROJECT_LG_SANDBOX 双闸；生产路径拒绝）；
 * 分路 B 的 A==B 不成立 ⇒ exit 4（失败关闭——不把边界推进建立在重放漂移之上）。
 *
 * 用法：tsx scripts/m8.5-live-drill.ts --db-dir <副本> --out <json>
 */
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { isProductionDir, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

export interface DrillReading {
  readonly ok: boolean
  readonly reason?: string
  /** replayed = 真实历史受控重建（A==B 有意义）；seeded_fresh = 副本从未建档 ⇒ @2 直接播种（A==B 对空历史无意义，如实记 vacuous） */
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
  readonly drilledAt: string
}

async function main(): Promise<void> {
  const dbDir = argValue('--db-dir')
  const out = argValue('--out')
  if (dbDir === undefined || out === undefined) {
    console.error('用法：tsx scripts/m8.5-live-drill.ts --db-dir <副本> --out <json>')
    process.exit(2)
  }
  const resolved = resolve(dbDir)
  if (!existsSync(resolved)) {
    console.error(`副本目录不存在：${resolved}`)
    process.exit(3)
  }
  if (isProductionDir(resolved) || resolved === resolve(PRODUCTION_DB_DIR)) {
    console.error('拒绝：--db-dir 指向生产库——演练只开副本')
    process.exit(3)
  }

  /* 两个变量必须在碰数据库之前设好（initDatabase 的真实库闸看它们） */
  process.env.PGLITE_DATA_DIR = resolved
  process.env.PROJECT_LG_SANDBOX = resolved

  const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')
  
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb } = await import('../src/infrastructure/persistence/db.ts')
  const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
  const { getAffectProjection, rebuildAffectProjectionV2 } = await import(
    '../src/infrastructure/persistence/affect-store.ts'
  )
  const { markAffectSemanticCutover } = await import(
    '../src/infrastructure/runtime/affect-semantic-scheduler.ts'
  )

  const characterId = asCharacterId(character.id ?? character.name)
  const runtime = createThinHostRuntime({
      character: character,
      settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'placeholder',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
    },
      conversationLength: 16,
    })
  await initDatabase(runtime)
  const db = getRawDb(runtime)

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

  const { getWatermark, advanceWatermark } = await import('../src/infrastructure/persistence/job-store.ts')
  const {
    AFFECT_SEMANTIC_SCANNER_NAME,
    AFFECT_SEMANTIC_WORKER_NAME,
  } = await import('../src/kernel/app/affect/semantic-worker.ts')
  const {
    AFFECT_SEMANTIC_SCANNER_PROCESSOR,
    AFFECT_SEMANTIC_WORKER_PROCESSOR,
  } = await import('../src/kernel/contracts/affect-semantic.ts')

  /*
   * 激活程序的第三步（工程选择，随 R-6 记录）：把语义 scanner/worker 水位
   * 预置到切换边界。边界前来源定义上永不语义评估（§24③）——扫描它们只会
   * 产生激活瞬态（长历史上扫描批次 32/跳要啃多轮；期间切换模式会把未发现
   * 语义工作埋进边界——第一跑 live 的实错发现，行为计划一致但读数不确定）。
   * 预置后首个语义 boot 的追赶直接从边界起步，激活读数确定。
   */
  const preadvanceWatermarks = async (boundary: number): Promise<void> => {
    if (boundary <= 0) return
    const scannerWm = await getWatermark(db, characterId, AFFECT_SEMANTIC_SCANNER_NAME, AFFECT_SEMANTIC_SCANNER_PROCESSOR)
    if ((scannerWm?.processedThroughSequence ?? 0) < boundary) {
      await advanceWatermark(db, characterId, AFFECT_SEMANTIC_SCANNER_NAME, AFFECT_SEMANTIC_SCANNER_PROCESSOR, boundary, now)
    }
    const workerWm = await getWatermark(db, characterId, AFFECT_SEMANTIC_WORKER_NAME, AFFECT_SEMANTIC_WORKER_PROCESSOR)
    if ((workerWm?.processedThroughSequence ?? 0) < boundary) {
      await advanceWatermark(db, characterId, AFFECT_SEMANTIC_WORKER_NAME, AFFECT_SEMANTIC_WORKER_PROCESSOR, boundary, now)
    }
  }

  const before = await getAffectProjection(db, characterId)
  const now = Date.now()

  /*
   * 分路 A——副本从未建档（今天的真实生产态：ADR-067 激活后没有真实聊天，
   * ORIGIN 从未播种）：@2 直接播种。这不是降级——WP13 的真实激活将面对的
   * 正是这个初始态；空历史上 A==B 无意义，如实记 vacuous。
   */
  if (before === undefined || !before.state.originated) {
    const { seedAffectOrigin } = await import('../src/infrastructure/runtime/affect-scheduler.ts')
    const seed = await seedAffectOrigin(db, {
      characterId,
      activationId: 'm8.5-live-drill',
      affectReducerVersion: 2,
      now,
    })
    if (seed.kind !== 'seeded' && seed.kind !== 'already') {
      const reading: DrillReading = {
        ok: false,
        reason: `@2 播种失败（${seed.kind}）`,
        path: 'refused',
        before: snapshotOf(before),
        after: null,
        appliedEvents: null,
        cutoverSequence: null,
        aEqualB: false,
        drilledAt: new Date().toISOString(),
      }
      writeFileSync(out, JSON.stringify(reading, null, 2), 'utf8')
      console.error(`演练拒绝：@2 播种失败（${seed.kind}）`)
      process.exit(4)
    }
    const cutover = await markAffectSemanticCutover(db, characterId, now)
    await preadvanceWatermarks(cutover.cutoverSequence)
    const after = await getAffectProjection(db, characterId)
    const ok = cutover.cutoverSequence > 0 && after?.state.originated === true
    const reading: DrillReading = {
      ok,
      reason: ok ? undefined : '播种后边界/建档读数异常',
      path: 'seeded_fresh',
      before: snapshotOf(before),
      after: snapshotOf(after),
      appliedEvents: 0,
      cutoverSequence: cutover.cutoverSequence,
      aEqualB: true,
      drilledAt: new Date().toISOString(),
    }
    writeFileSync(out, JSON.stringify(reading, null, 2), 'utf8')
    console.log(
      `  演练（未建档 ⇒ @2 直接播种）：边界=${String(cutover.cutoverSequence)} · @${String(after?.reducerVersion)}`
    )
    process.exit(ok ? 0 : 4)
  }

  /*
   * 分路 B——副本已建档（真实词形历史存在）：@2 受控重建 + A==B 判据 +
   * 边界推进。A==B 不成立 ⇒ exit 4（不把边界推进建立在重放漂移之上）。
   */
  const rebuild = await rebuildAffectProjectionV2(db, characterId, now)
  const after = await getAffectProjection(db, characterId)
  const aEqualB =
    after !== undefined &&
    after.revision === before.revision &&
    Math.abs(after.state.valence - before.state.valence) < 1e-12 &&
    Math.abs(after.state.arousal - before.state.arousal) < 1e-12 &&
    after.state.lastInteractionAt === before.state.lastInteractionAt

  let cutoverSequence: number | null = null
  if (aEqualB) {
    const cutover = await markAffectSemanticCutover(db, characterId, now)
    cutoverSequence = cutover.cutoverSequence
    await preadvanceWatermarks(cutover.cutoverSequence)
  }

  const reading: DrillReading = {
    ok: aEqualB && cutoverSequence !== null && cutoverSequence > 0,
    reason: aEqualB ? undefined : 'A==B 不成立：@2 重放与 @1 在线投影存在字段漂移——边界不推进',
    path: 'replayed',
    before: snapshotOf(before),
    after: snapshotOf(after),
    appliedEvents: rebuild.appliedEvents,
    cutoverSequence,
    aEqualB,
    drilledAt: new Date().toISOString(),
  }
  writeFileSync(out, JSON.stringify(reading, null, 2), 'utf8')
  console.log(
    `  演练：A==B=${String(aEqualB)} · 折叠事件=${String(rebuild.appliedEvents)} · 边界=${String(cutoverSequence)}`
  )
  process.exit(reading.ok ? 0 : 4)
}

void main()
