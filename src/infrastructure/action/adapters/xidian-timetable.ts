import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import type { CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { XIDIAN_TIMETABLE } from '../../../kernel/action/xidian-capability.ts'
import { renderTimetable, validateSnapshot, parseDate } from '../../xidian/timetable.ts'
import type { LocalTextTurnContent } from '../../../kernel/contracts/turn-content.ts'
import { TURN_CONTENT_LIMITS } from '../../../kernel/contracts/turn-content.ts'

export const XIDIAN_STATE_DIR = resolve(process.env.PROJECT_LG_XIDIAN_DIR ?? 'data/xidian')
export function createXidianTimetableAdapter(options: {
  directory?: string
} = {}): CapabilityAdapter {
  const directory = options.directory ?? XIDIAN_STATE_DIR
  return { capabilityId: XIDIAN_TIMETABLE,
    async execute(input) {
      const fail = (code: 'permission_denied' | 'validation_failed' | 'execution_failed', message: string): never => {
        throw new ActionFailureError(actionFailure(code,message))
      }
      if (input.operation !== 'query' || Object.keys(input.args).some(k => !['date','days'].includes(k))) fail('validation_failed','课表仅接受 query、date 和 days。')
      const now = Number(input.now())
      const date = input.args.date ?? new Date(now+8*3600000).toISOString().slice(0,10)
      const days = input.args.days ?? 7
      if (typeof date !== 'string' || !Number.isInteger(days) || Number(days) < 1 || Number(days) > 7) fail('validation_failed','日期需为 YYYY-MM-DD，天数为 1–7。')
      try { parseDate(date as string) } catch { fail('validation_failed','课表查询日期无效。') }
      try {
        const path = resolve(directory,'timetable.json')
        if ((await stat(path)).size > 2*1024*1024) fail('execution_failed','课表快照超出大小限制。')
        const raw = await readFile(path,'utf8')
        const snapshot = validateSnapshot(JSON.parse(raw))
        if (snapshot.fetchedAt > now+60000 || now-snapshot.fetchedAt > 6*3600000) fail('execution_failed','课表同步已超过六小时或时间无效，不能据此确认当前课表；请检查同步服务和学校认证。')
        let syncFailed = false
        try {
          const status = JSON.parse(await readFile(resolve(directory,'status.json'),'utf8'))
          syncFailed = status.ok !== true && status.attemptedAt >= snapshot.fetchedAt
        } catch { syncFailed = true }
        const text = (syncFailed ? '最近同步未成功或状态不可核验，以下是六小时内的缓存，后续变更可能尚未同步。\n' : '') + renderTimetable(snapshot,date as string,Number(days))
        // Return whole day results or fail; never silently truncate a class list into "no class".
        if (text.length > TURN_CONTENT_LIMITS.maxTextChars) fail('execution_failed','课表结果过大，请缩短查询天数。')
        const fingerprint = createHash('sha256').update(raw).digest('hex')
        const content: LocalTextTurnContent = {
          contentId: `${input.actionId}:xidian`, capability: XIDIAN_TIMETABLE, operation:'query',
          kind:'local-text', sourceKind:'remote-service', resourceRef:'xidian:owner-undergraduate-timetable',
          sourceFingerprint:fingerprint, resultFingerprint:createHash('sha256').update(text).digest('hex'),
          scope:{ totalChars:text.length, includedChars:text.length, truncated:false },
          facts:[`来源：西电本科 eHall 的后台同步快照`, `成功同步时间：${new Date(snapshot.fetchedAt).toISOString()}`, '时区：Asia/Shanghai',
            `最近同步状态：${syncFailed ? '未成功或不可核验，使用缓存' : '成功'}`, '含调停补课处理；不含独立考试及实验预约；不自动写入长期记忆。'],
          text, mediaType:'application/x-xidian-timetable', lineCount:text.split('\n').length, sourceBytes:Buffer.byteLength(raw),
        }
        return { effect:{ kind:'content_read',detail:'读取西电本科课表快照',fingerprint:content.resultFingerprint }, turnContent:[content] }
      } catch (error) {
        if (error instanceof ActionFailureError) throw error
        return fail('execution_failed','尚无有效课表快照；需先配置并完成一次学校登录与同步。')
      }
    },
  }
}
