/**
 * S8 / **`ADR-107` `R-4c`** —— **入口锁**（`pnpm postlv2:s8:entry-lock:verify`）。
 *
 * ============================================================================
 *  它回答 `L-S8-30` 立案的那个问题
 * ============================================================================
 * 立案事实（`S8-Consumption-Entry-Gap.md` §C1.2）：旧的"消费锁"只断言
 * `src/main.ts` 的**文本**里同时出现两个标识符 ⇒ **入口没有调用者时它照样绿**。
 * 本门把"入口有没有被真的调用"变成一条**行为**判据，并且**证明那条判据是敏感的**。
 *
 * ============================================================================
 *  三段式（**主张只挂在账本与水位读数上**）
 * ============================================================================
 * ```text
 * L1 正控：**调用入口**（`resolveChoiceTurn`，注入替身端口、合法闭集）
 *          ⇒ 账本里出现 `CHOICE_COMMITTED`，`choice_id` 逐字相符
 *          ⇒ 再 `consumeOnce()` ⇒ **三个**消费者水位都推进
 * L2 负控（**入口缺席**）：**只在同一套装配上**调 `consumeOnce()`，**从不**调入口
 *          ⇒ `CHOICE_COMMITTED` **仍然一条都没有**（判据对"入口有没有被调用"是敏感的）
 * L3 恢复：把入口放回去再调一次 ⇒ 又出现一条（L2 的"没有"是**没调入口**造成的，
 *          不是装配坏了 —— 同一套装配紧接着就产出了一条）
 * L4 降级：`src/main.ts` 的**文本锁**读数**列出来但不作为主张**（`R-4c` 的降级）
 * L5 非零分母 + 隔离
 * ```
 *
 * ⚠️ 本门**零真实模型 / 零出网 / 零真实库**：反射消费注入的是**离线固定件**
 *    （与 `postlv2:s8:production:verify` 的 `N9` 同一件），端口是注入的替身。
 * ⚠️ 它**不**主张"生产里一定有人调入口"：它主张的是"**这条链子在被调用时会留下可观测的行**，
 *    而**不**被调用时留不下" —— 生产调用点是否在跑，由 `main.ts` 的装配在场锁与真实轮次回答。
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

const sandbox = isolateDatabase('postlv2-s8-entry-lock', { keep: false })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness, M4_T0 } = await import('./m4-harness.ts')
const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
const { createStoryLedgerStore } = await import(
  '../src/infrastructure/storyline/store/story-ledger-store.ts'
)
const { createStoryWatermarkStore } = await import(
  '../src/infrastructure/storyline/store/story-watermark-store.ts'
)
const { createStoryCognition } = await import('../src/infrastructure/runtime/story-cognition.ts')
const { startStoryRun } = await import('../src/kernel/app/storyline/run-lifecycle.ts')
const { JICHUANG_PACK } = await import(
  '../src/content/storyline/jichuang-interview-two/story-pack.ts'
)

let clock = M4_T0
const h = await createM4Harness({ label: 'postlv2-s8-entry-lock' })
const db = h.db
const characterId = asCharacterId(h.characterId)
const ledger = createStoryLedgerStore(db)
const watermarks = createStoryWatermarkStore(db)
const RUN = 's8-entry-lock'

/* 反射消费用**离线固定件**（与 N9 同一件）：本门整轮零网络 */
const offlineReflectionProvider = {
  name: 's8-entry-lock-offline',
  version: 's8-entry-lock-offline@1',
  call: async (call: { handles: readonly { id: string }[] }) => ({
    schemaVersion: 'reflection-draft@1',
    focusQuestion: '离线固定件：不产生采纳',
    explanation: '离线占位解释（不进入任何真实判断）。',
    supportHandles: call.handles.map((row) => row.id),
    counterHandles: [],
    scope: 'adaptive_self_slot_candidate',
  }),
}

/** 真装配（与生产同一条 `createStoryCognition`） */
const assembly = createStoryCognition({
  db,
  characterId,
  pack: JICHUANG_PACK,
  userId: h.userId,
  provider: offlineReflectionProvider,
  now: () => (clock += 1000),
})

let portCalls = 0
const fakePort = (choiceId: string | null, quote: string | null = null) => ({
  call: async (): Promise<unknown> => {
    portCalls += 1
    return { schemaVersion: 'story-choice-draft@1', choiceId, quote }
  },
})

const choiceRows = async (): Promise<number> =>
  (await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN })).filter(
    (commit) => String(commit.eventType) === 'CHOICE_COMMITTED',
  ).length

const consumers = ['affect', 'relationship', 'reflection'] as const
const watermarkOf = async (consumer: (typeof consumers)[number]): Promise<number> =>
  (await watermarks.readWatermark({ consumer, storyId: JICHUANG_PACK.storyId, runId: RUN }))
    ?.lastConsumedRevision ?? 0

