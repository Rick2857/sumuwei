/**
 * S8 / **`ADR-107` `R-1b`** —— **剧情选择解析门**（`pnpm postlv2:s8:choice:verify`）。
 *
 * ============================================================================
 *  它守什么
 * ============================================================================
 * `R-1b` 让"候选 `choiceId`"有一个**可判定的产出面**：私有调用 → 闭集 → 世界提交。
 * 本门守的是**每一步都失败关闭**，并且**不该发调用的时候一次都不发**。
 *
 * ```text
 * G1  正控：合法闭集提案 ⇒ `committed`；账本读回 CHOICE_COMMITTED，choiceId 逐字相符，
 *          绑定是**服务端**给的（user_choice + 会话 + anchor + actor=user），模型碰不到
 * G2  负控：开关关闭 ⇒ `disabled` 且**端口一次都没被调用**、账本零变化
 * G3  负控：**没有活跃 run** ⇒ `no_active_run` 且**端口一次都没被调用**（`Q3` 的省钱硬闸）
 * G4  负控：闭集**外**的机器键 ⇒ 具名拒收 `..._choice_id_not_on_frontier` + 零副作用
 * G5  负控：多一个字段 ⇒ `..._unknown_field` + 零副作用
 * G6  负控：schemaVersion 不符 ⇒ `..._schema_version_missing_or_unknown` + 零副作用
 * G7  负控：不是对象 ⇒ `..._not_an_object` + 零副作用
 * G8  负控：超时（AbortError）⇒ `..._timeout` + 零副作用
 * G9  负控：调用抛错 ⇒ `..._call_failed` + 零副作用
 * G10 负控：模型说 `null` ⇒ `no_choice`（**结论**，不是失败）+ 零副作用
 * G11 负控：装配层没注入端口 ⇒ `..._port_missing`（配置错误）+ 零副作用
 * G12 恢复：回到合法提案 ⇒ **又能提交**（证明 G4–G11 的拒是注入条件造成的）
 * G13 无候选：把 run 走到 `choices: []` 的节点 ⇒ `no_candidates` 且**端口零调用**、账本零变化
 * G14 纯函数：有界输入（逐项上界 + 截断**具名**）与闭集判定的边界
 * G15 非零分母 + 隔离（`measured_count > 0`；`PROJECT_LG_ALLOW_PRODUCTION_DB` 未设）
 * ```
 *
 * ⚠️ 本门**零真实模型 / 零出网 / 零真实库**：私有端口是**注入的替身**，
 *    "调用了几次"由**计数器**给（那正是 G2/G3/G13 主张的来源）。
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

const sandbox = isolateDatabase('postlv2-s8-choice', { keep: false })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness, M4_T0 } = await import('./m4-harness.ts')
const { createStoryLedgerStore } = await import(
  '../src/infrastructure/storyline/store/story-ledger-store.ts'
)
const { ingestStoryChoice } = await import('../src/kernel/app/storyline/choice-ingest.ts')
const { startStoryRun, activeStoryRunOf } = await import(
  '../src/kernel/app/storyline/run-lifecycle.ts'
)
const { runStoryChoiceTurn } = await import('../src/kernel/app/storyline/choice-turn.ts')
const { buildStoryChoiceInput, buildStoryChoiceUserMessage, STORY_CHOICE_MAX_RECENT_LINES, STORY_CHOICE_MAX_INPUT_CODEPOINTS } =
  await import('../src/kernel/app/storyline/choice-input.ts')
const { recognizeStoryChoiceDraft, STORY_CHOICE_DRAFT_SCHEMA_VERSION } = await import(
  '../src/kernel/contracts/story-choice-draft.ts'
)
const { loadStoryRun } = await import('../src/kernel/app/storyline/commit-service.ts')
const { renderStoryVisibleEvents } = await import(
  '../src/content/storyline/jichuang-interview-two/render.ts'
)
const { JICHUANG_PACK } = await import(
  '../src/content/storyline/jichuang-interview-two/story-pack.ts'
)

let clock = M4_T0
const h = await createM4Harness({ label: 'postlv2-s8-choice' })
const db = h.db
const ledger = createStoryLedgerStore(db)

/** 私有决策端口的**替身**：记调用次数 + 返回注入的原始输出 / 抛出注入的错误。 */
let portCalls = 0
const fakePort = (behaviour: { raw?: unknown; throws?: Error }) => ({
  call: async (): Promise<unknown> => {
    portCalls += 1
    if (behaviour.throws !== undefined) throw behaviour.throws
    return behaviour.raw
  },
})

