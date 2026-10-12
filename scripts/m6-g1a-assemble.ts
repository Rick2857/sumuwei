/**
 * `g1a:assemble` —— **G1-A 盲审材料装配**（M6 契约 §8）。
 *
 * 纪律（逐条来自契约 §8 与 AGENTS §6）：
 *   · 材料只用**合成公开夹具**；真实对话/搜索正文**不得**进 Git / telemetry / 外部评测服务
 *     ⇒ 本脚本只写 `artifacts/m6/local/**`（gitignored），**不写** `docs/**` 或受版本控制的 `artifacts/m6/<runId>/**`。
 *   · 窗口**按固定规则**抽（见 §WINDOWS），不挑好看的；规则**写进包**里，可复核。
 *   · **所有机械硬失败一并纳入**（不能只放成功演示）：含 WP9b 的"假记忆边界 NOT MET"与
 *     "该性质的探测器 INVALID"的**全部**相关观测。
 *   · **缺什么就写缺什么**：A–E 五类的"完整轨迹"若某人没有持久化正文，如实标注，
 *     **不**用别的材料冒充。
 *
 * 产出：`artifacts/m6/local/g1-a-<head12>/`
 *   index.json · windows.json · hard-failures.json · review.md · (copied) false-memory 原始探针包
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve('.')
const LOCAL = join(ROOT, 'artifacts', 'm6', 'local')
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const runId = `g1-a-${head.slice(0, 12)}`
const OUT = join(LOCAL, runId)

/** 窗口规则（固定 · 写进包里 · 可复核）：开头 / 中段 / 结尾各一段 */
const WINDOWS = [
  { id: 'opening', label: '开头', from: 1, to: 8 },
  { id: 'middle', label: '中段', from: 246, to: 255 },
  { id: 'ending', label: '结尾', from: 493, to: 500 },
]

/** WP9b 的正式 runId（已落盘证据的那一次）；其它目录里的同名文件只作为副本登记 */
const WP9B_RUN = 'm6-wp9b-20260921-e869f29de85d'

interface ReplyRow {
  turn?: number
  kind?: string
  reply?: string
}

const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

