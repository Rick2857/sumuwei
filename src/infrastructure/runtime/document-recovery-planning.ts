import { DOCUMENT_EXTRACT, PDF_READERS, simulateDocumentRoutes, type PdfReader } from '../../kernel/contracts/document-reading.ts'
import { selectUsableRules, type PlanRuleDependency } from '../../kernel/contracts/cognitive-collaboration.ts'
import { parameterBindingDigestOf } from '../../kernel/action/action-forecast.ts'
import type { TaskPlannerPort } from '../../kernel/action/task-plan.ts'
import type { ActionTurnPortOptions } from '../../kernel/action/action-turn.ts'
import type { ActionResult } from '../../kernel/action/action-result.ts'
import type { WorldModelForecastOptions } from './world-model-forecast.ts'
import { createEblRuleSnapshotPort } from './ebl-rule-snapshot.ts'
import { createDocumentBeliefObserver } from './document-belief.ts'
import type { DocumentCoverageReferencePort } from './document-coverage-reference.ts'
import { DOCUMENT_PROFILE, PDF_PROFILE_READING_VERSION } from '../../kernel/contracts/document-profile.ts'
import { createDocumentPagePlanning } from './document-page-planning.ts'

/** Explicit single local PDF only. Quoted paths may contain spaces; no inferred filenames. */
export function documentReadingGoal(text: string): { path: string } | undefined {
  const match = /^(?:请|帮我|麻烦)?(?:读取|读一下|阅读)\s*(?:「([^」]+\.pdf)」|"([^"\n]+\.pdf)"|([^\s「」"]+\.pdf))\s*(?:的正文|并提取正文|提取正文)[。！!]?$/iu.exec(text.trim())
  const path = match?.[1] ?? match?.[2] ?? match?.[3]
  return path && /^(?:\/|[A-Za-z]:[\\/])/.test(path) && !/[\x00-\x1f]/.test(path) ? { path } : undefined
}
type Configure = NonNullable<NonNullable<ActionTurnPortOptions['task']>['configurePlanning']>
export function createDocumentRecoveryPlanning(options: WorldModelForecastOptions & {
  fallback?: Configure
  /** Evaluation arms use the same runtime; production default is model-qualified ordering. */
  strategy?: 'current' | 'static' | 'model'
  /** Formal bounded profile flow. Legacy evaluation arms remain unchanged unless explicitly enabled. */
  profile?: boolean
  /** Coverage references (only human-approved ones are returned); absent ⇒ coverage stays unknown. */
  coverage?: DocumentCoverageReferencePort
}): Configure {
  return async text => {
    if (options.profile) {
      const pages = await createDocumentPagePlanning(options)(text)
      if (pages) return pages
    }
    const goal = documentReadingGoal(text)
    if (!goal) return await options.fallback?.(text)
    const ruleSnapshot = createEblRuleSnapshotPort(options.db, options.characterId, options.activeUserId)
    const tried = new Set<PdfReader>()
    let last: ActionResult | undefined, dependency: PlanRuleDependency | undefined
    let profileTried = false
    const native = createDocumentBeliefObserver(options.db, options.activeUserId, () => dependency, options.coverage)
    const strategy = options.strategy ?? 'model'
    const planner: TaskPlannerPort = { id: `document-recovery:${strategy}@${options.profile ? 2 : 1}`, endpointHost: 'local', async plan(input) {
      dependency = undefined
      const nonempty = last?.status === 'success' && last.executed && last.turnContent?.some(c => c.capability === DOCUMENT_EXTRACT && c.text.trim().length > 0)
      if (nonempty) return { ok: true, requestCount: 0, plan: { goal: '已取得实际正文；覆盖范围以真实结果为准', steps: [], done: true } }
      if (options.profile && !profileTried) {
        if (!input.allowedCapabilities.includes(DOCUMENT_PROFILE) || input.remainingActions < 2) return { ok: false, failure: 'call_failed', requestCount: 0 }
        profileTried = true
        return { ok: true, requestCount: 0, plan: { goal: '有界检查 PDF 结构；并非正文读取', done: false,
          steps: [{ capability: DOCUMENT_PROFILE, operation: 'inspect', args: { path: goal.path } }] } }
      }
      const observed = native.profileFor(goal.path)
      if (options.profile && (!observed || !input.content?.some(line => line.includes(JSON.stringify(observed.profile)))))
        return { ok: false, failure: 'call_failed', requestCount: 0 }
      const bound = options.profile && observed?.profile.outcome === 'complete' ? observed.profile : undefined
      const textLayer = bound?.textLayer === 'present' || bound?.textLayer === 'absent' ? bound.textLayer : undefined
      if (!input.allowedCapabilities.includes(DOCUMENT_EXTRACT) || input.remainingActions < 1 || tried.size >= (strategy === 'current' ? 1 : 2)
        || last?.status === 'cancelled' || last?.status === 'rejected'
        || (last?.status === 'not_found' && !last.error?.details?.documentReading)) return { ok: false, failure: 'call_failed', requestCount: 0 }
      let reader = PDF_READERS.find(r => !tried.has(r))!
      if (strategy === 'model') {
        const all = await ruleSnapshot.list()
        const qualified = PDF_READERS.flatMap(r => selectUsableRules({ snapshots: all, visible: {
          subjectId: options.activeUserId, scope: 'pdf_text', environment: textLayer ? PDF_PROFILE_READING_VERSION : 'pdf-text@1',
          conditions: { format: 'pdf', reader: r, ...(textLayer ? { text_layer: textLayer } : {}) },
        } }).selected)
        const route = simulateDocumentRoutes(qualified, textLayer).find(r => !tried.has(r.reader) && r.expectation === 'nonempty')
        if (route) { reader = route.reader; dependency = route.dependency }
      }
      const binding = dependency
      return { ok: true, requestCount: 0, plan: { goal: '读取用户明确指定的 PDF 正文', done: false,
        steps: [{ capability: DOCUMENT_EXTRACT, operation: 'read', args: { path: goal.path, reader,
          ...(bound ? { expectedInputFingerprint: bound.inputFingerprint } : {}) } }] },
        ...(binding ? { simulation: { dependency: binding, forecast: { producedAt: Date.now(), inputRevision: `pdf:${binding.evidenceFingerprint}`,
          modelVersion: options.profile ? 'document-route-profile@1' : 'document-route@1', budgetCost: 0, planStepIndices: [0], steps: [{ capability: DOCUMENT_EXTRACT, operation: 'read',
            expectedVisibleOutcome: '预期取得非空文本；须实际提取核对，不证明内容准确', uncertainty: 'unknown', dependsOn: [],
            check: { kind: 'status_is', status: 'success' }, ruleDependencies: [binding], ruleVersion: binding.ruleVersion,
            parameterBindingDigest: parameterBindingDigestOf(DOCUMENT_EXTRACT, 'read', `path=${goal.path}|reader=${reader}${bound ? `|expectedInputFingerprint=${bound.inputFingerprint}` : ''}`),
          }] } } } : {}),
      }
    } }
    return { planner, ruleSnapshot, epistemic: {
      before: native.before,
      async after(input) {
        if (input.request.capability === DOCUMENT_EXTRACT && input.request.arguments.path === goal.path) {
          tried.add((input.request.arguments.reader ?? 'markitdown') as PdfReader); last = input.result
        }
        await native.after(input)
      },
    } }
  }
}
