/**
 * M5.1.1 WP1 —— **归因契约层测试**（`pnpm m5.1.1:test`）。
 *
 * ============================================================================
 *  它测的是"契约能不能挡住它该挡住的东西"，而且必须**双向**
 * ============================================================================
 * 计划书 WP1 §8 列了 15 项必测；这里逐项落地，并额外补三类这一层才做得出的判据：
 *
 *   ① **受控词汇精确**（PrincipalKind / UnknownReason / AuthorityKind / 三态 /
 *      七槽位 / 22 个列名）—— 少一个、多一个、拼错一个都必须红。
 *   ② **必要性矩阵双向**：必需槽位缺失 → 拒绝；**不适用槽位被填值 → 拒绝**。
 *      后者才是要害：只测前者，系统可以靠"把所有槽位都填满"通过
 *      （ADR-042 §5.4；WP1 任务书 §5 的"特别要求反向校验"）。
 *   ③ **Attestation 边界**（G-AT-4）：外部调用方自报 `contentOriginator` /
 *      `authority` / `executor` → 必须被拒；而 trusted ingress 构造的合法归因
 *      → 必须**安静**（正控；否则检测器是个恒响的噪音源）。
 *
 * 另外三条**静态锁**（源码级，防"规则被悄悄删掉"）：
 *   · 契约层不得出现 `actorTypeFromPrincipalKind` / `projectActorTypeFromSlots`
 *     的**声明**（ADR-042 D8.1 已把它们删除）
 *   · 契约层不得出现 Draft v1 的并行概念名 `sourceAuthor`
 *   · 契约层不得把 `DEVELOPER_SURFACE` / `UNKNOWN_LEGACY` / `UNKNOWN_NOW`
 *     写成受控词汇成员
 *
 * 本脚本**不碰数据库、不碰真实库、不写 artifacts/m5.1/**、不跑任何既有门。
 *
 * **K-19 证据门（fail closed）**：本脚本产出的两个 artifact
 * （`wp1-contracts.json` / `wp1-axis-b-closure.json`）是**已完成的 WP1 / WP1.1 的权威证据**。
 * 普通测试运行**不再写它们**；只有显式 `M511_AUTHORITATIVE_EVIDENCE=1` 且
 * 四路测量输入（`M511_*_EXIT`）齐全时才写，否则**拒绝写入并非 0 退出**。
 * 理由见 `docs/m5.1.1/WP2.3-Handoff.md`（K-19）。
 *
 * 跑法：pnpm m5.1.1:test        （可加过滤词：pnpm m5.1.1:test 矩阵）
 *       M511_AUTHORITATIVE_EVIDENCE=1 M511_TYPECHECK_EXIT=0 ... pnpm m5.1.1:test
 *
 * 验证缝：`M511_EVIDENCE_DIR` 只给 K-19 门把**授权**写入重定向到临时目录用
 * （本脚本要从 cwd 读 `src/kernel/contracts/**` 与 `docs/m5.1.1/**`，所以不能换 cwd）。
 * 它不会削弱 K-19：非授权运行仍然一个字节都不写。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { expect, group, printSummary, runAll, test } from './kernel-test-kit.ts'
import { ACTION_EVENT_TYPES } from '../src/kernel/action/execution-ledger.ts'
import {
  ATTRIBUTION_VALUE_STATES,
  PRINCIPAL_KINDS,
  UNKNOWN_REASONS,
  attributionAbsent,
  attributionKnown,
  attributionStateOf,
  attributionUnknown,
  principalRefEquals,
  type AttributionValue,
  type PrincipalKind,
  type PrincipalRef,
} from '../src/kernel/contracts/actor.ts'
import {
  ATTRIBUTION_EVENT_FAMILIES,
  ATTRIBUTION_NON_SLOT_COLUMNS,
  ATTRIBUTION_ORIGINS,
  ATTRIBUTION_SLOTS,
  ATTRIBUTION_SLOT_COLUMNS,
  ATTRIBUTION_V7_COLUMNS,
  AUTHORITY_KINDS,
  BACKFILL_CONTRACT_DEFERRED_FAMILIES,
  COGNITIVE_AXIS_B_FAMILIES,
  CONVERSATION_BACKFILL_CLASSIFICATION,
  NECESSITY_MATRIX,
  NECESSITY_MATRIX_RULINGS,
  NECESSITY_MATRIX_SOURCE,
  NECESSITY_STATES,
  STATE_TRANSITION_SYSTEM_ORIGIN_RULE,
  TRUSTED_INGRESS_MARK,
  UNTRUSTED_ATTRIBUTION_FIELDS,
  assertAttributionNecessity,
  assertNoUntrustedAttributionFields,
  constructTrustedAttribution,
  describeAttributionValue,
  isCognitiveAxisBApplicable,
  isTrustedAttribution,
  validateAttributionNecessity,
  type AttributionEnvelope,
  type AttributionEventFamily,
  type AuthorityRef,
  type NecessityViolationCode,
} from '../src/kernel/contracts/attribution.ts'
import {
  EPISTEMIC_SOURCES,
  SOURCE_AUTHORITIES,
  SOURCE_KINDS,
  SOURCE_KIND_BY_EVENT_FAMILY,
  canSupportExternalFact,
  epistemicSourceForKind,
  type SourceAuthority,
} from '../src/kernel/contracts/source-authority.ts'
import {
  MEMORY_AUTHORITIES,
  authorityFromSource,
  isMemoryAuthority,
  type MemoryAuthority,
} from '../src/kernel/contracts/memory.ts'
import { canEvidenceExternalFact } from '../src/kernel/contracts/conversation-event.ts'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SUBJECT: PrincipalRef = { kind: 'CHARACTER', id: 'char_sumuwei' }
const USER = { kind: 'USER', id: 'u-1' } as const
const CHARACTER = { kind: 'CHARACTER', id: 'char_sumuwei' } as const
const AGENT = { kind: 'SERVICE', id: 'agent-runner' } as const
const TOOL = { kind: 'TOOL', id: 'weather' } as const
const LEDGER = { kind: 'SYSTEM', id: 'kernel' } as const
const CAPABILITY: AuthorityRef = { kind: 'CAPABILITY', ref: 'sandbox.file.write' }

const known = attributionKnown<PrincipalRef>
const unknown = attributionUnknown<PrincipalRef>
const absent = attributionAbsent<PrincipalRef>()

/** 一条"合法"的 user_message：说一句话不需要许可，也没有执行者 */
function userMessageEnvelope(overrides: Partial<AttributionEnvelope> = {}): AttributionEnvelope {
  return {
    subject: SUBJECT,
    initiator: absent,
    actor: known(USER),
    executor: absent,
    authority: attributionAbsent<AuthorityRef>(),
    recordedBy: known(LEDGER),
    contentOriginator: unknown('RUNTIME_UNRESOLVED'),
    attributionOrigin: 'RECORDED',
    ...overrides,
  }
}

function minimalEnvelope(overrides: Partial<AttributionEnvelope> = {}): AttributionEnvelope {
  return {
    subject: SUBJECT,
    initiator: absent,
    actor: absent,
    executor: absent,
    authority: attributionAbsent<AuthorityRef>(),
    recordedBy: absent,
    contentOriginator: absent,
    attributionOrigin: 'RECORDED',
    ...overrides,
  }
}

function codesOf(violations: { code: NecessityViolationCode }[]): NecessityViolationCode[] {
  return violations.map((v) => v.code)
}

/**
 * 一条"正确"的 tool_event（K-20 的确定性工具行夹具）。
 *
 * 依据冻结矩阵（K-3 FINAL + Migration-Strategy §3.2/§3.3）：
 *   actor = D（`actor_type='tool'` + actorId 即该工具）· contentOriginator = D（工具即内容来源）
 *   executor = N（对话里的工具事件**不是**一次执行）· initiator = U（历史从未记录）
 */
function toolEventEnvelope(overrides: Partial<AttributionEnvelope> = {}): AttributionEnvelope {
  return {
    subject: SUBJECT,
    initiator: unknown('LEGACY_UNRECORDED'),
    actor: known(TOOL),
    executor: absent,
    authority: attributionAbsent<AuthorityRef>(),
    recordedBy: known(LEDGER),
    contentOriginator: known(TOOL),
    attributionOrigin: 'RECORDED',
    ...overrides,
  }
}

const CONTRACTS_DIR = join(process.cwd(), 'src', 'kernel', 'contracts')
const contractSource = (file: string): string => readFileSync(join(CONTRACTS_DIR, file), 'utf8')

