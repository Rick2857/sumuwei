/**
 * M5.1.1 / WP11 —— **Phase 1–3 Closure**（`pnpm m5.1.1:wp11:verify`）
 *
 * ============================================================================
 *  这道门做什么（canonical WP11 的原文要求）
 * ============================================================================
 * ```text
 * 生成：M5.1.1-Phase1-3-Acceptance-Report.md
 *
 * 报告必须分别给出：
 *   Phase 1        PASS / FAIL
 *   Phase 2        PASS / FAIL
 *   Phase 3        PASS / FAIL
 *   Phase 4        BLOCKED BY ADR-043
 *   M5.1.1 Final   BLOCKED
 *   M5.1-D01       P1 OPEN
 *
 * 不得写：M5.1.1 PASS
 * 不得写：D01 CLOSED
 * 即使 Phase 1–3 全绿。
 * ```
 *
 * ============================================================================
 *  这道门的**立场**：报告里的状态不是"人写的"，是**算出来的**
 * ============================================================================
 *  ① 本门**独立地**从 `artifacts/m5.1.1/**` 的落盘证据里**算出** Phase 1 / 2 / 3 的状态
 *     （每一格都指名到具体证据文件的**具体字段**，见 §2–§4）；
 *     然后**断言**报告里那六行与算出来的值**逐字相同**。
 *     ⇒ 报告不可能"自己说自己绿"。
 *  ② 本门**机器地**执行 canonical 的禁令：`M5.1.1 PASS` / `D01 CLOSED` 这类断言
 *     **不得**出现在两份报告里（唯一例外：出现在**明确的禁止语**上下文里，例如
 *     canonical 自己那句"不得写：…"）。这条检测器走**正控 / 负控 / 恢复**三段式（§6）。
 *  ③ `Phase 4 = BLOCKED BY ADR-043` 不是一句声明：本门**读 `ADR-043` 草案文件自己的状态行**
 *     （必须是 `DRAFT / NOT APPROVED`）⇒ 它是**事实推导**出来的。
 *
 * ============================================================================
 *  不重跑任何门
 * ============================================================================
 * 本门只**读**已落盘证据（AGENTS §6.4：文件不存在 = `not-run`，**不是** PASS）。
 * 它不写 `artifacts/m5.1/**`，不改 `src/**`，不开数据库。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, ok: boolean, detail: string): boolean {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}  [${detail}]`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}  [${detail}]`)
  }
  return ok
}
function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}
function measure(label: string, count: number, valid = count > 0): void {
  measurements.push({ label, count, valid })
  console.log(`  · 量：${label} = ${count}${valid ? '' : '   ← MEASUREMENT INVALID'}`)
}

const ROOT = process.cwd()
const ART = join(ROOT, 'artifacts', 'm5.1.1')
const DOCS = join(ROOT, 'docs', 'm5.1.1')
const FREEZE_TAG = 'm5.1-complete'
const FREEZE_TAG_OBJECT = '2e718f38a6256330d1a72af960702f64f570efff'
const FREEZE_TARGET_COMMIT = '2aac6cad50e0dbf66f26bf243345d9af01861013'
const FROZEN_DIRS = ['artifacts/m4-acceptance', 'artifacts/m4.1', 'artifacts/m4.5', 'artifacts/m5', 'artifacts/m5.1'] as const
const REPORT = join(DOCS, 'M5.1.1-Phase1-3-Acceptance-Report.md')
const GATE_DECISION = join(DOCS, 'M5.1.1-Gate-Decision.md')
const ADR_043 = join(DOCS, 'M5.1.1-ADR-043-Epistemic-Requalification-Draft.md')
/**
 * 本门**自己声明**的写入面 —— **本 WP 的五份有意产物**（R-46 §2 的白名单纪律）。
 * 除此之外工作树必须完全干净：任何**别人**的被跟踪改动或未跟踪文件都会让 §0 报红，
 * **没有**清洁度例外（本轮实测抓到过两次：一次是未提交的 F4 更正、一次是未提交的 handoff）。
 *
 * 注意区分"容忍"与"不检查"：本门**容忍**这五份产物自己是脏的（否则它提交后无法再跑），
 * 但它对**两份判定文档**的内容是**逐字断言**的（六行状态 + canonical 禁令检测器）——
 * 那才是判据所在。
 */
const SELF_WRITE = [
  'artifacts/m5.1.1/wp11-phase1-3-closure.json',
  'artifacts/m5.1.1/wp11-gate-exits.txt',
  'docs/m5.1.1/M5.1.1-Phase1-3-Acceptance-Report.md',
  'docs/m5.1.1/M5.1.1-Gate-Decision.md',
  'docs/m5.1.1/WP11-Handoff.md',
]

const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')

/** `git status --porcelain` 的路径解析：`slice(2).trim()`（WP10-C 的 `C-G1` 教训） */
function porcelainPaths(out: string): string[] {
  return out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(2).trim().replace(/\\/g, '/'))
}

/* ---------------------------------------------------------------------------
 * 证据读取（**只读已落盘证据**；不存在 = not-run，不是 PASS）
 * ------------------------------------------------------------------------- */

interface ReadResult {
  path: string
  present: boolean
  json: Record<string, unknown> | null
  bytes: number
  sha256: string
}
function readEvidence(rel: string): ReadResult {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return { path: rel, present: false, json: null, bytes: 0, sha256: '' }
  const raw = readFileSync(abs, 'utf8')
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(raw) as Record<string, unknown>
  } catch {
    json = null
  }
  return { path: rel, present: true, json, bytes: Buffer.byteLength(raw, 'utf8'), sha256: sha256(raw) }
}
const at = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, k) => (acc === null || acc === undefined ? undefined : (acc as Record<string, unknown>)[k]), o)
const num = (o: unknown, p: string): number | null => {
  const v = at(o, p)
  return typeof v === 'number' ? v : null
}
const bool = (o: unknown, p: string): boolean | null => {
  const v = at(o, p)
  return typeof v === 'boolean' ? v : null
}
const str = (o: unknown, p: string): string | null => {
  const v = at(o, p)
  return typeof v === 'string' ? v : null
}
const arr = (o: unknown, p: string): unknown[] => {
  const v = at(o, p)
  return Array.isArray(v) ? v : []
}

/** 一份"门级"证据的通用健康判据：存在 ∧ 有断言 ∧ 零失败 ∧ 量具有效 */
function gateHealthy(rel: string, r: ReadResult): { ok: boolean; detail: string } {
  if (!r.present) return { ok: false, detail: `${rel} 不存在 → not-run（**不是** PASS）` }
  if (!r.json) return { ok: false, detail: `${rel} 不是合法 JSON` }
  const p = num(r.json, 'passed')
  const f = num(r.json, 'failed')
  const mi = num(r.json, 'measurementInvalid')
  const v = str(r.json, 'verdict')
  const ok = (v === 'PASS' || v === null) && p !== null && p > 0 && f === 0 && (mi === null || mi === 0)
  return { ok, detail: `verdict=${String(v)} · passed=${String(p)} · failed=${String(f)} · measurementInvalid=${String(mi)}` }
}

const R = {
  wp3: readEvidence('artifacts/m5.1.1/wp3-backfill.json'),
  wp31: readEvidence('artifacts/m5.1.1/wp3.1-backfill.json'),
  wp32: readEvidence('artifacts/m5.1.1/wp3.2-recorded-axisb.json'),
  k20: readEvidence('artifacts/m5.1.1/wp3-k20-anti-fabrication.json'),
  migration: readEvidence('artifacts/m5.1.1/wp4.1-migration-verify.json'),
  prodcopy: readEvidence('artifacts/m5.1.1/wp9b1-production-copy-v9.json'),
  k16: readEvidence('artifacts/m5.1.1/wp2.1-k16-overlap-audit.json'),
  k17: readEvidence('artifacts/m5.1.1/wp2.2-k17-consumer-impact.json'),
  wp4: readEvidence('artifacts/m5.1.1/wp4.1-wp4-write-path.json'),
  wp4att: readEvidence('artifacts/m5.1.1/wp4.1-wp4-attestation.json'),
  wp41: readEvidence('artifacts/m5.1.1/wp4.1-k22-action-axis-b.json'),
  k25: readEvidence('artifacts/m5.1.1/wp4-k25-trusted-attestation.json'),
  wp5: readEvidence('artifacts/m5.1.1/wp5-action-attribution.json'),
  wp51: readEvidence('artifacts/m5.1.1/wp5.1-k27-causal-initiator.json'),
  wp6: readEvidence('artifacts/m5.1.1/wp6-recorded-read-path.json'),
  wp6replay: readEvidence('artifacts/m5.1.1/wp6-replay.json'),
  wp61: readEvidence('artifacts/m5.1.1/wp6.1-conversation-ingress.json'),
  wp9: readEvidence('artifacts/m5.1.1/wp9-e2e.json'),
  wp8inv: readEvidence('artifacts/m5.1.1/wp8-invariants.json'),
  wp8mut: readEvidence('artifacts/m5.1.1/wp8-mutations.json'),
  wp8c3: readEvidence('artifacts/m5.1.1/wp8c3-final-requalification.json'),
  gates: readEvidence('artifacts/m5.1.1/gate-results.json'),
  wp10: readEvidence('artifacts/m5.1.1/wp10-regression.json'),
  wp10pc: readEvidence('artifacts/m5.1.1/wp10-production-copy.json'),
}
const evidenceFiles = Object.keys(R).length