/**
 * **本门的入口判据**（`R-4c` 要求它是行为判据，不是文本判据）：
 * "入口被真的调用过" ⟺ 账本里出现了一条 `CHOICE_COMMITTED`。
 */
const entryReached = async (): Promise<boolean> => (await choiceRows()) > 0

/* 开局（它自己是一条 STORY_STARTED 提交，但**不是**选择提交） */
const started = await startStoryRun({
  ledger,
  pack: JICHUANG_PACK,
  runId: RUN,
  now: (clock += 1000),
})
const commitsAfterStart = (await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN })).length

/* ============================================================ L2 负控（先做） */
/*
 * ⚠️ 顺序刻意：**先**在"没调过入口"的状态下量一次。
 *    此时装配是**好的**（紧接着的 L1 就能产出），所以"没有 CHOICE_COMMITTED"
 *    只可能是**入口没被调用**造成的 —— 这正是"入口缺席负控"。
 */
portCalls = 0
const consumedWithoutEntry = await assembly.consumeOnce()
const reachedBeforeEntry = await entryReached()
const choiceRowsAfterConsume = await choiceRows()
record(
  'L2',
  '【负控·**入口缺席**】在同一套装配上**只**跑消费、**从不**调入口 ⇒ 账本里 `CHOICE_COMMITTED` **一条都没有**（判据对"入口有没有被调用"敏感）',
  started.ok === true &&
    started.status === 'appended' &&
    commitsAfterStart === 1 &&
    consumedWithoutEntry.progress.length > 0 &&
    reachedBeforeEntry === false &&
    choiceRowsAfterConsume === 0 &&
    portCalls === 0,
  `开局提交=${String(commitsAfterStart)} 条 · 消费回路跑了 ${String(consumedWithoutEntry.progress.length)} 个消费者 · ` +
    `入口判据=${reachedBeforeEntry ? 'REACHED（不对）' : 'NOT REACHED'} · CHOICE_COMMITTED=${String(choiceRowsAfterConsume)} · 端口调用=${String(portCalls)}`,
  1,
)

/* ================================================================ L1 正控 */
portCalls = 0
const resolved = await assembly.resolveChoiceTurn({
  anchorConversationEventId: 'cev:user:entry-lock-1',
  actorId: h.userId,
  currentInput: '就按第一个来吧',
  recentLines: [],
  decision: { port: fakePort('ask_scope', '就按第一个来'), deadlineMs: 8000 },
})
const reachedAfterEntry = await entryReached()
const rows = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN })
const chosen = rows.filter((commit) => String(commit.eventType) === 'CHOICE_COMMITTED')
const consumedAfterEntry = await assembly.consumeOnce()
const marks = await Promise.all(consumers.map(async (consumer) => [consumer, await watermarkOf(consumer)] as const))
record(
  'L1',
  '【正控】**调用入口** ⇒ 账本出现 `CHOICE_COMMITTED`（`choice_id` 逐字相符、绑定服务端给）；再跑消费 ⇒ **三个**消费者水位都推进',
  resolved.kind === 'committed' &&
    portCalls === 1 &&
    reachedAfterEntry === true &&
    chosen.length === 1 &&
    chosen[0]?.choiceId === 'ask_scope' &&
    chosen[0]?.binding.interactionKind === 'user_choice' &&
    /*
     * ⚠️ 会话引用由**故事边界模块**拼成 `cli:<userId>`（复核项 ②）：
     *    这里断言它**真的**是那个形状 —— 多会话入口若照抄这一条，
     *    至少会在本门的读数里留下可见痕迹（虽然现在还没有机器判据能挡住它）。
     */
    chosen[0]?.binding.interactionRef === `cli:${h.userId}` &&
    chosen[0]?.binding.anchorConversationEventId === 'cev:user:entry-lock-1' &&
    marks.every(([, mark]) => mark === rows.length),
  `kind=${resolved.kind} · 入口判据=${reachedAfterEntry ? 'REACHED' : 'NOT REACHED（不对）'} · ` +
    `CHOICE_COMMITTED=${String(chosen.length)} choice=${String(chosen[0]?.choiceId)} ` +
    `anchor=${String(chosen[0]?.binding.anchorConversationEventId)} · ` +
    `水位=${marks.map(([consumer, mark]) => `${consumer}→${String(mark)}`).join(' ')}（账本 ${String(rows.length)} 条）`,
  rows.length,
)