/**
 * 静态锁查的是**代码**，不是注释。
 *
 * 否则"注释里写明这个候选值已被删除"反而会让锁失败 —— 那会逼着后人删掉解释，
 * 把一条禁令变成一句没人知道来由的代码。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

// ===========================================================================
group('WP1 :: 受控词汇（平面 1）')
// ===========================================================================

test('1. PrincipalKind 精确为 6 个值（顺序即 ADR-042 D5）', () => {
  expect.deepEqual([...PRINCIPAL_KINDS], [
    'USER',
    'CHARACTER',
    'SYSTEM',
    'SERVICE',
    'TOOL',
    'EXTERNAL_ACTOR',
  ])
})

test('2. UnknownReason 精确为 2 个值', () => {
  expect.deepEqual([...UNKNOWN_REASONS], ['LEGACY_UNRECORDED', 'RUNTIME_UNRESOLVED'])
})

test('3. AuthorityKind 精确为 5 个值', () => {
  expect.deepEqual([...AUTHORITY_KINDS], [
    'POLICY',
    'CAPABILITY',
    'SYSTEM_RULE',
    'USER_CONSENT',
    'BREAK_GLASS',
  ])
})

test('13. UNKNOWN_* 不是 PrincipalKind（未知不是一种位次种类）', () => {
  expect.notOk(
    (PRINCIPAL_KINDS as readonly string[]).some((k) => k.startsWith('UNKNOWN')),
    'B4：Unknown 只能由 UnknownReason 表达'
  )
})

test('14. DEVELOPER 不是 PrincipalKind（developer 是上下文角色，不是位次）', () => {
  expect.notOk(
    (PRINCIPAL_KINDS as readonly string[]).includes('DEVELOPER'),
    'U-02：开发者身份走 USER/<id>，控制面走 SERVICE'
  )
})

test('15. DEVELOPER_SURFACE 不是 AuthorityKind（transport 不是许可）', () => {
  expect.notOk(
    (AUTHORITY_KINDS as readonly string[]).includes('DEVELOPER_SURFACE'),
    'B5：cli / http / page 只是 transport metadata'
  )
  expect.notOk((AUTHORITY_KINDS as readonly string[]).includes('UNKNOWN_LEGACY'))
  expect.notOk((AUTHORITY_KINDS as readonly string[]).includes('UNKNOWN_NOW'))
})

test('七槽位与 22 个列名（契约 ↔ DDL 的命名桥）', () => {
  expect.deepEqual([...ATTRIBUTION_SLOTS], [
    'subject',
    'initiator',
    'actor',
    'executor',
    'authority',
    'recordedBy',
    'contentOriginator',
  ])
  expect.equal(ATTRIBUTION_V7_COLUMNS.length, 22, '18 个槽位列 + 4 个非槽位列 = 22')
  expect.deepEqual([...ATTRIBUTION_NON_SLOT_COLUMNS], [
    'source_kind',
    'source_authority',
    'epistemic_source',
    'attribution_origin',
  ])
  // 两个"改名"的坑必须体现在契约里（否则 DDL 与代码会各叫各的）
  expect.equal(ATTRIBUTION_SLOT_COLUMNS.actor.id, 'actor_ref_id', 'actor 的 id 列叫 actor_ref_id')
  expect.equal(ATTRIBUTION_SLOT_COLUMNS.authority.id, 'authority_ref', 'authority 的引用列叫 _ref')
  expect.equal(ATTRIBUTION_SLOT_COLUMNS.contentOriginator.kind, 'content_originator_kind')
  expect.deepEqual([...ATTRIBUTION_ORIGINS], ['RECORDED', 'MIGRATED_LEGACY'])
})

// ===========================================================================
group('WP1 :: 三态模型（平面 2）')
// ===========================================================================

test('4. Known / Unknown / Absent 三态齐备', () => {
  expect.deepEqual([...ATTRIBUTION_VALUE_STATES], ['KNOWN', 'UNKNOWN', 'ABSENT'])
  expect.equal(attributionStateOf(known(USER)), 'KNOWN')
  expect.equal(attributionStateOf(unknown('LEGACY_UNRECORDED')), 'UNKNOWN')
  expect.equal(attributionStateOf(absent), 'ABSENT')
})

test('6. 三态两两不同：Unknown ≠ Absent、Known ≠ Unknown、Known ≠ Absent', () => {
  const k = known(USER)
  const u = unknown('RUNTIME_UNRESOLVED')
  const a = absent
  expect.notOk(JSON.stringify(k) === JSON.stringify(u), 'Known 与 Unknown 必须可区分')
  expect.notOk(JSON.stringify(u) === JSON.stringify(a), 'Unknown 与 Absent 必须可区分')
  expect.notOk(JSON.stringify(k) === JSON.stringify(a), 'Known 与 Absent 必须可区分')
  expect.notOk(describeAttributionValue(u) === describeAttributionValue(a), '渲染层也必须不同')
  expect.equal(describeAttributionValue(unknown('LEGACY_UNRECORDED')), 'Unknown(历史未记录)')
  expect.equal(describeAttributionValue(a), 'Absent(不适用)')
})

test('5. 混合形状被拒（KNOWN 带 reason / UNKNOWN 带 value / ABSENT 带 value）', () => {
  const mixed = [
    { state: 'KNOWN', value: USER, reason: 'LEGACY_UNRECORDED' },
    { state: 'UNKNOWN', reason: 'LEGACY_UNRECORDED', value: USER },
    { state: 'ABSENT', value: USER },
    { state: 'ABSENT', reason: 'LEGACY_UNRECORDED' },
    { state: 'MAYBE' },
  ] as unknown as AttributionValue<PrincipalRef>[]
  for (const value of mixed) {
    const violations = validateAttributionNecessity({
      family: 'user_message',
      envelope: userMessageEnvelope({ actor: value }),
    })
    expect.ok(
      codesOf(violations).includes('invalid_mixed_state'),
      `混合形状必须被拒：${JSON.stringify(value)}`
    )
  }
  // 正控：合法的三态一个都不该被这条判据碰到
  expect.notOk(codesOf(validateAttributionNecessity({
    family: 'user_message',
    envelope: userMessageEnvelope(),
  })).includes('invalid_mixed_state'))
})

test('运行时词汇兜底：越界的 kind / reason 被拒（类型擦除后的防线）', () => {
  const badKind = validateAttributionNecessity({
    family: 'user_message',
    envelope: userMessageEnvelope({
      actor: { state: 'KNOWN', value: { kind: 'DEVELOPER', id: 'x' } } as unknown as AttributionValue<PrincipalRef>,
    }),
  })
  expect.ok(codesOf(badKind).includes('unknown_principal_kind'), 'DEVELOPER 不是 PrincipalKind')

  const badReason = validateAttributionNecessity({
    family: 'user_message',
    envelope: userMessageEnvelope({
      contentOriginator: { state: 'UNKNOWN', reason: 'UNKNOWN_NOW' } as unknown as AttributionValue<PrincipalRef>,
    }),
  })
  expect.ok(codesOf(badReason).includes('unknown_unknown_reason'))

  const badAuthority = validateAttributionNecessity({
    family: 'action_authorized',
    envelope: minimalEnvelope({
      initiator: known(CHARACTER),
      actor: known(CHARACTER),
      recordedBy: known(LEDGER),
      authority: { state: 'KNOWN', value: { kind: 'DEVELOPER_SURFACE', ref: 'page' } } as unknown as AttributionValue<AuthorityRef>,
    }),
  })
  expect.ok(
    codesOf(badAuthority).includes('unknown_authority_kind'),
    'DEVELOPER_SURFACE 必须被运行时兜底拦住'
  )
})

test('principalRefEquals：同一个"谁"才算相等', () => {
  expect.ok(principalRefEquals({ kind: 'USER', id: 'u-1' }, { kind: 'USER', id: 'u-1' }))
  expect.notOk(principalRefEquals({ kind: 'USER', id: 'u-1' }, { kind: 'SERVICE', id: 'u-1' }))
  expect.notOk(principalRefEquals({ kind: 'USER', id: 'u-1' }, { kind: 'USER', id: 'u-2' }))
})

// ===========================================================================
group('WP1 :: 必要性矩阵（平面 3）')
// ===========================================================================

test('矩阵覆盖全部 10 个事件族，且单元状态都是受控值', () => {
  expect.deepEqual([...ATTRIBUTION_EVENT_FAMILIES], [
    'user_message',
    'assistant_message',
    'system_event',
    'tool_event',
    'action_requested',
    'action_authorized',
    'action_side_effect_execution',
    'action_read_only_diagnostic',
    'developer_control',
    // WP9-B1（R-45）：状态转移是**第 10 个**族（曾经的"9 个族"判据按新事实改写，未放宽）
    'state_transition',
  ])
  for (const family of ATTRIBUTION_EVENT_FAMILIES) {
    const row = NECESSITY_MATRIX[family]
    expect.ok(row !== undefined, `${family} 必须有矩阵行`)
    for (const slot of ATTRIBUTION_SLOTS) {
      expect.ok(
        (NECESSITY_STATES as readonly string[]).includes(row[slot]),
        `${family}.${slot} 的单元必须是受控状态，实际 ${String(row[slot])}`
      )
    }
    expect.equal(row.subject, 'DERIVED', 'subject 永远是派生语义（不新增存储）')
  }
  expect.includes(NECESSITY_MATRIX_SOURCE, 'Proposed-Schema')
})

test('WP9-B1（R-45）：state_transition 的冻结单元格、非 Axis B、回填 U 分类"未冻结"', () => {
  const row = NECESSITY_MATRIX.state_transition
  // 冻结值逐格断言（不是"看起来合理"）：系统发起 / 谁决定并施加 / 无独立执行者 /
  // 真实系统规则 / 账本写入器 / 不是内容主张
  expect.equal(row.initiator, 'REQUIRED')
  expect.equal(row.actor, 'REQUIRED')
  expect.equal(row.executor, 'ABSENT')
  expect.equal(row.authority, 'REQUIRED')
  expect.equal(row.recordedBy, 'REQUIRED')
  expect.equal(row.contentOriginator, 'ABSENT')
  expect.equal(row.subject, 'DERIVED')

  // 状态转移**不**进 Cognitive Axis B（全局不适用，与行动族/控制面同侧）
  expect.notOk(COGNITIVE_AXIS_B_FAMILIES.includes('state_transition'))
  expect.notOk(isCognitiveAxisBApplicable('state_transition'))

  // 它有写入期矩阵行，但**没有**冻结的回填 U 分类 ⇒ 必须在 deferred 列表里，
  // 且**不得**被塞进对话分类表（K-20 的"恰好相等"断言靠这两条成立）
  expect.ok(BACKFILL_CONTRACT_DEFERRED_FAMILIES.includes('state_transition'))
  expect.notOk('state_transition' in CONVERSATION_BACKFILL_CLASSIFICATION)

  // SYSTEM 的溯源规则是成文的：只能来自组件自己的受信身份
  expect.includes(STATE_TRANSITION_SYSTEM_ORIGIN_RULE, '受信身份')
  expect.includes(STATE_TRANSITION_SYSTEM_ORIGIN_RULE, 'trigger')
})

test('7. 必需槽位缺失 → 拒绝（正向：缺 actor / recordedBy）', () => {
  const violations = validateAttributionNecessity({
    family: 'user_message',
    envelope: minimalEnvelope(),
  })
  const codes = codesOf(violations)
  expect.ok(codes.includes('required_slot_absent'), 'actor / recordedBy 缺失必须被拒')
  expect.equal(
    violations.filter((v) => v.code === 'required_slot_absent').length,
    3,
    'user_message 缺的是 actor / recordedBy（REQUIRED）与 contentOriginator（? 也要求被表态）三个'
  )
  // 失败关闭版本必须抛
  let threw = false
  try {
    assertAttributionNecessity({ family: 'user_message', envelope: minimalEnvelope() })
  } catch (error) {
    threw = true
    expect.equal((error as { code?: string }).code, 'attribution_necessity_violation')
  }
  expect.ok(threw, 'assertAttributionNecessity 必须失败关闭')
})

test('8. 不适用槽位被填具体值 → 拒绝（**反向负控**，本设计的要害）', () => {
  // user_message.executor = Known(USER) —— 什么都没执行，填一个执行者就是伪造
  const executorFilled = validateAttributionNecessity({
    family: 'user_message',
    envelope: userMessageEnvelope({ executor: known(USER) }),
  })
  expect.ok(
    codesOf(executorFilled).includes('absent_slot_filled_concrete'),
    'user_message.executor = Known(USER) 必须 FAIL'
  )

  // user_message.authority = Known(POLICY/x) —— 说话不需要许可
  const authorityFilled = validateAttributionNecessity({
    family: 'user_message',
    envelope: userMessageEnvelope({ authority: attributionKnown<AuthorityRef>({ kind: 'POLICY', ref: 'p/x' }) }),
  })
  expect.ok(codesOf(authorityFilled).includes('absent_slot_filled_concrete'))

  // 只读诊断填 authority —— 读一次不需要许可
  const diagnosticAuthority = validateAttributionNecessity({
    family: 'action_read_only_diagnostic',
    envelope: minimalEnvelope({
      initiator: known(CHARACTER),
      actor: known(CHARACTER),
      recordedBy: known(LEDGER),
      authority: attributionKnown<AuthorityRef>(CAPABILITY),
    }),
  })
  expect.ok(
    codesOf(diagnosticAuthority).includes('absent_slot_filled_concrete'),
    'read-only diagnostic.authority = Known(...) 必须 FAIL'
  )

  // 不适用槽位连 Unknown 也不许（"这个概念不适用"却给它记一个未知）
  const absentUnknown = validateAttributionNecessity({
    family: 'user_message',
    envelope: userMessageEnvelope({ executor: unknown('RUNTIME_UNRESOLVED') }),
  })
  expect.ok(codesOf(absentUnknown).includes('absent_slot_filled_unknown'))
})

test('正控：合法 user_message 一个违规都没有（检测器不许恒响）', () => {
  expect.deepEqual(validateAttributionNecessity({
    family: 'user_message',
    envelope: userMessageEnvelope(),
  }), [])
})

test('9. ACTION_REQUESTED: authority = Absent（请求发生 ≠ 请求已获授权）', () => {
  const legal = minimalEnvelope({
    initiator: known(CHARACTER),
    actor: known(CHARACTER),
    recordedBy: known(LEDGER),
  })
  expect.deepEqual(validateAttributionNecessity({ family: 'action_requested', envelope: legal }), [])

  const illegal = minimalEnvelope({
    initiator: known(CHARACTER),
    actor: known(CHARACTER),
    recordedBy: known(LEDGER),
    authority: attributionKnown<AuthorityRef>(CAPABILITY),
  })
  const codes = codesOf(validateAttributionNecessity({ family: 'action_requested', envelope: illegal }))
  expect.ok(codes.includes('absent_slot_filled_concrete'), 'ACTION_REQUESTED.authority 必须 FAIL')
})

test('10. ACTION_AUTHORIZED: authority = Required（许可从请求事件搬到授权事件）', () => {
  const without = minimalEnvelope({
    initiator: known(CHARACTER),
    actor: known(CHARACTER),
    recordedBy: known(LEDGER),
  })
  expect.ok(
    codesOf(validateAttributionNecessity({ family: 'action_authorized', envelope: without })).includes(
      'required_slot_absent'
    ),
    'ACTION_AUTHORIZED 缺 authority 必须 FAIL'
  )

  const withAuthority = minimalEnvelope({
    initiator: known(CHARACTER),
    actor: known(CHARACTER),
    recordedBy: known(LEDGER),
    authority: attributionKnown<AuthorityRef>(CAPABILITY),
  })
  expect.deepEqual(
    validateAttributionNecessity({ family: 'action_authorized', envelope: withAuthority }),
    []
  )

  // 运行时确实定不下来时，Unknown(RUNTIME_UNRESOLVED) 是合法的（U-04）
  const runtimeUnknown = minimalEnvelope({
    initiator: known(CHARACTER),
    actor: known(CHARACTER),
    recordedBy: known(LEDGER),
    authority: attributionUnknown<AuthorityRef>('RUNTIME_UNRESOLVED'),
  })
  expect.deepEqual(
    validateAttributionNecessity({ family: 'action_authorized', envelope: runtimeUnknown }),
    []
  )

  // 但"历史没记"不是新事件的理由
  const legacyReason = minimalEnvelope({
    initiator: known(CHARACTER),
    actor: known(CHARACTER),
    recordedBy: known(LEDGER),
    authority: attributionUnknown<AuthorityRef>('LEGACY_UNRECORDED'),
  })
  expect.ok(
    codesOf(validateAttributionNecessity({ family: 'action_authorized', envelope: legacyReason })).includes(
      'required_slot_legacy_unrecorded'
    ),
    '新事件的必需槽位不得写 Unknown(LEGACY_UNRECORDED)'
  )
})

test('有副作用的执行：authority 必需、executor 允许运行时未知', () => {
  const ok = minimalEnvelope({
    initiator: known(USER),
    actor: known(CHARACTER),
    executor: unknown('RUNTIME_UNRESOLVED'),
    recordedBy: known(LEDGER),
    authority: attributionKnown<AuthorityRef>(CAPABILITY),
  })
  expect.deepEqual(
    validateAttributionNecessity({ family: 'action_side_effect_execution', envelope: ok }),
    []
  )

  const noAuthority = minimalEnvelope({
    initiator: known(USER),
    actor: known(CHARACTER),
    executor: known(TOOL),
    recordedBy: known(LEDGER),
  })
  expect.ok(
    codesOf(
      validateAttributionNecessity({ family: 'action_side_effect_execution', envelope: noAuthority })
    ).includes('required_slot_absent')
  )
})

test('D01 的合法形状必须**通过**：actor_type=user 但 contentOriginator=SERVICE', () => {
  // 这正是 M5.1-D01 说"表达不出来"的那一行：agent 用 user role 替用户发的内容。
  // 契约必须让它**合法入账**（否则修复就变成了另一种不可表达）。
  const envelope = userMessageEnvelope({
    actor: known(USER),
    contentOriginator: known(AGENT),
  })
  expect.deepEqual(validateAttributionNecessity({ family: 'user_message', envelope }), [])
  expect.equal(envelope.actor.state, 'KNOWN')
  expect.equal(envelope.contentOriginator.state, 'KNOWN')
  if (envelope.contentOriginator.state === 'KNOWN') {
    expect.equal(envelope.contentOriginator.value.kind, 'SERVICE')
  }
})

test('回填行（MIGRATED_LEGACY）由回填规则管，但**不得伪造 contentOriginator**', () => {
  /*
   * K-20（2026-09-18）：这条判据从"**任何**具体 contentOriginator 都是伪造"
   * 改成**按 D/P/U/N 分类判**。
   *
   * 为什么必须改：`tool_event.contentOriginator = D`（K-3 FINAL）——
   * 对确定性的工具行记 `Known(TOOL/<tool-id>)` 是**正确结果**。
   * 旧的 blanket 判据会把它判成伪造，与冻结矩阵、K-3 直接冲突。
   *
   * ⚠️ 判据**没有被删除、也没有被放宽**：伪造仍然会被抓到，只是理由码按分类给出。
   */

  // ① U 槽位：user_message.contentOriginator = **U** ⇒ 具体值计数必须为 0
  const fabricated = minimalEnvelope({
    contentOriginator: known(AGENT),
    attributionOrigin: 'MIGRATED_LEGACY',
  })
  expect.ok(
    codesOf(validateAttributionNecessity({ family: 'user_message', envelope: fabricated })).includes(
      'migrated_legacy_u_slot_fabricated'
    ),
    'U 槽位出现具体值即伪造（分类感知后的理由码）'
  )

  // ② **值级**禁止与分类无关：contentOriginator 永不可是 Known(USER / CHARACTER)。
  //    这里刻意挑一个 D 槽位（tool_event.contentOriginator = D）：
  //    即使分类允许 Known，"说成是用户/角色提供的"仍然是伪造（§3.7 / D01）。
  for (const forged of [USER, CHARACTER]) {
    const toolForged = toolEventEnvelope({
      contentOriginator: known(forged),
      attributionOrigin: 'MIGRATED_LEGACY',
    })
    expect.ok(
      codesOf(validateAttributionNecessity({ family: 'tool_event', envelope: toolForged })).includes(
        'migrated_legacy_fabricated_content_originator'
      ),
      `D 槽位被说成 Known(${forged.kind}) ⇒ 伪造（值级禁止，与分类无关）`
    )
  }

  // ③ 正控：回填行该有的样子（Unknown(LEGACY_UNRECORDED) / Absent）必须安静
  //    ⚠️ K-23 / R-20 之后 `recordedBy` **必须**是 canonical ledger recorder
  //    （SYSTEM/kernel）—— 它不再是 "Unknown 或 Absent 都行"。
  const honest = minimalEnvelope({
    actor: unknown('LEGACY_UNRECORDED'),
    recordedBy: known(LEDGER),
    contentOriginator: unknown('LEGACY_UNRECORDED'),
    attributionOrigin: 'MIGRATED_LEGACY',
  })
  expect.deepEqual(validateAttributionNecessity({ family: 'user_message', envelope: honest }), [])

  // ④ 正控（K-20 的要害）：**确定性工具行**的 Known(TOOL/<tool-id>) 必须合法、不得被判成伪造
  const deterministicTool = toolEventEnvelope({ attributionOrigin: 'MIGRATED_LEGACY' })
  expect.deepEqual(
    validateAttributionNecessity({ family: 'tool_event', envelope: deterministicTool }),
    [],
    'D 槽位记录确定性证据（TOOL/weather）必须是合法的回填结果'
  )

  // ⑤ N 槽位（tool_event.executor）被填值 ⇒ 必须违规
  const filledExecutor = toolEventEnvelope({
    executor: known(TOOL),
    attributionOrigin: 'MIGRATED_LEGACY',
  })
  expect.ok(
    codesOf(validateAttributionNecessity({ family: 'tool_event', envelope: filledExecutor })).includes(
      'migrated_legacy_n_slot_not_absent'
    ),
    'N 槽位（不适用）填了值即违规'
  )

  // ⑥ K-23 / R-20：`recordedBy` 必须是 canonical ledger recorder（SYSTEM/kernel）。
  //    "recordedBy MUST NOT be caller supplied" 的可执行形式：调用方自报任何别的位次 ⇒ 必红。
  const forgedRecorders = [
    { kind: 'USER', id: 'kernel' },
    { kind: 'CHARACTER', id: 'kernel' },
    { kind: 'TOOL', id: 'kernel' },
    { kind: 'SERVICE', id: 'kernel' },
    { kind: 'SYSTEM', id: 'not-the-kernel' },
  ] as const
  for (const forgedRecorder of forgedRecorders) {
    const forged = toolEventEnvelope({
      recordedBy: known(forgedRecorder),
      attributionOrigin: 'MIGRATED_LEGACY',
    })
    expect.ok(
      codesOf(validateAttributionNecessity({ family: 'tool_event', envelope: forged })).includes(
        'migrated_legacy_recorder_not_canonical'
      ),
      `recordedBy=${forgedRecorder.kind}/${forgedRecorder.id} ⇒ 必红（K-23）`
    )
  }
  expect.deepEqual(
    validateAttributionNecessity({
      family: 'tool_event',
      envelope: toolEventEnvelope({ attributionOrigin: 'MIGRATED_LEGACY' }),
    }),
    [],
    'canonical recorder（SYSTEM/kernel）⇒ 静默'
  )
})

