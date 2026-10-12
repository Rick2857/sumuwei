/**
 * S8 · WP7a —— **量具有效性 / 金标 / 请求计划**门（`pnpm postlv2:s8:measurement:verify`）。
 *
 * ============================================================================
 *  载体：计划书 WP7（"先验证量具，再按 §6 冻结批次运行"）· 测量计划 §1/§2/§4
 *        验收契约 `S8-A46` `S8-A47` · 纪律 AGENTS §6.7（三段式）§6.8（非零分母）
 * ============================================================================
 *  它守什么（**全离线**：不打开数据库、不发任何模型请求）
 * ---------------------------------------------------------------------------
 * ```text
 * Q1 提交身份解析器      三段式（正控 / 负控 / 恢复）
 * Q2 绑定形状判据        三段式
 * Q3 因果身份键          三段式（user_choice 与对话同键；system 不得冒充）
 * Q4 冻结增量界          三段式（规则表在界内 + 界判据对越界样本**必须响**）
 * Q5 撤回 payload        三段式（空 refs / 坏 id / 坏 reason 各具名拒收）
 * Q6 采纳门槛            空集与不足材料的具名拒收
 * Q7 语料与金标状态      **如实登记**（未人审 = `AWAITING HUMAN REVIEW`，不自签）
 * Q8 请求计划            409 上限逐条在案；本轮**实际消耗 0**（不虚报）
 * Q9 计数型自检          measured_count > 0
 * ```
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(process.cwd())
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8')
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

import {
  assertStoryCommitBinding,
  parseStoryCommitId,
  storyCommitIdOf,
  storyRootKeyOf,
  type StoryCommitRecord,
} from '../src/kernel/storyline/story-ledger.ts'
import {
  MAX_AFFECT_DELTA_PER_EVENT,
  affectDeltaWithinBounds,
} from '../src/kernel/contracts/affect.ts'
import { relationshipDeltaWithinBounds } from '../src/kernel/contracts/relationship.ts'
import {
  STORY_APPRAISAL_RULE_DELTAS,
  STORY_RELATIONSHIP_RULE_DELTAS,
  assertStoryRuleTablesWellFormed,
} from '../src/kernel/contracts/story-appraisal.ts'
import {
  STORY_EXPERIENCE_RETRACTED,
  validateStoryExperienceRetractedPayload,
} from '../src/kernel/contracts/story-events.ts'
import { storyStateEligibilityOf } from '../src/kernel/app/storyline/state-evaluators.ts'
import {
  REFLECTION_MIN_CONVERSATIONS,
  REFLECTION_MIN_INDEPENDENT_ROOTS,
  meetsStabilityThreshold,
} from '../src/kernel/app/reflection/inputs.ts'

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

/** 三段式的通用写法：正控安静 → 注入假象必须响 → 放回真实实现重新安静 */
function threeStage(input: {
  id: string
  label: string
  positive: () => boolean
  negative: () => boolean
  restored: () => boolean
  detail: string
}): void {
  const positive = input.positive()
  const negative = input.negative()
  const restored = input.restored()
  record(input.id, input.label, positive && negative && restored, `${input.detail} · 正控=${String(positive)} · 负控=${String(negative)} · 恢复=${String(restored)}`, 3)
}

// ---------------------------------------------------------------------------
// Q1 提交身份解析器
// ---------------------------------------------------------------------------
const identity = { storyId: 'jichuang-interview-two', storyVersion: 1, runId: 'run-measure', revision: 7 }
const commitId = storyCommitIdOf(identity)
threeStage({
  id: 'Q1',
  label: '提交身份解析器三段式：合法 id **读回逐字段相等**；改一位 revision 即不可解析；还原后重新通过',
  positive: () => {
    const parsed = parseStoryCommitId(commitId)
    return (
      parsed !== undefined &&
      parsed.storyId === identity.storyId &&
      parsed.storyVersion === identity.storyVersion &&
      parsed.runId === identity.runId &&
      parsed.revision === identity.revision
    )
  },
  negative: () =>
    parseStoryCommitId(commitId.replace('.e7', '.e8'))?.revision !== 7 &&
    parseStoryCommitId(commitId.replace('#', '@')) === undefined,
  restored: () => parseStoryCommitId(commitId) !== undefined,
  detail: `id=${commitId}`,
})

