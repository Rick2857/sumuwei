/**
 * M6.1 **WP5 专项证据**：冻结条文的"依据"是否真的成立（`pnpm m6.1:extraction-audit`）。
 *
 * ============================================================================
 *  它回答什么（WP5 诊断档发现的那个问题）
 * ============================================================================
 * WP5 诊断档实测：`记住：我在江城大学读书。` 这一句**确实写进了记忆**，
 * 但落库的取值是 **`education.institution = 书`**，不是条文期望的「江城大学」。
 *
 * 那一条不是孤例 —— `supported_recall_positive_v1` 的 30 条里，
 * `basisKind = memory_slot` 的条目（L1 实测 **18 条**）都建立在"这条 setup 序列能抽出条文写的那个值"
 * 之上。**如果抽出来的值不对，那一条的"依据"就不成立**，它的成功/失败读数也就不能按
 * "支持性回忆"来解释。
 *
 * 本脚本用**规则抽取器**（生产缺省那一份，`createRuleOnlyContentExtractor`）逐条跑
 * 条文的**全部** setup 轮次，并把结果分成**四类**（**不折叠**）：
 *
 * ```text
 *   literal                        某一轮抽出来的取值**字面包含**条文期望的要点 ⇒ 依据成立
 *   slotRecognized_valueDifferent  抽出的**谓词等于条文登记的槽位**，但取值不含期望要点
 *                                  ⚠️ 这一类**混着两种很不一样的东西**：
 *                                     (a) 取值是该槽位的**受控枚举**（`undergraduate`/`dislike`/`detailed`），
 *                                         期望要点是它的**中文说法** ⇒ 依据其实成立，只是**词形不同**
 *                                     (b) 取值**真的抽错了**（`education.institution = 书`）
 *                                  本脚本**不发明同义词表**去替人消歧 ⇒ 这一类必须**逐条读**
 *   slotNotRecognized              全部 setup 都没抽出条文登记的槽位
 *   unresolved                     全部 setup 都抽不出结构化内容
 * ```
 *
 * ⚠️ **它判什么、不判什么**：
 * ```text
 *   判    "这些条文的 setup，在生产缺省抽取器下抽出了什么、与条文期望差在哪"
 *   不判  抽取规则"对不对"（那是 M4 的语义与它的门）；本脚本**不改**任何抽取规则
 *   不判  模型行为（它完全不调模型）· 不碰数据库 · 不联网 · 无时钟字段
 * ```
 *
 * ============================================================================
 *  v3（2026-09-25）：服务路径补测 —— 更正轮的 B① 兜底（ADR-058）
 * ============================================================================
 * 审计@2 只测**抽取器**，于是 SRP-C-04/C-09 的更正轮（「更正一下，我转到历史学了」）
 * 抽不出 ⇒ 记"未抽出"。但**运行时**走的是 correct() 服务路径：解析 not_found 时
 * `correction-fallback.ts`（纯函数，端口注入）会用"会话内最近一次显式写入"选靶、
 * 按转换标记取守卫值 —— 四轮判定轮里她确实回忆出了更正后的值。
 * ⇒ v3 对**抽取器失败的轮**补测这条服务路径（同一份生产实现，不是重写）：
 *   · 前置轮成功抽到**恰好一个**槽位（`pickRecentExplicitWriteTarget` 的同款判定；
 *     ≥2 槽位 ⇒ ambiguous ⇒ 不落地）；
 *   · `extractCorrectionValue` 的四道守卫全过 ⇒ 该轮记 `via: 'correction-fallback'`。
 * ⚠️ 披露的近似：运行时还有一道 `intent=correct` 闸（审计不跑意图检测，对带转换
 *    标记的失败轮**假定**它成立）；负控（把字句 / 多槽位歧义）在脚本内自证。
 * 用法：`pnpm m6.1:extraction-audit`
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  CORRECTION_FALLBACK_VERSION,
  extractCorrectionValue,
  pickRecentExplicitWriteTarget,
} from '../src/kernel/app/memory/correction-fallback.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import type { MemoryRecord } from '../src/kernel/contracts/memory.ts'
import { loadExplicitWriteSet, loadSupportedRecallSet } from './m6.1-control-sets.ts'

const ROOT = resolve(process.cwd())
const outDir = join(ROOT, 'artifacts', 'm6.1')

/* ⚠️ entityId 只允许字母数字与 `_ - :`（点号会让 `asEntityId` 直接抛 —— 实测踩过） */
const owner = entityRef('character', 'm6-1-extraction-audit')
const speaker = entityRef('user', 'm6-1-extraction-audit')
const extractor = createRuleOnlyContentExtractor()

