// Copyright 2026 Project LG contributors.
// SPDX-License-Identifier: MPL-2.0
// eHall field mappings adapted from BenderBlog/traintime_pda (MPL-2.0),
// lib/repository/ids_session/classtable_session.dart, commit e780e4d01ea740c979ff5c31b9db439dbc586864.
// Original copyright 2023-2025 BenderBlog Rodriguez and contributors; 2025 Traintime PDA authors.

export interface Course {
  code: string; number: string; name: string; teacher: string; classroom: string
  day: number; start: number; stop: number; weeks: string
}
export interface TimetableSnapshot {
  version: 1; semester: string; termStart: string; fetchedAt: number
  courses: Course[]; unarranged: string[]; changesApplied: number
}
type Row = Record<string, unknown>
export class XidianError extends Error {
  constructor(readonly code: string) { super(code) }
}
function text(value: unknown, max = 200): string {
  if (value == null) return ''
  if (typeof value !== 'string' && typeof value !== 'number') throw new XidianError('invalid_response')
  const result = String(value).replace(/[\r\n\x00-\x1f]/g, ' ').trim()
  if (result.length > max) throw new XidianError('invalid_response')
  return result
}
function integer(value: unknown, max: number): number {
  const n = Number(value)
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(n) || n < 1 || n > max) throw new XidianError('invalid_response')
  return n
}
function weeks(value: unknown): string {
  if (typeof value !== 'string' || !/^[01]{1,60}$/.test(value)) throw new XidianError('invalid_response')
  return value
}
export function parseDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new XidianError('invalid_date')
  const ms = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new XidianError('invalid_date')
  return ms
}
export function rowsOf(body: unknown, table: string): Row[] {
  const b = body as { datas?: Record<string, { rows?: unknown; totalSize?: unknown; extParams?: { code?: unknown } }> }
  const data = b?.datas?.[table]
  if (!data || !Array.isArray(data.rows) || data.rows.length > 2000 ||
    data.rows.some(r => !r || typeof r !== 'object' || Array.isArray(r)) ||
    (data.extParams?.code !== undefined && String(data.extParams.code) !== '1') ||
    (data.totalSize !== undefined && (!/^\d+$/.test(String(data.totalSize)) || Number(data.totalSize) !== data.rows.length))) {
    throw new XidianError('incomplete_response')
  }
  return data.rows as Row[]
}
export function buildTimetable(input: {
  semester: string; termStart: string; rows: Row[]; changes: Row[]; unarranged: Row[]; fetchedAt: number
}): TimetableSnapshot {
  if (!/^\d{4}-\d{4}-[123]$/.test(input.semester)) throw new XidianError('invalid_semester')
  const termStart = /^(\d{4}-\d{2}-\d{2})(?: 00:00:00)?$/.exec(input.termStart)?.[1]
  if (!termStart) throw new XidianError('invalid_term_anchor')
  parseDate(termStart)
  // Upstream uses termStart + (week-1)*7 + weekday-1. Do not guess if that anchor changes.
  if (new Date(parseDate(termStart)).getUTCDay() !== 1) throw new XidianError('invalid_term_anchor')
  const courses: Course[] = input.rows.map(r => ({
    code: text(r.KCH), number: text(r.KXH), name: text(r.KCM), teacher: text(r.SKJS), classroom: text(r.JASMC),
    day: integer(r.SKXQ, 7), start: integer(r.KSJC, 11), stop: integer(r.JSJC, 11), weeks: weeks(r.SKZC),
  }))
  if (courses.some(c => !c.code || !c.name || c.start > c.stop)) throw new XidianError('invalid_response')
  const pending = [...input.changes]
  // Resolve chains by their actual source slot, without guessing order from display order.
  while (pending.length) {
    let progressed = false
    for (const change of [...pending]) {
      const type = text(change.TKLXDM)
      if (!['01', '02', '03'].includes(type)) throw new XidianError('unknown_change_type')
      const code = text(change.KCH), number = text(change.KXH)
      if (!code) throw new XidianError('unresolved_changes')
      const originalWeeks = weeks(change.SKZC ?? change.XSKZC)
      const matching = type === '03' ? [] : courses.filter(c => c.code === code &&
        (!number || c.number === number) && c.day === integer(change.SKXQ, 7) &&
        c.start === integer(change.KSJC, 11) && c.stop === integer(change.JSJC, 11) &&
        [...originalWeeks].some((bit, i) => bit === '1' && c.weeks[i] === '1'))
      if (type !== '03' && !matching.length) continue
      if (!number && new Set(matching.map(c => c.number)).size > 1) throw new XidianError('ambiguous_change')
      if (matching.some(c => [...originalWeeks].some((bit, i) => bit === '1' && c.weeks[i] !== '1'))) {
        throw new XidianError('unresolved_changes')
      }
      const base = matching[0]
      for (const course of matching) course.weeks = [...course.weeks].map((bit, i) => originalWeeks[i] === '1' ? '0' : bit).join('')
      if (type !== '02') {
        const added: Course = {
          code, number: number || base?.number || '', name: text(change.KCM) || base?.name || '',
          teacher: text(change.XSKJS ?? change.YSKJS) || base?.teacher || '',
          classroom: text(change.XJASMC ?? change.JASMC) || base?.classroom || '',
          day: integer(change.XSKXQ ?? change.SKXQ, 7), start: integer(change.XKSJC ?? change.KSJC, 11),
          stop: integer(change.XJSJC ?? change.JSJC, 11), weeks: weeks(change.XSKZC ?? change.SKZC),
        }
        if (!added.name || added.start > added.stop) throw new XidianError('unresolved_changes')
        courses.push(added)
      }
      pending.splice(pending.indexOf(change), 1)
      progressed = true
    }
    if (!progressed) throw new XidianError('unresolved_changes')
  }
  return { version: 1, semester: input.semester, termStart, fetchedAt: input.fetchedAt,
    courses, unarranged: input.unarranged.map(r => text(r.KCM)).filter(Boolean), changesApplied: input.changes.length }
}

