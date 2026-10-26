/**
 * **R4 §3.9 第 2–3 步门**：一条**真实 ActionTurn 闭环** + 真实链负控（**零模型请求**）。
 *
 * ============================================================================
 *  它证明什么（每一条都来自真实动作，不来自自述）
 * ============================================================================
 * ```text
 * ① 装配：合法 F2 请求 ⇒ 逐路径范围（两源只读 / 族标记限次一次 / 目标可写+读回）
 * ② 受信准备读：**占 1 动作 / 1 规划轮**、经 Gateway 真的读到权威源正文，
 *    正文进规划上下文（`TaskPlannerInput.content`）、其指纹成为本任务目标真值
 *    （`trustedReads` ⇒ `deriveF2GoalFingerprint`）
 * ③ 失败写 + 对照成功：缓存字节写入被**内容真值守卫**拒（`validation_failed`），
 *    权威字节写入成功 ⇒ 原生 EBL 取得**来源限定**资格
 * ④ 同族新对象消费：族级标记**每题重读一次** ⇒ 规划器**只否决缓存来源候选** ⇒
 *    真实写入权威字节 + **最后成功读回** == 真值 ⇒ 任务 `done`
 * ⑤ 真实链负控：越界读 / 写源文件 / 写标记 / 重复标记读（任务环逐路径闸）、
 *    无资格普通规划、规则撤回、**A 失败后换策略恢复**、假完成判废
 * ```
 *
 * ⚠️ 边界（必须读）：
 *  · F2 任务原话（单行闭集）**不被** `looksLikeTask` 认成任务形 ⇒ 本门从
 *    **已签发授权的会话键**进入 ActionTurn（生产里"继续一个已开任务"的同一条路）。
 *    这本身就是一个读数：F2 入口只能由**装配层解析**，不能靠词形。
 *  · 固定候选规划器 ⇒ 只证明**机制**，**不**构成收益读数、不冒充真实模型行为。
 *  · 准备读与族标记读是 F2 每题**固定付**的成本（三臂同口径）；本门不作成本比较。
 *  · 零真实模型请求。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runPreparedPgGate, runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'
import { isolateDatabase } from '../../src/dev/sandbox.ts'

if (process.env.LG_F2_CLOSED_LOOP_PG_CHILD !== '1') {
  process.env.LG_F2_CLOSED_LOOP_PG_CHILD = '1'
  const admin = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  if (admin) await runPreparedPgGateInInstance(admin, 'f2-closed-loop', 'scripts/cognitive/f2-actionturn-closed-loop-verify.ts')
  else await runPreparedPgGate('f2-closed-loop', 'scripts/cognitive/f2-actionturn-closed-loop-verify.ts')
  process.exit(0)
}
const sandbox = isolateDatabase('f2-closed-loop', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
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
import { runTask } from '../../src/kernel/action/task-loop.ts'
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
import { selectUsableRules } from '../../src/kernel/contracts/cognitive-collaboration.ts'
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import { writePreconditionConditions } from '../../src/kernel/contracts/write-precondition.ts'
import {
  createSimulationPlanning, deriveF2GoalFingerprint, resolveF2EntryScope,
} from '../../src/infrastructure/runtime/simulation-planning.ts'
import type { SimulationPlanSelection } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import { createActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import { createActionIntentDetector } from '../../src/kernel/action/intent-detector.ts'
import { exec } from '../../src/infrastructure/persistence/db.ts'
import { sql } from 'drizzle-orm'
import { actionFailure, ActionFailureError } from '../../src/kernel/action/errors.ts'
import type { AdapterExecuteInput, AdapterOutcome, CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'

const output = resolve('artifacts/local/f2-actionturn-closed-loop', `postgres-${Date.now()}`)
mkdirSync(output, { recursive: true })
const root = mkdtempSync(resolve(output, 'files-'))
/** 主族（有受信声明、会形成规则）与**无声明族**（用来验"无资格普通规划"与范围闸）。 */
const FAMILY = 'f1/a'
const OTHER = 'f1/b'
const MARKER = `${FAMILY}/.freshness`
const OTHER_MARKER = `${OTHER}/.freshness`
mkdirSync(resolve(root, FAMILY), { recursive: true })
mkdirSync(resolve(root, OTHER), { recursive: true })

