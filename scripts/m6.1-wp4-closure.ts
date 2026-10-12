/**
 * M6.1 / WP4 **出口门**（只读 · 不碰数据库 · 不联网 · 不调模型 · 无时钟字段）。
 *
 * ⚠️ 为什么要有它
 * ```text
 * 用户 2026-09-24 判「WP4 完成」。这句判定若只写在散文里，它与"没人核对过"在输出上
 * 长得一样（本仓库反复登记的那类损失；WP3 的收口就是这么做的，本门沿用同一形状）。
 * 本门把 WP4 的**出口条件**逐条变成读数：
 *   每条 → 具名交付物 / 具名实现标记 / 具名门读数 + **测到几条**（分母必须 > 0）。
 * 任何一项的分母为 0 ⇒ MEASUREMENT INVALID，**不是** PASS（AGENTS §6.8）。
 * ```
 *
 * ⚠️ 本门**不判**什么（边界，写在证据里，不许拿它冒充）
 * ```text
 * ① 不判"修复对不对"——那是行为门（WP5/WP6 的真实模型两轮）。本门只判：
 *    设计裁定的那几条**有没有落到具名代码与具名判据里**，以及**受影响门是否仍绿**。
 * ② 不判"她不再编造了"——本阶段**没有跑过真实模型**。
 * ③ 不判 R-8③ 的第二半 —— 它**没做**（缺"槽位当前状态的完整查询"），
 *    本门把"未做"如实列进 `notProvenByThisGate`，不拿它冒充完成。
 * ④ 真实库树摘要只作**读数**记录（它会在用户正常使用后变化）——
 *    本节只把"WP4 触达的文件里没有任何打开真实库的引用"做成**静态判据**。
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

const ROOT = process.cwd()

/* ---------------------------------------------------------------------------
 * ① 出口条件 → 具名交付物。markers 是**必须出现的小节标题**（完整性检查，
 *    不是语义判定：本门判"那一节在不在"，判"那一节说得对不对"的是人）。
 * ------------------------------------------------------------------------- */

export interface DeliverableSpec {
  readonly id: string
  readonly requirement: string
  readonly path: string
  readonly markers: readonly string[]
}

export const WP4_DELIVERABLES: readonly DeliverableSpec[] = [
  {
    id: 'wp4_handoff',
    requirement:
      '交付 WP4-Handoff.md，含出口条件对照 / 六项落地 / 变动文件与指纹 / 命令读数 / 真实库边界 / 允许主张 / WP5 入口',
    path: 'docs/m6.1/WP4-Handoff.md',
    markers: [
      '## 1. 计划书 §4 WP4 出口条件',
      '## 2. WP3 交接单',
      '## 3. 本轮我自己的缺陷',
      '## 4. 变动文件与指纹',
      '## 5. 命令与读数',
      '## 6. 真实库边界',
      '## 7. 允许主张',
      '## 8. 下一棒 WP5',
      '## 9. 复算方式',
    ],
  },
  {
    id: 'adr_055_revision',
    requirement: 'ADR-055 追加**状态修订**（设计冻结 → 实施落地），且逐条给出落地状态',
    path: 'docs/adr/ADR-055-m6.1-wp4-explicit-memory-correction-and-context-facts.md',
    markers: ['ACCEPTED', '## 9. 状态修订', 'IMPLEMENTED', 'D-55e', 'D-55g'],
  },
  {
    id: 'm5_compat_record',
    requirement: 'M5 两条判据的更新**逐条登记**（不是悄悄改）',
    path: 'docs/m6.1/M6.1-WP4-M5-Compatible-Assertion-Record.md',
    markers: ['## 2. 逐条变更', 'M5-1', 'M5-2', 'M5-3', '为什么不是放宽'],
  },
  {
    id: 'adjudication_log_wp4',
    requirement: '裁定日志登记 WP4 的实施与用户判定',
    path: 'evals/m6.1/acceptance/ADJUDICATION-LOG.md',
    markers: ['### 20.1', '### 20.2'],
  },
]

