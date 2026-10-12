/**
 * M4 人工审计语料生成（工程计划书第 217 节的 Gate；附件第 33 节）。
 *
 * ============================================================================
 *  §217 的原话，以及它为什么不能"直接在真实库上做"
 * ============================================================================
 *     在进入 M5 前随机抽取：至少数十条正式 Memory
 *     人工审计：这条东西真的值得记吗？来源正确吗？谁说的？是不是模型猜的？
 *               当前还有效吗？有没有重复？旧版本在哪里？为什么建立？
 *     如果这些问题不能快速回答：M4 不通过。
 *
 * 而真实库（`data/pglite`）目前只有 **2 条**记忆 —— 不是"她没什么可记"，
 * 是真实使用量还没到那个规模。`docs/m4/current-state.md` 早已裁定：
 *
 *     审计对象必须是 ① `evals/m4` 场景在沙箱里产出的记忆
 *                      + ② 真实库随日常使用增长的部分；
 *     且**不能用沙箱数据冒充实库数据**，必须在验收报告里如实写明。
 *
 * 本脚本负责 ①：在沙箱里造一份**覆盖各种形状**的语料，
 * 用**生产同一套** `renderMemoryAudit()` 渲染成审计清单。
 * 真实库那部分由 `pnpm memory:audit --limit N`（只读）单独产出。
 *
 * ---------------------------------------------------------------------------
 *  为什么语料要"覆盖各种形状"（而不是 40 条一模一样的偏好）
 * ---------------------------------------------------------------------------
 * §217 的八个问题里有两个是**只有在特定状态下才有答案**的：
 *
 *     ⑤ 当前还有效吗？   → 需要 superseded / retracted / disputed 三种状态
 *     ⑦ 旧版本在哪里？   → 需要真实的 revision 链
 *
 * 一份全是 ACTIVE 新建记忆的语料会让 ⑤ 与 ⑦ 的答案永远是"无"，
 * 于是那两问**看起来都答得出来**，其实一次都没被考到。
 *
 * 跑法：pnpm m4:audit
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderMemoryAudit } from '../src/kernel/app/memory/admin.ts'
import { describeProvenance, renderMemoryHistory } from '../src/kernel/app/memory/provenance.ts'
import {
  contaminatedMemories,
  domainEventsForMemory,
  unsupportedMemories,
} from '../src/infrastructure/persistence/memory-store.ts'
import type { MemoryRecord, NewMemoryCandidate } from '../src/kernel/contracts/index.ts'
import { createM4Harness, createReporter, M4_T0 } from './m4-harness.ts'

const report = createReporter()
const evidenceDir = join(process.cwd(), 'artifacts', 'm4-acceptance', 'audit')
const sandbox = isolateDatabase('m4-audit', { keep: true })
await resetPluginSqlConnection()

console.log('='.repeat(72))
console.log('M4 人工审计语料（沙箱）—— 计划书第 217 节')
console.log('='.repeat(72))
console.log(`实验库：${sandbox.dir}`)

const h = await createM4Harness({ label: 'audit' })
const { owner, user } = h

/** 单调递增的时间戳：语料必须**可复现**，不用 Math.random */
let tick = 0
const nextAt = (): number => M4_T0 + (tick += 100)

const claim = (predicate: string, value: string) =>
  ({ kind: 'claim', subject: user, predicate, value }) as never

async function create(
  predicate: string,
  value: string,
  type: 'person_fact' | 'preference' = 'person_fact',
  overrides: Partial<NewMemoryCandidate> = {}
): Promise<MemoryRecord | null> {
  const evidence = await h.recordUserEvidence(`（审计语料）${predicate} = ${value}`)
  return h.commitAndFold(
    h.makeCandidate(type, claim(predicate, value), {
      sourceRefs: [evidence.ref],
      ...overrides,
    }),
    nextAt()
  )
}

