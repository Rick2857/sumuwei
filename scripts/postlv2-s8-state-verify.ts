/**
 * S8 · WP4 —— **故事驱动的状态更新**门（`pnpm postlv2:s8:state:verify`）。
 *
 * ============================================================================
 *  载体：计划书 WP4 退出条件 · ADR-093 `D08`/`D09` · 验收契约
 *        `S8-A19` `S8-A20` `S8-A21` `S8-A22` `S8-A23` `S8-A24`
 * ============================================================================
 *  退出条件逐条对应
 * ---------------------------------------------------------------------------
 * ```text
 * · 合法实际合作能产生**预期的非零**情绪/关系更新        → V1（提案）/ V2（放行口接受）
 * · 提案**可追到原始故事根**                            → V1（sourceStoryRefs = commitId）
 * · 隐藏作者设定 / NPC 评价冒充用户 / 重复提交零额外影响 → V6 / V7 / V8
 * · 既有范围、单次 delta、对话规则及 cutover 回归通过   → V3 / V4 / V5 / V9
 * ```
 *
 * ⚠️ 全部在 `isolateDatabase()` 的**一次性沙箱**里；`data/pglite` **从不被打开**。
 * ⚠️ 零模型调用、零出网。正控 / 负控 / 恢复三段式 + 非零分母自检。
 */

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

const sandbox = isolateDatabase('postlv2-s8-state', { keep: false })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const { createStoryLedgerStore } = await import(
  '../src/infrastructure/storyline/store/story-ledger-store.ts'
)
const { commitStoryTurn } = await import('../src/kernel/app/storyline/commit-service.ts')
const {
  buildStoryAffectProposals,
  buildStoryRelationshipProposals,
  storyStateEligibilityOf,
} = await import('../src/kernel/app/storyline/state-evaluators.ts')
const { validateAffectProposal } = await import('../src/kernel/policies/affect-validator.ts')
const { validateRelationshipProposal } = await import('../src/kernel/policies/relationship-validator.ts')
const { createFullDomainEventRegistry } = await import('../src/kernel/contracts/domain-event.ts')
const { JICHUANG_PACK } = await import('../evals/storyline/jichuang-interview-two/story-pack.ts')
const { MAX_AFFECT_DELTA_PER_EVENT } = await import('../src/kernel/contracts/affect.ts')
const { AFFECT_IMPACT, AFFECT_TOUCH, RELATIONSHIP_IMPACT } = await import(
  '../src/kernel/contracts/domain-event.ts'
)
const { relationshipDeltaWithinBounds } = await import('../src/kernel/contracts/relationship.ts')
const { assertStoryRuleTablesWellFormed, STORY_APPRAISAL_RULE_IDS, STORY_RELATIONSHIP_RULE_IDS } =
  await import('../src/kernel/contracts/story-appraisal.ts')
const { asConversationEventId } = await import('../src/kernel/contracts/ids.ts')

const h = await createM4Harness({ label: 'postlv2-s8-state' })
const db = h.db
const ledger = createStoryLedgerStore(db)
const registry = createFullDomainEventRegistry()
const USER = h.userId

// ---------------------------------------------------------------------------
// 前置：真实账本上走一条"合法合作"路径（align_first → go_prepare → split_by_strength）
// ---------------------------------------------------------------------------
const RUN = 's8-state-main'
const anchor1 = (await h.recordUserEvidence('我们先把分工对齐一下。')).ref.id
const anchor2 = (await h.recordUserEvidence('那就按各自擅长来分。')).ref.id
const anchor3 = (await h.recordUserEvidence('练完之后直接进去。')).ref.id

const commit = (
  action: Parameters<typeof commitStoryTurn>[0]['request']['action'],
  anchor: string,
  key: string,
  now: number
): ReturnType<typeof commitStoryTurn> =>
  commitStoryTurn({
    ledger,
    request: {
      pack: JICHUANG_PACK,
      runId: RUN,
      binding: {
        interactionKind: 'user_choice',
        interactionRef: `conv-${RUN}`,
        anchorConversationEventId: String(anchor),
        actorKind: 'user',
        actorId: USER,
      },
      idempotencyKey: key,
      action,
      now,
    },
  })

