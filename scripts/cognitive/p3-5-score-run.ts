/**
 * 认知能力建设 · P3-5b · **判分驱动（正式脚本）** · `pnpm p3:5:score`
 * ============================================================================
 *  把**已归档的逐轮报告**交给冻结判分器 `p3-5-score.ts`，产出 `score.json` + `score-meta.json`。
 *
 *  ```bash
 *  pnpm p3:5:score                                   # 默认：最新一个含 turns/ 的 p3-5 运行目录
 *  pnpm p3:5:score -- --run artifacts/cognitive/local/p3-5-20261028T155501670Z
 *  pnpm p3:5:score -- --run <dir> --out <path>/--meta <path>
 *  ```
 *
 *  ⚠️ **零网络、零模型请求、零数据库**：只读文件 + 纯函数。可用 `p3:5:score:verify` 复算核对。
 *
 *  ⚠️ 两处**只读归一化**（采集侧缺陷的补偿，批记录 §6 逐条披露）：
 *   ① `readPaths` 里混着"绝对路径"与"资料根相对路径"两份写法（同一文件的两种形态）：
 *      采集侧 `library.search` 适配器回的是绝对路径，`local.file.read` 回的是相对路径
 *      ⇒ 判分前把资料根下的绝对路径**机械映射**成相对路径（**只改写法，不改事实**）。
 *   ② 归一化规则有**版本号**（`P3_5_NORMALIZATION_ID`）；规则一改版本就变，复算门据此断言同版本。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareArms,
  computeOverhead,
  contentIdenticalOf,
  mergeRepeats,
  scoreTurn,
  summarizeArm,
  type P3FiveTaskOutcome,
  type P3FiveTurnReport,
  type P3FiveTurnScore,
} from './p3-5-score.ts'

/* ------------------------------------------------------------------------- */
/*  路径与常量                                                                */
/* ------------------------------------------------------------------------- */

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const OUT_ROOT = join(REPO, 'artifacts', 'cognitive', 'local')
const SPEC_PATH = join(REPO, 'docs', 'architecture', 'p3-5-preregistration-20261028', 'task-spec.json')
const SCORER_PATH = join(REPO, 'scripts', 'cognitive', 'p3-5-score.ts')

/** 归一化规则版本（规则一改就换版本；复算门断言版本一致）。 */
export const P3_5_NORMALIZATION_ID = 'p3-5-normalize@1'
export const P3_5_NORMALIZATION_RULE =
  '把 readPaths/citedPaths 里落在 `<runDir>/corpus` 之下的绝对路径机械映射成相对路径；其它路径只做分隔符与 ./ 归一化，不做语义改写。'

interface TaskSpec {
  readonly taskId: string
  readonly kind: string
  readonly goalApplicable?: boolean
  readonly expect: { readonly files: readonly string[], readonly keywordsAnyOf: readonly string[], readonly minKeywords: number }
}
interface RunSummary {
  readonly generatedAt: string
  readonly seal: { readonly digest: string, readonly startMarker: string }
  readonly perArm: readonly {
    readonly arm: 'A' | 'B'
    readonly requests: number
    readonly tokens: number
    readonly elapsedMs: number
    readonly turns: number
    readonly skillLoadSucceededTurns: number
    readonly injectedSkillFingerprints: readonly string[]
  }[]
}

/* ------------------------------------------------------------------------- */
/*  纯函数：路径归一化                                                        */
/* ------------------------------------------------------------------------- */

