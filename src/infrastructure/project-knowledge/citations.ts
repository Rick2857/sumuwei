import type { TurnContentContextReality } from '../../kernel/contracts/turn-content.ts'

/** Only compiler-confirmed project/self results; no document body or model-invented references. */
export function projectKnowledgeCitations(reality: TurnContentContextReality | undefined): string {
  if (!reality?.reachedContext) return ''
  const refs = reality.refs.filter(ref => ref.capability === 'project.search' || ref.capability === 'self.capabilities')
  if (!refs.length) return ''
  return ['本轮查询出处：', ...refs.map(ref => `[${ref.label}] ${ref.resourceRef}\n${ref.facts.slice(0, 2).join('\n')}`)].join('\n')
}
