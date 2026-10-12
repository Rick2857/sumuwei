/**
 * M8 WP2 —— **合同门**（`pnpm m8:wp2:contracts`）。
 *
 * ============================================================================
 *  要测的命题（计划 §10 WP2 的出口条件）
 * ============================================================================
 * ① 静态：affect.ts 只依赖 contracts（依赖方向单向）；src/** 不存在
 *    `affect:<conversation|user|message>` 第二权威形状（M8-D01）；
 *    AFFECT_* 已登记独立工厂、WP2 只登记不接线（full registry 不含——
 *    判据在 WP4 证据里翻转，与 M7 同构）。
 * ② 合同行为：payload 结构校验 / 证据资格（active user + cutover）/
 *    衰减纯函数 / 界与夹取 / 拒绝码登记表 / 事件类型登记——
 *    全部走**正控 / 负控 / 恢复**三段式（AGENTS §6.7）。
 * ③ Reducer 纯折叠：ORIGIN/TOUCH/IMPACT 三类事件的折叠语义 +
 *    重放确定性（同一事件流两次折叠 ⇒ 逐字段一致）。
 * ④ 规则匹配器（affect-rules@1 词形判据）：句内匹配 / 问句抑制 /
 *    守卫词 / 敌意毒化 / 主导裁定全序。
 *
 * ============================================================================
 *  量具纪律
 * ============================================================================
 * · §6.7 三段式：只有正控的量具与"什么都不检查"无法区分；只有负控的量具
 *   与"拒绝一切"无法区分。恢复段证明检测器响过之后还能重新安静。
 * · §6.8：`measured_count > 0` 自检——三个阶段各自非空，否则 MEASUREMENT INVALID。
 * · 本门**不打开任何数据库**（纯合同检查）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import {
  DomainEventRegistry,
  MAX_AFFECT_DELTA_PER_EVENT,
  AFFECT_DOMAIN_EVENT_TYPES,
  AFFECT_ORIGIN_KINDS,
  AFFECT_REJECTION_CODES,
  AFFECT_RULES_VERSION,
  AFFECT_IMPACT_RULE_IDS,
  UNORIGINATED_AFFECT_STATE,
  affectDeltaWithinBounds,
  affectEvidenceVerdictOf,
  affectImpactIdempotencyOperation,
  affectTouchIdempotencyOperation,
  attributionKnown,
  clampAffectArousal,
  clampAffectValence,
  createAffectDomainEventRegistry,
  createFullDomainEventRegistry,
  decayAffectTowardNeutral,
  effectiveAffect,
  isAffectImpactRuleId,
  isAffectOriginKind,
  isAffectRejectionCode,
  originKindAcceptedByM8,
  renderAffectGuidance,
  validateAffectImpactPayload,
  validateAffectOriginPayload,
  validateAffectTouchPayload,
  type AffectEvidenceCandidateView,
  type AffectImpactPayload,
  type AffectOriginPayload,
  type AffectState,
  type AffectTouchPayload,
  type PrincipalRef,
} from '../src/kernel/contracts/index.ts'
import type { TrustedOriginReading } from '../src/kernel/contracts/attribution.ts'
import {
  AFFECT_IMPACT,
  AFFECT_ORIGIN,
  AFFECT_TOUCH,
} from '../src/kernel/contracts/domain-event.ts'
import type { CharacterId, ConversationEventId, DomainEventId, Timestamp } from '../src/kernel/contracts/ids.ts'
import type { DomainEvent } from '../src/kernel/contracts/domain-event.ts'
import {
  AFFECT_PATTERNS,
  AFFECT_RULE_DELTAS,
  AFFECT_RULE_PRIORITY,
  dominantAffectRuleFamily,
  matchAffectPatterns,
  matchedAffectRuleFamilies,
} from '../src/kernel/app/affect/patterns.ts'
import {
  AFFECT_REDUCER_VERSION,
  affectEventTargets,
  reduceAffectState,
} from '../src/kernel/projections/affect.ts'
import { createM8RunId, openM8RunDir, writeM8Manifest } from './m8-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const HOUR = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// 量具：检查条目（与 m8-wp0-admission 同一形状）
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
// 静态源码检查
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
 * （与 m7-wp2-contracts 同一状态机——量具自己的职责，不引第三方依赖。）
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
  // S1：affect.ts 只依赖 contracts（依赖方向单向）
  const affectSource = readFileSync(join(REPO_ROOT, 'src/kernel/contracts/affect.ts'), 'utf8')
  const importLines = [...affectSource.matchAll(/^import[^']*from\s+'([^']+)'/gm)].map((m) => m[1])
  const nonContract = importLines.filter((spec) => !spec.startsWith('./'))
  record(
    'S1',
    'affect.ts 的 import 全部来自 ./contracts（不 import 框架 / SQL / node:*）',
    `全部 ${String(importLines.length)} 条 import 以 './' 开头`,
    nonContract.length === 0
      ? `全部 ${String(importLines.length)} 条均为 contracts 内部依赖`
      : `越界依赖：${nonContract.join(', ')}`,
    nonContract.length === 0 && importLines.length > 0,
  )

  // S2：src/** 无 affect:<conversation|user|message> 第二权威形状（M8-D01）
  //    量具注释感知：affect.ts / ADR 引用里的禁令原文（"affect:<conversationId>"）
  //    是文档，不是违规。字符串字面量保留在扫描内。
  const hits: string[] = []
  for (const abs of srcFilesUnder(join(REPO_ROOT, 'src'))) {
    const code = stripComments(readFileSync(abs, 'utf8'))
    if (/affect:(conversation|user|message|conv)[^a-z]/.test(code)) {
      hits.push(relative(REPO_ROOT, abs))
    }
  }
  record(
    'S2',
    'src/** 代码中不存在 affect:conversation/user/message 第二权威形状（M8-D01；注释禁令原文不算）',
    '0 处命中',
    hits.length === 0 ? '0 处命中' : `命中：${hits.join(', ')}`,
    hits.length === 0,
  )

  // S3：WP4 起接线（full registry 含全部 AFFECT 类型；判据已按 WP4 交接翻转）
  const fullTypes = createFullDomainEventRegistry().types()
  const leaked = fullTypes.filter((t) => (AFFECT_DOMAIN_EVENT_TYPES as readonly string[]).includes(t))
  record(
    'S3',
    'createFullDomainEventRegistry() 含全部 AFFECT 类型（WP4 接线完成；WP2 时期的"不含"判据已按交接翻转）',
    `交集 = 全部 ${String(AFFECT_DOMAIN_EVENT_TYPES.length)} 类`,
    leaked.length === AFFECT_DOMAIN_EVENT_TYPES.length
      ? `已接线（full 共 ${String(fullTypes.length)} 类，AFFECT ${String(leaked.length)} 类在内）`
      : `缺类：${AFFECT_DOMAIN_EVENT_TYPES.filter((t) => !leaked.includes(t)).join(', ')}`,
    leaked.length === AFFECT_DOMAIN_EVENT_TYPES.length,
  )

  // S4：projections/affect.ts 只依赖 contracts（reducer 纯度静态面）
  const reducerSource = readFileSync(join(REPO_ROOT, 'src/kernel/projections/affect.ts'), 'utf8')
  const reducerImports = [...reducerSource.matchAll(/^import[^']*from\s+'([^']+)'/gm)].map((m) => m[1])
  const reducerNonContract = reducerImports.filter((spec) => !spec.startsWith('../contracts'))
  record(
    'S4',
    'projections/affect.ts 的 import 全部来自 ../contracts（reducer 不碰基础设施）',
    `全部 ${String(reducerImports.length)} 条以 '../contracts' 开头`,
    reducerNonContract.length === 0
      ? `全部 ${String(reducerImports.length)} 条均为 contracts`
      : `越界依赖：${reducerNonContract.join(', ')}`,
    reducerNonContract.length === 0 && reducerImports.length > 0,
  )
}

// ---------------------------------------------------------------------------
// 运行时三段式
// ---------------------------------------------------------------------------

const OWNER = 'char_sumuwei' as CharacterId
const ACTIVE_USER = 'user-1'
const T0 = 1_700_000_000_000

const validOrigin: AffectOriginPayload = {
  characterId: OWNER,
  initialValence: 0,
  initialArousal: 0,
  originKind: 'ACTIVATION_BASELINE',
  activationId: 'activation-test-001',
  cutoverAt: T0,
  cutoverSequence: 42,
  policyVersion: 'affect-policy@1',
}

const validTouch: AffectTouchPayload = {
  characterId: OWNER,
  sourceEventId: 'cev-100' as ConversationEventId,
  sourceSequence: 101,
  originKind: 'INTERACTION_DERIVED',
  evaluatorVersion: 'affect-evaluator@1',
  proposalId: 'prop-t1',
  traceId: 'trace-t1',
}

const validImpact: AffectImpactPayload = {
  characterId: OWNER,
  sourceEventId: 'cev-100' as ConversationEventId,
  sourceSequence: 101,
  ruleId: 'A-GRATITUDE',
  ruleVersion: AFFECT_RULES_VERSION,
  delta: { deltaValence: 0.08, deltaArousal: -0.03 },
  originKind: 'INTERACTION_DERIVED',
  evaluatorVersion: 'affect-evaluator@1',
  proposalId: 'prop-i1',
  matchedPatternId: 'ag-thanks',
  traceId: 'trace-i1',
}

function establishedUserReading(userId: string = ACTIVE_USER): TrustedOriginReading {
  return {
    attributionOrigin: 'RECORDED',
    contentOriginator: attributionKnown<PrincipalRef>({ kind: 'USER', id: userId }),
    axisBConfirmed: true,
  }
}

function candidate(
  id: string,
  sequence: number,
  type: string,
  trustedOrigin?: TrustedOriginReading,
): AffectEvidenceCandidateView {
  return { id: id as ConversationEventId, sequence, type, actorId: ACTIVE_USER, trustedOrigin }
}

function fakeEvent(
  id: string,
  type: string,
  payload: unknown,
  sequence: number,
  createdAt: Timestamp,
): DomainEvent {
  return {
    id: id as DomainEventId,
    characterId: OWNER,
    sequence,
    type,
    sourceConversationEventIds: ['cev-100' as ConversationEventId],
    payload,
    processor: 'affect-evaluator',
    processorVersion: 'affect-evaluator@1',
    idempotencyKey: `test-${id}`,
    schemaVersion: 1,
    createdAt,
  }
}

function runtimeChecks(): void {
  // ---- 正控（P）：合法输入全部安静通过 ----

  const origin = validateAffectOriginPayload(validOrigin)
  record(
    'P1',
    'ORIGIN 正控：合法建档 payload 通过结构校验，字段逐项保留（含 cutoverSequence）',
    'initial=0/0 · ACTIVATION_BASELINE · cutoverSequence=42',
    `initial=${String(origin.initialValence)}/${String(origin.initialArousal)} · ${String(origin.originKind)} · cutover=${String(origin.cutoverSequence)}`,
    origin.initialValence === 0 &&
      origin.initialArousal === 0 &&
      origin.originKind === 'ACTIVATION_BASELINE' &&
      origin.cutoverSequence === 42,
  )

  const touch = validateAffectTouchPayload(validTouch)
  record(
    'P2',
    'TOUCH 正控：合法触摸 payload 通过结构校验（sourceEventId + sourceSequence 保留）',
    'sourceEventId=cev-100 · sourceSequence=101 · INTERACTION_DERIVED',
    `source=${String(touch.sourceEventId)} · seq=${String(touch.sourceSequence)} · ${String(touch.originKind)}`,
    String(touch.sourceEventId) === 'cev-100' && touch.sourceSequence === 101 && touch.originKind === 'INTERACTION_DERIVED',
  )

  const impact = validateAffectImpactPayload(validImpact)
  record(
    'P3',
    'IMPACT 正控：合法影响 payload 通过结构校验（ruleId/ruleVersion/delta/matchedPatternId 保留）',
    'A-GRATITUDE · affect-rules@1 · Δv=0.08 · Δa=-0.03',
    `${String(impact.ruleId)} · ${String(impact.ruleVersion)} · Δv=${String(impact.delta.deltaValence)} · pattern=${String(impact.matchedPatternId)}`,
    impact.ruleId === 'A-GRATITUDE' &&
      impact.ruleVersion === AFFECT_RULES_VERSION &&
      impact.delta.deltaValence === 0.08 &&
      impact.matchedPatternId === 'ag-thanks',
  )

  const registry = createAffectDomainEventRegistry()
  const allRegistered =
    registry.has(AFFECT_ORIGIN) &&
    registry.has(AFFECT_TOUCH) &&
    registry.has(AFFECT_IMPACT) &&
    registry.get(AFFECT_ORIGIN)!.validatePayload(validOrigin) !== undefined &&
    registry.get(AFFECT_TOUCH)!.validatePayload(validTouch) !== undefined &&
    registry.get(AFFECT_IMPACT)!.validatePayload(validImpact) !== undefined
  record(
    'P4',
    '事件登记表正控：AFFECT_ORIGIN / TOUCH / IMPACT 都已登记且接受合法 payload',
    '三类都在，validatePayload 通过',
    allRegistered ? '三类都在，合法 payload 通过' : '登记或校验缺失',
    allRegistered,
  )

  const single = affectEvidenceVerdictOf([candidate('cev-1', 43, 'user_message', establishedUserReading())], {
    activeUserId: ACTIVE_USER,
    cutoverSequence: 42,
  })
  record(
    'P5',
    '证据资格正控：active user 的 ESTABLISHED user_message（序号 > cutover）判合格',
    'ok=true · 1 条',
    `ok=${String(single.ok)}${single.ok ? ` · ${String(single.qualifiedEventIds.length)} 条` : ` · ${single.code}`}`,
    single.ok && single.qualifiedEventIds.length === 1,
  )

  const exactBounds = affectDeltaWithinBounds({ deltaValence: 0.25, deltaArousal: -0.25 })
  const epsilonBounds = affectDeltaWithinBounds({ deltaValence: 0.12 + 0.13, deltaArousal: 0 })
  record(
    'P6',
    `界正控：|Δ|≤${String(MAX_AFFECT_DELTA_PER_EVENT)} 通过（含浮点容差 0.12+0.13）`,
    '边界值与浮点求和都通过',
    `exact=${String(exactBounds)} · epsilon=${String(epsilonBounds)}`,
    exactBounds && epsilonBounds,
  )

  const valenceHalved = decayAffectTowardNeutral(0.8, 0, 4, 4)
  const arousalHalved = decayAffectTowardNeutral(0.6, 0, 5, 5)
  const noDecayBackwards = decayAffectTowardNeutral(0.8, 0, 4, -1)
  record(
    'P7',
    '衰减正控：valence 0.8 经 4h（半衰期）→ 0.4；arousal 0.6 经 5h → 0.3；负时长不衰减',
    '0.4 · 0.3 · 0.8',
    `${String(valenceHalved)} · ${String(arousalHalved)} · ${String(noDecayBackwards)}`,
    Math.abs(valenceHalved - 0.4) < 1e-9 &&
      Math.abs(arousalHalved - 0.3) < 1e-9 &&
      noDecayBackwards === 0.8,
  )

  const originated: AffectState = {
    originated: true,
    valence: 0.8,
    arousal: 0.6,
    originKind: 'ACTIVATION_BASELINE',
    lastInteractionAt: T0,
    lastAffectEventAt: T0,
    lastDomainEventId: 'de-001' as DomainEventId,
    cutoverSequence: 42,
  }
  const effective = effectiveAffect(originated, T0 + 8 * HOUR)
  record(
    'P8',
    '读时视图正控：8h 后 valence 0.8→0.2（两次半衰）、arousal 0.6→~0.19；decayApplied=true；本体不被修改（纯函数）',
    'v≈0.2 · decayApplied=true · 原对象 v=0.8 不变',
    `v=${String(effective?.valence)} · decay=${String(effective?.decayApplied)} · 原v=${String(originated.valence)}`,
    effective !== undefined &&
      Math.abs(effective.valence - 0.2) < 1e-9 &&
      effective.decayApplied &&
      originated.valence === 0.8,
  )

  const quiet = effectiveAffect(UNORIGINATED_AFFECT_STATE, T0 + 8 * HOUR)
  record(
    'P9',
    '读时视图正控：未建档 ⇒ undefined（安静机制：调用方产 0 个 section）',
    'undefined',
    String(quiet),
    quiet === undefined,
  )

  const eff = effectiveAffect(originated, T0)!
  const guidance = renderAffectGuidance({ effective: eff, appliedThisTurn: true })
  const guidanceFailed = renderAffectGuidance({ effective: eff, appliedThisTurn: false })
  const guidanceDeterministic =
    guidance === renderAffectGuidance({ effective: eff, appliedThisTurn: true })
  // 数值泄漏判据（ADR-066 §8.1）：valence/arousal 的**原始数值**不得出现在渲染输出里
  //（小时数"距上次互动 X 小时"是既有 legacy 块的分开时长语义，不算内部数值泄漏）
  const leaksValence = guidance.includes(String(eff.valence))
  const leaksArousal = guidance.includes(String(eff.arousal))
  const hasBoundaryOnFailure = guidanceFailed.includes('本轮情绪处理未完成')
  const noBoundaryOnSuccess = !guidance.includes('本轮情绪处理未完成')
  record(
    'P10',
    '渲染正控：确定性输出 · 不泄漏 valence/arousal 原始数值 · 失败时追加如实边界行、成功时不追加',
    '确定 · 无原始数值 · 失败有边界行 · 成功无边界行',
    `确定=${String(guidanceDeterministic)} · 泄漏v=${String(leaksValence)} · 泄漏a=${String(leaksArousal)} · 失败边界=${String(hasBoundaryOnFailure)} · 成功边界=${String(noBoundaryOnSuccess)}`,
    guidanceDeterministic && !leaksValence && !leaksArousal && hasBoundaryOnFailure && noBoundaryOnSuccess,
  )

  // ---- Reducer 纯折叠（P11–P14）----

  const originEvent = fakeEvent('de-o1', AFFECT_ORIGIN, validOrigin, 1, T0)
  const foldedOrigin = reduceAffectState(UNORIGINATED_AFFECT_STATE, originEvent, OWNER)
  record(
    'P11',
    'Reducer ORIGIN：未建档 → 建档（中性 0/0 + 双锚 = 事件时间 + cutoverSequence 记录在 state）',
    'originated=true · v=0/a=0 · cutover=42 · 锚=T0',
    `originated=${String(foldedOrigin.originated)} · v=${String(foldedOrigin.valence)}/a=${String(foldedOrigin.arousal)} · cutover=${String(foldedOrigin.cutoverSequence)}`,
    foldedOrigin.originated &&
      foldedOrigin.valence === 0 &&
      foldedOrigin.arousal === 0 &&
      foldedOrigin.cutoverSequence === 42 &&
      foldedOrigin.lastInteractionAt === T0 &&
      foldedOrigin.lastAffectEventAt === T0,
  )

  // TOUCH 在 6h 后到达：只推进交互锚，不动 valence/arousal 与情绪轴锚
  const touchEvent = fakeEvent('de-t1', AFFECT_TOUCH, validTouch, 2, T0 + 6 * HOUR)
  const afterImpactState: AffectState = {
    ...foldedOrigin,
    valence: 0.4,
    arousal: 0.5,
    lastAffectEventAt: T0 + 1 * HOUR,
  }
  const foldedTouch = reduceAffectState(afterImpactState, touchEvent, OWNER)
  record(
    'P12',
    'Reducer TOUCH：只推进交互锚（M8-D07）；valence/arousal 与情绪轴锚不动',
    'lastInteractionAt=T0+6h · v/a 不变 · lastAffectEventAt 不变',
    `交互锚=${String(foldedTouch.lastInteractionAt)} · v=${String(foldedTouch.valence)} · 轴锚=${String(foldedTouch.lastAffectEventAt)}`,
    foldedTouch.lastInteractionAt === T0 + 6 * HOUR &&
      foldedTouch.valence === 0.4 &&
      foldedTouch.arousal === 0.5 &&
      foldedTouch.lastAffectEventAt === T0 + 1 * HOUR,
  )

  // IMPACT 在 4h 后到达：先衰减（v 0.8→0.4）再加 delta（+0.08）再推进双锚
  const impactEvent = fakeEvent('de-i1', AFFECT_IMPACT, validImpact, 3, T0 + 4 * HOUR)
  const foldedImpact = reduceAffectState(originated, impactEvent, OWNER)
  record(
    'P13',
    'Reducer IMPACT：先衰减（0.8→0.4 @4h）再应用 delta（+0.08→0.48）再推进双锚（§5 规则 2）',
    'v≈0.48 · 双锚=T0+4h',
    `v=${String(foldedImpact.valence)} · a=${String(foldedImpact.arousal)} · 交互锚=${String(foldedImpact.lastInteractionAt)} · 轴锚=${String(foldedImpact.lastAffectEventAt)}`,
    Math.abs(foldedImpact.valence - 0.48) < 1e-9 &&
      foldedImpact.lastInteractionAt === T0 + 4 * HOUR &&
      foldedImpact.lastAffectEventAt === T0 + 4 * HOUR,
  )

  // 重放确定性：同一事件流两次折叠 ⇒ 逐字段一致（铁律 ② 的合同层形态）
  const stream = [originEvent, touchEvent, impactEvent]
  const replayA = stream.reduce((s, e) => reduceAffectState(s, e, OWNER), UNORIGINATED_AFFECT_STATE)
  const replayB = stream.reduce((s, e) => reduceAffectState(s, e, OWNER), UNORIGINATED_AFFECT_STATE)
  record(
    'P14',
    'Reducer 重放确定性：同一事件流两次折叠 ⇒ 逐字段一致（JSON 同形）',
    '两次折叠一致',
    `一致=${String(JSON.stringify(replayA) === JSON.stringify(replayB))}`,
    JSON.stringify(replayA) === JSON.stringify(replayB),
  )

  /*
   * ⚠️ **判据修正（2026-10-03，S8/WP4）**：本项原来断言"originKind **五值**全登记、
   * 放行口只接受 ACTIVATION_BASELINE / INTERACTION_DERIVED"。
   *
   * ADR-093 `D08` 追加了第六个登记值 `STORY_DERIVED`（由**已提交的世界账本**经封闭故事
   * 规则形成）—— 它与 `INTERACTION_DERIVED` **必须分开**：合成一个值就等于让
   * "模拟里一起通过了"与"用户陪她做成了某件事"在来源轴上不可区分。
   *
   * ⇒ 判据改为**六值** + 放行口接受**三值**，并且**三个注入类仍然失败关闭**
   * （MAINTENANCE_REPAIR / TEST_FIXTURE / HISTORICAL_IMPORT）—— 这条没放宽。
   */
  const kindsOk =
    AFFECT_ORIGIN_KINDS.length === 6 &&
    originKindAcceptedByM8('ACTIVATION_BASELINE') &&
    originKindAcceptedByM8('INTERACTION_DERIVED') &&
    originKindAcceptedByM8('STORY_DERIVED') &&
    !originKindAcceptedByM8('MAINTENANCE_REPAIR') &&
    !originKindAcceptedByM8('TEST_FIXTURE') &&
    !originKindAcceptedByM8('HISTORICAL_IMPORT')
  record(
    'P15',
    'originKind 六值全登记；M8 放行口只接受 ACTIVATION_BASELINE / INTERACTION_DERIVED / STORY_DERIVED（维护/测试/导入失败关闭）',
    '6 值 · 其余 3 值拒绝',
    `${String(AFFECT_ORIGIN_KINDS.length)} 值 · kindsOk=${String(kindsOk)}`,
    kindsOk,
  )

  const codesUnique = new Set(AFFECT_REJECTION_CODES.map((s) => s.code)).size === AFFECT_REJECTION_CODES.length
  const codesKnown = AFFECT_REJECTION_CODES.every((s) => isAffectRejectionCode(s.code))
  record(
    'P16',
    '拒绝码登记表：全具名、无重复、可查询（新码必须先改表）',
    `${String(AFFECT_REJECTION_CODES.length)} 码全登记`,
    `${String(AFFECT_REJECTION_CODES.length)} 码 · unique=${String(codesUnique)} · queryable=${String(codesKnown)}`,
    codesUnique && codesKnown,
  )

  // ---- 规则匹配器（P17–P19）----

  const familySamples: Array<[string, string]> = [
    ['A-GRATITUDE', '谢谢你，帮大忙了'],
    ['A-REPAIR', '对不起，刚才是我态度不好'],
    ['A-WARM-CONTACT', '想你了，最近好吗'],
    ['A-COMFORT', '别难过，会好的'],
    ['A-HOSTILE', '我讨厌你，烦死了'],
    ['A-REJECTION', '我们分手吧，不要联系了'],
    ['A-URGENT', '快点回复，这事很紧急'],
  ]
  const familyHits = familySamples.filter(([, text]) => matchedAffectRuleFamilies(text).size > 0)
  record(
    'P17',
    '匹配器正控：7 个规则族各有至少一条触发样例（measured_count=7）',
    '7/7 族命中',
    `${String(familyHits.length)}/7 族命中`,
    familyHits.length === 7,
  )

  const dominant = dominantAffectRuleFamily('谢谢你。但是这件事很紧急，快点处理')
  record(
    'P18',
    '主导裁定正控：感谢 + 紧急同现 ⇒ 按全序取 A-URGENT（M8-D09；不叠加）',
    'A-URGENT',
    String(dominant?.ruleId),
    dominant?.ruleId === 'A-URGENT',
  )

  const touchOp = affectTouchIdempotencyOperation('cev-100' as ConversationEventId)
  const impactOp = affectImpactIdempotencyOperation('A-GRATITUDE', 'cev-100' as ConversationEventId)
  const touchOpStable = touchOp === affectTouchIdempotencyOperation('cev-100' as ConversationEventId)
  record(
    'P19',
    '幂等单元正控：touch/impact 的 operation 分量确定且可从事件自身推导（§6.3 两层幂等的事件层）',
    `affect-touch:cev-100 · affect-impact:A-GRATITUDE:cev-100`,
    `${touchOp} · ${impactOp} · 稳定=${String(touchOpStable)}`,
    touchOp === 'affect-touch:cev-100' &&
      impactOp === 'affect-impact:A-GRATITUDE:cev-100' &&
      touchOpStable,
  )

  // ---- 负控（N）：非法输入必须响 ----

  const negatives: Array<[string, string, () => unknown]> = [
    ['N1', 'ORIGIN 非中性初值（0.1）被拒（M8-D06：非中性初始化走维护事件另立授权）', () => validateAffectOriginPayload({ ...validOrigin, initialValence: 0.1 })],
    ['N2', 'ORIGIN 缺 activationId 被拒', () => validateAffectOriginPayload({ ...validOrigin, activationId: '' })],
    ['N3', 'ORIGIN cutoverSequence 为负被拒', () => validateAffectOriginPayload({ ...validOrigin, cutoverSequence: -1 })],
    ['N4', 'TOUCH 缺 sourceEventId 被拒', () => validateAffectTouchPayload({ ...validTouch, sourceEventId: '' })],
    ['N5', 'TOUCH sourceSequence=0 被拒（账本序号 ≥1）', () => validateAffectTouchPayload({ ...validTouch, sourceSequence: 0 })],
    ['N6', 'IMPACT delta 含 NaN 被拒', () => validateAffectImpactPayload({ ...validImpact, delta: { deltaValence: Number.NaN, deltaArousal: 0 } })],
    ['N7', 'IMPACT ruleId 为空被拒', () => validateAffectImpactPayload({ ...validImpact, ruleId: ' ' })],
    ['N8', 'IMPACT originKind 未登记被拒', () => validateAffectImpactPayload({ ...validImpact, originKind: 'HACKED' })],
    ['N9', 'IMPACT payload 非对象被拒', () => validateAffectImpactPayload('not-an-object')],
  ]
  for (const [id, label, fn] of negatives) {
    const outcome = expectThrow(label, fn)
    record(id, label, '必须抛错', outcome.threw ? `已拒：${outcome.message.slice(0, 60)}` : '未抛错（缺陷！）', outcome.threw)
  }

  const emptyEvidence = affectEvidenceVerdictOf([], { activeUserId: ACTIVE_USER, cutoverSequence: 42 })
  record(
    'N10',
    '证据负控：空候选 → affect_source_missing（无证据不变化）',
    'ok=false · affect_source_missing',
    `ok=${String(emptyEvidence.ok)}${emptyEvidence.ok ? '' : ` · ${emptyEvidence.code}`}`,
    !emptyEvidence.ok && emptyEvidence.code === 'affect_source_missing',
  )

  const assistantOnly = affectEvidenceVerdictOf(
    [candidate('cev-a', 43, 'assistant_message', establishedUserReading())],
    { activeUserId: ACTIVE_USER, cutoverSequence: 42 },
  )
  record(
    'N11',
    '证据负控：她的生成（assistant_message）即使带受信读数也判不合格',
    'ok=false · affect_source_unqualified',
    `ok=${String(assistantOnly.ok)}${assistantOnly.ok ? '' : ` · ${assistantOnly.code}`}`,
    !assistantOnly.ok && assistantOnly.code === 'affect_source_unqualified',
  )

  const foreignUser = affectEvidenceVerdictOf(
    [candidate('cev-f', 43, 'user_message', establishedUserReading('user-other'))],
    { activeUserId: ACTIVE_USER, cutoverSequence: 42 },
  )
  record(
    'N12',
    '证据负控：非 active user 的消息判不合格（M8-D11 单 active user 边界）',
    'ok=false · affect_source_unqualified',
    `ok=${String(foreignUser.ok)}${foreignUser.ok ? '' : ` · ${foreignUser.code}`}`,
    !foreignUser.ok && foreignUser.code === 'affect_source_unqualified',
  )

  const preCutover = affectEvidenceVerdictOf(
    [candidate('cev-p', 42, 'user_message', establishedUserReading())],
    { activeUserId: ACTIVE_USER, cutoverSequence: 42 },
  )
  record(
    'N13',
    '证据负控：切换前历史事件（sequence ≤ cutover）判不合格（M8-D05 不重放）',
    'ok=false · affect_source_unqualified',
    `ok=${String(preCutover.ok)}${preCutover.ok ? '' : ` · ${preCutover.code}`}`,
    !preCutover.ok && preCutover.code === 'affect_source_unqualified',
  )

  const unconfirmed = affectEvidenceVerdictOf(
    [candidate('cev-u', 43, 'user_message', { ...establishedUserReading(), axisBConfirmed: false })],
    { activeUserId: ACTIVE_USER, cutoverSequence: 42 },
  )
  record(
    'N14',
    '证据负控：Axis B 未确认（axisBConfirmed=false）→ 判不合格（失败关闭）',
    'ok=false',
    `ok=${String(unconfirmed.ok)}${unconfirmed.ok ? '' : ` · ${unconfirmed.code}`}`,
    !unconfirmed.ok,
  )

  const mixed = affectEvidenceVerdictOf(
    [
      candidate('cev-1', 43, 'user_message', establishedUserReading()),
      candidate('cev-a', 44, 'assistant_message'),
    ],
    { activeUserId: ACTIVE_USER, cutoverSequence: 42 },
  )
  record(
    'N15',
    '证据负控：合格用户消息 + 她的回复混引 → 整体不合格（因果集不容污染）',
    'ok=false',
    `ok=${String(mixed.ok)}${mixed.ok ? '' : ` · ${mixed.code}`}`,
    !mixed.ok,
  )

  const outOfBounds =
    !affectDeltaWithinBounds({ deltaValence: 0.26, deltaArousal: 0 }) &&
    !affectDeltaWithinBounds({ deltaValence: 0, deltaArousal: -0.3 }) &&
    !affectDeltaWithinBounds({ deltaValence: Number.NaN, deltaArousal: 0 })
  record(
    'N16',
    '界负控：|Δv|=0.26 / |Δa|=0.3 / NaN → 全部拒绝（不静默夹）',
    '3 项全 false',
    `outOfBounds=${String(outOfBounds)}`,
    outOfBounds,
  )

  const clampThrow = expectThrow('clamp NaN', () => clampAffectValence(Number.NaN))
  record(
    'N17',
    '夹取负控：非有限数直接抛（affect_value_not_finite），不猜不夹',
    '必须抛错',
    clampThrow.threw ? `已拒：${clampThrow.message.slice(0, 60)}` : '未抛错（缺陷！）',
    clampThrow.threw,
  )

  const duplicateRegistry = new DomainEventRegistry()
  duplicateRegistry.register({
    type: AFFECT_ORIGIN,
    description: 'dup-test',
    maxPayloadBytes: 1024,
    validatePayload: (p) => p,
  })
  const duplicateThrow = expectThrow('duplicate register', () =>
    duplicateRegistry.register({
      type: AFFECT_ORIGIN,
      description: 'dup-test-2',
      maxPayloadBytes: 1024,
      validatePayload: (p) => p,
    }),
  )
  record(
    'N18',
    '登记表负控：同一事件类型重复登记 → 启动即抛（不允许两处语义）',
    '必须抛错',
    duplicateThrow.threw ? `已拒：${duplicateThrow.message.slice(0, 60)}` : '未抛错（缺陷！）',
    duplicateThrow.threw,
  )

  // ---- 匹配器负控（N19–N23）----

  const quoted = matchAffectPatterns('他刚才说「谢谢你」，我没说')
  record(
    'N19',
    '匹配器负控：引号内的感谢（转述）不触发',
    '0 命中',
    `${String(quoted.length)} 命中`,
    quoted.length === 0,
  )

  const question = matchAffectPatterns('你讨厌我吗？')
  record(
    'N20',
    '匹配器负控：疑问句不触发（你讨厌我吗？不是敌意断言）',
    '0 命中',
    `${String(question.length)} 命中`,
    question.length === 0,
  )

  const negated = matchAffectPatterns('我不是不喜欢你，只是这次真的很失望')
  record(
    'N21',
    '匹配器负控：否认前缀守卫（不不喜欢你——含"不喜欢"守卫词）不触发温暖族',
    '0 命中',
    `${String(negated.length)} 命中`,
    negated.length === 0,
  )

  const poisoned = matchAffectPatterns('我讨厌你，谢谢你啊')
  const poisonedFamilies = [...matchedAffectRuleFamilies('我讨厌你，谢谢你啊')]
  record(
    'N22',
    '匹配器负控：敌意毒化——同句敌意在场 ⇒ 正面族命中作废（只剩 A-HOSTILE）',
    '只剩 A-HOSTILE',
    poisonedFamilies.join(','),
    poisoned.length > 0 &&
      poisonedFamilies.length === 1 &&
      poisonedFamilies[0] === 'A-HOSTILE',
  )

  const ruleIdGate =
    !isAffectImpactRuleId('A-NEUTRAL-TOUCH') &&
    !isAffectImpactRuleId('A-UNCERTAIN') &&
    !isAffectImpactRuleId('A-HACKED') &&
    AFFECT_IMPACT_RULE_IDS.every((id) => isAffectImpactRuleId(id))
  record(
    'N23',
    '规则标识负控：A-NEUTRAL-TOUCH / A-UNCERTAIN / 未知名都不是合法 IMPACT ruleId（7 族合法）',
    '3 项非法 · 7 族合法',
    `gate=${String(ruleIdGate)}`,
    ruleIdGate,
  )

  // ---- Reducer 负控（N24–N25）----

  const touchBeforeOrigin = expectThrow('touch before origin', () =>
    reduceAffectState(UNORIGINATED_AFFECT_STATE, touchEvent, OWNER),
  )
  record(
    'N24',
    'Reducer 负控：未建档先 TOUCH → 硬错误 affect_not_originated（失败关闭，不静默跳过）',
    '必须抛错',
    touchBeforeOrigin.threw ? `已拒：${touchBeforeOrigin.message.slice(0, 60)}` : '未抛错（缺陷！）',
    touchBeforeOrigin.threw,
  )

  const doubleOrigin = expectThrow('double origin', () =>
    reduceAffectState(foldedOrigin, originEvent, OWNER),
  )
  record(
    'N25',
    'Reducer 负控：重复 ORIGIN → 硬错误 affect_origin_duplicate',
    '必须抛错',
    doubleOrigin.threw ? `已拒：${doubleOrigin.message.slice(0, 60)}` : '未抛错（缺陷！）',
    doubleOrigin.threw,
  )

  const foreignEvent = fakeEvent(
    'de-x1',
    AFFECT_TOUCH,
    { ...validTouch, characterId: 'char_other' as CharacterId },
    5,
    T0,
  )
  const foreignSkipped = reduceAffectState(foldedOrigin, foreignEvent, OWNER)
  record(
    'N26',
    'Reducer 负控：别的 Character 的事件跳过（不折叠、state 原样——信封不前进的前提）',
    'state 原样',
    `原样=${String(JSON.stringify(foreignSkipped) === JSON.stringify(foldedOrigin))}`,
    JSON.stringify(foreignSkipped) === JSON.stringify(foldedOrigin) &&
    !affectEventTargets(foreignEvent, OWNER),
  )

  // ---- 恢复（R）：检测器响过之后重新安静 ----

  const recoverOrigin = validateAffectOriginPayload(validOrigin)
  const recoverImpact = validateAffectImpactPayload(validImpact)
  record(
    'R1',
    '恢复：负控 N1–N9 之后，合法 ORIGIN / TOUCH / IMPACT payload 重新通过',
    '字段逐项保留',
    `origin.cutover=${String(recoverOrigin.cutoverSequence)} · impact.ruleId=${String(recoverImpact.ruleId)}`,
    recoverOrigin.cutoverSequence === 42 && recoverImpact.ruleId === 'A-GRATITUDE',
  )

  const recoverEvidence = affectEvidenceVerdictOf(
    [candidate('cev-r', 99, 'user_message', establishedUserReading())],
    { activeUserId: ACTIVE_USER, cutoverSequence: 42 },
  )
  record(
    'R2',
    '恢复：负控 N10–N15 之后，active user 的 ESTABLISHED 证据重新判合格',
    'ok=true',
    `ok=${String(recoverEvidence.ok)}`,
    recoverEvidence.ok,
  )

  const recoverClamp = clampAffectArousal(1.7)
  record(
    'R3',
    '恢复：负控 N17 之后，clampAffectArousal(1.7) 正常夹到 1',
    '1',
    String(recoverClamp),
    recoverClamp === 1,
  )

  const recoverRegistry = createAffectDomainEventRegistry()
  record(
    'R4',
    '恢复：负控 N18 之后，全新登记表正常建立（三类都在）',
    '三类都在',
    `origin=${String(recoverRegistry.has(AFFECT_ORIGIN))} · touch=${String(recoverRegistry.has(AFFECT_TOUCH))} · impact=${String(recoverRegistry.has(AFFECT_IMPACT))}`,
    recoverRegistry.has(AFFECT_ORIGIN) && recoverRegistry.has(AFFECT_TOUCH) && recoverRegistry.has(AFFECT_IMPACT),
  )

  const neutralMessage = matchAffectPatterns('今天天气不错，我们聊聊那个项目吧')
  record(
    'R5',
    '恢复：守卫负控之后，中性消息安静（0 命中 ⇒ 只 touch 不 impact 的诚实中性）',
    '0 命中',
    `${String(neutralMessage.length)} 命中`,
    neutralMessage.length === 0,
  )

  const recoverFold = stream.reduce((s, e) => reduceAffectState(s, e, OWNER), UNORIGINATED_AFFECT_STATE)
  record(
    'R6',
    '恢复：负控 N24–N26 之后，合法事件流重新折叠出与 P14 相同的状态',
    '与 P14 一致',
    `一致=${String(JSON.stringify(recoverFold) === JSON.stringify(replayA))}`,
    JSON.stringify(recoverFold) === JSON.stringify(replayA),
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

  // --supersedes <runId> --supersedes-reason <text>：失败档留档、重跑记链（TD-04① 同纪律）
  const argOf = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag)
    return index >= 0 ? process.argv[index + 1] : undefined
  }
  const supersedes = argOf('--supersedes') ?? null
  const supersedesReason = argOf('--supersedes-reason')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM8RunId({ wpId: 'wp2-contracts', headShort: head })
  const dir = openM8RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm8-wp2-contracts@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    branch: 'feature/m7-relationship',
    propositions: {
      s1: 'affect.ts 只依赖 contracts（依赖方向单向）',
      s2: 'src/** 无 affect:conversation/user/message 第二权威形状（M8-D01）',
      s3: 'WP4 接线完成（full registry 含全部 AFFECT 类型；判据已翻转）',
      s4: 'projections/affect.ts 只依赖 contracts（reducer 纯度）',
      runtime: 'payload 校验 / 证据资格 / 衰减 / 界 / 拒绝码 / 登记表 / reducer 折叠 / 规则匹配器：正控·负控·恢复三段式',
    },
    stages: { positive, negative, recovery },
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
    ...(supersedes !== null ? { supersedes, supersedesReason: supersedesReason ?? '(未注明)' } : {}),
  }
  writeFileSync(join(dir, 'contracts.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM8Manifest(dir, {
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
    supersedes,
    notes:
      supersedes !== null
        ? `M8 WP2 合同门（取代 ${supersedes}：${supersedesReason ?? '未注明'}）`
        : 'M8 WP2 合同门：静态形状 + 三段式行为验证（含 reducer 纯折叠与 affect-rules@1 匹配器）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(`stages: 正控+静态=${String(positive)} · 负控=${String(negative)} · 恢复=${String(recovery)}`)
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main()