export function p35NormalizePath(value: string, corpusRoot: string): string {
  const absoluteCorpusRoot = corpusRoot.replace(/\\/g, '/')
  const repoPrefix = REPO.replace(/\\/g, '/')
  /* 相对仓库根的 corpus 路径（用于匹配"容器内绝对路径"的 `/<repo>/<rel>` 形态）。 */
  const relativeCorpusRoot = absoluteCorpusRoot.startsWith(`${repoPrefix}/`)
    ? absoluteCorpusRoot.slice(repoPrefix.length + 1)
    : absoluteCorpusRoot
  let out = value.trim().replace(/\\/g, '/')
  /*
   * 采集侧可能给三种形态：① 宿主绝对路径；② **容器内**绝对路径（`/opt/project-lg/<rel>`）；
   * ③ 已在资料根内的相对路径。三种都映射到 ③。
   */
  for (const prefix of [
    absoluteCorpusRoot,
    `/opt/project-lg/${relativeCorpusRoot}`,
    relativeCorpusRoot,
    `${repoPrefix}/${relativeCorpusRoot}`,
  ]) {
    if (out === prefix) return ''
    if (out.startsWith(`${prefix}/`)) { out = out.slice(prefix.length + 1); break }
  }
  return out.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
}

/* ------------------------------------------------------------------------- */
/*  主计算（供 CLI 与复算门共用）                                              */
/* ------------------------------------------------------------------------- */

export interface P35ScoreOutput {
  readonly score: Record<string, unknown>
  readonly meta: Record<string, unknown>
}

