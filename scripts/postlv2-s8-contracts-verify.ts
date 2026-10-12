/**
 * S8 · WP3a —— **契约与边界**门（`pnpm postlv2:s8:contracts:verify`）。
 *
 * ============================================================================
 *  载体：ADR-093 `D02`/`D03`/`D04`/`D14` · 验收契约 `S8-A04`/`A05`/`A06`/`A07`/`A08`/`A11`/`A18`
 * ============================================================================
 *  它守什么（**纯离线**：不打开任何数据库、不发任何模型请求）
 * ---------------------------------------------------------------------------
 * ```text
 * C1 EvidenceKind       = 旧四类 + story_event（**旧四类逐字不变**）
 * C2 LineageHandleKind  = 旧四类 + story_event
 * C3 LineageSourceClass = 旧五类 + story_experience
 * C4 STORY_OBSERVATION **不**支持外部事实（模拟结局永不升级成现实结论）
 * C5 故事事实**不可能**写成对话事件（负控：构造器真的抛错，不是"没人这么写"）
 * C6 绑定形状负控：system 夹带会话 / user_choice 缺 anchor / 对 STORY_STARTED 声明 user_choice
 * C7 旧解码不变：旧四类 kind 仍可用，且新集合是旧集合的**超集**
 * C8 计数型自检：measured_count > 0
 * ```
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import { EVIDENCE_KINDS, evidenceRef } from '../src/kernel/contracts/memory.ts'
import {
  LINEAGE_HANDLE_KINDS,
  LINEAGE_SOURCE_CLASSES,
} from '../src/kernel/contracts/reflection-lineage.ts'
import { REFLECTION_TRIGGER_FACTS, REFLECTION_TRIGGER_KINDS } from '../src/kernel/contracts/reflection-input.ts'
import {
  assertStorySourceIsNotExternalFact,
  canSupportExternalFact,
} from '../src/kernel/contracts/source-authority.ts'
import { createConversationEvent } from '../src/kernel/contracts/conversation-event.ts'
import {
  assertStoryCommitBinding,
  storyCommitIdOf,
  parseStoryCommitId,
  storyRootKeyOf,
  type StoryCommitRecord,
} from '../src/kernel/storyline/story-ledger.ts'
import { canWriteStoryFactAsConversationEvent } from '../src/kernel/storyline/world-observation.ts'

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

/** ADR-093 冻结的**旧**词汇（逐字；改这里等于悄悄改旧语义） */
const LEGACY_EVIDENCE_KINDS = ['conversation_event', 'observation', 'domain_event', 'tool_observation']
const LEGACY_HANDLE_KINDS = ['conversation_event', 'domain_event', 'memory', 'belief']
const LEGACY_SOURCE_CLASSES = [
  'user_statement',
  'user_report',
  'assistant_speech',
  'program_result',
  'internal_interpretation',
]

// ---------------------------------------------------------------------------
// C1/C2/C3 词汇表：旧值逐字不变 + 只追加
// ---------------------------------------------------------------------------
const evidenceOk =
  LEGACY_EVIDENCE_KINDS.every((kind, index) => EVIDENCE_KINDS[index] === kind) &&
  EVIDENCE_KINDS.length === LEGACY_EVIDENCE_KINDS.length + 1 &&
  EVIDENCE_KINDS.includes('story_event')
const handleOk =
  LEGACY_HANDLE_KINDS.every((kind, index) => LINEAGE_HANDLE_KINDS[index] === kind) &&
  LINEAGE_HANDLE_KINDS.length === LEGACY_HANDLE_KINDS.length + 1 &&
  LINEAGE_HANDLE_KINDS.includes('story_event')
const sourceClassOk =
  LEGACY_SOURCE_CLASSES.every((cls, index) => LINEAGE_SOURCE_CLASSES[index] === cls) &&
  LINEAGE_SOURCE_CLASSES.length === LEGACY_SOURCE_CLASSES.length + 1 &&
  LINEAGE_SOURCE_CLASSES.includes('story_experience')
record(
  'C1',
  '三张受控词汇表：**旧值逐字在前、只追加一个新值**（EvidenceKind / LineageHandleKind / LineageSourceClass）',
  evidenceOk && handleOk && sourceClassOk,
  `EvidenceKind=${JSON.stringify(EVIDENCE_KINDS)} · HandleKind=${JSON.stringify(LINEAGE_HANDLE_KINDS)} · SourceClass=${JSON.stringify(LINEAGE_SOURCE_CLASSES)}`,
  EVIDENCE_KINDS.length + LINEAGE_HANDLE_KINDS.length + LINEAGE_SOURCE_CLASSES.length
)

