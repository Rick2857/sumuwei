/**
 * INC-01 **WP4 门** —— 生产状态机与 incident hold（`AT4.1`…`AT4.5`）。
 *
 * 用法：`node_modules\.bin\tsx scripts/verify-inc-01-wp4.ts`
 *
 * ============================================================================
 *  它判什么（逐条对应计划书 §WP4 的 Atomic Tasks / Hard Tests）
 * ============================================================================
 * ```text
 *  A  AT4.1  中央强制闸：真实库 + 放行 + **无 token** ⇒ 抛（只设那个环境变量不再足够）
 *  B  AT4.2  真实打开前必须走完 LEASED → PREOPEN_SNAPSHOT_VERIFIED（失败 ⇒ 源一次都没开）
 *  C  AT4.3  只有 closed=true（两条读数都为 true）才做 post-close 晋升
 *  D  AT4.4  incident hold 四要素：code / 源摘要 / 最后 verified snapshot / dry-run 指令
 *  E  AT4.5  cleanClose 只在干净释放时写；上一次未干净是**诊断事实**，不是因果断言
 *  F  Hard Tests：第二进程在任何 PGlite 构造前被拒；pre-open 失败源摘要不变 + source-open=0
 *  G  接线真相：`src/db/index.ts` 的闸在 `registerPlugin` **之前**且只能"问"不能"给"
 * ```
 *
 * ============================================================================
 *  两条纪律
 * ============================================================================
 * 1. **不打开真实库、不运行真实快照/恢复**：所有 fixture 都在 `%TEMP%`，
 *    状态机全部用注入依赖驱动；真实 `data/pglite` 只做只读内容树摘要（前后逐字比对）。
 * 2. **量具自证**：每个 detector 都报 `measured_count`；"检查了 0 项"⇒ `MEASUREMENT INVALID`。
 *    三段式（正控安静 → 负控必响 → 恢复安静）见 K1/K2/K3。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { stripComments } from './text-scan.ts'
import { WP0_REAL_DB_NONVOLATILE, measureRealDbDrift } from './inc-01-real-db-drift.ts'

import {
  digestTree,
  ownerRecordPath,
  readOwnerRecord,
  type OwnerRecord,
  type SnapshotFailure,
  type SnapshotResult,
} from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  PRODUCTION_INCIDENT_CODES,
  PRODUCTION_OPEN_STATES,
  ProductionOpenGuardError,
  __resetPreopenTokensForTest,
  hasPreopenToken,
  lastVerifiedSnapshotId,
  prepareProductionOpen,
  previousOwnerRecord,
  type ProductionOpenDeps,
  type ProductionOpenHandle,
} from '../src/infrastructure/persistence/production-open-guard.ts'

const TSX_CLI = resolve('node_modules/tsx/dist/cli.mjs')
const CHILD = resolve('scripts/inc-01-lease-child.ts')
const REAL_DB = resolve('data/pglite')

// ---------------------------------------------------------------------------
// 输出 / 断言
// ---------------------------------------------------------------------------

interface Check {
  id: string
  desc: string
  pass: boolean
  reading: string
}
const checks: Check[] = []
let failed = 0
function check(id: string, desc: string, pass: boolean, reading: string): void {
  checks.push({ id, desc, pass, reading })
  if (!pass) failed += 1
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}\n        ${reading}`)
}

const root = mkdtempSync(join(tmpdir(), 'inc01-wp4-'))
console.log(`fixture root: ${root}\n`)

/*
 * 真实库的**只读**内容树摘要，取在门的最开头。
 * 末尾再取一次 ⇒ "本门有没有碰真库"是**同一轮内**的前后比对（这才是本门能判的东西）。
 * 与 WP0 冻结常量的关系则是另一回事（见 T2 的漂移登记）：
 * 她的库是**会被合法打开的**（用户每聊一次都会改 `pg_control`/WAL），
 * 所以"永远等于 WP0 基线"不能当判据，而"漂移有没有据"可以。
 */
const realDbBefore = digestTree(REAL_DB)

const incidentCodesSeen = new Set<string>()
const children: ChildProcess[] = []

/** 计数注入点（spy）：用来证明"某一步到底有没有被调用" */
class Spy {
  calls = 0
  async run(): Promise<void> {
    this.calls += 1
  }
}

const releases: { cleanClose: boolean; detail: string }[] = []
/** 门内所有 owner record 一律写到 `%TEMP%`（**绝不**污染工作区的取证目录） */
const defaultOwnerRecordDir = mkdtempSync(join(root, 'owner-records-'))

interface ScenarioOptions {
  dataDir: string
  snapshotRoot: string
  preOpen: SnapshotResult
  postClose?: SnapshotResult
  openThrows?: Error
  closed?: boolean
  /** **真的**在 snapshotRoot 下落目录 + manifest（用来断言"快照被保留"与 AT4.4 的 id 扫描） */
  materializePreOpen?: string
  operationKind?: 'chat' | 'migrate'
  ownerRecordDir?: string
  /** 收尾时再调一次 `finish()`（断言幂等） */
  finishTwice?: boolean
}

interface ScenarioResult {
  ran: boolean
  code?: string
  states: readonly string[]
  sourceOpens?: number
  cleanClose?: boolean
  preOpenSnapshotId?: string
  postCloseSnapshotId?: string
  previousUncleanExit?: OwnerRecord
  lastVerifiedSnapshotIdInHold?: string
  restoreDryRunCommand?: string
  openCalls: number
  stopCalls: number
  closeCalls: number
  releaseCalls: number
  secondFinishCode?: string
  tokenAfterFinish: boolean
  detail?: string
}

/**
 * 跑一次状态机（**全部依赖注入**，因此碰不到任何真实库）。
 *
 * `finishMode` 决定收尾形态：
 *   · `'self'`            —— 由状态机自己 stop/close（门内注入 spy）
 *   · `'afterClose'`      —— 模拟生产：WP3 的唯一收尾路径已经做过 stop/close
 *   · `'finishBeforeOpen'`—— 故意在 `open()` **之前**收尾（断言状态机不可跳过）
 */
