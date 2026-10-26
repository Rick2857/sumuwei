/**
 * 受限转移模型 · **机器门**（2026-10-21 · 认知能力建设计划 P2 第 2 步）
 *
 * ============================================================================
 *  它验什么
 * ============================================================================
 *  计划 §3 P2 第 2 步：「先用闭集数据规则和受信解释器形成单步转移；
 *  绑定规则版本与来源指纹，回放保留观察。」
 *
 *  ⇒ 门在**真 Gateway + 真文件**的 UTF-8 sandbox write/read 链上：
 *    ① 造一条**当前合格**的 EBL 命题（真读回、真结算）；
 *    ② 由它**构造**一条受限规则（绑定命题 id / 规则版本 / 证据指纹）；
 *    ③ 用**受信解释器**求"这次读应当得到什么"（预期 / 未知 / 冲突）；
 *    ④ **回放**保留的观察，检验模型是否**忠实**；
 *    ⑤ 一组**负控**：同能力不同对象错绑 · 条件未知 · 条件不匹配 ·
 *       读回不符 · **超时误归因**（"没读成"≠"被反驳"）· 撤回后不能构造。
 *
 *  ⚠️ **可见状态来自账本**（`listRecords`）：路径来自目标的 `canonicalId`，
 *    内容指纹来自效果的 `fingerprint` ⇒ 断言的是**真发生过的事**，
 *    不是"我们记得我们做过什么"。
 *  ⚠️ **负控与收益任务分开**：负控只证明"判据能失败"。
 *  ⚠️ 零模型调用、零出网、零生产访问；真实库**从不被打开**。
 * ============================================================================
 */

import 'dotenv/config'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ⚠️ 必须在任何会碰数据库的 import 之前（见 src/dev/sandbox.ts 的说明）
import { isolateDatabase, resetPluginSqlConnection } from '../../src/dev/sandbox.ts'

import { createM4Harness } from '../m4-harness.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader, eblReadbackRef, EBL_TOOL_ENVIRONMENT } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { createEblTaskObserver } from '../../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import { buildTransitionRule } from '../../src/infrastructure/runtime/world-model-transition.ts'
import { makeEblClaim } from '../../src/kernel/contracts/epistemic-belief.ts'
import {
  interpretTransition,
  replayTransition,
  type ObservedActionFact,
  type ObservedTransitionState,
  type RetainedObservation,
} from '../../src/kernel/contracts/world-model-transition.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import { createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS } from '../../src/kernel/action/capability-registry.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { runTask } from '../../src/kernel/action/task-loop.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'

const checks: string[] = []
function check (name: string, pass: unknown, detail = ''): void {
  assert.ok(pass, name)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const sandbox = isolateDatabase('world-model-transition', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

const output = resolve('artifacts/local/world-model-transition', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'RUNNING', backend: 'postgres' }))
const fsRoot = mkdtempSync(resolve(output, 'files-'))
const h = await createM4Harness({ label: 'world-model-transition', userId: 'Alex' })

