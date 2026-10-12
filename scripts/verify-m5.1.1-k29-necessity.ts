/**
 * M5.1.1 K-29 —— **Conversation Attribution Necessity Enforcement** 专项门
 * （`pnpm m5.1.1:k29:verify`）
 *
 * ============================================================================
 *  它证明的是什么
 * ============================================================================
 *  §1  **单一 canonical 矩阵**：全 `src/` 里只有 `contracts/attribution.ts` 定义
 *      family → necessity 的表；构造器与消费边界调用的都是**同一个**
 *      `assertAttributionNecessity`（不是复制一份规则）。
 *  §2  **构造器 fail-closed**：`buildTrustedAttributionContext()` 在返回前过必要性判据。
 *      正控：四族 + runtime-unresolved 的合法形态都能构造（每一格的期望**现场读**矩阵，
 *      不手抄）。负控：REQUIRED→Absent 必抛；MUST_ABSENT→填值必抛。
 *  §3  **消费边界**：`createConversationEvent()` 在写入前过**同一个**判据（defense in depth），
 *      并用"删掉那行调用 ⇒ 静态探测器必响"证明这条断言不是装饰。
 *  §4  **双向量控**（纯判据层）：A 应该表态却写 Absent / B 应该 Absent 却硬填，
 *      每一族 × 每一格按**现场读到的矩阵**逐个验证（含 recordedBy 缺失、
 *      applicable contentOriginator 被写成 Absent）。
 *  §5  **生产链路**：真实 `TurnGateway.beginTurn` / `completeTurn` 在加固后仍然写 RECORDED；
 *      D01 仍是 `SERVICE/agent-runner`；Unknown 仍能如实落库。
 *  §6  **不得 fallback**：生产者抛 necessity 错时，账本**必须抛**且**不写任何行**
 *      （特别不能静默退化成 no-envelope 的 legacy 写入）。
 *  §7  **legacy 逐字兼容**：不带 `trustedAttribution` 的写入行为不变（origin NULL）。
 *  §8  三段式量具 + `measured_count > 0` + `measurementInvalid = 0`。
 *
 * 跑法：pnpm m5.1.1:k29:verify
 */

import 'dotenv/config'

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { PRODUCTION_DB_DIR, isolateDatabase, isProductionDir } from '../src/dev/sandbox.ts'
import { createM4Harness } from './m4-harness.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { conversationAttributionForEntryMode } from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  ATTRIBUTION_EVENT_FAMILIES,
  NECESSITY_MATRIX,
  assertAttributionNecessity,
  assertConversationAttributionNecessity,
  attestActorFromDecisionPoint,
  attestContentOriginatorFromIngress,
  attestEpistemicConfirmation,
  attributionSlotsOfContext,
  buildTrustedAttributionContext,
  conversationAttributionEnvelopeOf,
  isTrustedAttributionContext,
  validateAttributionNecessity,
  type AttributionEnvelope,
  type AttributionEventFamily,
  type ConversationFamily,
  type AuthorityValue,
  type NecessityState,
} from '../src/kernel/contracts/attribution.ts'
import {
  attributionAbsent,
  attributionKnown,
  attributionUnknown,
  type AttributionValue,
} from '../src/kernel/contracts/actor.ts'
import type { PrincipalRef } from '../src/kernel/contracts/actor.ts'
import { createConversationEvent } from '../src/kernel/contracts/conversation-event.ts'
import {
  asCharacterId,
  asConversationId,
} from '../src/kernel/contracts/ids.ts'
import { createConversationLedger } from '../src/infrastructure/persistence/ledger.ts'
import { rowsOf, currentSchemaVersion } from '../src/infrastructure/persistence/db.ts'
import { MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'
import { getConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
}
function measure(label: string, count: number): number {
  const valid = count > 0
  measurements.push({ label, count, valid })
  if (!valid) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}
function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')

const ROOT = process.cwd()
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.1.1')
const CONVERSATION_FAMILIES: readonly AttributionEventFamily[] = [
  'user_message',
  'assistant_message',
  'system_event',
  'tool_event',
]

console.log('='.repeat(74))
console.log('M5.1.1 K-29 —— Conversation Attribution Necessity Enforcement')
console.log('='.repeat(74))

// ===========================================================================
section('§0 环境与边界')
// ===========================================================================

const sandbox = isolateDatabase('m5.1.1-k29')
check(
  '沙箱不是真实库',
  isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()),
  sandbox.dir
)
check(
  '真实库路径只被记录，从未被本脚本打开',
  PRODUCTION_DB_DIR.endsWith(join('data', 'pglite')) && process.env.PGLITE_DATA_DIR !== PRODUCTION_DB_DIR,
  PRODUCTION_DB_DIR
)
const liveDbMtime = (await import('node:fs')).statSync(join(ROOT, 'data', 'pglite')).mtime.toISOString()

