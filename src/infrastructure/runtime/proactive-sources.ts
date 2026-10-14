/**
 * 主动关心的**可用依据集**：把"读时视图里的条目"映射成可引用的来源
 * （post-Lv2 / ADR-111 `S01`/`S02`）。
 *
 * ============================================================================
 *  它**只**做一件事：读 + 映射。判据在别处
 * ============================================================================
 * ```text
 * 有界 / 去重 / 截断 / 上限 8 条  ← `boundProactiveSources`（契约层，纯函数）
 * "哪一条还算数"                  ← **各自的读时视图**（本文件的三个读）
 * "引用合不合法"                  ← `verifyProactiveSources`（生成前 + 发送前各一次）
 * ```
 *
 * ============================================================================
 *  ⚠️ 三条来源的**资格判据各不相同**，所以**不能**用一个 where 一把捞
 * ============================================================================
 * ```text
 * 可用信念    `status ∈ {active, disputed}`（可用集 = 投影自己的说法）
 * 未结清目标  `status ∈ {active, blocked}`（完成/取消的那些不再是"可说的事"）
 * 记忆事实    `status = active` —— **那道遮蔽**：`superseded` / `retracted` / `disputed`
 *            都不是"她今天还这么认为"的话 ⇒ 拿它们当依据，等于让她引用一句
 *            她自己都不再采信的话
 * ```
 * ⚠️ 本文件**不读原始对话行**、**不读 trace**、**不读账本**（ADR-111 `S01` 逐字：
 *    只能从已经过同一套遮蔽的读时视图里挑）。
 * ⚠️ 摘要（`label`）是**程序生成的有界标签**，不是正文、不是她要说的话；
 *    记忆那一条取**内容那一面**（claim 的槽位 / episode 的 summary），
 *    **不用**面向运营的审计串（那个含 `authority` / `importance` 等内部字段）。
 */
import type { RawDb } from '../persistence/db.ts'
import { asCharacterId } from '../../kernel/contracts/ids.ts'
import { entityRef } from '../../kernel/contracts/entity.ts'
import type { ProactiveSourceCandidate } from '../../kernel/contracts/proactive-proposal.ts'
import { listBeliefsByStatus } from '../persistence/belief-store.ts'
import { listGoalStates } from '../persistence/goal-store.ts'
import { createNativeMemoryStore } from '../persistence/memory-store.ts'
/* U1 / ADR-138：依据集的授权过滤（契约 §4 第 9 行） */
import { filterAuthorizedMemoryCandidates } from '../persistence/record-scope-store.ts'
import type { Room, ScopeContext } from '../../kernel/contracts/scope.ts'
import { currentReadScope, withReadScope } from '../persistence/read-scope.ts'

/** 可用的信念状态（`active` = 当前采信；`disputed` = 有争议但仍在用） */
export const PROACTIVE_SOURCE_BELIEF_STATUSES: readonly string[] = ['active', 'disputed']
/** 未结清的目标状态（`blocked` 仍算"正在做的事"——它只是暂时卡住） */
export const PROACTIVE_SOURCE_GOAL_STATUSES: readonly string[] = ['active', 'blocked']
/**
 * 记忆的**扫描上限**（不是"可用集上限"—— 后者是 `PROACTIVE_MAX_SOURCE_OPTIONS`=8）。
 *
 * ⚠️ 它只是"一次读多少行"的工程闸：真正的有界化在 `boundProactiveSources` 那一步。
 *    不设上限会让"她记得很多"变成一次读几千行。
 */
export const PROACTIVE_SOURCE_MEMORY_SCAN_LIMIT = 200

export interface ProactiveSourceBuildReadings {
  readonly beliefs: number
  readonly goals: number
  readonly memories: number
}

export interface ProactiveSourceBuildResult {
  readonly candidates: readonly ProactiveSourceCandidate[]
  readonly readings: ProactiveSourceBuildReadings
}

/**
 * 从**读时视图**收集可引用的依据。
 *
 * ⚠️ `ref` 用各投影自己的 **canonical id**（信念 id / 目标 id / 记忆 id）——
 *    这样"发送前复核"复的是**同一个东西**：它还在不在可用集里。
 * ⚠️ 标签各自取自己的"可读那一面"，**由程序拼**，并都会被 `boundProactiveSources`
 *    截到 120 码点。
 */
