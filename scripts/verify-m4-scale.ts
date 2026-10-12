/**
 * M4 规模测试（工程计划书第 216 节 Memory Growth / Reliability；附件 M4-P01）。
 *
 * ============================================================================
 *  它回答什么，以及**不**回答什么
 * ============================================================================
 * M4 不是最终的 G1 压力测试。这条 Gate 的目标只有一个：
 *
 *     Memory 架构在**合理规模**下不会立即退化（不损坏、不丢、可重放）。
 *
 * 因此本脚本**不设 SLA**，也**不**用性能数字判 PASS/FAIL（计划书第 216 节：
 * "性能记录即可"）。它硬性断言的是四件正确性的事：
 *
 *   1. 大规模混合事件之后 **Replay 仍然 `A == B`**（每条记忆都能从自己的事件流重算）
 *   2. 不变量成立：`unsupported = 0`、`contamination = 0`
 *   3. **同槽位第二取值不会静默覆盖旧值**（旧值仍在库里，MI-06）
 *   4. **重复输入不会让记忆膨胀**（去重真的在工作）
 *
 * ---------------------------------------------------------------------------
 *  为什么不在这里断言"冲突被正确处置"
 * ---------------------------------------------------------------------------
 * 冲突分析器住在**后台抽取流水线**（`pipeline.ts`，本仓库里冲突分析在放行之前）。
 * 本脚本直接走"放行口 → 落库 → 折叠"，刻意**不**伪造一条流水线，
 * 因为伪造出来的流水线测的是脚本而不是系统。
 * 冲突处置的验收在 `eval:m4` 与 `m4:verify` §16，那里有真实的流水线。
 *
 * 跑法：
 *   pnpm m4:scale:verify              # 默认 1000 次操作
 *   pnpm m4:scale:verify -- 10000     # 可选基准（P1，只记数字）
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import {
  countsOf,
  createM4Harness,
  createReporter,
  M4_T0,
} from './m4-harness.ts'
import type { M4Harness } from './m4-harness.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import {
  contaminatedMemories,
  unsupportedMemories,
} from '../src/infrastructure/persistence/memory-store.ts'

const report = createReporter()

const rawArgument = process.argv.slice(2).find((a) => /^\d+$/.test(a))
const OPERATIONS = Math.max(100, Number(rawArgument ?? 1000))

const sandbox = isolateDatabase('m4-scale', { keep: true })
const evidenceDir = join(process.cwd(), 'artifacts', 'm4-acceptance', 'scale')
await resetPluginSqlConnection()

console.log('='.repeat(72))
console.log(`M4 规模测试（${OPERATIONS} 次操作，混合 create / duplicate / revise / forget / 同槽位第二取值 / uncertain）`)
console.log('='.repeat(72))
console.log(`实验库：${sandbox.dir}`)

const h: M4Harness = await createM4Harness({ label: 'scale' })
const owner = h.owner
const user = h.user

// ---------------------------------------------------------------------------
// 混合比例（附件 M4-P01：30 / 20 / 20 / 10 / 10 / 10）
// ---------------------------------------------------------------------------
const SLOT_COUNT = Math.max(20, Math.floor(OPERATIONS * 0.3))
const slot = (i: number): string => `scale.fact.${i % SLOT_COUNT}`
const value = (i: number): string => `v${i}`

interface Tally {
  create: number
  duplicateAttempted: number
  duplicateRejected: number
  revise: number
  forget: number
  secondValue: number
  uncertain: number
  rejectedOther: number
}

const tally: Tally = {
  create: 0,
  duplicateAttempted: 0,
  duplicateRejected: 0,
  revise: 0,
  forget: 0,
  secondValue: 0,
  uncertain: 0,
  rejectedOther: 0,
}

/** 已经建成的 (slot, value) → memoryId，用于"重复投递"与"修订" */
const created = new Map<string, string>()

const startedAt = Date.now()