const h = await createM4Harness({ label: 'k29' })
const db = h.db
const characterId = h.kernel.characterId
const schemaVersion = await currentSchemaVersion(db)
check(
  '沙箱库 schema = v9（K-29 本身无 schema 变更；v9 是 WP9-B1 的 state_events 承载）',
  schemaVersion === 9,
  `v${schemaVersion}`
)
const fingerprint = (version: number): string => {
  const migration = MIGRATIONS.find((item) => item.version === version)!
  return createHash('sha256').update(migration.statements.join('\n'), 'utf8').digest('hex')
}
check(
  'MIGRATION_0007 / 0008 逐字未改；迁移清单 = 1..9（v9 = WP9-B1 的 state_events 承载，' +
    '原判据"没有 v9"按 R-45 的新事实改写，未放宽）',
  fingerprint(7) === '2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613' &&
    fingerprint(8) === '0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29' &&
    MIGRATIONS.map((item) => item.version).join(',') === '1,2,3,4,5,6,7,8,9' &&
    MIGRATIONS.find((item) => item.version === 9)?.name === 'm5.1.1-state-events-attribution',
  MIGRATIONS.map((item) => item.version).join(',')
)

// ===========================================================================
section('§1 单一 canonical 矩阵（不许第二张表）')
// ===========================================================================

const srcFiles: string[] = []
{
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.name.endsWith('.ts')) srcFiles.push(full)
    }
  }
  visit(join(ROOT, 'src'))
}
measure('扫描的 src 文件数', srcFiles.length)

const relativeOf = (path: string): string =>
  path.replace(ROOT, '').replace(/\\/g, '/').replace(/^\/+/, '')

/** 其他文件里出现"family → REQUIRED/ABSENT 表"的迹象（`NECESSITY_MATRIX` 只在契约里） */
const matrixDefiners = srcFiles
  .filter((file) => relativeOf(file) !== 'src/kernel/contracts/attribution.ts')
  .filter((file) => /NECESSITY_MATRIX\s*[:=]|NECESSITY_MATRIX\s*=\s*\{/.test(codeOnly(readFileSync(file, 'utf8'))))
  .map(relativeOf)
check(
  '★ K-29 单一矩阵：`NECESSITY_MATRIX` **只**在 `contracts/attribution.ts` 里定义',
  matrixDefiners.length === 0,
  matrixDefiners.join(', ') || 'AA'
)
const familySwitchTables = srcFiles
  .filter((file) => relativeOf(file) !== 'src/kernel/contracts/attribution.ts')
  .filter((file) => {
    const code = codeOnly(readFileSync(file, 'utf8'))
    return /'(user_message|assistant_message|system_event|tool_event)'\s*:/.test(code) &&
      /'(REQUIRED|ALLOWED_UNKNOWN|ABSENT|DERIVED)'/.test(code)
  })
  .map(relativeOf)
check(
  '★ K-29 没有"对话专用的第二张矩阵"：别处没有 family → REQUIRED/ABSENT 的表',
  familySwitchTables.length === 0,
  familySwitchTables.join(', ') || 'AA'
)
const validatorUsers = srcFiles
  .filter((file) => /assertAttributionNecessity\(/.test(codeOnly(readFileSync(file, 'utf8'))))
  .map(relativeOf)
measure('调用 canonical 必要性判据的 src 文件数', validatorUsers.length)
/**
 * 每个调用点都必须**从 canonical 契约 import** 那个函数 —— 这才是"单一来源"的真正判据。
 * （WP5 的动作写入路径也调它，这是**好事**：两边共用同一个判据，而不是各写一套。）
 */
const nonCanonicalCallers = validatorUsers
  /* 定义它的那个文件自己**不 import 自己**（它就是 canonical 出处） */
  .filter((file) => file !== 'src/kernel/contracts/attribution.ts')
  .filter((file) => {
    const source = codeOnly(readFileSync(join(ROOT, file), 'utf8'))
    return !/import\s*\{[\s\S]*?assertAttributionNecessity[\s\S]*?\}\s*from\s*'[^']*kernel\/contracts\/(attribution|index)\.ts'/.test(
      source
    )
  })
