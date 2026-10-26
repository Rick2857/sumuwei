/** Native EBL source policy. Reuses existing attribution, audience and withdrawal reads. */
import { createHash } from 'node:crypto'
import { fnv1a64Hex } from '../../kernel/action/idempotency.ts'
import { DOCUMENT_PROFILE, PDF_PROFILE_PREFIX, PDF_PROFILE_READING_VERSION, readPdfProfile } from '../../kernel/contracts/document-profile.ts'
import {
  DOCUMENT_COVERAGE_ENVIRONMENT, DOCUMENT_COVERAGE_POLICY, DOCUMENT_COVERAGE_PREFIX, DOCUMENT_COVERAGE_SCOPE,
  readDocumentCoverageReceipt, type DocumentCoverageReceipt,
} from '../../kernel/contracts/document-coverage.ts'
import { sql } from 'drizzle-orm'
import { asActionId, asCharacterId } from '../../kernel/contracts/ids.ts'
import { EBL_EVENT, eblAssert, type EblClaim, type EblObservation, type EblSourceRef } from '../../kernel/contracts/epistemic-belief.ts'
import { familyIdOfScope, familyOfWriteTarget } from '../../kernel/contracts/write-family.ts'
import {
  WRITE_PRECONDITION_ACTION, classifyWritePreconditionObservation,
  readSandboxConditionReceipt, readWritePreconditionConditions,
} from '../../kernel/contracts/write-precondition.ts'
import { EBL_TECHNICAL_CONTEXT, EBL_OTHER_CONTEXT, readEblPreference } from '../../kernel/app/epistemic-belief-lifecycle/human-policy.ts'
import { createActionLedgerStore } from '../action/action-ledger-store.ts'
import { getConversationEvent } from './conversation-store.ts'
import { readReflectionSourceSnapshot } from './reflection-source-read.ts'
import { exec, type RawDb } from './db.ts'
import type { EblSourceReader } from './epistemic-belief-store.ts'
import { DOCUMENT_EXTRACT, DOCUMENT_READING_VERSION, PDF_READERS, PDF_RECEIPT_PREFIX, readPdfReceipt } from '../../kernel/contracts/document-reading.ts'
import { attributeWriteSource } from '../../kernel/contracts/write-source-attribution.ts'
import { readWriteSourceReceipts, type WriteSourcesForTarget } from './write-source-read.ts'

export const EBL_TOOL_ENVIRONMENT = 'sandbox-filesystem@1'
export const EBL_HUMAN_ENVIRONMENT = 'interaction@3'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Constructed by the trusted task observer from actual action IDs + TaskAuthorization anchor. */
export function eblReadbackRef(writeActionId: string, readActionId: string, anchorEventId: string): EblSourceRef {
  return { kind: 'action', id: JSON.stringify([writeActionId, readActionId, anchorEventId]) }
}
/**
 * **写前置条件**命题的来源引用（ADR-151 步骤 C）。
 *
 * ⚠️ 三件事都必须在**账本**里可核：失败的写、条件读、对话锚点。
 * ⚠️ 条件读**必须早于**那次失败的写（否则"条件当时是什么"答不出来 ⇒ 归因不了）。
 */
export function eblWritePreconditionRef(writeActionId: string, conditionReadActionId: string, anchorEventId: string): EblSourceRef {
  return { kind: 'action', id: JSON.stringify(['precondition@1', writeActionId, conditionReadActionId, anchorEventId]) }
}
export function documentReadingRef(actionId: string, anchorId: string, profileActionId?: string): EblSourceRef {
  return { kind: 'action', id: JSON.stringify(profileActionId ? [PDF_PROFILE_READING_VERSION, actionId, anchorId, profileActionId] : [DOCUMENT_READING_VERSION, actionId, anchorId]) }
}
/** 覆盖命题的来源引用：**独立环境标识** ⇒ 不会被旧的 `pdf_text` 读面误认。 */
export function documentCoverageRef(actionId: string, anchorId: string): EblSourceRef {
  return { kind: 'action', id: JSON.stringify([DOCUMENT_COVERAGE_ENVIRONMENT, actionId, anchorId]) }
}
/**
 * 受信读面的**可选**参数。
 *
 * ⚠️ `knownDirectories`：给了就**复核族**（写目标必须真的落在命题的族里）；
 *    没给就**不**复核（读面在多处被创建，强行要求同一份受信事实会让读面行为不一致）。
 */
export interface EblSourceReaderOptions {
  knownDirectories?: () => readonly string[]
  writeSources?: WriteSourcesForTarget
}

