/**
 * M10.1 WP1 —— **约定识别契约**（有界输入 / 有界输出 / 严格校验 / 必须给出处）。
 *
 * ============================================================================
 *  它守什么（ADR-086 的 `D03`/`D04`/`D06`）
 * ============================================================================
 * ```text
 * ① **双方合意才算**（`D03`）：她**提出**（character 消息）+ 用户**明确接受**（user 消息），
 *    两条都要**指得到具体对话事件**。单方陈述、含糊接受、用户不确定 ⇒ **不写**。
 * ② **必须给出处**（`D04`）：草稿里的两个引用必须**能在窗口里解析**；解析不到 ⇒ 不写（失败关闭）。
 *    ⚠️ 程序**不**用词表判"接受"（`DR-11`）：判定由模型做，程序只做**结构 + 出处**的严格校验。
 * ③ **时间不猜**（`D06`）：`dueAt` 有值 ⇒ `dueBasis` 必须有值；解析不到具体时点 ⇒ 记为**无截止**
 *    （`dueBasis` 可以单独存在，表示"提到了时间但没解析成时点"）。
 * ④ **有界**：窗口 ≤ `AGREEMENT_MAX_WINDOW_INPUTS` · 每条正文 ≤ `AGREEMENT_TEXT_MAX_CODEPOINTS`
 *    （超出**不截断后假装看全**，而是把该条**遮蔽**）。
 * ⑤ **遮蔽是一个事实**：被遮蔽条目的正文恒为 `AGREEMENT_MASKED_TEXT`（**不是空串** ——
 *    空串与"这条本来就是空的"无法区分）。
 * ```
 *
 * ⚠️ 纯契约 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 */

/** 窗口条目上限（与 M11 同量级；超出留在下一次触发，不截断后假装看全） */
export const AGREEMENT_MAX_WINDOW_INPUTS = 50

/** 每条窗口条目的正文上界（**码点**） */
export const AGREEMENT_TEXT_MAX_CODEPOINTS = 300

/** 被遮蔽条目的**唯一**正文形态 */
export const AGREEMENT_MASKED_TEXT = '[已遮蔽]'

/** 约定内容 / 判据 / 时间依据的上界（码点） */
export const AGREEMENT_CONTENT_MAX_CODEPOINTS = 200
export const AGREEMENT_CRITERION_MAX_CODEPOINTS = 200
export const AGREEMENT_DUE_BASIS_MAX_CODEPOINTS = 120

/** 引用上限（提出 + 接受 + 至多两条旁证） */
export const AGREEMENT_CITATIONS_MAX = 4

/** 说话者（**闭集**；窗口装配时由程序分类，不让模型自己归类） */
export type AgreementActorType = 'character' | 'user'

/** 窗口里的一条（**已装配**：正文已被有界化或遮蔽） */
export interface AgreementWindowEntry {
  readonly id: string
  readonly actorType: AgreementActorType
  readonly sequence: number
  readonly text: string
  /** 这一条是否被遮蔽（遮蔽是**一个事实**，可查） */
  readonly masked: boolean
}

/** 窗口的程序读数（**给模型的事实**，不是让它自己数） */
export interface AgreementWindowFacts {
  readonly entryCount: number
  readonly characterCount: number
  readonly userCount: number
  /** 窗口是否被截断（超出上限时 true ⇒ 本次**不**下结论，留给下一次触发） */
  readonly windowTruncated: boolean
}

/** 有界窗口输入（模型唯一能看到的东西） */
export interface AgreementWindowInput {
  readonly entries: readonly AgreementWindowEntry[]
  readonly facts: AgreementWindowFacts
}

/** 草稿（模型输出；**只有**这两种 kind） */
export interface AgreementDraft {
  readonly kind: 'mutual_agreement' | 'none'
  readonly content?: string
  readonly criterion?: string
  readonly dueAt?: string
  readonly dueBasis?: string
  /**
   * 提出那一条的对话事件 id。
   *
   * ⚠️ **`D03` 修订（2026-10-01 用户裁定 (b)）**：提出者可以是**任一方** ——
   *    她提出、用户接受，或**用户提出、她接受**，都算双方合意。
   *    （修订前字段叫 `proposedByCharacterEventId`，只认"她提出"。）
   */
  readonly proposedByEventId?: string
  /** 接受那一条的对话事件 id（**必须是另一方**，与提出者不同说话者） */
  readonly acceptedByEventId?: string
}

/**
 * **具名拒绝理由**（闭集）。
 *
 * ⚠️ 具名是判据的一部分：门要能断言"**因为哪一条**被拒"，而不是只看"被拒了"。
 * ⚠️ **`D03` 修订（2026-10-01）**：`proposal_not_character` / `acceptance_not_user` **已移除**
 *    （提出者不再必须是"她"），改由 **`same_party`** 表达"提出与接受是同一个说话者 ⇒ 不是合意"。
 *    判据变更的前后读数都留在 `M10.1-WP1-Handoff.md`（旧读数不回写）。
 */
export const AGREEMENT_REJECT_REASONS = [
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
] as const
export type AgreementRejectReason = (typeof AGREEMENT_REJECT_REASONS)[number]

/** 通过校验后的**成形**约定（WP2 才把它变成承诺提案） */
export interface AcceptedAgreement {
  readonly content: string
  readonly criterion: string
  readonly proposedByEventId: string
  readonly proposedBy: AgreementActorType
  readonly acceptedByEventId: string
  readonly acceptedBy: AgreementActorType
  /** 解析到具体时点才有；否则 undefined（**不猜**） */
  readonly dueAt?: string
  readonly dueBasis?: string
}