const draft = (choiceId: string | null, quote: string | null = null): unknown => ({
  schemaVersion: STORY_CHOICE_DRAFT_SCHEMA_VERSION,
  choiceId,
  quote,
})

/** 账本行数（**主张的唯一来源**） */
const ledgerCount = async (runId: string): Promise<number> =>
  (await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId })).length

const serverCtx = (anchor: string, session: string, actorId: string) => ({
  runId: '',
  anchorConversationEventId: anchor,
  interactionRef: session,
  actorId,
  expectedRevision: 0,
})

/** 现成的一轮输入；`port` 缺省即"不注入"。 */
const turnInput = (opts: {
  enabled?: boolean
  runId: string
  currentInput: string
  port?: unknown
  anchor?: string
}) => ({
  enabled: opts.enabled ?? true,
  ledger,
  pack: JICHUANG_PACK,
  server: serverCtx(opts.anchor ?? 'cev:user:1', 's8-choice-session', h.userId),
  currentInput: opts.currentInput,
  recentLines: ['她说：明天十点二十五，楼下。'],
  /* 正文用**内容资产的真渲染器**（`R-3`）；空集合 ⇒ 空串 */
  narrativeOf: (state: { visibleEventIds: readonly string[] }) =>
    renderStoryVisibleEvents(state.visibleEventIds),
  ...(opts.port === undefined ? {} : { port: opts.port as never }),
  deadlineMs: 8000,
  now: (clock += 1000),
})

/* ============================================================ G3 先于一切 */
/* ⚠️ 顺序刻意：**在任何 run 存在之前**先量"没有活跃 run ⇒ 一次调用都不发" */
portCalls = 0
const beforeAnyRun = await runStoryChoiceTurn(turnInput({ runId: 'n/a', currentInput: '就选第一个吧', port: fakePort({ raw: draft('align_first') }) }) as never)
record(
  'G3',
  '【负控·没有活跃 run】⇒ `no_active_run`，且私有端口**一次都没被调用**、账本零变化（`ADR-107` `Q3` 的省钱硬闸）',
  beforeAnyRun.kind === 'no_active_run' && portCalls === 0,
  `kind=${beforeAnyRun.kind} · 端口调用=${String(portCalls)}`,
  1,
)

/* ================================================ 走一遍到 `choices: []` 的节点 */
const RUN_A = 's8-choice-walk'
const startedA = await startStoryRun({ ledger, pack: JICHUANG_PACK, runId: RUN_A, now: (clock += 1000) })
let walkSteps = 0
let walkStoppedAt = '(未走到)'
for (let i = 0; i < 20; i += 1) {
  const loaded = await loadStoryRun({ ledger, pack: JICHUANG_PACK, runId: RUN_A })
  if (!loaded.ok) break
  const node = JICHUANG_PACK.nodes.find((candidate) => candidate.id === loaded.state.currentNodeId)
  if (node === undefined || node.choices.length === 0) {
    walkStoppedAt = loaded.state.currentNodeId
    break
  }
  const picked = node.choices[0]!
  const committed = await ingestStoryChoice({
    enabled: true,
    ledger,
    pack: JICHUANG_PACK,
    server: { ...serverCtx(`cev:walk:${String(i)}`, 's8-choice-walk', h.userId), runId: RUN_A, expectedRevision: loaded.state.revision },
    proposedChoiceId: picked,
    now: (clock += 1000),
  })
  if (committed.kind !== 'committed') {
    walkStoppedAt = `${loaded.state.currentNodeId}（提交被拒：${committed.kind}）`
    break
  }
  walkSteps += 1
}
const ledgerAtEndOfWalk = await ledgerCount(RUN_A)
portCalls = 0
const noCandidates = await runStoryChoiceTurn(
  turnInput({ runId: RUN_A, currentInput: '随便', port: fakePort({ raw: draft('align_first') }) }) as never,
)
const ledgerAfterNoCandidates = await ledgerCount(RUN_A)
record(
  'G13',
  '【无候选】走到 `choices: []` 的节点 ⇒ `no_candidates`，私有端口**零调用**，账本**零变化**（"没有可选项"与"模型说没选"是两件事）',
  noCandidates.kind === 'no_candidates' &&
    portCalls === 0 &&
    ledgerAfterNoCandidates === ledgerAtEndOfWalk &&
    walkSteps > 0 &&
    startedA.ok === true,
  `走到=${walkStoppedAt} · 步数=${String(walkSteps)} · kind=${noCandidates.kind} · 端口调用=${String(portCalls)} · 账本 ${String(ledgerAtEndOfWalk)}→${String(ledgerAfterNoCandidates)}`,
  walkSteps,
)

