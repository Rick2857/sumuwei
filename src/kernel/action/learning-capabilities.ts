import type { CapabilityDefinition } from './capability-registry.ts'
import { createProjectKnowledgeDefinitions } from './project-knowledge-capabilities.ts'

export const WORKFLOW_SKILL = 'workflow.skill'
export const WORKFLOW_SKILL_PERMISSION = 'workflow:skill'
export const PERSONAL_LIBRARY_SEARCH = 'library.search'
export const PERSONAL_LIBRARY_PERMISSION = 'library:read'
export const ARXIV_RESEARCH = 'research.arxiv'
export const ARXIV_PERMISSION = 'arxiv:research'

export const WORKFLOW_SKILL_IDS = ['personal-library', 'writing-collaboration'] as const
export type WorkflowSkillId = (typeof WORKFLOW_SKILL_IDS)[number]

export interface WorkflowSkillDefinition {
  id: WorkflowSkillId
  instructions: string
  fingerprint: string
}

export function createLearningCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    ...createProjectKnowledgeDefinitions(),
    {
      id: PERSONAL_LIBRARY_SEARCH,
      version: 'library.search@1',
      description: '只读检索专用个人资料夹。query 用少量关键词（空串列目录），返回真实文件路径与有界文本摘录；PDF/Office 命中后用 document.read 深读。不扫描其它目录。',
      operations: [{ name: 'search', description: '按 query 检索专用资料夹', sideEffect: 'read', riskLevel: 'R0' }],
      sideEffectLevel: 'read', riskLevel: 'R0', permissions: [PERSONAL_LIBRARY_PERMISSION],
      supportsDryRun: true, idempotency: 'none',
    },
    {
      id: WORKFLOW_SKILL,
      version: 'workflow.skill@1',
      description: '按需加载受信流程。skill=personal-library：整理指定资料；skill=writing-collaboration：协作写作、改稿与报告。加载只提供流程，不代表已经读过资料或生成文件。闲聊无需加载。',
      operations: [{ name: 'load', description: '加载 skill 指定的流程（仅 personal-library / writing-collaboration）', sideEffect: 'read', riskLevel: 'R0' }],
      sideEffectLevel: 'read', riskLevel: 'R0', permissions: [WORKFLOW_SKILL_PERMISSION],
      supportsDryRun: true, idempotency: 'none',
    },
    {
      id: ARXIV_RESEARCH,
      version: 'research.arxiv@1',
      description: '通过固定 arXiv MCP 查论文。search(query,limit≤5) 查标题摘要；精准标题 query 必须用 ti:"论文标题"，主题可用 all:"关键词"（裸多词查询会很宽泛）。abstract(paperId) 取摘要；read(paperId,section可选) 缓存正文/指定章节；cite(paperId) 取 BibTeX。只接受 arXiv ID，不接受 URL、工具名或存储路径。',
      operations: [
        { name: 'search', description: '搜索 arXiv 论文元数据', sideEffect: 'read', riskLevel: 'R1' },
        { name: 'abstract', description: '按 paperId 获取摘要', sideEffect: 'read', riskLevel: 'R1' },
        { name: 'read', description: '缓存论文并读取有界正文（section 可选）', sideEffect: 'write', riskLevel: 'R1' },
        { name: 'cite', description: '按 paperId 获取 BibTeX', sideEffect: 'read', riskLevel: 'R1' },
      ],
      sideEffectLevel: 'write', riskLevel: 'R1', permissions: [ARXIV_PERMISSION],
      supportsDryRun: true, idempotency: 'none',
    },
  ]
}