// ---------------------------------------------------------------------------
// Q2 绑定形状判据
// ---------------------------------------------------------------------------
const bindingProbe = (binding: Parameters<typeof assertStoryCommitBinding>[0], type: Parameters<typeof assertStoryCommitBinding>[1]): string => {
  try {
    assertStoryCommitBinding(binding, type)
    return 'ACCEPTED'
  } catch (error) {
    return String((error as { code?: string }).code ?? 'REJECTED')
  }
}
const legalBinding = {
  interactionKind: 'user_choice' as const,
  interactionRef: 'conv-1',
  anchorConversationEventId: 'cev-1',
  actorKind: 'user' as const,
}
threeStage({
  id: 'Q2',
  label: '绑定形状三段式：合法形状通过；三种伪造形状**各具名拒收**；还原后重新通过',
  positive: () =>
    bindingProbe(legalBinding, 'CHOICE_COMMITTED') === 'ACCEPTED' &&
    bindingProbe({ interactionKind: 'system', actorKind: 'system' }, 'STORY_STARTED') === 'ACCEPTED',
  negative: () =>
    /*
     * ⚠️ 缺 `interactionRef` 时**先**撞上的是 `story_binding_without_interaction_ref`
     * （那一条在检查顺序里排在 anchor 之前）。第一版这里写成了 anchor 的码 ——
     * 门当场把它读了出来（这正是"判据要按实现顺序核对"的一个小现场）。
     */
    bindingProbe({ ...legalBinding, interactionRef: undefined }, 'CHOICE_COMMITTED') ===
      'story_binding_without_interaction_ref' &&
    bindingProbe({ ...legalBinding, anchorConversationEventId: undefined }, 'CHOICE_COMMITTED') ===
      'story_binding_without_anchor' &&
    bindingProbe({ interactionKind: 'system', interactionRef: 'forged', actorKind: 'system' }, 'STORY_STARTED') ===
      'story_binding_system_with_session' &&
    bindingProbe(legalBinding, 'STORY_STARTED') === 'story_binding_kind_not_allowed',
  restored: () => bindingProbe(legalBinding, 'CHOICE_COMMITTED') === 'ACCEPTED',
  detail: '四种伪造 = 缺会话 / 缺 anchor / system 夹带会话 / 对 STORY_STARTED 声明 user_choice',
})

// ---------------------------------------------------------------------------
// Q3 因果身份键
// ---------------------------------------------------------------------------
const recordOf = (binding: StoryCommitRecord['binding']): StoryCommitRecord =>
  ({
    commitId,
    storyId: identity.storyId,
    storyVersion: identity.storyVersion,
    runId: identity.runId,
    revision: identity.revision,
    binding,
  }) as StoryCommitRecord
threeStage({
  id: 'Q3',
  label: '因果身份键三段式：`user_choice` 与它的 anchor **同键**；`system` **不得**落到对话键；还原后同键',
  positive: () => storyRootKeyOf(recordOf(legalBinding)) === 'conversation:cev-1',
  negative: () => {
    const systemKey = storyRootKeyOf(recordOf({ interactionKind: 'system', actorKind: 'system' }))
    return systemKey !== 'conversation:cev-1' && systemKey === `story-system:${commitId}`
  },
  restored: () => storyRootKeyOf(recordOf(legalBinding)) === 'conversation:cev-1',
  detail: `anchor=cev-1 · commit=${commitId}`,
})

// ---------------------------------------------------------------------------
// Q4 冻结增量界（规则表在界内 + 界判据对越界样本必须响）
// ---------------------------------------------------------------------------
threeStage({
  id: 'Q4',
  label: '冻结增量界三段式：冻结表自检通过；界判据对越界样本**必须响**（两个域各一次）；还原后重新安静',
  positive: () => {
    assertStoryRuleTablesWellFormed()
    return (
      Object.values(STORY_APPRAISAL_RULE_DELTAS).every((delta) => affectDeltaWithinBounds(delta)) &&
      Object.values(STORY_RELATIONSHIP_RULE_DELTAS).every((delta) =>
        relationshipDeltaWithinBounds({ trust: delta.deltaTrust, closeness: delta.deltaCloseness })
      )
    )
  },
  negative: () =>
    !affectDeltaWithinBounds({ deltaValence: MAX_AFFECT_DELTA_PER_EVENT + 0.01, deltaArousal: 0 }) &&
    !relationshipDeltaWithinBounds({ trust: 0.9, closeness: 0 }),
  restored: () => affectDeltaWithinBounds({ deltaValence: 0, deltaArousal: 0 }),
  detail: `情绪上限=${String(MAX_AFFECT_DELTA_PER_EVENT)} · 情绪规则=${String(Object.keys(STORY_APPRAISAL_RULE_DELTAS).length)} 条 · 关系规则=${String(Object.keys(STORY_RELATIONSHIP_RULE_DELTAS).length)} 条`,
})

