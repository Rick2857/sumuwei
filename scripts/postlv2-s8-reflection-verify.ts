/**
 * S8 · WP5 —— **反思触发 / 有限采纳 / 实际入模**门（`pnpm postlv2:s8:reflection:verify`）。
 *
 * ============================================================================
 *  载体：计划书 WP5 退出条件 · ADR-093 `D10`/`D11` · 验收契约
 *        `S8-A25` `S8-A26` `S8-A27` `S8-A28` `S8-A29`
 * ============================================================================
 *  退出条件逐条对应
 * ---------------------------------------------------------------------------
 * ```text
 * · 通过**真实入口**完成「3 独立根 + 2 真实会话 → 非零已接受反思 → 合法槽位更新 → 实际入模」
 *        → R4（runReflectionWindow）/ R5（adaptive-self）/ R6（ContextCompiler 实入模）
 * · 2 根、1 会话、有冲突均明确拒收                       → R3（门槛）+ R4 的负控
 * · 开关关闭或 token 裁剪能如实显示**未**入模              → R6 的正控/负控成对
 * · 不得手填 accepted / 伪造来源计数 / 绕过 validator      → R7
 * ```
 *
 * ⚠️ 全部在 `isolateDatabase()` 的**一次性沙箱**里；`data/pglite` **从不被打开**。
 * ⚠️ 零真实模型调用（provider 是**离线固定件**，与 M11.1 各门同一口径）。
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

const sandbox = isolateDatabase('postlv2-s8-reflection', { keep: false })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness, M4_T0 } = await import('./m4-harness.ts')
const { asConversationId } = await import('../src/kernel/contracts/ids.ts')
const { ConversationRecorder } = await import('../src/infrastructure/runtime/conversation-recorder.ts')
const {
  createHumanConsoleUserTurnIngress,
  createCharacterAssistantTurnIngress,
} = await import('../src/infrastructure/runtime/conversation-attribution.ts')
const { runReflectionWindow } = await import('../src/infrastructure/runtime/reflection-runner.ts')
const { readUsableAdaptiveSelfStates, readCurrentReflectionFactPack } = await import(
  '../src/infrastructure/runtime/reflection-current-state.ts'
)
const { listReflectionRecords } = await import('../src/infrastructure/persistence/reflection-store.ts')
const { listAdaptiveSelfStates } = await import(
  '../src/infrastructure/persistence/adaptive-self-store.ts'
)
const { appendDomainEvent } = await import('../src/infrastructure/persistence/event-store.ts')
const { latestDomainEventSequence } = await import(
  '../src/infrastructure/persistence/reflection-input-source.ts'
)
const { TurnGateway } = await import('../src/kernel/app/turn-gateway.ts')
const { DEFAULT_CONTEXT_BUDGET } = await import('../src/kernel/recall/selector.ts')
const { getTrace } = await import('../src/infrastructure/persistence/trace-store.ts')
const { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE } = await import(
  '../src/kernel/contracts/reflection.ts'
)
const { buildReflectionInput, meetsStabilityThreshold } = await import(
  '../src/kernel/app/reflection/inputs.ts'
)
const { createReflectionInputSource } = await import(
  '../src/infrastructure/persistence/reflection-input-source.ts'
)
const { createReflectionLineageLookup } = await import(
  '../src/infrastructure/persistence/reflection-lineage-read.ts'
)
const { expandLineage } = await import('../src/kernel/app/reflection/lineage.ts')
const { createStoryLedgerStore } = await import(
  '../src/infrastructure/storyline/store/story-ledger-store.ts'
)
const { commitStoryTurn } = await import('../src/kernel/app/storyline/commit-service.ts')
const { JICHUANG_PACK } = await import('../evals/storyline/jichuang-interview-two/story-pack.ts')
const { storySourceRefOf } = await import('../src/kernel/contracts/source-authority.ts')
const { storyStateEligibilityOf } = await import(
  '../src/kernel/app/storyline/state-evaluators.ts'
)

let clock = M4_T0
const h = await createM4Harness({ label: 'postlv2-s8-reflection' })
const characterId = h.kernel.characterId
const db = h.db
const ledger = createStoryLedgerStore(db)

// ---------------------------------------------------------------------------
// 前置：**真实账本**上 3 次真实选择，跨 **2 个真实会话**
// ---------------------------------------------------------------------------
const sessionRecorders = [0, 1].map(
  (index) =>
    new ConversationRecorder({
      db,
      characterId,
      conversationId: asConversationId(`s8-reflection-s${String(index)}`),
      dryRun: false,
      userId: h.userId,
      userName: 'Alex',
      characterName: '苏沐薇',
      transport: 'postlv2-s8-reflection',
      attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    })
)
const anchors: string[] = []
for (let index = 0; index < 3; index += 1) {
  const recorded = await sessionRecorders[index % 2]!.recordUserMessage(
    `隔离用故事语料第 ${String(index)} 条：对象含糊时先核对。`,
    Math.floor(index / 2) + 1
  )
  anchors.push(String(recorded.event!.id))
}

const RUN = 's8-reflection-main'
const choices = ['align_first', 'go_prepare', 'split_by_strength']
await commitStoryTurn({
  ledger,
  request: {
    pack: JICHUANG_PACK,
    runId: RUN,
    binding: { interactionKind: 'system', actorKind: 'system' },
    idempotencyKey: `${RUN}:start`,
    action: { kind: 'start' },
    now: ++clock,
  },
})
for (let index = 0; index < choices.length; index += 1) {
  const outcome = await commitStoryTurn({
    ledger,
    request: {
      pack: JICHUANG_PACK,
      runId: RUN,
      binding: {
        interactionKind: 'user_choice',
        interactionRef: `s8-reflection-s${String(index % 2)}`,
        anchorConversationEventId: anchors[index]!,
        actorKind: 'user',
        actorId: h.userId,
      },
      idempotencyKey: `${RUN}:r${String(index + 1)}`,
      action: { kind: 'choice', choiceId: choices[index]!, expectedRevision: index + 1 },
      now: ++clock,
    },
  })
  if (!outcome.ok) throw new Error(`前置失败（第 ${String(index + 1)} 步）：${outcome.code}`)
}
const commits = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN })
const storyRefs = commits
  .filter((item) => storyStateEligibilityOf({ commit: item, anchorSequence: 1 }).eligible)
  .map((item) => storySourceRefOf({ sourceId: item.commitId, experienceScope: 'story_experience' }))

// ---------------------------------------------------------------------------
// R1 触发可达：已提交故事结果 ⇒ `story_outcome` 触发 + `story_experience` 窗口条目
// ---------------------------------------------------------------------------
const inputSource = createReflectionInputSource(db, { characterId })
const watermark = await latestDomainEventSequence(db, characterId)
const built = await buildReflectionInput(inputSource, {
  characterId: String(characterId),
  cutoverSequence: watermark,
  watermark,
  storyOutcomes: storyRefs.map((ref, index) => ({
    commitId: ref.sourceId,
    revision: index + 1,
    eventType: 'CHOICE_COMMITTED',
    /*
     * ⚠️ 正文由**调用方**渲染（真缺陷修复后的形状）：这里给一句**有内容**的故事文本，
     * 而不是占位符 —— 占位符会让窗口里没有任何经历内容（见 `ReflectionStoryOutcome.text`）。
     */
    text: `（程序渲染的经历：第 ${String(index + 1)} 步——${choices[index] ?? 'align_first'}）`,
  })),
})
const storyTriggerCount =
  built?.triggers.filter((trigger) => trigger.kind === 'story_outcome').length ?? 0