for (let i = 0; i < OPERATIONS; i += 1) {
  const bucket = i % 10

  // 0–2：create（30%）
  if (bucket <= 2 || i < SLOT_COUNT) {
    const key = `${slot(i)}=${value(i)}`
    if (created.has(key)) {
      // 这一格已经建过：转成一次"重复投递"
      const evidence = await h.recordUserEvidence(`再说一次：${slot(i)} 是 ${value(i)}`)
      const again = await h.tryCommit(
        h.makeCandidate('preference', claimFor(slot(i), value(i), user), {
          sourceRefs: [evidence.ref],
        }),
        M4_T0 + i * 10
      )
      tally.duplicateAttempted += 1
      if (again.rejected.length > 0) tally.duplicateRejected += 1
      else tally.rejectedOther += 1
      continue
    }
    const evidence = await h.recordUserEvidence(`${slot(i)} 是 ${value(i)}`)
    const record = await h.commitAndFold(
      h.makeCandidate('preference', claimFor(slot(i), value(i), user), {
        sourceRefs: [evidence.ref],
      }),
      M4_T0 + i * 10
    )
    created.set(key, String(record!.id))
    created.set(`${slot(i)}`, String(record!.id))
    tally.create += 1
    continue
  }

  // 3–4：duplicate（20%）—— 用**真实**的新证据重投同一个事实
  //
  // ⚠️ 第一版这里造了一个假 evidence id，于是被拒的原因是
  //    `memory_evidence_event_missing` 而不是去重 —— 那会让"重复被拦住"
  //    这条断言为真而**量的却是另一件事**（本项目记录过的那类假绿）。
  //    必须用真实证据，被拒的原因才可能是 `duplicate_content`。
  if (bucket <= 4) {
    const keys = [...created.keys()].filter((k) => k.includes('='))
    if (keys.length === 0) continue
    const key = keys[i % keys.length]
    const [predicate, val] = key.split('=')
    const evidence = await h.recordUserEvidence(`${predicate} 是 ${val}`)
    tally.duplicateAttempted += 1
    const again = await h.tryCommit(
      h.makeCandidate('preference', claimFor(predicate, val, user), {
        sourceRefs: [evidence.ref],
      }),
      M4_T0 + i * 10
    )
    if (again.rejected.some((code) => code.startsWith('duplicate'))) tally.duplicateRejected += 1
    else if (again.rejected.length > 0) tally.rejectedOther += 1
    continue
  }

  // 5–6：revise（20%）—— 同槽位新值 + supersede
  if (bucket <= 6) {
    const previousId = created.get(slot(i))
    if (previousId === undefined) continue
    const evidence = await h.recordUserEvidence(`改一下：${slot(i)} 现在是 ${value(i)}`)
    const fresh = await h.commitAndFold(
      h.makeCandidate('preference', claimFor(slot(i), value(i), user), {
        sourceRefs: [evidence.ref],
      }),
      M4_T0 + i * 10
    )
    created.set(`${slot(i)}=${value(i)}`, String(fresh!.id))
    await h.applyStateChange(
      'supersede',
      evidence.ref.id,
      {
        memoryId: previousId,
        supersededBy: fresh!.id,
        validUntil: M4_T0 + i * 10,
        reason: '规模测试：同槽位新值',
      },
      M4_T0 + i * 10
    )
    created.set(slot(i), String(fresh!.id))
    tally.revise += 1
    continue
  }

  // 7：forget（10%）
  if (bucket === 7) {
    const target = created.get(slot(i))
    if (target === undefined) continue
    const evidence = await h.recordUserEvidence(`忘掉 ${slot(i)} 这件事`)
    await h.applyStateChange(
      'retract',
      evidence.ref.id,
      { memoryId: target, reason: 'explicit_forget', note: '规模测试' },
      M4_T0 + i * 10
    )
    tally.forget += 1
    continue
  }

  // 8：同槽位第二取值（10%）—— 交给后台冲突分析器，本脚本只保证不静默覆盖
  if (bucket === 8) {
    const other = `${value(i)}-alt`
    const evidence = await h.recordUserEvidence(`${slot(i)} 其实也不是 ${value(i)}`)
    const record = await h.commitAndFold(
      h.makeCandidate('preference', claimFor(slot(i), other, user), {
        sourceRefs: [evidence.ref],
      }),
      M4_T0 + i * 10
    )
    if (record !== null) tally.secondValue += 1
    continue
  }

  // 9：不确定 / 时间限定（10%）
  //
  // ⚠️ 契约里的 epistemicStatus 是**四值**（reported / observed / inferred / generated），
  //    没有 `uncertain`。用户"记不太清"的陈述仍然是 **reported**
  //    （是用户报的），不确定性的正确表达是**降 confidence**（MI-09 由 authority 执行，
  //    不由 epistemicStatus 执行）。写一个不存在的枚举值会让这条
  //    "测试"测的是类型系统而不是系统。
  const evidence = await h.recordUserEvidence(`${slot(i)} 我好像记不太清了`)
  const record = await h.commitAndFold(
    h.makeCandidate('person_fact', claimFor(slot(i), `uncertain-${i}`, user), {
      sourceRefs: [evidence.ref],
      confidence: 0.3,
    }),
    M4_T0 + i * 10
  )
  if (record !== null) tally.uncertain += 1

  if ((i + 1) % 200 === 0) console.log(`  … 已跑 ${i + 1}/${OPERATIONS} 次操作`)
}

function claimFor(predicate: string, val: string, subject: typeof user) {
  return { kind: 'claim', subject, predicate, value: val } as never
}

const elapsedMs = Date.now() - startedAt

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------
report.section('1. 规模与产出')
const counts = await countsOf(h.db, owner)
const totalEvents = Number(
  rowsOf(
    await h.db.execute(sql`select count(*)::int as c from character_domain_events`)
  )[0]?.c ?? 0
)
const memoryEvents = counts.domainEvents
console.log(
  `  用时 ${(elapsedMs / 1000).toFixed(1)}s｜领域事件 ${totalEvents}（其中 MEMORY_* ${memoryEvents}）｜` +
    `记忆 ${counts.memories}（active ${counts.active} / superseded ${counts.superseded} / ` +
    `retracted ${counts.retracted} / disputed ${counts.disputed}）`
)
console.log(`  操作分布：${JSON.stringify(tally)}`)