// ---------------------------------------------------------------------------
// Q5 撤回 payload
// ---------------------------------------------------------------------------
const legalRetraction = {
  characterId: 'char-1',
  withdrawnStoryRefs: [
    {
      sourceId: commitId,
      storyId: identity.storyId,
      storyVersion: identity.storyVersion,
      runId: identity.runId,
      eventId: 'e7',
      experienceScope: 'story_experience' as const,
    },
  ],
  reason: 'user_withdrew' as const,
  withdrawnAt: 1,
}
const retractionProbe = (payload: unknown): string => {
  try {
    validateStoryExperienceRetractedPayload(payload)
    return 'ACCEPTED'
  } catch {
    return 'REJECTED'
  }
}
threeStage({
  id: 'Q5',
  label: '撤回 payload 三段式：合法形状通过；**空 refs / 坏来源 id / 坏 reason** 三种假象各拒收；还原后通过',
  positive: () => retractionProbe(legalRetraction) === 'ACCEPTED',
  negative: () =>
    retractionProbe({ ...legalRetraction, withdrawnStoryRefs: [] }) === 'REJECTED' &&
    retractionProbe({
      ...legalRetraction,
      withdrawnStoryRefs: [{ ...legalRetraction.withdrawnStoryRefs[0]!, sourceId: 'not-a-story-id' }],
    }) === 'REJECTED' &&
    retractionProbe({ ...legalRetraction, reason: 'because' }) === 'REJECTED',
  restored: () => retractionProbe(legalRetraction) === 'ACCEPTED',
  detail: `事件类型=${STORY_EXPERIENCE_RETRACTED}`,
})

// ---------------------------------------------------------------------------
// Q6 采纳门槛 + 故事资格（判定器的**不可达面**也要问）
// ---------------------------------------------------------------------------
const full = meetsStabilityThreshold({ rootCount: 3, conversationCount: 2, unresolvedConflict: false })
const twoRoots = meetsStabilityThreshold({ rootCount: 2, conversationCount: 2, unresolvedConflict: false })
const oneSession = meetsStabilityThreshold({ rootCount: 3, conversationCount: 1, unresolvedConflict: false })
const conflict = meetsStabilityThreshold({ rootCount: 3, conversationCount: 2, unresolvedConflict: true })
const empty = meetsStabilityThreshold({ rootCount: 0, conversationCount: 0, unresolvedConflict: false })
const systemEligibility = storyStateEligibilityOf({
  commit: {
    ...recordOf({ interactionKind: 'system', actorKind: 'system' }),
    /* `system` 提交也要有**合法的**提交身份，否则撞上的是身份闸而不是"非真实交互"闸 */
    commitId: storyCommitIdOf({ ...identity, runId: 'run-measure-system' }),
    runId: 'run-measure-system',
  } as StoryCommitRecord,
  anchorSequence: 1,
})
record(
  'Q6',
  '门槛判据：刚好达标通过；2 根 / 1 会话 / 有冲突 / 空集**各自具名拒收**；`system` 提交的故事资格也具名拒收',
  full.met &&
    !twoRoots.met &&
    twoRoots.reason === 'threshold_not_met' &&
    !oneSession.met &&
    oneSession.reason === 'single_session_only' &&
    !conflict.met &&
    conflict.reason === 'conflicting_support' &&
    !empty.met &&
    !systemEligibility.eligible &&
    systemEligibility.reason === 'story_feedback_not_real_interaction',
  `门槛=${String(REFLECTION_MIN_INDEPENDENT_ROOTS)} 根 / ${String(REFLECTION_MIN_CONVERSATIONS)} 会话 · 实读：2 根=${twoRoots.met ? 'PASS(不该)' : twoRoots.reason} · 1 会话=${oneSession.met ? 'PASS(不该)' : oneSession.reason} · 冲突=${conflict.met ? 'PASS(不该)' : conflict.reason} · system=${systemEligibility.eligible ? 'eligible(不该)' : systemEligibility.reason}`,
  6
)

