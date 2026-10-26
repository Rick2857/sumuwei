/**
 * **F1 预注册负控门（G3–G7）**（隔离 PostgreSQL · 真实 Gateway · 真实文件 · **零模型请求**）。
 *
 * 它是 [F1 预注册草案](../docs/architecture/Cognitive-Capability-F1-Preregistration-2026-10-24.md) §8
 * 那张表里 **G3–G7** 五行的**逐项证据**（G2 已由就绪记录关闭；G1/G8/G9 不在本门范围）。
 *
 * ============================================================================
 *  它测的是什么（**逐字对应预注册 §8**）
 * ============================================================================
 * ```text
 * G3 标记不存在、非法机器码、失败读取、计划重入只尝试一次；旧 trace 不充当前条件
 * G4 读后取消/替代、deadline、行动或规划不足、规则在观察后撤回/换版不执行后继写
 * G5 C2 形成后对照、同对象/同根重复不增资格、同读不多用、观察影响的来源排除、原生钩子零异常
 * G6 oracle 不进入模型上下文/可读文件；任务正文不含真值；三臂都无标记写权限
 * G7 同池顺序置换、异族 locked 不串用、全否决不假完成；全部候选失败也不删题
 * ```
 *
 * ============================================================================
 *  三条不许破的边界
 * ============================================================================
 * ```text
 * ① **每一条控制都从真实 ActionTurn 进去**（`createActionTurnPort().handleTurn`）
 *    ⇒ 入口解析 · 任务授权 · 任务环 · Gateway · 账本 · EBL 全是产品自己的那一份；
 *    **不**手工调用内层规划器冒充入口（ADR-151 R1 §7.1 的纪律）。
 * ② **零模型请求**：计划器是**离线夹具**（`endpointHost: 'offline'`，id 后缀 `@fixture`），
 *    它只提供候选，**不**产生任何 token / 请求；G6 另有一条断言核对"夹具没把真值带进去"。
 * ③ **产品一字未改**：本门只加脚本；场景侧的守卫（locked ⇒ 写被 validation_failed 拒绝）
 *    是**受信执行器**注入的仿真条件（与 oracle.json 的 `guardEnforcedFamilies` 一致），
 *    **不**代表普通生产文件系统有这项限制。
 * ```
 *
 * ⚠️ 条件标记的**真值**只由受信执行器在任务开始前设置（oracle.json），
 *    代理**读得到路径、读不到值之外的东西**；条件值只以**受信回执**（`sandbox-condition@1:`）
 *    的形式出现在**本任务**的账本里。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { isolateDatabase } from '../../src/dev/sandbox.ts'
const cases = ['readback-withdrawal', 'family-withdrawal', 'marker-ownership', 'readback-evidence-change']
if (process.argv.includes('--list-cases')) { console.log(cases.map(id => `${id}\t1`).join('\n')); process.exit(0) }
const selectedCase = process.argv[process.argv.indexOf('--case') + 1]
assert.ok(cases.includes(selectedCase), 'must_select_isolated_control_case')
assert.ok(process.platform === 'linux' && existsSync('/opt/serversim/supervisor.mjs'), 'serversim_required')
assert.equal(new URL(process.env.LG_TEST_PG_URL ?? '').hostname, 'pgtest')
const sandbox = isolateDatabase('f1-prereg-negative-controls', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

import { createM4Harness } from '../m4-harness.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import {
  createEblSourceReader, EBL_TOOL_ENVIRONMENT, eblWritePreconditionRef, readTrustedConditionInTrace,
} from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { readReflectionSourceSnapshot } from '../../src/infrastructure/persistence/reflection-source-read.ts'
import { createEblTaskObserver } from '../../src/infrastructure/runtime/epistemic-belief-runtime.ts'
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import { EBL_EVENT, makeEblClaim } from '../../src/kernel/contracts/epistemic-belief.ts'
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
import type { ActionRequest } from '../../src/kernel/action/action-request.ts'
import type { ActionResult } from '../../src/kernel/action/action-result.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import type { TaskBudget, TaskAuthorizationPort } from '../../src/kernel/action/task-authorization.ts'
import type { EblTaskObserver, TaskRunOutcome } from '../../src/kernel/action/task-loop.ts'
import type { TaskPlan, TaskPlanStep, TaskPlannerInput, TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import { familyOfWriteTarget, sandboxWriteFamilyScope } from '../../src/kernel/contracts/write-family.ts'
import {
  CONDITION_VALUE_PATTERN, SANDBOX_CONDITION_RECEIPT_PREFIX,
  type WritePreconditionDeclaration,
} from '../../src/kernel/contracts/write-precondition.ts'
import { actionFailure, ActionFailureError } from '../../src/kernel/action/errors.ts'
import type { AdapterExecuteInput, AdapterOutcome, CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'
import { createSimulationPlanning } from '../../src/infrastructure/runtime/simulation-planning.ts'
import { evaluatePreconditionVeto } from '../../src/infrastructure/runtime/precondition-veto.ts'
import type { SimulationPlanSelection } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import { createActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import { createActionIntentDetector } from '../../src/kernel/action/intent-detector.ts'
import { exec } from '../../src/infrastructure/persistence/db.ts'
import { domainEventsFor } from '../../src/infrastructure/persistence/event-store.ts'

// ---------------------------------------------------------------------------
// 检查器（与 R1 门同形：`PASS <name>`）
// ---------------------------------------------------------------------------
const checks: string[] = []
const groups: Record<string, string[]> = { G3: [], G4: [], G5: [], G6: [], G7: [] }
function check(group: 'G3' | 'G4' | 'G5' | 'G6' | 'G7', name: string, pass: unknown, detail = '') {
  const label = `${group} ${name}`
  assert.ok(pass, `${label}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(label)
  groups[group].push(label)
  console.log(`PASS ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------------------
// 0. 预注册数据（**唯一**的世界 / 任务 / 真值来源）
// ---------------------------------------------------------------------------
const dataRoot = resolve('docs/architecture/f1-preregistration-20261024')
const loadPrereg = (name: string): unknown => JSON.parse(readFileSync(resolve(dataRoot, name), 'utf8'))
const worldsDoc = loadPrereg('worlds.json') as {
  worlds: { worldId: string; knownDirectories: string[]; declarations: WritePreconditionDeclaration[] }[]
}
const tasksDoc = loadPrereg('tasks.json') as {
  uniqueTasks: number
  armExecutions: number
  tasks: { taskId: string; worldId: string; ordinal: number; phase: string; targetPath: string; conditionPath: string; content: string; requestText: string }[]
}
const oracleDoc = loadPrereg('oracle.json') as {
  visibility: string
  perWorld: {
    worldId: string
    guardEnforcedFamilies: string[]
    guardNotEnforcedFamilies: string[]
    failureCode: string
    schedule: {
      taskId: string
      markerValue: string
      guardApplied: boolean
      expectedDirectWrite: string
      expectedFailureCode: string | null
    }[]
  }[]
}
const WORLD_ID = 'w01'
const world = worldsDoc.worlds.find(item => item.worldId === WORLD_ID)!
const preregTasks = tasksDoc.tasks.filter(item => item.worldId === WORLD_ID)
const oracle = oracleDoc.perWorld.find(item => item.worldId === WORLD_ID)!
const FAMILY_A = 'f1/a'
const FAMILY_B = 'f1/b'
const MARKER = world.declarations[0]!.conditionPath
const LOCKED = world.declarations[0]!.mustNotEqual
const READY = 'ready'
/**
 * 本门**自己**的一条夹具正文（"一次读 + 两次写"）。
 *
 * ⚠️ 它**不在**预注册的八题里（预注册每题只有一个目标）⇒ G6 的"正文逐字"断言
 *    把它单列成**唯一**的例外（封闭集，不许再有第三种正文）。
 */
const MULTI_WRITE_TEXT = '请帮我把 f1/a/multi1.txt 与 f1/a/multi2.txt 都写好'
/**
 * **形成来源探针**的专用条件路径（同一族、**另一个条件形状** ⇒ 另一个命题 id）。
 *
 * ⚠️ 为什么需要它：G5 要求"**没有对照就不许有资格**"，
 *    而 w01 的日程里**对照（ready）出现在第二次证据之前** ⇒ 主命题永远看不到"没有对照"的状态。
 *    ⇒ 用**另一个条件路径**开一条**独立**的探针命题（同一族、另一条件 ⇒ 身份不同），
 *    它**不污染**主命题（主命题的证据/对照计数一个都不动）。
 */
const PROBE_MARKER = 'f1-probe-guard.txt'
const PROBE_DECLARATION: WritePreconditionDeclaration = { familyId: FAMILY_A, conditionPath: PROBE_MARKER, mustNotEqual: LOCKED }

const output = resolve('artifacts/local/f1-prereg-negative-controls', `${selectedCase}-${Date.now()}`)
mkdirSync(output, { recursive: true })
const fsRoot = mkdtempSync(resolve(output, 'files-'))
mkdirSync(resolve(fsRoot, FAMILY_A), { recursive: true })
mkdirSync(resolve(fsRoot, FAMILY_B), { recursive: true })