/* ---------------------------------------------------------------------------
 * ADR-043 的**两个**来源（2026-09-19 用户批准后新增；`W11-G6`）
 *   · 规范位置：`docs/adr/ADR-043-epistemic-requalification.md`（批准后 `ACCEPTED / DESIGN FROZEN`）
 *   · 原草案  ：`docs/m5.1.1/M5.1.1-ADR-043-Epistemic-Requalification-Draft.md`（应标 SUPERSEDED）
 * 本门**不再把 `DRAFT / NOT APPROVED` 写死** —— 那样在批准之后会变成一句假话。
 * 改为：**读规范位置的 ADR 状态行**，由它**推导** `Phase 4` 的闸应当显示什么。
 * ------------------------------------------------------------------------- */
const ADR_043_CANONICAL_ABS = join(ROOT, 'docs', 'adr', 'ADR-043-epistemic-requalification.md')
const adrCanonicalText = existsSync(ADR_043_CANONICAL_ABS) ? readFileSync(ADR_043_CANONICAL_ABS, 'utf8') : ''
const adrDraftText = existsSync(ADR_043) ? readFileSync(ADR_043, 'utf8') : ''
const adrStatusLineOf = (text: string): string => (text.split('\n').find((l) => /^\s*状态\s*:/.test(l)) ?? '(未找到状态行)').trim()
const adrCanonicalStatusLine = adrStatusLineOf(adrCanonicalText)
const adrDraftStatusLine = adrStatusLineOf(adrDraftText)
/** `ACCEPTED` ∧ 不含 `DRAFT` ⇒ 已批准。**推导**，不是声明 */
const adrApproved = /ACCEPTED/.test(adrCanonicalStatusLine) && !/DRAFT/.test(adrCanonicalStatusLine)
/** `Phase 4` 的闸应当显示的那一行（报告 §11 必须与它**逐字相同**） */
const phase4Gate = adrApproved ? 'ADR-043 已批准' : 'BLOCKED BY ADR-043'
measure('ADR-043 的读数源数', 2, true)

// ===========================================================================
section('§0 前置：干净树 + 冻结面 == immutable 标签')
// ===========================================================================

const porcelainTracked = porcelainPaths(git('status', '--porcelain', '--untracked-files=no'))
/**
 * **自己声明的写入面从"干净树"判据里排除**（与 `wp10a` 的处置同型）：
 * 本门的三份产物在第一次提交之后就变成**被跟踪**文件 ⇒ 再跑一次就会让 `git status` 变脏。
 * 排除它们**不是**清洁度例外：任何**别人**的改动仍然会红。
 */
const trackedModified = porcelainTracked.filter((p) => !SELF_WRITE.includes(p))
const allPorcelainPaths = porcelainPaths(git('status', '--porcelain'))
const untrackedPaths = allPorcelainPaths.filter((p) => !SELF_WRITE.includes(p) && git('status', '--porcelain', '--', p).startsWith('?? '))
check(
  '前置：Git 工作树干净（除本门自己声明的**五份本 WP 产物**之外，没有被跟踪文件的改动、没有别人的未跟踪文件）',
  trackedModified.length === 0 && untrackedPaths.length === 0,
  trackedModified.join(' ; ') || `tracked(他人)=0 · untracked(他人)=${untrackedPaths.length}${untrackedPaths.length > 0 ? `：${untrackedPaths.join(',')}` : ''}`
)
const frozen = FROZEN_DIRS.map((dir) => ({
  dir,
  worktreeDiff: git('diff', '--name-only', FREEZE_TAG, '--', dir).split('\n').filter(Boolean).length,
  headDiff: git('diff', '--name-only', `${FREEZE_TAG}..HEAD`, '--', dir).split('\n').filter(Boolean).length,
}))
measure('冻结目录数', frozen.length)
check(
  `前置：五个冻结目录**工作树**与 \`${FREEZE_TAG}\` **零差异**`,
  frozen.every((r) => r.worktreeDiff === 0),
  frozen.map((r) => `${r.dir}:${r.worktreeDiff}`).join(' · ')
)
check(
  `前置：五个冻结目录 \`HEAD\` 与 \`${FREEZE_TAG}\` **零差异**（历史证据一字未改）`,
  frozen.every((r) => r.headDiff === 0),
  frozen.map((r) => `${r.dir}:${r.headDiff}`).join(' · ')
)
check(
  `前置：immutable 标签未动（tag object \`${FREEZE_TAG_OBJECT.slice(0, 8)}…\` → commit \`${FREEZE_TARGET_COMMIT.slice(0, 8)}…\`）`,
  git('rev-parse', FREEZE_TAG) === FREEZE_TAG_OBJECT && git('rev-list', '-n', '1', FREEZE_TAG) === FREEZE_TARGET_COMMIT,
  `${git('rev-parse', FREEZE_TAG).slice(0, 8)}… → ${git('rev-list', '-n', '1', FREEZE_TAG).slice(0, 8)}…`
)
check(
  '前置：**没有**新增文件落进冻结目录（F4 约束③）',
  git('diff', '--name-status', `${FREEZE_TAG}..HEAD`, '--', ...FROZEN_DIRS).split('\n').filter((l) => l.startsWith('A')).length === 0,
  `${git('diff', '--name-status', `${FREEZE_TAG}..HEAD`, '--', ...FROZEN_DIRS).split('\n').filter(Boolean).length} 条改动`
)

// ===========================================================================
section('§1 读数源：每份证据都存在、都是合法 JSON、都有断言')
// ===========================================================================

for (const [key, r] of Object.entries(R)) {
  check(
    `读数源 ${key}：${r.path}`,
    r.present && r.json !== null,
    r.present ? `${r.bytes} 字节 · sha ${r.sha256.slice(0, 12)}…` : '**缺失** → not-run'
  )
}
measure('读数源证据文件数', evidenceFiles)

// ===========================================================================
section('§2 Phase 1（阶段 1 = WP2 + WP3：只加列 + 历史回填）—— M1–M7 逐格')
// ===========================================================================

const w3 = R.wp3.json
measure('WP3 读数：M1–M7 的格数', Object.keys((at(w3, 'gates') ?? {}) as object).length)
for (const m of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']) {
  check(
    `★ P1：\`M5.1.1:wp3:verify\` 的 ${m.toUpperCase()} 判据 = true`,
    bool(w3, `gates.${m}.verdict`) === true,
    JSON.stringify(at(w3, `gates.${m}`)).slice(0, 180)
  )
}
check('★ P1：WP3 门本身 PASS（有断言 / 零失败 / 量具有效）', gateHealthy('wp3-backfill.json', R.wp3).ok, gateHealthy('wp3-backfill.json', R.wp3).detail)
check('★ P1：WP3.1 门 PASS（K-20 / K-23 之后的读数）', gateHealthy('wp3.1-backfill.json', R.wp31).ok, gateHealthy('wp3.1-backfill.json', R.wp31).detail)
check('★ P1：WP3.2 门 PASS（K-24 RECORDED Axis-B 可表达性）', gateHealthy('wp3.2-recorded-axisb.json', R.wp32).ok, gateHealthy('wp3.2-recorded-axisb.json', R.wp32).detail)

/** M4：四类（六项）陈旧状态计数必须**全部**为 0 */
const m4Counts = (at(w3, 'gates.m4.counts') ?? {}) as Record<string, number>
const m4Entries = Object.entries(m4Counts)
measure('M4 的陈旧状态计数据点数', m4Entries.length)
check(
  '★ P1：**M4 禁止伪造** —— 六类陈旧状态计数**全部 = 0**（逐项）',
  m4Entries.length >= 6 && m4Entries.every(([, v]) => v === 0),
  m4Entries.map(([k, v]) => `${k}=${v}`).join(' · ')
)
/** M3：逐槽位精确相等（计数精确，不是抽样） */
const m3Slots = (at(w3, 'gates.m3.perSlot') ?? {}) as Record<string, { expected: number; actual: number }>
const m3Entries = Object.entries(m3Slots)
measure('M3 的逐槽位计数据点数', m3Entries.length)
check(
  '★ P1：**M3** 逐槽位 Unknown(LEGACY_UNRECORDED) 计数**精确相等**（expected == actual）',
  m3Entries.length === 6 && m3Entries.every(([, v]) => v.expected === v.actual),
  m3Entries.map(([k, v]) => `${k}:${v.expected}/${v.actual}`).join(' · ')
)
/** M7：Axis B 完整性 + **两个分支都必须 measured_count > 0** */
const m7 = at(w3, 'gates.m7') as Record<string, unknown>
check(
  '★ P1：**M7 Axis B 完整性** —— MIGRATED_LEGACY 行上三列无 NULL、坏值 0、词表外 0、且有真实行',
  num(w3, 'gates.m7.axisBNull') === 0 &&
    num(w3, 'gates.m7.axisBBadValue') === 0 &&
    num(w3, 'gates.m7.sourceKindOutOfVocab') === 0 &&
    (num(w3, 'gates.m7.migratedLegacyRows') ?? 0) > 0,
  JSON.stringify(m7).slice(0, 220)
)
const b = R.wp32.json
check(
  '★ P1：**M7 的两分支各自 measured_count > 0**（设计集 §5 M7 明文要求）',
  bool(b, 'gates.recordedConfirmed') === true &&
    bool(b, 'gates.recordedUnconfirmed') === true &&
    (num(b, 'gates.confirmedCount') ?? 0) > 0 &&
    (num(b, 'gates.unconfirmedCount') ?? 0) > 0 &&
    arr(b, 'gates.m7Violations').length === 0,
  `confirmed=${String(num(b, 'gates.confirmedCount'))} · unconfirmed=${String(num(b, 'gates.unconfirmedCount'))} · violations=${arr(b, 'gates.m7Violations').length}`
)
check(
  '★ P1：**K-20** 反伪造门 = PASS，且 WP3.2 的三条负控全部响',
  str(R.k20.json, 'k20') === 'PASS' &&
    arr(b, 'negativeControls').length > 0 &&
    arr(b, 'negativeControls').every((n) => (n as Record<string, unknown>).detectorFired === true),
  `k20=${String(str(R.k20.json, 'k20'))} · negativeControls=${arr(b, 'negativeControls').length}`
)
/** M1：迁移只追加（无破坏性语句）；M6：restore epoch 已显式记录 */
const mig = R.migration.json
const destructive = arr(mig, 'static.destructiveStatements')
const fingerprints = arr(mig, 'static.frozenFingerprints') as { match?: boolean }[]
measure('冻结迁移指纹条目数', fingerprints.length)
check(
  '★ P1：**M1** v7/v8/v9 里没有 drop / update / delete / truncate / alter column（迁移只追加）',
  destructive.length === 0,
  `destructiveStatements = ${destructive.length}`
)
check(
  '★ P1：迁移门 PASS，且 1..9 的冻结指纹**逐条 match**',
  gateHealthy('wp4.1-migration-verify.json', R.migration).ok &&
    fingerprints.length === 9 &&
    fingerprints.every((f) => f.match === true),
  `${fingerprints.filter((f) => f.match === true).length}/${fingerprints.length} match`
)
check(
  '★ P1：**M6** restore epoch 已被**显式记录**（不是缺省）',
  str(w3, 'gates.m6.restoreEpoch') !== null,
  `restoreEpoch = ${String(str(w3, 'gates.m6.restoreEpoch'))}`
)
check(
  '★ P1：production-copy 门 PASS（副本上 v6 → v9；真实库只被复制）',
  gateHealthy('wp9b1-production-copy-v9.json', R.prodcopy).ok,
  gateHealthy('wp9b1-production-copy-v9.json', R.prodcopy).detail
)

