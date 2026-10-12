/**
 * QQ 主动联系 —— **能力声明**（post-Lv2 / ADR-110 `D05`）。
 *
 * ============================================================================
 *  ⚠️ **改名记录（WP5 实测逼出来的）**：`ADR-110` `D05` / 计划 §4.3 的候选名是
 *  `qq.private.send_text`。登记口**直接拒绝**了它 —— `ID_PATTERN`
 *  （`capability-registry.ts:87`）是 `/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/`：
 *  **段里不许有下划线**，操作名同一条（既有操作全是单词：`read` / `write` / `echo` / `act` …）。
 *  ⇒ 最终名 = **`qq.private.message` / `send`**（对象=message，动词=send，
 *    与 `local.file.read` 同形）。计划原文说该名"是计划候选" ⇒ 改名不动语义。
 *
 * ============================================================================
 *  它声明什么
 * ============================================================================
 * ```text
 * qq.private.message / send
 *   sideEffect = write      ·   riskLevel = R2   ·  permissions = [qq:private_send]
 *   idempotency = required  ·   supportsDryRun = true
 * ```
 * 三条硬边界（`D05` 逐字）：
 * ```text
 * ① R2 **只**授给这一项本人私聊操作 —— 不提高全局 `CHARACTER_ACTION_MAX_RISK`（缺省仍 R1）
 * ② 目标由**现有绑定**生成确定证据（`readQqPrivateConfig().ownerId`）；
 *    `arguments` 里**没有**收件人字段可用 —— 模型提供不了收件人
 * ③ 不自动继承文件写入 / 浏览器操作 / 搜索 / 任意 MCP
 * ```
 *
 * ============================================================================
 *  它与别的能力不同的一点：**不在任务候选表里**
 * ============================================================================
 * 计划 §7 的能力矩阵逐字："本批新增 **NONE** —— 主动联系不授予这些能力"。
 * ⇒ 本能力**恒登记**（关闭时一条请求会得到可审计的 `permission_denied`，先例 ADR-045 `D-11`/`D-12`），
 *   但**不**进 `main.ts` 的 `TASK_CAPABILITY_IDS` ⇒
 *   角色自行选择工具 / 任务执行环**永远规划不到它**（那里的"不选"因此是结构性的，不是配置的）。
 *   ⚠️ 它仍必须有 `TASK_ARG_KEYS` 行与 `TOOL_GATE_KEYS` 行 ——
 *      那不是"任务可用"的标记，而是 `auditToolCatalog()` 的完整性要求（"无遗漏 / 无漂移"）。
 *
 * ⚠️ 本模块是**纯层**：不 import 任何基础设施（`kernel:test` 的依赖方向锁着这一条）。
 */
import type { CapabilityDefinition } from './capability-registry.ts'
import { KernelError } from '../contracts/ids.ts'

/** 能力 id（⚠️ 见上面的改名记录：段里不能有下划线） */
export const QQ_PRIVATE_SEND_TEXT = 'qq.private.message'
/** 唯一的操作名（单词形态，与既有操作一致） */
export const QQ_PRIVATE_SEND_OPERATION = 'send'
/**
 * 权限名。
 *
 * ⚠️ 与"总开关"是**两件事**：开关决定"这次装配是否授予它"，
 *    权限决定"策略那一步放不放行"。关着的时候权限**不在**授予清单里
 *    ⇒ 策略给出可审计的 `missing_permission`（先例 `ADR-045` `D-12`）。
 */
export const QQ_PRIVATE_SEND_PERMISSION = 'qq:private_send'

/**
 * 目标类型（`ActionTarget.type`）。
 *
 * ⚠️ 由装配层的 `resolveTarget` **按绑定常量**给出 `exact` 置信度
 *    （先例：`web.search` 的固定 `external_service`、`math.calculate` 的固定 `local_executor`）。
 *    没有这一支的能力会落到**沙箱梯子**上被判越界 —— 那不是"没接线"，会被读成"目标不合法"。
 */
export const QQ_PRIVATE_OWNER_TARGET_TYPE = 'qq_private_owner'

/**
 * 参数的**闭集**（唯一一处）。
 *
 * ⚠️ 只有 `text`。**没有** `user_id` / `to` / `recipient` 这类字段 ——
 *    收件人是"本人"，由绑定决定，不由任何请求方提供。
 */
