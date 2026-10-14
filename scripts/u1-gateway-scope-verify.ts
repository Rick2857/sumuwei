/**
 * U1 · 网关作用域端到端门（`u1:gateway-scope:verify`）—— 补上 `ADR-138` §5quinquies 欠下的读数
 *
 * 它证明的是什么（**真网关 + 真召回服务 + 间谍检索端口**）：
 * ```text
 * `TurnGatewayOptions.scope` ⇒ `recallForTurn` ⇒ `createRecallRequest({ scope })`
 *   ⇒ 召回服务 `translate()` ⇒ 检索端口 `retrieve(query)` 的 `query.scope`
 * 走完整条链；并且**不传 scope 时端口看到的仍是 `undefined`**（逐字不变的负控）。
 * ```
 *
 * 环境：隔离库（`isolateDatabase`）+ 真实 `TurnGateway`（`beginTurn` → `compileTurn`）；
 * 模型那一跳**不跑**（`compileTurn` 之后不调 `completeTurn`）⇒ 零模型 / 零出网。
 */

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

// 后端闸（与其它 U1 隔离门同形）
{
  const { config: loadDotenv } = await import('dotenv')
  const { existsSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  let envDir = process.cwd()
  while (!existsSync(join(envDir, '.env')) && dirname(envDir) !== envDir) envDir = dirname(envDir)
  loadDotenv({ path: join(envDir, '.env'), quiet: true })
  const { databaseBackendEnvironmentFrom, resolveDatabaseBackend } = await import(
    '../src/infrastructure/persistence/database-backend.ts'
  )
  if (resolveDatabaseBackend(databaseBackendEnvironmentFrom()).backend === 'postgres') {
    console.log('')
    console.log('  [NOT RUN] u1:gateway-scope:verify（具名原因：directory_sandbox_requires_pglite_backend）')
    console.log('     跑法：在没有 .env 的 cwd 下驱动本脚本，并设 CHARACTER_DB_BACKEND=pglite（+ POSTGRES_URL= / DATABASE_URL=）。')
    console.log('     这不是"通过"：本门的读数为未取得。')
    process.exit(2)
  }
}

const runId = `u1-gateway-scope-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const sandbox = isolateDatabase('u1-gateway-scope', { runId, keep: true })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const { TurnGateway } = await import('../src/kernel/app/turn-gateway.ts')
const { createMemoryRecallService } = await import('../src/kernel/app/recall/retrieval.ts')
const { createRecallTurnPort } = await import('../src/kernel/app/recall/turn.ts')
const { DEFAULT_CONTEXT_BUDGET } = await import('../src/kernel/recall/selector.ts')
const { asCharacterId, asMemoryId } = await import('../src/kernel/contracts/ids.ts')
const { entityRef } = await import('../src/kernel/contracts/entity.ts')
type ScopeContext = import('../src/kernel/contracts/scope.ts').ScopeContext
type MemoryRecord = import('../src/kernel/contracts/memory.ts').MemoryRecord

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

const h = await createM4Harness({ label: 'u1-gateway-scope' })
const USER = String((h as unknown as { userId?: string }).userId ?? 'u-a')

/** 合成记录（只填检索路径会读到的字段） */
function fixtureRecord(id: string, recordedAt: number): MemoryRecord {
  return {
    id: asMemoryId(id),
    owner: entityRef('character', String(h.characterId)),
    type: 'person_fact',
    content: { kind: 'claim', predicate: 'g28_fixture', subject: { kind: 'user', id: USER }, value: id },
    epistemicStatus: 'unconfirmed',
    authority: 'USER_EXPLICIT',
    importance: 0.5,
    confidence: 0.5,
    status: 'active',
    contentFingerprint: `fp-${id}`,
    recordedAt,
    processor: 'g28-fixture',
    processorVersion: 'g28-fixture@1',
    reducerVersion: 'memory-reducer@1',
    revision: 0,
    schemaVersion: 1,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  } as unknown as MemoryRecord
}
const RECORDS = ['mem-g28-1', 'mem-g28-2'].map((id, index) => fixtureRecord(id, 5_000 - index * 1_000))

/** 间谍检索端口：记录每一次 `retrieve(query)` 看到的 `query.scope` */
const seenScopes: (ScopeContext | undefined)[] = []
const spyPort = {
  name: 'spy-retrieval',
  retrieve: async (query: { scope?: ScopeContext; limit: number; explicitIds?: readonly string[] }) => {
    seenScopes.push(query.scope)
    const hits = RECORDS.slice(0, query.limit).map((item) => ({
      record: item,
      channels: ['recency'],
      rootReadings: [],
    }))
    return {
      hits,
      capabilities: { available: ['subject', 'recency'], unavailable: [] },
      scanned: RECORDS.length,
      semanticScoredIds: [],
      brokenMemoryIds: [],
    }
  },
  health: async () => ({ status: 'ready' as const }),
} as unknown as Parameters<typeof createMemoryRecallService>[0]['port']

const SCOPE = {
  principal: { kind: 'user', userId: USER, verifiedBy: 'onebot_inbound' },
  purpose: 'external_query',
  room: { kind: 'private', userId: USER },
} satisfies ScopeContext

/** 造一个真网关（`scope` 传 / 不传各一次） */
function gatewayWith(seq: { value: number }, scope?: ScopeContext): InstanceType<typeof TurnGateway> {
  const recall = createRecallTurnPort({
    service: createMemoryRecallService({ port: spyPort }),
    budget: DEFAULT_CONTEXT_BUDGET,
    now: () => Date.now(),
  })
  return new TurnGateway({
    kernel: h.kernel,
    definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot,
    recorder: h.recorder,
    conversationSequence: () => seq.value,
    userId: USER,
    recall,
    ...(scope !== undefined ? { scope } : {}),
  } as unknown as ConstructorParameters<typeof TurnGateway>[0])
}

/** 走一轮：`beginTurn` → `compileTurn`（**不**调 `completeTurn`，因此不碰模型） */
async function compile(
  seq: { value: number },
  text: string,
  opts: { gatewayScope?: ScopeContext; turnScope?: ScopeContext } = {}
): Promise<{ ok: boolean; reason: string }> {
  const gateway = gatewayWith(seq, opts.gatewayScope)
  try {
    const turn = await gateway.beginTurn(text)
    /* ⚠️ `+1`：本门**不**调 `completeTurn` ⇒ 不写助手那一格（`+2` 会制造空洞） */
    seq.value = turn.conversationSequence + 1
    await gateway.compileTurn({
      turn,
      currentInput: text,
      recentLines: [],
      clockEpochMs: Date.now(),
      ...(opts.turnScope !== undefined ? { scope: opts.turnScope } : {}),
    } as never)
    return { ok: true, reason: 'compiled' }
  } catch (error) {
    return { ok: false, reason: `${(error as Error).name}: ${(error as Error).message}` }
  }
}

/**
 * ⚠️ 会话内序号必须**连续**（网关的硬闸："会话内序号出现空洞"）⇒ 三轮共用**同一个** seq，
 *    由 `compile()` 按 `turn.conversationSequence + 2` 往前走。
 */
const seq = { value: 1 }

// ===========================================================================
// T1 正控 · 传了 `scope` ⇒ 召回端口在 `query` 上看到它（整链）
// ===========================================================================
{
  seenScopes.length = 0
  const outcome = await compile(seq, '你好呀', { gatewayScope: SCOPE })
  record('T1.0', '真网关走完 `beginTurn → compileTurn`（零模型）', outcome.ok, outcome.reason)
  const last = seenScopes[seenScopes.length - 1]
  record(
    'T1.1',
    '`TurnGatewayOptions.scope` ⇒ 检索端口 `retrieve(query)` 的 `query.scope` 逐字到达',
    last !== undefined && JSON.stringify(last) === JSON.stringify(SCOPE),
    `calls=${seenScopes.length} · scope=${JSON.stringify(last)}`
  )
}

// ===========================================================================
// T2 负控 · 不传 `scope` ⇒ 端口看到 `undefined`（逐字不变的形状）
// ===========================================================================
{
  seenScopes.length = 0
  const outcome = await compile(seq, '你好呀')
  const last = seenScopes[seenScopes.length - 1]
  record('T2.0', '不传 `scope` 时整轮同样跑完（没有新失败）', outcome.ok, outcome.reason)
  record(
    'T2.1',
    '不传 ⇒ `query.scope` 是 `undefined`（**接线前逐字相同**，不是空对象、不是默认作用域）',
    seenScopes.length > 0 && seenScopes.every((item) => item === undefined),
    `calls=${seenScopes.length} · allUndefined=${String(seenScopes.every((item) => item === undefined))}`
  )
}

// ===========================================================================
// T3 拆防线 · "不传就当作原主人"必须与真实读数相反
// ===========================================================================
{
  seenScopes.length = 0
  await compile(seq, '你好呀')
  const weakened = (last: ScopeContext | undefined) =>
    last ?? {
      principal: { kind: 'owner', userId: 'u-owner', verifiedBy: 'config_binding' },
      purpose: 'external_query',
      room: { kind: 'private', userId: 'u-owner' },
    }
  const realLast = seenScopes[seenScopes.length - 1]
  record(
    'T3.1',
    '拆防线 · "不传 scope 就补一个原主人作用域"会**凭空造出**授权上下文，而真实读数是 `undefined`',
    realLast === undefined && weakened(realLast).principal.kind === 'owner',
    `real=${String(realLast)} · weakened.kind=${weakened(realLast).principal.kind}`
  )
}

// ===========================================================================
// T4 **每轮**作用域（群场景必需）：`compileTurn({ scope })` 优先于网关选项
// ===========================================================================
{
  // T4.1 网关**没有**选项作用域，只有本轮给 ⇒ 本轮那个生效
  seenScopes.length = 0
  const onlyTurn = await compile(seq, '你好呀', { turnScope: SCOPE })
  const lastOnlyTurn = seenScopes[seenScopes.length - 1]
  record(
    'T4.1',
    '网关选项**没有** scope、只有本轮给了 ⇒ 端口看到的是**本轮**那个（每轮身份因此可行）',
    onlyTurn.ok && lastOnlyTurn !== undefined && JSON.stringify(lastOnlyTurn) === JSON.stringify(SCOPE),
    `ok=${String(onlyTurn.ok)} · scope=${JSON.stringify(lastOnlyTurn)}`
  )

  // T4.2 两边都有且**不同** ⇒ 本轮那个赢（否则群里的第二个说话人会继承第一个的作用域）
  const PER_TURN = {
    principal: { kind: 'user', userId: 'u-per-turn', verifiedBy: 'onebot_inbound' },
    purpose: 'external_query',
    room: { kind: 'group', groupId: 'g-per-turn' },
  } satisfies ScopeContext
  seenScopes.length = 0
  const bothGiven = await compile(seq, '你好呀', { gatewayScope: SCOPE, turnScope: PER_TURN })
  const lastBoth = seenScopes[seenScopes.length - 1]
  record(
    'T4.2',
    '网关选项与本轮**都给了且不同** ⇒ **本轮赢**（群里的第二个说话人不会继承第一个的作用域）',
    bothGiven.ok && lastBoth !== undefined && JSON.stringify(lastBoth) === JSON.stringify(PER_TURN),
    `scope=${JSON.stringify(lastBoth)}`
  )
}

// ===========================================================================
// 汇总
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
const passed = failed.length === 0
console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} u1:gateway-scope:verify = ${passed ? 'PASS' : 'FAIL'}`)
console.log('  ⚠️ 本门只证"网关把 scope 传下去了"：`main.ts` 仍未设置该选项（生产行为未变）。')
if (!passed) {
  console.log('  失败项：')
  for (const c of failed) console.log(`    - ${c.id} ${c.label}：${c.detail}`)
}

cleanupSandbox(sandbox.dir)
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
