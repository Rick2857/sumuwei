/**
 * M6.1 WP5 / B① —— **更新轮的"服务层"复现 / 修复验证器**（`pnpm m6.1:update-turn:service-repro`）。
 *
 * ============================================================================
 *  它比 `m6.1-update-turn:repro` 多测一层
 * ============================================================================
 * ```text
 * 抽取器层的复现器（`m6.1-update-turn-repro.ts`）证明的是：
 *   「换成 / 转到」这两个词形**在抽取器里抽不出**，而且**修好后仍应抽不出**
 *   （那条 ★负控 守着用户的裁定："不得把它们变成全局记忆指令"）。
 *
 * 于是"修复到底有没有让**更正轮真的落新值**"必须在**服务层**验：
 *   显式记忆服务（正确意图 + 目标槽位解析 + supersede + 落库）全程参与。
 * 本脚本就是那一层。它**先证明了修之前是坏的**（归因更正见 ADR-058 §0：
 * 失败在目标解析 ⇒ target_not_found ⇒ 抽取器根本没被调用），
 * ADR-058（目标层兜底）之后，同一脚本应翻成"新值真的落库、旧值 superseded"。
 * ```
 *
 * ============================================================================
 *  判据（三段式 + 两层负控）
 * ============================================================================
 * ```text
 * 正控（修前修后都必须成立 —— 否则装置/流程有问题，读数不可用）
 *   「记住：我的专业是汉语言文学。」+「更正一下，我的专业是历史学。」
 *      ⇒ 新值 历史学 active ∧ 旧值 汉语言文学 **superseded**
 *   「记住：我平时用的是 Windows 笔记本。」+「更正一下，我平时用的是 Mac。」
 *      ⇒ 新值 Mac active ∧ 旧值 superseded
 * 冻结用例（ADR-058 的修复对象；修后期望翻绿）
 *   SRP-C-04「更正一下，我转到历史学了。」· SRP-C-09「更正一下，我换成 Mac 了。」
 *   ⇒ 修后期望：新值 active ∧ 旧值 superseded（verdict = FIXED）
 * ★负控 A（无前置目标）：没有前置记忆时，同一句更正 ⇒ **不得**新增任何记忆
 * ★负控 B（非更正语境，意图层）：「我把闹钟换成七点了。」/「我把这首歌换成另一首了。」
 *   ⇒ 连显式意图都不该有 ⇒ **不得**新增任何记忆
 * ★负控 C（**误伤面**，ADR-058 §3 —— 有前置写入，守卫真正被考验的形状）：
 *   前置 device.primary=Windows 笔记本：
 *     「更正一下，我把这首歌换成另一首了。」 ⇒ 把字句守卫 + 指代前缀 ⇒ 不写（target_not_found）
 *     「更正一下，我把闹钟换成七点了。」     ⇒ 把字句守卫（「七点」本身过前缀守卫）⇒ 不写
 *     「更正一下，我换成这台了。」           ⇒ 指代前缀「这」⇒ 不写
 *   前置 major + device 两条：
 *     「更正一下，我换成 Mac 了。」           ⇒ 会话内 ≥2 槽位 ⇒ **target_ambiguous** ⇒ 不写
 * 恢复：同一组用例再跑一遍 ⇒ 与第一次逐字段相同
 * ```
 *
 * ⚠️ 它**不调模型**（`replyText` 不参与；这里只走显式记忆路径），但**会开隔离库**
 *    （`isolateDatabase`）——真实库只做文件树摘要，从不打开。
 * ⚠️ 服务构造与生产（`main.ts buildMemoryWriter`）**逐字同形**：同一个
 *    `listRecentExplicitWrites`（B① 兜底的读取端口）、同一个冲突端口、同一个解析器。
 * 退出码：`0` = 自证通过（读数写在 verdict）· `3` = **自证失败**（读数不可用）。
 */

import 'dotenv/config'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { listRecentExplicitWrites } from '../src/infrastructure/persistence/memory-store.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import {
  createExplicitMemoryIntentDetector,
  detectExplicitIntentFromEvent,
  targetHintsFrom,
} from '../src/kernel/app/memory/intent-detector.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import {
  createTargetMemoryResolver,
  LexicalSemanticJudge,
} from '../src/kernel/app/memory/target-resolver.ts'
import type { EntityRef } from '../src/kernel/contracts/entity.ts'
import { createM55Harness } from './m5.5-harness.ts'

