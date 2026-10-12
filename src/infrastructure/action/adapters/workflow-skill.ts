import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { WORKFLOW_SKILL, WORKFLOW_SKILL_IDS, type WorkflowSkillDefinition } from '../../../kernel/action/learning-capabilities.ts'
import type { CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'

const SKILL_ROOT = fileURLToPath(new URL('../../../../resources/workflow-skills/', import.meta.url))

export function loadWorkflowSkills(): readonly WorkflowSkillDefinition[] {
  const manifest = JSON.parse(readFileSync(resolve(SKILL_ROOT, 'manifest.json'), 'utf8')) as Record<string, string>
  return WORKFLOW_SKILL_IDS.map((id) => {
    const source = readFileSync(resolve(SKILL_ROOT, id, 'SKILL.md'), 'utf8')
    const fingerprint = createHash('sha256').update(source).digest('hex')
    if (manifest[id] !== fingerprint) throw new Error(`workflow_skill_assets_invalid:${id}`)
    const instructions = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
    if (instructions.length === 0 || instructions.length > 1800) throw new Error(`workflow_skill_size_invalid:${id}`)
    return { id, instructions, fingerprint }
  })
}

export function createWorkflowSkillAdapter(skills: readonly WorkflowSkillDefinition[]): CapabilityAdapter {
  return {
    capabilityId: WORKFLOW_SKILL,
    async execute(input) {
      const skill = skills.find((item) => item.id === input.args.skill)
      if (input.operation !== 'load' || Object.keys(input.args).some((key) => key !== 'skill') || skill === undefined) {
        throw new ActionFailureError(actionFailure('validation_failed', '只能加载已登记的两个流程技能'))
      }
      return {
        effect: { kind: 'content_read', detail: `已加载流程 ${skill.id}；尚不代表用户任务完成`, fingerprint: skill.fingerprint },
        evidence: [{ kind: 'adapter', detail: '固定流程包指纹核对通过', ref: `workflow-skill:${skill.id}@1` }],
      }
    },
  }
}
