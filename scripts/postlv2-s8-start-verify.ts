/**
 * S8 / **`L-S8-30` + `ADR-107` `R-2a′``** —— **显式开局入口门**（`pnpm postlv2:s8:start:verify`）。
 *
 * ============================================================================
 *  它守什么（`L-S8-30` 的"入口侧"那一半）
 * ============================================================================
 * 立案事实：`StoryCognition.ingestChoice` 在生产里**没有任何调用者** ⇒ `storyline_commits`
 * 永远 0 行 ⇒ 消费回路每次都是"无可消费项"（`docs/post-lv2/S8-Consumption-Entry-Gap.md`）。
 * 本门守的是**第一条提交由谁写**：`D02.2①` 的"用户**显式开始**的活跃 run"。
 *
 * ```text
 * S1 正控：`story:start <runId>` ⇒ 退出 0，账本里**恰好一条** STORY_STARTED @ revision 1，
 *          绑定**逐字**是 system（actorKind/system · 无 interactionRef · 无 anchor）· 无 choiceId
 * S2 幂等：同一 runId 重复 start ⇒ 退出 0，账本**不新增**第二条
 * S3 负控（`D02.4` 单用户单 run）：已有活跃 run 时 start 另一个 runId ⇒ 具名拒收 + **零副作用**
 * S4 负控（形状失败关闭）：未知选项 / 缺 runId / 含空白 / 超长 ⇒ 具名 `code` + 零副作用
 * S5 恢复：把活跃 run 走到**终局** ⇒ 同一个 start 命令**又能成功**（证明 S3 的拒是条件造成的）
 * S6 装配在场（**不作为主张**）：`main.ts` 派发 + `package.json` 脚本 + `invocation.ts` 分类
 * S7 非零分母：`measured_count > 0`（AGENTS §6.8）
 * S8 隔离：本门跑在 `isolateDatabase()` 的一次性沙箱里，真实库路径从未被打开
 * ```
 *
 * ⚠️ **S6 为什么不是主张**（`ADR-107` §2.5(1) / `R-4c`）：文本锁测不到"入口有没有被真的调用"
 * —— 那正是 `L-S8-30` 立案的形状。本门的**主张**只挂在 S1–S5 的**账本读数**上；
 * S6 只回答"装配还在不在"。
 *
 * ⚠️ 本门**零模型 / 零出网 / 零真实库**：全部走隔离库 + 离线调用。
 */

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

const REPO_ROOT = resolve(process.cwd())
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8')
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
  measured: number
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string, measured: number): void => {
  checks.push({ id, label, pass, detail, measured })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

const sandbox = isolateDatabase('postlv2-s8-start', { keep: false })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness, M4_T0 } = await import('./m4-harness.ts')
const { createStoryLedgerStore } = await import(
  '../src/infrastructure/storyline/store/story-ledger-store.ts'
)
const { commitStoryTurn } = await import('../src/kernel/app/storyline/commit-service.ts')
const { activeStoryRunOf, storyRunStatusesOf } = await import(
  '../src/kernel/app/storyline/run-lifecycle.ts'
)
const { runStoryStartCommand } = await import(
  '../src/infrastructure/runtime/story-start-command.ts'
)
const { parseStoryStartArgs, STORY_START_IDEMPOTENCY_KEY_PREFIX } = await import(
  '../src/kernel/app/storyline/admin.ts'
)
const { JICHUANG_PACK } = await import(
  '../src/content/storyline/jichuang-interview-two/story-pack.ts'
)

let clock = M4_T0
const h = await createM4Harness({ label: 'postlv2-s8-start' })
const db = h.db
const ledger = createStoryLedgerStore(db)
const characterId = h.kernel.characterId

/** 驱动**真实命令体**（与 CLI 走的是同一个函数）；返回退出码。 */
const startCommand = (argv: readonly string[]): Promise<number> =>
  runStoryStartCommand({ db, characterId, argv, now: () => (clock += 1000) })