const started = await commitStoryTurn({
  ledger,
  request: {
    pack: JICHUANG_PACK,
    runId: RUN,
    binding: { interactionKind: 'system', actorKind: 'system' },
    idempotencyKey: `${RUN}:start`,
    action: { kind: 'start' },
    now: 0,
  },
})
if (!started.ok) throw new Error(`前置失败（开局）：${started.code}`)
const c1 = await commit({ kind: 'choice', choiceId: 'align_first', expectedRevision: 1 }, String(anchor1), `${RUN}:r1`, 1)
if (!c1.ok) throw new Error(`前置失败（r1）：${c1.code}`)
const c2 = await commit({ kind: 'choice', choiceId: 'go_prepare', expectedRevision: 2 }, String(anchor2), `${RUN}:r2`, 2)
if (!c2.ok) throw new Error(`前置失败（r2）：${c2.code}`)
const c3 = await commit({ kind: 'choice', choiceId: 'split_by_strength', expectedRevision: 3 }, String(anchor3), `${RUN}:r3`, 3)
if (!c3.ok) throw new Error(`前置失败（r3）：${c3.code}`)

const commits = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN })
const anchorByCommit = new Map<string, number>([
  [c1.commit.commitId, 11],
  [c2.commit.commitId, 12],
  [c3.commit.commitId, 13],
])
const candidates = commits.map((item) => ({
  commit: item,
  anchorSequence: anchorByCommit.get(item.commitId) ?? 1,
}))

// ---------------------------------------------------------------------------
// V1 正控：合法合作 ⇒ **非零**情绪提案，且来源可追到原始故事根
// ---------------------------------------------------------------------------
const affectProposals = buildStoryAffectProposals({
  characterId: h.characterId as never,
  candidates,
  commits,
})
const impacts = affectProposals.filter((p) => p.targetEvents.some((t) => t.type === AFFECT_IMPACT))
const touches = affectProposals.filter((p) => p.targetEvents.some((t) => t.type === AFFECT_TOUCH))
const nonzero = impacts.filter((p) => {
  const payload = p.targetEvents[0]!.payload as { delta: { deltaValence: number; deltaArousal: number } }
  return payload.delta.deltaValence !== 0 || payload.delta.deltaArousal !== 0
})
const rootsTraceable = affectProposals.every((proposal) =>
  (proposal.sourceStoryRefs ?? []).some((ref) => commits.some((item) => item.commitId === ref.sourceId))
)
record(
  'V1',
  '正控：真实账本上的合法合作路径 ⇒ Affect 提案 **非零** delta（TOUCH 与 IMPACT 分立），且每条提案的 `sourceStoryRefs` 指回**真实提交身份**',
  commits.length === 4 &&
    touches.length === 3 &&
    impacts.length >= 1 &&
    nonzero.length === impacts.length &&
    rootsTraceable,
  `提交=${commits.length} · TOUCH=${touches.length} · IMPACT=${impacts.length} · 非零=${nonzero.length} · 来源可追=${String(rootsTraceable)}`,
  commits.length + touches.length + impacts.length
)

