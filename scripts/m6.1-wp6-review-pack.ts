/**
 * M6.1 **WP6 人审包生成器**（离线 · 零模型 · 只读已落盘证据）。
 *
 * ============================================================================
 *  冻结依据（[`M6.1-WP6-Freeze-Sheet.md`](../docs/m6.1/M6.1-WP6-Freeze-Sheet.md) §6）
 * ============================================================================
 * ```text
 * ① 预冻结窗口   每条轨迹三窗：1–20（开）· 240–260（中）· 481–500（末），双侧原话
 * ② 机器异常     全部技术失败 / 弃判 / 加判 / 中止段 / 序号异常，逐条具名
 * ③ 正控对照     WP5 短场景支持性回忆正控读数（现成产物，引用不重造）
 * ④ 判安全抽样   每条轨迹按 runId 种子确定性抽 10 轮"机器判 no_alert"的回复
 * ⑤ 短场景审阅包 A–E 每类 ≥3 条（引用 WP5 产物）
 * ⑥ 遗留人审项   CIN-01
 * ```
 * 另加（G-L5 的处置面）：**全部候选 alert**（句原文 + 形态族 + 标签 + 轮次）与
 * **全部冻结探针**（问/答原文 + 机器读数）——人审是 G-L3/G-L5 的最终权威。
 *
 * ⚠️ 位置纪律：包正文含**双方原话**⇒ 只写 gitignored 的 `local/<runId>/review-pack.md`；
 *    Git 内只落 `review-pack-summary.json`（计数与清单，无正文）。
 *
 * 用法：`pnpm exec tsx scripts/m6.1-wp6-review-pack.ts --run <runId> [--run <runId> …]`
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { M6_1_LOCAL_PARENT } from './m6.1-evidence.ts'
import { sha256OfText } from './m6.1-evidence.ts'

const ROOT = resolve(process.cwd())

interface LocalTurnRow {
  readonly turnIndex: number
  readonly kind: string
  readonly userText?: string
  readonly reply?: string
  readonly status?: number
  readonly failureHint?: string
  readonly stderrTail?: string
  readonly probe?: { probeId: string; expect: string; expectedPoints: readonly string[]; mustNotProduce: readonly string[] }
}

interface ReadingJson {
  readonly runId: string
  readonly trajectory: string
  readonly mode: string
  readonly turns: { readonly completed: number; readonly failed: number }
  readonly frozenProbes: readonly {
    readonly itemId: string
    readonly kind: string
    readonly turnIndex: number
    readonly ok: boolean
    readonly alertState: string
    readonly failure: string | null
    readonly expectedPointsHit: readonly string[]
    readonly expectedPointsMissed: readonly string[]
    readonly tieBroken: boolean
  }[]
  readonly scan: {
    readonly selfProofValid: boolean
    readonly candidateTotal: number
    readonly judgedCandidates: number
    readonly overflow: number
    readonly alerts: readonly { readonly itemId: string; readonly turnIndex: number; readonly families: readonly string[]; readonly labels: readonly string[] }[]
  }
  readonly gates: readonly { readonly gate: string; readonly pass: boolean; readonly detail: string }[]
  readonly sequenceVerification: { readonly anomalies: readonly string[]; readonly ok: boolean }
}

const WINDOWS: readonly { readonly label: string; readonly from: number; readonly to: number }[] = [
  { label: '开（1–20）', from: 1, to: 20 },
  { label: '中（240–260）', from: 240, to: 260 },
  { label: '末（481–500）', from: 481, to: 500 },
]

/** runId 种子的确定性抽样（与扫描核心同一 LCG 思路；人审包可复现） */
function seededPick<T>(pool: readonly T[], count: number, seedHex: string): readonly T[] {
  if (pool.length <= count) return pool
  let state = parseInt(seedHex.slice(0, 8), 16) >>> 0 || 0x9e3779b9
  const chosen = new Set<number>()
  while (chosen.size < count) {
    state = (state * 1664525 + 1013904223) >>> 0
    chosen.add(state % pool.length)
  }
  return [...chosen].sort((a, b) => a - b).map((i) => pool[i]!)
}

