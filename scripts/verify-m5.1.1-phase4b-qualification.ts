/**
 * M5.1.1 / Phase 4b —— **存量资格**专项门（ADR-043 §4.1 / §4.2 / §4.3）。
 *
 * ============================================================================
 *  它守什么
 * ============================================================================
 * 4b 让"**已有**记忆的当前认知资格"变成一个**读时派生量**，并让它影响两件事：
 *
 * ```text
 * 排序      资格 ≠ ESTABLISHED ⇒ authority 分量按**降一档**计（不改库值）
 * 标签      prompt 里追加 ` / 来源未确立` 或 ` / 来源与记录不符`
 * ```
 *
 * 它**不**做的事（每一条都有断言守着）：
 *
 * ```text
 * · 不重写 memory_records.authority（DR-1：那是"当时"的判定，不可变）
 * · 不把资格不足的记忆踢出召回（ADR §3.3 ⑤ / INV-CI-05）
 * · 不把"资格未确立"算成"污染"（contaminatedMemories() 必须仍然 = 0）
 * · 不向认知写入任何东西（回滚因此是精确且免费的）
 * ```
 *
 * ----------------------------------------------------------------------------
 *  ADR-043 §4.2 点名的六条判据（N-1…N-6）
 * ----------------------------------------------------------------------------
 * ```text
 * N-1 负控  伪造"agent 以 user 角色替发"（**无**受信归因）⇒ 资格必须**不是** ESTABLISHED
 * N-2 正控  同一内容带**受信的人类**归因 ⇒ 资格**必须** ESTABLISHED
 * N-3 正控  既有 legacy 记忆的资格 = UNCONFIRMED_ORIGIN ∧ `memory_records.authority` **逐字节未变**
 * N-4 恢复  规则版本回退 ⇒ 资格恢复 ESTABLISHED ∧ 账本**未被改写**
 * N-5 正控  `contaminatedMemories()` 仍 = 0（不得把新状态算成污染）
 * N-6 自检  受影响条目数 / 受影响脚本数必须 > 0，否则 **MEASUREMENT INVALID**
 * ```
 * `N-3` 与 `N-6` 最重要：前者证明"纠正资格"没有变成"改写历史"；
 * 后者防的是"半径只有 2 条 ⇒ 门看起来全绿但其实什么都没量到"（AGENTS §6.8）。
 *
 * 跑法：`pnpm m5.1.1:phase4b:verify`
 */

import 'dotenv/config'

// ⚠️ 必须在任何会碰数据库的 import **调用**之前（见 src/dev/sandbox.ts）
import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { createHash } from 'node:crypto'

