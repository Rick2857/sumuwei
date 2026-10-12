/**
 * S8 · WP2 —— **世界提交账本**门（`pnpm postlv2:s8:store:verify`）。
 *
 * ============================================================================
 *  载体：计划书 WP2 退出条件 · ADR-093 `D01`/`D05`/`D13`/`D15`
 *       验收契约 `S8-A01` `S8-A02` `S8-A03` `S8-A11` `S8-A31` `S8-A32` `S8-A50`
 * ============================================================================
 *  退出条件逐条对应
 * ---------------------------------------------------------------------------
 * ```text
 * · 关闭进程后重新打开隔离库，提交/可见观测/revision/折叠状态**逐项对账**  → T8（真子进程）
 * · 重复选择**不重复提交**                                              → T4（幂等）
 * · 提交前/后故障恢复均**无半条世界记录**                                → T7（事务回滚）
 * · 旧来源无账本时**拒收**，不自动回填                                    → T9
 * ```
 *
 * ⚠️ 全部在 `isolateDatabase()` 的**一次性沙箱**里；`data/pglite` **从不被打开**。
 * ⚠️ 零模型调用、零出网。
 * ⚠️ 正控 / 负控 / 恢复三段式（AGENTS.md §6.7），并有非零分母自检（§6.8）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { cleanupSandbox, isolateDatabase, pluginSqlSingletons, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

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

// ---------------------------------------------------------------------------
// 隔离（必须在任何会碰数据库的 import 之前）
// ---------------------------------------------------------------------------
const RUN_FIXTURE_ID = `s8store${Date.now()}`
const sandbox = isolateDatabase('postlv2-s8-store', { runId: RUN_FIXTURE_ID, keep: true })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const { sql } = await import('drizzle-orm')
const { rowsOf } = await import('../src/infrastructure/persistence/db.ts')
const { latestSchemaVersion } = await import('../src/infrastructure/persistence/migrations.ts')
const { createStoryLedgerStore, storyLedgerIntegrityProblems, STORY_LEDGER_TABLES } = await import(
  '../src/infrastructure/storyline/store/story-ledger-store.ts'
)
const { storyCommitRecordOf, storyObservationRecordsOf, storyRootKeyOf, storySessionKeyOf } =
  await import('../src/kernel/storyline/story-ledger.ts')
const { commitStoryTurn, loadStoryRun, reconcileStoryRun } = await import(
  '../src/kernel/app/storyline/commit-service.ts'
)
const { JICHUANG_PACK } = await import('../evals/storyline/jichuang-interview-two/story-pack.ts')
const { asConversationId } = await import('../src/kernel/contracts/ids.ts')
const { ConversationRecorder } = await import(
  '../src/infrastructure/runtime/conversation-recorder.ts'
)

const h = await createM4Harness({ label: 'postlv2-s8-store' })
const db = h.db
const ledger = createStoryLedgerStore(db)

async function countOf(table: string): Promise<number> {
  const rows = rowsOf(await db.execute(sql.raw(`select count(*)::int as c from ${table}`)))
  return Number(rows[0]?.c ?? 0)
}

// ===========================================================================
// T1 迁移与表结构（量具自检：列数 / 约束数必须 > 0）
// ===========================================================================
const tableRows = rowsOf(
  await db.execute(
    sql`select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('storyline_commits', 'storyline_observations')`
  )
)
const presentTables = tableRows.map((row) => String(row.table_name)).sort()
const columnRows = rowsOf(
  await db.execute(
    sql`select table_name, count(*)::int as c from information_schema.columns
        where table_schema = 'public' and table_name in ('storyline_commits', 'storyline_observations')
        group by table_name`
  )
)
const columnCounts = Object.fromEntries(columnRows.map((row) => [String(row.table_name), Number(row.c)]))
const constraintRows = rowsOf(
  await db.execute(
    sql`select table_name, count(*)::int as c from information_schema.table_constraints
        where table_schema = 'public' and table_name = 'storyline_commits'
        group by table_name`
  )
)
const commitConstraintCount = Number(constraintRows[0]?.c ?? 0)
record(
  'T1',
  '隔离库迁移到最新版本，两张账本表存在，且列/约束计数**非零**（量具自检）',
  presentTables.length === STORY_LEDGER_TABLES.length &&
    (columnCounts['storyline_commits'] ?? 0) >= 20 &&
    (columnCounts['storyline_observations'] ?? 0) === 7 &&
    commitConstraintCount >= 6,
  `schemaVersion=${latestSchemaVersion()} · 表=${JSON.stringify(presentTables)} · 列=${JSON.stringify(columnCounts)} · commits 约束=${commitConstraintCount}`,
  presentTables.length + Object.keys(columnCounts).length + commitConstraintCount
)

// ===========================================================================
// T2 正控：真实三步（开局 + 两次真实选择）→ 账本逐条落盘
// ===========================================================================
const sessionOne = asConversationId(`dm-${h.characterId}-postlv2-s8-store`)
const anchor1 = (await h.recordUserEvidence('好，我们一起去参加极创工作室的二面吧。')).ref.id
const anchor2 = (await h.recordUserEvidence('先对齐一下我们各自的分工。')).ref.id

const started = await commitStoryTurn({
  ledger,
  request: {
    pack: JICHUANG_PACK,
    runId: 's8-store-main',
    binding: {
      interactionKind: 'system',
      actorKind: 'system',
    },
    idempotencyKey: 's8-store-main:start',
    action: { kind: 'start' },
    now: 1_000,
  },
})
const step1 = await commitStoryTurn({
  ledger,
  request: {
    pack: JICHUANG_PACK,
    runId: 's8-store-main',
    binding: {
      interactionKind: 'user_choice',
      interactionRef: String(sessionOne),
      anchorConversationEventId: String(anchor1),
      actorKind: 'user',
      actorId: h.userId,
    },
    idempotencyKey: 's8-store-main:r2',
    action: { kind: 'choice', choiceId: 'align_first', expectedRevision: 1 },
    now: 2_000,
  },
})
const step2 = await commitStoryTurn({
  ledger,
  request: {
    pack: JICHUANG_PACK,
    runId: 's8-store-main',
    binding: {
      interactionKind: 'user_choice',
      interactionRef: String(sessionOne),
      anchorConversationEventId: String(anchor2),
      actorKind: 'user',
      actorId: h.userId,
    },
    idempotencyKey: 's8-store-main:r3',
    action: { kind: 'choice', choiceId: 'go_prepare', expectedRevision: 2 },
    now: 3_000,
  },
})
const commitsMain = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: 's8-store-main' })
const observationsMain = (
  await Promise.all(
    commitsMain.flatMap((commit) =>
      storyObservationRecordsOf(commit).map((item) => ledger.readObservation(item.observationId))
    )
  )
).filter((item) => item !== undefined)
record(
  'T2',
  '正控：开局 + 两次真实选择 ⇒ 三条提交与全部可见观测**逐条落盘**（分母非零）',
  started.ok &&
    started.status === 'appended' &&
    step1.ok &&
    step1.status === 'appended' &&
    step2.ok &&
    step2.status === 'appended' &&
    commitsMain.length === 3 &&
    observationsMain.length === 3 &&
    commitsMain.map((c) => c.revision).join(',') === '1,2,3',
  `状态=${[started.ok ? started.status : 'REJECT', step1.ok ? step1.status : 'REJECT', step2.ok ? step2.status : 'REJECT'].join('/')} · 提交=${commitsMain.length} · 观测=${observationsMain.length} · revision=${commitsMain.map((c) => c.revision).join(',')}`,
  commitsMain.length + observationsMain.length
)

// ===========================================================================
// T3 一次提交的 3 个可见条目 ⇒ 仍只有 **1** 条父提交（S8-A03）
// ===========================================================================
const multiCommit = storyCommitRecordOf({
  event: {
    eventId: 'e1',
    storyId: JICHUANG_PACK.storyId,
    storyVersion: 1,
    runId: 's8-store-multi',
    revision: 1,
    type: 'STORY_STARTED',
    fromNodeId: 's1_intro',
    toNodeId: 's1_intro',
    stage: 'confirm_goal',
    variablesAfter: {},
    visibleEvents: ['multi_a', 'multi_b', 'multi_c'],
    committedAt: 10,
  },
  contentDigest: JICHUANG_PACK.contentDigest,
  binding: { interactionKind: 'system', actorKind: 'system' },
  recordedAt: 10,
  idempotencyKey: 's8-store-multi:start',
})
const multiObservations = storyObservationRecordsOf(multiCommit)
const multiAppend = await ledger.appendCommit({ commit: multiCommit, observations: multiObservations })
const multiReadback = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: 's8-store-multi' })
const multiParents = new Set(multiObservations.map((item) => item.parentCommitId))
record(
  'T3',
  '一次提交的 3 个可见条目 ⇒ 3 条观测指向**同一条**父提交（独立根仍为 1）',
  multiObservations.length === 3 &&
    multiParents.size === 1 &&
    multiParents.has(multiCommit.commitId) &&
    multiReadback.length === 1 &&
    multiAppend.status === 'appended',
  `观测=${multiObservations.length} · 不同父提交=${multiParents.size} · 该 run 提交数=${multiReadback.length}`,
  multiObservations.length + multiParents.size
)

// ===========================================================================
// T4 幂等：同一请求重放 ⇒ already_committed，账本**不增行**
// ===========================================================================
const beforeReplay = await countOf('storyline_commits')
const replay = await commitStoryTurn({
  ledger,
  request: {
    pack: JICHUANG_PACK,
    runId: 's8-store-main',
    binding: {
      interactionKind: 'user_choice',
      interactionRef: String(sessionOne),
      anchorConversationEventId: String(anchor2),
      actorKind: 'user',
      actorId: h.userId,
    },
    idempotencyKey: 's8-store-main:r3',
    action: { kind: 'choice', choiceId: 'go_prepare', expectedRevision: 2 },
    now: 9_999,
  },
})
const afterReplay = await countOf('storyline_commits')
record(
  'T4',
  '重放同一次选择（同幂等键）⇒ `already_committed`，且提交行数**不变**（重复选择不重复提交）',
  replay.ok && replay.status === 'already_committed' && beforeReplay === afterReplay,
  `状态=${replay.ok ? replay.status : `REJECT:${replay.code}`} · 提交行 ${beforeReplay} → ${afterReplay}`,
  beforeReplay + afterReplay
)

// ===========================================================================
// T5 负控：同一 revision 上**不同**幂等键 ⇒ 拒收，账本不增行
// ===========================================================================
const beforeConflict = await countOf('storyline_commits')
const conflict = await commitStoryTurn({
  ledger,
  request: {
    pack: JICHUANG_PACK,
    runId: 's8-store-main',
    binding: {
      interactionKind: 'user_choice',
      interactionRef: String(sessionOne),
      anchorConversationEventId: String(anchor2),
      actorKind: 'user',
      actorId: h.userId,
    },
    idempotencyKey: 's8-store-main:r3-different-request',
    action: { kind: 'choice', choiceId: 'go_prepare', expectedRevision: 2 },
    now: 9_999,
  },
})
const afterConflict = await countOf('storyline_commits')
record(
  'T5',
  '负控：同一 revision 上**不同请求**（幂等键不同）⇒ 拒收 `story_stale_revision`，账本不增行',
  !conflict.ok && conflict.code === 'story_stale_revision' && beforeConflict === afterConflict,
  `拒收码=${conflict.ok ? 'NONE（不该通过）' : conflict.code} · 提交行 ${beforeConflict} → ${afterConflict}`,
  beforeConflict + afterConflict
)

// ===========================================================================
// T6 负控：绑定形状（服务端字段不能被伪造/夹带）
// ===========================================================================
const bindingCases: { id: string; expect: string; run: () => Promise<{ ok: boolean; code?: string }> }[] = [
  {
    id: 'system-with-session',
    expect: 'story_binding_invalid',
    run: async () => {
      const out = await commitStoryTurn({
        ledger,
        request: {
          pack: JICHUANG_PACK,
          runId: 's8-store-binding-a',
          binding: {
            interactionKind: 'system',
            interactionRef: 'forged-session',
            actorKind: 'system',
          },
          idempotencyKey: 'binding-a:start',
          action: { kind: 'start' },
          now: 1,
        },
      })
      return { ok: out.ok, ...(out.ok ? {} : { code: out.code }) }
    },
  },
  {
    id: 'user-choice-without-anchor',
    expect: 'story_binding_invalid',
    run: async () => {
      const out = await commitStoryTurn({
        ledger,
        request: {
          pack: JICHUANG_PACK,
          runId: 's8-store-binding-b',
          binding: {
            interactionKind: 'user_choice',
            interactionRef: String(sessionOne),
            actorKind: 'user',
          },
          idempotencyKey: 'binding-b:start',
          action: { kind: 'start' },
          now: 1,
        },
      })
      return { ok: out.ok, ...(out.ok ? {} : { code: out.code }) }
    },
  },
  {
    id: 'user-choice-on-story-started',
    expect: 'story_binding_invalid',
    run: async () => {
      const out = await commitStoryTurn({
        ledger,
        request: {
          pack: JICHUANG_PACK,
          runId: 's8-store-binding-c',
          binding: {
            interactionKind: 'user_choice',
            interactionRef: String(sessionOne),
            anchorConversationEventId: String(anchor1),
            actorKind: 'user',
          },
          idempotencyKey: 'binding-c:start',
          action: { kind: 'start' },
          now: 1,
        },
      })
      return { ok: out.ok, ...(out.ok ? {} : { code: out.code }) }
    },
  },
]
const bindingResults: string[] = []
for (const item of bindingCases) {
  const out = await item.run()
  bindingResults.push(`${item.id}=${out.ok ? 'ACCEPTED(不该)' : out.code}`)
}
const bindingAllRejected = bindingResults.every((line) => line.endsWith('=story_binding_invalid'))
record(
  'T6',
  '负控：`system` 夹带会话 / `user_choice` 缺 anchor / 对 STORY_STARTED 声明 user_choice ⇒ 三条全部拒收（服务端绑定不可伪造）',
  bindingAllRejected,
  bindingResults.join(' · '),
  bindingResults.length
)

// ===========================================================================
// T7 事务：观测写入冲突 ⇒ **整条提交回滚**（无半条世界记录）
// ===========================================================================
const txCommitA = storyCommitRecordOf({
  event: {
    eventId: 'e1',
    storyId: JICHUANG_PACK.storyId,
    storyVersion: 1,
    runId: 's8-store-tx',
    revision: 1,
    type: 'STORY_STARTED',
    fromNodeId: 's1_intro',
    toNodeId: 's1_intro',
    stage: 'confirm_goal',
    variablesAfter: {},
    visibleEvents: ['tx_shared'],
    committedAt: 100,
  },
  contentDigest: JICHUANG_PACK.contentDigest,
  binding: { interactionKind: 'system', actorKind: 'system' },
  recordedAt: 100,
  idempotencyKey: 's8-store-tx:r1',
})
await ledger.appendCommit({ commit: txCommitA, observations: storyObservationRecordsOf(txCommitA) })

// 第二条提交故意**重复引入**同一个可见条目 ⇒ 观测唯一约束冲突
const txCommitB = storyCommitRecordOf({
  event: {
    eventId: 'e2',
    storyId: JICHUANG_PACK.storyId,
    storyVersion: 1,
    runId: 's8-store-tx',
    revision: 2,
    type: 'CHOICE_COMMITTED',
    choiceId: 'align_first',
    fromNodeId: 's1_intro',
    toNodeId: 's1_align',
    stage: 'confirm_goal',
    variablesAfter: { cooperation: 1 },
    visibleEvents: ['tx_shared'],
    committedAt: 200,
  },
  contentDigest: JICHUANG_PACK.contentDigest,
  binding: { interactionKind: 'system', actorKind: 'system' },
  recordedAt: 200,
  idempotencyKey: 's8-store-tx:r2',
})
let txError = ''
try {
  await ledger.appendCommit({ commit: txCommitB, observations: storyObservationRecordsOf(txCommitB) })
} catch (error) {
  txError = error instanceof Error ? error.message : String(error)
}
const txCommitBReadback = await ledger.readCommit(txCommitB.commitId)
const txCommits = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: 's8-store-tx' })
record(
  'T7',
  '提交行写入后观测写入失败 ⇒ **整个事务回滚**：第二条提交读不回来，run 里只剩第一条（无半条世界记录）',
  txError !== '' && txCommitBReadback === undefined && txCommits.length === 1,
  `抛错=${txError !== ''} · 回读=${txCommitBReadback === undefined ? 'undefined（已回滚）' : 'EXISTS(不该)'} · run 提交数=${txCommits.length}`,
  txCommits.length + (txError !== '' ? 1 : 0)
)

// ===========================================================================
// T8 真实进程重启：父进程**先关闭连接**，子进程再打开同一个隔离库
// ===========================================================================
/*
 * ⚠️ 顺序是这条判据的**全部要点**（ADR-093/INV-DB-01）：
 * PGlite 是嵌入式 Postgres，**跨进程单持有**。父进程不关连接就让子进程打开同一个
 * 数据目录 ⇒ 子进程拿不到库（或拿到半死的库）—— 那测的不是"重启恢复"，
 * 而是"两个进程抢一个库"。
 * 第一版就是那样写的，实测表现为子进程里 `PLUGIN:SQL` 无限重试同一句 select。
 * 因此：**先关、验关闭、再开子进程**。
 */
