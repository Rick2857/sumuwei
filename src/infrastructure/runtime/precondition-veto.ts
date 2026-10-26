/**
 * **写前置条件的否决评估**（ADR-151 步骤 D · 消费侧读面）。
 *
 * 它把四样**受信**的东西接起来：
 * ```text
 * 受信已知目录事实（族）  ─┐
 * 受信族前置条件声明      ─┼─► 族作用域的当前合格规则（复用 selectUsableRules + 翻译）
 * 本任务的受信条件观测    ─┤
 * 开关（缺省 false）      ─┴─► decideWritePreconditionVeto ⇒ 否决 / 不否决 + 具名理由
 * ```
 *
 * ⚠️ **条件值只来自本任务（trace）的受信观测**：不是候选自述，也不是任意历史读数。
 * ⚠️ **没有族 / 没有声明 / 没有当前合格的规则 ⇒ 不否决**（不猜）。
 * ⚠️ 本模块**不**执行任何动作：它只回答"这次写该不该被否决"。
 */

import { selectUsableRules } from '../../kernel/contracts/cognitive-collaboration.ts'
import { familyOfWriteTarget, sandboxWriteFamilyScope } from '../../kernel/contracts/write-family.ts'
import {
  decideWritePreconditionVeto, writePreconditionConditions,
  type WritePreconditionDeclaration, type WritePreconditionVetoDecision,
} from '../../kernel/contracts/write-precondition.ts'
import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type { RawDb } from '../persistence/db.ts'
import { EBL_TOOL_ENVIRONMENT, readTrustedConditionInTrace } from '../persistence/epistemic-belief-source.ts'
import { createEblRuleSnapshotPort } from './ebl-rule-snapshot.ts'
import { buildTransitionRule } from './world-model-transition.ts'
import type { WriteSourceScope } from '../../kernel/contracts/world-model-transition.ts'
import { readWriteSourceReceipts, type WriteSourcesForTarget } from '../persistence/write-source-read.ts'
import { attributeWriteSource, type WriteSourceAttribution } from '../../kernel/contracts/write-source-attribution.ts'

/** 否决评估的**输入**（全部受信）。 */
export interface PreconditionVetoInput {
  /** 开关（**缺省 false** ⇒ 整段不跑）。 */
  readonly enabled: boolean
  readonly db: RawDb
  readonly characterId: CharacterId
  readonly activeUserId: string
  /** 这次写的目标路径（族从这里算）。 */
  readonly targetPath: string
  /** **本任务**的 trace id（条件值只从这里读）。 */
  readonly traceId?: string
  /** 受信已知目录事实。 */
  readonly knownDirectories: () => readonly string[]
  /** 受信族前置条件声明。 */
  readonly declarations: readonly WritePreconditionDeclaration[]
  readonly writeSources?: WriteSourcesForTarget
  /** Select the matching learned source claim; absence preserves legacy all-writes semantics. */
  readonly sourceScope?: WriteSourceScope
}

export interface PreconditionVetoEvaluation {
  readonly decision: WritePreconditionVetoDecision
  readonly sourceScope?: WriteSourceScope
  /** 命中的族（若有）。 */
  readonly familyId?: string
  /** 条件标记路径（若有）。 */
  readonly conditionPath?: string
  /** 族的那条**前置条件命题** id（即使它当前不合格也有）⇒ 读数能答"是哪条命题、为什么不能用"。 */
  readonly claimId?: string
  /** 那条命题当前**为什么**不能被消费（复用 `selectUsableRules` 的具名跳过原因）。 */
  readonly ruleStatus?: 'qualified' | 'not_usable' | 'scope_mismatch' | 'condition_unknown' | 'condition_mismatch'
  | 'subject_mismatch' | 'environment_mismatch'
}

/**
 * 评估"这次写要不要被否决"。
 *
 * ⚠️ 顺序要紧：**开关 → 族 → 当前合格的规则 → 条件观测 → 真值表**。
 *    任何一环缺失 ⇒ **不否决**（回默认顺序）。
 */