try {
  const characterId = h.kernel.characterId
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const fsOptions = { root: fsRoot, staging }
  const ledger = createActionLedgerStore(h.db)
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fsOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger,
    adapters: [createSandboxReadAdapter(fsOptions), createSandboxWriteAdapter(fsOptions)],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'wmt-test', executorAdapterId: 'sandbox-filesystem' } })
  const observer = createEblTaskObserver(h.db, h.userId)
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
  const authorizations = createTaskAuthorizationRegistry()
  let claimId = ''

  /** 从**账本**读回"真发生过的事"（路径 + 内容指纹） */
  async function readFacts (): Promise<{ actions: ObservedActionFact[]; retained: RetainedObservation[] }> {
    const records = await ledger.listRecords({ characterId, limit: 200 })
    const actions: ObservedActionFact[] = []
    const retained: RetainedObservation[] = []
    // 账本按时间**倒序**返回 ⇒ 倒过来用（"上一次写入"要取最近的那次）
    for (const record of [...records].reverse()) {
      const path = record.target?.canonicalId
      const fingerprint = record.effect?.fingerprint
      actions.push({
        actionId: String(record.actionId),
        capability: record.capability,
        operation: record.operation,
        status: String(record.status),
        effects: {
          ...(path === undefined ? {} : { path }),
          ...(fingerprint === undefined ? {} : { contentFingerprint: fingerprint }),
        },
      })
      if (record.operation === 'read' && path !== undefined && fingerprint !== undefined) {
        retained.push({ path, contentFingerprint: fingerprint })
      }
    }
    return { actions, retained }
  }

  /** 一次**真**的"写进去 → 读回来"（生产形状：真 Gateway · 真文件 · 离线规划器） */
  async function task (index: number): Promise<void> {
    const evidence = await h.recordUserEvidence(`受限于模型 ${index}：写文件后读回。`)
    const traceId = asTraceId(`wmt-task-${index}`)
    const path = `sample-${index}.txt`
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId), originalText: `task ${index}`,
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1' })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({ adapterId: 'wmt-test',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'wmt-test', triggeringEvent: triggeringConversationEventOf(evidence.event) }) })
    const result = await runTask({ gateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      epistemic: { before: input => observer.before(input), after: input => observer.after(input) },
      planner: { id: 'wmt-fixed-offline', endpointHost: 'offline', async plan() {
        return { ok: true, requestCount: 1, plan: { goal: 'roundtrip', done: true, steps: [
          /*
           * ⚠️ 每次写**不同**的内容（否则三条路径的内容指纹相同，
           *    "预期绑在对象上"就**测不出来** —— 三个对象的预期会一模一样）。
           */
          { capability: 'sandbox.file.write', operation: 'write', args: { path, content: `UTF-8 验证 ${index}\n` } },
          { capability: 'sandbox.file.read', operation: 'read', args: { path } },
        ] } }
      } } }, { characterId, traceId, authorization, text: `task ${index}` })
    check(`task ${index}: 真 Gateway 的写 + 读都成功`,
      result.steps.length === 2 && result.steps.every(step => step.status === 'success'))
    const ref = eblReadbackRef(result.steps[0]!.actionId!, result.steps[1]!.actionId!, String(evidence.event.id))
    claimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool', predicate: 'readback_matches',
      expected: true, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' }, formation: ref }).id
  }

  // 三次真链 ⇒ 命题**当前合格**（EBL 政策：两条独立支持）
  await task(1)
  await task(2)
  await task(3)
  check('EBL 命题在真读回上**当前合格**', (await store.get(claimId))?.status === 'validated',
    String((await store.get(claimId))?.status))

  const { actions, retained } = await readFacts()
  check('可见状态来自**账本**（真发生过的事）', actions.length >= 6 && retained.length >= 3,
    `${String(actions.length)} 条动作 · ${String(retained.length)} 条保留观察`)

  // -------------------------------------------------------------------------
  // ① 构造：EBL 命题 → 受限规则（绑定版本与指纹）
  // -------------------------------------------------------------------------
  const snapshotPort = createEblRuleSnapshotPort(h.db, characterId, h.userId)
  const snapshot = await snapshotPort.current(claimId)
  check('① 构造：合格命题有当前快照', snapshot !== undefined && snapshot.usable,
    `status=${String(snapshot?.status)} usable=${String(snapshot?.usable)}`)
  const translation = snapshot === undefined ? { reason: '没有快照' } : buildTransitionRule(snapshot)
  if (!('rule' in translation)) {
    check('① 构造：合格命题能构造出受限规则', false, translation.reason)
    throw new Error(`构造失败：${translation.reason}`)
  }
  const rule = translation.rule
  assert.ok(snapshot)
  check('命题预期为 false 时不能被翻译成字节相等规则',
    !('rule' in buildTransitionRule({ ...snapshot, expected: false })))
  check('范围相同但谓词不同，不能借用相等规则解释器',
    !('rule' in buildTransitionRule({ ...snapshot, predicate: 'other_predicate' })))
  const conditional = buildTransitionRule({ ...snapshot, conditions: { ...snapshot.conditions, freshness: 'current' } })
  check('翻译保留全部条件，不能只保留编码条件', 'rule' in conditional && conditional.rule.conditions.freshness === 'current')
  check('附加条件未知时不能沿用原规则预期', 'rule' in conditional && interpretTransition({
    rule: conditional.rule, observed: { actions, facts: { encoding: 'utf8' } },
    action: { capability: 'sandbox.file.read', operation: 'read', arguments: { path: 'sample-1.txt' }, subjectId: h.userId },
  }).kind === 'unknown')
  check('① 构造：合格命题能构造出受限规则', true, rule.id)
  check('① 构造：规则**绑定**了命题 id / 规则版本 / 证据指纹',
    rule.binding.claimId === claimId && rule.binding.ruleVersion === snapshot!.ruleVersion &&
    rule.binding.evidenceFingerprint === snapshot!.evidenceFingerprint,
    `${rule.binding.claimId} / ${rule.binding.ruleVersion.slice(0, 20)}…`)

  // -------------------------------------------------------------------------
  // ② 解释：受信解释器给出"这次读应当得到什么"
  // -------------------------------------------------------------------------
  const facts = { encoding: 'utf8' }
  const observed: ObservedTransitionState = { actions, facts }
  const readPath = 'sample-3.txt'
  const expectedOutcome = interpretTransition({
    rule,
    observed,
    action: { capability: 'sandbox.file.read', operation: 'read', arguments: { path: readPath }, subjectId: h.userId },
    result: { status: 'success', effects: { contentFingerprint: retained.at(-1)!.contentFingerprint } },
  })
  check('② 解释：给出**可检查的预期**（闭集谓词）',
    expectedOutcome.kind === 'expected' && expectedOutcome.expectation?.predicate === 'same_content_fingerprint',
    JSON.stringify(expectedOutcome.expectation ?? expectedOutcome.reason))
  check('② 解释：预期绑在**具体路径**上（不是"某个文件"）',
    expectedOutcome.expectation?.path === readPath, String(expectedOutcome.expectation?.path))

  // -------------------------------------------------------------------------
  // ③ 回放：模型是否**忠实**（保留的观察）
  // -------------------------------------------------------------------------
  const replay = replayTransition({ rule, observed, retained })
  check('③ 回放：保留的观察全部复现（pass）',
    replay.outcome === 'pass' && replay.mismatchedCount === 0 && replay.reproducedCount === replay.coveredCount,
    `复现 ${String(replay.reproducedCount)}/${String(replay.coveredCount)} · 不符 ${String(replay.mismatchedCount)} · 不可判 ${String(replay.unknownCount)}`)
  check('③ 回放：覆盖数在报告里（"回放不全"看得见）', replay.coveredCount === retained.length,
    `${String(replay.coveredCount)} 条`)

  // -------------------------------------------------------------------------
  // ④ 负控
  // -------------------------------------------------------------------------
  // (a) 同能力不同对象：**从没写过**的那个对象 ⇒ 没有预期可比 ⇒ unknown（**不是**"一样"）
  const wrongObject = interpretTransition({
    rule,
    observed,
    action: { capability: 'sandbox.file.read', operation: 'read', arguments: { path: 'never-written.txt' }, subjectId: h.userId },
    result: { status: 'success', effects: { contentFingerprint: retained[0]!.contentFingerprint } },
  })
  check('④ 负控 (a)：同能力**不同对象**（从没写过）⇒ 找不到预期 ⇒ unknown（不是"一样"）',
    wrongObject.kind === 'unknown' && wrongObject.reason === 'prior_effect_unknown', String(wrongObject.reason))
  // (a2) 对照：读过**自己写过**的那个对象 ⇒ 预期是**它自己**的指纹（不是别人的）
  const otherPath = interpretTransition({
    rule,
    observed,
    action: { capability: 'sandbox.file.read', operation: 'read', arguments: { path: 'sample-1.txt' }, subjectId: h.userId },
    result: { status: 'success', effects: { contentFingerprint: retained[0]!.contentFingerprint } },
  })
  check('④ 负控 (a2)：预期**绑在对象上**（换一个对象就是另一个预期，不是通用结论）',
    otherPath.kind === 'expected' && otherPath.expectation?.path === 'sample-1.txt' &&
    otherPath.expectation?.expectedFingerprint !== expectedOutcome.expectation?.expectedFingerprint,
    `${String(otherPath.expectation?.path)} ≠ ${String(expectedOutcome.expectation?.path)}`)

  const unknownCondition = interpretTransition({
    rule,
    observed: { actions, facts: {} },
    action: { capability: 'sandbox.file.read', operation: 'read', arguments: { path: readPath }, subjectId: h.userId },
  })
  check('④ 负控 (b)：条件**未知** ⇒ unknown（不是"不适用"）',
    unknownCondition.kind === 'unknown' && unknownCondition.reason === 'condition_unknown', String(unknownCondition.reason))

  const mismatchCondition = interpretTransition({
    rule,
    observed: { actions, facts: { encoding: 'gbk' } },
    action: { capability: 'sandbox.file.read', operation: 'read', arguments: { path: readPath }, subjectId: h.userId },
  })
  check('④ 负控 (c)：条件已知但对不上 ⇒ unknown(condition_mismatch)',
    mismatchCondition.kind === 'unknown' && mismatchCondition.reason === 'condition_mismatch', String(mismatchCondition.reason))

  const mismatchReadback = interpretTransition({
    rule,
    observed,
    action: { capability: 'sandbox.file.read', operation: 'read', arguments: { path: readPath }, subjectId: h.userId },
    result: { status: 'success', effects: { contentFingerprint: 'not-the-same-fingerprint' } },
  })
  check('④ 负控 (d)：读回内容**不符** ⇒ conflict（这是反驳）',
    mismatchReadback.kind === 'conflict' && mismatchReadback.reason === 'readback_mismatch', String(mismatchReadback.reason))

  const timedOut = interpretTransition({
    rule,
    observed,
    action: { capability: 'sandbox.file.read', operation: 'read', arguments: { path: readPath }, subjectId: h.userId },
    result: { status: 'timeout', effects: {} },
  })
  check('④ 负控 (e)：**超时** ⇒ unknown（不是"被反驳"——没读成不等于读得不一样）',
    timedOut.kind === 'unknown' && timedOut.reason === 'readback_unknown', String(timedOut.reason))

  for (const fact of [
    { actionId: 'failed-write', capability: 'sandbox.file.write', operation: 'write', status: 'failed', effects: { path: 'unwritten.txt', contentFingerprint: 'not-committed' } },
    { actionId: 'foreign-write', capability: 'other.write', operation: 'write', status: 'success', effects: { path: 'unwritten.txt', contentFingerprint: 'unrelated' } },
  ]) {
    const unsupported = interpretTransition({ rule,
      observed: { actions: [fact], facts },
      action: { capability: 'sandbox.file.read', operation: 'read', arguments: { path: 'unwritten.txt' }, subjectId: h.userId },
    })
    check(`失败或异类写入不提供预期：${fact.actionId}`, unsupported.kind === 'unknown')
  }

  await store.commit(claimId, { kind: 'withdraw' })
  const withdrawnSnapshot = await snapshotPort.current(claimId)
  const withdrawnTranslation = withdrawnSnapshot === undefined
    ? { reason: '没有快照' }
    : buildTransitionRule(withdrawnSnapshot)
  check('④ 负控 (f)：来源撤回后**构造不出**规则（消费前就被拒）',
    !('rule' in withdrawnTranslation) && withdrawnSnapshot?.usable === false,
    withdrawnSnapshot?.invalidatedReason ?? '（无快照）')

  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', backend: 'postgres',
    evidenceKind: 'real_gateway_real_files_offline_planner', measured_count: checks.length, checks,
    productionOpened: false, modelCalls: 0, humanAcceptance: 'NOT RUN' }, null, 2))
  console.log(`受限转移模型：${checks.length}/${checks.length}; ${output}`)
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', backend: 'postgres', checks,
    error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally {
  await h.stop()
  await resetPluginSqlConnection()
}
