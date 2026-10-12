/**
 * M5 WP3 —— **Retrieval Adapter 门**（`pnpm m5:retrieval:verify`）。
 *
 * ============================================================================
 *  它证明的是"宽召回 + 资格过滤"这条链，而不是"函数返回了什么"
 * ============================================================================
 * 计划书 WP3 的测试要求：
 *
 *     构造 relevant / irrelevant / wrong user / forgotten / superseded 混合 fixture。
 *     确保 Candidate Retrieval 可以**宽召回**；但 Eligibility 后**非法候选全部消失**。
 *
 * 因此这份门有三段，缺一段就会变成"看起来绿"：
 *
 *   ① **宽召回**：非法候选（别人的 / 已遗忘 / 已取代 / 证据已不存在）**必须出现在**
 *      候选里 —— 它们在适配器里被提前滤掉的话，WP2 的零泄漏计数就永远返回 0，
 *      而"永远是 0"与"真的没有泄漏"在输出上完全一样。
 *   ② **资格后消失**：接 WP2 之后，非法候选必须各带**精确的理由**被拒，
 *      合法候选必须被放行（正控），且泄漏计数为 0。
 *   ③ **只读**：取候选前后，整个 Memory Space 的**规范化快照哈希**必须不变。
 *
 * 另有几条"如实"断言：能力报告必须把语义维度列为**不可用**（G3 裁定），
 * 保留通道（explicit_id / canonical_key）不许出现在 `retrievedBy` 里。
 *
 * 跑法：pnpm m5:retrieval:verify        （在一次性沙箱库上，不碰真实库、不调模型）
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import { M4_T0, createM4Harness, createReporter, snapshotOf } from './m4-harness.ts'
import { exec } from '../src/infrastructure/persistence/db.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { measureLeakage } from '../src/kernel/recall/eligibility.ts'
import { describeRetrievalCapabilities } from '../src/kernel/recall/ports.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import {
  RECALL_CHANNEL_FACTS,
  RESERVED_RECALL_CHANNELS,
  createRecallRequest,
  type RecallCandidate,
  type RecallRequest,
} from '../src/kernel/contracts/recall.ts'

const report = createReporter()
const sandbox = isolateDatabase('m5-retrieval', { keep: false })
await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'm5-retrieval' })

const owner = h.owner
const user = h.user
const otherUser = h.newSubject('someone-else')

// ---------------------------------------------------------------------------
// fixture：relevant / irrelevant / wrong user / forgotten / superseded / orphan
// ---------------------------------------------------------------------------

const claim = (predicate: string, value: string) =>
  ({ kind: 'claim' as const, subject: user, predicate, value })

// ① relevant：问"我在哪所大学"时它应该被想起来
const relevantEvidence = await h.recordUserEvidence('记住，我现在上的大学是示例工程科技大学')
const relevant = (await h.commitAndFold(
  h.makeCandidate('person_fact', claim('education.institution', '示例工程科技大学'), {
    sourceRefs: [relevantEvidence.ref],
  }),
  M4_T0 + 100
))!

// ② irrelevant：合法但与这句话无关（宽召回会带上它，排序阶段才淘汰）
const irrelevantEvidence = await h.recordUserEvidence('记住，我不吃香菜')
const irrelevant = (await h.commitAndFold(
  h.makeCandidate('preference', claim('food.preference.cilantro', 'dislike'), {
    sourceRefs: [irrelevantEvidence.ref],
  }),
  M4_T0 + 200
))!

// ③ wrong user：讲的是另一个人
const otherEvidence = await h.recordUserEvidence('他说他在读研究生')
const otherSubjectClaim = {
  kind: 'claim' as const,
  subject: otherUser,
  predicate: 'education.status',
  value: 'graduate',
}
const wrongUser = (await h.commitAndFold(
  h.makeCandidate('person_fact', otherSubjectClaim, {
    sourceRefs: [otherEvidence.ref],
    subjects: [otherUser],
  }),
  M4_T0 + 300
))!

// ④ forgotten：建立后真实遗忘
const forgottenEvidence = await h.recordUserEvidence('记住，我平时主要用 Windows')
const forgotten = (await h.commitAndFold(
  h.makeCandidate('person_fact', claim('device.primary', 'Windows'), {
    sourceRefs: [forgottenEvidence.ref],
  }),
  M4_T0 + 400
))!
const forgetTurn = await h.recordUserEvidence('忘掉我平时用 Windows 这件事')
await h.applyStateChange(
  'retract',
  forgetTurn.ref.id,
  { memoryId: forgotten.id, reason: 'explicit_forget', note: '用户要求忘掉' },
  M4_T0 + 450
)

// ⑤ superseded：同槽位新值取代旧值（旧条曾经为真）
const oldEvidence = await h.recordUserEvidence('记住，我讨厌辣')
const oldSpicy = (await h.commitAndFold(
  h.makeCandidate('preference', claim('food.avoid.general', '回避辣'), {
    sourceRefs: [oldEvidence.ref],
  }),
  M4_T0 + 500
))!
const newEvidence = await h.recordUserEvidence('那个改一下，我现在能吃辣了')
const newSpicy = (await h.commitAndFold(
  h.makeCandidate('preference', claim('food.avoid.general', '喜欢辣'), {
    sourceRefs: [newEvidence.ref],
  }),
  M4_T0 + 600
))!
await h.applyStateChange(
  'supersede',
  newEvidence.ref.id,
  { memoryId: oldSpicy.id, supersededBy: newSpicy.id, validUntil: M4_T0 + 600, reason: '能吃了' },
  M4_T0 + 600
)

// ⑥ orphan：证据事件被直接删掉（模拟 M5-PRE 修好之前的历史遗留形状）
const orphanEvidence = await h.recordUserEvidence('记住，我最喜欢的颜色是蓝色')
const orphan = (await h.commitAndFold(
  h.makeCandidate('preference', claim('preference.color.favorite', 'blue'), {
    sourceRefs: [orphanEvidence.ref],
  }),
  M4_T0 + 700
))!
await exec(
  h.db,
  sql`delete from conversation_events where id = ${orphanEvidence.ref.id}`,
  '（fixture）制造悬空证据'
)

// ---------------------------------------------------------------------------
// 装配：真实的 store + M5-PRE 探针 + 适配器 + 应用服务
// ---------------------------------------------------------------------------

const retrievalPort = createMemoryRetrievalStore({
  store: h.store,
  // ⚠️ 探针来自 M5-PRE（同一个 DB）—— 适配器不许另写一套"证据还在不在"
  integrity: (o) => memoryIntegrityProblems(h.db, o),
  // Phase 4b：根证据受信读数（**必填** —— 忘记接线会让每条事实都被标成"来源未确立"）
  rootReadings: (ids) => rootReadingsByMemory(h.db, ids),
})
const service = createMemoryRecallService({ port: retrievalPort })

const request = (overrides: Partial<Parameters<typeof createRecallRequest>[0]> = {}): RecallRequest =>
  createRecallRequest({
    traceId: 'trace:wp3',
    characterId: h.characterId,
    user,
    /*
     * ⚠️ **M9.5 / `D-5`（`ADR-084`）**：片段粒度 **2 字 → 3 字** ⇒
     *    原来靠共享 `大学`（2 字）构成词面命中，**现在不再构成** ✗ ⇒
     *    断言"related 走 lexical 通道"失败 ✓
     * ⇒ 问句改成**与取值共享 3 字片段**（`西安电`/`安电子`/…/`技大学`）⇒ 意图不变 ✓
     */
    query: { text: '你还记得示例工程科技大学吗？' },
    intent: 'current_fact',
    ...overrides,
  })