// ---------------------------------------------------------------------------
// V2 真实放行口：故事 IMPACT/TOUCH 被**接受**（不是"evaluator 被调用了"）
// ---------------------------------------------------------------------------
const evidenceReadingOf = (id: string) => ({
  id: asConversationEventId(id),
  characterId: h.characterId,
  sequence: 11,
  type: 'user_message',
  trustedOrigin: {
    /*
     * ⚠️ `axisBConfirmed` 是 `sourceQualificationOf` 的**第一道**闸：少了它，
     * 任何来源都判 `UNCONFIRMED_ORIGIN`。第一版就是踩在这里，而门如实把它读了出来
     * （`affect_source_unqualified` + 详情里的 `UNCONFIRMED_ORIGIN`）—— 这正是
     * "放行口而不是 evaluator 才是判据的归属处"的一个现场证据。
     */
    axisBConfirmed: true,
    contentOriginator: { state: 'KNOWN' as const, value: { kind: 'USER' as const, id: USER } },
  },
})
const affectDeps = {
  registry,
  evidence: { findEvents: async (ids: readonly never[]) => ids.map((id) => evidenceReadingOf(String(id))) },
  processed: { hasProcessed: async () => false },
  affect: {
    getAffectState: async () => ({
      originated: true,
      valence: 0,
      arousal: 0,
      lastInteractionAt: undefined,
      lastAffectEventAt: undefined,
      originKind: 'INTERACTION_DERIVED' as const,
    }),
  },
  policy: { activeUserId: USER },
}
const acceptedByValidator: string[] = []
const rejectedCodes: string[] = []
const rejectedDetails: string[] = []
for (const proposal of affectProposals) {
  const outcome = await validateAffectProposal(affectDeps as never, proposal as never)
  for (const event of outcome.acceptedEvents) acceptedByValidator.push(String(event.type))
  for (const rejection of outcome.rejected) {
    rejectedCodes.push(rejection.code)
    rejectedDetails.push(String(rejection.message))
  }
}
record(
  'V2',
  '真实 Affect 放行口**接受**故事 TOUCH/IMPACT（正控非零：不是"只看到 evaluator 被调用"）',
  acceptedByValidator.filter((type) => type === AFFECT_TOUCH).length === 3 &&
    acceptedByValidator.filter((type) => type === AFFECT_IMPACT).length >= 1 &&
    rejectedCodes.length === 0,
  `接受=${acceptedByValidator.length}（TOUCH ${acceptedByValidator.filter((t) => t === AFFECT_TOUCH).length} / IMPACT ${acceptedByValidator.filter((t) => t === AFFECT_IMPACT).length}）· 拒码=${JSON.stringify(rejectedCodes)} · 首条详情=${rejectedDetails[0] ?? '（无）'}`,
  acceptedByValidator.length + rejectedCodes.length
)

// ---------------------------------------------------------------------------
// V3/V4/V5 负控：放行口的**故事分支**逐条具名拒收（改一个字段就换一个码）
// ---------------------------------------------------------------------------
const sample = impacts[0]!
const mutate = (patch: Record<string, unknown>): Record<string, unknown> => {
  const target = sample.targetEvents[0]!
  return { ...(target.payload as Record<string, unknown>), ...patch }
}
const probeImpact = async (patch: Record<string, unknown>): Promise<string[]> => {
  const outcome = await validateAffectProposal(
    affectDeps as never,
    { ...sample, targetEvents: [{ ...sample.targetEvents[0]!, payload: mutate(patch) }] } as never
  )
  return outcome.rejected.map((r) => r.code)
}
const v3 = await probeImpact({ originKind: 'INTERACTION_DERIVED' })
const v4 = await probeImpact({
  delta: { deltaValence: 0.001, deltaArousal: 0.0 },
})
const v5 = await probeImpact({ ruleId: 'S-NOT-A-REAL-RULE' })
record(
  'V3',
  '负控：故事规则表 + `originKind ≠ STORY_DERIVED` ⇒ `affect_origin_kind_mismatch`（故事来源不得挂在"用户交互"名下）',
  v3.includes('affect_origin_kind_mismatch'),
  `拒码=${JSON.stringify(v3)}`,
  1
)
record(
  'V4',
  '负控：delta **不是**该规则的冻结值 ⇒ `affect_delta_not_exact`（故事规则要求精确一致，不是范围界）',
  v4.includes('affect_delta_not_exact'),
  `拒码=${JSON.stringify(v4)}`,
  1
)
record(
  'V5',
  '负控：`ruleId` 不在故事规则表 ⇒ `affect_rule_unknown`',
  v5.includes('affect_rule_unknown'),
  `拒码=${JSON.stringify(v5)}`,
  1
)