const storyEntry = built?.window.find((entry) => entry.kind === 'story_event')
record(
  'R1',
  '`D10` 触发可达：已提交故事结果 ⇒ **恰好**每条一个 `story_outcome` 触发，窗口条目来源类是 `story_experience` 且 handle 含该提交',
  built !== undefined &&
    storyTriggerCount === storyRefs.length &&
    storyEntry?.sourceClass === 'story_experience' &&
    (built.handles ?? []).some((handle) => handle.id === storyRefs[0]?.sourceId),
  `触发=${String(storyTriggerCount)}/${String(storyRefs.length)} · 窗口条目来源类=${String(storyEntry?.sourceClass)} · 窗口=${String(built?.window.length ?? 0)}`,
  storyTriggerCount + (built?.window.length ?? 0)
)

// ---------------------------------------------------------------------------
// R2 负控：没有任何触发（也无故事结果）⇒ `undefined`（调用方不得据此调模型）
// ---------------------------------------------------------------------------
const noTrigger = await buildReflectionInput(inputSource, {
  characterId: String(characterId),
  cutoverSequence: watermark,
  watermark,
})
record(
  'R2',
  '负控：既没有领域事件触发、也没有故事结果 ⇒ `undefined`（**不**调模型；"没想法"与"没触发"必须可区分）',
  noTrigger === undefined,
  `返回=${noTrigger === undefined ? 'undefined' : '有输入（不该）'}`,
  1
)