// ---------------------------------------------------------------------------
// 1. 覆盖登记表里的全部槽位（每个槽位**一条**）
// ---------------------------------------------------------------------------
report.section('1. 覆盖登记表里的全部槽位')
const slots: [string, string, 'person_fact' | 'preference'][] = [
  ['education.institution', '示例工程科技大学', 'person_fact'],
  ['education.status', 'undergraduate', 'person_fact'],
  ['education.major', '计算机科学与技术', 'person_fact'],
  ['device.primary', 'Windows', 'person_fact'],
  ['project.background.active', '苏沐薇角色 Agent', 'person_fact'],
  ['preferred.address', '西安', 'person_fact'],
  ['preferred.explanation.style', 'detailed', 'preference'],
  ['food.preference.cilantro', 'dislike', 'preference'],
  ['food.avoid.general', 'avoid-spicy', 'preference'],
  ['tooling.preference.editor', 'VS Code', 'preference'],
]

const byPredicate = new Map<string, MemoryRecord>()
for (const [predicate, value, type] of slots) {
  const record = await create(predicate, value, type)
  if (record !== null) byPredicate.set(predicate, record)
}

/*
 * ============================================================================
 *  为什么剩下的语料用 **episode** 而不是"同一槽位再写几条"
 * ============================================================================
 * 第一版这里写了 12 条 `project.background.active` + 8 条
 * `preferred.explanation.style`，结果是**同一个 canonical 槽位里
 * 12 条 ACTIVE 并存**。
 *
 * 那不是系统缺陷（槽位唯一的保证在**后台冲突分析器**里，不在 store 里；
 * `m4:verify` §16 用真实分析器覆盖了那一层），但它让这份语料
 * **不再是"槽位级冲突处置"的有效证词** —— 而它本来也不该冒充。
 *
 * Episode 没有 canonical key（一段经历本来就不是"一个事实槽位"），
 * 因此拿它凑规模既真实又不会伪造出槽位竞争。
 */
const episodeShapes: [string, 'observed' | 'reported' | 'inferred', number, number][] = [
  ['一起把 Memory 的证据链问题啃下来了', 'observed', 0.8, 0.9],
  ['第一次把上下文编译器的预算裁剪跑通', 'observed', 0.7, 0.9],
  ['一起确认了投影必须可重放', 'observed', 0.7, 0.85],
  ['聊到很晚，话题从架构跑到了猫', 'reported', 0.4, 0.8],
  ['她说想学一门新语言', 'reported', 0.5, 0.6],
  ['一起看了那次失败的迁移日志', 'observed', 0.6, 0.9],
  ['把真实库的 schema 升到了 5', 'observed', 0.8, 0.95],
  ['讨论了记忆的遗忘语义', 'observed', 0.7, 0.9],
  ['她说今天有点累', 'reported', 0.3, 0.5],
  ['一起把故障注入矩阵补齐', 'observed', 0.7, 0.9],
  ['聊到各自对"记住"的理解', 'reported', 0.5, 0.7],
  ['一起修掉了一个假绿用例', 'observed', 0.8, 0.9],
  ['她提到过喜欢安静的地方', 'reported', 0.4, 0.5],
  ['一起读了 MemOS 的插件说明', 'observed', 0.6, 0.9],
  ['讨论了 M5 的召回入口', 'observed', 0.6, 0.8],
  ['她说想把这段对话留着', 'reported', 0.5, 0.6],
  ['一起确认了 Seed 没有被侵蚀', 'observed', 0.8, 0.95],
  ['把一个 N+1 查询记进了技术债', 'observed', 0.5, 0.9],
  ['她问过为什么旧记忆不删掉', 'observed', 0.6, 0.8],
  ['一起确认了 Owner 与 Subject 是两件事', 'observed', 0.7, 0.9],
  ['聊到以后想去哪里', 'reported', 0.3, 0.4],
  ['一起把验收基线冻结下来', 'observed', 0.8, 0.9],
]
for (const [summary, epistemicStatus, importance, confidence] of episodeShapes) {
  const evidence = await h.recordUserEvidence(`（审计语料）${summary}`)
  await h.commitAndFold(
    h.makeCandidate(
      'episode',
      {
        kind: 'episode',
        summary,
        participants: [user],
        eventRefs: [evidence.ref.id],
      } as never,
      { sourceRefs: [evidence.ref], epistemicStatus, importance, confidence }
    ),
    nextAt()
  )
}