export const QQ_PRIVATE_SEND_ARG_KEYS: readonly string[] = ['text']

/**
 * 一旦出现这些参数名就**具名拒绝**（"模型提供不了收件人"的机器形态）。
 *
 * ⚠️ 与 `TASK_ARG_KEYS` 的闭集是**两道闸**：闭集挡住"没声明的参数"，
 *    这张黑名单挡住"以后有人顺手把收件人加进闭集"。两者都要有。
 */
export const FORBIDDEN_RECIPIENT_ARG_KEYS: readonly string[] = [
  'user_id', 'userId', 'userid', 'owner_id', 'ownerId', 'ownerid',
  'to', 'target_user', 'targetUser', 'recipient', 'qq', 'uin',
]

export interface RecipientArgViolation {
  readonly code: string
  readonly detail: string
}

/**
 * 复核一次调用的参数里**没有**收件人字段。
 *
 * 返回 `undefined` = 合法；否则给出具名问题（调用点负责失败关闭）。
 */
export function recipientArgViolation(
  args: Readonly<Record<string, unknown>> | undefined
): RecipientArgViolation | undefined {
  if (args === undefined) return undefined
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_RECIPIENT_ARG_KEYS.includes(key)) {
      return {
        code: 'qq_send_recipient_from_argument',
        detail: `参数里出现收件人字段 ${key} —— 收件人由本机绑定决定，任何请求方都不得提供`,
      }
    }
  }
  return undefined
}

/** 复核参数的**闭集**（未声明的键一律拒绝；与"多一个字段整条作废"同一条纪律） */
export function assertQqSendArgKeys(args: Readonly<Record<string, unknown>>): void {
  const violation = recipientArgViolation(args)
  if (violation !== undefined) {
    throw new KernelError('validation_error', violation.code, violation.detail)
  }
  for (const key of Object.keys(args)) {
    if (!QQ_PRIVATE_SEND_ARG_KEYS.includes(key)) {
      throw new KernelError(
        'validation_error',
        'qq_send_unknown_arg',
        `qq.private.send_text 的参数只有 ${QQ_PRIVATE_SEND_ARG_KEYS.join(' / ')}，收到 ${key}`
      )
    }
  }
}

/** 正文的**有界**上限（与通知实例、提案正文同一口径） */
export const QQ_PRIVATE_SEND_MAX_CODEPOINTS = 500

/** 能力声明（**追加**到登记表；不改 M4.5 的默认三项） */
export function createQqProactiveCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    {
      id: QQ_PRIVATE_SEND_TEXT,
      version: `${QQ_PRIVATE_SEND_TEXT}@1`,
      description:
        '向**已绑定的本人**发送一条私聊文字。目标由本机绑定取值（载荷提供不了收件人）；' +
        '首版只发文字、不附带图片/语音/群聊，也不因为这一次发送取得任何其它能力。',
      operations: [
        {
          name: QQ_PRIVATE_SEND_OPERATION,
          description: `把 text（≤ ${String(QQ_PRIVATE_SEND_MAX_CODEPOINTS)} 字符）作为一条私聊文字发给已绑定的本人`,
          sideEffect: 'write',
          /*
           * ⚠️ R2 = "外部可逆动作"：消息发出去**收不回来**，但它是私聊文字、
           *    目标固定为本人、有额度与停用闸 ⇒ 不是 R3（destructive / public / costly）。
           *    `write` 的风险下限是 R1，声明 R2 高于下限 ⇒ 合法（登记口会校验这条）。
           */
          riskLevel: 'R2',
        },
      ],
      sideEffectLevel: 'write',
      riskLevel: 'R2',
      permissions: [QQ_PRIVATE_SEND_PERMISSION],
      /* `shadow` 档靠它"完整产生选择与审计、不真的发"（ADR-110 D14） */
      supportsDryRun: true,
      /*
       * 幂等**必需**：重复发送是可见伤害（本人手机上多一条）。
       * 键由通知实例的 `occurrenceKey` 显式给出（`D07`），而不是从参数推导 ——
       * 因为"同一句话发两次"在参数上完全一样，推导不出区别。
       * ⚠️ 这也是本仓库**第一个**用 `required` 的能力（此前只有 `sandbox.file.write` 用 `supported`）。
       */
      idempotency: 'required',
    },
  ]
}
