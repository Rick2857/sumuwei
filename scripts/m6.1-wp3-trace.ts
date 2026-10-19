/**
 * M6.1 **WP3 程序真相读数器** —— 从既有合成沙箱里读回 trace 步骤。
 *
 * ============================================================================
 *  它回答什么
 * ============================================================================
 * 基线跑完只知道"`--memory-list` 是空的"（**结果**）。要定位就得知道**为什么**：
 * `turn-gateway.ts` 把显式记忆的写入结果记成 trace 步骤 `memory_explicit_write`
 * （`status` + 具名属性），那是程序侧的**权威读数**。
 *
 * WP3 第二轮起它还要回答**"她这一轮实际看见了什么"**（判定契约 §3.1 的第 ③ 套事实）：
 * ```text
 *   context_compile  sections / dropped / estimatedTokens / identityIncluded / rollup_*
 *   memory_recall    candidates / eligible / selected / scanned / droppedByBudget / …
 * ```
 * 两者都在 product 自己的 trace 里，**不需要**打开真实库、**不需要**重跑任何一轮。
 *
 * ⚠️ 它**不重跑任何轮次、不调任何模型**：只打开**既有**的合成沙箱库读 trace。
 * 因此它可以随时重跑，读数稳定。
 *
 * ⚠️ **它能证明什么、不能证明什么**（不许把它读成"逐字上下文"）：
 * ```text
 *   能   这一轮编译出了哪些 section（**名字**）、预算裁剪掉了几个、召回扫了几条 / 选了几条
 *        选中记忆的 **id** 与分数（`decisionRecord`，契约 §3.1 的"无正文"设计）
 *   不能 逐字渲染出来的提示正文 —— trace 里**刻意没有正文**（`observability.ts` 的无泄漏白名单）
 *        ⇒ 用它构造的第 ③ 套事实必须自报"结构性重建"，**不得**写成"逐字重放"
 * ```
 *
 * ⚠️ 数据纪律：trace 属性里**只有**类型与状态（代码注释：异常类型进 trace、**内容不进**），
 * 但本脚本仍把完整读数写进 **gitignored** 的 `artifacts/m6.1/local/<runId>/`，只在终端打摘要。
 *
 * 用法：
 * ```bash
 * pnpm exec tsx scripts/m6.1-wp3-trace.ts --run <runId> [--traces 12]
 * ```
 */

import 'dotenv/config'

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { M6_1_LOCAL_PARENT } from './m6.1-evidence.ts'

const ROOT = resolve(process.cwd())

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

interface StepReadout {
  traceId: string
  kind: string
  label: string
  status: string
  attributes: Record<string, unknown>
}

/** 一轮（= 一条 trace）的"她实际看见了什么"的结构性读数。 */
interface TurnTraceReadout {
  /** 1 起的轮次序号（按 trace `startedAt` 升序 = 时间顺序） */
  order: number
  traceId: string
  startedAt: string
  stepKinds: Record<string, number>
  /** `context_compile` 那一步的属性（`sections` 是**名字**的逗号串） */
  contextCompile: Record<string, unknown> | null
  /** `memory_recall` 那一步的属性（计数 + `decisionRecord`，**无正文**） */
  memoryRecall: Record<string, unknown> | null
  /** 这一轮的显式记忆写入步骤（可能没有 ⇒ `null` 是有意义的读数） */
  explicitWrite: StepReadout | null
  /**
   * WP4 `D-55e` 的**记录状态行**结局（M6.1 WP5 追加）。
   *
   * `outcome` = `included` / `dropped` / `not_generated`；
   * `reason_code` = 那一行说的是哪种事实（`(none)` = 默认缺席句；`not_searched:flag_off` 等）。
   * ⇒ 它回答的正是 WP5 要问的那件事："她编造的那一刻，程序给她的**是不是**'本轮没有依据'。"
   */
  recordStatus: StepReadout | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function main(): Promise<void> {
  const runId = argValue('--run')
  if (runId === undefined || runId === '') {
    throw new Error('必须给 --run <runId>（从 artifacts/m6.1/local/<runId>/sandbox-dir.txt 读沙箱路径）')
  }
  const tracesRaw = argValue('--traces') ?? '12'
  const tracesLimit = Number(tracesRaw)
  if (!Number.isInteger(tracesLimit) || tracesLimit <= 0 || tracesLimit > 200) {
    throw new Error(`--traces 必须是 1..200 的整数（收到 ${String(tracesRaw)}）`)
  }

  const localDir = join(ROOT, M6_1_LOCAL_PARENT, runId)
  const dirFile = join(localDir, 'sandbox-dir.txt')
  if (!existsSync(dirFile)) throw new Error(`缺 ${dirFile} ⇒ 不知道该开哪个沙箱`)
  const dbDir = readFileSync(dirFile, 'utf8').split(/\r?\n/)[0]?.trim() ?? ''
  if (dbDir === '' || !existsSync(dbDir)) throw new Error(`沙箱目录不存在：${JSON.stringify(dbDir)}`)

  /* ---- 失败关闭：绝不允许指向真实库 ---- */
  if (isProductionDir(dbDir)) throw new Error('拒绝：该路径被判成**生产库**')
  if (resolve(dbDir) === resolve(PRODUCTION_DB_DIR)) throw new Error('拒绝：该路径就是真实库')

  /*
   * ⚠️ 两个变量必须在**碰数据库之前**设好（`initDatabase` 的拒绝写真实库闸看它们）；
   *    因此 DB 相关模块一律**动态 import**。
   */
  process.env.PGLITE_DATA_DIR = dbDir
  process.env.PROJECT_LG_SANDBOX = dbDir

  const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')
  
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb } = await import('../src/infrastructure/persistence/db.ts')
  const { createDeveloperQueryService } = await import('../src/infrastructure/dev/query-service.ts')
  const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
  const { entityRef } = await import('../src/kernel/contracts/entity.ts')

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
  const service = createDeveloperQueryService({
    db,
    characterId,
    owner: entityRef('character', String(characterId)),
    runtimeId: 'm6.1-wp3-trace',
  })

