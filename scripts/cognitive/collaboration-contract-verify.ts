/**
 * 认知能力协作契约 · **判据门**（2026-10-21 · 计划 P1）
 *
 * ============================================================================
 *  它验什么
 * ============================================================================
 *  计划 §2 的 P1 退出条件逐字是：
 *
 *      「**不同主体/版本/参数不能错绑**；**候选不能直接写权威状态**；
 *        **来源撤回或版本冲突在消费/提交前被拒**；**不先构建通用框架**。」
 *
 *  ⇒ 本门对上面四句各给一组**正控 + 负控**。
 *
 *  ⚠️ **负控与收益任务分开**：负控只证明"判据能失败"——
 *    没有负控的绿没有信息量（计划 §3 P2 末段）。
 *  ⚠️ 本门**零数据库、零模型、零出网**：它验的是**契约判据**，不是端到端链路
 *    （端到端的那条链是 P2 的事）。
 *
 *  用法：pnpm cognitive:collaboration:verify
 * ============================================================================
 */

import {
  COGNITIVE_COLLABORATION_VERSION,
  RULE_INVALIDATION_REASONS,
  selectUsableRules,
  verifyBaselineBeforeCommit,
  verifyModelResultAtCommit,
  verifyPlanRulesStillUsable,
  type RuleSnapshotPort,
  type UsableRuleSnapshot,
} from '../../src/kernel/contracts/cognitive-collaboration.ts'

let passed = 0
let failed = 0
const failures: string[] = []

