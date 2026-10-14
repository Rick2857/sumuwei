/**
 * U1 · `G18` 接线门（`u1:g18-wiring:verify`）—— **截断之前**先过授权
 *
 * 归属：多用户补充计划 U1 / WP5（[`ADR-138`](../../docs/adr/ADR-138-authorization-filter-before-truncation.md) `D01`/`D05`）。
 *
 * 被测对象：**真的** `createMemoryRetrievalStore({ authorizeCandidates })` 的截断路径
 * （`src/infrastructure/persistence/memory-retrieval-store.ts`）。
 * 数据面用**夹具 store**（合成记录）⇒ 候选集合完全可控、**零数据库 / 零模型 / 零出网**。
 *
 * ⚠️ 它证明的是"**装配层一旦注入授权器，截断就发生在授权之后**"。
 *    它**不**代表 `G18` 在**生产**已关闭：生产尚未切换；源码装配已注入授权器，
 *    因为授权上下文（谁 · 什么空间）在入口那一条线上尚未贯通 —— 那是 WP5 接线的剩余部分。
 *
 * 三段式：正控（注入后越权候选不占名额 · limit 填满 · 计数如实 · 同序）
 *        · 负控（**不注入 ⇒ 与今天逐字相同**；**拆防线：先截断后过滤 ⇒ 0 条**）
 *        · 恢复（再跑一次读数一致）
 */

import { asCharacterId, asMemoryId, asTraceId } from '../src/kernel/contracts/ids.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import {
  createRecallRequest,
  parseRecallRequest,
  recallRequestDigest,
  serializeRecallRequest,
} from '../src/kernel/contracts/recall.ts'
import type { ScopeContext } from '../src/kernel/contracts/scope.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import type { MemoryRecord } from '../src/kernel/contracts/memory.ts'
import type { RecallRequest } from '../src/kernel/contracts/recall.ts'
import type { MemoryRetrievalQuery } from '../src/kernel/recall/ports.ts'