  const page = await service.listTraces({ characterId, limit: tracesLimit })
  /*
   * ==========================================================================
   *  ⚠️ **截断闸**（2026-09-24 实测换来的）
   * ==========================================================================
   * 第一版把这个脚本的 `--traces` 缺省写成 12。对一个 **24 轮**的 run 来说，
   * `listTraces({limit:12})` **只**会返回 12 条，而下面的 `ordered` 把它们按时间排序后
   * **重新编号 1..12** —— 于是"第 3 轮"其实是场景的第 15 轮。
   * 这不是"少看了几条"，是**把证据贴到了错的轮次上**（本仓库反复登记的那类形态）。
   *
   * 失败关闭两条：
   *   ① 返回条数**等于**上限 ⇒ 可能还有更多 ⇒ 拒绝（叫调用方把 `--traces` 调大）；
   *   ② 有 `baseline.json` 时，trace 条数必须**等于**它的轮数（跨来源对账，不靠"看起来够"）。
   */
  const baselinePath = join(ROOT, 'artifacts', 'm6.1', runId, 'baseline.json')
  let expectedTurns: number | null = null
  if (existsSync(baselinePath)) {
    const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as { turns?: unknown[] }
    if (Array.isArray(parsed.turns)) expectedTurns = parsed.turns.length
  }
  if (page.items.length >= tracesLimit) {
    throw new Error(
      `MEASUREMENT INVALID：listTraces 返回了 ${String(page.items.length)} 条，**等于** --traces 上限 ` +
        `${String(tracesLimit)} ⇒ 可能被截断（截断后重新编号会把证据贴到错的轮次上）。` +
        '把 --traces 调到明显大于预期轮数再跑。'
    )
  }
  if (expectedTurns !== null && page.items.length !== expectedTurns) {
    throw new Error(
      `MEASUREMENT INVALID：trace 条数 ${String(page.items.length)} ≠ baseline.json 的轮数 ` +
        `${String(expectedTurns)} ⇒ 逐轮对应关系不成立，拒绝出读数`
    )
  }
  const allSteps: StepReadout[] = []
  /** 按时间升序 —— 这是 trace 顺序 → 轮次顺序的**唯一**依据，不靠"列表恰好倒序"的巧合。 */
  const ordered = [...page.items].sort((left, right) =>
    String(left.startedAt).localeCompare(String(right.startedAt))
  )
  const turns: TurnTraceReadout[] = []
  const readout: {
    runId: string
    sandbox: string
    traceCount: number
    note: string
    writeSteps: StepReadout[]
    allSteps: StepReadout[]
    allStepKinds: Record<string, number>
    turns: TurnTraceReadout[]
  } = {
    runId,
    sandbox: dbDir,
    traceCount: page.items.length,
    note:
      '`turns[]` 是"她这一轮实际看见了什么"的**结构性**读数（判定契约 §3.1 第 ③ 套事实）：' +
      'section **名字**、预算裁剪计数、召回计数与选中记忆 **id**。' +
      '⚠️ trace 里**刻意没有**逐字提示正文 ⇒ 用它构造上下文事实时必须自报"结构性重建"。',
    writeSteps: [],
    allSteps,
    allStepKinds: {},
    turns,
  }

