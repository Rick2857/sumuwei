/**
 * P3 —— **技能发布状态 + 使用记录**的持久化（基础设施层）。
 *
 * ============================================================================
 *  它只做两件事（其余全在 kernel 的纯函数里）
 * ============================================================================
 * ```text
 * ① 发布事实：`workflow_skill_releases`（每个技能最多一行 is_current）
 *     + append-only `workflow_skill_release_events`（每次转移都留痕，历史可查）
 * ② 使用记录：`workflow_skill_usage_records`（append-only；同 recordId 重复写是 no-op）
 * ```
 *
 * ---------------------------------------------------------------------------
 *  四条纪律
 * ---------------------------------------------------------------------------
 * · **信任边界**：状态转移只由受信发布器调用（actor 恒为 `trusted-publisher`）；
 *   模型 / 动作 / 技能自身**没有任何**路径能调用本模块（见门 `p3:skill-usage:verify`
 *   的结构锁：`src/kernel/action/**` 与适配器里没有 import 本文件）。
 * · **原子转移**：`update ... where state = <期望状态>`（CAS）⇒ 并发/重复发布不会
 *   出现"两个发布者都以为自己成功了"。事件与状态在**同一个事务**里写。
 * · **幂等登记**：目录资产重复登记 = 逐项核对（digest + 内容指纹），一致则 no-op。
 *   不一致 ⇒ `catalog_drift`（不覆盖任何一行）。因此"重放目录"不会改写历史。
 * · **正文不落库**：使用记录只存 id / 布尔 / 闭集标志 / 状态（与 trace 同一隐私原则）。
 */

import { sql } from 'drizzle-orm'

import type {
  WorkflowSkillCatalog,
  WorkflowSkillCatalogSkill,
  WorkflowSkillPublishedState,
  WorkflowSkillRelease,
  WorkflowSkillReleaseState,
  WorkflowSkillUsageFlag,
  WorkflowSkillUsageRecord,
} from '../../kernel/contracts/workflow-skill-catalog.ts'
import {
  WORKFLOW_SKILL_RELEASE_STATES,
  WORKFLOW_SKILL_RELEASE_TRANSITIONS,
  isWorkflowSkillReleaseState,
} from '../../kernel/contracts/workflow-skill-catalog.ts'
import {
  P3_REVISION_HARNESS_PRODUCER,
  computeVerificationBundleDigest,
  sha256Hex,
  type WorkflowSkillVerificationBundle,
} from '../../kernel/contracts/workflow-skill-revision.ts'
import { exec, inTransaction, type RawDb } from './db.ts'

/** 受信发布器标识（写进每条事件；模型侧没有任何路径能产生它）。 */
export const TRUSTED_PUBLISHER_ACTOR = 'trusted-publisher' as const

/**
 * 事务内"判定失败"的**唯一**正确传播方式。
 *
 * ⚠️ 为什么必须是 throw（2026-10-28 独立复核指出后修）：`inTransaction` 用的是
 *    drizzle 的 `db.transaction(work)` —— **回调正常返回 ⇒ COMMIT**，只有抛异常才
 *    ROLLBACK。所以事务里"先写了几行、再发现这次不该成功"时若 `return { ok: false }`，
 *    那几行会被**提交**（例：校验包已入账、候选状态没改）。⇒ 事务内判定失败一律
 *    `abortTx(outcome)`，由 `settleTx` 在事务外还原成普通返回值。
 */
class TxAbort extends Error {
  constructor(readonly outcome: unknown) {
    super('tx_abort')
    this.name = 'TxAbort'
  }
}

function abortTx<T>(outcome: T): never {
  throw new TxAbort(outcome)
}

/** 把 `abortTx` 抛出的判定结果还原为普通返回值；其它异常照常上抛（真故障不吞）。 */
async function settleTx<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof TxAbort) return error.outcome as T
    throw error
  }
}

export interface WorkflowSkillReleaseRecord extends WorkflowSkillPublishedState {
  readonly predecessorVersion: number | null
  readonly catalogDigest: string
  readonly registeredAt: number
  readonly updatedAt: number
}

export interface WorkflowSkillReleaseEventRecord {
  readonly eventId: string
  readonly skillId: string
  readonly version: number
  readonly fromState: WorkflowSkillReleaseState | null
  readonly toState: WorkflowSkillReleaseState
  readonly action: 'register' | 'publish' | 'suspend' | 'retire' | 'set_current'
  readonly actor: string
  readonly reason: string
  readonly detail: Record<string, string | number | boolean>
  readonly createdAt: number
}

export interface WorkflowSkillVerificationBundleRecord extends WorkflowSkillVerificationBundle {
  readonly recordedAt: number
}

export interface WorkflowSkillRevisionDecisionRecord {
  readonly decisionId: string
  readonly skillId: string
  readonly version: number
  readonly parentVersion: number | null
  readonly bundleDigest: string | null
  readonly decision: 'accepted' | 'rejected'
  readonly rejectCode: string | null
  readonly holdoutSetId: string | null
  readonly detail: Record<string, string | number | boolean>
  readonly decidedBy: string
  readonly decidedAt: number
}

/** 追加裁定时调用方给的内容（decisionId 由存储层按内容+时间生成）。 */
export interface WorkflowSkillRevisionDecisionInput {
  readonly skillId: string
  readonly version: number
  readonly parentVersion: number | null
  readonly bundleDigest: string | null
  readonly decision: 'accepted' | 'rejected'
  readonly rejectCode: string | null
  readonly holdoutSetId: string | null
  readonly detail: Record<string, string | number | boolean>
  readonly decidedAt: number
}