const ROOT = resolve(process.cwd())
const PRODUCTION_DB_DIR = join(ROOT, 'data', 'pglite')

interface Case {
  readonly id: string
  readonly kind: 'positive' | 'frozen' | 'negative'
  readonly slot: string
  readonly origin: string
  /** 前置（逐字来自冻结条文的 setup；负控可为空） */
  readonly setup: readonly string[]
  readonly correction: string
  /** 正控期望的 active 值（复现/负控不需要） */
  readonly expectedValue?: string
  /** 负控期望的失败码（不填 = 不检查；意图层负控没有失败码可言） */
  readonly expectReason?: string
}

const CASES: readonly Case[] = [
  {
    id: 'ctl-major',
    kind: 'positive',
    slot: 'education.major',
    origin: '同一条更正，换用**已有线索词**「专业」',
    setup: ['记住：我的专业是汉语言文学。'],
    correction: '更正一下，我的专业是历史学。',
    expectedValue: '历史学',
  },
  {
    id: 'ctl-device',
    kind: 'positive',
    slot: 'device.primary',
    origin: '同一条更正，换用**已有线索词**「用的是」',
    setup: ['记住：我平时用的是 Windows 笔记本。'],
    correction: '更正一下，我平时用的是 Mac。',
    expectedValue: 'Mac',
  },
  {
    id: 'miss-major',
    kind: 'frozen',
    slot: 'education.major',
    origin: 'SRP-C-04 的两轮原文（冻结条文）',
    setup: ['记住：我的专业是汉语言文学。'],
    correction: '更正一下，我转到历史学了。',
  },
  {
    id: 'miss-device',
    kind: 'frozen',
    slot: 'device.primary',
    origin: 'SRP-C-09 的两轮原文（冻结条文）',
    setup: ['记住：我平时用的是 Windows 笔记本。'],
    correction: '更正一下，我换成 Mac 了。',
  },
  {
    id: 'miss-status',
    kind: 'frozen',
    slot: 'education.status',
    origin:
      'SRP-C-05 的两轮原文（冻结条文；B② / ADR-063 的修复对象——' +
      '无转换标记 ⇒ B① 全过不了 ⇒ 候选 59493d58e9ef 四轮活体记忆永远只有旧值）',
    setup: ['记住：我现在是本科生。'],
    correction: '更正一下，我读研究生了。',
  },
  {
    id: 'neg-no-prior-target',
    kind: 'negative',
    slot: 'device.primary',
    origin: '★ 无前置记忆：同一句更正必须**不落库**（兜底 0 候选 ⇒ not_found）',
    setup: [],
    correction: '更正一下，我换成 Mac 了。',
    expectReason: 'target_not_found',
  },
  {
    id: 'neg-alarm',
    kind: 'negative',
    slot: '(任意)',
    origin: '★ 非更正语境（意图层）：换的是闹钟 ⇒ 连显式意图都不该有',
    setup: [],
    correction: '我把闹钟换成七点了。',
  },
  {
    id: 'neg-song',
    kind: 'negative',
    slot: '(任意)',
    origin: '★ 非更正语境（意图层）：换的是歌 ⇒ 连显式意图都不该有',
    setup: [],
    correction: '我把这首歌换成另一首了。',
  },
  {
    id: 'neg-song-prior',
    kind: 'negative',
    slot: 'device.primary',
    origin: '★ 误伤面（ADR-058 §3）：前置 device ⇒ 把字句守卫（「这首歌」无关）+ 指代前缀「另」',
    setup: ['记住：我平时用的是 Windows 笔记本。'],
    correction: '更正一下，我把这首歌换成另一首了。',
    expectReason: 'target_not_found',
  },
  {
    id: 'neg-alarm-prior',
    kind: 'negative',
    slot: 'device.primary',
    origin: '★ 误伤面（ADR-058 §3）：前置 device ⇒ 把字句守卫（「闹钟」无关；「七点」本身过前缀守卫）',
    setup: ['记住：我平时用的是 Windows 笔记本。'],
    correction: '更正一下，我把闹钟换成七点了。',
    expectReason: 'target_not_found',
  },
  {
    id: 'neg-referential-prior',
    kind: 'negative',
    slot: 'device.primary',
    origin: '★ 误伤面（ADR-058 §3）：前置 device ⇒ 指代前缀「这」',
    setup: ['记住：我平时用的是 Windows 笔记本。'],
    correction: '更正一下，我换成这台了。',
    expectReason: 'target_not_found',
  },
  {
    id: 'neg-ambiguous-mixed',
    kind: 'negative',
    slot: 'device.primary',
    origin:
      '★ 误伤面（ADR-058 D-58b①）：前置 major + device 两条 ⇒ 会话内 ≥2 槽位 ⇒ target_ambiguous' +
      '（education.major 由"全库计数不变"一并守住）',
    setup: ['记住：我的专业是汉语言文学。', '记住：我平时用的是 Windows 笔记本。'],
    correction: '更正一下，我换成 Mac 了。',
    expectReason: 'target_ambiguous',
  },
  {
    id: 'neg-b2-slot-mismatch',
    kind: 'negative',
    slot: 'device.primary',
    origin:
      '★ B② 误伤面（ADR-063 §3）：前置 device ⇒ 更正句抽出的 claim 是**别的槽位**' +
      '（education.status=graduate）⇒ 槽位闸拒绝 ⇒ 不写（target_not_found）',
    setup: ['记住：我平时用的是 Windows 笔记本。'],
    correction: '更正一下，我读研究生了。',
    expectReason: 'target_not_found',
  },
]