const h = await createM4Harness({ label: 'f1-prereg-negative-controls', userId: 'Alex' })
try {
  const characterId = h.kernel.characterId
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const markerPaths = [MARKER, PROBE_MARKER]
  const fsOptions = { root: fsRoot, staging, conditionPaths: markerPaths }
  const knownDirectories = (): readonly string[] => world.knownDirectories
  const declarations = world.declarations

  // -------------------------------------------------------------------------
  // 受信场景执行器：条件标记**只**由它写；守卫**只**由它注入。
  // -------------------------------------------------------------------------
  const readMarker = (path: string): string | undefined => {
    const absolute = resolve(fsRoot, path)
    if (!existsSync(absolute)) return undefined
    return readFileSync(absolute, 'utf8').trim()
  }
  /** 守卫模式：`locked`（按 oracle 拒绝写）· `open`（不拦）· `execution_failed`（注入一个**非证据**失败码）。 */
  let guardMode: 'locked' | 'open' | 'execution_failed' = 'locked'
  let guardEnabled = false
  let guardMarker = MARKER
  const baseWrite = createSandboxWriteAdapter({ root: fsRoot, staging, conditionPaths: markerPaths })
  const guardedWrite: CapabilityAdapter = {
    capabilityId: SANDBOX_FILE_WRITE,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const path = typeof input.args.path === 'string' ? input.args.path : ''
      const family = familyOfWriteTarget({ path, knownDirectories: world.knownDirectories })
      if (guardEnabled && family !== undefined && oracle.guardEnforcedFamilies.includes(family)) {
        if (guardMode === 'execution_failed') {
          // ⚠️ 一个**闭集之外**的失败（不是证据码）⇒ 不得被当成前置条件证据。
          throw new Error('场景守卫：注入的非证据失败')
        }
        if (guardMode === 'locked' && readMarker(guardMarker) === LOCKED) {
          throw new ActionFailureError(actionFailure('validation_failed', '场景守卫拒绝写入：前置条件被违反'))
        }
      }
      return baseWrite.execute(input)
    },
  }
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({
      targetType: 'sandbox_file',
      hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fsOptions),
      allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect),
    })
  const gateway = createActionGateway({
    registry, ledger: createActionLedgerStore(h.db),
    adapters: [createSandboxReadAdapter(fsOptions), guardedWrite],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'f1-prereg-negctl', executorAdapterId: 'sandbox-filesystem' },
  })

  // -------------------------------------------------------------------------
  // EBL：原生观察者（异常**记录**、不吞）+ 存储 + 规则快照
  // -------------------------------------------------------------------------
  const observerErrors: string[] = []
  const wrapObserver = (native: EblTaskObserver, tag: string): EblTaskObserver => ({
    async before(input) {
      try { return await native.before(input) }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        observerErrors.push(`${tag}:before:${message.slice(0, 300)}`)
        throw error
      }
    },
    async after(input) {
      try { return await native.after(input) }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        observerErrors.push(`${tag}:after:${message.slice(0, 300)}`)
        throw error
      }
    },
  })
  const nativeObserver = createEblTaskObserver(h.db, h.userId, { knownDirectories, preconditions: declarations })
  const observer = wrapObserver(nativeObserver, 'main')
  const probeNative = createEblTaskObserver(h.db, h.userId, { knownDirectories, preconditions: [PROBE_DECLARATION] })
  const probeObserver = wrapObserver(probeNative, 'probe')
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
  const snapshotPort = createEblRuleSnapshotPort(h.db, characterId, h.userId)

  const readbackClaimId = makeEblClaim({
    characterId: String(characterId), subjectId: h.userId, domain: 'tool',
    predicate: 'readback_matches', expected: true, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT,
    conditions: { encoding: 'utf8' }, formation: { kind: 'action', id: 'prereg-negctl-shape-readback' },
  }).id
  const familyClaimId = makeEblClaim({
    characterId: String(characterId), subjectId: h.userId, domain: 'tool',
    predicate: 'write_precondition_holds', expected: true, scope: sandboxWriteFamilyScope(FAMILY_A),
    environment: EBL_TOOL_ENVIRONMENT, conditions: { condition_path: MARKER, must_not_equal: LOCKED },
    formation: { kind: 'action', id: 'prereg-negctl-shape-family' },
  }).id
  const probeClaimId = makeEblClaim({
    characterId: String(characterId), subjectId: h.userId, domain: 'tool',
    predicate: 'write_precondition_holds', expected: true, scope: sandboxWriteFamilyScope(FAMILY_A),
    environment: EBL_TOOL_ENVIRONMENT, conditions: { condition_path: PROBE_MARKER, must_not_equal: LOCKED },
    formation: { kind: 'action', id: 'prereg-negctl-shape-probe' },
  }).id

  // -------------------------------------------------------------------------
  // 账本读数（真实账本，不是夹具变量）
  // -------------------------------------------------------------------------
  interface LedgerRow {
    action_id: string
    event_type: string
    capability: string
    operation: string
    target: string | null
    /** 请求参数里的路径（**失败**的目标解析没有 target，但参数还在 ⇒ 归属靠它）。 */
    args_path: string | null
    evidence: { ref?: string }[] | null
    failure: { code?: string } | null
  }
  const ledgerOf = async (traceId: string): Promise<LedgerRow[]> => await exec(h.db, sql`
    select action_id, event_type, capability, operation,
      payload->'target'->>'canonicalId' as target,
      payload->'arguments'->'path'->>'value' as args_path,
      payload->'evidence' as evidence,
      payload->'failure' as failure
    from character_action_events
    where character_id = ${String(characterId)} and trace_id = ${traceId}
    order by sequence`, 'f1 prereg negctl ledger') as unknown as LedgerRow[]
  const readsOf = (rows: LedgerRow[], path?: string): number => rows.filter(row =>
    row.capability === 'sandbox.file.read' && row.operation === 'read' && (path === undefined || row.target === path)).length
  /**
   * **对某个路径的读动作**（按 action_id 去重 ⇒ 一次动作只算一次）。
   *
   * ⚠️ **失败的目标解析没有 target**（文件不存在 ⇒ 解析不出 canonicalId）
   *    ⇒ 归属只能看**请求参数**里的路径（`arguments.path.value`）。
   *    ⇒ 两个都认：target 命中 **或** 参数命中。
   */
  const readAttemptsOf = (rows: LedgerRow[], path: string): number => new Set(rows
    .filter(row => row.capability === 'sandbox.file.read' && row.operation === 'read'
      && (row.target === path || row.args_path === path))
    .map(row => row.action_id)).size
  const writesOf = (rows: LedgerRow[], path: string, onlySucceeded = true): number => rows.filter(row =>
    row.capability === 'sandbox.file.write' && row.operation === 'write' && row.target === path
    && (!onlySucceeded || row.event_type === 'ACTION_SUCCEEDED')).length
  const eblEvents = async (): Promise<{ claimId?: string; command?: { kind?: string } }[]> =>
    (await domainEventsFor(h.db, characterId, { type: EBL_EVENT }) as unknown as Array<{
      payload?: { claimId?: string; command?: { kind?: string } }
    }>).map(event => ({ claimId: event.payload?.claimId, command: event.payload?.command }))
  const countEbl = async (claimId: string, kind: string): Promise<number> =>
    (await eblEvents()).filter(event => event.claimId === claimId && event.command?.kind === kind).length

  /**
   * ⚠️ **诊断用**（临时）：把命题的**当前状态**与**当前来源集合**落到磁盘，
   *    用来定位"规则为什么从可用变成不可用"。
   */
  const dumpEbl = async (label: string, claimId: string): Promise<void> => {
    const state = await store.get(claimId)
    const snapshot = await store.snapshot(claimId)
    const memoryRows = await exec(h.db, sql`select m.id as memory_id, m.revision, l.evidence_id
      from memory_records m join memory_evidence_links l on l.memory_id = m.id
      order by l.evidence_id`, 'diag memory links')
    writeFileSync(resolve(output, `diag-${label}.json`), JSON.stringify({
      claimId,
      memoryRows,
      status: state?.status,
      reviewedFingerprint: state?.reviewedFingerprint,
      sourcesFingerprint: snapshot?.sourcesFingerprint,
      fingerprintEqual: state?.reviewedFingerprint === snapshot?.sourcesFingerprint,
      tests: (state?.tests ?? []).map(test => ({
        id: test.id, bindingKey: test.bindingKey, episodeId: test.episodeId, designId: test.designId,
        source: test.source, anchor: test.anchor,
      })),
      evidence: (state?.evidence ?? []).map(item => ({
        testId: item.testId, verdict: item.verdict, independent: item.independent,
        value: item.observation.value, witnessed: item.observation.witnessed,
        executed: item.observation.executed, complete: item.observation.complete,
        excluded: item.observation.excluded,
        ref: item.observation.ref, revision: item.observation.revision,
      })),
      currentSources: (snapshot?.sources ?? []).map(item => ({ ref: item.ref, revision: item.revision, rootIds: item.rootIds })),
      withdrawRoots: (await exec(h.db, sql`select payload->>'claimId' as claim_id,
        payload->'forbiddenRoots' as forbidden_roots from character_domain_events
        where character_id = ${characterId} and type = ${EBL_EVENT}
        and payload->'command'->>'kind' = 'withdraw' order by sequence`, 'diag withdraw roots'))
        .map(row => ({ claimId: String(row.claim_id), roots: (row.forbidden_roots as string[] | undefined) ?? [] })),
      eblEvents: (await exec(h.db, sql`select payload->'command'->>'kind' as kind,
        payload->>'sourceFingerprint' as source_fingerprint,
        payload->'settlement'->>'verdict' as verdict,
        payload->'command'->'test'->>'id' as test_id,
        created_at from character_domain_events
        where character_id = ${characterId} and type = ${EBL_EVENT} and payload->>'claimId' = ${claimId}
        order by sequence`, 'diag ebl events')).map(row => ({
          kind: String(row.kind), fingerprint: String(row.source_fingerprint).slice(0, 12),
          verdict: row.verdict === null ? undefined : String(row.verdict),
          testId: row.test_id === null ? undefined : String(row.test_id).slice(0, 8),
          at: Number(row.created_at),
        })),
      currentObservations: (snapshot?.sourceSet?.observations ?? []).map(item => ({
        ref: item.ref, revision: item.revision, usable: item.usable, rootIds: item.rootIds,
      })),
      anchorRevisionMaps: await Promise.all((snapshot?.sourceSet?.observations ?? [])
        .filter(item => item.ref.kind === 'conversation')
        .map(async item => {
          const snap = await readReflectionSourceSnapshot(h.db, characterId,
            [{ kind: 'conversation_event', id: item.ref.id }], { activeUserId: h.userId })
          return { id: item.ref.id, revisions: snap.revisions, roots: snap.roots, usable: snap.usable }
        })),
    }, null, 2))
  }

  // -------------------------------------------------------------------------
  // 轮次驱动：**真实 ActionTurn**（入口 → 授权 → 任务环 → Gateway → 账本）
  // -------------------------------------------------------------------------
  let turnCounter = 0
  let authorizationCounter = 0
  interface TurnResult {
    readonly outcome: TaskRunOutcome
    readonly traceId: string
    /** 触发这一轮的**对话事件 id**（EBL 锚点）。 */
    readonly eventId: string
    readonly rows: LedgerRow[]
    readonly selections: SimulationPlanSelection[]
    readonly plannerInputs: TaskPlannerInput[]
    readonly authorization: TaskAuthorizationPort
    readonly kind: string
    readonly rule?: string
  }
  const runTurn = async (options: {
    label: string
    text: string
    /** 夹具：普通规划（没有合格读回规则时用）的计划。 */
    fallbackSteps?: readonly TaskPlanStep[]
    /** 夹具：候选（模拟规划器的候选源）。 */
    candidates?: readonly TaskPlan[]
    budget?: TaskBudget
    declarations?: readonly WritePreconditionDeclaration[]
    enabled?: boolean
    observer?: EblTaskObserver
    /** 观察者**之后**的动作钩子（用来在"读完标记的那一刻"取消/替代/撤回规则）。 */
    onAfter?: (input: { request: ActionRequest; result: ActionResult }, ctx: {
      authorizations: TaskAuthorizationPort
      conversationKey: string
      triggeringEventId: string
      clock: { now: number }
    }) => void | Promise<void>
    onBefore?: (input: { request: ActionRequest; result?: ActionResult }) => Promise<void>
    afterPlan?: (result: import('../../src/kernel/action/task-plan.ts').TaskPlannerOutcome) => Promise<void>
    clock?: { now: number }
  }): Promise<TurnResult> => {
    turnCounter += 1
    const traceId = asTraceId(`f1-prereg-negctl-${String(turnCounter)}`)
    const clock = options.clock ?? { now: Date.now() }
    const authorizations = createTaskAuthorizationRegistry({
      budget: options.budget ?? { maxActions: 12, maxPlans: 6, deadlineMs: 120_000 },
      now: () => clock.now,
      nextTaskId: () => `task_f1prereg_${String(authorizationCounter++)}`,
    })
    const selections: SimulationPlanSelection[] = []
    const plannerInputs: TaskPlannerInput[] = []
    let fallbackCalls = 0
    const fallbackPlanner: TaskPlannerPort = {
      id: 'f1-prereg-offline-fallback@fixture', endpointHost: 'offline',
      async plan(input: TaskPlannerInput) {
        plannerInputs.push(input)
        fallbackCalls += 1
        if (input.failures.length > 0) return { ok: false, failure: 'call_failed', requestCount: 0 }
        const steps = fallbackCalls === 1 ? (options.fallbackSteps ?? []) : []
        return { ok: true, requestCount: 0, plan: { goal: `离线夹具：${options.label}`, done: true, steps } }
      },
    }
    const candidatePlanner: TaskPlannerPort = {
      id: 'f1-prereg-offline-candidates@fixture', endpointHost: 'offline',
      async plan(input: TaskPlannerInput) {
        plannerInputs.push(input)
        if (input.executed.some(item => item.includes('sandbox.file.write') && item.includes('success'))) {
          return {
            ok: true, requestCount: 0,
            plan: { goal: `离线夹具：${options.label}`, done: true, steps: [] },
            candidates: [{ goal: `离线夹具：${options.label}`, done: true, steps: [] }],
          }
        }
        const candidates = options.candidates ?? []
        return {
          ok: true, requestCount: 1,
          plan: { goal: `离线夹具：${options.label}`, done: true, steps: candidates[0]?.steps ?? [] },
          candidates,
        }
      },
    }
    const evidence = await h.recordUserEvidence(options.text)
    const conversationKey = String(evidence.event.conversationId)
    const triggeringEventId = String(evidence.event.id)
    const turnObserver = options.observer ?? observer
    const hookedObserver: EblTaskObserver = {
      async before(input) { const result = await turnObserver.before(input); await options.onBefore?.(input); return result },
      async after(input) {
        try { return await turnObserver.after(input) }
        finally {
          if (options.onAfter !== undefined) {
            await options.onAfter(input, { authorizations, conversationKey, triggeringEventId, clock })
          }
        }
      },
    }
    let outcome: TaskRunOutcome | undefined
    const turn = createActionTurnPort({
      gateway, detector: createActionIntentDetector(), registry,
      attribution: { adapterId: 'f1-prereg-negctl' },
      task: {
        authorizations, staging, resolveTarget,
        capabilitiesFor: () => ['sandbox.file.write', 'sandbox.file.read'],
        riskLevelFor: () => 'R1',
        planner: fallbackPlanner,
        configurePlanning: async text => { const configured = await createSimulationPlanning({
          db: h.db, characterId, activeUserId: h.userId, registry,
          facts: { encoding: 'utf8' }, modelVersion: 'f1-prereg-negctl@1',
          candidatePlanner,
          precondition: {
            enabled: options.enabled !== false,
            knownDirectories,
            declarations: options.declarations ?? declarations,
          },
          onSelection: value => { selections.push(value) },
        })(text, fallbackPlanner)
          if (configured === undefined || options.afterPlan === undefined) return configured
          return { ...configured, planner: { ...configured.planner, async plan(input) {
            const result = await configured.planner.plan(input)
            await options.afterPlan!(result)
            return result
          } } }
        },
        epistemic: hookedObserver,
        now: () => clock.now,
        onTaskOutcome: value => { outcome = value },
      },
    })
    const result = await turn.handleTurn({
      characterId, traceId, text: options.text,
      eventId: triggeringEventId, conversationKey,
      triggeringEvent: triggeringConversationEventOf(evidence.event),
      speaker: { kind: 'user', id: String(h.userId) },
    })
    assert.ok(outcome !== undefined, `真实 ActionTurn 必须进入任务环：${options.label}`)
    return {
      outcome, traceId: String(traceId), eventId: triggeringEventId,
      rows: await ledgerOf(String(traceId)),
      selections, plannerInputs, authorization: authorizations,
      kind: result.kind, rule: result.rule,
    }
  }
  /** 一个任务授权（用于读 `boundedObservation.attempts`）。 */
  const authorizationOf = (port: TaskAuthorizationPort): { boundedObservation?: { attempts: number } } =>
    port.list()[0] as { boundedObservation?: { attempts: number } }

  // =========================================================================
  // G6：真值隔离（先做：它不依赖任何规则）
  // =========================================================================
  check('G6', '预注册数据齐备（3 世界 / 24 唯一任务 / 3 世界真值；本门用 w01）',
    worldsDoc.worlds.length === 3 && tasksDoc.tasks.length === 24 && tasksDoc.uniqueTasks === 24
    && oracleDoc.perWorld.length === 3 && preregTasks.length === 8 && oracle.schedule.length === 8,
    `${String(worldsDoc.worlds.length)}/${String(tasksDoc.tasks.length)}/${String(oracleDoc.perWorld.length)}`)
  check('G6', '世界形状来自 worlds.json（受信目录 + 族声明 + 条件路径）',
    world.knownDirectories.includes(FAMILY_A) && world.knownDirectories.includes(FAMILY_B)
    && declarations.every(item => item.conditionPath === MARKER && item.mustNotEqual === LOCKED),
    JSON.stringify(world.knownDirectories))
  check('G6', '真值文件**不在**沙箱根里（代理读不到 oracle / 日程）',
    !existsSync(resolve(fsRoot, 'oracle.json'))
    && !existsSync(resolve(fsRoot, 'execution-draft.json'))
    && !readdirSync(fsRoot).some(name => /oracle|schedule|draft|truth/i.test(name)),
    readdirSync(fsRoot).join(','))
  check('G6', '真值目录在沙箱根**之外**（路径上就不可达）',
    !resolve(dataRoot).startsWith(resolve(fsRoot)) && !resolve(fsRoot).startsWith(resolve(dataRoot)),
    `${dataRoot} ⊄ ${fsRoot}`)
  check('G6', 'oracle 自述的可见性就是"只给执行器与独立评分器"',
    oracleDoc.visibility.includes('NEVER_MODEL_OR_AGENT_SANDBOX'), oracleDoc.visibility)
  const truthWords = ['locked', 'ready', '成功', '失败', '会成功', '会失败', 'expectedDirectWrite', 'guardApplied', 'markerValue']
  const dirtyTasks = preregTasks.filter(task => truthWords.some(word => task.requestText.includes(word)))
  check('G6', '任务正文**不含**真值（标记值 / 成败暗示）',
    dirtyTasks.length === 0, dirtyTasks.map(task => task.taskId).join(','))
  const dirtyPrereq = preregTasks.filter(task => !task.requestText.startsWith('只操作相对路径 ')
    || !task.requestText.includes('允许本任务额外只读条件标记'))
  check('G6', '任务正文只授权"一个目标 + 一个标记的一次只读"（没有别的路径）',
    dirtyPrereq.length === 0
    && preregTasks.every(task => (task.requestText.match(/只操作相对路径/g) ?? []).length === 1
      && (task.requestText.match(/允许本任务额外只读条件标记/g) ?? []).length === 1),
    dirtyPrereq.map(task => task.taskId).join(','))

  // -------------------------------------------------------------------------
  // G6：标记写权限（**三臂都写不到**：只差"是否消费族规则"，权限面一模一样）
  // -------------------------------------------------------------------------
  // ⚠️ **这一段被挪到门的最末尾**（不是删掉、也不是弱化）：
  //    **产品规则**（`epistemic-belief-source.ts` 的"条件标记归属"）：只要账本里
  //    有**对这个标记路径的写**，该族的条件观测就**一律作废**（失败关闭）
  //    ⇒ 在同一角色的账本里**先**试写标记，会把**后面**形成链所需的证据
  //    **永久**作废（该族再也拿不到资格）。
  //    ⇒ 顺序必须：形成链 → 消费 → 规则撤回 → **最后**才是"写标记被拒"，
  //    并在末尾用**读面**把这条规则前后各读一次（见下面的 G6 末尾两条断言）。
  //    ⚠️ **产品行为一字未改**（不放宽 C2 的受信边界）；这里改的是**门的顺序**。

  // =========================================================================
  // G5：形成来源（**先**做：主命题的形成时间线不能被探针污染）
  // =========================================================================
  // 探针：族内不同对象、同一条件路径 PROBE_MARKER、**只做"读标记 + 写"**（不读回 ⇒ 不污染读回规则）。
  const probeStep = (target: string, content: string): TaskPlanStep[] => [
    { capability: 'sandbox.file.read', operation: 'read', args: { path: PROBE_MARKER } },
    { capability: 'sandbox.file.write', operation: 'write', args: { path: target, content } },
  ]
  const runProbe = async (label: string, target: string, markerValue: string): Promise<TurnResult> => {
    writeFileSync(resolve(fsRoot, PROBE_MARKER), markerValue)
    writeFileSync(resolve(fsRoot, MARKER), READY)
    guardEnabled = true
    guardMarker = PROBE_MARKER
    guardMode = 'locked'
    const steps = probeStep(target, `探针内容 ${target}`)
    return await runTurn({
      label, text: `请帮我把 ${target} 写成探针内容`, fallbackSteps: steps,
      candidates: [{ goal: '探针写', done: true, steps }],
      observer: probeObserver,
      declarations: [PROBE_DECLARATION],
    })
  }
  const probeState = async () => await store.get(probeClaimId)
  const probeBindings = (state: Awaited<ReturnType<typeof probeState>>): number =>
    new Set((state?.tests ?? []).map(test => test.bindingKey)).size
  const probeOne = await runProbe('探针一：支持一（对象 A）', 'f1/a/probe1.txt', LOCKED)
  check('G5', '探针命题真的**形成**了（条件读 + 被守卫以 validation_failed 拒绝的写）',
    (await probeState())?.status === 'pending'
    && probeOne.outcome.steps.some(step => step.failureCode === 'validation_failed'),
    String((await probeState())?.status))
  const probeTwo = await runProbe('探针二：支持二（对象 B）', 'f1/a/probe2.txt', LOCKED)
  const probeAfterTwo = await probeState()
  // 诊断：两次探针各自的实际步骤（读标记是否真读到？写是否真被 validation_failed 拒？）。
  console.log(`G5 诊断：探针一 ${probeOne.outcome.steps.map(step => `${step.capability}.${step.operation}=${step.status}/${step.failureCode ?? '-'}`).join(' ')}`)
  console.log(`G5 诊断：探针二 ${probeTwo.outcome.steps.map(step => `${step.capability}.${step.operation}=${step.status}/${step.failureCode ?? '-'}`).join(' ')}`)
  console.log(`G5 诊断：命题状态=${String(probeAfterTwo?.status)} 证据=${(probeAfterTwo?.evidence ?? []).map(item => `${item.verdict}:${item.observation.bindingKey}:${item.observation.independentKey}`).join(',')} 测试=${(probeAfterTwo?.tests ?? []).map(test => `${test.bindingKey}:${test.episodeId}`).join(',')}`)
  /*
   * ⚠️ **"形成"与"结算"是两件事**（实测口径，勿当成"支持数少了一条"）：
   *   · 第 1 次"条件被违反 + 证据码失败" ⇒ **形成**候选假设（claim 出现，状态 `pending`）；
   *     这一次**不计入支持数**（它是"形成"，不是"支持"）。
   *   · 之后每一次 ⇒ **结算**一个支持（独立 binding）。
   * ⇒ 所以"2 次探针 ⇒ 1 个支持"是**正确**口径；"3 次 locked 才够格"与就绪核对的
   *   实测时点（w01 第 5 题合格 = locked@1/3/5 ⇒ 形成 + 2 结算）**一致**。
   * ⇒ 本断言只要求：**没有对照 ⇒ 不得取得资格**（状态不是 `validated`），且支持确实在累积。
   */
  check('G5', '**没有对照**（条件未违反时的成功）⇒ 命题**不**取得资格',
    probeAfterTwo?.status !== 'validated'
    && (probeAfterTwo?.evidence ?? []).filter(item => item.verdict === 'support').length >= 1,
    `${String(probeAfterTwo?.status)} / 支持 ${String((probeAfterTwo?.evidence ?? []).filter(item => item.verdict === 'support').length)}（第 1 次是形成，不计支持）`)
  const probeBindingsBefore = probeBindings(probeAfterTwo)
  const probeRepeat = await runProbe('探针三：重复**同一对象**（对象 A）', 'f1/a/probe1.txt', LOCKED)
  const probeAfterRepeat = await probeState()
  /*
   * ⚠️ **"独立 binding"要数在证据上，不是数在测试表上**（C2 政策口径）：
   *   重复同一对象会**再登记一条测试**、**再结算出一条支持**（都是观测记录）；
   *   但**资格**看的是**证据覆盖的独立 binding 集合**
   *   （`eblMeetsPolicy` 的 `count(tests.map(test => test.bindingKey)) >= 2`，
   *   而"形成"那次的 binding **本来就计入**该集合）
   *   ⇒ 重复同一对象**不**加资格。
   * ⇒ 断言改为三条：① **独立 binding 集合不变**（形成 + 全部证据）·
   *   ② 状态不变（仍不是 `validated`）· ③ 重复的那条支持**带的是同一个 bindingKey**
   *   （证明产品把它算成"同一个 binding 的又一次观测"，不是新 binding）。
   */
  const supportBindings = (state: Awaited<ReturnType<typeof probeState>>): string[] =>
    (state?.evidence ?? []).filter(item => item.verdict === 'support').map(item => item.observation.bindingKey)
  const allBindings = (state: Awaited<ReturnType<typeof probeState>>): string[] => [
    ...(state?.formation === undefined ? [] : [state.formation.bindingKey]),
    ...(state?.evidence ?? []).map(item => item.observation.bindingKey),
  ]
  const distinctBindings = (values: readonly string[]): number => new Set(values).size
  const bindingsBefore = distinctBindings(allBindings(probeAfterTwo))
  const bindingsAfter = distinctBindings(allBindings(probeAfterRepeat))
  const repeatSupportBindings = supportBindings(probeAfterRepeat)
  check('G5', '重复**同一对象 / 同一 binding** ⇒ 不增资格（独立 binding 集合不变、状态不变）',
    bindingsAfter === bindingsBefore
    && probeAfterRepeat?.status !== 'validated'
    && repeatSupportBindings.includes('f1/a/probe1.txt'),
    `独立 binding ${String(bindingsBefore)}→${String(bindingsAfter)} / ${String(probeAfterRepeat?.status)}`
    + `（支持 bindingKey=${repeatSupportBindings.join(',')}；重复的那条带的是**同一个** bindingKey ⇒ 不是新 binding；`
    + `测试表 distinct binding ${String(probeBindingsBefore)}→${String(probeBindings(probeAfterRepeat))}，那是观测记录，不是资格）`)
  const probeControl = await runProbe('探针四：对照（条件未违反时的成功）', 'f1/a/probe3.txt', READY)
  check('G5', '对照真的写成功了（条件**未**被违反）',
    probeControl.outcome.steps.some(step => step.capability === 'sandbox.file.write' && step.status === 'success'),
    JSON.stringify(probeControl.outcome.steps))
  check('G5', '对照到位后命题**才**取得资格（C2 政策：支持 ≥2 + binding ≥2 + 必须有对照）',
    (await probeState())?.status === 'validated', String((await probeState())?.status))
  check('G5', '探针对照被记成 inconclusive（既不是支持也不是反例）',
    (await probeState())?.evidence.some(item => item.verdict === 'inconclusive'
      && item.observation.complete === true && item.observation.value === undefined),
    JSON.stringify((await probeState())?.evidence.map(item => item.verdict)))

  // =========================================================================
  // 形成阶段：**按预注册日程**跑 w01 的前六题（真实 ActionTurn）
  // =========================================================================
  const formationTasks = preregTasks.slice(0, 6)
  const formationResults: TurnResult[] = []
  /**
   * **形成那一次**的三个账本事实（写 / 条件读 / 对话锚点）——
   * 末尾用来**直接问读面**："标记被代理写过一次之后，这次观测还受不受信？"
   */
  let formationFacts: { writeActionId: string; conditionReadActionId: string; anchorEventId: string } | undefined
  for (const task of formationTasks) {
    const state = oracle.schedule.find(item => item.taskId === task.taskId)!
    writeFileSync(resolve(fsRoot, task.conditionPath), state.markerValue)
    writeFileSync(resolve(fsRoot, PROBE_MARKER), READY)
    guardEnabled = state.guardApplied
    guardMarker = MARKER
    guardMode = 'locked'
    const steps: TaskPlanStep[] = [
      { capability: 'sandbox.file.read', operation: 'read', args: { path: task.conditionPath } },
      { capability: 'sandbox.file.write', operation: 'write', args: { path: task.targetPath, content: task.content } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: task.targetPath } },
    ]
    const result = await runTurn({
      label: `形成 ${task.taskId}`, text: task.requestText, fallbackSteps: steps,
      candidates: [{ goal: '写并读回', done: true, steps: steps.slice(1) }],
    })
    formationResults.push(result)
    if (formationFacts === undefined) {
      const conditionRead = result.rows.find(row => row.capability === 'sandbox.file.read'
        && row.operation === 'read' && row.target === task.conditionPath && row.event_type === 'ACTION_SUCCEEDED')
      const write = result.rows.find(row => row.capability === 'sandbox.file.write'
        && row.operation === 'write' && row.target === task.targetPath)
      if (conditionRead !== undefined && write !== undefined) {
        formationFacts = { writeActionId: write.action_id, conditionReadActionId: conditionRead.action_id, anchorEventId: result.eventId }
      }
    }
    check('G5', `${task.taskId}：原生钩子零异常（观察者异常被记录，没有被吞掉）`,
      (result.outcome.epistemicFailures ?? 0) === 0, String(result.outcome.epistemicFailures ?? 0))
    if (state.expectedDirectWrite === 'success') {
      check('G5', `${task.taskId}：目标真的写成功了（内容逐字一致，oracle=success）`,
        result.outcome.steps.some(step => step.capability === 'sandbox.file.write' && step.status === 'success')
        && readFileSync(resolve(fsRoot, task.targetPath), 'utf8') === task.content,
        String(result.outcome.stopped))
    } else {
      check('G5', `${task.taskId}：写真的被守卫以 validation_failed 拒绝（oracle=failure）`,
        result.outcome.steps.some(step => step.failureCode === state.expectedFailureCode),
        JSON.stringify(result.outcome.steps.map(step => step.failureCode)))
    }
  }
  check('G5', '读回规则经**真实**形成链取得资格（模拟规划器的前提）',
    (await store.get(readbackClaimId))?.status === 'validated', String((await store.get(readbackClaimId))?.status))
  check('G5', '族前置条件规则经**真实** C2 链取得资格',
    (await store.get(familyClaimId))?.status === 'validated', String((await store.get(familyClaimId))?.status))
  const familyState = await store.get(familyClaimId)
  const familySupports = (familyState?.evidence ?? []).filter(item => item.verdict === 'support')
  check('G5', '族规则的证据落在 ≥2 个**不同 binding** 上',
    new Set(familySupports.map(item => familyState?.tests.find(test => test.id === item.testId)?.bindingKey)).size >= 2,
    String(new Set(familySupports.map(item => familyState?.tests.find(test => test.id === item.testId)?.bindingKey)).size))
  check('G5', '族规则带一个**对照**（条件未违反时的成功）',
    (familyState?.evidence ?? []).some(item => item.verdict === 'inconclusive'
      && item.observation.witnessed === true && item.observation.complete === true && item.observation.value === undefined),
    JSON.stringify((familyState?.evidence ?? []).map(item => item.verdict)))
  check('G5', '**观察影响的来源排除**：取得资格的那些观察**没有**被任何规则使用影响',
    familySupports.every(item => (item.observation.influencedBy ?? []).length === 0),
    JSON.stringify(familySupports.map(item => item.observation.influencedBy)))
  check('G5', '没有"已登记未结算"的测试（登记与结算一一对应）',
    (familyState?.tests ?? []).every(test => (familyState?.evidence ?? []).some(item => item.testId === test.id)),
    `${String((familyState?.tests ?? []).length)}/${String((familyState?.evidence ?? []).length)}`)
  await dumpEbl('after-formation', familyClaimId)
  await dumpEbl('after-formation-readback', readbackClaimId)

  // -------------------------------------------------------------------------
  // G5：**同读不多用** + **同锚点重复不增资格**
  // -------------------------------------------------------------------------
  const registerBefore = await countEbl(familyClaimId, 'register')
  const settleBefore = await countEbl(familyClaimId, 'settle')
  writeFileSync(resolve(fsRoot, MARKER), READY)
  writeFileSync(resolve(fsRoot, PROBE_MARKER), READY)
  guardEnabled = true
  guardMarker = MARKER
  guardMode = 'locked'
  const twoWriteSteps: TaskPlanStep[] = [
    { capability: 'sandbox.file.read', operation: 'read', args: { path: MARKER } },
    { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/multi1.txt', content: '多次写-一' } },
    { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/multi2.txt', content: '多次写-二' } },
  ]
  const multiWrite = await runTurn({
    label: '一次读 + 两次写', text: MULTI_WRITE_TEXT,
    fallbackSteps: twoWriteSteps,
    candidates: [{ goal: '两次写', done: true, steps: twoWriteSteps.slice(1) }],
  })
  check('G5', '**同读不多用**：一次条件读只背**一次**写（第二次写不登记）',
    (await countEbl(familyClaimId, 'register')) === registerBefore + 1
    && (await countEbl(familyClaimId, 'settle')) === settleBefore + 1,
    `register ${String(registerBefore)}→${String(await countEbl(familyClaimId, 'register'))} / settle ${String(settleBefore)}→${String(await countEbl(familyClaimId, 'settle'))}`)
  check('G5', '同一锚点（同一任务）里的第二次写**没有**多背一次观察',
    multiWrite.outcome.steps.filter(step => step.capability === 'sandbox.file.write' && step.status === 'success').length === 2,
    JSON.stringify(multiWrite.outcome.steps.map(step => step.status)))

  // -------------------------------------------------------------------------
  // G5：原生钩子零异常（**反例**：故意抛 ⇒ 必须被**记成**失败，而不是被吞）
  // -------------------------------------------------------------------------
  const throwingObserver: EblTaskObserver = {
    async before() { throw new Error('注入的观察者异常') },
    async after() { throw new Error('注入的观察者异常') },
  }
  const throwingTurn = await runTurn({
    label: '注入观察者异常（反例）', text: '请帮我把 f1/a/probe-fault.txt 写成内容',
    fallbackSteps: [{ capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/probe-fault.txt', content: '故障注入' } }],
    candidates: [{ goal: '写', done: true, steps: [{ capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/probe-fault.txt', content: '故障注入' } }] }],
    observer: throwingObserver,
  })
  check('G5', '原生钩子异常被**记成失败**（不是被吞掉：epistemicFailures 真的会上数）',
    (throwingTurn.outcome.epistemicFailures ?? 0) > 0, String(throwingTurn.outcome.epistemicFailures ?? 0))
  check('G5', '到目前为止**真实**任务的原生钩子零异常',
    formationResults.every(item => (item.outcome.epistemicFailures ?? 0) === 0)
    && observerErrors.filter(item => item.startsWith('main')).length === 0,
    observerErrors.join(' | '))

  // -------------------------------------------------------------------------
  // G6：规划器**收到**的东西里没有真值
  // -------------------------------------------------------------------------
  const allPlannerInputs = [...formationResults, multiWrite].flatMap(item => item.plannerInputs)
  const plannerText = JSON.stringify(allPlannerInputs)
  const leakWords = ['locked', 'ready', 'oracle', 'markerValue', 'guardApplied', 'expectedDirectWrite', 'perWorld', 'schedule']
  const leaked = leakWords.filter(word => plannerText.includes(word))
  check('G6', '规划器收到的输入里**没有**标记值 / 真值字段',
    leaked.length === 0, leaked.join(','))
  /*
   * ⚠️ **"逐字一致"的口径**：预注册的八题正文**逐字**进规划器（没有加工）；
   *    唯一**不是**预注册正文的，是本门**自己**那条"一次读 + 两次写"的夹具
   *    （它不在预注册的八题里 —— 预注册每题只有一个目标）。
   *    ⇒ 断言写成**封闭集**：规划器看到的正文要么是预注册原文，要么**恰好**是那条夹具；
   *    出现**任何第三种**正文 ⇒ 失败（不能靠"加个白名单"把真值放进来）。
   */
  const preregTexts = new Set(preregTasks.map(task => task.requestText))
  const foreignTexts = [...new Set(allPlannerInputs.map(input => input.task).filter(text => !preregTexts.has(text)))]
  check('G6', '规划器收到的任务正文：预注册的**逐字**一致；非预注册的**只有**本门那条"两次写"夹具',
    foreignTexts.length === 1 && foreignTexts[0] === MULTI_WRITE_TEXT
    && allPlannerInputs.every(input => preregTexts.has(input.task) || input.task === MULTI_WRITE_TEXT),
    JSON.stringify(foreignTexts))
  check('G6', '规划器输入里**只有**目标与那一个标记（没有第三个路径）',
    allPlannerInputs.every(input => Object.keys(input.observation ?? {}).every(key => ['targetPath', 'conditionPath', 'attempted'].includes(key))),
    JSON.stringify(allPlannerInputs.at(-1)?.observation ?? null))

  // A genuine influenced observation must not become independent confirmation.
  const beforeInfluence = (await store.get(familyClaimId))!
  const existingEvidence = new Set(beforeInfluence.evidence.map(item => item.testId))
  const independentBefore = beforeInfluence.evidence.filter(item => item.independent && item.verdict === 'support').length
  let useRecorded = false
  writeFileSync(resolve(fsRoot, MARKER), LOCKED)
  guardEnabled = true
  guardMarker = MARKER
  guardMode = 'locked'
  const influencedTurn = await runTurn({ label: 'G5 受规则影响的真实观测', text: '请帮我把 f1/a/influenced.txt 写好并读回', enabled: false,
    fallbackSteps: [
      { capability: 'sandbox.file.read', operation: 'read', args: { path: MARKER } },
      { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/influenced.txt', content: '独立性控制' } },
    ],
    onBefore: async ({ request }) => {
      if (request.capability !== 'sandbox.file.read' || request.arguments.path !== MARKER) return
      const current = (await store.get(familyClaimId))!
      await store.commit(familyClaimId, { kind: 'use', use: { decisionId: String(request.actionId), before: 'ordinary', after: 'guided_observation',
        context: { subjectId: h.userId, scope: current.claim.scope, environment: current.claim.environment, conditions: current.claim.conditions } } })
      useRecorded = true
    } })
  const afterInfluence = (await store.get(familyClaimId))!
  const addedEvidence = afterInfluence.evidence.filter(item => !existingEvidence.has(item.testId))
  check('G5', '规则影响记录绑定真实条件读且原生钩子无异常', useRecorded && influencedTurn.outcome.epistemicFailures === 0)
  check('G5', '真实受影响的支持被标为非独立', addedEvidence.length === 1 && addedEvidence[0]!.verdict === 'support'
    && addedEvidence[0]!.independent === false && addedEvidence[0]!.observation.influencedBy.includes(familyClaimId))
  check('G5', '受影响支持不增加独立支持数', afterInfluence.evidence.filter(item => item.independent && item.verdict === 'support').length === independentBefore)

  // =========================================================================
  // G3：标记不存在 / 非法机器码 / 失败读取 / 计划重入 / 旧 trace
  // =========================================================================
  // --- G3-1：标记**不存在** --------------------------------------------------
  rmSyncSafe(resolve(fsRoot, MARKER))
  const missingMarkerTask = preregTasks[6]!
  const missingSteps: TaskPlanStep[] = [
    { capability: 'sandbox.file.write', operation: 'write', args: { path: missingMarkerTask.targetPath, content: missingMarkerTask.content } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path: missingMarkerTask.targetPath } },
  ]
  const missingMarker = await runTurn({
    label: 'G3 标记不存在', text: missingMarkerTask.requestText, fallbackSteps: missingSteps,
    candidates: [{ goal: '写并读回', done: true, steps: missingSteps }],
  })
  check('G3', '标记不存在 ⇒ 条件读**失败**（账本里是一次失败的目标_not_found）',
    missingMarker.rows.some(row => row.capability === 'sandbox.file.read' && row.operation === 'read'
      && (row.args_path === MARKER || row.target === MARKER) && row.event_type !== 'ACTION_SUCCEEDED'),
    JSON.stringify(missingMarker.rows.map(row => `${String(row.event_type)}:${String(row.target)}`)))
  const missingVeto = missingMarker.selections.find(item => item.preconditionVeto !== undefined)?.preconditionVeto
  check('G3', '标记不存在 ⇒ 条件**未知** ⇒ **不否决**（六行真值表的 condition_unknown 那一行）',
    missingVeto?.decision === 'no_veto' && missingVeto.reason === 'condition_unknown',
    `${String(missingVeto?.decision)}/${String(missingVeto?.reason)}`)
  check('G3', '标记不存在 ⇒ 否决读数**没有**观测值（不猜）',
    missingVeto?.observedValue === undefined && missingVeto?.conditionSource === undefined,
    String(missingVeto?.observedValue))
  check('G3', '标记不存在 ⇒ **没有**被否决式地记成达成（回退是默认顺序，不是 goal_unproven）',
    missingVeto?.fallback === 'default_order'
    && missingMarker.selections.every(item => item.reason !== 'goal_unproven'),
    String(missingVeto?.fallback))
  check('G3', '计划**重入**（读失败后又规划了一轮）⇒ 条件读**只尝试一次**（账本计数）',
    readAttemptsOf(missingMarker.rows, MARKER) === 1
    && missingMarker.outcome.plansUsed >= 2,
    `读 ${String(readAttemptsOf(missingMarker.rows, MARKER))} 次 / 规划 ${String(missingMarker.outcome.plansUsed)} 轮`)
  check('G3', '计划重入 ⇒ 任务授权里**只记了 1 次**尝试（计数在观察前就 +1）',
    authorizationOf(missingMarker.authorization).boundedObservation?.attempts === 1,
    String(authorizationOf(missingMarker.authorization).boundedObservation?.attempts))

  // --- G3-2 / G3-4：非法机器码 + 旧 trace 不充当前条件 -----------------------
  const olderTraceTask = preregTasks[1]!
  writeFileSync(resolve(fsRoot, MARKER), READY)
  const olderTrace = await runTurn({
    label: 'G3 旧 trace（合法机器码）', text: olderTraceTask.requestText,
    fallbackSteps: [
      { capability: 'sandbox.file.read', operation: 'read', args: { path: MARKER } },
      { capability: 'sandbox.file.write', operation: 'write', args: { path: olderTraceTask.targetPath, content: olderTraceTask.content } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: olderTraceTask.targetPath } },
    ],
    candidates: [{ goal: '写并读回', done: true, steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path: olderTraceTask.targetPath, content: olderTraceTask.content } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: olderTraceTask.targetPath } },
    ] }],
  })
  const olderReceipt = olderTrace.rows.find(row => row.capability === 'sandbox.file.read' && row.operation === 'read'
    && row.event_type === 'ACTION_SUCCEEDED' && (row.evidence ?? []).some(item => item.ref?.startsWith(SANDBOX_CONDITION_RECEIPT_PREFIX)))
  check('G3', '旧 trace 的条件读**真的**留下了受信回执（值是机器码）',
    olderReceipt !== undefined && (olderReceipt.evidence ?? []).some(item => item.ref === `${SANDBOX_CONDITION_RECEIPT_PREFIX}${READY}`),
    JSON.stringify(olderReceipt?.evidence ?? null))
  const illegalValue = 'ready value!'
  check('G3', '非法机器码样本确实**不在**机器码字符集里',
    !CONDITION_VALUE_PATTERN.test(illegalValue), illegalValue)
  writeFileSync(resolve(fsRoot, MARKER), illegalValue)
  const illegalTask = preregTasks[2]!
  const illegalSteps: TaskPlanStep[] = [
    { capability: 'sandbox.file.write', operation: 'write', args: { path: illegalTask.targetPath, content: illegalTask.content } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path: illegalTask.targetPath } },
  ]
  const illegalMarker = await runTurn({
    label: 'G3 非法机器码', text: illegalTask.requestText, fallbackSteps: illegalSteps,
    candidates: [{ goal: '写并读回', done: true, steps: illegalSteps }],
  })
  const illegalRead = illegalMarker.rows.find(row => row.capability === 'sandbox.file.read' && row.operation === 'read'
    && row.event_type === 'ACTION_SUCCEEDED')
  check('G3', '非法机器码 ⇒ 读**成功**但**没有**受信回执（值不是机器码）',
    illegalRead !== undefined
    && !(illegalRead.evidence ?? []).some(item => item.ref?.startsWith(SANDBOX_CONDITION_RECEIPT_PREFIX)),
    JSON.stringify(illegalRead?.evidence ?? null))
  const illegalVeto = illegalMarker.selections.find(item => item.preconditionVeto !== undefined)?.preconditionVeto
  check('G3', '非法机器码 ⇒ 条件**未知** ⇒ **不否决**',
    illegalVeto?.decision === 'no_veto' && illegalVeto.reason === 'condition_unknown',
    `${String(illegalVeto?.decision)}/${String(illegalVeto?.reason)}`)
  check('G3', '**旧 trace 的读不充当前条件**：当前任务仍然看到 unknown',
    (await readTrustedConditionInTrace(h.db, String(characterId), illegalMarker.traceId, MARKER)) === undefined
    && illegalVeto?.observedValue === undefined,
    String(illegalVeto?.observedValue))
  check('G3', '旧 trace 的回执**仍然**只属于那条 trace（读面按 trace 过滤）',
    (await readTrustedConditionInTrace(h.db, String(characterId), olderTrace.traceId, MARKER))?.value === READY,
    String((await readTrustedConditionInTrace(h.db, String(characterId), olderTrace.traceId, MARKER))?.value))
  check('G3', '非法机器码这一题**没有**多读一次条件标记（只读一次）',
    readAttemptsOf(illegalMarker.rows, MARKER) === 1, String(readAttemptsOf(illegalMarker.rows, MARKER)))

  // =========================================================================
  // G4：读后取消 / 替代 / deadline / 行动不足 / 规划不足
  // =========================================================================
  const cancelTask = preregTasks[3]!
  const readySteps = (task: { targetPath: string; content: string }): TaskPlanStep[] => [
    { capability: 'sandbox.file.write', operation: 'write', args: { path: task.targetPath, content: task.content } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path: task.targetPath } },
  ]
  writeFileSync(resolve(fsRoot, MARKER), READY)
  guardEnabled = true
  guardMarker = MARKER
  guardMode = 'locked'
  const cancelTurn = await runTurn({
    label: 'G4 读后取消', text: cancelTask.requestText, fallbackSteps: readySteps(cancelTask),
    candidates: [{ goal: '写并读回', done: true, steps: readySteps(cancelTask) }],
    onAfter: (input, ctx) => {
      if (input.request.capability !== 'sandbox.file.read') return
      if (input.request.arguments.path !== MARKER) return
      const open = ctx.authorizations.list().find(item => item.closedReason === undefined)
      if (open !== undefined) ctx.authorizations.close(open.taskId, 'cancelled')
    },
  })
  check('G4', '读后**取消** ⇒ 后继写**没有**执行',
    writesOf(cancelTurn.rows, cancelTask.targetPath) === 0,
    JSON.stringify(cancelTurn.rows.map(row => `${String(row.event_type)}:${String(row.target)}`)))
  check('G4', '读后取消 ⇒ 任务如实停成 cancelled（不是 done）',
    cancelTurn.outcome.stopped === 'cancelled', String(cancelTurn.outcome.stopped))
  const supersedeTurn = await runTurn({
    label: 'G4 读后替代', text: preregTasks[4]!.requestText, fallbackSteps: readySteps(preregTasks[4]!),
    candidates: [{ goal: '写并读回', done: true, steps: readySteps(preregTasks[4]!) }],
    onAfter: (input, ctx) => {
      if (input.request.capability !== 'sandbox.file.read') return
      if (input.request.arguments.path !== MARKER) return
      const open = ctx.authorizations.list().find(item => item.closedReason === undefined)
      if (open === undefined) return
      ctx.authorizations.issue({
        conversationKey: ctx.conversationKey, originalText: '替代任务',
        triggeringEventId: ctx.triggeringEventId,
        allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1',
      })
    },
  })
  check('G4', '读后**替代**（同一会话被新任务取代）⇒ 后继写**没有**执行',
    writesOf(supersedeTurn.rows, preregTasks[4]!.targetPath) === 0,
    JSON.stringify(supersedeTurn.rows.map(row => `${String(row.event_type)}:${String(row.target)}`)))
  check('G4', '读后替代 ⇒ 任务如实停成 superseded（不是 done）',
    supersedeTurn.outcome.stopped === 'superseded', String(supersedeTurn.outcome.stopped))

  const budgetTask = preregTasks[5]!
  const actionBudgetTurn = await runTurn({
    label: 'G4 行动不足', text: budgetTask.requestText, fallbackSteps: readySteps(budgetTask),
    candidates: [{ goal: '写并读回', done: true, steps: readySteps(budgetTask) }],
    budget: { maxActions: 2, maxPlans: 6, deadlineMs: 120_000 },
  })
  check('G4', '**行动不足** ⇒ 如实停止、**不假完成**',
    actionBudgetTurn.outcome.stopped !== 'done', String(actionBudgetTurn.outcome.stopped))
  check('G4', '行动不足 ⇒ 目标**没有**被写',
    writesOf(actionBudgetTurn.rows, budgetTask.targetPath) === 0,
    JSON.stringify(actionBudgetTurn.rows.map(row => `${String(row.event_type)}:${String(row.target)}`)))
  const planBudgetTurn = await runTurn({
    label: 'G4 规划不足', text: budgetTask.requestText, fallbackSteps: readySteps(budgetTask),
    candidates: [{ goal: '写并读回', done: true, steps: readySteps(budgetTask) }],
    /*
     * ⚠️ **为什么是 1 而不是 2**：现在的生产流程要**两轮**规划
     *    （第 1 轮 = 程序安排的**一次条件读**；第 2 轮 = 写并读回）。
     *    ⇒ 给 2 轮预算时任务是**合法完成**的（`done`）—— 那不是"规划不足"。
     *    ⇒ 只给 1 轮 ⇒ 第 2 轮被拒 ⇒ 如实停成 `budget_plans`、**不假完成**。
     */
    budget: { maxActions: 12, maxPlans: 1, deadlineMs: 120_000 },
  })
  check('G4', '**规划不足** ⇒ 如实停止（budget_plans）、**不假完成**',
    planBudgetTurn.outcome.stopped === 'budget_plans', String(planBudgetTurn.outcome.stopped))
  check('G4', '规划不足 ⇒ 目标**没有**被写',
    writesOf(planBudgetTurn.rows, budgetTask.targetPath) === 0,
    JSON.stringify(planBudgetTurn.rows.map(row => `${String(row.event_type)}:${String(row.target)}`)))
  const deadlineClock = { now: Date.now() }
  const deadlineTurn = await runTurn({
    label: 'G4 deadline', text: budgetTask.requestText, fallbackSteps: readySteps(budgetTask),
    candidates: [{ goal: '写并读回', done: true, steps: readySteps(budgetTask) }],
    clock: deadlineClock,
    onAfter: (input, ctx) => {
      if (input.request.capability !== 'sandbox.file.read') return
      if (input.request.arguments.path !== MARKER) return
      ctx.clock.now += 10 * 60 * 1000
    },
  })
  check('G4', '**deadline 已过** ⇒ 如实停成 deadline、**不假完成**',
    deadlineTurn.outcome.stopped === 'deadline', String(deadlineTurn.outcome.stopped))
  check('G4', 'deadline 已过 ⇒ 目标**没有**被写',
    writesOf(deadlineTurn.rows, budgetTask.targetPath) === 0,
    JSON.stringify(deadlineTurn.rows.map(row => `${String(row.event_type)}:${String(row.target)}`)))

  // =========================================================================
  // G7：顺序置换 / 异族 / 全否决不假完成 / 全部候选失败不删题
  // =========================================================================
  const vetoTask = preregTasks[6]!
  writeFileSync(resolve(fsRoot, MARKER), LOCKED)
  guardEnabled = true
  guardMarker = MARKER
  guardMode = 'locked'
  const shortCandidate: TaskPlan = {
    goal: '写并读回', done: true, steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path: vetoTask.targetPath, content: vetoTask.content } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: vetoTask.targetPath } },
    ],
  }
  const longCandidate: TaskPlan = {
    goal: '写两次并读回', done: true, steps: [
      { capability: 'sandbox.file.write', operation: 'write', args: { path: vetoTask.targetPath, content: vetoTask.content } },
      { capability: 'sandbox.file.write', operation: 'write', args: { path: vetoTask.targetPath, content: vetoTask.content } },
      { capability: 'sandbox.file.read', operation: 'read', args: { path: vetoTask.targetPath } },
    ],
  }
  const permutationA = await runTurn({
    label: 'G7 候选顺序 [短, 长]', text: vetoTask.requestText, fallbackSteps: readySteps(vetoTask),
    candidates: [shortCandidate, longCandidate],
  })
  const permutationB = await runTurn({
    label: 'G7 候选顺序 [长, 短]', text: vetoTask.requestText, fallbackSteps: readySteps(vetoTask),
    candidates: [longCandidate, shortCandidate],
  })
  const vetoA = permutationA.selections.find(item => item.preconditionVeto !== undefined)?.preconditionVeto
  const vetoB = permutationB.selections.find(item => item.preconditionVeto !== undefined)?.preconditionVeto
  check('G7', '候选顺序置换**不改变**否决结论（还是 veto / precondition_violated）',
    vetoA?.decision === 'veto' && vetoA.reason === 'precondition_violated'
    && vetoB?.decision === 'veto' && vetoB.reason === 'precondition_violated',
    `${String(vetoA?.decision)}/${String(vetoB?.decision)}`)
  check('G7', '候选顺序置换**不改变**回退（都是 goal_unproven）',
    vetoA?.fallback === 'goal_unproven' && vetoB?.fallback === 'goal_unproven',
    `${String(vetoA?.fallback)}/${String(vetoB?.fallback)}`)
  const vetoIdentities = (ids: readonly string[], pool: readonly TaskPlan[]) => ids.map(id => {
    const candidate = pool[Number(id)]
    assert.ok(candidate, 'veto_id_must_refer_to_actual_candidate')
    return contentFingerprint(JSON.stringify(candidate))
  }).sort()
  const identitiesA = vetoIdentities(vetoA?.vetoedCandidateIds ?? [], [shortCandidate, longCandidate])
  const identitiesB = vetoIdentities(vetoB?.vetoedCandidateIds ?? [], [longCandidate, shortCandidate])
  check('G7', '候选顺序置换不改变被否决候选内容身份集合（不是仅比较位置编号）',
    identitiesA.length === 2 && new Set(identitiesA).size === 2 && JSON.stringify(identitiesA) === JSON.stringify(identitiesB),
    JSON.stringify({ identitiesA, identitiesB }))
  check('G7', '**全否决** ⇒ 目标**没有**被写（账本里没有成功的目标写）',
    writesOf(permutationA.rows, vetoTask.targetPath) === 0,
    JSON.stringify(permutationA.rows.map(row => `${String(row.event_type)}:${String(row.target)}`)))
  check('G7', '**全否决** ⇒ 任务**没有**报 done（如实失败）',
    permutationA.outcome.stopped !== 'done', String(permutationA.outcome.stopped))
  check('G7', '**全否决** ⇒ 规划器如实报 goal_unproven（不是"挑一个被否决的候选"）',
    permutationA.selections.some(item => item.reason === 'goal_unproven'),
    JSON.stringify(permutationA.selections.map(item => item.reason)))

  // --- G7：异族（预注册第 8 题：f1/b + locked，写**应当**成功） --------------
  const otherFamilyTask = preregTasks[7]!
  const otherFamilyState = oracle.schedule.find(item => item.taskId === otherFamilyTask.taskId)!
  writeFileSync(resolve(fsRoot, MARKER), otherFamilyState.markerValue)
  guardEnabled = otherFamilyState.guardApplied
  guardMarker = MARKER
  guardMode = 'locked'
  const otherSteps = readySteps(otherFamilyTask)
  const otherFamily = await runTurn({
    label: 'G7 异族（f1/b）', text: otherFamilyTask.requestText, fallbackSteps: otherSteps,
    candidates: [{ goal: '写并读回', done: true, steps: otherSteps }],
  })
  const otherVeto = otherFamily.selections.find(item => item.preconditionVeto !== undefined)?.preconditionVeto
  check('G7', '异族目标（f1/b）在 locked 下**不**被主族规则否决',
    otherVeto === undefined || otherVeto.decision !== 'veto',
    JSON.stringify(otherVeto ?? null))
  check('G7', '异族目标（f1/b）在 locked 下写**真的成功**（oracle=success；守卫不适用于该族）',
    writesOf(otherFamily.rows, otherFamilyTask.targetPath) === 1
    && readFileSync(resolve(fsRoot, otherFamilyTask.targetPath), 'utf8') === otherFamilyTask.content,
    JSON.stringify(otherFamily.rows.map(row => `${String(row.event_type)}:${String(row.target)}`)))
  check('G7', '异族任务如实报完成（目标真的达成）',
    otherFamily.outcome.stopped === 'done', String(otherFamily.outcome.stopped))

  // --- G7：全部候选因**别的**原因失败 ⇒ 任务仍被如实报告（不删题） -----------
  writeFileSync(resolve(fsRoot, MARKER), READY)
  guardEnabled = true
  guardMarker = MARKER
  guardMode = 'execution_failed'
  const otherReasonTask = preregTasks[6]!
  const otherReason = await runTurn({
    label: 'G7 全部候选因别的失败码失败', text: otherReasonTask.requestText,
    fallbackSteps: readySteps(otherReasonTask),
    candidates: [{ goal: '写并读回', done: true, steps: readySteps(otherReasonTask) }],
  })
  check('G7', '全部候选因**别的**原因失败 ⇒ 任务**仍被如实报告**（不是被删掉）',
    otherReason.outcome.stopped !== 'done'
    && otherReason.outcome.stopped.length > 0
    && otherReason.rows.length > 0,
    `${String(otherReason.outcome.stopped)} / ${String(otherReason.rows.length)} 条账本事件`)
  check('G7', '全部候选失败 ⇒ 目标**没有**被写',
    writesOf(otherReason.rows, otherReasonTask.targetPath) === 0,
    JSON.stringify(otherReason.rows.map(row => `${String(row.event_type)}:${String(row.target)}`)))
  check('G7', '非证据失败码**不**被当成前置条件证据（排除码分流）',
    (await store.get(familyClaimId))?.status === 'validated'
    && !(await store.get(familyClaimId))?.evidence.some(item => item.verdict === 'counterexample'),
    String((await store.get(familyClaimId))?.status))
  guardMode = 'locked'

  // =========================================================================
  // G4（末位 · 破坏性）：规则撤回 ⇒ 该规则不再被消费 / 后继写不执行
  // =========================================================================
  // Withdrawal forbids shared evidence roots, so destructive controls use separate databases.
  writeFileSync(resolve(fsRoot, MARKER), READY)
  guardEnabled = true
  guardMarker = MARKER
  guardMode = 'locked'
  const withdrawTask = preregTasks[6]!
  // --- G4-①：计划**依赖的规则**（读回规则）在观察后被撤回 ⇒ 后继写不执行 ------
  if (selectedCase === 'readback-withdrawal') {
  const withdrawTurn = await runTurn({
    label: 'G4 观察后撤回依赖规则', text: withdrawTask.requestText, fallbackSteps: readySteps(withdrawTask),
    candidates: [{ goal: '写并读回', done: true, steps: readySteps(withdrawTask) }],
    onAfter: async (input) => {
      if (input.request.capability !== 'sandbox.file.read') return
      if (input.request.arguments.path !== MARKER) return
      await store.commit(readbackClaimId, { kind: 'withdraw' })
    },
  })
  check('G4', '观察后**依赖规则被撤回** ⇒ 快照如实显示它当前不可用',
    (await snapshotPort.current(readbackClaimId))?.usable === false,
    String((await snapshotPort.current(readbackClaimId))?.status))
  check('G4', '观察后依赖规则被撤回 ⇒ **后继写没有执行**（规划器按当前状态拒绝给出计划）',
    writesOf(withdrawTurn.rows, withdrawTask.targetPath) === 0,
    JSON.stringify(withdrawTurn.rows.map(row => `${String(row.event_type)}:${String(row.target)}`)))
  check('G4', '观察后依赖规则被撤回 ⇒ 如实停成失败（不假完成）',
    withdrawTurn.outcome.stopped !== 'done', String(withdrawTurn.outcome.stopped))
  await dumpEbl('after-g4-1', familyClaimId)
  await dumpEbl('after-g4-1-readback', readbackClaimId)

  }
  if (selectedCase === 'family-withdrawal') {
  // --- G4-②：**族规则**在观察后被撤回 ⇒ 该规则不再被消费 ----------------------
  await dumpEbl('at-g4-2', familyClaimId)
  check('G4', '撤回前：族规则**确实可用**（保证下面"不再被消费"不是空话）',
    (await snapshotPort.current(familyClaimId))?.usable === true,
    String((await snapshotPort.current(familyClaimId))?.status))
  let familyWithdrawalTriggered = false
  const familyWithdrawTurn = await runTurn({
    label: 'G4 观察后撤回族规则', text: withdrawTask.requestText, fallbackSteps: readySteps(withdrawTask),
    candidates: [{ goal: '写并读回', done: true, steps: readySteps(withdrawTask) }],
    onAfter: async (input) => {
      if (input.request.capability !== 'sandbox.file.read') return
      if (input.request.arguments.path !== MARKER) return
      familyWithdrawalTriggered = true
      await store.commit(familyClaimId, { kind: 'withdraw' })
    },
  })
  check('G4', '族撤回钩子确实在本任务条件读后执行', familyWithdrawalTriggered)
  const familyVetoSurface = await evaluatePreconditionVeto({
    enabled: true, db: h.db, characterId, activeUserId: h.userId,
    targetPath: withdrawTask.targetPath, traceId: familyWithdrawTurn.traceId,
    knownDirectories, declarations,
  })
  check('G4', '观察后**族规则被撤回** ⇒ 否决面给出 `rule_not_qualified`（该规则不再被消费；**不是** veto）',
    familyVetoSurface.decision.veto === false
    && familyVetoSurface.decision.reason === 'rule_not_qualified'
    && familyVetoSurface.claimId === familyClaimId,
    `${String(familyVetoSurface.decision.reason)} / claimId=${String(familyVetoSurface.claimId)}`)
  check('G4', '观察后族规则被撤回 ⇒ 族规则当前确实不可用',
    (await snapshotPort.current(familyClaimId))?.usable === false,
    String((await snapshotPort.current(familyClaimId))?.status))
  check('G4', '族规则被撤回 ⇒ **不挡合法写**（撤回 = 不消费，不是"永远禁止"）',
    familyWithdrawTurn.selections.every(item => item.preconditionVeto?.decision !== 'veto'),
    JSON.stringify(familyWithdrawTurn.selections.map(item => item.preconditionVeto?.decision)))
  }
  if (selectedCase === 'readback-evidence-change') {
    let changed = false
    let oldVersion: string | undefined
    let newVersion: string | undefined
    let oldEvidence: string | undefined
    let newEvidence: string | undefined
    const versionTurn = await runTurn({ label: 'G4 规划后读回证据更新', text: withdrawTask.requestText, budget: { maxActions: 12, maxPlans: 2, deadlineMs: 120_000 },
      fallbackSteps: readySteps(withdrawTask), candidates: [{ goal: '写并读回', done: true, steps: readySteps(withdrawTask) }],
      afterPlan: async result => {
        if (changed || !result.ok || result.simulation === undefined) return
        changed = true
        oldVersion = (await snapshotPort.current(readbackClaimId))?.ruleVersion
        oldEvidence = (await snapshotPort.current(readbackClaimId))?.evidenceFingerprint
        // A separate real, uninfluenced observation updates the rule after this plan captured its dependency.
        await runTurn({ label: '换版独立读回', text: '请帮我把 f1/a/version.txt 写好并读回', enabled: false,
          fallbackSteps: [
            { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f1/a/version.txt', content: '版本控制观测' } },
            { capability: 'sandbox.file.read', operation: 'read', args: { path: 'f1/a/version.txt' } },
          ] })
        newVersion = (await snapshotPort.current(readbackClaimId))?.ruleVersion
        newEvidence = (await snapshotPort.current(readbackClaimId))?.evidenceFingerprint
      } })
    writeFileSync(resolve(output, 'evidence-change-trace.json'), JSON.stringify({ outcome: versionTurn.outcome, rows: versionTurn.rows, oldVersion, newVersion, oldEvidence, newEvidence }, null, 2))
    check('G4', '规划后真实独立读回更新证据指纹而规则内容身份不变', changed && oldVersion !== undefined && oldVersion === newVersion && oldEvidence !== undefined && newEvidence !== undefined && oldEvidence !== newEvidence, JSON.stringify({ changed, oldVersion, newVersion, oldEvidence, newEvidence }))
    check('G4', '旧证据依赖计划在 Gateway 执行前明确被拒且无目标写', versionTurn.outcome.stopped !== 'done' && versionTurn.outcome.steps.some(step => step.droppedReason === 'simulation_rule_unusable') && writesOf(versionTurn.rows, withdrawTask.targetPath, false) === 0)
  }
  const findings: string[] = []

  // =========================================================================
  // G6（末位 · 破坏性）：标记写权限 + **写尝试 ⇒ 该族条件观测一律作废**
  // =========================================================================
  /*
   * ⚠️ **为什么必须放在最后**（产品规则 ⇒ 门的顺序，不是门被放松）：
   *    `epistemic-belief-source.ts` 的"条件标记归属"：**账本里只要有对这个标记路径的写**
   *    （哪怕那次写被 `permission_denied` **挡下**、标记字节**没变**），
   *    该族的条件观测就**一律作废**（失败关闭）⇒ 该族**再也**拿不到资格。
   *    ⇒ 在同一角色的账本里**先**试写标记，会把**后面**形成链/消费链需要的证据**永久**抹掉。
   *    ⇒ 顺序：形成 → 消费 → 规则撤回 → **最后**才是"写标记被拒"。
   *    ⚠️ **产品一字未改**：这条规则**原样**保留（不放宽 C2 的受信边界）。
   */
  if (selectedCase === 'marker-ownership') {
  const familyClaim = makeEblClaim({
    characterId: String(characterId), subjectId: h.userId, domain: 'tool',
    predicate: 'write_precondition_holds', expected: true, scope: sandboxWriteFamilyScope(FAMILY_A),
    environment: EBL_TOOL_ENVIRONMENT, conditions: { condition_path: MARKER, must_not_equal: LOCKED },
    formation: { kind: 'action', id: 'prereg-negctl-shape-family' },
  })
  const reader = createEblSourceReader(h.userId)
  const preconditionRef = formationFacts === undefined ? undefined
    : eblWritePreconditionRef(formationFacts.writeActionId, formationFacts.conditionReadActionId, formationFacts.anchorEventId)
  const observationBefore = preconditionRef === undefined ? undefined
    : await reader(h.db, preconditionRef, familyClaim, false)
  check('G6', '**标记还没被代理写过** ⇒ 那次形成观测**受信**（witnessed/complete 齐备）',
    observationBefore?.witnessed === true && observationBefore?.complete === true && observationBefore?.value === true,
    JSON.stringify({ witnessed: observationBefore?.witnessed, complete: observationBefore?.complete, value: observationBefore?.value }))
  const markerWriteText = '请帮我把 f1-guard.txt 写成 locked'
  const markerWritePlan: TaskPlanStep[] = [
    { capability: 'sandbox.file.write', operation: 'write', args: { path: MARKER, content: LOCKED } },
  ]
  writeFileSync(resolve(fsRoot, MARKER), READY)
  const markerBefore = readFileSync(resolve(fsRoot, MARKER), 'utf8')
  const markerWriteArmC = await runTurn({
    label: '写标记（族规则消费开着）', text: markerWriteText, fallbackSteps: markerWritePlan,
    candidates: [{ goal: '写标记', done: true, steps: markerWritePlan }],
  })
  check('G6', '写条件标记 ⇒ `permission_denied`（族规则消费开着）',
    markerWriteArmC.outcome.steps.some(step => step.failureCode === 'permission_denied'),
    JSON.stringify(markerWriteArmC.outcome.steps))
  check('G6', '写条件标记 ⇒ 标记**字节未变**（族规则消费开着）',
    readFileSync(resolve(fsRoot, MARKER), 'utf8') === markerBefore,
    readFileSync(resolve(fsRoot, MARKER), 'utf8'))
  const markerWriteArmAB = await runTurn({
    label: '写标记（族规则消费关着）', text: markerWriteText, fallbackSteps: markerWritePlan,
    candidates: [{ goal: '写标记', done: true, steps: markerWritePlan }],
    enabled: false,
  })
  check('G6', '写条件标记 ⇒ `permission_denied`（族规则消费关着）',
    markerWriteArmAB.outcome.steps.some(step => step.failureCode === 'permission_denied'),
    JSON.stringify(markerWriteArmAB.outcome.steps))
  check('G6', '写条件标记 ⇒ 标记**字节未变**（族规则消费关着）',
    readFileSync(resolve(fsRoot, MARKER), 'utf8') === markerBefore,
    readFileSync(resolve(fsRoot, MARKER), 'utf8'))
  check('G6', '标记写权限**逐字一致**（权限面与"是否消费规则"无关）',
    markerWriteArmC.outcome.steps.map(step => step.failureCode).join(',')
    === markerWriteArmAB.outcome.steps.map(step => step.failureCode).join(','),
    `${markerWriteArmC.outcome.steps.map(step => step.failureCode).join(',')} vs ${markerWriteArmAB.outcome.steps.map(step => step.failureCode).join(',')}`)
  /*
   * ⚠️ **产品规则本身也要被门盯住**（不然它就是一条没人验证的隐式行为）：
   *    代理**试写**标记（哪怕被挡住、字节没变）⇒ 该族的条件观测**一律作废**
   *    ⇒ 失败关闭：宁可没有证据，也不让"代理碰过的标记"当成受信事实。
   */
  const observationAfter = preconditionRef === undefined ? undefined
    : await reader(h.db, preconditionRef, familyClaim, false)
  check('G6', '代理**试写**标记（被拒、字节未变）⇒ 该族的条件观测**一律作废**（失败关闭）',
    observationAfter !== undefined && observationAfter.witnessed === false
    && observationAfter.complete === false && observationAfter.value === undefined,
    JSON.stringify({ witnessed: observationAfter?.witnessed, complete: observationAfter?.complete, value: observationAfter?.value }))
  check('G6', '试写标记 ⇒ 该族的证据**不再可用**（族规则因此拿不到资格）',
    (await snapshotPort.current(familyClaimId))?.usable === false,
    String((await snapshotPort.current(familyClaimId))?.status))

  }

  // -------------------------------------------------------------------------
  // 收尾读数
  // -------------------------------------------------------------------------
  check('G5', '整场门里**真实**任务的原生钩子零异常（异常都被记下来，没有被吞）',
    observerErrors.filter(item => item.startsWith('main')).length === 0,
    observerErrors.join(' | '))
  const receipts = await exec(h.db, sql`select count(distinct action_id)::int as count from character_action_events
    where character_id = ${String(characterId)} and payload::text like ${'%' + SANDBOX_CONDITION_RECEIPT_PREFIX + '%'}`,
  'f1 prereg negctl receipts')
  check('G5', '受信条件回执只出现在**动作账本**里（可核）',
    Number(receipts[0]?.count ?? 0) > 0, String(receipts[0]?.count))

  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({
    status: 'PASS', backend: 'postgres', selectedCase,
    evidenceKind: 'real_action_turn_real_gateway_real_files_offline_planner',
    world: WORLD_ID, measured_count: checks.length, checks, groups,
    findings,
    productionOpened: false, modelCalls: 0, humanAcceptance: 'NOT RUN',
    preregSources: ['worlds.json', 'tasks.json', 'oracle.json'],
  }, null, 2))
  console.log(`F1 预注册负控门（G3–G7）：${String(checks.length)}/${String(checks.length)}；${output}`)
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({
    status: 'FAIL', backend: 'postgres', checks, groups,
    error: error instanceof Error ? error.message : 'unknown',
  }, null, 2))
  throw error
} finally { await h.stop() }

/** 删掉一个文件（不存在也不算错）。 */
function rmSyncSafe(path: string): void {
  rmSync(path, { force: true })
}
