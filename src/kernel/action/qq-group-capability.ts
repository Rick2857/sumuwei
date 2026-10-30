/**
 * QQ 群消息（主人授权任务）—— **能力声明**（post-Lv2 / 群任务 P2）。
 *
 * ============================================================================
 *  ⚠️ 先看这条教训（与 `qq-proactive-capability.ts` 同一个坑）
 * ============================================================================
 * `capability-registry.ts` 的 `ID_PATTERN` 是 `/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/`：
 * **id 段里不许有下划线**，操作名同一条（既有操作全是单词：`read` / `write` / `send`）。
 * ⇒ 候选名 `qq.group.send_text` / `qq.group_list` 会被登记口**当场拒绝**。
 * 本批最终名：
 * ```text
 * qq.group.message / send     写：往**任务授权的那个群**发一条消息
 * qq.group.list    / read     读：只读机器人实际所在群（消歧用，不接受任意群参数）
 * ```
 *
 * ============================================================================
 *  它声明什么
 * ============================================================================
 * ```text
 * qq.group.message / send
 *   sideEffect = write      ·  riskLevel = R2   ·  permissions = [qq:group_send]
 *   idempotency = required  ·  supportsDryRun = true
 * qq.group.list / read
 *   sideEffect = read       ·  riskLevel = R1   ·  permissions = [qq:group_list]
 *   idempotency = none      ·  supportsDryRun = true
 * ```
 *
 * ============================================================================
 *  三条硬边界（与 `D05` 同一条纪律）
 * ============================================================================
 * ```text
 * ① R2 只授给这一项群发送操作 —— 不提高全局 `CHARACTER_ACTION_MAX_RISK`（缺省仍 R1）
 * ② **群号/收件人永远不来自载荷**：参数闭集里没有 group_id / to / recipient 这类字段；
 *    群号只能来自**注入的任务授权事实**（`resolveAuthorization` 端口）。
 *    载荷里一旦出现这类字段，适配器**具名拒绝**（`qq_group_send_group_from_argument`）。
 * ③ 不自动继承文件写入 / 浏览器操作 / 搜索 / 任意 MCP；本能力**不**在任务候选表里，
 *    也不由模型"挑一个群"——选群是程序事实，不是模型参数。
 * ```
 *
 * ⚠️ 本模块是**纯层**：只 import 同层契约与登记口类型，不碰任何基础设施。
 */
import type { CapabilityDefinition } from './capability-registry.ts'
import { KernelError } from '../contracts/ids.ts'
import { GROUP_TASK_LIMITS } from '../contracts/qq-group-task.ts'

/** 写能力 id（⚠️ 段里不能有下划线，见文件头） */
export const QQ_GROUP_MESSAGE = 'qq.group.message'
/** 写能力唯一的操作名 */
export const QQ_GROUP_SEND_OPERATION = 'send'
/** 写能力的权限名（装配层显式授予；缺省**不在** `DEFAULT_GRANTED_PERMISSIONS` 里） */
export const QQ_GROUP_SEND_PERMISSION = 'qq:group_send'

/** 读能力 id（只读机器人所在群，用于精确消歧） */
export const QQ_GROUP_LIST = 'qq.group.list'
/** 读能力的操作名 */
export const QQ_GROUP_LIST_OPERATION = 'read'
/** 读能力的权限名 */
export const QQ_GROUP_LIST_PERMISSION = 'qq:group_list'

/**
 * 目标类型（`ActionTarget.type`）。
 *
 * ⚠️ 由装配层的 `resolveTarget` **按任务授权事实**给出 `exact` 置信度
 *    （先例：`qq_private_owner` 的"目标由绑定生成确定证据"）。
 *    适配器要求 `type === 本常量 && confidence === 'exact'`；
 *    没有 exact 目标的能力会落到**沙箱梯子**上被判越界 —— 那不是"没接线"，
 *    会被读成"目标不合法"。
 * ⚠️ `ActionTarget.canonicalId` 放**授权事实里的真实群号**；适配器再核对一次
 *    "载荷/解析出来的目标"与"任务授权事实"逐字相同，不一致就不发。
 */
export const QQ_GROUP_TASK_TARGET_TYPE = 'qq_group_task'

/**
 * `qq.group.message/send` 的参数**闭集**（唯一一处）。
 *
 * ```text
 * text    要发出去的正文（必需，有界）
 * media   可选：'text' | 'voice'，只是"这条任务允许的形态里这次想用哪种"，
 *         **不是**收件人/群号。**本批适配器只真的发文字**（见适配器文件头）。
 * ```
 *
 * ⚠️ **没有** `group_id` / `groupId` / `to` / `recipient` / `user_id` 这类字段：
 *    群号来自任务授权事实（`resolveAuthorization` 注入端口），任何请求方都提供不了。
 */
export const QQ_GROUP_SEND_ARG_KEYS: readonly string[] = ['text', 'media']

/**
 * `qq.group.list/read` 的参数**闭集**：**空**。
 *
 * ⚠️ 这个能力只列"机器人实际所在群"；它不接受任何"指定一个群"的参数
 *    —— 否则就等于让模型自己挑一个群，再去别的判定里当事实用。
 */
export const QQ_GROUP_LIST_ARG_KEYS: readonly string[] = []

/**
 * 一旦出现这些参数名就**具名拒绝**（"群号/收件人不可由载荷提供"的机器形态）。
 *
 * ⚠️ 与参数闭集是**两道闸**：闭集挡住"没声明的参数"，这张黑名单挡住
 *    "以后有人顺手把群号加进闭集"。两者都要有（先例：`FORBIDDEN_RECIPIENT_ARG_KEYS`）。
 * ⚠️ 含中文字段名 `群号`：模型偶尔会用母语键名给参数，这条也归到"载荷提供群号"。
 */