// ---------------------------------------------------------------------------
// C4 故事来源不支持外部事实（S8-A08）
// ---------------------------------------------------------------------------
let externalFactThrew = ''
try {
  assertStorySourceIsNotExternalFact()
} catch (error) {
  externalFactThrew = error instanceof Error ? error.message : String(error)
}
record(
  'C4',
  '`STORY_OBSERVATION` **不**支持外部事实：白名单自检通过且 `canSupportExternalFact` 为 false（模拟结局永不升级）',
  canSupportExternalFact('STORY_OBSERVATION') === false && externalFactThrew === '',
  `canSupportExternalFact(STORY_OBSERVATION)=${String(canSupportExternalFact('STORY_OBSERVATION'))} · 自检抛错=${externalFactThrew === '' ? '无' : externalFactThrew}`,
  2
)

// ---------------------------------------------------------------------------
// C5 故事事实不可能写成对话事件（S8-A07；负控）
// ---------------------------------------------------------------------------
let conversationRejected = ''
try {
  createConversationEvent({
    characterId: 'char-s8-contracts',
    conversationId: 'conv-s8-contracts',
    conversationSequence: 1,
    sequence: 1,
    type: 'system_event',
    actorType: 'system',
    actorId: 'story-runtime',
    content: '（负控：试图把故事事实写成对话事件）',
    sourceKind: 'story_fact',
  } as never)
} catch (error) {
  conversationRejected = (error as { code?: string }).code ?? 'unknown'
}
/** 正向自证：同一个构造器对**合法**来源照常接受（证明上面的"拒"不是恒响） */
let legitimateAccepted = false
try {
  createConversationEvent({
    characterId: 'char-s8-contracts',
    conversationId: 'conv-s8-contracts',
    conversationSequence: 2,
    sequence: 2,
    type: 'system_event',
    actorType: 'system',
    actorId: 'system',
    content: '（正控：合法的系统事件）',
  } as never)
  legitimateAccepted = true
} catch {
  legitimateAccepted = false
}
record(
  'C5',
  '负控：声明 `sourceKind = story_fact` 的对话事件**真的被构造器拒绝**（`source_kind_actor_mismatch`）+ 判据恒为 false + 合法来源照常接受（正控）',
  canWriteStoryFactAsConversationEvent() === false &&
    conversationRejected === 'source_kind_actor_mismatch' &&
    legitimateAccepted,
  `判据=${String(canWriteStoryFactAsConversationEvent())} · 拒绝码=${conversationRejected} · 合法来源通过=${String(legitimateAccepted)}`,
  3
)

// ---------------------------------------------------------------------------
// C6 绑定形状（S8-A11；三个负控 + 一个正控）
// ---------------------------------------------------------------------------
const bindingProbe = (
  label: string,
  binding: Parameters<typeof assertStoryCommitBinding>[0],
  eventType: Parameters<typeof assertStoryCommitBinding>[1]
): string => {
  try {
    assertStoryCommitBinding(binding, eventType)
    return `${label}=ACCEPTED`
  } catch (error) {
    return `${label}=${error instanceof Error && 'code' in error ? String((error as { code: string }).code) : 'REJECTED'}`
  }
}
const bindingResults = [
  bindingProbe(
    'system+session',
    { interactionKind: 'system', interactionRef: 'forged', actorKind: 'system' },
    'STORY_STARTED'
  ),
  bindingProbe(
    'user_choice-no-anchor',
    { interactionKind: 'user_choice', interactionRef: 'conv-1', actorKind: 'user' },
    'CHOICE_COMMITTED'
  ),
  bindingProbe(
    'user_choice-on-start',
    {
      interactionKind: 'user_choice',
      interactionRef: 'conv-1',
      anchorConversationEventId: 'ev-1',
      actorKind: 'user',
    },
    'STORY_STARTED'
  ),
  bindingProbe(
    'legal-user-choice',
    {
      interactionKind: 'user_choice',
      interactionRef: 'conv-1',
      anchorConversationEventId: 'ev-1',
      actorKind: 'user',
    },
    'CHOICE_COMMITTED'
  ),
  bindingProbe('legal-system', { interactionKind: 'system', actorKind: 'system' }, 'STORY_STARTED'),
]
const bindingOk =
  bindingResults[0]!.endsWith('=story_binding_system_with_session') &&
  bindingResults[1]!.endsWith('=story_binding_without_anchor') &&
  bindingResults[2]!.endsWith('=story_binding_kind_not_allowed') &&
  bindingResults[3]!.endsWith('=ACCEPTED') &&
  bindingResults[4]!.endsWith('=ACCEPTED')