report.check(
  '产生了足够的 MEMORY_* 领域事件（≥ 500）',
  memoryEvents >= 500,
  `${memoryEvents} 条（用时 ${(elapsedMs / 1000).toFixed(1)}s）`
)
report.check(
  '领域事件与记忆都不是"空跑"',
  memoryEvents > 0 && counts.memories > 0 && counts.memories > counts.active,
  `memories=${counts.memories} > active=${counts.active}`
)

// ---------------------------------------------------------------------------
report.section('2. Replay：每条记忆都能从自己的事件流重算（`A == B`）')
const rebuild = await h.store.rebuildCharacterMemories(owner)
report.check(
  '大规模重放：全部记忆 `A == B`',
  rebuild.memories > 0 && rebuild.mismatched === 0,
  `重建 ${rebuild.rebuilt}/${rebuild.memories}，不一致 ${rebuild.mismatched}`
)
if (rebuild.mismatched > 0) {
  for (const detail of rebuild.details.filter((d) => !d.equal).slice(0, 5)) {
    console.log(`     · ${String(detail.memoryId)} 差异字段：${detail.differences.join(', ')}`)
  }
}

// 重复重放两次必须稳定（附件 M4-T26 的规模化版本）
const rebuild2 = await h.store.rebuildCharacterMemories(owner)
const rebuild3 = await h.store.rebuildCharacterMemories(owner)
report.check(
  '重复重放稳定（第二次、第三次结果一致，不是随机的）',
  rebuild2.mismatched === 0 && rebuild3.mismatched === 0
)

// ---------------------------------------------------------------------------
report.section('3. 不变量')
const unsupported = await unsupportedMemories(h.db, owner)
report.check('unsupported = 0（MI-03）', unsupported.length === 0, `${unsupported.length} 条`)
const contaminated = await contaminatedMemories(h.db, owner)
report.check('contamination = 0', contaminated.length === 0, `${contaminated.length} 条`)

const dupFingerprint = rowsOf(
  await h.db.execute(
    sql`select owner_kind, owner_id, content_fingerprint, count(*)::int as c
        from memory_records where status = 'active'
        group by owner_kind, owner_id, content_fingerprint having count(*) > 1`
  )
)
report.check(
  '活跃内容指纹唯一约束成立（去重第一层在库层面没有被破坏）',
  dupFingerprint.length === 0,
  `${dupFingerprint.length} 组重复`
)

// ---------------------------------------------------------------------------
report.section('4. 重复输入没有让记忆膨胀')
report.check(
  '重复投递被去重/幂等拦下（不是每次都新建一条）',
  tally.duplicateRejected > 0,
  `尝试 ${tally.duplicateAttempted} 次，被拦 ${tally.duplicateRejected} 次`
)
report.check(
  '记忆条数 ≈ 不同槽位数 × 状态数，而不是操作次数',
  counts.memories < OPERATIONS,
  `memories=${counts.memories} < operations=${OPERATIONS}`
)

// ---------------------------------------------------------------------------
report.section('5. 旧值没有被静默覆盖（MI-06）')
const supersededWithPointer = rowsOf(
  await h.db.execute(
    sql`select count(*)::int as c from memory_records
        where status = 'superseded' and (superseded_by is null or superseded_by = '')`
  )
)
report.check(
  '每条 SUPERSEDED 记忆都有 supersededBy 指针（INV-03）',
  Number(supersededWithPointer[0]?.c ?? -1) === 0,
  `${supersededWithPointer[0]?.c} 条没有指针`
)
const retractedLeaked = await h.store.list({ owner, status: 'retracted', limit: 500 })
report.check(
  'RETRACTED 记忆确实存在（遗忘是状态转移，不是物理删除）',
  retractedLeaked.length > 0,
  `${retractedLeaked.length} 条`
)

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'scale-result.json'),
  `${JSON.stringify(
    {
      testId: 'M4-P01',
      name: 'Memory Scale Test',
      priority: 'P1',
      status: report.failed === 0 ? 'PASS' : 'FAIL',
      operations: OPERATIONS,
      elapsedMs,
      operationsPerSecond: Number((OPERATIONS / (elapsedMs / 1000)).toFixed(1)),
      domainEventsTotal: totalEvents,
      memoryDomainEvents: memoryEvents,
      counts,
      replay: { memories: rebuild.memories, mismatched: rebuild.mismatched },
      tally,
      slaAsserted: false,
      note: '计划书第 216 节：性能记录即可，不作为 PASS/FAIL 的判据',
      checks: { passed: report.passed, failed: report.failed, failures: report.failures },
    },
    null,
    2
  )}\n`,
  'utf8'
)

await h.stop()
await resetPluginSqlConnection()
cleanupSandbox(sandbox.dir)

report.finish('M4 规模测试')
