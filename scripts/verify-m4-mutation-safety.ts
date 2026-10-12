/**
 * M4.1 WP-02 / WP-04 —— **Mutation State Safety**（D1 的 reproduction 与回归门）。
 *
 * ============================================================================
 *  它测的不是"resolver 返回了什么"，而是"**库有没有被改**"
 * ============================================================================
 * D1（S1）的原始症状不是某个函数返回了错的值，而是：
 *
 *     用户说"忘掉我养过一只鹦鹉这件事"（库里从未有过这件事）
 *     → 库里那条「education.institution = 示例工程科技大学」被 retracted
 *
 * 因此本文件的判据是**状态级**的：
 *
 *     before = CanonicalSemanticSnapshot(库) + counts(库) + MEMORY_RETRACTED 条数
 *     ---- 走完整条真实链路（自然语言 → 意图 → 抽取 → 目标解析 → 服务 → 事件 → 投影）----
 *     after  = 同上
 *
 *     negative：after.hash === before.hash  且  事件计数不变
 *     positive：**必须真的产生** retract（否则"没有变化"是恒真的）
 *
 * ⚠️ 每一条用例都**禁止**直接传 memoryId —— 那是 `m4:verify` §13 的做法，
 *    也正是 D1 逃过整套验收的原因："从自然语言解析目标"这一层从未被测过。
 *
 * ============================================================================
 *  ⚠️ 每条用例一个**干净的库**（这一条是被实测逼出来的）
 * ============================================================================
 * 第一版把 6 条用例接在同一个库上。结果 T-D1-001 真的把那条记忆撤掉之后，
 * 后面几条就都在"0 条 active"的库上跑 —— 它们**全绿**，而那是
 * **空过的绿**（`verify-m4-persistence.ts` §16 记录过同一个坑：
 * "失败原因是测试没隔离，不是实现有问题"）。
 *
 * 现在每条用例各自 `isolateDatabase` 一个干净库，因此
 * "绿灯"总是出现在**有东西可错**的状态上。
 *
 * 跑法：pnpm m4:mutation-safety:verify
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import { countsOf, createM4Harness, createReporter, snapshotOf, M4_T0 } from './m4-harness.ts'
import type { M4Harness } from './m4-harness.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import {
  createExplicitMemoryIntentDetector,
  detectExplicitIntentFromEvent,
  targetHintsFrom,
} from '../src/kernel/app/memory/intent-detector.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import {
  LexicalSemanticJudge,
  createTargetMemoryResolver,
} from '../src/kernel/app/memory/target-resolver.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import type { EntityRef } from '../src/kernel/contracts/index.ts'

const report = createReporter()
const evidenceDir = join(process.cwd(), 'artifacts', 'm4.1')

console.log('='.repeat(72))
console.log('M4.1 Mutation State Safety（D1 reproduction + 回归门）')
console.log('='.repeat(72))

interface StoreState {
  hash: string
  memories: number
  active: number
  retracted: number
  memoryEvents: number
  retractedEvents: number
}

interface Scenario {
  label: string
  h: M4Harness
  seedClaim: (predicate: string, value: string, type: 'person_fact' | 'preference') => Promise<void>
  runTurn: (text: string, withHints?: boolean) => Promise<{ ok: boolean | undefined; reason: string | undefined }>
  state: () => Promise<StoreState>
  dispose: () => Promise<void>
}

/**
 * 开一个**干净**的场景库。
 *
 * 每条用例调用一次 —— 因此"上一条把记忆撤掉"不会让下一条变成空过。
 */