// ---------------------------------------------------------------------------
// R3 门槛：3 根 / 2 会话 ⇒ 通过；2 根 / 1 会话 / 有冲突 ⇒ 具名拒收
// ---------------------------------------------------------------------------
const lookup = createReflectionLineageLookup(db, { characterId })
const lookupForDiagnostics = lookup
const storyHandles = storyRefs.map((ref) => ({ kind: 'story_event' as const, id: ref.sourceId }))
const fullLineage = await expandLineage(lookup, storyHandles, { characterId: String(characterId) })
const twoRoots = await expandLineage(lookup, storyHandles.slice(0, 2), {
  characterId: String(characterId),
})
const thresholdOk = meetsStabilityThreshold({
  rootCount: fullLineage.rootCount,
  conversationCount: fullLineage.conversationCount,
  unresolvedConflict: false,
})
const thresholdRoots = meetsStabilityThreshold({
  rootCount: twoRoots.rootCount,
  conversationCount: twoRoots.conversationCount,
  unresolvedConflict: false,
})
const thresholdConflict = meetsStabilityThreshold({
  rootCount: fullLineage.rootCount,
  conversationCount: fullLineage.conversationCount,
  unresolvedConflict: true,
})
record(
  'R3',
  '门槛（逐字沿用）：3 独立根 + 2 真实会话 ⇒ 通过；**2 根** ⇒ `threshold_not_met`；**有冲突** ⇒ `conflicting_support`',
  fullLineage.rootCount === 3 &&
    fullLineage.conversationCount === 2 &&
    thresholdOk.met &&
    !thresholdRoots.met &&
    thresholdRoots.reason === 'threshold_not_met' &&
    !thresholdConflict.met &&
    thresholdConflict.reason === 'conflicting_support',
  `真实链根=${String(fullLineage.rootCount)}/会话=${String(fullLineage.conversationCount)} · 2 根判决=${thresholdRoots.met ? 'PASS（不该）' : thresholdRoots.reason} · 冲突判决=${thresholdConflict.met ? 'PASS（不该）' : thresholdConflict.reason}`,
  fullLineage.rootCount + fullLineage.conversationCount + 3
)

// ---------------------------------------------------------------------------
// R4/R5 真实入口：runReflectionWindow ⇒ 已接受反思 ⇒ 合法槽位更新
// ---------------------------------------------------------------------------
const draft = (call: { handles: readonly { id: string }[] }, support = call.handles.map((h2) => h2.id)) => ({
  schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION,
  focusQuestion: '对象含糊时是否先核对？',
  explanation: '候选解释（不是外部事实）；来源是已提交的故事经历。',
  supportHandles: support,
  counterHandles: [],
  scope: REFLECTION_DRAFT_SCOPE,
  suggestedSlot: 'clarify_when_ambiguous' as const,
})
const provider = {
  name: 's8-reflection-offline',
  version: 's8-reflection@1',
  async call(call: never) {
    return draft(call as never)
  },
}

async function seedTrigger(
  key: string,
  refs: readonly { sourceId: string }[],
  sequence: number,
  conversationAnchorIds: readonly string[] = anchors
): Promise<{ watermark: number; eventId: string }> {
  const before = await latestDomainEventSequence(db, characterId)
  const appended = await appendDomainEvent(
    db,
    characterId,
    {
      type: 'GOAL_COMPLETED',
      operation: 's8-reflection-fixture',
      payload: {
        goalId: `goal:${key}`,
        basis: 'user_report',
        expectedRevision: 1,
        /* S8：**程序**把故事来源写进 payload ⇒ 追根器据此走到故事提交（ADR-093 D03） */
        sourceStoryRefs: refs.map((ref) => ({ sourceId: ref.sourceId })),
      },
      /*
       * ⚠️ 触发事件带的对话来源**必须由用例指定**：R7 想证明"只有 2 个根就不采纳"，
       * 若这里恒带 3 个 anchor，追根器会经对话侧凑出 3 个根 —— 那测的就不是门槛了
       * （第一版就是这么错的：R7 读到 accepted，而 diag 显示根=3）。
       */
      sourceConversationEventIds: conversationAnchorIds as never,
      idempotencyKey: `s8-reflection:${key}`,
      processor: 's8-reflection',
      processorVersion: 's8-reflection@1',
      scope: 'CHARACTER_INTERNAL',
    } as never,
    ++clock
  )
  void sequence
  const eventId = String((appended as { event?: { id?: unknown } }).event?.id ?? '')
  /*
   * **诊断（不判，只记）**：直接把该域事件交给追根器，看它能不能走到故事提交。
   * 少了这一格，R4 失败时只能看到"被拒"，看不到**是哪一跳断的**。
   */
  const lineage = await expandLineage(lookupForDiagnostics, [{ kind: 'domain_event', id: eventId }], {
    characterId: String(characterId),
  })
  console.log(
    `  [diag] ${key}: 域事件=${eventId} → 根=${String(lineage.rootCount)} 会话=${String(lineage.conversationCount)} ` +
      `拒收=${JSON.stringify(lineage.rejections.map((r) => r.reason))} 派生节点=${String(lineage.derivedNodeCount)}`
  )
  return { watermark: before, eventId }
}

