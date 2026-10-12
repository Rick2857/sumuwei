/**
 * INC-01 **全量回归**（`pnpm inc-01:regression:verify`）—— 计划书 §WP6 的 `G8`。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * 按**固定顺序**逐条跑计划书 §WP6 "Final Regression" 列出的命令，并把
 * **每条命令的退出码**落进 `artifacts/incidents/inc-01/regression.json`。
 *
 * ```text
 *   不手写"全绿表格"：退出码是子进程给的，读数是从**已落盘证据**里读的
 *   缺文件 / 环境缺失 ⇒ NOT RUN（明确写理由），**不是** PASS
 *   `inc-01:gates` 在首次真实快照授权之前**按设计**非零 ⇒ 单独归类为 expectedNonZero
 * ```
 *
 * 用法：
 *   pnpm inc-01:regression:verify --list     # 只列出将跑什么（不执行）
 *   pnpm inc-01:regression:verify            # 真的跑（约 30 分钟）
 *
 * ⚠️ 三条接线验证排在最前面：那三个只读真实库 opener 现在走生产状态机，
 *    因此它们各自会**真的**取租约、做 pre-open/post-close verified snapshot。
 *    这是 INC-01 `D1`/`D2` 的要求（真实库同一时刻只允许一个访问者）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { sourceTreeKey } from './gates/cache.ts'
import { decideOfflineReuse } from './gates/reuse.ts'

const ROOT = resolve('.')
const ART = join(ROOT, 'artifacts/incidents/inc-01')

interface RegressionStep {
  id: string
  /** **整条命令字符串**（用 `shell: true` 交给 cmd.exe 解析，见文件头的 ENOENT 说明） */
  cmd: string
  /** 这一条是干什么的 */
  why: string
  /** `false` ⇒ 退出码非零不算失败（例如首次快照授权前的 `inc-01:gates`） */
  expectZero: boolean
  /** 前置文件（缺 ⇒ NOT RUN，不跑） */
  requires?: string
  requiresReason?: string
  /** 已知的、**与本次改动无关**的非零读数（必须逐条说明，不许静默降级） */
  knownNonZeroBecause?: string
}

const steps: RegressionStep[] = [
  {
    id: 'wire-real-db-verify',
    cmd: 'pnpm m4:real-db:verify',
    why: '接线验证：真实库只读验收脚本现在走生产状态机（租约 + 两份 verified snapshot）',
    expectZero: true,
  },
  {
    id: 'wire-state-snapshot',
    cmd: 'pnpm snapshot',
    why: '接线验证：`state_snapshot` 这个 opener 现在也走状态机',
    expectZero: true,
  },
  {
    id: 'wire-phase4b-db-v9',
    cmd: 'pnpm m5.1.1:phase4b:db-v9',
    why: '接线验证：`real_db_verify` 的第二个 opener（只允许 SELECT 的读闸仍在）',
    /*
     * ⚠️ 这条脚本里有两句**当时点**断言：真实库"没有任何一行带 `attribution_origin`"、
     * "全库没有 `MIGRATED_LEGACY`" —— 那是 2026-09-19 v9 迁移刚做完时的事实。
     * 迁移之后，真实库**被合法地**写入了归因数据（M5.1.1 Phase 4 的激活 + 之后的正常对话），
     * 于是这两句不再成立（实测 28 行）。**与 INC-01 的接线无关**：本 WP 只做只读查询。
     * 它是**既有红**，由 M5.1.1 自己的关闭门（`m5.1.1:phase4:closure:verify`，在本清单里）负责裁决；
     * 这里保留它的退出码并**逐条写明**，不静默降级。
     */
    expectZero: false,
    knownNonZeroBecause:
      '该脚本的两句"迁移当时"断言（无 attribution_origin / 无 MIGRATED_LEGACY）在迁移之后不再成立（实测 28 行）；' +
      'INC-01 的接线只做只读查询，不会写这两列。接线证据见其输出里的 8 态状态机 + cleanClose=true。',
  },
  {
    id: 'm4.5-ci',
    cmd: 'pnpm m4.5:ci',
    why: 'M1→M4.5 全部离线门串联（计划书 §WP6 Final Regression）',
    expectZero: true,
  },
  {
    id: 'm4.5-ci-full',
    cmd: 'pnpm with-test-model pnpm m4.5:ci:full',
    why: '再加真实模型档（需要 `.env.test` 的测试端点）',
    expectZero: true,
    requires: '.env.test',
    requiresReason: '缺 `.env.test` ⇒ 包装器会失败关闭（绝不用生产 key 跑测试）',
  },
  { id: 'm5.1-gates', cmd: 'pnpm m5.1:gates', why: 'M5.1 十二道门汇总（只读证据）', expectZero: true },
  {
    id: 'm5.1-regression',
    cmd: 'pnpm m5.1:regression:verify',
    why: 'M5.1 全量回归（读 m4.5:ci 的日志 + 各门 verdict）',
    expectZero: true,
  },
  {
    id: 'm5.1.1-phase4-closure',
    cmd: 'pnpm m5.1.1:phase4:closure:verify',
    why: 'M5.1.1 Phase 4 最终关闭门',
    expectZero: true,
  },
  { id: 'm5.5-gates', cmd: 'pnpm m5.5:gates', why: 'M5.5 门汇总（只读证据）', expectZero: true },
  {
    id: 'm5.5.1-gates',
    cmd: 'pnpm m5.5.1:gates',
    why: 'M5.5.1 门汇总（若本分支没有这条命令 ⇒ 如实 NOT RUN）',
    expectZero: true,
  },
  {
    id: 'inc-01-gates',
    cmd: 'pnpm inc-01:gates',
    why: 'INC-01 门汇总：首次真实快照授权前**按设计**非零（G9 未运行）',
    expectZero: false,
  },
]

const pkgScripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

interface StepReading {
  id: string
  /** 计划书 §WP6 里**冻结的那条命令**（永远照抄，不因复用而改写）。 */
  command: string
  /** 实际执行的命令。只有离线段复用（Tier 1）时才与 `command` 不同。 */
  executedCommand?: string
  why: string
  status: 'PASS' | 'FAIL' | 'NOT RUN' | 'NOT APPLICABLE' | 'EXPECTED NONZERO'
  exitCode: number | null
  seconds: number
  tail: string
  note?: string
  knownNonZeroBecause?: string
  /**
   * Tier 1：`m4.5-ci-full` 复用掉离线段时，如实记下**复用自哪一步**、
   * 以及当时的源码树摘要（判据本身进证据，便于复核"它凭什么复用"）。
   */
  offlineReusedFrom?: string
  sourceTreeKey?: string
  sourceTreeFiles?: number
  reuseNote?: string
}

if (process.argv.includes('--list')) {
  console.log('将按顺序执行：\n')
  for (const step of steps) {
    const scriptName = step.cmd.replace(/^pnpm\s+/, '').split(/\s+/)[0] ?? ''
    const known = scriptName !== 'with-test-model' && !(scriptName in pkgScripts)
    console.log(
      `  ${step.id.padEnd(26)} ${step.cmd}\n` +
        `      ${step.why}${known ? `\n      ⚠️ package.json 里没有 \`${scriptName}\` ⇒ 会记 NOT RUN` : ''}` +
        `${step.requires === undefined ? '' : `\n      需要 ${step.requires}（${String(step.requiresReason)}）`}`
    )
  }
  process.exit(0)
}

/*
 * `--recompute-verdict-only`：**只重算判决**，复用上次记录的退出码。
 *
 * 为什么需要它：改一条**判据**（例如"本分支不存在的命令算不适用"）不该逼着重跑
 * 35 分钟的全量门。退出码是**原始读数**，判决是从读数**派生**的 —— 重算必须在证据里写明。
 */
const recompute = process.argv.includes('--recompute-verdict-only')
const readings: StepReading[] = []
let reusedFrom: string | undefined
if (recompute) {
  const previous = JSON.parse(readFileSync(join(ART, 'regression.json'), 'utf8')) as {
    steps: StepReading[]
    generatedAt?: string
  }
  reusedFrom = previous.generatedAt
  console.log(
    `INC-01 全量回归：**只重算判决**（复用 ${previous.generatedAt ?? '?'} 记录的退出码；**不重跑任何门**）\n`
  )
  for (const recorded of previous.steps) {
    const spec = steps.find((step) => step.id === recorded.id)
    const scriptName = recorded.command.replace(/^pnpm\s+/, '').split(/\s+/)[0] ?? ''
    if (recorded.exitCode === null) {
      // 没有退出码 ⇒ 按**当前**判据重新分类（本分支不存在 vs 环境缺失）
      const missingScript = scriptName !== 'with-test-model' && !(scriptName in pkgScripts)
      const missingRequires = spec?.requires !== undefined && !existsSync(join(ROOT, spec.requires))
      readings.push({
        ...recorded,
        status: missingScript ? 'NOT APPLICABLE' : missingRequires ? 'NOT RUN' : recorded.status,
        ...(missingScript
          ? { note: `package.json 里没有 \`${scriptName}\` 这条脚本（计划书允许：若本分支未提供 ⇒ 如实 NOT RUN）` }
          : {}),
      })
      continue
    }
    const expectZero = spec?.expectZero ?? true
    readings.push({
      ...recorded,
      status: recorded.exitCode === 0 ? 'PASS' : expectZero ? 'FAIL' : 'EXPECTED NONZERO',
    })
  }
} else {
  console.log(`INC-01 全量回归：${steps.length} 条命令，按顺序串行（真实库同一时刻只允许一个访问者）\n`)
}

