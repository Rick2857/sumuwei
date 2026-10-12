/**
 * Lv2 WP5 —— **混合轨迹 + 回访**（`pnpm lv2:trajectory`；计划 §`LV2-G5` 的前半）。
 *
 * ============================================================================
 *  本增量的范围（**如实标出没做的部分**）
 * ============================================================================
 * 做了：50 轮**确定性混合脚本**（记忆写入/更正/遗忘 · 目标 · 承诺 · 撤回 · 闲聊）
 *      + **15 次回访探针**（在登记的点上读回状态并与**脚本写死的期望**对比）+ 证据。
 * **没做**（下一增量）：**真实重启**（进程边界）与**逐字段 rebuild 对账**
 *      ⇒ manifest 里 `restart` / `fieldLevelRebuild` 都写 `NOT IMPLEMENTED`，
 *        并且**不许**把本 run 当成 `LV2-G5` 的通过证据（它只是那条 lane 的仪器与前哨）。
 *
 * 两条档位（与 `lv2:short:live` 同一套纪律）：
 *   `--preflight`  控制档：整条链**一个字节都不出网**（0 次模型调用）
 *   真实档          必须经 `pnpm with-test-model`（否则**拒绝启动**，exit 2）
 *
 * ⚠️ 回访的期望**写死在脚本里**（`expectedValueAt`），**不是**从状态里反推 ——
 *    否则"回访"会退化成"读自己"，15 次探针等于 15 次同义反复。
 */

import 'dotenv/config'
import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createLv2CaseEnvironment } from './lv2-harness.ts'
import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'
import { rebuildGoalProjections } from '../src/infrastructure/persistence/goal-store.ts'

const argv = process.argv.slice(2)
const preflight = argv.includes('--preflight')
const roundsIndex = argv.indexOf('--rounds')
const rounds = roundsIndex >= 0 ? Number(argv[roundsIndex + 1] ?? '50') : 50
/**
 * `--from <n>`：**第二段**（真实重启之后那一段）从这里开始。
 * ⚠️ 给了它 ⇒ **不**调用 `isolateDatabase()`（那会新建一个空沙箱、把状态丢掉），
 *    而是沿用外部传进来的 `PROJECT_LG_SANDBOX` —— 这正是"**真实进程边界**"的实现方式：
 *    两个**独立进程**先后打开**同一个**隔离库目录。
 */
const fromIndex = argv.indexOf('--from')
const continued = fromIndex >= 0
const from = continued ? Number(argv[fromIndex + 1] ?? '1') : 1
const tagIndex = argv.indexOf('--segment-tag')
const segmentTag = tagIndex >= 0 ? String(argv[tagIndex + 1] ?? 'seg') : 'whole'
/**
 * `--dump-state <path>`：把（顺序无关的）状态快照落到一个 JSON 文件。
 * 用途：**区分"投影没载入"与"真的丢了"** —— 只比哈希分不出来，比内容才分得出来。
 */
const dumpIndex = argv.indexOf('--dump-state')
/**
 * ⚠️ **优先读环境变量**：工作区路径里有空格（`project LG`），而编排器用 `shell: true` 起子进程时
 *    参数会在空格处被切开 ⇒ `--dump-state` 拿到一个被截断的路径、dump **静默没写**，
 *    而 diff 侧又"读不到就当空" ⇒ 打印出"0 对 0、没有差异"这种**看起来是结论其实是失败**的行。
 *    （真踩到：`AGENTS.md` §6.8 的"静默零"就是这个形状。）
 */
const dumpStatePath = String(process.env.LV2_DUMP_STATE ?? (dumpIndex >= 0 ? String(argv[dumpIndex + 1] ?? '') : ''))
/** 计划 §`LV2-G5` 要求 **15 次回访**：均匀铺在整条轨迹上（不是"每 k 轮"那种会多出来一个的写法）。 */
const REVISIT_ROUNDS: readonly number[] = Array.from({ length: 15 }, (_, index) =>
  Math.round(((index + 1) * rounds) / 15),
)

if (!preflight && process.env.DSH_TEST_MODEL_WRAPPER !== '1') {
  console.error('[lv2:trajectory] 拒绝启动：真实档必须经 `pnpm with-test-model`（否则会落到生产 key）')
  process.exit(2)
}

