import { fnv1a64Hex } from '../../kernel/action/idempotency.ts'
import type { EblTaskObserver } from '../../kernel/action/task-loop.ts'
import { EBL_LIMIT, makeEblClaim, type EblClaim } from '../../kernel/contracts/epistemic-belief.ts'
import { DOCUMENT_EXTRACT, DOCUMENT_READING_VERSION, PDF_READERS, type PdfReader } from '../../kernel/contracts/document-reading.ts'
import {
  DOCUMENT_COVERAGE_ENVIRONMENT, DOCUMENT_COVERAGE_PREFIX, DOCUMENT_COVERAGE_SCOPE,
  documentCoverageConditions, readDocumentCoverageReceipt,
} from '../../kernel/contracts/document-coverage.ts'
import type { PlanRuleDependency } from '../../kernel/contracts/cognitive-collaboration.ts'
import type { RawDb } from '../persistence/db.ts'
import { createEblStore } from '../persistence/epistemic-belief-store.ts'
import { createEblSourceReader, documentCoverageRef, documentReadingRef } from '../persistence/epistemic-belief-source.ts'
import { DOCUMENT_PROFILE, PDF_PROFILE_PREFIX, PDF_PROFILE_READING_VERSION, readPdfProfile, type PdfProfile } from '../../kernel/contracts/document-profile.ts'
import type { TaskAuthorization } from '../../kernel/action/task-authorization.ts'
import type { DocumentCoverageReferencePort } from './document-coverage-reference.ts'

/**
 * 原生 EBL 观察器（**只**观察，不写正文）。
 *
 * ⚠️ 两条命题**分列**，互不转义：
 *   · `pdf_text` / `pdf-text@1`（或 `pdf-text-profile@1`）⇒ **"取得了非空文本"**；
 *   · `pdf_text_coverage` / `pdf-text-coverage@1` ⇒ **"在声明范围内达到覆盖政策"**。
 *   覆盖命题的**身份是新的**（内容寻址）⇒ 不继承"非空"命题的任何资格。
 */
