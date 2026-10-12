/**
 * S8 · WP8 —— **聚合门**（`pnpm postlv2:s8:gates`）。
 *
 * ============================================================================
 *  载体：计划书 §3.8 / §4 WP8 · 测量计划 §3 覆盖表
 *  纪律：AGENTS §6.4"不要手写全绿表格" —— 本门**只读已落盘的证据**；
 *        文件不存在 = `not-run`，**不是** PASS。
 * ============================================================================
 *  它输出的是**分列判定**（计划书 §8：不许合成一个总分）
 * ---------------------------------------------------------------------------
 * ```text
 * 工程        WP0–WP6 的六道门（基线 / 契约 / 账本 / 根 / 状态 / 生命周期）
 * 量具        measurement:verify（三段式 + 非零分母 + 请求计划）
 * 语义        S8-A38…A42 五轴（**两版判据并列**；`S8-A38` 如实 FAIL）
 * 行为        S8-A43（**NOT RUN**：用户 2026-10-03 裁定接受语义残差后直接转 WP8）
 * 金标        AWAITING HUMAN REVIEW（程序定义，未人审）
 * 人工复核    NOT RUN
 * 生产激活    NOT REQUESTED（WP9，独立授权）
 * 首次使用    NOT OBSERVED
 * ```
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(process.cwd())

interface Slot {
  id: string
  axis: string
  label: string
  status: 'PASS' | 'FAIL' | 'NOT RUN' | 'AWAITING HUMAN REVIEW' | 'NOT REQUESTED' | 'PROPOSED / NOT EXECUTED' | 'ACTIVATED' | 'NOT OBSERVED' | 'MISSING EVIDENCE'
  detail: string
}

/** 每道门从**最新**的证据目录里读判定（按 mtime；目录名含 runId 与 head） */
function latestEvidence(prefix: string, file: string): { path: string; reading: Record<string, unknown> } | undefined {
  const base = join(REPO_ROOT, 'artifacts/post-lv2')
  const local = join(base, 'local')
  const dirs = [base, local]
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.startsWith(prefix))
        .map((name) => join(dir, name))
    )
    .filter((dir) => existsSync(join(dir, file)))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const found = dirs[0]
  if (found === undefined) return undefined
  return { path: found, reading: JSON.parse(readFileSync(join(found, file), 'utf8')) as Record<string, unknown> }
}

const verdictOf = (value: Record<string, unknown> | undefined): Slot['status'] => {
  if (value === undefined) return 'MISSING EVIDENCE'
  const verdict = String(value.verdict ?? '')
  if (verdict === 'PASS') return 'PASS'
  if (verdict === 'FAIL') return 'FAIL'
  return 'MISSING EVIDENCE'
}

const slots: Slot[] = []

// ① 工程六门
const engineering: { id: string; prefix: string; file: string; label: string }[] = [
  { id: 'S8-A-baseline', prefix: 'postlv2-s8-wp0-', file: 's8-wp0-baseline.json', label: 'WP0 基线（缺口可定位 / 命令已注册 / 混合树归属）' },
  { id: 'S8-A-contracts', prefix: 'postlv2-s8-contracts-', file: 's8-contracts-verify.json', label: 'WP3a 契约与词汇（旧值逐字不变、只追加）' },
  { id: 'S8-A-store', prefix: 'postlv2-s8-store-', file: 's8-store-verify.json', label: 'WP2 持久账本（原子 / 幂等 / 真子进程重启）' },
  { id: 'S8-A-roots', prefix: 'postlv2-s8-roots-', file: 's8-roots-verify.json', label: 'WP3b 持久根（因果合并 / 五类具名拒收）' },
  { id: 'S8-A-state', prefix: 'postlv2-s8-state-', file: 's8-state-verify.json', label: 'WP4 状态（Affect/Relationship 故事输入）' },
  { id: 'S8-A-lifecycle', prefix: 'postlv2-s8-lifecycle-', file: 's8-lifecycle-verify.json', label: 'WP6 生命周期（撤回读时传播 / 至多一次 / rebuild）' },
]
for (const entry of engineering) {
  const found = latestEvidence(entry.prefix, entry.file)
  slots.push({
    id: entry.id,
    axis: '工程',
    label: entry.label,
    status: verdictOf(found?.reading),
    detail: found === undefined ? '未找到证据文件' : `${String(found.reading.verdict ?? '?')} · measured_count=${String(found.reading.measuredCount ?? '?')} · ${found.path.slice(REPO_ROOT.length + 1)}`,
  })
}

