/**
 * M7 WP2 —— **合同门**（`pnpm m7:wp2:contracts`）。
 *
 * ============================================================================
 *  要测的命题（计划 §5 WP2 的出口条件）
 * ============================================================================
 * ① `EntityRelationKey` 静态检查通过：关系合同用的是 entity.ts 的冻结形状，
 *    不是另造的；投影作用域按 projection-model.md 的约定编进 projectionType。
 * ② 无 `userTrust` 等写死形状：src/** 里不存在把 user 写死的关系字段。
 * ③ 合同自身的行为正确：payload 结构校验 / 证据等级判据 / 衰减纯函数 /
 *    界与夹取 / 拒绝码登记表 / 事件类型登记——全部走
 *    **正控 / 负控 / 恢复**三段式（AGENTS §6.7）。
 *
 * ============================================================================
 *  量具纪律
 * ============================================================================
 * · §6.7 三段式：只有正控的量具与"什么都不检查"无法区分；只有负控的量具
 *   与"拒绝一切"无法区分。恢复段证明检测器响过之后还能重新安静。
 * · §6.8：`measured_count > 0` 自检——三个阶段各自非空，否则 MEASUREMENT INVALID。
 * · 本门**不打开任何数据库**（纯合同检查；真实库边界不适用但照旧不碰）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import {
  DomainEventRegistry,
  MAX_CLOSENESS_DELTA_PER_EVENT,
  MAX_TRUST_DELTA_PER_EVENT,
  RELATIONSHIP_DOMAIN_EVENT_TYPES,
  RELATIONSHIP_ORIGIN_KINDS,
  RELATIONSHIP_REJECTION_CODES,
  UNORIGINATED_RELATIONSHIP_STATE,
  attributionKnown,
  clampRelationshipValue,
  createFullDomainEventRegistry,
  createRelationshipDomainEventRegistry,
  effectiveRelationship,
  entityRef,
  erodeClosenessForAbsence,
  isRelationshipRejectionCode,
  originKindAcceptedByM7,
  parseRelationshipProjectionType,
  relationshipDeltaWithinBounds,
  relationshipEvidenceVerdictOf,
  relationshipProjectionType,
  validateRelationshipImpactPayload,
  validateRelationshipOriginPayload,
  type ConversationEventId,
  type DomainEventId,
  type EntityId,
  type PrincipalRef,
  type RelationshipEvidenceCandidateView,
  type RelationshipImpactPayload,
  type RelationshipOriginPayload,
  type RelationshipState,
} from '../src/kernel/contracts/index.ts'
import type { TrustedOriginReading } from '../src/kernel/contracts/attribution.ts'
import { RELATIONSHIP_IMPACT, RELATIONSHIP_ORIGIN } from '../src/kernel/contracts/domain-event.ts'
import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// ---------------------------------------------------------------------------
// 量具：检查条目（与 m7-wp0-admission 同一形状）
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []

function record(id: string, label: string, expected: string, actual: string, pass: boolean): void {
  checks.push({ id, label, expected, actual, pass })
}

/** 断言 fn 抛错（负控用）：返回错误消息；不抛 ⇒ fail */
function expectThrow(label: string, fn: () => unknown): { threw: boolean; message: string } {
  try {
    fn()
    return { threw: false, message: '(未抛错)' }
  } catch (error) {
    return { threw: true, message: (error as Error).message }
  }
}

// ---------------------------------------------------------------------------
// 静态源码检查（WP2 出口条件 ①②）
// ---------------------------------------------------------------------------

function srcFilesUnder(dir: string): string[] {
  const out: string[] = []
  const visit = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name)
      if (entry.isDirectory()) visit(abs)
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs)
    }
  }
  visit(dir)
  return out
}

/**
 * 剥离 `//` 与 `/* *\/` 注释（字符串字面量内容保留），供标识符扫描用。
 *
 * 为什么不用正则：注释里的禁令原文（如 entity.ts 的"不允许 userTrust 这种形状"）
 * 必须不算违规，而"先删注释再扫"用正则做不可靠（URL 里的 `//`、跨行块注释）。
 * 状态机约 30 行，是这个量具自己的职责，不引第三方依赖。
 */
