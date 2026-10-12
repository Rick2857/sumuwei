/**
 * S8 · `L-S8-09` —— **撤回入口门**（`pnpm postlv2:s8:withdraw:verify`）。
 *
 * ============================================================================
 *  载体：`src/kernel/app/storyline/admin.ts`（纯逻辑）·
 *        `src/infrastructure/runtime/story-withdraw-command.ts`（DB 侧）
 * ============================================================================
 *  它守什么（**离线 + 隔离库，零模型调用**）
 * ---------------------------------------------------------------------------
 * ```text
 * W1 解析失败关闭：缺来源 / 缺理由 / 理由不在闭集 / 来源不可解析 / 多给参数
 *    ⇒ **各具名拒收**（码不同）
 * W2 payload 构造：形状过契约校验；幂等键稳定可复算
 * W3 正控（隔离库）：真撤回 ⇒ 事件追加 + **该来源的根报 `story_root_withdrawn`**
 * W4 幂等：同来源同理由重复执行 ⇒ **不产生第二条**撤回事件
 * W5 负控（隔离库）：引用不存在 ⇒ `story_withdraw_target_missing` 且**零写入**
 * W6 非零分母自检
 * ```
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

const sandbox = isolateDatabase('postlv2-s8-withdraw', { keep: false })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness, M4_T0 } = await import('./m4-harness.ts')
const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
const { parseStoryWithdrawArgs, storyWithdrawPayloadOf, storyWithdrawIdempotencyKey, STORY_WITHDRAW_USAGE } =
  await import('../src/kernel/app/storyline/admin.ts')
const { validateStoryExperienceRetractedPayload } = await import(
  '../src/kernel/contracts/story-events.ts'
)
const { runStoryWithdrawCommand } = await import(
  '../src/infrastructure/runtime/story-withdraw-command.ts'
)
const { createStoryLedgerStore } = await import(
  '../src/infrastructure/storyline/store/story-ledger-store.ts'
)
const { commitStoryTurn } = await import('../src/kernel/app/storyline/commit-service.ts')
const { expandLineage } = await import('../src/kernel/app/reflection/lineage.ts')
const { createReflectionLineageLookup } = await import(
  '../src/infrastructure/persistence/reflection-lineage-read.ts'
)
const { domainEventsFor } = await import('../src/infrastructure/persistence/event-store.ts')
const { JICHUANG_PACK } = await import('../src/content/storyline/jichuang-interview-two/story-pack.ts')

let clock = M4_T0
const h = await createM4Harness({ label: 'postlv2-s8-withdraw' })
const characterId = asCharacterId(h.characterId)
const db = h.db
const ledger = createStoryLedgerStore(db)
const RUN = 's8-withdraw-main'

// ---------------------------------------------------------------------------
// 前置：一次真实选择提交（正控要有东西可撤）
// ---------------------------------------------------------------------------
const rec = new (await import('../src/infrastructure/runtime/conversation-recorder.ts')).ConversationRecorder({
  db,
  characterId,
  conversationId: (await import('../src/kernel/contracts/ids.ts')).asConversationId('s8-withdraw-s0'),
  dryRun: false,
  userId: h.userId,
  userName: 'Alex',
  characterName: '苏沐薇',
  transport: 'postlv2-s8-withdraw',
  attribution: [
    (await import('../src/infrastructure/runtime/conversation-attribution.ts')).createHumanConsoleUserTurnIngress(),
    (await import('../src/infrastructure/runtime/conversation-attribution.ts')).createCharacterAssistantTurnIngress(),
  ],
})
const anchor = String((await rec.recordUserMessage('隔离用故事语料。', 1)).event!.id)
const started = await commitStoryTurn({
  ledger,
  request: { pack: JICHUANG_PACK, runId: RUN, binding: { interactionKind: 'system', actorKind: 'system' }, idempotencyKey: `${RUN}:start`, action: { kind: 'start' }, now: ++clock },
})
if (!started.ok) throw new Error(`开场失败：${started.code}`)
const chosen = await commitStoryTurn({
  ledger,
  request: {
    pack: JICHUANG_PACK,
    runId: RUN,
    binding: { interactionKind: 'user_choice', interactionRef: 's8-withdraw-s0', anchorConversationEventId: anchor, actorKind: 'user', actorId: h.userId },
    idempotencyKey: `${RUN}:r1`,
    action: { kind: 'choice', choiceId: 'align_first', expectedRevision: 1 },
    now: ++clock,
  },
})
if (!chosen.ok) throw new Error(`提交失败：${chosen.code}`)
const commits = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN })
const target = commits.find((row) => row.revision === 2)!

// ---------------------------------------------------------------------------
// W1 解析失败关闭（纯函数）
// ---------------------------------------------------------------------------
const cases: { name: string; argv: string[]; code: string }[] = [
  { name: '缺来源', argv: [], code: 'story_withdraw_source_missing' },
  { name: '缺理由', argv: [target.commitId], code: 'story_withdraw_reason_missing' },
  { name: '理由不在闭集', argv: [target.commitId, '--reason', '因为'], code: 'story_withdraw_reason_unknown' },
  { name: '来源不可解析', argv: ['not-a-story-id', '--reason', 'user_withdrew'], code: 'story_withdraw_source_unparsable' },
  { name: '多给参数', argv: [target.commitId, 'another', '--reason', 'user_withdrew'], code: 'story_withdraw_too_many_args' },
  { name: 'flag 没有值', argv: [target.commitId, '--reason'], code: 'story_withdraw_flag_without_value' },
]
const observed = cases.map((row) => ({ ...row, got: parseStoryWithdrawArgs(row.argv) }))
const allNamed = observed.every((row) => row.got.ok === false && row.got.code === row.code)
record(
  'W1',
  '**解析失败关闭**：六类坏输入各具名拒收（缺来源 / 缺理由 / 理由不在闭集 / 来源不可解析 / 多参数 / flag 无值）',
  allNamed,
  observed.map((row) => `${row.name}=${row.got.ok ? 'ACCEPTED(不该)' : row.got.code}`).join(' · '),
  cases.length
)
const legal = parseStoryWithdrawArgs([target.commitId, '--reason', 'user_withdrew', '--note', '隔离用例'])
record(
  'W2',
  '合法输入被接受，且 payload 过**契约校验**、幂等键稳定可复算（同输入 ⇒ 同键）',
  legal.ok &&
    (() => {
      const payload = storyWithdrawPayloadOf({ characterId: String(characterId), request: legal.request, withdrawnAt: 1 })
      const validated = validateStoryExperienceRetractedPayload(payload)
      return (
        validated.withdrawnStoryRefs[0]?.sourceId === target.commitId &&
        storyWithdrawIdempotencyKey(legal.request) ===
          storyWithdrawIdempotencyKey({ sourceId: target.commitId, reason: 'user_withdrew' })
      )
    })(),
  `用法串=${STORY_WITHDRAW_USAGE.slice(0, 28)}… · key=${legal.ok ? storyWithdrawIdempotencyKey(legal.request) : '(解析失败)'}`,
  2
)

// ---------------------------------------------------------------------------
// W3/W4 正控 + 幂等（隔离库，走**命令本体**）
// ---------------------------------------------------------------------------
const eventsBefore = (await domainEventsFor(db, characterId)).length
const firstRun = await runStoryWithdrawCommand({
  db,
  characterId,
  argv: [target.commitId, '--reason', 'user_withdrew'],
  now: () => ++clock,
})
const eventsAfterFirst = (await domainEventsFor(db, characterId)).length
const lineage = await expandLineage(
  createReflectionLineageLookup(db, { characterId }),
  [{ kind: 'story_event', id: target.commitId }],
  { characterId: String(characterId) }
)
record(
  'W3',
  '**正控**（隔离库，走命令本体）：撤回 ⇒ 领域事件 +1，且**该来源的根现在报 `story_root_withdrawn`**（读时传播生效）',
  firstRun === 0 &&
    eventsAfterFirst === eventsBefore + 1 &&
    lineage.rejections.some((row) => row.reason === 'story_root_withdrawn'),
  `退出码=${String(firstRun)} · 领域事件 ${String(eventsBefore)}→${String(eventsAfterFirst)} · 追根拒收=${JSON.stringify(lineage.rejections.map((r) => r.reason))}`,
  3
)
const secondRun = await runStoryWithdrawCommand({
  db,
  characterId,
  argv: [target.commitId, '--reason', 'user_withdrew'],
  now: () => ++clock,
})
const eventsAfterSecond = (await domainEventsFor(db, characterId)).length
record(
  'W4',
  '**幂等**：同来源 + 同理由重复执行 ⇒ 领域事件**不增加**（键 = 来源 + 理由）',
  eventsAfterSecond === eventsAfterFirst,
  `领域事件 ${String(eventsAfterFirst)}→${String(eventsAfterSecond)} · 第二次退出码=${String(secondRun)}`,
  eventsAfterFirst
)

// ---------------------------------------------------------------------------
// W5 负控：引用不存在 ⇒ 具名拒收 + 零写入
// ---------------------------------------------------------------------------
const beforeMissing = (await domainEventsFor(db, characterId)).length
const missingRun = await runStoryWithdrawCommand({
  db,
  characterId,
  argv: [`story:${JICHUANG_PACK.storyId}@v1#${RUN}.e99`, '--reason', 'user_withdrew'],
  now: () => ++clock,
})
const afterMissing = (await domainEventsFor(db, characterId)).length
record(
  'W5',
  '**负控**：被撤回的提交**不存在**于账本 ⇒ 拒收（`story_withdraw_target_missing`）且**零写入**（不留悬空撤回事件）',
  missingRun === 1 && beforeMissing === afterMissing,
  `退出码=${String(missingRun)}（期望 1）· 领域事件 ${String(beforeMissing)}→${String(afterMissing)}`,
  beforeMissing
)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failed = checks.filter((check) => !check.pass)
const passed = measuredCount > 0 && failed.length === 0

let head = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-s8-withdraw-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:withdraw:verify',
  milestone: 'post-lv2 / S8 / L-S8-09 撤回入口',
  generatedAt: new Date().toISOString(),
  source: { head },
  isolation: { sandboxDir: sandbox.dir, note: '`isolateDatabase()` 一次性沙箱；`data/pglite` 从不被打开' },
  modelCalls: { real: 0, note: '撤回入口本身不调模型（反思才调）' },
  contractFingerprints: {
    admin: sha256(read('src/kernel/app/storyline/admin.ts')),
    command: sha256(read('src/infrastructure/runtime/story-withdraw-command.ts')),
    storyEvents: sha256(read('src/kernel/contracts/story-events.ts')),
  },
  checks,
  measuredCount,
  verdict: passed ? 'PASS' : 'FAIL',
}

writeFileSync(join(outDir, 's8-withdraw-verify.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:withdraw:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-withdraw-verify.json`)

await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
