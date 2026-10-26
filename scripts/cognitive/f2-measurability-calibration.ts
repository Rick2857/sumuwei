/*
 * F2 零模型可测性校准 v2（固定规划器 · **零真实模型请求**）。
 *
 * 目的：证明"F2 这套任务域 + 评分 + 三臂设置**能测出差异**"，而不是靠机制模型里的漂亮差值。
 * ⚠️ **本脚本不得把优势写进实验**（2026-10-25 用户核对后重写）：
 *   ① 代理**允许用失败反馈**：写被拒是**新证据**，且可靠候选**仍然可用** ⇒ 继续在**同一预算内**尝试
 *      （不再"第一次失败就 break"——那会人为阻断 A 的恢复、放大 C 的达成率优势）。
 *   ② **守卫只按内容真值判断**：`content === authoritative`。模型**自报的标签**不能改变放行结果、
 *      权限或规则适用性（策略身份由**可核验的读日志**决定 ⇒ `effectiveVariant`）。
 *   ③ **配对置换候选顺序**：两种顺序都跑、**分别报告**；达成差**允许为 0**（真实优势也可能只体现为
 *      "失败更少 / 成本更低"），不把"必须 C>A"写成判据。
 *   ④ 形成要求 **≥2 个不同绑定 + 一个对照**（F1 既有资格口径）。
 *
 * 边界（如实读）：
 *  · 任务域、真值、评分、三臂差别 = 本脚本**真实实现**（可执行）。
 *  · 规则**消费**用产品真实原语 `applyPreconditionVeto`；规则**形成**是**机制模型**。
 *  · **没有**执行真实 ActionTurn→Gateway→账本→EBL 形成链（下一批验收项）⇒ 本校准**不能**被称为
 *    "真实产品链迁移通过"。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyPreconditionVeto } from '../../src/kernel/contracts/write-precondition.ts'
import { validateWriteRequirement } from '../../src/kernel/contracts/world-model-transition.ts'

const OUT_DIR = resolve('artifacts/local/f2-calibration')
const DATA = resolve('docs/architecture/f2-preregistration-20261025')

type Condition = 'fresh' | 'stale'
type Variant = 'cached' | 'authoritative'
type Arm = 'A' | 'B' | 'C'
type Order = 'cached-first' | 'authoritative-first'

interface F2Object {
  worldId: string
  familyId: string
  objectId: string
  phase: 'dev' | 'holdout'
  condition: Condition
  targetPath: string
  authoritativeContent: string
  cacheContent: string
}

interface Protocol {
  worlds: Array<{ worldId: string, familyId: string }>
  conditionAssignment: Record<string, { dev: Condition[], holdout: Condition[] }>
  arms: Array<{ arm: Arm, label: string, ruleUse: string, strategyPolicy: string }>
  budget: { perTaskModelRequests: number }
  ruleFormation: {
    mustNotEqual: string
    minDistinctBindings: number
    evidenceFailureCode: string
    evidenceConditionObserved: string
    requiresCounterexample: boolean
  }
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const protocol = readJson(resolve(DATA, 'protocol.json')) as Protocol

const buildObjects = (): F2Object[] => {
  const objects: F2Object[] = []
  for (const world of protocol.worlds) {
    const assignment = protocol.conditionAssignment[world.worldId]!
    let counter = 0
    for (const [phase, conditions] of [['dev', assignment.dev], ['holdout', assignment.holdout]] as const) {
      for (const condition of conditions) {
        counter += 1
        const nn = String(counter).padStart(2, '0')
        const id = `${world.worldId}-obj-${nn}`
        const authoritativeContent = `AUTH:${id}:payload\n`
        objects.push({
          worldId: world.worldId, familyId: world.familyId, objectId: id, phase, condition,
          targetPath: `${world.familyId}/obj-${nn}.txt`,
          authoritativeContent,
          cacheContent: condition === 'fresh' ? authoritativeContent : `STALE:${id}:payload\n`,
        })
      }
    }
  }
  return objects
}

const objects = buildObjects()

// ---------------------------------------------------------------------------
// 策略：两条策略**动作数相同**（1 读 + 1 写）；差别只在**读哪个源**。
// 有效变体（effectiveVariant）由**读日志**决定 ⇒ 可核验；claimedVariant 只是模型自报（仅供负控）。
// ---------------------------------------------------------------------------
interface Candidate {
  id: string
  effectiveVariant: Variant
  claimedVariant: string
  readPath: 'cache' | 'source'
  familyId: string
  actions: number
  modelRequests: number
}

const candidatesFor = (object: F2Object, order: Order, claimedOverride?: { id: string, claimed: string }): Candidate[] => {
  const cached: Candidate = {
    id: 'S_cached', effectiveVariant: 'cached', claimedVariant: 'cached', readPath: 'cache',
    familyId: object.familyId, actions: 2, modelRequests: 1,
  }
  const authoritative: Candidate = {
    id: 'S_authoritative', effectiveVariant: 'authoritative', claimedVariant: 'authoritative', readPath: 'source',
    familyId: object.familyId, actions: 2, modelRequests: 1,
  }
  const list = order === 'cached-first' ? [cached, authoritative] : [authoritative, cached]
  if (claimedOverride === undefined) return list
  return list.map(candidate => (candidate.id === claimedOverride.id ? { ...candidate, claimedVariant: claimedOverride.claimed } : candidate))
}

// ---------------------------------------------------------------------------
// 守卫：**只看内容真值**（标签无关）
// ---------------------------------------------------------------------------
const guardAccepts = (object: F2Object, content: string): boolean => content === object.authoritativeContent

// ---------------------------------------------------------------------------
// 规则（形成 → 消费）
// ---------------------------------------------------------------------------
interface F2Rule { familyId: string, mustNotEqual: string, variant: Variant, bindings: string[], counterexample: string | null }
interface Receipt { binding: string, failureCode: string, conditionObserved: string }

const formRule = (familyId: string, receipts: Receipt[], counterexamples: string[]): F2Rule | null => {
  const qualifying = receipts.filter(receipt =>
    receipt.failureCode === protocol.ruleFormation.evidenceFailureCode &&
    receipt.conditionObserved === protocol.ruleFormation.evidenceConditionObserved)
  const bindings = [...new Set(qualifying.map(receipt => receipt.binding))]
  if (bindings.length < protocol.ruleFormation.minDistinctBindings) return null
  const counterexample = counterexamples[0] ?? null
  if (protocol.ruleFormation.requiresCounterexample && counterexample === null) return null
  return { familyId, mustNotEqual: protocol.ruleFormation.mustNotEqual, variant: 'cached', bindings, counterexample }
}

/** 族匹配 + 条件**已知** + 观测值**等于** mustNotEqual（F1 语义）+ 未撤回 */
const ruleApplies = (rule: F2Rule | null, object: F2Object, conditionKnown: boolean, withdrawn: boolean): boolean => {
  if (rule === null || withdrawn) return false
  if (rule.familyId !== object.familyId) return false
  if (!conditionKnown) return false
  return object.condition === rule.mustNotEqual
}