export function computeP35Score(input: { readonly runDir: string }): P35ScoreOutput {
  const runDir = resolve(REPO, input.runDir)
  const turnsDir = join(runDir, 'turns')
  const corpusRoot = `${runDir.replace(/\\/g, '/')}/corpus`
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as { readonly tasks: readonly TaskSpec[] }
  const summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')) as RunSummary

  const rawTurns = readdirSync(turnsDir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => JSON.parse(readFileSync(join(turnsDir, name), 'utf8')) as P3FiveTurnReport & {
      readonly planDiagnostics?: readonly unknown[]
      readonly answerMissing?: boolean
      readonly aborted?: boolean
    })

  const turns = rawTurns.map(turn => ({
    ...turn,
    readPaths: turn.readPaths.map(path => p35NormalizePath(path, corpusRoot)).filter(path => path !== ''),
    citedPaths: turn.citedPaths.map(path => p35NormalizePath(path, corpusRoot)).filter(path => path !== ''),
  }))

  const taskById = new Map(spec.tasks.map(task => [task.taskId, task]))
  const perTurn = turns.map(turn => {
    const task = taskById.get(turn.taskId)
    if (task === undefined) throw new Error(`task-spec 里没有 ${turn.taskId}`)
    return { turn, task, score: scoreTurn(turn, task) as P3FiveTurnScore }
  })

  const taskOutcomes: P3FiveTaskOutcome[] = []
  for (const arm of ['A', 'B'] as const) {
    for (const task of spec.tasks) {
      const picked = perTurn.filter(item => item.turn.arm === arm && item.turn.taskId === task.taskId)
      if (picked.length === 0) continue
      taskOutcomes.push(mergeRepeats(
        arm,
        {
          taskId: task.taskId,
          kind: task.kind,
          ...(task.goalApplicable === undefined ? {} : { goalApplicable: task.goalApplicable }),
        },
        picked.map(item => item.score),
        picked.map(item => item.turn.aborted === true || item.turn.answerMissing === true),
      ))
    }
  }

  const costOf = (arm: 'A' | 'B'): { requests?: number, tokens?: number, elapsedMs?: number } => {
    const row = summary.perArm.find(item => item.arm === arm)
    return row === undefined ? {} : { requests: row.requests, tokens: row.tokens, elapsedMs: row.elapsedMs }
  }
  const armSummaries = [
    summarizeArm('A', taskOutcomes.filter(item => item.arm === 'A'), costOf('A')),
    summarizeArm('B', taskOutcomes.filter(item => item.arm === 'B'), costOf('B')),
  ]

  /* M8（内容层）：两臂**注入过的技能正文指纹集合**是否逐字相同。 */
  const fingerprintsOf = (arm: 'A' | 'B', taskId?: string): readonly string[] =>
    [...new Set(turns
      .filter(turn => turn.arm === arm && (taskId === undefined || turn.taskId === taskId))
      .flatMap(turn => turn.injectedSkillFingerprints))].sort()
  const contentPerTask = spec.tasks.map(task => ({
    taskId: task.taskId,
    a: fingerprintsOf('A', task.taskId),
    b: fingerprintsOf('B', task.taskId),
    identical: contentIdenticalOf(fingerprintsOf('A', task.taskId), fingerprintsOf('B', task.taskId)),
  }))
  const contentIdentical = contentIdenticalOf(fingerprintsOf('A'), fingerprintsOf('B'))

  /* M9（行为层）：逐任务的自主加载率与注入指纹集合。 */
  const m9PerTask = spec.tasks.map(task => {
    const pick = (arm: 'A' | 'B') => turns.filter(turn => turn.arm === arm && turn.taskId === task.taskId)
    const rate = (arm: 'A' | 'B'): string => {
      const rows = pick(arm)
      return rows.length === 0 ? 'unknown' : `${String(rows.filter(turn => turn.skillLoadSucceeded).length)}/${String(rows.length)}`
    }
    return {
      taskId: task.taskId,
      kind: task.kind,
      loadRateA: rate('A'),
      loadRateB: rate('B'),
      loadRateSame: rate('A') === rate('B'),
      fingerprintsA: fingerprintsOf('A', task.taskId),
      fingerprintsB: fingerprintsOf('B', task.taskId),
      sameFingerprintSet: contentIdenticalOf(fingerprintsOf('A', task.taskId), fingerprintsOf('B', task.taskId)),
    }
  })

  const overhead = computeOverhead(costOf('A'), costOf('B'))
  const comparison = compareArms(
    taskOutcomes.filter(item => item.arm === 'A'),
    taskOutcomes.filter(item => item.arm === 'B'),
    { contentIdentical, ...(overhead === 'unknown' ? {} : { overhead }) },
  )

  /* M1（自主加载率）：逐轮实测；分母 = 该臂轮次。 */
  const autoLoadRate = (['A', 'B'] as const).map(arm => {
    const armTurns = turns.filter(turn => turn.arm === arm)
    const loaded = armTurns.filter(turn => turn.skillLoadSucceeded).length
    const relevant = armTurns.filter(turn => taskById.get(turn.taskId)?.kind === 'skill_relevant')
    return {
      arm,
      turns: armTurns.length,
      loaded,
      rate: armTurns.length === 0 ? 'unknown' : loaded / armTurns.length,
      skillRelevantTurns: relevant.length,
      skillRelevantLoaded: relevant.filter(turn => turn.skillLoadSucceeded).length,
    }
  })

  /* 规划失败直方图（真实模型行为；来自运行器写入的 planDiagnostics）。 */
  const planFailureHistogram: Record<string, number> = {}
  for (const turn of rawTurns) {
    for (const item of turn.planDiagnostics ?? []) {
      const diag = item as { ok?: boolean, failure?: string, parseFailureCode?: string }
      if (diag.ok === true) continue
      const key = `${String(diag.failure)}${diag.parseFailureCode === undefined ? '' : `/${diag.parseFailureCode}`}`
      planFailureHistogram[key] = (planFailureHistogram[key] ?? 0) + 1
    }
  }

  const scorerDigest = createHash('sha256').update(readFileSync(SCORER_PATH)).digest('hex')
  const score = {
    schema: 'p3-5-score@1',
    generatedAt: new Date().toISOString(),
    runDir,
    seal: summary.seal,
    normalization: {
      id: P3_5_NORMALIZATION_ID,
      rule: P3_5_NORMALIZATION_RULE,
      corpusRoot,
    },
    scorer: { path: 'scripts/cognitive/p3-5-score.ts', sha256: scorerDigest },
    turns: perTurn.map(item => ({
      turnId: item.turn.turnId,
      arm: item.turn.arm,
      taskId: item.turn.taskId,
      repeat: item.turn.repeat,
      skillLoadSucceeded: item.turn.skillLoadSucceeded,
      aborted: item.turn.aborted === true || item.turn.answerMissing === true,
      normalizedReadPaths: item.turn.readPaths,
      normalizedCitedPaths: item.turn.citedPaths,
      score: item.score,
    })),
    taskOutcomes,
    armSummaries,
    autoLoadRate,
    planFailureHistogram,
    contentPerTask,
    contentIdentical,
    contentFingerprintsAll: { a: fingerprintsOf('A'), b: fingerprintsOf('B') },
    m9PerTask,
    overhead,
    comparison,
  }
  const meta = {
    schema: 'p3-5-score-meta@1',
    generatedAt: score.generatedAt,
    runDir,
    seal: summary.seal,
    normalization: { id: P3_5_NORMALIZATION_ID, rule: P3_5_NORMALIZATION_RULE },
    scorer: { path: 'scripts/cognitive/p3-5-score.ts', sha256: scorerDigest },
    inputs: {
      taskSpec: createHash('sha256').update(readFileSync(SPEC_PATH)).digest('hex'),
      turns: rawTurns.length,
      turnsDir,
      summaryGeneratedAt: summary.generatedAt,
    },
  }
  return { score, meta }
}