/** 账本一行（**主张的唯一来源**；不复述命令打印了什么）。 */
interface LedgerRow {
  runId: string
  revision: number
  eventType: string
  actorKind: string
  interactionKind: string
  interactionRef?: string
  anchor?: string
  choiceId?: string
  idempotencyKey: string
}

const commitsOf = async (): Promise<readonly LedgerRow[]> => {
  const runIds = await ledger.listRuns(JICHUANG_PACK.storyId)
  const rows: LedgerRow[] = []
  for (const runId of runIds) {
    for (const commit of await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId })) {
      rows.push({
        runId: commit.runId,
        revision: commit.revision,
        eventType: String(commit.eventType),
        actorKind: String(commit.binding.actorKind),
        interactionKind: String(commit.binding.interactionKind),
        ...(commit.binding.interactionRef === undefined ? {} : { interactionRef: commit.binding.interactionRef }),
        ...(commit.binding.anchorConversationEventId === undefined
          ? {}
          : { anchor: commit.binding.anchorConversationEventId }),
        ...(commit.choiceId === undefined ? {} : { choiceId: commit.choiceId }),
        idempotencyKey: commit.idempotencyKey,
      })
    }
  }
  return rows
}

/* ---------------------------------------------------------------- S1 正控 */
const RUN_A = 's8-start-a'
const codeA1 = await startCommand([RUN_A, '--yes'])
const rowsA1 = await commitsOf()
const firstA = rowsA1.find((row) => row.runId === RUN_A && row.revision === 1)
record(
  'S1',
  '【正控】**真实命令体**开局 ⇒ 退出 0，账本**恰好一条** STORY_STARTED @ revision 1，绑定逐字是 system、无 choiceId',
  codeA1 === 0 &&
    rowsA1.length === 1 &&
    firstA !== undefined &&
    firstA.eventType === 'STORY_STARTED' &&
    firstA.actorKind === 'system' &&
    firstA.interactionKind === 'system' &&
    firstA.interactionRef === undefined &&
    firstA.anchor === undefined &&
    firstA.choiceId === undefined,
  `exit=${String(codeA1)} · 账本 ${String(rowsA1.length)} 行 · ` +
    `event=${String(firstA?.eventType)} rev=${String(firstA?.revision)} actor=${String(firstA?.actorKind)} ` +
    `kind=${String(firstA?.interactionKind)} ref=${String(firstA?.interactionRef)} anchor=${String(firstA?.anchor)} choice=${String(firstA?.choiceId)}`,
  rowsA1.length,
)

/* -------------------------------------------------------------- S2 幂等 */
const codeA2 = await startCommand([RUN_A, '--yes'])
const rowsA2 = await commitsOf()
record(
  'S2',
  '【幂等】同一 runId 重复 start ⇒ 退出 0，账本**不新增**第二条（runId 是身份，不能复用成第二次开局）',
  codeA2 === 0 && rowsA2.length === 1 && rowsA2[0]?.idempotencyKey === `story-start:${RUN_A}`,
  `exit=${String(codeA2)} · 账本 ${String(rowsA2.length)} 行 · key=${String(rowsA2[0]?.idempotencyKey)}`,
  rowsA2.length,
)
record(
  'S2b',
  '【键形状】开局幂等键是 `story-start:<runId>`，**不**与选择提交的 `story-commit:<runId>:r<rev>:<anchor>` 同族',
  rowsA2[0]?.idempotencyKey === `${STORY_START_IDEMPOTENCY_KEY_PREFIX}${RUN_A}` &&
    !String(rowsA2[0]?.idempotencyKey).startsWith('story-commit:'),
  `key=${String(rowsA2[0]?.idempotencyKey)} · prefix=${STORY_START_IDEMPOTENCY_KEY_PREFIX}`,
  1,
)

