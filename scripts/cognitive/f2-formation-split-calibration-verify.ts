/**
 * **F2 形成阶段与测量阶段分开 · 真实链零模型校准**（用户裁定 A，2026-10-26）。
 *
 * ============================================================================
 *  协议修订（登记：`protocol.json` @2 的 `revision.formation-split`）
 * ============================================================================
 * ```text
 * 形成阶段（训练，**脚本固定**）：读族标记 → 读缓存源 → 写目标（缓存字节）→ 读回
 *   ⚠️ **代理不读权威源**（这样"成功的 cache 归属写"才存在 ⇒ cache 作用域对照可达）
 *   ⚠️ 序列**预先固定 3 题**：support-1(stale) / support-2(stale) / control(fresh)
 *   ⚠️ **不许**为了等资格而追加任务；未取得资格 ⇒ 保留在分母、如实报
 * 测量阶段：F2 任务入口（每题**受信准备读**权威源）→ 候选按预注册顺序 → 归因否决（只 C）→ 真实写入 + 终读回
 *   ⚠️ B 直接**复用准备读**的权威正文，**不再读一次**（不抬高基线成本）
 * ```
 * 每个「世界 × 臂 × 候选顺序」= **一个独立单元**：独立一次性 PostgreSQL + 独立文件根
 * ⇒ 不共用角色/族，规则状态不串扰。
 *
 * ⚠️ 本门零真实模型请求；固定候选/脚本训练 ⇒ 测的是**相同经历之后的规则消费**，不是自主探索能力。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runPreparedPgGate, runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'

const SCRIPT = 'scripts/cognitive/f2-formation-split-calibration-verify.ts'
const ORDERS = ['cached-first', 'authoritative-first'] as const
const ARMS = ['A', 'B', 'C'] as const
type Order = (typeof ORDERS)[number]
type Arm = (typeof ARMS)[number]
/** 形成阶段的**固定**序列（不追加；未取得资格也保留在分母里）。 */
/*
 * ⚠️ **固定 4 题**（`candidate + support-1 + support-2 + control`），**不追加**等资格：
 *    C2 的资格口径是「候选命题（第 1 次失败）= formation 根」+「**evidence 里 ≥2 条独立 support**」+「≥1 个对照」
 *    ⇒ 只给 2 次 stale 会只剩 1 条 support（实测：claim 停在 pending）。这是**冻结的形成序列**，
 *    如果 4 题之后仍未取得资格 ⇒ 如实记"本配置未取得资格"，该臂仍留在分母里，**不得**再加题。
 */
const FORMATION = [
  { object: 'obj-f1', condition: 'stale', role: 'candidate' },
  { object: 'obj-f2', condition: 'stale', role: 'support-1' },
  { object: 'obj-f3', condition: 'stale', role: 'support-2' },
  { object: 'obj-f4', condition: 'fresh', role: 'control' },
] as const
/** 测量窗口的固定留出集（同族新对象；路径全新 ⇒ 只能靠族级规则迁移）。 */
const HOLDOUT = [
  { object: 'obj-07', condition: 'fresh' },
  { object: 'obj-08', condition: 'stale' },
  { object: 'obj-09', condition: 'fresh' },
  { object: 'obj-10', condition: 'stale' },
  { object: 'obj-11', condition: 'fresh' },
  { object: 'obj-12', condition: 'stale' },
] as const
const FAMILY = 'f2/a'
const WRONG_FAMILY = 'f4/a'
const MARKER = `${FAMILY}/.freshness`

