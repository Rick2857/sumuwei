/** Default-off task observer + interpersonal shadow. No new tools or model calls. */
import { EBL_LIMIT, makeEblClaim, type EblClaim, type EblValue } from '../../kernel/contracts/epistemic-belief.ts'
import type { EblTaskObserver } from '../../kernel/action/task-loop.ts'
import { decideEblPreference, readEblPreference } from '../../kernel/app/epistemic-belief-lifecycle/human-policy.ts'
import type { CharacterId } from '../../kernel/contracts/ids.ts'
import { createEblStore } from '../persistence/epistemic-belief-store.ts'
import {
  createEblSourceReader, EBL_HUMAN_ENVIRONMENT, EBL_TOOL_ENVIRONMENT, eblReadbackRef, eblWritePreconditionRef,
} from '../persistence/epistemic-belief-source.ts'
import { getConversationEvent } from '../persistence/conversation-store.ts'
import type { RawDb } from '../persistence/db.ts'
import { familyOfWriteTarget, sandboxWriteFamilyScope } from '../../kernel/contracts/write-family.ts'
import {
  WRITE_PRECONDITION_EVIDENCE_FAILURE_CODE, validateWritePreconditionDeclaration,
  writePreconditionConditions, type WritePreconditionDeclaration,
} from '../../kernel/contracts/write-precondition.ts'
import { attributeWriteSource } from '../../kernel/contracts/write-source-attribution.ts'
import type { WriteSourceScope } from '../../kernel/contracts/world-model-transition.ts'
import { readWriteSourceReceipts, type WriteSourcesForTarget } from '../persistence/write-source-read.ts'

/**
 * **受信输入**（ADR-151 步骤 C）。
 *
 * ⚠️ 两样都**只能**来自受信侧：已知目录事实（族）与族前置条件声明（条件形状）。
 * ⚠️ **不**来自模型输出、任务文本、文件名启发式。
 * ⚠️ 缺省（`undefined` / 空表）⇒ **没有族前置条件** ⇒ 形成链**不触发**
 *    （既有行为逐字不变）。
 */
export interface EblTaskObserverOptions {
  /** 已知目录事实（程序给出的族来源）。 */
  knownDirectories?: () => readonly string[]
  /** 受信的"族 → 前置条件"声明。 */
  preconditions?: readonly WritePreconditionDeclaration[]
  /** Trusted source roles only; which role fails is learned from real actions. */
  writeSources?: WriteSourcesForTarget
}

