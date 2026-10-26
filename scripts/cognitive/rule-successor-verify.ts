/** 真 Gateway/文件上的反例 → 后继重新验证 → 消费切换；外部漂移为受控负控。 */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isolateDatabase, resetPluginSqlConnection } from '../../src/dev/sandbox.ts'
import { createM4Harness } from '../m4-harness.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader, eblReadbackRef, EBL_TOOL_ENVIRONMENT } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { createEblTaskObserver } from '../../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import { createWorldModelForecastPort } from '../../src/infrastructure/runtime/world-model-forecast.ts'
import { parameterBindingDigestOf } from '../../src/kernel/action/action-forecast.ts'
import { buildTransitionRule, simulateCurrentTransition } from '../../src/infrastructure/runtime/world-model-transition.ts'
import { makeEblClaim, type EblClaim } from '../../src/kernel/contracts/epistemic-belief.ts'
import { verifyPlanRulesStillUsable } from '../../src/kernel/contracts/cognitive-collaboration.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import { createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS } from '../../src/kernel/action/capability-registry.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { runTask, type EblTaskObserver } from '../../src/kernel/action/task-loop.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'

const isolated = isolateDatabase('rule-successor', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(isolated.backend, 'postgres')
const output = resolve('artifacts/local/rule-successor', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
const files = mkdtempSync(resolve(output, 'files-'))
const checks: string[] = []
const check = (name: string, condition: unknown) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`) }
// 既有 M4 recorder 固定使用 Alex，保持与其受信来源身份一致。
const h = await createM4Harness({ label: 'rule-successor', userId: 'Alex' })
try {
  const characterId = h.kernel.characterId
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const fileOptions = { root: files, staging }
  const ledger = createActionLedgerStore(h.db)
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fileOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger,
    adapters: [createSandboxReadAdapter(fileOptions), createSandboxWriteAdapter(fileOptions)],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'successor-test', executorAdapterId: 'sandbox-filesystem' } })
  const observer = createEblTaskObserver(h.db, h.userId)
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
  const snapshots = createEblRuleSnapshotPort(h.db, characterId, h.userId)
  const authorizations = createTaskAuthorizationRegistry()
  const claimFor = (formation: EblClaim['formation'], predecessor?: string) => makeEblClaim({
    characterId: String(characterId), subjectId: h.userId, domain: 'tool', predicate: 'readback_matches', expected: true,
    scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' }, formation,
    ...(predecessor === undefined ? {} : { predecessor }),
  })
  async function roundtrip(index: number, options: { fault?: boolean; candidate?: EblClaim } = {}) {
    const path = `sample-${index}.txt`
    const evidence = await h.recordUserEvidence(`后继规则独立试验 ${index}：写文件再读回。`)
    const traceId = asTraceId(`successor-${index}`)
    const anchor = String(evidence.event.id)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `roundtrip ${index}`,
      triggeringEventId: anchor, allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'successor-test',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'successor-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    let writeId = ''
    const candidate = options.candidate
    const hooks: EblTaskObserver = {
      async before(input) {
        if (!candidate) return await observer.before(input)
        if (input.request.capability === 'sandbox.file.read') await store.commit(candidate.id, { kind: 'register', test: {
          id: String(input.request.actionId), episodeId: String(traceId), bindingKey: path,
          designId: writeId, targetId: writeId, source: eblReadbackRef(writeId, String(input.request.actionId), anchor),
          anchor: { kind: 'conversation', id: anchor },
        } })
      },
      async after(input) {
        if (input.request.capability === 'sandbox.file.write') {
          writeId = String(input.request.actionId)
          if (options.fault) writeFileSync(resolve(files, path), 'controlled external state drift')
        }
        if (!candidate) await observer.after(input)
        else if (input.request.capability === 'sandbox.file.read') await store.commit(candidate.id, { kind: 'settle',
          testId: String(input.request.actionId), source: eblReadbackRef(writeId, String(input.request.actionId), anchor) })
      },
    }
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }), epistemic: hooks,
      planner: { id: 'successor-offline', endpointHost: 'offline', async plan() {
        return { ok: true, requestCount: 1, plan: { goal: 'roundtrip', done: true, steps: [
          { capability: 'sandbox.file.write', operation: 'write', args: { path, content: `value-${index}` } },
          { capability: 'sandbox.file.read', operation: 'read', args: { path } },
        ] } }
      } } }, { characterId, traceId, authorization, text: `roundtrip ${index}` })
    check(`真实写读成功：${index}`, result.steps.length === 2 && result.steps.every(step => step.status === 'success'))
    check(`EBL 观察无异常：${index}`, (result.epistemicFailures ?? 0) === 0)
    return eblReadbackRef(result.steps[0]!.actionId!, result.steps[1]!.actionId!, anchor)
  }

  const rootClaim = claimFor(await roundtrip(1))
  await roundtrip(2)
  await roundtrip(3)
  const original = await snapshots.current(rootClaim.id)
  assert.ok(original)
  check('原规则已独立验证且可构造模型', original.usable && 'rule' in buildTransitionRule(original))
  await roundtrip(4, { fault: true })
  const suspended = await store.get(rootClaim.id)
  check('真实读回反例使原规则暂停', suspended?.status === 'suspended' && suspended.evidence.at(-1)?.verdict === 'counterexample')
  check('依赖原版本的计划失效', !(await verifyPlanRulesStillUsable({ snapshot: snapshots, dependencies: [{
    claimId: rootClaim.id, ruleVersion: original.ruleVersion, evidenceFingerprint: original.evidenceFingerprint,
  }] })).ok)
  const blockedSimulation = await simulateCurrentTransition({ snapshot: snapshots, claimId: rootClaim.id,
    visible: { subjectId: h.userId, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT },
    initialState: { actions: [], facts: { encoding: 'utf8' } }, candidates: [] })
  check('暂停后拒绝新的模型模拟', !blockedSimulation.ok)

  // 关闭负控漂移后，形成新候选；既有反例不能被删除或解释为“从未发生”。
  const successor = claimFor(await roundtrip(5), rootClaim.id)
  await store.commit(successor.id, { kind: 'propose', claim: successor })
  check('后继从 pending 开始，不继承验证资格', (await store.get(successor.id))?.status === 'pending')
  await assert.rejects(() => store.commit(successor.id, { kind: 'review' }), /validation_policy/)
  await assert.rejects(() => store.commit(rootClaim.id, { kind: 'supersede', successorId: successor.id }), /successor_not_usable/)
  check('未重新验证的后继不能替换旧规则', (await store.get(rootClaim.id))?.status === 'suspended')
  await roundtrip(6, { candidate: successor })
  await assert.rejects(() => store.commit(successor.id, { kind: 'review' }), /validation_policy/)
  await roundtrip(7, { candidate: successor })
  await store.commit(successor.id, { kind: 'review' })
  const successorSnapshot = await snapshots.current(successor.id)
  assert.ok(successorSnapshot)
  check('后继在新独立测试上重新验证', successorSnapshot.usable && successorSnapshot.ruleVersion !== original.ruleVersion)
  check('后继规则带新身份和来源，可重新构造', 'rule' in buildTransitionRule(successorSnapshot))
  const oldEvidence = JSON.stringify((await store.get(rootClaim.id))!.evidence)
  await store.commit(rootClaim.id, { kind: 'supersede', successorId: successor.id })
  check('原规则成为 superseded 并指向后继', (await store.get(rootClaim.id))?.successorId === successor.id)
  check('旧反例和证据逐字保留', JSON.stringify((await store.get(rootClaim.id))!.evidence) === oldEvidence)
  check('旧规则不会重新进入模型构造', (await snapshots.current(rootClaim.id))?.usable === false)
  const forecast = await createWorldModelForecastPort({ db: h.db, characterId, activeUserId: h.userId,
    modelVersion: 'world-model-transition@1', facts: { encoding: 'utf8' } }).forecast({
    goal: '后继规则预测', candidateSteps: [{ capability: 'sandbox.file.read', operation: 'read' }],
    targetBindings: [{ capability: 'sandbox.file.read', operation: 'read',
      bindingDigest: parameterBindingDigestOf('sandbox.file.read', 'read', 'path=sample-7.txt') }],
    state: [], remainingActions: 1, remainingModelCalls: 1, producedAt: Date.now(), inputRevision: 'successor-probe', deadlineMs: 5_000,
  })
  check('新的世界模型预测实际依赖后继规则', forecast.ok && forecast.forecast.steps[0]?.ruleDependencies?.[0]?.claimId === successor.id)
  const newEvidenceCount = (await store.get(successor.id))!.evidence.length
  await roundtrip(8)
  check('常规观察器在替换后继续核对后继规则', (await store.get(successor.id))!.evidence.length === newEvidenceCount + 1)
  check('常规观察器没有继续写入被替换的旧版本', JSON.stringify((await store.get(rootClaim.id))!.evidence) === oldEvidence)
  const replayed = await store.rebuild(rootClaim.id)
  check('回放保留原反例与后继链接', replayed?.status === 'superseded' && replayed.successorId === successor.id &&
    JSON.stringify(replayed.evidence) === oldEvidence)
  await store.commit(successor.id, { kind: 'withdraw' })
  await roundtrip(9)
  check('后继撤回后不复活原规则', (await store.get(rootClaim.id))?.status === 'superseded' &&
    (await snapshots.current(rootClaim.id))?.usable === false && (await snapshots.current(successor.id))?.usable === false)
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', checks, measured_count: checks.length,
    backend: 'postgres', modelCalls: 0, faultInjection: 'owned_file_external_drift', productionOpened: false }, null, 2))
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', checks,
    error: error instanceof Error ? error.message : String(error) }, null, 2))
  throw error
} finally {
  await h.stop()
  await resetPluginSqlConnection()
}
