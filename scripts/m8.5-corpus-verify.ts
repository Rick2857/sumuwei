/**
 * M8.5 WP2 —— 验收语料校验器（量具）
 *
 * 校验 evals/m8.5/corpus/ 下全部语料条目：
 *   schema / id 唯一性与前缀 / 层与类目闭集 / 上下文边界 / 消息长度 /
 *   金标一致性（IMPACT ⇔ family）/ 状态闭集 / 标签数
 * 并核对分层配额（smoke=50 · gate≥250 计分 · blind≥100）。
 *
 * 量具纪律（AGENTS.md §6.8）：计数型检测器必须自检 measured_count > 0——
 * 解析到 0 条时结论是 MEASUREMENT INVALID，不是 PASS。
 *
 * 自包含：不打开任何数据库、不出站、不加载 .env。
 * 证据落盘：artifacts/m8.5/wp2-corpus-verify-<ts>/corpus-verify.json
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CORPUS_ROOT = join(process.cwd(), 'evals', 'm8.5', 'corpus')
const ARTIFACTS_ROOT = join(process.cwd(), 'artifacts', 'm8.5')

const LAYERS = new Set(['smoke', 'gate', 'blind'])
const CATEGORIES = new Set([
  'gratitude', 'repair', 'warm-contact', 'comfort', 'hostile', 'rejection',
  'urgent', 'neutral', 'uncertain', 'out-of-scope', 'manipulation', 'mixed', 'context',
])
const DECISIONS = new Set(['IMPACT', 'NEUTRAL', 'UNCERTAIN', 'OUT_OF_SCOPE'])
const FAMILIES = new Set([
  'A-GRATITUDE', 'A-REPAIR', 'A-WARM-CONTACT', 'A-COMFORT',
  'A-HOSTILE', 'A-REJECTION', 'A-URGENT',
])
const STATUSES = new Set(['gold-final', 'pending-ruling'])
const LAYER_PREFIX: Record<string, string> = { smoke: 's-', gate: 'g-', blind: 'b-' }

interface CorpusEntry {
  id: string
  layer: string
  category: string
  tags?: string[]
  context?: Array<{ role: string; text: string }>
  message: string
  gold: { decision: string; family?: string }
  note?: string
  status?: string
  spanHint?: string
}

const errors: string[] = []
const warnings: string[] = []
const seenIds = new Set<string>()
const layerCounts: Record<string, number> = { smoke: 0, gate: 0, blind: 0 }
const categoryCounts = new Map<string, number>()
const statusCounts = new Map<string, number>()
let parsed = 0
let files = 0

function collectJsonlFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) collectJsonlFiles(full, acc)
    else if (name.name.endsWith('.jsonl')) acc.push(full)
  }
  return acc
}

const jsonlFiles = collectJsonlFiles(CORPUS_ROOT).sort()
if (jsonlFiles.length === 0) {
  console.error('FAIL: no .jsonl files found under ' + CORPUS_ROOT)
  process.exit(1)
}

for (const file of jsonlFiles) {
  files += 1
  const rel = file.slice(CORPUS_ROOT.length + 1).replaceAll('\\', '/')
  const lines = readFileSync(file, 'utf8').split('\n')
  let lineNo = 0
  for (const raw of lines) {
    lineNo += 1
    const line = raw.trim()
    if (line.length === 0) continue
    let entry: CorpusEntry
    try {
      entry = JSON.parse(line) as CorpusEntry
    } catch (err) {
      errors.push(`${rel}:${lineNo} JSON 解析失败: ${(err as Error).message}`)
      continue
    }
    parsed += 1
    const at = `${rel}:${lineNo} (${entry.id ?? '?'})`

    if (typeof entry.id !== 'string' || entry.id.length === 0) { errors.push(`${at} id 缺失`); continue }
    if (seenIds.has(entry.id)) errors.push(`${at} id 重复`)
    seenIds.add(entry.id)

    if (!LAYERS.has(entry.layer)) errors.push(`${at} layer 非法: ${entry.layer}`)
    else {
      layerCounts[entry.layer] += 1
      if (!entry.id.startsWith(LAYER_PREFIX[entry.layer])) {
        errors.push(`${at} id 前缀与 layer 不符: ${entry.layer} 应为 ${LAYER_PREFIX[entry.layer]}`)
      }
    }

    if (!CATEGORIES.has(entry.category)) errors.push(`${at} category 非法: ${entry.category}`)
    else categoryCounts.set(entry.category, (categoryCounts.get(entry.category) ?? 0) + 1)

    if (entry.tags !== undefined) {
      if (!Array.isArray(entry.tags) || entry.tags.length > 5) errors.push(`${at} tags 必须是 ≤5 的数组`)
    }

    if (entry.context !== undefined) {
      if (!Array.isArray(entry.context) || entry.context.length > 6) {
        errors.push(`${at} context 必须 ≤6 条`)
      } else {
        for (const c of entry.context) {
          if (c?.role !== 'user' && c?.role !== 'assistant') errors.push(`${at} context.role 非法: ${c?.role}`)
          if (typeof c?.text !== 'string' || c.text.length === 0) errors.push(`${at} context.text 为空`)
        }
      }
    }

    if (typeof entry.message !== 'string' || entry.message.length === 0) {
      errors.push(`${at} message 为空`)
    } else if (entry.message.length > 500) {
      errors.push(`${at} message 超 500 UTF-16 units: ${entry.message.length}`)
    }

    const gold = entry.gold
    if (gold === undefined || typeof gold !== 'object') {
      errors.push(`${at} gold 缺失`)
    } else {
      if (!DECISIONS.has(gold.decision)) errors.push(`${at} gold.decision 非法: ${gold.decision}`)
      if (gold.decision === 'IMPACT') {
        if (!FAMILIES.has(gold.family ?? '')) errors.push(`${at} IMPACT 必须带合法 family: ${gold.family}`)
      } else if (gold.family !== undefined) {
        errors.push(`${at} 非 IMPACT 不得带 family: ${gold.decision}/${gold.family}`)
      }
    }

    if (entry.note !== undefined && entry.note.length > 120) warnings.push(`${at} note 超 120 字: ${entry.note.length}`)
    const status = entry.status ?? 'gold-final'
    if (!STATUSES.has(status)) errors.push(`${at} status 非法: ${status}`)
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1)
  }
}

// ---- 量具自检：measured_count > 0（AGENTS.md §6.8）----
if (parsed === 0) {
  console.error('MEASUREMENT INVALID: parsed 0 entries — 语料清单为空或全部解析失败，不得判 PASS')
  process.exit(2)
}

// ---- 分层配额核对 ----
const gateScored = layerCounts.gate - (statusCounts.get('pending-ruling') ?? 0)
const quotaChecks = [
  { name: 'smoke = 50', ok: layerCounts.smoke === 50, actual: layerCounts.smoke },
  { name: 'gate total ≥ 250', ok: layerCounts.gate >= 250, actual: layerCounts.gate },
  { name: 'gate scored (gold-final) ≥ 250', ok: gateScored >= 250, actual: gateScored },
  { name: 'blind ≥ 100', ok: layerCounts.blind >= 100, actual: layerCounts.blind },
  { name: '全部 13 类目均有条目', ok: categoryCounts.size === 13, actual: categoryCounts.size },
]
for (const q of quotaChecks) if (!q.ok) errors.push(`配额未达: ${q.name}，实际 ${q.actual}`)

// ---- 上下文条目覆盖核对（跨轮用例必须真实带 context）----
const contextCount = countContextEntries()
function countContextEntries(): number {
  let n = 0
  for (const file of jsonlFiles) {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim()
      if (line.length === 0) continue
      try {
        const e = JSON.parse(line) as CorpusEntry
        if (Array.isArray(e.context) && e.context.length > 0) n += 1
      } catch { /* 已在上面报错 */ }
    }
  }
  return n
}
if (contextCount < 20) errors.push(`跨轮上下文条目不足: ${contextCount} < 20`)