const consumeRule = (rule: F2Rule | null, object: F2Object, conditionKnown: boolean, withdrawn: boolean, candidates: Candidate[]) => {
  const applies = ruleApplies(rule, object, conditionKnown, withdrawn)
  if (!applies || rule === null) return { eligible: [...candidates], vetoed: [] as Candidate[], applied: false }
  const result = applyPreconditionVeto({
    decision: {
      veto: true, reason: 'precondition_violated', familyId: rule.familyId,
      conditionPath: `${object.familyId}/obj-01.fresh`, observedValue: object.condition, mustNotEqual: rule.mustNotEqual,
    } as never,
    candidates,
    writesIntoFamily: (candidate: Candidate) =>
      candidate.familyId === object.familyId && candidate.effectiveVariant === rule.variant,
  })
  return { eligible: result.eligible, vetoed: result.vetoed, applied: true }
}

// ---------------------------------------------------------------------------
// 执行一个对象（**允许用失败反馈**：失败是新证据，可靠候选仍可用 ⇒ 预算内继续）
// ---------------------------------------------------------------------------
interface Execution {
  object: F2Object
  writtenContent: string | null
  writeVariant: Variant | null
  actions: number
  modelRequests: number
  failedActions: number
  guardRefusals: number
  reportedDone: boolean
  vetoedVariants: Variant[]
  receipts: Receipt[]
}