interface Check {
  readonly id: string
  readonly label: string
  readonly pass: boolean
  readonly detail: string
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

const CHARACTER = 'char_g18_fixture'
const OWNER = entityRef('character', CHARACTER)
const USER = entityRef('user', 'u-a')

/** 合成记录：只填检索路径真的会读到的字段（夹具，不是生产形状的完整记录） */
function fixtureRecord(id: string, recordedAt: number): MemoryRecord {
  return {
    id: asMemoryId(id),
    owner: OWNER,
    type: 'person_fact',
    content: { kind: 'claim', predicate: 'g18_fixture_predicate', subject: { kind: 'user', id: 'u-a' }, value: `记录 ${id}` },
    epistemicStatus: 'unconfirmed',
    authority: 'USER_EXPLICIT',
    importance: 0.5,
    confidence: 0.5,
    status: 'active',
    contentFingerprint: `fp-${id}`,
    recordedAt,
    processor: 'g18-fixture',
    processorVersion: 'g18-fixture@1',
    reducerVersion: 'memory-reducer@1',
    revision: 0,
    schemaVersion: 1,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  } as unknown as MemoryRecord
}

/** 越权的那两条**最新**（这样"先截断"必然先把它们选中） */
const RECENT_DENIED = ['mem-r1', 'mem-r2']
const ALL_IDS = ['mem-r1', 'mem-r2', 'mem-r3', 'mem-r4', 'mem-r5']
const RECORDS = ALL_IDS.map((id, index) => fixtureRecord(id, 5_000 - index * 1_000))

/** 完整性夹具：检索只读这两张表（本门不测完整性，故都为空） */
const integrityStub = async () =>
  ({ memoriesWithoutLiveEvidence: [], memoriesWithoutLiveEvents: [] }) as never

/** 夹具 store：`list()` 按 recordedAt 降序返回全部；`listBySubject` 故意为空（只走 recency/explicit 通道） */
function fixtureStore(): never {
  return {
    get: async (id: string) => RECORDS.find((item) => String(item.id) === String(id)) ?? null,
    list: async () => RECORDS,
    listBySubject: async () => [],
  } as never
}

function queryOf(limit: number): MemoryRetrievalQuery {
  return {
    traceId: asTraceId('trc:g18-wiring'),
    characterId: asCharacterId(CHARACTER),
    user: USER,
    text: '记录',
    timeScope: { kind: 'all' },
    limit,
    explicitIds: ALL_IDS.map((id) => asMemoryId(id)),
  } as unknown as MemoryRetrievalQuery
}

/** 授权器夹具：`denied` 里的 id 一律拒（其余放行），并如实给计数 */
function authorizerDenying(deniedIds: readonly string[], missingLabel = 0) {
  return async (input: { candidateIds: readonly string[]; limit: number }) => {
    const deniedSet = new Set(deniedIds)
    return {
      authorized: input.candidateIds.filter((id) => !deniedSet.has(id)),
      denied: input.candidateIds.filter((id) => deniedSet.has(id)).length,
      deniedForMissingLabel: missingLabel,
    }
  }
}

const LIMIT = 2

// ===========================================================================
// T1 负控（默认）· 不注入授权器 ⇒ 与今天**逐字相同**，且 `authorization` **不出现**
// ===========================================================================
const plainStore = createMemoryRetrievalStore({
  store: fixtureStore(),
  integrity: integrityStub,
  rootReadings: async () => new Map(),
})
const plain = await plainStore.retrieve(queryOf(LIMIT))
record(
  'T1.1',
  '不注入授权器 ⇒ 结果与今天同形：取到**最新的两条**（越权的那两条）',
  plain.hits.map((hit) => String(hit.record.id)).join(',') === RECENT_DENIED.join(','),
  `hits=${plain.hits.map((hit) => String(hit.record.id)).join(',')}`
)
record(
  'T1.2',
  '不注入 ⇒ `authorization` 字段**不出现在结果对象上**（形状逐字不变）',
  plain.authorization === undefined && !Object.hasOwn(plain, 'authorization'),
  `authorization=${String(plain.authorization)} · hasOwn=${String(Object.hasOwn(plain, 'authorization'))}`
)

// ===========================================================================
// T2 正控 · 注入授权器 ⇒ 越权候选**不占名额**，limit 被合法候选填满
// ===========================================================================
const scopedStore = createMemoryRetrievalStore({
  store: fixtureStore(),
  integrity: integrityStub,
  rootReadings: async () => new Map(),
  authorizeCandidates: authorizerDenying(RECENT_DENIED, 1),
})
const scoped = await scopedStore.retrieve(queryOf(LIMIT))
record(
  'T2.1',
  '注入后：最新的两条被授权拒掉 ⇒ 结果**向后顺延**取到合法的两条（`filter → slice`）',
  scoped.hits.map((hit) => String(hit.record.id)).join(',') === 'mem-r3,mem-r4',
  `hits=${scoped.hits.map((hit) => String(hit.record.id)).join(',')}`
)
record(
  'T2.2',
  '`limit` 被**填满**（2 条）—— 不是"少给"',
  scoped.hits.length === LIMIT,
  `hits=${scoped.hits.length}`
)
record(
  'T2.3',
  '缩水**可观测**：`authorization` 如实给出 authorized/denied/deniedForMissingLabel',
  scoped.authorization?.authorized === 3 &&
    scoped.authorization?.denied === 2 &&
    scoped.authorization?.deniedForMissingLabel === 1,
  `authorization=${JSON.stringify(scoped.authorization)}`
)
record(
  'T2.4',
  '过滤**不改顺序**：命中仍按原来的相关性顺序',
  scoped.hits.map((hit) => String(hit.record.id)).join(',') === 'mem-r3,mem-r4',
  `order=${scoped.hits.map((hit) => String(hit.record.id)).join(',')}`
)

// ===========================================================================
// T3 拆防线 · "先截断后过滤"（旧次序）⇒ 得 0 条
// ===========================================================================
{
  const oldOrder = plain.hits.map((hit) => String(hit.record.id))
  const filteredAfterTruncation = oldOrder.filter((id) => !RECENT_DENIED.includes(id))
  record(
    'T3.1',
    '拆防线 · 旧次序（先截断再过滤）得 **0 条**，而新次序得 **2 条** ⇒ 次序就是被量的那件事',
    filteredAfterTruncation.length === 0 && scoped.hits.length === 2,
    `old=${filteredAfterTruncation.length} 条 · new=${scoped.hits.length} 条`
  )
  const allowAll = createMemoryRetrievalStore({
    store: fixtureStore(),
    integrity: integrityStub,
    rootReadings: async () => new Map(),
    authorizeCandidates: authorizerDenying([]),
  })
  const all = await allowAll.retrieve(queryOf(LIMIT))
  record(
    'T3.2',
    '反向负控 · 授权器"全放行" ⇒ 又回到最新的两条（证明**是过滤**把越权候选拿掉的）',
    all.hits.map((hit) => String(hit.record.id)).join(',') === RECENT_DENIED.join(',') &&
      all.authorization?.denied === 0,
    `hits=${all.hits.map((hit) => String(hit.record.id)).join(',')} · denied=${String(all.authorization?.denied)}`
  )
}

// ===========================================================================
// T4 恢复 · 再跑一次读数一致（只读、确定性）
// ===========================================================================
{
  const again = await scopedStore.retrieve(queryOf(LIMIT))
  record(
    'T4.1',
    '恢复 · 同一查询再跑一次读数一致（只读、确定性）',
    again.hits.map((hit) => String(hit.record.id)).join(',') === scoped.hits.map((hit) => String(hit.record.id)).join(',') &&
      JSON.stringify(again.authorization) === JSON.stringify(scoped.authorization),
    `hits=${again.hits.map((hit) => String(hit.record.id)).join(',')}`
  )
}

// ===========================================================================
// T5 端到端透传 · `RecallRequest.scope` → `query.scope` → 授权器
// ===========================================================================
{
  const SCOPE = {
    principal: { kind: 'user', userId: 'u-a', verifiedBy: 'onebot_inbound' },
    purpose: 'external_query',
    room: { kind: 'private', userId: 'u-a' },
  } satisfies ScopeContext
  let seen: unknown
  const spyStore = createMemoryRetrievalStore({
    store: fixtureStore(),
    integrity: integrityStub,
    rootReadings: async () => new Map(),
    authorizeCandidates: async (input) => {
      seen = input.query.scope
      return { authorized: [...input.candidateIds], denied: 0, deniedForMissingLabel: 0 }
    },
  })
  const service = createMemoryRecallService({ port: spyStore })
  /*
   * ⚠️ 这里**故意**走真的 `createRecallRequest`（不再是 `as unknown as RecallRequest`）：
   *    上一版用类型断言构造请求，**因此漏掉了"工厂根本不带 `scope`"这个真缺陷**
   *    （断言绕过了校验与字段拷贝）。量具必须走生产同一条构造路径。
   */
  await service.retrieveCandidates(
    createRecallRequest({
      traceId: 'trc:g18-scope',
      characterId: CHARACTER,
      user: USER,
      query: { text: '记录' },
      intent: 'current_fact',
      candidateLimit: LIMIT,
      contextBudget: { memoryTokens: 800 },
      scope: SCOPE,
    })
  )
  record(
    'T5.1',
    '端到端 · `RecallRequest.scope` 经召回服务透传到授权器（`query.scope`）',
    seen !== undefined && JSON.stringify(seen) === JSON.stringify(SCOPE),
    `seen=${JSON.stringify(seen)}`
  )
}

// ===========================================================================
// T6 失败关闭**可观测** · 注入授权器但查询没有 scope ⇒ 拒绝全部且计数为候选数
// ===========================================================================
{
  const failClosed = createMemoryRetrievalStore({
    store: fixtureStore(),
    integrity: integrityStub,
    rootReadings: async () => new Map(),
    // 装配层的正确形状：拿不到作用域就**一个都不放行**（不是"放行了但没人知道"）
    authorizeCandidates: async (input) =>
      input.query.scope === undefined
        ? { authorized: [], denied: input.candidateIds.length, deniedForMissingLabel: 0 }
        : { authorized: [...input.candidateIds], denied: 0, deniedForMissingLabel: 0 },
  })
  const noScope = await failClosed.retrieve(queryOf(LIMIT))
  const noScopeAuth = noScope.authorization
  record(
    'T6.1',
    '注入授权器但查询没有 `scope` ⇒ **拒绝全部**（hits=0），且 `denied` 如实等于候选数（**静默放行不可能**）',
    noScope.hits.length === 0 && noScopeAuth !== undefined && noScopeAuth.authorized === 0 && noScopeAuth.denied === ALL_IDS.length,
    `hits=${noScope.hits.length} · authorization=${JSON.stringify(noScopeAuth)}`
  )
  const withScope = await failClosed.retrieve({ ...queryOf(LIMIT), scope: {
    principal: { kind: 'owner', userId: 'u-owner', verifiedBy: 'config_binding' },
    purpose: 'external_query',
    room: { kind: 'private', userId: 'u-owner' },
  } } as unknown as MemoryRetrievalQuery)
  record(
    'T6.2',
    '补上 `scope` 之后同一查询恢复正常（证明失败关闭是"缺上下文"而不是"永久拒绝"）',
    withScope.hits.length === LIMIT && withScope.authorization?.denied === 0,
    `hits=${withScope.hits.length} · denied=${String(withScope.authorization?.denied)}`
  )
}

// ===========================================================================
// T7 契约层 · 工厂**真的**带 scope；记录（序列化/摘要）**不带**；载荷自带 scope **被拒**
// ===========================================================================
{
  const SCOPE7 = {
    principal: { kind: 'user', userId: 'u-a', verifiedBy: 'onebot_inbound' },
    purpose: 'external_query',
    room: { kind: 'private', userId: 'u-a' },
  } satisfies ScopeContext
  const base = {
    traceId: 'trc:g18-contract',
    characterId: CHARACTER,
    user: USER,
    query: { text: '记录' },
    intent: 'current_fact' as const,
    candidateLimit: LIMIT,
    contextBudget: { memoryTokens: 800 },
  }
  const scoped = createRecallRequest({ ...base, scope: SCOPE7 })
  const unscoped = createRecallRequest(base)
  record(
    'T7.1',
    '**`createRecallRequest` 真的把 `scope` 带上了**（上一版正是漏在这里：工厂显式列字段，新增字段会被静默丢掉）',
    scoped.scope !== undefined && JSON.stringify(scoped.scope) === JSON.stringify(SCOPE7),
    `scope=${JSON.stringify(scoped.scope)}`
  )
  const serialized = serializeRecallRequest(scoped)
  record(
    'T7.2',
    '记录材料**不含** `scope`（授权上下文是每轮事实，固化进记录会让回放用旧身份）',
    !serialized.includes('scope') && !serialized.includes('"scope"'),
    `hasScopeKey=${String(serialized.includes('scope'))}`
  )
  record(
    'T7.3',
    '摘要**不因 scope 变化**（有 scope 与无 scope 的同一请求摘要相同 ⇒ 旧读数逐字不变）',
    recallRequestDigest(scoped) === recallRequestDigest(unscoped),
    `scoped=${recallRequestDigest(scoped)} · unscoped=${recallRequestDigest(unscoped)}`
  )
  record(
    'T7.4',
    '反序列化往返一致：序列化**不写** scope、解析**不产** scope（不会出现"存了却没读回"）',
    parseRecallRequest(JSON.parse(serialized)).scope === undefined,
    `roundTripScope=${String(parseRecallRequest(JSON.parse(serialized)).scope)}`
  )
  let payloadRejected = ''
  try {
    parseRecallRequest({ ...JSON.parse(serialized), scope: SCOPE7 })
  } catch (error) {
    payloadRejected = String((error as { code?: string }).code ?? '')
  }
  record(
    'T7.5',
    '**载荷自带 `scope` ⇒ 具名拒绝**（`recall_scope_from_payload`）—— 否则任何能喂进请求的地方都能自称原主人',
    payloadRejected === 'recall_scope_from_payload',
    `code=${payloadRejected}`
  )
  let badPurpose = ''
  try {
    createRecallRequest({ ...base, scope: { ...SCOPE7, purpose: 'root' } as unknown as ScopeContext })
  } catch (error) {
    badPurpose = String((error as { code?: string }).code ?? '')
  }
  let badRoom = ''
  try {
    createRecallRequest({ ...base, scope: { ...SCOPE7, room: { kind: 'private', userId: '  ' } } })
  } catch (error) {
    badRoom = String((error as { code?: string }).code ?? '')
  }
  record(
    'T7.6',
    '工厂对形状**失败关闭**：未登记用途 / 空空间 id ⇒ 具名拒绝',
    badPurpose === 'recall_scope_bad_purpose' && badRoom === 'recall_scope_bad_room_id',
    `badPurpose=${badPurpose} · badRoom=${badRoom}`
  )
}

// T9 读取链登记：检查实际委托边界。行为由 completion/group 两道隔离门测量。
{
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const chains: readonly [string, string, string][] = [
    ['候选授权', 'src/infrastructure/persistence/memory-retrieval-store.ts', 'options.authorizeCandidates'],
    ['资格证明', 'src/kernel/recall/eligibility.ts', 'record_scope_not_authorized'],
    ['语义候选', 'src/infrastructure/semantic/semantic-probe.ts', 'authorizedMemoryIds(options.db'],
    ['预算渲染', 'src/kernel/recall/selector.ts', 'recall_scope_not_authorized'],
    ['最终入模', 'src/kernel/app/turn-gateway.ts', 'text: recallOutcome.selection.blockText'],
    ['Recent 取窗口', 'src/infrastructure/persistence/conversation-store.ts', 'and (${conversationReadPredicate()})'],
    ['滚动摘要委托', 'src/infrastructure/persistence/rollup-source-store.ts', 'await recentConversationEvents(db'],
    ['图片同会话', 'src/kernel/app/turn-gateway.ts', 'line.conversationId !== String(this.options.recorder.conversationId)'],
    ['主动依据限定', 'src/main.ts', 'authorization: session.proactiveSourceAuthorization'],
    ['后台逐来源作用域', 'src/infrastructure/runtime/post-turn-model-memory.ts', 'withReadScope(scope, processEvent)'],
    ['反思来源授权', 'src/infrastructure/persistence/reflection-source-read.ts', 'sourceRootsVisible'],
    ['目标输入委托', 'src/infrastructure/persistence/goal-input-store.ts', 'await store.get('],
    ['信念来源授权', 'src/infrastructure/persistence/belief-store.ts', 'sourceRootsVisible'],
    ['动作对新用户关闭', 'src/main.ts', 'workflowSkillsEnabled: false'],
    ['trace 禁正文', 'src/kernel/app/memory/memory-trace.ts', 'assertNoMemoryContentInTrace'],
    ['管理渲染仅本机 CLI', 'src/main.ts', 'if (memoryAdminRequested)'],
  ]
  for (const [index, [name, path, marker]] of chains.entries()) {
    const source = readFileSync(resolve(import.meta.dirname, '..', path), 'utf8')
    record(`T9.${index+1}`, name, source.includes(marker), `${path} delegates/guards through ${marker}`)
  }
  record('T9.boundary', '诊断/导出/恢复仅本机管理入口，普通 QQ 的动作与技能关闭',
    readFileSync(resolve(import.meta.dirname, '../src/main.ts'), 'utf8').includes('taskAutonomyEnabled: false'),
    '入口边界；不是全库 RLS 或诊断脚本逐一行为通过')
}

// ===========================================================================
// 汇总
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
const passed = failed.length === 0
console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} u1:g18-wiring:verify = ${passed ? 'PASS' : 'FAIL'}`)
console.log('  ⚠️ 本门**不**代表 G18 在生产已关闭：源码已接线；生产未切换，行为证据另见 completion/group 门。')
if (!passed) {
  console.log('  失败项：')
  for (const c of failed) console.log(`    - ${c.id} ${c.label}：${c.detail}`)
}
process.exitCode = passed ? 0 : 1