/** M5：认知资格影响半径报告（只读） */
const radiusExists = existsSync(join(ROOT, 'docs/m5.1.1/M5.1.1-Phase4-Cognitive-Impact-Radius.md'))
const radiusText = radiusExists ? readFileSync(join(ROOT, 'docs/m5.1.1/M5.1.1-Phase4-Cognitive-Impact-Radius.md'), 'utf8') : ''
measure('影响半径报告的字节数', Buffer.byteLength(radiusText, 'utf8'))
check(
  '★ P1：**M5 认知资格影响半径报告**已产出（只读）+ WP3 的 M5 格声明 `readOnly = true`',
  radiusExists && radiusText.length > 0 && /只读/.test(radiusText) && /NOT APPROVED/.test(radiusText) && bool(w3, 'gates.m5.readOnly') === true,
  radiusExists ? `${Buffer.byteLength(radiusText, 'utf8')} 字节 · 含「只读」+「NOT APPROVED」· m5.readOnly=true` : '**缺失**'
)
const m5Counts = (at(w3, 'gates.m5.counts') ?? {}) as Record<string, unknown>
measure('影响半径的证据链条数（`measured_count > 0` 自检）', num(w3, 'gates.m5.counts.evidenceLinks') ?? 0)
check(
  '★ P1：影响半径的判据**自检过 `measured_count > 0`**（空集不算 PASS）',
  (num(w3, 'gates.m5.counts.evidenceLinks') ?? 0) > 0 && m5Counts.wouldLoseEligibility !== undefined,
  JSON.stringify(m5Counts).slice(0, 200)
)

// ===========================================================================
section('§3 Phase 2（阶段 2 = WP4：并存记录）—— G-AT-1/2/3/4')
// ===========================================================================

const w4 = R.wp4.json
const scenarios = arr(w4, 'scenarios') as Record<string, unknown>[]
measure('WP4 的场景数（G-AT-1/2/3 的载体）', scenarios.length)
check(
  '★ P2：WP4 写路径门 PASS（有断言 / 零失败 / 量具有效）',
  gateHealthy('wp4.1-wp4-write-path.json', R.wp4).ok,
  gateHealthy('wp4.1-wp4-write-path.json', R.wp4).detail
)
check(
  '★ P2：**G-AT-1/2/3** —— 每个场景的三段（写 / 库 / 回读）**逐槽位一致**且 Axis B 一致',
  scenarios.length > 0 &&
    scenarios.every((s) => {
      const slots = s.slots as Record<string, Record<string, string>> | undefined
      const same = slots ? slots.write && slots.db && slots.readback && JSON.stringify(slots.write) === JSON.stringify(slots.db) && JSON.stringify(slots.db) === JSON.stringify(slots.readback) : false
      return same && Array.isArray(s.slotMismatches) && s.slotMismatches.length === 0 && Array.isArray(s.axisBMismatches) && s.axisBMismatches.length === 0 && s.branch === s.expectedBranch
    }),
  `${scenarios.length} 个场景 · 每场景三段逐槽位一致 + 0 mismatch`
)
/** G-AT-4：不可信调用方不能自报三类字段 */
const inj = at(w4, 'attestation.callerInjection') as Record<string, unknown>
measure('G-AT-4 被测试的不可信 payload 字段数', arr(w4, 'attestation.untrustedPayloadFieldsTested').length)
check(
  '★ P2：**G-AT-4 Attestation Boundary** —— 正控安静（`positiveQuiet`）',
  bool(w4, 'attestation.positiveQuiet') === true,
  `positiveQuiet=${String(bool(w4, 'attestation.positiveQuiet'))}`
)
check(
  '★ P2：**G-AT-4** —— 调用方自报被拒且**零残留行**（真实错误码）',
  inj.rejectedCode === 'untrusted_attribution_context' && inj.residueRows === 0,
  `rejectedCode=${String(inj.rejectedCode)} · residueRows=${String(inj.residueRows)}`
)
check(
  '★ P2：**G-AT-4** —— 负控真的响（payload 拒绝数 > 0）+ 变异被检出 + 恢复段成立',
  (num(w4, 'attestation.payloadRejections') ?? 0) > 0 &&
    bool(w4, 'attestation.mutation.trustedContextMutationDetected') === true &&
    bool(w4, 'attestation.restoreOk') === true,
  `payloadRejections=${String(num(w4, 'attestation.payloadRejections'))} · mutationDetected=${String(bool(w4, 'attestation.mutation.trustedContextMutationDetected'))} · restoreOk=${String(bool(w4, 'attestation.restoreOk'))}`
)
/** K-25：受信鉴证与 actor/contentOriginator 解耦 —— S2' 的反假阳性对照在这里 */
const k25 = R.k25.json
const legal = arr(k25, 'legalReadings') as Record<string, unknown>[]
check(
  '★ P2：**K-25** 门 PASS（受信鉴证与两个 principal 解耦）',
  gateHealthy('wp4-k25-trusted-attestation.json', R.k25).ok && str(k25, 'k25') === 'PASS',
  `${gateHealthy('wp4-k25-trusted-attestation.json', R.k25).detail} · k25=${String(str(k25, 'k25'))}`
)
check(
  "★ P2：**S2'（合法相等必须通过）** —— 合法的「两个 principal 相同」读数**存在且 match**，未被当成假阳性拒掉",
  legal.length > 0 && legal.some((l) => l.distinct === false && l.match === true),
  `${legal.length} 条合法读数 · 其中 distinct=false（合法相等）= ${legal.filter((l) => l.distinct === false).length} 条`
)
check(
  '★ P2：K-25 的负控逐条 `holds = true`',
  arr(k25, 'negatives').length > 0 && arr(k25, 'negatives').every((n) => (n as Record<string, unknown>).holds === true),
  `${arr(k25, 'negatives').length} 条负控`
)
/** WP4.1：K-22 行动轴 B 不适用 + v8 */
const w41 = R.wp41.json
check(
  '★ P2：WP4.1 门 PASS（K-22 行动账本 Axis B = NOT_APPLICABLE 的物理落地）',
  gateHealthy('wp4.1-k22-action-axis-b.json', R.wp41).ok && bool(w41, 'v8Required') === true,
  `${gateHealthy('wp4.1-k22-action-axis-b.json', R.wp41).detail} · v8Required=${String(bool(w41, 'v8Required'))}`
)
check(
  '★ P2：WP4.1 正控 + 负控都在，且负控**契约检测器响 ∧ DB 拒绝 ∧ 零残留**',
  arr(w41, 'positiveControls').length > 0 &&
    arr(w41, 'negativeControls').length > 0 &&
    arr(w41, 'negativeControls').every((n) => {
      const x = n as Record<string, unknown>
      return x.contractDetectorFired === true && x.dbRejected === true && x.residueRows === 0
    }),
  `正控 ${arr(w41, 'positiveControls').length} · 负控 ${arr(w41, 'negativeControls').length}`
)
// ===========================================================================
section('§4 Phase 3（阶段 3 = WP5 写侧 + WP6 读侧）—— R1–R6 / S1–S6 / K-27 / K-28')
// ===========================================================================

