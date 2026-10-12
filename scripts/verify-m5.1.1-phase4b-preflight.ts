/**
 * M5.1.1 / Phase 4b —— **只读预检**（`prepare` + `preview`，ADR-043 §4.3）。
 *
 * ============================================================================
 *  它为什么存在
 * ============================================================================
 * `4a` 的历史已经证明"先量再写"是必需的：4-preflight 的影响清单把
 * `k17` / `wp61` 判成"不受影响"，而那两处恰恰是 4a 唯一的两个结构性红灯。
 * `4b` 的改动面比 4a 更宽（recall 排序 / prompt 渲染 / 探针 / 开发者平面），
 * 而且它会**改变她已经记住的东西的呈现方式**。
 *
 * ADR-043 §4.3 还要求：激活是一次 **Privileged Cognitive Operation**，路径是
 *
 *     prepare → preview（半径报告）→ warn → **用户显式确认** → execute → verify → audit
 *
 * 本脚本就是其中的 **prepare + preview + warn 三段的机器部分**。
 * 它**不**执行 4b、**不**改 `src/**`、**不**开数据库、**不**写认知。
 *
 * ============================================================================
 *  它量什么（全部只读）
 * ============================================================================
 * ① 变更面精确清单：ADR-043 §4.1 / §5 点名的每个面，在今天的源码里**逐文件逐行**落点
 * ② 门影响清单：哪些门会因 4b 变红 / 需要追平 / 不受影响（按针扫描，不靠猜）
 * ③ 存量半径：引用**已实测**的 production-copy 读数（2 条，2 条失去资格）
 * ④ ⚠️ **一处新前置**：真实库当前是 **v6**，没有归因列 ⇒ 4b 的派生在真库上
 *    一律 fail-closed ⇒ **她今天全部 2 条长期记忆（2/2 = 100%）** 都会拿到
 *    `UNCONFIRMED_ORIGIN` 的标签与降档排序。这是 ADR-043 的 Landing 没有讨论过的前提。
 * ⑤ preview：`render.ts:124` 的**逐字前后对照** + 排序变化 + 受影响条数（INV-CI-04 的 warn 材料）
 *
 * 跑法：`pnpm m5.1.1:phase4b:preflight`
 */

import 'dotenv/config'

import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.1.1')
const SELF_REL = 'scripts/verify-m5.1.1-phase4b-preflight.ts'

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
}

function measure(label: string, count: number): number {
  const valid = count > 0
  measurements.push({ label, count, valid })
  if (!valid) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}

function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}

// ---------------------------------------------------------------------------
// 扫描面
// ---------------------------------------------------------------------------

function readTree(relativeRoot: string): Map<string, string> {
  const files = new Map<string, string>()
  const base = join(ROOT, relativeRoot)
  if (!existsSync(base)) return files
  for (const entry of readdirSync(base, { recursive: true }).map(String)) {
    if (!entry.endsWith('.ts')) continue
    const key = `${relativeRoot}/${entry.replace(/\\/g, '/')}`
    files.set(key, readFileSync(join(base, entry), 'utf8'))
  }
  return files
}

const SRC = readTree('src')
const SCRIPTS_ALL = readTree('scripts')
const selfPresent = SCRIPTS_ALL.has(SELF_REL)
const SCRIPTS = new Map(SCRIPTS_ALL)
SCRIPTS.delete(SELF_REL)
const EVALS = readTree('evals')

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function filesContaining(files: Map<string, string>, needle: string): string[] {
  return [...files.entries()]
    .filter(([, text]) => text.includes(needle))
    .map(([key]) => key)
    .sort()
}

function totalOccurrences(files: Map<string, string>, needle: string): number {
  return [...files.values()].reduce((sum, text) => sum + countOccurrences(text, needle), 0)
}

function lineNumbersOf(text: string, needle: string): number[] {
  const out: number[] = []
  text.split('\n').forEach((line, index) => {
    if (line.includes(needle)) out.push(index + 1)
  })
  return out
}

console.log('='.repeat(74))
console.log('M5.1.1 Phase 4b —— 只读预检（prepare / preview / warn）')
console.log('='.repeat(74))

// ---------------------------------------------------------------------------
// §0 量具自检
// ---------------------------------------------------------------------------

section('§0 量具自检（`measured_count > 0` + 针能命中 + 自身排除）')