async function runScenario(
  options: ScenarioOptions,
  finishMode: 'self' | 'afterClose' | 'finishBeforeOpen' = 'self'
): Promise<ScenarioResult> {
  const open = new Spy()
  const stop = new Spy()
  const close = new Spy()
  const result: ScenarioResult = {
    ran: false,
    states: [],
    openCalls: 0,
    stopCalls: 0,
    closeCalls: 0,
    releaseCalls: 0,
    tokenAfterFinish: false,
  }

  const deps: ProductionOpenDeps = {
    openDatabase: async () => {
      await open.run()
      if (options.openThrows !== undefined) throw options.openThrows
    },
    stopServices: () => stop.run(),
    closeDatabase: () => close.run(),
    isDatabaseClosed: () => options.closed === true,
    createSnapshot: async (request) => {
      if (request.kind === 'pre-open') {
        if (options.preOpen.ok && options.materializePreOpen !== undefined) {
          const id = options.preOpen.snapshotId ?? 'pre'
          mkdirSync(join(options.materializePreOpen, `pglite-${id}`), { recursive: true })
          writeFileSync(join(options.materializePreOpen, `pglite-${id}`, 'marker.txt'), 'x\n', 'utf8')
          // `INC01-D3` 的顺序：先 rename 出目录，**最后**才写 manifest
          writeFileSync(join(options.materializePreOpen, `pglite-${id}.manifest.json`), '{}\n', 'utf8')
        }
        return options.preOpen
      }
      return options.postClose ?? { ok: true, snapshotId: 'post-default' }
    },
    /*
     * AT4.4 的"最后一份 verified snapshot"用**生产实现**去扫快照根，
     * 而不是让门自己编一个 id —— 否则这条读数就是自己证明自己。
     */
    lastVerifiedSnapshotId: () => lastVerifiedSnapshotId(options.snapshotRoot),
    /*
     * 释放走**真实**的 `lease.release()`：它会 ① 写 owner record（AT4.5 的证据）
     * ② 关掉 named pipe 的 server。用纯 spy 替掉它会留下绑着的管道，
     * 于是门跑完进程都不退出（而且 owner record 根本不写）。
     * 记录一份读数用于断言，同时 owner record 目录一律指向 `%TEMP%`。
     */
    releaseLease: async (lease, input) => {
      releases.push(input)
      await lease.release(input)
    },
    ownerRecordDir: options.ownerRecordDir ?? defaultOwnerRecordDir,
  }

  let handle: ProductionOpenHandle | undefined
  try {
    handle = await prepareProductionOpen({
      dataDir: options.dataDir,
      snapshotRoot: options.snapshotRoot,
      operationKind: options.operationKind ?? 'chat',
      deps,
    })
    result.ran = true
    result.preOpenSnapshotId = handle.reading.preOpenSnapshotId
    result.previousUncleanExit = handle.reading.previousUncleanExit
    if (finishMode === 'finishBeforeOpen') {
      // 必须抛 `db_open_failed`：状态机不允许被跳过
      await handle.finish({ closed: true })
    } else {
      await handle.open()
      if (finishMode === 'self') {
        await handle.finish({ closed: options.closed === true })
      } else if (finishMode === 'afterClose') {
        await handle.finish({ closed: options.closed === true, afterClose: true })
      }
    }
  } catch (error) {
    if (error instanceof ProductionOpenGuardError) {
      result.code = error.hold.code
      result.states = error.reading.states
      result.sourceOpens = error.reading.sourceOpens
      result.cleanClose = error.reading.cleanClose
      result.previousUncleanExit = error.reading.previousUncleanExit ?? result.previousUncleanExit
      result.lastVerifiedSnapshotIdInHold = error.hold.lastVerifiedSnapshotId
      result.restoreDryRunCommand = error.hold.restoreDryRunCommand
      incidentCodesSeen.add(error.hold.code)
      result.detail = `${error.hold.code}: ${error.hold.detail}`
    } else {
      result.detail = `非 guard 错误：${error instanceof Error ? error.message : String(error)}`
    }
    /*
     * 收尾**失败之后**再调一次 `finish()`：不能拿一个已经放掉的租约去写第二次 owner record。
     */
    if (options.finishTwice === true && handle !== undefined) {
      try {
        const again = await handle.finish({ closed: options.closed === true })
        result.secondFinishCode = again.states.at(-1) ?? 'no-state'
      } catch (error) {
        result.secondFinishCode =
          error instanceof ProductionOpenGuardError ? error.hold.code : 'non-guard-error'
      }
    }
  }

  if (result.code === undefined && handle !== undefined) {
    result.states = handle.reading.states
    result.cleanClose = handle.reading.cleanClose
    result.sourceOpens = handle.reading.sourceOpens
    result.postCloseSnapshotId = handle.reading.postCloseSnapshotId
  }
  result.openCalls = open.calls
  result.stopCalls = stop.calls
  result.closeCalls = close.calls
  result.releaseCalls = releases.length
  result.tokenAfterFinish = handle === undefined ? false : hasPreopenToken(options.dataDir)
  return result
}

// ---------------------------------------------------------------------------
// A. AT4.1 中央强制闸（纯策略）
// ---------------------------------------------------------------------------

const {
  productionOpenDecision,
  productionOpenDenialMessage,
  assertDatabaseAccessAllowed,
} = await import('../src/db/index.ts')
type ProductionOpenDenial = 'missing_production_allowance' | 'missing_preopen_token'

interface DecisionCase {
  name: string
  input: { dataDir: string | undefined; allowFlag: boolean; isolated: boolean; tokenPresent: boolean }
  allowed: boolean
  denial?: ProductionOpenDenial
}

const decisionCases: DecisionCase[] = [
  {
    name: '非真实库目录（%TEMP% 副本）',
    input: { dataDir: join(root, 'copy'), allowFlag: false, isolated: false, tokenPresent: false },
    allowed: true,
  },
  {
    name: '未指定 dataDir（适配器默认）',
    input: { dataDir: undefined, allowFlag: false, isolated: false, tokenPresent: false },
    allowed: true,
  },
  {
    name: '已 isolate 到沙箱',
    input: { dataDir: REAL_DB, allowFlag: false, isolated: true, tokenPresent: false },
    allowed: true,
  },
  {
    name: '真实库 + 未放行',
    input: { dataDir: REAL_DB, allowFlag: false, isolated: false, tokenPresent: false },
    allowed: false,
    denial: 'missing_production_allowance',
  },
  {
    name: '真实库 + 放行 + **无 token**（AT4.1 的核心）',
    input: { dataDir: REAL_DB, allowFlag: true, isolated: false, tokenPresent: false },
    allowed: false,
    denial: 'missing_preopen_token',
  },
  {
    name: '真实库 + 放行 + 有 token',
    input: { dataDir: REAL_DB, allowFlag: true, isolated: false, tokenPresent: true },
    allowed: true,
  },
]