function stripComments(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  let state: 'code' | 'block' | 'line' | 'squote' | 'dquote' | 'template' = 'code'
  while (i < n) {
    const ch = text[i]
    const next = i + 1 < n ? text[i + 1] : ''
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line'
        i += 2
        continue
      }
      if (ch === '/' && next === '*') {
        state = 'block'
        i += 2
        continue
      }
      if (ch === "'") state = 'squote'
      else if (ch === '"') state = 'dquote'
      else if (ch === '`') state = 'template'
      out += ch
      i += 1
      continue
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code'
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code'
        out += '\n'
      }
      i += 1
      continue
    }
    // 字符串态：保留内容（字符串里的 'userTrust' 列名同样是违规形状），处理转义
    if (ch === '\\') {
      out += ch + next
      i += 2
      continue
    }
    if (
      (state === 'squote' && ch === "'") ||
      (state === 'dquote' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      state = 'code'
    }
    out += ch
    i += 1
  }
  return out
}

function staticChecks(): void {
  // S1：关系合同用的是 entity.ts 的冻结形状（EntityRelationKey），不是另造的
  const relationshipSource = readFileSync(join(REPO_ROOT, 'src/kernel/contracts/relationship.ts'), 'utf8')
  const usesFrozenKey =
    relationshipSource.includes("type EntityRelationKey } from './entity.ts'") &&
    relationshipSource.includes('key: EntityRelationKey')
  record(
    'S1',
    '关系合同使用 entity.ts 冻结的 EntityRelationKey 形状（FC-05/ADR-018）',
    "import 含 EntityRelationKey，且 payload 字段类型为 key: EntityRelationKey",
    usesFrozenKey ? '形状正确（未另造键）' : '未检出冻结形状的使用',
    usesFrozenKey,
  )

  // S2：src/** 无 userTrust / user_trust 写死形状（WP2 出口条件②）
  //    量具必须**注释感知**：entity.ts:200 引用禁令原文（"不允许 userTrust 这种形状"）
  //    是文档，不是违规——第一版天真扫描把它误报了（读数保留在先前的 FAIL run 里）。
  //    字符串字面量**保留在扫描内**：代码里出现 'userTrust' 列名/字段名同样是写死形状。
  const hits: string[] = []
  for (const abs of srcFilesUnder(join(REPO_ROOT, 'src'))) {
    const code = stripComments(readFileSync(abs, 'utf8'))
    if (/userTrust|user_trust/.test(code)) {
      hits.push(relative(REPO_ROOT, abs))
    }
  }
  record(
    'S2',
    'src/** 代码中不存在 userTrust / user_trust 写死形状（注释里的禁令原文不算）',
    '0 处命中',
    hits.length === 0 ? '0 处命中' : `命中：${hits.join(', ')}`,
    hits.length === 0,
  )

  // S3：relationship.ts 只依赖 contracts（依赖方向单向）
  const importLines = [...relationshipSource.matchAll(/^import[^']*from\s+'([^']+)'/gm)].map((m) => m[1])
  const nonContract = importLines.filter((spec) => !spec.startsWith('./'))
  record(
    'S3',
    'relationship.ts 的 import 全部来自 ./contracts（不 import 框架 / SQL / node:*）',
    `全部 ${importLines.length} 条 import 以 './' 开头`,
    nonContract.length === 0
      ? `全部 ${importLines.length} 条均为 contracts 内部依赖`
      : `越界依赖：${nonContract.join(', ')}`,
    nonContract.length === 0 && importLines.length > 0,
  )

  // S4：登记表接线（WP2 时只登记不接线；WP4 起接入 full registry——判据随里程碑翻转，如实记录）
  const fullTypes = createFullDomainEventRegistry().types()
  const wired = fullTypes.filter((t) => (RELATIONSHIP_DOMAIN_EVENT_TYPES as readonly string[]).includes(t))
  record(
    'S4',
    'createFullDomainEventRegistry() 含全部 Relationship 类型（WP4 起接线；WP2 时代断言相反）',
    `交集 = ${RELATIONSHIP_DOMAIN_EVENT_TYPES.join(' + ')}`,
    wired.length === RELATIONSHIP_DOMAIN_EVENT_TYPES.length
      ? `接线齐全（full 共 ${fullTypes.length} 类）`
      : `缺：${RELATIONSHIP_DOMAIN_EVENT_TYPES.filter((t) => !wired.includes(t)).join(', ')}`,
    wired.length === RELATIONSHIP_DOMAIN_EVENT_TYPES.length,
  )
}

// ---------------------------------------------------------------------------
// 运行时三段式
// ---------------------------------------------------------------------------

const OWNER = 'char_sumuwei' as EntityId
const TARGET = 'user-1' as EntityId

const validOrigin: RelationshipOriginPayload = {
  key: { owner: OWNER, target: TARGET },
  targetKind: 'user',
  trust: 0.85,
  closeness: 0.6,
  originKind: 'SETTING_BASELINE',
  basis: '用户 2026-09 授权的角色设定（ADR-064 U-M7-02）',
}

const validImpact: RelationshipImpactPayload = {
  key: { owner: OWNER, target: TARGET },
  targetKind: 'user',
  delta: { trust: 0.03, closeness: 0.02 },
  ruleId: 'contract-test-rule',
  unit: 'window',
  originKind: 'INTERACTION_DERIVED',
}

function establishedUserReading(): TrustedOriginReading {
  return {
    attributionOrigin: 'RECORDED',
    contentOriginator: attributionKnown<PrincipalRef>({ kind: 'USER', id: 'user-1' }),
    axisBConfirmed: true,
  }
}

function candidate(
  id: string,
  type: string,
  trustedOrigin?: TrustedOriginReading,
): RelationshipEvidenceCandidateView {
  return { id: id as ConversationEventId, type, trustedOrigin }
}

function runtimeChecks(): void {
  // ---- 正控（P）：合法输入全部安静通过 ----

  const origin = validateRelationshipOriginPayload(validOrigin)
  record(
    'P1',
    'ORIGIN 正控：合法建档 payload 通过结构校验，字段逐项保留',
    'trust=0.85 · closeness=0.6 · SETTING_BASELINE · basis 非空',
    `trust=${String(origin.trust)} · closeness=${String(origin.closeness)} · ${String(origin.originKind)}`,
    origin.trust === 0.85 && origin.closeness === 0.6 && origin.originKind === 'SETTING_BASELINE',
  )

  const impact = validateRelationshipImpactPayload({
    ...validImpact,
    supersedes: { domainEventId: 'de-001' as DomainEventId, reason: 'contract-test correction' },
    note: 'contract-test',
  })
  record(
    'P2',
    'IMPACT 正控：合法影响 payload（含 supersedes 纠正链）通过结构校验',
    'delta={0.03,0.02} · ruleId 非空 · INTERACTION_DERIVED · supersedes 保留',
    `delta={${String(impact.delta.trust)},${String(impact.delta.closeness)}} · supersedes.domainEventId=${String(impact.supersedes?.domainEventId)}`,
    impact.delta.trust === 0.03 &&
      impact.delta.closeness === 0.02 &&
      impact.originKind === 'INTERACTION_DERIVED' &&
      impact.supersedes !== undefined,
  )

  const registry = createRelationshipDomainEventRegistry()
  const bothRegistered =
    registry.has(RELATIONSHIP_ORIGIN) &&
    registry.has(RELATIONSHIP_IMPACT) &&
    registry.get(RELATIONSHIP_ORIGIN)!.validatePayload(validOrigin) !== undefined &&
    registry.get(RELATIONSHIP_IMPACT)!.validatePayload(validImpact) !== undefined
  record(
    'P3',
    '事件登记表正控：RELATIONSHIP_ORIGIN / RELATIONSHIP_IMPACT 都已登记且接受合法 payload',
    '两类都在，validatePayload 通过',
    bothRegistered ? '两类都在，合法 payload 通过' : '登记或校验缺失',
    bothRegistered,
  )

  const single = relationshipEvidenceVerdictOf([candidate('cev-1', 'user_message', establishedUserReading())])
  record(
    'P4',
    '证据等级正控：单条 ESTABLISHED 的 user_message 判为合格（Tier 1）',
    'ok=true · qualifiedEventIds=[cev-1]',
    `ok=${String(single.ok)}${single.ok ? ` · ${single.qualifiedEventIds.length} 条` : ` · ${single.code}`}`,
    single.ok && single.qualifiedEventIds.length === 1,
  )

  const double = relationshipEvidenceVerdictOf([
    candidate('cev-1', 'user_message', establishedUserReading()),
    candidate('cev-2', 'user_message', establishedUserReading()),
  ])
  record(
    'P5',
    '证据等级正控：多条合格用户事件全部保留（证据绑定不丢条）',
    'ok=true · 2 条',
    double.ok ? `ok=true · ${double.qualifiedEventIds.length} 条` : `ok=false · ${double.code}`,
    double.ok && double.qualifiedEventIds.length === 2,
  )

  const userRef = entityRef('user', 'user-1')
  const projectionType = relationshipProjectionType(userRef)
  const parsed = parseRelationshipProjectionType(projectionType)
  record(
    'P6',
    '投影作用域正控：relationshipProjectionType 产出 relationship:user:<id> 且可解析回同一 EntityRef',
    'relationship:user:user-1 · round-trip 相等',
    `${projectionType} · parsed=${parsed ? `${parsed.kind}:${String(parsed.id)}` : 'undefined'}`,
    projectionType === 'relationship:user:user-1' &&
      parsed !== undefined &&
      parsed.kind === 'user' &&
      String(parsed.id) === 'user-1',
  )

  const exactBounds = relationshipDeltaWithinBounds({ trust: 0.05, closeness: -0.03 })
  const epsilonBounds = relationshipDeltaWithinBounds({ trust: 0.02 + 0.03, closeness: 0 })
  record(
    'P7',
    `界正控：|Δtrust|≤${String(MAX_TRUST_DELTA_PER_EVENT)} · |Δcloseness|≤${String(MAX_CLOSENESS_DELTA_PER_EVENT)} 通过（含浮点容差）`,
    '边界值与浮点求和都通过',
    `exact=${String(exactBounds)} · epsilon(0.02+0.03)=${String(epsilonBounds)}`,
    exactBounds && epsilonBounds,
  )

  const t0 = 1_000_000_000_000
  const atThreshold = erodeClosenessForAbsence(0.8, t0, t0 + 24 * HOUR)
  const afterTwoDays = erodeClosenessForAbsence(0.8, t0, t0 + 48 * HOUR)
  record(
    'P8',
    '衰减正控：24h 阈值内不侵蚀；48h 侵蚀 0.02（0.8 → 0.78）',
    'atThreshold=0.8 · afterTwoDays≈0.78',
    `atThreshold=${String(atThreshold)} · afterTwoDays=${String(afterTwoDays)}`,
    atThreshold === 0.8 && Math.abs(afterTwoDays - 0.78) < 1e-9,
  )

  const originated: RelationshipState = {
    originated: true,
    trust: 0.85,
    closeness: 0.8,
    originKind: 'SETTING_BASELINE',
    lastInteractionAt: t0,
    accusationsInCase: [],
  }
  const effective = effectiveRelationship(originated, t0 + 72 * HOUR)
  record(
    'P9',
    '读时视图正控：72h 疏远（计费 48h）→ closeness 0.8→0.76，trust 不变，本体状态不被修改（纯函数）',
    'closeness≈0.76 · trust=0.85 · 原对象不变',
    `closeness=${String(effective.closeness)} · trust=${String(effective.trust)} · 原closeness=${String(originated.closeness)}`,
    Math.abs(effective.closeness - 0.76) < 1e-9 &&
      effective.trust === 0.85 &&
      originated.closeness === 0.8,
  )

  const passthrough = effectiveRelationship(UNORIGINATED_RELATIONSHIP_STATE, t0 + 72 * HOUR)
  record(
    'P10',
    '读时视图正控：未建档状态原样返回（没有关系可侵蚀）',
    'originated=false 原样',
    `originated=${String(passthrough.originated)} · 与常量同形=${String(passthrough.originated === false)}`,
    passthrough.originated === false && passthrough.lastInteractionAt === null,
  )

  /*
   * ⚠️ **判据修正（2026-10-03，S8/WP4）**：本项原来断言"originKind **三值**全登记、
   * 放行口拒绝 MAINTENANCE_INJECTION"。ADR-093 `D09` 追加了第四个登记值
   * `STORY_DERIVED`（由**已提交的世界账本**经封闭故事规则形成，且只对
   * `interaction_kind = user_choice` 且绑定到当前真实用户的提交成立）。
   *
   * ⚠️ **判据修正（2026-10-14，U1/WP3 `ADR-136` 方案 A）**：追加第五个登记值
   * `NEW_USER_BASELINE`（**系统**在新用户首次幂等建档时给的起点 0.2/0.2 ——
   * 既不是"用户授权的设定基线"，也不是"由互动推导"）。
   * ⇒ 判据改为**五值具名闭集 + 放行口接受四值**，`MAINTENANCE_INJECTION` **仍然失败关闭**。
   * ⚠️ 这里**不**用 `length >= 4` 这类放宽写法：闭集长大后必须**显式**写进这条断言。
   */
  const expectedOriginKinds: readonly string[] = [
    'SETTING_BASELINE',
    'INTERACTION_DERIVED',
    'MAINTENANCE_INJECTION',
    'STORY_DERIVED',
    'NEW_USER_BASELINE',
  ]
  const originKindsExact =
    RELATIONSHIP_ORIGIN_KINDS.length === expectedOriginKinds.length &&
    expectedOriginKinds.every((kind) => (RELATIONSHIP_ORIGIN_KINDS as readonly string[]).includes(kind))
  const injectionRejected =
    !originKindAcceptedByM7('MAINTENANCE_INJECTION') &&
    originKindAcceptedByM7('SETTING_BASELINE') &&
    originKindAcceptedByM7('INTERACTION_DERIVED') &&
    originKindAcceptedByM7('STORY_DERIVED') &&
    originKindAcceptedByM7('NEW_USER_BASELINE')
  record(
    'P11',
    'originKind 五值具名闭集；MAINTENANCE_INJECTION 登记但 M7 放行口拒绝，STORY_DERIVED / NEW_USER_BASELINE 可放行（U-M7-07 失败关闭 + ADR-093 D09 + ADR-136 A）',
    '5 值（具名）· injection=false',
    `${String(RELATIONSHIP_ORIGIN_KINDS.length)} 值 · injectionAccepted=${String(originKindAcceptedByM7('MAINTENANCE_INJECTION'))} · newUserAccepted=${String(originKindAcceptedByM7('NEW_USER_BASELINE'))}`,
    originKindsExact && injectionRejected,
  )

  const codesUnique = new Set(RELATIONSHIP_REJECTION_CODES.map((s) => s.code)).size === RELATIONSHIP_REJECTION_CODES.length
  const codesKnown = RELATIONSHIP_REJECTION_CODES.every((s) => isRelationshipRejectionCode(s.code))
  record(
    'P12',
    '拒绝码登记表：全具名、无重复、可查询',
    `${String(RELATIONSHIP_REJECTION_CODES.length)} 码全登记`,
    `${String(RELATIONSHIP_REJECTION_CODES.length)} 码 · unique=${String(codesUnique)} · queryable=${String(codesKnown)}`,
    codesUnique && codesKnown,
  )

  // ---- 负控（N）：非法输入必须响 ----

  const negatives: Array<[string, string, () => unknown]> = [
    ['N1', 'ORIGIN 缺 basis（基线无来源）被拒', () => validateRelationshipOriginPayload({ ...validOrigin, basis: '' })],
    ['N2', 'ORIGIN 基线越界（trust=1.5）被拒', () => validateRelationshipOriginPayload({ ...validOrigin, trust: 1.5 })],
    ['N3', 'ORIGIN targetKind 未登记被拒', () => validateRelationshipOriginPayload({ ...validOrigin, targetKind: 'alien' })],
    ['N4', 'ORIGIN originKind 未登记被拒', () => validateRelationshipOriginPayload({ ...validOrigin, originKind: 'HACKED' })],
    ['N5', 'ORIGIN key 缺 target 被拒', () => validateRelationshipOriginPayload({ ...validOrigin, key: { owner: OWNER } as unknown as EntityId })],
    ['N6', 'IMPACT delta 非有限数（NaN）被拒', () => validateRelationshipImpactPayload({ ...validImpact, delta: { trust: Number.NaN, closeness: 0 } })],
    ['N7', 'IMPACT ruleId 为空被拒', () => validateRelationshipImpactPayload({ ...validImpact, ruleId: ' ' })],
    ['N8', 'IMPACT supersedes 缺 reason 被拒', () => validateRelationshipImpactPayload({ ...validImpact, supersedes: { domainEventId: 'de-001' as DomainEventId } as unknown as RelationshipImpactPayload['supersedes'] })],
  ]
  for (const [id, label, fn] of negatives) {
    const outcome = expectThrow(label, fn)
    record(id, label, '必须抛错', outcome.threw ? `已拒：${outcome.message.slice(0, 60)}` : '未抛错（缺陷！）', outcome.threw)
  }

  const emptyEvidence = relationshipEvidenceVerdictOf([])
  record(
    'N9',
    '证据负控：空候选 → relationship_evidence_missing（无证据不变化）',
    'ok=false · code=relationship_evidence_missing',
    `ok=${String(emptyEvidence.ok)}${emptyEvidence.ok ? '' : ` · ${emptyEvidence.code}`}`,
    !emptyEvidence.ok && emptyEvidence.code === 'relationship_evidence_missing',
  )

  const assistantOnly = relationshipEvidenceVerdictOf([candidate('cev-a', 'assistant_message', establishedUserReading())])
  record(
    'N10',
    '证据负控：她的生成（assistant_message）即使带受信读数也判 Tier 0',
    'ok=false · not_qualified',
    `ok=${String(assistantOnly.ok)}${assistantOnly.ok ? '' : ` · ${assistantOnly.code}`}`,
    !assistantOnly.ok && assistantOnly.code === 'relationship_evidence_not_qualified',
  )

  const noReading = relationshipEvidenceVerdictOf([candidate('cev-b', 'user_message')])
  record(
    'N11',
    '证据负控：无受信读数（来源未确立）→ UNCONFIRMED_ORIGIN，判 Tier 0',
    'ok=false · not_qualified',
    `ok=${String(noReading.ok)}${noReading.ok ? '' : ` · ${noReading.code}`}`,
    !noReading.ok,
  )

  const unconfirmedReading = relationshipEvidenceVerdictOf([
    candidate('cev-c', 'user_message', { ...establishedUserReading(), axisBConfirmed: false }),
  ])
  record(
    'N12',
    '证据负控：Axis B 未确认（axisBConfirmed=false）→ 判 Tier 0（失败关闭）',
    'ok=false · not_qualified',
    `ok=${String(unconfirmedReading.ok)}${unconfirmedReading.ok ? '' : ` · ${unconfirmedReading.code}`}`,
    !unconfirmedReading.ok,
  )

  const mixed = relationshipEvidenceVerdictOf([
    candidate('cev-1', 'user_message', establishedUserReading()),
    candidate('cev-a', 'assistant_message'),
  ])
  record(
    'N13',
    '证据负控：合格用户消息 + 她的回复混引 → 整体不合格（因果集不容 Tier 0 污染）',
    'ok=false · not_qualified',
    `ok=${String(mixed.ok)}${mixed.ok ? '' : ` · ${mixed.code}`}`,
    !mixed.ok && mixed.code === 'relationship_evidence_not_qualified',
  )

  const badParses = [
    parseRelationshipProjectionType('character:self'),
    parseRelationshipProjectionType('relationship:alien:x'),
    parseRelationshipProjectionType('relationship:user:'),
    parseRelationshipProjectionType('relationship:user'),
  ]
  record(
    'N14',
    '解析负控：非关系类型 / 未登记 kind / 空 id / 段数不对 → 全部 undefined（不猜）',
    '4 项全 undefined',
    badParses.map((p) => (p === undefined ? '∅' : '有值')).join(' · '),
    badParses.every((p) => p === undefined),
  )

  const outOfBounds =
    !relationshipDeltaWithinBounds({ trust: 0.06, closeness: 0 }) &&
    !relationshipDeltaWithinBounds({ trust: 0, closeness: -0.04 }) &&
    !relationshipDeltaWithinBounds({ trust: Number.NaN, closeness: 0 })
  record(
    'N15',
    '界负控：|Δtrust|=0.06 / |Δcloseness|=0.04 / NaN → 全部拒绝（不静默夹）',
    '3 项全 false',
    `outOfBounds=${String(outOfBounds)}`,
    outOfBounds,
  )

  const clampThrow = expectThrow('clamp NaN', () => clampRelationshipValue(Number.NaN))
  record(
    'N16',
    '夹取负控：非有限数直接抛（relationship_value_not_finite），不猜不夹',
    '必须抛错',
    clampThrow.threw ? `已拒：${clampThrow.message.slice(0, 60)}` : '未抛错（缺陷！）',
    clampThrow.threw,
  )

  const duplicateRegistry = new DomainEventRegistry()
  duplicateRegistry.register({
    type: RELATIONSHIP_ORIGIN,
    description: 'dup-test',
    maxPayloadBytes: 1024,
    validatePayload: (p) => p,
  })
  const duplicateThrow = expectThrow('duplicate register', () =>
    duplicateRegistry.register({
      type: RELATIONSHIP_ORIGIN,
      description: 'dup-test-2',
      maxPayloadBytes: 1024,
      validatePayload: (p) => p,
    }),
  )
  record(
    'N17',
    '登记表负控：同一事件类型重复登记 → 启动即抛（不允许两处语义）',
    '必须抛错',
    duplicateThrow.threw ? `已拒：${duplicateThrow.message.slice(0, 60)}` : '未抛错（缺陷！）',
    duplicateThrow.threw,
  )

  // ---- 恢复（R）：检测器响过之后重新安静 ----

  const recoverOrigin = validateRelationshipOriginPayload(validOrigin)
  const recoverImpact = validateRelationshipImpactPayload(validImpact)
  record(
    'R1',
    '恢复：负控 N1–N8 之后，合法 ORIGIN / IMPACT payload 重新通过',
    '两类都通过',
    `origin.trust=${String(recoverOrigin.trust)} · impact.ruleId=${recoverImpact.ruleId}`,
    recoverOrigin.trust === 0.85 && recoverImpact.ruleId === 'contract-test-rule',
  )

  const recoverEvidence = relationshipEvidenceVerdictOf([candidate('cev-r', 'user_message', establishedUserReading())])
  record(
    'R2',
    '恢复：负控 N9–N13 之后，ESTABLISHED 用户证据重新判合格',
    'ok=true',
    `ok=${String(recoverEvidence.ok)}`,
    recoverEvidence.ok,
  )

  const recoverClamp = clampRelationshipValue(1.7)
  record(
    'R3',
    '恢复：负控 N16 之后，clampRelationshipValue(1.7) 正常夹到 1',
    '1',
    String(recoverClamp),
    recoverClamp === 1,
  )

  const recoverRegistry = createRelationshipDomainEventRegistry()
  record(
    'R4',
    '恢复：负控 N17 之后，全新登记表正常建立（两类都在）',
    '两类都在',
    `origin=${String(recoverRegistry.has(RELATIONSHIP_ORIGIN))} · impact=${String(recoverRegistry.has(RELATIONSHIP_IMPACT))}`,
    recoverRegistry.has(RELATIONSHIP_ORIGIN) && recoverRegistry.has(RELATIONSHIP_IMPACT),
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  staticChecks()
  runtimeChecks()

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const positive = checks.filter((c) => c.id.startsWith('P') || c.id.startsWith('S')).length
  const negative = checks.filter((c) => c.id.startsWith('N')).length
  const recovery = checks.filter((c) => c.id.startsWith('R')).length

  // §6.8 自检：分母必须 > 0，且三段各自非空（否则 MEASUREMENT INVALID，不是 PASS）
  const stagesValid = positive > 0 && negative > 0 && recovery > 0
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM7RunId({ wpId: 'wp2-contracts', headShort: head })
  const dir = openM7RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm7-wp2-contracts@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    branch: 'feature/m7-relationship',
    propositions: {
      s1: '关系合同使用 entity.ts 冻结的 EntityRelationKey（无另造键）',
      s2: 'src/** 无 userTrust / user_trust 写死形状',
      s3: 'relationship.ts 只依赖 contracts（依赖方向单向）',
      s4: 'WP2 只登记不接线（full registry 不含关系类型）',
      runtime: 'payload 校验 / 证据等级 / 衰减 / 界 / 拒绝码 / 登记表：正控·负控·恢复三段式',
    },
    stages: { positive, negative, recovery },
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
  }
  writeFileSync(join(dir, 'contracts.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM7Manifest(dir, {
    runId,
    wp: 'wp2-contracts',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'contracts',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes: 'M7 WP2 合同门：EntityRelationKey 静态检查 + 无 userTrust 写死 + 三段式行为验证',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(`stages: 正控+静态=${positive} · 负控=${negative} · 恢复=${recovery}`)
  console.log(`verdict: ${verdict}（${passed}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main()
