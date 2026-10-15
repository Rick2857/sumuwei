import { readReminderRequest } from '../../contracts/notification-intake.ts'
import { MAX_NOTIFICATION_TEXT_CODEPOINTS, notificationTextFingerprint } from '../../contracts/notification.ts'
import { CHAT_CHANNEL_LABELS, isChatChannel, type ChatChannel } from '../../contracts/chat-channel.ts'
import { chooseReminderChannel } from './fallback-channel.ts'
import { hasCalendarDate } from '../../contracts/reminder-calendar.ts'
import type { PendingReminder, ReminderResolutionInput } from '../reminder-turn.ts'

export const MAX_REMINDER_PLAN_ITEMS = 100
export interface ReminderMaterial { id: string; text: string; createdAt: number; dataUrl?: string; truncated?: boolean }
export type ReminderPlanItem =
  | { operation: 'create'; sourceId: string; timeText: string; dateText?: string; eventText?: string; text: string; leadMinutes?: number }
  | { operation: 'reschedule'; targetIntentId: string; sourceId: string; timeText: string; dateText?: string; leadMinutes?: number }
  | { operation: 'cancel'; targetIntentId: string }
  | { operation: 'confirm'; targetIntentId: string; text?: string }
export interface ReminderPlanDraft { kind: 'batch'; items: readonly ReminderPlanItem[]; channel?: ChatChannel | 'current' | 'unsupported' }
export interface ReminderPlanReading { operation: string; status: 'created' | 'existing' | 'updated' | 'cancelled' | 'skipped' | 'failed'; id?: string; dueAt?: number; text?: string; channel?: ChatChannel; code?: string }
export interface ReminderPlanResult { kind: 'planned'; code: 'reminder_plan_result'; message: string; items: readonly ReminderPlanReading[]; sourceRefs: readonly string[] }
export interface ReminderWritePorts {
  create: (input: { text: string; dueAt: number; timezone: string; sourceRefs: readonly string[]; timeSourceId: string; channel: ChatChannel }) => Promise<PendingReminder & { created: boolean }>
  reschedule?: (target: PendingReminder, dueAt: number) => Promise<boolean>
  cancel?: (target: PendingReminder) => Promise<boolean>
}

export function readReminderPlan(value: Record<string, unknown>): ReminderPlanDraft | undefined {
  if (Object.keys(value).some(key => !['kind', 'items', 'channel'].includes(key)) || !Array.isArray(value.items)
    || value.items.length < 1 || value.items.length > MAX_REMINDER_PLAN_ITEMS) return undefined
  if (value.channel !== undefined && !isChatChannel(value.channel) && value.channel !== 'current' && value.channel !== 'unsupported') return undefined
  for (const raw of value.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const item = raw as Record<string, unknown>
    const keys = item.operation === 'create' ? ['operation', 'sourceId', 'timeText', 'dateText', 'eventText', 'text', 'leadMinutes']
      : item.operation === 'reschedule' ? ['operation', 'targetIntentId', 'sourceId', 'timeText', 'dateText', 'leadMinutes']
        : item.operation === 'cancel' ? ['operation', 'targetIntentId']
          : item.operation === 'confirm' ? ['operation', 'targetIntentId', 'text'] : undefined
    if (!keys || Object.keys(item).some(key => !keys.includes(key))) return undefined
    const required = item.operation === 'cancel' || item.operation === 'confirm' ? ['targetIntentId'] : item.operation === 'create'
      ? ['sourceId', 'timeText', 'text'] : ['targetIntentId', 'sourceId', 'timeText']
    if (required.some(key => typeof item[key] !== 'string' || !(item[key] as string).trim() || (item[key] as string).length > 2000)) return undefined
    if (item.text !== undefined && (typeof item.text !== 'string' || [...item.text].length > MAX_NOTIFICATION_TEXT_CODEPOINTS)) return undefined
    if (item.dateText !== undefined && (typeof item.dateText !== 'string' || item.dateText.length > 80)) return undefined
    if (item.eventText !== undefined && (typeof item.eventText !== 'string' || !item.eventText.trim() || item.eventText.length > 120)) return undefined
    if (item.leadMinutes !== undefined && (!Number.isInteger(item.leadMinutes) || Number(item.leadMinutes) < 0 || Number(item.leadMinutes) > 1440)) return undefined
  }
  return value as unknown as ReminderPlanDraft
}