report.check('沙箱语料规模 ≥ 30 条', (await h.store.list({ owner, limit: 500 })).length >= 30)

// ---------------------------------------------------------------------------
// 2. revision 链 / 遗忘 / 存疑：让第 ⑤ 与第 ⑦ 问真的有内容
// ---------------------------------------------------------------------------
report.section('2. revision 链（supersede / retract / dispute）')

// ⚠️ 修订必须落在**同一个 predicate** 上，否则新旧两条不在同一个槽位，
//    链就断了（第一版把 canonicalKey 的哈希当 predicate 传了进去，
//    于是"新条"落进了一个凭空的槽位 —— 测试看起来通过，链是假的）。
const editor = byPredicate.get('tooling.preference.editor')!
const revEvidence = await h.recordUserEvidence('（审计语料）改一下：我现在主要用 Rider')
const replacement = (await h.commitAndFold(
  h.makeCandidate('preference', claim('tooling.preference.editor', 'JetBrains Rider'), {
    sourceRefs: [revEvidence.ref],
  }),
  nextAt()
))!
await h.applyStateChange(
  'supersede',
  revEvidence.ref.id,
  {
    memoryId: editor.id,
    supersededBy: replacement.id,
    validUntil: nextAt(),
    reason: '审计语料：用户换了编辑器',
  },
  nextAt()
)

report.check(
  'revision 链的新旧两条**共用同一个 canonical 槽位**',
  editor.canonicalKey !== undefined && editor.canonicalKey === replacement.canonicalKey,
  `${String(editor.canonicalKey)} vs ${String(replacement.canonicalKey)}`
)

// 一条被忘记的
const forgetTarget = byPredicate.get('food.avoid.general')!
const forgetEvidence = await h.recordUserEvidence('（审计语料）忘掉这件事')
await h.applyStateChange(
  'retract',
  forgetEvidence.ref.id,
  { memoryId: forgetTarget.id, reason: 'explicit_forget', note: '审计语料' },
  nextAt()
)

// 一条存疑的
const disputeTarget = byPredicate.get('food.preference.cilantro')!
const disputeEvidence = await h.recordUserEvidence('（审计语料）我从来不喜欢这个')
await h.applyStateChange(
  'dispute',
  disputeEvidence.ref.id,
  { memoryId: disputeTarget.id, conflictingMemoryIds: [], reason: '审计语料：矛盾陈述' },
  nextAt()
)

const counts = {
  active: (await h.store.list({ owner, status: 'active', limit: 500 })).length,
  superseded: (await h.store.list({ owner, status: 'superseded', limit: 500 })).length,
  retracted: (await h.store.list({ owner, status: 'retracted', limit: 500 })).length,
  disputed: (await h.store.list({ owner, status: 'disputed', limit: 500 })).length,
}
report.check(
  '语料覆盖四种状态（否则第 ⑤ 问常年无内容）',
  counts.active > 0 && counts.superseded > 0 && counts.retracted > 0 && counts.disputed > 0,
  JSON.stringify(counts)
)

// ---------------------------------------------------------------------------
// 3. 认识状态覆盖（让第 ④ 问有内容）
// ---------------------------------------------------------------------------
report.section('3. 认识状态覆盖')
// 低置信度 + inferred 各来一条（都是 episode：槽位型记忆改 confidence 会
// 制造"同槽位多 ACTIVE"，而那不是本节要测的东西）
for (const [summary, epistemicStatus, confidence] of [
  ['她好像提过以前学过一点日语，记不太清', 'reported', 0.3],
  ['推测她更偏好简短的说明', 'inferred', 0.4],
] as [string, 'reported' | 'inferred', number][]) {
  const evidence = await h.recordUserEvidence(`（审计语料）${summary}`)
  await h.commitAndFold(
    h.makeCandidate(
      'episode',
      {
        kind: 'episode',
        summary,
        participants: [user],
        eventRefs: [evidence.ref.id],
      } as never,
      { sourceRefs: [evidence.ref], epistemicStatus, confidence, importance: 0.4 }
    ),
    nextAt()
  )
}