test('subject 缺失 → 拒绝（派生语义也必须真的派生出来）', () => {
  const violations = validateAttributionNecessity({
    family: 'user_message',
    envelope: userMessageEnvelope({ subject: undefined as unknown as PrincipalRef }),
  })
  expect.ok(codesOf(violations).includes('subject_missing'))
})

test('K-3 FINAL 已同步进矩阵：tool_event 三格不再是旧冲突值', () => {
  // 旧值（K-3 裁定前）：actor=ABSENT / executor=ALLOWED_UNKNOWN / contentOriginator=ABSENT
  expect.equal(NECESSITY_MATRIX.tool_event.actor, 'REQUIRED', 'K-3：actor 必备')
  expect.equal(
    NECESSITY_MATRIX.tool_event.contentOriginator,
    'REQUIRED',
    'K-3：contentOriginator 必备（与 actor 相同是合法的）'
  )
  expect.equal(NECESSITY_MATRIX.tool_event.executor, 'ABSENT', 'K-3：executor 不适用')
  // 裁定记录必须存在且自洽——否则"旧矩阵"会重新变成某些人眼里的真相
  expect.atLeast(NECESSITY_MATRIX_RULINGS.length, 3)
  for (const ruling of NECESSITY_MATRIX_RULINGS) {
    expect.equal(
      NECESSITY_MATRIX[ruling.family][ruling.slot],
      ruling.after,
      `${ruling.family}.${ruling.slot} 必须等于裁定后的值`
    )
    expect.notOk(ruling.before === ruling.after, '裁定记录必须真的记录了变化')
    expect.includes(ruling.decidedBy, 'K-3')
  }
})