const verdict = errors.length === 0 ? 'PASS' : 'FAIL'
const result = {
  verdict,
  measured_count: parsed,
  files,
  layerCounts,
  categoryCounts: Object.fromEntries([...categoryCounts.entries()].sort()),
  statusCounts: Object.fromEntries([...statusCounts.entries()].sort()),
  gateScored,
  contextEntries: contextCount,
  quotaChecks,
  errors,
  warnings,
  checkedAt: new Date().toISOString(),
}

const runId = `wp2-corpus-verify-${result.checkedAt.replace(/[-:T.]/g, '').slice(0, 15)}`
const outDir = join(ARTIFACTS_ROOT, runId)
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'corpus-verify.json')
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8')

console.log(`verdict        : ${verdict}`)
console.log(`measured_count : ${parsed} (files: ${files})`)
console.log(`layers         : smoke=${layerCounts.smoke} gate=${layerCounts.gate} (scored ${gateScored}) blind=${layerCounts.blind}`)
console.log(`contextEntries : ${contextCount}`)
console.log(`errors         : ${errors.length}`)
for (const e of errors) console.log('  ERROR ' + e)
console.log(`warnings       : ${warnings.length}`)
console.log(`evidence       : ${outPath}`)
process.exit(verdict === 'PASS' ? 0 : 1)