// 反污染：她的猜测必须被结构性地拒（第 ④ 问在数据上可核验）
//
// ⚠️ 实测比预期更早：`createMemoryCandidate()` **在构造候选时**就抛
//    `authority_cannot_establish_person_fact`，根本到不了放行口。
//    这正是计划书第 148 节要的"结构上不可能，而不是靠 prompt 里的一句叮嘱"。
//    第一版脚本把这一步写成 `tryCommit(...)`（期望拿到拒绝码），
//    结果脚本自己崩了 —— 而崩得对：它说明防线在更前面。
const probeEvidence = await h.recordUserEvidence('（审计语料）探测污染通道')
let constructionCode = ''
try {
  h.makeCandidate('person_fact', claim('device.primary', 'MacBook'), {
    sourceRefs: [probeEvidence.ref],
    authority: 'CHARACTER_GENERATION',
    epistemicStatus: 'generated',
  })
} catch (error) {
  constructionCode = String((error as { code?: string }).code ?? '')
}
report.check(
  '她的猜测在**构造候选时**就被拒（第 ④ 问在数据上可核验）',
  constructionCode === 'authority_cannot_establish_person_fact',
  constructionCode || '(没有抛错 —— 污染通道是开着的)'
)

// ---------------------------------------------------------------------------
// 4. §217 规模与不变量
// ---------------------------------------------------------------------------
const all = await h.store.list({ owner, limit: 500 })
console.log(
  `共 ${all.length} 条记忆（active ${counts.active} / superseded ${counts.superseded} / ` +
    `retracted ${counts.retracted} / disputed ${counts.disputed}）`
)

report.section('4. §217 规模与不变量')
report.check('抽样规模 ≥ 30 条（"至少数十条"）', all.length >= 30, `${all.length} 条`)

const unsupported = await unsupportedMemories(h.db, owner)
const contaminated = await contaminatedMemories(h.db, owner)
report.check('语料 unsupported = 0（否则第 ② 问答不出来）', unsupported.length === 0)
report.check('语料 contamination = 0（否则第 ④ 问答不出来）', contaminated.length === 0)

/*
 * ============================================================================
 *  第 ⑥ / ⑦ 问必须**机械可答**，否则审计只是"看起来答完了"
 * ============================================================================
 * 只把 fingerprint 打印出来**不等于**回答了"有没有重复" ——
 * 判断重复要拿指纹去比对。同理"旧版本在哪里"要真的顺着
 * supersededBy / supersedes 走一遍，而不是打印"(无)"。
 * 因此这两问在这里各加一条全量扫描。
 */
const activeByFingerprint = new Map<string, string[]>()
for (const record of all) {
  if (record.status !== 'active') continue
  const key = `${record.owner.kind}:${String(record.owner.id)}::${record.contentFingerprint}`
  activeByFingerprint.set(key, [...(activeByFingerprint.get(key) ?? []), String(record.id)])
}
const duplicateGroups = [...activeByFingerprint.entries()].filter(([, ids]) => ids.length > 1)
report.check(
  '第 ⑥ 问：活跃记忆的指纹两两不同（没有重复）',
  duplicateGroups.length === 0,
  `${duplicateGroups.length} 组重复`
)

const ids = new Set(all.map((r) => String(r.id)))
const supersededWithoutPointer = all.filter(
  (r) => r.status === 'superseded' && r.supersededBy === undefined
)
const danglingSupersedes = all.filter((r) => (r.supersedes ?? []).some((id) => !ids.has(String(id))))
report.check(
  '第 ⑦ 问：每条 SUPERSEDED 都有 supersededBy，且指针不悬空',
  supersededWithoutPointer.length === 0 && danglingSupersedes.length === 0,
  `缺指针 ${supersededWithoutPointer.length} / 悬空 ${danglingSupersedes.length}`
)