test('K-3 之后的 tool_event：合法信封通过，三处旧冲突形态各自被拒', () => {
  const legal = minimalEnvelope({
    initiator: known(TOOL),
    actor: known(TOOL),
    executor: absent,
    recordedBy: known(LEDGER),
    contentOriginator: known(TOOL),
  })
  expect.deepEqual(validateAttributionNecessity({ family: 'tool_event', envelope: legal }), [])

  // 旧矩阵把 executor 记成"允许 Unknown"——现在填任何东西都不行
  const filledExecutor = validateAttributionNecessity({
    family: 'tool_event',
    envelope: minimalEnvelope({
      initiator: known(TOOL),
      actor: known(TOOL),
      executor: known(TOOL),
      recordedBy: known(LEDGER),
      contentOriginator: known(TOOL),
    }),
  })
  expect.ok(
    codesOf(filledExecutor).includes('absent_slot_filled_concrete'),
    'tool_event.executor 填了具体值必须 FAIL（执行者归 Action Ledger）'
  )

  // 旧矩阵把 actor / contentOriginator 记成 Absent——现在缺一个都不行
  const missingActor = validateAttributionNecessity({
    family: 'tool_event',
    envelope: minimalEnvelope({
      initiator: known(TOOL),
      recordedBy: known(LEDGER),
      contentOriginator: known(TOOL),
    }),
  })
  expect.ok(codesOf(missingActor).includes('required_slot_absent'), 'tool_event 缺 actor 必须 FAIL')

  const missingOriginator = validateAttributionNecessity({
    family: 'tool_event',
    envelope: minimalEnvelope({
      initiator: known(TOOL),
      actor: known(TOOL),
      recordedBy: known(LEDGER),
    }),
  })
  expect.ok(
    codesOf(missingOriginator).includes('required_slot_absent'),
    'tool_event 缺 contentOriginator 必须 FAIL'
  )
})

// ===========================================================================
group('WP1 :: Attestation 边界（G-AT-4）')
// ===========================================================================

test('11+③. 外部自报三类字段 → 拒绝（三个负控各一条）', () => {
  for (const field of UNTRUSTED_ATTRIBUTION_FIELDS) {
    let threw = false
    try {
      assertNoUntrustedAttributionFields({ content: '你好', [field]: 'x' })
    } catch (error) {
      threw = true
      expect.equal((error as { code?: string }).code, 'untrusted_attribution_field')
    }
    expect.ok(threw, `untrusted DTO 带 ${field} 必须被拒`)

    let threw2 = false
    try {
      constructTrustedAttribution({
        family: 'user_message',
        envelope: userMessageEnvelope(),
        callerSuppliedFields: [field],
      })
    } catch {
      threw2 = true
    }
    expect.ok(threw2, `调用方自称提供 ${field} 必须被拒`)
  }
  expect.deepEqual([...UNTRUSTED_ATTRIBUTION_FIELDS], ['contentOriginator', 'authority', 'executor'])
})

test('正控：trusted ingress 构造的合法归因必须安静，并带 trusted 标记', () => {
  const trusted = constructTrustedAttribution({
    family: 'user_message',
    envelope: userMessageEnvelope({ contentOriginator: known(AGENT) }),
    untrustedDto: { content: '你好' },
    callerSuppliedFields: ['content'],
  })
  expect.equal(trusted.trustedIngress, TRUSTED_INGRESS_MARK)
  expect.ok(isTrustedAttribution(trusted))
  expect.notOk(isTrustedAttribution(userMessageEnvelope()), '裸信封不是 trusted attribution')
})

test('trusted ingress 里若归因本身违规，构造同样失败关闭', () => {
  let threw = false
  try {
    constructTrustedAttribution({
      family: 'user_message',
      envelope: userMessageEnvelope({ executor: known(USER) }),
    })
  } catch (error) {
    threw = true
    expect.equal((error as { code?: string }).code, 'attribution_necessity_violation')
  }
  expect.ok(threw)
})

// ===========================================================================
group('WP1 :: Axis B 契约扩展（U-08 / U-09）')
// ===========================================================================