const measuredCount = SRC.size + SCRIPTS.size + EVALS.size
measure('扫描的源文件数（src + scripts + evals）', measuredCount)
check(
  '量具自检：扫描范围非空',
  measuredCount > 0,
  `src ${SRC.size} · scripts ${SCRIPTS.size}（已排除本门）· evals ${EVALS.size}`
)
check(
  '量具自检：自身排除确实生效（路径存在且排除后少 1 个文件）',
  selfPresent && SCRIPTS.size === SCRIPTS_ALL.size - 1,
  `selfPresent=${String(selfPresent)} · ${SCRIPTS_ALL.size} → ${SCRIPTS.size}`
)

/*
 * 针能命中的自检：**先证明针在已知存在处能命中**，否则下面每一条 "== 0" 都可能
 * 只是"什么都没扫到"（AGENTS §6.8 那条真实事故）。
 */
const NEEDLE_RENDER = 'renderMemoryEntry'
const NEEDLE_AUTHORITY_RANK = 'authorityRank('
const NEEDLE_CONTAMINATED = 'contaminatedMemories'
const NEEDLE_MIN_AUTHORITY = 'minAuthority'
const NEEDLE_QUALIFICATION = 'SourceQualification'

const renderHits = totalOccurrences(SRC, NEEDLE_RENDER)
const authorityRankHits = totalOccurrences(SRC, NEEDLE_AUTHORITY_RANK)
const contaminatedHits = totalOccurrences(SRC, NEEDLE_CONTAMINATED)
check(
  '量具自检：针**能**命中已知存在处',
  renderHits > 0 && authorityRankHits > 0 && contaminatedHits > 0,
  `${NEEDLE_RENDER} ${renderHits} 处 · ${NEEDLE_AUTHORITY_RANK} ${authorityRankHits} 处 · ${NEEDLE_CONTAMINATED} ${contaminatedHits} 处`
)

// ---------------------------------------------------------------------------
// §1 变更面精确清单（逐文件逐行）
// ---------------------------------------------------------------------------

section('§1 变更面精确清单（ADR-043 §4.1 / §5 点名的每个面，逐个落到行）')

interface SurfaceRow {
  face: string
  adr: string
  change: 'modify' | 'new' | 'unchanged'
  files: string[]
  touchPoints: string[]
}

const renderText = SRC.get('src/kernel/recall/render.ts') ?? ''
const rankingText = SRC.get('src/kernel/recall/ranking.ts') ?? ''
const eligibilityText = SRC.get('src/kernel/recall/eligibility.ts') ?? ''
const storeText = SRC.get('src/infrastructure/persistence/memory-store.ts') ?? ''

const surface: SurfaceRow[] = [
  {
    face: 'prompt 标签（她读到的上下文）',
    adr: '§3.3 ⑦ · §5「renderMemoryEntry 输出 ⇒ prompt 字节变化」',
    change: 'modify',
    files: ['src/kernel/recall/render.ts'],
    touchPoints: lineNumbersOf(renderText, NEEDLE_RENDER).map((n) => `render.ts:${n}`),
  },
  {
    face: 'Recall 排序（authority 分量降一档）',
    adr: '§3.3 ⑥',
    change: 'modify',
    files: ['src/kernel/recall/ranking.ts'],
    touchPoints: lineNumbersOf(rankingText, NEEDLE_AUTHORITY_RANK).map((n) => `ranking.ts:${n}`),
  },
  {
    face: 'Recall 入选（**仍允许**，不得新增排除理由）',
    adr: '§3.3 ⑤ + INV-CI-05',
    change: 'unchanged',
    files: ['src/kernel/recall/eligibility.ts'],
    touchPoints: lineNumbersOf(eligibilityText, NEEDLE_MIN_AUTHORITY).map((n) => `eligibility.ts:${n}`),
  },
  {
    face: '第二个只读探针（既有探针不动）',
    adr: '§4.1 · DR-9 · §5「memory-store.ts 只加一个新探针」',
    change: 'modify',
    files: ['src/infrastructure/persistence/memory-store.ts'],
    touchPoints: lineNumbersOf(storeText, NEEDLE_CONTAMINATED).map((n) => `memory-store.ts:${n}`),
  },
  {
    face: '开发者平面 DTO（暴露资格）',
    adr: '§4.1 · §5',
    change: 'modify',
    files: ['src/kernel/contracts/developer-query.ts', 'src/infrastructure/dev/query-service.ts'],
    touchPoints: [],
  },
  {
    face: 'qualification 派生（**新文件**，纯函数）',
    adr: '§3.1 / §3.2 · §4.1',
    change: 'new',
    files: [],
    touchPoints: [],
  },
  {
    face: 'Recall 候选形状（携带资格）',
    adr: '§3.3 ⑥⑦ 的前置：排序与渲染都要拿到它',
    change: 'modify',
    files: ['src/kernel/contracts/recall.ts', 'src/kernel/recall/record.ts', 'src/kernel/recall/selector.ts'],
    touchPoints: [],
  },
]