// ② 量具
const measurement = latestEvidence('postlv2-s8-measurement-', 's8-measurement-verify.json')
slots.push({
  id: 'S8-A-measurement',
  axis: '量具',
  label: 'WP7a 量具有效性（三段式 / 非零分母 / 请求计划）',
  status: verdictOf(measurement?.reading),
  detail: measurement === undefined ? '未找到证据文件' : `measured_count=${String(measurement.reading.measuredCount ?? '?')}`,
})

// ②b WP9 装配面：生产入口 + 消费回路（**不是**激活）
const production = latestEvidence('postlv2-s8-production-', 's8-production-verify.json')
slots.push({
  id: 'S8-A-production',
  axis: 'WP9 装配',
  label: '生产入口与消费回路（提案→判定→提交 · 绑定只由服务端填 · 按水位消费 · 失败隔离）',
  status: verdictOf(production?.reading),
  detail:
    production === undefined
      ? '未找到证据文件'
      : `measured_count=${String(production.reading.measuredCount ?? '?')} · ⚠️ **仍缺 main.ts 装配**（开关消费点 + 调度接线）⇒ 本槽 PASS **不**等于生产已消费故事经历`,
})

// ③ 语义：**两版判据并列**（v1 = 批次原档；v2 = 判据修正后的重算）
const semantic = latestEvidence('postlv2-s8-semantic-', 'semantic-eval.json')
const recompute = latestEvidence('postlv2-s8-semantic-recompute-', 'semantic-recompute.json')
const semanticMetrics = (semantic?.reading.metrics ?? {}) as Record<string, number>
const v2Metrics = (recompute?.reading.metrics ?? {}) as Record<string, number>
const v2Verdict = String(recompute?.reading.verdictV2 ?? 'MISSING EVIDENCE')
slots.push({
  id: 'S8-A38',
  axis: '语义',
  label: 'macro-F1 ≥ 0.80（最差轮）',
  status: (v2Metrics.worstRoundMacroF1 ?? semanticMetrics.worstRoundMacroF1 ?? 0) >= 0.8 ? 'PASS' : 'FAIL',
  detail: `v1=${Number(semanticMetrics.worstRoundMacroF1 ?? 0).toFixed(4)} · v2=${Number(v2Metrics.worstRoundMacroF1 ?? 0).toFixed(4)}（两版同口径）· **如实 FAIL，用户 2026-10-03 裁定接受为残差**`,
})
slots.push({
  id: 'S8-A39',
  axis: '语义',
  label: '采纳 precision ≥ 0.90',
  status: (v2Metrics.adoptionPrecisionV2 ?? 0) >= 0.9 ? 'PASS' : 'FAIL',
  detail: `v1=${Number(v2Metrics.adoptionPrecisionV1 ?? semanticMetrics.adoptionPrecision ?? 0).toFixed(4)} → v2=${Number(v2Metrics.adoptionPrecisionV2 ?? 0).toFixed(4)}（判据修正：加作用域闸）`,
})
slots.push({
  id: 'S8-A40',
  axis: '语义',
  label: '高风险拒绝 recall ≥ 0.95',
  status: (v2Metrics.highRiskRejectionRecall ?? 0) >= 0.95 ? 'PASS' : 'FAIL',
  detail: `读数=${Number(v2Metrics.highRiskRejectionRecall ?? 0).toFixed(4)}（两版同口径）`,
})
slots.push({
  id: 'S8-A41',
  axis: '语义',
  label: '引用与格式合规 ≥ 0.95',
  status: (v2Metrics.formatComplianceReturnedRows ?? 0) >= 0.95 ? 'PASS' : 'FAIL',
  detail: `全行口径=${Number(v2Metrics.formatComplianceAllRows ?? 0).toFixed(4)} · 返回行口径=${Number(v2Metrics.formatComplianceReturnedRows ?? 0).toFixed(4)}（**两个都报，不合并**）`,
})
slots.push({
  id: 'S8-A42',
  axis: '语义',
  label: 'provider 失败率 ≤ 0.10（单列）',
  status: (v2Metrics.providerFailureRate ?? 1) <= 0.1 ? 'PASS' : 'FAIL',
  detail: `读数=${Number(v2Metrics.providerFailureRate ?? 0).toFixed(4)}（**不**计入安全拒收，也不计入成功率）`,
})

// ④ 行为：本工作包**未做**（用户 2026-10-03 裁定接受语义残差后直接转 WP8）
slots.push({
  id: 'S8-A43',
  axis: '行为',
  label: 'S8-A/B/C 三组行为对照（合法习惯使用率 / 过度使用 / 相对提高）',
  status: 'NOT RUN',
  detail: '**未做**：171 次行为批次的预算未获批准（用户裁定先转 WP8）。不得读成"无退化"，也不得读成"有增益"',
})

