import { readReminderRequest } from '../../contracts/notification-intake.ts'
import { MAX_NOTIFICATION_TEXT_CODEPOINTS, notificationTextFingerprint } from '../../contracts/notification.ts'
import { CHAT_CHANNEL_LABELS, isChatChannel, type ChatChannel } from '../../contracts/chat-channel.ts'
import { chooseReminderChannel } from './fallback-channel.ts'
import type { PendingReminder, ReminderResolutionInput } from '../reminder-turn.ts'
import { isReminderRepeatMode, type ReminderRepeatMode } from './repeat-mode.ts'

export const MAX_REMINDER_PLAN_ITEMS = 100
export interface ReminderMaterial { id: string; text: string; createdAt: number; dataUrl?: string; truncated?: boolean }
export type ReminderPlanItem =
  | { operation: 'create'; sourceId: string; timeText: string; dateText?: string; eventText?: string; text: string; leadMinutes?: number }
  | { operation: 'reschedule'; targetIntentId: string; sourceId: string; timeText: string; dateText?: string; leadMinutes?: number }
  | { operation: 'cancel'; targetIntentId: string }
  | { operation: 'confirm'; targetIntentId: string; text?: string }
export interface ReminderPlanDraft { kind: 'batch'; items: readonly ReminderPlanItem[]; channel?: ChatChannel | 'current' | 'unsupported'; repeat?: ReminderRepeatMode; requestSourceId?: string }
export interface ReminderPlanReading { operation: string; status: 'created' | 'existing' | 'updated' | 'cancelled' | 'skipped' | 'failed'; id?: string; dueAt?: number; text?: string; channel?: ChatChannel; code?: string; repeatMode?: string }
export interface ReminderPlanResult { kind: 'planned'; code: 'reminder_plan_result'; message: string; items: readonly ReminderPlanReading[]; sourceRefs: readonly string[] }
export interface ReminderWritePorts {
  create: (input: { text: string; dueAt: number; timezone: string; sourceRefs: readonly string[]; timeSourceId: string; channel: ChatChannel; repeatMode?: ReminderRepeatMode }) => Promise<PendingReminder & { created: boolean }>
  update?: (target: PendingReminder, text: string, sourceRefs: readonly string[], channel?: ChatChannel, repeatMode?: ReminderRepeatMode) => Promise<boolean>
  reschedule?: (target: PendingReminder, dueAt: number, repeatMode?: ReminderRepeatMode) => Promise<boolean>
  cancel?: (target: PendingReminder) => Promise<boolean>
}