test('11. Axis B 扩展已落地（M5.1.1 基线 + 后 Lv2 追加），既有值一个字未改', () => {
  expect.ok((SOURCE_AUTHORITIES as readonly string[]).includes('UNCONFIRMED_ORIGIN'))
  /*
   * ⚠️ **2026-10-03 修订（后 Lv2 · S1 / ADR-091 D04）**：本断言原来是"恰为 7 个"。
   * 后 Lv2 往 Axis B 追加了**故事来源**（`story_fact` / `STORY_OBSERVATION` /
   * `story_experience`），因此"恰为 7"不再成立。
   *
   * **判据没有被放宽**（与 FC-T04 的阶段锁演进同一条纪律）：
   *   · M5.1.1 的 `UNCONFIRMED_ORIGIN` 仍在，且**仍是**那个语义；
   *   · M3 的既有值**一字未改、未换语义**（下面逐条断言）；
   *   · 新增值**只许追加**，且必须来自**同一份契约文件**（不是某个模块自己造的）。
   */
  expect.equal(SOURCE_AUTHORITIES.length, 8, 'M3 的 6 个 + M5.1.1 的 1 个 + 后 Lv2 的 1 个')
  expect.equal(
    SOURCE_AUTHORITIES[SOURCE_AUTHORITIES.length - 1],
    'STORY_OBSERVATION',
    '新增值只能**追加在尾部**：既有成员的顺序本身也是契约的一部分'
  )
  expect.ok((EPISTEMIC_SOURCES as readonly string[]).includes('UNCONFIRMED_ORIGIN'))
  expect.equal(EPISTEMIC_SOURCES.length, 6, '既有 4 个 + M5.1.1 的 1 个 + 后 Lv2 的 1 个')
  expect.equal(
    EPISTEMIC_SOURCES.filter((s) => s !== 'UNCONFIRMED_ORIGIN' && s !== 'story_experience').length,
    4,
    '既有 4 个 EpistemicSource 值不得改名、不得换语义'
  )
})

test('C. canSupportExternalFact(UNCONFIRMED_ORIGIN) 必须仍然为 false', () => {
  expect.notOk(canSupportExternalFact('UNCONFIRMED_ORIGIN'), '来源未确立的内容不能支持外部事实')
  expect.notOk(
    canSupportExternalFact('UNCONFIRMED_ORIGIN') === canSupportExternalFact('USER_EXPLICIT'),
    '不得把 UNCONFIRMED_ORIGIN 当成 USER_EXPLICIT 的等价物'
  )
})

test('D. EXTERNAL_FACT_AUTHORITIES 保留原有成员、且不含 UNCONFIRMED_ORIGIN', () => {
  const allowed = SOURCE_AUTHORITIES.filter((a) => canSupportExternalFact(a))
  expect.deepEqual([...allowed].sort(), [
    'TOOL_OBSERVATION',
    'USER_EXPLICIT',
    'USER_REPLY_CONFIRMATION',
  ])
})

test('A+B. authorityFromSource(UNCONFIRMED_ORIGIN) 失败关闭，且不返回任何 MemoryAuthority', () => {
  let thrown: unknown
  let returned: MemoryAuthority | undefined
  try {
    returned = authorityFromSource('UNCONFIRMED_ORIGIN')
  } catch (error) {
    thrown = error
  }
  expect.equal(returned, undefined, 'B：绝不允许返回一个 MemoryAuthority（哪怕是最弱的）')
  expect.ok(thrown !== undefined, 'A：必须抛错（fail closed）')
  expect.equal(
    (thrown as { code?: string }).code,
    'unconfirmed_origin_cannot_become_memory_authority',
    '失败关闭必须带自己的理由码，不能借用 system_instruction 那一个'
  )
})

test('晋级路径全枚举：8 个 SourceAuthority 里恰好 6 个可映射、2 个失败关闭', () => {
  /*
   * ⚠️ **2026-10-03 修订（后 Lv2 · S1 / ADR-091 D04/D05）**：
   * `STORY_OBSERVATION` 追加进来了，并且**有**一条映射
   * （`→ DIRECT_INTERACTION`，理由见 `contracts/memory.ts` 里那段注释：
   * 门槛不降 + 不是外部事实 + "现实 vs 模拟"由 provenance 承担而不是这一轴）。
   *
   * **失败关闭的那两个一个字没改** —— 本断言的核心（"哪些**拒绝**晋级"）
   * 反而是被加强的：它现在同时钉住"新增值必须**显式**给出映射或显式拒绝"。
   */
  const mapped: Record<string, string> = {}
  const closed: string[] = []
  for (const source of SOURCE_AUTHORITIES) {
    try {
      mapped[source] = authorityFromSource(source)
    } catch {
      closed.push(source)
    }
  }
  expect.deepEqual(Object.keys(mapped).sort(), [
    'CHARACTER_GENERATION',
    'DIRECT_INTERACTION',
    'STORY_OBSERVATION',
    'TOOL_OBSERVATION',
    'USER_EXPLICIT',
    'USER_REPLY_CONFIRMATION',
  ])
  expect.deepEqual([...closed].sort(), ['SYSTEM_INSTRUCTION', 'UNCONFIRMED_ORIGIN'])
  // 既有六个映射的语义一个字没改（与 M4 的既有断言一致）
  expect.equal(mapped['USER_EXPLICIT'], 'EXPLICIT_USER_STATEMENT')
  expect.equal(mapped['USER_REPLY_CONFIRMATION'], 'EXPLICIT_USER_STATEMENT')
  expect.equal(mapped['DIRECT_INTERACTION'], 'DIRECT_INTERACTION')
  expect.equal(mapped['TOOL_OBSERVATION'], 'TOOL_OBSERVATION')
  expect.equal(mapped['CHARACTER_GENERATION'], 'CHARACTER_GENERATION')
  // 新增值：映射到既有的 DIRECT_INTERACTION，**不新增 MemoryAuthority**
  expect.equal(mapped['STORY_OBSERVATION'], 'DIRECT_INTERACTION')
  expect.equal(MEMORY_AUTHORITIES.length, 6, '后 Lv2 不得新增 MemoryAuthority')
  expect.notOk(
    canSupportExternalFact('STORY_OBSERVATION'),
    '故事来源**不得**支持外部事实：模拟中通过二面不能升级成现实录取'
  )
})

test('检测器自检（三段式）：合法来源安静 → 注入假象必响 → 恢复后重新安静', () => {
  const detect = (source: SourceAuthority): string => {
    try {
      return `mapped:${authorityFromSource(source)}`
    } catch (error) {
      return `failed-closed:${(error as { code?: string }).code ?? 'unknown'}`
    }
  }
  // ① 正控：合法来源 → 安静（能正常说出它映射到哪）
  expect.equal(detect('USER_EXPLICIT'), 'mapped:EXPLICIT_USER_STATEMENT')
  // ② 负控：UNCONFIRMED_ORIGIN → 必须响
  expect.equal(
    detect('UNCONFIRMED_ORIGIN'),
    'failed-closed:unconfirmed_origin_cannot_become_memory_authority'
  )
  expect.notOk(detect('UNCONFIRMED_ORIGIN').startsWith('mapped:'), '假象绝不允许落进 mapped')
  // ③ 恢复：再喂合法来源 → 重新安静（证明②不是"恒响的噪音源"）
  expect.equal(detect('CHARACTER_GENERATION'), 'mapped:CHARACTER_GENERATION')
})

test('硬不变量：UNCONFIRMED_ORIGIN 可以作为已记录的 provenance，但没有晋级路径', () => {
  // 记录侧：它在两个受控词汇里（历史回填行必须能记它）
  expect.ok((SOURCE_AUTHORITIES as readonly string[]).includes('UNCONFIRMED_ORIGIN'))
  expect.ok((EPISTEMIC_SOURCES as readonly string[]).includes('UNCONFIRMED_ORIGIN'))
  // 晋级侧：MemoryAuthority 词汇表里**没有**它，也没有任何值代表它
  expect.notOk(isMemoryAuthority('UNCONFIRMED_ORIGIN'))
  expect.notOk((MEMORY_AUTHORITIES as readonly string[]).includes('UNCONFIRMED_ORIGIN'))
  expect.equal(MEMORY_AUTHORITIES.length, 6, 'MemoryAuthority 词汇表不得因为本 WP 而变动')
})

test('K-1 阻塞文书仍在（B1 已裁定，作为历史留档与裁定依据）', () => {
  const report = readFileSync(
    join(process.cwd(), 'docs', 'm5.1.1', 'M5.1.1-WP1-Blocking-Issue-Report.md'),
    'utf8'
  )
  expect.includes(report, 'authorityFromSource', '报告必须点出确切的冲突点')
  expect.includes(report, 'contracts/memory.ts')
  expect.includes(report, 'ADR-043')
})

test('12. EXTERNAL_FACT_AUTHORITIES 未扩权：白名单成员仍是那 3 个', () => {
  const allowed = SOURCE_AUTHORITIES.filter((a) => canSupportExternalFact(a))
  expect.deepEqual([...allowed].sort(), [
    'TOOL_OBSERVATION',
    'USER_EXPLICIT',
    'USER_REPLY_CONFIRMATION',
  ])
})

test('epistemicSourceForKind 对全部登记 SourceKind 全函数（Axis B 第二轴未被搅动）', () => {
  /*
   * ⚠️ **2026-10-03 修订（后 Lv2 · S1 / ADR-091 D04）**：`story_fact` 追加进来。
   * **没有被放宽的**是"全函数"这条性质本身 —— 本断言逐值检查**每一个**登记值
   * 都有确定的 EpistemicSource（`switch` 里漏一个值会被 `tsc` 与这条同时抓住）。
   */
  expect.deepEqual([...SOURCE_KINDS], [
    'user_statement',
    'character_output',
    'system_instruction',
    'tool_output',
    'story_fact',
  ])
  expect.equal(epistemicSourceForKind('user_statement'), 'user_report')
  expect.equal(epistemicSourceForKind('character_output'), 'character_generation')
  expect.equal(epistemicSourceForKind('system_instruction'), 'system_instruction')
  expect.equal(epistemicSourceForKind('tool_output'), 'tool_observation')
  expect.equal(epistemicSourceForKind('story_fact'), 'story_experience')
  // 全函数自检：**每一个**登记值都必须给出确定答案（不是"恰好前四个对"）
  for (const kind of SOURCE_KINDS) {
    const resolved = epistemicSourceForKind(kind)
    expect.ok(
      (EPISTEMIC_SOURCES as readonly string[]).includes(resolved),
      `${kind} → ${resolved} 必须落在受控词汇表里`
    )
  }
  // 故事来源**不得**混进对话事件族分类（ADR-091 D04 第 3 条硬约束）
  expect.notOk(
    Object.values(SOURCE_KIND_BY_EVENT_FAMILY).includes('story_fact'),
    'story_fact 不是对话事件族：混进去会让世界事实获得一条伪装成对话的通道'
  )
})