/**
 * **本任务**（trace）里**受信观测**到的条件值（ADR-151 步骤 D 的消费侧读面）。
 *
 * ⚠️ 只认：**同一个 trace** 里、对那个路径的**成功读动作**的**受信回执**
 *    （`sandbox-condition@1:<值>`）。
 * ⚠️ **不**认候选自述，**不**认别的历史读数 ⇒ 条件**未知**就是未知（不猜）。
 * ⚠️ 取**最近一次**（同 trace 内 sequence 最大的那条）。
 */
export async function readTrustedConditionInTrace (
  db: RawDb,
  characterId: string,
  traceId: string,
  conditionPath: string
): Promise<{ readonly value: string; readonly source: string } | undefined> {
  const rows = await exec(db, sql`select action_id, payload->'evidence' as evidence
    from character_action_events
    where character_id = ${characterId} and trace_id = ${traceId}
      and capability = 'sandbox.file.read' and operation = 'read'
      and event_type = 'ACTION_SUCCEEDED'
      and payload->'target'->>'canonicalId' = ${conditionPath}
    order by sequence desc limit 1`, 'EBL trusted condition in trace')
  const evidence = rows[0]?.evidence as { ref?: string }[] | undefined
  const value = evidence?.map(item => readSandboxConditionReceipt(item.ref)).find(item => item !== undefined)
  if (value === undefined) return undefined
  return { value, source: String(rows[0]?.action_id) }
}