/* --------------------------------- S3 负控：单活跃 run ⇒ 拒收且零副作用 */
const RUN_B = 's8-start-b'
const codeB1 = await startCommand([RUN_B, '--yes'])
const rowsB1 = await commitsOf()
const activeNow = await activeStoryRunOf({ ledger, pack: JICHUANG_PACK })
record(
  'S3',
  '【负控·`D02.4` 单用户单 run】已有活跃 run 时 start 另一个 runId ⇒ 退出 1，且账本**一行都不多**（零副作用）',
  codeB1 === 1 && rowsB1.length === 1 && rowsB1.every((row) => row.runId === RUN_A) && activeNow?.runId === RUN_A,
  `exit=${String(codeB1)} · 账本 ${String(rowsB1.length)} 行 · 活跃=${String(activeNow?.runId)} · 出现 b 行=${String(rowsB1.some((row) => row.runId === RUN_B))}`,
  rowsB1.length,
)

/* ------------------------------------------- S4 负控：形状失败关闭（逐条具名） */
const shapeCases: readonly { argv: string[]; code: string; note: string }[] = [
  { argv: ['--nope', 'x'], code: 'story_start_unknown_flag', note: '未知选项' },
  { argv: [], code: 'story_start_run_id_missing', note: '缺 runId' },
  { argv: ['a b'], code: 'story_start_run_id_has_whitespace', note: '含空白（会污染幂等键）' },
  { argv: [RUN_A, RUN_B], code: 'story_start_too_many_args', note: '多了位置参数' },
  { argv: ['x'.repeat(129)], code: 'story_start_run_id_too_long', note: '超长' },
  { argv: [RUN_A], code: 'story_start_confirmation_missing', note: '缺显式授权（CI-4）' },
]
const shapeReadings: string[] = []
let shapeOk = true
for (const item of shapeCases) {
  const parsed = parseStoryStartArgs(item.argv)
  const code = parsed.ok ? '(被接受——不对)' : parsed.code
  const exitCode = await startCommand(item.argv)
  const ok = !parsed.ok && parsed.code === item.code && exitCode === 2
  if (!ok) shapeOk = false
  shapeReadings.push(`${item.note}⇒${code}/exit${String(exitCode)}`)
}
const rowsB2 = await commitsOf()
record(
  'S4',
  '【负控·形状失败关闭】五类非法入参各自给**具名 code** + 退出 2，且账本全程**零副作用**',
  shapeOk && rowsB2.length === 1,
  `${shapeReadings.join(' · ')} · 账本仍 ${String(rowsB2.length)} 行`,
  shapeCases.length,
)

/* ------------------------------------------------- S5 恢复：走到终局后又能开局 */
const exitOutcome = await commitStoryTurn({
  ledger,
  request: {
    pack: JICHUANG_PACK,
    runId: RUN_A,
    binding: { interactionKind: 'system', actorKind: 'system' },
    idempotencyKey: `story-exit:${RUN_A}`,
    action: { kind: 'exit', expectedRevision: 1 },
    now: (clock += 1000),
  },
})
const statusesAfterExit = await storyRunStatusesOf({ ledger, pack: JICHUANG_PACK })
const activeAfterExit = await activeStoryRunOf({ ledger, pack: JICHUANG_PACK })
const codeB3 = await startCommand([RUN_B, '--yes'])
const rowsB3 = await commitsOf()
const bStart = rowsB3.find((row) => row.runId === RUN_B && row.revision === 1)
record(
  'S5',
  '【恢复】把活跃 run 走到**终局**（RUN_EXITED）⇒ 同一个 start 命令**又能成功**（S3 的拒是"有活跃 run"这个条件造成的，不是门坏了）',
  exitOutcome.ok === true &&
    statusesAfterExit.some((status) => status.runId === RUN_A && status.terminal && status.folded) &&
    activeAfterExit === undefined &&
    codeB3 === 0 &&
    bStart !== undefined &&
    bStart.eventType === 'STORY_STARTED' &&
    bStart.actorKind === 'system',
  `exit 提交=${String(exitOutcome.ok)} · run_a 终局=${
    statusesAfterExit.find((status) => status.runId === RUN_A)?.terminal ?? 'n/a'
  } · 恢复前活跃=${String(activeAfterExit?.runId)} · start b exit=${String(codeB3)} · 账本 ${String(rowsB3.length)} 行`,
  rowsB3.length,
)

