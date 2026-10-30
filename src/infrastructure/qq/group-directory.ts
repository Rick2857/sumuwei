/**
 * QQ 群目标**消歧**（post-Lv2 / 群任务 P2.1-A）—— 纯函数，零 I/O、零网络、零数据库。
 *
 * ============================================================================
 *  ⚠️ 这是**消歧**（disambiguation），不是**授权**（authorization）
 * ============================================================================
 * ```text
 * 本模块只回答一个问题：
 *   "主人说的这个群，在机器人**当前可见**的群列表里对应哪个群号？"
 *
 * 它**不**读 `allowedGroupIds`、**不**读 `multiUserEnabled`、**不**查成员身份、
 * **不**做任何放行/拒绝决定、**不**发任何消息、**不**联网。
 *
 * 解析出来的群号**仍然**要过任务授权（持久层任务事实 + 原子额度预留）与准入判定；
 * "解析成功" **不等于** "可以发" —— 恰恰相反，解析只是把"人话"换成"群号"，
 * 能不能发由授权链单独决定。
 * ```
 *
 * ============================================================================
 *  规则（**不许猜**）
 * ============================================================================
 * ```text
 * ① 给了群号：
 *      该群号在列表里                 ⇒ resolved（群名取自列表，不采信提示里的名字）
 *      该群号不在列表里               ⇒ not_found
 *        ⚠️ 不推断"机器人可能没在群"以外的任何结论，也不改判成"按名字找找看"
 * ② 只给名字：
 *      先**精确同名**（trim + 全等，不做别的归一）
 *        唯一 ⇒ resolved / 多个 ⇒ ambiguous（候选按群号升序）
 *      没有精确同名时**才**退到"去空白后包含"（群名去空白 ⊇ 提示去空白）
 *        唯一 ⇒ resolved / 多个 ⇒ ambiguous / 零 ⇒ not_found
 * ③ 空提示（群号与名字都没给 / 给了全是空白）   ⇒ invalid `group_hint_empty`
 *    群号与名字**互相矛盾**（都给了，但名字不指向该群号那个群）
 *                                                 ⇒ invalid `group_hint_conflict`
 * ④ 输入上限：提示名字 ≤ 64 个**码点**；超过 ⇒ invalid `group_hint_name_too_long`
 *    （不截断后继续匹配 —— 截断会让"消歧"变成"猜"）
 * ```
 *
 * ⚠️ 本模块**假设** `groups` 已经过 `OneBotPrivateClient.listGroups()` 清理
 *    （群号过 `qqId`、群名 trim 且有界）。为防御重复校验，这里匹配时**再**用
 *    `qqId` 校验一次：坏群号的条目**视作不存在**（不是放行）、重复群号只认首条。
 */
import { qqId } from './private-config.ts'

/**
 * 群名（平台回包与主人提示共用的上界）最多 **64 个码点**。
 *
 * ⚠️ 按**码点**计，不按 UTF-16 单元计：一个 emoji 是 1 个码点、2 个 UTF-16 单元。
 * ⚠️ `OneBotPrivateClient.listGroups()` 也用这个常量做回包清理上界（单一来源）。
 */
export const GROUP_NAME_MAX_CODEPOINTS = 64

/** 群列表里的一条：群号已过 `qqId`（统一 string）、群名已 trim 且有界 */
export interface QqGroupListEntry {
  readonly groupId: string
  readonly groupName: string
}

/** 主人的目标提示：群号（可选）与/或群名提示（可选） */
export interface QqGroupTargetHint {
  readonly groupId?: string
  readonly nameHint?: string
}

/** 具名拒绝码（闭集；具体哪个码由规则决定，调用方如实回报，不改判） */
export const GROUP_TARGET_RESOLUTION_CODES = {
  /** 群号与名字都没给（或给了全是空白） */
  hintEmpty: 'group_hint_empty',
  /** 群号与名字都给了，但名字不指向该群号那个群 */
  hintConflict: 'group_hint_conflict',
  /** 给了群号，但它连"QQ 群号"的形状都不是 */
  groupIdInvalid: 'group_hint_group_id_invalid',
  /** 提示名字超过 64 个码点 */
  nameTooLong: 'group_hint_name_too_long',
} as const

export type GroupTargetResolutionCode =
  typeof GROUP_TARGET_RESOLUTION_CODES[keyof typeof GROUP_TARGET_RESOLUTION_CODES]

/** 消歧结局（闭集四态；**没有**"猜一个"这一态） */
export type QqGroupTargetResolution =
  | { readonly kind: 'resolved'; readonly groupId: string; readonly groupName: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly QqGroupListEntry[] }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid'; readonly code: GroupTargetResolutionCode }

/** 去空白（所有 `\s`：空格 / 制表 / 换行 / 全角空格 / NBSP …） */
const normalizeName = (name: string): string => name.replace(/\s+/gu, '')

