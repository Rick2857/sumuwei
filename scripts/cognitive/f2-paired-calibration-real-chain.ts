/**
 * **F2 零模型配对校准 · 真实产品链迁移**（固定规划器 · 隔离 PostgreSQL · **零真实模型请求**）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * ```text
 * 把"机制模型校准"（`f2-measurability-calibration.ts`，17 项）搬到**真实产品链**上跑一遍：
 *   ActionTurn → 装配层 F2 分支（准备读 / 族标记读 / 来源限定否决）→ 真实 Gateway
 *   → 真实文件 → 账本 → 原生 EBL（形成 / 消费）。
 *
 * 规模（单进程 · 一库 · 一根 · 一角色）：
 *   w1 = f1/a：A×2 序 + B×2 序（无受信声明 ⇒ 永远没有规则；A/B 的差别只在候选先验）
 *   w2 = f2/a：C × cache-first   （开发集 6 + 留出集 6）
 *   w3 = f3/a：C × authoritative-first（同上；⚠️ 该序下代理先选可靠策略 ⇒ 通常**不形成**规则）
 *   共 6 条序列 × 12 题 = 72 题。
 * ```
 *
 * ⚠️ 本门**不是**收益读数：候选正文/顺序来自夹具；零模型请求；token 只标估算。
 * ⚠️ 与冻结的 `protocol.json` 的两处**过期形态**（逐对象 `.fresh` 条件、S_authoritative 三动作、
 *    "写被拒即结束"）**不同**：本门按**修订后协议**跑（族级 `.freshness`、两策略均 1 读 + 1 写
 *    (+读回)、**保留失败后的恢复**）。⇒ 真实运行封存前必须先对齐 `protocol.json`（见记录）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runPreparedPgGate, runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'
import { isolateDatabase } from '../../src/dev/sandbox.ts'

if (process.env.LG_F2_CAL_CHILD !== '1') {
  process.env.LG_F2_CAL_CHILD = '1'
  const admin = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  if (admin) await runPreparedPgGateInInstance(admin, 'f2-paired-calibration', 'scripts/cognitive/f2-paired-calibration-real-chain.ts')
  else await runPreparedPgGate('f2-paired-calibration', 'scripts/cognitive/f2-paired-calibration-real-chain.ts')
  process.exit(0)
}
const sandbox = isolateDatabase('f2-paired-calibration', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

import { createM4Harness } from '../m4-harness.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import {
  contentFingerprint, createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries,
} from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import {
  createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS, SANDBOX_FILE_WRITE,
} from '../../src/kernel/action/capability-registry.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import type { TaskPlan, TaskPlannerInput, TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import {
  attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf,
} from '../../src/kernel/contracts/attribution.ts'
import { createEblTaskObserver } from '../../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader, EBL_TOOL_ENVIRONMENT } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { makeEblClaim } from '../../src/kernel/contracts/epistemic-belief.ts'
import { sandboxWriteFamilyScope } from '../../src/kernel/contracts/write-family.ts'
import { writePreconditionConditions } from '../../src/kernel/contracts/write-precondition.ts'
import { createSimulationPlanning } from '../../src/infrastructure/runtime/simulation-planning.ts'
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import type { SimulationPlanSelection } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import { createActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import { createActionIntentDetector } from '../../src/kernel/action/intent-detector.ts'
import { exec } from '../../src/infrastructure/persistence/db.ts'
import { sql } from 'drizzle-orm'
import { actionFailure, ActionFailureError } from '../../src/kernel/action/errors.ts'
import type { AdapterExecuteInput, AdapterOutcome, CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'

const output = resolve('artifacts/local/f2-paired-calibration', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
const root = resolve(output, 'files')
mkdirSync(root, { recursive: true })
const WORLDS = [
  { world: 'w1', family: 'f1/a', dev: ['fresh', 'stale', 'fresh', 'stale', 'fresh', 'stale'], holdout: ['stale', 'fresh', 'stale', 'fresh', 'stale', 'fresh'] },
  { world: 'w2', family: 'f2/a', dev: ['stale', 'fresh', 'stale', 'fresh', 'stale', 'fresh'], holdout: ['fresh', 'stale', 'fresh', 'stale', 'fresh', 'stale'] },
  { world: 'w3', family: 'f3/a', dev: ['fresh', 'fresh', 'stale', 'stale', 'fresh', 'stale'], holdout: ['stale', 'stale', 'fresh', 'fresh', 'stale', 'fresh'] },
] as const
type Order = 'cached-first' | 'authoritative-first'
type Arm = 'A' | 'B' | 'C'
const h = await createM4Harness({ label: 'f2-paired-calibration', userId: 'Alex' })
const checks: string[] = []
const diagnostics: Record<string, unknown> = {}
const check = (name: string, value: unknown, detail = ''): void => {
  assert.ok(value, `${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

try {
  const characterId = h.kernel.characterId
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const markerOf = (family: string) => `${family}/.freshness`
  const conditionPaths = WORLDS.map(world => markerOf(world.family))
  const guardedWrite: CapabilityAdapter = {
    capabilityId: SANDBOX_FILE_WRITE,
    async execute (input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const path = String(input.args.path)
      if (path.endsWith('.txt')) {
        const raw = typeof input.args.content === 'string' ? input.args.content : staging.read(String(input.args.payloadRef))
        const content = typeof raw === 'string' ? raw : raw?.kind === 'text' ? raw.text : undefined
        if (content !== readFileSync(resolve(root, path.replace(/\.txt$/, '.src')), 'utf8')) {
          throw new ActionFailureError(actionFailure('validation_failed', '内容与权威源不一致'))
        }
      }
      return createSandboxWriteAdapter({ root, staging, conditionPaths }).execute(input)
    },
  }
  const fsOptions = { root, staging, conditionPaths, exposeReadContent: true }
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fsOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger: createActionLedgerStore(h.db),
    adapters: [createSandboxReadAdapter(fsOptions), guardedWrite],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'f2-cal', executorAdapterId: 'sandbox-filesystem' } })
  const authorizations = createTaskAuthorizationRegistry()
  const knownDirectories = () => WORLDS.map(world => world.family)
  const writeSources = (path: string) => [
    { kind: 'cache' as const, path: path.replace(/\.txt$/, '.cache') },
    { kind: 'authoritative' as const, path: path.replace(/\.txt$/, '.src') },
  ]
  const declarations = WORLDS.filter(world => world.family !== 'f1/a')
    .map(world => ({ familyId: world.family, conditionPath: markerOf(world.family), mustNotEqual: 'stale' }))
  const observer = createEblTaskObserver(h.db, h.userId, { knownDirectories, writeSources, preconditions: declarations })
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
  const initiatorFor = (event: { id: string }) => attestActionInitiatorFromCausalOrigin({ adapterId: 'f2-cal',
    causalSource: correlationSourceFromConversationEvent({ adapterId: 'f2-cal',
      triggeringEvent: triggeringConversationEventOf(event as never) }) })

  const entryText = (family: string, name: string): string => {
    const stem = `${family}/${name}`
    return `F2 只操作相对路径 ${stem}.txt；缓存源 ${stem}.cache；权威源 ${stem}.src；族标记 ${family}/.freshness，最多读一次。`
  }
  /** 夹具：把某个对象的三个文件 + 族标记按条件摆好（**任务之间**设置，任务期间不变）。 */
  const prepare = (family: string, name: string, condition: 'fresh' | 'stale'): { target: string, auth: string, cached: string, marker: string } => {
    mkdirSync(resolve(root, family), { recursive: true })
    const target = `${family}/${name}.txt`
    const auth = `auth:${name}`
    const cached = condition === 'stale' ? `stale:${name}` : auth
    writeFileSync(resolve(root, target.replace(/\.txt$/, '.src')), auth)
    writeFileSync(resolve(root, target.replace(/\.txt$/, '.cache')), cached)
    writeFileSync(resolve(root, markerOf(family)), condition)
    /*
     * ⚠️ **预置一个占位目标**（不是删掉它）。原因：本门把三个族放在**同一个沙箱根**里，
     *    不同族的对象同名（`obj-01.txt`）。目标解析对"同名但在别的目录"给出 **weak**
     *    ⇒ 有副作用的写会被策略拒成 `target_uncertain`（实测：C 的 12 题全部卡在这里）。
     *    真实 F2 世界里每个世界一个根、目标一开始不存在 ⇒ 不会遇到这种跨族同名。
     *    ⇒ 夹具二选一：(a) 每族一个根（要多个 Gateway）；(b) 预置占位目标让"精确路径"成立。
     *    这里取 (b)，并**不改变真值判据**（占位内容 != 权威源 ⇒ 未真实写入就不算达成）。
     */
    writeFileSync(resolve(root, target), `unset:${name}`)
    return { target, auth, cached, marker: markerOf(family) }
  }
  const read = (path: string) => ({ capability: 'sandbox.file.read', operation: 'read', args: { path } })
  const write = (path: string, content: string) => ({ capability: 'sandbox.file.write', operation: 'write', args: { path, content } })
  type Step = TaskPlan['steps'][number]

  /** 一题一行（**claimed 与 observed 分开**：评分器要能识破注入）。 */
  interface TaskRow {
    sequence: string
    arm: Arm
    order: Order
    world: string
    family: string
    objectId: string
    phase: 'dev' | 'holdout'
    condition: 'fresh' | 'stale'
    claimedAchieved: boolean
    stopped: string
    observedFailures: number
    observedActions: number
    observedPlans: number
    modelRequests: number
    fileTruth: boolean
    vetoedIds: readonly string[]
    vetoReason?: string
    phaseNotes: readonly string[]
    codes: readonly string[]
  }
  const rows: TaskRow[] = []
  const sequencePlannerCalls: Record<string, number> = {}

  /** 每条序列一题：真实 ActionTurn（从**已签发授权会话键**进入）→ 真实任务环。 */
  const runTask = async (options: {
    sequence: string, arm: Arm, order: Order, world: string, family: string, name: string,
    phase: 'dev' | 'holdout', condition: 'fresh' | 'stale', ordinal: number
  }): Promise<TaskRow> => {
    const object = prepare(options.family, options.name, options.condition)
    const selections: SimulationPlanSelection[] = []
    let calls = 0
    let cachedRead = false
    let triedRecovery = false
    const plans: { cached: TaskPlan, authoritative: TaskPlan } = {
      cached: { goal: 'cached strategy', done: true, steps: [read(object.target.replace(/\.txt$/, '.cache')),
        write(object.target, object.cached), read(object.target)] },
      authoritative: { goal: 'authoritative strategy', done: true, steps: [read(object.target.replace(/\.txt$/, '.src')),
        write(object.target, object.auth), read(object.target)] },
    }
    const ordered: TaskPlan[] = options.order === 'cached-first' ? [plans.cached, plans.authoritative] : [plans.authoritative, plans.cached]
    const planner: TaskPlannerPort = { id: `f2-cal-${options.arm}`, endpointHost: 'offline', async plan (input: TaskPlannerInput) {
      calls += 1
      const writeFailed = input.failures.some(item => item === 'sandbox.file.write.write=validation_failed')
      // ① 先观察一族源字节（来源归属需要**本任务**的真实读回执）
      if (!cachedRead && !input.executed.some(line => line.includes(`${object.target.replace(/\.txt$/, '.cache')}=success`))) {
        return { ok: true, requestCount: 1, plan: { goal: 'observe cache bytes', done: false,
          steps: [read(object.target.replace(/\.txt$/, '.cache'))] } }
      }
      cachedRead = true
      // ② 有失败 ⇒ **保留恢复能力**：换另一条策略（评测侧有界收尾：两条都失败才停）
      if (writeFailed && triedRecovery) return { ok: false as const, requestCount: 1, failure: 'call_failed' as const }
      if (writeFailed) {
        triedRecovery = true
        const other = ordered[1]!
        return { ok: true, requestCount: 1, plan: other, ...(options.arm === 'B' ? {} : { candidates: [other] }) }
      }
      const first = options.arm === 'B' ? plans.authoritative : ordered[0]!
      const candidateList = options.arm === 'B' ? [plans.authoritative] : ordered
      return { ok: true, requestCount: 1, plan: first, candidates: candidateList }
    } }
    const evidence = await h.recordUserEvidence(`F2 校准 ${options.sequence} #${String(options.ordinal)}`)
    const conversationKey = String(evidence.event.conversationId)
    const traceId = `f2cal-${options.sequence}-${String(options.ordinal)}`
    authorizations.issue({ conversationKey, originalText: entryText(options.family, options.name),
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'],
      maxRiskLevel: 'R1', budget: { maxActions: 12, maxPlans: 6, deadlineMs: 600_000 } })
    const turn = createActionTurnPort({ gateway, detector: createActionIntentDetector(), registry,
      attribution: { adapterId: 'f2-cal' },
      task: {
        authorizations, staging, resolveTarget, epistemic: observer,
        capabilitiesFor: () => ['sandbox.file.read', 'sandbox.file.write'],
        riskLevelFor: () => 'R1' as const,
        planner,
        replanContext: { knownDirectories, contentTokens: 4000 },
        configurePlanning: (text, fallback) => createSimulationPlanning({
          db: h.db, characterId, activeUserId: h.userId, registry, facts: { encoding: 'utf8' },
          modelVersion: 'f2-paired-calibration@1', candidatePlanner: planner,
          precondition: { enabled: true, knownDirectories, declarations, writeSources },
          onSelection: value => selections.push(value),
          f2: { enabled: true },
        })(text, fallback),
      } })
    const result = await turn.handleTurn({ characterId, traceId: asTraceId(traceId), text: entryText(options.family, options.name),
      eventId: String(evidence.event.id), conversationKey, speaker: { kind: 'user', id: String(h.userId) },
      triggeringEvent: triggeringConversationEventOf(evidence.event) })
    sequencePlannerCalls[options.sequence] = (sequencePlannerCalls[options.sequence] ?? 0) + calls
    const failures = Number((await exec(h.db, sql`select count(distinct action_id)::int as count from character_action_events
      where character_id = ${String(characterId)} and trace_id = ${traceId}
        and capability = 'sandbox.file.write' and event_type = 'ACTION_FAILED'`, 'f2cal failures'))[0]?.count ?? 0)
    const veto = selections.map(item => item.f2).find(item => item?.phase === 'candidates_evaluated')
    /** 每步的闭集结果码（含被拒/丢弃的具名原因；排障用）。 */
    const codes = [result.result, ...(result.followUps ?? []).map(item => item.result)]
      .map(item => item?.error === undefined ? '' : `${String(item.error.code)}:${String((item.error as { message?: string }).message ?? '')}`)
      .filter(code => code !== '')
    let fileTruth = false
    try { fileTruth = readFileSync(resolve(root, object.target), 'utf8') === object.auth } catch { fileTruth = false }
    return {
      sequence: options.sequence, arm: options.arm, order: options.order, world: options.world, family: options.family,
      objectId: options.name, phase: options.phase, condition: options.condition,
      claimedAchieved: result.task?.goal?.achieved === true, stopped: String(result.task?.stopped ?? 'none'),
      observedFailures: failures, observedActions: Number(result.task?.actionsUsed ?? 0), observedPlans: Number(result.task?.plansUsed ?? 0),
      modelRequests: calls, fileTruth, vetoedIds: veto?.vetoedCandidateIds ?? [],
      ...(veto?.veto?.reason === undefined ? {} : { vetoReason: veto.veto.reason }),
      phaseNotes: selections.map(item => `${item.reason}/${String(item.f2?.phase ?? 'none')}`),
      codes,
    }
  }

  // -------------------------------------------------------------------------
  // ① 六条序列（A/B 无声明族 ⇒ 永远没有规则；C 在两个有声明族上各一序）
  // -------------------------------------------------------------------------
  const sequences: { sequence: string, arm: Arm, order: Order, world: string, family: string }[] = [
    { sequence: 'A-cf', arm: 'A', order: 'cached-first', world: 'w1', family: 'f1/a' },
    { sequence: 'A-af', arm: 'A', order: 'authoritative-first', world: 'w1', family: 'f1/a' },
    { sequence: 'B-cf', arm: 'B', order: 'cached-first', world: 'w1', family: 'f1/a' },
    { sequence: 'B-af', arm: 'B', order: 'authoritative-first', world: 'w1', family: 'f1/a' },
    { sequence: 'C-cf', arm: 'C', order: 'cached-first', world: 'w2', family: 'f2/a' },
    { sequence: 'C-af', arm: 'C', order: 'authoritative-first', world: 'w3', family: 'f3/a' },
  ]
  for (const sequence of sequences) {
    const world = WORLDS.find(item => item.world === sequence.world)!
    for (const [phase, count] of [['dev', 6], ['holdout', 6]] as const) {
      for (let index = 0; index < count; index += 1) {
        const condition = (phase === 'dev' ? world.dev : world.holdout)[index]!
        const name = `obj-${String(index + 1 + (phase === 'holdout' ? 6 : 0)).padStart(2, '0')}`
        rows.push(await runTask({ ...sequence, name, phase, condition,
          ordinal: index + (phase === 'holdout' ? 6 : 0) }))
      }
    }
    console.log(`… 序列 ${sequence.sequence} 完成（${String(rows.filter(row => row.sequence === sequence.sequence).length)} 题）`)
  }
  const of = (sequence: string) => rows.filter(row => row.sequence === sequence)
  /** 排障读数：两个声明族的**当前命题状态**与"标记读被安排"的次数。 */
  const claimProbe = async (family: string, scope?: 'cache' | 'authoritative') => {
    const declaration = { familyId: family, conditionPath: markerOf(family), mustNotEqual: 'stale' }
    const claimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool',
      predicate: 'write_precondition_holds', expected: true, scope: sandboxWriteFamilyScope(family),
      environment: EBL_TOOL_ENVIRONMENT,
      conditions: writePreconditionConditions(declaration, scope), formation: { kind: 'action', id: 'shape' } }).id
    const state = await store.get(claimId)
    const snapshot = await createEblRuleSnapshotPort(h.db, characterId, h.userId, { writeSources }).current(claimId)
    return { claimId, storedStatus: state?.status, snapshotStatus: snapshot?.status, usable: snapshot?.usable }
  }
  diagnostics.claims = {
    'f2/a:cache': await claimProbe('f2/a', 'cache'),
    'f2/a:unscoped': await claimProbe('f2/a'),
    'f3/a:cache': await claimProbe('f3/a', 'cache'),
    'f1/a:unscoped': await claimProbe('f1/a'),
  }
  diagnostics.markerScheduled = Object.fromEntries(sequences.map(sequence => [sequence.sequence,
    of(sequence.sequence).filter(row => row.phaseNotes.some(note => note.includes('marker_read_scheduled'))).length]))
  const holdout = (sequence: string) => of(sequence).filter(row => row.phase === 'holdout')

  // -------------------------------------------------------------------------
  // ② 评分器（**claimed 与 observed 分开**；注入必须被识破）
  // -------------------------------------------------------------------------
  const scorer = (input: readonly TaskRow[]) => {
    const falseCompletion = input.filter(row => row.claimedAchieved && !row.fileTruth).length
    const missedFailure = input.filter(row => row.observedFailures > 0 && row.claimedAchieved && !row.fileTruth).length
    const achievementMismatch = input.filter(row => row.claimedAchieved !== row.fileTruth).length
    return {
      tasks: input.length,
      achieved: input.filter(row => row.fileTruth).length,
      falseCompletion,
      missedFailure,
      achievementMismatch,
      failedActions: input.reduce((sum, row) => sum + row.observedFailures, 0),
      actions: input.reduce((sum, row) => sum + row.observedActions, 0),
      plans: input.reduce((sum, row) => sum + row.observedPlans, 0),
      modelRequests: input.reduce((sum, row) => sum + row.modelRequests, 0),
    }
  }
  const table = Object.fromEntries(sequences.map(sequence => [sequence.sequence, {
    all: scorer(of(sequence.sequence)),
    holdout: scorer(holdout(sequence.sequence)),
  }]))
  diagnostics.table = table
  diagnostics.rows = rows

  // ③ 判据 1：**每个臂都有可行完成路径**（留出集全达成，不是 C 专属）
  for (const sequence of sequences) {
    const scored = table[sequence.sequence]!.holdout
    check(`${sequence.sequence}：留出集**逐题达成**（真实写入 + 终读回 == 权威源）`,
      scored.achieved === scored.tasks, `${String(scored.achieved)}/${String(scored.tasks)}`)
  }
  // ④ 判据 2：**两策略确有差异、顺序不决定真值**（同一对象两种顺序的真值判定相同）
  const byObject = (sequence: string) => new Map(of(sequence).map(row => [`${row.objectId}`, row.fileTruth]))
  for (const arm of ['A'] as const) {
    const cf = byObject(`${arm}-cf`)
    const af = byObject(`${arm}-af`)
    check(`${arm}：两种候选顺序下**同一对象的真值判定相同**（顺序不改变可达性）`,
      [...cf.keys()].every(key => cf.get(key) === af.get(key)))
  }
  check('A：cache-first 的失败写**确实多于** authoritative-first（策略确有不同的执行后果）',
    table['A-cf']!.holdout.failedActions > table['A-af']!.holdout.failedActions,
    `${String(table['A-cf']!.holdout.failedActions)} > ${String(table['A-af']!.holdout.failedActions)}`)
  check('B：恒定可靠策略 ⇒ 两种顺序下**零失败写**（强基线）',
    table['B-cf']!.holdout.failedActions === 0 && table['B-af']!.holdout.failedActions === 0)

  // ⑤ 判据 3：合格规则**改变选择并影响真实执行** —— 本轮在真实链上**未达成**，如实记阻塞点
  const claims = diagnostics.claims as Record<string, { storedStatus?: string, usable?: boolean }>
  const cStale = holdout('C-cf').filter(row => row.condition === 'stale')
  check('C-cf：**规则在真实链上停在 pending**（未取得资格）⇒ 判据 3 的前提不成立',
    claims['f2/a:cache']?.storedStatus === 'pending' && claims['f2/a:cache']?.usable === false,
    String(claims['f2/a:cache']?.storedStatus))
  check('C-cf：因此留出集 stale 任务**没有否决**（如实记；不把"没有规则"说成"规则没起作用"）',
    cStale.length > 0 && cStale.every(row => row.vetoedIds.length === 0), JSON.stringify(cStale.map(row => row.vetoedIds)))
  check('C-cf：没有否决时行为与 A 相同（stale 上失败一次、换策略后达成）',
    cStale.every(row => row.observedFailures === 1 && row.fileTruth === true && row.stopped === 'done'))
  check('A 在同族同条件下**有失败写**（对照：差异来自规则，不来自任务难度）',
    holdout('A-cf').filter(row => row.condition === 'stale').every(row => row.observedFailures === 1))
  check('C-af（authoritative-first）：先选可靠策略 ⇒ **不形成**规则、表现同强基线',
    of('C-af').every(row => row.vetoedIds.length === 0) && table['C-af']!.holdout.failedActions === 0,
    JSON.stringify(of('C-af').map(row => row.vetoReason ?? 'none')))
  /*
   * ⚠️ **判据 3 未达成的根因（证据在 claims 里）**：
   *    来源限定（`source_scope=cache`）命题要取得资格，需要一次**成功的、来源归属为 cache 的写**作对照。
   *    但 F2 任务**每题都读权威源**（用户裁定 A 的受信准备读）⇒ fresh 对象上 cache 与 auth 内容相同
   *    ⇒ 归属按 R2 契约判 `unknown` ⇒ 不能当 cache 作用域的对照；stale 对象上 cache 写**必被守卫拒**
   *    ⇒ 也当不了对照。**⇒ 在"每题读权威源"的 F2 任务里，cache 作用域的对照不可达。**
   */
  const blockers = [{
    id: 'f2-real-chain-source-scoped-control-unreachable',
    criterion: 'F2 协议 §6 判据 3（合格规则改变选择并影响真实执行）',
    status: 'NOT_MET',
    evidence: {
      claim: claims['f2/a:cache'] ?? null,
      markerReadsPerTask: diagnostics.markerScheduled,
      freshAttribution: 'cache 与 auth 内容相同 ⇒ R2 契约判 unknown（不能当对照）',
      staleAttribution: 'cache 内容 != auth ⇒ 归属 cache，但写被内容真值守卫拒（失败不能当对照）',
    },
    options: [
      'A（待裁定）：形成阶段用**普通 S_cached 形状任务**（只读缓存、不读权威源）取得 cache 作用域对照；测量阶段仍走 F2 入口（每题读权威源）',
      'B（不建议）：放宽 C2 让"内容同源不可分"的写充当 cache 对照 ⇒ 削弱 R2 的"归属不明"不变量',
      'C（不可行）：只用不限来源（族级）规则 ⇒ 会把权威候选一起否决，破坏"可靠路径恒可达"',
    ],
  }]

  // ⑥ 判据 4：**撤回 / 条件未知 / 错误族 ⇒ 不错误消费**（真实链，C-cf 的族上）
  const scoreRow = async (options: { name: string, condition: 'fresh' | 'stale', markerMissing?: boolean, withdraw?: boolean }):
  Promise<TaskRow> => {
    const family = 'f2/a'
    const object = prepare(family, options.name, options.condition)
    if (options.markerMissing === true) rmSync(resolve(root, markerOf(family)), { force: true })
    const claimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool',
      predicate: 'write_precondition_holds', expected: true, scope: sandboxWriteFamilyScope(family),
      environment: EBL_TOOL_ENVIRONMENT,
      conditions: writePreconditionConditions({ familyId: family, conditionPath: markerOf(family), mustNotEqual: 'stale' }, 'cache'),
      formation: { kind: 'action', id: 'shape' } }).id
    if (options.withdraw === true) await store.commit(claimId, { kind: 'withdraw' })
    const selections: SimulationPlanSelection[] = []
    let cachedRead = false
    const authority = (path: string) => path.replace(/\.txt$/, '.src')
    const planner: TaskPlannerPort = { id: 'f2-cal-negative', endpointHost: 'offline', async plan (input: TaskPlannerInput) {
      const writeFailed = input.failures.some(item => item === 'sandbox.file.write.write=validation_failed')
      if (!cachedRead && !input.executed.some(line => line.includes(`${object.target.replace(/\.txt$/, '.cache')}=success`))) {
        return { ok: true, requestCount: 1, plan: { goal: 'observe', done: false, steps: [read(object.target.replace(/\.txt$/, '.cache'))] } }
      }
      cachedRead = true
      const cachedPlan: TaskPlan = { goal: 'cached', done: true, steps: [read(object.target.replace(/\.txt$/, '.cache')), write(object.target, object.cached), read(object.target)] }
      const authPlan: TaskPlan = { goal: 'authoritative', done: true, steps: [read(authority(object.target)), write(object.target, object.auth), read(object.target)] }
      if (writeFailed) return { ok: true, requestCount: 1, plan: authPlan, candidates: [authPlan] }
      return { ok: true, requestCount: 1, plan: cachedPlan, candidates: [cachedPlan, authPlan] }
    } }
    const evidence = await h.recordUserEvidence(`F2 校准负控 ${options.name}`)
    const conversationKey = String(evidence.event.conversationId)
    const traceId = `f2cal-negative-${options.name}`
    authorizations.issue({ conversationKey, originalText: entryText(family, options.name), triggeringEventId: String(evidence.event.id),
      allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'], maxRiskLevel: 'R1',
      budget: { maxActions: 12, maxPlans: 6, deadlineMs: 600_000 } })
    const turn = createActionTurnPort({ gateway, detector: createActionIntentDetector(), registry, attribution: { adapterId: 'f2-cal' },
      task: {
        authorizations, staging, resolveTarget, epistemic: observer,
        capabilitiesFor: () => ['sandbox.file.read', 'sandbox.file.write'], riskLevelFor: () => 'R1' as const,
        planner, replanContext: { knownDirectories, contentTokens: 4000 },
        configurePlanning: (text, fallback) => createSimulationPlanning({ db: h.db, characterId, activeUserId: h.userId,
          registry, facts: { encoding: 'utf8' }, modelVersion: 'f2-paired-calibration@1', candidatePlanner: planner,
          precondition: { enabled: true, knownDirectories, declarations, writeSources },
          onSelection: value => selections.push(value), f2: { enabled: true } })(text, fallback),
      } })
    const result = await turn.handleTurn({ characterId, traceId: asTraceId(traceId), text: entryText(family, options.name),
      eventId: String(evidence.event.id), conversationKey, speaker: { kind: 'user', id: String(h.userId) },
      triggeringEvent: triggeringConversationEventOf(evidence.event) })
    const failures = Number((await exec(h.db, sql`select count(distinct action_id)::int as count from character_action_events
      where character_id = ${String(characterId)} and trace_id = ${traceId}
        and capability = 'sandbox.file.write' and event_type = 'ACTION_FAILED'`, 'f2cal neg failures'))[0]?.count ?? 0)
    const veto = selections.map(item => item.f2).find(item => item?.phase === 'candidates_evaluated')
    let fileTruth = false
    try { fileTruth = readFileSync(resolve(root, object.target), 'utf8') === object.auth } catch { fileTruth = false }
    return { sequence: `neg-${options.name}`, arm: 'C', order: 'cached-first', world: 'w2', family, objectId: options.name,
      phase: 'holdout', condition: options.condition, claimedAchieved: result.task?.goal?.achieved === true,
      stopped: String(result.task?.stopped ?? 'none'), observedFailures: failures,
      observedActions: Number(result.task?.actionsUsed ?? 0), observedPlans: Number(result.task?.plansUsed ?? 0),
      modelRequests: 0, fileTruth, vetoedIds: veto?.vetoedCandidateIds ?? [],
      ...(veto?.veto?.reason === undefined ? {} : { vetoReason: veto.veto.reason }),
      phaseNotes: selections.map(item => `${item.reason}/${String(item.f2?.phase ?? 'none')}`), codes: [] }
  }
  const unknownCondition = await scoreRow({ name: 'obj-13', condition: 'stale', markerMissing: true })
  check('条件**未知**（族标记读失败）⇒ **不消费**（不否决），但真实失败后仍能恢复达成',
    unknownCondition.vetoedIds.length === 0
    && unknownCondition.observedFailures === 1 && unknownCondition.fileTruth === true,
    `${String(unknownCondition.vetoReason)}/${String(unknownCondition.observedFailures)}/${String(unknownCondition.fileTruth)}`)
  const withdrawn = await scoreRow({ name: 'obj-14', condition: 'stale', withdraw: true })
  check('规则**撤回** ⇒ **不消费**（不否决），行为回到 A（失败一次后恢复达成）',
    withdrawn.vetoedIds.length === 0 && withdrawn.observedFailures === 1 && withdrawn.fileTruth === true,
    `${String(withdrawn.vetoReason)}/${String(withdrawn.observedFailures)}`)
  check('**错误族**（f1/a 无受信声明）⇒ 全序列**没有否决读数**（不误伤）',
    [...of('A-cf'), ...of('A-af'), ...of('B-cf'), ...of('B-af')].every(row => row.vetoedIds.length === 0))

  // ⑦ 判据 5：**评分器识别人为注入**（假优势 / 漏记失败）
  const injectedFake = [...holdout('C-cf')].map(row => ({ ...row }))
  injectedFake[0] = { ...injectedFake[0]!, claimedAchieved: true, fileTruth: false }
  const fakeScore = scorer(injectedFake)
  check('评分器：把**未达成**记成达成 ⇒ 被识破（falseCompletion ≥ 1）', fakeScore.falseCompletion >= 1)
  const missedRows = [...holdout('C-cf')].map(row => ({ ...row }))
  missedRows[0] = { ...missedRows[0]!, observedFailures: 0, claimedAchieved: true, fileTruth: false }
  const missedScore = scorer(missedRows)
  check('评分器：**漏记失败**且谎报达成 ⇒ 被识破（achievementMismatch ≥ 1）', missedScore.achievementMismatch >= 1)
  check('评分器：真实读数里**假完成 = 0** 且 claimed==fileTruth',
    rows.every(row => row.claimedAchieved === row.fileTruth),
    JSON.stringify(rows.filter(row => row.claimedAchieved !== row.fileTruth).slice(0, 3)))

  // ⑧ 冷启动与配对差（只作**机制计数**，不是真实成本）
  diagnostics.coldStart = { modelRequests: of('C-cf').filter(row => row.vetoedIds.length === 0).reduce((sum, row) => sum + row.modelRequests, 0),
    note: '首次消费之前的候选调用数（机制计数；token 未计）' }
  diagnostics.paired = {
    'cached-first': { A: table['A-cf']!.holdout, C: table['C-cf']!.holdout,
      delta: { failedActions: table['C-cf']!.holdout.failedActions - table['A-cf']!.holdout.failedActions,
        modelRequests: table['C-cf']!.holdout.modelRequests - table['A-cf']!.holdout.modelRequests,
        achieved: table['C-cf']!.holdout.achieved - table['A-cf']!.holdout.achieved } },
    'authoritative-first': { A: table['A-af']!.holdout, C: table['C-af']!.holdout,
      delta: { failedActions: table['C-af']!.holdout.failedActions - table['A-af']!.holdout.failedActions,
        modelRequests: table['C-af']!.holdout.modelRequests - table['A-af']!.holdout.modelRequests,
        achieved: table['C-af']!.holdout.achieved - table['A-af']!.holdout.achieved } },
    note: '单世界、固定候选规划器、零模型 ⇒ 只作机制迁移计数；达成率是共同上限，不作收益主张',
  }

  writeFileSync(resolve(output, 'calibration.json'), JSON.stringify({
    /* ⚠️ **不是 PASS**：判据 3 在真实链上未达成 ⇒ 状态是"诊断完成 / 目标受阻"。 */
    status: 'BLOCKED_ON_DESIGN', schema: 'f2-paired-calibration-real-chain@1',
    measuredAt: new Date().toISOString(), checks,
    criteriaMet: [
      '判据 1：三臂在留出集上都能达成（可达性不是 C 专属）',
      '判据 2：两条策略执行后果不同；同一对象的真值判定不随候选顺序改变',
      '判据 4：撤回 / 条件未知 / 错误族都**不误伤**（没有否决）',
      '判据 5：评分器识破"假达成"与"漏记失败"；真实读数里假完成 = 0',
      '真实链装配：每题族标记读（12/12）、正文进规划上下文、来源限定否决面接在装配层',
    ],
    blockers, diagnostics, boundary: [
      '固定候选规划器 + 夹具正文/顺序 ⇒ 只证明机制，不构成收益读数；零真实模型请求',
      '单世界三族（f1/a 无声明、f2/a 与 f3/a 各一序）；C 的同世界同规则两序配对差只能由机制模型给出',
      'protocol.json 的逐对象 .fresh / 三动作 authoritative / "写被拒即结束"是修订前形态；本门按修订后协议跑，冻结前须对齐',
      '评测侧有界收尾：两条策略都失败才停（用既有失败码收尾；产品尚无该机制）',
      '夹具预置占位目标：本门把三族放在同一沙箱根，跨族同名会被目标解析判成 weak ⇒ 真实世界每世界一根，不会遇到',
    ], note: '逐题行在 diagnostics.rows（失败时另写 verification.json）' }, null, 2))
  console.log(`F2 配对校准（真实链）：${String(checks.length)} 项诊断检查全过，但**目标受阻**（判据 3 未达成）；${output}`)
  console.log(`BLOCKER：${blockers[0]!.id} —— 来源限定对照在"每题读权威源"的 F2 任务里不可达（见 calibration.json）`)

} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', checks, diagnostics,
    error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally { await h.stop() }