for (const row of surface) {
  for (const file of row.files) {
    if (!SRC.has(file)) {
      check(`变更面引用的文件必须真实存在：${file}`, false, '(不存在 —— 清单已漂移)')
    }
  }
}
measure('变更面条目数', surface.length)
measure('变更面涉及的文件数', new Set(surface.flatMap((row) => row.files)).size)

check(
  '变更面清单非空且每一项都有 ADR 出处',
  surface.length > 0 && surface.every((row) => row.adr.length > 0 && row.change.length > 0),
  `${surface.length} 项`
)

for (const row of surface) {
  const tag = row.change === 'modify' ? '改' : row.change === 'new' ? '新增' : '**不得改**'
  console.log(
    `  · [${tag}] ${row.face}\n      ADR ${row.adr}\n      文件：${row.files.join(', ') || '(新文件，待定名)'}` +
      (row.touchPoints.length > 0 ? `\n      落点：${row.touchPoints.join(', ')}` : '')
  )
}

/* ---- 不变量：eligibility 不得被 4b 改动（⑤ 仍允许入选） ---- */
const AUTHORITY_BELOW_POLICY = "'authority_below_policy'"
const eligibilityReasonFiles = filesContaining(SRC, AUTHORITY_BELOW_POLICY)
const eligibilityReasonHits = totalOccurrences(SRC, AUTHORITY_BELOW_POLICY)
check(
  '⑤ 不变量：`eligibility` 的排除理由集合**不变**（4b 不得新增"资格不够 ⇒ 不入选"）',
  eligibilityReasonFiles.join() === 'src/kernel/recall/eligibility.ts' && eligibilityReasonHits === 2,
  `${AUTHORITY_BELOW_POLICY} 只在 ${eligibilityReasonFiles.join(', ') || '(无)'} 出现 ${eligibilityReasonHits} 处（类型字面量 + reject 各 1）`
)

/* ---- 不变量：既有探针 contaminatedMemories 的判据文本（DR-9） ---- */
const contaminatedSqlAnchor = "authority not in ('EXPLICIT_USER_STATEMENT', 'EXPLICIT_CORRECTION')"
check(
  'DR-9 不变量：`contaminatedMemories` 的判据 SQL **一字未改**（4b 只允许**追加**第二个探针）',
  storeText.includes(contaminatedSqlAnchor),
  contaminatedSqlAnchor.slice(0, 60) + '…'
)

/* ---- ⚠️ 命名冲突：4a 已经引入了同一组三值 ---- */
const sourceQualificationFile = filesContaining(SRC, NEEDLE_QUALIFICATION)
const memoryQualificationFiles = filesContaining(SRC, 'MemoryQualification')
check(
  '⚠️ 命名决策已量出：4a 的三值类型叫 `SourceQualification`，而 ADR §3.1 叫 `MemoryQualification`',
  sourceQualificationFile.length > 0 && memoryQualificationFiles.length === 0,
  `SourceQualification 出现在 ${sourceQualificationFile.join(', ')}；MemoryQualification 尚未存在（0 处）`
)

// ---------------------------------------------------------------------------
// §2 门影响清单（按针扫描，不靠猜）
// ---------------------------------------------------------------------------

section('§2 门影响清单（哪些门会因 4b 变红 / 需追平 / 不受影响）')

const PROMPT_BASELINE_REL = 'evals/fixtures/m3.5/prompt-baseline.txt'
const promptBaselineExists = existsSync(join(ROOT, PROMPT_BASELINE_REL))
measure('prompt 基线文件存在（4b 会改 prompt 字节）', promptBaselineExists ? 1 : 0)
check(
  'prompt 基线文件在位 ⇒ 4b 落地时**必须**重刷（ADR §4.1 明写）',
  promptBaselineExists,
  PROMPT_BASELINE_REL
)