export type WorkflowSkillBundleIntakeResult =
  | { readonly ok: true; readonly inserted: boolean }
  | {
      readonly ok: false
      readonly code:
        | 'bundle_digest_mismatch'
        | 'bundle_producer_invalid'
        | 'bundle_conflict'
        | 'bundle_candidate_not_registered'
      readonly detail: string
    }

export type WorkflowSkillPromotionCommitResult =
  | { readonly ok: true; readonly previousVersion: number | null }
  | {
      readonly ok: false
      readonly code:
        | 'bundle_digest_mismatch'
        | 'bundle_producer_invalid'
        | 'bundle_conflict'
        | 'candidate_not_registered'
        | 'candidate_state_conflict'
        | 'current_conflict'
      readonly detail: string
    }

export interface WorkflowSkillPromotionCommitInput {
  readonly skillId: string
  readonly version: number
  readonly bundle: WorkflowSkillVerificationBundle
  readonly reason: string
  readonly now: number
  /** 候选提议的闭集读数（写进事件 detail；不含正文） */
  readonly proposalDetail: Record<string, string | number | boolean>
}

export type WorkflowSkillRegisterResult =
  | { readonly ok: true; readonly inserted: number; readonly verified: number }
  | { readonly ok: false; readonly code: 'catalog_drift'; readonly detail: string }

export type WorkflowSkillTransitionResult =
  | { readonly ok: true; readonly from: WorkflowSkillReleaseState; readonly to: WorkflowSkillReleaseState }
  | {
      readonly ok: false
      readonly code: 'release_not_registered' | 'illegal_transition' | 'state_conflict' | 'unknown_state'
      readonly detail: string
      readonly state?: WorkflowSkillReleaseState
    }

export type WorkflowSkillSetCurrentResult =
  | { readonly ok: true; readonly previousVersion: number | null }
  | {
      readonly ok: false
      readonly code: 'release_not_registered' | 'target_not_published' | 'unknown_state'
      readonly detail: string
      readonly state?: WorkflowSkillReleaseState
    }

export interface WorkflowSkillReleaseStore {
  /** 幂等登记目录资产（受信发布器启动时调用一次即可）。 */
  registerCatalog(
    catalog: WorkflowSkillCatalog,
    options: { readonly catalogDigest: string; readonly now: number }
  ): Promise<WorkflowSkillRegisterResult>
  /** 某技能的全部版本状态（升序）。 */
  readStates(skillId: string): Promise<WorkflowSkillReleaseRecord[]>
  /** 当前版本状态（没有登记 ⇒ undefined）。 */
  readCurrent(skillId: string): Promise<WorkflowSkillReleaseRecord | undefined>
  /** 原子状态转移（非法转移不写任何一行，也不写事件）。 */
  transition(input: {
    readonly skillId: string
    readonly version: number
    readonly to: WorkflowSkillReleaseState
    readonly reason: string
    readonly now: number
    readonly expectedFrom?: WorkflowSkillReleaseState
  }): Promise<WorkflowSkillTransitionResult>
  /** 原子切换当前版本（目标必须 published）。 */
  setCurrent(input: {
    readonly skillId: string
    readonly version: number
    readonly reason: string
    readonly now: number
  }): Promise<WorkflowSkillSetCurrentResult>
  /** 发布历史（append-only，新→旧）。 */
  listEvents(skillId: string, limit?: number): Promise<WorkflowSkillReleaseEventRecord[]>
  /** 追加使用记录（同 recordId 重复写 = no-op，不覆盖已存在行）。 */
  appendUsage(record: WorkflowSkillUsageRecord): Promise<{ readonly inserted: boolean }>
  /** 读回一条使用记录。 */
  readUsage(recordId: string): Promise<WorkflowSkillUsageRecord | undefined>
  /** 按 trace 读使用记录（门用）。 */
  readUsageByTrace(traceId: string): Promise<WorkflowSkillUsageRecord[]>
  /* ---- P3-3：候选修订的验证包与裁定历史 ---- */
  /** 记录验证包（每候选版本只接受一份；摘要/产者不符 ⇒ 拒绝）。 */
  recordVerificationBundle(bundle: WorkflowSkillVerificationBundle): Promise<WorkflowSkillBundleIntakeResult>
  /** 读某候选版本的验证包。 */
  readVerificationBundle(skillId: string, version: number): Promise<WorkflowSkillVerificationBundleRecord | undefined>
  /** 追加一条裁定（接受/拒绝都留痕；拒绝码可回查）。 */
  appendRevisionDecision(decision: WorkflowSkillRevisionDecisionInput): Promise<{ readonly decisionId: string }>
  /** 某技能的裁定历史（新→旧）。 */
  listRevisionDecisions(skillId: string, limit?: number): Promise<WorkflowSkillRevisionDecisionRecord[]>
  /**
   * **原子发布**：验证包入账 + 状态 candidate→published + 切换当前版本 + 两条事件。
   *
   * ⚠️ 为什么必须是存储层的单一入口：发布=四件事同时成立。任何一步分开做，
   *    都可能留下"已发布但没切当前版本"或"包没记账却发布了"的半状态。
   */
  commitPromotion(input: WorkflowSkillPromotionCommitInput): Promise<WorkflowSkillPromotionCommitResult>
}

