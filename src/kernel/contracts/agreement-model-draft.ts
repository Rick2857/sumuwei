/**
 * M10.1 WP2b —— **模型面**的约定草案 + 严格校验（慢路径识别的入口）。
 *
 * ============================================================================
 *  为什么要有这一层（而不是把窗口直接交给 `validateAgreementDraft`）
 * ============================================================================
 * ```text
 * WP1 的 `AgreementDraft` 用**事件 id** 指出处（`proposedByEventId` / `acceptedByEventId`），
 * 而窗口渲染给模型的是 `[序号] 说话者：正文` —— **没有 id**（id 是长 UUID，印 50 行既没用
 * 又正好是模型抄错的地方）。
 * ⇒ 模型只说**序号**，**程序**把序号解析回事件 id（`resolveSeq`）。
 *   这与目标域的 `targetGoalId` 必须来自程序给的候选**同一条纪律**：
 *   "指得到出处"在**形状上**成立，模型没有编造 id 的空间。
 * ⇒ 本模块是那条解析 + 形状闸；**语义**（同一方、顺序、遮蔽、上界）仍由 WP1 的
 *   `validateAgreementDraft` 判 —— 一处实现，不复制。
 * ```
 *
 * ⚠️ 纯契约 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟。
 */

import {
  validateAgreementDraft,
  type AcceptedAgreement,
  type AgreementDraft,
  type AgreementRejectReason,
  type AgreementWindowInput,
} from './agreement-input.ts'

/** 草案 schema 版本（改形状必须升版本） */
export const AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION = 'agreement-draft@1'

/** 模型可产出的 **kind 闭集**（`none` = "这一段里没有约定"） */
export const AGREEMENT_MODEL_DRAFT_KINDS = ['mutual_agreement', 'none'] as const
export type AgreementModelDraftKind = (typeof AGREEMENT_MODEL_DRAFT_KINDS)[number]

/** 模型面的字段闭集（**只有**这些；不该带的带了 = 拒绝） */
export const AGREEMENT_MODEL_DRAFT_FIELDS = [
  'schemaVersion',
  'kind',
  'content',
  'criterion',
  'dueBasis',
  'proposedBySeq',
  'acceptedBySeq',
] as const

/**
 * 模型面的草案。
 *
 * ⚠️ **没有 id 字段**（`proposedByEventId` 等）：模型只能给**窗口里的序号**。
 * ⚠️ **没有 `dueAt`**：不猜绝对时刻；相对口径用 `dueBasis`（人话），
 *    绝对时刻由请求侧自己说清（`U-04` 的边界照旧）。
 */
export interface AgreementModelDraft {
  readonly schemaVersion: string
  readonly kind: AgreementModelDraftKind
  readonly content?: string
  readonly criterion?: string
  readonly dueBasis?: string
  readonly proposedBySeq?: number
  readonly acceptedBySeq?: number
}

/**
 * **形状层**的具名拒绝理由（语义层的理由来自 WP1，见 `AgreementRecognitionReason`）。
 *
 * ⚠️ 具名是判据的一部分：门要能断言"**因为哪一条**被拒"。
 */
export const AGREEMENT_MODEL_REJECT_REASONS = [
  'not_an_object',
  'schema_version_missing_or_unknown',
  'kind_missing_or_unknown',
  'unknown_field',
  'citation_missing',
  'citation_not_in_window',
] as const
export type AgreementModelRejectReason = (typeof AGREEMENT_MODEL_REJECT_REASONS)[number]

/** 识别层的**全部**具名理由（形状 ∪ 语义） */
export const AGREEMENT_RECOGNITION_REASONS = [
  ...AGREEMENT_MODEL_REJECT_REASONS,
  ...([
    'no_agreement',
    'missing_content',
    'missing_criterion',
    'content_too_long',
    'criterion_too_long',
    'proposal_not_found',
    'acceptance_not_found',
    'same_party',
    'order_inverted',
    'citation_masked',
    'due_basis_missing',
    'due_basis_too_long',
  ] as const satisfies readonly AgreementRejectReason[]),
] as const
export type AgreementRecognitionReason =
  | AgreementModelRejectReason
  | AgreementRejectReason