const expectedMain = commitsMain.map((commit) => commit.commitId)
const stateBeforeClose = step2.ok ? step2.state : undefined
const countsBeforeClose = {
  commits: await countOf('storyline_commits'),
  observations: await countOf('storyline_observations'),
}

/**
 * 重启对账（**在 T9/T10/T11 之后调用** —— 那几条还需要父进程的库是开着的）。
 */
let restartChildPid: number | undefined
async function runRestartCheck(): Promise<void> {
  /*
   * ⚠️ 先 `stop()` 再关连接。
   *
   * 第一版直接 `resetPluginSqlConnection()`，实测后果是 bootstrap 的 task 服务仍在定时器上
   * 轮询一个已关闭的库 ⇒ 日志被 `Database operation rejected during shutdown` 无限刷屏、
   * 进程永不退出。判据本身没错，缺的是"先把运行体停掉"。
   */
  await h.stop()
  const closedBeforeRestart = await resetPluginSqlConnection()
  const stillOpen = pluginSqlSingletons()?.pgLiteClientManager !== undefined

  const outPath = join(tmpdir(), `s8-store-restart-${RUN_FIXTURE_ID}.json`)
  const childOutput = execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(REPO_ROOT, 'scripts', 'postlv2-s8-store-restart.ts'),
      '--run-id',
      RUN_FIXTURE_ID,
      '--out',
      outPath,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )
  const child = JSON.parse(readFileSync(outPath, 'utf8')) as {
    pid: number
    runs: string[]
    counts: { commits: number; observations: number }
    mainRun: {
      revision?: number
      currentNodeId?: string
      variables?: Record<string, unknown>
      visibleEventIds?: string[]
      terminal?: boolean
      commitIds?: string[]
      bindings?: unknown[]
      error?: string
    }
    reconciliations: Record<
      string,
      {
        error?: string
        commitCount?: number
        observationCount?: number
        revision?: number
        visibleEventIds?: string[]
        currentNodeId?: string
        terminal?: boolean
      }
    >
  }

  const childState = child.mainRun
  restartChildPid = child.pid
  const stateMatches =
    stateBeforeClose !== undefined &&
    childState.revision === stateBeforeClose.revision &&
    childState.currentNodeId === stateBeforeClose.currentNodeId &&
    childState.terminal === stateBeforeClose.terminal &&
    JSON.stringify(childState.variables) === JSON.stringify(stateBeforeClose.variables) &&
    JSON.stringify(childState.visibleEventIds) === JSON.stringify(stateBeforeClose.visibleEventIds) &&
    JSON.stringify(childState.commitIds) === JSON.stringify(expectedMain)
  record(
    'T8',
    '真实**子进程**重启：父进程先关闭连接（验关闭）→ 子进程打开同一隔离库 → revision/节点/变量/可见集合/提交序列**逐项一致**，且重启**没有写账本**',
    stateMatches &&
      child.pid !== process.pid &&
      !stillOpen &&
      child.counts.commits === countsBeforeClose.commits &&
      child.counts.observations === countsBeforeClose.observations,
    `关闭连接=${String(closedBeforeRestart)} · 残留单例=${String(stillOpen)} · 子进程 pid=${child.pid}（父=${process.pid}） · ` +
      `提交序列一致=${String(JSON.stringify(childState.commitIds) === JSON.stringify(expectedMain))} · 状态一致=${String(stateMatches)} · ` +
      `提交行 ${countsBeforeClose.commits}→${child.counts.commits} · 观测 ${countsBeforeClose.observations}→${child.counts.observations}`,
    expectedMain.length + (stateMatches ? 1 : 0) + (stillOpen ? 0 : 1)
  )
  console.log(`  [child] ${childOutput.trim().split('\n').slice(-1)[0] ?? ''}`)
}