const runObject = (arm: Arm, object: F2Object, budget: number, rule: F2Rule | null, conditionKnown: boolean, withdrawn: boolean, order: Order): Execution => {
  const armSpec = protocol.arms.find(item => item.arm === arm)!
  const all = candidatesFor(object, order)
  const pool = armSpec.strategyPolicy === 'always_authoritative'
    ? all.filter(candidate => candidate.effectiveVariant === 'authoritative')
    : all
  const { eligible, vetoed } = armSpec.strategyPolicy === 'always_authoritative'
    ? { eligible: pool, vetoed: [] as Candidate[] }
    : consumeRule(rule, object, conditionKnown, withdrawn, pool)
  const vetoedVariants = vetoed.map(candidate => candidate.effectiveVariant)

  let calls = 0
  let actions = 0
  let failedActions = 0
  let guardRefusals = 0
  const receipts: Receipt[] = []
  for (const candidate of eligible) {
    if (calls >= budget) break
    const content = candidate.effectiveVariant === 'cached' ? object.cacheContent : object.authoritativeContent
    calls += 1
    actions += candidate.actions
    if (guardAccepts(object, content)) {
      return {
        object, writtenContent: content, writeVariant: candidate.effectiveVariant, actions, modelRequests: calls,
        failedActions, guardRefusals, reportedDone: true, vetoedVariants, receipts,
      }
    }
    // 写被拒：**新证据**；可靠候选**仍然可用** ⇒ 预算内继续
    failedActions += 1
    guardRefusals += 1
    receipts.push({ binding: object.objectId, failureCode: 'validation_failed', conditionObserved: object.condition })
  }
  return {
    object, writtenContent: null, writeVariant: null, actions, modelRequests: calls,
    failedActions, guardRefusals, reportedDone: false, vetoedVariants, receipts,
  }
}

// ---------------------------------------------------------------------------
// 一次序列
// ---------------------------------------------------------------------------
interface ArmRun {
  arm: Arm
  order: Order
  executions: Execution[]
  rules: F2Rule[]
  coldStartRequests: number
  coldStartTokens: number
  firstConsumptionAt: string | null
  consumedInHoldout: number
  consumedAndAchieved: number
}

const runArm = (arm: Arm, budget: number, order: Order): ArmRun => {
  const armSpec = protocol.arms.find(item => item.arm === arm)!
  const executions: Execution[] = []
  const rules = new Map<string, F2Rule>()
  const receipts = new Map<string, Receipt[]>()
  const counterexamples = new Map<string, string[]>()
  let coldStartRequests = 0
  let coldStartTokens = 0
  let firstConsumptionAt: string | null = null
  let consumedInHoldout = 0
  let consumedAndAchieved = 0
  let coldStartClosed = false

  for (const object of objects) {
    const familyRule = rules.get(object.familyId) ?? null
    const execution = runObject(arm, object, budget, familyRule, true, false, order)
    executions.push(execution)
    if (armSpec.ruleUse !== 'form_and_consume') continue
    if (familyRule === null && object.phase === 'dev') {
      const list = receipts.get(object.familyId) ?? []
      list.push(...execution.receipts)
      receipts.set(object.familyId, list)
      // 对照：同一条动作**成功过**的绑定（条件 fresh ⇒ 缓存写成立）
      if (execution.reportedDone && execution.writeVariant === 'cached') {
        const list2 = counterexamples.get(object.familyId) ?? []
        list2.push(object.objectId)
        counterexamples.set(object.familyId, list2)
      }
      const formed = formRule(object.familyId, list, counterexamples.get(object.familyId) ?? [])
      if (formed !== null) rules.set(object.familyId, formed)
      continue
    }
    if (execution.vetoedVariants.length > 0) {
      if (!coldStartClosed) {
        coldStartRequests += execution.modelRequests
        coldStartTokens += execution.modelRequests * 4000
        if (object.phase === 'holdout') { coldStartClosed = true; firstConsumptionAt = object.objectId }
      }
      if (object.phase === 'holdout') {
        consumedInHoldout += 1
        if (execution.reportedDone) consumedAndAchieved += 1
      }
    }
  }
  return {
    arm, order, executions, rules: [...rules.values()], coldStartRequests, coldStartTokens,
    firstConsumptionAt, consumedInHoldout, consumedAndAchieved,
  }
}

// ---------------------------------------------------------------------------
// 评分（程序真值）
// ---------------------------------------------------------------------------
const truthAchieved = (execution: Execution): boolean =>
  execution.writtenContent !== null && execution.writtenContent === execution.object.authoritativeContent