export async function evaluatePreconditionVeto (input: PreconditionVetoInput): Promise<PreconditionVetoEvaluation> {
  if (!input.enabled) {
    return { decision: decideWritePreconditionVeto({ enabled: false }) }
  }
  const familyId = familyOfWriteTarget({ path: input.targetPath, knownDirectories: input.knownDirectories() })
  if (familyId === undefined) {
    return { decision: decideWritePreconditionVeto({ enabled: true }) }
  }
  const declaration = input.declarations.find(item => item.familyId === familyId)
  if (declaration === undefined) {
    // 没有受信声明 ⇒ 这个族**没有**前置条件 ⇒ 不否决（不是"任意族都行"）。
    return { decision: decideWritePreconditionVeto({ enabled: true }), familyId }
  }
  const snapshotPort = createEblRuleSnapshotPort(input.db, input.characterId, input.activeUserId, { writeSources: input.writeSources })
  const snapshots = await snapshotPort.list()
  const familyScope = sandboxWriteFamilyScope(familyId)
  // 族的那条前置条件命题（即使它当前不合格，也要能报"为什么不能用"）。
  const scopedSnapshots = snapshots.filter(item => item.conditions.source_scope === input.sourceScope)
  const familyClaim = scopedSnapshots.find(item => item.predicate === 'write_precondition_holds' && item.scope === familyScope)
  const selection = selectUsableRules({
    snapshots: scopedSnapshots,
    visible: {
      subjectId: input.activeUserId,
      scope: familyScope,
      environment: EBL_TOOL_ENVIRONMENT,
      conditions: writePreconditionConditions(declaration, input.sourceScope),
    },
  })
  const translated = selection.selected.map(item => ({ snapshot: item, translation: buildTransitionRule(item) }))
    .find(item => 'rule' in item.translation)
  if (translated === undefined || !('rule' in translated.translation)) {
    // 没有**当前合格**的族规则（未合格 / 被挂起 / 已撤回 / 族不匹配）⇒ 不否决。
    const skip = familyClaim === undefined
      ? undefined
      : selection.skipped.find(item => item.claimId === familyClaim.claimId)
    return {
      decision: decideWritePreconditionVeto({ enabled: true }),
      familyId,
      conditionPath: declaration.conditionPath,
      ...(familyClaim === undefined ? {} : { claimId: familyClaim.claimId }),
      ...(skip === undefined ? {} : { ruleStatus: skip.reason }),
    }
  }
  const rule = translated.translation.rule
  // ⚠️ **族作用域**来自**命题快照**（规则本身不带 scope；族是命题身份的一部分）。
  const scope = translated.snapshot.scope
  const observed = input.traceId === undefined
    ? undefined
    : await readTrustedConditionInTrace(input.db, String(input.characterId), input.traceId, declaration.conditionPath)
  const decision = decideWritePreconditionVeto({
    enabled: true,
    rule: {
      id: rule.id,
      version: rule.version,
      scope,
      requires: rule.requires!,
    },
    targetFamilyId: familyId,
    ...(observed === undefined ? {} : { conditionValue: observed.value, conditionSource: observed.source }),
  })
  return {
    decision,
    ...(rule.sourceScope === undefined ? {} : { sourceScope: rule.sourceScope }),
    familyId,
    conditionPath: declaration.conditionPath,
    claimId: translated.snapshot.claimId,
    ruleStatus: 'qualified',
  }
}

/** Candidate bytes are fingerprinted by the caller; no source label comes from a plan. */
export async function evaluateCandidatePreconditionVeto(input: PreconditionVetoInput, candidates: readonly {
  id: string; writeFingerprints: readonly string[]
}[]) {
  const base = await evaluatePreconditionVeto(input)
  if (!input.enabled) return { vetoedIds: [] as string[], attributions: [] as {
    candidateId: string; attribution: WriteSourceAttribution
  }[], evaluation: base }
  let evaluation = base
  const declarations = input.writeSources?.(input.targetPath) ?? []
  const receipts = !input.enabled || input.traceId === undefined || declarations.length === 0 ? []
    : await readWriteSourceReceipts(input.db, { characterId: String(input.characterId), activeUserId: input.activeUserId,
      traceId: input.traceId, declarations })
  const scoped = new Map<string, PreconditionVetoEvaluation>()
  const vetoedIds: string[] = []
  const attributions: { candidateId: string; attribution: WriteSourceAttribution }[] = []
  for (const candidate of candidates) {
    let veto = candidate.writeFingerprints.length > 0 && base.decision.veto
    if (input.enabled && input.writeSources !== undefined) for (const contentFingerprint of candidate.writeFingerprints) {
      const attribution = attributeWriteSource({ declarations, receipts,
        candidate: { taskId: input.traceId ?? '', contentFingerprint } }).attribution
      attributions.push({ candidateId: candidate.id, attribution })
      if (attribution === 'unknown') continue
      let result = scoped.get(attribution)
      if (result === undefined) {
        result = await evaluatePreconditionVeto({ ...input, sourceScope: attribution })
        scoped.set(attribution, result)
      }
      if (result.decision.veto) { veto = true; evaluation = result }
    }
    if (veto) vetoedIds.push(candidate.id)
  }
  return { vetoedIds, attributions, evaluation }
}