// ===========================================================================
group('WP1 :: 静态锁与跨界交叉核对')
// ===========================================================================

test('契约层没有"投影函数"的声明（ADR-042 D8.1 已删除它们）', () => {
  for (const file of ['actor.ts', 'attribution.ts']) {
    const source = codeOnly(contractSource(file))
    expect.notOk(
      /export\s+(function|const|type|interface)\s+(actorTypeFromPrincipalKind|projectActorTypeFromSlots)\b/.test(
        source
      ),
      `${file} 不得声明投影函数`
    )
  }
})

test('契约层没有 Draft v1 的并行概念名 sourceAuthor', () => {
  /*
   * K-24（2026-09-18）：判据由"**子串**包含"改成"**概念名**匹配"。
   *
   * 旧写法 `notIncludes(code, 'sourceAuthor')` 会把**合法**的 camelCase 名字
   * `sourceAuthority` / `sourceAuthorities`（Axis B 第二列的 DTO 字段名与复数形式）
   * 一起判红 —— 那是**假阳性**：锁的本意（见下面原注释）是
   * "不得重新引入 `sourceAuthor` 这个**概念名**"，不是"这个前缀永不允许出现"。
   *
   * ⚠️ 判据**没有被放宽**：`sourceAuthor` / `sourceAuthors`（单复数概念名）**仍然会红**；
   *    只是放过了 `sourceAuthority` / `sourceAuthorities` 这两个**另一个**合法名字。
   *    下面自带自检，证明精炼后的锁**仍然抓得住**它该抓的东西。
   */
  const legacyConceptName = /sourceAuthor(?!it(?:y|ies))/
  for (const file of ['actor.ts', 'attribution.ts', 'source-authority.ts']) {
    // 注意：`source_authority` 是**另一个**合法名字（Axis B 的第二列），
    // 所以这里查的是 camelCase 的 `sourceAuthor`，而且只查代码（注释里写明它已改名是允许的）。
    expect.notOk(
      legacyConceptName.test(codeOnly(contractSource(file))),
      `${file} 不得重新引入 sourceAuthor`
    )
  }
  // 自检：精炼后的锁必须**仍然会响**（否则它就从"假阳性"变成了"永不响"）
  expect.ok(legacyConceptName.test('const sourceAuthor = 1'), '必须抓住独立的概念名 sourceAuthor')
  expect.ok(legacyConceptName.test('sourceAuthors'), '必须抓住复数概念名 sourceAuthors')
  expect.notOk(legacyConceptName.test('sourceAuthority'), '合法的 sourceAuthority 不得被判红')
  expect.notOk(legacyConceptName.test('sourceAuthorities'), '合法的 sourceAuthorities 不得被判红')
})

test('契约层不把被删除的候选值写成词汇成员', () => {
  const source = codeOnly(contractSource('attribution.ts') + contractSource('source-authority.ts'))
  expect.notIncludes(source, "'DEVELOPER_SURFACE'")
  expect.notIncludes(source, "'UNKNOWN_LEGACY'")
  expect.notIncludes(source, "'UNKNOWN_NOW'")
})

test('ACTION_AUTHORIZED 已存在于 ActionEventType（不需要新增生产事件）', () => {
  expect.ok((ACTION_EVENT_TYPES as readonly string[]).includes('ACTION_REQUESTED'))
  expect.ok((ACTION_EVENT_TYPES as readonly string[]).includes('ACTION_AUTHORIZED'))
})

test('R-2 前置零退化断言：Fact Firewall 的可达性在契约层未被改动', () => {
  // WP1 只加词汇与 validator；canEvidenceExternalFact 的行为必须与今天逐字相同。
  expect.ok(
    canEvidenceExternalFact({ type: 'user_message', actorType: 'user' }),
    '用户陈述仍可支持外部事实'
  )
  expect.notOk(canEvidenceExternalFact({ type: 'assistant_message', actorType: 'character' }))
  expect.notOk(canEvidenceExternalFact({ type: 'system_event', actorType: 'system' }))
  expect.ok(canEvidenceExternalFact({ type: 'tool_event', actorType: 'tool' }))
})

// ===========================================================================
// 证据
// ===========================================================================

const summary = await runAll({ filter: process.argv[2] })
printSummary(summary, 'M5.1.1 WP1 归因契约层测试')

/** 由包装命令真实设置的退出码（缺失时记 null —— **绝不推断成 0/PASS**） */
function exitFromEnv(name: string): number | null {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

const suiteExits = {
  typecheck: exitFromEnv('M511_TYPECHECK_EXIT'),
  kernelTest: exitFromEnv('M511_KERNEL_TEST_EXIT'),
  conversation: exitFromEnv('M511_CONVERSATION_EXIT'),
  frozenAreaRegressionM4Ci: exitFromEnv('M511_M4_CI_EXIT'),
  source:
    'env M511_TYPECHECK_EXIT / M511_KERNEL_TEST_EXIT / M511_CONVERSATION_EXIT / M511_M4_CI_EXIT' +
    '（由执行 WP1.1 的包装命令真实设置；缺失时为 null —— 不得推断为 0）' +
    '【K-19】本 artifact 是 WP1 的**权威证据**：只在 M511_AUTHORITATIVE_EVIDENCE=1' +
    '且四路测量输入齐全时被写入；普通测试运行**不写**它。',
}

// ---------------------------------------------------------------------------
// K-19：权威证据写入门（fail closed）
// ---------------------------------------------------------------------------
// 真实事故：本脚本过去**每次**运行都无条件重写这两个 artifact。于是"顺手跑一下
// m5.1.1:test"会把已完成的 WP1 / WP1.1 权威证据里的**真实退出码 0 改写成 null**
// —— 一次静默降级，而且两次运行的 stdout 几乎一样（改写前后打印的是同一行
// "证据已写入：…"），从输出上**看不出**证据被降级了。
//
// 现在：普通 test execution **不写**；只有显式 `M511_AUTHORITATIVE_EVIDENCE=1`
// 才允许写，且必须同时满足两条 ——
//   ① 四路测量输入齐全（任一缺失 ⇒ 拒绝）；
//   ② 不得把**已经量到**的数值写成 null（existing 0 → null 被明确禁止）。
// 任一不满足 ⇒ **拒绝写入 + 非 0 退出**（fail closed），artifact 一个字节都不碰。
//
// 为什么用环境变量而不是 CLI 开关：`argv[2]` 已经被用作**测试过滤词**
// （`pnpm m5.1.1:test <filter>`）。再加一个位置参数会把过滤词吃掉 ——
// 那会写出"0 条测试通过"的权威证据，正是本门要防的事。

const AUTHORITATIVE_EVIDENCE_ENV = 'M511_AUTHORITATIVE_EVIDENCE'

/**
 * 证据目录（默认 `<cwd>/artifacts/m5.1.1`）。
 *
 * `M511_EVIDENCE_DIR` 是一个**验证缝**：只给
 * `scripts/verify-m5.1.1-k19-evidence-integrity.ts` 的三段式把**授权**写入重定向到临时目录用。
 * 之所以需要它：本脚本还要从 **cwd** 读 `src/kernel/contracts/**`（静态锁）与
 * `docs/m5.1.1/M5.1.1-WP1-Blocking-Issue-Report.md`，因此**不能在别的 cwd 下跑**。
 * 它不削弱 K-19：非授权运行仍然一个字节都不写，唯一效果是把**授权**写入挪走。
 */
const EVIDENCE_DIR = process.env.M511_EVIDENCE_DIR ?? join(process.cwd(), 'artifacts', 'm5.1.1')
const AUTHORITATIVE_ARTIFACTS = ['wp1-contracts.json', 'wp1-axis-b-closure.json'] as const
const MEASUREMENT_INPUT_KEYS = [
  'typecheck',
  'kernelTest',
  'conversation',
  'frozenAreaRegressionM4Ci',
] as const

const authoritativeEvidenceRequested = process.env[AUTHORITATIVE_EVIDENCE_ENV] === '1'

/** 递归收集一份已落盘证据里**已经量到**的退出码（两个 artifact 的嵌套形状不同） */
function collectMeasuredExits(value: unknown, found: Map<string, number>): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectMeasuredExits(item, found)
    return
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      (MEASUREMENT_INPUT_KEYS as readonly string[]).includes(key) &&
      typeof item === 'number' &&
      Number.isFinite(item)
    ) {
      found.set(key, item)
    } else {
      collectMeasuredExits(item, found)
    }
  }
}

function readExistingMeasuredExits(fileName: string): Map<string, number> {
  const found = new Map<string, number>()
  try {
    collectMeasuredExits(
      JSON.parse(readFileSync(join(EVIDENCE_DIR, fileName), 'utf8')),
      found
    )
  } catch {
    // 不存在 / 解析不了 ⇒ 没有"已量到"的值可以失去
  }
  return found
}