/* ---------------------------------------------------------------------------
 * ② 出口条件 → 具名**实现标记**（"那条规定落到了哪段代码里"的字节级证据）
 * ------------------------------------------------------------------------- */

export interface ImplementationSpec {
  readonly id: string
  readonly requirement: string
  readonly path: string
  readonly markers: readonly string[]
}

export const WP4_IMPLEMENTATION: readonly ImplementationSpec[] = [
  {
    id: 'record_status_contract',
    requirement: 'D-55e：记录状态的契约与渲染器（五种情形 · 默认句 · 禁止写法 · 独立额度）',
    path: 'src/kernel/contracts/memory-record-status.ts',
    markers: [
      'MEMORY_RECORD_STATUS_REASON_FACTS',
      'reachableMemoryRecordStatusReasons',
      'MEMORY_RECORD_STATUS_DEFAULT_ABSENCE',
      'MEMORY_RECORD_STATUS_FORBIDDEN_PHRASES',
      'MEMORY_RECORD_STATUS_BUDGET_TOKENS',
      'renderMemoryRecordStatus',
    ],
  },
  {
    id: 'record_status_builder',
    requirement: 'D-55e：程序事实 → 状态（逐条读直方图；理由字面量不落判定层）',
    path: 'src/kernel/app/recall/record-status.ts',
    markers: ['buildMemoryRecordStatus', 'recordStatusReasonOfExclusion'],
  },
  {
    id: 'reply_guard_contract',
    requirement: 'D-55g：守卫三态契约（具名 · not_run/passed/triggered · 结构化原因 · 缺报告）',
    path: 'src/kernel/contracts/reply-guard.ts',
    markers: [
      'REPLY_GUARD_NAMES',
      "'not_run'",
      "'passed'",
      "'triggered'",
      'summarizeReplyGuards',
      'missingReplyGuards',
      'replyGuardTraceAttributes',
    ],
  },
  {
    id: 'runtime_readings',
    requirement: 'D-55d：运行期三读数与三类缺陷（含"未声明触发条件不算证据"）',
    path: 'scripts/m6.1-assembly-runtime.ts',
    markers: [
      'readAssemblyRuntime',
      'port_missing',
      'flag_not_consumed',
      'result_not_in_downstream',
      'trigger_not_declared',
      'MEASUREMENT INVALID',
    ],
  },
  {
    id: 'gateway_wiring',
    requirement: '网关接线：两遍编译 · 状态行进 trace · 守卫报告 · 独立额度不变量',
    path: 'src/kernel/app/turn-gateway.ts',
    markers: [
      'memory_record_status',
      'reply_guard',
      'statusTokenBudget',
      'replyGuards',
      'status_budget_isolated',
      'memorySectionSurvivedProbe',
    ],
  },
  {
    id: 'false_trigger_12',
    requirement: '误触发负控读**冻结集**（12 条 = 6 类 × 2）+ 集自检',
    path: 'scripts/verify-m4-nl-mutation.ts',
    markers: ['loadCorrectionNegativeSet', 'validateCorrectionNegativeSet', 'MEASUREMENT INVALID'],
  },
  {
    id: 'm5_assertion_update',
    requirement: 'M5 G6 的两条判据已按设计变更更新（差异只许来自状态行）',
    path: 'scripts/verify-m5-runtime.ts',
    markers: ['withoutStatusSection', 'memory-record-status', 'M6.1 WP4 / ADR-055'],
  },
]

/* ---------------------------------------------------------------------------
 * ③ 出口条件 → 具名**门读数**（从落盘证据读；缺文件 = 没测到）
 * ------------------------------------------------------------------------- */

export interface GateReading {
  readonly id: string
  readonly requirement: string
  readonly path: string
  /**
   * 从该 JSON 里取 passed/failed 的路径前缀（点号结尾，例如 `checks.`）。
   *
   * ⚠️ **省略它 = 这一条只有"判决"可读**（例如 `m5/gate-results.json` 是汇总，
   *    里面没有顶层 passed/failed）。那时判据只要求判决含 `PASS`，
   *    并把 measured 记作 1 —— 如实标成"读到了一个汇总判决"，
   *    而不是拿 0 去充分母（0 会被本门判成 MEASUREMENT INVALID）。
   */
  readonly counters?: readonly [string, string]
  /** 从该 JSON 里取判决的路径（点号分隔） */
  readonly verdict?: string
}