// ---------------------------------------------------------------------------
// 行 → 领域对象
// ---------------------------------------------------------------------------

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function num(value: unknown): number {
  return Number(value ?? 0)
}

function bool(value: unknown): boolean {
  return value === true || value === 't' || value === 1 || value === '1'
}

/** jsonb 在不同驱动下可能是已解析对象、JSON 字符串或数组。 */
function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }
  return []
}

function jsonObject(value: unknown): Record<string, string | number | boolean> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, string | number | boolean>
  }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, string | number | boolean>
      }
    } catch {
      return {}
    }
  }
  return {}
}

function stateOf(value: unknown): WorkflowSkillReleaseState | undefined {
  const text = str(value)
  return isWorkflowSkillReleaseState(text) ? text : undefined
}

function toReleaseRecord(row: Record<string, unknown>): WorkflowSkillReleaseRecord | undefined {
  const state = stateOf(row.state)
  if (state === undefined) return undefined
  const predecessor = row.predecessor_version === null || row.predecessor_version === undefined
    ? null
    : num(row.predecessor_version)
  return {
    skillId: str(row.skill_id),
    version: num(row.version),
    state,
    isCurrent: bool(row.is_current),
    releaseDigest: str(row.release_digest),
    predecessorVersion: predecessor,
    catalogDigest: str(row.catalog_digest),
    registeredAt: num(row.registered_at),
    updatedAt: num(row.updated_at),
  }
}

function toEventRecord(row: Record<string, unknown>): WorkflowSkillReleaseEventRecord {
  const from = str(row.from_state)
  return {
    eventId: str(row.event_id),
    skillId: str(row.skill_id),
    version: num(row.version),
    fromState: isWorkflowSkillReleaseState(from) ? from : null,
    toState: stateOf(row.to_state) ?? 'candidate',
    action: str(row.action) as WorkflowSkillReleaseEventRecord['action'],
    actor: str(row.actor),
    reason: str(row.reason),
    detail: jsonObject(row.detail),
    createdAt: num(row.created_at),
  }
}

function toUsageRecord(row: Record<string, unknown>): WorkflowSkillUsageRecord {
  const stateAtCommit = str(row.state_at_commit)
  const outcome = str(row.outcome)
  const record: WorkflowSkillUsageRecord = {
    recordId: str(row.record_id),
    characterId: str(row.character_id),
    traceId: str(row.trace_id),
    ...(str(row.task_id) === '' ? {} : { taskId: str(row.task_id) }),
    skillId: str(row.skill_id),
    version: num(row.version),
    contentFingerprint: str(row.content_fingerprint),
    releaseDigest: str(row.release_digest),
    managed: bool(row.managed),
    selected: bool(row.selected),
    loadSucceeded: bool(row.load_succeeded),
    ...(str(row.load_receipt_fingerprint) === ''
      ? {}
      : { loadReceiptFingerprint: str(row.load_receipt_fingerprint) }),
    ...(str(row.load_receipt_ref) === '' ? {} : { loadReceiptRef: str(row.load_receipt_ref) }),
    instructionDelivered: bool(row.instruction_delivered),
    ...(str(row.instruction_section_id) === ''
      ? {}
      : { instructionSectionId: str(row.instruction_section_id) }),
    instructionSourceRefs: jsonArray<string>(row.instruction_source_refs).map(String),
    ...(str(row.instruction_withheld_reason) === ''
      ? {}
      : { instructionWithheldReason: str(row.instruction_withheld_reason) }),
    contentDelivered: bool(row.content_delivered),
    deliveredContentIds: jsonArray<string>(row.delivered_content_ids).map(String),
    readPaths: jsonArray<string>(row.read_paths).map(String),
    actionRefs: jsonArray<string>(row.action_refs).map(String),
    outcome: outcome === 'done' || outcome === 'not_done' ? outcome : 'unknown',
    outcomeEvidence: jsonObject(row.outcome_evidence),
    ...(str(row.stop_reason) === '' ? {} : { stopReason: str(row.stop_reason) }),
    stateAtCommit: isWorkflowSkillReleaseState(stateAtCommit)
      ? stateAtCommit
      : 'unavailable',
    flags: jsonArray<string>(row.flags).map(String) as WorkflowSkillUsageFlag[],
    budget: (() => {
      const raw = jsonObject(row.budget)
      const actionsUsed = typeof raw.actionsUsed === 'number' ? raw.actionsUsed : undefined
      const plansUsed = typeof raw.plansUsed === 'number' ? raw.plansUsed : undefined
      return {
        ...(actionsUsed !== undefined ? { actionsUsed } : {}),
        ...(plansUsed !== undefined ? { plansUsed } : {}),
      }
    })(),
    createdAt: num(row.created_at),
  }
  return record
}

function eventIdOf(skillId: string, version: number, action: string, now: number, ordinal: string): string {
  return `skill-release-event:${skillId}@${String(version)}:${action}:${String(now)}:${ordinal}`
}