// ===========================================================================
// T9 旧来源没有账本 ⇒ 读不到，**不自动回填**（story_root_unconfirmed 的输入形态）
// ===========================================================================
const legacyObservation = 'story:jichuang-interview-two@v1#legacy-run.s1_intro_met'
const legacyRead = await ledger.readObservation(legacyObservation)
const legacyCommits = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: 'legacy-run' })
record(
  'T9',
  '旧来源（无提交记录）⇒ 观测与 run 读回均为空，**不自动回填**（拒收的输入形态）',
  legacyRead === undefined && legacyCommits.length === 0,
  `观测=${legacyRead === undefined ? 'undefined' : 'EXISTS(不该)'} · run 提交数=${legacyCommits.length}`,
  1 + legacyCommits.length
)

// ===========================================================================
// T10 完整性探针：正控安静 / 负控必响 / 恢复
// ===========================================================================
const integrityPositive = await storyLedgerIntegrityProblems(db)
const injectedObservationId = 'story:jichuang-interview-two@v1#s8-store-orphan.injected_event'
await db.execute(
  sql`insert into storyline_observations
        (observation_id, parent_commit_id, story_id, story_version, run_id, event_id, created_at)
      values (${injectedObservationId}, 'story:jichuang-interview-two@v1#s8-store-orphan.e9',
              ${JICHUANG_PACK.storyId}, 1, 's8-store-orphan', 'injected_event', 1)`
)
const integrityNegative = await storyLedgerIntegrityProblems(db)
await db.execute(sql`delete from storyline_observations where observation_id = ${injectedObservationId}`)
const integrityRestored = await storyLedgerIntegrityProblems(db)
record(
  'T10',
  '完整性探针三段式：正控 0 问题 → 注入悬挂观测**必响** → 删除后恢复 0（且扫描分母非零）',
  integrityPositive.orphanObservations.length === 0 &&
    integrityPositive.revisionGaps.length === 0 &&
    integrityNegative.orphanObservations.includes(injectedObservationId) &&
    integrityRestored.orphanObservations.length === 0 &&
    integrityPositive.scannedCommits > 0 &&
    integrityPositive.scannedObservations > 0,
  `正控=cmt${integrityPositive.scannedCommits}/obs${integrityPositive.scannedObservations}/${integrityPositive.orphanObservations.length} 问题 · ` +
    `负控命中=${integrityNegative.orphanObservations.includes(injectedObservationId)} · 恢复=${integrityRestored.orphanObservations.length} 问题`,
  integrityPositive.scannedCommits + integrityPositive.scannedObservations + integrityNegative.orphanObservations.length
)