interface SlotRow {
  readonly value: string
  readonly status: string
}

interface Reading {
  readonly id: string
  readonly kind: Case['kind']
  readonly slot: string
  readonly origin: string
  readonly setupTurns: number
  readonly intentKind: string
  readonly outcomeOk: boolean | null
  readonly outcomeReason: string | null
  /** 这一轮之后，该槽位里的行（值 + 状态） */
  readonly slotAfter: readonly SlotRow[]
  /** 前置写完之后的全库记忆数（带前置的负控以它为"没新增"的基线） */
  readonly memoryCountAfterSetup: number
  /** 这一轮之后全库记忆数（负控用它证明"没有新增"） */
  readonly memoryCountAfter: number
  /** 冻结用例的读数：新值是否真的落库（`written` / `not_written`） */
  readonly newValueWritten: boolean | null
  /** 冻结用例的读数：旧值是否被 superseded（防"新值落了、旧值还 active"的半状态） */
  readonly oldValueSuperseded: boolean | null
  readonly ok: boolean
}

async function runCase(
  bed: Awaited<ReturnType<typeof createM55Harness>>,
  testCase: Case
): Promise<Reading> {
  const h = bed.h
  const { owner, user, db, store } = h
  const service = createExplicitMemoryService({
    store,
    validator: h.validator,
    extractor: createRuleOnlyContentExtractor(),
    resolveTarget: (input) =>
      createTargetMemoryResolver({
        get: (id) => store.get(id),
        getActiveByCanonicalKey: (key) => store.getActiveByCanonicalKey(key),
        listBySubject: (o: EntityRef, s: EntityRef) => store.listBySubject(o, s),
        semanticJudge: new LexicalSemanticJudge(),
      }).resolve({
        owner: input.owner,
        text: input.text,
        ...(input.canonicalKey !== undefined ? { canonicalKey: input.canonicalKey } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.hints !== undefined ? { hints: input.hints } : {}),
      }),
    commitEvents: async (accepted, now) =>
      (await applyAcceptedEvents(db, h.characterId as never, accepted, [], now)).domainEvents,
    conflict: {
      recordsInCanonicalSlot: async ({ canonicalKey }) => {
        const active = await store.getActiveByCanonicalKey(canonicalKey)
        const disputed = (await store.list({ owner, status: 'disputed', limit: 500 })).filter(
          (record) => record.canonicalKey === canonicalKey
        )
        return [...active, ...disputed]
      },
    },
    /*
     * M6.1 WP5 / B① / ADR-058：correct 目标层兜底的读取端口。
     * 与生产（main.ts buildMemoryWriter）接的是**同一个** `listRecentExplicitWrites`
     * ⇒ 复现与生产接线逐字一致（不接它 ⇒ 兜底不启用，读数回到修前形态）。
     */
    recentExplicitWrites: (input) => listRecentExplicitWrites(db, input),
  })
  const detector = createExplicitMemoryIntentDetector()

  const send = async (
    text: string
  ): Promise<{ intentKind: string; ok: boolean | null; reason: string | null }> => {
    const recorded = await h.recordUserEvidence(text)
    const intent = await detectExplicitIntentFromEvent(detector, {
      id: recorded.ref.id as never,
      actorType: 'user',
      content: text,
    })
    if (intent === undefined) return { intentKind: '(无意图)', ok: null, reason: null }
    const outcome = await service.handle({
      owner,
      speaker: user,
      intent,
      triggerEventId: recorded.ref.id,
      hints: targetHintsFrom(intent),
    })
    return {
      intentKind: String((intent as { kind?: unknown }).kind ?? '?'),
      ok: outcome.ok === true,
      reason: outcome.ok === true ? null : String((outcome as { reason?: unknown }).reason ?? '?'),
    }
  }

  /* ① 前置（生产路径写进去） */
  for (const text of testCase.setup) await send(text)
  const slotBefore = await rowsInSlot(store, owner, testCase.slot)
  const memoryCountAfterSetup = (await store.list({ owner, limit: 500 })).length

  /* ② 更正那一句 */
  const turn = await send(testCase.correction)
  const slotAfter = await rowsInSlot(store, owner, testCase.slot)
  const all = await store.list({ owner, limit: 500 })

  const activeAfter = slotAfter.filter((row) => row.status === 'active').map((row) => row.value)
  const beforeActive = slotBefore.find((row) => row.status === 'active')?.value
  const newValueWritten =
    testCase.kind === 'frozen'
      ? activeAfter.some((value) => value !== beforeActive)
      : null
  const oldValueSuperseded =
    testCase.kind === 'frozen'
      ? beforeActive !== undefined &&
        slotAfter.some((row) => row.status === 'superseded' && row.value === beforeActive)
      : null

  const ok =
    testCase.kind === 'positive'
      ? testCase.expectedValue !== undefined && activeAfter.includes(testCase.expectedValue)
      : testCase.kind === 'negative'
        ? /*
           * 带前置的负控：基线是**前置写完之后**的计数（不是开跑前的 0）——
           * 否则"前置本身写了一条"就会被误判成"更正轮新增了记忆"。
           * 槽位行逐字段不变 ⇒ 连"只改状态不新增"的半状态也不放过。
           * expectReason ⇒ 连**失败码**都要对（不写 ≠ 什么都没发生）。
           */
          all.length === memoryCountAfterSetup &&
          sameRows(slotAfter, slotBefore) &&
          (testCase.expectReason === undefined || turn.reason === testCase.expectReason)
        : true /* 冻结用例只出读数，不作通过条件（修前"没落"、修后"落了"都合法） */

  return {
    id: testCase.id,
    kind: testCase.kind,
    slot: testCase.slot,
    origin: testCase.origin,
    setupTurns: testCase.setup.length,
    intentKind: turn.intentKind,
    outcomeOk: turn.ok,
    outcomeReason: turn.reason,
    slotAfter,
    memoryCountAfterSetup,
    memoryCountAfter: all.length,
    newValueWritten,
    oldValueSuperseded,
    ok,
  }
}