function requestedLead(text: string, now: number): number {
  const match = /(?:提前|前)\s*([0-9]{1,4}|[零一两二三四五六七八九十]{1,3})\s*分钟/u.exec(text)
  if (!match) return 0
  if (/^\d+$/u.test(match[1]!)) return Number(match[1]) <= 1440 ? Number(match[1]) : -1
  const parsed = readReminderRequest({ text: `${match[1]}分钟后提醒我`, now })
  return parsed.kind === 'scheduled' ? (parsed.dueAt - now) / 60_000 : -1
}

export function formatReminderTime(dueAt: number): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(dueAt)
}

/** Compile the complete proposal before the first write. Model output is never a timestamp authority. */
export async function executeReminderPlan(input: ReminderResolutionInput & { now: number }, draft: ReminderPlanDraft, ports: ReminderWritePorts): Promise<ReminderPlanResult | { kind: 'clarify' | 'refused'; code: string; message: string }> {
  const sources: ReminderMaterial[] = [input.current, ...input.recent.filter(item => item.actor !== 'character'), ...(input.materials ?? [])]
  const choice = chooseReminderChannel({ ...(draft.channel ? { requested: draft.channel === 'current' ? input.entry ?? 'qq_private' : draft.channel } : {}),
    ...(input.entry ? { entry: input.entry } : {}), ...(input.availableChannels ? { available: input.availableChannels } : {}) })
  const channel = choice?.channel ?? (draft.channel === 'unsupported' ? undefined : draft.channel === 'current' ? input.entry ?? 'qq_private' : draft.channel ?? input.entry ?? 'qq_private')
  if (channel === undefined) return { kind: 'refused', code: 'reminder_channel_unsupported', message: '指定的提醒渠道尚未支持，未设置提醒。' }
  if (input.availableChannels && !input.availableChannels.includes(channel)) return { kind: 'refused', code: 'reminder_channel_unavailable', message: '当前没有可投递的提醒出口，未执行本批操作。' }
  const prepared: { item: ReminderPlanItem; dueAt?: number; timezone?: string; source?: ReminderMaterial; target?: PendingReminder }[] = []
  const lead = requestedLead(input.current.text, input.current.createdAt)
  const targets = new Set<string>()
  for (const item of draft.items) {
    const target = 'targetIntentId' in item ? input.pending.find(row => row.id === item.targetIntentId) : undefined
    if ('targetIntentId' in item && (!target || targets.has(item.targetIntentId))) return { kind: 'refused', code: 'reminder_target_invalid', message: '提醒目标不存在或同批被重复修改，整批尚未执行。' }
    if (target) targets.add(target.id)
    if (item.operation === 'cancel' || item.operation === 'confirm') { prepared.push({ item, target }); continue }
    const source = sources.find(row => row.id === item.sourceId)
    if (!source || source.truncated) return { kind: 'clarify', code: 'reminder_source_incomplete', message: '本批提醒缺少完整的原始资料，尚未执行；请补充缺失部分。' }
    if (item.operation === 'create' && item.eventText && [...`${item.eventText.trim()}：${item.text}`].length > MAX_NOTIFICATION_TEXT_CODEPOINTS) {
      return { kind: 'refused', code: 'reminder_text_too_long', message: '有一条提醒正文过长，整批尚未执行。' }
    }
    if (!source.dataUrl && (!source.text.includes(item.timeText) || (item.dateText !== undefined && !source.text.includes(item.dateText))
      || (item.operation === 'create' && item.eventText !== undefined && !source.text.includes(item.eventText)))) {
      return { kind: 'refused', code: 'reminder_time_source_mismatch', message: '候选时间与原始资料对不上，整批尚未执行。' }
    }
    if ((item.leadMinutes ?? 0) !== lead) return { kind: 'clarify', code: 'reminder_offset_mismatch', message: '提前量与本轮要求不一致，整批尚未执行。' }
    let timeText = [item.dateText, item.timeText].filter(Boolean).join(' ')
    const dated = hasCalendarDate(timeText) || /今天|明天|今晚|明晚|今早|次日/u.test(timeText)
    const relative = /(?:分钟|分|秒|小时|天|min(?:ute)?s?|h(?:ou)?rs?)\s*(?:之)?后/iu.test(timeText)
    if (!dated && !relative && (source.id !== input.current.id || hasCalendarDate(source.text))) {
      return { kind: 'clarify', code: 'reminder_event_date_missing', message: '事件只有钟点，缺少对应日期；整批尚未执行，请补充日期。' }
    }
    const weekScope = /本周|这周|下周|上周/u.exec(input.current.text)?.[0]
    if (weekScope && /^(?:周|星期)[一二三四五六日天]/u.test(timeText)) timeText = `${weekScope[0]}${timeText}`
    const read = readReminderRequest({ text: timeText, now: weekScope ? input.current.createdAt : source.createdAt, forceReminderIntent: true })
    if (read.kind !== 'scheduled' && !(read.kind === 'refused' && read.code === 'reminder_due_at_not_future')) {
      return { kind: 'clarify', code: 'reminder_plan_time_unreadable', message: '有一项的日期或时刻不完整、无效或有多个解释，整批尚未执行；请补充对应时间。' }
    }
    // Past events are recorded as skipped; they must never become immediate catch-up messages.
    prepared.push({ item, source, target, ...(read.kind === 'scheduled' ? { dueAt: read.dueAt - lead * 60_000, timezone: read.timezone } : {}) })
  }
  const readings: ReminderPlanReading[] = []
  const created: PendingReminder[] = []
  for (const entry of prepared) {
    const { item, target, source, dueAt } = entry
    try {
      if (item.operation === 'confirm') {
        readings.push({ operation: item.operation, status: 'existing', id: target!.id, dueAt: target!.dueAt, text: target!.text, channel: target!.channel ?? 'qq_private' })
      } else if (item.operation === 'cancel') {
        const ok = await ports.cancel?.(target!)
        readings.push({ operation: item.operation, status: ok ? 'cancelled' : 'failed', id: target!.id, text: target!.text, code: ok ? undefined : 'reminder_cancel_conflict' })
      } else if (dueAt === undefined || dueAt <= input.now) {
        readings.push({ operation: item.operation, status: 'skipped', code: 'reminder_time_passed', text: 'text' in item ? item.text : target?.text })
      } else if (item.operation === 'reschedule') {
        const ok = await ports.reschedule?.(target!, dueAt)
        readings.push({ operation: item.operation, status: ok ? 'updated' : 'failed', id: target!.id, dueAt: ok ? dueAt : target!.dueAt,
          text: target!.text, channel: target!.channel ?? 'qq_private', code: ok ? undefined : 'reminder_update_conflict' })
      } else {
        const title = item.eventText?.trim()
        const text = title ? `${title}：${item.text}` : item.text
        const existing = [...input.pending, ...created].find(row => row.dueAt === dueAt
          && (title ? row.text.startsWith(`${title}：`) : row.text === text) && (row.channel ?? 'qq_private') === channel)
        const written = existing ? { ...existing, created: false } : await ports.create({ text, dueAt, timezone: entry.timezone!,
          sourceRefs: [input.current.id, source!.id], timeSourceId: `${source!.id}:${notificationTextFingerprint(title ?? item.text)}`, channel })
        created.push(written)
        readings.push({ operation: item.operation, status: written.created ? 'created' : 'existing', id: written.id, dueAt: written.dueAt, text: written.text, channel: written.channel ?? channel })
      }
    } catch { readings.push({ operation: item.operation, status: 'failed', code: 'reminder_write_failed', text: 'text' in item ? item.text : target?.text }) }
  }
  const count = (status: ReminderPlanReading['status']) => readings.filter(row => row.status === status).length
  const fallback = choice?.fallbackFrom || choice?.requestedUnsupported ? `（原指定渠道不可用，已改用${CHAT_CHANNEL_LABELS[channel]}）` : ''
  const lines = readings.map((row, i) => `${i + 1}. ${row.status === 'created' ? '已设置' : row.status === 'existing' ? '已存在' : row.status === 'updated' ? '已改期' : row.status === 'cancelled' ? '已取消' : row.status === 'skipped' ? '已过提醒时间，跳过' : '未完成'}${row.dueAt ? ` ${formatReminderTime(row.dueAt)}` : ''}${row.channel ? `，通过${CHAT_CHANNEL_LABELS[row.channel]}` : ''}：${row.text ?? '本项处理未完成'}`)
  return { kind: 'planned', code: 'reminder_plan_result', items: readings, sourceRefs: [...new Set([input.current.id, ...prepared.flatMap(row => row.source ? [row.source.id] : [])])],
    message: `提醒处理：新增${count('created')}条，已有${count('existing')}条，改期${count('updated')}条，取消${count('cancelled')}条，跳过${count('skipped')}条，失败${count('failed')}条。${fallback}\n${lines.join('\n')}` }
}