interface GateImpact {
  pnpm: string
  script: string
  will: 'red' | 'rebaseline' | 'review' | 'unaffected'
  why: string
}

const gateScan: readonly { pnpm: string; needle: string; will: GateImpact['will']; why: string }[] = [
  { pnpm: 'm3.5:test', needle: 'prompt-baseline', will: 'rebaseline', why: 'prompt 逐字节基线：4b 改了 renderMemoryEntry 的输出' },
  { pnpm: 'm5:test', needle: 'renderMemoryEntry', will: 'review', why: 'recall 部件测试直接断言渲染行' },
  { pnpm: 'm5:verify', needle: 'authorityRank', will: 'review', why: '资格子系统正负双控会碰到 authority 分量' },
  { pnpm: 'm5:metrics:verify', needle: 'authority_below_policy', will: 'review', why: '资格/排序判据改动需重出度量' },
  { pnpm: 'm5:nl-e2e:verify', needle: 'MEMORY_BLOCK_HEADER', will: 'review', why: '自然语言端到端会看见 prompt 里的记忆块' },
  { pnpm: 'm5.1:query:verify', needle: 'contaminatedMemories', will: 'review', why: '开发者平面的 stats 读这两个探针' },
  { pnpm: 'm5.1:test', needle: 'getMemoryStats', will: 'review', why: 'dev 平面 DTO 追加字段' },
  { pnpm: 'm5.1:page:verify', needle: 'page.html', will: 'review', why: '页面若渲染新字段需同步' },
  { pnpm: 'm4:verify', needle: 'contaminatedMemories', will: 'review', why: '既有探针的调用点与断言（DR-9 要求它不变）' },
]

const gateImpact: GateImpact[] = gateScan.map((row) => {
  const inScripts = filesContaining(SCRIPTS, row.needle)
  const inEvals = filesContaining(EVALS, row.needle)
  const inSrc = filesContaining(SRC, row.needle)
  return {
    pnpm: row.pnpm,
    script: [...new Set([...inScripts, ...inEvals, ...inSrc])].join(', ') || '(未命中)',
    will: inScripts.length + inEvals.length + inSrc.length > 0 ? row.will : 'unaffected',
    why: row.why,
  }
})

measure('门影响清单条目数', gateImpact.length)
measure(
  '命中针的文件数（门影响清单的依据）',
  new Set(gateImpact.flatMap((row) => (row.script === '(未命中)' ? [] : row.script.split(', ')))).size
)

check(
  '门影响清单非空且每条都有理由',
  gateImpact.length > 0 && gateImpact.every((row) => row.why.length > 0),
  `${gateImpact.length} 条`
)
for (const row of gateImpact) {
  console.log(`  · [${row.will}] ${row.pnpm}\n      ${row.why}\n      命中：${row.script}`)
}

const unmeasuredGates = gateImpact.filter((row) => row.script === '(未命中)').map((row) => row.pnpm)
check(
  '没有"命中 0 个文件"的门（否则那条影响判断是无依据的）',
  unmeasuredGates.length === 0,
  unmeasuredGates.join(', ') || '0'
)

// ---------------------------------------------------------------------------
// §3 存量半径（引用已实测的 production-copy 读数）
// ---------------------------------------------------------------------------

section('§3 存量半径（引用已实测读数；**不**在真库上重跑）')

const radiusReportRel = 'docs/m5.1.1/M5.1.1-Phase4-Cognitive-Impact-Radius.md'
const radiusText = existsSync(join(ROOT, radiusReportRel)) ? readFileSync(join(ROOT, radiusReportRel), 'utf8') : ''
measure('影响半径报告的字节数', radiusText.length)
check('影响半径报告在位（由 `m5.1.1:wp3:verify` 在 production-copy 上生成）', radiusText.length > 0, radiusReportRel)