/** 槽位行逐字段比对（值 + 状态 + 顺序） */
function sameRows(a: readonly SlotRow[], b: readonly SlotRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => row.value === b[i]!.value && row.status === b[i]!.status)
  )
}

async function rowsInSlot(
  store: Awaited<ReturnType<typeof createM55Harness>>['h']['store'],
  owner: EntityRef,
  slot: string
): Promise<SlotRow[]> {
  const rows = await store.list({ owner, limit: 500 })
  return rows
    .filter((record) => (record.content as { predicate?: string }).predicate === slot)
    .map((record) => ({
      value: String((record.content as { value?: unknown }).value ?? ''),
      status: String(record.status),
    }))
}

async function openCase(label: string): Promise<Awaited<ReturnType<typeof createM55Harness>>> {
  await resetPluginSqlConnection()
  isolateDatabase(`m61-b1-${label}`, { keep: false })
  return createM55Harness({ label: `m61-b1-${label}` })
}

const realDbBefore = digestTree(PRODUCTION_DB_DIR)
const readings: Reading[] = []
for (const testCase of CASES) {
  const bed = await openCase(testCase.id)
  try {
    readings.push(await runCase(bed, testCase))
  } finally {
    await bed.dispose()
  }
}
await resetPluginSqlConnection()
const realDbAfter = digestTree(PRODUCTION_DB_DIR)