  console.log('='.repeat(78))
  console.log('M6.1 WP3 程序真相（只读既有沙箱的 trace；**零模型调用**）')
  console.log('='.repeat(78))
  console.log(`  runId   ${runId}`)
  console.log(`  沙箱    ${dbDir}`)
  console.log(`  trace   ${String(page.items.length)} 条（最多看 ${String(tracesLimit)}）`)
  console.log('')

  for (const [index, item] of ordered.entries()) {
    const detail = await service.getTrace({ characterId, traceId: item.traceId })
    const steps = detail?.found === true ? detail.value.steps : []
    const turn: TurnTraceReadout = {
      order: index + 1,
      traceId: String(item.traceId),
      startedAt: String(item.startedAt),
      stepKinds: {},
      contextCompile: null,
      memoryRecall: null,
      explicitWrite: null,
      recordStatus: null,
    }
    for (const step of steps) {
      const kind = String(step.kind)
      readout.allStepKinds[kind] = (readout.allStepKinds[kind] ?? 0) + 1
      turn.stepKinds[kind] = (turn.stepKinds[kind] ?? 0) + 1
      const attributes = (step.attributes ?? {}) as Record<string, unknown>
      const entry: StepReadout = {
        traceId: String(item.traceId),
        kind,
        label: String(step.label ?? ''),
        status: String(step.status ?? ''),
        attributes,
      }
      allSteps.push(entry)

      if (kind === 'context_compile') turn.contextCompile = asRecord(attributes) ?? {}
      if (kind === 'memory_record_status') turn.recordStatus = entry
      if (kind === 'memory_recall') turn.memoryRecall = asRecord(attributes) ?? {}
      if (kind !== 'memory_explicit_write') continue

      turn.explicitWrite = entry
      readout.writeSteps.push(entry)
      console.log(
        `  trace ${String(item.traceId).slice(-8)} · ${String(step.status ?? '')} · ${String(step.label ?? '')}`
      )
      console.log(`        属性 = ${JSON.stringify(attributes)}`)
    }
    turns.push(turn)

    const sections = String(turn.contextCompile?.sections ?? '(没有 context_compile 步骤)')
    const recordStatus = turn.recordStatus
    const recall = turn.memoryRecall
    console.log(
      `  第 ${String(turn.order)} 轮 · ${String(item.traceId).slice(-8)} · sections=[${sections}]` +
        (recordStatus === null
          ? ' · **没有** memory_record_status 步骤'
          : ` · 状态行=${String(recordStatus.attributes.outcome ?? '?')}` +
            `/${String(recordStatus.attributes.reason_code ?? '(none)')}`) +
        (recall === null
          ? ' · **没有** memory_recall 步骤'
          : ` · 召回 候选=${String(recall.candidates)} 合格=${String(recall.eligible)}` +
            ` 选中=${String(recall.selected)} 扫过=${String(recall.scanned)}` +
            ` 预算裁掉=${String(recall.droppedByBudget)} 达上下文=${String(recall.reachedContext)}`)
    )
  }

  if (readout.writeSteps.length === 0) {
    console.log('  ⚠️ 没有任何 `memory_explicit_write` 步骤 —— 那本身就是读数：')
    console.log('     要么"写入路径根本没被走到"，要么"走了但没记这一步"。见下面的步骤分布。')
  }
  console.log('')
  console.log('  各步骤出现次数：')
  for (const [kind, count] of Object.entries(readout.allStepKinds).sort()) {
    console.log(`    ${kind}: ${String(count)}`)
  }

  /*
   * ---- 计数型自检（M5.1.1 WP1.1 的教训）：0 条 trace 不许打印成"看完了" ----
   */
  if (readout.traceCount === 0 || turns.length === 0) {
    throw new Error(
      `MEASUREMENT INVALID：沙箱里读到 0 条 trace ⇒ 这份读数什么都没量到` +
        `（"0 条"与"全都没问题"在输出上长得一样）`
    )
  }
  const withoutContext = turns.filter((turn) => turn.contextCompile === null).length
  console.log('')
  console.log(
    `  共 ${String(turns.length)} 轮：有 context_compile 的 ${String(turns.length - withoutContext)} 轮，` +
      `缺 context_compile 的 ${String(withoutContext)} 轮（缺 = 那一轮的入模集合**无从结构性重建**）`
  )

  const outPath = join(localDir, 'trace-readout.json')
  writeFileSync(outPath, `${JSON.stringify(readout, null, 2)}\n`, 'utf8')
  console.log('')
  console.log(`  完整读数（gitignored）：${join('artifacts', 'm6.1', 'local', runId, 'trace-readout.json')}`)
}

await main()