function buildPack(runId: string): { readonly summary: Record<string, unknown>; readonly packPath: string } {
  const runDir = join(ROOT, 'artifacts', 'm6.1', runId)
  const localDir = join(ROOT, M6_1_LOCAL_PARENT, runId)
  const reading = JSON.parse(readFileSync(join(runDir, 'reading.json'), 'utf8')) as ReadingJson
  const turns = readFileSync(join(localDir, 'turns.jsonl'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as LocalTurnRow)
  const byIndex = new Map(turns.map((row) => [row.turnIndex, row]))
  const seed = sha256OfText(runId)

  const lines: string[] = []
  lines.push(`# WP6 人审包 · ${reading.trajectory}（${runId}）`)
  lines.push('')
  lines.push(`- 模式：${reading.mode} · 完成 ${String(reading.turns.completed)} / 失败 ${String(reading.turns.failed)}`)
  lines.push(`- 机器门：${reading.gates.map((gate) => `${gate.gate}=${gate.pass ? 'PASS' : 'FAIL'}`).join(' · ')}`)
  const reevalPath = join(runDir, 'gates-reeval.json')
  if (existsSync(reevalPath)) {
    const reeval = JSON.parse(readFileSync(reevalPath, 'utf8')) as {
      readonly gates: readonly { readonly gate: string; readonly oldVerdict: { readonly pass: boolean }; readonly newVerdict: { readonly pass: boolean; readonly undecidable?: readonly string[] } }[]
    }
    for (const gate of reeval.gates) {
      lines.push(
        `- ${gate.gate} 判据修正重评（冻结单 §11）：旧 ${gate.oldVerdict.pass ? 'FAIL→见下' : 'FAIL'} → 新 ${gate.newVerdict.pass ? 'PASS' : 'FAIL'}` +
          (gate.newVerdict.undecidable !== undefined && gate.newVerdict.undecidable.length > 0
            ? `（弃判 ${String(gate.newVerdict.undecidable.length)} 条：${gate.newVerdict.undecidable.join('、')}）`
            : '')
      )
    }
  }
  lines.push(`- 序号核验原始异常：${reading.sequenceVerification.anomalies.length === 0 ? '0 条' : reading.sequenceVerification.anomalies.join('；')}`)
  lines.push('')
  lines.push('> 人审是 G-L3 / G-L5 的最终权威（冻结单 §5：未审不填 PASS）。本包只给证据，不给结论。')
  lines.push('')

  /* ① 预冻结窗口 */
  lines.push('## ① 预冻结窗口（双侧原话）')
  for (const window of WINDOWS) {
    lines.push('')
    lines.push(`### ${window.label}`)
    for (let index = window.from; index <= window.to; index += 1) {
      const row = byIndex.get(index)
      if (row === undefined) continue
      lines.push(`- **t${String(index)}**（${row.kind}）用户：${row.userText ?? '(缺失)'}`)
      lines.push(`  - 她：${row.status === 0 ? (row.reply ?? '(空)').replace(/\n/g, ' ⏎ ') : `**技术失败（${row.failureHint ?? '未知'}）**`}`)
    }
  }

  /* ② 机器异常 */
  lines.push('')
  lines.push('## ② 机器异常（逐条具名）')
  const failedTurns = turns.filter((row) => row.status !== 0)
  if (failedTurns.length === 0) lines.push('- 技术失败：0 轮')
  for (const row of failedTurns) {
    lines.push(`- 技术失败 t${String(row.turnIndex)}（${row.kind}）：${row.failureHint ?? '未知'}；stderr 尾部：${(row.stderrTail ?? '').replace(/\s+/g, ' ').slice(-120)}`)
  }
  const tieBroken = reading.frozenProbes.filter((probe) => probe.tieBroken)
  for (const probe of tieBroken) {
    lines.push(`- 争议加判（协议 v2）：${probe.itemId} ⇒ ${probe.alertState}（三次采样 2/1 多数，单列披露）`)
  }
  const undecidable = reading.frozenProbes.filter((probe) => !probe.ok)
  for (const probe of undecidable) {
    lines.push(`- 弃判：${probe.itemId}（${probe.failure ?? '?'}）——覆盖率不全，判定按 INCOMPLETE 处理`)
  }
  if (existsSync(join(runDir, 'aborted.json'))) lines.push('- ⚠️ 本 run 有中止段（aborted.json 在案）')

  /* 冻结探针全量（问/答 + 机器读数） */
  lines.push('')
  lines.push('## ③ 冻结探针全量（检查点 + 诱导 + 假预设）')
  for (const probe of reading.frozenProbes) {
    const row = byIndex.get(probe.turnIndex)
    const spec = row?.probe
    lines.push('')
    lines.push(`### ${probe.itemId}（t${String(probe.turnIndex)} · ${probe.kind}）`)
    lines.push(`- 问：${row?.userText ?? '(缺失)'}`)
    lines.push(`- 答：${(row?.reply ?? '(无回复)').replace(/\n/g, ' ⏎ ')}`)
    lines.push(`- 机器读数：${probe.ok ? probe.alertState : `弃判（${probe.failure ?? '?'}）——技术失败轮上的探针，无行为读数`}${probe.tieBroken ? '（争议加判）' : ''}`)
    if (spec !== undefined) {
      lines.push(`- 预期：${spec.expect}${spec.expectedPoints.length > 0 ? ` · 要点 [${spec.expectedPoints.join('、')}]` : ''}`)
      lines.push(`- 要点命中 [${probe.expectedPointsHit.join('、') || '—'}] · 未中 [${probe.expectedPointsMissed.join('、') || '—'}]`)
      lines.push(`- 不许出现：${spec.mustNotProduce.join('；')}`)
    }
  }

  /* 候选 alert 全量（G-L5 处置面） */
  lines.push('')
  lines.push('## ④ 候选 alert 全量（扫描候选被量具判 alert 的每一句）')
  lines.push(`- 候选总数 ${String(reading.scan.candidateTotal)} · 送判 ${String(reading.scan.judgedCandidates)}（上限 60 · 溢出 ${String(reading.scan.overflow)}）· alert ${String(reading.scan.alerts.length)}`)
  const candidatesPath = join(localDir, 'scan-candidates.jsonl')
  const candidateByTurn = new Map<number, string[]>()
  if (existsSync(candidatesPath)) {
    for (const line of readFileSync(candidatesPath, 'utf8').split(/\r?\n/).filter((row) => row.trim() !== '')) {
      const row = JSON.parse(line) as { turnIndex: number; sentence: string }
      const list = candidateByTurn.get(row.turnIndex) ?? []
      list.push(row.sentence)
      candidateByTurn.set(row.turnIndex, list)
    }
  }
  for (const alert of reading.scan.alerts) {
    const row = byIndex.get(alert.turnIndex)
    lines.push('')
    lines.push(`- **${alert.itemId}**（t${String(alert.turnIndex)} · 形态族 ${alert.families.join('/')} · 标签 ${alert.labels.join(',') || '(无)'}）`)
    lines.push(`  - 句：${(candidateByTurn.get(alert.turnIndex) ?? []).find((sentence) => alert.itemId.includes(sha256OfText(sentence).slice(0, 8))) ?? '(候选句原文见 scan-candidates.jsonl)'} `)
    lines.push(`  - 该轮她的完整回复：${(row?.reply ?? '').replace(/\n/g, ' ⏎ ').slice(0, 300)}`)
  }

  /* ④ 判安全抽样 */
  lines.push('')
  lines.push('## ⑤ 判安全抽样（runId 种子确定性抽 10 轮 no_alert 回复——查"机器判安全"里有没有漏网）')
  const safePool = turns.filter((row) => row.status === 0 && row.reply !== undefined && row.reply !== '' && row.kind === 'casual')
  const safePicks = seededPick(safePool, 10, seed)
  for (const row of safePicks) {
    lines.push(`- **t${String(row.turnIndex)}** 用户：${row.userText ?? ''}`)
    lines.push(`  - 她：${(row.reply ?? '').replace(/\n/g, ' ⏎ ')}`)
  }

  /* ⑥ 正控对照与遗留人审项（引用，不重造） */
  lines.push('')
  lines.push('## ⑥ 正控对照与遗留人审项（引用现成产物）')
  lines.push('- WP5 短场景支持性回忆正控（B② 批 `m6.1-wp5-short-r1-code-default-*` 的 supported 读数）：她当轮能正确复述显式事实——对照本包长程回忆的衰减形态。')
  lines.push('- WP5 短场景审阅包 A–E 每类 ≥3 条：`docs/m6.1/WP5-Handoff.md` §5.37/§5.38 的产物清单。')
  lines.push('- CIN-01（WP5 §2.2 遗留人审项）：见 `docs/m6.1/WP5-Handoff.md`。')
  lines.push('')
  lines.push('---')
  lines.push('本包正文含双方原话，只存在于 gitignored 的 local/ 目录；Git 内只有 review-pack-summary.json（计数）。')

  const packPath = join(localDir, 'review-pack.md')
  writeFileSync(packPath, `${lines.join('\n')}\n`, 'utf8')

  const summary = {
    schemaVersion: 'm6.1-wp6-review-pack@1',
    at: new Date().toISOString(),
    runId,
    trajectory: reading.trajectory,
    windows: WINDOWS.map((window) => ({ label: window.label, turns: window.to - window.from + 1 })),
    failedTurns: failedTurns.map((row) => ({ turnIndex: row.turnIndex, kind: row.kind, hint: row.failureHint ?? 'unknown' })),
    tieBroken: tieBroken.map((probe) => probe.itemId),
    undecidable: undecidable.map((probe) => probe.itemId),
    probes: reading.frozenProbes.length,
    probeAlerts: reading.frozenProbes.filter((probe) => probe.ok && probe.alertState === 'alert').length,
    candidateTotal: reading.scan.candidateTotal,
    candidateAlerts: reading.scan.alerts.length,
    safeSamples: safePicks.map((row) => row.turnIndex),
    packSha256: sha256OfText(lines.join('\n')),
    packPath: join('artifacts', 'm6.1', 'local', runId, 'review-pack.md'),
  }
  writeFileSync(join(runDir, 'review-pack-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return { summary, packPath }
}

const runIds = (() => {
  const explicit: string[] = []
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--run' && process.argv[i + 1] !== undefined) explicit.push(process.argv[i + 1]!)
  }
  if (explicit.length > 0) return explicit
  return readdirSync(join(ROOT, 'artifacts', 'm6.1'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('m6.1-wp6-long-'))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(ROOT, 'artifacts', 'm6.1', name, 'reading.json')))
    .filter((name) => !existsSync(join(ROOT, 'artifacts', 'm6.1', name, 'abandoned.json')))
})()

if (runIds.length === 0) {
  console.error('没有可用的 WP6 正式 run（带 reading.json 且未作废）')
  process.exit(2)
}
for (const runId of runIds) {
  const { summary, packPath } = buildPack(runId)
  console.log(
    `人审包：${runId} ⇒ ${packPath}` +
      `（探针 ${String(summary.probes)} · alert ${String(summary.probeAlerts)} · 候选 alert ${String(summary.candidateAlerts)} · 安全抽样 ${String((summary.safeSamples as number[]).length)}）`
  )
}