// ---------------------------------------------------------------------------
// V6 负控：`system` 提交（作者设定 / 后台推进）⇒ **零**状态提案
// ---------------------------------------------------------------------------
const systemCandidate = {
  commit: { ...c3.commit, binding: { interactionKind: 'system' as const, actorKind: 'system' as const } },
  anchorSequence: 1,
}
const systemEligibility = storyStateEligibilityOf(systemCandidate)
const systemProposals = buildStoryAffectProposals({
  characterId: h.characterId as never,
  candidates: [systemCandidate],
  commits: [systemCandidate.commit],
})
const systemRelationship = buildStoryRelationshipProposals({
  characterId: h.characterId as never,
  targetUserId: USER,
  candidates: [systemCandidate],
  commits: [systemCandidate.commit],
})
record(
  'V6',
  '负控：`system` 提交（作者设定 / 后台推进）⇒ 资格具名拒收且**零**提案（情绪与关系都是 0）',
  !systemEligibility.eligible &&
    systemEligibility.reason === 'story_feedback_not_real_interaction' &&
    systemProposals.length === 0 &&
    systemRelationship.length === 0,
  `资格=${systemEligibility.eligible ? '合格（不该）' : systemEligibility.reason} · 情绪提案=${systemProposals.length} · 关系提案=${systemRelationship.length}`,
  3
)

// ---------------------------------------------------------------------------
// V7 真实 Relationship 放行口：合法交互被接受；`STORY_DERIVED` 不配版本 ⇒ 拒收
// ---------------------------------------------------------------------------
const relationshipProposals = buildStoryRelationshipProposals({
  characterId: h.characterId as never,
  targetUserId: USER,
  candidates,
  commits,
})
const relationshipDeps = {
  registry,
  evidence: { findEvents: async (ids: readonly never[]) => ids.map((id) => evidenceReadingOf(String(id))) },
  processed: { hasProcessed: async () => false },
  relationships: {
    getRelationshipState: async () => ({
      originated: true,
      trust: 0.85,
      closeness: 0.7,
      lastInteractionAt: undefined,
      originKind: 'INTERACTION_DERIVED' as const,
    }),
  },
  events: { getDomainEvent: async () => undefined },
}
const relationshipAccepted: string[] = []
const relationshipRejected: string[] = []
for (const proposal of relationshipProposals) {
  const outcome = await validateRelationshipProposal(relationshipDeps as never, proposal as never)
  for (const event of outcome.acceptedEvents) relationshipAccepted.push(String(event.type))
  for (const rejection of outcome.rejected) relationshipRejected.push(rejection.code)
}
const noVersionProbe = await validateRelationshipProposal(
  relationshipDeps as never,
  {
    ...relationshipProposals[0]!,
    targetEvents: [
      {
        ...relationshipProposals[0]!.targetEvents[0]!,
        payload: { ...(relationshipProposals[0]!.targetEvents[0]!.payload as object), ruleVersion: undefined },
      },
    ],
  } as never
)
record(
  'V7',
  '真实 Relationship 放行口：合法故事交互**被接受**；而 `STORY_DERIVED` 不配故事版本 ⇒ 具名拒收（反向闸）',
  relationshipProposals.length >= 1 &&
    relationshipAccepted.filter((type) => type === RELATIONSHIP_IMPACT).length ===
      relationshipProposals.length &&
    relationshipRejected.length === 0 &&
    noVersionProbe.rejected.some((r) => r.code === 'relationship_origin_kind_mismatch'),
  `关系提案=${relationshipProposals.length} · 接受=${relationshipAccepted.length} · 拒码=${JSON.stringify(relationshipRejected)} · 反向闸=${JSON.stringify(noVersionProbe.rejected.map((r) => r.code))}`,
  relationshipProposals.length + relationshipAccepted.length + 1
)