/* ================================================== 关掉 A、开一个干净的 B */
const { commitStoryTurn } = await import('../src/kernel/app/storyline/commit-service.ts')
const loadedA = await loadStoryRun({ ledger, pack: JICHUANG_PACK, runId: RUN_A })
if (loadedA.ok) {
  await commitStoryTurn({
    ledger,
    request: {
      pack: JICHUANG_PACK,
      runId: RUN_A,
      binding: { interactionKind: 'system', actorKind: 'system' },
      idempotencyKey: `story-exit:${RUN_A}`,
      action: { kind: 'exit', expectedRevision: loadedA.state.revision },
      now: (clock += 1000),
    },
  })
}
const RUN_B = 's8-choice-main'
const startedB = await startStoryRun({ ledger, pack: JICHUANG_PACK, runId: RUN_B, now: (clock += 1000) })
const activeB = await activeStoryRunOf({ ledger, pack: JICHUANG_PACK })

/* ------------------------------------------------------------ G2 开关关闭 */
const beforeG2 = await ledgerCount(RUN_B)
portCalls = 0
const off = await runStoryChoiceTurn(
  turnInput({ enabled: false, runId: RUN_B, currentInput: '就选第一个吧', port: fakePort({ raw: draft('align_first') }) }) as never,
)
record(
  'G2',
  '【负控·开关关闭】⇒ `disabled`，且私有端口**一次都没被调用**、账本零变化（"没启用"与"拒绝"是两件事）',
  off.kind === 'disabled' && portCalls === 0 && (await ledgerCount(RUN_B)) === beforeG2,
  `kind=${off.kind} · 端口调用=${String(portCalls)} · 账本 ${String(beforeG2)}→${String(await ledgerCount(RUN_B))}`,
  1,
)

/* ---------------------------------------------------------------- G1 正控 */
const beforeG1 = await ledgerCount(RUN_B)
portCalls = 0
const positive = await runStoryChoiceTurn(
  turnInput({
    runId: RUN_B,
    currentInput: '就按第一个来吧，先问清楚范围',
    port: fakePort({ raw: draft('ask_scope', '就按第一个来') }),
    anchor: 'cev:user:g1',
  }) as never,
)
const rowsB1 = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN_B })
const lastB1 = rowsB1.at(-1)
record(
  'G1',
  '【正控】合法闭集提案 ⇒ `committed`；账本读回 `CHOICE_COMMITTED` 且 `choiceId` 逐字相符，绑定是**服务端**给的（user_choice + 会话 + anchor + actor=user）',
  positive.kind === 'committed' &&
    startedB.ok === true &&
    activeB?.runId === RUN_B &&
    portCalls === 1 &&
    lastB1 !== undefined &&
    String(lastB1.eventType) === 'CHOICE_COMMITTED' &&
    lastB1.choiceId === 'ask_scope' &&
    lastB1.binding.interactionKind === 'user_choice' &&
    lastB1.binding.actorKind === 'user' &&
    lastB1.binding.interactionRef === 's8-choice-session' &&
    lastB1.binding.anchorConversationEventId === 'cev:user:g1',
  `kind=${positive.kind} · 端口调用=${String(portCalls)} · 账本 ${String(beforeG1)}→${String(rowsB1.length)} · ` +
    `type=${String(lastB1?.eventType)} choice=${String(lastB1?.choiceId)} kind=${String(lastB1?.binding.interactionKind)} ` +
    `actor=${String(lastB1?.binding.actorKind)} ref=${String(lastB1?.binding.interactionRef)} anchor=${String(lastB1?.binding.anchorConversationEventId)}`,
  rowsB1.length,
)