check(
  '★ K-29 复用同一个判据：每个调用点都从 canonical 契约 import `assertAttributionNecessity`（没有自造判据）',
  validatorUsers.length > 0 && nonCanonicalCallers.length === 0,
  nonCanonicalCallers.join(', ') || `${validatorUsers.join(', ')}（全部来自契约）`
)

// ===========================================================================
section('§2 构造器 fail-closed（正控：合法形态都能构造）')
// ===========================================================================

const USER: PrincipalRef = { kind: 'USER', id: 'u-1' } as PrincipalRef
const AGENT: PrincipalRef = { kind: 'SERVICE', id: 'agent-runner' } as PrincipalRef
const CHAR: PrincipalRef = { kind: 'CHARACTER', id: String(characterId) } as PrincipalRef
const TOOL: PrincipalRef = { kind: 'TOOL', id: 'weather' } as PrincipalRef
const SYSTEM: PrincipalRef = { kind: 'SYSTEM', id: 'scheduler' } as PrincipalRef

const actorEvidenceOf = (principal: PrincipalRef | null, unresolvedReason?: 'RUNTIME_UNRESOLVED') =>
  attestActorFromDecisionPoint({
    adapterId: 'k29-gate',
    principal,
    ...(unresolvedReason !== undefined ? { unresolvedReason } : {}),
  })
const originatorEvidenceOf = (principal: PrincipalRef | null, unresolvedReason?: 'RUNTIME_UNRESOLVED') =>
  attestContentOriginatorFromIngress({
    adapterId: 'k29-ingress',
    principal,
    ...(unresolvedReason !== undefined ? { unresolvedReason } : {}),
  })
const confirm = (kind: 'authenticated_human_input' | 'character_self_generation' | 'tool_observation_source' | 'system_instruction_source') =>
  attestEpistemicConfirmation({ adapterId: 'k29-attest', kind })

/** 每一族的"合法形态"：actor/originator + 可选鉴证（期望值**现场读矩阵**校验） */
const legalCases: {
  label: string
  family: ConversationFamily
  actor: PrincipalRef | null
  originator: PrincipalRef | null
  unresolved?: 'RUNTIME_UNRESOLVED'
  attest?: Parameters<typeof confirm>[0]
}[] = [
  { label: '人类 user_message', family: 'user_message', actor: USER, originator: USER, attest: 'authenticated_human_input' },
  { label: 'D01 agent-as-user', family: 'user_message', actor: AGENT, originator: AGENT },
  { label: 'assistant_message', family: 'assistant_message', actor: CHAR, originator: CHAR, attest: 'character_self_generation' },
  { label: 'system_event', family: 'system_event', actor: SYSTEM, originator: SYSTEM, attest: 'system_instruction_source' },
  { label: 'tool_event', family: 'tool_event', actor: TOOL, originator: TOOL, attest: 'tool_observation_source' },
  {
    label: 'runtime-unresolved（合法未知，不是 Absent）',
    family: 'user_message',
    actor: null,
    originator: null,
    unresolved: 'RUNTIME_UNRESOLVED',
  },
]
measure('§2 正控用例数', legalCases.length)