record(
  'C6',
  '绑定形状：三个非法形状**具名拒收**（各自不同的码），两个合法形状通过（正控非零）',
  bindingOk,
  bindingResults.join(' · '),
  bindingResults.length
)

// ---------------------------------------------------------------------------
// C7 旧解码不变 + 提交身份读回（S8-A01/S8-A04/S8-A18）
// ---------------------------------------------------------------------------
const legacyEvidenceOk = LEGACY_EVIDENCE_KINDS.every((kind) => {
  const ref = evidenceRef(kind as never, `${kind}-id`)
  return ref.kind === kind && ref.id === `${kind}-id`
})
const identity = { storyId: 'jichuang-interview-two', storyVersion: 1, runId: 'run-contracts', revision: 7 }
const commitId = storyCommitIdOf(identity)
const readback = parseStoryCommitId(commitId)
const identityOk =
  commitId === 'story:jichuang-interview-two@v1#run-contracts.e7' &&
  readback !== undefined &&
  readback.storyId === identity.storyId &&
  readback.storyVersion === identity.storyVersion &&
  readback.runId === identity.runId &&
  readback.revision === identity.revision
/** 因果键：user_choice 与它的 anchor 对话事件**同键**（S8-C02 的构造形态） */
const userChoiceKey = storyRootKeyOf({
  commitId,
  binding: {
    interactionKind: 'user_choice',
    interactionRef: 'conv-1',
    anchorConversationEventId: 'ev-anchor',
    actorKind: 'user',
  },
} as StoryCommitRecord)
const systemKey = storyRootKeyOf({
  commitId,
  binding: { interactionKind: 'system', actorKind: 'system' },
} as StoryCommitRecord)
record(
  'C7',
  '旧证据 kind 解码不变；提交身份可读回；因果键 user_choice=对话键、system=story-system 前缀（不合格为习惯根）',
  legacyEvidenceOk &&
    identityOk &&
    userChoiceKey === 'conversation:ev-anchor' &&
    systemKey === `story-system:${commitId}`,
  `旧 kind 可用=${String(legacyEvidenceOk)} · commitId=${commitId} · user_choice 键=${userChoiceKey} · system 键=${systemKey}`,
  LEGACY_EVIDENCE_KINDS.length + 4
)

// ---------------------------------------------------------------------------
// C8 触发登记表的**可达性事实**没被悄悄改写（S8-A25 的前置）
// ---------------------------------------------------------------------------
const feedbackFact = REFLECTION_TRIGGER_FACTS.user_feedback
record(
  'C8',
  '`user_feedback` 的 `v1Detectable` **仍是 false**（ADR-093 §0.3 的读法：不给它补词形检测器）',
  feedbackFact.v1Detectable === false && REFLECTION_TRIGGER_KINDS.includes('user_feedback'),
  `v1Detectable=${String(feedbackFact.v1Detectable)} · 触发表=${JSON.stringify(REFLECTION_TRIGGER_KINDS)}`,
  REFLECTION_TRIGGER_KINDS.length
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

const runId = `postlv2-s8-contracts-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:contracts:verify',
  milestone: 'post-lv2 / S8 / WP3',
  generatedAt: new Date().toISOString(),
  source: { head, workingTreeDirty: porcelain.length > 0, workingTreePorcelain: porcelain.slice(0, 60) },
  contractFingerprints: {
    memory: sha256(read('src/kernel/contracts/memory.ts')),
    reflectionLineage: sha256(read('src/kernel/contracts/reflection-lineage.ts')),
    storyLedger: sha256(read('src/kernel/storyline/story-ledger.ts')),
    lineageResolver: sha256(read('src/kernel/app/reflection/lineage.ts')),
  },
  vocabulary: {
    evidenceKinds: [...EVIDENCE_KINDS],
    lineageHandleKinds: [...LINEAGE_HANDLE_KINDS],
    lineageSourceClasses: [...LINEAGE_SOURCE_CLASSES],
  },
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}

writeFileSync(join(outDir, 's8-contracts-verify.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:contracts:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-contracts-verify.json`)
process.exitCode = passed ? 0 : 1