// ===========================================================================
// T11 根/会话键读数（WP3 的输入；此处只证明它们**可算且非零**）
// ===========================================================================
const rootKeys = new Set(commitsMain.map((commit) => storyRootKeyOf(commit)))
const sessionKeys = new Set(
  commitsMain.map((commit) => storySessionKeyOf(commit)).filter((key): key is string => key !== undefined)
)
const reconciliation = await reconcileStoryRun({ ledger, pack: JICHUANG_PACK, runId: 's8-store-main' })
record(
  'T11',
  '因果键可算且非零：3 条提交 ⇒ 1 个真实会话键（两次选择同一会话；system 开场**不**贡献会话）',
  sessionKeys.size === 1 &&
    rootKeys.size === 3 &&
    !('error' in reconciliation) &&
    reconciliation.commitCount === 3,
  `会话键=${JSON.stringify([...sessionKeys])} · 根键数=${rootKeys.size} · 对账=${'error' in reconciliation ? reconciliation.error : `提交${reconciliation.commitCount}/观测${reconciliation.observationCount}`}`,
  rootKeys.size + sessionKeys.size
)

// ===========================================================================
// T8（**最后执行**）：关库 → 真子进程重开 → 逐项对账
// ===========================================================================
await runRestartCheck()

// ===========================================================================
// 汇总
// ===========================================================================
/** 报告里按 id 排序（T8 因为"最后才关库"而排在执行序末位，表里仍应读起来是 T1…T11） */
checks.sort((a, b) => a.id.localeCompare(b.id, 'en'))
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failed = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const passed = gateValid && failed.length === 0