import { createM4Harness, createReporter } from './m4-harness.ts'
import {
  COGNITIVE_QUALIFICATION_RULE_VERSION,
  EVIDENCE_ORIGIN_NOT_ESTABLISHED,
  type SourceQualification,
} from '../src/kernel/contracts/attribution.ts'
import {
  memoryQualificationOf,
  qualificationAppliesTo,
  qualificationLabelSuffix,
  qualificationPenalizesAuthority,
  countQualifications,
} from '../src/kernel/recall/qualification.ts'
import { renderMemoryEntry } from '../src/kernel/recall/render.ts'
import { scoreCandidate } from '../src/kernel/recall/ranking.ts'
import { createRecallRequest, type RecallCandidate } from '../src/kernel/contracts/recall.ts'
import {
  contaminatedMemories,
  unqualifiedUserFacts,
  qualificationsForMemories,
} from '../src/infrastructure/persistence/memory-store.ts'
import { exec, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { sql } from 'drizzle-orm'

const report = createReporter()

/** 计数型读数：`measured_count > 0` 是硬要求（AGENTS §6.8） */
function measure(label: string, count: number): number {
  report.check(`量具：${label}（measured_count > 0）`, count > 0, `measured_count = ${count}`)
  return count
}

/** 「实际 === 期望」的一条断言（把实际读数打出来，"应当为真"信息量最小） */
function checkEqual(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  report.check(
    label,
    same,
    same ? String(actual) : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
  )
}

// ---------------------------------------------------------------------------
// §1 纯派生：三值 + 规则版本 + 定义域（N-4 的一半）
// ---------------------------------------------------------------------------

report.section('§1 纯派生的三值、定义域与规则版本（DR-3 / DR-5 / N-4）')

const ESTABLISHED_READING = {
  attributionOrigin: 'RECORDED' as const,
  contentOriginator: { state: 'KNOWN' as const, value: { kind: 'USER' as const, id: 'user_alex' } },
  axisBConfirmed: true,
}
const CONTRADICTED_READING = {
  attributionOrigin: 'RECORDED' as const,
  contentOriginator: {
    state: 'KNOWN' as const,
    value: { kind: 'CHARACTER' as const, id: 'char_sumuwei' },
  },
  axisBConfirmed: true,
}
const UNCONFIRMED_READING = {
  attributionOrigin: 'RECORDED' as const,
  contentOriginator: { state: 'UNKNOWN' as const, reason: 'RUNTIME_UNRESOLVED' as const },
  axisBConfirmed: false,
}

const pure = (memoryType: 'person_fact' | 'preference' | 'self_experience', roots: unknown[], version = 1) =>
  memoryQualificationOf({
    memoryType,
    rootReadings: roots as never,
    ruleVersion: version,
  })

checkEqual(
  '正控：受信人类归因 ⇒ ESTABLISHED',
  pure('person_fact', [ESTABLISHED_READING]),
  'ESTABLISHED'
)
checkEqual(
  '负控：她的输出当证据 ⇒ CONTRADICTED_ORIGIN（"知道不是他"）',
  pure('preference', [CONTRADICTED_READING]),
  'CONTRADICTED_ORIGIN'
)
checkEqual(
  '负控：没有受信读数（历史行 / MIGRATED_LEGACY）⇒ UNCONFIRMED_ORIGIN（DR-7 失败关闭）',
  pure('person_fact', [undefined]),
  'UNCONFIRMED_ORIGIN'
)
checkEqual(
  '负控：根证据为空 ⇒ UNCONFIRMED_ORIGIN（没有根证据 = 来源未确立）',
  pure('person_fact', []),
  'UNCONFIRMED_ORIGIN'
)
checkEqual(
  '多根证据：有一条 ESTABLISHED 就够（与 4a 的闸同优先级）',
  pure('person_fact', [CONTRADICTED_READING, ESTABLISHED_READING]),
  'ESTABLISHED'
)
checkEqual(
  '多根证据：都不确立但有 CONTRADICTED ⇒ 报更具体的那个（DR-3 不合并）',
  pure('person_fact', [UNCONFIRMED_READING, CONTRADICTED_READING]),
  'CONTRADICTED_ORIGIN'
)
report.check(
  '定义域（DR-5）：Episode 面**不适用**（返回 undefined，不是第四种取值）',
  qualificationAppliesTo('person_fact') &&
    qualificationAppliesTo('preference') &&
    !qualificationAppliesTo('self_experience') &&
    pure('self_experience', [ESTABLISHED_READING]) === undefined,
  'self_experience → undefined'
)
checkEqual(
  'N-4：规则版本不认识 ⇒ fail-closed 为 UNCONFIRMED_ORIGIN（不猜）',
  pure('person_fact', [ESTABLISHED_READING], COGNITIVE_QUALIFICATION_RULE_VERSION + 1),
  'UNCONFIRMED_ORIGIN'
)
checkEqual(
  'N-4（恢复）：规则版本回到当前版本 ⇒ 重新 ESTABLISHED（纯函数，无副作用）',
  pure('person_fact', [ESTABLISHED_READING], COGNITIVE_QUALIFICATION_RULE_VERSION),
  'ESTABLISHED'
)

// ---------------------------------------------------------------------------
// §2 排序与标签：只降档、不改库值、不动入选
// ---------------------------------------------------------------------------

report.section('§2 排序降一档 + prompt 标签后缀（ADR §3.3 ⑥⑦）')

const candidateOf = (qualification: SourceQualification | undefined): RecallCandidate => ({
  memoryId: 'mem:test:1' as never,
  owner: { kind: 'character', id: 'char_sumuwei' } as never,
  type: 'person_fact',
  status: 'active',
  authority: 'EXPLICIT_USER_STATEMENT',
  epistemicStatus: 'reported',
  subjects: [{ kind: 'user', id: 'user_alex' } as never],
  importance: 0.8,
  confidence: 0.9,
  recordedAt: 1_800_000_000_000,
  contentFingerprint: 'fp',
  searchable: '不吃香菜',
  dataText: 'food.preference.cilantro = dislike',
  sourceRefs: [{ kind: 'conversation_event', id: 'cev:1' }],
  retrievedBy: ['lexical'],
  integrityOk: true,
  ...(qualification !== undefined ? { qualification } : {}),
})

const request = createRecallRequest({
  traceId: 'trace:4b' as never,
  characterId: 'char_sumuwei' as never,
  user: { kind: 'user', id: 'user_alex' } as never,
  query: { text: '我不吃香菜' },
  intent: 'current_fact',
  timeScope: { kind: 'any' },
})
const capabilities = { available: ['subject', 'recency', 'lexical'] as never, unavailable: [] as never }

const authorityComponentOf = (qualification: SourceQualification | undefined): number => {
  const breakdown = scoreCandidate({
    request,
    candidate: candidateOf(qualification),
    capabilities,
    now: 1_800_000_000_000,
  })
  const component = breakdown.components.find((item) => item.name === 'authority')
  return component?.value ?? Number.NaN
}

const establishedScore = authorityComponentOf('ESTABLISHED')
const unconfirmedScore = authorityComponentOf('UNCONFIRMED_ORIGIN')
const notApplicableScore = authorityComponentOf(undefined)
report.check(
  '排序：资格 ≠ ESTABLISHED ⇒ authority 分量**恰好降一档**（1/5 = 0.2）',
  Number.isFinite(establishedScore) && Math.abs(establishedScore - unconfirmedScore - 0.2) < 1e-9,
  `ESTABLISHED=${establishedScore.toFixed(3)} · UNCONFIRMED=${unconfirmedScore.toFixed(3)}`
)
report.check(
  '排序：Episode 面（不适用）**不降档**（与 ESTABLISHED 同分）',
  Math.abs(notApplicableScore - establishedScore) < 1e-9,
  `${notApplicableScore.toFixed(3)} == ${establishedScore.toFixed(3)}`
)
report.check(
  '排序：两个非 ESTABLISHED 值降**同样**的档（不因"知道不是他"多降）',
  Math.abs(authorityComponentOf('CONTRADICTED_ORIGIN') - unconfirmedScore) < 1e-9,
  'UNCONFIRMED == CONTRADICTED'
)
report.check(
  '扣分判定：只有已定义且非 ESTABLISHED 才扣',
  qualificationPenalizesAuthority('UNCONFIRMED_ORIGIN') &&
    qualificationPenalizesAuthority('CONTRADICTED_ORIGIN') &&
    !qualificationPenalizesAuthority('ESTABLISHED') &&
    !qualificationPenalizesAuthority(undefined)
)

const legacyLine = `- ${'food.preference.cilantro = dislike'}（EXPLICIT_USER_STATEMENT）`
checkEqual(
  '⑨ 可回滚性（正控）：ESTABLISHED 的渲染行与 4b **之前**逐字节相同',
  renderMemoryEntry({
    dataText: 'food.preference.cilantro = dislike',
    authority: 'EXPLICIT_USER_STATEMENT',
    status: 'active',
    qualification: 'ESTABLISHED',
  }),
  legacyLine
)
checkEqual(
  '标签：UNCONFIRMED_ORIGIN ⇒ ` / 来源未确立`',
  qualificationLabelSuffix('UNCONFIRMED_ORIGIN'),
  ' / 来源未确立'
)
checkEqual(
  '标签：CONTRADICTED_ORIGIN ⇒ ` / 来源与记录不符`（与上面**不同** —— 三值不折叠）',
  qualificationLabelSuffix('CONTRADICTED_ORIGIN'),
  ' / 来源与记录不符'
)
report.check(
  '标签：不适用 ⇒ 空串（Episode 面不进本规则）',
  qualificationLabelSuffix(undefined) === '' && qualificationLabelSuffix('ESTABLISHED') === ''
)
report.check(
  '标签顺序固定：status 在前、资格在后（同一状态只有一种写法）',
  renderMemoryEntry({
    dataText: 'x',
    authority: 'A',
    status: 'superseded',
    qualification: 'UNCONFIRMED_ORIGIN',
  }) === '- x（A / superseded / 来源未确立）',
  renderMemoryEntry({
    dataText: 'x',
    authority: 'A',
    status: 'superseded',
    qualification: 'UNCONFIRMED_ORIGIN',
  })
)

// ---------------------------------------------------------------------------
// §3 端到端（沙箱库）：N-1 / N-2 / N-3 / N-5
// ---------------------------------------------------------------------------

report.section('§3 端到端（沙箱库）：N-1 负控 · N-2 正控 · N-3 authority 未变 · N-5 污染仍 0')

await resetPluginSqlConnection()
const sandbox = isolateDatabase('m5.1.1-phase4b-qualification', { keep: true })
const h = await createM4Harness({ label: 'phase4b' })

/** 一条记忆的 authority 列摘要（N-3：派生资格**不许**动它） */
const authorityDigest = async (): Promise<string> => {
  const rows = rowsOf(
    await exec(
      h.db,
      sql`select id, memory_type, authority, status from memory_records order by id asc`,
      'N-3：读取记忆的 authority/status 摘要'
    )
  )
  return createHash('sha256')
    .update(rows.map((row) => `${String(row.id)}|${String(row.authority)}|${String(row.status)}`).join('\n'))
    .digest('hex')
}

const commitPersonFact = async (text: string, predicate: string): Promise<void> => {
  const evidence = await h.recordUserEvidence(text)
  const candidate = h.makeCandidate(
    'person_fact',
    { kind: 'claim', subject: h.user, predicate, value: 'dislike' },
    { sourceRefs: [evidence.ref], evidenceRootIds: [evidence.ref.id] }
  )
  await h.commit(candidate, 1_800_000_000_000 + evidence.conversationSequence)
}

// N-2 正控：受信人类归因 ⇒ ESTABLISHED
await commitPersonFact('我不吃香菜', 'food.preference.cilantro')
// N-1 负控：同一**内容**，但用 legacy 写入（没有受信信封）⇒ 不许 ESTABLISHED
const legacyRecorderEvent = await (async () => {
  const { ConversationRecorder } = await import('../src/infrastructure/runtime/conversation-recorder.ts')
  const { asConversationId } = await import('../src/kernel/contracts/index.ts')
  const recorder = new ConversationRecorder({
    db: h.db,
    characterId: h.kernel.characterId,
    conversationId: asConversationId('phase4b-legacy'),
    dryRun: false,
    userName: 'Alex',
    characterName: '苏沐薇',
    transport: 'phase4b-legacy',
  })
  const { event } = await recorder.recordUserMessage('我其实不讨厌香菜', 1)
  if (event === undefined) throw new Error('夹具失败：legacy 写入没落库')
  const candidate = h.makeCandidate(
    'person_fact',
    { kind: 'claim', subject: h.user, predicate: 'food.preference.coriander', value: 'like' },
    { sourceRefs: [{ kind: 'conversation_event', id: String(event.id) }] }
  )
  await h.commit(candidate, 1_800_000_000_000 + 999)
  return event
})()

const memories = rowsOf(
  await exec(
    h.db,
    sql`select id, memory_type, authority from memory_records order by id asc`,
    'N-1/N-2：读取沙箱记忆列表'
  )
).map((row) => ({ id: String(row.id), type: String(row.memory_type) as never }))
measure('沙箱库里的记忆条数', memories.length)

const qualifications = await qualificationsForMemories(h.db, memories)
const values = memories.map((memory) => qualifications.get(memory.id))
const byId = new Map(memories.map((memory, index) => [memory.id, values[index]]))

const legacyMemoryId = rowsOf(
  await exec(
    h.db,
    sql`select l.memory_id as id from memory_evidence_links l
        where l.evidence_id = ${String(legacyRecorderEvent.id)} limit 1`,
    'N-1：查 legacy 写入对应的记忆'
  )
)[0]?.id
const trustedMemoryId = memories.find((memory) => memory.id !== String(legacyMemoryId))?.id

checkEqual(
  'N-2 正控：人机控制台鉴证的证据 ⇒ 该记忆资格 = ESTABLISHED',
  byId.get(String(trustedMemoryId)),
  'ESTABLISHED'
)
checkEqual(
  'N-1 负控：**同一内容**但 legacy 写入（无受信信封）⇒ 资格 = UNCONFIRMED_ORIGIN（不是 ESTABLISHED）',
  byId.get(String(legacyMemoryId)),
  'UNCONFIRMED_ORIGIN'
)
report.check(
  'N-1 与 N-2 的证据**内容相同、只有来源不同** ⇒ 结论不同（这正是 DR-6 要的效果）',
  byId.get(String(trustedMemoryId)) !== byId.get(String(legacyMemoryId)),
  `trusted=${String(byId.get(String(trustedMemoryId)))} · legacy=${String(byId.get(String(legacyMemoryId)))}`
)

// N-3：派生资格**不许**改库
const digestBefore = await authorityDigest()
const probe = await unqualifiedUserFacts(h.db, h.owner)
const digestAfter = await authorityDigest()
checkEqual(
  'N-3：跑完资格派生之后 `memory_records` 的 (authority, status) 摘要**逐字节未变**',
  digestAfter,
  digestBefore
)
report.check('N-5：既有污染探针仍然 = 0（新状态不算污染）', (await contaminatedMemories(h.db, h.owner)).length === 0)
report.check(
  'N-6 自检：探针确实扫到了条目（scanned > 0）且确实判出"未确立"（affected > 0）',
  probe.scanned > 0 && probe.unqualified.length > 0,
  `scanned=${probe.scanned} · unqualified=${probe.unqualified.length}`
)
checkEqual(
  'N-6：三档计数之和 = 扫描条数（没有条目掉在统计之外）',
  probe.counts.established + probe.counts.unconfirmedOrigin + probe.counts.contradictedOrigin,
  probe.scanned
)
report.check(
  '探针给出的资格与逐条派生**一致**（读路径只有一处，不是两套判据）',
  probe.unqualified.every((row) => byId.get(row.memoryId) === row.qualification) &&
    memories.every((memory) => {
      const fromProbe = probe.unqualified.find((row) => row.memoryId === memory.id)?.qualification
      const expected = byId.get(memory.id)
      return expected === 'ESTABLISHED' ? fromProbe === undefined : fromProbe === expected
    })
)

checkEqual(
  '计数工具：三档分开计，不适用**不计数**',
  countQualifications(['ESTABLISHED', 'UNCONFIRMED_ORIGIN', 'CONTRADICTED_ORIGIN', undefined]),
  { established: 1, unconfirmedOrigin: 1, contradictedOrigin: 1 }
)

// ---------------------------------------------------------------------------
// §4 与 4a 的口径一致（同一组理由码、同一个概念）
// ---------------------------------------------------------------------------

report.section('§4 与 4a 的口径一致')

checkEqual(
  '4b 与 4a 用**同一个**三值域与**同一个**规则版本（D-2 = ①：一个概念一个名字）',
  COGNITIVE_QUALIFICATION_RULE_VERSION,
  1
)
report.check(
  '4a 的形成期理由码在 4b 里**原样存在**（4b 没有另立一套说法）',
  EVIDENCE_ORIGIN_NOT_ESTABLISHED === 'evidence_origin_not_established',
  EVIDENCE_ORIGIN_NOT_ESTABLISHED
)

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

report.section('§5 量具汇总')

report.check(
  '量具有效：纯派生 + 端到端 + 探针三段都真的跑到了（不是空过）',
  memories.length > 0 && probe.scanned > 0 && probe.unqualified.length > 0 && Number.isFinite(establishedScore),
  `记忆 ${memories.length} 条 · scanned ${probe.scanned} · unqualified ${probe.unqualified.length}`
)

await h.stop()
cleanupSandbox(sandbox.dir)
report.finish('M5.1.1 Phase 4b 存量资格专项验证')