async function openScenario(label: string): Promise<Scenario> {
  const sandbox = isolateDatabase(`m41-${label}`, { keep: true })
  await resetPluginSqlConnection()
  const h = await createM4Harness({ label: `m41-${label}` })
  const { owner, user, db, store } = h

  const resolver = createTargetMemoryResolver({
    get: (id) => store.get(id),
    getActiveByCanonicalKey: (key) => store.getActiveByCanonicalKey(key),
    listBySubject: (o: EntityRef, s: EntityRef) => store.listBySubject(o, s),
    // 离线段刻意用**词面**判别器：确定性、不调模型
    semanticJudge: new LexicalSemanticJudge(),
  })

  const explicit = createExplicitMemoryService({
    store,
    validator: h.validator,
    extractor: createRuleOnlyContentExtractor(),
    resolveTarget: (input) =>
      resolver.resolve({
        owner: input.owner,
        text: input.text,
        ...(input.canonicalKey !== undefined ? { canonicalKey: input.canonicalKey } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.hints !== undefined ? { hints: input.hints } : {}),
      }),
    commitEvents: async (accepted, now) => {
      const applied = await applyAcceptedEvents(db, h.characterId as never, accepted, [], now)
      return applied.domainEvents
    },
  })

  const intentDetector = createExplicitMemoryIntentDetector()

  const runTurn = async (text: string, withHints = true) => {
    const recorded = await h.recordUserEvidence(text)
    const intent = await detectExplicitIntentFromEvent(intentDetector, {
      id: recorded.ref.id as never,
      actorType: 'user',
      content: text,
    })
    if (intent === undefined) return { ok: undefined, reason: 'no_intent' }
    const outcome = await explicit.handle({
      owner,
      intent,
      triggerEventId: recorded.ref.id as never,
      speaker: user,
      ...(withHints ? { hints: targetHintsFrom(intent) } : {}),
    })
    return { ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason }
  }

  const state = async (): Promise<StoreState> => {
    const snap = await snapshotOf(store, owner)
    const counts = await countsOf(db, owner)
    const retractedEvents = Number(
      rowsOf(
        await db.execute(
          sql`select count(*)::int as c from character_domain_events where type = 'MEMORY_RETRACTED'`
        )
      )[0]?.c ?? -1
    )
    return {
      hash: snap.hash,
      memories: counts.memories,
      active: counts.active,
      retracted: counts.retracted,
      memoryEvents: counts.domainEvents,
      retractedEvents,
    }
  }

  return {
    label,
    h,
    async seedClaim(predicate, value, type) {
      const evidence = await h.recordUserEvidence(`${predicate} 是 ${value}`)
      const record = await h.commitAndFold(
        h.makeCandidate(
          type,
          { kind: 'claim', subject: user, predicate, value } as never,
          { sourceRefs: [evidence.ref] }
        ),
        M4_T0 + 100
      )
      if (record === null) throw new Error(`夹具建立失败：${predicate}`)
    },
    runTurn,
    state,
    async dispose() {
      await h.stop()
      await resetPluginSqlConnection()
      cleanupSandbox(sandbox.dir)
    },
  }
}

/** 一条"不得改动任何东西"的用例（自带干净库） */
async function expectNoMutation(label: string, text: string, withHints = true): Promise<void> {
  const s = await openScenario(label.replace(/[^A-Za-z0-9-]/g, '').slice(0, 24) || 'case')
  try {
    await s.seedClaim('education.institution', '示例工程科技大学', 'person_fact')
    const before = await s.state()
    if (before.active !== 1) {
      report.check(`${label}：[夹具失败] 库里应恰好 1 条 active`, false, `active=${before.active}`)
      return
    }
    const outcome = await s.runTurn(text, withHints)
    const after = await s.state()

    const unchanged = before.hash === after.hash
    report.check(
      `${label}：**库没有被改动**`,
      unchanged,
      unchanged
        ? `哈希 ${after.hash.slice(0, 12)}…｜active ${before.active} → ${after.active}｜reason=${String(outcome.reason)}`
        : `❌ 哈希 ${before.hash.slice(0, 10)}… → ${after.hash.slice(0, 10)}…｜` +
          `retracted ${before.retracted} → ${after.retracted}`
    )
    report.check(
      `${label}：没有新增 MEMORY_RETRACTED 事件`,
      after.retractedEvents === before.retractedEvents,
      `RETRACTED ${before.retractedEvents} → ${after.retractedEvents}`
    )
    report.check(
      `${label}：MEMORY_* 事件总数不变`,
      after.memoryEvents === before.memoryEvents,
      `${before.memoryEvents} → ${after.memoryEvents}`
    )
  } finally {
    await s.dispose()
  }
}