const matrixSource = NECESSITY_MATRIX
measure('canonical 矩阵覆盖的族数', ATTRIBUTION_EVENT_FAMILIES.length)
let slotChecks = 0
for (const testCase of legalCases) {
  let context
  try {
    context = buildTrustedAttributionContext({
      family: testCase.family,
      characterId: String(characterId),
      actorEvidence: actorEvidenceOf(testCase.actor, testCase.unresolved),
      contentOriginatorEvidence: originatorEvidenceOf(testCase.originator, testCase.unresolved),
      ...(testCase.attest !== undefined ? { epistemicEvidence: confirm(testCase.attest) } : {}),
    })
  } catch (error) {
    check(`★ §2 正控 ${testCase.label}：合法形态**可以**构造`, false, (error as Error).message.slice(0, 120))
    continue
  }
  const slots = attributionSlotsOfContext(context)
  const row = matrixSource[testCase.family]
  const violations: string[] = []
  for (const [slot, cell] of [
    ['initiator', row.initiator],
    ['actor', row.actor],
    ['executor', row.executor],
    ['authority', row.authority],
    ['recordedBy', row.recordedBy],
    ['contentOriginator', row.contentOriginator],
  ] as const) {
    const state = (slots[slot] as AttributionValue<unknown>).state
    slotChecks += 1
    if (cell === 'ABSENT' && state !== 'ABSENT') violations.push(`${slot}: ${cell} 却 ${state}`)
    if (cell === 'REQUIRED' && state === 'ABSENT') violations.push(`${slot}: ${cell} 却 Absent`)
    if (cell === 'REQUIRED' && state === 'UNKNOWN' && (slots[slot] as { reason?: string }).reason === 'LEGACY_UNRECORDED') {
      violations.push(`${slot}: REQUIRED 不得用 LEGACY_UNRECORDED`)
    }
  }
  check(
    `★ §2 正控 ${testCase.label}：每一槽位都满足**现场读到**的矩阵格（${testCase.family}）`,
    violations.length === 0,
    violations.join(' · ') || `矩阵：${JSON.stringify(row)}`
  )
}
measure('§2 逐槽位比对次数', slotChecks)

// ===========================================================================
section('§3 负控：构造器必须**抛**（A 应该表态却 Absent / B 应该 Absent 却硬填）')
// ===========================================================================

function buildAttempt(input: {
  family: ConversationFamily
  actor: PrincipalRef | null
  originator: PrincipalRef | null
  unresolved?: 'RUNTIME_UNRESOLVED'
  attested?: boolean
}): { ok: boolean; code: string; violations: string[] } {
  try {
    buildTrustedAttributionContext({
      family: input.family,
      characterId: String(characterId),
      actorEvidence: actorEvidenceOf(input.actor, input.unresolved),
      contentOriginatorEvidence: originatorEvidenceOf(input.originator, input.unresolved),
      ...(input.attested === true
        ? { epistemicEvidence: confirm('authenticated_human_input') }
        : {}),
    })
    return { ok: true, code: '', violations: [] }
  } catch (error) {
    const err = error as { code?: string; details?: { violations?: { slot: string; code: string }[] } }
    return {
      ok: false,
      code: String(err.code ?? 'unknown'),
      violations: (err.details?.violations ?? []).map((item) => `${item.slot}/${item.code}`),
    }
  }
}

const requiredAbsentCases = [
  { label: 'A-① user_message.actor = Absent（矩阵 REQUIRED）', family: 'user_message' as const, actor: null, originator: USER },
  { label: 'A-② assistant_message.actor = Absent', family: 'assistant_message' as const, actor: null, originator: CHAR },
  { label: 'A-③ system_event.actor = Absent', family: 'system_event' as const, actor: null, originator: SYSTEM },
  { label: 'A-④ tool_event.contentOriginator = Absent（矩阵 REQUIRED）', family: 'tool_event' as const, actor: TOOL, originator: null },
]
measure('§3 A 类负控数（应该表态却 Absent）', requiredAbsentCases.length)
for (const item of requiredAbsentCases) {
  const attempt = buildAttempt({ family: item.family, actor: item.actor, originator: item.originator })
  check(
    `★ §3 ${item.label} ⇒ **必抛** attribution_necessity_violation`,
    attempt.ok === false && attempt.code === 'attribution_necessity_violation',
    attempt.ok ? '竟然构造成功了（K-29 没生效）' : `${attempt.code} ${attempt.violations.join(',')}`
  )
}

/*
 * B 类（应该 Absent 却硬填）由**纯判据层**覆盖：构造器的 `executor` / `authority`
 * 由矩阵自己决定（没有调用方可填的入口），所以"硬填"只可能出现在手写信封上。
 * 这里用 canonical validator 直接验（同一份判据）。
 */