let decisionMismatch = 0
const decisionReadings: string[] = []
for (const item of decisionCases) {
  const actual = productionOpenDecision(item.input)
  const ok = actual.allowed === item.allowed && actual.denial === item.denial
  if (!ok) decisionMismatch += 1
  decisionReadings.push(
    `${item.name} ⇒ ${actual.allowed ? 'allow' : `deny(${String(actual.denial)})`}${ok ? '' : ' ← 不符'}`
  )
}
check(
  'A1',
  '真实库判据真值表：只有"放行 + 本进程 token"才放行；副本/沙箱不受影响',
  decisionMismatch === 0 && decisionCases.length > 0,
  `measured=${decisionCases.length} mismatch=${decisionMismatch} :: ${decisionReadings.join(' | ')}`
)

// K1/K2/K3：三段式（正控安静 → 负控必响 → 恢复安静）
const envBefore = {
  dataDir: process.env.PGLITE_DATA_DIR,
  allow: process.env.PROJECT_LG_ALLOW_PRODUCTION_DB,
  sandbox: process.env.PROJECT_LG_SANDBOX,
}
let k1Pass = false
let k2Pass = false
let k3Pass = false
let k2Reading = '（未走到）'
let k2Message = ''
try {
  process.env.PGLITE_DATA_DIR = REAL_DB
  process.env.PROJECT_LG_ALLOW_PRODUCTION_DB = '1'
  delete process.env.PROJECT_LG_SANDBOX

  try {
    assertDatabaseAccessAllowed(() => true)
    k1Pass = true
  } catch (error) {
    k2Reading = `正控意外抛错：${error instanceof Error ? error.message : String(error)}`
  }

  try {
    assertDatabaseAccessAllowed(() => false)
    k2Reading = '负控**没有**抛错（BUG：无 token 也能打开真实库）'
  } catch (error) {
    k2Message = error instanceof Error ? error.message : String(error)
    k2Pass = true
    k2Reading = k2Message.split('\n')[0] ?? k2Message
  }

  try {
    assertDatabaseAccessAllowed(() => true)
    k3Pass = true
  } catch (error) {
    k3Pass = false
    k2Reading = `恢复后仍抛错：${error instanceof Error ? error.message : String(error)}`
  }
} finally {
  for (const [key, value] of [
    ['PGLITE_DATA_DIR', envBefore.dataDir],
    ['PROJECT_LG_ALLOW_PRODUCTION_DB', envBefore.allow],
    ['PROJECT_LG_SANDBOX', envBefore.sandbox],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

check(
  'K1',
  '【正控】真实库 + 放行 + token ⇒ 闸**安静**',
  k1Pass,
  `assertDatabaseAccessAllowed(() => true) 未抛错 = ${String(k1Pass)}`
)
check(
  'K2',
  '【负控】真实库 + 放行 + **无 token** ⇒ 闸**必须响**（"只设那个环境变量"不再足够）',
  k2Pass,
  k2Reading
)
check(
  'K3',
  '【恢复】把 token 放回 ⇒ 闸**重新安静**（检测器不是"永远响"）',
  k3Pass,
  `恢复后未抛错 = ${String(k3Pass)}`
)

// AT4.4：incident hold 的四要素必须都在文案里
const holdText = productionOpenDenialMessage('missing_preopen_token', REAL_DB)
const holdElements = {
  incidentCode: holdText.includes('missing_preopen_token'),
  incidentCodeMarker: holdText.includes('[incident code]'),
  lastVerifiedSnapshot: holdText.includes('最后 verified snapshot'),
  dryRunCommand: holdText.includes('pnpm db:restore --from') && !holdText.includes('--apply'),
  noAutoRepair: holdText.includes('不删 postmaster.pid'),
}
check(
  'A2',
  'AT4.4：拒绝文案给出 incident code / 最后 verified snapshot / **dry-run** 恢复指令，且明确不自动修',
  Object.values(holdElements).every(Boolean) && k2Message.length > 0,
  `${JSON.stringify(holdElements)}（负控消息实测长度 ${k2Message.length}）`
)

// ---------------------------------------------------------------------------
// B. 状态机（注入依赖，%TEMP% fixture）
// ---------------------------------------------------------------------------

const okPre = (id: string): SnapshotResult => ({ ok: true, snapshotId: id })
const failPre = (failure: SnapshotFailure, detail: string): SnapshotResult => ({
  ok: false,
  failure,
  detail,
})

const canonical = PRODUCTION_OPEN_STATES.join(' → ')

// B1 成功路径（自收尾）
__resetPreopenTokensForTest()
releases.length = 0
const b1Dir = mkdtempSync(join(root, 'b1-data-'))
const b1Snap = mkdtempSync(join(root, 'b1-snap-'))
const b1 = await runScenario(
  {
    dataDir: b1Dir,
    snapshotRoot: b1Snap,
    preOpen: okPre('pre-b1'),
    postClose: okPre('post-b1'),
    closed: true,
  },
  'self'
)
check(
  'B1',
  '成功路径走完 8 态，cleanClose=true，两份 verified snapshot 都被记录，源只被打开一次',
  b1.ran &&
    b1.states.join(' → ') === canonical &&
    b1.cleanClose === true &&
    b1.sourceOpens === 1 &&
    b1.preOpenSnapshotId === 'pre-b1' &&
    b1.postCloseSnapshotId === 'post-b1' &&
    b1.openCalls === 1 &&
    b1.stopCalls === 1 &&
    b1.closeCalls === 1,
  `states=${b1.states.join('→')} cleanClose=${String(b1.cleanClose)} sourceOpens=${String(b1.sourceOpens)} open=${b1.openCalls} stop=${b1.stopCalls} close=${b1.closeCalls} pre=${String(b1.preOpenSnapshotId)} post=${String(b1.postCloseSnapshotId)}`
)
check(
  'B2',
  'AT4.1/AT4.3：收尾后 token 被撤销（下一次打开必须重走状态机）',
  b1.tokenAfterFinish === false && !hasPreopenToken(b1Dir),
  `tokenAfterFinish=${String(b1.tokenAfterFinish)}`
)

// B3 finish() 在 open() 之前 ⇒ 状态机不可跳过
__resetPreopenTokensForTest()
const b3Dir = mkdtempSync(join(root, 'b3-data-'))
const b3Snap = mkdtempSync(join(root, 'b3-snap-'))
const b3 = await runScenario(
  { dataDir: b3Dir, snapshotRoot: b3Snap, preOpen: okPre('pre-b3') },
  'finishBeforeOpen'
)
check(
  'B3',
  '跳过打开步骤就不可能收尾（`finish()` 在 `open()` 之前 ⇒ db_open_failed，源从未被开）',
  b3.ran && b3.code === 'db_open_failed' && b3.sourceOpens === 0 && b3.openCalls === 0,
  `code=${String(b3.code)} sourceOpens=${String(b3.sourceOpens)} openCalls=${b3.openCalls} detail=${String(b3.detail)}`
)

// B4 pre-open 验证失败（注入坏库）⇒ 源摘要不变 + source-open = 0
__resetPreopenTokensForTest()
releases.length = 0
const b4Dir = mkdtempSync(join(root, 'b4-data-'))
writeFileSync(join(b4Dir, 'data.txt'), 'unchanged\n', 'utf8')
const b4Snap = mkdtempSync(join(root, 'b4-snap-'))
const b4Before = digestTree(b4Dir)
const b4 = await runScenario({
  dataDir: b4Dir,
  snapshotRoot: b4Snap,
  preOpen: failPre('snapshot_health_failed', '注入：健康探针失败'),
})
const b4After = digestTree(b4Dir)
const b4Releases = [...releases]
check(
  'B4',
  'AT4.2 Hard Test：pre-open 注入坏库 ⇒ INCIDENT_HOLD、**PGlite source-open = 0**、源摘要逐字不变',
  b4.code === 'preopen_verify_failed' &&
    b4.sourceOpens === 0 &&
    b4.openCalls === 0 &&
    b4Before.treeSha256 === b4After.treeSha256 &&
    b4Before.measuredCount > 0,
  `code=${String(b4.code)} sourceOpens=${String(b4.sourceOpens)} openCalls=${b4.openCalls} digest ${b4Before.treeSha256.slice(0, 12)}…(${b4Before.measuredCount} 文件) → ${b4After.treeSha256.slice(0, 12)}…`
)
check(
  'B5',
  'AT4.2：pre-open 失败也要**放掉租约**（否则"修好再重试"会先被自己的锁挡住），且 cleanClose=false',
  b4Releases.length === 1 &&
    b4Releases[0]?.cleanClose === false &&
    b4Releases[0]?.detail === 'PREOPEN_VERIFY_FAILED',
  `releases=${JSON.stringify(b4Releases)}`
)

// B6 打开失败 ⇒ 尝试关闭 + pre-open 快照**保留** + 不做 post-close 晋升
__resetPreopenTokensForTest()
releases.length = 0
const b6Dir = mkdtempSync(join(root, 'b6-data-'))
const b6Snap = mkdtempSync(join(root, 'b6-snap-'))
const b6 = await runScenario({
  dataDir: b6Dir,
  snapshotRoot: b6Snap,
  preOpen: okPre('pre-b6'),
  materializePreOpen: b6Snap,
  openThrows: new Error('注入：adapter 构造失败'),
  closed: false,
})
const b6PreOpenDirExists = existsSync(join(b6Snap, 'pglite-pre-b6'))
const b6PostDirs = readdirSync(b6Snap).filter((name) => name.startsWith('pglite-post'))
check(
  'B7',
  'DB OPEN/INIT FAILED ⇒ 非零 + **尝试关闭** + pre-open 快照保留 + 不做 post-close 晋升',
  b6.code === 'db_open_failed' &&
    b6.closeCalls === 1 &&
    b6PreOpenDirExists &&
    b6PostDirs.length === 0 &&
    b6.releaseCalls === 1,
  `code=${String(b6.code)} closeCalls=${b6.closeCalls} preOpenKept=${String(b6PreOpenDirExists)} postCloseDirs=${JSON.stringify(b6PostDirs)} releaseCalls=${b6.releaseCalls}`
)

// B8 closed != true ⇒ 不做 post-close 晋升
__resetPreopenTokensForTest()
releases.length = 0
const b8Dir = mkdtempSync(join(root, 'b8-data-'))
const b8Snap = mkdtempSync(join(root, 'b8-snap-'))
const b8 = await runScenario({
  dataDir: b8Dir,
  snapshotRoot: b8Snap,
  preOpen: okPre('pre-b8'),
  materializePreOpen: b8Snap,
  closed: false,
})
const b8PostDirs = readdirSync(b8Snap).filter((name) => name.startsWith('pglite-post'))
check(
  'B8',
  'DB CLOSE NOT VERIFIED ⇒ 非零、**不**做 post-close 晋升、不写 cleanClose',
  b8.code === 'db_close_not_verified' &&
    b8PostDirs.length === 0 &&
    b8.cleanClose === false &&
    b8.releaseCalls === 1,
  `code=${String(b8.code)} postCloseDirs=${JSON.stringify(b8PostDirs)} cleanClose=${String(b8.cleanClose)} releaseCalls=${b8.releaseCalls}`
)

// B9 post-close 快照失败 ⇒ 保留上一份 verified snapshot
__resetPreopenTokensForTest()
releases.length = 0
const b9Dir = mkdtempSync(join(root, 'b9-data-'))
const b9Snap = mkdtempSync(join(root, 'b9-snap-'))
const b9 = await runScenario({
  dataDir: b9Dir,
  snapshotRoot: b9Snap,
  preOpen: okPre('pre-b9'),
  materializePreOpen: b9Snap,
  postClose: failPre('copy_digest_mismatch', '注入：post-close 副本摘要不符'),
  closed: true,
  ownerRecordDir: mkdtempSync(join(root, 'b9-owner-')),
})
check(
  'B9',
  'POSTCLOSE SNAPSHOT FAILED ⇒ 非零、保留上一份 verified snapshot（incident 里报出它的 id）、不写 cleanClose',
  b9.code === 'postclose_snapshot_failed' &&
    b9.lastVerifiedSnapshotIdInHold === 'pre-b9' &&
    b9.cleanClose === false &&
    b9.releaseCalls === 1 &&
    b9.restoreDryRunCommand?.includes('--from pre-b9') === true,
  `code=${String(b9.code)} lastVerifiedSnapshotId=${String(b9.lastVerifiedSnapshotIdInHold)} cleanClose=${String(b9.cleanClose)} dryRun=${String(b9.restoreDryRunCommand)}`
)

// B10 afterClose 模式：不重复 stop/close（生产接线：WP3 的唯一收尾路径已经做过）
__resetPreopenTokensForTest()
releases.length = 0
const b10Dir = mkdtempSync(join(root, 'b10-data-'))
const b10Snap = mkdtempSync(join(root, 'b10-snap-'))
const b10 = await runScenario(
  {
    dataDir: b10Dir,
    snapshotRoot: b10Snap,
    preOpen: okPre('pre-b10'),
    postClose: okPre('post-b10'),
    closed: true,
  },
  'afterClose'
)
check(
  'B10',
  'AT3.1 协同：`afterClose: true` 时状态机**不重复** stop/close，但 state 序列与 cleanClose 不变',
  b10.ran &&
    b10.stopCalls === 0 &&
    b10.closeCalls === 0 &&
    b10.states.join(' → ') === canonical &&
    b10.cleanClose === true,
  `stop=${b10.stopCalls} close=${b10.closeCalls} states=${b10.states.join('→')} cleanClose=${String(b10.cleanClose)}`
)

// B11 幂等：失败边之后再 finish() 不重复释放
__resetPreopenTokensForTest()
releases.length = 0
const b11Dir = mkdtempSync(join(root, 'b11-data-'))
const b11Snap = mkdtempSync(join(root, 'b11-snap-'))
const b11 = await runScenario({
  dataDir: b11Dir,
  snapshotRoot: b11Snap,
  preOpen: okPre('pre-b11'),
  closed: false,
  finishTwice: true,
})
check(
  'B11',
  '失败边已经释放过租约 ⇒ 后续任何收尾都是 no-op（不会拿已放掉的租约写第二次 owner record）',
  b11.code === 'db_close_not_verified' &&
    b11.secondFinishCode === 'RELEASED' &&
    releases.length === 1 &&
    b11.releaseCalls === 1,
  `first=${String(b11.code)} second=${String(b11.secondFinishCode)} releases=${releases.length}`
)

// ---------------------------------------------------------------------------
// B12 真实进程：第二个生产 opener 在任何 PGlite 构造之前被拒
// ---------------------------------------------------------------------------

const b12Dir = mkdtempSync(join(root, 'b12-data-'))
writeFileSync(join(b12Dir, 'keep.txt'), 'untouched\n', 'utf8')
const b12Snap = mkdtempSync(join(root, 'b12-snap-'))
const b12Owner = mkdtempSync(join(root, 'b12-owner-'))

function spawnLeaseChild(dataDir: string, ownerDir: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [TSX_CLI, CHILD, 'hold', dataDir, ownerDir], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: process.cwd(),
    })
    children.push(child)
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        rejectPromise(new Error(`持锁子进程 60s 未给出协议行；buffer=${JSON.stringify(buffer)}`))
      }
    }, 60_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const match = /^(ACQUIRED|REJECTED)[^\n]*/m.exec(buffer)
      if (match && !settled) {
        settled = true
        clearTimeout(timer)
        resolvePromise(match[0].trim())
      }
    })
    child.on('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        rejectPromise(error)
      }
    })
  })
}