// 反向：supersededBy 指的必须真的存在，且状态确实是 superseded
const byId = new Map(all.map((r) => [String(r.id), r]))
const badTargets = all.filter((r) => {
  if (r.supersededBy === undefined) return false
  const target = byId.get(String(r.supersededBy))
  return target === undefined || !(target.supersedes ?? []).some((id) => String(id) === String(r.id))
})
report.check(
  '第 ⑦ 问：supersede 是**双向**的（新条也指回旧条）',
  badTargets.length === 0,
  `${badTargets.length} 条单向`
)

/*
 * S4-1（2026-09-26）：⑤ 的撤回文案按 `MEMORY_RETRACTED.payload.reason` 区分 ——
 * 与生产 `memory:audit` 同一套渲染、同一来源（领域事件流）。
 * 没查到原因的 retracted 记录留空 ⇒ 渲染层如实写"原因未提供"。
 */
const retractReasons = new Map<string, 'explicit_forget' | 'explicit_correction' | 'audit'>()
for (const record of all) {
  if (record.status !== 'retracted') continue
  const events = await domainEventsForMemory(h.db, record.id)
  const retractedEvent = [...events].reverse().find((e) => e.type === 'MEMORY_RETRACTED')
  const reason = (retractedEvent?.payload as { reason?: unknown } | undefined)?.reason
  if (reason === 'explicit_forget' || reason === 'explicit_correction' || reason === 'audit') {
    retractReasons.set(String(record.id), reason)
  }
}

const auditText = renderMemoryAudit(all, retractReasons)
// 时间线视图：第 ⑤ 问（"当前还有效吗"）在**槽位**层面才有意义的汇总
const timelineText = renderMemoryHistory(all, { title: `全部记忆时间线（${all.length} 条）` })

mkdirSync(evidenceDir, { recursive: true })
writeFileSync(join(evidenceDir, 'audit-corpus.txt'), `${auditText}\n`, 'utf8')
writeFileSync(join(evidenceDir, 'audit-timeline-sample.txt'), `${timelineText}\n`, 'utf8')
writeFileSync(
  join(evidenceDir, 'audit-corpus.json'),
  `${JSON.stringify(
    {
      testId: '计划书第 217 节 / 附件第 33 节',
      name: 'Manual Audit Corpus (sandbox)',
      priority: 'P0',
      status: report.failed === 0 ? 'PASS' : 'FAIL',
      scopeNote:
        '沙箱语料。真实库部分由 pnpm memory:audit --limit N（只读）单独产出，' +
        '两者在报告里**分区标注**，不用沙箱数据冒充实库数据。',
      sandboxDir: sandbox.dir,
      totalRecords: all.length,
      counts,
      unsupported: unsupported.length,
      contaminated: contaminated.length,
      records: all.map((record) => ({
        id: String(record.id),
        type: record.type,
        status: record.status,
        authority: record.authority,
        epistemicStatus: record.epistemicStatus,
        importance: record.importance,
        confidence: record.confidence,
        canonicalKey: record.canonicalKey ?? null,
        contentFingerprint: record.contentFingerprint,
        subjects: record.subjects.map((s) => `${s.kind}:${String(s.id)}`),
        sourceRefs: record.sourceRefs.map((r) => `${r.kind}:${String(r.id)}`),
        supersedes: (record.supersedes ?? []).map(String),
        supersededBy: record.supersededBy === undefined ? null : String(record.supersededBy),
        provenance: describeProvenance(record),
      })),
      checks: { passed: report.passed, failed: report.failed, failures: report.failures },
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`\n审计清单已写到：${join(evidenceDir, 'audit-corpus.txt')}\n`)
console.log(auditText.split('\n').slice(0, 34).join('\n'))

await h.stop()
await resetPluginSqlConnection()
cleanupSandbox(sandbox.dir)

report.finish('M4 人工审计语料')