/**
 * 群号升序比较。
 *
 * `qqId` 只认 `^[1-9]\d{4,19}$`（无前导零的纯数字），所以"先比长度、再比字典序"
 * 就是**精确的数值升序**，且不受 20 位群号超出 `Number.MAX_SAFE_INTEGER` 的影响。
 */
const compareGroupId = (left: string, right: string): number => {
  if (left.length !== right.length) return left.length - right.length
  return left < right ? -1 : left > right ? 1 : 0
}

const resolved = (entry: QqGroupListEntry): QqGroupTargetResolution => ({
  kind: 'resolved', groupId: entry.groupId, groupName: entry.groupName,
})

const ambiguous = (entries: readonly QqGroupListEntry[]): QqGroupTargetResolution => ({
  kind: 'ambiguous',
  candidates: [...entries]
    .sort((left, right) => compareGroupId(left.groupId, right.groupId))
    .map((entry) => ({ groupId: entry.groupId, groupName: entry.groupName })),
})

const invalid = (code: GroupTargetResolutionCode): QqGroupTargetResolution => ({ kind: 'invalid', code })

/** 名字是否**指向**这个群：trim 后全等，或去空白后"群名包含提示" */
const namePointsAt = (nameHint: string, entry: QqGroupListEntry): boolean => {
  if (entry.groupName === nameHint) return true
  const hint = normalizeName(nameHint)
  return hint !== '' && normalizeName(entry.groupName).includes(hint)
}

/**
 * 把主人的群提示解析成**真实群号**（纯函数；不做授权、不发消息、不联网）。
 *
 * 只返回四种结局：`resolved` / `ambiguous` / `not_found` / `invalid`。
 * 任何"两种解释都说得通"的输入都**不会**被猜成 `resolved`。
 */
export function resolveGroupTarget(input: {
  readonly hint: QqGroupTargetHint
  readonly groups: readonly QqGroupListEntry[]
}): QqGroupTargetResolution {
  const hint: QqGroupTargetHint = input.hint ?? {}
  const rawGroupId = typeof hint.groupId === 'string' ? hint.groupId.trim() : ''
  const rawNameHint = typeof hint.nameHint === 'string' ? hint.nameHint.trim() : ''

  /* ④ 先验输入形状：超长名字**不截断**，直接具名拒绝 */
  if ([...rawNameHint].length > GROUP_NAME_MAX_CODEPOINTS) {
    return invalid(GROUP_TARGET_RESOLUTION_CODES.nameTooLong)
  }
  const nameHint = rawNameHint === '' ? undefined : rawNameHint
  const wantedGroupId = rawGroupId === '' ? undefined : qqId(rawGroupId)
  if (rawGroupId !== '' && wantedGroupId === undefined) {
    return invalid(GROUP_TARGET_RESOLUTION_CODES.groupIdInvalid)
  }
  if (wantedGroupId === undefined && nameHint === undefined) {
    return invalid(GROUP_TARGET_RESOLUTION_CODES.hintEmpty)
  }

  /* 防御性重复校验：坏群号/空名/重复群号的条目**视作不存在**（不是放行） */
  const usable: QqGroupListEntry[] = []
  const seen = new Set<string>()
  for (const entry of input.groups) {
    const groupId = qqId(entry?.groupId)
    if (groupId === undefined || seen.has(groupId)) continue
    if (typeof entry.groupName !== 'string' || entry.groupName.trim() === '') continue
    seen.add(groupId)
    usable.push({ groupId, groupName: entry.groupName.trim() })
  }

  /* ① 显式群号：在列表里就认这个群，不在列表里就 not_found（不换一种找法） */
  if (wantedGroupId !== undefined) {
    const byId = usable.find((entry) => entry.groupId === wantedGroupId)
    if (byId === undefined) return { kind: 'not_found' }
    if (nameHint === undefined) return resolved(byId)
    /* ③ 都给了：名字必须**指向同一个群**，否则矛盾（不替主人选一个） */
    return namePointsAt(nameHint, byId) ? resolved(byId) : invalid(GROUP_TARGET_RESOLUTION_CODES.hintConflict)
  }

  /* ② 只给名字：先精确同名，唯一 ⇒ resolved；多个 ⇒ ambiguous */
  const exact = usable.filter((entry) => entry.groupName === nameHint)
  if (exact.length === 1) return resolved(exact[0]!)
  if (exact.length > 1) return ambiguous(exact)

  /* 没有精确同名时才退到"去空白后包含" */
  const normalizedHint = normalizeName(nameHint!)
  if (normalizedHint === '') return { kind: 'not_found' }
  const contained = usable.filter((entry) => normalizeName(entry.groupName).includes(normalizedHint))
  if (contained.length === 1) return resolved(contained[0]!)
  if (contained.length > 1) return ambiguous(contained)
  return { kind: 'not_found' }
}