/*
 * Tier 1（用户 2026-09-22 授权，载体 = 本计划书 §13）：`m4.5:ci:full` 的离线段复用。
 * 这三个变量是"复用的机器判据"的载体：**采到的判据本身要进证据**。
 */
const noReuseOffline = process.argv.includes('--no-reuse-offline')
let offlineKeyAtRun: string | undefined
let offlineFilesAtRun = 0
let offlineStepPassed = false
let offlineReused = false

for (const step of recompute ? [] : steps) {
  const label = step.cmd
  const scriptName = step.cmd.replace(/^pnpm\s+/, '').split(/\s+/)[0] ?? ''
  if (step.requires !== undefined && !existsSync(join(ROOT, step.requires))) {    readings.push({
      id: step.id,
      command: label,
      why: step.why,
      status: 'NOT RUN',
      exitCode: null,
      seconds: 0,
      tail: '',
      note: `缺 ${step.requires}：${String(step.requiresReason)}`,
    })
    console.log(`⏭️  ${step.id.padEnd(26)} NOT RUN（缺 ${step.requires}）`)
    continue
  }
  if (scriptName !== 'with-test-model' && !(scriptName in pkgScripts)) {
    readings.push({
      id: step.id,
      command: label,
      why: step.why,
      /*
       * **不适用** ≠ **未运行**：
       * 计划书对 `m5.5.1:gates` 的原话是"若当前分支已提供该命令；否则如实 NOT RUN" ——
       * 这条命令在本分支**根本不存在**，所以它不是"该跑没跑"，而是"在本分支不适用"。
       * 两者都如实登记，但只有后者会把总判决降成 PARTIAL。
       */
      status: 'NOT APPLICABLE',
      exitCode: null,
      seconds: 0,
      tail: '',
      note: `package.json 里没有 \`${scriptName}\` 这条脚本（计划书允许：若本分支未提供 ⇒ 如实 NOT RUN）`,
    })
    console.log(`⏭️  ${step.id.padEnd(26)} NOT APPLICABLE（package.json 里没有 ${scriptName}）`)
    continue
  }

  /*
   * ---------------------------------------------------------------------
   *  Tier 1：离线段复用
   * ---------------------------------------------------------------------
   *  `pnpm m4.5:ci:full` 的定义就是 `m4.5:ci && m4.5:smoke:live`。本清单里它**紧跟**
   *  在同一条 `pnpm m4.5:ci` 之后 ⇒ 照字面执行会把**同一批离线门在同一棵树上重算
   *  第二遍**（实测 749s，占全量回归 2823s 的 26.5%）。
   *
   *  复用条件（**全部**满足才复用；任一不满足就退回冻结形态）：
   *    ① 上一步 `m4.5:ci` 退出码 0；
   *    ② 现在的源码树摘要与上一步起跑时**逐字相同**（`sourceTreeKey`，覆盖
   *       `src/scripts/evals` + 配置，去掉 `evals/m4/promptfoo/` 这个生成物目录）；
   *    ③ 没有 `--no-reuse-offline`。
   *
   *  为什么"少跑一遍离线门"不改变任何断言：离线链不发起真实模型调用
   *  （`eval:m4:promptfoo` 用的是 `file://../promptfoo-provider.cjs` 确定性 provider），
   *  而 `.env.test` 与 `.env` 的差别只在模型端点 —— 对不发模型请求的门不起作用。
   *  这条等价性写在计划书 §13 里，并且**由条件 ② 的机器判据守着**：
   *  只要有任何一个被覆盖的源码文件变了，复用立刻不成立。
   */
  let executed = step.cmd
  let reuseNote: string | undefined
  let reusedFromStep: string | undefined
  let treeKeyForStep: string | undefined
  let treeFilesForStep: number | undefined

  if (step.id === 'm4.5-ci') {
    const key = sourceTreeKey(ROOT)
    offlineKeyAtRun = key.key
    offlineFilesAtRun = key.files
    treeKeyForStep = key.key
    treeFilesForStep = key.files
    console.log(`  ⌗ 源码树摘要（离线链起跑）：${key.key.slice(0, 16)}…（${key.detail}）`)
  }

  if (step.id === 'm4.5-ci-full') {
    const now = sourceTreeKey(ROOT)
    treeKeyForStep = now.key
    treeFilesForStep = now.files
    // 判定本身是纯函数（scripts/gates/reuse.ts）⇒ 可以被正控/负控/恢复三段式直接测。
    const decision = decideOfflineReuse({
      noReuse: noReuseOffline,
      offlinePassed: offlineStepPassed,
      offlineKeyAtRun,
      currentKey: now.key,
    })
    reuseNote = decision.reason
    if (decision.reuse) {
      executed = 'pnpm with-test-model pnpm m4.5:smoke:live'
      reusedFromStep = 'm4.5-ci'
      offlineReused = true
    }
    console.log(`  ⟳ ${reuseNote}`)
  }

  const startedAt = Date.now()
  /*
   * ⚠️ 两个都踩过的坑，写在这里免得下次再踩：
   *  ① `spawnSync('pnpm', …)` 在 Windows 上直接 **ENOENT** —— Node 不会替你解析 `pnpm.cmd`。
   *     必须 `shell: true`（交给 cmd.exe），并且把命令写成**一整条字符串**。
   *  ② 不用管道捕获输出（`stdio:'pipe'`）：受限模式下捕获孙进程输出会 EPERM，
   *     而且"所有门都 0 秒失败"看起来像全红，其实是**运行器**没跑起来。
   *     所以子进程**继承** stdout（调用方重定向到日志），运行器只记退出码与耗时。
   */
  const child = spawnSync(executed, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    timeout: 3_600_000,
    env: process.env,
  })
  const exitCode = child.status ?? -1
  const spawnError = child.error === undefined ? '' : String((child.error as Error).message ?? child.error)
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  const tail = spawnError === '' ? '（输出已直通调用方日志；读数见该步自己的落盘证据）' : `spawn 失败：${spawnError}`
  if (step.id === 'm4.5-ci') offlineStepPassed = exitCode === 0

  const status: StepReading['status'] =
    exitCode === 0 ? 'PASS' : step.expectZero ? 'FAIL' : 'EXPECTED NONZERO'
  readings.push({
    id: step.id,
    command: label,
    // 实际跑的是哪条命令：只有复用档才会与 `command`（计划书冻结的那条）不同。
    ...(executed === step.cmd ? {} : { executedCommand: executed }),
    why: step.why,
    status,
    exitCode,
    seconds,
    tail,
    ...(reusedFromStep === undefined ? {} : { offlineReusedFrom: reusedFromStep }),
    ...(treeKeyForStep === undefined ? {} : { sourceTreeKey: treeKeyForStep }),
    ...(treeFilesForStep === undefined ? {} : { sourceTreeFiles: treeFilesForStep }),
    ...(reuseNote === undefined ? {} : { reuseNote }),
    ...(spawnError === '' ? {} : { note: spawnError }),
    ...(step.knownNonZeroBecause !== undefined ? { knownNonZeroBecause: step.knownNonZeroBecause } : {}),
  })
  const mark = status === 'PASS' ? '✅' : status === 'EXPECTED NONZERO' ? 'ℹ️ ' : '❌'
  console.log(
    `${mark} ${step.id.padEnd(26)} exit=${exitCode} (${seconds}s)` + (reusedFromStep === undefined ? '' : ' ⟳离线段复用')
  )
  if (status === 'EXPECTED NONZERO' && step.knownNonZeroBecause !== undefined) {
    console.log(`      ℹ️ 已登记的非零理由：${step.knownNonZeroBecause}`)
  }
  if (status === 'FAIL' && spawnError !== '') console.log(`      ⚠️ ${spawnError}`)
}