export function createEblTaskObserver(db: RawDb, activeUserId: string, options: EblTaskObserverOptions = {}): EblTaskObserver {
  const tasks = new Map<string, {
    writes: Map<string, string>
    tests: Map<string, string>
    conditionReads: Map<string, string>
    preconditionReads: Map<string, string>
    preconditionRegistered: Set<string>
    preconditionObserved: boolean
    preconditionScopes: Map<string, WriteSourceScope>
  }>()
  const readSource = createEblSourceReader(activeUserId, { knownDirectories: options.knownDirectories, writeSources: options.writeSources })
  const declarations = new Map<string, WritePreconditionDeclaration>()
  for (const raw of options.preconditions ?? []) {
    let declaration: WritePreconditionDeclaration
    try { declaration = validateWritePreconditionDeclaration(raw) }
    catch { continue } // 非法声明**失败关闭**：跳过它，不猜。
    declarations.set(declaration.familyId, declaration)
  }
  const conditionPaths = new Set([...declarations.values()].map(item => item.conditionPath))
  const knownDirectories = (): readonly string[] => {
    try { return options.knownDirectories?.() ?? [] } catch { return [] }
  }
  function task(id: string) {
    let value = tasks.get(id)
    if (!value) {
      if (tasks.size >= 128) tasks.delete(tasks.keys().next().value!)
      value = { writes: new Map(), tests: new Map(), conditionReads: new Map(), preconditionReads: new Map(),
        preconditionRegistered: new Set(), preconditionObserved: false, preconditionScopes: new Map() }
      tasks.set(id, value)
    }
    return value
  }
  function candidate(characterId: string, ref: EblClaim['formation']) {
    return makeEblClaim({ characterId, subjectId: activeUserId, domain: 'tool', predicate: 'readback_matches', expected: true,
      scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' }, formation: ref })
  }
  /** 族作用域的**写前置条件**命题（族是身份的一部分）。 */
  function preconditionCandidate(characterId: string, declaration: WritePreconditionDeclaration, ref: EblClaim['formation'], sourceScope?: WriteSourceScope) {
    return makeEblClaim({ characterId, subjectId: activeUserId, domain: 'tool', predicate: 'write_precondition_holds', expected: true,
      scope: sandboxWriteFamilyScope(declaration.familyId), environment: EBL_TOOL_ENVIRONMENT,
      conditions: writePreconditionConditions(declaration, sourceScope), formation: ref })
  }
  /** 这次写的**族**与**受信声明**（族只来自已知目录事实）。 */
  function declarationOf(path: string): WritePreconditionDeclaration | undefined {
    const familyId = familyOfWriteTarget({ path, knownDirectories: knownDirectories() })
    if (familyId === undefined) return undefined
    return declarations.get(familyId)
  }
  // 只为新观察追随已提交的后继链接；旧计划的版本依赖仍按原身份拒用。
  async function claimForNewObservation(store: ReturnType<typeof createEblStore>, base: EblClaim): Promise<EblClaim | undefined> {
    let claim = base
    for (let depth = 0; depth < EBL_LIMIT; depth++) {
      const state = await store.get(claim.id)
      if (!state) return depth === 0 ? claim : undefined
      if (state.status === 'superseded') {
        if (!state.successorId) return undefined
        const successor = await store.get(state.successorId)
        if (!successor || successor.claim.predecessor !== claim.id) return undefined
        claim = successor.claim
        continue
      }
      if (['retired', 'withdrawn'].includes(state.status)) return undefined
      // 新规则种类、环境或条件需要自己的观察协议，不能借用当前 UTF-8 读回协议。
      if (claim.predicate !== base.predicate || claim.expected !== base.expected || claim.scope !== base.scope ||
        claim.environment !== base.environment || JSON.stringify(claim.conditions) !== JSON.stringify(base.conditions)) return undefined
      return state.claim
    }
    return undefined
  }
  return {
    async before({ request, authorization, characterId }) {
      if (request.capability === 'sandbox.file.write') {
        /*
         * ⚠️ **前置登记**（ADR-151 步骤 C）：写**执行之前**就把这次写登记成测试。
         *    结算纪律要求"观察**晚于**登记" ⇒ 不预登记 ⇒ 永远不能结算。
         */
        const path = request.arguments.path
        if (typeof path !== 'string') return
        const declaration = declarationOf(path)
        if (!declaration) return
        const current = task(authorization.taskId)
        let sourceScope: WriteSourceScope | undefined
        if (options.writeSources !== undefined) {
          const declarations = options.writeSources(path)
          const fingerprint = request.arguments.payloadFingerprint
          if (typeof fingerprint !== 'string') return
          const receipts = await readWriteSourceReceipts(db, { characterId: String(characterId), activeUserId,
            traceId: String(request.traceId), declarations })
          const attribution = attributeWriteSource({ declarations, receipts,
            candidate: { taskId: String(request.traceId), contentFingerprint: fingerprint } }).attribution
          if (attribution === 'unknown') return // Never fall back to a broader, all-writes claim.
          sourceScope = attribution
          current.preconditionScopes.set(String(request.actionId), sourceScope)
        }
        const conditionReadId = current.conditionReads.get(declaration.conditionPath)
        if (!conditionReadId) return // 没有受信条件读 ⇒ 归因不了（不猜）。
        /*
         * ⚠️ **一次条件读只背一次写**（2026-10-24 复核）：
         *    观测的根里含那次条件读；**同一个锚点下的第二次观察会撞上 EBL 的
         *    `formation_reused` 断言**（既有 root 纪律）⇒ 那次测试永远结算不了。
         *    ⇒ 用掉就删：条件值必须**贴着**它被读到的那一次写。
         */
        current.conditionReads.delete(declaration.conditionPath)
        current.preconditionReads.set(String(request.actionId), conditionReadId)
        // 一个锚点（一次用户消息）**只允许一次观察** ⇒ 同一任务里的第二次写不再登记。
        if (current.preconditionObserved) return
        current.preconditionObserved = true
        const ref = eblWritePreconditionRef(String(request.actionId), conditionReadId, authorization.triggeringEventId)
        const store = createEblStore(db, characterId, readSource)
        const claim = await claimForNewObservation(store, preconditionCandidate(String(characterId), declaration, ref, sourceScope))
        if (!claim) return
        // 恢复旧测试失败**不许**阻断新的登记（否则一次中断就把整族钉死）。
        try { await store.recover(claim.id) } catch { /* 如实吞掉：它只影响恢复，不影响登记 */ }
        const state = await store.get(claim.id)
        if (!state || ['retired', 'withdrawn', 'superseded'].includes(state.status)) return
        await store.commit(claim.id, { kind: 'register', test: { id: String(request.actionId),
          episodeId: String(request.traceId), bindingKey: path, designId: String(request.actionId), targetId: String(request.actionId),
          source: ref, anchor: { kind: 'conversation', id: authorization.triggeringEventId } } })
        current.preconditionRegistered.add(String(request.actionId))
        return
      }
      if (request.capability !== 'sandbox.file.read') return
      const path = request.arguments.path
      if (typeof path !== 'string') return
      const current = task(authorization.taskId)
      const write = current.writes.get(path)
      if (!write) return
      const ref = eblReadbackRef(write, String(request.actionId), authorization.triggeringEventId)
      const store = createEblStore(db, characterId, readSource)
      const claim = await claimForNewObservation(store, candidate(String(characterId), ref))
      if (!claim) return
      await store.recover(claim.id)
      const state = await store.get(claim.id)
      if (!state || ['retired', 'withdrawn', 'superseded'].includes(state.status)) return
      await store.commit(claim.id, { kind: 'register', test: { id: String(request.actionId),
        episodeId: String(request.traceId), bindingKey: path, designId: write, targetId: write, source: ref,
        anchor: { kind: 'conversation', id: authorization.triggeringEventId } } })
      current.tests.set(String(request.actionId), write)
      const context = { subjectId: activeUserId, scope: claim.scope, environment: claim.environment, conditions: claim.conditions }
      if (await store.usable(claim.id, context, false, String(request.actionId))) {
        await store.commit(claim.id, { kind: 'use', use: { decisionId: String(request.actionId), before: 'unknown', after: 'readback_matches', context } })
        return { predictionChanged: true }
      }
    },
    async after({ request, result, authorization, characterId, comparison }) {
      const path = request.arguments.path
      if (typeof path !== 'string') return
      const current = task(authorization.taskId)
      if (request.capability === 'sandbox.file.write') {
        if (result.status === 'success') current.writes.set(path, String(request.actionId))
        else current.writes.delete(path)
        await settlePrecondition({ request, result, authorization, characterId })
        return
      }
      if (request.capability !== 'sandbox.file.read') return
      // 受信读面：记下这次成功的**条件标记读**（它的值由读动作的回执给出）。
      if (result.status === 'success' && conditionPaths.has(path)) current.conditionReads.set(path, String(request.actionId))
      const write = current.writes.get(path)
      if (!write) return
      const ref = eblReadbackRef(write, String(request.actionId), authorization.triggeringEventId)
      const store = createEblStore(db, characterId, readSource)
      const claim = await claimForNewObservation(store, candidate(String(characterId), ref))
      if (!claim) return
      const observed = await readSource(db, ref, claim, false)
      if (!observed?.usable) throw new Error('ebl_source_unavailable')
      const state = await store.get(claim.id)
      if (!state) await store.commit(claim.id, { kind: 'propose', claim })
      else if (current.tests.has(String(request.actionId))) {
        /*
         * ⚠️ **结算带上"比的是哪一版"**（2026-10-21 · 计划 P2 第 4 步）：
         *    `comparison` 是**这一轮**的预测核对结论（模型版本 / 规则版本 / 参数绑定摘要）
         *    ⇒ 一起落进账本，账本才能回答"这次结算比的是哪一版"。
         *    ⚠️ 没有 `comparison`（没有模型参与）⇒ **不带**（不编版本）。
         */
        await store.commit(claim.id, {
          kind: 'settle',
          testId: String(request.actionId),
          source: ref,
          ...(comparison === undefined
            ? {}
            : {
              model: {
                modelVersion: comparison.modelVersion,
                ruleVersion: comparison.ruleVersion,
                forecastVerdict: comparison.verdict,
                ...(comparison.parameterBindingDigest === undefined ? {} : { parameterBindingDigest: comparison.parameterBindingDigest }),
                ...(comparison.predictionRef === undefined ? {} : { predictionRef: comparison.predictionRef }),
              },
            }),
        })
        try { await store.commit(claim.id, { kind: 'review' }) }
        catch (error) { if (!(error instanceof Error) || !error.message.includes('validation_policy')) throw error }
      }
    },
  }

  /** 写**之后**的形成/结算（ADR-151 步骤 C）。 */
  async function settlePrecondition(input: {
    request: { actionId: unknown; arguments: Record<string, unknown> }
    result: { status: string; error?: { code?: string } }
    authorization: { taskId: string; triggeringEventId: string }
    characterId: CharacterId
  }): Promise<void> {
    const path = input.request.arguments.path
    if (typeof path !== 'string') return
    const declaration = declarationOf(path)
    if (!declaration) return
    const current = task(input.authorization.taskId)
    const actionId = String(input.request.actionId)
    // ⚠️ 用掉的那次条件读（**一次读只背一次写**；见 `before` 里的说明）。
    const conditionReadId = current.preconditionReads.get(actionId)
    if (!conditionReadId) return
    const ref = eblWritePreconditionRef(actionId, conditionReadId, input.authorization.triggeringEventId)
    const store = createEblStore(db, input.characterId, readSource)
    const claim = preconditionCandidate(String(input.characterId), declaration, ref, current.preconditionScopes.get(actionId))
    const observed = await readSource(db, ref, claim, false)
    const state = await store.get(claim.id)
    if (!state) {
      // **形成**：只有"证据码的失败 + 条件被违反"才形成候选假设（成功不是形成依据）。
      if (!observed?.usable) return
      if (input.result.status === 'success') return
      if (input.result.error?.code !== WRITE_PRECONDITION_EVIDENCE_FAILURE_CODE) return
      if (observed.value !== true) return
      await store.commit(claim.id, { kind: 'propose', claim })
      return
    }
    // 登记过的那一次写才有测试可结算（没登记 ⇒ 这次写不是观察对象）。
    if (!current.preconditionRegistered.has(actionId)) return
    if (!observed?.usable) throw new Error('ebl_precondition_source_unavailable')
    await store.commit(claim.id, { kind: 'settle', testId: actionId, source: ref })
    try { await store.commit(claim.id, { kind: 'review' }) }
    catch (error) { if (!(error instanceof Error) || !error.message.includes('validation_policy')) throw error }
  }
}

export async function observeEblFeedback(db: RawDb, characterId: CharacterId, activeUserId: string, eventId: string, formal = false): Promise<void> {
  const event = await getConversationEvent(db, eventId as never)
  if (!event || event.type !== 'user_message' || event.actorId !== activeUserId) return
  const signal = readEblPreference(event.content)
  if (!signal) return
  const decision = decideEblPreference(signal, { subjectId: activeUserId, relevant: true, attributed: true })
  // Current-turn exceptions do not become long-term counterexamples. Formal outlet applies their turn mask.
  if (!decision.longTerm) return
  const value = signal.value
  const readSource = createEblSourceReader(activeUserId)
  const store = createEblStore(db, characterId, readSource)
  for (const expected of ['concise', 'detailed'] as const satisfies readonly EblValue[]) {
    const claim = makeEblClaim({ characterId: String(characterId), subjectId: activeUserId, domain: 'interpersonal',
      predicate: 'explanation_detail', expected, scope: 'technical_explanation', environment: EBL_HUMAN_ENVIRONMENT,
      conditions: { scene: 'technical_explanation' }, formation: { kind: 'conversation', id: eventId } })
    const state = await store.get(claim.id)
    const observation = await readSource(db, { kind: 'conversation', id: eventId }, state?.claim ?? claim, false)
    if (!observation?.usable) return
    if (!state) {
      if (expected !== value) continue
      await store.commit(claim.id, { kind: 'propose', claim })
    } else {
      if (['retired', 'withdrawn', 'superseded'].includes(state.status)) continue
      if (state.tests.some(test => test.id === `after:${eventId}`)) continue
      if (expected !== value) {
        // Direct user correction is not an experiment and does not wait for another episode/test.
        await store.commit(claim.id, { kind: 'correct', source: observation.ref })
        continue
      }
      if (state.status === 'validated') continue
      for (const test of state.tests) if (test.episodeId !== observation.episodeId
        && !state.evidence.some(item => item.testId === test.id) && !state.closedTests?.some(item => item.testId === test.id)) {
        await store.commit(claim.id, { kind: 'close_test', testId: test.id, source: observation.ref })
      }
      const pending = state.tests.find(test => test.episodeId === observation.episodeId
        && !state.evidence.some(item => item.testId === test.id) && !state.closedTests?.some(item => item.testId === test.id))
      if (pending) await store.commit(claim.id, { kind: 'settle', testId: pending.id, source: observation.ref })
      if (formal) {
        try { if ((await store.commit(claim.id, { kind: 'review' })).status === 'validated') continue }
        catch (error) { if (!(error instanceof Error) || !error.message.includes('validation_policy')) throw error }
      }
    }
    // Register the next natural feedback, never turn a received message into a pre-registered test.
    await store.commit(claim.id, { kind: 'register', test: { id: `after:${eventId}`, episodeId: observation.episodeId,
      bindingKey: observation.bindingKey, designId: eventId, targetId: observation.targetId } })
  }
}