export function readReminderPlan(value: Record<string, unknown>): ReminderPlanDraft | undefined {
  if (Object.keys(value).some(key => !['kind', 'items', 'channel', 'repeat', 'requestSourceId'].includes(key)) || !Array.isArray(value.items)
    || value.items.length < 1 || value.items.length > MAX_REMINDER_PLAN_ITEMS) return undefined
  if (value.channel !== undefined && !isChatChannel(value.channel) && value.channel !== 'current' && value.channel !== 'unsupported') return undefined
  if (value.repeat !== undefined && !isReminderRepeatMode(value.repeat)) return undefined
  if (value.requestSourceId !== undefined && (typeof value.requestSourceId !== 'string' || !value.requestSourceId.trim() || value.requestSourceId.length > 2000)) return undefined
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
  const requests = [input.current, ...[...input.recent].reverse()].filter(row => row.actor !== 'character')
  const request = draft.requestSourceId ? requests.find(row => row.id === draft.requestSourceId) : input.current
  if (!request) return { kind: 'clarify', code: 'reminder_request_missing', message: '候选引用的用户消息不存在，本批尚未执行。' }
  const targets = new Set<string>()
  for (const item of draft.items) {
    const target = 'targetIntentId' in item ? input.pending.find(row => row.id === item.targetIntentId) : undefined
    if ('targetIntentId' in item && (!target || targets.has(item.targetIntentId))) return { kind: 'refused', code: 'reminder_target_invalid', message: '提醒目标不存在或同批被重复修改，整批尚未执行。' }
    if (target) targets.add(target.id)
    if (item.operation === 'cancel' || item.operation === 'confirm') { prepared.push({ item, target }); continue }
    const source = sources.find(row => row.id === item.sourceId)
    if (!source) return { kind: 'clarify', code: 'reminder_source_incomplete', message: '本批提醒引用的原始资料不存在，尚未执行。' }
    if (item.operation === 'create' && item.eventText && [...`${item.eventText.trim()}：${item.text}`].length > MAX_NOTIFICATION_TEXT_CODEPOINTS) {
      return { kind: 'refused', code: 'reminder_text_too_long', message: '有一条提醒正文过长，整批尚未执行。' }
    }
    const lead = item.leadMinutes ?? 0
    const timeText = [item.dateText, item.timeText].filter(Boolean).join(' ')
    const read = readReminderRequest({ text: timeText, now: source.createdAt, forceReminderIntent: true })
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
        const changeRepeat = draft.repeat !== undefined && draft.repeat !== (target!.repeatMode ?? 'once')
        const ok = !changeRepeat || await ports.update?.(target!, target!.text, [input.current.id, ...(request ? [request.id] : [])], target!.channel, draft.repeat)
        readings.push({ operation: item.operation, status: !ok ? 'failed' : changeRepeat ? 'updated' : 'existing', id: target!.id, dueAt: target!.dueAt, text: target!.text, channel: target!.channel ?? 'qq_private', repeatMode: ok ? draft.repeat ?? target!.repeatMode : target!.repeatMode, ...(!ok ? { code: 'reminder_update_conflict' } : {}) })
      } else if (item.operation === 'cancel') {
        const ok = await ports.cancel?.(target!)
        readings.push({ operation: item.operation, status: ok ? 'cancelled' : 'failed', id: target!.id, text: target!.text, code: ok ? undefined : 'reminder_cancel_conflict' })
      } else if (dueAt === undefined || dueAt <= input.now) {
        readings.push({ operation: item.operation, status: 'skipped', code: 'reminder_time_passed', text: 'text' in item ? item.text : target?.text })
      } else if (item.operation === 'reschedule') {
        const ok = await ports.reschedule?.(target!, dueAt, draft.repeat)
        readings.push({ operation: item.operation, status: ok ? 'updated' : 'failed', id: target!.id, dueAt: ok ? dueAt : target!.dueAt,
          text: target!.text, channel: target!.channel ?? 'qq_private', repeatMode: ok ? draft.repeat ?? target!.repeatMode : target!.repeatMode, code: ok ? undefined : 'reminder_update_conflict' })
      } else {
        const title = item.eventText?.trim()
        const text = title ? `${title}：${item.text}` : item.text
        const existing = [...input.pending, ...created].find(row => row.dueAt === dueAt
          && (title ? row.text.startsWith(`${title}：`) : row.text === text) && (row.channel ?? 'qq_private') === channel)
        const sourceRefs = [...new Set([input.current.id, source!.id, ...(request ? [request.id] : [])])]
        const changeRepeat = existing && draft.repeat !== undefined && draft.repeat !== (existing.repeatMode ?? 'once')
        if (changeRepeat && !await ports.update?.(existing, existing.text, sourceRefs, existing.channel, draft.repeat)) {
          readings.push({ operation: item.operation, status: 'failed', id: existing.id, code: 'reminder_update_conflict', text }); continue
        }
        const written = existing ? { ...existing, created: false } : await ports.create({ text, dueAt, timezone: entry.timezone!,
          sourceRefs, timeSourceId: `${source!.id}:${notificationTextFingerprint(title ?? item.text)}`, channel,
          ...(draft.repeat === undefined ? {} : { repeatMode: draft.repeat }) })
        created.push(written)
        readings.push({ operation: item.operation, status: written.created ? 'created' : changeRepeat ? 'updated' : 'existing', id: written.id, dueAt: written.dueAt, text: written.text, channel: written.channel ?? channel, repeatMode: draft.repeat ?? written.repeatMode })
      }
    } catch { readings.push({ operation: item.operation, status: 'failed', code: 'reminder_write_failed', text: 'text' in item ? item.text : target?.text }) }
  }
  const fallback = choice?.fallbackFrom || choice?.requestedUnsupported ? `（原指定渠道不可用，已改用${CHAT_CHANNEL_LABELS[channel]}）` : ''
  const lines = readings.map(row => {
    const subject = (row.text ?? '这项').split(/[：:]/u)[0]!.replace(/[。！!？?]$/u, '')
    if (row.status === 'cancelled') return `${subject}那条提醒已经取消了。`
    if (row.status === 'failed') return `${subject}的提醒${row.operation === 'cancel' ? '没能取消' : '未处理成功'}，尚未确认变更。`
    if (row.status === 'skipped') return `${subject}已过提醒时间，这次没有设置。`
    return `${subject}的提醒${row.status === 'existing' ? '已存在' : row.status === 'updated' ? row.operation === 'reschedule' ? '已改期' : '已更新' : '已设置'}${row.dueAt ? `，时间是${formatReminderTime(row.dueAt)}` : ''}${row.channel ? `，通过${CHAT_CHANNEL_LABELS[row.channel]}` : ''}${row.repeatMode === 'until_reply' ? '，到点后每60秒续发直到你回复' : ''}。`
  })
  return { kind: 'planned', code: 'reminder_plan_result', items: readings, sourceRefs: [...new Set([input.current.id, ...(request ? [request.id] : []), ...prepared.flatMap(row => row.source ? [row.source.id] : [])])],
    message: `${lines.join('\n')}${fallback}` }
}