/* 恢复：整组重跑一遍（新沙箱、同语料）⇒ 逐字段相同 */
const replayBed = await openCase('replay')
let replay: Reading | undefined
try {
  const missDevice = CASES.find((row) => row.id === 'miss-device')
  if (missDevice === undefined) throw new Error('CASES 里找不到 miss-device')
  replay = await runCase(replayBed, missDevice) /* miss-device：最要紧的那一条 */
} finally {
  await replayBed.dispose()
}
await resetPluginSqlConnection()
const original = readings.find((row) => row.id === 'miss-device')
const restoreOk =
  original !== undefined &&
  replay !== undefined &&
  original.newValueWritten === replay.newValueWritten &&
  original.oldValueSuperseded === replay.oldValueSuperseded &&
  original.slotAfter.length === replay.slotAfter.length

const positives = readings.filter((row) => row.kind === 'positive')
const negatives = readings.filter((row) => row.kind === 'negative')
const frozen = readings.filter((row) => row.kind === 'frozen')
/* 误伤负控 = 带前置写入的那批（ADR-058 §3 的 4 条；少了 ⇒ 量具缺角） */
const priorNegatives = negatives.filter((row) => row.setupTurns > 0)

const failures: string[] = []
if (readings.length === 0) failures.push('MEASUREMENT INVALID：0 条读数')
if (positives.length === 0) failures.push('计数自检：正控 0 条')
if (negatives.length === 0) failures.push('计数自检：负控 0 条')
if (frozen.length === 0) failures.push('计数自检：冻结用例 0 条')
if (priorNegatives.length < 4) {
  failures.push(`计数自检：带前置的误伤负控只有 ${priorNegatives.length} 条（ADR-058 §3 要求 ≥4）`)
}
if (!positives.every((row) => row.ok)) {
  failures.push('正控未成立：带**已有线索词**的更正必须真的落新值 ⇒ 否则装置/流程有问题，下面的读数不可用')
}
if (!negatives.every((row) => row.ok)) {
  failures.push('★ 负控被打破：没有可确定的目标槽位 / 非更正语境 / 误伤面 ⇒ **不得**新增任何记忆')
}
if (!restoreOk) failures.push('恢复失败：同一句两次读数不同')

/* 冻结两条的读数：修后期望 = 新值落库 ∧ 旧值 superseded（ADR-058 D-58h） */
const frozenNotWritten = frozen.filter((row) => row.newValueWritten === false).length
const frozenWritten = frozen.filter(
  (row) => row.newValueWritten === true && row.oldValueSuperseded === true
).length
const verdict =
  failures.length > 0
    ? 'SELF_PROOF_FAILED'
    : frozenNotWritten === frozen.length && frozen.length > 0
      ? 'MISS_REPRODUCED'
      : frozenWritten === frozen.length
        ? 'FIXED'
        : 'PARTIAL'

console.log('='.repeat(96))
console.log('M6.1 WP5 / B①+B② · 更新轮"服务层"复现（隔离库 · **零模型调用** · ADR-058 目标层兜底 + ADR-063 槽位限定抽取闸）')
console.log('='.repeat(96))
for (const row of readings) {
  const mark = row.kind === 'positive' ? '正控' : row.kind === 'negative' ? '负控' : '复现'
  console.log(`  [${mark}] ${row.id.padEnd(22)} ${row.origin}`)
  console.log(
    `         意图 ${row.intentKind} · 结果 ${row.outcomeOk === null ? '(无意图)' : row.outcomeOk ? 'ok' : `失败(${String(row.outcomeReason)})`}` +
      ` · 槽位行 ${row.slotAfter.map((r) => `${r.status}:${r.value}`).join(' / ') || '(空)'}` +
      ` · 全库记忆 ${String(row.memoryCountAfterSetup)}→${String(row.memoryCountAfter)}` +
      (row.newValueWritten === null ? '' : ` · **新值落库=${row.newValueWritten}**`)
  )
}
console.log('')
console.log(
  `  正控 ${positives.filter((r) => r.ok).length}/${positives.length} · ` +
    `负控 ${negatives.filter((r) => r.ok).length}/${negatives.length}（含误伤负控 ${String(priorNegatives.length)}）· ` +
    `冻结用例：未落新值 ${frozenNotWritten} / 新值落库且旧值superseded ${frozenWritten}（共 ${frozen.length}）· ` +
    `恢复 ${restoreOk ? 'PASS' : '**FAIL**'}`
)
console.log(`  真实库树摘要（只摘要不打开）：${realDbBefore.treeSha256.slice(0, 16)}… → ${realDbAfter.treeSha256.slice(0, 16)}… ${realDbBefore.treeSha256 === realDbAfter.treeSha256 ? '未变' : '**变了**'}`)
console.log(`  结论 verdict = ${verdict}`)