report.section('① 宽召回：非法候选必须出现在候选里（否则 WP2 的计数失去意义）')
const wide = await service.recall({ request: request() })
const ids = new Set(wide.candidates.map((c) => String(c.memoryId)))

report.check(
  'relevant / irrelevant / wrong-user / forgotten / superseded / orphan 全部被取回',
  [relevant, irrelevant, wrongUser, forgotten, oldSpicy, orphan].every((r) =>
    ids.has(String(r.id))
  ),
  `取回 ${wide.candidates.length} 条（scanned=${wide.scanned}）`
)
report.check(
  '适配器**没有**替资格层做过滤（这就是"宽召回"的可测形式）',
  ids.has(String(wrongUser.id)) && ids.has(String(forgotten.id)) && ids.has(String(oldSpicy.id)),
  '别人的 / 已遗忘 / 已取代 的都还在候选里'
)
report.check('每一条候选都有检索通道（可解释）', wide.candidates.every((c) => c.retrievedBy.length > 0))
report.check(
  'related 那条走的是 lexical 通道（问句里有"大学"）',
  (wide.candidates.find((c) => String(c.memoryId) === String(relevant.id))?.retrievedBy ?? []).includes(
    'lexical'
  ),
  JSON.stringify(wide.candidates.find((c) => String(c.memoryId) === String(relevant.id))?.retrievedBy)
)
report.check(
  'subject 通道确实在工作（同一用户的全量候选）',
  wide.candidates.some((c) => c.retrievedBy.includes('subject'))
)
report.check(
  '保留通道不许出现：explicit_id / canonical_key',
  wide.candidates.every((c) => c.retrievedBy.every((ch) => !RESERVED_RECALL_CHANNELS.includes(ch))),
  `保留通道 = ${RESERVED_RECALL_CHANNELS.join(',')}`
)
report.check(
  '通道登记表：三条有生产者、两条是保留位（AT3.2 的答案）',
  RECALL_CHANNEL_FACTS.subject.produced &&
    RECALL_CHANNEL_FACTS.recency.produced &&
    RECALL_CHANNEL_FACTS.lexical.produced &&
    !RECALL_CHANNEL_FACTS.explicit_id.produced &&
    !RECALL_CHANNEL_FACTS.canonical_key.produced
)