async function stopChildCleanly(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()))
  try {
    child.send?.('shutdown')
  } catch {
    child.kill()
  }
  await Promise.race([done, new Promise<void>((r) => setTimeout(r, 5_000))])
  if (child.exitCode === null && child.signalCode === null) child.kill()
}

let b12Reading = ''
let b12Pass = false
try {
  __resetPreopenTokensForTest()
  const held = await spawnLeaseChild(b12Dir, b12Owner)
  const before = readdirSync(b12Dir).sort()
  const second = await runScenario({
    dataDir: b12Dir,
    snapshotRoot: b12Snap,
    preOpen: okPre('pre-b12'),
  })
  const after = readdirSync(b12Dir).sort()
  b12Pass =
    held.startsWith('ACQUIRED') &&
    second.code === 'lease_failed' &&
    second.sourceOpens === 0 &&
    second.openCalls === 0 &&
    before.join(',') === after.join(',') &&
    second.tokenAfterFinish === false
  b12Reading = `holder=${held} → second=${String(second.code)} sourceOpens=${String(second.sourceOpens)} openCalls=${second.openCalls} fixtureFiles=${JSON.stringify(before)}→${JSON.stringify(after)}`
} catch (error) {
  b12Reading = `子进程路径失败：${error instanceof Error ? error.message : String(error)}`
}
check(
  'B12',
  'Hard Test：第二个生产进程在任何 PGlite 构造前被拒（lease_failed、source-open=0、fixture 一个字节没动）',
  b12Pass,
  b12Reading
)