const findDetail = (v: string): { path: string; source: string } | null => {
  const preferred = join(LOCAL, WP9B_RUN, `trajectory-${v}.detail.json`)
  if (existsSync(preferred)) return { path: preferred, source: `local/${WP9B_RUN}` }
  if (!existsSync(LOCAL)) return null
  for (const entry of readdirSync(LOCAL, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(LOCAL, entry.name, `trajectory-${v}.detail.json`)
    if (existsSync(candidate)) return { path: candidate, source: `local/${entry.name}` }
  }
  return null
}

mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------------------
// 1. 窗口（三条 500 轮轨迹 × 三段固定窗口）
// ---------------------------------------------------------------------------

const windowItems: Record<string, unknown>[] = []
const coverage: Record<string, unknown>[] = []
const kindHistogram: Record<string, number> = {}

for (const v of ['V1', 'V2', 'V3']) {
  const found = findDetail(v)
  if (found === null) {
    coverage.push({ trajectory: v, present: false, note: '未找到 detail 文件 ⇒ 该轨迹的窗口 NOT RUN（不许当成通过）' })
    continue
  }
  const o = readJson(found.path)
  const replies = (Array.isArray(o.replies) ? o.replies : []) as ReplyRow[]
  const turns = Array.isArray(o.turns) ? (o.turns as unknown[]) : []
  coverage.push({
    trajectory: v,
    present: true,
    source: found.source,
    file: relative(ROOT, found.path).split(/[\\/]/).join('/'),
    bytes: statSync(found.path).size,
    turnCount: turns.length,
    replyCount: replies.length,
    /** ⚠️ 诚实标注：detail 里只有**她那一侧**（turn/kind/reply），没有用户原话 */
    containsUserText: false,
  })
  for (const w of WINDOWS) {
    const rows = replies.filter((r) => typeof r.turn === 'number' && r.turn >= w.from && r.turn <= w.to)
    windowItems.push({
      id: `${v}-${w.id}`,
      trajectory: v,
      window: w.label,
      rule: `turn ∈ [${w.from}, ${w.to}]`,
      rowCount: rows.length,
      rows,
    })
  }
  for (const r of replies) {
    if (typeof r.kind === 'string') kindHistogram[r.kind] = (kindHistogram[r.kind] ?? 0) + 1
  }
}

// ---------------------------------------------------------------------------
// 2. 硬失败：**全部**纳入（含假记忆边界 NOT MET 与探测器 INVALID 的原始材料）
// ---------------------------------------------------------------------------

const falseMemorySrc = join(LOCAL, WP9B_RUN, 'review-packet-false-memory.json')
let falseMemoryCopied: string | null = null
let falseMemoryProbeCount = 0
let falseMemoryNote = ''
if (existsSync(falseMemorySrc)) {
  const fm = readJson(falseMemorySrc)
  falseMemoryProbeCount = Array.isArray(fm.probes) ? (fm.probes as unknown[]).length : 0
  falseMemoryNote = typeof fm.note === 'string' ? fm.note : ''
  const dest = join(OUT, 'false-memory-probes.json')
  copyFileSync(falseMemorySrc, dest)
  falseMemoryCopied = relative(ROOT, dest).split(/[\\/]/).join('/')
}

const hardFailures = [
  {
    id: 'M6-FMB-01',
    severity: 'quality（不是硬边界）',
    status: 'NOT MET',
    what: 'WP9b · V2：她多次把**没有依据的记忆**补成具体细节（鹦鹉的颜色/名字/年级、"蹲在阳台上找了一下午"），另有检查点直接说"嗯，你说过"',
    instrument: '同期自动探测器（对比式 FALSE_MEMORY）报 12/13"正确"，**人工核对后确认它判错了** ⇒ 该性质探测器 **INVALID**，其读数不得当证据',
    originals: falseMemoryCopied,
    probeCount: falseMemoryProbeCount,
    note: falseMemoryNote,
    pointer: 'docs/m6/M6-Known-Limitations.md §1 · docs/m6/M6-False-Memory-Boundary-Register.md',
  },
  {
    id: 'M5.5.1-semantic-first-run',
    severity: 'quality（已修并复验通过，作为历史）',
    status: 'FAIL → 复验 PASS',
    what: '收口初测（closure-full-v2-prod）最差轮 explicit 召回 10/11 = 90.9% < 95%；唯一翻转项 e12（run2 返回合法 clarify/missing_subject）',
    instrument: '量具本身有效（传输 1.15% 在门槛内、格式 100%、错误放行 0/88）',
    originals: 'artifacts/m5.5.1/wp7/closure-full-v2-prod/observations.json + step4-full-v2-prod/observations.json',
    pointer: 'docs/m5.5.1/M5.5.1-Acceptance-Report.md §2.1/§2.2',
  },
  {
    id: 'WP7b-review-packet',
    severity: 'reference（跨午夜 / 预算竞争的评审包，非失败）',
    status: 'INCLUDED',
    what: 'WP7b 生成的本地评审包（4393 B）：三时间通道分列 + 同轮预算竞争的可审材料',
    instrument: '该包本身未被判失败；列出以便盲审一并看',
    originals: 'artifacts/m6/local/m6-wp7b-*/review-packet.json（4 份副本）',
    pointer: 'docs/m6/WP7b-Handoff.md',
  },
]

// ---------------------------------------------------------------------------
// 3. 人读入口 + 索引
// ---------------------------------------------------------------------------

const reviewMd = [
  '# G1-A 盲审入口（M6）',
  '',
  '> runId: `' + runId + '` · 由 `scripts/m6-g1a-assemble.ts` 生成 · **本目录在 gitignored 区**（`artifacts/m6/local/**`）。',
  '',
  '## 怎么审',
  '',
  '1. 先读 `docs/m6/G1-Acceptance-Report.md`（判什么、阈值用哪版、阻断项）。',
  '2. 看 `windows.json`：三条 500 轮轨迹的开头 / 中段 / 结尾三段（**规则固定**：turn ∈ [1,8] / [246,255] / [493,500]）。',
  '3. 看 `hard-failures.json`：**所有**机械硬失败，尤其 `M6-FMB-01`（假记忆边界 NOT MET、探测器 INVALID）——',
  '   它的原始探针原文在同目录 `false-memory-probes.json`。',
  '4. 按 `docs/m6/G1-Acceptance-Report.md` 的 G1-B 逐项表打分（阈值用 **WP9a 冻结的 rev2**，**不得看过答卷再调分**）。',
  '',
  '## 本包**包含**什么',
  '',
  `- 三条 500 轮轨迹的固定窗口共 ${windowItems.length} 段（每段含 \`turn\` / \`kind\` / 她的回复正文）`,
  `- 全部机械硬失败（${hardFailures.length} 条）与假记忆原始探针包（${falseMemoryProbeCount} 条 probe）`,
  '',
  '## 本包**不包含**什么（**不许当成已满足**）',
  '',
  '- ⚠️ detail 文件里**只有她那一侧**（`turn` / `kind` / `reply`），**没有用户原话**；',
  '  因此"完整多轮轨迹"里用户侧需要按 `kind` 标签理解，或由人工另行索取。',
  '- ⚠️ WP7a 的 A–E 五类（变化/修正/假设/污染来源/遗忘）**合成剧情正文没有被任何门持久化**；',
  '  本包只给出 `kind` 直方图与三条长轨迹的窗口，**不**宣称"A–E 每类 ≥3 条完整轨迹"已满足。',
  '- ⚠️ G1-B 的**真人评分**不在本包内；`AWAITING HUMAN REVIEW` 不会因为本包存在而改变。',
  '',
  '## kind 直方图（三条轨迹合计）',
  '',
  '```text',
  ...Object.entries(kindHistogram).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`),
  '```',
  '',
].join('\n')

writeFileSync(join(OUT, 'windows.json'), `${JSON.stringify({ runId, rule: WINDOWS, items: windowItems }, null, 2)}\n`, 'utf8')
writeFileSync(join(OUT, 'hard-failures.json'), `${JSON.stringify({ runId, items: hardFailures }, null, 2)}\n`, 'utf8')
writeFileSync(join(OUT, 'review.md'), `${reviewMd}\n`, 'utf8')
writeFileSync(
  join(OUT, 'index.json'),
  `${JSON.stringify(
    {
      schemaVersion: 'm6-g1a-packet@1',
      runId,
      head,
      generatedAt: new Date().toISOString(),
      note: 'G1-A 盲审材料包（只读装配；材料只用合成夹具；本目录 gitignored）',
      files: ['review.md', 'windows.json', 'hard-failures.json', ...(falseMemoryCopied !== null ? ['false-memory-probes.json'] : [])],
      windowRule: WINDOWS,
      windowCount: windowItems.length,
      kindHistogram,
      coverage,
      gaps: [
        'detail 文件不含用户原话（只有 turn/kind/reply）',
        'A–E 五类的合成剧情正文未持久化 ⇒ “每类 ≥3 条完整轨迹”未满足，不得宣称已满足',
        '窗口规则是**装配时**写的固定规则，**不是**运行前预先登记（如实标注）',
        'G1-B 真人评分未做 ⇒ G1 仍是 AWAITING HUMAN REVIEW',
      ],
      hardFailures: hardFailures.map((h) => h.id),
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`G1-A 包已生成：${relative(ROOT, OUT).split(/[\\/]/).join('/')}`)
console.log(`  窗口 ${windowItems.length} 段 · 硬失败 ${hardFailures.length} 条 · 假记忆 probe ${falseMemoryProbeCount} 条`)
console.log(`  缺口 ${4} 条已写进 index.json，并在 review.md 里对读者点名`)