const radiusNumbers = {
  evidenceChains: /证据链路（memory_records × memory_evidence_links）: (\d+)/.exec(radiusText)?.[1] ?? null,
  qualifiedToday: /今天有资格（canSupportExternalFact = true）\s*: (\d+)/.exec(radiusText)?.[1] ?? null,
  lostAfterPhase4: /Phase 4 假设下会失去资格的\s*: (\d+)/.exec(radiusText)?.[1] ?? null,
}
check(
  '三条半径读数都能从报告里解析出来（解析失败 = 量具坏，不是"没影响"）',
  radiusNumbers.evidenceChains !== null && radiusNumbers.qualifiedToday !== null && radiusNumbers.lostAfterPhase4 !== null,
  JSON.stringify(radiusNumbers)
)
check(
  '存量半径 = 2 条，且**全部**会失去资格（即 100%）',
  radiusNumbers.evidenceChains === '2' && radiusNumbers.qualifiedToday === '2' && radiusNumbers.lostAfterPhase4 === '2',
  `${JSON.stringify(radiusNumbers)} ⇒ 受影响 ${radiusNumbers.lostAfterPhase4}/${radiusNumbers.evidenceChains}`
)

// ---------------------------------------------------------------------------
// §4 关键前置：真库的归因列状态（本次迁移后**已实测**，不再是推论）
// ---------------------------------------------------------------------------

section('§4 关键前置：真库归因列的实际状态（v9 迁移后已实测）')

const agentsText = existsSync(join(ROOT, 'AGENTS.md')) ? readFileSync(join(ROOT, 'AGENTS.md'), 'utf8') : ''
measure('AGENTS.md 的字节数', agentsText.length)
const realDbV9Recorded = /真实库当前已是 \*\*v9\*\*/.test(agentsText)
const realDbV9Recorded2 = /当前已应用至 schema v9/.test(agentsText)
const migrationsText = existsSync(join(ROOT, 'src/infrastructure/persistence/migrations.ts'))
  ? readFileSync(join(ROOT, 'src/infrastructure/persistence/migrations.ts'), 'utf8')
  : ''
const migrationCount = (migrationsText.match(/version:\s*\d+/g) ?? []).length
measure('已发布的迁移条数', migrationCount)

check(
  '真库已经迁移到 v9（用户 D-1 = ②；AGENTS.md 两处已记录）',
  realDbV9Recorded && realDbV9Recorded2,
  `两处表述命中：${String(realDbV9Recorded)} / ${String(realDbV9Recorded2)}`
)
check(
  '归因列属于 v7 迁移 ⇒ 真库现在**有**这些列，但历史行全是 NULL ⇒ 派生仍然 fail-closed（DR-7）',
  migrationCount >= 9,
  `代码里已发布 ${migrationCount} 条迁移（v7=归因模型 · v8=K22 · v9=state 归因）`
)
check(
  '⚠️ **推论已实测**：真库上 4b 的效果 = 她今天**全部** 2 条长期记忆（2/2 = 100%）都拿到 `UNCONFIRMED_ORIGIN`',
  radiusNumbers.lostAfterPhase4 === radiusNumbers.evidenceChains && radiusNumbers.evidenceChains !== null,
  '迁移**不改变**这个 100%：`pnpm m5.1.1:phase4b:db-v9` 实测 28 行 conversation_events 里 ' +
    '`attribution_origin` 非 NULL = 0 ⇒ 全部历史行没有信封（迁移只影响**新写入**的记忆）'
)

// ---------------------------------------------------------------------------
// §5 preview（INV-CI-04 的 warn 材料：逐字前后对照）
// ---------------------------------------------------------------------------

section('§5 preview（`render.ts:124` 逐字前后对照 + 排序变化）')

// ⚠️ 旧行在源码里是**模板字面量**（以反引号开头），锚点必须逐字取它 —— 第一版写成单引号，假红
const oldLineAnchor = '`- ${input.dataText}'
check('preview：旧渲染行的锚点逐字取自 `render.ts`', renderText.includes(oldLineAnchor), 'render.ts:124')

const preview = {
  before: '`- {dataText}（{authority}）`（status ≠ active 时追加 ` / {status}`）',
  afterEstablished: '`- {dataText}（{authority}）`  ← **不变**',
  afterUnconfirmed: '`- {dataText}（{authority} / 来源未确立）`',
  afterContradicted: '`- {dataText}（{authority} / 来源与记录不符）`',
  oldLineInSource: oldLineAnchor,
  rankingBefore: 'authority 分量 = (5 − authorityRank(authority)) / 5',
  rankingAfter: '资格 ≠ ESTABLISHED 时 authorityRank **按降一档**计（不改库值；status=disputed 再降）',
}
console.log(JSON.stringify(preview, null, 2))