// ---------------------------------------------------------------------------
// P3-3：验证包 / 裁定 / 原子的行 → 领域对象
// ---------------------------------------------------------------------------

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function setResultOf(prefix: 'dev' | 'holdout', row: Record<string, unknown>): {
  setId: string
  specDigest: string
  verdict: 'pass' | 'fail'
  checks: number
  failures: number
  reportDigest: string
} {
  const verdict = str(row[`${prefix}_verdict`]) === 'pass' ? 'pass' : 'fail'
  return {
    setId: str(row[`${prefix}_set_id`]),
    specDigest: str(row[`${prefix}_spec_digest`]),
    verdict,
    checks: num(row[`${prefix}_checks`]),
    failures: num(row[`${prefix}_failures`]),
    reportDigest: str(row[`${prefix}_report_digest`]),
  }
}

function toVerificationBundleRecord(row: Record<string, unknown>): WorkflowSkillVerificationBundleRecord {
  return {
    bundleVersion: 'workflow-skill-verification-bundle@1',
    skillId: str(row.skill_id),
    version: num(row.version),
    parentVersion: num(row.parent_version),
    dev: setResultOf('dev', row),
    holdout: setResultOf('holdout', row),
    producer: str(row.producer),
    bundleDigest: str(row.bundle_digest),
    recordedAt: num(row.recorded_at),
  }
}