// ---------------------------------------------------------------------------
// V8 `S8-A22`：故事来源**不**制造旧对话里程碑计数
// ---------------------------------------------------------------------------
const units = relationshipProposals.map(
  (proposal) => (proposal.targetEvents[0]!.payload as { unit: string }).unit
)
const noMilestoneUnits = units.every(
  (unit) => !unit.startsWith('messages-') && !unit.startsWith('days-')
)
record(
  'V8',
  '`S8-A22`：故事关系的幂等单元是**提交身份**（既不是 `messages-*` 也不是 `days-*`）⇒ 故事来源**不**增加旧对话里程碑计数',
  units.length === relationshipProposals.length && noMilestoneUnits,
  `单元=${JSON.stringify(units)}`,
  units.length
)

// ---------------------------------------------------------------------------
// V9 回归 + 上限不放宽（`S8-A20`/`S8-A24`）
// ---------------------------------------------------------------------------
let boundsOk = true
try {
  assertStoryRuleTablesWellFormed()
} catch {
  boundsOk = false
}
const affectWithin = impacts.every((proposal) => {
  const delta = (proposal.targetEvents[0]!.payload as { delta: { deltaValence: number; deltaArousal: number } })
    .delta
  return (
    Math.abs(delta.deltaValence) <= MAX_AFFECT_DELTA_PER_EVENT &&
    Math.abs(delta.deltaArousal) <= MAX_AFFECT_DELTA_PER_EVENT
  )
})
const relWithin = relationshipProposals.every((proposal) => {
  const delta = (proposal.targetEvents[0]!.payload as { delta: { trust: number; closeness: number } }).delta
  return relationshipDeltaWithinBounds({ trust: delta.trust, closeness: delta.closeness })
})
record(
  'V9',
  '`S8-A20`/`S8-A24`：规则表自检通过；每条情绪 delta 都在 `MAX_AFFECT_DELTA_PER_EVENT` 内、每条关系增量都在**既有**单事件上限内（不放宽）',
  boundsOk &&
    affectWithin &&
    relWithin &&
    STORY_APPRAISAL_RULE_IDS.length > 0 &&
    STORY_RELATIONSHIP_RULE_IDS.length > 0,
  `自检=${String(boundsOk)} · 情绪在界内=${String(affectWithin)} · 关系在界内=${String(relWithin)} · 规则数=${STORY_APPRAISAL_RULE_IDS.length}/${STORY_RELATIONSHIP_RULE_IDS.length}`,
  impacts.length + relationshipProposals.length + 2
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

const runId = `postlv2-s8-state-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:state:verify',
  milestone: 'post-lv2 / S8 / WP4',
  generatedAt: new Date().toISOString(),
  source: { head, workingTreeDirty: porcelain.length > 0, workingTreePorcelain: porcelain.slice(0, 60) },
  isolation: { sandboxDir: sandbox.dir, note: '`isolateDatabase()` 一次性沙箱；`data/pglite` 从不被打开' },
  contractFingerprints: {
    storyAppraisal: sha256(read('src/kernel/contracts/story-appraisal.ts')),
    affectValidator: sha256(read('src/kernel/policies/affect-validator.ts')),
    relationshipValidator: sha256(read('src/kernel/policies/relationship-validator.ts')),
    stateEvaluators: sha256(read('src/kernel/app/storyline/state-evaluators.ts')),
  },
  /** 本门**不**覆盖的面（如实登记，不许读成已实现） */
  notCovered: [
    '故事提案进入**真实调度/水位**（WP5 的 reflection 与 WP6 的 lifecycle 才接线）',
    '入模（ContextCompiler 实际入模）= WP5',
  ],
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}

writeFileSync(join(outDir, 's8-state-verify.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:state:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-state-verify.json`)

/*
 * ⚠️ 收尾：**先关库，再退出**。不关的话 PGlite 句柄会把事件循环吊住 ⇒
 * 门跑完了却不退出（实测表现为"看起来卡住" + 每轮留一个孤儿进程）。
 */
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
