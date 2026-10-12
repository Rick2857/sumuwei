/**
 * **S8 / `L-S8-09`** —— 故事体验撤回的**用户入口**（管理面，纯逻辑）。
 *
 * ============================================================================
 *  载体与先例
 * ============================================================================
 *  照 `pnpm memory:retract` 的既有形状（`src/kernel/app/memory/admin.ts`）：
 *  用户入口 = **`main.ts` 的 CLI 开关**，解析与校验放在应用层纯模块，DB 写入在 main 分发。
 *
 * ```text
 * pnpm story:withdraw <sourceId> --reason user_withdrew|user_corrected [--note <text>]
 * ```
 *
 * ============================================================================
 *  🔒 认知完整性审查（`Privileged Cognitive Operation`，AGENTS §4）
 * ============================================================================
 * ```text
 * 它改变什么认知？   撤回一段故事经历的**认知使用资格** ⇒ 依赖它的行为槽不再入模
 *                   （读时传播已实现并由 WP6 的门守住：`L7`/`L8`/`L9`/`L3`/`L4`）
 * 有没有绕过放行口？ **没有**：它只追加一条**撤回事件**，不直接改任何投影或状态
 * 失败关闭面？       解析不出 / reason 不在闭集 / 引用不存在 ⇒ **具名拒收 + 零写入**（见下）
 * 可查 / 可审计？     事件进领域事件流（`STORY_EXPERIENCE_RETRACTED`），带 reason 与 note
 * 可降档？           撤回**只**影响认知使用资格，**不**物理删除世界历史（`ADR-093 D12`）
 * 顺序硬约束？       归因（`M5.1-D01 = CLOSED`）早于本入口，满足
 * ```
 *
 * ⚠️ 三条**必须**失败关闭的判据（本模块负责前两条；引用存在性由调用方查账本）：
 * ```text
 * ① 来源 id 必须能解析成故事身份（`isStorySourceId`）—— 否则撤回会指向"某个说不清的东西"
 * ② `reason` 必须是**闭集**里的值（与契约同源）—— 自由文本会让审计分不了类
 * ③ 被撤回的提交**必须真的存在于账本**（调用方查）—— 否则会留下悬空撤回事件
 *    （`L-S8-10` 那一类问题的入口版本）
 * ```
 */

import {
  STORY_EXPERIENCE_RETRACTION_REASONS,
  type StoryExperienceRetractedPayload,
  type StoryExperienceRetractionReason,
} from '../../contracts/story-events.ts'
import { isStorySourceId, parseStorySourceId, storySourceRefOf } from '../../contracts/source-authority.ts'

export interface StoryWithdrawRequest {
  readonly sourceId: string
  readonly reason: StoryExperienceRetractionReason
  readonly note?: string
}

export type StoryWithdrawParse =
  | { readonly ok: true; readonly request: StoryWithdrawRequest }
  /** 具名拒收：`code` 供 CLI 与门判据共用，**不**改成自由文本 */
  | { readonly ok: false; readonly code: string; readonly detail: string; readonly usage: string }

export const STORY_WITHDRAW_USAGE =
  'pnpm story:withdraw <sourceId> --reason ' +
  STORY_EXPERIENCE_RETRACTION_REASONS.join('|') +
  ' [--note <text>]   （**写操作**：撤回该故事经历的认知使用资格；不删除世界历史）'

/**
 * 解析 `story:withdraw` 的参数（**纯函数**，不碰 DB）。
 *
 * ⚠️ 失败关闭：任何一项不合法都返回具名 `code`，**不**抛出（CLI 要打印用法而不是栈）。
 */
export function parseStoryWithdrawArgs(argv: readonly string[]): StoryWithdrawParse {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token.startsWith('--')) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, code: 'story_withdraw_flag_without_value', detail: `${token} 后面没有值`, usage: STORY_WITHDRAW_USAGE }
      }
      flags.set(token, value)
      index += 1
    } else {
      positional.push(token)
    }
  }

  const sourceId = positional[0]
  if (sourceId === undefined || sourceId.trim() === '') {
    return { ok: false, code: 'story_withdraw_source_missing', detail: '没有给出被撤回的故事来源 id', usage: STORY_WITHDRAW_USAGE }
  }
  if (positional.length > 1) {
    return { ok: false, code: 'story_withdraw_too_many_args', detail: `只接受一个来源 id，收到 ${String(positional.length)} 个`, usage: STORY_WITHDRAW_USAGE }
  }
  /* ① 来源身份必须可解析 */
  if (!isStorySourceId(sourceId)) {
    return {
      ok: false,
      code: 'story_withdraw_source_unparsable',
      detail: `来源 id 不能解析成故事身份：${JSON.stringify(sourceId)}（形如 story:<storyId>@v<ver>#<runId>.<eventId>）`,
      usage: STORY_WITHDRAW_USAGE,
    }
  }
  /* ② reason 必须是闭集里的值 —— 自由文本会让审计分不了类 */
  const reasonRaw = flags.get('--reason')
  if (reasonRaw === undefined) {
    return { ok: false, code: 'story_withdraw_reason_missing', detail: '缺少 --reason（撤回必须说明理由）', usage: STORY_WITHDRAW_USAGE }
  }
  if (!(STORY_EXPERIENCE_RETRACTION_REASONS as readonly string[]).includes(reasonRaw)) {
    return {
      ok: false,
      code: 'story_withdraw_reason_unknown',
      detail: `--reason 必须是 ${STORY_EXPERIENCE_RETRACTION_REASONS.join(' / ')}，收到 ${JSON.stringify(reasonRaw)}`,
      usage: STORY_WITHDRAW_USAGE,
    }
  }
  const note = flags.get('--note')
  return {
    ok: true,
    request: {
      sourceId,
      reason: reasonRaw as StoryExperienceRetractionReason,
      ...(note === undefined ? {} : { note }),
    },
  }
}

