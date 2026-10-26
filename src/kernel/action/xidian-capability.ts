import type { CapabilityDefinition } from './capability-registry.ts'
import type { ScopeContext } from '../contracts/scope.ts'

export const XIDIAN_TIMETABLE = 'xidian.timetable'
export const XIDIAN_PERMISSION = 'xidian:timetable'

/** Legacy single-owner sessions have no ScopeContext; scoped sessions must be owner-private. */
export function mayReadXidianTimetable(scope: ScopeContext | undefined): boolean {
  return scope === undefined || (scope.principal.kind === 'owner' &&
    scope.purpose === 'external_query' && scope.room.kind === 'private' &&
    scope.room.userId === scope.principal.userId)
}

export function createXidianCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [{
    id: XIDIAN_TIMETABLE, version: `${XIDIAN_TIMETABLE}@1`,
    description: '查询原主人的西电本科课表同步快照。date 为北京时间 YYYY-MM-DD，days 为 1–7，缺省今天起七天。返回课程、教室、节次、调停课处理结果及同步时间；仅原主人私聊可用，不能代查其他账号。',
    operations: [{ name: 'query', description: '按日期查询已同步的课表（不修改教务数据）', sideEffect: 'read', riskLevel: 'R1' }],
    sideEffectLevel: 'read', riskLevel: 'R1', permissions: [XIDIAN_PERMISSION],
    supportsDryRun: true, idempotency: 'none',
  }]
}