/** 返回拒绝原因；`null` = 允许写。顺序：先查"降级"，再查"缺输入"。 */
function authoritativeWriteRefusal(): string | null {
  const downgrades: string[] = []
  for (const fileName of AUTHORITATIVE_ARTIFACTS) {
    const existing = readExistingMeasuredExits(fileName)
    for (const key of MEASUREMENT_INPUT_KEYS) {
      const measured = existing.get(key)
      if (measured !== undefined && suiteExits[key] === null) {
        downgrades.push(`${fileName}:${key} ${measured} → null`)
      }
    }
  }
  const missing = MEASUREMENT_INPUT_KEYS.filter((key) => suiteExits[key] === null)
  if (downgrades.length > 0) {
    return (
      'K19_REFUSED_AUTHORITATIVE_WRITE reason=measured-downgrade' +
      `（禁止把已量到的值写成 null）：${downgrades.join(' | ')}`
    )
  }
  if (missing.length > 0) {
    return (
      'K19_REFUSED_AUTHORITATIVE_WRITE reason=missing-measurement-input' +
      `（权威证据要求四路测量输入齐全）：缺 ${missing.join(', ')}`
    )
  }
  return null
}

const authoritativeWriteRefusalReason = authoritativeEvidenceRequested
  ? authoritativeWriteRefusal()
  : null
const authoritativeWriteAllowed =
  authoritativeEvidenceRequested && authoritativeWriteRefusalReason === null
const authoritativeWriteRefused = authoritativeWriteRefusalReason !== null

if (!authoritativeEvidenceRequested) {
  console.log(
    `K-19 证据门：非授权运行 ⇒ 不写 ${AUTHORITATIVE_ARTIFACTS.join(' / ')}` +
      `（要写请显式 ${AUTHORITATIVE_EVIDENCE_ENV}=1 并给出四路 M511_*_EXIT）`
  )
} else if (authoritativeWriteRefusalReason !== null) {
  console.error(`❌ ${authoritativeWriteRefusalReason}`)
  console.error('   ⇒ 拒绝写入（fail closed）：artifact 保持原样。')
} else {
  console.log(`K-19 证据门：授权写入（${AUTHORITATIVE_EVIDENCE_ENV}=1，四路测量输入齐全）`)
}

/** 只有授权写入才落盘；否则**一个字节都不碰**（连目录都不建） */
function writeEvidenceMaybe(fileName: string, content: string, encoding: BufferEncoding): void {
  if (!authoritativeWriteAllowed) return
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, fileName), content, encoding)
}

function logEvidenceOutcome(fileName: string): void {
  if (!authoritativeWriteAllowed) return
  const rel = relative(process.cwd(), join(EVIDENCE_DIR, fileName))
  console.log(`证据已写入：${rel.startsWith('..') ? join(EVIDENCE_DIR, fileName) : rel}`)
}