export const WP4_GATE_READINGS: readonly GateReading[] = [
  {
    id: 'l1',
    requirement: '判据层 L1（`pnpm m6.1:test`）读数存在且 failed = 0',
    path: 'artifacts/m6.1/component.json',
    counters: ['', ''],
    verdict: 'verdict',
  },
  {
    id: 'false_trigger',
    requirement: '误触发负控（`pnpm m4:nl-mutation:verify`）failed = 0',
    path: 'artifacts/m4.1/nl-mutation.json',
    counters: ['checks.', 'checks.'],
    verdict: 'status',
  },
  {
    id: 'm5_g6',
    requirement: 'M5 G6 运行期（`pnpm m5:runtime:verify`）failed = 0',
    path: 'artifacts/m5/wp6-context-compiler.json',
    counters: ['', ''],
  },
  {
    id: 'm5_g2',
    requirement: 'M5 G2 资格静态锁（`pnpm m5:verify`）failed = 0（AT2.1 未放宽）',
    path: 'artifacts/m5/wp2-eligibility.json',
    counters: ['', ''],
    verdict: 'hardGateVerdict',
  },
  {
    id: 'm5_gates',
    requirement: 'M5 汇总（`pnpm m5:gates`）Hard Gates = PASS',
    path: 'artifacts/m5/gate-results.json',
    verdict: 'hardGateVerdict',
  },
]
/* ---------------------------------------------------------------------------
 * 判据（**纯函数**，可注入坏形态做负控）
 * ------------------------------------------------------------------------- */

export interface GateFact {
  readonly id: string
  readonly requirement: string
  readonly passed: number
  readonly failed: number
  readonly verdict: string
  readonly present: boolean
  /** 这份证据里有没有 passed/failed 计数（汇总类证据只有判决） */
  readonly hasCounters: boolean
}

export interface Wp4ClosureInput {
  /** 交付物正文；null = 文件缺失 */
  readonly deliverables: Readonly<Record<string, string | null>>
  /** 实现文件正文；null = 文件缺失 */
  readonly implementation: Readonly<Record<string, string | null>>
  /** 门读数（已从落盘证据解析） */
  readonly gates: readonly GateFact[]
  /**
   * 真实库树摘要（**只做文件树摘要**，不经数据库读取）；null = 读不到。
   *
   * ⚠️ 只作**读数**，不作通过条件：它会随用户正常使用而变化
   *    （这条教训已经在 M5.1 的 production-copy 门上吃过一次）。
   */
  readonly realDb: { readonly sha256: string; readonly files: number } | null
}

export interface Wp4ClosureItem {
  readonly id: string
  readonly requirement: string
  readonly ok: boolean
  readonly measured: number
  readonly detail: string
}

export interface Wp4ClosureResult {
  readonly verdict: 'PASS' | 'FAIL' | 'MEASUREMENT INVALID'
  readonly items: readonly Wp4ClosureItem[]
  readonly invalidReasons: readonly string[]
}

/**
 * **真实库边界**的静态锁：WP4 触达的文件里不许出现"打开真实库"的引用。
 *
 * ⚠️ 只查"打开"那类符号（`initDatabase` / 生产库开关 / 直接引用生产目录常量），
 *    **不**查"提到这个词"——判据若看散文，就会把"照实记录边界"判成越界
 *    （这条教训在 M6.1 WP4 的静态等价判据里已经吃过一次）。
 */