function toRevisionDecisionRecord(row: Record<string, unknown>): WorkflowSkillRevisionDecisionRecord {
  return {
    decisionId: str(row.decision_id),
    skillId: str(row.skill_id),
    version: num(row.version),
    parentVersion: numOrNull(row.parent_version),
    bundleDigest: strOrNull(row.bundle_digest),
    decision: str(row.decision) === 'accepted' ? 'accepted' : 'rejected',
    rejectCode: strOrNull(row.reject_code),
    holdoutSetId: strOrNull(row.holdout_set_id),
    detail: jsonObject(row.detail),
    decidedBy: str(row.decided_by),
    decidedAt: num(row.decided_at),
  }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export function createWorkflowSkillReleaseStore(db: RawDb): WorkflowSkillReleaseStore {
  async function readStatesIn(target: RawDb, skillId: string): Promise<WorkflowSkillReleaseRecord[]> {
    const rows = await exec(
      target,
      sql`select * from workflow_skill_releases where skill_id = ${skillId} order by version asc`,
      '读取技能发布状态'
    )
    return rows
      .map((row) => toReleaseRecord(row))
      .filter((row): row is WorkflowSkillReleaseRecord => row !== undefined)
  }

  async function appendEvent(
    target: RawDb,
    event: {
      skillId: string
      version: number
      fromState: WorkflowSkillReleaseState | null
      toState: WorkflowSkillReleaseState
      action: WorkflowSkillReleaseEventRecord['action']
      reason: string
      detail?: Record<string, string | number | boolean>
      now: number
    }
  ): Promise<void> {
    await exec(
      target,
      sql`insert into workflow_skill_release_events
            (event_id, skill_id, version, from_state, to_state, action, actor, reason, detail, created_at)
          values (${eventIdOf(event.skillId, event.version, event.action, event.now, String(Math.random()).slice(2, 8))},
                  ${event.skillId}, ${event.version}, ${event.fromState}, ${event.toState},
                  ${event.action}, ${TRUSTED_PUBLISHER_ACTOR}, ${event.reason},
                  ${JSON.stringify(event.detail ?? {})}::jsonb, ${event.now})`,
      '写入技能发布事件'
    )
  }

  async function registerRelease(
    target: RawDb,
    skillId: string,
    release: WorkflowSkillRelease,
    options: { readonly isCurrent: boolean; readonly catalogDigest: string; readonly now: number }
  ): Promise<'inserted' | 'verified' | 'drift'> {
    const existing = (await exec(
      target,
      sql`select * from workflow_skill_releases
          where skill_id = ${skillId} and version = ${release.version} limit 1`,
      '核对技能版本登记'
    )).map((row) => toReleaseRecord(row)).filter((row): row is WorkflowSkillReleaseRecord => row !== undefined)
    const current = existing[0]
    if (current !== undefined) {
      const same = current.releaseDigest === release.releaseDigest
      return same ? 'verified' : 'drift'
    }
    if (!options.isCurrent) {
      /*
       * 非当前版本（未来的修订候选）也要登记：`is_current = false`。
       * 它们的初始状态由资产声明（candidate）。
       */
      await exec(
        target,
        sql`insert into workflow_skill_releases
              (skill_id, version, content_fingerprint, release_digest, state, is_current,
               predecessor_version, catalog_digest, registered_at, updated_at)
            values (${skillId}, ${release.version}, ${release.contentFingerprint}, ${release.releaseDigest},
                    ${release.initialState}, false, ${release.predecessorVersion},
                    ${options.catalogDigest}, ${options.now}, ${options.now})`,
        '登记技能修订版本'
      )
      await appendEvent(target, {
        skillId,
        version: release.version,
        fromState: null,
        toState: release.initialState,
        action: 'register',
        reason: release.changeReason,
        now: options.now,
      })
      return 'inserted'
    }
    /*
     * 当前版本：一次前一个 current 都没有（首次登记）⇒ 直接 published + is_current。
     *
     * ⚠️ 若已经存在**另一个** current 行，这里**不**静默换人：切换当前版本必须走
     *    `setCurrent()`（它写事件、可回读）。目录重新登记不是"偷偷升级"的通道。
     */
    const currentRow = (await exec(
      target,
      sql`select * from workflow_skill_releases where skill_id = ${skillId} and is_current limit 1`,
      '读取当前技能版本'
    )).map((row) => toReleaseRecord(row)).filter((row): row is WorkflowSkillReleaseRecord => row !== undefined)
    if (currentRow.length > 0) return 'drift'
    await exec(
      target,
      sql`insert into workflow_skill_releases
            (skill_id, version, content_fingerprint, release_digest, state, is_current,
             predecessor_version, catalog_digest, registered_at, updated_at)
          values (${skillId}, ${release.version}, ${release.contentFingerprint}, ${release.releaseDigest},
                  ${release.initialState}, true, ${release.predecessorVersion},
                  ${options.catalogDigest}, ${options.now}, ${options.now})`,
      '登记技能当前版本'
    )
    await appendEvent(target, {
      skillId,
      version: release.version,
      fromState: null,
      toState: release.initialState,
      action: 'register',
      reason: release.changeReason,
      detail: { current: true },
      now: options.now,
    })
    return 'inserted'
  }

  return {
    async registerCatalog(catalog, options) {
      /* 事务内失败必须抛（见 `abortTx` 注释）：否则已登记的若干行会被提交。 */
      return settleTx(() => inTransaction(db, async (tx) => {
        let inserted = 0
        let verified = 0
        for (const skill of catalog.skills) {
          for (const release of skill.releases) {
            const isCurrent = release.version === skill.currentVersion
            const outcome = await registerRelease(tx, skill.skillId, release, {
              isCurrent,
              catalogDigest: options.catalogDigest,
              now: options.now,
            })
            if (outcome === 'drift') {
              abortTx({
                ok: false as const,
                code: 'catalog_drift' as const,
                detail: `${skill.skillId}@${String(release.version)} 的登记行与目录资产不一致（不覆盖历史）`,
              })
            }
            if (outcome === 'inserted') inserted += 1
            else verified += 1
          }
        }
        return { ok: true as const, inserted, verified }
      }))
    },

    async readStates(skillId) {
      return readStatesIn(db, skillId)
    },

    async readCurrent(skillId) {
      const rows = await exec(
        db,
        sql`select * from workflow_skill_releases where skill_id = ${skillId} and is_current limit 1`,
        '读取当前技能发布状态'
      )
      return toReleaseRecord(rows[0] ?? {})
    },

    async transition(input) {
      return inTransaction(db, async (tx) => {
        const rows = (await exec(
          tx,
          sql`select * from workflow_skill_releases
              where skill_id = ${input.skillId} and version = ${input.version} limit 1`,
          '读取待转移的技能版本'
        )).map((row) => toReleaseRecord(row)).filter((row): row is WorkflowSkillReleaseRecord => row !== undefined)
        const current = rows[0]
        if (current === undefined) {
          return {
            ok: false as const,
            code: 'release_not_registered' as const,
            detail: `${input.skillId}@${String(input.version)} 未登记`,
          }
        }
        if (input.expectedFrom !== undefined && current.state !== input.expectedFrom) {
          return {
            ok: false as const,
            code: 'state_conflict' as const,
            detail: `期望状态 ${input.expectedFrom}，实际 ${current.state}`,
            state: current.state,
          }
        }
        const allowed = WORKFLOW_SKILL_RELEASE_TRANSITIONS[current.state].includes(input.to)
        if (!allowed) {
          return {
            ok: false as const,
            code: 'illegal_transition' as const,
            detail: `${current.state} → ${input.to} 不在允许的转移表里`,
            state: current.state,
          }
        }
        const affected = await exec(
          tx,
          sql`update workflow_skill_releases
                 set state = ${input.to}, updated_at = ${input.now}
               where skill_id = ${input.skillId} and version = ${input.version} and state = ${current.state}
              returning version`,
          '原子转移技能发布状态'
        )
        if (affected.length === 0) {
          return {
            ok: false as const,
            code: 'state_conflict' as const,
            detail: '并发修改：状态已被别人改走',
          }
        }
        const action = input.to === 'published' ? 'publish' : input.to === 'suspended' ? 'suspend' : 'retire'
        await appendEvent(tx, {
          skillId: input.skillId,
          version: input.version,
          fromState: current.state,
          toState: input.to,
          action,
          reason: input.reason,
          now: input.now,
        })
        return { ok: true as const, from: current.state, to: input.to }
      })
    },

    async setCurrent(input) {
      return inTransaction(db, async (tx) => {
        const rows = (await exec(
          tx,
          sql`select * from workflow_skill_releases
              where skill_id = ${input.skillId} and version = ${input.version} limit 1`,
          '读取待切换的技能版本'
        )).map((row) => toReleaseRecord(row)).filter((row): row is WorkflowSkillReleaseRecord => row !== undefined)
        const target = rows[0]
        if (target === undefined) {
          return {
            ok: false as const,
            code: 'release_not_registered' as const,
            detail: `${input.skillId}@${String(input.version)} 未登记`,
          }
        }
        if (target.state !== 'published') {
          return {
            ok: false as const,
            code: 'target_not_published' as const,
            detail: `目标版本状态是 ${target.state}，只有 published 能成为当前版本`,
            state: target.state,
          }
        }
        const previous = (await exec(
          tx,
          sql`select * from workflow_skill_releases where skill_id = ${input.skillId} and is_current limit 1`,
          '读取旧当前版本'
        )).map((row) => toReleaseRecord(row)).filter((row): row is WorkflowSkillReleaseRecord => row !== undefined)
        const previousVersion = previous[0]?.version ?? null
        if (previousVersion === input.version) {
          return { ok: true as const, previousVersion }
        }
        if (previousVersion !== null) {
          await exec(
            tx,
            sql`update workflow_skill_releases set is_current = false, updated_at = ${input.now}
                where skill_id = ${input.skillId} and is_current`,
            '清掉旧当前版本'
          )
        }
        await exec(
          tx,
          sql`update workflow_skill_releases set is_current = true, updated_at = ${input.now}
              where skill_id = ${input.skillId} and version = ${input.version}`,
          '切换当前版本'
        )
        await appendEvent(tx, {
          skillId: input.skillId,
          version: input.version,
          fromState: 'published',
          toState: 'published',
          action: 'set_current',
          reason: input.reason,
          detail: previousVersion === null ? {} : { previousVersion },
          now: input.now,
        })
        return { ok: true as const, previousVersion }
      })
    },

    async listEvents(skillId, limit = 50) {
      const rows = await exec(
        db,
        sql`select * from workflow_skill_release_events
            where skill_id = ${skillId}
            order by created_at desc, event_id desc
            limit ${Math.max(1, Math.min(200, limit))}`,
        '读取技能发布历史'
      )
      return rows.map((row) => toEventRecord(row))
    },

    async appendUsage(record) {
      /*
       * append-only：主键冲突即 no-op（`do nothing`）。**不**做 upsert ——
       * "同一轮的使用记录被改写"正是"用加载次数冒充使用"最容易发生的地方。
       */
      const rows = await exec(
        db,
        sql`insert into workflow_skill_usage_records
              (record_id, character_id, trace_id, task_id, skill_id, version, content_fingerprint,
               release_digest, managed, selected, load_succeeded, load_receipt_fingerprint, load_receipt_ref,
               instruction_delivered, instruction_section_id, instruction_source_refs,
               instruction_withheld_reason, content_delivered, delivered_content_ids, read_paths,
               action_refs, outcome, outcome_evidence, stop_reason, state_at_commit, flags, budget, created_at)
            values (${record.recordId}, ${record.characterId}, ${record.traceId}, ${record.taskId ?? null},
                    ${record.skillId}, ${record.version}, ${record.contentFingerprint}, ${record.releaseDigest},
                    ${record.managed}, ${record.selected}, ${record.loadSucceeded},
                    ${record.loadReceiptFingerprint ?? null}, ${record.loadReceiptRef ?? null},
                    ${record.instructionDelivered}, ${record.instructionSectionId ?? null},
                    ${JSON.stringify(record.instructionSourceRefs)}::jsonb,
                    ${record.instructionWithheldReason ?? null}, ${record.contentDelivered},
                    ${JSON.stringify(record.deliveredContentIds)}::jsonb,
                    ${JSON.stringify(record.readPaths)}::jsonb,
                    ${JSON.stringify(record.actionRefs)}::jsonb,
                    ${record.outcome}, ${JSON.stringify(record.outcomeEvidence)}::jsonb,
                    ${record.stopReason ?? null}, ${record.stateAtCommit},
                    ${JSON.stringify(record.flags)}::jsonb, ${JSON.stringify(record.budget)}::jsonb,
                    ${record.createdAt})
            on conflict (record_id) do nothing
            returning record_id`,
        '写入技能使用记录'
      )
      return { inserted: rows.length > 0 }
    },

    async readUsage(recordId) {
      const rows = await exec(
        db,
        sql`select * from workflow_skill_usage_records where record_id = ${recordId} limit 1`,
        '读取技能使用记录'
      )
      return rows[0] === undefined ? undefined : toUsageRecord(rows[0])
    },

    async readUsageByTrace(traceId) {
      const rows = await exec(
        db,
        sql`select * from workflow_skill_usage_records where trace_id = ${traceId}
            order by created_at asc, record_id asc`,
        '按 trace 读取技能使用记录'
      )
      return rows.map((row) => toUsageRecord(row))
    },

    /* ---- P3-3：验证包 / 裁定 / 原子发布 ---- */

    async recordVerificationBundle(bundle) {
      return inTransaction(db, async (tx) => recordBundleInTx(tx, bundle))
    },

    async readVerificationBundle(skillId, version) {
      const rows = await exec(
        db,
        sql`select * from workflow_skill_revision_bundles
            where skill_id = ${skillId} and version = ${version} limit 1`,
        '读取候选验证包'
      )
      return rows[0] === undefined ? undefined : toVerificationBundleRecord(rows[0])
    },

    async appendRevisionDecision(decision) {
      const decisionId = `skill-revision-decision:${sha256OfDecision(decision)}`
      await exec(
        db,
        sql`insert into workflow_skill_revision_decisions
              (decision_id, skill_id, version, parent_version, bundle_digest, decision, reject_code,
               holdout_set_id, detail, decided_by, decided_at)
            values (${decisionId}, ${decision.skillId}, ${decision.version}, ${decision.parentVersion},
                    ${decision.bundleDigest}, ${decision.decision}, ${decision.rejectCode},
                    ${decision.holdoutSetId}, ${JSON.stringify(decision.detail)}::jsonb,
                    ${TRUSTED_PUBLISHER_ACTOR}, ${decision.decidedAt})
            on conflict (decision_id) do nothing`,
        '追加候选修订裁定'
      )
      return { decisionId }
    },

    async listRevisionDecisions(skillId, limit = 50) {
      const rows = await exec(
        db,
        sql`select * from workflow_skill_revision_decisions
            where skill_id = ${skillId}
            order by decided_at desc, decision_id desc
            limit ${Math.max(1, Math.min(200, limit))}`,
        '读取候选修订裁定历史'
      )
      return rows.map((row) => toRevisionDecisionRecord(row))
    },

    async commitPromotion(input) {
      const recomputed = computeVerificationBundleDigest({
        bundleVersion: input.bundle.bundleVersion,
        skillId: input.bundle.skillId,
        version: input.bundle.version,
        parentVersion: input.bundle.parentVersion,
        dev: { ...input.bundle.dev },
        holdout: { ...input.bundle.holdout },
        producer: input.bundle.producer,
      })
      if (recomputed !== input.bundle.bundleDigest) {
        return { ok: false as const, code: 'bundle_digest_mismatch' as const, detail: '验证包摘要与内容不一致' }
      }
      if (input.bundle.producer !== P3_REVISION_HARNESS_PRODUCER) {
        return { ok: false as const, code: 'bundle_producer_invalid' as const, detail: '验证包产者不是唯一 harness' }
      }
      /* 事务内失败必须抛（见 `abortTx` 注释）：这里已经写过校验包/状态行，
         若 `return { ok:false }` 会被 drizzle 当成成功提交（"包写了、状态没改"）。 */
      return settleTx(() => inTransaction(db, async (tx) => {
        const intake = await recordBundleInTx(tx, input.bundle)
        if (!intake.ok) {
          /* 包入账的失败码是闭集；发布侧只有四个同名码 + 一个"候选未登记"改名 */
          const code = intake.code === 'bundle_candidate_not_registered'
            ? ('candidate_not_registered' as const)
            : intake.code === 'bundle_conflict'
              ? ('bundle_conflict' as const)
              : intake.code === 'bundle_digest_mismatch'
                ? ('bundle_digest_mismatch' as const)
                : ('bundle_producer_invalid' as const)
          abortTx({ ok: false as const, code, detail: intake.detail })
        }
        const rows = (await exec(
          tx,
          sql`select * from workflow_skill_releases
              where skill_id = ${input.skillId} and version = ${input.version} limit 1`,
          '读取待发布候选版本'
        )).map((row) => toReleaseRecord(row)).filter((row): row is WorkflowSkillReleaseRecord => row !== undefined)
        const candidate = rows[0]
        if (candidate === undefined) {
          abortTx({ ok: false as const, code: 'candidate_not_registered' as const, detail: `${input.skillId}@${String(input.version)} 未登记` })
        }
        if (candidate.state !== 'candidate') {
          abortTx({
            ok: false as const,
            code: 'candidate_state_conflict' as const,
            detail: `候选当前状态是 ${candidate.state}，只有 candidate 能发布`,
          })
        }
        const affected = await exec(
          tx,
          sql`update workflow_skill_releases
                 set state = 'published', updated_at = ${input.now}
               where skill_id = ${input.skillId} and version = ${input.version} and state = 'candidate'
              returning version`,
          '原子发布候选版本'
        )
        if (affected.length === 0) {
          abortTx({ ok: false as const, code: 'candidate_state_conflict' as const, detail: '并发修改：候选状态已被别人改走' })
        }
        const previous = (await exec(
          tx,
          sql`select * from workflow_skill_releases where skill_id = ${input.skillId} and is_current limit 1`,
          '读取旧当前版本'
        )).map((row) => toReleaseRecord(row)).filter((row): row is WorkflowSkillReleaseRecord => row !== undefined)
        const previousVersion = previous[0]?.version ?? null
        if (previousVersion === input.version) {
          abortTx({ ok: false as const, code: 'current_conflict' as const, detail: '目标版本已经是当前版本' })
        }
        if (previousVersion !== null) {
          await exec(
            tx,
            sql`update workflow_skill_releases set is_current = false, updated_at = ${input.now}
                where skill_id = ${input.skillId} and is_current`,
            '清掉旧当前版本'
          )
        }
        await exec(
          tx,
          sql`update workflow_skill_releases set is_current = true, updated_at = ${input.now}
              where skill_id = ${input.skillId} and version = ${input.version}`,
          '切换当前版本到候选'
        )
        await appendEvent(tx, {
          skillId: input.skillId,
          version: input.version,
          fromState: 'candidate',
          toState: 'published',
          action: 'publish',
          reason: input.reason,
          detail: { ...input.proposalDetail, bundleDigest: input.bundle.bundleDigest },
          now: input.now,
        })
        await appendEvent(tx, {
          skillId: input.skillId,
          version: input.version,
          fromState: 'published',
          toState: 'published',
          action: 'set_current',
          reason: input.reason,
          detail: previousVersion === null
            ? { bundleDigest: input.bundle.bundleDigest }
            : { previousVersion, bundleDigest: input.bundle.bundleDigest },
          now: input.now,
        })
        await appendDecisionInTx(tx, {
          skillId: input.skillId,
          version: input.version,
          parentVersion: candidate.predecessorVersion,
          bundleDigest: input.bundle.bundleDigest,
          decision: 'accepted',
          rejectCode: null,
          holdoutSetId: input.bundle.holdout.setId,
          detail: input.proposalDetail,
          decidedAt: input.now,
        })
        return { ok: true as const, previousVersion }
      }))
    },
  }

  /**
   * 包入账（事务内）：摘要/产者先验；`unique (skill_id, version)` 是"每候选一份包"的结构保证。
   *
   * ⚠️ 冲突时**不覆盖**：已记录的那份必须与新给的逐字相同，否则拒绝（`bundle_conflict`）。
   */
  async function recordBundleInTx(
    tx: RawDb,
    bundle: WorkflowSkillVerificationBundle
  ): Promise<WorkflowSkillBundleIntakeResult> {
    const recomputed = computeVerificationBundleDigest({
      bundleVersion: bundle.bundleVersion,
      skillId: bundle.skillId,
      version: bundle.version,
      parentVersion: bundle.parentVersion,
      dev: { ...bundle.dev },
      holdout: { ...bundle.holdout },
      producer: bundle.producer,
    })
    if (recomputed !== bundle.bundleDigest) {
      return { ok: false, code: 'bundle_digest_mismatch', detail: '验证包摘要与内容不一致' }
    }
    if (bundle.producer !== P3_REVISION_HARNESS_PRODUCER) {
      return { ok: false, code: 'bundle_producer_invalid', detail: '验证包产者不是唯一 harness' }
    }
    const stateRows = await exec(
      tx,
      sql`select version, state from workflow_skill_releases
          where skill_id = ${bundle.skillId} and version = ${bundle.version} limit 1`,
      '校验候选是否已登记（验证包入账前置）'
    )
    if (stateRows.length === 0) {
      return {
        ok: false,
        code: 'bundle_candidate_not_registered',
        detail: `${bundle.skillId}@${String(bundle.version)} 未登记，不能为它记录验证包`,
      }
    }
    const existing = await exec(
      tx,
      sql`select bundle_digest from workflow_skill_revision_bundles
          where skill_id = ${bundle.skillId} and version = ${bundle.version} limit 1`,
      '读取已有验证包'
    )
    if (existing.length > 0) {
      const existingDigest = str(existing[0].bundle_digest)
      if (existingDigest === bundle.bundleDigest) return { ok: true, inserted: false }
      return {
        ok: false,
        code: 'bundle_conflict',
        detail: `候选已有另一份验证包（已记录 ${existingDigest.slice(0, 12)}）：每候选只接受一份，重试须新建候选版本`,
      }
    }
    await exec(
      tx,
      sql`insert into workflow_skill_revision_bundles
            (bundle_digest, skill_id, version, parent_version,
             dev_set_id, dev_spec_digest, dev_verdict, dev_checks, dev_failures, dev_report_digest,
             holdout_set_id, holdout_spec_digest, holdout_verdict, holdout_checks, holdout_failures,
             holdout_report_digest, producer, recorded_by, recorded_at)
          values (${bundle.bundleDigest}, ${bundle.skillId}, ${bundle.version}, ${bundle.parentVersion},
                  ${bundle.dev.setId}, ${bundle.dev.specDigest}, ${bundle.dev.verdict},
                  ${bundle.dev.checks}, ${bundle.dev.failures}, ${bundle.dev.reportDigest},
                  ${bundle.holdout.setId}, ${bundle.holdout.specDigest}, ${bundle.holdout.verdict},
                  ${bundle.holdout.checks}, ${bundle.holdout.failures}, ${bundle.holdout.reportDigest},
                  ${bundle.producer}, ${TRUSTED_PUBLISHER_ACTOR}, ${Date.now()})`,
      '记录候选验证包'
    )
    return { ok: true, inserted: true }
  }

  async function appendDecisionInTx(
    tx: RawDb,
    decision: WorkflowSkillRevisionDecisionInput
  ): Promise<void> {
    const decisionId = `skill-revision-decision:${sha256OfDecision(decision)}`
    await exec(
      tx,
      sql`insert into workflow_skill_revision_decisions
            (decision_id, skill_id, version, parent_version, bundle_digest, decision, reject_code,
             holdout_set_id, detail, decided_by, decided_at)
          values (${decisionId}, ${decision.skillId}, ${decision.version}, ${decision.parentVersion},
                  ${decision.bundleDigest}, ${decision.decision}, ${decision.rejectCode},
                  ${decision.holdoutSetId}, ${JSON.stringify(decision.detail)}::jsonb,
                  ${TRUSTED_PUBLISHER_ACTOR}, ${decision.decidedAt})
          on conflict (decision_id) do nothing`,
      '追加候选修订裁定'
    )
  }
}

function sha256OfDecision(decision: WorkflowSkillRevisionDecisionInput): string {
  return sha256Hex(
    `${decision.skillId}@${String(decision.version)}|${decision.decision}|${decision.rejectCode ?? ''}|` +
      `${decision.bundleDigest ?? ''}|${String(decision.decidedAt)}`
  )
}

/** 便于门与装配层：目录资产里某技能（缺省 = 不在目录里的技能）。 */
export function catalogSkillOf(
  catalog: WorkflowSkillCatalog,
  skillId: string
): WorkflowSkillCatalogSkill | undefined {
  return catalog.skills.find((skill) => skill.skillId === skillId)
}

/** 便于门：读到的状态是否是合法闭集值（防御性，不进产品路径）。 */
export function isKnownReleaseState(value: unknown): value is WorkflowSkillReleaseState {
  return typeof value === 'string' && (WORKFLOW_SKILL_RELEASE_STATES as readonly string[]).includes(value)
}