export async function buildProactiveSourceCandidates(
  db: RawDb,
  input: {
    characterId: string
    /**
     * **U1 / `ADR-138`（`G18`）· 契约 §4 第 9 行**：本轮的授权上下文（**可选**）。
     *
     * ```text
     * 有它 ⇒ 记忆依据集先过授权过滤（越权候选**不进**依据集）；无它 ⇒ 行为**逐字不变**
     *        （既有调用点不传，单用户前提下与接线前一致）。
     * ⚠️ 只过滤**记忆**这一档：信念与目标是**角色自己的认知**（不是别人的私聊内容），
     *    它们的可见性语义是另一件事（契约 §4 第 9 行的引用也正是记忆那一处 `list({owner,status})`）。
     *    这条限制是**刻意的**，不许被读成"整个依据面都已过滤"。
     * ```
     */
    authorization?: { context: ScopeContext; defaultOriginRoom: Room }
  }
): Promise<ProactiveSourceBuildResult> {
  // ADR-140: the same scope now protects memories AND derived belief/goal sources.
  if (input.authorization !== undefined && currentReadScope() === undefined) {
    const auth = input.authorization
    if (auth.defaultOriginRoom.kind !== 'private') throw new Error('proactive_owner_origin_required')
    return withReadScope({ context: auth.context, ownerUserId: auth.defaultOriginRoom.userId, roomAuthorized: false },
      () => buildProactiveSourceCandidates(db, { characterId: input.characterId }))
  }
  const cid = asCharacterId(input.characterId)
  const candidates: ProactiveSourceCandidate[] = []

  const beliefs = await listBeliefsByStatus(db, cid, PROACTIVE_SOURCE_BELIEF_STATUSES)
  for (const belief of beliefs) {
    const predicate = String(belief.proposition?.predicate ?? '').trim()
    const value =
      typeof belief.proposition?.value === 'string'
        ? belief.proposition.value
        : JSON.stringify(belief.proposition?.value ?? '')
    const label = predicate === '' ? value : `${predicate} = ${value}`
    if (String(belief.beliefId ?? '').trim() === '') continue
    candidates.push({ ref: String(belief.beliefId), label })
  }

  const goals = await listGoalStates(db, cid)
  let goalCount = 0
  for (const row of goals) {
    const goal = row.goal
    if (!PROACTIVE_SOURCE_GOAL_STATUSES.includes(String(goal.status))) continue
    if (String(goal.goalId ?? '').trim() === '') continue
    goalCount += 1
    candidates.push({ ref: String(goal.goalId), label: String(goal.statement ?? '') })
  }

  /*
   * ---- 记忆事实（ADR-111 `S01`：只取**读时已过遮蔽**的那一档） -----------------
   *
   * ⚠️ `status: 'active'` 就是那道遮蔽：`superseded` / `retracted` 是"她不再那么认为"
   *    的那两档，`disputed` 是"自己跟自己打架" —— 拿它们当依据等于让她引用一句
   *    她自己都不再采信的话。⇒ **只取 active**（比信念那一条更严，是刻意的：
   *    信念的 `disputed` 在 M9 里仍算"可用判断"，记忆的 `disputed` 不是）。
   * ⚠️ 标签取**内容那一面**（claim 的 `predicate = value` / episode 的 `summary`），
   *    **不**用 `summarizeRecord()` —— 那一行是给运营看的审计串
   *    （`authority=… imp=… conf=… evidence=…`），塞进 prompt 既没用又泄内部字段。
   */
  const store = createNativeMemoryStore(db)
  const owner = entityRef('character', String(input.characterId))
  const memories = await store.list({
    owner,
    status: 'active',
    limit: PROACTIVE_SOURCE_MEMORY_SCAN_LIMIT,
  })
  /*
   * U1 / ADR-138：**先授权、后取用**（与召回候选同一条次序纪律）。
   * 列表已在手 ⇒ 不必改 store；没有 authorization ⇒ `allowedIds === null` ⇒ 逐字不变。
   */
  const allowedIds =
    input.authorization === undefined
      ? null
      : new Set(
          (
            await filterAuthorizedMemoryCandidates(db, {
              context: input.authorization.context,
              candidateIds: memories.map((record) => String(record.id)),
              defaultOriginRoom: input.authorization.defaultOriginRoom,
            })
          ).authorized
        )
  let memoryCount = 0
  for (const record of memories) {
    const ref = String(record.id ?? '').trim()
    if (ref === '') continue
    if (allowedIds !== null && !allowedIds.has(ref)) continue
    const label = memoryLabelOf(record)
    if (label === '') continue
    memoryCount += 1
    candidates.push({ ref, label })
  }

  return {
    candidates,
    readings: { beliefs: beliefs.length, goals: goalCount, memories: memoryCount },
  }
}

/**
 * 记忆的**可读标签**（程序生成、有界由调用方截断）。
 *
 * 两种内容形态各取自己的那一面：claim 是槽位（`predicate = value`），
 * episode 是它自己的 `summary`。
 */
function memoryLabelOf(record: { readonly content?: unknown }): string {
  const content = record.content as
    | { readonly kind?: string; readonly predicate?: unknown; readonly value?: unknown }
    | { readonly kind?: string; readonly summary?: unknown }
    | undefined
  if (content === undefined || content === null) return ''
  if ((content as { kind?: string }).kind === 'claim') {
    const claim = content as { predicate?: unknown; value?: unknown }
    const predicate = String(claim.predicate ?? '').trim()
    const value = typeof claim.value === 'string' ? claim.value : JSON.stringify(claim.value ?? '')
    return predicate === '' ? value : `${predicate} = ${value}`
  }
  return String((content as { summary?: unknown }).summary ?? '').trim()
}