/**
 * 构造撤回事件的 payload（**纯函数**）。
 *
 * ⚠️ 撤回粒度是**提交身份**（`ADR-093 D01`：一次提交一个根）—— 给观测 id 会让
 *    同一提交的另一条观测漏网（`story-events.ts` 的注释里有同样的理由）。
 */
export function storyWithdrawPayloadOf(input: {
  characterId: string
  request: StoryWithdrawRequest
  withdrawnAt: number
}): StoryExperienceRetractedPayload {
  const parts = parseStorySourceId(input.request.sourceId)
  if (parts === undefined) {
    throw new Error(`构造撤回 payload 前必须校验来源可解析：${input.request.sourceId}`)
  }
  return {
    characterId: input.characterId,
    withdrawnStoryRefs: [
      storySourceRefOf({ sourceId: input.request.sourceId, experienceScope: 'story_experience' }),
    ],
    reason: input.request.reason,
    withdrawnAt: input.withdrawnAt,
    ...(input.request.note === undefined ? {} : { note: input.request.note }),
  }
}

/** CLI 幂等键：同一个来源 + 同一个理由重复执行 ⇒ 撞键（不产生第二条撤回） */
export function storyWithdrawIdempotencyKey(request: StoryWithdrawRequest): string {
  return `story-withdraw:${request.sourceId}:${request.reason}`
}

/* ===========================================================================
 * **S8 / `L-S8-30` + `ADR-107` `R-2a′`** —— 显式开始一次故事 run（`story:start`）
 * ===========================================================================
 * 它补的是"**入口侧没有东西可消费**"那一半：`ADR-094` `D02.2①` 要求
 * "该会话存在一个**用户显式开始**的活跃 run"，而全仓此前**没有任何调用者**会写第一条提交。
 *
 * ⚠️ **它为什么必须是 `system` 绑定**（不是我在两可之间挑的，是**代码定死的**）：
 * ```text
 * `STORY_STARTED` **不在** `STORY_USER_CHOICE_EVENT_TYPES` 里
 *   （src/kernel/storyline/story-ledger.ts:147-151 只有 CHOICE_COMMITTED / ENDING_REACHED / RUN_EXITED）
 * ⇒ 给它声明 `user_choice` 会被 `assertStoryCommitBinding` **当场抛错**（`story_binding_kind_not_allowed`，:167-175）
 * ```
 * 这正好是 `INV-CI-03`（"维护不得冒充经历"）要的形状：**开局不是一次用户选择**。
 * "用户显式开始"这个**人的动作**由**CLI 调用**本身承载；持久记录如实写 `system`，
 * **不**伪造 `interactionRef` / `anchorConversationEventId`（伪造会违反 `D02.2②` 与 `S8-A14`）。
 *
 * ⚠️ 三条失败关闭：
 * ```text
 * ① runId 形状不合法 ⇒ 具名拒收（自由文本会让账本里出现无法复述的身份）
 * ② 已有**活跃**（非终局）run 且不是本 runId ⇒ 拒收（`ADR-107` `Q6`：`D02.4` 单用户单 run）
 * ③ 同一 runId 重复 start ⇒ 走既有开局的**幂等**路径（`already_committed`），**不**写第二行
 * ```
 */

/** `runId` 的上界（码点）。它是**服务端**生成的身份，不是模型自由文本。 */
export const STORY_RUN_ID_MAX_CODEPOINTS = 128