/* ------------------------------------------- G4–G11 负控（每一条都必须零副作用） */
const negatives: readonly {
  id: string
  label: string
  behaviour: { raw?: unknown; throws?: Error }
  port?: boolean
  expectKind: string
  expectCode?: string
}[] = [
  { id: 'G4', label: '闭集之外的机器键', behaviour: { raw: draft('我编的选项') }, expectKind: 'failed', expectCode: 'story_choice_choice_id_not_on_frontier' },
  { id: 'G5', label: '多一个字段', behaviour: { raw: { ...(draft('go_prepare', '就选那个') as Record<string, unknown>), extra: 1 } }, expectKind: 'failed', expectCode: 'story_choice_unknown_field' },
  { id: 'G6', label: 'schemaVersion 不符', behaviour: { raw: { schemaVersion: '别的@1', choiceId: 'go_prepare' } }, expectKind: 'failed', expectCode: 'story_choice_schema_version_missing_or_unknown' },
  { id: 'G7', label: '不是对象', behaviour: { raw: 'go_prepare' }, expectKind: 'failed', expectCode: 'story_choice_not_an_object' },
  { id: 'G8', label: '超时（AbortError）', behaviour: { throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) }, expectKind: 'failed', expectCode: 'story_choice_timeout' },
  { id: 'G9', label: '调用抛错', behaviour: { throws: new Error('socket hang up') }, expectKind: 'failed', expectCode: 'story_choice_call_failed' },
  { id: 'G10', label: '模型说 null（**结论**，不是失败）', behaviour: { raw: draft(null) }, expectKind: 'no_choice' },
  { id: 'G11', label: '装配层没注入端口（配置错误）', behaviour: {}, port: false, expectKind: 'failed', expectCode: 'story_choice_port_missing' },
  /* ⚠️ `L-S8-31` 的缓解面：给了选择却**指不出用户原话** ⇒ 一律拒收（机械包含检查） */
  { id: 'G16', label: '给了 choiceId 却没给 quote', behaviour: { raw: { schemaVersion: STORY_CHOICE_DRAFT_SCHEMA_VERSION, choiceId: 'go_prepare' } }, expectKind: 'failed', expectCode: 'story_choice_quote_not_a_string_or_null' },
  { id: 'G17', label: 'quote **不是**用户原话的片段', behaviour: { raw: { schemaVersion: STORY_CHOICE_DRAFT_SCHEMA_VERSION, choiceId: 'go_prepare', quote: '我没说过这句话' } }, expectKind: 'failed', expectCode: 'story_choice_quote_not_in_user_turn' },
  { id: 'G18', label: 'quote 是空串', behaviour: { raw: { schemaVersion: STORY_CHOICE_DRAFT_SCHEMA_VERSION, choiceId: 'go_prepare', quote: '   ' } }, expectKind: 'failed', expectCode: 'story_choice_quote_empty' },
]
const negativeReadings: string[] = []
let negativesOk = true
const ledgerBeforeNegatives = await ledgerCount(RUN_B)
for (const item of negatives) {
  portCalls = 0
  const outcome = await runStoryChoiceTurn(
    turnInput({
      runId: RUN_B,
      currentInput: '就选那个吧',
      anchor: `cev:user:${item.id}`,
      ...(item.port === false ? {} : { port: fakePort(item.behaviour) }),
    }) as never,
  )
  const code = 'code' in outcome ? String(outcome.code) : '(无 code)'
  const ok =
    outcome.kind === item.expectKind &&
    (item.expectCode === undefined || code === item.expectCode) &&
    (await ledgerCount(RUN_B)) === ledgerBeforeNegatives
  if (!ok) negativesOk = false
  negativeReadings.push(`${item.id}(${item.label})⇒${outcome.kind}/${code}·账本${String(await ledgerCount(RUN_B))}`)
}
record(
  'G4-G11',
  '【负控 ×8】闭集外 / 多字段 / 版本不符 / 非对象 / 超时 / 调用失败 / 模型说 null / 端口缺失 —— 各自**具名**，且**账本一行都不多**',
  negativesOk,
  `${negativeReadings.join(' · ')} · 负控前账本=${String(ledgerBeforeNegatives)}`,
  8,
)

