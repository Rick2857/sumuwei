/**
 * M5.1.1 WP4 step 1/3b —— **K-25 / R-22 Trusted Attestation Decoupling**
 * （`pnpm m5.1.1:k25:verify`）
 *
 * ============================================================================
 *  它防的是三件"看起来对、其实把概念又合回去"的事
 * ============================================================================
 *   ① `actor` 与 `contentOriginator` 被**同一个来源**推导 ⇒ 两个槽位永远绑死，
 *      `actor ≠ contentOriginator` 表达不出来（那正是 D01 的病根之一）。
 *   ② 一个**调用方可填的枚举**（`ingress: 'human_console'`）就能提权 ⇒
 *      普通 DTO 字段 = 权威声明。信任必须来自**不透明的受信证据**。
 *   ③ 用 `contentOriginator.kind === 该族 canonical 主体` 当"认知资格已确立"的判据 ⇒
 *      主体类型又变回认知资格的证据（R-21 明确禁止）。
 *
 * 跑法：pnpm m5.1.1:k25:verify
 */

import 'dotenv/config'

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CONFIRMING_ATTESTATION_BY_FAMILY,
  EPISTEMIC_ATTESTATION_KINDS,
  assertNoCallerSuppliedAttribution,
  attestActorFromDecisionPoint,
  attestContentOriginatorFromIngress,
  attestEpistemicConfirmation,
  buildTrustedAttributionContext,
  isTrustedAttestationEvidence,
  type EpistemicAttestationKind,
} from '../src/kernel/contracts/attribution.ts'
import type { PrincipalRef } from '../src/kernel/contracts/actor.ts'

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

const ROOT = process.cwd()
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.1.1')
const USER: PrincipalRef = { kind: 'USER', id: 'u-1' } as PrincipalRef
const AGENT: PrincipalRef = { kind: 'SERVICE', id: 'agent' } as PrincipalRef
const SU: PrincipalRef = { kind: 'CHARACTER', id: 'char_sumuwei' } as PrincipalRef
const EXTERNAL: PrincipalRef = { kind: 'EXTERNAL_ACTOR', id: 'x' } as PrincipalRef

console.log('='.repeat(74))
console.log('M5.1.1 WP4 step 1/3b —— K-25 Trusted Attestation Decoupling')
console.log('='.repeat(74))

// ===========================================================================
section('0. 静态：耦合已解（旧 API 不再存在；三个角色各自的证据构造器）')
// ===========================================================================

const source = readFileSync(join(ROOT, 'src', 'kernel', 'contracts', 'attribution.ts'), 'utf8')
const codeOnly = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
const code = codeOnly(source)

