/**
 * M10.1 WP1 —— **约定识别语料**（正控 + 负控；判据先行）。
 *
 * ============================================================================
 *  两层，**必须分清**（否则会把"程序的结构校验"说成"程序看懂了话"）
 * ============================================================================
 * ```text
 * ① **结构层**（本门的机器判据）：引用解析不到 / 说话者不对 / 顺序反了 / 引用落在遮蔽条目上 /
 *    缺判据 / 超上界 / `dueAt` 缺 `dueBasis` —— 这些由 `validateAgreementDraft` **确定性**判定。
 * ② **语义层**（WP2 的模型门，本门**只登记**）：含糊接受（"嗯"）/ 用户不确定（"可能有空"）/
 *    无可核对判据（"我会一直等你"）—— 程序**没有**词表（`DR-11`），判"这算不算接受"是**模型**的事。
 *    ⇒ 本文件把它们登记成 `expectedKind: 'none'`，并**明确标注**：它们的裁决在 WP2，不在 WP1。
 * ```
 *
 * ⚠️ 纯数据 + 纯函数：不 import 框架 / SQL / `node:*`。
 */

import {
  AGREEMENT_TEXT_MAX_CODEPOINTS,
  type AgreementDraft,
} from '../../src/kernel/contracts/agreement-input.ts'
import type { AgreementRawEntry } from '../../src/kernel/app/agreement/inputs.ts'

/** 语料家族（闭集） */
export const AGREEMENT_CORPUS_FAMILIES = [
  'mutual_agreement',
  'single_party',
  'vague_acceptance',
  'user_uncertain',
  'no_criterion',
  'structural_broken_citation',
] as const
export type AgreementCorpusFamily = (typeof AGREEMENT_CORPUS_FAMILIES)[number]

/** 每条语料的**预期裁决**（`accepted` = 结构校验通过；`rejected` = 带具名理由） */
export interface AgreementCorpusItem {
  readonly caseId: string
  readonly family: AgreementCorpusFamily
  /** 结构层（本门判）还是语义层（WP2 判） */
  readonly layer: 'structural' | 'semantic'
  readonly note: string
  readonly window: readonly AgreementRawEntry[]
  readonly draft: AgreementDraft
  readonly expected:
    | { readonly kind: 'accepted' }
    | { readonly kind: 'rejected'; readonly reason: string }
  /** 语义层条目的预期（**只登记**，由 WP2 的模型门裁决） */
  readonly expectedKindForModel?: 'none' | 'mutual_agreement'
}

const she = (sequence: number, text: string): AgreementRawEntry => ({
  id: `cev:char:${String(sequence)}`,
  actorType: 'character',
  sequence,
  text,
})
const user = (sequence: number, text: string): AgreementRawEntry => ({
  id: `cev:user:${String(sequence)}`,
  actorType: 'user',
  sequence,
  text,
})

/** 正控：双方合意（三种形状：时间+地点 / 只有时间 / 只有动作） */
const positives: readonly AgreementCorpusItem[] = [
  {
    caseId: 'pos-time-place',
    family: 'mutual_agreement',
    layer: 'structural',
    note: '她定了时间地点，用户明确接受',
    window: [she(1, '明天十点二十五，楼下。'), user(2, '好的，一定到。')],
    draft: {
      kind: 'mutual_agreement',
      content: '明天十点二十五在楼下见',
      criterion: '他十点二十五出现在楼下',
      dueAt: '2026-10-02T10:25:00+08:00',
      dueBasis: '用户说"明天"，当天为 10-01；时区 +08:00',
      proposedByEventId: 'cev:char:1',
      acceptedByEventId: 'cev:user:2',
    },
    expected: { kind: 'accepted' },
  },
  {
    caseId: 'pos-time-only',
    family: 'mutual_agreement',
    layer: 'structural',
    note: '只有时间、没有地点（仍然可核对）',
    window: [she(3, '明早八点半叫我起来。'), user(4, '行，我定闹钟。')],
    draft: {
      kind: 'mutual_agreement',
      content: '明早八点半叫她起来',
      criterion: '他八点半之前发来消息',
      dueBasis: '用户说"明早"，当天为 10-01（未解析到具体时点 ⇒ 无截止）',
      proposedByEventId: 'cev:char:3',
      acceptedByEventId: 'cev:user:4',
    },
    expected: { kind: 'accepted' },
  },
  {
    caseId: 'pos-action-only',
    family: 'mutual_agreement',
    layer: 'structural',
    note: '只有动作与判据（无时间）',
    window: [she(5, '把那篇稿子先发我看一眼再投。'), user(6, '好，投之前先给你看。')],
    draft: {
      kind: 'mutual_agreement',
      content: '投稿前先把稿子发给她看',
      criterion: '他投稿前发来稿子',
      proposedByEventId: 'cev:char:5',
      acceptedByEventId: 'cev:user:6',
    },
    expected: { kind: 'accepted' },
  },
  {
    /*
     * ⚠️ **`D03` 修订（2026-10-01 用户裁定 (b)）**：这条以前是**负控**
     *    （`neg-proposal-not-character`，预期 `proposal_not_character`），
     *    现在改成**正控** —— 用户提出、她接受，同样是双方合意。
     */
    caseId: 'pos-user-proposes',
    family: 'mutual_agreement',
    layer: 'structural',
    note: '**用户提出 + 她接受**（`D03` 修订后算合意）',
    window: [user(7, '明天十点二十五楼下见吧。'), she(8, '行。')],
    draft: {
      kind: 'mutual_agreement',
      content: '明天十点二十五在楼下见',
      criterion: '两人十点二十五都在楼下',
      dueBasis: '用户说"明天"，当天为 10-01（未解析到具体时点 ⇒ 无截止）',
      proposedByEventId: 'cev:user:7',
      acceptedByEventId: 'cev:char:8',
    },
    expected: { kind: 'accepted' },
  },
]

