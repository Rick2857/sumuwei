import { zh } from 'chrono-node'

/** Only calendar expressions use Chrono; existing elapsed-time reminders keep their semantics. */
export function hasCalendarDate(text: string): boolean {
  return /\d{4}[-/]\d|[0-9一二三四五六七八九十]月|后天|[本这上下]周|星期|周[一二三四五六日天]|今年|明年|后年/u.test(text)
}

export function readCalendarComponents(text: string, now: number, offsetMinutes: number): {
  year: number; month: number; day: number; hour: number; minute: number; matched: string
} | undefined {
  // Chrono's Chinese locale does not consume YYYY/MM/DD or relative years completely.
  const local = new Date(now + offsetMinutes * 60_000)
  const year = local.getUTCFullYear()
  const monday = Date.UTC(year, local.getUTCMonth(), local.getUTCDate() - (local.getUTCDay() + 6) % 7)
  const normalized = text.replace(/(\d{4})\/(\d{1,2})\/(\d{1,2})/gu, '$1-$2-$3')
    .replace(/今年|明年|后年/gu, word => `${year + (word === '明年' ? 1 : word === '后年' ? 2 : 0)}年`)
    .replace(/(本|这|上|下)(?:周|星期)([一二三四五六日天])/gu, (_match, shift: string, weekday: string) => {
      const date = new Date(monday + ((shift === '下' ? 7 : shift === '上' ? -7 : 0) + '一二三四五六日'.indexOf(weekday === '天' ? '日' : weekday)) * 86_400_000)
      return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`
    })
  const results = zh.hans.parse(normalized, { instant: new Date(now), timezone: offsetMinutes })
  if (results.length !== 1 || results[0]!.end != null) return undefined
  const result = results[0]!
  if (result.start.isCertain('timezoneOffset') && result.start.get('timezoneOffset') !== offsetMinutes) return undefined
  if (!result.start.isCertain('hour') || (!result.start.isCertain('day') && !result.start.isCertain('weekday'))) return undefined
  // Reject partial extraction: an unread date/clock must never fall back to today's clock.
  const outside = normalized.slice(0, result.index) + normalized.slice(result.index + result.text.length)
  if (/\d{4}[-年/]|\d{1,2}[月日号:：]|[本这上下]周|星期|后天/u.test(outside)) return undefined
  return {
    year: result.start.get('year')!, month: result.start.get('month')!, day: result.start.get('day')!,
    hour: result.start.get('hour')!, minute: result.start.get('minute') ?? 0, matched: result.text,
  }
}
