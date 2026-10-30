import type { CapabilityDefinition } from './capability-registry.ts'
import type { ScopeContext } from '../contracts/scope.ts'

export const PROJECT_SEARCH = 'project.search'
export const SELF_CAPABILITIES = 'self.capabilities'
export const PROJECT_READ_PERMISSION = 'project:read'
export const SELF_READ_PERMISSION = 'self:read'
export function mayReadProjectKnowledge(scope: ScopeContext | undefined): boolean {
  return scope === undefined || (scope.principal.kind === 'owner' && scope.purpose === 'external_query'
    && scope.room.kind === 'private' && scope.room.userId === scope.principal.userId)
}
export function createProjectKnowledgeDefinitions(): readonly CapabilityDefinition[] {
  return [
    { id: PROJECT_SEARCH, version: 'project.search@1',
      description: '只读查询 LG 项目资料库。search(query,limit可选1–3) 用主题词检索已导入原文；read(path,revision可选,section可选从0开始) 读取所引片段。返回文件、版本、行号及环境。资料含历史设计与报告，不能据此声称当前功能已启用；当前状态用 self.capabilities。',
      operations: [{ name: 'search', description: '按主题检索当前索引原文', sideEffect: 'read', riskLevel: 'R0' },
        { name: 'read', description: '按文件和片段定位读取，可显式指定历史版本', sideEffect: 'read', riskLevel: 'R0' }],
      sideEffectLevel: 'read', riskLevel: 'R0', permissions: [PROJECT_READ_PERMISSION], supportsDryRun: true, idempotency: 'none' },
    { id: SELF_CAPABILITIES, version: 'self.capabilities@1',
      description: '只读查询当前 LG 实例的能力事实。query(capability可选) 返回当前入口、开关、本会话工具候选、已授予权限及本地依赖检查。未探测的远端连接和实际执行结果保持未知；已登记/已开启/本地依赖齐全不能证明动作成功。',
      operations: [{ name: 'query', description: '读取当前实例能力，capability可选为精确能力ID', sideEffect: 'read', riskLevel: 'R0' }],
      sideEffectLevel: 'read', riskLevel: 'R0', permissions: [SELF_READ_PERMISSION], supportsDryRun: true, idempotency: 'none' },
  ]
}