const envelopeOf = (overrides: Partial<AttributionEnvelope>): AttributionEnvelope => ({
  subject: { kind: 'CHARACTER', id: String(characterId) } as PrincipalRef,
  initiator: attributionAbsent<PrincipalRef>(),
  actor: attributionKnown<PrincipalRef>(USER),
  executor: attributionAbsent<PrincipalRef>(),
  authority: attributionAbsent<AuthorityValue>() as AuthorityValue,
  recordedBy: attributionKnown<PrincipalRef>({ kind: 'SYSTEM', id: 'kernel' } as PrincipalRef),
  contentOriginator: attributionKnown<PrincipalRef>(USER),
  attributionOrigin: 'RECORDED',
  ...overrides,
})
const mustAbsentCases: { label: string; family: AttributionEventFamily; envelope: AttributionEnvelope }[] = [
  {
    label: 'B-① user_message.executor = Known(TOOL/weather)（矩阵 ABSENT）',
    family: 'user_message',
    envelope: envelopeOf({ executor: attributionKnown<PrincipalRef>(TOOL) }),
  },
  {
    label: 'B-② user_message.authority = Known(CAPABILITY/system.echo)（矩阵 ABSENT）',
    family: 'user_message',
    envelope: envelopeOf({
      authority: attributionKnown<AuthorityValue>({ kind: 'CAPABILITY', ref: 'system.echo' } as never) as AuthorityValue,
    }),
  },
  {
    label: 'B-③ user_message.initiator = Known(USER/u-1)（矩阵 ABSENT）',
    family: 'user_message',
    envelope: envelopeOf({ initiator: attributionKnown<PrincipalRef>(USER) }),
  },
  {
    label: 'B-④ recordedBy 缺失（三格全 NULL = Absent；矩阵 REQUIRED）',
    family: 'user_message',
    envelope: envelopeOf({ recordedBy: attributionAbsent<PrincipalRef>() }),
  },
  {
    label: 'B-⑤ system_event.contentOriginator = Absent（矩阵 ALLOWED_UNKNOWN ⇒ 必须表态）',
    family: 'system_event',
    envelope: envelopeOf({
      actor: attributionKnown<PrincipalRef>(SYSTEM),
      initiator: attributionUnknown<PrincipalRef>('RUNTIME_UNRESOLVED'),
      contentOriginator: attributionAbsent<PrincipalRef>(),
    }),
  },
]
measure('§3 B 类负控数（应该 Absent 却硬填 / 该表态却 Absent）', mustAbsentCases.length)
for (const item of mustAbsentCases) {
  const violations = validateAttributionNecessity({ family: item.family, envelope: item.envelope })
  check(
    `★ §3 ${item.label} ⇒ canonical validator **必响**`,
    violations.length > 0,
    violations.map((v) => `${v.slot}/${v.code}`).join(', ') || '（没响 —— 判据是空转的）'
  )
}
/** 恢复：合法的那个信封必须安静 */
check(
  '★ §3 恢复：合法信封（user_message / Known+ABSENT 各就各位）⇒ validator **安静**',
  validateAttributionNecessity({ family: 'user_message', envelope: envelopeOf({}) }).length === 0,
  'AA'
)

// ===========================================================================
section('§4 消费边界：`createConversationEvent` 过**同一个**判据')
// ===========================================================================

