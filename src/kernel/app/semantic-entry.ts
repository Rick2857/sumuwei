import { readReminderDraft, type ReminderDraft, type ReminderResolutionInput } from './reminder-turn.ts'
import { readRelayDraft, type RelayDraft, type RelayTaskView } from './relay-turn.ts'
import { readGroupTaskDraft, type GroupTaskDraft, type GroupTaskView } from '../contracts/qq-group-task.ts'
import { validateGoalProposalDraft, type GoalProposalDraft } from '../contracts/goal-proposal.ts'
import type { GoalCandidateSummary } from './goal/understanding.ts'
import type { ExplicitMemoryIntentKind } from './memory/intent-detector.ts'

export const SEMANTIC_DOMAINS = ['memory', 'reminder', 'goal', 'tools', 'relay', 'group_task'] as const
export type SemanticDomain = typeof SEMANTIC_DOMAINS[number]
export interface SemanticMemoryCommand { kind: ExplicitMemoryIntentKind; payload: string; targetId?: string }
export interface SemanticEntryInput {
  current: ReminderResolutionInput['current']
  recent: ReminderResolutionInput['recent']
  pending: ReminderResolutionInput['pending']
  materials?: ReminderResolutionInput['materials']
  memories: readonly { id: string; content: unknown }[]
  goals: readonly GoalCandidateSummary[]
  relayTasks: readonly RelayTaskView[]
  /** 群任务（ADR-156）：只在 `group_task` 域启用时读取；**只读事实**，不是授权 */
  groupTasks: readonly GroupTaskView[]
  /**
   * ADR-156：机器人**实际所在**的群（只读；消歧用）。
   *
   * ⚠️ 提供它 ⇒ 建单草稿里的群号必须**在列表里**（否则整条 `invalid_output`）：
   *    模型不许编群号。`undefined` = 拿不到群列表（此时不校验，由运行时再失败关闭）。
   */
  qqGroups?: readonly { readonly groupId: string; readonly groupName: string }[]
  enabledDomains: readonly SemanticDomain[]
  toolCatalog: string
  availableCapabilities: readonly string[]
  /** Trusted current-reply presentation capability; not an executable tool or relay permission. */
  replyMedia?: { qqVoiceAvailable: true }
  knownDirectories?: readonly string[]
  openTask?: { originalText: string }
  entry: ReminderResolutionInput['entry']
  availableChannels: ReminderResolutionInput['availableChannels']
  /** Previously proposed domains are never offered again after a tool read. */
  priorDomains?: readonly SemanticDomain[]
  omittedMemories?: number
  unavailableMaterials?: number
  /** Channel-supplied conversational data; quoted senders cannot authorize actions. */
  conversationContext?: readonly string[]
}
export interface SemanticPlan {
  memory?: SemanticMemoryCommand
  reminder?: ReminderDraft
  goal?: GoalProposalDraft
  tools?: unknown
  relay?: RelayDraft
  /** ADR-156：群任务（建/改/停/查）；群号由程序消歧，授权由程序绑定 */
  group_task?: GroupTaskDraft
}
export type SemanticEntryResult = { kind: 'planned'; plan: SemanticPlan }
  | { kind: 'clarify'; question: string }
  | { kind: 'failed'; code: 'transport' | 'timeout' | 'invalid_output' | 'context_unavailable' }
export interface SemanticToolContext {
  catalog: string
  capabilities: readonly string[]
  knownDirectories?: readonly string[]
  openTask?: { originalText: string }
  validate: (draft: unknown) => void
}
export interface SemanticToolCall { function: { name: string; arguments: string } }