/** 负控·结构层（程序**确定性**判定，本门逐条断言具名理由） */
const structuralNegatives: readonly AgreementCorpusItem[] = [
  {
    caseId: 'neg-proposal-not-found',
    family: 'structural_broken_citation',
    layer: 'structural',
    note: '提出那条引用**在窗口里不存在**（编造 id）',
    window: [she(1, '明天十点二十五，楼下。'), user(2, '好的。')],
    draft: {
      kind: 'mutual_agreement',
      content: '明天见',
      criterion: '他到场',
      proposedByEventId: 'cev:char:999',
      acceptedByEventId: 'cev:user:2',
    },
    expected: { kind: 'rejected', reason: 'proposal_not_found' },
  },
  {
    caseId: 'neg-acceptance-not-found',
    family: 'single_party',
    layer: 'structural',
    note: '**单方陈述**：她定了，用户没有接受（窗口里没有 user 消息）',
    window: [she(1, '明天十点二十五，楼下。'), she(2, '别迟到。')],
    draft: {
      kind: 'mutual_agreement',
      content: '明天见',
      criterion: '他到场',
      proposedByEventId: 'cev:char:1',
      acceptedByEventId: 'cev:user:2',
    },
    expected: { kind: 'rejected', reason: 'acceptance_not_found' },
  },
  {
    caseId: 'neg-acceptance-not-user',
    family: 'structural_broken_citation',
    layer: 'structural',
    note: '被当成"接受"的那条其实是她自己说的 ⇒ **同一个说话者**（`D03` 修订后按 `same_party` 判）',
    window: [she(1, '明天十点二十五，楼下。'), she(2, '那就这么定。')],
    draft: {
      kind: 'mutual_agreement',
      content: '明天见',
      criterion: '他到场',
      proposedByEventId: 'cev:char:1',
      acceptedByEventId: 'cev:char:2',
    },
    expected: { kind: 'rejected', reason: 'same_party' },
  },
  {
    /*
     * ⚠️ 这条**保留为负控**：提出与接受是**同一个人（都是用户）** ⇒ `same_party`。
     *    （`D03` 修订前它按 `proposal_not_character` 判；修订后提出者可以是任一方，
     *     但"同一方自说自话"仍然不是合意 ⇒ 理由改成 `same_party`。）
     */
    caseId: 'neg-same-party-user',
    family: 'structural_broken_citation',
    layer: 'structural',
    note: '**同一个人（都是用户）**既提出又接受 ⇒ 不是合意',
    window: [user(1, '明天十点二十五楼下见吧。'), user(2, '行，就这么定。')],
    draft: {
      kind: 'mutual_agreement',
      content: '明天见',
      criterion: '他到场',
      proposedByEventId: 'cev:user:1',
      acceptedByEventId: 'cev:user:2',
    },
    expected: { kind: 'rejected', reason: 'same_party' },
  },
  {
    caseId: 'neg-same-party',
    family: 'structural_broken_citation',
    layer: 'structural',
    note: '**同一个说话者**既"提出"又"接受"（自说自话，不是合意）—— `D03` 修订后的核心负控',
    window: [she(1, '明天十点二十五，楼下。'), she(2, '那就这么定。')],
    draft: {
      kind: 'mutual_agreement',
      content: '明天见',
      criterion: '他到场',
      proposedByEventId: 'cev:char:1',
      acceptedByEventId: 'cev:char:2',
    },
    expected: { kind: 'rejected', reason: 'same_party' },
  },
  {
    caseId: 'neg-order-inverted',
    family: 'structural_broken_citation',
    layer: 'structural',
    note: '接受在提出**之前**（顺序反了）',
    window: [user(1, '好的。'), she(2, '明天十点二十五，楼下。')],
    draft: {
      kind: 'mutual_agreement',
      content: '明天见',
      criterion: '他到场',
      proposedByEventId: 'cev:char:2',
      acceptedByEventId: 'cev:user:1',
    },
    expected: { kind: 'rejected', reason: 'order_inverted' },
  },
  {
    caseId: 'neg-citation-masked',
    family: 'structural_broken_citation',
    layer: 'structural',
    note: '引用落在**被遮蔽**的条目上（看不到内容就不能当依据）',
    window: [
      { id: 'cev:char:1', actorType: 'character', sequence: 1, text: 'x'.repeat(AGREEMENT_TEXT_MAX_CODEPOINTS + 1) },
      user(2, '好的。'),
    ],
    draft: {
      kind: 'mutual_agreement',
      content: '明天见',
      criterion: '他到场',
      proposedByEventId: 'cev:char:1',
      acceptedByEventId: 'cev:user:2',
    },
    expected: { kind: 'rejected', reason: 'citation_masked' },
  },
  {
    caseId: 'neg-missing-criterion',
    family: 'no_criterion',
    layer: 'structural',
    note: '**没有可核对判据**（`D03` 要求可核对）',
    window: [she(1, '明天十点二十五，楼下。'), user(2, '好。')],
    draft: {
      kind: 'mutual_agreement',
      content: '明天见',
      criterion: '   ',
      proposedByEventId: 'cev:char:1',
      acceptedByEventId: 'cev:user:2',
    },
    expected: { kind: 'rejected', reason: 'missing_criterion' },
  },
  {
    caseId: 'neg-missing-content',
    family: 'structural_broken_citation',
    layer: 'structural',
    note: '没有给出约定内容',
    window: [she(1, '明天十点二十五，楼下。'), user(2, '好。')],
    draft: {
      kind: 'mutual_agreement',
      content: '',
      criterion: '他到场',
      proposedByEventId: 'cev:char:1',
      acceptedByEventId: 'cev:user:2',
    },
    expected: { kind: 'rejected', reason: 'missing_content' },
  },
  {
    caseId: 'neg-due-basis-missing',
    family: 'structural_broken_citation',
    layer: 'structural',
    note: '`dueAt` 有值但**没有** `dueBasis`（`D06`：不猜日期）',
    window: [she(1, '明天十点二十五，楼下。'), user(2, '好。')],
    draft: {
      kind: 'mutual_agreement',
      content: '明天见',
      criterion: '他到场',
      dueAt: '2026-10-02T10:25:00+08:00',
      proposedByEventId: 'cev:char:1',
      acceptedByEventId: 'cev:user:2',
    },
    expected: { kind: 'rejected', reason: 'due_basis_missing' },
  },
  {
    caseId: 'neg-content-too-long',
    family: 'structural_broken_citation',
    layer: 'structural',
    note: '约定内容超上界（200 码点）',
    window: [she(1, '明天十点二十五，楼下。'), user(2, '好。')],
    draft: {
      kind: 'mutual_agreement',
      content: '内'.repeat(201),
      criterion: '他到场',
      proposedByEventId: 'cev:char:1',
      acceptedByEventId: 'cev:user:2',
    },
    expected: { kind: 'rejected', reason: 'content_too_long' },
  },
]