export function createDocumentBeliefObserver(db: RawDb, activeUserId: string,
  selected: () => PlanRuleDependency | undefined = () => undefined,
  coverage?: DocumentCoverageReferencePort) {
  const registered = new Map<string, { claimId?: string; profileActionId?: string; coverageClaimId?: string }>()
  let observed: { profile: PdfProfile; actionId: string; path: string; authorization: TaskAuthorization; traceId: string } | undefined
  function profileFor(path: string) {
    return observed?.path === path && observed.authorization.closedReason === undefined && Date.now() < observed.authorization.expiresAt ? observed : undefined
  }
  const reader = createEblSourceReader(activeUserId)
  async function current(store: ReturnType<typeof createEblStore>, base: EblClaim): Promise<EblClaim | undefined> {
    let claim = base
    for (let depth = 0; depth < EBL_LIMIT; depth++) {
      const state = await store.get(claim.id)
      if (!state) return depth === 0 ? claim : undefined
      if (state.status === 'superseded') {
        const next = state.successorId ? await store.get(state.successorId) : undefined
        if (!next || next.claim.predecessor !== claim.id) return undefined
        claim = next.claim
        continue
      }
      if (['retired','withdrawn'].includes(state.status) || claim.predicate !== base.predicate || claim.expected !== base.expected
        || claim.scope !== base.scope || claim.environment !== base.environment
        || JSON.stringify(claim.conditions) !== JSON.stringify(base.conditions)) return undefined
      return state.claim
    }
    return undefined
  }
  const observer: EblTaskObserver = {
    async before({ request, authorization, characterId }) {
      if (request.capability !== DOCUMENT_EXTRACT) return
      const backend = (request.arguments.reader ?? 'markitdown') as PdfReader
      if (!PDF_READERS.includes(backend) || typeof request.arguments.path !== 'string') return
      const store = createEblStore(db, characterId, reader)
      const entry: { claimId?: string; profileActionId?: string; coverageClaimId?: string } = {}
      /*
       * ⚠️ **覆盖命题的预登记**（先于执行发生）：
       *   只有**真人复核通过**的参照才进入；登记的 `source` 就是覆盖回执的来源引用，
       *   ⇒ 结算时只能由**同一次真实提取**的回执来应答，不接受任何事后声明。
       */
      const reference = coverage?.find(request.arguments.path)
      if (reference) {
        const coverageRef = documentCoverageRef(String(request.actionId), authorization.triggeringEventId)
        const coverageBase = makeEblClaim({ characterId: String(characterId), subjectId: activeUserId, domain: 'tool',
          predicate: 'document_extracts', expected: true, scope: DOCUMENT_COVERAGE_SCOPE, environment: DOCUMENT_COVERAGE_ENVIRONMENT,
          conditions: documentCoverageConditions(backend, reference.version), formation: coverageRef })
        const coverageClaim = await current(store, coverageBase)
        /*
         * ⚠️ **命题还不存在时不能登记**（2026-10-23 第五批试点抓到）：
         *   `current()` 在命题未落地时返回的是**候选身份**，不是已存在的命题；
         *   直接 `register` 会让账本报 `claim_missing` ⇒ 观察钩子抛错（被吞掉，只留失败计数）。
         *   ⇒ 只有**账本里真的有这条命题**才登记（与旧"非空"命题同一形状）。
         */
        const coverageState = coverageClaim ? await store.get(coverageClaim.id) : undefined
        if (coverageClaim && coverageState && !['retired', 'withdrawn', 'superseded'].includes(coverageState.status)) {
          await store.commit(coverageClaim.id, { kind: 'register', test: { id: String(request.actionId), episodeId: String(request.traceId),
            bindingKey: `document:${fnv1a64Hex(request.arguments.path)}`, targetId: String(request.actionId),
            designId: `pdf-coverage-independent:${authorization.triggeringEventId}`, source: coverageRef,
            anchor: { kind: 'conversation', id: authorization.triggeringEventId } } })
          entry.coverageClaimId = coverageClaim.id
        }
      }
      const prior = profileFor(request.arguments.path)
      const bound = prior?.authorization.taskId === authorization.taskId && prior.authorization.triggeringEventId === authorization.triggeringEventId
        && prior.traceId === String(request.traceId) && prior.profile.outcome === 'complete'
        && request.arguments.expectedInputFingerprint === prior.profile.inputFingerprint ? prior : undefined
      const ref = documentReadingRef(String(request.actionId), authorization.triggeringEventId, bound?.actionId)
      const base = makeEblClaim({ characterId: String(characterId), subjectId: activeUserId, domain: 'tool',
        predicate: 'document_extracts', expected: true, scope: 'pdf_text', environment: bound ? PDF_PROFILE_READING_VERSION : DOCUMENT_READING_VERSION,
        conditions: { format: 'pdf', reader: backend, ...(bound ? { text_layer: bound.profile.textLayer } : {}) }, formation: ref })
      const claim = await current(store, base)
      if (!claim) { if (entry.coverageClaimId) registered.set(String(request.actionId), entry); return }
      await store.recover(claim.id)
      const state = await store.get(claim.id)
      if (!state || ['retired','withdrawn','superseded'].includes(state.status)) { if (entry.coverageClaimId) registered.set(String(request.actionId), entry); return }
      const dependency = selected()
      await store.commit(claim.id, { kind: 'register', test: { id: String(request.actionId), episodeId: String(request.traceId),
        bindingKey: `document:${fnv1a64Hex(request.arguments.path)}`, targetId: String(request.actionId),
        designId: dependency ? `pdf-rule:${dependency.claimId}` : `pdf-independent:${authorization.triggeringEventId}`,
        source: ref, anchor: { kind: 'conversation', id: authorization.triggeringEventId } } })
      if (dependency?.claimId === claim.id) await store.commit(claim.id, { kind: 'use', use: {
        decisionId: String(request.actionId), before: 'unknown', after: 'nonempty',
        context: { subjectId: activeUserId, scope: claim.scope, environment: claim.environment, conditions: claim.conditions },
      } })
      registered.set(String(request.actionId), { ...entry, claimId: claim.id, ...(bound ? { profileActionId: bound.actionId } : {}) })
      if (dependency?.claimId === claim.id) return { predictionChanged: true }
    },
    async after({ request, result, authorization, characterId, comparison }) {
      if (request.capability === DOCUMENT_PROFILE) {
        observed = undefined
        const encoded = result.evidence?.find(e => e.ref?.startsWith(PDF_PROFILE_PREFIX))?.ref?.slice(PDF_PROFILE_PREFIX.length)
        let profile: PdfProfile | undefined
        try { profile = readPdfProfile(JSON.parse(encoded ?? '')) } catch { /* no trustworthy profile */ }
        if (profile && result.executed && ['success','partial'].includes(result.status) && typeof request.arguments.path === 'string'
          && result.turnContent?.some(c => c.capability === DOCUMENT_PROFILE && c.sourceFingerprint === profile!.inputFingerprint)
          && authorization.closedReason === undefined && Date.now() < authorization.expiresAt)
          observed = { profile, actionId: String(request.actionId), path: request.arguments.path, authorization, traceId: String(request.traceId) }
        return
      }
      if (request.capability !== DOCUMENT_EXTRACT) return
      const backend = (request.arguments.reader ?? 'markitdown') as PdfReader
      if (!PDF_READERS.includes(backend)) return
      const registration = registered.get(String(request.actionId))
      const store = createEblStore(db, characterId, reader)
      /*
       * ⚠️ **覆盖命题的结算**（与"非空"命题分列）：
       *   ① 没有覆盖回执 ⇒ 覆盖**未知** ⇒ 不产生任何证据（不是支持，也不是反例）；
       *   ② 有回执但命题还不存在 ⇒ 用**这次真实提取**的回执作为形成观察提出命题
       *      （形成观察必须显示覆盖**已达成**，否则不提出）；
       *   ③ 命题已存在且本次已预登记 ⇒ 用同一份回执结算（覆盖未达成 = 反例）。
       */
      const coverageEncoded = result.evidence?.find(e => e.ref?.startsWith(DOCUMENT_COVERAGE_PREFIX))?.ref?.slice(DOCUMENT_COVERAGE_PREFIX.length)
      let coverageReceipt
      if (coverageEncoded) { try { coverageReceipt = readDocumentCoverageReceipt(JSON.parse(coverageEncoded)) } catch { coverageReceipt = undefined } }
      if (coverageReceipt) {
        const coverageRef = documentCoverageRef(String(request.actionId), authorization.triggeringEventId)
        const coverageBase = makeEblClaim({ characterId: String(characterId), subjectId: activeUserId, domain: 'tool',
          predicate: 'document_extracts', expected: true, scope: DOCUMENT_COVERAGE_SCOPE, environment: DOCUMENT_COVERAGE_ENVIRONMENT,
          conditions: documentCoverageConditions(backend, coverageReceipt.referenceVersion), formation: coverageRef })
        const coverageClaimId = registration?.coverageClaimId
        const coverageClaim = coverageClaimId ? (await store.get(coverageClaimId))?.claim : await current(store, coverageBase)
        if (coverageClaim) {
          const coverageState = await store.get(coverageClaim.id)
          if (!coverageState) {
            const observation = await reader(db, coverageClaim.formation, coverageClaim, false)
            if (observation?.usable && observation.complete && observation.value === true) {
              await store.commit(coverageClaim.id, { kind: 'propose', claim: coverageClaim })
            }
          } else if (coverageClaimId) {
            try {
              await store.commit(coverageClaim.id, { kind: 'settle', testId: String(request.actionId), source: coverageRef })
            } catch (error) {
              // 与形成观察同源的文档不构成独立证据：这是策略拒绝，不是程序缺陷。
              if (!(error instanceof Error) || !error.message.includes('formation_reused')) throw error
            }
            try { await store.commit(coverageClaim.id, { kind: 'review' }) }
            catch (error) { if (!(error instanceof Error) || !error.message.includes('validation_policy')) throw error }
          }
        }
      }
      const ref = documentReadingRef(String(request.actionId), authorization.triggeringEventId, registration?.profileActionId)
      const base = makeEblClaim({ characterId: String(characterId), subjectId: activeUserId, domain: 'tool',
        predicate: 'document_extracts', expected: true, scope: 'pdf_text', environment: DOCUMENT_READING_VERSION,
        conditions: { format: 'pdf', reader: backend }, formation: ref })
      const registeredId = registration?.claimId
      registered.delete(String(request.actionId))
      // First scoped observation has no stored claim yet; repeat the same bound context, never downgrade it to legacy evidence.
      const prior = profileFor(String(request.arguments.path))
      const scoped = prior?.authorization.taskId === authorization.taskId && prior.traceId === String(request.traceId)
        && prior.profile.outcome === 'complete' && request.arguments.expectedInputFingerprint === prior.profile.inputFingerprint ? prior : undefined
      const candidate = scoped ? makeEblClaim({ ...base, environment: PDF_PROFILE_READING_VERSION,
        conditions: { ...base.conditions, text_layer: scoped.profile.textLayer },
        formation: documentReadingRef(String(request.actionId), authorization.triggeringEventId, scoped.actionId) }) : base
      if (result.error?.details?.profileBinding === 'source_changed') observed = undefined
      const claim = registeredId ? (await store.get(registeredId))?.claim : await current(store, candidate)
      if (!claim) return
      const state = await store.get(claim.id)
      if (!state) {
        const observation = await reader(db, claim.formation, claim, false)
        if (observation?.usable && observation.complete) await store.commit(claim.id, { kind: 'propose', claim })
        return
      }
      if (!registeredId) return
      await store.commit(claim.id, { kind: 'settle', testId: String(request.actionId), source: ref,
        ...(comparison ? { model: { modelVersion: comparison.modelVersion, ruleVersion: comparison.ruleVersion,
          forecastVerdict: comparison.verdict, ...(comparison.parameterBindingDigest ? { parameterBindingDigest: comparison.parameterBindingDigest } : {}),
          ...(comparison.predictionRef ? { predictionRef: comparison.predictionRef } : {}) } } : {}),
      })
      try { await store.commit(claim.id, { kind: 'review' }) }
      catch (error) { if (!(error instanceof Error) || !error.message.includes('validation_policy')) throw error }
    },
  }
  return { ...observer, profileFor }
}