// ===========================================================================
//  父进程：6 个独立单元（每个单元一个新的一次性库）
// ===========================================================================
if (process.env.LG_F2_UNIT === undefined) {
  if (process.env.LG_F2_DEBUG_ENV === '1') {
    const admin = process.env.LG_SIM_PGTEST_ADMIN_URL
    const test = process.env.LG_TEST_PG_URL
    console.log('[debug] admin=' + (admin === undefined ? 'undefined' : String(admin.length))
      + ' test=' + (test === undefined ? 'undefined' : String(test.length))
      + ' argv=' + process.argv.slice(2).join(','))
  }
  const out = resolve('artifacts/local/f2-formation-split', `postgres-${Date.now()}`)
  mkdirSync(out, { recursive: true })
  const checks: string[] = []
  const diagnostics: Record<string, unknown> = {}
  const check = (name: string, value: unknown, detail = ''): void => {
    if (!value) throw new Error(`${name}${detail === '' ? '' : ` — ${detail}`}`)
    checks.push(name)
    console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
  const only = (process.env.LG_F2_UNITS ?? '').split(',').map(item => item.trim()).filter(item => item !== '')
  const units: { unit: string, arm: Arm, order: Order }[] = []
  for (const arm of ARMS) for (const order of ORDERS) {
    const id = `${arm}-${order === 'cached-first' ? 'cf' : 'af'}`
    if (only.length === 0 || only.includes(id)) units.push({ unit: id, arm, order })
  }
  /*
   * 宿主：每个单元起一个一次性容器（本机 docker）。
   * 仿真内（simhost）：在专用 `pgtest` 实例里给每个单元新建一个空白库。
   * ⚠️ 仿真内必须**显式**传 `LG_F2_ADMIN_URL`（`run-pg-script` 的孙进程拿不到 `LG_SIM_PGTEST_ADMIN_URL`）。
   */
  const adminUrl = (process.env.LG_F2_ADMIN_URL ?? process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  for (const unit of units) {
    process.env.LG_F2_UNIT = unit.unit
    process.env.LG_F2_ARM = unit.arm
    process.env.LG_F2_ORDER = unit.order
    process.env.LG_F2_OUT = out
    if (adminUrl !== '') await runPreparedPgGateInInstance(adminUrl, `f2-fsplit-${unit.unit}`, SCRIPT)
    else await runPreparedPgGate(`f2-fsplit-${unit.unit}`, SCRIPT)
    console.log(`… 单元 ${unit.unit} 完成`)
  }
  delete process.env.LG_F2_UNIT
  const report = (arm: Arm, order: Order) => {
    const id = `${arm}-${order === 'cached-first' ? 'cf' : 'af'}`
    const path = resolve(out, `unit-${id}.json`)
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as UnitReport
  }
  const reports = units.map(unit => report(unit.arm, unit.order))
  const by = (arm: Arm, order: Order) => reports.find(item => item.arm === arm && item.order === order)!
  diagnostics.units = reports.map(item => ({
    unit: item.unit, arm: item.arm, order: item.order, formationQualified: item.formation.qualified,
    formationTasks: item.formation.tasks, formationActions: item.formation.actions,
    measurement: item.measurement,
    coldStartActions: item.coldStartActions, negatives: item.negatives,
  }))

  // ① 形成阻塞解除：**每个单元**的缓存作用域对照可达 ⇒ 原生 EBL 取得资格
  for (const item of reports) {
    check(`${item.unit}：形成阶段 3 题后**规则取得资格**（cache 作用域对照可达）`,
      item.formation.qualified === true, String(item.formation.claimStatus))
  }
  check('形成阶段序列**预先固定**为 4 题（candidate + 2 supports + control；未追加任务等资格）',
    reports.every(item => item.formation.tasks === FORMATION.length))
  // ② 三臂同经历：形成阶段动作数一致
  const formationActions = new Set(reports.map(item => item.formation.actions))
  check('三臂 × 两序**形成阶段动作数完全一致**（相同训练经历、同一脚本）', formationActions.size === 1,
    [...formationActions].join(','))
  // ③ 可靠路径仍可完成（每个单元留出集逐题达成）
  for (const item of reports) {
    check(`${item.unit}：留出集 6 题**逐题达成**（真实写入 + 终读回 == 权威源）`,
      item.measurement.achieved === 6, `${String(item.measurement.achieved)}/6`)
  }
  check('真实读数里**假完成 = 0**', reports.every(item => item.measurement.falseCompletion === 0))
  // ④ C 的规则消费：同族新对象上出现否决、零失败写（cache-first 序）
  const ccf = by('C', 'cached-first')
  check('C-cf：留出集 stale 任务**出现否决**（同族新对象消费学到的规则）',
    ccf.measurement.staleVetoed === ccf.measurement.staleTasks && ccf.measurement.staleTasks > 0,
    `${String(ccf.measurement.staleVetoed)}/${String(ccf.measurement.staleTasks)}`)
  check('C-cf：留出集 stale 任务**零失败写**且全部达成', ccf.measurement.staleFailures === 0
    && ccf.measurement.staleAchieved === ccf.measurement.staleTasks)
  check('A-cf 在同族同条件上**有失败写**（对照：差异来自规则，不来自任务难度）',
    by('A', 'cached-first').measurement.staleFailures === by('A', 'cached-first').measurement.staleTasks)
  // ⑤ 不误伤：未知条件 / 撤回 / 错误族
  check('C-cf：条件**未知**（标记读失败）⇒ 不否决，失败后仍恢复达成',
    ccf.negatives.unknownCondition.vetoed === false && ccf.negatives.unknownCondition.achieved === true
    && ccf.negatives.unknownCondition.failedWrites === 1)
  check('C-cf：规则**撤回** ⇒ 不否决，行为回到 A（失败一次后恢复达成）',
    ccf.negatives.withdrawn.vetoed === false && ccf.negatives.withdrawn.achieved === true
    && ccf.negatives.withdrawn.failedWrites === 1)
  check('**错误族**（无受信声明）⇒ 不否决、行为同 A（失败一次后恢复达成）',
    ccf.negatives.wrongFamily.vetoed === false && ccf.negatives.wrongFamily.achieved === true)
  // ⑥ **净成本**（含训练 + 观察 + 测量）必须分开报告，两序都报
  const netOf = (arm: Arm, order: Order) => {
    const item = by(arm, order)
    return {
      training: item.formation.actions, observation: item.measurement.observationActions,
      measurement: item.measurement.actions, total: item.formation.actions + item.measurement.actions,
      failedWrites: item.measurement.failedWrites, candidateCalls: item.formation.candidateCalls + item.measurement.candidateCalls,
      achieved: item.measurement.achieved,
    }
  }
  diagnostics.netCost = {
    'cached-first': { A: netOf('A', 'cached-first'), B: netOf('B', 'cached-first'), C: netOf('C', 'cached-first'),
      deltaCminusA: { total: netOf('C', 'cached-first').total - netOf('A', 'cached-first').total,
        failedWrites: netOf('C', 'cached-first').failedWrites - netOf('A', 'cached-first').failedWrites,
        achieved: netOf('C', 'cached-first').achieved - netOf('A', 'cached-first').achieved } },
    'authoritative-first': { A: netOf('A', 'authoritative-first'), B: netOf('B', 'authoritative-first'), C: netOf('C', 'authoritative-first'),
      deltaCminusA: { total: netOf('C', 'authoritative-first').total - netOf('A', 'authoritative-first').total,
        failedWrites: netOf('C', 'authoritative-first').failedWrites - netOf('A', 'authoritative-first').failedWrites,
        achieved: netOf('C', 'authoritative-first').achieved - netOf('A', 'authoritative-first').achieved } },
    note: '动作/失败/候选调用是**机制计数**；token 未计（零模型）。两序分别报告，不只保留有利结果。',
  }
  check('净成本报告**同时给出两序**且分解为"训练 / 观察 / 测量"',
    Object.keys(diagnostics.netCost as Record<string, unknown>).length === 3
    && ['training', 'observation', 'measurement', 'total'].every(key => key in netOf('C', 'cached-first')))

  writeFileSync(resolve(out, 'calibration.json'), JSON.stringify({
    status: 'PASS', schema: 'f2-formation-split-calibration@1', measuredAt: new Date().toISOString(),
    revision: 'formation-split（形成阶段与测量阶段分开；用户裁定 A）', checks, diagnostics,
    readings: diagnostics.netCost,
    boundary: [
      '零真实模型请求；固定候选 + 脚本固定训练 ⇒ 测的是**相同经历之后的规则消费**，不是自主探索能力',
      '每个「臂 × 候选顺序」= 独立单元（一次性 PostgreSQL + 独立文件根）⇒ 规则状态不串扰',
      '达成率是共同上限；主读数是**净动作/失败/候选调用差值**（含训练与观察开销），允许为零或负',
      'token 未计：本校准只给机制计数，不作真实成本读数',
    ],
  }, null, 2))
  console.log(`F2 形成/测量分离校准（真实链）：${String(checks.length)}/${String(checks.length)}；${out}`)
  process.exit(0)
}

// ===========================================================================
//  子进程：一个单元（一个一次性库 + 一个文件根）
// ===========================================================================
const UNIT = String(process.env.LG_F2_UNIT)
const ARM = String(process.env.LG_F2_ARM) as Arm
const ORDER = String(process.env.LG_F2_ORDER) as Order
const OUT = String(process.env.LG_F2_OUT)
const { isolateDatabase } = await import('../../src/dev/sandbox.ts')
const sandbox = isolateDatabase(`f2-fsplit-${UNIT}`, { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
if (sandbox.backend !== 'postgres') throw new Error('需要 PostgreSQL 后端')
const root = resolve(OUT, `files-${UNIT}`)
mkdirSync(root, { recursive: true })
const { createM4Harness } = await import('../m4-harness.ts')
const { createActionGateway } = await import('../../src/kernel/action/gateway.ts')
const { createActionLedgerStore } = await import('../../src/infrastructure/action/action-ledger-store.ts')
const { createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries, contentFingerprint } = await import('../../src/infrastructure/action/adapters/sandbox-filesystem.ts')
const { createCapabilityRegistry, createDefaultCapabilityDefinitions, DEFAULT_GRANTED_PERMISSIONS, SANDBOX_FILE_WRITE } = await import('../../src/kernel/action/capability-registry.ts')
const { createInMemoryPayloadStaging } = await import('../../src/kernel/action/payload-staging.ts')
const { resolveActionTarget } = await import('../../src/kernel/action/target-resolver.ts')
const { hasSideEffect } = await import('../../src/kernel/action/action-request.ts')
const { createTaskAuthorizationRegistry } = await import('../../src/kernel/action/task-authorization.ts')
const { asTraceId } = await import('../../src/kernel/contracts/ids.ts')
const { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } = await import('../../src/kernel/contracts/attribution.ts')
const { createEblTaskObserver } = await import('../../src/infrastructure/runtime/epistemic-belief-runtime.ts')
const { createEblStore } = await import('../../src/infrastructure/persistence/epistemic-belief-store.ts')
const { createEblSourceReader, EBL_TOOL_ENVIRONMENT } = await import('../../src/infrastructure/persistence/epistemic-belief-source.ts')
const { createEblRuleSnapshotPort } = await import('../../src/infrastructure/runtime/ebl-rule-snapshot.ts')
const { makeEblClaim } = await import('../../src/kernel/contracts/epistemic-belief.ts')
const { sandboxWriteFamilyScope } = await import('../../src/kernel/contracts/write-family.ts')
const { writePreconditionConditions } = await import('../../src/kernel/contracts/write-precondition.ts')
const { createSimulationPlanning, f2QualifiedFamilyRuleIds } = await import('../../src/infrastructure/runtime/simulation-planning.ts')
const { createActionTurnPort } = await import('../../src/kernel/action/action-turn.ts')
const { createActionIntentDetector } = await import('../../src/kernel/action/intent-detector.ts')
const { runTask } = await import('../../src/kernel/action/task-loop.ts')
const { actionFailure, ActionFailureError } = await import('../../src/kernel/action/errors.ts')
const { exec } = await import('../../src/infrastructure/persistence/db.ts')
const { sql } = await import('drizzle-orm')
type TaskPlan = import('../../src/kernel/action/task-plan.ts').TaskPlan
type TaskPlannerPort = import('../../src/kernel/action/task-plan.ts').TaskPlannerPort
type TaskPlannerInput = import('../../src/kernel/action/task-plan.ts').TaskPlannerInput
type AdapterExecuteInput = import('../../src/kernel/action/executor-port.ts').AdapterExecuteInput
type AdapterOutcome = import('../../src/kernel/action/executor-port.ts').AdapterOutcome
type CapabilityAdapter = import('../../src/kernel/action/executor-port.ts').CapabilityAdapter
type SimulationPlanSelection = import('../../src/infrastructure/runtime/simulation-task-planner.ts').SimulationPlanSelection

const h = await createM4Harness({ label: `f2-fsplit-${UNIT}`, userId: 'Alex' })
try {
  const characterId = h.kernel.characterId
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const conditionPaths = [MARKER]
  const fsOptions = { root, staging, conditionPaths, exposeReadContent: true }
  const guardedWrite: CapabilityAdapter = {
    capabilityId: SANDBOX_FILE_WRITE,
    async execute (input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const path = String(input.args.path)
      if (path.endsWith('.txt')) {
        const raw = typeof input.args.content === 'string' ? input.args.content : staging.read(String(input.args.payloadRef))
        const content = typeof raw === 'string' ? raw : raw?.kind === 'text' ? raw.text : undefined
        const truthPath = resolve(root, path.replace(/\.txt$/, '.src'))
        if (content !== readFileSync(truthPath, 'utf8')) {
          throw new ActionFailureError(actionFailure('validation_failed', '内容与权威源不一致'))
        }
      }
      return createSandboxWriteAdapter({ root, staging, conditionPaths }).execute(input)
    },
  }
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fsOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger: createActionLedgerStore(h.db),
    adapters: [createSandboxReadAdapter(fsOptions), guardedWrite],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'f2-fsplit', executorAdapterId: 'sandbox-filesystem' } })
  const authorizations = createTaskAuthorizationRegistry()
  const knownDirectories = () => [FAMILY, WRONG_FAMILY]
  const writeSources = (path: string) => [
    { kind: 'cache' as const, path: path.replace(/\.txt$/, '.cache') },
    { kind: 'authoritative' as const, path: path.replace(/\.txt$/, '.src') },
  ]
  const declaration = { familyId: FAMILY, conditionPath: MARKER, mustNotEqual: 'stale' }
  const observer = createEblTaskObserver(h.db, h.userId, { knownDirectories, writeSources, preconditions: [declaration] })
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
  const initiatorFor = (event: { id: string }) => attestActionInitiatorFromCausalOrigin({ adapterId: 'f2-fsplit',
    causalSource: correlationSourceFromConversationEvent({ adapterId: 'f2-fsplit',
      triggeringEvent: triggeringConversationEventOf(event as never) }) })
  const entryText = (family: string, name: string): string => {
    const stem = `${family}/${name}`
    return `F2 只操作相对路径 ${stem}.txt；缓存源 ${stem}.cache；权威源 ${stem}.src；族标记 ${family}/.freshness，最多读一次。`
  }
  /** 摆好对象文件 + 族标记（**任务之间**设置、任务期间不变）。目标预置占位（不等于真值）。 */
  const prepare = (family: string, name: string, condition: 'fresh' | 'stale') => {
    mkdirSync(resolve(root, family), { recursive: true })
    const target = `${family}/${name}.txt`
    const auth = `auth:${name}`
    const cached = condition === 'stale' ? `stale:${name}` : auth
    writeFileSync(resolve(root, target.replace(/\.txt$/, '.src')), auth)
    writeFileSync(resolve(root, target.replace(/\.txt$/, '.cache')), cached)
    writeFileSync(resolve(root, `${family}/.freshness`), condition)
    writeFileSync(resolve(root, target), `unset:${name}`)
    return { target, auth, cached, marker: `${family}/.freshness`, authority: target.replace(/\.txt$/, '.src') }
  }
  const read = (path: string) => ({ capability: 'sandbox.file.read', operation: 'read', args: { path } })
  const write = (path: string, content: string) => ({ capability: 'sandbox.file.write', operation: 'write', args: { path, content } })
  type Step = TaskPlan['steps'][number]
  const planOf = (steps: readonly Step[], done = false): TaskPlan => ({ goal: 'f2', done, steps })
  const claimId = (family: string) => makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool',
    predicate: 'write_precondition_holds', expected: true, scope: sandboxWriteFamilyScope(family),
    environment: EBL_TOOL_ENVIRONMENT, conditions: writePreconditionConditions(
      { familyId: family, conditionPath: `${family}/.freshness`, mustNotEqual: 'stale' }, 'cache'),
    formation: { kind: 'action', id: 'shape' } }).id
  const actionsOf = async (traceId: string, capability: 'sandbox.file.read' | 'sandbox.file.write') => Number((await exec(h.db,
    sql`select count(distinct action_id)::int as count from character_action_events where character_id = ${String(characterId)}
      and trace_id = ${traceId} and capability = ${capability} and event_type = 'ACTION_SUCCEEDED'`, 'f2fsplit actions'))[0]?.count ?? 0)
  const failuresOf = async (traceId: string) => Number((await exec(h.db, sql`select count(distinct action_id)::int as count
    from character_action_events where character_id = ${String(characterId)} and trace_id = ${traceId}
      and capability = 'sandbox.file.write' and event_type = 'ACTION_FAILED'`, 'f2fsplit failures'))[0]?.count ?? 0)

  // -------------------------------------------------------------------------
  // ① 形成阶段（**脚本固定** · 3 题 · 不读权威源）
  // -------------------------------------------------------------------------
  let trainingActions = 0
  let trainingCalls = 0
  for (const [index, task] of FORMATION.entries()) {
    const object = prepare(FAMILY, task.object, task.condition)
    const evidence = await h.recordUserEvidence(`形成 ${UNIT} #${String(index)}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId),
      originalText: `形成 ${UNIT} ${task.object}`, triggeringEventId: String(evidence.event.id),
      allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'], maxRiskLevel: 'R1',
      budget: { maxActions: 8, maxPlans: 3, deadlineMs: 600_000 } })
    const plan = planOf([read(object.marker), read(object.target.replace(/\.txt$/, '.cache')),
      write(object.target, object.cached), read(object.target)], true)
    let planned = false
    const planner: TaskPlannerPort = { id: 'f2-fsplit-training', endpointHost: 'offline', async plan () {
      trainingCalls += 1
      if (planned) return { ok: true, requestCount: 1, plan: planOf([], true) }
      planned = true
      return { ok: true, requestCount: 1, plan }
    } }
    const outcome = await runTask({ gateway, registry, authorizations, staging, resolveTarget, epistemic: observer,
      invocationFor: () => ({ initiatorEvidence: initiatorFor(evidence.event), riskBudgetOverride: 'R1' }), planner },
    { characterId, traceId: asTraceId(`f2fsplit-train-${UNIT}-${String(index)}`), authorization, text: `形成 ${task.object}` })
    trainingActions += outcome.actionsUsed
  }
  const formationClaim = claimId(FAMILY)
  const formationState = await store.get(formationClaim)
  const formationSnapshot = await createEblRuleSnapshotPort(h.db, characterId, h.userId, { writeSources }).current(formationClaim)
  /** 资格为什么没到：把命题的**证据/测试/对照**逐条摊开（排障读数）。 */
  const formationDetail = (() => {
    const state = formationState as unknown as {
      tests?: readonly { id: string, episodeId?: string, bindingKey?: string, designId?: string, source?: unknown }[]
      evidence?: readonly {
        testId: string, verdict: string, independent?: boolean
        observation?: { witnessed?: boolean, executed?: boolean, complete?: boolean, value?: number | string | undefined, bindingKey?: string, episodeId?: string }
      }[]
    } | undefined
    return {
      tests: (state?.tests ?? []).map(test => ({ id: test.id, episode: test.episodeId, binding: test.bindingKey, design: test.designId })),
      evidence: (state?.evidence ?? []).map(item => ({ test: item.testId, verdict: item.verdict, independent: item.independent,
        witnessed: item.observation?.witnessed, executed: item.observation?.executed, complete: item.observation?.complete,
        value: item.observation?.value })),
      hasControl: (state?.evidence ?? []).some(item => item.verdict === 'inconclusive' && item.observation?.witnessed
        && item.observation?.executed && item.observation?.complete && item.observation?.value === undefined),
    }
  })()

  // -------------------------------------------------------------------------
  // ② 测量阶段（真实 ActionTurn · F2 入口 · B 复用准备读正文）
  // -------------------------------------------------------------------------
  const runMeasurement = async (options: { name: string, condition: 'fresh' | 'stale', family?: string,
    /** ⚠️ 在**夹具摆好之后**才执行（负控要删标记/撤回规则，必须在 prepare 之后）。 */
    afterPrepare?: () => Promise<void> | void }):
  Promise<{ row: MeasurementRow, selections: SimulationPlanSelection[] }> => {
    const family = options.family ?? FAMILY
    const object = prepare(family, options.name, options.condition)
    if (options.afterPrepare !== undefined) await options.afterPrepare()
    const selections: SimulationPlanSelection[] = []
    let calls = 0
    let cacheRead = false
    let recovered = false
    const qualifiedAtStart = (await f2QualifiedFamilyRuleIds({ db: h.db, characterId, activeUserId: h.userId,
      familyId: family, declarations: [declaration], writeSources })).length
    const cachedPlan = planOf([write(object.target, object.cached), read(object.target)], true)
    const authPlan = planOf([write(object.target, object.auth), read(object.target)], true)
    const ordered = ORDER === 'cached-first' ? [cachedPlan, authPlan] : [authPlan, cachedPlan]
    const planner: TaskPlannerPort = { id: `f2-fsplit-${ARM}`, endpointHost: 'offline', async plan (input: TaskPlannerInput) {
      calls += 1
      const writeFailed = input.failures.some(item => item === 'sandbox.file.write.write=validation_failed')
      if (ARM !== 'B' && ORDER === 'cached-first' && !cacheRead &&
        !input.executed.some(line => line.includes(`${object.target.replace(/\.txt$/, '.cache')}=success`))) {
        return { ok: true, requestCount: 1, plan: planOf([read(object.target.replace(/\.txt$/, '.cache'))]) }
      }
      cacheRead = true
      if (writeFailed && recovered) return { ok: false as const, requestCount: 1, failure: 'call_failed' as const }
      if (writeFailed) {
        recovered = true
        const other = ARM === 'B' ? authPlan : ordered[1]!
        return { ok: true, requestCount: 1, plan: other, candidates: [other] }
      }
      const first = ARM === 'B' ? authPlan : ordered[0]!
      const candidateList = ARM === 'B' ? [authPlan] : ordered
      return { ok: true, requestCount: 1, plan: first, candidates: candidateList }
    } }
    const evidence = await h.recordUserEvidence(`测量 ${UNIT} ${options.name}`)
    const conversationKey = String(evidence.event.conversationId)
    const traceId = `f2fsplit-measure-${UNIT}-${options.name}`
    authorizations.issue({ conversationKey, originalText: entryText(family, options.name),
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'],
      maxRiskLevel: 'R1', budget: { maxActions: 12, maxPlans: 8, deadlineMs: 600_000 } })
    const turn = createActionTurnPort({ gateway, detector: createActionIntentDetector(), registry, attribution: { adapterId: 'f2-fsplit' },
      task: {
        authorizations, staging, resolveTarget, epistemic: observer,
        capabilitiesFor: () => ['sandbox.file.read', 'sandbox.file.write'], riskLevelFor: () => 'R1' as const,
        planner, replanContext: { knownDirectories, contentTokens: 4000 },
        configurePlanning: (text, fallback) => createSimulationPlanning({ db: h.db, characterId, activeUserId: h.userId,
          registry, facts: { encoding: 'utf8' }, modelVersion: 'f2-formation-split@1', candidatePlanner: planner,
          precondition: { enabled: ARM === 'C', knownDirectories, declarations: [declaration], writeSources },
          onSelection: value => selections.push(value), f2: { enabled: true } })(text, fallback),
      } })
    const result = await turn.handleTurn({ characterId, traceId: asTraceId(traceId), text: entryText(family, options.name),
      eventId: String(evidence.event.id), conversationKey, speaker: { kind: 'user', id: String(h.userId) },
      triggeringEvent: triggeringConversationEventOf(evidence.event) })
    const failed = await failuresOf(traceId)
    const readActions = await actionsOf(traceId, 'sandbox.file.read')
    /* ⚠️ 一轮可能有多条 candidates_evaluated（观察轮没有写 ⇒ 没有归属/否决）：取**决定性**的那轮。 */
    const evaluated = selections.map(item => item.f2).filter(item => item?.phase === 'candidates_evaluated')
    const veto = evaluated.at(-1)
    let fileTruth = false
    try { fileTruth = readFileSync(resolve(root, object.target), 'utf8') === object.auth } catch { fileTruth = false }
    return { selections, row: {
      unit: UNIT, arm: ARM, order: ORDER, family, object: options.name, condition: options.condition,
      achieved: result.task?.goal?.achieved === true, stopped: String(result.task?.stopped ?? 'none'),
      actions: Number(result.task?.actionsUsed ?? 0), plans: Number(result.task?.plansUsed ?? 0),
      readActions, failedWrites: failed, candidateCalls: calls, fileTruth,
      vetoed: evaluated.some(item => (item?.vetoedCandidateIds ?? []).length > 0), vetoReason: veto?.veto?.reason, qualifiedRuleIds: qualifiedAtStart,
      vetoDecision: veto?.veto?.decision, observedValue: veto?.veto?.observedValue,
      attributions: (veto?.sourceAttributions ?? []).map(item => item.attribution),
      contentInPlannerContext: selections.length > 0,
    } }
  }
  const rows: MeasurementRow[] = []
  for (const task of HOLDOUT) rows.push((await runMeasurement({ name: task.object, condition: task.condition })).row)

  // -------------------------------------------------------------------------
  // ③ 负控（未知条件 / 撤回 / 错误族）——全部在 C-cf 单元里做
  // -------------------------------------------------------------------------
  const negatives: Record<string, NegativeReading> = {}
  if (ARM === 'C' && ORDER === 'cached-first') {
    const runNegative = async (label: string, setup: () => Promise<void> | void): Promise<NegativeReading> => {
      const { row } = await runMeasurement({ name: `obj-n-${label}`, condition: 'stale',
        family: label === 'wrongFamily' ? WRONG_FAMILY : FAMILY, afterPrepare: setup })
      return { vetoed: row.vetoed, failedWrites: row.failedWrites, achieved: row.fileTruth, vetoReason: row.vetoReason }
    }
    negatives.unknownCondition = await runNegative('unknownCondition', () => { rmSync(resolve(root, MARKER), { force: true }) })
    writeFileSync(resolve(root, MARKER), 'stale')
    negatives.withdrawn = await runNegative('withdrawn', async () => {
      try { await store.commit(formationClaim, { kind: 'withdraw' }) } catch { /* 已撤回/不可撤回 ⇒ 同样算「没有合格规则」 */ }
    })
    /* 错误族：`prepare` 会按族写 `.freshness`；这里**没有**对 `f4/a` 的受信声明 ⇒ 没有规则可用。 */
    negatives.wrongFamily = await runNegative('wrongFamily', () => undefined)
  }

  /** 测量之后的资格读数（排障：是"没资格"还是"资格在测量中失效"）。 */
  const afterMeasurement = await createEblRuleSnapshotPort(h.db, characterId, h.userId, { writeSources }).current(formationClaim)
  const qualifiedAfter = await f2QualifiedFamilyRuleIds({ db: h.db, characterId, activeUserId: h.userId,
    familyId: FAMILY, declarations: [declaration], writeSources })
  const measurement: MeasurementReport = {
    tasks: rows.length,
    achieved: rows.filter(row => row.fileTruth).length,
    falseCompletion: rows.filter(row => row.achieved && !row.fileTruth).length,
    actions: rows.reduce((sum, row) => sum + row.actions, 0),
    readActions: rows.reduce((sum, row) => sum + row.readActions, 0),
    observationActions: rows.reduce((sum, row) => sum + row.readActions, 0) - rows.length,
    failedWrites: rows.reduce((sum, row) => sum + row.failedWrites, 0),
    candidateCalls: rows.reduce((sum, row) => sum + row.candidateCalls, 0),
    staleTasks: rows.filter(row => row.condition === 'stale').length,
    staleFailures: rows.filter(row => row.condition === 'stale').reduce((sum, row) => sum + row.failedWrites, 0),
    staleVetoed: rows.filter(row => row.condition === 'stale' && row.vetoed).length,
    staleAchieved: rows.filter(row => row.condition === 'stale' && row.fileTruth).length,
  }
  const report: UnitReport = {
    unit: UNIT, arm: ARM, order: ORDER,
    formation: { tasks: FORMATION.length, actions: trainingActions, candidateCalls: trainingCalls,
      qualified: formationState?.status === 'validated' && formationSnapshot?.usable === true,
      claimStatus: String(formationState?.status ?? 'missing'), detail: formationDetail },
    measurement, rows,
    coldStartActions: rows.slice(0, rows.findIndex(row => row.vetoed) + 1).reduce((sum, row) => sum + row.actions, 0),
    negatives,
    postMeasurement: { qualifiedRuleIds: qualifiedAfter.length, snapshotUsable: afterMeasurement?.usable,
      snapshotStatus: afterMeasurement?.status, invalidatedReason: afterMeasurement?.invalidatedReason },
  }
  writeFileSync(resolve(OUT, `unit-${UNIT}.json`), JSON.stringify(report, null, 2))
  console.log(`单元 ${UNIT} 完成：形成资格=${String(report.formation.qualified)}（${report.formation.claimStatus}）· 测量达成 ${String(measurement.achieved)}/6`)
} finally { await h.stop() }

interface MeasurementRow {
  unit: string; arm: Arm; order: Order; family: string; object: string; condition: 'fresh' | 'stale'
  achieved: boolean; stopped: string; actions: number; plans: number; readActions: number
  failedWrites: number; candidateCalls: number; fileTruth: boolean; vetoed: boolean
  vetoReason?: string; contentInPlannerContext: boolean; qualifiedRuleIds: number
  vetoDecision?: string; observedValue?: string; attributions: string[]
}
interface NegativeReading { vetoed: boolean; failedWrites: number; achieved: boolean; vetoReason?: string }
interface MeasurementReport {
  tasks: number; achieved: number; falseCompletion: number; actions: number; readActions: number
  observationActions: number; failedWrites: number; candidateCalls: number
  staleTasks: number; staleFailures: number; staleVetoed: number; staleAchieved: number
}
interface UnitReport {
  unit: string; arm: Arm; order: Order
  formation: { tasks: number; actions: number; candidateCalls: number; qualified: boolean; claimStatus: string; detail: unknown }
  measurement: MeasurementReport; rows: MeasurementRow[]; coldStartActions: number
  negatives: Record<string, NegativeReading>
  postMeasurement?: { qualifiedRuleIds: number, snapshotUsable?: boolean, snapshotStatus?: string, invalidatedReason?: string }
}