/* ------------------------------------------------------------------------- */
/*  CLI                                                                      */
/* ------------------------------------------------------------------------- */

function latestRunDir(): string | undefined {
  if (!statSync(OUT_ROOT).isDirectory()) return undefined
  const candidates = readdirSync(OUT_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('p3-5-'))
    .map(entry => entry.name)
    .filter(name => {
      try { return statSync(join(OUT_ROOT, name, 'turns')).isDirectory() && statSync(join(OUT_ROOT, name, 'summary.json')).isFile() } catch { return false }
    })
    .sort()
  const last = candidates[candidates.length - 1]
  return last === undefined ? undefined : join(OUT_ROOT, last)
}

function argOf(name: string): string | undefined {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

const isMain = process.argv[1] !== undefined && /p3-5-score-run\.(ts|mjs|js)$/.test(process.argv[1].replace(/\\/g, '/'))
if (isMain) {
  const runDirArg = argOf('--run')
  const runDir = runDirArg === undefined ? latestRunDir() : resolve(runDirArg)
  if (runDir === undefined) {
    console.error('找不到可判分的运行目录（需要 turns/ 与 summary.json）；用 --run <dir> 指定。')
    process.exit(2)
  }
  const { score, meta } = computeP35Score({ runDir })
  const outPath = argOf('--out') === undefined ? join(runDir, 'score.json') : resolve(argOf('--out')!)
  const metaPath = argOf('--meta') === undefined ? join(runDir, 'score-meta.json') : resolve(argOf('--meta')!)
  writeFileSync(outPath, `${JSON.stringify(score, null, 2)}\n`, 'utf8')
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

  const comparison = score.comparison as { verdict: string, perTask: readonly { taskId: string, sameOutcome: boolean }[] }
  console.log(`判分完成：${outPath}`)
  console.log(`  runDir      = ${runDir}`)
  console.log(`  normalization = ${P3_5_NORMALIZATION_ID}`)
  console.log(`  scorer      = sha256:${String((score.scorer as { sha256: string }).sha256).slice(0, 16)}…`)
  console.log(`  结论        = ${comparison.verdict}`)
  for (const row of score.armSummaries as readonly { arm: string, tasks: number, achieved: number, unknown: number, aborted: number, requests?: number, tokens?: number }[]) {
    console.log(`  臂 ${row.arm}：任务 ${String(row.tasks)} · 达成 ${String(row.achieved)} · unknown ${String(row.unknown)} · aborted ${String(row.aborted)} · 请求 ${String(row.requests)} · token ${String(row.tokens)}`)
  }
  console.log(`  逐任务一致  = ${comparison.perTask.filter(item => item.sameOutcome).length}/${comparison.perTask.length}`)
}