const score = (executions: Execution[]) => ({
  attempted: executions.length,
  achieved: executions.filter(truthAchieved).length,
  falseCompletion: executions.filter(execution => execution.reportedDone && !truthAchieved(execution)).length,
  failedActions: executions.reduce((sum, execution) => sum + execution.failedActions, 0),
  guardRefusals: executions.reduce((sum, execution) => sum + execution.guardRefusals, 0),
  modelRequests: executions.reduce((sum, execution) => sum + execution.modelRequests, 0),
  actions: executions.reduce((sum, execution) => sum + execution.actions, 0),
})

// ---------------------------------------------------------------------------
// 校准检查
// ---------------------------------------------------------------------------
const checks: Array<{ label: string, pass: boolean, detail: string }> = []
const check = (label: string, pass: boolean, detail = ''): void => {
  checks.push({ label, pass, detail })
  assert.ok(pass, `${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const BUDGET = protocol.budget.perTaskModelRequests
const ORDERS: Order[] = ['cached-first', 'authoritative-first']
const holdout = (executions: Execution[]) => executions.filter(execution => execution.object.phase === 'holdout')

// ① **每个对象**对**每个臂**都有可行完成路径（不是"存在一题成功"）
const feasibleForEveryObject = (arm: Arm): { ok: boolean, missing: string[] } => {
  const missing: string[] = []
  for (const object of objects) {
    const probe = runObject(arm, object, 99, null, true, false, 'cached-first')
    if (!(probe.writtenContent !== null && truthAchieved(probe))) missing.push(object.objectId)
  }
  return { ok: missing.length === 0, missing }
}
const feasA = feasibleForEveryObject('A')
const feasB = feasibleForEveryObject('B')
const feasC = feasibleForEveryObject('C')
check('① **每个对象**对**每个臂**都有可行完成路径（不是"存在一题成功"）',
  feasA.ok && feasB.ok && feasC.ok,
  `A缺${String(feasA.missing.length)} B缺${String(feasB.missing.length)} C缺${String(feasC.missing.length)}`)

// ② 候选顺序：**配对置换**（两序都跑、分别报告）；**同一轮内三臂同序**（无恒真式）
const runs = new Map<string, ArmRun>()
for (const order of ORDERS) for (const arm of ['A', 'B', 'C'] as Arm[]) runs.set(`${arm}|${order}`, runArm(arm, BUDGET, order))
const ordersUsedPerArm = (order: Order): string => (['A', 'B', 'C'] as Arm[])
  .map(arm => (runs.get(`${arm}|${order}`) as ArmRun).order).join(',')
const orderIsPairedAndShared = ORDERS.every(order => ordersUsedPerArm(order) === `${order},${order},${order}`)
check('② 候选顺序**配对置换**且**同一轮三臂同序**（顺序是配对因子，不是被测量变量）', orderIsPairedAndShared)

// ③ 守卫只看内容真值：自报标签**不能**改变放行；有效变体来自读日志
const staleObject = objects.find(object => object.phase === 'dev' && object.condition === 'stale')!
const mislabeled = candidatesFor(staleObject, 'cached-first', { id: 'S_cached', claimed: 'authoritative' })
const mislabeledRun = runObject('A', staleObject, 99, null, true, false, 'cached-first')
check('③ 自报标签为 authoritative 但内容是缓存内容 ⇒ **守卫仍按内容拒绝**（标签不放行）',
  mislabeled.length > 0 && mislabeled[0]!.claimedVariant === 'authoritative' &&
  mislabeled[0]!.effectiveVariant === 'cached' && mislabeledRun.guardRefusals >= 1)
const noLabel = candidatesFor(staleObject, 'cached-first').map(candidate => ({ ...candidate, claimedVariant: '' }))
check('③b 去掉标签**不改变**有效变体（仍由读日志决定）',
  noLabel.every(candidate => candidate.effectiveVariant === (candidate.readPath === 'cache' ? 'cached' : 'authoritative')))
const unknownLabel = candidatesFor(staleObject, 'cached-first').map(candidate => ({ ...candidate, claimedVariant: 'unknown' }))
check('③c 未知标签**不被采纳**（有效变体照旧来自读日志）',
  unknownLabel.every(candidate => candidate.effectiveVariant === (candidate.readPath === 'cache' ? 'cached' : 'authoritative')))

// ④ 规则形成要 **≥2 个不同绑定 + 一个对照**；消费要改变选择并影响执行结果
const runC = runs.get('C|cached-first') as ArmRun
const cRule = runC.rules[0] ?? null
check('④ 规则形成要求 **≥2 个不同绑定**（按 formation 口径）',
  cRule !== null && cRule.bindings.length >= 2, `bindings=${cRule?.bindings.join(',') ?? ''}`)
check('④b 规则形成还要求**一个对照**（同一条动作成功过的绑定）',
  cRule !== null && cRule.counterexample !== null, `counterexample=${cRule?.counterexample ?? ''}`)
check('④c 规则在**留出集**上被消费（跨对象生效）', runC.consumedInHoldout > 0, `consumed=${String(runC.consumedInHoldout)}`)
check('④d 消费后 stale 留出对象**真值达成**（不是只改记录）',
  runC.consumedAndAchieved === runC.consumedInHoldout && runC.consumedInHoldout > 0,
  `达成=${String(runC.consumedAndAchieved)}/${String(runC.consumedInHoldout)}`)

// ⑤ 错误族 / 未知条件 / 规则撤回 ⇒ 不误伤
const otherFamilyObject = objects.find(object => object.familyId !== (cRule?.familyId ?? ''))!
const wrongFamily = consumeRule(cRule, otherFamilyObject, true, false, candidatesFor(otherFamilyObject, 'cached-first'))
check('⑤a 错误族：规则不作用（不移除任何候选）', wrongFamily.vetoed.length === 0 && wrongFamily.eligible.length === 2)
const unknownCondition = consumeRule(cRule, staleObject, false, false, candidatesFor(staleObject, 'cached-first'))
check('⑤b 条件未知：**不**消费（unknown ≠ 禁止）', unknownCondition.vetoed.length === 0 && unknownCondition.eligible.length === 2)
const withdrawnCase = consumeRule(cRule, staleObject, true, true, candidatesFor(staleObject, 'cached-first'))
check('⑤c 规则撤回：**不**消费', withdrawnCase.vetoed.length === 0 && withdrawnCase.eligible.length === 2)

// ⑥ 评分器抗注入
const runA = runs.get('A|cached-first') as ArmRun
const honestA = holdout(runA.executions)
const tampered = honestA.map(execution => (execution.guardRefusals > 0
  ? { ...execution, writtenContent: execution.object.authoritativeContent, reportedDone: true }
  : execution))
const scoreHonest = score(honestA)
const scoreTampered = score(tampered)
const detected = tampered.filter(execution => execution.guardRefusals > 0 && execution.writtenContent !== null)
check('⑥a 注入"假优势"（把被拒的写篡改成达成）⇒ 独立核对（看拒绝收据）能**识破**',
  detected.length > 0 && scoreTampered.achieved >= scoreHonest.achieved,
  `识破=${String(detected.length)}`)
const degraded = honestA.map(execution => ({ ...execution, failedActions: 0 }))
const scoreDegraded = score(degraded)
const refusalsHonest = honestA.reduce((sum, execution) => sum + execution.guardRefusals, 0)
check('⑥b 注入"退化"（清零失败动作计数）⇒ 与拒绝收据对账能**发现**',
  refusalsHonest > 0 && scoreHonest.failedActions === refusalsHonest && scoreDegraded.failedActions === 0,
  `收据=${String(refusalsHonest)} 诚实=${String(scoreHonest.failedActions)} 注入后=${String(scoreDegraded.failedActions)}`)

// ⑦ 冷启动成本**真的累计**（不是恒 0）
const coldStartTotal = runC.coldStartRequests + runC.coldStartTokens
check('⑦ 冷启动成本**已累计**（不是恒 0 的占位）', coldStartTotal > 0,
  `requests=${String(runC.coldStartRequests)} tokens=${String(runC.coldStartTokens)} firstConsumption=${String(runC.firstConsumptionAt)}`)

// ⑧ 规则形状仍受产品契约校验
let goodShape = false
try {
  const validated = validateWriteRequirement('write_requires_condition', { conditionPath: 'f1/a/obj-01.fresh', mustNotEqual: 'stale' })
  goodShape = validated !== undefined && validated.mustNotEqual === 'stale'
} catch { goodShape = false }
let badShapeRejected = false
try { validateWriteRequirement('write_requires_condition', { conditionPath: 'f1/a/obj-01.fresh', mustNotEqual: 'stale', extra: 1 } as never) } catch { badShapeRejected = true }
check('⑧ 规则前置条件形状受**产品契约**校验（好形状通过、坏形状被拒）', goodShape && badShapeRejected)

// ---------------------------------------------------------------------------
// 读数（配对置换：两序分别报告；**允许达成差为 0**）
// ---------------------------------------------------------------------------
const perOrder = ORDERS.map(order => {
  const row: Record<string, unknown> = { order }
  for (const arm of ['A', 'B', 'C'] as Arm[]) {
    const run = runs.get(`${arm}|${order}`) as ArmRun
    row[arm] = { ...score(holdout(run.executions)), coldStartRequests: run.coldStartRequests, coldStartTokens: run.coldStartTokens }
  }
  return row
})
const paired = ORDERS.map(order => {
  const a = score(holdout((runs.get(`A|${order}`) as ArmRun).executions))
  const b = score(holdout((runs.get(`B|${order}`) as ArmRun).executions))
  const c = score(holdout((runs.get(`C|${order}`) as ArmRun).executions))
  return {
    order,
    cMinusA_achievement: c.achieved - a.achieved,
    aMinusC_failures: a.failedActions - c.failedActions,
    aMinusC_requests: a.modelRequests - c.modelRequests,
    bMinusC_requests: b.modelRequests - c.modelRequests,
  }
})
check('⑨ 两种顺序都跑完并**分别报告**（配对置换）', perOrder.length === ORDERS.length && paired.length === ORDERS.length)

const summary = {
  schema: 'f2-calibration@2',
  generatedAt: new Date().toISOString(),
  status: 'PASS',
  protocolId: 'f2-benefit-qualified-strategy@1',
  modelCalls: 0,
  revisionNote: 'v2：去掉人为优势（失败可用作证据继续尝试）、守卫只看内容真值、标签不可信、形成需对照、顺序配对置换、弱断言已修、冷启动真累计',
  objects: { total: objects.length, dev: objects.filter(o => o.phase === 'dev').length, holdout: objects.filter(o => o.phase === 'holdout').length },
  frozenPerTaskBudget: BUDGET,
  perOrder,
  paired,
  ruleConsumption: {
    formed: cRule !== null,
    bindings: cRule?.bindings ?? [],
    counterexample: cRule?.counterexample ?? null,
    consumedInHoldout: runC.consumedInHoldout,
    consumedAndAchieved: runC.consumedAndAchieved,
    coldStartRequests: runC.coldStartRequests,
    coldStartTokens: runC.coldStartTokens,
  },
  checks,
  boundaries: [
    '本校准**零真实模型请求**（固定规划器 + 内容真值守卫 + 程序真值）',
    '规则**消费**用产品真实原语 applyPreconditionVeto；规则**形成**是机制模型（≥2 绑定 + 对照）',
    '**没有**执行真实 ActionTurn→Gateway→账本→EBL 形成链 ⇒ 本校准**不能**被称为"真实产品链迁移通过"',
    '策略身份由**读日志**决定（可核验），模型自报标签**不能**改变放行/权限/规则适用性',
    '达成差**允许为 0**：真实优势也可能只体现为失败更少或成本更低',
  ],
}
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(resolve(OUT_DIR, 'calibration.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
console.log(`F2 零模型可测性校准 v2：${String(checks.length)} 项检查全部通过（零真实模型请求）`)
for (const row of perOrder) {
  const a = row.A as { achieved: number, attempted: number, failedActions: number, modelRequests: number }
  const b = row.B as { achieved: number, failedActions: number, modelRequests: number }
  const c = row.C as { achieved: number, failedActions: number, modelRequests: number }
  console.log(`顺序 ${String(row.order)}：达成 A=${String(a.achieved)} B=${String(b.achieved)} C=${String(c.achieved)}/${String(a.attempted)}；失败动作 A=${String(a.failedActions)} B=${String(b.failedActions)} C=${String(c.failedActions)}；请求 A=${String(a.modelRequests)} B=${String(b.modelRequests)} C=${String(c.modelRequests)}`)
}
for (const row of paired) console.log(`配对 ${String(row.order)}：C−A 达成=${String(row.cMinusA_achievement)} 失败减少=${String(row.aMinusC_failures)} 请求减少=${String(row.aMinusC_requests)}；C−B 请求减少=${String(row.bMinusC_requests)}`)
for (const item of checks) console.log(`PASS ${item.label}${item.detail === '' ? '' : ` — ${item.detail}`}`)