export type AgreementRecognition =
  | { readonly ok: true; readonly agreement: AcceptedAgreement }
  | { readonly ok: false; readonly reason: AgreementRecognitionReason; readonly detail: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 把**模型原文**解析成成形约定（或具名拒绝）。
 *
 * ```text
 * ① 形状闸：对象 · `schemaVersion` 相符 · 字段闭集 · `kind` 在闭集里
 * ② `kind === 'none'` ⇒ `no_agreement`（**不是错误**：这一段里没有约定）
 * ③ 序号 ⇒ 事件 id（**只能**从窗口里解析，超出即 `citation_not_in_window`）
 * ④ 语义 ⇒ 交给 WP1 的 `validateAgreementDraft`（一处实现）
 * ```
 */
export function recognizeAgreement(
  raw: unknown,
  window: AgreementWindowInput
): AgreementRecognition {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'not_an_object', detail: '草案必须是 JSON 对象' }
  }
  if (raw.schemaVersion !== AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'schema_version_missing_or_unknown',
      detail: `schemaVersion 必须是 ${AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION}（收到 ${JSON.stringify(raw.schemaVersion)}）`,
    }
  }
  for (const key of Object.keys(raw)) {
    if (!(AGREEMENT_MODEL_DRAFT_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, reason: 'unknown_field', detail: `闭集外的字段：${key}` }
    }
  }
  if (!(AGREEMENT_MODEL_DRAFT_KINDS as readonly string[]).includes(String(raw.kind))) {
    return {
      ok: false,
      reason: 'kind_missing_or_unknown',
      detail: `kind 必须是 ${AGREEMENT_MODEL_DRAFT_KINDS.join(' / ')}（收到 ${JSON.stringify(raw.kind)}）`,
    }
  }
  if (raw.kind === 'none') {
    return { ok: false, reason: 'no_agreement', detail: '模型判定这一段里没有双方合意的约定' }
  }

  const proposedBySeq = raw.proposedBySeq
  const acceptedBySeq = raw.acceptedBySeq
  if (
    typeof proposedBySeq !== 'number' ||
    typeof acceptedBySeq !== 'number' ||
    !Number.isInteger(proposedBySeq) ||
    !Number.isInteger(acceptedBySeq)
  ) {
    return {
      ok: false,
      reason: 'citation_missing',
      detail: '必须给出 `proposedBySeq` 与 `acceptedBySeq`（**窗口里的序号**，双方各一条）',
    }
  }
  const proposeEntry = window.entries.find((entry) => entry.sequence === proposedBySeq)
  const acceptEntry = window.entries.find((entry) => entry.sequence === acceptedBySeq)
  if (proposeEntry === undefined || acceptEntry === undefined) {
    return {
      ok: false,
      reason: 'citation_not_in_window',
      detail:
        `序号解析不到：提出 #${String(proposedBySeq)}=${String(proposeEntry !== undefined)} · ` +
        `接受 #${String(acceptedBySeq)}=${String(acceptEntry !== undefined)}（**指不到出处就不写**）`,
    }
  }

  const draft: AgreementDraft = {
    kind: 'mutual_agreement',
    content: typeof raw.content === 'string' ? raw.content : undefined,
    criterion: typeof raw.criterion === 'string' ? raw.criterion : undefined,
    dueBasis: typeof raw.dueBasis === 'string' ? raw.dueBasis : undefined,
    proposedByEventId: proposeEntry.id,
    acceptedByEventId: acceptEntry.id,
  }
  const verdict = validateAgreementDraft(draft, window)
  return verdict.ok
    ? { ok: true, agreement: verdict.value }
    : { ok: false, reason: verdict.reason, detail: verdict.detail }
}