export const FORBIDDEN_GROUP_ARG_KEYS: readonly string[] = [
  'group_id', 'groupId', 'groupid', 'group', 'groupCode', 'group_code', '群号',
  'target_group', 'targetGroup', 'target_group_id', 'targetGroupId',
  'user_id', 'userId', 'userid', 'member_id', 'memberId', 'owner_id', 'ownerId',
  'to', 'recipient', 'qq', 'uin', 'group_list', 'groupIds',
]

export interface GroupArgViolation {
  readonly code: string
  readonly detail: string
}

/**
 * 复核一次调用的参数里**没有**群号/收件人字段。
 *
 * 返回 `undefined` = 合法；否则给出具名问题（调用点负责失败关闭）。
 */
export function groupArgViolation(
  args: Readonly<Record<string, unknown>> | undefined
): GroupArgViolation | undefined {
  if (args === undefined) return undefined
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_GROUP_ARG_KEYS.includes(key)) {
      return {
        code: 'qq_group_send_group_from_argument',
        detail: `参数里出现群号/收件人字段 ${key} —— 群号只能来自任务授权事实，任何请求方都不得提供`,
      }
    }
  }
  return undefined
}

/** 复核 `qq.group.message/send` 参数的**闭集**（未声明的键一律拒绝） */
export function assertQqGroupSendArgKeys(args: Readonly<Record<string, unknown>>): void {
  const violation = groupArgViolation(args)
  if (violation !== undefined) {
    throw new KernelError('validation_error', violation.code, violation.detail)
  }
  for (const key of Object.keys(args)) {
    if (!QQ_GROUP_SEND_ARG_KEYS.includes(key)) {
      throw new KernelError(
        'validation_error',
        'qq_group_send_unknown_arg',
        `qq.group.message.send 的参数只有 ${QQ_GROUP_SEND_ARG_KEYS.join(' / ')}，收到 ${key}`
      )
    }
  }
}

/** 复核 `qq.group.list/read` 参数的**闭集**（它**一个参数都不接受**） */
export function assertQqGroupListArgKeys(args: Readonly<Record<string, unknown>>): void {
  const violation = groupArgViolation(args)
  if (violation !== undefined) {
    throw new KernelError('validation_error', 'qq_group_list_group_from_argument', violation.detail)
  }
  for (const key of Object.keys(args)) {
    if (!QQ_GROUP_LIST_ARG_KEYS.includes(key)) {
      throw new KernelError(
        'validation_error',
        'qq_group_list_unknown_arg',
        `qq.group.list.read 不接受任何参数（只列机器人实际所在群），收到 ${key}`
      )
    }
  }
}

/** 正文的有界上限（**单一来源**是契约的 `GROUP_TASK_LIMITS`，这里只是导出给调用点读） */
export const QQ_GROUP_SEND_MAX_CODEPOINTS = GROUP_TASK_LIMITS.maxTextCodepoints

/**
 * 能力声明（**追加**到登记表；不改 M4.5 的默认三项，也不改 `DEFAULT_GRANTED_PERMISSIONS`）。
 *
 * ⚠️ 登记 ≠ 授权：权限要装配层**显式**授予；缺省时策略给出可审计的 `missing_permission`
 *    （先例 `ADR-045` `D-12`）。
 */
export function createQqGroupCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    {
      id: QQ_GROUP_MESSAGE,
      version: `${QQ_GROUP_MESSAGE}@1`,
      description:
        '往**主人在私聊里明确授权的那一个群**发送一条消息。群号由任务授权事实给出（载荷提供不了群号/收件人）；' +
        '首版只真的发送文字，语音形态不在本批适配器内；不因为这一次发送取得任何其它能力。',
      operations: [
        {
          name: QQ_GROUP_SEND_OPERATION,
          description:
            `把 text（≤ ${String(QQ_GROUP_SEND_MAX_CODEPOINTS)} 字符）作为一条群消息发到任务授权的群；` +
            'media 只是形态提示，不是收件人',
          sideEffect: 'write',
          /*
           * ⚠️ R2 = "外部可逆动作"：群消息发出去**收不回来**，但目标固定为授权任务、
           *    有额度与停止闸、且不是公开/破坏性动作 ⇒ 不是 R3。
           *    `write` 的风险下限是 R1，声明 R2 高于下限 ⇒ 合法（登记口会校验这条）。
           */
          riskLevel: 'R2',
        },
      ],
      sideEffectLevel: 'write',
      riskLevel: 'R2',
      permissions: [QQ_GROUP_SEND_PERMISSION],
      /* `shadow` 档靠它"完整产生选择与审计、不真的发" */
      supportsDryRun: true,
      /*
       * 幂等**必需**：重复发送是可见伤害（群里多一条）。
       * 键由调用方显式给出（投递稳定键），而不是从正文推导 ——
       * "同一句话发两次"在参数上完全一样，推导不出区别。
       */
      idempotency: 'required',
    },
    {
      id: QQ_GROUP_LIST,
      version: `${QQ_GROUP_LIST}@1`,
      description:
        '只读机器人**实际所在**的群列表（群号/群名/机器人在群人数），用于把主人的群名提示精确消歧成真实群号。' +
        '不接受任何参数，尤其不接受"指定一个群"。',
      operations: [
        {
          name: QQ_GROUP_LIST_OPERATION,
          description: '列出机器人实际所在的群（只读；不接受任何参数）',
          sideEffect: 'read',
          riskLevel: 'R1',
        },
      ],
      sideEffectLevel: 'read',
      riskLevel: 'R1',
      permissions: [QQ_GROUP_LIST_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
  ]
}