const h = await createM4Harness({ label: 'f2-closed-loop', userId: 'Alex' })
const checks: string[] = []
/** 失败时带出的**诊断读数**（只为排障；不参与判定）。 */
const diagnostics: Record<string, unknown> = {}
function check (name: string, value: unknown, detail = ''): void {
  assert.ok(value, `${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

try {
  const characterId = h.kernel.characterId
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const staging = createInMemoryPayloadStaging()
  const conditionPaths = [MARKER, OTHER_MARKER]
  /*
   * **内容真值守卫**（协议 §3.2 / R5）：写目标（`.txt`）的字节必须与权威源（`.src`）逐字节相同，
   * 否则 `validation_failed`。**始终只按内容真值判断**（不看标签、不看候选自述）。
   */
  const guardedWrite: CapabilityAdapter = {
    capabilityId: SANDBOX_FILE_WRITE,
    async execute (input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const path = String(input.args.path)
      if (path.endsWith('.txt')) {
        const raw = typeof input.args.content === 'string'
          ? input.args.content
          : staging.read(String(input.args.payloadRef))
        const content = typeof raw === 'string' ? raw : raw?.kind === 'text' ? raw.text : undefined
        const truth = readFileSync(resolve(root, path.replace(/\.txt$/, '.src')), 'utf8')
        if (content !== truth) {
          throw new ActionFailureError(actionFailure('validation_failed', '内容与权威源不一致'))
        }
      }
      return createSandboxWriteAdapter({ root, staging, conditionPaths }).execute(input)
    },
  }
  /* ⚠️ exposeReadContent: true ⇒ 读到正文进当轮内容管线（只在本门/ F2 世界装配里打开；缺省关闭）。 */
  const fsOptions = { root, staging, conditionPaths, exposeReadContent: true }
  const resolveTarget = async ({ request, operation }: Parameters<Parameters<typeof createActionGateway>[0]['resolveTarget']>[0]) =>
    resolveActionTarget({ targetType: 'sandbox_file', hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(fsOptions), allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect) })
  const gateway = createActionGateway({ registry, ledger: createActionLedgerStore(h.db),
    adapters: [createSandboxReadAdapter(fsOptions), guardedWrite],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'f2-r4-closed-loop', executorAdapterId: 'sandbox-filesystem' } })
  const authorizations = createTaskAuthorizationRegistry()
  const knownDirectories = () => [FAMILY, OTHER]
  const writeSources = (path: string) => [
    { kind: 'cache' as const, path: path.replace(/\.txt$/, '.cache') },
    { kind: 'authoritative' as const, path: path.replace(/\.txt$/, '.src') },
  ]
  const declaration = { familyId: FAMILY, conditionPath: MARKER, mustNotEqual: 'stale' }
  const observer = createEblTaskObserver(h.db, h.userId, { knownDirectories, writeSources, preconditions: [declaration] })
  const store = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
  const initiatorFor = (event: { id: string }) => attestActionInitiatorFromCausalOrigin({ adapterId: 'f2-r4-closed-loop',
    causalSource: correlationSourceFromConversationEvent({ adapterId: 'f2-r4-closed-loop',
      triggeringEvent: triggeringConversationEventOf(event as never) }) })

  /** F2 任务原话（单行闭集，与冻结规格逐字同形）。 */
  const entryText = (family: string, name: string): string => {
    const stem = `${family}/${name}`
    return `F2 只操作相对路径 ${stem}.txt；缓存源 ${stem}.cache；权威源 ${stem}.src；族标记 ${family}/.freshness，最多读一次。`
  }
  /** 夹具：写三个文件（权威源 / 缓存 / 族标记）。 */
  const prepare = (family: string, name: string, stale: boolean): { path: string, auth: string, cached: string } => {
    const path = `${family}/${name}.txt`
    const auth = `auth:${name}`
    const cached = stale ? `stale:${name}` : auth
    writeFileSync(resolve(root, path.replace(/\.txt$/, '.src')), auth)
    writeFileSync(resolve(root, path.replace(/\.txt$/, '.cache')), cached)
    writeFileSync(resolve(root, `${family}/.freshness`), stale ? 'stale' : 'fresh')
    return { path, auth, cached }
  }
  const read = (path: string) => ({ capability: 'sandbox.file.read', operation: 'read', args: { path } })
  const write = (path: string, content: string) => ({ capability: 'sandbox.file.write', operation: 'write', args: { path, content } })
  type F2Step = TaskPlan['steps'][number]
  /** 组装一份计划（`done` 决定执行完这批之后是否宣称完成；完成与否由程序判定）。 */
  const planOf = (steps: readonly F2Step[], done = false): TaskPlan => ({ goal: 'f2 step', done, steps })

  // -------------------------------------------------------------------------
  // ① 入口解析（纯函数）：准备读路径**必须**是权威源
  // -------------------------------------------------------------------------
  const pureEntry = resolveF2EntryScope({ enabled: true, text: entryText(FAMILY, 'obj-01') })
  check('入口：合法 F2 请求 ⇒ 解析成 entry 且准备读路径 = **权威源**',
    pureEntry.kind === 'entry' && pureEntry.prepReadPath === `${FAMILY}/obj-01.src`,
    String(pureEntry.kind))
  check('真值派生：没有受信读回执 ⇒ **不给**指纹（不猜内容）',
    deriveF2GoalFingerprint({ targetPath: `${FAMILY}/obj-01.txt`, authoritativeSource: `${FAMILY}/obj-01.src` }) === undefined)
  check('真值派生：有**本任务**对权威源的成功读回执 ⇒ 指纹 = 该回执',
    deriveF2GoalFingerprint({ targetPath: `${FAMILY}/obj-01.txt`, authoritativeSource: `${FAMILY}/obj-01.src`,
      trustedReads: [{ path: `${FAMILY}/obj-01.src`, fingerprint: contentFingerprint('x') },
        { path: `${FAMILY}/obj-01.cache`, fingerprint: contentFingerprint('y') }] })
      ?.goalFingerprint === contentFingerprint('x'))

  const readCount = async (traceId: string, path: string) => Number((await exec(h.db, sql`select count(distinct action_id)::int as count
    from character_action_events where character_id = ${String(characterId)} and trace_id = ${traceId}
    and capability = 'sandbox.file.read' and operation = 'read' and payload->'target'->>'canonicalId' = ${path}`,
  'f2 read count'))[0]?.count ?? 0)
  const writeCount = async (traceId: string, path: string) => Number((await exec(h.db, sql`select count(distinct action_id)::int as count
    from character_action_events where character_id = ${String(characterId)} and trace_id = ${traceId}
    and capability = 'sandbox.file.write' and operation = 'write' and event_type = 'ACTION_SUCCEEDED'
    and payload->'target'->>'canonicalId' = ${path}`, 'f2 write count'))[0]?.count ?? 0)
  /** 某条路径在某 trace 里的**动作条数**（逐路径闸的证据：被拒的步骤不产生动作）。 */
  const eventCount = async (traceId: string, path: string, operation?: 'read' | 'write') =>
    Number((await exec(h.db, sql`select count(distinct action_id)::int as count from character_action_events
      where character_id = ${String(characterId)} and trace_id = ${traceId}
        and payload->'target'->>'canonicalId' = ${path}
        ${operation === undefined ? sql`` : sql`and operation = ${operation}`}`, 'f2 event count'))[0]?.count ?? 0)
  /** 某条路径在某 trace 里**被拒/失败**的动作数（"第二次读被挡"的证据）。 */
  const rejectedCount = async (traceId: string, path: string) =>
    Number((await exec(h.db, sql`select count(distinct action_id)::int as count from character_action_events
      where character_id = ${String(characterId)} and trace_id = ${traceId}
        and payload->'target'->>'canonicalId' = ${path}
        and event_type in ('ACTION_REJECTED', 'ACTION_FAILED')`, 'f2 rejected count'))[0]?.count ?? 0)
  const firstReadPath = async (traceId: string) => {
    const rows = await exec(h.db, sql`select payload->'target'->>'canonicalId' as path from character_action_events
      where character_id = ${String(characterId)} and trace_id = ${traceId} and capability = 'sandbox.file.read'
      and event_type = 'ACTION_SUCCEEDED'
      order by sequence asc limit 1`, 'f2 first read')
    return rows[0]?.path as string | undefined
  }

  // -------------------------------------------------------------------------
  // ② 形成：真实链上的失败写 + 对照成功 ⇒ 原生 EBL **来源限定**资格（缓存来源）
  // -------------------------------------------------------------------------
  let ordinal = 0
  /** 普通任务（不经 F2 入口）：只用来形成规则。 */
  const formationTask = async (plan: TaskPlan) => {
    ordinal += 1
    const evidence = await h.recordUserEvidence(`F2 形成任务 ${String(ordinal)}`)
    const authorization = authorizations.issue({ conversationKey: String(evidence.event.conversationId),
      originalText: `F2 形成 ${String(ordinal)}`, triggeringEventId: String(evidence.event.id),
      allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'], maxRiskLevel: 'R1',
      budget: { maxActions: 8, maxPlans: 4, deadlineMs: 600_000 } })
    let planned = false
    const planner: TaskPlannerPort = { id: 'f2-formation', endpointHost: 'offline', async plan () {
      if (planned) return { ok: true, requestCount: 1, plan: { goal: '结束', done: true, steps: [] } }
      planned = true
      return { ok: true, requestCount: 1, plan }
    } }
    return await runTask({ gateway, registry, authorizations, staging, resolveTarget, epistemic: observer,
      invocationFor: () => ({ initiatorEvidence: initiatorFor(evidence.event), riskBudgetOverride: 'R1' }), planner },
    { characterId, traceId: asTraceId(`f2-form-${String(ordinal)}`), authorization, text: `F2 形成 ${String(ordinal)}` })
  }
  for (let n = 1; n <= 6; n += 1) {
    const stale = n <= 3
    const object = prepare(FAMILY, `learn-${String(n)}`, stale)
    const result = await formationTask({ goal: 'copy source', done: true, steps: [
      read(MARKER), read(object.path.replace(/\.txt$/, '.cache')), write(object.path, object.cached), read(object.path),
    ] })
    check(`形成 ${String(n)}：观察者零失败`, (result.epistemicFailures ?? 0) === 0)
    check(`形成 ${String(n)}：${stale ? '缓存字节被**内容真值守卫**拒（且没有写出目标）' : '对照：权威字节写入成功且读回一致'}`,
      stale
        ? !existsSync(resolve(root, object.path)) && result.results.some(item => item.result.error?.code === 'validation_failed')
        : readFileSync(resolve(root, object.path), 'utf8') === object.auth)
  }
  const claimId = makeEblClaim({ characterId: String(characterId), subjectId: h.userId, domain: 'tool',
    predicate: 'write_precondition_holds', expected: true, scope: sandboxWriteFamilyScope(FAMILY),
    environment: EBL_TOOL_ENVIRONMENT, conditions: writePreconditionConditions(declaration, 'cache'),
    formation: { kind: 'action', id: 'shape' } }).id
  check('形成：原生 EBL 取得**缓存来源限定**资格（≥2 不同绑定 + 对照）',
    (await store.get(claimId))?.status === 'validated', String((await store.get(claimId))?.status))

  // 诊断：快照面到底怎么看这条命题（资格 / 来源 / 条件）。
  {
    const port = createEblRuleSnapshotPort(h.db, characterId, h.userId, { writeSources })
    const snapshot = await port.current(claimId)
    const selection = selectUsableRules({ snapshots: snapshot === undefined ? [] : [snapshot], visible: {
      subjectId: h.userId, scope: sandboxWriteFamilyScope(FAMILY), environment: EBL_TOOL_ENVIRONMENT,
      conditions: writePreconditionConditions(declaration, 'cache') } })
    diagnostics.claim = { found: snapshot !== undefined, usable: snapshot?.usable, status: snapshot?.status,
      scope: snapshot?.scope, conditions: snapshot?.conditions, sources: snapshot?.sources?.length,
      selected: selection.selected.length, skipped: selection.skipped }
  }

  // -------------------------------------------------------------------------
  // ③ 一条真实 ActionTurn 闭环：准备读 → 标记读 → 候选 → **否决** → 真实写入 + 读回
  // -------------------------------------------------------------------------
  /** 固定候选来源（按轮次给候选；每轮一次"模型请求"，本门零真实请求）。 */
  const candidateSource = (rounds: readonly (readonly TaskPlan[])[]) => {
    let round = 0
    const inputs: TaskPlannerInput[] = []
    const planner: TaskPlannerPort = { id: 'f2-candidates', endpointHost: 'offline', async plan (input) {
      inputs.push(input)
      const plans = rounds[Math.min(round, rounds.length - 1)]!
      round += 1
      return { ok: true, requestCount: 1, plan: plans[0]!, candidates: plans }
    } }
    return { planner, inputs }
  }
  /** 普通规划器（F2 链里"没有合格规则"时的兜底 / 负控探针）；每轮给一份计划。 */
  const probePlanner = (rounds: readonly (readonly F2Step[])[]) => {
    let round = 0
    const planner: TaskPlannerPort = { id: 'f2-probe', endpointHost: 'offline', async plan () {
      const steps = rounds[Math.min(round, rounds.length - 1)] ?? []
      round += 1
      return { ok: true, requestCount: 1, plan: planOf(steps, true) }
    } }
    return planner
  }
  const selectionsOf = () => {
    const selections: SimulationPlanSelection[] = []
    return { selections, push: (value: SimulationPlanSelection) => selections.push(value) }
  }
  /** 规划器实际收到的输入（**排障用**：executed 行的真实格式只由执行环决定）。 */
  const plannerTrace: { label: string, executed: readonly string[], trustedReads: readonly string[] }[] = []
  /** 从**已签发授权的会话键**进入 ActionTurn（生产里"继续一个已开任务"的同一条路）。 */
  const runTurn = async (options: {
    label: string
    entry: string
    candidatePlanner: TaskPlannerPort
    fallback: TaskPlannerPort
    selections: { push: (value: SimulationPlanSelection) => void }
    declarations?: readonly { familyId: string, conditionPath: string, mustNotEqual: string }[]
  }) => {
    const evidence = await h.recordUserEvidence(`F2 闭环 ${options.label}`)
    const conversationKey = String(evidence.event.conversationId)
    const traceId = `f2-closed-${options.label}`
    authorizations.issue({ conversationKey, originalText: options.entry, triggeringEventId: String(evidence.event.id),
      allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'], maxRiskLevel: 'R1',
      budget: { maxActions: 12, maxPlans: 8, deadlineMs: 600_000 } })
    const turn = createActionTurnPort({ gateway, detector: createActionIntentDetector(), registry,
      attribution: { adapterId: 'f2-r4-closed-loop' },
      task: {
        authorizations, staging, resolveTarget, epistemic: observer,
        capabilitiesFor: () => ['sandbox.file.read', 'sandbox.file.write'],
        riskLevelFor: () => 'R1' as const,
        planner: options.fallback,
        replanContext: { knownDirectories, contentTokens: 4000 },
        configurePlanning: async (text, fallback) => {
          const configured = await createSimulationPlanning({
            db: h.db, characterId, activeUserId: h.userId, registry, facts: { encoding: 'utf8' },
            modelVersion: 'f2-closed-loop@1', candidatePlanner: options.candidatePlanner,
            precondition: { enabled: true, knownDirectories, declarations: (options.declarations ?? [declaration]) as never, writeSources },
            onSelection: options.selections.push,
            f2: { enabled: true },
          })(text, fallback)
          if (configured === undefined) return undefined
          const inner = configured.planner
          return { ...configured, planner: { id: 'f2-trace', endpointHost: 'none',
            async plan (input: TaskPlannerInput) {
              plannerTrace.push({ label: options.label, executed: [...input.executed],
                trustedReads: (input.trustedReads ?? []).map(item => `${item.path}@${item.fingerprint.slice(0, 8)}`) })
              return inner.plan(input)
            } } }
        },
      } })
    const result = await turn.handleTurn({ characterId, traceId: asTraceId(traceId), text: options.entry,
      eventId: String(evidence.event.id), conversationKey, speaker: { kind: 'user', id: String(h.userId) },
      /*
       * ⚠️ **权威归因**必须给（K-27）：来源归属读面按 `initiator_kind=USER, initiator_id=<用户>` 过滤；
       *    缺了它 ⇒ 受信读回执一条都读不到 ⇒ 归属恒 `unknown` ⇒ 规则**永不消费**（本轮实测抓到过）。
       */
      triggeringEvent: triggeringConversationEventOf(evidence.event) })
    return { result, traceId }
  }
  const outcomeOf = (result: { task?: { stopped: string, goal?: { achieved: boolean } } }): { stopped: string, achieved: boolean } =>
    ({ stopped: result.task?.stopped ?? 'none', achieved: result.task?.goal?.achieved === true })
  /** 一次 ActionTurn 里**每步**的闭集结果码（含失败码），用来断言"这一步真的被拒了"。 */
  const codesOf = (result: { result?: { error?: { code: string } }, followUps?: readonly { result?: { error?: { code: string } } }[] }) =>
    [result.result, ...(result.followUps ?? []).map(item => item.result)]
      .map(item => item?.error?.code).filter((code): code is string => typeof code === 'string')

  const mainObject = prepare(FAMILY, 'obj-10', true)
  const mainSelections = selectionsOf()
  const mainCandidate = candidateSource([
    // 第 1 轮：**只读缓存源**（取得缓存字节；下一步再按来源归属决定写谁的字节）
    [planOf([read(mainObject.path.replace(/\.txt$/, '.cache'))])],
    // 第 2 轮：两个候选 —— 缓存字节 vs 权威字节
    [planOf([write(mainObject.path, mainObject.cached), read(mainObject.path)], true),
      planOf([write(mainObject.path, mainObject.auth), read(mainObject.path)], true)],
  ])
  const main = await runTurn({ label: 'main-stale', entry: entryText(FAMILY, 'obj-10'), candidatePlanner: mainCandidate.planner,
    fallback: probePlanner([[]]), selections: mainSelections })
  const mainOutcome = outcomeOf(main.result)
  diagnostics.main = {
    stopped: mainOutcome.stopped, achieved: mainOutcome.achieved,
    plansUsed: main.result.task?.plansUsed, actionsUsed: main.result.task?.actionsUsed,
    steps: main.result.task?.steps, planRejectedCode: (main.result.task as { planRejectedCode?: string } | undefined)?.planRejectedCode,
    selectionPhases: mainSelections.selections.map(value => ({ reason: value.reason, ...value.f2 })),
    inputs: mainCandidate.inputs.map(input => ({ executed: input.executed, failures: input.failures,
      remainingActions: input.remainingActions, trustedReads: input.trustedReads,
      contentLines: (input.content ?? []).length })),
    rows: await (async () => await exec(h.db, sql`select capability, operation, event_type,
      payload->'target'->>'canonicalId' as target from character_action_events
      where character_id = ${String(characterId)} and trace_id = ${main.traceId} order by sequence asc`, 'f2 main rows'))(),
    resultCodes: codesOf(main.result),
    plannerTrace: plannerTrace.filter(item => item.label === 'main-stale'),
  }
  check('主链：任务真的报完成（目标达成）', mainOutcome.stopped === 'done' && mainOutcome.achieved,
    `${mainOutcome.stopped}/${String(mainOutcome.achieved)}`)
  check('主链：第 1 个真实动作是**读权威源**（受信准备读，经 Gateway）',
    await firstReadPath(main.traceId) === `${FAMILY}/obj-10.src`, String(await firstReadPath(main.traceId)))
  check('主链：权威源只被读 1 次（准备读占 1 动作）', await readCount(main.traceId, `${FAMILY}/obj-10.src`) === 1)
  check('主链：族标记被读 1 次（每题重读，不沿用上一题）', await readCount(main.traceId, MARKER) === 1)
  check('主链：缓存源被读 1 次（来源归属需要**本任务**的真实读回执）',
    await readCount(main.traceId, `${FAMILY}/obj-10.cache`) === 1)
  check('主链：**源正文进了规划上下文**（`content` 里有权威源正文）+ **受信指纹**可用',
    mainCandidate.inputs.some(input => (input.content ?? []).some(line => line.includes(mainObject.auth)))
    && mainCandidate.inputs.some(input => (input.trustedReads ?? []).some(item =>
      item.path === `${FAMILY}/obj-10.src` && item.fingerprint === contentFingerprint(mainObject.auth))),
    `${String(mainCandidate.inputs.length)} 次规划输入`)
  const markerRead = mainSelections.selections.find(value => value.f2?.phase === 'marker_read_scheduled')
  check('主链：族标记读由**程序安排**（零模型请求、只占 1 规划轮）',
    markerRead?.f2?.goalFingerprint === contentFingerprint(mainObject.auth))
  const evaluated = mainSelections.selections.filter(value => value.f2?.phase === 'candidates_evaluated')
  const vetoReading = evaluated.map(value => value.f2).find(value => value?.veto?.decision === 'veto')
  check('主链：**只否决缓存来源候选**（同族新对象消费学到的规则）',
    JSON.stringify(vetoReading?.vetoedCandidateIds) === '["0"]', JSON.stringify(vetoReading?.vetoedCandidateIds ?? null))
  check('主链：否决读数齐全（理由 / 观测值 / 来源作用域 / 回退）',
    vetoReading?.veto?.reason === 'precondition_violated' && vetoReading.veto.observedValue === 'stale'
    && vetoReading.veto.sourceScope === 'cache' && vetoReading.veto.fallback === 'default_order'
    && vetoReading.veto.claimId === claimId)
  check('主链：每个候选的**受信来源归属**（缓存 / 权威）',
    JSON.stringify((vetoReading?.sourceAttributions ?? []).map(item => item.attribution)) === '["cache","authoritative"]',
    JSON.stringify(vetoReading?.sourceAttributions ?? null))
  check('主链：选中权威来源候选（默认顺序里第一个未被否决的）', vetoReading?.selectedCandidateId === '1')
  check('主链：真实写入权威字节（账本里 1 次成功写）', await writeCount(main.traceId, mainObject.path) === 1)
  check('主链：目标文件内容 == 权威源内容（程序真值）',
    readFileSync(resolve(root, mainObject.path), 'utf8') === mainObject.auth)
  check('主链：**没有**发生被守卫拒绝的写（缓存字节从未被尝试）',
    !JSON.stringify(main.result).includes('validation_failed'))

  // -------------------------------------------------------------------------
  // ④ 对照：族标记 fresh（缓存 == 权威）⇒ **不否决**，写缓存字节照样达成
  // -------------------------------------------------------------------------
  const freshObject = prepare(FAMILY, 'obj-11', false)
  const freshSelections = selectionsOf()
  const freshCandidate = candidateSource([
    [planOf([read(freshObject.path.replace(/\.txt$/, '.cache'))])],
    [planOf([write(freshObject.path, freshObject.cached), read(freshObject.path)], true),
      planOf([write(freshObject.path, freshObject.auth), read(freshObject.path)], true)],
  ])
  const fresh = await runTurn({ label: 'main-fresh', entry: entryText(FAMILY, 'obj-11'), candidatePlanner: freshCandidate.planner,
    fallback: probePlanner([[]]), selections: freshSelections })
  const freshOutcome = outcomeOf(fresh.result)
  const freshVeto = freshSelections.selections.map(value => value.f2).find(value => value?.phase === 'candidates_evaluated')
  check('对照：条件成立 ⇒ **不否决**（`condition_not_violated` 或来源相同 ⇒ 归属不明）',
    freshVeto?.veto?.decision === 'no_veto' && freshVeto.vetoedCandidateIds?.length === 0, String(freshVeto?.veto?.reason))
  check('对照：依旧真实写入 + 读回一致 + 目标达成',
    freshOutcome.stopped === 'done' && freshOutcome.achieved
    && readFileSync(resolve(root, freshObject.path), 'utf8') === freshObject.auth)

  // -------------------------------------------------------------------------
  // ⑤ 真实链负控：逐路径闸（越界读 / 写源 / 写标记 / 重复标记读）
  //    ⚠️ 用**无受信声明族** f1/b ⇒ 没有合格规则 ⇒ **普通规划**（F2 范围照样挂着）
  // -------------------------------------------------------------------------

  prepare(OTHER, 'other-1', true)
  const noRuleSelections = selectionsOf()
  const outOfScope = await runTurn({ label: 'scope-read', entry: entryText(OTHER, 'other-1'),
    candidatePlanner: candidateSource([[planOf([read(`${OTHER}/x.txt`)])]]).planner,
    fallback: probePlanner([[read(`${OTHER}/x.txt`)]]), selections: noRuleSelections })
  check('负控·无资格：装配走**普通规划**（读数 `ordinary_planning_no_rule`），不假装有规则',
    noRuleSelections.selections.some(value => value.f2?.phase === 'ordinary_planning_no_rule'))
  check('负控·无资格：**没有**安排族标记读（冷启动不预赠资格）', await readCount(outOfScope.traceId, OTHER_MARKER) === 0)
  /*
   * ⚠️ 逐路径闸的**证据在账本里**：被任务环拒的步骤**不会产生任何动作事件**
   *    （ActionTurnResult 只摊平"真的执行过"的结果 ⇒ 用 `result.error.code` 看不到拒绝）。
   *    ⇒ 判据 = 该路径在本 trace 里**0 条事件** + 文件字节没变。
   */
  check('负控·越界读：这一步**没有执行**（账本里 0 条该路径事件）',
    await eventCount(outOfScope.traceId, `${OTHER}/x.txt`) === 0,
    String(await eventCount(outOfScope.traceId, `${OTHER}/x.txt`)))

  prepare(OTHER, 'other-2', true)
  const writeSource = await runTurn({ label: 'scope-write-source', entry: entryText(OTHER, 'other-2'),
    candidatePlanner: candidateSource([[planOf([read(`${OTHER}/other-2.src`)])]]).planner,
    fallback: probePlanner([[write(`${OTHER}/other-2.cache`, 'tampered')]]),
    selections: selectionsOf() })
  check('负控·写源文件：**没有执行**（账本里 0 条该源路径事件），缓存源一个字节都没变',
    await eventCount(writeSource.traceId, `${OTHER}/other-2.cache`) === 0
    && readFileSync(resolve(root, `${OTHER}/other-2.cache`), 'utf8') === 'stale:other-2',
    String(await eventCount(writeSource.traceId, `${OTHER}/other-2.cache`)))

  prepare(OTHER, 'other-3', true)
  const writeMarker = await runTurn({ label: 'scope-write-marker', entry: entryText(OTHER, 'other-3'),
    candidatePlanner: candidateSource([[planOf([read(`${OTHER}/other-3.src`)])]]).planner,
    fallback: probePlanner([[write(OTHER_MARKER, 'fresh')]]), selections: selectionsOf() })
  check('负控·写标记：**没有执行**（账本里 0 条标记写事件），族标记仍是夹具设定的值',
    await eventCount(writeMarker.traceId, OTHER_MARKER, 'write') === 0
    && readFileSync(resolve(root, OTHER_MARKER), 'utf8') === 'stale'
    && writeMarker.result.task?.stopped !== 'done',
    String(await eventCount(writeMarker.traceId, OTHER_MARKER, 'write')))

  prepare(OTHER, 'other-4', true)
  const duplicateMarker = await runTurn({ label: 'scope-marker-twice', entry: entryText(OTHER, 'other-4'),
    candidatePlanner: candidateSource([[planOf([read(`${OTHER}/other-4.src`)])]]).planner,
    fallback: probePlanner([[read(OTHER_MARKER), read(OTHER_MARKER)]]), selections: selectionsOf() })
  check('负控·重复标记读：本任务**只成功读了 1 次**标记，且第二次没有变成第二个成功读',
    await readCount(duplicateMarker.traceId, OTHER_MARKER) === 1
    && duplicateMarker.result.task?.stopped !== 'done',
    `成功 ${String(await readCount(duplicateMarker.traceId, OTHER_MARKER))} / 停止 ${String(duplicateMarker.result.task?.stopped)}`)

  // -------------------------------------------------------------------------
  // ⑥ 规则撤回 ⇒ 下一次同族任务**不再消费**；**A 失败后换策略恢复**（不是"结束"）
  // -------------------------------------------------------------------------
  await store.commit(claimId, { kind: 'withdraw' })
  const recoverObject = prepare(FAMILY, 'obj-12', true)
  const withdrawnSelections = selectionsOf()
  const recover = await runTurn({ label: 'withdrawn-recover', entry: entryText(FAMILY, 'obj-12'),
    candidatePlanner: candidateSource([[planOf([read(recoverObject.path.replace(/\.txt$/, '.cache'))])]]).planner,
    fallback: probePlanner([
      [read(recoverObject.path.replace(/\.txt$/, '.cache')), write(recoverObject.path, recoverObject.cached)],
      [read(recoverObject.path.replace(/\.txt$/, '.src')), write(recoverObject.path, recoverObject.auth),
        read(recoverObject.path)],
    ]), selections: withdrawnSelections })
  const recoverOutcome = outcomeOf(recover.result)
  check('负控·规则撤回：**不再出现否决**；标记仍按冻结规格**每题读一次**（读它不预赠资格）',
    await readCount(recover.traceId, MARKER) === 1)
  check('负控·规则撤回：不再出现否决读数',
    withdrawnSelections.selections.every(value => value.f2?.veto === undefined || value.f2.veto.decision === 'no_veto'))
  check('负控·A 恢复：缓存字节写被守卫拒（真实失败，不是"结束"）',
    codesOf(recover.result).includes('validation_failed'), codesOf(recover.result).join(','))
  check('负控·A 恢复：同一任务内换可靠策略 ⇒ 真实写入 + 读回一致 + 达成',
    recoverOutcome.stopped === 'done' && recoverOutcome.achieved
    && readFileSync(resolve(root, recoverObject.path), 'utf8') === recoverObject.auth,
    `${recoverOutcome.stopped}/${String(recoverOutcome.achieved)}`)

  // -------------------------------------------------------------------------
  // ⑦ 假完成判废：写被拒却声称 done ⇒ **不许**报完成
  // -------------------------------------------------------------------------
  const fakeObject = prepare(FAMILY, 'obj-13', true)
  const fake = await runTurn({ label: 'fake-done', entry: entryText(FAMILY, 'obj-13'),
    candidatePlanner: candidateSource([[planOf([read(`${FAMILY}/obj-13.src`)])]]).planner,
    fallback: probePlanner([[read(fakeObject.path.replace(/\.txt$/, '.cache')), write(fakeObject.path, fakeObject.cached)]]),
    selections: selectionsOf() })
  const fakeOutcome = outcomeOf(fake.result)
  check('假完成判废：写被守卫拒 ⇒ 任务**不**报完成（没有真实写入 + 读回）',
    fakeOutcome.stopped !== 'done' && !existsSync(resolve(root, fakeObject.path)),
    fakeOutcome.stopped)
  check('假完成判废：完成判定只按真实结果（`goal.achieved=false`）', fakeOutcome.achieved === false)

  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'PASS', backend: 'postgres',
    evidenceKind: 'real_action_turn_real_gateway_real_files_offline_candidate', measured_count: checks.length, checks,
    productionOpened: false, modelCalls: 0, boundary: [
      '本门证明**机制**：准备读 → 标记读 → 来源限定否决 → 真实写入 + 终读回；**不**构成收益读数',
      '固定候选规划器：候选正文与顺序来自夹具，不代表真实模型行为',
      '准备读与族标记读是 F2 每题固定成本，本门不作成本比较',
      'F2 任务原话不被词形判据认成任务形 ⇒ 从**已签发授权会话键**进入 ActionTurn（继续已开任务）',
    ], humanAcceptance: 'NOT RUN' }, null, 2))
  console.log(`F2 ActionTurn 闭环门：${String(checks.length)}/${String(checks.length)}；${output}`)
} catch (error) {
  writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ status: 'FAIL', backend: 'postgres', checks, diagnostics,
    error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally { await h.stop() }
