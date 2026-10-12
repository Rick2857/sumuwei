/**
 * `qq.private.message` / `send` 的适配器（post-Lv2 / ADR-110 `D05`/`D09`）。
 *
 * ============================================================================
 *  它做什么 / 不做什么
 * ============================================================================
 * ```text
 * 做：① 复核参数闭集（只有 text，**没有**收件人字段）
 *     ② 复核目标**就是本人**（`qq_private_owner` 且 exact）
 *     ③ 复核正文有界
 *     ④ 把正文交给**注入的投递端口**（那一条线缆会把它送到外壳的发送面）
 *     ⑤ 回一个 effect = `message_sent` + **正文指纹**（正文不进账本）
 * 不做：不决定该不该发（策略层）、不认识谁请求的（端口形状里没有）、
 *       **不**打开数据库、**不**判断正文写得好不好
 * ```
 * ⚠️ 影子档（`shadow`）**结构上**到不了这里：`dryRun` 是网关层的选项，
 *    策略会给出 `dry_run` 结论而**不**调用适配器 —— 所以"影子档不真发"不是这条代码的自觉，
 *    是链路上没有那条路。
 *
 * ⚠️ 成功**不等于**送达：`message_sent` 的逐字含义见 `ActionEffect` 的注释。
 *    平台结局由外壳的回执写进通知实例（`QqDeliveryRegistry`）。
 *
 * ⚠️ 失败一律走**闭集**的 `ActionFailureCode`；我们自己的具名理由进 `details.reason`
 *    （与 `browser.ts` / `desktop-control.ts` 同一条纪律）。
 */
import type { AdapterExecuteInput, AdapterOutcome, CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import {
  QQ_PRIVATE_SEND_OPERATION,
  QQ_PRIVATE_SEND_TEXT,
  QQ_PRIVATE_OWNER_TARGET_TYPE,
  assertQqSendArgKeys,
  recipientArgViolation,
} from '../../../kernel/action/qq-proactive-capability.ts'
import {
  MAX_NOTIFICATION_TEXT_CODEPOINTS,
  notificationTextFingerprint,
} from '../../../kernel/contracts/notification.ts'

/** 把一行文字交给 QQ 外壳去投递（**这条线缆之外没有正文**的地方） */
export interface QqTextDeliveryPort {
  deliver(input: { deliveryId: string; text: string }): { written: boolean; code?: string }
}

export interface QqProactiveDeliveryAdapterOptions {
  readonly delivery: QqTextDeliveryPort
  /**
   * 从参数里取**本次投递的稳定键**（= 通知实例的 `occurrenceKey`）。
   *
   * ⚠️ 它**不是**从正文推导的：同一句话发两次在参数上完全一样，
   *    必须由调用方（主动调度那一条线）显式给出。取不到 ⇒ **失败关闭**。
   */
  readonly resolveDeliveryId: (input: AdapterExecuteInput) => string | undefined
}

function fail(code: Parameters<typeof actionFailure>[0], reason: string, message: string): never {
  throw new ActionFailureError(actionFailure(code, message, { reason }))
}

export function createQqProactiveDeliveryAdapter(
  options: QqProactiveDeliveryAdapterOptions
): CapabilityAdapter {
  return {
    capabilityId: QQ_PRIVATE_SEND_TEXT,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      if (input.operation !== QQ_PRIVATE_SEND_OPERATION) {
        fail('validation_failed', 'qq_send_unknown_operation',
          `qq.private.message 只有 ${QQ_PRIVATE_SEND_OPERATION} 这一个操作，收到 ${input.operation}`)
      }

      /* ① 参数闭集 + 收件人黑名单（与声明同源的两条复核函数） */
      const violation = recipientArgViolation(input.args)
      if (violation !== undefined) fail('validation_failed', violation.code, violation.detail)
      try {
        assertQqSendArgKeys(input.args)
      } catch (error) {
        /* `assertQqSendArgKeys` 抛的是 KernelError；适配器的失败必须归一（`errors.ts` 的纪律） */
        const reason = (error as { code?: string }).code ?? 'qq_send_unknown_arg'
        fail('validation_failed', reason, error instanceof Error ? error.message : '参数闭集复核失败')
      }

      /* ② 目标**必须**是已绑定的本人（`resolveTarget` 那一支给 exact 置信度） */
      if (input.target.type !== QQ_PRIVATE_OWNER_TARGET_TYPE || input.target.confidence !== 'exact') {
        fail('validation_failed', 'qq_send_target_not_owner',
          `收件人必须是已绑定的本人（${QQ_PRIVATE_OWNER_TARGET_TYPE} / exact），收到 ${input.target.type} / ${input.target.confidence}`)
      }

      /* ③ 正文有界（与通知窗口同一条上界） */
      const text = stringArg(input.args, 'text') ?? ''
      const codepoints = [...text].length
      if (text.trim() === '') fail('validation_failed', 'qq_send_without_text', '正文是空的')
      if (codepoints > MAX_NOTIFICATION_TEXT_CODEPOINTS) {
        fail('validation_failed', 'qq_send_text_too_long',
          `正文 ${String(codepoints)} 码点，上界 ${String(MAX_NOTIFICATION_TEXT_CODEPOINTS)}`)
      }

      /* ④ 稳定键（拿不到就**不发**：一次无法幂等的发送不该发生） */
      const deliveryId = String(options.resolveDeliveryId(input) ?? '').trim()
      if (deliveryId === '') {
        fail('validation_failed', 'qq_send_without_delivery_key',
          '取不到本次投递的稳定键（occurrenceKey）—— 幂等必需的能力不许在没有键的情况下发送')
      }

      const written = options.delivery.deliver({ deliveryId, text })
      if (!written.written) {
        fail('execution_failed', written.code ?? 'qq_delivery_not_written',
          '投递通道没有收下这一行（没有当前投递连接 / 正文被拒）')
      }

      /*
       * ⑤ 账本只收**指纹**（`D09`）：正文进了账本，就等于把私聊内容复制进一份长期留存的数据。
       *    ⚠️ `detail` 也**不含**正文 —— 它说的是"交给外壳了"，不是说了什么。
       */
      return {
        effect: {
          kind: 'message_sent',
          detail: '已交给 QQ 外壳投递（平台结局待回执）',
          fingerprint: notificationTextFingerprint(text),
          bytes: new TextEncoder().encode(text).length,
        },
      }
    },
  }
}