/**
 * **显式授权开关**（`cognitive-integrity` §2 的 "Authorization" + §18 `CI-4`）。
 *
 * ⚠️ **2026-10-05 复核后的结论：它必须有**，理由是一条**方向性**的区别：
 * ```text
 * `story:withdraw`（有先例、无二次确认）—— 它是**移除**认知使用资格的方向（保守）
 * `story:start`                       —— 它是**新增**认知摄入的方向：开局之后，
 *                                        用户的选择才会经三个消费者变成情绪/关系/反思状态
 * ⇒ §2 的"**不得默认开放、不得静默执行**"针对的正是后者（放行一个**新的**认知摄入面），
 *   所以"抄 withdraw 的形状"不能一路抄到"也不要求授权"。
 * ```
 * 同型先例：`pnpm desktop-control:act --i-am-here`（需要人在场显式授权，**不**登记在门表里）。
 * ⚠️ 它**不**替代"显式告警"：告警照打，`--yes` 只是回答"这是人**明确**要的"。
 */
export const STORY_START_CONFIRM_FLAG = '--yes'

export const STORY_START_USAGE =
  `pnpm story:start <runId> ${STORY_START_CONFIRM_FLAG}   （**写操作**：显式开始一次故事 run；` +
  '**不**自动开始任何故事，也**不**替用户做任何选择。缺 ' +
  STORY_START_CONFIRM_FLAG +
  ' ⇒ 具名拒收、零写入）'

export interface StoryStartRequest {
  readonly runId: string
}

export type StoryStartParse =
  | { readonly ok: true; readonly request: StoryStartRequest }
  | { readonly ok: false; readonly code: string; readonly detail: string; readonly usage: string }

/**
 * 解析 `story:start` 的参数（**纯函数**，不碰 DB）。
 *
 * ⚠️ 失败关闭：任何一项不合法都返回具名 `code`，**不**抛出（CLI 要打印用法而不是栈）。
 * ⚠️ 顺序：**形状**先判、**授权**最后判 —— 这样"没给 runId"与"没给授权"不会互相掩盖，
 *    两条各有具名码（门对两条都下了负控）。
 */
export function parseStoryStartArgs(argv: readonly string[]): StoryStartParse {
  const positional: string[] = []
  let confirmed = false
  for (const token of argv) {
    if (token === STORY_START_CONFIRM_FLAG) {
      confirmed = true
      continue
    }
    if (token.startsWith('--')) {
      return {
        ok: false,
        code: 'story_start_unknown_flag',
        detail: `本命令只接受 ${STORY_START_CONFIRM_FLAG}，收到 ${JSON.stringify(token)}`,
        usage: STORY_START_USAGE,
      }
    }
    positional.push(token)
  }
  const runId = positional[0]
  if (runId === undefined || runId.trim() === '') {
    return { ok: false, code: 'story_start_run_id_missing', detail: '没有给出 runId', usage: STORY_START_USAGE }
  }
  if (positional.length > 1) {
    return {
      ok: false,
      code: 'story_start_too_many_args',
      detail: `只接受一个 runId，收到 ${String(positional.length)} 个`,
      usage: STORY_START_USAGE,
    }
  }
  if (runId !== runId.trim() || /\s/.test(runId)) {
    return {
      ok: false,
      code: 'story_start_run_id_has_whitespace',
      detail: `runId 不得含空白（会污染幂等键 "story-commit:<runId>:r1:…"）：${JSON.stringify(runId)}`,
      usage: STORY_START_USAGE,
    }
  }
  if ([...runId].length > STORY_RUN_ID_MAX_CODEPOINTS) {
    return {
      ok: false,
      code: 'story_start_run_id_too_long',
      detail: `runId 最长 ${String(STORY_RUN_ID_MAX_CODEPOINTS)} 码点，收到 ${String([...runId].length)}`,
      usage: STORY_START_USAGE,
    }
  }
  /* ⚠️ 授权（`CI-4`）：**最后**判 —— 形状错误先报，两条互不掩盖 */
  if (!confirmed) {
    return {
      ok: false,
      code: 'story_start_confirmation_missing',
      detail:
        `开局会**新增**一个认知摄入面（此后用户的选择才可能变成情绪/关系/反思状态）` +
        `⇒ 必须显式授权：请在命令里带上 ${STORY_START_CONFIRM_FLAG}`,
      usage: STORY_START_USAGE,
    }
  }
  return { ok: true, request: { runId } }
}

/**
 * 开局幂等键的**前缀**（导出给门用：它可以断言"开局键不与选择键同族"）。
 *
 * ⚠️ 它与选择提交的键形状（`story-commit:<runId>:r<rev>:<anchor>`）**刻意不同**：
 *    开局没有 `anchor`（不是任何一次对话触发），所以不能共用同一个模板 ——
 *    共用会让"开局"与"某一次选择"在键空间里看起来是同一族东西。
 */
export const STORY_START_IDEMPOTENCY_KEY_PREFIX = 'story-start:'

/**
 * 开局的幂等键（**只由服务端拼**）。
 */
export function storyStartIdempotencyKey(runId: string): string {
  return `${STORY_START_IDEMPOTENCY_KEY_PREFIX}${runId}`
}