/* ================================================================ L3 恢复 */
portCalls = 0
const recovered = await assembly.resolveChoiceTurn({
  anchorConversationEventId: 'cev:user:entry-lock-2',
  actorId: h.userId,
  currentInput: '那就先照着练一遍',
  recentLines: [],
  decision: { port: fakePort('go_prepare', '先照着练一遍'), deadlineMs: 8000 },
})
const choiceRowsAfterRecovery = await choiceRows()
record(
  'L3',
  '【恢复】把入口放回去再调一次 ⇒ **又**出现一条（L2 的"没有"是**没调入口**造成的，不是装配坏了）',
  recovered.kind === 'committed' && portCalls === 1 && choiceRowsAfterRecovery === 2,
  `kind=${recovered.kind} · CHOICE_COMMITTED=${String(choiceRowsAfterRecovery)} · 端口调用=${String(portCalls)}`,
  1,
)

/* ============================================ L4 文本锁：读数，**不是主张** */
const mainText = read('src/main.ts')
const testText = read('scripts/kernel-tests-memory.ts')
const textLocks = {
  mainReadsFlag: /storyChoiceDecisionEnabled/.test(mainText),
  mainCallsBoundary: /\.resolveChoiceTurn\(/.test(mainText),
  mainDrainsPerTurn: /drainStoryTail/.test(mainText),
  testAssertsConsumption: /resolveChoiceTurn/.test(testText),
}
record(
  'L4',
  '【降级·**不作为主张**】`main.ts` 的文本锁读数（列出来，但本门的 `claims` 里**没有**它）—— 文本锁测不到"入口有没有被真的调用"',
  Object.values(textLocks).every((value) => value === true),
  JSON.stringify(textLocks),
  1,
)

/* ==================================================== L5 非零分母 + 隔离 */
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const sandboxIsReal =
  process.env.PROJECT_LG_SANDBOX !== undefined &&
  (process.env.PGLITE_DATA_DIR ?? '').includes('project-lg-exp-') &&
  process.env.PROJECT_LG_ALLOW_PRODUCTION_DB !== '1'
record(
  'L5',
  '【非零分母 + 隔离】`measured_count > 0`；跑在 `isolateDatabase()` 沙箱里，`PROJECT_LG_ALLOW_PRODUCTION_DB` **未**设置',
  measuredCount > 0 && sandboxIsReal,
  `measured_count=${String(measuredCount)} · PROJECT_LG_SANDBOX=${String(process.env.PROJECT_LG_SANDBOX)} · allowProd=${String(process.env.PROJECT_LG_ALLOW_PRODUCTION_DB)}`,
  1,
)

/* ------------------------------------------------------------------ 落盘 */
const failedChecks = checks.filter((check) => !check.pass)
const finalMeasured = checks.reduce((sum, check) => sum + check.measured, 0)
const passed = failedChecks.length === 0 && finalMeasured > 0

let head = ''
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-s8-entry-lock-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:entry-lock:verify',
  milestone: 'post-lv2 / S8 / `ADR-107` `R-4c`（入口锁：入口缺席负控）',
  generatedAt: new Date().toISOString(),
  source: { head },
  isolation: { sandboxDir: sandbox.dir, note: '`isolateDatabase()` 一次性沙箱；`data/pglite` 从不被打开' },
  modelCalls: { real: 0, note: '反射消费注入**离线固定件**；选择端口是注入的替身 —— 本门整轮零网络' },
  /** ⚠️ **主张只挂在这三条**：它们都是账本 / 水位读数（行为），不是文本 */
  claimBasis: ['L2', 'L1', 'L3'],
  /** ⚠️ 文本锁的读数**列出来但不主张**（`R-4c` 的降级） */
  textLocksNotClaims: textLocks,
  contractFingerprints: {
    storyCognition: sha256(read('src/infrastructure/runtime/story-cognition.ts')),
    choiceTurn: sha256(read('src/kernel/app/storyline/choice-turn.ts')),
    runLifecycle: sha256(read('src/kernel/app/storyline/run-lifecycle.ts')),
    consumerLoop: sha256(read('src/kernel/app/storyline/consumer-loop.ts')),
  },
  notCovered: [
    '**生产里是否真的有人调入口**（`main.ts` 的每轮调用点是否在跑）：本门不回答 —— 它回答的是"被调用时留得下、不被调用时留不下"',
    '每轮**尾扫**（`R-3b`）的调度行为：本门手动调 `consumeOnce()`，不驱动 `main.ts` 的轮尾',
    '真实模型的选择解析质量：`L-S8-31`，需真实模型批次',
  ],
  checks,
  measuredCount: finalMeasured,
  verdict: passed ? 'PASS' : 'FAIL',
}

writeFileSync(join(outDir, 's8-entry-lock-verify.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  measured_count = ${String(finalMeasured)}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:entry-lock:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-entry-lock-verify.json`)

await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