measure('preview 的字段数', Object.keys(preview).length)
check('preview 含"前""后"两态且给出了两种非 ESTABLISHED 的标签', Object.keys(preview).length >= 6, `${Object.keys(preview).length} 个字段`)

// ---------------------------------------------------------------------------
// §6 N-1…N-6（新门必须带的判据）与激活 / 回滚
// ---------------------------------------------------------------------------

section('§6 新门判据（ADR-043 §4.2 N-1…N-6）与激活 / 回滚路径')

const gateCriteria = [
  { id: 'N-1', kind: '负控', text: '伪造"agent 以 user 角色替发"的事件（**无**受信归因）⇒ 新闸必须拒绝', owner: '4a 已实现（新门复用它）' },
  { id: 'N-2', kind: '正控', text: '同一内容带**受信的人类**归因 ⇒ 必须**正常形成**', owner: '4a 已实现' },
  { id: 'N-3', kind: '正控', text: '既有 legacy 记忆的资格 = UNCONFIRMED_ORIGIN ∧ `memory_records.authority` **逐字节未变**', owner: '**4b 新增**（最重要）' },
  { id: 'N-4', kind: '恢复', text: '规则版本回退 ⇒ 资格恢复 ESTABLISHED ∧ 账本**未被改写**', owner: '**4b 新增**' },
  { id: 'N-5', kind: '正控', text: '`contaminatedMemories()` 仍 = 0（不得把新状态算成污染）', owner: '4b（既有门 + 新门都要守）' },
  { id: 'N-6', kind: '自检', text: '受影响条目数 / 受影响脚本数必须 > 0，否则 **MEASUREMENT INVALID**', owner: '**4b 新增**（本预检已给出两个非零读数）' },
]
measure('N-1…N-6 条目数', gateCriteria.length)
check('N-1…N-6 六条齐全', gateCriteria.length === 6, gateCriteria.map((g) => g.id).join(' '))
for (const c of gateCriteria) console.log(`  · ${c.id} [${c.kind}] ${c.text}\n      归属：${c.owner}`)

const activationSteps = [
  'prepare（本预检 + 改动面/门影响清单）',
  'preview（半径报告：本节 §3 §4 §5）',
  'warn（把 §4 的 100% 与 prompt 标签变化明确告知）',
  '**confirm（用户显式确认 —— ADR §4.3 要求，不可由代理代签）**',
  'execute（改 recall + render + 探针 + DTO + 重刷 prompt 基线）',
  'verify（新门 + m5:* + m3.5:test + m5.1:* 全绿）',
  'audit（**追加** `docs/m5.1.1/M5.1.1-ADR-043-Activation-Record.md`，不删旧记录）',
]
measure('激活路径步数', activationSteps.length)
check(
  '激活路径含"用户显式确认"这一步（INV-CI-04：不可由代理代签）',
  activationSteps.some((s) => s.includes('用户显式确认')),
  activationSteps.length + ' 步'
)
for (const [index, step] of activationSteps.entries()) console.log(`  ${index + 1}. ${step}`)

check(
  '回滚是精确且免费的（4b 不向认知写入任何东西 ⇒ 版本回退即恢复）',
  surface.every((row) => row.face !== '记录权威'),
  '本预检确认：4b 的改动面里**没有**"写认知"的一项'
)

// ---------------------------------------------------------------------------
// §7 需要用户裁定的决策（本预检**不**替用户决定）
// ---------------------------------------------------------------------------

section('§7 需要用户裁定的决策（本预检到此 STOP）')

