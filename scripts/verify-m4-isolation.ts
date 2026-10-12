/**
 * M4 隔离验收（MI-04 / MI-05 / INV-01 / INV-05；附件 M4-T33 ~ M4-T36，**已按本项目语义改写**）。
 *
 * ============================================================================
 *  为什么附件写的那四条不能照搬
 * ============================================================================
 * 附件第 6 / 28 节把隔离定义成"多用户库（User-A / User-B）之间的 owner 隔离"，
 * 即假设**每条记忆的 owner 是一个用户**。
 *
 * 本项目的模型不是这样，而且这是**刻意的**（ADR-021 Owner / Subject 分离）：
 *
 *     owner   —— Memory Space 属于**角色**（`memory-validator.ts` 强制
 *                `owner.kind === 'character'`，否则报 `memory_owner_not_character`）
 *     subject —— 这条事实**讲的是谁**（今天几乎总是 Alex）
 *
 * 因此"用户之间不能串线"在这里的正确落点是：
 *
 *     同一个角色空间里，**不同 subject 的事实槽位互不可及**，
 *     而 canonical key = owner + subject + type + predicate + qualifier scope。
 *
 * 照抄附件的写法会造出一个**架构不允许**的测试（owner=user），
 * 并且会漏掉真正要守的那条：**subject 参与槽位键** ——
 * 一旦 subject 不进键，A 和 B 的"我住在西安"会被去重成一条共享记忆，
 * 那才是本项目的串线形态。
 *
 * ---------------------------------------------------------------------------
 *  它验证什么
 * ---------------------------------------------------------------------------
 *   1. **owner 闸**：owner 不是 character → 显式拒绝（架构边界，负例）
 *   2. 不同 subject 的事实互不可见（`listBySubject`）
 *   3. **同样文本不同 subject → 两个槽位**（canonical key / fingerprint 都不同）
 *   4. 跨 subject **修订不互相干扰**：B 的矛盾陈述不动 A 的槽位
 *      （且以槽位查询机械证明：B 的 canonicalKey 查不到 A 的记录）
 *   5. 跨 subject **遗忘不互相干扰**：A 的 forget 不动 B
 *   6. 不变量：unsupported = 0、contamination = 0、所有 owner 都是 character
 *
 * 跑法：pnpm m4:isolation:verify
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
  snapshotOf,
  stableStringify,
  M4_T0,
} from './m4-harness.ts'
import {
  contaminatedMemories,
  unsupportedMemories,
} from '../src/infrastructure/persistence/memory-store.ts'
import { stringToUuid } from '@elizaos/core'

import { rowsOf } from '../src/infrastructure/persistence/db.ts'

const report = createReporter()
const evidenceDir = join(process.cwd(), 'artifacts', 'm4-acceptance', 'isolation')

const sandbox = isolateDatabase('m4-isolation', { keep: true })
await resetPluginSqlConnection()

console.log('='.repeat(72))
console.log('M4 隔离验收（owner 闸 + subject 级隔离）')
console.log('='.repeat(72))
console.log(`实验库：${sandbox.dir}`)

const h = await createM4Harness({ label: 'isolation' })
const owner = h.owner
const userA = h.newSubject('acceptance-user-a')
const userB = h.newSubject('acceptance-user-b')
const claim = (subject: typeof userA, predicate: string, value: string) =>
  ({ kind: 'claim', subject, predicate, value }) as never

// ---------------------------------------------------------------------------
// 1. owner 闸：owner 必须是 character
// ---------------------------------------------------------------------------
report.section('1. owner 闸（Memory Space 属于角色，不属于用户）')
const wrongOwnerCandidate = h.makeCandidate(
  'preference',
  claim(userA, 'food.preference.apple', 'like'),
  { sourceRefs: [{ kind: 'conversation_event', id: 'cev:not-a-real-event' } as never] }
)
// 造一个 owner=user 的候选（架构不允许的形状）
const userOwnedCandidate = {
  ...wrongOwnerCandidate,
  owner: userA,
} as typeof wrongOwnerCandidate

const wrongOwner = await h.tryCommit(userOwnedCandidate, M4_T0 - 10)
report.check(
  'owner = user 的候选被显式拒绝（不是静默接受）',
  wrongOwner.rejected.includes('memory_owner_not_character'),
  wrongOwner.rejected.join(',') || '(没有任何拒绝 —— 架构边界没守住)'
)
report.check(
  '被拒绝时**没有产生**任何记忆',
  wrongOwner.record === null && wrongOwner.accepted === 0
)

// ---------------------------------------------------------------------------
// 2. 不同 subject 的事实互不可见
// ---------------------------------------------------------------------------
report.section('2. 不同 subject 的事实互不可见')
const appleEvidence = await h.recordUserEvidence('我喜欢苹果')
const apple = (await h.commitAndFold(
  h.makeCandidate('preference', claim(userA, 'food.preference.apple', 'like'), {
    sourceRefs: [appleEvidence.ref],
  }),
  M4_T0 + 100
))!
const bananaEvidence = await h.recordUserEvidence('我喜欢香蕉')
const banana = (await h.commitAndFold(
  h.makeCandidate('preference', claim(userB, 'food.preference.banana', 'like'), {
    sourceRefs: [bananaEvidence.ref],
  }),
  M4_T0 + 200
))!

const listA = await h.store.listBySubject(owner, userA)
const listB = await h.store.listBySubject(owner, userB)
report.check(
  'A 的 subject 查询只返回 A 的记忆',
  listA.some((r) => String(r.id) === String(apple.id)) &&
    !listA.some((r) => String(r.id) === String(banana.id)),
  `A=${listA.length} 条`
)
report.check(
  'B 的 subject 查询只返回 B 的记忆',
  listB.some((r) => String(r.id) === String(banana.id)) &&
    !listB.some((r) => String(r.id) === String(apple.id)),
  `B=${listB.length} 条`
)
report.check(
  '两条记忆的 subjects 索引确实指向不同的人',
  apple.subjects.some((s) => String(s.id) === String(userA.id)) &&
    apple.subjects.every((s) => String(s.id) !== String(userB.id)) &&
    banana.subjects.some((s) => String(s.id) === String(userB.id)),
  `${apple.subjects.map((s) => s.id).join(',')} | ${banana.subjects.map((s) => s.id).join(',')}`
)

// ---------------------------------------------------------------------------
// 3. 同样文本、不同 subject → 两个槽位
// ---------------------------------------------------------------------------
report.section('3. 同样文本不同 subject → 必须是两个槽位（本项目真正的串线形态）')
const siaEvidence = await h.recordUserEvidence('我住在西安')
const siaA = (await h.commitAndFold(
  h.makeCandidate('person_fact', claim(userA, 'residence.city', '西安'), {
    sourceRefs: [siaEvidence.ref],
  }),
  M4_T0 + 300
))!
const siaEvidenceB = await h.recordUserEvidence('我住在西安')
const siaB = (await h.commitAndFold(
  h.makeCandidate('person_fact', claim(userB, 'residence.city', '西安'), {
    sourceRefs: [siaEvidenceB.ref],
  }),
  M4_T0 + 400
))!

report.check(
  '同样内容没有被错误去重成一条共享记忆（INV-05 / T34）',
  String(siaA.id) !== String(siaB.id) && siaB.status === 'active',
  `A=${String(siaA.id).slice(-12)} B=${String(siaB.id).slice(-12)}`
)
report.check(
  '两条的 canonicalKey **不同**（subject 确实进了槽位键）',
  siaA.canonicalKey !== undefined &&
    siaB.canonicalKey !== undefined &&
    siaA.canonicalKey !== siaB.canonicalKey,
  `${String(siaA.canonicalKey)} vs ${String(siaB.canonicalKey)}`
)
report.check(
  '两条的 contentFingerprint 也不同（去重第一层不会把它们合并）',
  siaA.contentFingerprint !== siaB.contentFingerprint,
  `${siaA.contentFingerprint.slice(0, 12)}… vs ${siaB.contentFingerprint.slice(0, 12)}…`
)
report.check(
  'A 的槽位里查不到 B 的那一条（同文本不同人不会共用一个槽位）',
  (await h.store.getActiveByCanonicalKey(siaA.canonicalKey!)).every(
    (r) => String(r.id) !== String(siaB.id)
  )
)

// ---------------------------------------------------------------------------
// 4. 跨 subject 修订不互相干扰
// ---------------------------------------------------------------------------
report.section('4. 跨 subject 修订攻击（附件 M4-T35）')
const coffeeEvidenceA = await h.recordUserEvidence('我喜欢咖啡')
const coffeeA = (await h.commitAndFold(
  h.makeCandidate('preference', claim(userA, 'beverage.coffee', 'like'), {
    sourceRefs: [coffeeEvidenceA.ref],
  }),
  M4_T0 + 500
))!
const beforeAttack = await snapshotOf(h.store, owner)

// B 说反话 —— 不得让 A 的咖啡记忆失效
const coffeeEvidenceB = await h.recordUserEvidence('我不喜欢咖啡')
const coffeeB = (await h.commitAndFold(
  h.makeCandidate('preference', claim(userB, 'beverage.coffee', 'dislike'), {
    sourceRefs: [coffeeEvidenceB.ref],
  }),
  M4_T0 + 600
))!

const coffeeAAfter = await h.store.get(coffeeA.id)
report.check(
  'B 的否定陈述落成**独立**的一条记忆',
  String(coffeeB.id) !== String(coffeeA.id) && coffeeB.status === 'active'
)
report.check(
  'A 的咖啡记忆仍然是 ACTIVE，且没有被改动',
  coffeeAAfter?.status === 'active' &&
    coffeeAAfter.authority === coffeeA.authority &&
    stableStringify(coffeeAAfter.content) === stableStringify(coffeeA.content),
  `status=${String(coffeeAAfter?.status)}`
)
report.check(
  'A 的槽位里查不到 B 的记录（槽位查询机械证明修订不越界）',
  (await h.store.getActiveByCanonicalKey(coffeeA.canonicalKey!)).every(
    (r) => String(r.id) !== String(coffeeB.id)
  ) &&
    (await h.store.getActiveByCanonicalKey(coffeeB.canonicalKey!)).every(
      (r) => String(r.id) !== String(coffeeA.id)
    )
)
const afterAttack = await snapshotOf(h.store, owner)
report.check(
  'B 的这次操作**没有修改 A 的任何一条已有记忆**',
  beforeAttack.entries.every((beforeEntry) => {
    const after = afterAttack.entries.find((e) => e.logicalId === beforeEntry.logicalId)
    return after !== undefined && stableStringify(beforeEntry) === stableStringify(after)
  })
)

// ---------------------------------------------------------------------------
// 5. 跨 subject 遗忘不互相干扰
// ---------------------------------------------------------------------------
report.section('5. 跨 subject 遗忘隔离（附件 M4-T36）')
const coffeeBId = String(coffeeB.id)
const listBBeforeForget = (await h.store.listBySubject(owner, userB)).map((r) => String(r.id))

const forgetEvidenceA = await h.recordUserEvidence('忘掉我喜欢咖啡这件事')
await h.applyStateChange(
  'retract',
  forgetEvidenceA.ref.id,
  { memoryId: coffeeA.id, reason: 'explicit_forget', note: 'A 要求忘掉' },
  M4_T0 + 700
)

const coffeeAAfterForget = await h.store.get(coffeeA.id)
const coffeeBAfterForget = await h.store.get(coffeeBId as never)
report.check('A 的 forget 生效', coffeeAAfterForget?.status === 'retracted')
report.check(
  'B 的同名事实**没有被波及**（仍是 ACTIVE）',
  coffeeBAfterForget?.status === 'active',
  `status=${String(coffeeBAfterForget?.status)}`
)
report.check(
  'B 的 subject 查询结果集不变',
  stableStringify((await h.store.listBySubject(owner, userB)).map((r) => String(r.id)).sort()) ===
    stableStringify([...listBBeforeForget].sort()),
  `${listBBeforeForget.length} → ${(await h.store.listBySubject(owner, userB)).length}`
)
report.check(
  'A 已遗忘的记忆不出现在 active 集合里（INV-04）',
  !(await h.store.list({ owner, status: 'active', limit: 500 })).some(
    (r) => String(r.id) === String(coffeeA.id)
  )
)

// ---------------------------------------------------------------------------
// 6. 不变量
// ---------------------------------------------------------------------------
report.section('6. 不变量（INV-01 / INV-04 / MI-03 / MI-04）')
const counts = await countsOf(h.db, owner)
const allRecords = await h.store.list({ owner, limit: 500 })
report.check(
  'INV-01：每条记忆的 owner 都是 character 且等于当前角色',
  allRecords.length > 0 &&
    allRecords.every(
      (r) => r.owner.kind === 'character' && String(r.owner.id) === String(owner.id)
    ),
  `${allRecords.length} 条 / owner.kind=${[...new Set(allRecords.map((r) => r.owner.kind))].join(',')}`
)
report.check(
  'MI-04：每条记忆都有 subject 索引（owner 不是唯一归属信息）',
  allRecords.every((r) => r.subjects.length > 0),
  `最少 subject 数=${Math.min(...allRecords.map((r) => r.subjects.length))}`
)
const unsupported = await unsupportedMemories(h.db, owner)
report.check('MI-03：unsupported = 0', unsupported.length === 0, `${unsupported.length} 条`)
const contaminated = await contaminatedMemories(h.db, owner)
report.check('反污染：contamination = 0', contaminated.length === 0, `${contaminated.length} 条`)
report.check(
  '库里**没有** owner 不是 character 的行（架构边界在数据上可核验）',
  Number(
    rowsOf(
      await h.db.execute(
        sql`select count(*)::int as c from memory_records where owner_kind <> 'character'`
      )
    )[0]?.c ?? -1
  ) === 0
)

// ---------------------------------------------------------------------------
// 7. 落证据
// ---------------------------------------------------------------------------
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'isolation-result.json'),
  `${JSON.stringify(
    {
      testId: 'MI-04/MI-05/INV-01/INV-05 (M4-T33..T36 改写)',
      name: 'Owner Gate + Subject-Scope Isolation',
      priority: 'P0',
      status: report.failed === 0 ? 'PASS' : 'FAIL',
      note:
        '附件把隔离写成"多用户 owner 隔离"；本项目 owner 强制为 character（ADR-021），' +
        '因此隔离落在 subject 维度，且 subject 参与 canonicalKey。',
      subjects: { userA: String(userA.id), userB: String(userB.id) },
      counts,
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
void stringToUuid

report.finish('M4 隔离验收')