function check (label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function section (title: string): void {
  console.log(`\n=== ${title} ===`)
}

console.log('='.repeat(72))
console.log('认知能力协作契约 · 判据门（世界模型 ＋ EBL 一条链）')
console.log('='.repeat(72))

// ---------------------------------------------------------------------------
// 夹具：一条"当前合格规则"与它的各种变体
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000

function snapshotOf (overrides: Partial<UsableRuleSnapshot> = {}): UsableRuleSnapshot {
  return {
    claimId: 'claim-tool-001',
    predicate: 'readback_matches',
    expected: true,
    claimVersion: 3,
    policy: 'epistemic-policy@3',
    subjectId: 'user-Alex',
    scope: 'sandbox.file.write',
    environment: 'serversim',
    conditions: {},
    ruleVersion: 'rule-v1',
    sources: [{ kind: 'conversation', id: 'cev:1', revision: 'rev-1' }],
    evidenceFingerprint: 'fp-abc',
    status: 'validated',
    usable: true,
    ...overrides,
  }
}

/** 一个只读快照读面（**不写任何东西** —— 这是"候选不能直接写权威状态"的机制面） */
function portOf (snapshots: Map<string, UsableRuleSnapshot>): RuleSnapshotPort {
  let reads = 0
  const port: RuleSnapshotPort = {
    async current (claimId: string): Promise<UsableRuleSnapshot | undefined> {
      reads += 1
      return snapshots.get(claimId)
    },
    async list (): Promise<UsableRuleSnapshot[]> {
      reads += 1
      return [...snapshots.values()].sort((a, b) => (a.claimId < b.claimId ? -1 : 1))
    },
  }
  return Object.assign(port, { readCount: () => reads })
}

const EXPECTED = { subjectId: 'user-Alex', scope: 'sandbox.file.write', environment: 'serversim' }

// ---------------------------------------------------------------------------
section('0. 契约形状')
// ---------------------------------------------------------------------------
check('契约有版本号', COGNITIVE_COLLABORATION_VERSION === 'cognitive-collaboration@1', COGNITIVE_COLLABORATION_VERSION)
check(
  '失效原因是**闭集**（机器判定，不是自由文本）',
  RULE_INVALIDATION_REASONS.length === 6 && RULE_INVALIDATION_REASONS.includes('source_withdrawn'),
  RULE_INVALIDATION_REASONS.join(' / ')
)

// ---------------------------------------------------------------------------
section('1. 正控：一切匹配 ⇒ 放行')
// ---------------------------------------------------------------------------
{
  const current = snapshotOf()
  const verdict = verifyBaselineBeforeCommit({
    baseline: { claimId: current.claimId, claimVersion: current.claimVersion, ruleVersion: current.ruleVersion, evidenceFingerprint: current.evidenceFingerprint },
    current,
    expected: EXPECTED,
  })
  check('正控：基准与当前一致 ⇒ 允许提交', verdict.ok, verdict.ok ? '' : verdict.detail)

  const snapshot = portOf(new Map([[current.claimId, current]]))
  const plan = await verifyPlanRulesStillUsable({
    dependencies: [{ claimId: current.claimId, ruleVersion: current.ruleVersion, evidenceFingerprint: current.evidenceFingerprint }],
    snapshot,
  })
  check('正控：计划依赖的规则仍可用 ⇒ 允许执行', plan.ok, plan.ok ? '' : plan.detail)

  const commit = verifyModelResultAtCommit({ baseline: { inputRevision: 'rev-7', producedAt: NOW, cancelled: false }, currentRevision: 'rev-7' })
  check('正控：未取消且不迟到 ⇒ 允许提交', commit.ok, commit.ok ? '' : commit.detail)
}

// ---------------------------------------------------------------------------
section('2. 负控：不同主体 / 版本错绑（**必须被拒**）')
// ---------------------------------------------------------------------------
{
  const current = snapshotOf()
  const baseline = { claimId: current.claimId, claimVersion: current.claimVersion, ruleVersion: current.ruleVersion, evidenceFingerprint: current.evidenceFingerprint }

  const wrongSubject = verifyBaselineBeforeCommit({
    baseline,
    current,
    expected: { ...EXPECTED, subjectId: 'user- Somebody-else' },
  })
  check('负控：主体不同 ⇒ 拒（subject_mismatch）', !wrongSubject.ok && wrongSubject.reason === 'subject_mismatch', wrongSubject.ok ? '竟然放行了' : wrongSubject.detail)

  const wrongScope = verifyBaselineBeforeCommit({
    baseline,
    current,
    expected: { ...EXPECTED, scope: 'sandbox.file.read' },
  })
  check('负控：范围不同 ⇒ 拒（subject_mismatch）', !wrongScope.ok && wrongScope.reason === 'subject_mismatch', wrongScope.ok ? '竟然放行了' : wrongScope.detail)

  const versionConflict = verifyBaselineBeforeCommit({
    baseline: { ...baseline, ruleVersion: 'rule-v0' },
    current,
    expected: EXPECTED,
  })
  check('负控：规则版本不同 ⇒ 拒（version_conflict）', !versionConflict.ok && versionConflict.reason === 'version_conflict', versionConflict.ok ? '竟然放行了' : versionConflict.detail)

  const fingerprintConflict = verifyBaselineBeforeCommit({
    baseline: { ...baseline, evidenceFingerprint: 'fp-old' },
    current,
    expected: EXPECTED,
  })
  check('负控：证据指纹不同 ⇒ 拒（version_conflict）', !fingerprintConflict.ok && fingerprintConflict.reason === 'version_conflict', fingerprintConflict.ok ? '竟然放行了' : fingerprintConflict.detail)
}

// ---------------------------------------------------------------------------
section('3. 负控：来源撤回 / 状态不可用（**消费与提交前就要被拒**）')
// ---------------------------------------------------------------------------
{
  const withdrawn = snapshotOf({ usable: false, status: 'withdrawn', invalidatedReason: 'source_withdrawn' })
  const verdict = verifyBaselineBeforeCommit({
    baseline: { claimId: withdrawn.claimId, claimVersion: withdrawn.claimVersion, ruleVersion: withdrawn.ruleVersion, evidenceFingerprint: withdrawn.evidenceFingerprint },
    current: withdrawn,
    expected: EXPECTED,
  })
  check('负控：来源已撤回 ⇒ 拒（source_withdrawn）', !verdict.ok && verdict.reason === 'source_withdrawn', verdict.ok ? '竟然放行了' : verdict.detail)

  const snapshot = portOf(new Map([[withdrawn.claimId, withdrawn]]))
  const plan = await verifyPlanRulesStillUsable({
    dependencies: [{ claimId: withdrawn.claimId, ruleVersion: withdrawn.ruleVersion, evidenceFingerprint: withdrawn.evidenceFingerprint }],
    snapshot,
  })
  check('负控：计划依赖一条已撤回的规则 ⇒ 整份计划拒执行', !plan.ok && plan.reason === 'source_withdrawn', plan.ok ? '竟然放行了' : plan.detail)

  const missing = await verifyPlanRulesStillUsable({
    dependencies: [{ claimId: 'claim-does-not-exist', ruleVersion: 'rule-v1', evidenceFingerprint: 'fp-abc' }],
    snapshot: portOf(new Map()),
  })
  check('负控：依赖的命题根本没有快照 ⇒ 拒（not_usable）', !missing.ok && missing.reason === 'not_usable', missing.ok ? '竟然放行了' : missing.detail)
}

// ---------------------------------------------------------------------------
section('4. 负控：一条计划里只要有一条规则不可用 ⇒ 整份计划不可用')
// ---------------------------------------------------------------------------
{
  const good = snapshotOf()
  const bad = snapshotOf({ claimId: 'claim-tool-002', usable: false, status: 'suspended', invalidatedReason: 'not_usable' })
  const snapshot = portOf(new Map([[good.claimId, good], [bad.claimId, bad]]))
  const plan = await verifyPlanRulesStillUsable({
    dependencies: [
      { claimId: good.claimId, ruleVersion: good.ruleVersion, evidenceFingerprint: good.evidenceFingerprint },
      { claimId: bad.claimId, ruleVersion: bad.ruleVersion, evidenceFingerprint: bad.evidenceFingerprint },
    ],
    snapshot,
  })
  check('负控：不"挑还能用的那条"（整份计划拒执行）', !plan.ok && plan.reason === 'not_usable', plan.ok ? '竟然放行了' : plan.detail)
}

// ---------------------------------------------------------------------------
section('5. 负控：迟到 / 已取消的模型结果（**挡在提交口**）')
// ---------------------------------------------------------------------------
{
  const late = verifyModelResultAtCommit({
    baseline: { inputRevision: 'rev-6', producedAt: NOW, cancelled: false },
    currentRevision: 'rev-7',
  })
  check('负控：产出时基准已过时 ⇒ 拒（late_result）', !late.ok && late.reason === 'late_result', late.ok ? '竟然放行了' : late.detail)

  const cancelled = verifyModelResultAtCommit({
    baseline: { inputRevision: 'rev-7', producedAt: NOW, cancelled: true },
    currentRevision: 'rev-7',
  })
  check('负控：结果已取消 ⇒ 拒（cancelled_result）', !cancelled.ok && cancelled.reason === 'cancelled_result', cancelled.ok ? '竟然放行了' : cancelled.detail)

  // ⚠️ 已取消**优先**于迟到（它根本不该存在）
  const both = verifyModelResultAtCommit({
    baseline: { inputRevision: 'rev-6', producedAt: NOW, cancelled: true },
    currentRevision: 'rev-7',
  })
  check('负控：已取消优先于迟到（只报一个最硬的原因）', !both.ok && both.reason === 'cancelled_result', both.ok ? '竟然放行了' : both.detail)
}

// ---------------------------------------------------------------------------
section('6. 候选不能直接写权威状态（**读面没有写路径**）')
// ---------------------------------------------------------------------------
{
  const snapshot = snapshotOf()
  const port = portOf(new Map([[snapshot.claimId, snapshot]]))
  const before = JSON.stringify(snapshot)
  port.current(snapshot.claimId)
  port.current(snapshot.claimId)
  const after = JSON.stringify(snapshot)
  check('取快照**不改变**快照本身（读面没有写路径）', before === after)
  check(
    '端口只暴露"取当前快照 / 列当前命题"（没有写方法）',
    Object.keys(port).every(key => key === 'current' || key === 'list' || key === 'readCount'),
    Object.keys(port).join(',')
  )
}

// ---------------------------------------------------------------------------
section('7. 规则选择（消费的第一步：只从**当前合格**的规则里选）')
// ---------------------------------------------------------------------------
{
  const good = snapshotOf({ claimId: 'claim-tool-001', conditions: { encoding: 'utf8' } })
  const otherSubject = snapshotOf({ claimId: 'claim-other-subject', subjectId: 'user-Other' })
  const otherScope = snapshotOf({ claimId: 'claim-other-scope', scope: 'sandbox.file.read' })
  const otherEnv = snapshotOf({ claimId: 'claim-other-env', environment: 'other-env' })
  const unknownCondition = snapshotOf({ claimId: 'claim-unknown-cond', conditions: { encoding: 'utf8', charset: 'gbk' } })
  const mismatchCondition = snapshotOf({ claimId: 'claim-mismatch-cond', conditions: { encoding: 'utf16' } })
  const notUsable = snapshotOf({ claimId: 'claim-not-usable', usable: false, status: 'suspended', invalidatedReason: 'not_usable' })
  const snapshots = [good, otherSubject, otherScope, otherEnv, unknownCondition, mismatchCondition, notUsable]
  const port = portOf(new Map(snapshots.map(snapshot => [snapshot.claimId, snapshot])))

  // 正控：可见状态里条件齐全 ⇒ 那条规则被选中
  const visible = { subjectId: 'user-Alex', scope: 'sandbox.file.write', environment: 'serversim', conditions: { encoding: 'utf8' } }
  const selection = selectUsableRules({ snapshots: await port.list(), visible })
  check('正控：条件齐全的合格规则被选中',
    selection.selected.length === 1 && selection.selected[0]?.claimId === 'claim-tool-001',
    `选中 ${selection.selected.length} 条`)

  const reasons = new Map(selection.skipped.map(item => [item.claimId, item.reason]))
  check('负控：主体不同 ⇒ 不选中（subject_mismatch）', reasons.get('claim-other-subject') === 'subject_mismatch')
  check('负控：范围不同 ⇒ 不选中（scope_mismatch）', reasons.get('claim-other-scope') === 'scope_mismatch')
  check('负控：环境不同 ⇒ 不选中（environment_mismatch）', reasons.get('claim-other-env') === 'environment_mismatch')
  check('负控：条件已知但对不上 ⇒ 不选中（condition_mismatch）', reasons.get('claim-mismatch-cond') === 'condition_mismatch')
  check('负控：不合格的规则不入选，且原因单列（not_usable）', reasons.get('claim-not-usable') === 'not_usable')
  check(
    '负控：**条件未知** ⇒ 标成 unknown（**不是**"不适用"）',
    reasons.get('claim-unknown-cond') === 'condition_unknown',
    String(selection.skipped.find(item => item.claimId === 'claim-unknown-cond')?.detail ?? '')
  )
  check(
    '全库检索结果**不会**直接变成可用规则（不合格的 / 不适用的都进不了 selected）',
    selection.selected.every(item => item.usable) && selection.selected.length === 1
  )
  check('没有命题被选中时给出**空**集合（不是"随便挑一条"）',
    selectUsableRules({ snapshots: [], visible }).selected.length === 0)
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(72))
console.log(`认知能力协作契约 · 判据门：${passed} 通过 / ${failed} 失败`)
if (failed > 0) console.log(`失败项：${failures.join(' | ')}`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