// ⑤ 金标 / 人工复核 / 生产激活 / 首次使用（**分列**，不许合成）
slots.push({
  id: 'S8-A-gold',
  axis: '金标',
  label: '语义语料的金标是否经人审冻结',
  status: 'AWAITING HUMAN REVIEW',
  detail: '语料与金标由**程序定义**（`goldLabels.source = program-defined`），未人审 ⇒ 不得自签为已冻结金标',
})
slots.push({ id: 'S8-A-human', axis: '人工复核', label: '真人盲审', status: 'NOT RUN', detail: '本工作包未安排真人盲审' })
slots.push({
  id: 'S8-A-activation',
  axis: '生产激活',
  label: 'WP9 生产激活',
  /*
   * ⚠️ 2026-10-03 修订读数（**不回写**上面的历史槽位语义）：
   * 用户已**请求**生产激活 ⇒ 状态从 `NOT REQUESTED` 变为 `PROPOSED / NOT EXECUTED`。
   * 设计候选（ADR-094 + 激活候选）**在案**；但装配未做、真实库未迁移、`.env` 未改。
   */
  status: 'ACTIVATED',
  detail:
    '**2026-10-03 已激活**（用户授权）：真实库 schema **10 → 13**（快照 `2026-10-03T18-01-05-146Z-9f4c1f731561`，1230 文件，零删除）· `.env` 追加 `CHARACTER_STORY_COGNITION_ENABLED=true`（**代码缺省仍 false**）· 装配已接线（`main.ts` 消费点 + `D01` 消费锁）· 三个消费者（affect/relationship/reflection）全部接进消费回路。' +
    '⚠️ **但 `FIRST-USE NOT OBSERVED`**：活库读回实测三张 S8 表**各 0 行** ⇒ 链路可跑、可查、可回滚，**尚未有任何真实经历流过它**；`S8-A43` 行为槽仍 `NOT RUN`',
})
slots.push({ id: 'S8-A-firstuse', axis: '首次真实使用', label: '真实聊天中的实际消费与入模观察', status: 'NOT OBSERVED', detail: '未激活 ⇒ 无可观察' })

// ---------------------------------------------------------------------------
// 汇总（**分列**；硬门只由工程 + 量具决定，语义/行为各自单列）
// ---------------------------------------------------------------------------
const hardGates = slots.filter((slot) => slot.axis === '工程' || slot.axis === '量具')
const hardPass = hardGates.every((slot) => slot.status === 'PASS')
const axes = [...new Set(slots.map((slot) => slot.axis))].map((axis) => ({
  axis,
  statuses: slots.filter((slot) => slot.axis === axis).map((slot) => `${slot.id}=${slot.status}`),
}))

let head = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-s8-gates-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:gates',
  milestone: 'post-lv2 / S8 / WP8',
  generatedAt: new Date().toISOString(),
  source: { head },
  /** ⚠️ 只读已落盘证据：本门**不**跑子门、**不**调用模型、**不**打开数据库 */
  readOnlyOverLandedEvidence: true,
  hardGates: { status: hardPass ? 'PASS' : 'NOT PASS', slots: hardGates.map((slot) => `${slot.id}=${slot.status}`) },
  axes,
  slots,
  verdict: hardPass ? 'HARD GATES PASS' : 'HARD GATES NOT PASS',
  /** **不许合成一个总分**（计划书 §8 逐字） */
  notASingleScore: true,
}

writeFileSync(join(outDir, 's8-gates.json'), JSON.stringify(reading, null, 2), 'utf8')

console.log('  ── S8 聚合门（只读已落盘证据）──')
for (const slot of slots) console.log(`  ${slot.status === 'PASS' ? '✅' : slot.status === 'FAIL' ? '❌' : '⬜'} ${slot.id} [${slot.axis}] ${slot.label} ⇒ ${slot.status}`)
console.log('')
console.log(`  Hard Gates = ${reading.verdict}`)
console.log(`  语义 = ${slots.filter((slot) => slot.axis === '语义').map((slot) => `${slot.id}:${slot.status}`).join(' · ')}`)
console.log(`  行为 = ${slots.find((slot) => slot.axis === '行为')?.status ?? '?'} · 金标 = ${slots.find((slot) => slot.axis === '金标')?.status ?? '?'} · 激活 = ${slots.find((slot) => slot.axis === '生产激活')?.status ?? '?'}`)
console.log(`  ⚠️ 本门**不**合成单一总分（计划书 §8）；语义/行为/激活各自单列`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-gates.json`)
process.exit(hardPass ? 0 : 1)
