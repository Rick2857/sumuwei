import type { CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import { LOCAL_REMINDER_SEND } from '../../../kernel/action/local-reminder-capability.ts'
import { notificationTextFingerprint, MAX_NOTIFICATION_TEXT_CODEPOINTS } from '../../../kernel/contracts/notification.ts'
import type { ChatChannel } from '../../../kernel/contracts/chat-channel.ts'
import type { QqTextDeliveryPort } from './qq-proactive-delivery.ts'

export function createLocalReminderDeliveryAdapter(channel: Exclude<ChatChannel, 'qq_private'>, delivery: QqTextDeliveryPort): CapabilityAdapter {
  return { capabilityId: LOCAL_REMINDER_SEND, async execute(input) {
    const text = input.args.text
    if (input.operation !== 'send' || Object.keys(input.args).some(key => key !== 'text') || typeof text !== 'string' ||
      !text.trim() || [...text].length > MAX_NOTIFICATION_TEXT_CODEPOINTS || !input.idempotencyKey ||
      input.target.type !== 'local_reminder_entry' || input.target.canonicalId !== channel || input.target.confidence !== 'exact') {
      throw new ActionFailureError(actionFailure('validation_failed', '本地提醒参数或绑定出口不合法'))
    }
    const result = delivery.deliver({ deliveryId: input.idempotencyKey, text })
    if (!result.written) throw new ActionFailureError(actionFailure('execution_failed', result.code ?? 'local_reminder_not_written'))
    return { effect: { kind: 'message_sent', detail: '已交给绑定的本地出口，接收结果待回执',
      fingerprint: notificationTextFingerprint(text), bytes: new TextEncoder().encode(text).length } }
  } }
}
