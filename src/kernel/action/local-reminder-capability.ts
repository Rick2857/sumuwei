import type { CapabilityDefinition } from './capability-registry.ts'

export const LOCAL_REMINDER_SEND = 'local.reminder.message'
export const LOCAL_REMINDER_PERMISSION = 'local:reminder_send'
export function createLocalReminderCapabilities(): readonly CapabilityDefinition[] {
  return [{ id: LOCAL_REMINDER_SEND, version: `${LOCAL_REMINDER_SEND}@1`,
    description: '向当前受信的皮套或控制台出口投递已保存的到点文字提醒；不能选择收件人或改投QQ。',
    operations: [{ name: 'send', description: '投递到本会话绑定的本地出口', sideEffect: 'write', riskLevel: 'R1' }],
    sideEffectLevel: 'write', riskLevel: 'R1', permissions: [LOCAL_REMINDER_PERMISSION], supportsDryRun: true, idempotency: 'required',
  }]
}