const w5 = R.wp5.json
measure('WP5 的 action/execution 阶梯事件数', arr(w5, 'stages').length)
check(
  '★ P3：WP5 门 PASS（行动 + 执行归因，阶梯逐级）',
  gateHealthy('wp5-action-attribution.json', R.wp5).ok,
  gateHealthy('wp5-action-attribution.json', R.wp5).detail
)
check(
  '★ P3：WP5 的十个负控**全部响** + 恢复段成立 + 结构克隆被拒',
  (num(w5, 'negatives.fired') ?? 0) > 0 && bool(w5, 'negatives.restoreOk') === true && arr(w5, 'negatives.cloneProbes').length > 0,
  `fired=${String(num(w5, 'negatives.fired'))} · restoreOk=${String(bool(w5, 'negatives.restoreOk'))} · cloneProbes=${arr(w5, 'negatives.cloneProbes').length}`
)
check(
  '★ P3：**Execution Truth 与归因不互相冒充**（Known executor ⇏ executed；Axis B 不污染执行真相）',
  bool(w5, 'executionTruthFirewall.knownExecutorImpliesExecuted') === false &&
    bool(w5, 'executionTruthFirewall.knownAuthorityImpliesAccepted') === false &&
    num(w5, 'executionTruthFirewall.recordedRowsWithAxisB') === 0,
  JSON.stringify(at(w5, 'executionTruthFirewall')).slice(0, 200)
)
const w51 = R.wp51.json
check(
  '★ P3：**K-27 CLOSED** —— 行动 initiator 的因果闭包（人类正控 + 七条负控 + 恢复）',
  str(w51, 'k27') === 'CLOSED' &&
    (str(w51, 'humanPositive.actionInitiator') ?? '').startsWith('KNOWN|USER') &&
    (num(w51, 'negatives.fired') ?? 0) > 0 &&
    str(w51, 'restore.actionInitiator') === str(w51, 'humanPositive.actionInitiator'),
  `k27=${String(str(w51, 'k27'))} · human=${String(str(w51, 'humanPositive.actionInitiator'))} · fired=${String(num(w51, 'negatives.fired'))} · restore=${String(str(w51, 'restore.actionInitiator'))}`
)
/** R1–R6：重放不改归因、不洗白 Unknown */
const rp = at(R.wp6replay.json, 'replay') as Record<string, unknown>
check(
  '★ P3：WP6 门 PASS（读侧改读**已记录的值**）',
  gateHealthy('wp6-recorded-read-path.json', R.wp6).ok,
  gateHealthy('wp6-recorded-read-path.json', R.wp6).detail
)
measure('R1–R6 的判据数', Object.keys(rp ?? {}).filter((k) => /^r\d/.test(k)).length)
check(
  '★ P3：**R1–R6 全绿**（不二次存储 / 槽位==物理列 / legacy 稳定 / 相等仍相等 / **Unknown 不被洗白** / 三态仍可区分）',
  bool(R.wp6replay.json, 'replay.r2ActionSlotsMatchColumns') === true &&
    bool(R.wp6replay.json, 'replay.r3MigratedStable') === true &&
    bool(R.wp6replay.json, 'replay.r4EqualStaysEqual') === true &&
    bool(R.wp6replay.json, 'replay.r5UnknownStaysUnknown') === true &&
    bool(R.wp6replay.json, 'replay.r6ThreeStatesDistinct') === true &&
    arr(R.wp6replay.json, 'replay.r1NoSecondStorage').length > 0,
  `r2=${String(bool(R.wp6replay.json, 'replay.r2ActionSlotsMatchColumns'))} · r3=${String(bool(R.wp6replay.json, 'replay.r3MigratedStable'))} · r4=${String(bool(R.wp6replay.json, 'replay.r4EqualStaysEqual'))} · r5=${String(bool(R.wp6replay.json, 'replay.r5UnknownStaysUnknown'))} · r6=${String(bool(R.wp6replay.json, 'replay.r6ThreeStatesDistinct'))}`
)
check(
  '★ P3：**K-28 CLOSED** —— 生产对话 ingress 真的构造受信归因（WP6.1，115/0）',
  gateHealthy('wp6.1-conversation-ingress.json', R.wp61).ok,
  gateHealthy('wp6.1-conversation-ingress.json', R.wp61).detail
)
/** 七个 mutation */
const muts = arr(R.wp8mut.json, 'mutations') as Record<string, unknown>[]
measure('WP8 的 mutation 锚数', num(R.wp8mut.json, 'count') ?? 0)
check(
  '★ P3（退出条件③）：**七个 mutation 全部响过**，且各自带恢复段',
  num(R.wp8mut.json, 'count') === 7 && muts.length === 7 && muts.every((m) => m.ok === true),
  `${muts.filter((m) => m.ok === true).length}/${muts.length} 成立`
)
/** S1–S6 + E→S 映射 */
const w9 = R.wp9.json
const eToS = (at(w9, 'eToS') ?? {}) as Record<string, string[]>
const coveredS = new Set(Object.values(eToS).flat())
measure('E→S 映射覆盖到的 S 类数', coveredS.size)
check(
  '★ P3（退出条件②）：**S1–S6 六类全部被映射到**，且每个 E 都有真实运行时读数',
  ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].every((s) => coveredS.has(s)) && bool(w9, 'fieldwise.equal') === true,
  `covered=${[...coveredS].sort().join(',')} · fieldwise.equal=${String(bool(w9, 'fieldwise.equal'))}`
)
const corr = arr(w9, 'correlations') as Record<string, unknown>[]
check(
  '★ P3：WP9 的八条 L1↔L2 关联**全部 agree**（真实 id 机器关联，不是人写的表）',
  corr.length === 8 && corr.every((c) => c.agree === true),
  `${corr.filter((c) => c.agree === true).length}/${corr.length}`
)
check(
  '★ P3：WP9 **blocking gaps = 0**（canonical 场景无阻塞缺口）',
  arr(w9, 'blockingGaps').length === 0,
  `blockingGaps = ${arr(w9, 'blockingGaps').length}`
)
const dc = arr(w9, 'deferredCapabilities') as Record<string, unknown>[]
measure('被如实登记的 deferred capability 数', dc.length)
check(
  '★ P3：三项**能力缺口仍如实登记为 `NOT IMPLEMENTED / DEFERRED`**（未被改成 CLOSED，也未被删掉）',
  dc.length === 3 && dc.every((d) => d.status === 'NOT IMPLEMENTED / DEFERRED'),
  dc.map((d) => `${String(d.id)}=${String(d.status)}`).join(' · ')
)
check(
  '★ P3：WP8 不变量（INV-1..10 / CE-D01 / CE-K27）**全部成立**',
  arr(R.wp8inv.json, 'claims').length >= 12 && arr(R.wp8inv.json, 'claims').every((c) => (c as Record<string, unknown>).ok !== false),
  `${arr(R.wp8inv.json, 'claims').length} 条 claim`
)

// ===========================================================================
section('§5 十个退出条件（Master-Plan §3 逐条）')
// ===========================================================================

