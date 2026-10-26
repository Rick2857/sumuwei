/** Existing domain events + one projection per claim. Transaction required; no schema migration. */
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { EBL_EVENT, EBL_EVENT_MAX_BYTES, EBL_VERSION, eblAssert, eblCanonical, eblSourceKey, validateEblCommand, validateEblEventPayload,
  validateEblObservation, type EblClaim, type EblCommand, type EblObservation, type EblSourceRef,
  type EblSources, type EblState, type EblUse } from '../../kernel/contracts/epistemic-belief.ts'
import { eblUsable, reduceEbl, validateEblTransition } from '../../kernel/app/epistemic-belief-lifecycle/lifecycle.ts'
import type { CharacterId } from '../../kernel/contracts/ids.ts'
import { exec, inTransaction, type RawDb } from './db.ts'
import { appendDomainEvent, domainEventsFor, findDomainEventByIdempotencyKey, getProjection,
  insertProjection, saveProjection } from './event-store.ts'

export type EblSourceReader = (db: RawDb, ref: EblSourceRef, claim: EblClaim, lock: boolean) => Promise<EblObservation | undefined>
const rowKey = (id: string) => `ebl:${id}`
const digest = (value: unknown) => createHash('sha256').update(eblCanonical(value)).digest('hex')

/**
 * 一条命题的**当前快照**（状态 + 版本 + 当前证据指纹 + 来源引用）。
 *
 * ⚠️ 为什么要有它：世界模型引擎要消费的是"**当前合格**的规则"，
 *    而"合格"这件事**只有 EBL 侧知道**（证据资格、政策、独立根都在那边）。
 *    ⇒ 这里把 EBL 的读面**原样**交出去，**不在外面重算一遍**证据资格
 *      （重算就会分叉 —— 那是"两套实现算出两个答案"的经典形状）。
 */
export interface EblSnapshot {
  /** 当前状态 */
  state: EblState
  /** 投影的 revision（单调递增；当作"这条命题的第几版"） */
  revision: number
  /** 当前证据指纹（历史来源的指纹；证据动过就会变） */
  sourcesFingerprint: string
  /** 当前来源观察（引用 + 各自 revision + 根） */
  sources: Array<{ ref: EblSourceRef; revision: string; rootIds: string[] }>
  /**
   * 完整的来源集合（`formation` + 观察 + 指纹）。
   *
   * ⚠️ 它**不是**外面重算的 —— 是**同一条读面**（`sourcesOf`）算出来的，
   *    所以"判政策用的来源"与"指纹用的来源"**必然一致**
   *    （分开算就会出现"指纹对得上但政策用另一份来源"的分叉）。
   */
  sourceSet: EblSources
}