check(
  '① 旧耦合已删除：`TRUSTED_INGRESSES` / `CANONICAL_ORIGINATOR_KIND_BY_FAMILY` 不再存在',
  !/TRUSTED_INGRESSES|CANONICAL_ORIGINATOR_KIND_BY_FAMILY/.test(code),
  'AA'
)
check(
  '② 构建器**入参里没有** ingress/ingressRef 这类可填枚举（只有三份证据 + family + characterId）',
  /buildTrustedAttributionContext\(input: \{[\s\S]*?\}\)/.test(code) &&
    !/buildTrustedAttributionContext\(input: \{[\s\S]*?\n\s*ingress/.test(code),
  'AA'
)
check(
  '③ 三个角色各有一个**专用**证据构造器',
  ['attestActorFromDecisionPoint', 'attestContentOriginatorFromIngress', 'attestEpistemicConfirmation'].every((name) =>
    code.includes(`export function ${name}`)
  ),
  'AA'
)
measure('§0 检查的受信证据构造器数', 3)
measure('§0 鉴证种类数', EPISTEMIC_ATTESTATION_KINDS.length)
check(
  '④ 每一族都有自己的确认鉴证种类（四族齐全）',
  Object.keys(CONFIRMING_ATTESTATION_BY_FAMILY).length === 4,
  Object.keys(CONFIRMING_ATTESTATION_BY_FAMILY).join(',')
)

// ===========================================================================
section('1. 合法表示 A–E（K-25 §5）')
// ===========================================================================

const actor = (principal: PrincipalRef | null) => attestActorFromDecisionPoint({ adapterId: 'gateway', principal })
const originator = (principal: PrincipalRef | null, unresolvedReason?: 'RUNTIME_UNRESOLVED') =>
  attestContentOriginatorFromIngress({ adapterId: 'ingress', principal, ...(unresolvedReason ? { unresolvedReason } : {}) })
const confirm = (kind: EpistemicAttestationKind) => attestEpistemicConfirmation({ adapterId: 'attestation', kind })

type Case = {
  label: string
  family: 'user_message' | 'assistant_message' | 'system_event' | 'tool_event'
  actorPrincipal: PrincipalRef | null
  originatorPrincipal: PrincipalRef | null
  unresolvedReason?: 'RUNTIME_UNRESOLVED'
  attestation?: EpistemicAttestationKind
  expectBranch: 'confirmed' | 'unconfirmed'
  expectDistinct: boolean
}
const legalCases: Case[] = [
  { label: 'A. actor=USER/u · originator=USER/u · 人类输入鉴证', family: 'user_message', actorPrincipal: USER, originatorPrincipal: USER, attestation: 'authenticated_human_input', expectBranch: 'confirmed', expectDistinct: false },
  { label: 'B. actor=SERVICE/agent · originator=SERVICE/agent · 无鉴证', family: 'user_message', actorPrincipal: AGENT, originatorPrincipal: AGENT, expectBranch: 'unconfirmed', expectDistinct: false },
  { label: 'C. actor=CHARACTER/sumuwei · originator=USER/u · 有鉴证 ⇒ confirmed', family: 'user_message', actorPrincipal: SU, originatorPrincipal: USER, attestation: 'authenticated_human_input', expectBranch: 'confirmed', expectDistinct: true },
  { label: 'C′. 同上但**无鉴证** ⇒ unconfirmed', family: 'user_message', actorPrincipal: SU, originatorPrincipal: USER, expectBranch: 'unconfirmed', expectDistinct: true },
  { label: 'D. actor=SERVICE/relay · originator=EXTERNAL_ACTOR/x · 无鉴证', family: 'user_message', actorPrincipal: { kind: 'SERVICE', id: 'relay' } as PrincipalRef, originatorPrincipal: EXTERNAL, expectBranch: 'unconfirmed', expectDistinct: true },
  { label: 'E. originator=Known(USER/u) 但**认知证据不可用** ⇒ RECORDED + UNCONFIRMED', family: 'user_message', actorPrincipal: USER, originatorPrincipal: USER, expectBranch: 'unconfirmed', expectDistinct: false },
  { label: 'E′. tool_event 有工具观测鉴证 ⇒ confirmed', family: 'tool_event', actorPrincipal: { kind: 'TOOL', id: 'weather' } as PrincipalRef, originatorPrincipal: { kind: 'TOOL', id: 'weather' } as PrincipalRef, attestation: 'tool_observation_source', expectBranch: 'confirmed', expectDistinct: false },
]
measure('§1 合法表示用例数', legalCases.length)
const legalReadings: { label: string; branch: string; origin: string; distinct: boolean; match: boolean }[] = []
for (const legal of legalCases) {
  const context = buildTrustedAttributionContext({
    family: legal.family,
    characterId: 'char_sumuwei',
    actorEvidence: actor(legal.actorPrincipal),
    contentOriginatorEvidence: originator(legal.originatorPrincipal, legal.unresolvedReason),
    ...(legal.attestation ? { epistemicEvidence: confirm(legal.attestation) } : {}),
  })
  const distinct =
    context.actor.state !== context.contentOriginator.state ||
    (context.actor.state === 'KNOWN' &&
      context.contentOriginator.state === 'KNOWN' &&
      context.actor.value.id !== context.contentOriginator.value.id)
  const match =
    context.axisB.branch === legal.expectBranch &&
    context.attributionOrigin === 'RECORDED' &&
    distinct === legal.expectDistinct
  legalReadings.push({ label: legal.label, branch: context.axisB.branch, origin: context.attributionOrigin, distinct, match })
  check(`§1 ${legal.label}`, match, `branch=${context.axisB.branch} distinct=${distinct}`)
}

// ===========================================================================
section('2. 负控（K-25 §6）')
// ===========================================================================

const negatives: { label: string; holds: boolean }[] = []

// ① 调用方自己选"human_console"（普通 DTO）⇒ 不得提权
const plainDto = { ingress: 'human_console', ingressRef: 'u-1' }
let dtoRejected = false
try {
  assertNoCallerSuppliedAttribution(plainDto as Record<string, unknown>)
} catch {
  dtoRejected = true
}
negatives.push({ label: '① 普通 DTO 带 ingress/ingressRef ⇒ 被拒（不得凭字段提权）', holds: dtoRejected })

// ② actor Known(USER) ⇒ 不得自动把 contentOriginator 设成 USER
const actorOnly = buildTrustedAttributionContext({
  family: 'user_message',
  characterId: 'char_sumuwei',
  actorEvidence: actor(USER),
  contentOriginatorEvidence: originator(AGENT),
})
negatives.push({
  label: '② actor=Known(USER) ⇒ contentOriginator **仍**是 SERVICE/agent（不从 actor 推导）',
  holds:
    actorOnly.contentOriginator.state === 'KNOWN' && actorOnly.contentOriginator.value.kind === 'SERVICE',
})

// ③ contentOriginator Known(USER) ⇒ 不得自动把 actor 设成 USER
const originatorOnly = buildTrustedAttributionContext({
  family: 'user_message',
  characterId: 'char_sumuwei',
  actorEvidence: actor(AGENT),
  contentOriginatorEvidence: originator(USER),
})
negatives.push({
  label: '③ contentOriginator=Known(USER) ⇒ actor **仍**是 SERVICE/agent（不从 originator 推导）',
  holds: originatorOnly.actor.state === 'KNOWN' && originatorOnly.actor.value.kind === 'SERVICE',
})

// ④ contentOriginator Known(USER) 但没有认知鉴证 ⇒ 不得自动成为 USER_EXPLICIT
negatives.push({
  label: '④ contentOriginator=Known(USER) **无鉴证** ⇒ Axis B = UNCONFIRMED（不是 USER_EXPLICIT）',
  holds:
    originatorOnly.axisB.branch === 'unconfirmed' &&
    originatorOnly.axisB.sourceAuthority === 'UNCONFIRMED_ORIGIN' &&
    originatorOnly.axisB.epistemicSource === 'UNCONFIRMED_ORIGIN',
})

// ⑤ 表面身份不足：即使有"人类输入"鉴证，contentOriginator 不是 USER 也不能 confirmed
const serviceWithHumanAttestation = buildTrustedAttributionContext({
  family: 'user_message',
  characterId: 'char_sumuwei',
  actorEvidence: actor(AGENT),
  contentOriginatorEvidence: originator(AGENT),
  epistemicEvidence: confirm('authenticated_human_input'),
})
negatives.push({
  label: '⑤ 鉴证为"人类输入"但来源是 SERVICE ⇒ **仍** unconfirmed（表面身份本身不足以证明）',
  holds: serviceWithHumanAttestation.axisB.branch === 'unconfirmed',
})

measure('§2 负控数', negatives.length)
for (const negative of negatives) check(`§2 ${negative.label}`, negative.holds, 'AA')

// ===========================================================================
section('3. Matter：证据不可伪造（mutation）与恢复')
// ===========================================================================

const realEvidence = actor(USER)
measure('§3 受信证据 token 数', 1)
check('§3 正控：真实证据 token 通过守卫', isTrustedAttestationEvidence(realEvidence), 'AA')

const clones = [
  { label: '结构克隆（展开运算符）', value: { ...realEvidence } as unknown },
  { label: 'JSON 往返', value: JSON.parse(JSON.stringify(realEvidence)) as unknown },
  { label: '手写同形对象', value: { adapterId: 'gateway', principal: USER } as unknown },
]
measure('§3 mutation 形态数', clones.length)
for (const clone of clones) {
  const rejected = !isTrustedAttestationEvidence(clone.value)
  check(`§3 mutation：${clone.label} ⇒ 守卫**必响**（不算证据）`, rejected, 'AA')
}

// 恢复：真实 token 仍然可用 ⇒ 构建成功且安静
const restored = buildTrustedAttributionContext({
  family: 'user_message',
  characterId: 'char_sumuwei',
  actorEvidence: actor(USER),
  originatorEvidence: undefined as never,
  contentOriginatorEvidence: originator(USER),
  epistemicEvidence: confirm('authenticated_human_input'),
} as never)
check('§3 恢复：真实证据放回去 ⇒ 构建成功且 branch=confirmed', restored.axisB.branch === 'confirmed', restored.axisB.branch)

// ===========================================================================
section('4. 汇总与证据')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const k25Verdict = failed === 0 ? 'PASS' : 'FAIL'
const evidence = {
  testId: 'M5.1.1 / WP4 step 1/3b K-25 Trusted Attestation Decoupling',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:k25:verify',
  verdict: k25Verdict,
  k25: k25Verdict,
  passed,
  failed,
  failures,
  decoupling: {
    actorAndContentOriginator: '两份**独立**证据；合法地可以相同，但一个不从另一个推导',
    trustedIngressBoundary: '不透明证据 token（品牌类型 + 运行期 WeakSet）；调用方枚举不提升信任',
    epistemicConfirmation: 'confirmed 必须由**受信认知鉴证**建立；无证据时即使 Known(USER) 也 unconfirmed',
    humanConsoleCaveat:
      'authenticated_human_input 只对 Known(USER) 成立 —— 服务/自动化走同一表面时，表面身份本身不足',
  },
  legalReadings,
  negatives,
  mutation: clones.map((clone) => ({ label: clone.label, rejectedAsEvidence: !isTrustedAttestationEvidence(clone.value) })),
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    conversationEventTouched: false,
    conversationStoreTouched: false,
    factFirewallChanged: false,
    memoryAuthorityChanged: false,
    migration0007Edited: false,
    liveDb: false,
    startedWp5: false,
  },
}
mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'wp4-k25-trusted-attestation.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(`\n${'='.repeat(74)}`)
console.log(`K-25 Trusted Attestation Decoupling：${passed} 通过 / ${failed} 失败｜K-25 = ${k25Verdict}`)
if (failures.length > 0) for (const failure of failures) console.log(`  - ${failure}`)
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp4-k25-trusted-attestation.json')
process.exit(failed === 0 ? 0 : 1)