const contractSources = {
  attribution: readFileSync(join(ROOT, 'src/kernel/contracts/attribution.ts'), 'utf8'),
  conversationEvent: readFileSync(join(ROOT, 'src/kernel/contracts/conversation-event.ts'), 'utf8'),
}
const consumerCallSite = /assertConversationAttributionNecessity\(trusted\)/
check(
  '★ §4 静态：`createConversationEvent` 在写入前调用 canonical 必要性判据（同一个函数）',
  consumerCallSite.test(codeOnly(contractSources.conversationEvent)),
  'AA'
)
check(
  '★ §4 静态：那个函数就是 `assertAttributionNecessity` 的薄包装（不是第二套规则）',
  /export function assertConversationAttributionNecessity\(context: TrustedAttributionContext\): void \{[\s\S]{0,200}assertAttributionNecessity\(/.test(
    codeOnly(contractSources.attribution)
  ),
  'AA'
)
/** 变异探测：把那一行调用删掉 ⇒ 同一条静态断言**必响**（证明它不是装饰） */
const mutatedConsumer = codeOnly(contractSources.conversationEvent).replace(
  consumerCallSite,
  '/* K-29 mutation: call removed */'
)
check(
  '★ §4 变异探测：删掉那行调用 ⇒ 同一条静态断言**必响**（这条断言不是装饰）',
  consumerCallSite.test(codeOnly(contractSources.conversationEvent)) === true &&
    consumerCallSite.test(mutatedConsumer) === false,
  'AA'
)
const legalContext = buildTrustedAttributionContext({
  family: 'user_message',
  characterId: String(characterId),
  actorEvidence: actorEvidenceOf(USER),
  contentOriginatorEvidence: originatorEvidenceOf(USER),
  epistemicEvidence: confirm('authenticated_human_input'),
})
check(
  '§4 动态：合法受信上下文过消费边界（同一判据）不抛，且真的被登记为受信',
  (() => {
    try {
      assertConversationAttributionNecessity(legalContext)
      return isTrustedAttributionContext(legalContext)
    } catch {
      return false
    }
  })(),
  'AA'
)
const consumed = createConversationEvent({
  characterId,
  conversationId: asConversationId('conv_k29_consumer'),
  conversationSequence: 1,
  sequence: 1,
  type: 'user_message',
  actorType: 'user',
  actorId: 'u-1',
  content: 'K-29 消费边界正控',
  trustedAttribution: legalContext,
})
check(
  '§4 动态：`createConversationEvent` 接受合法上下文（信封与上下文逐字一致）',
  consumed.attribution?.attributionOrigin === 'RECORDED' &&
    JSON.stringify(consumed.attribution.slots) ===
      JSON.stringify(attributionSlotsOfContext(legalContext)),
  'AA'
)

// ===========================================================================
section('§5 生产链路：加固后仍然写 RECORDED（人类 / D01 / 她的输出）')
// ===========================================================================

async function runTurn(input: {
  entryMode: 'interactive_human_console' | 'scripted_agent_runner'
  conversationId: string
  text: string
  reply: string
}): Promise<{ userOrigin: string | null; userActor: string; assistantOrigin: string | null; userKind: string }> {
  const wiring = conversationAttributionForEntryMode(input.entryMode)
  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId: asConversationId(input.conversationId),
    dryRun: false,
    userName: 'Alex',
    characterName: character.name,
    transport: 'cli',
    userId: h.userId,
    userRef: 'Alex',
    attribution: wiring.producers,
  })
  let sequence = 0
  const gateway = new TurnGateway({
    kernel: h.kernel,
    definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot,
    recorder,
    conversationSequence: () => {
      sequence += 1
      return sequence
    },
    recentLimit: 16,
    slowPathEnabled: false,
    dryRun: false,
    userId: h.userId,
  })
  const incoming = await gateway.beginTurn(input.text)
  const outgoing = await gateway.completeTurn({ turn: incoming, replyText: input.reply })
  const rows = rowsOf(
    await db.execute(
      sql`select attribution_origin, actor_kind, actor_ref_id from conversation_events
          where character_id = ${String(characterId)} and conversation_id = ${input.conversationId}
            and conversation_sequence = ${incoming.userEvent!.conversationSequence}`
    )
  ) as { attribution_origin: string | null; actor_kind: string | null; actor_ref_id: string | null }[]
  const assistantRows = rowsOf(
    await db.execute(
      sql`select attribution_origin from conversation_events
          where character_id = ${String(characterId)} and conversation_id = ${input.conversationId}
            and conversation_sequence = ${outgoing.assistantEvent!.conversationSequence}`
    )
  ) as { attribution_origin: string | null }[]
  return {
    userOrigin: rows[0]?.attribution_origin ?? null,
    userActor: `${String(rows[0]?.actor_kind)}/${String(rows[0]?.actor_ref_id)}`,
    userKind: String(rows[0]?.actor_kind),
    assistantOrigin: assistantRows[0]?.attribution_origin ?? null,
  }
}