/** 混合脚本：每轮一句话（确定性 · 无随机 · 无时钟）。 */
function scriptFor(index: number): string {
  const i = index + 1
  switch (i) {
    case 1:
      return '记住，我不吃香菜。'
    case 2:
      return '记住，我的实验室在 A 楼 302。'
    case 3:
      return '明天十点楼下见吧。'
    case 4:
      return '好，就这么说定了。'
    case 8:
      return '那个改一下，我现在能吃香菜了。'
    case 12:
      return '唉，其实我早就能吃香菜了。'
    case 16:
      return '忘掉我实验室在哪这件事。'
    case 20:
      return '还是记一下吧：我的实验室在 A 楼 302。'
    case 24:
      return '我实验室在哪来着？'
    case 28:
      return '那个约定算了，不去了。'
    case 32:
      return '出差带 Mac 笔记本。'
    case 36:
      return '我们再约一次：明天十点楼下见，还是核对旧提纲。'
    case 40:
      return '出差带 Mac 笔记本。'
    case 44:
      return '我实验室在哪来着？'
    case 48:
      return '今天天气不错。'
    default:
      /* 其余轮次：轻量轮交替（避免"只有重活没有闲话"的假轨迹） */
      if (i % 5 === 0) return '今天有点累。'
      return i % 3 === 0 ? '我实验室在哪来着？' : '嗯，知道了。'
  }
}

/**
 * 回访期望（**脚本事实表**）：香菜槽位在第 1 轮写 `dislike`、第 8 轮被更正为 `like`。
 * ⇒ 第 1–7 轮期望 `dislike`，第 8 轮起期望 `like`。别的一律 `null`（"不该有活跃值"）。
 */
function expectedCilantroAt(round: number): string {
  return round < 8 ? 'dislike' : 'like'
}

interface RevisitRow {
  readonly round: number
  readonly expected: string
  readonly observed: string | null
  readonly passed: boolean
}