export type AgreementValidation =
  | { readonly ok: true; readonly value: AcceptedAgreement }
  | { readonly ok: false; readonly reason: AgreementRejectReason; readonly detail: string }

/** 码点数（**不**用 `.length`：UTF-16 长度会把 emoji 与部分汉字算错） */
export function codepointLength(text: string): number {
  return [...text].length
}

/** 有界正文：超上限 ⇒ 返回 undefined（调用方据此**遮蔽**，而不是截断后假装看全） */
export function boundedAgreementText(text: string, max: number): string | undefined {
  return codepointLength(text) > max ? undefined : text
}

/**
 * **严格校验**（纯函数；`D03`/`D04`/`D06` 的全部结构判据都在这里）。
 *
 * ⚠️ 它**不**判断"这句话算不算接受"（那是模型的事，且程序**没有**词表）——
 *    它只判断：形状对不对 · 引用能不能解析 · 说话者对不对 · 顺序对不对 · 时间有没有依据。
 */
export function validateAgreementDraft(
  draft: AgreementDraft,
  window: AgreementWindowInput
): AgreementValidation {
  if (draft.kind === 'none') {
    return { ok: false, reason: 'no_agreement', detail: '模型判定这不是一条双方合意的约定' }
  }

  const content = draft.content?.trim() ?? ''
  if (content === '') return { ok: false, reason: 'missing_content', detail: '没有给出约定内容' }
  if (codepointLength(content) > AGREEMENT_CONTENT_MAX_CODEPOINTS) {
    return {
      ok: false,
      reason: 'content_too_long',
      detail: `约定内容 ${String(codepointLength(content))} 码点 > 上限 ${String(AGREEMENT_CONTENT_MAX_CODEPOINTS)}`,
    }
  }

  const criterion = draft.criterion?.trim() ?? ''
  if (criterion === '') {
    return { ok: false, reason: 'missing_criterion', detail: '没有给出**可核对**的判据（`D03` 要求可核对）' }
  }
  if (codepointLength(criterion) > AGREEMENT_CRITERION_MAX_CODEPOINTS) {
    return {
      ok: false,
      reason: 'criterion_too_long',
      detail: `判据 ${String(codepointLength(criterion))} 码点 > 上限 ${String(AGREEMENT_CRITERION_MAX_CODEPOINTS)}`,
    }
  }

  const proposal = window.entries.find((entry) => entry.id === draft.proposedByEventId)
  if (proposal === undefined) {
    return {
      ok: false,
      reason: 'proposal_not_found',
      detail: `提出那条引用解析不到：${String(draft.proposedByEventId)}（**指不到出处就不写**）`,
    }
  }
  const acceptance = window.entries.find((entry) => entry.id === draft.acceptedByEventId)
  if (acceptance === undefined) {
    return {
      ok: false,
      reason: 'acceptance_not_found',
      detail: `接受那条引用解析不到：${String(draft.acceptedByEventId)}（单方陈述不算约定）`,
    }
  }
  /*
   * ⚠️ **`D03` 修订（用户裁定 (b)）**：提出者可以是**任一方**；
   *    但**提出与接受必须是不同说话者** —— 同一个人自说自话不是合意。
   */
  if (proposal.actorType === acceptance.actorType) {
    return {
      ok: false,
      reason: 'same_party',
      detail: `提出与接受是**同一个说话者**（都是 ${proposal.actorType}）⇒ 不是双方合意`,
    }
  }
  if (proposal.sequence >= acceptance.sequence) {
    return {
      ok: false,
      reason: 'order_inverted',
      detail: `顺序反了：提出 #${String(proposal.sequence)} 不早于接受 #${String(acceptance.sequence)}`,
    }
  }
  if (proposal.masked || acceptance.masked) {
    return {
      ok: false,
      reason: 'citation_masked',
      detail: '引用落在**被遮蔽**的条目上 ⇒ 不写（看不到内容就不能当依据）',
    }
  }

  const dueBasis = draft.dueBasis?.trim()
  if (dueBasis !== undefined && codepointLength(dueBasis) > AGREEMENT_DUE_BASIS_MAX_CODEPOINTS) {
    return {
      ok: false,
      reason: 'due_basis_too_long',
      detail: `时间依据 ${String(codepointLength(dueBasis))} 码点 > 上限 ${String(AGREEMENT_DUE_BASIS_MAX_CODEPOINTS)}`,
    }
  }
  const dueAt = draft.dueAt?.trim()
  if (dueAt !== undefined && dueAt !== '' && (dueBasis === undefined || dueBasis === '')) {
    return {
      ok: false,
      reason: 'due_basis_missing',
      detail: '`dueAt` 有值但**没有** `dueBasis` —— `D06`：有截止必须有解析依据（不猜日期）',
    }
  }

  return {
    ok: true,
    value: {
      content,
      criterion,
      proposedByEventId: proposal.id,
      proposedBy: proposal.actorType,
      acceptedByEventId: acceptance.id,
      acceptedBy: acceptance.actorType,
      ...(dueAt === undefined || dueAt === '' ? {} : { dueAt }),
      ...(dueBasis === undefined || dueBasis === '' ? {} : { dueBasis }),
    },
  }
}