interface TurnReading {
  readonly turnIndex: number
  readonly type: string | null
  readonly predicate: string | null
  readonly value: string | null
  readonly containsExpected: boolean
  /** v3：该轮读数来自抽取器还是 B① 兜底的服务路径补测（恢复性：兜底只填抽取器失败的轮） */
  readonly via: 'extractor' | 'correction-fallback'
}

type ItemResult =
  | 'literal'
  | 'slotRecognized_valueDifferent'
  | 'slotNotRecognized'
  | 'unresolved'

interface AuditRow {
  readonly setId: 'supported_recall_positive_v1' | 'explicit_write_positive_v1'
  readonly itemId: string
  readonly category: string
  /** 条文登记的槽位（`source.slot` / `slot`） */
  readonly slot: string | null
  readonly expected: readonly string[]
  readonly setupTurns: number
  readonly turns: readonly TurnReading[]
  readonly result: ItemResult
}

async function extractTurn(text: string, expected: readonly string[]): Promise<TurnReading> {
  const extracted = await extractor.extract({ text, owner, speaker })
  if (extracted === undefined) {
    return { turnIndex: -1, type: null, predicate: null, value: null, containsExpected: false, via: 'extractor' }
  }
  const content = extracted.content as { predicate?: unknown; value?: unknown }
  const predicate = typeof content.predicate === 'string' ? content.predicate : null
  const value = typeof content.value === 'string' ? content.value : null
  return {
    turnIndex: -1,
    type: String(extracted.type),
    predicate,
    value,
    containsExpected: value !== null && expected.some((point) => value.includes(point)),
    via: 'extractor',
  }
}

/*
 * v3：合成"会话内最近一次显式写入"的记录（B① 兜底的端口读面）。
 * 只填兜底会读的字段（status / canonicalKey / content.kind / content.predicate /
 * content.value —— `lexicalOverlapHits` 也只读这些）；沿用 m6.1-fmb-set-v2-generate
 * 的 `asRecord` cast 模式（memoryListRow 同款理由：读面之外的字段不被消费）。
 */
function syntheticWriteRecord(input: {
  itemId: string
  turnIndex: number
  predicate: string
  value: string
}): MemoryRecord {
  return {
    id: `mem:audit-synthetic:${input.itemId}:${String(input.turnIndex)}`,
    owner,
    type: 'person_fact',
    subjects: [owner],
    content: { kind: 'claim', subject: owner, predicate: input.predicate, value: input.value },
    status: 'active',
    canonicalKey: `audit:synthetic:${input.predicate}`,
  } as unknown as MemoryRecord
}

/**
 * v3 服务路径补测：对**抽取器失败**的轮，模拟 correct() 的 B① 兜底
 * （同一份生产实现 `correction-fallback.ts`，不是重写）。
 * 前置轮成功抽到恰好一个槽位 ⇒ 选靶；四道守卫过 ⇒ 落地该轮读数。
 * 其余情形（无前置 / 多槽位歧义 / 守卫拒绝）⇒ 维持抽取器的失败读数（不猜）。
 */