/* --------------------------------- S6 装配在场（**不作为主张**，见文件头） */
const mainText = read('src/main.ts')
const invocationText = read('src/invocation.ts')
const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
const wiring = {
  dispatch: /argv\.includes\('--story-start'\)/.test(mainText),
  invokes: /runStoryStartCommand\(\{/.test(mainText),
  classified: /'--story-start'/.test(invocationText),
  script: pkg.scripts?.['story:start'] === 'tsx src/main.ts --story-start',
}
record(
  'S6',
  '【装配在场·**不作为主张**】`main.ts` 派发 + `invocation.ts` 分类 + `package.json` 脚本都在（文本锁；它测不到"入口有没有被真的调用"）',
  Object.values(wiring).every((value) => value === true),
  JSON.stringify(wiring),
  1,
)

/* -------------------------------------------------- S7/S8 非零分母 + 隔离 */
record(
  'S7',
  '【非零分母】本门确实量了东西（`measured_count` 由每条的 `measured` 求和，且 > 0）',
  checks.reduce((sum, check) => sum + check.measured, 0) > 0,
  `measured_count=${String(checks.reduce((sum, check) => sum + check.measured, 0))}`,
  1,
)
const sandboxIsReal =
  process.env.PROJECT_LG_SANDBOX !== undefined &&
  (process.env.PGLITE_DATA_DIR ?? '').includes('project-lg-exp-') &&
  process.env.PROJECT_LG_ALLOW_PRODUCTION_DB !== '1'
record(
  'S8',
  '【隔离】本门跑在 `isolateDatabase()` 的一次性沙箱里；`PROJECT_LG_ALLOW_PRODUCTION_DB` **未**被设置',
  sandboxIsReal,
  `PROJECT_LG_SANDBOX=${String(process.env.PROJECT_LG_SANDBOX)} · PGLITE_DATA_DIR=${String(process.env.PGLITE_DATA_DIR)} · allowProd=${String(process.env.PROJECT_LG_ALLOW_PRODUCTION_DB)}`,
  1,
)

/* ------------------------------------------------------------------ 落盘 */
const failedChecks = checks.filter((check) => !check.pass)
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const passed = failedChecks.length === 0 && measuredCount > 0

let head = ''
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-s8-start-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:start:verify',
  milestone: 'post-lv2 / S8 / `L-S8-30` 入口侧（`ADR-107` `R-2a′`）',
  generatedAt: new Date().toISOString(),
  source: { head },
  isolation: { sandboxDir: sandbox.dir, note: '`isolateDatabase()` 一次性沙箱；`data/pglite` 从不被打开' },
  modelCalls: { real: 0, note: '本门不调模型：开局是程序提交（system 绑定），与模型提案无关' },
  contractFingerprints: {
    admin: sha256(read('src/kernel/app/storyline/admin.ts')),
    runLifecycle: sha256(read('src/kernel/app/storyline/run-lifecycle.ts')),
    startCommand: sha256(read('src/infrastructure/runtime/story-start-command.ts')),
    storyLedger: sha256(read('src/kernel/storyline/story-ledger.ts')),
  },
  /** ⚠️ 主张只挂在 S1–S5 的**账本读数**上；S6 是装配在场检查，**不**构成主张（`R-4c`） */
  claimBasis: ['S1', 'S2', 'S2b', 'S3', 'S4', 'S5'],
  notCovered: [
    '`ingestChoice` 的**生产**调用者（消费侧入口）：仍未接线 —— 本门只证明"第一条提交有人写"',
    '每轮消费点的调度（`R-3b`）：未做（现状仍只在 `open()` 补扫一次）',
    '端到端的"入口缺席负控"（`R-4c` 的三段式）：**未做**',
    '真实库迁移与激活：`R-2a′` 已不需要新迁移；激活是独立裁定',
  ],
  checks,
  measuredCount,
  verdict: passed ? 'PASS' : 'FAIL',
}

writeFileSync(join(outDir, 's8-start-verify.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  measured_count = ${String(measuredCount)}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:start:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-start-verify.json`)

await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