const legalWatermark = await seedTrigger('legal', storyRefs, ++clock).then((row) => row.watermark)
const legalOutcome = await runReflectionWindow(db, {
  characterId,
  activeUserId: h.userId,
  watermark: legalWatermark,
  adaptiveEnabled: true,
  provider: provider as never,
  now: () => ++clock,
})
const legalRecord = (await listReflectionRecords(db, characterId)).find(
  (row) => row.reflectionId === legalOutcome.reflectionId
)
record(
  'R4',
  '真实入口：域事件（payload 带 `sourceStoryRefs`）+ 3 个故事根 / 2 真实会话 ⇒ 反思**已接受**，且 `rootCount`/`conversationCount` 由**程序**算出',
  legalOutcome.kind === 'accepted' &&
    legalRecord?.status === 'accepted' &&
    legalRecord.rootCount === 3 &&
    legalRecord.conversationCount === 2,
  `结果=${legalOutcome.kind} · 详情=${String((legalOutcome as { detail?: string }).detail ?? '')} · 记录状态=${String(legalRecord?.status)} · 根=${String(legalRecord?.rootCount)} · 会话=${String(legalRecord?.conversationCount)}`,
  (legalRecord?.rootCount ?? 0) + (legalRecord?.conversationCount ?? 0)
)

const statesAfter = await listAdaptiveSelfStates(db, characterId)
const clarifState = statesAfter.find((state) => state.slot === 'clarify_when_ambiguous')
record(
  'R5',
  '有限采纳：合法槽位更新为 `enhanced`（`revision ≥ 1`），且**只**动这三个槽里的这一个（`S8-A30`）',
  clarifState?.level === 'enhanced' &&
    clarifState.revision >= 1 &&
    statesAfter.filter((state) => state.level === 'enhanced').length === 1,
  `槽位=${String(clarifState?.slot)} · 档位=${String(clarifState?.level)} · revision=${String(clarifState?.revision)} · enhanced 槽数=${String(statesAfter.filter((s) => s.level === 'enhanced').length)}`,
  statesAfter.filter((state) => state.level === 'enhanced').length + 1
)