export function createEblStore(db: RawDb, characterId: CharacterId, readSource: EblSourceReader) {
  async function lock(tx: RawDb): Promise<void> {
    // ponytail: serialize EBL per character; split by claim only if measured throughput requires it.
    await exec(tx, sql`select pg_advisory_xact_lock(hashtextextended(${`ebl:${characterId}`}, 0))`, 'EBL character lock')
  }
  async function sourcesOf(tx: RawDb, state: EblState | undefined, claim: EblClaim, extra: EblSourceRef[] = []): Promise<EblSources> {
    const historical = new Set([claim.formation, ...(state?.evidence.map(item => item.observation.ref) ?? []),
      ...(state?.corrections?.map(item => item.ref) ?? []), ...(state?.closedTests?.map(item => item.source.ref) ?? [])].map(eblSourceKey))
    const refs = new Map([claim.formation, ...(state?.evidence.map(item => item.observation.ref) ?? []),
      ...(state?.corrections?.map(item => item.ref) ?? []),
      ...(state?.closedTests?.map(item => item.source.ref) ?? []),
      ...(state?.tests.flatMap(test => [...(test.source ? [test.source] : []), ...(test.anchor ? [test.anchor] : [])]) ?? []), ...extra]
      .map(ref => [eblSourceKey(ref), ref]))
    const observations: EblObservation[] = []
    for (const [, ref] of [...refs].sort(([a], [b]) => a.localeCompare(b))) {
      const item = await readSource(tx, ref, claim, true)
      if (item) observations.push(validateEblObservation(item))
    }
    const roots = [...new Set(observations.flatMap(item => item.rootIds))]
    if (roots.length > 0) {
      const withdrawals = await exec(tx, sql`select payload->'forbiddenRoots' as roots from character_domain_events
        where character_id = ${String(characterId)} and type = ${EBL_EVENT}
        and payload->'command'->>'kind' = 'withdraw'
        and jsonb_exists_any(payload->'forbiddenRoots', array[${sql.join(roots.map(id => sql`${id}`), sql`, `)}]::text[])`, 'EBL forgotten roots')
      const forbidden = new Set(withdrawals.flatMap(row => row.roots as string[]))
      for (const item of observations) if (item.rootIds.some(root => forbidden.has(root))) {
        item.usable = false; item.revision = digest([item.revision, 'ebl_withdrawn'])
      }
    }
    return { formation: observations.find(item => eblSourceKey(item.ref) === eblSourceKey(claim.formation)),
      observations, fingerprint: digest(observations.filter(item => historical.has(eblSourceKey(item.ref)))) }
  }
  async function transaction<T>(work: (tx: RawDb) => Promise<T>): Promise<T> {
    eblAssert(db.transaction, 'transaction_required')
    return inTransaction(db, async tx => { await lock(tx); return work(tx) })
  }
  const store = {
    async get(claimId: string): Promise<EblState | undefined> {
      return (await getProjection<EblState>(db, characterId, rowKey(claimId)))?.state
    },
    async commit(claimId: string, raw: EblCommand, options: { allowHuman?: boolean } = {}): Promise<EblState> {
      const command = validateEblCommand(raw)
      return transaction(async tx => {
        const prior = await getProjection<EblState>(tx, characterId, rowKey(claimId))
        const claim = command.kind === 'propose' ? command.claim : prior?.state.claim
        eblAssert(claim && claim.characterId === String(characterId), 'claim_owner')
        const sources = await sourcesOf(tx, prior?.state, claim, command.kind === 'settle' || command.kind === 'correct' || command.kind === 'close_test' ? [command.source]
          : command.kind === 'register' && command.test.anchor ? [command.test.anchor] : [])
        const key = `ebl:${digest([String(characterId), EBL_VERSION, claimId, command,
          command.kind === 'review' ? sources.fingerprint : null])}`
        const duplicate = await findDomainEventByIdempotencyKey(tx, key)
        if (duplicate) {
          eblAssert(prior, 'projection_missing')
          if (command.kind === 'use') eblAssert(eblUsable(prior.state, sources, command.use.context,
            options.allowHuman, command.use.decisionId), 'not_usable')
          return prior.state
        }
        const observation = command.kind === 'settle' || command.kind === 'correct' || command.kind === 'close_test'
          ? sources.observations.find(item => eblSourceKey(item.ref) === eblSourceKey(command.source)) : undefined
        const relatedId = command.kind === 'supersede' ? command.successorId : command.kind === 'propose' ? claim.predecessor : undefined
        const successor = relatedId ? (await getProjection<EblState>(tx, characterId, rowKey(relatedId)))?.state : undefined
        if (command.kind === 'supersede' && successor) {
          const successorSources = await sourcesOf(tx, successor, successor.claim)
          eblAssert(eblUsable(successor, successorSources, { subjectId: successor.claim.subjectId, scope: successor.claim.scope,
            environment: successor.claim.environment, conditions: successor.claim.conditions }, options.allowHuman), 'successor_not_usable')
        }
        const nowRows = await exec(tx, sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as now`, 'EBL registration clock')
        const now = Number(nowRows[0]?.now)
        const payload = validateEblEventPayload(validateEblTransition({ claimId, characterId: String(characterId), command,
          state: prior?.state, sources, observation, now, allowHuman: options.allowHuman, successor }))
        eblAssert(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= EBL_EVENT_MAX_BYTES, 'payload_limit')
        const roots = [...new Set(sources.observations.flatMap(item => item.rootIds).filter(id => !id.startsWith('action:')))]
        const event = await appendDomainEvent(tx, characterId, { type: EBL_EVENT, operation: command.kind,
          payload, sourceConversationEventIds: roots as never, idempotencyKey: key, processor: 'epistemic-belief-lifecycle',
          processorVersion: EBL_VERSION, scope: 'CHARACTER_INTERNAL',
          ...(prior?.lastDomainEventId ? { causedByDomainEventIds: [prior.lastDomainEventId] } : {}) }, now)
        const next = reduceEbl(prior?.state, payload, event.event.createdAt)
        const projection = { characterId, projectionType: rowKey(claimId), revision: (prior?.revision ?? 0) + 1,
          reducerVersion: EBL_VERSION, state: next, lastDomainEventId: event.event.id,
          lastDomainEventSequence: event.event.sequence, updatedAt: now }
        if (prior) await saveProjection(tx, projection, prior.revision, now)
        else await insertProjection(tx, projection, now)
        return next
      })
    },
    async usable(claimId: string, context: EblUse['context'], allowHuman = false, currentTestId?: string): Promise<boolean> {
      try {
        return await transaction(async tx => {
          const state = (await getProjection<EblState>(tx, characterId, rowKey(claimId)))?.state
          return state !== undefined && eblUsable(state, await sourcesOf(tx, state, state.claim), context, allowHuman, currentTestId)
        })
      } catch { return false }
    },
    /**
     * 当前快照（状态 + 版本 + 证据指纹 + 来源引用）。
     *
     * ⚠️ **只读**：不开事务、不写任何东西（写路径只有 `commit`）。
     *    ⇒ 它可以被规则消费者反复调用。
     */
    async snapshot(claimId: string): Promise<EblSnapshot | undefined> {
      const projection = await getProjection<EblState>(db, characterId, rowKey(claimId))
      if (projection === undefined) return undefined
      const state = projection.state
      const sources = await sourcesOf(db, state, state.claim)
      return {
        state,
        revision: projection.revision,
        sourcesFingerprint: sources.fingerprint,
        sources: sources.observations.map(observation => ({
          ref: observation.ref,
          revision: observation.revision,
          rootIds: observation.rootIds,
        })),
        sourceSet: sources,
      }
    },
    async recover(claimId: string): Promise<void> {
      const state = await store.get(claimId)
      if (!state || ['withdrawn', 'retired', 'superseded'].includes(state.status)) return
      for (const test of state.tests) if (test.source && !state.evidence.some(item => item.testId === test.id)) {
        const observation = await readSource(db, test.source, state.claim, false)
        if (observation?.usable) await store.commit(claimId, { kind: 'settle', testId: test.id, source: test.source })
      }
    },
    async rebuild(claimId: string): Promise<EblState | undefined> {
      return transaction(async tx => {
        let state: EblState | undefined
        let last = 0
        let lastEvent: Awaited<ReturnType<typeof domainEventsFor>>[number] | undefined
        let revision = 0
        // Page the complete event stream; never silently accept a truncated replay.
        for (;;) {
          const events = await domainEventsFor(tx, characterId, { type: EBL_EVENT, afterSequence: last, limit: 512 })
          for (const event of events) {
            const payload = validateEblEventPayload(event.payload)
            if (payload.claimId === claimId) { state = reduceEbl(state, payload, event.createdAt); revision++; lastEvent = event }
            last = event.sequence
          }
          if (events.length < 512) break
        }
        if (state && lastEvent) {
          const prior = await getProjection<EblState>(tx, characterId, rowKey(claimId))
          const projection = { characterId, projectionType: rowKey(claimId), state, revision, reducerVersion: EBL_VERSION,
            lastDomainEventId: lastEvent.id, lastDomainEventSequence: lastEvent.sequence, updatedAt: lastEvent.createdAt }
          if (prior) await saveProjection(tx, projection, prior.revision, lastEvent.createdAt)
          else await insertProjection(tx, projection, lastEvent.createdAt)
        }
        return state
      })
    },
  }
  return store
}
export type EblStore = ReturnType<typeof createEblStore>