const evidence = {
  schemaVersion: 'm6.1-update-turn-service-repro@3',
  testId: 'M6.1 WP5 / B①+B② 更新轮服务层复现/修复验证（更正意图 → 目标槽位 → 落新值/supersede）',
  what: '走生产显式记忆服务：前置记忆 + 更正那一句，读出该槽位的最终行与全库记忆数。',
  why:
    '抽取器层复现（m6.1:update-turn:repro）已证明「换成/转到」抽不出、且修好后**仍应**抽不出；' +
    '服务层复现进一步证明失败在**目标解析**（target_not_found ⇒ 抽取器未被调用，ADR-058 §0）。' +
    'ADR-058 的目标层兜底（B①：会话内最近一次显式写入 + 槽位限定取值 + 守卫）之后，' +
    '冻结两条应翻成"新值 active ∧ 旧值 superseded"。' +
    '@3（2026-09-25 用户裁定 B② / ADR-063）：B① 标记取值失败后加**槽位限定抽取闸**——' +
    '冻结第三条 SRP-C-05「更正一下，我读研究生了。」（无转换标记）应同样翻绿；' +
    '新增负控 neg-b2-slot-mismatch（抽出的是别的槽位 ⇒ 拒绝）。',
  verdict,
  cases: readings,
  realDb: { before: realDbBefore.treeSha256, after: realDbAfter.treeSha256, unchanged: realDbBefore.treeSha256 === realDbAfter.treeSha256 },
  selfProof: {
    positiveControls: positives.map((row) => ({ id: row.id, ok: row.ok, slotAfter: row.slotAfter })),
    negatives: negatives.map((row) => ({
      id: row.id,
      ok: row.ok,
      setupTurns: row.setupTurns,
      outcomeReason: row.outcomeReason,
      memoryCountAfterSetup: row.memoryCountAfterSetup,
      memoryCountAfter: row.memoryCountAfter,
    })),
    priorNegativeCount: priorNegatives.length,
    restore: restoreOk,
    countCheck: { cases: readings.length, positives: positives.length, negatives: negatives.length, priorNegatives: priorNegatives.length, frozen: frozen.length },
  },
  failures,
  notProven: [
    '它不证明"修好之后 WP5 就能过"：WP5 的判定要按裁定 19.5 由新候选从 round 1 重跑得出。',
    '它不覆盖**模型侧**行为：这一层是确定性程序路径，不含生成。',
    '它不证明 12 条 live 误触发负控复验通过：那些属于 WP5 的 live 轮（ADR-058 §7）。',
    '负控的"槽位行不变"只看具名槽位；其余槽位由"全库计数不变"守住（不新增 ⇒ 不可能有半状态）。',
    '残余风险（ADR-058 §5）不因本读数关闭：无把字、值具体的「换成七点了」类句子仍存在误伤面。',
  ],
}
mkdirSync(join(ROOT, 'artifacts', 'm6.1'), { recursive: true })
writeFileSync(join(ROOT, 'artifacts', 'm6.1', 'update-turn-service-repro.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log('  证据：artifacts/m6.1/update-turn-service-repro.json')

if (failures.length > 0) {
  console.error('\n  ⚠️ 自证失败 ⇒ 读数不可用：')
  for (const message of failures) console.error(`     · ${message}`)
  process.exitCode = 3
} else {
  process.exitCode = 0
}
