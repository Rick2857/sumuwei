/**
 * P3-5b · **G1：真实入口的独立结果核验**（`verifyPersonalLibraryAnswer` 的产品侧接线）
 * ============================================================================
 *  背景（P3-6 上线准备表 G1）：
 *  `verifyPersonalLibraryAnswer` 早就实现了，但**只被两个门调用**；`src/main.ts` 的
 *  按轮记账走的是 `outcomeFromActionResults`（**任务环自评**）⇒ "使用记录里的结果"
 *  在真实入口上**不是独立核验**。本模块把核验接到入口，并明确"什么能说、什么不能说"。
 *
 *  ```text
 *  能独立核验的（机械事实）：真的读过哪些文件、读的路径是否落在资料根内、回复是否引用了
 *                            已登记来源、是否出现未登记的事实标记 …… 由契约核验器给结论。
 *  不能说的：① 没有受信任务声明提供 `requiredSourcePaths` ⇒ **unknown**（不是"通过"）；
 *            ② 记账发生在**回复生成之前** ⇒ 没有回复正文 ⇒ 引文类判据不可用 ⇒ **unknown**；
 *            ③ **"确实读过来源" ≠ "答案正确"** —— 因此绝不用"读过"单独推出 `done`。
 *  ```
 *
 *  ⚠️ **不把测试夹具的标准答案带进生产**：`requiredSourcePaths` / `allowedFactMarkers`
 *    只能由**受信任务声明**（调用方注入）提供；本模块**没有**任何内置样例、没有从资料里
 *    反推"应该读哪些文件"、没有把搜索结果当成"期望来源"。
 */
import {
  verifyPersonalLibraryAnswer,
  type WorkflowSkillTaskOutcome,
} from '../../kernel/contracts/workflow-skill-catalog.ts'
import type { ActionTurnResult } from '../../kernel/action/action-turn.ts'

/** 受管技能里**只有** personal-library 有独立核验器；其它技能一律 `unknown`。 */
export const P3_VERIFIED_SKILL_ID = 'personal-library'
export const P3_VERIFIER_ID = 'personal-library-answer@1'

export interface P3IndependentVerificationInput {
  /** 本轮**被选中/加载**的技能 id（由装配层从真实动作里取）。 */
  readonly skillIds: readonly string[]
  /** 本轮真实动作结果（只读它们，不读模型自述）。 */
  readonly actionResults: readonly ActionTurnResult[]
  /** 资料根（真实绝对路径）；读取落在这里之外算越界。 */
  readonly libraryRoot: string
  /**
   * 任务**要求读到**的来源（只能来自受信任务声明）。
   * ⚠️ 生产缺省为空 ⇒ 核验结论 `unknown`（**不**从搜索结果/资料清单反推）。
   */
  readonly requiredSourcePaths?: readonly string[]
  /** 受信任务声明里的事实标记白名单（缺省空）。 */
  readonly allowedFactMarkers?: readonly string[]
  /**
   * 记账时点可得的回复正文。当前装配在**回复生成之前**记账 ⇒ 缺省 `undefined`，
   * 于是引文类判据不可用，结论只能是 `unknown`。
   */
  readonly replyText?: string
}

export interface P3IndependentVerification {
  /** 每个技能一条结论（`unknown` 也**必须**有条目 ⇒ 记账层不会回落到自评）。 */
  readonly outcomes: Readonly<Record<string, WorkflowSkillTaskOutcome>>
  readonly mechanical: {
    readonly verifier: string
    readonly realReadCount: number
    readonly outOfScopeReadCount: number
    readonly replyTextAvailable: boolean
    readonly requiredSourceCount: number
    /** 任务环自评的原始读数（**只是事实记录**，不参与核验结论）。 */
    readonly selfAssessment?: WorkflowSkillTaskOutcome
  }
}

/** 从真实动作里取"成功读到"的路径（只认 `content_read` 且状态 success 的动作）。 */
export function realReadPathsOf(actionResults: readonly ActionTurnResult[]): string[] {
  const paths: string[] = []
  const visit = (item: ActionTurnResult): void => {
    const result = item.result
    if (result !== undefined && result.status === 'success' && result.effect?.kind === 'content_read') {
      const argumentPath = item.request?.arguments?.path
      if (typeof argumentPath === 'string' && argumentPath !== '' && !paths.includes(argumentPath)) paths.push(argumentPath)
      for (const evidence of result.evidence ?? []) {
        if (typeof evidence.ref !== 'string' || evidence.ref === '') continue
        if (!paths.includes(evidence.ref)) paths.push(evidence.ref)
      }
    }
    for (const followUp of item.followUps ?? []) visit(followUp)
  }
  for (const item of actionResults) visit(item)
  return paths
}

