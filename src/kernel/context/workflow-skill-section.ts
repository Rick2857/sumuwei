import type { ActionTurnResult } from '../action/action-turn.ts'
import { WORKFLOW_SKILL, type WorkflowSkillDefinition } from '../action/learning-capabilities.ts'
import type { ContextSectionProvider } from '../contracts/context.ts'

/** Only a successful load of a matching packaged skill can supply instructions. */
export function createWorkflowSkillProvider(
  skills: readonly WorkflowSkillDefinition[],
  outcomes: readonly ActionTurnResult[] = []
): ContextSectionProvider {
  return {
    name: 'workflow-skills',
    async provide() {
      const selected = skills.filter((skill) => outcomes.some(({ request, result }) =>
        request?.capability === WORKFLOW_SKILL && request.operation === 'load' &&
        request.arguments.skill === skill.id && result?.accepted === true && result.executed &&
        result.status === 'success' && result.effect?.fingerprint === skill.fingerprint
      ))
      return selected.map((skill) => ({
        id: `workflow-skill:${skill.id}`, kind: 'instruction' as const, priority: 56,
        content: `# 本轮流程：${skill.id}\n\n${skill.instructions}`,
        sourceRefs: [`workflow-skill:${skill.id}@1#${skill.fingerprint}`], droppable: true,
      }))
    },
  }
}