const REAL_DB_OPEN_PATTERN =
  /initDatabase\s*\(|PROJECT_LG_ALLOW_PRODUCTION_DB|openProductionDatabase|createProductionSafeOpener/

export function checkWp4Closure(input: Wp4ClosureInput): Wp4ClosureResult {
  const items: Wp4ClosureItem[] = []

  /* ① 交付物齐备 + 必备小节在 */
  for (const spec of WP4_DELIVERABLES) {
    const text = input.deliverables[spec.id] ?? null
    const missingList = text === null ? spec.markers : spec.markers.filter((m) => !text.includes(m))
    items.push({
      id: `deliverable:${spec.id}`,
      requirement: spec.requirement,
      ok: text !== null && text.trim() !== '' && missingList.length === 0,
      measured: text === null ? 0 : text.length,
      detail:
        text === null
          ? '文件缺失'
          : missingList.length === 0
            ? `${String(text.length)} 字符 · 必备小节 ${String(spec.markers.length)}/${String(spec.markers.length)} 在`
            : `缺 ${String(missingList.length)} 个必备小节：${missingList.join(' · ')}`,
    })
  }

  /* ② 实现标记在（"那条规定落到了哪段代码里"） */
  for (const spec of WP4_IMPLEMENTATION) {
    const text = input.implementation[spec.id] ?? null
    const missingList = text === null ? spec.markers : spec.markers.filter((m) => !text.includes(m))
    items.push({
      id: `implementation:${spec.id}`,
      requirement: spec.requirement,
      ok: text !== null && missingList.length === 0,
      measured: text === null ? 0 : spec.markers.length - missingList.length,
      detail:
        text === null
          ? '文件缺失'
          : missingList.length === 0
            ? `${String(spec.markers.length)}/${String(spec.markers.length)} 个标记在`
            : `缺标记：${missingList.join(' · ')}`,
    })
  }

  /* ③ 门读数：必须存在、failed = 0、passed > 0（"没测到"不是 PASS） */
  for (const gate of input.gates) {
    const spec = WP4_GATE_READINGS.find((item) => item.id === gate.id)
    const verdictOk =
      spec?.verdict === undefined ? true : gate.verdict.toUpperCase().includes('PASS')
    /*
     * ⚠️ 汇总类证据（`m5/gate-results.json`）只有判决、没有 passed/failed。
     * 那时判据 = "判决含 PASS"，measured = 1（如实标成"读到一个汇总判决"），
     * 而不是拿 0 去充分母 —— 0 会被本门判成 MEASUREMENT INVALID。
     */
    const ok = gate.hasCounters
      ? gate.present && gate.failed === 0 && gate.passed > 0 && verdictOk
      : gate.present && verdictOk
    items.push({
      id: `gate:${gate.id}`,
      requirement: gate.requirement,
      ok,
      measured: gate.present ? (gate.hasCounters ? gate.passed : 1) : 0,
      detail: gate.present
        ? gate.hasCounters
          ? `${String(gate.passed)} 通过 / ${String(gate.failed)} 失败` +
            (spec?.verdict !== undefined ? ` · 判决=${gate.verdict}` : '')
          : `汇总判决=${gate.verdict || '(缺)'}（该证据只有判决，没有逐条计数）`
        : '证据文件缺失（NOT RUN，不是 PASS）',
    })
  }

  /* ④ 真实库边界：WP4 触达的文件里没有任何"打开真实库"的引用 */
  const offenders = Object.entries(input.implementation)
    .filter(([, text]) => text !== null && REAL_DB_OPEN_PATTERN.test(text))
    .map(([id]) => id)
  items.push({
    id: 'real_db_boundary',
    requirement: 'WP4 触达的文件里**没有**任何打开真实库的引用（本阶段从未打开真实库）',
    ok: offenders.length === 0 && input.realDb !== null,
    measured: Object.keys(input.implementation).length,
    detail:
      offenders.length > 0
        ? `出现"打开真实库"的引用：${offenders.join(', ')}`
        : `扫了 ${String(Object.keys(input.implementation).length)} 个文件，零引用` +
          ` · 树摘要 ${input.realDb === null ? '(读不到)' : `${input.realDb.sha256.slice(0, 16)}… / ${String(input.realDb.files)} 文件`}` +
          '（**只作读数**：它会随用户正常使用而变化，因此不作通过条件）',
  })

  /* ⑤ R-8③ 的第二半**未做** —— 如实登记，不拿它冒充完成 */
  items.push({
    id: 'r8_second_half_not_done',
    requirement: '如实登记：R-8③ 的第二半（"目前没有有效替代值"）**未做**，理由写进交付物',
    ok: (input.deliverables.wp4_handoff ?? '').includes('第二半') &&
      (input.deliverables.wp4_handoff ?? '').includes('完整查询'),
    measured: (input.deliverables.wp4_handoff ?? '').includes('第二半') ? 1 : 0,
    detail: '相邻条件：交接单 §2② 必须写明"第二半未做 + 缺完整查询"；漏了就等于把它说成已完成',
  })

  /* 分母自检：任何一项 measured = 0 ⇒ 这一项根本没测到 */
  const invalidReasons = items
    .filter((item) => item.measured === 0)
    .map((item) => `${item.id}：measured=0 ⇒ MEASUREMENT INVALID`)
  const verdict: Wp4ClosureResult['verdict'] =
    invalidReasons.length > 0 ? 'MEASUREMENT INVALID' : items.every((item) => item.ok) ? 'PASS' : 'FAIL'
  return { verdict, items, invalidReasons }
}

/* ---------------------------------------------------------------------------
 * 从磁盘组装入参 + 三段式自证
 * ------------------------------------------------------------------------- */

function readText(path: string): string | null {
  const abs = join(ROOT, path)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null
}

function pick(root: unknown, path: string): unknown {
  const clean = path.endsWith('.') ? path.slice(0, -1) : path
  if (clean === '') return root
  let cursor: unknown = root
  for (const part of clean.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

function readGates(): GateFact[] {
  return WP4_GATE_READINGS.map((spec) => {
    const base = {
      id: spec.id,
      requirement: spec.requirement,
      passed: 0,
      failed: 0,
      verdict: '',
      present: false,
      hasCounters: spec.counters !== undefined,
    }
    const text = readText(spec.path)
    if (text === null) return base
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return base
    }
    const verdictRaw = spec.verdict === undefined ? undefined : pick(parsed, spec.verdict)
    const verdict = typeof verdictRaw === 'string' ? verdictRaw : ''
    if (spec.counters === undefined) {
      return { ...base, verdict, present: true }
    }
    const [passedPath, failedPath] = spec.counters
    const passed = Number(pick(parsed, `${passedPath}passed`))
    const failed = Number(pick(parsed, `${failedPath}failed`))
    return {
      ...base,
      passed: Number.isFinite(passed) ? passed : 0,
      failed: Number.isFinite(failed) ? failed : 0,
      verdict,
      present: true,
    }
  })
}

/**
 * 真实库树摘要：**只读文件树**（不打开数据库）—— 仅作读数。
 *
 * ⚠️ 用仓库**既有的** `digestTree()`（同一算法），不自己另写一个：
 *    两个"树摘要"算法会给出两个不同的值，而那两个值长得一样、含义不同 ——
 *    这正是 WP4 静态判据里"不造第二套"那条纪律的同一个形状。
 */
function realDbTreeSha256(): { sha256: string; files: number } | null {
  const dir = join(ROOT, 'data', 'pglite')
  if (!existsSync(dir)) return null
  const digest = digestTree(dir)
  return { sha256: digest.treeSha256, files: digest.measuredCount }
}

function readInput(): Wp4ClosureInput {
  const deliverables: Record<string, string | null> = {}
  for (const spec of WP4_DELIVERABLES) deliverables[spec.id] = readText(spec.path)
  const implementation: Record<string, string | null> = {}
  for (const spec of WP4_IMPLEMENTATION) implementation[spec.id] = readText(spec.path)
  return { deliverables, implementation, gates: readGates(), realDb: realDbTreeSha256() }
}

const positiveInput = readInput()
const positive = checkWp4Closure(positiveInput)

/* 负控①：抽掉一份交付物（ADR 修订正文置 null） */
const nc1Input = readInput()
const nc1 = checkWp4Closure({ ...nc1Input, deliverables: { ...nc1Input.deliverables, adr_055_revision: null } })
const nc1Hit = nc1.verdict !== 'PASS' && nc1.items.some((i) => i.id === 'deliverable:adr_055_revision' && !i.ok)

/* 负控②：交付物在、但必备小节被删掉 ⇒ 必须报缺哪一节 */
const nc2Input = readInput()
const nc2 = checkWp4Closure({
  ...nc2Input,
  deliverables: {
    ...nc2Input.deliverables,
    wp4_handoff: (nc2Input.deliverables.wp4_handoff ?? '').replace('## 6. 真实库边界', '## 6. （被删）'),
  },
})
const nc2Hit = nc2.verdict !== 'PASS' && nc2.items.some((i) => i.detail.includes('真实库边界'))

/* 负控③：门读数被注入失败 ⇒ 必须红（"任一轮违规仍按必修门失败处理"） */
const nc3Input = readInput()
const nc3 = checkWp4Closure({
  ...nc3Input,
  gates: nc3Input.gates.map((g) => (g.id === 'false_trigger' ? { ...g, failed: 1 } : g)),
})
const nc3Hit = nc3.verdict !== 'PASS' && nc3.items.some((i) => i.id === 'gate:false_trigger' && !i.ok)

/* 负控④：L1 读数归零 ⇒ 必须是 MEASUREMENT INVALID，不是"通过" */
const nc4Input = readInput()
const nc4 = checkWp4Closure({
  ...nc4Input,
  gates: nc4Input.gates.map((g) => (g.id === 'l1' ? { ...g, passed: 0, present: false } : g)),
})
const nc4Hit = nc4.verdict === 'MEASUREMENT INVALID' && nc4.invalidReasons.some((r) => r.includes('gate:l1'))

/* 负控⑤：往一个实现文件里注入"打开真实库"的引用 ⇒ 边界判据必须红 */
const nc5Input = readInput()
const nc5 = checkWp4Closure({
  ...nc5Input,
  implementation: {
    ...nc5Input.implementation,
    record_status_builder: `${nc5Input.implementation.record_status_builder ?? ''}\nawait initDatabase('data/pglite')\n`,
  },
})
const nc5Hit = nc5.verdict !== 'PASS' && nc5.items.some((i) => i.id === 'real_db_boundary' && !i.ok)

/* 负控⑥：把"第二半未做"那段删掉 ⇒ 必须红（不许把未做说成已完成） */
const nc6Input = readInput()
const nc6 = checkWp4Closure({
  ...nc6Input,
  deliverables: {
    ...nc6Input.deliverables,
    wp4_handoff: (nc6Input.deliverables.wp4_handoff ?? '').replace(/第二半/g, '（被删）'),
  },
})
const nc6Hit = nc6.verdict !== 'PASS' && nc6.items.some((i) => i.id === 'r8_second_half_not_done' && !i.ok)

/* 恢复：放回真实入参 ⇒ 必须重新 PASS（与正控同一函数、同一入参） */
const restored = checkWp4Closure(readInput())
const restoreOk = restored.verdict === positive.verdict && positive.verdict === 'PASS'

const failures: string[] = []
if (positive.verdict !== 'PASS') failures.push(`正控未通过：${positive.verdict} ${positive.invalidReasons.join('|')}`)
if (!nc1Hit) failures.push('负控①未触发：抽掉交付物必须红')
if (!nc2Hit) failures.push('负控②未触发：删掉必备小节必须红')
if (!nc3Hit) failures.push('负控③未触发：门读数被注入失败必须红')
if (!nc4Hit) failures.push('负控④未触发：L1 读数归零必须是 MEASUREMENT INVALID')
if (!nc5Hit) failures.push('负控⑤未触发：注入"打开真实库"必须红')
if (!nc6Hit) failures.push('负控⑥未触发：删掉"第二半未做"必须红')
if (!restoreOk) failures.push('恢复未回到正控读数')

for (const item of positive.items) {
  console.log(`  ${item.ok ? '✅' : '❌'} ${item.requirement}\n       [${item.detail}]`)
}
console.log(
  `\n负控①抽交付物=${nc1Hit ? '红' : '未触发'} · 负控②删小节=${nc2Hit ? '红' : '未触发'} · ` +
    `负控③门读数失败=${nc3Hit ? '红' : '未触发'} · 负控④L1 归零=${nc4.verdict} · ` +
    `负控⑤注入打开真库=${nc5Hit ? '红' : '未触发'} · 负控⑥抹掉"未做"=${nc6Hit ? '红' : '未触发'} · ` +
    `恢复=${restoreOk ? 'PASS' : '失败'}`
)

const evidence = {
  schemaVersion: 'm6.1-wp4-closure@1',
  gateId: 'M6.1 / WP4 出口门（只读 · 不碰数据库 · 无时钟字段）',
  scope: 'WP4 出口条件的**可复算**读数：交付物齐备性 + 实现标记 + 受影响门读数 + 真实库边界静态锁',
  note:
    '本门不判"修复对不对"（那是 WP5/WP6 的真实模型行为门），也不判"她不再编造了"。' +
    '真实库树摘要只作读数记录（它会随用户正常使用而变化），通过条件只要求"WP4 触达的文件里没有打开真实库的引用"。' +
    '判据期望值独立写死在脚本里；证据里没有时钟字段 ⇒ 重复运行逐字节相同。',
  verdict: failures.length > 0 ? 'FAIL' : 'PASS',
  wp4Verdict: positive.verdict,
  items: positive.items,
  invalidReasons: positive.invalidReasons,
  negativeControls: [
    { id: 'nc1_deliverable_removed', fired: nc1Hit, verdict: nc1.verdict },
    { id: 'nc2_marker_removed', fired: nc2Hit, verdict: nc2.verdict },
    { id: 'nc3_gate_reading_failed', fired: nc3Hit, verdict: nc3.verdict },
    { id: 'nc4_l1_zeroed', fired: nc4Hit, verdict: nc4.verdict },
    { id: 'nc5_real_db_open_injected', fired: nc5Hit, verdict: nc5.verdict },
    { id: 'nc6_undone_erased', fired: nc6Hit, verdict: nc6.verdict },
  ],
  restore: restoreOk,
  realDbTreeSha256: positiveInput.realDb?.sha256 ?? null,
  realDbFileCount: positiveInput.realDb?.files ?? 0,
  counters: {
    deliverablesChecked: WP4_DELIVERABLES.length,
    implementationFilesChecked: WP4_IMPLEMENTATION.length,
    gatesChecked: positive.items.filter((i) => i.id.startsWith('gate:')).length,
    l1Passed: positive.items.find((i) => i.id === 'gate:l1')?.measured ?? 0,
    falseTriggerPassed: positive.items.find((i) => i.id === 'gate:false_trigger')?.measured ?? 0,
  },
  notProvenByThisGate: [
    '不判"她不再编造了"：本阶段没有跑过真实模型，一套验收集都还没跑。',
    '不判"生产装配 ≡ 受测装配的运行期三读数"：读数器在了，**真实读数属 WP5/WP6**。',
    '不判 R-8③ 第二半：它**未做**（缺"槽位当前状态的完整查询"），交接待办里如实列着。',
    '不判"根因结论对不对"：那是真人裁定（用户 2026-09-24）；本门只判裁定落到了具名代码与判据里。',
  ],
  failures,
}

mkdirSync(join(ROOT, 'artifacts/m6.1'), { recursive: true })
writeFileSync(join(ROOT, 'artifacts/m6.1/wp4-closure.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(`\nM6.1 WP4 出口门：${evidence.verdict}（WP4 判定 = ${positive.verdict}）`)
console.log('  证据：artifacts/m6.1/wp4-closure.json')
process.exitCode = evidence.verdict === 'PASS' ? 0 : 1