writeEvidenceMaybe(
  'wp1-contracts.json',
  `${JSON.stringify(
    {
      testId: 'M5.1.1 / WP1 attribution contracts',
      generatedAt: new Date().toISOString(),
      command: 'pnpm m5.1.1:test',
      passed: summary.passed,
      failed: summary.failed,
      failures: summary.failures.map((f) => ({ name: f.name, message: f.failure.message })),
      durationMs: summary.durationMs,
      suiteExits,
      vocabulary: {
        principalKinds: [...PRINCIPAL_KINDS],
        unknownReasons: [...UNKNOWN_REASONS],
        authorityKinds: [...AUTHORITY_KINDS],
        attributionValueStates: [...ATTRIBUTION_VALUE_STATES],
        attributionSlots: [...ATTRIBUTION_SLOTS],
        attributionOrigins: [...ATTRIBUTION_ORIGINS],
        sourceAuthorities: [...SOURCE_AUTHORITIES],
        epistemicSources: [...EPISTEMIC_SOURCES],
        memoryAuthorities: [...MEMORY_AUTHORITIES],
        sourceKinds: [...SOURCE_KINDS],
      },
      axisB: {
        status: 'VERIFIED',
        closure: 'WP1.1 Axis B Fail-Closed Compatibility Closure（K-1 = B1）',
        blockedItemResolved: 'SourceAuthority.UNCONFIRMED_ORIGIN / EpistemicSource.UNCONFIRMED_ORIGIN',
        blockerReport: 'docs/m5.1.1/M5.1.1-WP1-Blocking-Issue-Report.md（历史留档）',
        observedVocabulary: {
          sourceAuthorities: [...SOURCE_AUTHORITIES],
          sourceAuthoritiesCount: SOURCE_AUTHORITIES.length,
          epistemicSources: [...EPISTEMIC_SOURCES],
          epistemicSourcesCount: EPISTEMIC_SOURCES.length,
          memoryAuthorities: [...MEMORY_AUTHORITIES],
          memoryAuthoritiesCount: MEMORY_AUTHORITIES.length,
        },
        unconfirmedOriginWhitelistStatus: {
          canSupportExternalFact: canSupportExternalFact('UNCONFIRMED_ORIGIN'),
          failClosed: canSupportExternalFact('UNCONFIRMED_ORIGIN') === false,
        },
        externalFactAuthoritiesObserved: SOURCE_AUTHORITIES.filter((a) =>
          canSupportExternalFact(a)
        ),
        whitelistSizeObserved: SOURCE_AUTHORITIES.filter((a) => canSupportExternalFact(a)).length,
        epistemicSourceForKind: SOURCE_KINDS.map((kind) => ({
          kind,
          epistemicSource: epistemicSourceForKind(kind),
        })),
        promotionPathEnumeration: SOURCE_AUTHORITIES.map((source) => {
          try {
            return { source, outcome: 'mapped', memoryAuthority: authorityFromSource(source) }
          } catch (error) {
            return {
              source,
              outcome: 'failed-closed',
              reasonCode: (error as { code?: string }).code ?? 'unknown',
            }
          }
        }),
      },
      schemaBridge: {
        slotColumns: ATTRIBUTION_SLOT_COLUMNS,
        nonSlotColumns: [...ATTRIBUTION_NON_SLOT_COLUMNS],
        v7ColumnCount: ATTRIBUTION_V7_COLUMNS.length,
        source: 'M5.1.1-Proposed-Schema.md §0/§1（22 列/表；DDL 属 WP2）',
      },
      necessityMatrix: {
        source: NECESSITY_MATRIX_SOURCE,
        families: [...ATTRIBUTION_EVENT_FAMILIES],
        matrix: NECESSITY_MATRIX,
        rulings: NECESSITY_MATRIX_RULINGS,
        negativeControls: [
          {
            id: 'user_message.executor = Known(USER)',
            expected: 'absent_slot_filled_concrete',
            observed: codesOf(
              validateAttributionNecessity({
                family: 'user_message',
                envelope: userMessageEnvelope({ executor: known(USER) }),
              })
            ),
          },
          {
            id: 'user_message.authority = Known(POLICY/x)',
            expected: 'absent_slot_filled_concrete',
            observed: codesOf(
              validateAttributionNecessity({
                family: 'user_message',
                envelope: userMessageEnvelope({
                  authority: attributionKnown<AuthorityRef>({ kind: 'POLICY', ref: 'p/x' }),
                }),
              })
            ),
          },
          {
            id: 'action_read_only_diagnostic.authority = Known(CAPABILITY/…)',
            expected: 'absent_slot_filled_concrete',
            observed: codesOf(
              validateAttributionNecessity({
                family: 'action_read_only_diagnostic',
                envelope: minimalEnvelope({
                  initiator: known(CHARACTER),
                  actor: known(CHARACTER),
                  recordedBy: known(LEDGER),
                  authority: attributionKnown<AuthorityRef>(CAPABILITY),
                }),
              })
            ),
          },
          {
            id: 'action_requested.authority = Known(CAPABILITY/…)',
            expected: 'absent_slot_filled_concrete',
            observed: codesOf(
              validateAttributionNecessity({
                family: 'action_requested',
                envelope: minimalEnvelope({
                  initiator: known(CHARACTER),
                  actor: known(CHARACTER),
                  recordedBy: known(LEDGER),
                  authority: attributionKnown<AuthorityRef>(CAPABILITY),
                }),
              })
            ),
          },
          {
            id: 'user_message.executor = Unknown(RUNTIME_UNRESOLVED)',
            expected: 'absent_slot_filled_unknown',
            observed: codesOf(
              validateAttributionNecessity({
                family: 'user_message',
                envelope: userMessageEnvelope({ executor: unknown('RUNTIME_UNRESOLVED') }),
              })
            ),
          },
        ],
        positiveControls: [
          {
            id: 'user_message 合法信封',
            observedViolations: validateAttributionNecessity({
              family: 'user_message',
              envelope: userMessageEnvelope(),
            }),
          },
          {
            id: 'D01 形状：actor_type=user ∧ contentOriginator=Known(SERVICE/agent)',
            observedViolations: validateAttributionNecessity({
              family: 'user_message',
              envelope: userMessageEnvelope({ actor: known(USER), contentOriginator: known(AGENT) }),
            }),
          },
          {
            id: 'ACTION_AUTHORIZED + Known(CAPABILITY)',
            observedViolations: validateAttributionNecessity({
              family: 'action_authorized',
              envelope: minimalEnvelope({
                initiator: known(CHARACTER),
                actor: known(CHARACTER),
                recordedBy: known(LEDGER),
                authority: attributionKnown<AuthorityRef>(CAPABILITY),
              }),
            }),
          },
        ],
      },
      attestationBoundary: {
        untrustedFields: [...UNTRUSTED_ATTRIBUTION_FIELDS],
        trustedIngressMark: TRUSTED_INGRESS_MARK,
        requirement: 'G-AT-4：外部调用方不得自报 contentOriginator / authority / executor',
      },
      firewallUnchanged: {
        note: 'WP1 未改 canEvidenceExternalFact / extractor / MemoryAuthority（R-2 的前置断言）',
        probes: [
          { type: 'user_message', actorType: 'user', allowed: canEvidenceExternalFact({ type: 'user_message', actorType: 'user' }) },
          { type: 'assistant_message', actorType: 'character', allowed: canEvidenceExternalFact({ type: 'assistant_message', actorType: 'character' }) },
          { type: 'system_event', actorType: 'system', allowed: canEvidenceExternalFact({ type: 'system_event', actorType: 'system' }) },
          { type: 'tool_event', actorType: 'tool', allowed: canEvidenceExternalFact({ type: 'tool_event', actorType: 'tool' }) },
        ],
      },
      scope: {
        status: 'PASS — WP1 全部交付（含 §6 Axis B 扩展，WP1.1 收口）',
        delivered: [
          'src/kernel/contracts/actor.ts（PrincipalKind / PrincipalRef / UnknownReason / AttributionValue 三态 + 构造器）',
          'src/kernel/contracts/attribution.ts（新增：AuthorityKind / AuthorityRef / 七槽位信封 / 必要性矩阵 / 双向 validator / Attestation 边界 / 22 个列名）',
          'src/kernel/contracts/source-authority.ts（§6：Axis B 两个 UNCONFIRMED_ORIGIN + sourceKindForActor 的 legacy classifier 定位）',
          'src/kernel/contracts/memory.ts（§6 的冻结区最小兼容改动：authorityFromSource 对 UNCONFIRMED_ORIGIN 失败关闭，不制造也不挑选任何 MemoryAuthority）',
          'scripts/kernel-tests-conversation.ts（基数断言 6 → 7，逐条记录见兼容性记录）',
          'scripts/kernel-tests-m5.1.1.ts + package.json 的 m5.1.1:test',
        ],
        notTouched: [
          'src/kernel/contracts/index.ts（re-export 与文件头登记：留给第一个消费它的 WP 或用户批准）',
          'persistence / migrations / v7 / runtime write-path',
          'Fact Firewall 行为（canEvidenceExternalFact 语义未改）· memory extractor 可达性 · Recall 行为',
          '既有六个 SourceAuthority → MemoryAuthority 映射的语义 · MemoryAuthority 词汇表',
          'artifacts/m5.1/**、artifacts/m4.5/**、artifacts/m5/**（未运行任何会重写它们的门）',
        ],
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)
logEvidenceOutcome('wp1-contracts.json')

// ---------------------------------------------------------------------------
// WP1.1 专项证据：Axis B 失败关闭收口
// ---------------------------------------------------------------------------

const promotionPathEnumeration = SOURCE_AUTHORITIES.map((source) => {
  try {
    return { source, outcome: 'mapped', memoryAuthority: authorityFromSource(source) }
  } catch (error) {
    return {
      source,
      outcome: 'failed-closed',
      reasonCode: (error as { code?: string }).code ?? 'unknown',
    }
  }
})

writeEvidenceMaybe(
  'wp1-axis-b-closure.json',
  `${JSON.stringify(
    {
      testId: 'M5.1.1 / WP1.1 Axis B fail-closed closure',
      generatedAt: new Date().toISOString(),
      decision: {
        k1: 'B1',
        decisionSource: '用户 2026-09-18 裁定（WP1.1 任务书：K-1 decision = B1）',
        blockerReport: 'docs/m5.1.1/M5.1.1-WP1-Blocking-Issue-Report.md',
      },
      hardInvariant:
        'UNCONFIRMED_ORIGIN 可以作为**已记录的 provenance** 存在，' +
        '但在 ADR-043 之前**没有**任何合法的 MemoryAuthority 晋级路径',
      vocabulary: {
        sourceAuthorities: [...SOURCE_AUTHORITIES],
        epistemicSources: [...EPISTEMIC_SOURCES],
        memoryAuthoritiesBeforeAndAfter: [...MEMORY_AUTHORITIES],
        memoryAuthoritiesCount: MEMORY_AUTHORITIES.length,
        note: 'MemoryAuthority 词汇表未变动（本 WP 只加了一条 fail-closed 分支）',
      },
      frozenAreaChange: {
        file: 'src/kernel/contracts/memory.ts',
        function: 'authorityFromSource',
        change: '新增 case \'UNCONFIRMED_ORIGIN\'，抛 KernelError，**不返回**任何 MemoryAuthority',
        reasonCode: 'unconfirmed_origin_cannot_become_memory_authority',
        existingMappingsUnchanged: true,
        exhaustiveLockPreserved: 'default 分支仍是 const exhaustive: never = source（未放宽）',
        agentRule: 'AGENTS §3 冻结区程序：追加能力 + 失败关闭；断言语义未被删除或放宽',
      },
      negativeControls: [
        {
          id: 'A. authorityFromSource(UNCONFIRMED_ORIGIN) 失败关闭',
          expected: 'throw',
          observed: (() => {
            try {
              authorityFromSource('UNCONFIRMED_ORIGIN')
              return 'returned'
            } catch (error) {
              return `throw:${(error as { code?: string }).code ?? 'unknown'}`
            }
          })(),
        },
        {
          id: 'B. 它不得返回任何 MemoryAuthority',
          expected: 'no MemoryAuthority returned',
          observed: (() => {
            try {
              const value = authorityFromSource('UNCONFIRMED_ORIGIN')
              return `returned:${String(value)}`
            } catch {
              return 'no MemoryAuthority returned (threw)'
            }
          })(),
        },
        {
          id: 'C. canSupportExternalFact(UNCONFIRMED_ORIGIN) 必须仍为 false',
          expected: false,
          observed: canSupportExternalFact('UNCONFIRMED_ORIGIN'),
        },
        {
          id: 'D. EXTERNAL_FACT_AUTHORITIES 保留原有成员、不含 UNCONFIRMED_ORIGIN',
          expected: ['TOOL_OBSERVATION', 'USER_EXPLICIT', 'USER_REPLY_CONFIRMATION'],
          observed: SOURCE_AUTHORITIES.filter((a) => canSupportExternalFact(a)),
        },
      ],
      detectorSelfTest: {
        description: '三段式：合法来源安静 → 注入假象必响 → 恢复后重新安静',
        positiveControl: (() => {
          try {
            return `quiet:mapped:${authorityFromSource('USER_EXPLICIT')}`
          } catch {
            return 'unexpected-throw'
          }
        })(),
        negativeControl: (() => {
          try {
            return `unexpected-mapped:${authorityFromSource('UNCONFIRMED_ORIGIN')}`
          } catch (error) {
            return `fired:${(error as { code?: string }).code ?? 'unknown'}`
          }
        })(),
        restored: (() => {
          try {
            return `quiet:mapped:${authorityFromSource('CHARACTER_GENERATION')}`
          } catch {
            return 'unexpected-throw'
          }
        })(),
      },
      promotionPathEnumeration,
      promotionPathSummary: {
        mapped: promotionPathEnumeration.filter((r) => r.outcome === 'mapped').map((r) => r.source),
        failedClosed: promotionPathEnumeration
          .filter((r) => r.outcome === 'failed-closed')
          .map((r) => r.source),
      },
      firewallUnchanged: {
        note: 'Fact Firewall 行为未改（canEvidenceExternalFact 语义与 extractor 可达性零变化）',
        probes: [
          { type: 'user_message', actorType: 'user', allowed: canEvidenceExternalFact({ type: 'user_message', actorType: 'user' }) },
          { type: 'assistant_message', actorType: 'character', allowed: canEvidenceExternalFact({ type: 'assistant_message', actorType: 'character' }) },
          { type: 'system_event', actorType: 'system', allowed: canEvidenceExternalFact({ type: 'system_event', actorType: 'system' }) },
          { type: 'tool_event', actorType: 'tool', allowed: canEvidenceExternalFact({ type: 'tool_event', actorType: 'tool' }) },
        ],
      },
      suites: {
        m5_1_1_test: { passed: summary.passed, failed: summary.failed },
        exits: suiteExits,
      },
      compatibilityRecord: 'docs/m5.1.1/M5.1.1-WP1.1-Compatible-Assertion-Record.md',
      changedAssertions: [
        {
          file: 'scripts/kernel-tests-conversation.ts',
          line: 102,
          before: 'expect.equal(SOURCE_AUTHORITIES.length, 6)',
          after: 'expect.equal(SOURCE_AUTHORITIES.length, 7)',
          criterionPreserved: '精确基数 + 封闭枚举（判据未删除、未放宽，只是精确值随加值更新）',
        },
      ],
      forbiddenScopeRespected: {
        persistence: false,
        migration: false,
        v7: false,
        runtimeWritePath: false,
        factFirewallBehaviorChange: false,
        canEvidenceExternalFactSemanticChange: false,
        extractorReachabilityChange: false,
        memoryRequalification: false,
        memoryAuthorityMigration: false,
        recallBehaviorChange: false,
        adr043Implementation: false,
        wp2: false,
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)
logEvidenceOutcome('wp1-axis-b-closure.json')

console.log(
  `M511_TEST_SUMMARY ${JSON.stringify({
    passed: summary.passed,
    failed: summary.failed,
    durationMs: summary.durationMs,
    authoritativeEvidenceRequested,
    authoritativeWriteAllowed,
    authoritativeWriteRefused,
    evidenceWritten: authoritativeWriteAllowed ? [...AUTHORITATIVE_ARTIFACTS] : [],
    refusalReason: authoritativeWriteRefusalReason,
  })}`
)

process.exit(summary.failed === 0 && !authoritativeWriteRefused ? 0 : 1)