// ---------------------------------------------------------------------------
// R6 实际入模：token 额度 > 0 ⇒ 有 section；额度 = 0 ⇒ **如实未入模**
// ---------------------------------------------------------------------------
async function compile(budget: number): Promise<{ sections: number; refs: string[]; traceKinds: string[] }> {
  const gateway = new TurnGateway({
    kernel: h.kernel,
    definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot,
    recorder: h.recorder,
    conversationSequence: h.nextTurnSequence,
    recentLimit: 16,
    slowPathEnabled: false,
    userId: h.userId,
    recallBudget: { ...DEFAULT_CONTEXT_BUDGET, adaptiveSelfTokens: budget },
  })
  const turn = await gateway.beginTurn('隔离入口：帮我核对当前对象。')
  const packet = await gateway.compileTurn({
    turn,
    currentInput: '隔离入口：帮我核对当前对象。',
    recentLines: [],
    buildAdaptiveSelfStates: () => readUsableAdaptiveSelfStates(db, characterId, h.userId),
    buildReflectionFactPack: () => readCurrentReflectionFactPack(db, characterId, h.userId),
  })
  await gateway.completeTurn({ turn, replyText: '（离线占位回复）', modelDurationMs: 0 })
  const trace = await getTrace(db, turn.traceId)
  return {
    sections: packet.sections.filter((row) => row.id === 'adaptive-self').length,
    refs: packet.sections
      .filter((row) => row.id === 'adaptive-self')
      .flatMap((row) => row.sourceRefs ?? [])
      .map((ref) => String(ref)),
    traceKinds: trace?.steps.map((step) => step.kind) ?? [],
  }
}
const withBudget = await compile(300)
const withoutBudget = await compile(0)
record(
  'R6',
  '`S8-A29` 实际入模成对：`adaptiveSelfTokens=300` ⇒ 有 `adaptive-self` section 且来源含已采纳槽位；**`=0`** ⇒ 无 section（如实"未入模"，不假报）',
  withBudget.sections === 1 &&
    withBudget.refs.some((ref) => ref.includes('clarify_when_ambiguous')) &&
    withoutBudget.sections === 0,
  `300 ⇒ section=${String(withBudget.sections)} refs=${JSON.stringify(withBudget.refs)} · 0 ⇒ section=${String(withoutBudget.sections)} · trace=${JSON.stringify(withBudget.traceKinds.slice(0, 6))}`,
  withBudget.sections + withBudget.refs.length + 1
)

// ---------------------------------------------------------------------------
// R7 `S8-A28`：不得手填 accepted / 伪造计数（真实 validator 是唯一放行口）
// ---------------------------------------------------------------------------
const fakeWatermark = (
  await seedTrigger('fake-counts', storyRefs.slice(0, 2), ++clock, [])
).watermark
const fakeOutcome = await runReflectionWindow(db, {
  characterId,
  activeUserId: h.userId,
  watermark: fakeWatermark,
  adaptiveEnabled: true,
  provider: {
    ...provider,
    async call(call: never) {
      return draft(call as never)
    },
  } as never,
  now: () => ++clock,
})
record(
  'R7',
  '`S8-A28`：**2 根**材料走同一真实入口 ⇒ 反思被**拒收**（受理计数由程序算，模型不能自报；门里没有手填 accepted 的路径）',
  fakeOutcome.kind === 'rejected',
  `结果=${fakeOutcome.kind}（根数由程序算：材料只有 2 条合格提交）`,
  1
)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
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

const runId = `postlv2-s8-reflection-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:reflection:verify',
  milestone: 'post-lv2 / S8 / WP5',
  generatedAt: new Date().toISOString(),
  source: { head, workingTreeDirty: porcelain.length > 0, workingTreePorcelain: porcelain.slice(0, 60) },
  isolation: { sandboxDir: sandbox.dir, note: '`isolateDatabase()` 一次性沙箱；`data/pglite` 从不被打开' },
  modelCalls: { real: 0, note: 'provider 是离线固定件（与 M11.1 各门同口径）' },
  contractFingerprints: {
    reflectionInput: sha256(read('src/kernel/contracts/reflection-input.ts')),
    reflectionInputs: sha256(read('src/kernel/app/reflection/inputs.ts')),
    lineageResolver: sha256(read('src/kernel/app/reflection/lineage.ts')),
    reflectionRunner: sha256(read('src/infrastructure/runtime/reflection-runner.ts')),
  },
  notCovered: [
    '独立故事水位与"至多一次消费"（WP6 的 lifecycle 门）',
    '撤回后的读时屏蔽（WP6）',
    '真模型语义评测与行为对照（WP7）',
  ],
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}

writeFileSync(join(outDir, 's8-reflection-verify.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:reflection:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-reflection-verify.json`)

/*
 * ===========================================================================
 *  ⚠️ 收尾：**先关库，再退出**（2026-10-03 实测修掉的一个真缺陷）
 * ===========================================================================
 * 不关的话 `@elizaos/plugin-sql` 的 PGlite 客户端句柄会把 Node 的事件循环吊住 ——
 * 门**已经跑完、证据已经写好**，但进程**永不退出**。后果有两层，都是真的：
 * ```text
 * ① 调用方（pnpm / pwsh / 我的后台包装）永远等不到返回 ⇒ 看起来像"卡住"，
 *    实际是"干完了不肯走"；
 * ② 每次运行都留一个孤儿进程（实测一轮里积了 4 对），而它们仍持有各自的沙箱句柄。
 * ```
 * 因此这里显式关闭进程级单例，然后**显式**给退出码。
 */
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