/* ---------------------------------------------------------- G12 恢复 */
portCalls = 0
const recovered = await runStoryChoiceTurn(
  turnInput({ runId: RUN_B, currentInput: '那就先照着练一遍', port: fakePort({ raw: draft('go_prepare', '先照着练一遍') }), anchor: 'cev:user:g12' }) as never,
)
record(
  'G12',
  '【恢复】回到合法提案 ⇒ **又能提交**（证明 G4–G11 的拒是**注入的条件**造成的，不是链路坏了）',
  recovered.kind === 'committed' && portCalls === 1 && (await ledgerCount(RUN_B)) === ledgerBeforeNegatives + 1,
  `kind=${recovered.kind} · 端口调用=${String(portCalls)} · 账本=${String(await ledgerCount(RUN_B))}`,
  1,
)

/* ---------------------------------------------------- G14 纯函数边界 */
const emptyCandidates = buildStoryChoiceInput({
  runId: 'r',
  currentNodeId: 'n',
  stage: 's',
  revision: 1,
  narrative: 'x',
  nodeChoices: [],
  currentInput: 'x',
  recentLines: [],
})
const manyLines = Array.from({ length: STORY_CHOICE_MAX_RECENT_LINES + 3 }, (_, i) => `line-${String(i)}`)
const bounded = buildStoryChoiceInput({
  runId: 'r',
  currentNodeId: 'n',
  stage: 's',
  revision: 1,
  narrative: 'x'.repeat(5000),
  nodeChoices: ['a', 'b'],
  currentInput: 'y'.repeat(2000),
  recentLines: manyLines,
})
const closed = recognizeStoryChoiceDraft({ raw: draft('a', 'y'), candidates: ['a', 'b'], userText: 'y' })
const notClosed = recognizeStoryChoiceDraft({ raw: draft('c', 'y'), candidates: ['a', 'b'], userText: 'y' })
/* ⚠️ `L-S8-31`：逐字引用**不在**用户原话里 / 干脆没给 ⇒ 都拒收（机械包含检查） */
const badQuote = recognizeStoryChoiceDraft({ raw: draft('a', '别的'), candidates: ['a', 'b'], userText: 'y' })
const noQuote = recognizeStoryChoiceDraft({ raw: draft('a'), candidates: ['a', 'b'], userText: 'y' })
const messageHasBounds = bounded.ok ? buildStoryChoiceUserMessage(bounded.input) : ''
record(
  'G14',
  '【纯函数】没有候选 ⇒ `ok:false`（**不发调用**）· 超上界**如实截断并具名** · 闭集外一审就拒 · 渲染出的消息里是**截断后**的原话、且带候选块',
  emptyCandidates.ok === false &&
    bounded.ok === true &&
    bounded.ok &&
    bounded.input.truncated.includes('narrative') &&
    bounded.input.truncated.includes('currentInput') &&
    bounded.input.truncated.includes('recentLines') &&
    bounded.input.recentLines.length === STORY_CHOICE_MAX_RECENT_LINES &&
    closed.ok === true &&
    notClosed.ok === false &&
    badQuote.ok === false &&
    badQuote.code === 'quote_not_in_user_turn' &&
    noQuote.ok === false &&
    noQuote.code === 'quote_not_a_string_or_null' &&
    /* 真的按上界截断了：500 个 y 在、501 个 y 不在 */
    messageHasBounds.includes('y'.repeat(STORY_CHOICE_MAX_INPUT_CODEPOINTS)) &&
    !messageHasBounds.includes('y'.repeat(STORY_CHOICE_MAX_INPUT_CODEPOINTS + 1)) &&
    messageHasBounds.includes('【本轮候选（机器键）】'),
  `空候选=${String(emptyCandidates.ok)} · 截断=${JSON.stringify(bounded.ok ? bounded.input.truncated : [])} · ` +
    `闭集通过=${String(closed.ok)} · 闭集外=${notClosed.ok ? '通过（不对）' : notClosed.code} · ` +
    `引用不在原话=${badQuote.ok ? '通过（不对）' : badQuote.code} · 没给引用=${noQuote.ok ? '通过（不对）' : noQuote.code} · ` +
    `消息含 500y=${String(messageHasBounds.includes('y'.repeat(STORY_CHOICE_MAX_INPUT_CODEPOINTS)))} · 含 501y=${String(messageHasBounds.includes('y'.repeat(STORY_CHOICE_MAX_INPUT_CODEPOINTS + 1)))}`,
  1,
)