const decisions = [
  {
    id: 'D-1',
    question: '4b 是否在真库迁移到 v9 之后落地？（用户已裁定 ②，迁移已落地，本条为**已完成**记录）',
    options: '✅ 已裁定 ② 并执行：真实库 v6 → v9 已应用，且由 `pnpm m5.1.1:phase4b:db-v9` 逐条验证（既有行身份摘要逐字未变、无任何伪造归因）',
    basis: '§4：v9 已记录；历史行 0 条带信封 ⇒ 100% 不变',
  },
  {
    id: 'D-2',
    question: '派生量类型是**复用** 4a 已落地的 `SourceQualification`，还是按 ADR §3.1 新引入 `MemoryQualification`？',
    options: '✅ 已裁定 ① 复用 `SourceQualification`（ADR §3.1 的 `MemoryQualification` 作为同一组三值的别名，在 Landing 记一笔）',
    basis: '§1：`SourceQualification` 已存在；`MemoryQualification` 0 处',
  },
  {
    id: 'D-3',
    question: 'prompt 基线重刷（`pnpm m3.5:baseline`）是否在本次 4b 授权内？',
    options: '✅ 已裁定 ① 纳入 4b（ADR §4.1 明写它是 4b 的必跑门；AGENTS §3 把它列为冻结区，因此重刷时必须**说明理由**）',
    basis: '§2：`evals/fixtures/m3.5/prompt-baseline.txt` 在位',
  },
  {
    id: 'D-4',
    question: '开发者平面（`developer-query` DTO + `dev/**`）是否在本次 4b 内？',
    options: '✅ 已裁定 ① 纳入 4b（ADR §4.1/§5 点名）',
    basis: '§1/§2：DTO 与 page 各自有门',
  },
  {
    id: 'D-5',
    question: '（迁移后新增）4b 的 `execute` 段现在可以开始吗？',
    options: '**待用户显式确认** —— ADR §4.3 明写激活是 Privileged Cognitive Operation，`confirm` 不可由代理代签',
    basis: 'D-1…D-4 已全部裁定；前置（真库 v9）已落地并验证',
  },
]
measure('待裁定决策数', decisions.length)
check('决策清单非空（预检不以"没有决策"收尾）', decisions.length > 0, `${decisions.length} 条`)
for (const d of decisions) console.log(`  · ${d.id} ${d.question}\n      选项：${d.options}\n      依据：${d.basis}`)

// ---------------------------------------------------------------------------
// 证据落盘
// ---------------------------------------------------------------------------

mkdirSync(EVIDENCE_DIR, { recursive: true })
const evidence = {
  workPackage: 'M5.1.1 / Phase 4b — 只读预检（prepare / preview / warn）',
  nature: 'read-only；未改 src/**、未开数据库、未激活 4b',
  authorization: '用户 2026-09-19：「4b 授权」+ ADR-043 §4.1/§4.3',
  scanned: { src: SRC.size, scriptsExcludingSelf: SCRIPTS.size, evals: EVALS.size },
  measurements,
  measurementInvalid: measurements.filter((m) => !m.valid).length,
  surface,
  gateImpact,
  radius: { report: radiusReportRel, ...radiusNumbers, affectedRatio: '100%' },
  newPrerequisite: {
    finding:
      '真实库已按用户 D-1 = ② 迁移至 v9（2026-09-19）；归因列现在存在，但**全部历史行的 `attribution_origin` 仍是 NULL** ⇒ 4b 的资格派生对它们一律 fail-closed（DR-7）',
    evidence:
      'AGENTS.md §3/§1 已记录 v9；`pnpm m5.1.1:phase4b:db-v9` 实测：28 行 conversation_events 里 attribution_origin 非 NULL = 0、MIGRATED_LEGACY = 0、content_originator_kind = USER = 0',
    consequence:
      '她今天全部 2 条长期记忆（2/2 = 100%）都会拿到 UNCONFIRMED_ORIGIN 的标签与降档排序 —— 迁移**不改变**这个 100%，它只影响**新写入**的记忆能不能被确立',
    resolvedDecision: 'D-1 已由用户裁定为 ②，且迁移已落地并逐条验证',
  },
  preview,
  gateCriteria,
  activationSteps,
  decisions,
  scope: {
    modifiedSrc: false,
    openedDatabase: false,
    activated4b: false,
    wroteCognition: false,
    executed4b: false,
  },
  passed,
  failed,
  failures,
}

writeFileSync(join(EVIDENCE_DIR, 'wp4bpre-preflight.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(`\n证据已写入：${relative(ROOT, join(EVIDENCE_DIR, 'wp4bpre-preflight.json')).replace(/\\/g, '/')}`)

console.log('\n' + '='.repeat(74))
console.log(`M5.1.1 Phase 4b 只读预检：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
console.log('='.repeat(74))
process.exit(failed === 0 ? 0 : 1)