/** 路径是否落在资料根内（前缀匹配；反斜杠统一成 `/`）。 */
function withinRoot(path: string, root: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalizedRoot === '') return false
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

/**
 * 独立核验本轮技能结果。
 *
 * ⚠️ 纪律（与 G1 的裁定逐条对应）：
 *  · 每个被选中技能**必定**有一条结论（`unknown` 也算）⇒ 记账层拿到的 `outcomes` 里
 *    **没有键缺失**，因此**不会**回落到 `outcomeFromActionResults`（任务环自评）；
 *  · `done` **只**来自契约核验器，且必须同时具备：受信 `requiredSourcePaths`、
 *    回复正文、核验器判 `done`；
 *  · 机械事实（真实读路径数、越界读数）始终记录在 `evidence` 里；
 *  · 任务环自评只作为 `mechanical.selfAssessment` 的**事实记录**保留，**不**参与结论。
 */
export function independentlyVerifySkillResults(
  input: P3IndependentVerificationInput
): P3IndependentVerification {
  const readPaths = realReadPathsOf(input.actionResults)
  const outOfScope = readPaths.filter((path) => !withinRoot(path, input.libraryRoot))
  const requiredSourcePaths = input.requiredSourcePaths ?? []
  const replyTextAvailable = typeof input.replyText === 'string' && input.replyText !== ''
  const selfAssessment = selfAssessmentOf(input.actionResults)
  const outcomes: Record<string, WorkflowSkillTaskOutcome> = {}

  for (const skillId of input.skillIds) {
    const baseEvidence = {
      verifier: P3_VERIFIER_ID,
      skillId,
      realReadCount: readPaths.length,
      outOfScopeReadCount: outOfScope.length,
      requiredSourceCount: requiredSourcePaths.length,
      replyTextAvailable,
      selfAssessmentLabel: 'task_loop_self_assessment_not_verification',
    }
    if (skillId !== P3_VERIFIED_SKILL_ID) {
      outcomes[skillId] = { kind: 'unknown', evidence: { ...baseEvidence, reason: 'verifier_not_available_for_skill' } }
      continue
    }
    if (requiredSourcePaths.length === 0) {
      /* 没有受信任务声明 ⇒ 独立核验的前提不存在 ⇒ unknown（**不是**"通过"）。 */
      outcomes[skillId] = { kind: 'unknown', evidence: { ...baseEvidence, reason: 'no_trusted_required_sources' } }
      continue
    }
    if (!replyTextAvailable) {
      /*
       * 有受信来源、但记账时点没有回复正文 ⇒ 引文/虚构类判据不可用。
       * ⚠️ 这里**不**用"读过来源"顶替"答案正确" ⇒ 仍然 unknown。
       */
      outcomes[skillId] = { kind: 'unknown', evidence: { ...baseEvidence, reason: 'reply_text_not_available_at_write_time' } }
      continue
    }
    const verification = verifyPersonalLibraryAnswer({
      replyText: input.replyText ?? '',
      requiredSourcePaths,
      readPaths,
      libraryRoot: input.libraryRoot,
      allowedFactMarkers: input.allowedFactMarkers ?? [],
    })
    outcomes[skillId] = {
      kind: verification.kind,
      evidence: { ...baseEvidence, ...verification.evidence, verifierVerdict: verification.kind },
    }
  }

  return {
    outcomes,
    mechanical: {
      verifier: P3_VERIFIER_ID,
      realReadCount: readPaths.length,
      outOfScopeReadCount: outOfScope.length,
      replyTextAvailable,
      requiredSourceCount: requiredSourcePaths.length,
      ...(selfAssessment === undefined ? {} : { selfAssessment }),
    },
  }
}

/** 任务环自评读数的只读快照（**只作事实记录**；不进核验结论）。 */
function selfAssessmentOf(actionResults: readonly ActionTurnResult[]): WorkflowSkillTaskOutcome | undefined {
  const tasks: NonNullable<ActionTurnResult['task']>[] = []
  const visit = (item: ActionTurnResult): void => {
    if (item.task !== undefined) tasks.push(item.task)
    for (const followUp of item.followUps ?? []) visit(followUp)
  }
  for (const item of actionResults) visit(item)
  if (tasks.length === 0) return undefined
  const achieved = tasks.some((task) => task.goal?.achieved === true && task.stopped === 'done')
  return {
    kind: achieved ? 'done' : 'not_done',
    evidence: {
      label: 'task_loop_self_assessment_not_verification',
      taskCount: tasks.length,
      stopped: tasks[tasks.length - 1]!.stopped,
    },
  }
}