/** 负控·语义层（**只登记**；裁决在 WP2 的模型门） */
const semanticNegatives: readonly AgreementCorpusItem[] = [
  {
    caseId: 'sem-vague-acceptance',
    family: 'vague_acceptance',
    layer: 'semantic',
    note: '含糊接受（"嗯"）—— 程序**没有**词表，判"算不算接受"是模型的事（`D04`）',
    window: [she(1, '明天十点二十五，楼下。'), user(2, '嗯。')],
    draft: { kind: 'none' },
    expected: { kind: 'rejected', reason: 'no_agreement' },
    expectedKindForModel: 'none',
  },
  {
    caseId: 'sem-user-uncertain',
    family: 'user_uncertain',
    layer: 'semantic',
    note: '用户不确定（"可能有空"）—— 不是接受',
    window: [she(1, '明天十点二十五，楼下。'), user(2, '明天我可能有空吧。')],
    draft: { kind: 'none' },
    expected: { kind: 'rejected', reason: 'no_agreement' },
    expectedKindForModel: 'none',
  },
  {
    caseId: 'sem-no-criterion',
    family: 'no_criterion',
    layer: 'semantic',
    note: '无可核对判据（"我会一直等你"）—— 不是可核对的约定',
    window: [she(1, '我会一直等你。'), user(2, '好。')],
    draft: { kind: 'none' },
    expected: { kind: 'rejected', reason: 'no_agreement' },
    expectedKindForModel: 'none',
  },
  {
    caseId: 'sem-topic-change',
    family: 'vague_acceptance',
    layer: 'semantic',
    note: '用户换了话题（没回应约定）',
    window: [she(1, '明天十点二十五，楼下。'), user(2, '对了，国庆你干嘛去了？')],
    draft: { kind: 'none' },
    expected: { kind: 'rejected', reason: 'no_agreement' },
    expectedKindForModel: 'none',
  },
]

export function buildAgreementCorpus(): readonly AgreementCorpusItem[] {
  return [...positives, ...structuralNegatives, ...semanticNegatives]
}