// ===========================================================================
// D1 的核心复现：库里只有一条 active，而用户说的是**另一个人/另一件事**
// ===========================================================================
report.section('D1 reproduction｜唯一候选 ≠ 相关候选')

await expectNoMutation('T-D1-001 忘掉我养过一只鹦鹉这件事', '忘掉我养过一只鹦鹉这件事', true)
await expectNoMutation('T-D1-001b 同一句·不传 hints', '忘掉我养过一只鹦鹉这件事', false)
await expectNoMutation('T-D1-002 忘掉我用 VS Code 这件事', '忘掉我用 VS Code 这件事', true)

// ===========================================================================
// 正控：目标真的存在时必须仍然可用（否则"没变化"是恒真的）
// ===========================================================================
report.section('正控｜目标存在时 forget 必须仍然工作')
{
  const s = await openScenario('positive-forget')
  try {
    await s.seedClaim('education.institution', '示例工程科技大学', 'person_fact')
    const before = await s.state()
    const outcome = await s.runTurn('忘掉我在示例工程科技大学上学这件事')
    const after = await s.state()
    report.check(
      '正控：受支持的 forget **真的**产生了 retract',
      after.retracted === before.retracted + 1 &&
        after.retractedEvents === before.retractedEvents + 1 &&
        outcome.ok === true,
      `retracted ${before.retracted} → ${after.retracted}｜事件 ${before.retractedEvents} → ` +
        `${after.retractedEvents}｜ok=${String(outcome.ok)}`
    )
    report.check('正控：该槽位不再有 active', after.active === 0, `active ${before.active} → ${after.active}`)
  } finally {
    await s.dispose()
  }
}

// ===========================================================================
// 多条候选：唯一词面命中 → 只动那一条；模糊目标 → 不得 mutation
// ===========================================================================
report.section('多候选｜唯一命中 vs 模糊')
{
  const s = await openScenario('multi-candidate')
  try {
    await s.seedClaim('tooling.preference.editor', 'VS Code', 'preference')
    await s.seedClaim('project.background.active', 'Rust', 'person_fact')
    const before = await s.state()
    report.check('夹具：两条 active', before.active === 2, `active=${before.active}`)

    const outcome = await s.runTurn('忘掉我用 VS Code')
    const after = await s.state()
    report.check(
      'T-D1-004：唯一词面命中 → 真的只撤销那一条',
      after.retracted === before.retracted + 1 && outcome.ok === true,
      `retracted ${before.retracted} → ${after.retracted}｜ok=${String(outcome.ok)}`
    )
    const remaining = await s.h.store.list({ owner: s.h.owner, status: 'active', limit: 10 })
    report.check(
      'T-D1-004：另一条候选**没有**被波及',
      remaining.length === 1 &&
        remaining[0].content.kind === 'claim' &&
        String(remaining[0].content.value) === 'Rust',
      `剩余 active=${remaining.length}｜${remaining
        .map((r) => (r.content.kind === 'claim' ? String(r.content.value) : ''))
        .join(',')}`
    )
  } finally {
    await s.dispose()
  }
}
await expectNoMutation('T-D1-005 忘掉我用的开发工具（模糊）', '忘掉我用的开发工具', true)
await expectNoMutation('T-D1-005b 忘掉我养过一只鹦鹉（多候补）', '忘掉我养过一只鹦鹉', true)

// ===========================================================================
// 证据
// ===========================================================================
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'mutation-safety.json'),
  `${JSON.stringify(
    {
      testId: 'M4.1 / WP-02 + WP-04',
      name: 'Mutation State Safety (D1)',
      priority: 'P0',
      status: report.failed === 0 ? 'PASS' : 'FAIL',
      isolation: '每条用例一个干净的沙箱库（避免"空过的绿"）',
      fixtures: 'education.institution / tooling.preference.editor / project.background.active',
      checks: { passed: report.passed, failed: report.failed, failures: report.failures },
    },
    null,
    2
  )}\n`,
  'utf8'
)

report.finish('M4.1 Mutation State Safety')