export function createEblSourceReader(activeUserId: string, options: EblSourceReaderOptions = {}): EblSourceReader {
  async function root(db: RawDb, id: string, claim: EblClaim, lock: boolean) {
    const event = await getConversationEvent(db, id as never)
    if (!event || event.type !== 'user_message' || event.actorId !== activeUserId
      || String(event.characterId) !== claim.characterId || claim.subjectId !== activeUserId) return undefined
    if (lock) await exec(db, sql`select id from conversation_events where id = ${id} for share`, 'EBL root lock')
    const snapshot = await readReflectionSourceSnapshot(db, asCharacterId(claim.characterId), [{ kind: 'conversation_event', id }], { activeUserId, lock })
    return { event, snapshot }
  }
  return async (db, ref, claim, lock) => {
    if (ref.kind === 'conversation') {
      if (claim.domain === 'tool') {
        const reading = await root(db, ref.id, claim, lock)
        if (!reading) return undefined
        return { ref, characterId: claim.characterId, subjectId: activeUserId, episodeId: String(reading.event.conversationId),
          bindingKey: String(reading.event.conversationId), environment: claim.environment, targetId: ref.id,
          observedAt: reading.event.createdAt, independentKey: ref.id, revision: hash(reading.snapshot.revisions), rootIds: [ref.id],
          usable: reading.snapshot.usable && !reading.snapshot.unresolvedConflict, witnessed: false, executed: false, complete: false, influencedBy: [] }
      }
      if (claim.domain !== 'interpersonal' || claim.environment !== EBL_HUMAN_ENVIRONMENT
        || claim.predicate !== 'explanation_detail' || claim.scope !== 'technical_explanation'
        || JSON.stringify(claim.conditions) !== JSON.stringify({ scene: 'technical_explanation' })) return undefined
      const reading = await root(db, ref.id, claim, lock)
      if (!reading) return undefined
      const { event, snapshot } = reading
      const technical = EBL_TECHNICAL_CONTEXT, otherScene = EBL_OTHER_CONTEXT
      let scene = technical.test(event.content) && !otherScene.test(event.content) ? { id: String(event.id), snapshot } : undefined
      if (!scene && !otherScene.test(event.content)) {
        const anchors = await exec(db, sql`select id, content from conversation_events where character_id = ${claim.characterId}
          and conversation_id = ${String(event.conversationId)} and actor_type = 'user' and actor_id = ${activeUserId}
          and conversation_sequence < ${event.conversationSequence} order by conversation_sequence desc limit 12`, 'EBL observed technical context')
        for (const anchor of anchors) {
          if (otherScene.test(String(anchor.content))) break
          if (!technical.test(String(anchor.content))) continue
          const qualified = await root(db, String(anchor.id), claim, lock)
          if (qualified?.snapshot.usable && !qualified.snapshot.unresolvedConflict) scene = { id: String(anchor.id), snapshot: qualified.snapshot }
          break
        }
      }
      if (!scene) return undefined // The declared scene is a condition, not an invented default.
      const signal = readEblPreference(event.content)
      const persistent = signal?.horizon === 'persistent'
      // A rule-guided reply cannot supply a new independent success for its own rule.
      const influenced = await exec(db, sql`select distinct e.payload->>'claimId' as claim_id
        from character_domain_events e join conversation_events u on u.id = e.payload->'command'->'use'->>'decisionId'
        where e.character_id = ${claim.characterId} and e.type = ${EBL_EVENT}
        and e.payload->'command'->>'kind' = 'use' and u.conversation_id = ${String(event.conversationId)}
        and u.character_id = ${claim.characterId} and u.conversation_sequence = (
          select max(conversation_sequence) from conversation_events where character_id = ${claim.characterId}
          and conversation_id = ${String(event.conversationId)} and actor_type = 'user'
          and conversation_sequence < ${event.conversationSequence})`, 'EBL human feedback influence')
      return { ref, characterId: claim.characterId, subjectId: activeUserId,
        episodeId: String(event.conversationId), bindingKey: String(event.conversationId),
        environment: EBL_HUMAN_ENVIRONMENT, targetId: String(event.conversationId), observedAt: event.createdAt,
        independentKey: String(event.id), revision: hash([snapshot.revisions, scene.id, scene.snapshot.revisions]), rootIds: [String(event.id)],
        usable: snapshot.usable && !snapshot.unresolvedConflict, witnessed: signal !== undefined,
        executed: true, complete: persistent, ...(persistent ? { value: signal.value } : {}),
        ...(signal ? { feedbackScope: signal.horizon } : {}), influencedBy: influenced.map(row => String(row.claim_id)).sort() }
    }
    /*
     * ⚠️ **覆盖命题的证据读面**（2026-10-23 · P2.1 第四批）：
     *   它只认**行动账本里的覆盖回执**（无正文），并且回执的参照版本必须
     *   与命题条件 `reference` 一致、字节指纹必须与提取回执一致。
     *   ⇒ 没有回执 = 覆盖**未知**（不是支持），未复核参照也不会走到这里。
     */
    if (claim.domain === 'tool' && claim.predicate === 'document_extracts' && claim.scope === DOCUMENT_COVERAGE_SCOPE) {
      if (claim.environment !== DOCUMENT_COVERAGE_ENVIRONMENT || claim.conditions.format !== 'pdf'
        || !PDF_READERS.includes(claim.conditions.reader as never)
        || claim.conditions.policy !== DOCUMENT_COVERAGE_POLICY
        || Object.keys(claim.conditions).length !== 4) return undefined
      let parts: unknown
      try { parts = JSON.parse(ref.id) } catch { return undefined }
      if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== claim.environment
        || !parts.every(s => typeof s === 'string' && s.length <= 128)) return undefined
      const [, actionId, anchorId] = parts as string[]
      const reading = await root(db, anchorId!, claim, lock)
      if (!reading) return undefined
      if (lock) await exec(db, sql`select action_id from character_action_events where character_id = ${claim.characterId}
        and action_id = ${actionId} order by action_id, sequence for share`, 'PDF coverage source lock')
      const events = await createActionLedgerStore(db).getEventsByActionId(asCharacterId(claim.characterId), asActionId(actionId!))
      const requested = events.find(e => e.type === 'ACTION_REQUESTED')
      const actual = events.find(e => ['ACTION_SUCCEEDED','ACTION_FAILED','ACTION_REJECTED','ACTION_CANCELLED'].includes(e.type))
      const initiator = actual?.attribution?.slots.initiator
      if (!actual || !requested || actual.capability !== DOCUMENT_EXTRACT || actual.operation !== 'read'
        || initiator?.state !== 'KNOWN' || !initiator.value || typeof initiator.value !== 'object'
        || !('kind' in initiator.value) || initiator.value.kind !== 'USER' || !('id' in initiator.value) || initiator.value.id !== activeUserId
        || reading.event.createdAt > requested.createdAt) return undefined
      const args = requested.payload.arguments as Record<string, { value?: string; fingerprint?: string }> | undefined
      if ((args?.reader?.value ?? 'markitdown') !== claim.conditions.reader || !args?.path?.fingerprint) return undefined
      const evidence = actual.payload.evidence as { ref?: string }[] | undefined
      const encodedCoverage = evidence?.find(e => e.ref?.startsWith(DOCUMENT_COVERAGE_PREFIX))?.ref?.slice(DOCUMENT_COVERAGE_PREFIX.length)
      if (!encodedCoverage) return undefined // 覆盖未知：没有回执就没有证据
      let coverage: DocumentCoverageReceipt | undefined
      try { coverage = readDocumentCoverageReceipt(JSON.parse(encodedCoverage)) } catch { coverage = undefined }
      if (!coverage || coverage.referenceVersion !== claim.conditions.reference) return undefined
      const encodedReading = evidence?.find(e => e.ref?.startsWith(PDF_RECEIPT_PREFIX))?.ref?.slice(PDF_RECEIPT_PREFIX.length)
      let readingReceipt
      if (encodedReading) { try { readingReceipt = readPdfReceipt(JSON.parse(encodedReading)) } catch { readingReceipt = undefined } }
      if (!readingReceipt || readingReceipt.inputFingerprint !== coverage.inputFingerprint
        || readingReceipt.reader !== claim.conditions.reader) return undefined
      if (coverage.outcome === 'unknown') return undefined // 未知覆盖不产生任何证据
      const registration = await exec(db, sql`select payload->>'claimId' as claim_id,
        payload->'command'->'test'->>'designId' as design_id from character_domain_events
        where character_id = ${claim.characterId} and type = ${EBL_EVENT} and payload->'command'->>'kind' = 'register'
        and payload->'command'->'test'->>'id' = ${actionId}`, 'PDF coverage prior test design')
      const uses = await exec(db, sql`select payload->>'claimId' as claim_id from character_domain_events
        where character_id = ${claim.characterId} and type = ${EBL_EVENT} and payload->'command'->>'kind' = 'use'
        and payload->'command'->'use'->>'decisionId' = ${actionId}`, 'PDF coverage guidance exclusion')
      const influencedBy = [...new Set([...uses.map(row => String(row.claim_id)),
        ...registration.filter(row => String(row.design_id).startsWith('pdf-rule:')).map(row => String(row.claim_id))])].sort()
      // 覆盖回执只可能出现在成功行动上 ⇒ 未成功就没有覆盖证据（而不是"接口故障"）。
      const excluded = actual.status === 'success' ? undefined
        : actual.status === 'cancelled' ? 'cancelled' as const
        : actual.status === 'rejected' ? 'permission_denied' as const
        : actual.status === 'timeout' ? 'transport_failure' as const : 'interface_failure' as const
      return { ref, characterId: claim.characterId, subjectId: activeUserId, episodeId: String(actual.traceId),
        bindingKey: `document:${args.path.fingerprint}`, targetId: actionId!, environment: claim.environment,
        observedAt: actual.createdAt, independentKey: `document:${coverage.inputFingerprint}`,
        revision: hash([reading.snapshot.revisions, actual.sequence, coverage, readingReceipt]),
        rootIds: [anchorId!, `action:${actionId}`, `document:${coverage.inputFingerprint}`],
        usable: reading.snapshot.usable && !reading.snapshot.unresolvedConflict, witnessed: true,
        executed: events.some(e => e.type === 'ACTION_STARTED'), complete: true,
        value: coverage.outcome === 'met', ...(excluded ? { excluded } : {}), influencedBy }
    }
    if (claim.domain === 'tool' && claim.predicate === 'document_extracts') {
      const scoped = claim.environment === PDF_PROFILE_READING_VERSION
      if ((!scoped && claim.environment !== DOCUMENT_READING_VERSION) || claim.scope !== 'pdf_text' || claim.conditions.format !== 'pdf'
        || !PDF_READERS.includes(claim.conditions.reader as never) || Object.keys(claim.conditions).length !== (scoped ? 3 : 2)
        || (scoped && !['present','absent'].includes(String(claim.conditions.text_layer)))) return undefined
      let parts: unknown
      try { parts = JSON.parse(ref.id) } catch { return undefined }
      if (!Array.isArray(parts) || parts.length !== (scoped ? 4 : 3) || parts[0] !== claim.environment
        || !parts.every(s => typeof s === 'string' && s.length <= 128)) return undefined
      const [, actionId, anchorId, profileId] = parts as string[]
      const reading = await root(db, anchorId!, claim, lock)
      if (!reading) return undefined
      if (lock) await exec(db, sql`select action_id from character_action_events where character_id = ${claim.characterId}
        and action_id in (${actionId}, ${profileId ?? actionId}) order by action_id, sequence for share`, 'PDF reading source lock')
      const events = await createActionLedgerStore(db).getEventsByActionId(asCharacterId(claim.characterId), asActionId(actionId!))
      const requested = events.find(e => e.type === 'ACTION_REQUESTED')
      const actual = events.find(e => ['ACTION_SUCCEEDED','ACTION_FAILED','ACTION_REJECTED','ACTION_CANCELLED'].includes(e.type))
      const initiator = actual?.attribution?.slots.initiator
      if (!actual || !requested || actual.capability !== DOCUMENT_EXTRACT || actual.operation !== 'read'
        || initiator?.state !== 'KNOWN' || !initiator.value || typeof initiator.value !== 'object'
        || !('kind' in initiator.value) || initiator.value.kind !== 'USER' || !('id' in initiator.value) || initiator.value.id !== activeUserId
        || reading.event.createdAt > requested.createdAt) return undefined
      const args = requested.payload.arguments as Record<string, { value?: string; fingerprint?: string }> | undefined
      if ((args?.reader?.value ?? 'markitdown') !== claim.conditions.reader || !args?.path?.fingerprint) return undefined
      const evidence = actual.payload.evidence as { ref?: string }[] | undefined
      const failure = actual.payload.failure as { code?: string; details?: { documentReading?: unknown } } | undefined
      const encoded = evidence?.find(e => e.ref?.startsWith(PDF_RECEIPT_PREFIX))?.ref?.slice(PDF_RECEIPT_PREFIX.length)
      let candidate: unknown = failure?.details?.documentReading
      if (encoded) { try { candidate = JSON.parse(encoded) } catch { return undefined } }
      const receipt = readPdfReceipt(candidate)
      if (receipt && (receipt.reader !== claim.conditions.reader || (receipt.outcome === 'nonempty') !== (actual.type === 'ACTION_SUCCEEDED'))) return undefined
      let profileMatches = !scoped, profileRevision: unknown
      if (scoped) {
        const profileEvents = await createActionLedgerStore(db).getEventsByActionId(asCharacterId(claim.characterId), asActionId(profileId!))
        const pr = profileEvents.find(e => e.type === 'ACTION_REQUESTED'), pa = profileEvents.find(e => e.type === 'ACTION_SUCCEEDED')
        const profileArgs = pr?.payload.arguments as typeof args
        const profileEvidence = pa?.payload.evidence as {ref?: string}[] | undefined
        const encodedProfile = profileEvidence?.find(e => e.ref?.startsWith(PDF_PROFILE_PREFIX))?.ref?.slice(PDF_PROFILE_PREFIX.length)
        let profile
        try { profile = readPdfProfile(JSON.parse(encodedProfile ?? '')) } catch { /* invalid profile cannot support evidence */ }
        profileMatches = Boolean(pr && pa && profile && profile.outcome === 'complete' && profile.textLayer === claim.conditions.text_layer
          && pa.capability === DOCUMENT_PROFILE && pa.operation === 'inspect' && pa.traceId === actual.traceId
          && profileEvents.some(e => e.type === 'ACTION_STARTED') && pa.sequence < requested.sequence && reading.event.createdAt <= pr.createdAt
          && JSON.stringify(pa.attribution?.slots.initiator) === JSON.stringify(initiator)
          && profileArgs?.path?.fingerprint === args.path.fingerprint
          && args.expectedInputFingerprint?.fingerprint === fnv1a64Hex(profile.inputFingerprint)
          && receipt?.inputFingerprint === profile.inputFingerprint)
        profileRevision = [pa?.sequence, profile]
      }
      const complete = profileMatches && receipt !== undefined && ['empty','nonempty'].includes(receipt.outcome)
      const registration = await exec(db, sql`select payload->>'claimId' as claim_id,
        payload->'command'->'test'->>'designId' as design_id from character_domain_events
        where character_id = ${claim.characterId} and type = ${EBL_EVENT} and payload->'command'->>'kind' = 'register'
        and payload->'command'->'test'->>'id' = ${actionId}`, 'PDF prior test design')
      const uses = await exec(db, sql`select payload->>'claimId' as claim_id from character_domain_events
        where character_id = ${claim.characterId} and type = ${EBL_EVENT} and payload->'command'->>'kind' = 'use'
        and payload->'command'->'use'->>'decisionId' = ${actionId}`, 'PDF guidance exclusion')
      const influencedBy = [...new Set([...uses.map(row => String(row.claim_id)),
        ...registration.filter(row => String(row.design_id).startsWith('pdf-rule:')).map(row => String(row.claim_id))])].sort()
      const excluded = complete ? undefined : actual.status === 'cancelled' ? 'cancelled' as const
        : actual.status === 'rejected' && failure?.code === 'permission_denied' ? 'permission_denied' as const
        : actual.status === 'timeout' ? 'transport_failure' as const : 'interface_failure' as const
      return { ref, characterId: claim.characterId, subjectId: activeUserId, episodeId: String(actual.traceId),
        bindingKey: `document:${args.path.fingerprint}`, targetId: actionId!, environment: claim.environment,
        observedAt: actual.createdAt, independentKey: receipt ? `document:${receipt.inputFingerprint}` : `action:${actionId}`,
        revision: hash([reading.snapshot.revisions, actual.sequence, receipt, ...(scoped ? [profileRevision] : [])]), rootIds: [anchorId!, `action:${actionId}`,
          ...(scoped ? [`action:${profileId}`] : []),
          ...(receipt ? [`document:${receipt.inputFingerprint}`] : [])],
        usable: reading.snapshot.usable && !reading.snapshot.unresolvedConflict, witnessed: receipt !== undefined,
        executed: events.some(e => e.type === 'ACTION_STARTED'), complete,
        ...(complete ? { value: receipt!.outcome === 'nonempty' } : {}), ...(excluded ? { excluded } : {}), influencedBy }
    }
    /*
     * ⚠️ **写前置条件命题的证据读面**（ADR-151 步骤 C）：
     *   只认**账本里三件可核的事**：那次写、条件读、对话锚点。
     *   ⚠️ 条件读**必须早于**那次写（否则"条件当时是什么"答不出来 ⇒ 归因不了）。
     *   ⚠️ 条件值**只**来自那次读动作的**受信回执**（不在账本里 ⇒ 条件未知 ⇒ 不猜）。
     */
    if (claim.domain === 'tool' && claim.predicate === 'write_precondition_holds') {
      if (claim.environment !== EBL_TOOL_ENVIRONMENT || claim.expected !== true) return undefined
      const familyId = familyIdOfScope(claim.scope)
      if (familyId === undefined) return undefined
      const shape = readWritePreconditionConditions(claim.conditions)
      if (!shape) return undefined
      let parts: unknown
      try { parts = JSON.parse(ref.id) } catch { return undefined }
      if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== 'precondition@1'
        || !parts.every(part => typeof part === 'string' && part.length > 0 && part.length <= 128)) return undefined
      const [, writeId, conditionReadId, anchorId] = parts as string[]
      const reading = await root(db, anchorId, claim, lock)
      if (!reading) return undefined
      if (lock) await exec(db, sql`select action_id from character_action_events where character_id = ${claim.characterId}
        and action_id in (${sql.join([writeId, conditionReadId].sort().map(id => sql`${id}`), sql`, `)}) order by action_id, sequence for share`, 'EBL precondition source lock')
      const ledger = createActionLedgerStore(db)
      const writes = await ledger.getEventsByActionId(asCharacterId(claim.characterId), asActionId(writeId))
      const reads = await ledger.getEventsByActionId(asCharacterId(claim.characterId), asActionId(conditionReadId))
      const write = writes.find(event => ['ACTION_SUCCEEDED', 'ACTION_FAILED', 'ACTION_REJECTED', 'ACTION_CANCELLED'].includes(event.type))
      const read = reads.find(event => ['ACTION_SUCCEEDED', 'ACTION_FAILED', 'ACTION_REJECTED', 'ACTION_CANCELLED'].includes(event.type))
      if (!write || !read || write.capability !== WRITE_PRECONDITION_ACTION.capability || write.operation !== WRITE_PRECONDITION_ACTION.operation
        || read.capability !== 'sandbox.file.read' || read.operation !== 'read'
        || write.traceId !== read.traceId || read.createdAt > write.createdAt
        || reading.event.createdAt > write.createdAt) return undefined
      const knownUser = (event: typeof read) => {
        const value = event.attribution?.slots.initiator
        return value?.state === 'KNOWN' && typeof value.value === 'object' && value.value !== null
          && 'kind' in value.value && value.value.kind === 'USER' && 'id' in value.value && value.value.id === activeUserId
      }
      if (!knownUser(write) || !knownUser(read)) return undefined
      const target = (event: typeof read) => (event.payload.target as { canonicalId?: string } | undefined)?.canonicalId
      if (!target(write) || target(read) !== shape.conditionPath) return undefined
      if (shape.sourceScope !== undefined) {
        const declarations = options.writeSources?.(target(write)!) ?? []
        const requested = writes.find(event => event.type === 'ACTION_REQUESTED')
        if (!requested) return undefined
        const args = requested.payload.arguments as
          Record<string, { value?: string; fingerprint?: string }> | undefined
        // The ledger summarizes the staged content fingerprint by hashing it again.
        const receipts = await readWriteSourceReceipts(db, { characterId: claim.characterId, activeUserId,
          traceId: String(write.traceId), declarations, beforeSequence: requested.sequence })
        const fingerprints = [...new Set(receipts.map(item => item.contentFingerprint))]
        const contentFingerprint = fingerprints.find(item => fnv1a64Hex(item) === args?.payloadFingerprint?.fingerprint)
        if (contentFingerprint === undefined || attributeWriteSource({ declarations, receipts,
          candidate: { taskId: String(write.traceId), contentFingerprint } }).attribution !== shape.sourceScope) return undefined
      }
      /*
       * ⚠️ **族复核**（只在**给了**受信目录事实时做）：写目标必须真的落在命题的族里。
       *    没有受信目录事实 ⇒ 不复核（族仍由**受信声明 + 观察者**给出）。
       */
      if (options.knownDirectories !== undefined) {
        let known: readonly string[] = []
        try { known = options.knownDirectories() ?? [] } catch { known = [] }
        if (familyOfWriteTarget({ path: target(write)!, knownDirectories: known }) !== familyId) return undefined
      }
      /*
       * ⚠️ **条件标记的归属**（失败关闭）：条件标记**必须**由受信侧拥有。
       *    如果代理**写过**它（动作账本里有对它的写），它的值就由代理控制
       *    ⇒ 那就不是受信事实 ⇒ **这一族的条件观测一律作废**（宁可没有证据，
       *    也不让代理自己写出"条件被违反"）。
       */
      const markerWrites = await exec(db, sql`select action_id from character_action_events
        where character_id = ${claim.characterId} and capability = ${WRITE_PRECONDITION_ACTION.capability}
        and operation = ${WRITE_PRECONDITION_ACTION.operation}
        and payload->'target'->>'canonicalId' = ${shape.conditionPath} limit 1`, 'EBL precondition marker provenance')
      const started = writes.some(event => event.type === 'ACTION_STARTED')
      const failure = write.payload.failure as { code?: string } | undefined
      const readEvidence = read.payload.evidence as { ref?: string }[] | undefined
      const observed = readEvidence?.map(item => readSandboxConditionReceipt(item.ref)).find(item => item !== undefined)
      /*
       * ⚠️ 判定**共用** `classifyWritePreconditionObservation`（C1 的同一份规则）
       *    ⇒ 纯函数门与产品接线**不会**各自漂移。
       */
      const preconditionReading = classifyWritePreconditionObservation({
        status: write.type === 'ACTION_SUCCEEDED' ? 'success'
          : write.type === 'ACTION_FAILED' ? 'failure'
            : write.type === 'ACTION_CANCELLED' ? 'cancelled' : 'rejected',
        ...(failure?.code === undefined ? {} : { failureCode: failure.code }),
        ...(observed === undefined ? {} : { conditionObserved: { conditionPath: shape.conditionPath, value: observed } }),
        conditionPath: shape.conditionPath,
        mustNotEqual: shape.mustNotEqual,
        executed: started,
        conditionTrusted: markerWrites.length === 0,
      })
      const uses = await exec(db, sql`select payload->>'claimId' as claim_id from character_domain_events
        where character_id = ${claim.characterId} and type = ${EBL_EVENT}
        and payload->'command'->>'kind' = 'use'
        and payload->'command'->'use'->>'decisionId' in (${writeId}, ${conditionReadId})`, 'EBL precondition influenced test exclusion')
      const result: EblObservation = {
        ref, characterId: claim.characterId, subjectId: activeUserId, episodeId: String(write.traceId),
        bindingKey: target(write)!, environment: EBL_TOOL_ENVIRONMENT, targetId: writeId,
        observedAt: write.createdAt, independentKey: `action:${writeId}`,
        revision: hash([reading.snapshot.revisions, write.sequence, read.sequence, shape, observed]),
        rootIds: [anchorId, `action:${writeId}`, `action:${conditionReadId}`],
        usable: reading.snapshot.usable && !reading.snapshot.unresolvedConflict,
        witnessed: preconditionReading.witnessed, executed: started, complete: preconditionReading.complete,
        ...(preconditionReading.value === undefined ? {} : { value: preconditionReading.value }),
        ...(preconditionReading.excluded === undefined ? {} : { excluded: preconditionReading.excluded }),
        influencedBy: [...new Set(uses.map(row => String(row.claim_id)))].sort(),
      }
      eblAssert(result.ref.id.length <= 256, 'precondition_ref_limit')
      return result
    }
    if (claim.domain !== 'tool' || claim.predicate !== 'readback_matches' || claim.environment !== EBL_TOOL_ENVIRONMENT
      || claim.scope !== 'sandbox_readback' || JSON.stringify(claim.conditions) !== JSON.stringify({ encoding: 'utf8' })) return undefined
    let ids: unknown
    try { ids = JSON.parse(ref.id) } catch { return undefined }
    if (!Array.isArray(ids) || ids.length !== 3 || !ids.every(id => typeof id === 'string' && id.length <= 128)) return undefined
    const [writeId, readId, anchorId] = ids as string[]
    const reading = await root(db, anchorId, claim, lock)
    if (!reading) return undefined
    if (lock) await exec(db, sql`select action_id from character_action_events where character_id = ${claim.characterId}
      and action_id in (${sql.join([writeId, readId].sort().map(id => sql`${id}`), sql`, `)}) order by action_id, sequence for share`, 'EBL action source lock')
    const ledger = createActionLedgerStore(db)
    const writes = await ledger.getEventsByActionId(asCharacterId(claim.characterId), asActionId(writeId))
    const reads = await ledger.getEventsByActionId(asCharacterId(claim.characterId), asActionId(readId))
    const write = writes.find(event => event.type === 'ACTION_SUCCEEDED')
    const read = reads.find(event => ['ACTION_SUCCEEDED', 'ACTION_FAILED', 'ACTION_CANCELLED', 'ACTION_REJECTED'].includes(event.type))
    if (!write || !read || write.capability !== 'sandbox.file.write' || write.operation !== 'write'
      || read.capability !== 'sandbox.file.read' || read.operation !== 'read'
      || write.traceId !== read.traceId || write.createdAt > read.createdAt
      || reading.event.createdAt > write.createdAt) return undefined
    const knownUser = (event: typeof read) => {
      const value = event.attribution?.slots.initiator
      return value?.state === 'KNOWN' && typeof value.value === 'object' && value.value !== null
        && 'kind' in value.value && value.value.kind === 'USER' && 'id' in value.value && value.value.id === activeUserId
    }
    if (!knownUser(write) || !knownUser(read)) return undefined // legacy is not fabricated into trusted evidence
    const target = (event: typeof read) => (event.payload.target as { canonicalId?: string } | undefined)?.canonicalId
    if (!target(write) || target(write) !== target(read)) return undefined
    const writeEffect = write.payload.effect as { fingerprint?: string; bytes?: number } | undefined
    const readEffect = read.payload.effect as { fingerprint?: string; bytes?: number } | undefined
    const complete = writeEffect?.fingerprint !== undefined && readEffect?.fingerprint !== undefined
      && writeEffect.bytes !== undefined && readEffect.bytes !== undefined
    const excluded = read.status === 'cancelled' ? 'cancelled' : read.status === 'rejected' ? 'permission_denied'
      : read.status === 'timeout' ? 'transport_failure' : read.status === 'failed' ? 'interface_failure' : undefined
    const uses = await exec(db, sql`select payload->>'claimId' as claim_id from character_domain_events
      where character_id = ${claim.characterId} and type = ${EBL_EVENT}
      and payload->'command'->>'kind' = 'use'
      and payload->'command'->'use'->>'decisionId' in (${writeId}, ${readId})`, 'EBL influenced test exclusion')
    const result: EblObservation = { ref, characterId: claim.characterId, subjectId: activeUserId,
      episodeId: String(read.traceId), bindingKey: target(read)!, environment: EBL_TOOL_ENVIRONMENT,
      targetId: writeId, observedAt: read.createdAt, independentKey: `action:${writeId}`,
      revision: hash([reading.snapshot.revisions, write.sequence, read.sequence]),
      rootIds: [anchorId, `action:${writeId}`, `action:${readId}`],
      usable: reading.snapshot.usable && !reading.snapshot.unresolvedConflict, witnessed: true,
      executed: reads.some(event => event.type === 'ACTION_STARTED'), complete,
      ...(complete ? { value: writeEffect!.fingerprint === readEffect!.fingerprint && writeEffect!.bytes === readEffect!.bytes } : {}),
      ...(excluded ? { excluded } : {}), influencedBy: [...new Set(uses.map(row => String(row.claim_id)))].sort() }
    eblAssert(result.ref.id.length <= 256, 'readback_ref_limit')
    return result
  }
}
