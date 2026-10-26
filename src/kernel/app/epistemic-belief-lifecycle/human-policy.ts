/** Review H1–H8, revision 2026-10-20. Revisable policy, not a permanent conclusion. */
import { BELIEF_INFERENCE_GUARDS, judgeExplanationDetail } from '../belief/patterns.ts'
import type { MemoryContent } from '../../contracts/memory.ts'

export type ExplanationPreference = 'concise' | 'detailed'
export const EBL_PREFERENCE_PREDICATE = 'preferred.explanation.style'
export const EBL_PREFERENCE_QUALIFIERS = { context: 'technical' } as const
export const EBL_TECHNICAL_CONTEXT = /技术|代码|编程|算法|数据库|程序|函数|软件|工程/
export const EBL_OTHER_CONTEXT = /(?:改聊|换成|现在聊|这次聊).*(?:闲聊|小说|日常)|(?:闲聊|小说|文案)(?:方面|的时候|时)/
export function isEblManagedStyle(content: MemoryContent): boolean {
  return content.kind === 'claim' && content.predicate === EBL_PREFERENCE_PREDICATE
    && (!content.qualifiers || Object.keys(content.qualifiers).length === 0
      || (Object.keys(content.qualifiers).length === 1 && content.qualifiers.context === 'technical'))
}
export interface PreferenceSignal {
  value: ExplanationPreference
  horizon: 'persistent' | 'turn'
  change: 'statement' | 'correction' | 'time_change'
  explicit: boolean
}
/** Bounded Chinese style adapter. Unknown language stays unknown; M9 grammar is unchanged. */
export function readEblPreference(text: string): PreferenceSignal | undefined {
  // Reported/quoted speech must be routed to its own verified subject by a future target adapter.
  const changed = /以前.*(?:现在|如今)/.test(text)
  if (BELIEF_INFERENCE_GUARDS.some(guard => guard.reason !== 'single_task_reference'
    && !(changed && guard.reason === 'past_preference_disclaimed') && guard.pattern.test(text))) return undefined
  if (/(?:你|他|她|别人|朋友)(?:一般|通常|更|都|很|比较)?(?:喜欢|需要)|["']|是否/.test(text)) return undefined
  if (!/解释|讲|说|步骤|结论|铺垫|展开|回答|回复|技术/.test(text) && !changed) return undefined
  const current = changed ? text.slice(Math.max(text.lastIndexOf('现在'), text.lastIndexOf('如今'))) : text
  if (/(?:不|没|别)(?:要|用|是|太|更|喜欢|需要)?(?:简短|简洁|详细|展开)/.test(current)) return undefined
  const detailed = /(?:需要|喜欢|请|要|更|想)(?:再|更|多|一点|一些|地|的)?(?:详细|展开)|详细(?:解释|展开|讲解)/.test(current)
  const concise = /(?:只(?:讲|说|要)|先给)(?:个|出)?结论|(?:喜欢|需要|请|要|更)(?:更|一点|一些)?(?:简短|简洁)/.test(current)
  const value = detailed !== concise ? (detailed ? 'detailed' : 'concise')
    : !detailed ? judgeExplanationDetail(current).value : undefined
  if (!value) return undefined
  const turn = /这题|这道题|这次|本次|这轮|本轮|这一次|这段|下一题|这个/.test(current)
  const stated = changed || /(?:以后|今后)(?:请|都|先)|(?:一般|通常|每次)(?:都)?(?:请|先|给)|我[^。！？]{0,12}(?:喜欢|需要)/.test(current)
  const persistent = stated
    || judgeExplanationDetail(current).value !== undefined
  return { value, horizon: !turn && persistent ? 'persistent' : 'turn',
    change: changed ? 'time_change' : /理解错|误解|纠正/.test(text) ? 'correction' : 'statement', explicit: stated || turn }
}

/** Subject/relevance are supplied by trusted routing, never guessed from the word "she". */
export function decideEblPreference(signal: PreferenceSignal, target: {
  subjectId?: string; relevant: boolean; attributed: boolean
}) {
  const eligible = !!target.subjectId && target.relevant && target.attributed
  const persistent = eligible && signal.horizon === 'persistent'
  return { subjectId: eligible ? target.subjectId : undefined, longTerm: persistent,
    maskConflictingInference: !eligible ? 'none' : persistent ? 'ongoing' : 'current_turn',
    write: !eligible ? 'none' : persistent ? signal.explicit ? 'reported_preference' : 'inferred_candidate' : 'turn_audit',
    preservePast: signal.change === 'time_change' } as const
}

export interface AcceptanceOpportunity {
  rootId: string; claimId: string; subjectId: string; scope: string
  kind: 'acceptance' | 'explicit_support' | 'explicit_opposition'
  /** Requires witnessed delivery/exposure + a closed natural interaction, never a timer alone. */
  eligible: boolean
}
/** H6: weak support is disposable on revision; repeated majority acceptance remains below statements.
 * Provisional meaning of "large proportion": >1/2 and >=3 independent accepted opportunities.
 * This summary does not validate an inferred rule or authorize a tool action.
 */
export function summarizeEblAcceptance(opportunities: readonly AcceptanceOpportunity[], context: {
  claimId: string; subjectId: string; scope: string; revising: boolean; explicitContradiction: boolean
}) {
  const roots = new Map<string, AcceptanceOpportunity>()
  for (const item of opportunities) {
    if (!item.eligible || item.claimId !== context.claimId || item.subjectId !== context.subjectId || item.scope !== context.scope) continue
    // Conflicting classifications for one root are not independent; explicit feedback wins.
    const rank = { acceptance: 0, explicit_support: 1, explicit_opposition: 2 }
    if (!roots.has(item.rootId) || rank[item.kind] > rank[roots.get(item.rootId)!.kind]) roots.set(item.rootId, item)
  }
  const accepted = [...roots.values()].filter(item => item.kind === 'acceptance').length
  const repeated = accepted >= 3 && accepted * 2 > roots.size
  const contradicted = context.explicitContradiction || [...roots.values()].some(item => item.kind === 'explicit_opposition')
  return { accepted, opportunities: roots.size, tier: repeated ? 'repeated_acceptance' : 'weak_acceptance',
    supporting: contradicted || (context.revising && !repeated) ? 0 : accepted,
    canBlockRevision: false, countsAsAgreement: false, grantsPermission: false } as const
}

/** H7/H8: consult actual authorization; the current prohibition restricts this task immediately. */
export function decideEblTaskClarification(input: { hasRelatedInference: boolean; contradictsInference: boolean }) {
  return { scope: 'current_task', mustRecheckAuthorization: true, prohibitExecution: true,
    reviseExistingInference: input.hasRelatedInference && input.contradictsInference,
    createNewInference: false } as const
}