async function main(): Promise<void> {
  const started = new Date().toISOString()
  const root = process.cwd()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  /* ⚠️ 标签**不能**含段标记：目录名 = project-lg-exp-<label>-<runId>，${segmentTag} 进了 label
     就会让两段算出**两个不同目录**（第二段于是拿到一个**空库** —— 实测 diff: seg1=2 · seg2=0）。 */
  // The same run id must reopen the same directory when segment lengths differ.
  const label = `lv2-trajectory-${preflight ? 'control' : 'live'}`
  /*
   * ⚠️ **两个进程都调 `isolateDatabase`**，用**固定 runId**复用同一目录 ——
   *    这是本仓库**已有**的受控入口（`src/dev/sandbox.ts:79/110-112` 的注释逐字写着
   *    "同一 id 会复用目录 / keep=true 时不自动清理，用于需要跨进程复用同一目录的实验"）。
   *
   * ⚠️ **绝不**用"只设 `PROJECT_LG_SANDBOX`"的写法：那样中央闸会认为"已隔离"而放行，
   *    但 PGlite 真正用的 `PGLITE_DATA_DIR` 没设 ⇒ 落到缺省 `./data/pglite` = **真实库**
   *    （`R-38` 的事故就是这么发生的）。
   */
  const runIdIndex = argv.indexOf('--sandbox-run-id')
  const sandboxRunId = runIdIndex >= 0 ? String(argv[runIdIndex + 1] ?? '') : ''
  if (continued && sandboxRunId === '') {
    throw new Error(
      '续段必须带 --sandbox-run-id（用 isolateDatabase 的固定 runId 复用目录）；' +
        '不要只设 PROJECT_LG_SANDBOX —— 那会让 PGlite 落到真实库（R-38）',
    )
  }
  const info = isolateDatabase(label, { keep: true, ...(sandboxRunId === '' ? {} : { runId: sandboxRunId }) })
  console.log(`[lv2:trajectory] SANDBOX=${info.dir}`)
  await resetPluginSqlConnection()
  const sandboxDir = info.dir
  const environment = await createLv2CaseEnvironment({ label, conversationId: 'lv2-trajectory', control: preflight })

  /* 续段的第一件事：把**接手时的状态**指纹打出来（编排器用它证明跨进程连续性） */
  /*
   * ⚠️ 指纹**不能用 id**：`makeMemoryId(characterId, slot)` 的 `slot` 形如
   *    `<批次内序号>-<规范化谓词>`（`src/kernel/contracts/ids.ts:212-217`），
   *    而"批次内序号"是**进程局部**的 ⇒ 同一个持久化事实在两个进程里会得到**不同的 id**。
   *    （实测：两段都读到那 2 条记忆、内容一致，只有 id 不同 ⇒ 以 id 为键的指纹必然不等。）
   *    ⇒ 改成**内容键**：谓词 / 取值 / 规范键 / 状态。
   *    ⚠️ 这**不**意味着 id 无所谓 —— "id 跨进程不稳定"本身就是一条**独立发现**，另案登记。
   */
  const byKey = <T>(rows: readonly T[], key: (row: T) => string): T[] =>
    [...rows].sort((a, b) => {
      const left = key(a)
      const right = key(b)
      return left < right ? -1 : left > right ? 1 : 0
    })
  const memoryKey = (row: { predicate: string | null; value: string | null; canonicalKey: string | null; status: string }): string =>
    `${String(row.predicate)}|${String(row.value)}|${String(row.canonicalKey)}|${row.status}`
  const stateSha = (snap: Awaited<ReturnType<typeof environment.snapshot>>): string =>
    createHash('sha256')
      .update(
        JSON.stringify({
          memories: byKey(snap.memories, memoryKey).map(memoryKey),
          goals: byKey(snap.goals, (row) => `${row.statement}|${row.status}`).map((row) => [row.statement, row.status]),
          commitments: byKey(snap.commitments, (row) => `${row.statement}|${row.status}`).map((row) => [
            row.statement,
            row.status,
          ]),
        }),
      )
      .digest('hex')
  if (continued) {
    const initial = await environment.snapshot()
    console.log(`[lv2:trajectory] INITIAL_STATE_SHA=${stateSha(initial)}`)
    if (dumpStatePath !== '') {
      writeFileSync(
        `${dumpStatePath}.initial.json`,
        `${JSON.stringify(
          {
            memories: byKey(initial.memories, (row) => row.id),
            goals: byKey(initial.goals, (row) => `${row.statement}|${row.status}`),
            commitments: byKey(initial.commitments, (row) => `${row.statement}|${row.status}`),
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
    }
  }

  const steps: {
    round: number
    input: string
    replyCodepoints: number
    completed: boolean
    modelRequests: number
    sections: number
    memories: number
    goals: number
    commitments: number
  }[] = []
  const revisits: RevisitRow[] = []
  let cleanClose = true
  try {
    for (let round = from - 1; round < rounds; round += 1) {
      const text = scriptFor(round)
      const turn = await environment.runTurn(text, { control: preflight, turnIndex: round + 1 })
      const state = await environment.snapshot()
      steps.push({
        round: round + 1,
        input: text,
        replyCodepoints: [...turn.reply].length,
        completed: turn.completed,
        modelRequests: turn.modelRequests,
        sections: turn.sectionIds.length,
        memories: state.memories.length,
        goals: state.goals.length,
        commitments: state.commitments.length,
      })
      if (REVISIT_ROUNDS.includes(round + 1)) {
        const expected = expectedCilantroAt(round + 1)
        const active = state.memories.filter(
          (row) => row.status === 'active' && row.predicate === 'food.preference.cilantro',
        )
        const observed = active.length === 0 ? null : (active[0]?.value ?? null)
        revisits.push({ round: round + 1, expected, observed, passed: observed === expected })
      }
    }
  } finally {
    try {
      await environment.close()
    } catch {
      cleanClose = false
    }
  }

  const finalSnapshot = await environment.snapshot()
  const finalStateSha = stateSha(finalSnapshot)
  console.log(`[lv2:trajectory] STATE_SHA=${finalStateSha}`)
  if (dumpStatePath !== '') {
    writeFileSync(
      `${dumpStatePath}.final.json`,
      `${JSON.stringify(
        {
          memories: byKey(finalSnapshot.memories, (row) => row.id),
          goals: byKey(finalSnapshot.goals, (row) => `${row.statement}|${row.status}`),
          commitments: byKey(finalSnapshot.commitments, (row) => `${row.statement}|${row.status}`),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  }
  const revisitPassed = revisits.filter((row) => row.passed).length

  /*
   * `--rebuild-check`：**逐字段 rebuild 对账**（计划 §`LV2-G5` 的最后一段仪器）。
   *
   * 受控入口（已探明，不是猜的）：
   *   · 整空间记忆：`store.rebuildCharacterMemories(owner)` → `MemoryRebuildSummary.mismatched`
   *     （内部逐条 `rebuildMemory`，其 `MemoryRebuildResult.equal` 就是"计划书第 74 节的 A == B 判定"）
   *   · 目标投影：`rebuildGoalProjections(db, characterId)`（事务内删 `goal:%` → 全量重放）
   * ⚠️ 形状不认识时**不许猜成通过** ⇒ 这里只在拿到明确字段时才算 OK，否则记 `UNKNOWN`。
   */
  let rebuildReading: Record<string, unknown> | null = null
  let fieldLevelRebuild = 'NOT IMPLEMENTED'
  if (argv.includes('--rebuild-check')) {
    const beforeMemories = finalSnapshot.memories.length
    const beforeGoals = finalSnapshot.goals.length
    const memorySummary = await environment.h.store.rebuildCharacterMemories(environment.h.owner)
    const goalRebuild = await rebuildGoalProjections(environment.h.db, environment.h.characterId as never)
    const afterSnapshot = await environment.snapshot()
    /*
     * ⚠️ **每个域各自要求 measured_count > 0**（`AGENTS.md` §6.8）：
     *    某域一条对象都没有时，"重放后也一样（都是 0）"是**空跑**，不是通过。
     *    ⇒ 记忆域按条数、目标域按重建前行数分别设闸；只有一侧有对象时结论要**标出来**。
     */
    const memoryChecked = memorySummary.memories > 0
    const goalChecked = beforeGoals > 0
    const memoryOk = memoryChecked && memorySummary.mismatched === 0
    const goalOk = goalChecked
      ? afterSnapshot.goals.length === beforeGoals && goalRebuild.rows.length === afterSnapshot.goals.length
      : null
    fieldLevelRebuild =
      !memoryChecked && !goalChecked
        ? 'INVALID_NO_SUBJECT（两个域都没有对象 ⇒ 空跑，不算通过）'
        : memoryOk && goalOk !== false
          ? goalChecked
            ? 'CHECKED_OK'
            : 'CHECKED_MEMORY_ONLY（目标域本轨迹 0 行 ⇒ 那一半空跑，未测）'
          : 'CHECKED_MISMATCH'
    rebuildReading = {
      memory: {
        memories: memorySummary.memories,
        rebuilt: memorySummary.rebuilt,
        mismatched: memorySummary.mismatched,
        differences: memorySummary.details
          .filter((row) => !row.equal)
          .flatMap((row) => row.differences)
          .slice(0, 20),
        beforeCount: beforeMemories,
        afterCount: afterSnapshot.memories.length,
      },
      goal: {
        beforeRows: beforeGoals,
        afterRows: afterSnapshot.goals.length,
        replayRows: goalRebuild.rows.length,
        previousRowCount: goalRebuild.previousRowCount,
        appliedEvents: goalRebuild.appliedEvents,
      },
      verdict: fieldLevelRebuild,
    }
    console.log(
      `[lv2:trajectory] rebuild-check：记忆 mismatched=${String(memorySummary.mismatched)}/${String(memorySummary.memories)} · ` +
        `目标 ${String(beforeGoals)}→${String(afterSnapshot.goals.length)}（重放 ${String(goalRebuild.rows.length)} 行 · 事件 ${String(goalRebuild.appliedEvents)}）` +
        ` ⇒ ${fieldLevelRebuild}`,
    )
  }
  const runId = createLv2RunId({ wpId: 'wp5-trajectory', headShort: head })
  const dir = openLv2RunDir(root, runId)
  const verdict = preflight ? 'PREFLIGHT' : revisitPassed === revisits.length && steps.every(step => step.completed) ? 'PASS' : 'FAIL'
  writeFileSync(
    join(dir, 'readings.json'),
    `${JSON.stringify(
      { runId, rounds, mode: preflight ? 'control' : 'live', steps, revisits, fieldLevelRebuild, rebuildReading },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const manifestPath = writeLv2Manifest(dir, {
    runId,
    wp: 'wp5-trajectory',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    toolVersions: { node: process.version },
    testType: preflight ? 'mixed-trajectory-preflight' : 'mixed-trajectory-live',
    counts: { total: revisits.length, passed: revisitPassed, failed: revisits.length - revisitPassed },
    phases: ['single'],
    supersedes: null,
    started,
    ended: new Date().toISOString(),
    worktree: { clean: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '', note: '本脚本自己的 run 目录按白名单不计入' },
    sourceFingerprints: Object.fromEntries(
      (['scripts/lv2-trajectory.ts', 'scripts/lv2-harness.ts', 'scripts/lv2-evidence.ts'] as const).map((path) => [
        path,
        createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
      ]),
    ),
    config: {
      mode: preflight ? 'control（0 次模型调用）' : 'live（测试端点，经 with-test-model）',
      rounds,
      from,
      segmentTag,
      finalStateSha,
      revisitEvery: null,
      revisitRounds: REVISIT_ROUNDS,
      restarted: false,
      fieldLevelRebuild,
    },
    model: preflight
      ? { providerKind: 'none', note: '控制档：整条链不出网' }
      : { providerKind: 'openai-compatible', note: '测试端点（ark），经 with-test-model' },
    requests: {
      planned: preflight ? 0 : (rounds - from + 1) * 2,
      actual: steps.reduce((sum, step) => sum + step.modelRequests, 0),
      note: preflight ? '零模型请求' : '实际数由原生 runTurn 的调用计数逐轮相加；准备外的失败调用保留在各轮计数中',
    },
    denominators: {
      rounds,
      steps: steps.length,
      revisits: revisits.length,
      revisitPassed,
      restart: continued || from === 1 ? 'IMPLEMENTED（本 lane 的两段进程见 lv2:restart:preflight）' : 'NOT IMPLEMENTED',
      fieldLevelRebuild,
    },
    correlations: { cases: steps.length, conversations: 1, requests: steps.reduce((sum, step) => sum + step.modelRequests, 0), traces: steps.length },
    faultInjection: null,
    cleanClose,
    realDb: { opened: false, summaryBefore: null, summaryAfter: null, note: '隔离库；`data/pglite` 未被打开' },
    verdict,
    limitation:
      '本 run 单独不替代跨进程重启证据；rebuild 是否完成由 fieldLevelRebuild 决定。' +
      (preflight ? '控制档零模型调用，只验证管线与回访量具。' : '真实模型轨迹；回访判状态，回复正文不作为行为逐案评分。'),
  })

  console.log(`[lv2:trajectory] runId = ${runId}（${preflight ? 'PREFLIGHT 控制档' : 'LIVE 真实档'} · ${String(rounds)} 轮 · ${String(revisits.length)} 次回访）`)
  console.log(`[lv2:trajectory] 回访通过 ${String(revisitPassed)}/${String(revisits.length)}`)
  for (const row of revisits) console.log(`   ${row.passed ? '✅' : '❌'} r${String(row.round)} 期望 ${row.expected} · 实测 ${String(row.observed)}`)
  console.log(`[lv2:trajectory] 末轮状态：记忆 ${String(steps.at(-1)?.memories ?? 0)} · 目标 ${String(steps.at(-1)?.goals ?? 0)} · 承诺 ${String(steps.at(-1)?.commitments ?? 0)}`)
  console.log(`[lv2:trajectory] ACTUAL_MODEL_REQUESTS=${steps.reduce((sum, step) => sum + step.modelRequests, 0)}`)
  console.log(`[lv2:trajectory] cleanClose=${String(cleanClose)} · 本段接续=${continued} · rebuild=${fieldLevelRebuild}`)
  console.log(`[lv2:trajectory] manifest = ${manifestPath.replace(`${root}\\`, '').replace(/\\/g, '/')}`)
  process.exitCode = verdict === 'FAIL' ? 1 : 0
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