report.section('② 能力报告：语义维度必须**如实**列为不可用（G3 裁定）')
report.check(
  'available 含 subject/recency/lexical/time/kind',
  ['subject', 'recency', 'lexical', 'time', 'kind'].every((d) =>
    (wide.capabilities.available as readonly string[]).includes(d)
  ),
  describeRetrievalCapabilities(wide.capabilities)
)
report.check(
  'unavailable 明确写出 semantic 与原因（不许伪造成 0 分）',
  wide.capabilities.unavailable.some((item) => item.dimension === 'semantic' && item.reason.length > 0),
  JSON.stringify(wide.capabilities.unavailable)
)

report.section('③ 完整性：integrityOk 必须来自 M5-PRE 的探针')
const orphanCandidate = wide.candidates.find((c) => String(c.memoryId) === String(orphan.id))
const relevantCandidate = wide.candidates.find((c) => String(c.memoryId) === String(relevant.id))
report.check('悬空证据的那条 integrityOk = false', orphanCandidate?.integrityOk === false)
report.check('正常的记忆 integrityOk = true', relevantCandidate?.integrityOk === true)

report.section('④ 接 WP2：非法候选各带精确理由被拒，合法候选放行')
const leakage = measureLeakage({ request: request(), verdicts: wide.eligibility.verdicts })
const reasonOf = (memoryId: string): string | undefined =>
  wide.eligibility.verdicts.find((v) => String(v.candidate.memoryId) === memoryId)?.verdict.reason

report.check('relevant 通过资格（正控）', reasonOf(String(relevant.id)) === undefined)
report.check('wrong-user → WRONG_USER', reasonOf(String(wrongUser.id)) === 'WRONG_USER')
report.check('forgotten → FORGOTTEN', reasonOf(String(forgotten.id)) === 'FORGOTTEN')
report.check('superseded（current_fact）→ SUPERSEDED', reasonOf(String(oldSpicy.id)) === 'SUPERSEDED')
report.check('orphan → ORPHANED_EVIDENCE（不是 DELETED）', reasonOf(String(orphan.id)) === 'ORPHANED_EVIDENCE')
report.check(
  'irrelevant 仍然**通过资格**（淘汰它是 WP4 排序的事，不是资格的事）',
  reasonOf(String(irrelevant.id)) === undefined
)
report.check(
  '泄漏计数 = 0',
  leakage.forgotten + leakage.wrongUser + leakage.wrongNamespace + leakage.invalidTarget + leakage.orphanedEvidence === 0,
  JSON.stringify(leakage)
)