const gatesJson = R.gates.json
const gateRows = arr(gatesJson, 'gates') as { id: string; verdict: string }[]
const ver = (id: string): string => gateRows.find((g) => g.id === id)?.verdict ?? 'MISSING'
measure('M5.1.1 九门读数条数', gateRows.length)
const exitConditions = [
  { id: 'EC-1', scope: 'phase1-3', text: 'G-AT-1/2/3/4 全绿，各带正控 + 负控', ok: bool(w4, 'attestation.positiveQuiet') === true && (num(w4, 'attestation.payloadRejections') ?? 0) > 0 && arr(R.wp41.json, 'negativeControls').length > 0, detail: 'G-AT-1/2/3 = WP4 三段一致 · G-AT-4 = 正控安静 + 9 条 payload 拒绝' },
  { id: 'EC-2', scope: 'phase1-3', text: 'S1–S6 按语义维度可区分；S2′ 必须通过', ok: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].every((s) => coveredS.has(s)) && legal.some((l) => l.distinct === false && l.match === true), detail: `covered=${[...coveredS].sort().join(',')} · S2′ 合法相等读数存在` },
  { id: 'EC-3', scope: 'phase1-3', text: '七个 mutation 全部会响、恢复后重新安静', ok: num(R.wp8mut.json, 'count') === 7 && muts.every((m) => m.ok === true), detail: `${muts.length}/7` },
  { id: 'EC-4', scope: 'phase1-3', text: 'R1–R6 全绿（重放不改归因、不洗白 Unknown）', ok: bool(R.wp6replay.json, 'replay.r5UnknownStaysUnknown') === true && bool(R.wp6replay.json, 'replay.r6ThreeStatesDistinct') === true && bool(R.wp6replay.json, 'replay.r2ActionSlotsMatchColumns') === true, detail: 'r1–r6 逐条' },
  { id: 'EC-5', scope: 'phase1-3', text: 'M1–M7 全绿；M4 陈旧状态计数全 0；M7 Axis B 完整性成立', ok: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].every((m) => bool(w3, `gates.${m}.verdict`) === true) && m4Entries.every(([, v]) => v === 0) && num(w3, 'gates.m7.axisBNull') === 0 && (num(b, 'gates.confirmedCount') ?? 0) > 0 && (num(b, 'gates.unconfirmedCount') ?? 0) > 0, detail: `M1–M7 = 7/7 · M4 = ${m4Entries.length} 项全 0 · M7 两分支 ${String(num(b, 'gates.confirmedCount'))}/${String(num(b, 'gates.unconfirmedCount'))}` },
  { id: 'EC-6', scope: 'phase1-3', text: 'M511-G9 旧 Gate 兼容性成立（F4 四条约束）', ok: ver('M511-G9') === 'PASS', detail: `M511-G9 = ${ver('M511-G9')}` },
  { id: 'EC-7', scope: 'phase1-3', text: '认知资格影响半径报告已产出（只读）并交用户看过', ok: radiusExists && radiusText.length > 0 && bool(w3, 'gates.m5.readOnly') === true, detail: `${Buffer.byteLength(radiusText, 'utf8')} 字节 · readOnly=true（**"已交用户看过"是人类动作，本门只能证明报告存在且只读**）` },
  { id: 'EC-8', scope: 'phase4', text: 'ADR-043 已批准（**WP11 时点**的读数）', ok: false, detail: '**当时未达成** —— 当时的 ADR-043 草案状态行 = `DRAFT / NOT APPROVED`。这是 Phase 4 的前置，**不是阶段 1–3 的阻断项**（Master-Plan §3 逐字）。→ 当前读数见 EC-8b' },
  { id: 'EC-8b', scope: 'current', text: 'ADR-043 已批准（**当前**，由规范位置的 ADR 状态行**推导**）', ok: adrApproved, detail: `规范位置 \`docs/adr/ADR-043-epistemic-requalification.md\` 的状态行 = \`${adrCanonicalStatusLine}\` ⇒ adrApproved = ${String(adrApproved)}` },
  { id: 'EC-9', scope: 'phase1-3', text: '全量回归零退化（m4.5:ci / m5:* / m5.1:*）', ok: str(R.wp10.json, 'verdict') === 'PASS' && num(R.wp10.json, 'm45CiRun.exit') === 0 && str(R.wp10.json, 'freshCi.regressionVerdict') === 'PASS' && str(R.wp10.json, 'liveSmoke.status') === 'NOT RUN', detail: `wp10 verdict=${String(str(R.wp10.json, 'verdict'))} · m4.5:ci exit=${String(num(R.wp10.json, 'm45CiRun.exit'))} · regression=${String(str(R.wp10.json, 'freshCi.regressionVerdict'))} · liveSmoke=${String(str(R.wp10.json, 'liveSmoke.status'))}` },
  {
    id: 'EC-10',
    scope: 'delegated',
    text: '只有到这时，M5.1-D01 才可以从 OPEN 改为 CLOSED',
    /** **WP11 时点**的读数：不适用 / 禁止（Master-Plan §3 第 10 行逐字） */
    historicalOk: false,
    /** **当前**状态由谁判定（WP-C3：职责移交，本门不再断言它的值） */
    delegatedTo: 'scripts/verify-m5.1.1-phase4-closure.ts',
    detail:
      '**WP11 时点**这一条**不适用**（Master-Plan §3 第 10 行：本里程碑内**不会**发生；`DR-12` 要求 4a + 4b + Live Smoke 观察 + 用户批准）。' +
      '**自 Phase 4 关闭起，它的当前状态由关闭门 `pnpm m5.1.1:phase4:closure:verify` 判定** —— 本门只登记"当时未达成"这一历史事实。',
  },
] as const
for (const ec of exitConditions) {
  if (ec.scope === 'phase1-3') {
    check(`★ 退出条件 ${ec.id}（阶段 1–3）：${ec.text}`, ec.ok, ec.detail)
  } else if (ec.scope === 'current') {
    check(`★ 退出条件 ${ec.id}（**当前**，由 ADR 状态推导）：${ec.text}`, ec.ok === true, ec.detail)
  } else if (ec.scope === 'delegated') {
    const delegateAbs = join(ROOT, ec.delegatedTo)
    check(
      `★ 退出条件 ${ec.id}（**Phase 4 / D01 专属**）：当前状态**已委派**给 \`${ec.delegatedTo}\``,
      ec.historicalOk === false && existsSync(delegateAbs),
      `WP11 时点 = 未达成（历史事实）· 关闭门存在 = ${String(existsSync(delegateAbs))}`,
    )
  } else {
    check(`★ 退出条件 ${ec.id}（**Phase 4 / D01 专属**，阶段 1–3 的判定**不**依赖它）：${ec.text} → 维持 **未达成 / 禁止**`, ec.ok === false, ec.detail)
  }
}
const ec13 = exitConditions.filter((e) => e.scope === 'phase1-3')
const ec13Ok = ec13.filter((e) => e.ok).length
measure('阶段 1–3 的退出条件达成数', ec13Ok)
check(
  `★ 阶段 1–3 的退出条件**逐条**达成（${ec13.length} 条，其中 EC-7 的"已交用户看过"是人类动作）`,
  ec13.every((e) => e.ok),
  ec13.map((e) => `${e.id}=${e.ok ? '✅' : '❌'}`).join(' ')
)

// ===========================================================================
section('§6 报告：六行状态**必须等于本门算出来的值** + canonical 禁令的三段式检测器')
// ===========================================================================

const reportExists = existsSync(REPORT)
const reportText = reportExists ? readFileSync(REPORT, 'utf8') : ''
const gdExists = existsSync(GATE_DECISION)
const gdText = gdExists ? readFileSync(GATE_DECISION, 'utf8') : ''

/** Phase 1/2/3 的状态 = **算出来的**（§2–§4 的同一条判据线） */
const phase1Ok =
  ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].every((m) => bool(w3, `gates.${m}.verdict`) === true) &&
  gateHealthy('wp3-backfill.json', R.wp3).ok &&
  gateHealthy('wp3.1-backfill.json', R.wp31).ok &&
  gateHealthy('wp3.2-recorded-axisb.json', R.wp32).ok &&
  gateHealthy('wp4.1-migration-verify.json', R.migration).ok &&
  gateHealthy('wp9b1-production-copy-v9.json', R.prodcopy).ok &&
  m4Entries.length >= 6 &&
  m4Entries.every(([, v]) => v === 0) &&
  m3Entries.length === 6 &&
  m3Entries.every(([, v]) => v.expected === v.actual) &&
  num(w3, 'gates.m7.axisBNull') === 0 &&
  radiusExists
const phase2Ok =
  gateHealthy('wp4.1-wp4-write-path.json', R.wp4).ok &&
  gateHealthy('wp4.1-k22-action-axis-b.json', R.wp41).ok &&
  gateHealthy('wp4-k25-trusted-attestation.json', R.k25).ok &&
  scenarios.length > 0 &&
  scenarios.every((s) => Array.isArray(s.slotMismatches) && s.slotMismatches.length === 0 && s.branch === s.expectedBranch) &&
  bool(w4, 'attestation.positiveQuiet') === true &&
  (num(w4, 'attestation.payloadRejections') ?? 0) > 0
const phase3Ok =
  gateHealthy('wp5-action-attribution.json', R.wp5).ok &&
  gateHealthy('wp5.1-k27-causal-initiator.json', R.wp51).ok &&
  gateHealthy('wp6-recorded-read-path.json', R.wp6).ok &&
  gateHealthy('wp6.1-conversation-ingress.json', R.wp61).ok &&
  str(R.wp9.json, 'verdict') === 'PASS' &&
  arr(w9, 'blockingGaps').length === 0 &&
  dc.length === 3 &&
  bool(R.wp6replay.json, 'replay.r5UnknownStaysUnknown') === true &&
  num(R.wp8mut.json, 'count') === 7
const computed = {
  'Phase 1': phase1Ok ? 'PASS' : 'FAIL',
  'Phase 2': phase2Ok ? 'PASS' : 'FAIL',
  'Phase 3': phase3Ok ? 'PASS' : 'FAIL',
  'Phase 4': 'BLOCKED BY ADR-043',
  'M5.1.1 Final': 'BLOCKED',
  'M5.1-D01': 'P1 OPEN',
} as const
console.log('  · 本门**算出来**的六行状态：')
for (const [k, v] of Object.entries(computed)) console.log(`      ${k.padEnd(14)} ${v}`)

/**
 * 从报告里解析状态行。
 *
 * `which`：`first` = **WP11 时点**的那一块（§0 的六行）；`last` = **当前**那一块（§11 的追加块）。
 *
 * ⚠️ 两组模式都**刻意收紧到允许值**，否则 `Phase 4 · 闸  ADR-043 已批准` 这类
 * 「标签里含 `Phase 4`」的行会被误当成 `Phase 4` 的值 —— 那正是本仓库
 * "数字对 ≠ 数字描述的是你以为的那个东西" 的同型风险（AGENTS §6.2）。
 */
const STATUS_PATTERNS = {
  'Phase 1': /^\s*Phase\s+1\s+(PASS|FAIL)\s*$/m,
  'Phase 2': /^\s*Phase\s+2\s+(PASS|FAIL)\s*$/m,
  'Phase 3': /^\s*Phase\s+3\s+(PASS|FAIL)\s*$/m,
  'Phase 4': /^\s*Phase\s+4\s+(PASS|FAIL|NOT RUN|BLOCKED BY ADR-043)\s*$/m,
  'M5.1.1 Final': /^\s*M5\.1\.1\s+Final\s+(BLOCKED|PASS|FAIL)\s*$/m,
  'M5.1-D01': /^\s*M5\.1-D01\s+(P1 OPEN|CLOSED)\s*$/m,
} as const
function statusLines(text: string, which: 'first' | 'last'): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const [key, re] of Object.entries(STATUS_PATTERNS)) {
    const all = [...text.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))]
    out[key] = all.length === 0 ? null : all[which === 'first' ? 0 : all.length - 1][1].trim()
  }
  return out
}
check('★ 报告存在：`docs/m5.1.1/M5.1.1-Phase1-3-Acceptance-Report.md`', reportExists && reportText.length > 0, reportExists ? `${Buffer.byteLength(reportText, 'utf8')} 字节` : '**缺失** → not-run（**不是** PASS）')
check('★ `M5.1.1-Gate-Decision.md` 存在（R-9）且含「不主张」小节', gdExists && /不主张/.test(gdText), gdExists ? `${Buffer.byteLength(gdText, 'utf8')} 字节` : '**缺失**')
const reported = statusLines(reportText, 'first')
for (const key of Object.keys(computed) as (keyof typeof computed)[]) {
  check(
    `★ 报告 **§0 历史块**里的 \`${key}\` = **本门算出来的值**（\`${computed[key]}\`）`,
    reported[key] === computed[key],
    `报告写的是 ${JSON.stringify(reported[key])}`
  )
}
check(
  '★ 报告里 **Phase 4 只能是 `BLOCKED BY ADR-043`**（不得写成 PASS / FAIL）',
  reported['Phase 4'] === 'BLOCKED BY ADR-043',
  `Phase 4 = ${JSON.stringify(reported['Phase 4'])}`
)
check(
  '★ 报告里 **`M5.1.1 Final` 只能是 `BLOCKED`**（不得写成 PASS）',
  reported['M5.1.1 Final'] === 'BLOCKED',
  `M5.1.1 Final = ${JSON.stringify(reported['M5.1.1 Final'])}`
)
check(
  '★ 报告里 **`M5.1-D01` 只能是 `P1 OPEN`**（不得写成 CLOSED）',
  reported['M5.1-D01'] === 'P1 OPEN',
  `M5.1-D01 = ${JSON.stringify(reported['M5.1-D01'])}`
)