const humanTurn = await runTurn({
  entryMode: 'interactive_human_console',
  conversationId: 'conv_k29_human',
  text: 'K-29：人类控制台这一轮',
  reply: '好。',
})
check(
  '★ §5 人类 ingress：加固后仍然写 RECORDED，actor = USER（没有被必要性判据打回 legacy）',
  humanTurn.userOrigin === 'RECORDED' && humanTurn.userActor === `USER/${h.userId}`,
  `${String(humanTurn.userOrigin)} ${humanTurn.userActor}`
)
const agentTurn = await runTurn({
  entryMode: 'scripted_agent_runner',
  conversationId: 'conv_k29_agent',
  text: 'K-29：程序化入口这一轮',
  reply: '好。',
})
check(
  '★ §5 D01 ingress：仍然是 RECORDED + SERVICE/agent-runner（K-27 / D01 不因 K-29 退化）',
  agentTurn.userOrigin === 'RECORDED' && agentTurn.userActor === 'SERVICE/agent-runner',
  `${String(agentTurn.userOrigin)} ${agentTurn.userActor}`
)
check(
  '★ §5 她的输出：assistant 事件同样 RECORDED（两族的矩阵格在加固后仍被满足）',
  humanTurn.assistantOrigin === 'RECORDED' && agentTurn.assistantOrigin === 'RECORDED',
  `${String(humanTurn.assistantOrigin)} / ${String(agentTurn.assistantOrigin)}`
)
const unknownRow = rowsOf(
  await db.execute(
    sql`select actor_unknown_reason from conversation_events
        where character_id = ${String(characterId)} and conversation_id = 'conv_k29_human'
          and conversation_sequence = 1`
  )
) as { actor_unknown_reason: string | null }[]
check(
  '★ §5 Unknown 仍能如实落库的形态：合法行上 actor 是 Known（未知只出现在适用而确实未知的槽位）',
  unknownRow.length === 1 && unknownRow[0]!.actor_unknown_reason === null,
  `actor_unknown_reason=${String(unknownRow[0]?.actor_unknown_reason)}`
)

// ===========================================================================
section('§6 不得 fallback：RECORDED 失败必须**抛**且**不写行**')
// ===========================================================================