// ---------------------------------------------------------------------------
// B13 AT4.5 owner evidence：cleanClose + 上一次未干净是**诊断事实**
// ---------------------------------------------------------------------------

__resetPreopenTokensForTest()
releases.length = 0
const b13Dir = mkdtempSync(join(root, 'b13-data-'))
const b13Snap = mkdtempSync(join(root, 'b13-snap-'))
const b13Owner = mkdtempSync(join(root, 'b13-owner-'))
const b13RecordPath = ownerRecordPath(b13Dir, b13Owner)

// 第一次：以"关闭未验证"结束 ⇒ owner record 必须留 cleanClose=false
const b13First = await runScenario(
  {
    dataDir: b13Dir,
    snapshotRoot: b13Snap,
    preOpen: okPre('pre-b13'),
    closed: false,
    ownerRecordDir: b13Owner,
  },
  'self'
)
const afterFirst: OwnerRecord | undefined = readOwnerRecord(b13RecordPath)

// 第二次：正常结束 ⇒ 应当把上一次那条**未干净**记录作为诊断事实带出来
const b13Second = await runScenario(
  {
    dataDir: b13Dir,
    snapshotRoot: b13Snap,
    preOpen: okPre('pre-b13-2'),
    postClose: okPre('post-b13-2'),
    closed: true,
    ownerRecordDir: b13Owner,
  },
  'self'
)
const afterSecond: OwnerRecord | undefined = readOwnerRecord(b13RecordPath)
const b13Files = readdirSync(b13Owner)
const b13UncleanFiles = b13Files.filter((name) => name.includes('.unclean-'))
const b13Previous = b13Second.previousUncleanExit
check(
  'B13',
  'AT4.5：未干净退出把 cleanClose=false 留在 owner record 里；下一次打开把它作为**诊断事实**带出（不据此断言它是损坏原因）',
  b13First.code === 'db_close_not_verified' &&
    afterFirst?.cleanClose === false &&
    b13Second.ran === true &&
    b13Second.cleanClose === true &&
    afterSecond?.cleanClose === true &&
    b13UncleanFiles.length === 1 &&
    b13Previous !== undefined &&
    typeof b13Previous.pid === 'number' &&
    b13Previous.operationKind === 'chat',
  `first=${String(b13First.code)} recordAfterFirst.cleanClose=${String(afterFirst?.cleanClose)} secondCleanClose=${String(b13Second.cleanClose)} recordAfterSecond.cleanClose=${String(afterSecond?.cleanClose)} uncleanFiles=${JSON.stringify(b13UncleanFiles)} previousUncleanExit=${b13Previous === undefined ? 'undefined' : `pid=${String(b13Previous.pid)} kind=${String(b13Previous.operationKind)}`} previousOwnerRecord()=${String(previousOwnerRecord(b13Dir, b13Owner)?.cleanClose)}`
)