/* --------------------------------------------------- G15 非零分母 + 隔离 */
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const sandboxIsReal =
  process.env.PROJECT_LG_SANDBOX !== undefined &&
  (process.env.PGLITE_DATA_DIR ?? '').includes('project-lg-exp-') &&
  process.env.PROJECT_LG_ALLOW_PRODUCTION_DB !== '1'
record(
  'G15',
  '【非零分母 + 隔离】`measured_count > 0`；跑在 `isolateDatabase()` 沙箱里，`PROJECT_LG_ALLOW_PRODUCTION_DB` **未**设置',
  measuredCount > 0 && sandboxIsReal,
  `measured_count=${String(measuredCount)} · PROJECT_LG_SANDBOX=${String(process.env.PROJECT_LG_SANDBOX)} · allowProd=${String(process.env.PROJECT_LG_ALLOW_PRODUCTION_DB)}`,
  1,
)
/* `startedA` / `startedB` / `activeB` 已经在 G13 / G1 的判据里被断言，不再 `void` 掉 */

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

const runId = `postlv2-s8-choice-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:choice:verify',
  milestone: 'post-lv2 / S8 / `ADR-107` `R-1b`（候选 choiceId 的产出面）',
  generatedAt: new Date().toISOString(),
  source: { head },
  isolation: { sandboxDir: sandbox.dir, note: '`isolateDatabase()` 一次性沙箱；`data/pglite` 从不被打开' },
  modelCalls: {
    real: 0,
    fake: '端口是**注入的替身**；"调用了几次"由计数器给 —— 那正是 G2/G3/G13 主张的来源',
  },
  contractFingerprints: {
    draft: sha256(read('src/kernel/contracts/story-choice-draft.ts')),
    input: sha256(read('src/kernel/app/storyline/choice-input.ts')),
    decision: sha256(read('src/kernel/app/storyline/choice-decision.ts')),
    turn: sha256(read('src/kernel/app/storyline/choice-turn.ts')),
    entry: sha256(read('src/kernel/app/storyline/choice-ingest.ts')),
  },
  /** ⚠️ 主张只挂在**账本读数**与**端口调用计数**上 */
  claimBasis: ['G1', 'G2', 'G3', 'G4-G11', 'G12', 'G13'],
  notCovered: [
    '**真实模型**的解析质量（本门用替身端口；"她会不会把用户没做的选择解析出来"是 `L-S8-31`）',
    '`main.ts` 的**生产接线**（开关消费 + 端口装配 + 每轮调用点）：**未做**（下一步）',
    '`CHARACTER_STORY_CHOICE_DECISION_ENABLED` 的 flag 与缺省锁：**未做**（下一步）',
    '主 prompt 逐字节基线未动的证明（`m3.5:test`）：**未跑**',
  ],
  checks,
  measuredCount: finalMeasured,
  verdict: passed ? 'PASS' : 'FAIL',
}

writeFileSync(join(outDir, 's8-choice-verify.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  measured_count = ${String(finalMeasured)}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:choice:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-choice-verify.json`)

await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