export function validateSnapshot(value: unknown): TimetableSnapshot {
  const s = value as TimetableSnapshot
  if (!s || s.version !== 1 || !/^\d{4}-\d{4}-[123]$/.test(s.semester) ||
    !Number.isFinite(s.fetchedAt) || !Array.isArray(s.courses) || s.courses.length > 4000 ||
    !Array.isArray(s.unarranged) || s.unarranged.length > 2000 || !Number.isInteger(s.changesApplied) || s.changesApplied < 0) {
    throw new XidianError('invalid_snapshot')
  }
  parseDate(s.termStart)
  if (new Date(parseDate(s.termStart)).getUTCDay() !== 1) throw new XidianError('invalid_term_anchor')
  for (const c of s.courses) {
    if (!c || !text(c.name) || !text(c.code) || text(c.number) !== c.number ||
      text(c.teacher) !== c.teacher || text(c.classroom) !== c.classroom || c.start > c.stop) throw new XidianError('invalid_snapshot')
    integer(c.day, 7); integer(c.start, 11); integer(c.stop, 11); weeks(c.weeks)
  }
  s.unarranged.forEach(n => { if (typeof n !== 'string' || text(n) !== n) throw new XidianError('invalid_snapshot') })
  return s
}

const TIMES = ['08:30','09:15','09:20','10:05','10:25','11:10','11:15','12:00','14:00','14:45','14:50','15:35','15:55','16:40','16:45','17:30','19:00','19:45','19:50','20:35','20:40','21:25']
export function renderTimetable(snapshot: TimetableSnapshot, date: string, days: number): string {
  const first = parseDate(date), anchor = parseDate(snapshot.termStart)
  const maxWeeks = Math.max(0, ...snapshot.courses.map(c => c.weeks.length))
  const lines = [`学期：${snapshot.semester}；学期起点：${snapshot.termStart}；时区：Asia/Shanghai`,
    `最后成功同步：${new Date(snapshot.fetchedAt).toISOString()}；已应用调停补课记录：${snapshot.changesApplied} 条。`,
    '范围：本科教务课表；不包含独立考试、实验预约、私人日历。钟点沿用 XDYou 节次表，学校调整作息时以校方通知为准。']
  for (let i = 0; i < days; i++) {
    const ms = first + i * 86400000, day = new Date(ms).getUTCDay() || 7
    const week = Math.floor((ms - anchor) / (7 * 86400000))
    const label = new Date(ms).toISOString().slice(0, 10)
    if (week < 0 || week >= maxWeeks) { lines.push(`${label}：不在已同步课表周次覆盖范围，不能据此判断无课。`); continue }
    const courses = snapshot.courses.filter(c => c.day === day && c.weeks[week] === '1').sort((a,b) => a.start-b.start)
    lines.push(`${label}（第 ${week+1} 周，星期${day}）：`)
    lines.push(...(courses.length ? courses.map(c => `  第${c.start}–${c.stop}节 ${TIMES[(c.start-1)*2]}–${TIMES[(c.stop-1)*2+1]} ${c.name}；教室：${c.classroom || '未给出'}；教师：${c.teacher || '未给出'}`) : ['  已同步的已排课记录中无课。']))
  }
  if (snapshot.unarranged.length) lines.push(`另有未排时间课程（不能计作无课）：${snapshot.unarranged.join('、')}`)
  return lines.join('\n')
}