report.section('⑤ 检索维度：timeScope 与 memoryKinds 真的起作用')
const windowed = await service.retrieveCandidates(
  request({ timeScope: { kind: 'range', from: M4_T0 + 650, to: M4_T0 + 750 } })
)
report.check(
  '时间窗把范围外的记忆挡掉（只剩 orphan 那条 M4_T0+700）',
  windowed.candidates.length === 1 && String(windowed.candidates[0]!.memoryId) === String(orphan.id),
  `actual=${windowed.candidates.map((c) => String(c.memoryId)).join(',')}`
)
const onlyFacts = await service.retrieveCandidates(request({ memoryKinds: ['person_fact'] }))
report.check(
  'memoryKinds 只返回 person_fact',
  onlyFacts.candidates.every((c: RecallCandidate) => c.type === 'person_fact') &&
    onlyFacts.candidates.length > 0,
  `types=${[...new Set(onlyFacts.candidates.map((c) => c.type))].join(',')}`
)
const historical = await service.recall({ request: request({ intent: 'historical' }) })
report.check(
  '历史查询允许 superseded 通过资格（"以前……"必须想得起来）',
  historical.eligibility.verdicts.find((v) => String(v.candidate.memoryId) === String(oldSpicy.id))?.verdict
    .eligible === true
)
const supersededHistoricalEvidence = await h.store.get(oldSpicy.id)
report.check(
  '旧条确实处于 superseded（否则上面那条是空过）',
  supersededHistoricalEvidence?.status === 'superseded',
  `status=${supersededHistoricalEvidence?.status}`
)

report.section('⑥ 确定性：同样的输入给同样的顺序')
const first = await service.retrieveCandidates(request())
const second = await service.retrieveCandidates(request())
report.check(
  '两次取候选的 id 顺序完全一致',
  first.candidates.map((c) => String(c.memoryId)).join(',') ===
    second.candidates.map((c) => String(c.memoryId)).join(',')
)

report.section('⑦ 只读：取候选前后 Memory Space 的规范化快照哈希不变')
const before = await snapshotOf(h.store, owner)
await service.retrieveCandidates(request())
const after = await snapshotOf(h.store, owner)
report.check('快照哈希一致（适配器没有写任何表）', before.hash === after.hash)

report.section('⑧ 翻译（AT3.1）：RecallRequest → 后端无关的查询')
const translated = service.translate(request())
report.check('翻译保留了 user scope / kinds / timeScope / limit', translated.user.kind === 'user' && translated.limit === 50)
report.check(
  'target 解析后会把 targetSubject 交给后端',
  service.translate(
    request({
      target: {
        status: 'resolved',
        subject: user,
        via: 'canonical_key',
        confidence: 'exact',
      },
    })
  ).targetSubject?.kind === 'user'
)
report.check(
  'target 未解析时不编一个 subject（不猜）',
  service.translate(request({ target: { status: 'not_found', via: 'x' } })).targetSubject === undefined
)
report.check('portName 进证据（换后端时可追溯）', service.portName === 'native-memory-retrieval-store')

// ---------------------------------------------------------------------------
// 证据 + 收尾
// ---------------------------------------------------------------------------

mkdirSync(join(process.cwd(), 'artifacts', 'm5'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5', 'wp3-retrieval.json'),
  `${JSON.stringify(
    {
      testId: 'M5 / WP3 retrieval adapter',
      generatedAt: new Date().toISOString(),
      passed: report.passed,
      failed: report.failed,
      failures: [...report.failures],
      port: service.portName,
      scanned: wide.scanned,
      candidateCount: wide.candidates.length,
      candidates: wide.candidates.map((c) => ({
        memoryId: String(c.memoryId),
        type: c.type,
        status: c.status,
        channels: c.retrievedBy,
        integrityOk: c.integrityOk,
        reason:
          wide.eligibility.verdicts.find((v) => String(v.candidate.memoryId) === String(c.memoryId))
            ?.verdict.reason ?? null,
      })),
      capabilities: wide.capabilities,
      leakage,
      channelFacts: RECALL_CHANNEL_FACTS,
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('\n证据已写入：artifacts/m5/wp3-retrieval.json')

await h.stop()
cleanupSandbox(sandbox.dir)
report.finish('M5 WP3 Retrieval Adapter')