function supplementWithCorrectionFallback(input: {
  itemId: string
  setup: readonly string[]
  expected: readonly string[]
  turns: TurnReading[]
}): void {
  for (const [index, turn] of input.turns.entries()) {
    if (turn.value !== null) continue
    const text = input.setup[index] ?? ''
    const priorWrites = input.turns
      .slice(0, index)
      .filter((prior) => prior.predicate !== null && prior.value !== null)
      .map((prior) =>
        syntheticWriteRecord({
          itemId: input.itemId,
          turnIndex: prior.turnIndex,
          predicate: prior.predicate!,
          value: prior.value!,
        })
      )
    const target = pickRecentExplicitWriteTarget(priorWrites)
    if (target === undefined || target.status !== 'targeted') continue
    const extracted = extractCorrectionValue(text, target.record)
    if (extracted === undefined) continue
    input.turns[index] = {
      turnIndex: turn.turnIndex,
      type: `correction-fallback`,
      predicate: target.slot,
      value: extracted.value,
      containsExpected: input.expected.some((point) => extracted.value.includes(point)),
      via: 'correction-fallback',
    }
  }
}

async function auditItem(input: {
  setId: AuditRow['setId']
  itemId: string
  category: string
  slot: string | null
  setup: readonly string[]
  expected: readonly string[]
}): Promise<AuditRow> {
  const turns: TurnReading[] = []
  for (const [index, text] of input.setup.entries()) {
    const reading = await extractTurn(text, input.expected)
    turns.push({ ...reading, turnIndex: index })
  }
  /* v3：抽取器失败的轮 ⇒ 补测 B① 兜底的服务路径（只填失败轮，恢复性由结构保证） */
  supplementWithCorrectionFallback({ itemId: input.itemId, setup: input.setup, expected: input.expected, turns })
  const anyLiteral = turns.some((turn) => turn.containsExpected)
  const anySlotMatch =
    input.slot !== null && turns.some((turn) => turn.predicate !== null && turn.predicate === input.slot)
  const allUnresolved = turns.every((turn) => turn.value === null)
  const result: ItemResult = anyLiteral
    ? 'literal'
    : anySlotMatch
      ? 'slotRecognized_valueDifferent'
      : allUnresolved
        ? 'unresolved'
        : 'slotNotRecognized'
  return { ...input, setupTurns: input.setup.length, turns, result }
}

const rows: AuditRow[] = []

/* ---- 支持性回忆正控：只审 `basisKind = memory_slot`（`dialogue_recent` 不经过抽取器） ---- */
const skippedByBasisKind: string[] = []
for (const item of loadSupportedRecallSet(ROOT)) {
  if (item.basisKind !== 'memory_slot') {
    skippedByBasisKind.push(`${item.id}(${item.basisKind})`)
    continue
  }
  rows.push(
    await auditItem({
      setId: 'supported_recall_positive_v1',
      itemId: item.id,
      category: item.category,
      slot: item.source.slot ?? null,
      setup: item.setup,
      expected: item.expectedPoints,
    })
  )
}

/* ---- 写入正控：期望落库值就是"抽出来的取值必须包含它" ---- */
for (const item of loadExplicitWriteSet(ROOT)) {
  rows.push(
    await auditItem({
      setId: 'explicit_write_positive_v1',
      itemId: item.id,
      category: 'explicit_write',
      slot: item.slot,
      setup: item.setup,
      expected: [item.expectedStoredValue],
    })
  )
}

const byResult = (setId: AuditRow['setId']) => {
  const subset = rows.filter((row) => row.setId === setId)
  const count = (result: ItemResult) => subset.filter((row) => row.result === result).length
  return {
    total: subset.length,
    literal: count('literal'),
    slotRecognized_valueDifferent: count('slotRecognized_valueDifferent'),
    slotNotRecognized: count('slotNotRecognized'),
    unresolved: count('unresolved'),
  }
}

/*
 * 计数型自检（AGENTS §6.8）：0 条被审 ⇒ **MEASUREMENT INVALID**，不是"全部一致"。
 */
const measurementInvalid = rows.length === 0

/* ---------------------------------------------------------------------------
 * v3 三段式自证（INV-M45-06）：兜底补测必须证明它**只**放行守卫过的落地。
 *  正控（真实语料）：抽取器失败的更正轮里，确有经兜底落地的轮（C-04/C-09 形状）。
 *  负控 a（把字句）：「我把闹钟换成七点了」对 device.primary ⇒ 必须拒绝（说的不是设备）。
 *  负控 b（多槽位歧义）：前置写过两个不同槽位 ⇒ 必须 ambiguous，绝不挑一条。
 *  负控 c（指代前缀）：「换成另一台了」的值以「另」开头 ⇒ 必须拒绝（不是新值本身）。
 *  恢复：兜底只填抽取器**失败**的轮（supplementWithCorrectionFallback 的结构保证），
 *        其余轮的读数与 v2 逐字段相同（via 字段为加性）。
 * ------------------------------------------------------------------------- */