const failures = readings.filter((reading) => reading.status === 'FAIL')
const notRun = readings.filter((reading) => reading.status === 'NOT RUN')
const notApplicable = readings.filter((reading) => reading.status === 'NOT APPLICABLE')
const verdict = failures.length > 0 ? 'FAIL' : notRun.length > 0 ? 'PARTIAL' : 'PASS'

mkdirSync(ART, { recursive: true })
writeFileSync(
  join(ART, 'regression.json'),
  `${JSON.stringify(
    {
      incident: 'INC-01',
      wp: 'WP6',
      generatedAt: new Date().toISOString(),
      head: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      ...(reusedFrom !== undefined
        ? {
            verdictRecomputedAt: new Date().toISOString(),
            verdictRecomputedFrom: reusedFrom,
            verdictRecomputedNote:
              '本次只重算判决：退出码复用上面记录的原始读数，**没有重跑任何门**。',
          }
        : {}),
      verdict,
      /*
       * Tier 1 的复用事实：**必须进证据**，不许只留在 stdout 里。
       * 判据（树摘要）也一并记下 —— 下一个人要能复核"它凭什么复用"。
       */
      offlineReuse: {
        enabled: !noReuseOffline,
        reused: offlineReused,
        offlineKeyAtRun,
        offlineFilesAtRun,
        rule:
          '`m4.5:ci:full` = `m4.5:ci && m4.5:smoke:live`；当且仅当上一步 m4.5:ci 退出码 0、' +
          '且源码树摘要（src/scripts/evals + 配置，去掉 evals/m4/promptfoo/ 生成物）逐字未变、' +
          '且未传 --no-reuse-offline 时，第二步只跑 m4.5:smoke:live；否则退回冻结形态。',
        authorization: '用户 2026-09-22「Tier1–4 全部启用」；载体 = 本计划书 §13 附录。',
        escapeHatch: 'pnpm inc-01:regression:verify --no-reuse-offline（回到计划书原样的两条命令）',
      },
      steps: readings,
      totals: {
        steps: readings.length,
        failed: failures.length,
        notRun: notRun.length,
        notApplicable: notApplicable.length,
      },
      note:
        '`inc-01:gates` 在首次真实快照（G9）授权之前**按设计**非零：未运行 G8/G9。' +
        '口令是子进程实测退出码；读数取自各自落盘证据。' +
        '`NOT APPLICABLE` = 该命令在本分支不存在（计划书允许如实 NOT RUN），**不**降级总判决；' +
        '`NOT RUN` = 该跑但环境缺失，会把判决降成 PARTIAL。',
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(
  `\nINC-01 全量回归：${verdict}（${readings.length} 条；失败 ${failures.length}，未运行 ${notRun.length}，` +
    `本分支不适用 ${notApplicable.length}）`
)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  ❌ ${failure.id}: exit=${String(failure.exitCode)} ${failure.tail}`)
}
if (notRun.length > 0) {
  for (const skipped of notRun) console.log(`  ⏭️  ${skipped.id}: ${String(skipped.note)}`)
}
if (notApplicable.length > 0) {
  for (const skipped of notApplicable) console.log(`  ⏭️  ${skipped.id}: ${String(skipped.note)}`)
}
console.log(
  `\n离线段复用：${offlineReused ? '**已启用**（第二步只跑 m4.5:smoke:live）' : '未启用（按冻结形态跑完整 m4.5:ci:full）'}` +
    (noReuseOffline ? '（--no-reuse-offline）' : '')
)
console.log('证据：artifacts/incidents/inc-01/regression.json')
process.exitCode = verdict === 'PASS' ? 0 : 1