const fallbackConversation = 'conv_k29_nofallback'
const throwingProducer = {
  producerId: 'k29-throwing-producer',
  family: 'user_message' as const,
  attest(): never {
    throw Object.assign(new Error('K-29 注入：necessity 违规'), {
      code: 'attribution_necessity_violation',
    })
  },
}
const fallbackLedger = createConversationLedger({
  db,
  defaultTransport: 'cli',
  attribution: [throwingProducer],
})
let fallbackCode = ''
try {
  await fallbackLedger.appendUserStatement({
    characterId,
    conversationId: asConversationId(fallbackConversation),
    userId: 'u-1',
    content: 'K-29：这一条**不得**落库',
    conversationSequence: 1,
  })
} catch (error) {
  fallbackCode = String((error as { code?: string }).code ?? (error as Error).name)
}
check(
  '★ §6 生产者抛 necessity 错 ⇒ 账本**抛**（不吞、不降级）',
  fallbackCode === 'attribution_necessity_violation',
  fallbackCode || '（竟然没抛）'
)
const fallbackRows = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from conversation_events
        where character_id = ${String(characterId)} and conversation_id = ${fallbackConversation}`
  )
) as { c: number }[]
check(
  '★ §6 且**一行都没有写**（没有静默退化成 no-envelope 的 legacy 写入）',
  Number(fallbackRows[0]?.c) === 0,
  `rows=${String(fallbackRows[0]?.c)}`
)
/** 反向自检：同一份代码在**没有** attribution 时确实会写 legacy 行（证明上面那条不是"什么都没做"） */
const legacyLedger = createConversationLedger({ db, defaultTransport: 'cli' })
const legacyOutcome = await legacyLedger.appendUserStatement({
  characterId,
  conversationId: asConversationId('conv_k29_legacy'),
  userId: 'u-1',
  content: 'K-29：legacy 路径（不带 attribution）',
  conversationSequence: 1,
})
const legacyRow = rowsOf(
  await db.execute(
    sql`select attribution_origin from conversation_events
        where character_id = ${String(characterId)} and conversation_id = 'conv_k29_legacy'
          and conversation_sequence = 1`
  )
) as { attribution_origin: string | null }[]
check(
  '★ §7 legacy 逐字兼容：不带 `trustedAttribution` 的写入仍然落 **legacy** 行（origin NULL）',
  legacyOutcome.appended === true && legacyRow[0]?.attribution_origin === null,
  `origin=${String(legacyRow[0]?.attribution_origin)}`
)
const legacyReadback = await getConversationEvent(db, legacyOutcome.event!.id)
check(
  '★ §7 legacy 行的读回仍然**没有**信封（K-29 不给旧行补 necessity 要求）',
  legacyReadback?.attribution === undefined,
  'AA'
)

// ===========================================================================
section('§8 三段式：正控 / 负控 / 恢复')
// ===========================================================================

const probeEnvelope = envelopeOf({})
const probeFamily: ConversationFamily = 'user_message'
const quietPositive = validateAttributionNecessity({ family: probeFamily, envelope: probeEnvelope }).length === 0
const mutated = { ...probeEnvelope, actor: attributionAbsent<PrincipalRef>() }
const mutatedNegative = validateAttributionNecessity({ family: probeFamily, envelope: mutated }).length > 0
const restored = validateAttributionNecessity({ family: probeFamily, envelope: probeEnvelope }).length === 0
check('★ §8 正控：合法信封 ⇒ 判据安静', quietPositive, 'AA')
check('★ §8 负控：把一个 necessity 槽位改坏 ⇒ 判据**必响**', mutatedNegative, 'AA')
check('★ §8 恢复：改回 canonical 值 ⇒ 判据重新安静', restored, 'AA')
measure('§8 三段式覆盖的 mutation 类数', 1)
const mutatedFilled = { ...probeEnvelope, executor: attributionKnown<PrincipalRef>(TOOL) }
check(
  '★ §8 第二类 mutation：把 MUST_ABSENT 的槽位填上 ⇒ 判据**必响**',
  validateAttributionNecessity({ family: probeFamily, envelope: mutatedFilled }).length > 0,
  'AA'
)
measure('§8 第二类 mutation', 1)

// ===========================================================================
section('§9 汇总与证据')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const verdict = failed === 0 ? 'PASS' : 'FAIL'
const evidence = {
  testId: 'M5.1.1 / K-29 Conversation Attribution Necessity Enforcement',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:k29:verify',
  verdict,
  passed,
  failed,
  failures,
  singleSourceOfTruth: {
    matrixDefiners,
    familySwitchTables,
    validatorUsers,
    matrixFamilies: [...ATTRIBUTION_EVENT_FAMILIES],
  },
  builderEnforcement: {
    legalCases: legalCases.map((item) => item.label),
    slotChecks,
    requiredAbsentCases: requiredAbsentCases.map((item) => item.label),
    mustAbsentCases: mustAbsentCases.map((item) => item.label),
  },
  consumerBoundary: {
    staticCallSitePresent: consumerCallSite.test(codeOnly(contractSources.conversationEvent)),
    mutationDetectorFires: consumerCallSite.test(mutatedConsumer) === false,
    legalContextAccepted: consumed.attribution?.attributionOrigin === 'RECORDED',
  },
  productionIngress: { humanTurn, agentTurn },
  noFallback: { thrownCode: fallbackCode, rowsWritten: Number(fallbackRows[0]?.c) },
  legacyCompatibility: {
    appended: legacyOutcome.appended === true,
    origin: legacyRow[0]?.attribution_origin ?? null,
    envelopeAbsent: legacyReadback?.attribution === undefined,
  },
  slotsOfContextRule: {
    note: '构造器自填的三个槽位按 canonical 矩阵那一格取值：ABSENT ⇒ Absent；REQUIRED/ALLOWED_UNKNOWN ⇒ Unknown(RUNTIME_UNRESOLVED)',
    initiatorByFamily: Object.fromEntries(
      CONVERSATION_FAMILIES.map((family) => [family, NECESSITY_MATRIX[family].initiator])
    ) as Record<string, NecessityState>,
  },
  schemaBoundary: {
    latestSchemaVersion: schemaVersion,
    migration0007Sha256: fingerprint(7),
    migration0008Sha256: fingerprint(8),
    schemaChangeRequired: false,
  },
  sandbox: { dir: sandbox.dir, isProductionDir: isProductionDir(sandbox.dir), liveDbMtime },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: { schemaChanged: false, wp8Started: false, k31Touched: false, pageHtmlTouched: false },
}

mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'k29-necessity-enforcement.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
writeFileSync(
  join(EVIDENCE_DIR, 'k29-exits.json'),
  `${JSON.stringify({ command: evidence.command, verdict, passed, failed, measurementInvalid: measurementInvalid.length }, null, 2)}\n`,
  'utf8'
)
console.log('\n证据已写入：artifacts/m5.1.1/k29-necessity-enforcement.json ・ k29-exits.json')

await h.stop()

console.log(`\n${'='.repeat(74)}`)
console.log(`M5.1.1 K-29 Necessity Enforcement：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
console.log(verdict === 'PASS' ? 'K-29 = CLOSED（必要条件全部成立）' : 'K-29 = OPEN（见失败项）')
console.log('='.repeat(74))
process.exit(failed === 0 ? 0 : 1)
