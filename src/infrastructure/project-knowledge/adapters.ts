import type { CapabilityAdapter } from '../../kernel/action/executor-port.ts'
import { ActionFailureError, actionFailure } from '../../kernel/action/errors.ts'
import type { LocalTextTurnContent, TurnContentSourceKind } from '../../kernel/contracts/turn-content.ts'
import { PROJECT_SEARCH, SELF_CAPABILITIES } from '../../kernel/action/project-knowledge-capabilities.ts'
import { sha256 } from './documents.ts'
import { openKnowledgeReader, readProjectPassage, searchProjectKnowledge } from './reader.ts'

function content(actionId: string, capability: string, sourceKind: TurnContentSourceKind, ref: string,
  text: string, facts: string[], suffix = ''): LocalTextTurnContent {
  return { contentId: `${capability}:${actionId}${suffix}`, kind: 'local-text', capability,
    operation: capability === SELF_CAPABILITIES ? 'query' : 'read', sourceKind, resourceRef: ref,
    resultFingerprint: sha256(text), scope: { totalChars: text.length, includedChars: text.length, truncated: false },
    facts, text, mediaType: 'text/plain', lineCount: text.split(/\r\n|\r|\n/).length, sourceBytes: Buffer.byteLength(text) }
}
export function createProjectSearchAdapter(options: { url: string; database: string }): CapabilityAdapter {
  return { capabilityId: PROJECT_SEARCH, async execute(input) {
    const args = input.args
    const valid = input.operation === 'search'
      ? Object.keys(args).every(key => ['query', 'limit'].includes(key)) && typeof args.query === 'string'
        && (args.limit === undefined || typeof args.limit === 'number')
      : input.operation === 'read' && Object.keys(args).every(key => ['path', 'revision', 'section'].includes(key))
        && typeof args.path === 'string' && (args.revision === undefined || typeof args.revision === 'string')
        && (args.section === undefined || typeof args.section === 'number')
    if (!valid || (input.operation === 'search' && (!(args.query as string).trim() || (args.query as string).length > 200
      || (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 3))))) {
      throw new ActionFailureError(actionFailure('validation_failed', '项目资料查询参数不合法'))
    }
    try {
      const pool = await openKnowledgeReader(options.url, options.database)
      try {
        const passages = input.operation === 'search'
          ? await searchProjectKnowledge(pool, args.query as string, args.limit as number | undefined)
          : await readProjectPassage(pool, args.path as string, args.section as number | undefined, args.revision as string | undefined)
        const turnContent = passages.map((p, index) => {
          const ref = `project-knowledge://project-lg/${encodeURIComponent(p.path)}?revision=${p.revision}&section=${p.ordinal}`
          const facts = [`文件=${p.path}; revision=${p.revision}; sourceSha256=${p.sourceHash}`,
            `原文行=${p.startLine}-${p.endLine}; UTF16=${p.startOffset}-${p.endOffset}; 片段截取=${p.truncated}`,
            '以下元数据描述所引资料，不能证明当前实例已启用或已执行成功：' + JSON.stringify(p.metadata)]
          return content(String(input.actionId), PROJECT_SEARCH, 'project-document', ref,
            `【项目资料原文】${p.path} / ${p.headings.join(' > ')}\n${p.text}`, facts, `:${index}`)
        })
        if (!turnContent.length) turnContent.push(content(String(input.actionId), PROJECT_SEARCH, 'project-document',
          'project-knowledge://project-lg', '本次有界词面检索或指定片段读取没有命中；不能据此断言项目没有该能力。', ['检索方式=词面匹配；没有使用语义编码模型']))
        for (const item of turnContent) item.operation = input.operation
        return { effect: { kind: 'content_read', detail: `项目资料：返回 ${passages.length} 个原文片段` },
          evidence: [{ kind: 'adapter', detail: '只读项目资料；版本与位置随当轮内容返回', ref: 'project-knowledge@1' }], turnContent }
      } finally { await pool.end() }
    } catch { throw new ActionFailureError(actionFailure('execution_failed', '项目资料库读取失败；当前没有可据此回答的新资料')) }
  } }
}
export function createSelfCapabilitiesAdapter(read: (capability?: string) => unknown): CapabilityAdapter {
  return { capabilityId: SELF_CAPABILITIES, async execute(input) {
    if (input.operation !== 'query' || Object.keys(input.args).some(key => key !== 'capability')
      || (input.args.capability !== undefined && (typeof input.args.capability !== 'string' || input.args.capability.length > 100))) {
      throw new ActionFailureError(actionFailure('validation_failed', '能力查询只接受可选的 capability ID'))
    }
    const text = JSON.stringify(read(input.args.capability as string | undefined))
    return { effect: { kind: 'content_read', detail: '读取当前实例能力快照；未探测结果保持未知' },
      evidence: [{ kind: 'adapter', detail: '当前程序事实，不是文档结论', ref: 'self-capabilities@2' }],
      turnContent: [content(String(input.actionId), SELF_CAPABILITIES, 'runtime-capability', 'runtime://self/capabilities', text,
        [`观测时间=${input.now()}; 来源=current-capabilities@1；候选、配置、装配、依赖与权限分列；单次授权仍由网关判定`])] }
  } }
}