const fallbackTurns = rows.flatMap((row) =>
  row.turns.filter((turn) => turn.via === 'correction-fallback').map((turn) => ({ itemId: row.itemId, ...turn }))
)
const controlDeviceRecord = syntheticWriteRecord({
  itemId: 'nc-device',
  turnIndex: 0,
  predicate: 'device.primary',
  value: 'Windows 笔记本',
})
const controlEduRecord = syntheticWriteRecord({
  itemId: 'nc-edu',
  turnIndex: 0,
  predicate: 'education.major',
  value: '汉语言文学',
})
const negativeControls = {
  baClauseGuardRejects: extractCorrectionValue('更正一下，我把闹钟换成七点了。', controlDeviceRecord) === undefined,
  ambiguityRefuses:
    pickRecentExplicitWriteTarget([controlEduRecord, controlDeviceRecord])?.status === 'ambiguous',
  referentialPrefixRejects:
    extractCorrectionValue('更正一下，我换成另一台了。', controlDeviceRecord) === undefined,
}
const controlsOk =
  fallbackTurns.length > 0 &&
  negativeControls.baClauseGuardRejects &&
  negativeControls.ambiguityRefuses &&
  negativeControls.referentialPrefixRejects

console.log('='.repeat(78))
console.log('M6.1 WP5 专项证据：冻结条文的"依据"是否真的成立（规则抽取器 · 离线 · 四类不折叠）')
console.log('='.repeat(78))
for (const row of rows) {
  const mark =
    row.result === 'literal' ? '✅' : row.result === 'slotRecognized_valueDifferent' ? '⚠️' : '❌'
  const last = row.turns[row.turns.length - 1]
  console.log(
    `  ${mark} ${row.itemId.padEnd(10)} [${row.category}] 槽位=${row.slot ?? '(无)'}` +
      ` 期望=${row.expected.join('/')} · setup ${String(row.setupTurns)} 轮 · 末轮抽出 ` +
      `${last?.type ?? '(undefined)'}${last?.predicate !== null && last?.predicate !== undefined ? `/${last.predicate}` : ''}` +
      `=${last?.value ?? '(无)'} ⇒ **${row.result}**`
  )
}
console.log('')
const supported = byResult('supported_recall_positive_v1')
const ewp = byResult('explicit_write_positive_v1')
console.log(
  `  支持性回忆（memory_slot，共 ${String(supported.total)} 条）：字面命中 ${String(supported.literal)} · ` +
    `槽位认得出但取值不同 ${String(supported.slotRecognized_valueDifferent)}（**混着"受控枚举的中文说法"与"真抽错"，必须逐条读**）· ` +
    `槽位认不出 ${String(supported.slotNotRecognized)} · 抽不出 ${String(supported.unresolved)}`
)
console.log(
  `  写入正控（共 ${String(ewp.total)} 条）：字面命中 ${String(ewp.literal)} · 槽位认得出但取值不同 ${String(ewp.slotRecognized_valueDifferent)}`
)
console.log(`  跳过（basisKind ≠ memory_slot）：${String(skippedByBasisKind.length)} 条`)
console.log('')