let head = 'unknown'
let porcelain: string[] = []
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
} catch {
  /* 只读盘点失败不改变判定 */
}

const dataDir = join(REPO_ROOT, 'data/pglite')
const runId = `postlv2-s8-store-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:store:verify',
  milestone: 'post-lv2 / S8 / WP2',
  generatedAt: new Date().toISOString(),
  source: { head, workingTreeDirty: porcelain.length > 0, workingTreePorcelain: porcelain.slice(0, 80) },
  versions: { node: process.version, platform: `${process.platform} ${process.arch}` },
  isolation: {
    sandboxDir: sandbox.dir,
    childPid: restartChildPid ?? null,
    parentPid: process.pid,
    note: '`isolateDatabase()` 一次性沙箱（%TEMP%）；`data/pglite` 从不被打开',
  },
  contractFingerprints: {
    storyLedger: sha256(read('src/kernel/storyline/story-ledger.ts')),
    storyLedgerPort: sha256(read('src/kernel/storyline/story-ledger-port.ts')),
    commitService: sha256(read('src/kernel/app/storyline/commit-service.ts')),
    store: sha256(read('src/infrastructure/storyline/store/story-ledger-store.ts')),
    migrations: sha256(read('src/infrastructure/persistence/migrations.ts')),
  },
  realDb: existsSync(dataDir)
    ? { exists: true, mtimeMs: statSync(dataDir).mtimeMs, note: 'data/ 被 gitignore ⇒ 只记 mtime' }
    : { exists: false },
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}

writeFileSync(join(outDir, 's8-store-verify.json'), JSON.stringify(reading, null, 2), 'utf8')
writeFileSync(
  join(outDir, 'README.md'),
  [
    '# S8 · WP2 世界提交账本读数',
    '',
    `- runId：\`${reading.runId}\``,
    `- HEAD：\`${head}\` · 工作树脏：${String(porcelain.length > 0)}`,
    `- 判定：**${reading.verdict}** · measured_count = ${measuredCount}`,
    `- 隔离库：\`${sandbox.dir}\``,
    '',
    '| 检查 | 标签 | 结果 | 读数 |',
    '|---|---|---|---|',
    ...checks.map(
      (check) => `| ${check.id} | ${check.label} | ${check.pass ? 'PASS' : 'FAIL'} | ${check.detail.replace(/\|/g, '\\|')} |`
    ),
    '',
    '⚠️ 全离线：零模型调用、零出网、`data/pglite` 从不被打开。',
    '',
  ].join('\n'),
  'utf8'
)

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:store:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-store-verify.json`)

cleanupSandbox(sandbox.dir)
/*
 * ⚠️ 收尾：本门在 T8 已经关过一次库（那是判据的一部分）；这里再关一次是**幂等**的
 * （`resetPluginSqlConnection` 没有单例时返回 false），然后**显式**给退出码 ——
 * 否则残留句柄会把事件循环吊住，门跑完了却不退出。
 */
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
