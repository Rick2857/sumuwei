/**
 * M10.1 WP1 —— **约定窗口装配**（有界 + 遮蔽**先于**注入）。
 *
 * ============================================================================
 *  纪律（与 M11 的 `app/reflection/inputs.ts` 同源）
 * ============================================================================
 * ```text
 * ① **有界**：只取最近 `AGREEMENT_MAX_WINDOW_INPUTS` 条；**超出 ⇒ `windowTruncated=true`
 *    且本次不下结论**（留给下一次触发）——不截断后假装看全。
 * ② **遮蔽先于注入**：正文超上限 / 内容不可用 ⇒ 该条正文变成 `AGREEMENT_MASKED_TEXT`，
 *    并且 `masked=true`（**可查**）。校验层对"引用落在遮蔽条目上"直接拒绝（`citation_masked`）。
 * ③ **说话者由程序分列**：`character` / `user` 两类在装配时分好，**不让模型自己归类**。
 * ④ **不读时钟**：时间只从传入的读数来（`now` 由调用方给），本模块是纯函数。
 * ```
 *
 * ⚠️ 纯函数：不 import 框架 / SQL / `node:*`，无副作用。
 */

import {
  AGREEMENT_MAX_WINDOW_INPUTS,
  AGREEMENT_MASKED_TEXT,
  AGREEMENT_TEXT_MAX_CODEPOINTS,
  boundedAgreementText,
  type AgreementActorType,
  type AgreementWindowEntry,
  type AgreementWindowInput,
} from '../../contracts/agreement-input.ts'

/** 装配层的**原始**读数（来自账本；正文可能很长，也可能标记为不可用） */
export interface AgreementRawEntry {
  readonly id: string
  readonly actorType: string
  readonly sequence: number
  readonly text: string
  /** 内容不可用（例如被撤回 / 被遗忘 / 无正文）⇒ 直接遮蔽，**不**进模型 */
  readonly contentUnavailable?: boolean
}

export interface AssembleAgreementWindowInput {
  readonly entries: readonly AgreementRawEntry[]
  /** 只保留**本角色**的对话（调用方已按 characterId 过滤） */
  readonly limit?: number
}

/** 说话者归一化：只认两类；别的（system/tool/未知）**不进窗口** */
function normalizeActorType(value: string): AgreementActorType | undefined {
  if (value === 'character' || value === 'assistant') return 'character'
  if (value === 'user') return 'user'
  return undefined
}

/**
 * 装配有界窗口。
 *
 * ⚠️ **顺序**：先按 sequence 升序 → 只认两类说话者 → 取**最近** N 条 → 再逐条有界化/遮蔽。
 *    "取最近 N 条"必须在**有界化之前**，否则长正文会把窗口挤空（读数会失真）。
 */
export function assembleAgreementWindow(input: AssembleAgreementWindowInput): AgreementWindowInput {
  const limit = input.limit ?? AGREEMENT_MAX_WINDOW_INPUTS
  const usable = input.entries
    .filter((entry) => normalizeActorType(entry.actorType) !== undefined)
    .slice()
    .sort((left, right) => left.sequence - right.sequence)

  const windowTruncated = usable.length > limit
  const recent = usable.slice(-limit)

  const entries: AgreementWindowEntry[] = recent.map((entry) => {
    const actorType = normalizeActorType(entry.actorType)!
    if (entry.contentUnavailable === true) {
      return { id: entry.id, actorType, sequence: entry.sequence, text: AGREEMENT_MASKED_TEXT, masked: true }
    }
    const bounded = boundedAgreementText(entry.text, AGREEMENT_TEXT_MAX_CODEPOINTS)
    if (bounded === undefined) {
      // 超上限 ⇒ **遮蔽**（不是截断后假装看全）
      return { id: entry.id, actorType, sequence: entry.sequence, text: AGREEMENT_MASKED_TEXT, masked: true }
    }
    return { id: entry.id, actorType, sequence: entry.sequence, text: bounded, masked: false }
  })

  return {
    entries,
    facts: {
      entryCount: entries.length,
      characterCount: entries.filter((entry) => entry.actorType === 'character').length,
      userCount: entries.filter((entry) => entry.actorType === 'user').length,
      windowTruncated,
    },
  }
}

/**
 * 渲染成**给模型的一段文本**（程序渲染；模型只读这段，不自己找）。
 *
 * ⚠️ 每条前面带**程序给的编号与说话者**：模型引用时用这个编号，程序据此解析回事件 id
 *    ⇒ "指得到出处"在形状上就成立（模型没有编造 id 的空间）。
 */
export function renderAgreementWindow(window: AgreementWindowInput): string {
  return window.entries
    .map((entry) => {
      const speaker = entry.actorType === 'character' ? '她' : '用户'
      return `[${String(entry.sequence)}] ${speaker}：${entry.text}`
    })
    .join('\n')
}