// ---------------------------------------------------------------------------
// B14 `lastVerifiedSnapshotId`（真实 fs）：只有"目录 + manifest 都在"才算 verified
// ---------------------------------------------------------------------------

const b14Snap = mkdtempSync(join(root, 'b14-snap-'))
const b14Empty = mkdtempSync(join(root, 'b14-empty-'))
const b14Verified = (id: string): void => {
  mkdirSync(join(b14Snap, `pglite-${id}`), { recursive: true })
  writeFileSync(join(b14Snap, `pglite-${id}.manifest.json`), '{}\n', 'utf8')
}
b14Verified('2026-01-01T00-00-00-000Z-aaaaaaaaaaaa')
b14Verified('2026-02-02T00-00-00-000Z-bbbbbbbbbbbb')
// 半成品：只有目录、没有 manifest ⇒ **不算** verified（D3：manifest 是晋升的最后一步）
mkdirSync(join(b14Snap, 'pglite-2026-03-03T00-00-00-000Z-cccccccccccc'), { recursive: true })
const b14Latest = lastVerifiedSnapshotId(b14Snap)
const b14EmptyResult = lastVerifiedSnapshotId(b14Empty)
check(
  'B14',
  'AT4.4：最后 verified snapshot = 最新那份"目录 + manifest 都在"的；半成品与空目录如实返回 undefined',
  b14Latest === '2026-02-02T00-00-00-000Z-bbbbbbbbbbbb' &&
    b14EmptyResult === undefined &&
    readdirSync(b14Snap).length === 5,
  `latest=${String(b14Latest)}（半成品 cccc… 被正确忽略） emptyRoot=${String(b14EmptyResult)} measured=${readdirSync(b14Snap).length}`
)

// B15 五个 incident code 是否都被真实走到（集合覆盖，零命中不是 PASS）
const missingCodes = PRODUCTION_INCIDENT_CODES.filter((code) => !incidentCodesSeen.has(code))
check(
  'B15',
  'AT4.4：五个失败边都有具名 code，且本门**真的走到过**（零命中不是 PASS）',
  missingCodes.length === 0 && incidentCodesSeen.size === PRODUCTION_INCIDENT_CODES.length,
  `exercised=${incidentCodesSeen.size}/${PRODUCTION_INCIDENT_CODES.length} 未走到=${JSON.stringify(missingCodes)}`
)

// ---------------------------------------------------------------------------
// B16/B17 真实 shape（**在副本上**；真实库仍未打开）
// ---------------------------------------------------------------------------
/*
 * 为什么必须有这一段：`AT4.3` 的判据是"`closed === true` 才做 post-close 晋升"，
 * 而"关得上吗"这件事**只能对着真实的 plugin-sql 适配器问** —— fixture 里的
 * 注入替身回答不了它。WP4 因此实测到一个真缺陷（见 B16 的读数）：
 * `runtime.adapter` 是 `PgliteDatabaseAdapter`，它的 `db` 是 **drizzle 包装对象**
 * （既没有 `close` 也没有 `closed`），旧实现于是①关不动②永远报 false。
 * 这两条都在 `%TEMP%` 的**空库/副本**上验证，真实 `data/pglite` 从未被打开。
 */

const envBeforeAdapter = {
  dataDir: process.env.PGLITE_DATA_DIR,
  allow: process.env.PROJECT_LG_ALLOW_PRODUCTION_DB,
  sandbox: process.env.PROJECT_LG_SANDBOX,
}