/** Validate every proposal before any domain may write. Model prose never grants authority. */
export function readSemanticToolCalls(calls: readonly SemanticToolCall[], input: SemanticEntryInput,
  validateTools?: SemanticToolContext['validate']): SemanticEntryResult {
  const invalid = (): SemanticEntryResult => ({ kind: 'failed', code: 'invalid_output' })
  if (calls.length > SEMANTIC_DOMAINS.length) return invalid()
  const plan: SemanticPlan = {}
  const userSources = new Set([input.current.id, ...input.recent.filter(row => row.actor !== 'character').map(row => row.id)])
  const sources = new Set([...userSources, ...(input.materials ?? []).map(row => row.id)])
  try {
    for (const call of calls) {
      const raw: unknown = JSON.parse(call.function.arguments)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid()
      const draft = raw as Record<string, unknown>
      if (call.function.name === 'lg_clarify') {
        if (calls.length !== 1 || Object.keys(draft).length !== 1 || typeof draft.question !== 'string'
          || !draft.question.trim() || draft.question.length > 500) return invalid()
        return { kind: 'clarify', question: draft.question }
      }
      if (!call.function.name.startsWith('lg_')) return invalid()
      const domain = call.function.name.slice(3) as SemanticDomain
      if (!SEMANTIC_DOMAINS.includes(domain) || !input.enabledDomains.includes(domain) || domain in plan) return invalid()
      if (input.priorDomains && (input.priorDomains.includes(domain) || domain === 'memory' || domain === 'tools')) return invalid()
      if (domain === 'memory') {
        if (Object.keys(draft).some(key => !['kind', 'payload', 'targetId'].includes(key))
          || !['remember', 'correct', 'forget', 'dispute'].includes(String(draft.kind))
          || typeof draft.payload !== 'string' || !draft.payload.trim() || !input.current.text.includes(draft.payload)
          || (draft.kind !== 'remember' && !input.memories.some(row => row.id === draft.targetId))
          || (draft.kind === 'remember' && draft.targetId !== undefined)) return invalid()
        plan.memory = draft as unknown as SemanticMemoryCommand
      } else if (domain === 'reminder') {
        const value = readReminderDraft(draft)
        if (!value || value.kind === 'none' || value.kind === 'clarify') return invalid()
        if ('targetIntentId' in value && !input.pending.some(row => row.id === value.targetIntentId)) return invalid()
        if ('timeSourceId' in value && !sources.has(value.timeSourceId)) return invalid()
        if (value.kind === 'batch' && (value.requestSourceId && !sources.has(value.requestSourceId)
          || value.items.some(item => 'sourceId' in item && !sources.has(item.sourceId)
            || 'targetIntentId' in item && !input.pending.some(row => row.id === item.targetIntentId)))) return invalid()
        plan.reminder = value
      } else if (domain === 'goal') {
        const verdict = validateGoalProposalDraft(draft, { sourceText: input.current.text,
          proposalSourceText: [...input.recent].reverse().find(row => row.actor === 'character')?.text,
          candidateGoalIds: input.goals.map(row => row.goalId) })
        if (!verdict.ok || verdict.draft.operation === 'none') return invalid()
        plan.goal = verdict.draft
      } else if (domain === 'relay') {
        const value = readRelayDraft(draft)
        if (!value || value.kind === 'none') return invalid()
        if (value.kind === 'cancel' && !input.relayTasks.some(row => row.id === value.taskId)) return invalid()
        if (value.kind === 'create' && [value.requestSourceId, ...value.sourceIds].some(id => !userSources.has(id))) return invalid()
        plan.relay = value
      } else if (domain === 'group_task') {
        /*
         * ADR-156：群任务域（只解析**形状**，不解析群号、不做授权）。
         *
         * ⚠️ 群号必须由**程序**在真实群列表里核对（`runtime/qq-group-task-runtime.ts`）；
         *    这里只保证：形状闭合、改/停的目标必须在**当前任务列表**里、
         *    版本必须与模型看到的那一版一致（否则等它自己重读，不许盲改）。
         */
        const value = readGroupTaskDraft(draft)
        if (!value || value.kind === 'none') return invalid()
        if (value.kind === 'modify' || value.kind === 'status') {
          const task = input.groupTasks.find(row => row.id === value.taskId)
          if (task === undefined || task.version !== value.expectedVersion) return invalid()
        }
        /* 模型不许编群号：给了真实群列表就必须在列表里（同名/不确定应由 lg_clarify 处理） */
        if (value.kind === 'create' && input.qqGroups !== undefined
          && !input.qqGroups.some(row => row.groupId === value.spec.groupId)) return invalid()
        plan.group_task = value
      } else {
        if (!validateTools) return invalid()
        validateTools(draft)
        if (draft.branch !== 'tools') return invalid()
        plan.tools = draft
      }
    }
    return { kind: 'planned', plan }
  } catch { return invalid() }
}

export function semanticDomainSelected(result: SemanticEntryResult | undefined, domain: SemanticDomain): boolean {
  return result === undefined || result.kind === 'planned' && result.plan[domain] !== undefined
}

export function semanticEntryFact(result: SemanticEntryResult): string {
  return ['【本轮统一语义入口】', result.kind === 'planned'
    ? `已选择操作域：${Object.keys(result.plan).join('、') || '无；普通对话'}。提案不代表执行成功，以各域实际结果为准。`
    : result.kind === 'clarify' ? `需要澄清（该次理解没有执行操作）：${JSON.stringify(result.question)}`
      : `统一理解失败：${result.code}；该次理解没有执行操作，未退回关键词路径。处理失败不表示用户表达不清楚。`,
  '由你根据程序事实自然回答；不要输出内部路由标签或固定操作回执。'].join('\n')
}