/* ---- §11 当前块：**职责已收窄**（WP-C3 / ADR-044） ----
 *
 * ⚠️ 这里**曾经**断言"当前状态"的值（`Phase 4 = NOT RUN` · `M5.1-D01 = P1 OPEN` · `M5.1.1 Final = BLOCKED`）。
 *    自 Phase 4 关闭起，那一条职责**已移交** `scripts/verify-m5.1.1-phase4-closure.ts`
 *    （`pnpm m5.1.1:phase4:closure:verify` / `pnpm m5.1.1:final:verify`）。
 *
 * 本门**保留**的是它作为 **Phase 1–3 历史门** 的职责：
 *   · §0 的历史六行（`ST-4/5/6`，上面已断言）
 *   · §11 里 **Phase 1/2/3** 的值仍必须与算出来的值一致（那是阶段 1–3 的事实）
 *   · §11 **存在**（当前状态的权威块必须可被定位）
 *   · **移交已声明**（ADR-044 写着当前状态由关闭门判定）
 *
 * 它**不再**做的事（刻意）：断言 §11 的 `Phase 4` / `M5.1-D01` / `M5.1.1 Final` 取什么值 ——
 * 那正是"旧状态锁"，继续留在历史门里会让关闭后的合法状态把历史门判红。
 */
const reportedCurrent = statusLines(reportText, 'last')
const gateLineMatch = /^\s*Phase\s+4\s*·\s*闸\s+(.+?)\s*$/m.exec(reportText)
const reportedGate = gateLineMatch ? gateLineMatch[1].trim() : null
console.log(`  · 报告 §11 当前块读数（**只登记，不再断言**）：${JSON.stringify(reportedCurrent)} · 闸 = ${JSON.stringify(reportedGate)}`)
const appendixExists = (['Phase 1', 'Phase 2', 'Phase 3'] as const).every((key) => reportedCurrent[key] !== null)
check('★ **§11 当前块存在**（当前状态的权威块必须可被定位，内容由关闭门判定）', appendixExists, `§11 = ${JSON.stringify(reportedCurrent)}`)
for (const key of ['Phase 1', 'Phase 2', 'Phase 3'] as const) {
  check(
    `★ **§11 当前块**的 \`${key}\` = \`${computed[key]}\`（阶段 1–3 的事实不变；其余取值由关闭门判定）`,
    reportedCurrent[key] === computed[key],
    `§11 写的是 ${JSON.stringify(reportedCurrent[key])}`
  )
}
const CLOSURE_GATE_SCRIPT = 'scripts/verify-m5.1.1-phase4-closure.ts'
const CLOSURE_ADR = 'docs/adr/ADR-044-m5.1.1-phase4-closure.md'
const closureAdrText = existsSync(join(ROOT, CLOSURE_ADR)) ? readFileSync(join(ROOT, CLOSURE_ADR), 'utf8') : ''
check(
  '★ **职责移交已声明**：ADR-044 存在，且写明"当前状态由 Phase 4 关闭门判定"',
  closureAdrText.length > 0 && closureAdrText.includes('m5.1.1:phase4:closure:verify'),
  closureAdrText.length > 0 ? CLOSURE_ADR : '**缺失**'
)
/*
 * ⚠️ 这里**不**自我扫描"本文件里没有某某断言" —— 那种检查会因为**检查语句自己**
 *    含有那个字面量而假红（同族的自我指涉在关闭门里也撞到过两次）。
 *    "WP11 没有做当前状态的正向断言"由**关闭门从外部**核对（它读本文件的源码）。
 */
check(
  '★ 本门仍是 **Phase 1–3 历史门**（不是关闭门）：关闭门存在，且本文件已声明委派',
  existsSync(join(ROOT, CLOSURE_GATE_SCRIPT)),
  '职责边界：历史（本门）↔ 当前（关闭门）'
)

/**
 * ADR-043 的**事实依据**（`W11-G6` 改写了这一条）：
 * 不再把 `DRAFT / NOT APPROVED` 写死（批准之后那是假话），而是
 * 读**规范位置**的 ADR 状态行 → 推导 `Phase 4` 的闸应当是什么 → 与报告 §11 对齐。
 * 同时要求**原草案**已被标 SUPERSEDED，防止"两份都还活着"的两套方言。
 */
check(
  '★ ADR-043 的**规范位置**存在且状态行 = `ACCEPTED / DESIGN FROZEN`（`Phase 4` 的闸由它推导）',
  existsSync(ADR_043_CANONICAL_ABS) && /ACCEPTED \/ DESIGN FROZEN/.test(adrCanonicalStatusLine),
  `docs/adr/ADR-043-epistemic-requalification.md → ${adrCanonicalStatusLine || '**文件缺失**'}`
)
check(
  '★ ADR-043 的**原草案**已被标 `SUPERSEDED`（避免同一概念两处权威 —— 仓库明令禁止两套方言）',
  /SUPERSEDED/.test(adrDraftStatusLine),
  `草案 → ${adrDraftStatusLine || '**文件缺失**'}`
)
const adrText = adrDraftText
check(
  '★ `Phase 4 = BLOCKED BY ADR-043` 的**事实依据（历史）**：WP11 时点的 ADR-043 是 `DRAFT / NOT APPROVED`（该判断已由本门改为**从状态推导**，见上两条）',
  /DRAFT/.test(adrDraftStatusLine) || /SUPERSEDED/.test(adrDraftStatusLine),
  `草案状态行 = ${adrDraftStatusLine}`
)

/* ---- canonical 禁令的检测器（**同一个函数**走三段式） ---- */
const FORBIDDEN_CLAIMS = [
  'M5.1.1 PASS',
  'M5.1.1 Final = PASS',
  'M5.1.1 Final: PASS',
  'M5.1.1 Final PASS',
  'D01 CLOSED',
  'D01 已关闭',
  'D01 已全部关闭',
  'M5.1-D01 = CLOSED',
  'M5.1-D01 已关闭',
  '苏沐薇已经具备后台自主运行能力',
] as const
/** 明确的**禁止语**上下文标记：出现这些词的行 / 代码块的引导行 = 允许**引用**禁止的说法 */
const PROHIBITION_MARKERS = /不得|禁止|不主张|forbidden|FORBIDDEN|not allowed|NOT ALLOWED/
/**
 * **描述**上下文标记（**只对过程性文档**生效，见下）：
 * 这些行不是在断言，而是在**描述"什么是被禁止的"**本身
 * （例如"把阶段 1–3 全绿**偷换成** `M5.1.1 Final = PASS`"、负控名"**裸的** `D01 CLOSED` 行"）。
 * 判定文档**不**接受这一条 —— 它们只接受 `prohibition` 与 `quoted-fence` 两种上下文。
 */
const DESCRIPTION_MARKERS = /偷换成|裸的|防的是|描述|指的是/

type ClaimContext = 'prohibition' | 'quoted-fence' | 'description' | 'UNCLASSIFIED'

/**
 * 扫出文本里**全部**禁止说法的出现，并逐条给出**上下文分类**。
 * 规则（对**判定文档**）：
 *   ① 行内带禁止语标记 ⇒ `prohibition`（引用禁令）
 *   ② 位于**由禁止语引导的**围栏代码块内 ⇒ `quoted-fence`（canonical 的"不得写：```…```"形状）
 *   ③ 行内带**描述**标记 ⇒ `description`（只对**过程性文档**放行；判定文档视为违规）
 *   ④ 其余 ⇒ `UNCLASSIFIED`（**判定文档与过程性文档都视为违规**）
 */
function scanClaims(text: string): { line: number; claim: string; text: string; context: ClaimContext }[] {
  const lines = text.split('\n')
  const out: { line: number; claim: string; text: string; context: ClaimContext }[] = []
  let inFence = false
  let fenceQuotedAsProhibition = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      if (!inFence) {
        inFence = true
        fenceQuotedAsProhibition = PROHIBITION_MARKERS.test(lines.slice(Math.max(0, i - 3), i).join(' '))
      } else {
        inFence = false
        fenceQuotedAsProhibition = false
      }
      continue
    }
    for (const claim of FORBIDDEN_CLAIMS) {
      if (!line.includes(claim)) continue
      const context: ClaimContext = PROHIBITION_MARKERS.test(line)
        ? 'prohibition'
        : inFence && fenceQuotedAsProhibition
          ? 'quoted-fence'
          : DESCRIPTION_MARKERS.test(line)
            ? 'description'
            : 'UNCLASSIFIED'
      out.push({ line: i + 1, claim, text: line.trim().slice(0, 140), context })
    }
  }
  return out
}
/** **判定文档**用的严格判据：只接受"引用禁令"与"由禁止语引导的围栏块" */
const strictViolations = (text: string) => scanClaims(text).filter((c) => c.context !== 'prohibition' && c.context !== 'quoted-fence')