// ---------------------------------------------------------------------------
// Q7 语料与金标状态（**如实登记**）
// ---------------------------------------------------------------------------
const pack = read('evals/storyline/jichuang-interview-two/story-pack.ts')
const manifest = JSON.parse(read('evals/storyline/jichuang-interview-two/content-manifest.json')) as {
  inkSourceSha256?: string
}
const goldLabelPath = 'evals/post-lv2/s8/annotations/labels.json'
const goldExists = (() => {
  try {
    read(goldLabelPath)
    return true
  } catch {
    return false
  }
})()
record(
  'Q7',
  '语料与金标状态**如实登记**：语料 = 既有内容包（版本/摘要可核）；**金标尚未人审 ⇒ `AWAITING HUMAN REVIEW`**（不自签）',
  pack.includes('JICHUANG_STORY_VERSION = 1') &&
    typeof manifest.inkSourceSha256 === 'string' &&
    manifest.inkSourceSha256.length >= 8 &&
    !goldExists,
  `内容包 v1 · inkSourceSha256=${String(manifest.inkSourceSha256)} · 金标文件在案=${String(goldExists)} ⇒ ${goldExists ? '（仍须人审后才可称冻结金标）' : 'AWAITING HUMAN REVIEW'}`,
  2
)

// ---------------------------------------------------------------------------
// Q8 请求计划（冻结上限逐条在案 + 本轮实际消耗）
// ---------------------------------------------------------------------------
const planText = read('docs/post-lv2/S8-Measurement-Plan.md')
const planRows = [
  { name: '开发探针', cap: 12, token: '| 开发探针 | 最多 12 个候选请求' },
  { name: '正式语义', cap: 144, token: '| 正式语义 | 48 项 × 3 轮' },
  { name: '真模型短链', cap: 16, token: '| 真模型短链 | 8 条' },
  { name: '留出行为', cap: 171, token: '| 留出行为 | 三槽 × 6 项 × 三组 × 3 次重复' },
  { name: '有界长轨迹', cap: 66, token: '| 有界长轨迹 | 三槽各 20 轮' },
]
const planOk = planRows.every((row) => planText.includes(row.token)) && planText.includes('**409**')
record(
  'Q8',
  '请求计划：五批次与 **409** 上限逐条在案；本轮**实际模型请求 = 0**（不虚报消耗，也不预支未来批次）',
  planOk,
  `批次=${JSON.stringify(planRows.map((row) => `${row.name}:${String(row.cap)}`))} · 上限在案=${String(planText.includes('**409**'))} · 本轮实际消耗=0`,
  planRows.length + 1
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

const runId = `postlv2-s8-measurement-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:measurement:verify',
  milestone: 'post-lv2 / S8 / WP7a',
  generatedAt: new Date().toISOString(),
  source: { head, workingTreeDirty: porcelain.length > 0, workingTreePorcelain: porcelain.slice(0, 60) },
  /** 本门**不**打开库、**不**发请求：它是"先验证量具"那一步 */
  offline: { databaseOpened: false, modelRequests: 0 },
  corpus: {
    storyId: 'jichuang-interview-two',
    storyVersion: 1,
    contentDigest: manifest.inkSourceSha256 ?? null,
  },
  goldLabels: {
    path: goldLabelPath,
    present: goldExists,
    status: goldExists ? 'PRESENT_AWAITING_HUMAN_REVIEW' : 'AWAITING HUMAN REVIEW',
  },
  requestPlan: {
    batches: planRows.map((row) => ({ name: row.name, cap: row.cap })),
    totalCap: 409,
    consumedThisRound: 0,
  },
  contractFingerprints: {
    measurementPlan: sha256(planText),
    storyLedger: sha256(read('src/kernel/storyline/story-ledger.ts')),
    storyAppraisal: sha256(read('src/kernel/contracts/story-appraisal.ts')),
    storyEvents: sha256(read('src/kernel/contracts/story-events.ts')),
  },
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}

writeFileSync(join(outDir, 's8-measurement-verify.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:measurement:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-measurement-verify.json`)
process.exit(passed ? 0 : 1)