const evidence = {
  schemaVersion: 'm6.1-extraction-audit@3',
  testId: 'M6.1 / WP5 专项证据：冻结条文的依据是否成立（离线 · 无模型 · 无数据库 · 四类不折叠 · v3 含 B① 兜底服务路径补测）',
  scope:
    'supported_recall_positive_v1 里 basisKind=memory_slot 的条目 + explicit_write_positive_v1 的每一条：' +
    '用**生产缺省**的规则抽取器跑条文的**全部** setup 轮次，逐条给出四类结果之一；' +
    'v3：抽取器失败的轮补测 correct() 的 B① 兜底（同一份生产实现 correction-fallback.ts，' +
    `${CORRECTION_FALLBACK_VERSION}；前置恰好一个槽位 + 四道守卫全过才落地，via='correction-fallback'）`,
  note:
    '本脚本**不判**抽取器"对不对"（那是 M4 的语义与它的门），也**不改**任何抽取规则；' +
    '它只判"这些条文的依据，在今天的生产抽取器（v3 起含更正轮的 B① 兜底服务路径）下抽出了什么"。' +
    '`slotRecognized_valueDifferent` **故意不折叠成"错"** —— 它混着受控枚举的中文说法（依据其实成立）' +
    '与真正的抽取错误，消歧需要人读（本脚本**不发明同义词表**；词形等价由 verdict v3 的冻结等价表承担）。' +
    '⚠️ v3 披露的近似：运行时兜底还有一道 intent=correct 闸，审计不跑意图检测，' +
    '对带转换标记的失败轮**假定**其成立（负控 a/b/c 在 selfProof 里自证守卫面）。' +
    '证据里没有时钟字段 ⇒ 重复运行逐字节相同。',
  verdict: measurementInvalid
    ? 'MEASUREMENT INVALID'
    : byResult('supported_recall_positive_v1').literal === supported.total
      ? 'PASS'
      : 'FAIL',
  counts: {
    audited: rows.length,
    supportedRecallMemorySlot: supported,
    explicitWrite: ewp,
    skippedByBasisKindCount: skippedByBasisKind.length,
    skippedByBasisKind,
    correctionFallbackTurns: fallbackTurns.length,
  },
  selfProof: {
    positiveControl_fallbackLanded: fallbackTurns.length > 0,
    fallbackTurns,
    negativeControls,
    controlsOk,
    restoreNote:
      '兜底只填抽取器失败的轮（supplementWithCorrectionFallback 只处理 value=null 的轮）；' +
      '其余轮读数与审计@2 逐字段相同（via 字段为加性）。',
  },
  rows,
  /** 逐条"槽位认得出但取值不同"的条目（**给人读的清单**，本门不替人消歧） */
  needsHumanReading: rows
    .filter((row) => row.result !== 'literal')
    .map((row) => ({
      itemId: row.itemId,
      result: row.result,
      slot: row.slot,
      expected: row.expected,
      extractedLastValue: row.turns[row.turns.length - 1]?.value ?? null,
      extractedLastPredicate: row.turns[row.turns.length - 1]?.predicate ?? null,
    })),
  interpretation: {
    whatThisDoesNotSay:
      '**不**主张"抽取器坏了" —— 只能说"这些条文的 setup 在今天的抽取器下抽出了什么、与期望差在哪"。' +
      '要判断抽取规则是否应当覆盖这些句式，是 M4 侧的产品裁定（不在本里程碑）。',
    whyItMatters:
      '`basisKind = memory_slot` 的条目，其"依据"必须真的落进记忆，否则该条的读数不构成"支持性回忆"。' +
      'WP5 诊断档实测到的 `education.institution = 书` 就是这一类的实例。',
    howToReadTheMiddleClass:
      '`slotRecognized_valueDifferent` 里的 `undergraduate` / `dislike` / `detailed` 是**受控枚举**，' +
      '期望要点写的是它们的中文说法 ⇒ 那些条目的依据**成立但词形不同**；' +
      '而 `education.institution = 书` 是**真的抽错**。两者必须分开计数（本脚本给出逐条清单）。',
  },
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'extraction-audit.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(
  `  verdict = ${evidence.verdict}（${String(rows.length)} 条被审 · 需人读 ${String(evidence.needsHumanReading.length)} 条` +
    ` · 兜底落地 ${String(fallbackTurns.length)} 轮 · 负控 ${controlsOk ? '全过' : '有失败'}）`
)
console.log('  证据：artifacts/m6.1/extraction-audit.json')
if (measurementInvalid) process.exitCode = 2
else if (!controlsOk) process.exitCode = 3