/**
 * **量程**（WP-C3）：禁令只对**历史区**（`## 11.` 之前）生效。
 *
 * ```text
 *   §0–§10   历史判定 —— 那里**不得**出现 `M5.1.1 PASS` / `D01 CLOSED` 这类断言
 *   §11 起   当前状态附录 —— Phase 4 关闭之后，那里**合法地**写着 `M5.1-D01 = CLOSED`
 * ```
 * 不区分这两段，禁令就会把**关闭之后正确的结果**判红（那正是"旧状态锁"的形态）；
 * 而把整篇都放行，又会让"在历史区里偷改历史"失去唯一的机器守卫。
 */
const splitAppendix = (text: string): { historical: string; appendix: string } => {
  const parts = text.split(/^##\s*11\./m)
  return { historical: parts[0] ?? text, appendix: parts.length < 2 ? '' : `## 11.${parts.slice(1).join('## 11.')}` }
}
const reportParts = splitAppendix(reportText)
const gdParts = splitAppendix(gdText)
check(
  '★ **量程**：两份报告都能被切成"历史区 / 当前附录"两段（否则禁令不是在正确的范围上生效）',
  reportParts.historical.length > 0 && reportParts.appendix.length > 0 && gdParts.historical.length > 0 && gdParts.appendix.length > 0,
  `Phase1-3 历史 ${reportParts.historical.length} / 附录 ${reportParts.appendix.length} 字节 · ` +
    `Gate-Decision 历史 ${gdParts.historical.length} / 附录 ${gdParts.appendix.length} 字节`
)

const violationsReport = strictViolations(reportParts.historical)
const violationsGd = strictViolations(gdParts.historical)
measure('两份报告**历史区**里"断言式禁止说法"的出现次数（必须为 0）', violationsReport.length + violationsGd.length, true)
check(
  '★ **canonical 禁令（正控：合法输入 ⇒ 安静）** —— 两份报告的**历史区**里**没有**任何"断言式"的 `M5.1.1 PASS` / `D01 CLOSED`',
  violationsReport.length === 0 && violationsGd.length === 0,
  `历史区 ${violationsReport.length} 处 · Gate-Decision 历史区 ${violationsGd.length} 处${violationsReport.length + violationsGd.length > 0 ? `：${[...violationsReport, ...violationsGd].map((v) => `:${v.line} ${v.claim}`).join(' , ')}` : ''}`
)
/** 负控：注入假象 ⇒ **必须响**（走**同一个**检测器函数；注入点仍在**历史区**） */
const NEGATIVES = [
  { name: 'N1 历史区里裸的 `M5.1.1 Final = PASS` 行', text: `${reportParts.historical}\n\n## 结论\nM5.1.1 Final = PASS\n${reportParts.appendix}`, expectAtLeast: 1 },
  { name: 'N2 历史区里裸的 `D01 CLOSED` 行', text: `${reportParts.historical}\n\n## 结论\nD01 CLOSED\n${reportParts.appendix}`, expectAtLeast: 1 },
  { name: 'N3 历史区里无禁止语引导的围栏块（内含 `M5.1.1 PASS`）', text: `${reportParts.historical}\n\n## 结论\n\`\`\`text\nM5.1.1 PASS\n\`\`\`\n${reportParts.appendix}`, expectAtLeast: 1 },
  { name: 'N4 **不**得被误报：带禁止语标记的同一行', text: `${reportParts.historical}\n\n本报告不得写 D01 CLOSED。\n${reportParts.appendix}`, expectAtLeast: 0 },
  { name: 'N5 **不**得被误报：由「不得写：」引导的围栏块（canonical 的形状）', text: `${reportParts.historical}\n\n不得写：\n\n\`\`\`text\nM5.1.1 PASS\nD01 CLOSED\n\`\`\`\n${reportParts.appendix}`, expectAtLeast: 0 },
  /*
   * N6（WP-C3 新增的量程自检）：**当前状态附录里的合法 CLOSED 不得误报**。
   * 这一条与 N2 成对：同一个断言式 `D01 CLOSED`，在历史区是**违规**，在附录里是**正确结果**。
   */
  { name: 'N6 **不**得被误报：当前附录里的合法 `M5.1-D01 = CLOSED` / `M5.1.1 Final = PASS`', text: `${reportParts.historical}\n${reportParts.appendix}\n\n\`\`\`text\nM5.1-D01           CLOSED\nM5.1.1 Final       PASS\n\`\`\`\n`, expectAtLeast: 0 },
] as const
const negativeReadings: { name: string; fired: number; expectAtLeast: number; ok: boolean }[] = []
for (const n of NEGATIVES) {
  const fired = strictViolations(splitAppendix(n.text).historical).length
  const ok = n.expectAtLeast > 0 ? fired >= n.expectAtLeast : fired === 0
  negativeReadings.push({ name: n.name, fired, expectAtLeast: n.expectAtLeast, ok })
  check(
    `★ **canonical 禁令（负控）：${n.name}** ⇒ ${n.expectAtLeast > 0 ? '**必须响**' : '**必须不响（特异性）**'}`,
    ok,
    `fired=${fired}（期望 ${n.expectAtLeast > 0 ? `≥${n.expectAtLeast}` : '=0'}）`
  )
}
/** 恢复：放回真实报告 ⇒ 重新安静 */
const restored = strictViolations(reportParts.historical).length + strictViolations(gdParts.historical).length
check('★ **canonical 禁令（恢复）：放回真实报告的历史区 ⇒ 检测器重新安静**', restored === 0, `fired=${restored}`)

/* ---- 过程性文档的**审计**（allow `description`，但 `UNCLASSIFIED` 必须为 0） ---- */
const AUX_DOCS = [
  'docs/m5.1.1/WP11-Handoff.md',
  'docs/m5.1.1/M5.1.1-WP11-Compatible-Assertion-Record.md',
  'artifacts/m5.1.1/wp11-gate-exits.txt',
] as const
const auxAudit = AUX_DOCS.map((rel) => {
  const abs = join(ROOT, rel)
  const text = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
  const all = scanClaims(text)
  const unclassified = all.filter((c) => c.context === 'UNCLASSIFIED')
  return {
    path: rel,
    present: existsSync(abs),
    occurrences: all.length,
    byContext: {
      prohibition: all.filter((c) => c.context === 'prohibition').length,
      quotedFence: all.filter((c) => c.context === 'quoted-fence').length,
      description: all.filter((c) => c.context === 'description').length,
    },
    unclassified,
  }
})
measure('过程性文档里禁止说法的出现次数（它们**必须**能提到禁令，否则无法执行禁令）', auxAudit.reduce((s, a) => s + a.occurrences, 0))
measure('其中 `UNCLASSIFIED` 的出现次数（必须为 0）', auxAudit.reduce((s, a) => s + a.unclassified.length, 0), true)
check(
  '★ **过程性文档审计**：每一处提及都落在"引用禁令 / 由禁止语引导的围栏块 / 对禁令的描述"三种上下文里，`UNCLASSIFIED = 0`',
  auxAudit.every((a) => a.present) && auxAudit.every((a) => a.unclassified.length === 0),
  auxAudit.map((a) => `${a.path.split('/').pop()}:${a.occurrences}(U=${a.unclassified.length})`).join(' · ')
)
/** 过程性文档审计的**负控**：往过程性文档里追加一行**裸的**禁止说法 ⇒ 必须变成 UNCLASSIFIED */
const auxNegative = AUX_DOCS.map((rel) => {
  const abs = join(ROOT, rel)
  const text = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
  return scanClaims(`${text}\n\n## 结论\nM5.1.1 PASS\n`).filter((c) => c.context === 'UNCLASSIFIED').length
})
check(
  '★ **过程性文档审计（负控）**：往每一份过程性文档追加一行裸的 `M5.1.1 PASS` ⇒ 三份都必须出现 `UNCLASSIFIED`',
  auxNegative.length === 3 && auxNegative.every((n) => n >= 1),
  `UNCLASSIFIED 增量 = ${auxNegative.join(' / ')}`
)
/** 过程性文档审计的**恢复**：真实文本重新安静 */
check(
  '★ **过程性文档审计（恢复）**：放回真实文本 ⇒ `UNCLASSIFIED` 重新为 0',
  auxAudit.every((a) => a.unclassified.length === 0),
  `U=${auxAudit.reduce((s, a) => s + a.unclassified.length, 0)}`
)
/**
 * **为什么过程性文档可以用一套更宽的审计规则**（如实登记，`notClaimed` 里也写一遍）：
 * `F4` 与 `handoff` **必须**能逐条写出"哪些说法是被禁止的"（R-46 §4 要求 F4 枚举
 * criterion change；本 WP 的 F4 §1.3 还逐条列了 canonical 禁令的机器落点）。
 * 若对它们套用与**判定文档**相同的严格规则，那两份文档就**无法**执行自己的职责。
 * ⇒ 判定文档用**严格**判据（`prohibition` / `quoted-fence` 两种上下文），
 *   过程性文档用**审计**判据（多一个 `description` 上下文，且 `UNCLASSIFIED` 必须为 0）。
 * **两套规则都有各自的负控**（上面的 N1–N3 与 `auxNegative`），因此都不是空转判据。
 */

// ===========================================================================
section('§7 量具健康 / 判定 / 证据')
// ===========================================================================

const measurementInvalid = measurements.filter((m) => !m.valid)
check(
  '所有计数型判据都自检过 `measured_count > 0`（测到 0 个对象的一律 MEASUREMENT INVALID，不报 PASS）',
  measurementInvalid.length === 0,
  `${measurements.length} 个量具，无效 ${measurementInvalid.length} 个${measurementInvalid.length > 0 ? `：${measurementInvalid.map((m) => m.label).join(' , ')}` : ''}`
)

const verdict = failed === 0 && measurementInvalid.length === 0 ? 'PASS' : 'FAIL'
mkdirSync(ART, { recursive: true })
const evidence = {
  testId: 'M5.1.1 / WP11 Phase 1–3 Closure',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp11:verify',
  verdict,
  passed,
  failed,
  failures,
  computedStatuses: computed,
  reportedStatuses: reported,
  reportedCurrentStatuses: reportedCurrent,
  reportedPhase4Gate: reportedGate,
  derivedPhase4Gate: phase4Gate,
  statusesAgree: (Object.keys(computed) as (keyof typeof computed)[]).every((k) => reported[k] === computed[k]),
  phaseCriteria: {
    'Phase 1': { M1_M7: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map((m) => `${m}=${String(bool(w3, `gates.${m}.verdict`))}`), m3PerSlot: m3Entries.map(([k, v]) => `${k}:${v.expected}/${v.actual}`), m4Counts: Object.fromEntries(m4Entries), m7: { migratedLegacyRows: num(w3, 'gates.m7.migratedLegacyRows'), axisBNull: num(w3, 'gates.m7.axisBNull'), axisBBadValue: num(w3, 'gates.m7.axisBBadValue'), sourceKindOutOfVocab: num(w3, 'gates.m7.sourceKindOutOfVocab'), confirmedCount: num(b, 'gates.confirmedCount'), unconfirmedCount: num(b, 'gates.unconfirmedCount') }, restoreEpoch: str(w3, 'gates.m6.restoreEpoch'), impactRadiusBytes: Buffer.byteLength(radiusText, 'utf8') },
    'Phase 2': { scenarios: scenarios.length, legalReadings: legal.length, legalEqualReadings: legal.filter((l) => l.distinct === false).length, payloadRejections: num(w4, 'attestation.payloadRejections'), positiveQuiet: bool(w4, 'attestation.positiveQuiet'), negativeControls: arr(R.wp41.json, 'negativeControls').length },
    'Phase 3': { stages: arr(w5, 'stages').length, negativesFired: num(w5, 'negatives.fired'), k27: str(w51, 'k27'), replay: rp, sCovered: [...coveredS].sort(), correlations: corr.length, blockingGaps: arr(w9, 'blockingGaps').length, deferredCapabilities: dc.map((d) => `${String(d.id)}=${String(d.status)}`), mutations: `${muts.filter((m) => m.ok === true).length}/${muts.length}` },
  },
  exitConditions: exitConditions.map((e) => ({ id: e.id, scope: e.scope, text: e.text, ok: 'ok' in e ? e.ok : null, delegatedTo: 'delegatedTo' in e ? e.delegatedTo : null, detail: e.detail })),
  exitConditionsPhase13: { total: ec13.length, achieved: ec13Ok },
  canonicalProhibition: {
    claims: [...FORBIDDEN_CLAIMS],
    strictRule: {
      appliesTo: ['docs/m5.1.1/M5.1.1-Phase1-3-Acceptance-Report.md（**历史区**，§0–§10）', 'docs/m5.1.1/M5.1.1-Gate-Decision.md（**历史区**，§0–§10）'],
      allowedContexts: ['prohibition（行内带禁止语标记）', 'quoted-fence（由禁止语引导的围栏块）'],
      note: '**判定文档的历史区**用严格判据 —— 它们是"历史判定"所在的地方。WP-C3 起，禁令的**量程**只覆盖 `## 11.` 之前的部分；当前附录里的合法 `CLOSED` 由关闭门判定（负控 N6 守着这条量程）。',
    },
    auditRule: {
      appliesTo: [...AUX_DOCS],
      allowedContexts: ['prohibition', 'quoted-fence', 'description（对禁令的描述）'],
      hardCriterion: 'UNCLASSIFIED 必须为 0',
      note: '**过程性文档**（F4 / handoff / gate-exits）**必须**能逐条写出"哪些说法是被禁止的"，否则无法执行 R-46 §4 与本 WP 的 F4 §1.3。',
    },
    positiveQuiet: violationsReport.length + violationsGd.length,
    negatives: negativeReadings,
    restored,
    reportViolations: violationsReport,
    gateDecisionViolations: violationsGd,
    auxiliaryAudit: auxAudit,
    auxiliaryNegativeIncrements: auxNegative,
  },
  adr043: {
    canonical: { path: 'docs/adr/ADR-043-epistemic-requalification.md', statusLine: adrCanonicalStatusLine, approved: adrApproved },
    draft: { path: 'docs/m5.1.1/M5.1.1-ADR-043-Epistemic-Requalification-Draft.md', statusLine: adrDraftStatusLine, superseded: /SUPERSEDED/.test(adrDraftStatusLine) },
    derivedPhase4Gate: phase4Gate,
    historicalPhase4: 'BLOCKED BY ADR-043',
    source: '**由规范位置的 ADR 状态行推导**（`W11-G6`）；不再把 `DRAFT / NOT APPROVED` 写死',
  },
  currentStatuses: {
    reported: reportedCurrent,
    phase4Gate: reportedGate,
    derivedGate: phase4Gate,
    note: '**只登记，不再断言**（WP-C3 / ADR-044）：当前状态的判定职责已移交 `scripts/verify-m5.1.1-phase4-closure.ts`。',
  },
  d01: {
    historicalStatus: 'P1 OPEN',
    currentStatusDelegatedTo: 'scripts/verify-m5.1.1-phase4-closure.ts',
    historicalForbidden: ['D01 CLOSED', 'D01 已关闭', 'M5.1-D01 = CLOSED'],
    note:
      '**WP11 时点** `M5.1-D01 = P1 OPEN`（历史事实，§0 仍原样保留，`ST-6` 继续断言）。' +
      '关闭与否**不是**本门的判定：`DR-12` 的四项条件达成后由关闭门判定当前状态。',
  },
  liveSmoke: { status: str(R.wp10.json, 'liveSmoke.status'), mocked: false, note: 'cell 沿用 WP10-C 的读数；本门不跑任何需要 key 的命令' },
  readingsSources: Object.fromEntries(Object.entries(R).map(([k, r]) => [k, { path: r.path, present: r.present, bytes: r.bytes, sha256: r.sha256 }])),
  frozenFace: { tag: FREEZE_TAG, tagObject: FREEZE_TAG_OBJECT, targetCommit: FREEZE_TARGET_COMMIT, dirs: frozen },
  scope: { productionDbOpened: false, srcChanged: false, gatesRerun: false, onlyReadsLandedEvidence: true, frozenDirsFinallyEqualTag: frozen.every((r) => r.worktreeDiff === 0 && r.headDiff === 0) },
  measurements,
  measurementInvalid: measurementInvalid.length,
  notClaimed: [
    '本门（**Phase 1–3 历史门**）**不**主张 `M5.1.1 PASS`、也**不**主张 `D01 CLOSED` —— 当前状态的判定职责已移交 `scripts/verify-m5.1.1-phase4-closure.ts`（WP-C3 / ADR-044）。',
    '退出条件 EC-7 的"**已交用户看过**"是**人类动作**：本门只能证明报告存在且只读，不能证明用户看过。',
    '`Phase 4` 的闸**不是**本门的判定，而是**读规范位置 ADR-043 的状态行推导**出来的（`W11-G6`）。',
    '**本门不断言当前状态的值**：§11 的 `Phase 4` / `M5.1-D01` / `M5.1.1 Final` 取什么值由关闭门判定；本门只断言 §0 的历史六行、§11 里阶段 1–3 的事实、以及"移交已声明"。',
    '三项能力缺口（DC-1 / DC-2 / DC-3）仍 `NOT IMPLEMENTED / DEFERRED`；本门**不**把它们读成已实现。',
    'Live Smoke = NOT RUN（沿用 WP10-C 的**历史**读数），本门**没有**跑任何需要 key 的命令。',
    '**禁令检测器有两套规则**：判定文档的历史区用严格规则（只允许"引用禁令 / 由禁止语引导的围栏块"），过程性文档用审计规则（另允许"对禁令的描述"，且 `UNCLASSIFIED` 必须为 0）。两套规则**各有自己的负控**，因此都不是空转判据 —— 本门**不**主张"一套规则就够"。',
    '**禁令的量程只覆盖历史区**（`## 11.` 之前）：当前附录里的合法 `M5.1-D01 = CLOSED` 不得被本门误报（负控 N6 守着这条量程）。',
  ],
}
writeFileSync(join(ART, 'wp11-phase1-3-closure.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log('  ↳ 证据：artifacts/m5.1.1/wp11-phase1-3-closure.json')

console.log(`\n${'='.repeat(78)}`)
console.log(`M5.1.1 WP11（Phase 1–3 Closure）：${passed} 通过 / ${failed} 失败｜**WP11 = ${verdict}**`)
for (const [k, v] of Object.entries(computed)) console.log(`  ${k.padEnd(14)} ${v}`)
console.log(`  退出条件：阶段 1–3 ${ec13Ok}/${ec13.length} 达成 · EC-8b（ADR-043 当前）=${adrApproved ? '已达成' : '未达成'} · EC-10（D01 关闭）→ **当前状态已委派给关闭门**`)
console.log(`  当前状态（§11，**只登记不再断言**）：Phase 4 = ${String(reportedCurrent['Phase 4'])} · 闸 = ${String(reportedGate)} · M5.1-D01 = ${String(reportedCurrent['M5.1-D01'])}`)
console.log('  ↳ 当前状态的判定职责：scripts/verify-m5.1.1-phase4-closure.ts（本门是 Phase 1–3 历史门）')
console.log('='.repeat(78))
if (failed > 0) console.log(`失败项：\n${failures.map((f) => `    - ${f}`).join('\n')}`)
process.exit(failed === 0 && measurementInvalid.length === 0 ? 0 : 1)