let b16AdapterCtor = 'n/a'
let b16Before = true
let b16After = false
let b16GateAllowsCopy = false
let b16Error = ''
const b16Dir = join(root, 'b16-db')
try {
  process.env.PGLITE_DATA_DIR = b16Dir
  process.env.PROJECT_LG_ALLOW_PRODUCTION_DB = '1'
  delete process.env.PROJECT_LG_SANDBOX

  const { AgentRuntime } = await import('@elizaos/core')
  const sqlPlugin = (await import('@elizaos/plugin-sql')).default
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { closeDatabaseConnection, isDatabaseClosed } = await import(
    '../src/infrastructure/persistence/runtime-shutdown.ts'
  )

  // AT4.1 的副本分支：非真实库目录 ⇒ 中央闸放行（不需要 token）
  try {
    assertDatabaseAccessAllowed()
    b16GateAllowsCopy = true
  } catch {
    b16GateAllowsCopy = false
  }

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin],
    conversationLength: 4,
    settings: { OPENAI_API_KEY: 'offline-probe' },
  })
  // 空目录：`initDatabase` 会把表建起来（**不是**真实库）
  await initDatabase(runtime, sqlPlugin)
  const adapter = (runtime as unknown as { adapter?: { constructor?: { name?: string } } }).adapter
  b16AdapterCtor = adapter?.constructor?.name ?? 'unknown'
  b16Before = isDatabaseClosed(runtime)
  await closeDatabaseConnection(runtime)
  b16After = isDatabaseClosed(runtime)
} catch (error) {
  b16Error = error instanceof Error ? error.message : String(error)
} finally {
  for (const [key, value] of [
    ['PGLITE_DATA_DIR', envBeforeAdapter.dataDir],
    ['PROJECT_LG_ALLOW_PRODUCTION_DB', envBeforeAdapter.allow],
    ['PROJECT_LG_SANDBOX', envBeforeAdapter.sandbox],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

check(
  'B16',
  '真实 plugin-sql 适配器上"关得上吗"：`close` 前 closed=false → `close` 后 closed=true（%TEMP% 空库实测）',
  b16AdapterCtor === 'PgliteDatabaseAdapter' &&
    b16Before === false &&
    b16After === true &&
    b16Error === '',
  `adapter=${b16AdapterCtor} before=${String(b16Before)} after=${String(b16After)} err=${b16Error || 'none'}`
)
check(
  'B17',
  'AT4.1 副本分支：非真实库目录上中央闸**放行**（不需要 token），且真库仍未被打开',
  b16GateAllowsCopy,
  `副本路径 assertDatabaseAccessAllowed() 未抛错 = ${String(b16GateAllowsCopy)}`
)

/*
 * B18：生产装配根 `src/main.ts` 的**只读入口**在一个空副本上必须 EXIT 0。
 * 这条直接回答"WP4 有没有把 `pnpm chat` 这条路径弄坏"，
 * 而且它测的是**本尊**（不是照抄的 harness）。
 */
const b18Dir = join(root, 'b18-db')
mkdirSync(b18Dir, { recursive: true })
let b18Status = -1
let b18Output = ''
try {
  const out = execFileSync(process.execPath, [TSX_CLI, 'src/main.ts', '--kernel-status'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 300_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PGLITE_DATA_DIR: b18Dir, PROJECT_LG_ALLOW_PRODUCTION_DB: '1' },
  })
  b18Status = 0
  b18Output = out
} catch (error) {
  const failed = error as { status?: number; stdout?: string; stderr?: string }
  b18Status = failed.status ?? -1
  b18Output = `${failed.stdout ?? ''}${failed.stderr ?? ''}${error instanceof Error ? error.message : ''}`
}
check(
  'B18',
  '生产装配根本尊的只读入口（`src/main.ts --kernel-status`）在空副本上 **EXIT 0**，且副本路径没有触发状态机',
  b18Status === 0 && !b18Output.includes('incident code') && !b18Output.includes('[inc-01] 生产状态机'),
  `exit=${b18Status} 输出含"数据库就绪"=${String(b18Output.includes('数据库就绪'))} 含"角色已加载"=${String(b18Output.includes('角色已加载'))}`
)

// ---------------------------------------------------------------------------
// C. 接线真相（静态扫描；只读源码文本）
// ---------------------------------------------------------------------------

const dbSrc = readFileSync('src/db/index.ts', 'utf8')
const mainSrc = readFileSync('src/main.ts', 'utf8')
const guardSrc = readFileSync('src/infrastructure/persistence/production-open-guard.ts', 'utf8')
/** 注释里出现一个名字**不算**接线（M6 WP5 的教训：gate 扫的是代码，不是注释） */
const dbCode = stripComments(dbSrc)
const mainCode = stripComments(mainSrc)

const c1Init = dbSrc.indexOf('export async function initDatabase(')
const c1Gate = dbSrc.indexOf('assertDatabaseAccessAllowed()', c1Init)
const c1Register = dbSrc.indexOf('await runtime.registerPlugin(sqlPlugin)', c1Init)
check(
  'C1',
  'AT4.1：中央闸在 `initDatabase()` 的 `runtime.registerPlugin(sqlPlugin)` **之前**（按源码位置核对）',
  c1Init >= 0 && c1Gate > c1Init && c1Register > c1Gate,
  `initDatabase@${c1Init} gate@${c1Gate} registerPlugin@${c1Register}`
)

const c2GrantMentions = (dbCode.match(/grantPreopenToken/g) ?? []).length
check(
  'C2',
  'AT4.1：闸只能"问"token，token 的**授予**没有导出（`src/db/index.ts` 的**代码**里 0 次 `grantPreopenToken`）',
  guardSrc.includes('export function hasPreopenToken') &&
    !/export function grantPreopenToken/.test(guardSrc) &&
    c2GrantMentions === 0,
  `hasPreopenTokenExported=${String(guardSrc.includes('export function hasPreopenToken'))} grantExported=${String(/export function grantPreopenToken/.test(guardSrc))} grantMentionsInDbIndexCode=${c2GrantMentions}`
)

/*
 * C3：`initDatabase` 的**唯一**调用形态是"被塞进状态机的 `openDatabase` 注入点"。
 * 刻意不按"文本先后"判（那会误判：闭包定义在 `prepareProductionOpen(...)` 调用之前），
 * 而是判三件事：
 *   ① 只出现 2 次 `ready = await initDatabase(runtime, sqlPlugin)`（两处 opener）
 *   ② 只出现 2 个 `const openDatabase = async` 闭包，且两处都把 `openDatabase` 传进 deps
 *   ③ 收尾走 `handle.finish(..., afterClose: true)`
 */
const c3InitCalls = (mainCode.match(/ready = await initDatabase\(runtime, sqlPlugin\)/g) ?? []).length
const c3Openers = (mainCode.match(/const openDatabase = async/g) ?? []).length
const c3DepPassing = (mainCode.match(/^\s+openDatabase,$/gm) ?? []).length
const c3HandleOpen = (mainCode.match(/await handle\.open\(\)/g) ?? []).length
const c3AfterClose = (mainCode.match(/afterClose: true/g) ?? []).length
check(
  'C3',
  'AT4.2：生产装配根把 `initDatabase` **只**作为状态机的 `openDatabase` 注入点（两处 opener），收尾走 `finish({ afterClose: true })`',
  c3InitCalls === 2 &&
    c3Openers === 2 &&
    c3DepPassing === 2 &&
    c3HandleOpen >= 1 &&
    c3AfterClose === 2,
  `initCalls=${c3InitCalls} openers=${c3Openers} depPassing=${c3DepPassing} handleOpen=${c3HandleOpen} afterClose=${c3AfterClose}`
)

/*
 * C5：**唯一**不走状态机的直呼形态是 `else` 分支（非真实库目录/沙箱）。
 * 若哪天有人把 `isProductionDir` 判据删掉，这条断言会红。
 */
const c5ElseOnly = (mainCode.match(/\} else \{\s*\n\s*await openDatabase\(\)\s*\n\s*\}/g) ?? []).length
const c5GuardedFlags = (mainCode.match(/isProductionDir\(/g) ?? []).length
check(
  'C5',
  'AT4.2：直呼 `await openDatabase()`（不走状态机）**只**出现在 `isProductionDir` 判据的 else 分支里（2 处）',
  c5ElseOnly === 2 && c5GuardedFlags >= 2,
  `elseOnlyDirectCalls=${c5ElseOnly} isProductionDirMentions=${c5GuardedFlags}`
)

// 三个只读真实库 opener：**WP6 已把它们接进状态机**（WP4 当时登记为缺口）
const readOnlyOpeners = [
  'scripts/snapshot-state.ts',
  'scripts/verify-m4-real-db.ts',
  'scripts/verify-m5.1.1-phase4b-db-v9.ts',
]
const stillUnwired: string[] = []
const wired: string[] = []
for (const file of readOnlyOpeners) {
  const text = readFileSync(file, 'utf8')
  if (text.includes('prepareProductionOpen(') && text.includes('ProductionOpenHandle')) wired.push(file)
  else stillUnwired.push(file)
}
check(
  'C4',
  'AT4.2 缺口**已闭合**：三个只读真实库 opener 都走生产状态机（WP4 当时作为已知缺口登记，WP6 接线）',
  stillUnwired.length === 0 && wired.length === readOnlyOpeners.length,
  `已接线=${JSON.stringify(wired)} 未接线=${JSON.stringify(stillUnwired)}`
)

// ---------------------------------------------------------------------------
// T. 真实库安全（本门从未打开它）
// ---------------------------------------------------------------------------

/*
 * 判据共用 `scripts/inc-01-real-db-drift.ts`（WP4/WP5 同一个实现）：
 *   ① 同轮不变；② 相对 WP0 基线的漂移必须**有据**（verified 快照捕获了改动前状态 + 一次干净关闭）。
 */
const realAfter = digestTree(REAL_DB)
const drift = measureRealDbDrift(realDbBefore, realAfter)
check(
  'T1',
  '真实 `data/pglite` 在本门运行前后**逐字不变**（本门只读它，从未打开）',
  drift.unchangedDuringRun && realAfter.measuredCount > 0,
  `measured=${realAfter.measuredCount} files / ${realAfter.totalBytes} bytes · ${drift.reading}`
)
check(
  'T2',
  '真实库摘要与 WP0 冻结基线的关系**有据可查**：相同 ⇒ 直接过；不同 ⇒ 必须由 verified 快照 + 干净关闭解释（解释不了 ⇒ FAIL）',
  drift.matchesWp0Baseline || drift.driftExplained,
  drift.reading
)

for (const child of children) await stopChildCleanly(child)

// ---------------------------------------------------------------------------
// 汇总 / 证据
// ---------------------------------------------------------------------------

const measuredCount = realAfter.measuredCount + decisionCases.length + checks.length
const measurementInvalid =
  realAfter.measuredCount === 0 || checks.length === 0 || incidentCodesSeen.size === 0
const verdict = measurementInvalid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

const summary = {
  wp: 'INC-01 WP4 — Production Guard Wiring & Incident Hold',
  checkedAt: new Date().toISOString(),
  canonicalStates: canonical,
  incidentCodes: PRODUCTION_INCIDENT_CODES,
  incidentCodesExercised: [...incidentCodesSeen],
  decisionTable: decisionCases.map((item) => ({
    case: item.name,
    expected: item.allowed ? 'allow' : `deny(${String(item.denial)})`,
  })),
  realDbOpenersWiring: {
    wired,
    stillUnwired,
    note:
      'WP4 当时把这三个只读真实库 opener 登记为**已知缺口**（它们只调 allowProductionDatabase()，' +
      '会被新的中央闸失败关闭）；**WP6 已把它们全部接进生产状态机**（租约 + pre/post-close verified snapshot），' +
      '并由 `pnpm m4:real-db:verify`（30/30 EXIT 0）与 `pnpm db:restore` 的 dry-run 实测过。',
  },
  measurements: {
    checks: checks.length,
    failed,
    decisionCases: decisionCases.length,
    realDbFiles: realAfter.measuredCount,
    realDbBytes: realAfter.totalBytes,
    realDbNonVolatileTreeSha256: realAfter.treeSha256,
    measuredCount,
  },
  realDb: {
    before: drift.before.treeSha256,
    after: drift.after.treeSha256,
    unchangedDuringThisRun: drift.unchangedDuringRun,
    wp0Baseline: WP0_REAL_DB_NONVOLATILE,
    matchesWp0Baseline: drift.matchesWp0Baseline,
    baselineCapturedBySnapshot: drift.baselineCapturedBySnapshotId,
    cleanOwnerRecords: drift.cleanOwnerRecords,
    verifiedSnapshots: drift.verifiedSnapshots,
    driftExplained: drift.driftExplained,
  },
  didNotOpenRealDatabase: true,
  didNotRunRealSnapshotOrRestore: true,
  openedOnlyTempCopies: true,
  checks,
  verdict,
}

mkdirSync('artifacts/incidents/inc-01', { recursive: true })
writeFileSync(
  'artifacts/incidents/inc-01/wp4-integration.json',
  `${JSON.stringify(summary, null, 2)}\n`,
  'utf8'
)

rmSync(root, { recursive: true, force: true })

console.log(
  `\nWP4 门：${verdict}（${checks.length} 项断言，${failed} 失败，incident codes exercised ` +
    `${incidentCodesSeen.size}/${PRODUCTION_INCIDENT_CODES.length}）；证据 artifacts/incidents/inc-01/wp4-integration.json`
)
process.exitCode = verdict === 'PASS' ? 0 : 1
