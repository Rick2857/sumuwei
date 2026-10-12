/**
 * M5.1.1 / WP8-B —— **Full Attribution Measurement & Gate Harness**（`pnpm m5.1.1:wp8:verify`）
 *
 * 它**不**重新实现 WP4–WP7 的测试逻辑。它做的是"测量":
 *   §0 只读预检        schema / 真库 / 冻结点 —— WP8 自己不碰它们
 *   §1 门覆盖完整性    expected gate registry == actual attribution verifier set
 *                      （missingGate / staleGate / unclassifiedVerifier + 合成注入负控 + 恢复）
 *   §2 逐门运行        把每一道既有 verifier 真的跑一遍，exit code 逐一记录
 *   §3 量具健康        measurementInvalid / measurements[].valid / 计数范围非空
 *   §4 跨门一致性      同一事实在**别的 WP 独立跑出**的证据副本里必须逐字相同（D01 / K-27 / schema）
 *   §5 核心不变量      十条不变量逐条锚到真实证据字段（解析不到 = MEASUREMENT INVALID）
 *   §6 mutation       计划冻结的七个注入，逐条锚到"某个既有门真的响过"
 *   §7 M511-G9         旧 Gate 兼容性 ①–⑤ 逐条机械检查（含"artifacts/m5.1 一字不动"）
 *   §8 证据 + 还原     落盘 wp8-*，并把被重写的**历史**证据按白名单逐路径还原（hash 前后对照）
 *
 * 纪律：只读真库（只记 mtime/文件数/字节数）；发现新的 correctness defect **不在本 WP 修**。
 */

import 'dotenv/config'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DISCOVERY_NEEDLES,
  FACT_CLAIMS,
  HISTORICAL_ECHOES,
  M511_GATES,
  M5L_FREEZE,
  NON_VERIFIER_SCRIPTS,
  VERIFIERS,
} from './m5.1.1-attribution-gate-registry.ts'
import type { EvidenceAnchor, FactClaim, VerifierSpec } from './m5.1.1-attribution-gate-registry.ts'

const ROOT = process.cwd()
const ART = join(ROOT, 'artifacts', 'm5.1.1')
const M511 = 'artifacts/m5.1.1/'
const FROZEN_0007 = '2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613'
const FROZEN_0008 = '0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29'
const EXPECTED_SCHEMA_VERSION = 9

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
  console.log(`  · 量：${label} = ${count}${valid ? '' : '   ← MEASUREMENT INVALID（测到的对象数为 0）'}`)
}
const abs = (p: string): string => join(ROOT, p)
const exists = (p: string): boolean => existsSync(abs(p))
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(abs(p))).digest('hex')
const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
/**
 * **不 trim** 的 git 输出。`git status --porcelain` 的第一列是空格（`" M path"`），
 * 对整段输出 `.trim()` 会把**第一行**的前导空格吃掉 ⇒ 那一行会被 `/^ M\s/` 漏掉。
 * （WP8-B 实测踩到：一个文件的证据因此永远不被还原。读数纪律：解析 porcelain 绝不能先 trim。）
 */
const gitRaw = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
function readJson(p: string): unknown {
  return JSON.parse(readFileSync(abs(p), 'utf8')) as unknown
}
function resolvePath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}
function writeJson(name: string, value: unknown): void {
  writeFileSync(join(ART, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  console.log(`  ↳ 证据：artifacts/m5.1.1/${name}`)
}

// ---------------------------------------------------------------------------
// §0 只读预检
// ---------------------------------------------------------------------------
interface DbFingerprint {
  mtime: string
  files: number
  bytes: number
}
function dbFingerprint(dir: string): DbFingerprint {
  const root = abs(dir)
  const st = statSync(root)
  let files = 0
  let bytes = 0
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        files += 1
        bytes += statSync(p).size
      }
    }
  }
  walk(root)
  return { mtime: st.mtime.toISOString(), files, bytes }
}

section('§0 只读预检 —— WP8 不碰 schema / 真库 / 冻结点')
const dbBefore = dbFingerprint('data/pglite')
console.log(`  真实库（运行前）：mtime=${dbBefore.mtime} files=${dbBefore.files} bytes=${dbBefore.bytes}`)
const migrationsSrc = readFileSync(abs('src/infrastructure/persistence/migrations.ts'), 'utf8')
const migrationVersions = [...migrationsSrc.matchAll(/const MIGRATION_000(\d): Migration = \{\s*version: (\d+)/g)].map((m) => Number(m[2]))
const maxMigrationVersion = migrationVersions.length === 0 ? 0 : Math.max(...migrationVersions)
measure('迁移清单条目数', migrationVersions.length, migrationVersions.length > 0)
/*
 * WP9-B1（R-45）把边界从 8 推到 9。
 *
 * 判据**没有被放宽**，它被**改写成更难的一条**：
 *   · 旧判据："清单到 0008 为止"（断言**没有** v9）；
 *   · 新判据：清单到 **0009** 为止（= `EXPECTED_SCHEMA_VERSION`），
 *     且 **v8 之后唯一新增的就是 MIGRATION_0009**，而且它**只碰 `state_events`**。
 * 后半句必须从**源码文本**里读出来（不是从库里读）—— 因为这一条要回答的是
 * "本 WP 有没有在迁移源码里偷偷扩半径"，而不是"当前库长什么样"。
 */
check(
  `迁移清单到 000${EXPECTED_SCHEMA_VERSION} 为止（v${EXPECTED_SCHEMA_VERSION - 1} 之后唯一新增的是 MIGRATION_0009）`,
  migrationVersions.length === EXPECTED_SCHEMA_VERSION && maxMigrationVersion === EXPECTED_SCHEMA_VERSION,
  `条目数 = ${migrationVersions.length} · 最大版本 = ${maxMigrationVersion}`
)
const v9BlockMatch = /const MIGRATION_0009: Migration = \{[\s\S]*?\n\}\r?\n/.exec(migrationsSrc)
const v9Block = v9BlockMatch?.[0] ?? ''
const v9AlterTargets = [...v9Block.matchAll(/alter table (\w+)/g)].map((m) => m[1] as string)
const v9DistinctTargets = [...new Set(v9AlterTargets)].sort()
measure('MIGRATION_0009 源码里字面 alter 的目标表数', v9DistinctTargets.length, v9DistinctTargets.length > 0)
check(
  'MIGRATION_0009 源码里字面 `alter table` 只对 `state_events` 发（目标表恰好一个）',
  v9DistinctTargets.length === 1 && v9DistinctTargets[0] === 'state_events',
  v9DistinctTargets.join(',') || '(解析不到目标表 —— MEASUREMENT INVALID)'
)
/*
 * 19 列的语句与 18 条槽位 CHECK 是**生成器**产出的（源码里只有两处 spread 调用），
 * 因此源码侧能读的是"两段生成器的实参都必须是 state_events"，
 * 而"恰好 19 + 19 = 38 条"由 `pnpm m5.1.1:migration:verify` 在运行期逐条实测。
 */
const v9SpreadCalls = [...v9Block.matchAll(/\.\.\.(v9StateEventAttributionColumnStatements|v7AttributionCheckStatements)\('state_events'/g)].map((m) => m[1] as string)
measure('MIGRATION_0009 中以 state_events 为实参的生成器调用数', v9SpreadCalls.length, v9SpreadCalls.length > 0)
check(
  'MIGRATION_0009 的两段生成器（列 / 槽位 CHECK）实参都是 `state_events`',
  v9SpreadCalls.length === 2 &&
    v9SpreadCalls.includes('v9StateEventAttributionColumnStatements') &&
    v9SpreadCalls.includes('v7AttributionCheckStatements'),
  v9SpreadCalls.join(',') || '(解析不到 —— MEASUREMENT INVALID)'
)
check(
  'MIGRATION_0009 是**纯追加**：无 Axis B 列、无索引、无数据语句',
  !/source_kind|source_authority|epistemic_source/.test(v9Block) &&
    !/create\s+index/i.test(v9Block) &&
    !/\b(update|delete|insert|truncate)\b/i.test(v9Block),
  `列/约束由生成器产出；字面语句 ${v9AlterTargets.length} 条`
)
check('M5.1 冻结点标签未移动（tag object 与它指向的 commit 都要逐字一致）', git('rev-parse', M5L_FREEZE.tagName) === M5L_FREEZE.tagObjectId && git('rev-list', '-n', '1', M5L_FREEZE.tagName) === M5L_FREEZE.targetCommitId, `${M5L_FREEZE.tagName}: tag object ${M5L_FREEZE.tagObjectId.slice(0, 8)}… → commit ${M5L_FREEZE.targetCommitId.slice(0, 8)}…`)
check('M5.1 的判决文档自冻结以来一字未改', git('diff', '--name-only', `${M5L_FREEZE.targetCommitId}..HEAD`, '--', 'docs/m5.1').length === 0, git('diff', '--name-only', `${M5L_FREEZE.targetCommitId}..HEAD`, '--', 'docs/m5.1') || '0 个文件')
check('本 WP 没有改迁移源码（工作区层面）', git('status', '--porcelain', '--', 'src/infrastructure/persistence/migrations.ts').length === 0, `migrations.ts sha256 = ${sha256('src/infrastructure/persistence/migrations.ts').slice(0, 16)}…`)

// ---------------------------------------------------------------------------
// §1 门覆盖完整性
// ---------------------------------------------------------------------------
interface CoverageInput {
  scriptsDir: string
  registry: readonly { id: string; script: string; pnpm: string | null; discoveryFile: boolean }[]
  pkgScripts: Record<string, string>
}
interface CoverageResult {
  discovered: string[]
  missingGate: string[]
  staleGate: string[]
  unclassifiedVerifier: string[]
}
function discoverAttributionVerifiers(scriptsDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(scriptsDir)) {
    if (!name.endsWith('.ts')) continue
    const src = readFileSync(join(scriptsDir, name), 'utf8')
    if (DISCOVERY_NEEDLES.some((n) => src.includes(n))) out.push(name)
  }
  return out.sort()
}
function coverage(input: CoverageInput): CoverageResult {
  const discovered = discoverAttributionVerifiers(input.scriptsDir)
  const known = new Set(input.registry.map((v) => v.script.split('/').pop() as string))
  const missingGate = input.registry
    .filter((v) => !existsSync(join(ROOT, v.script)) || (v.discoveryFile && !discovered.includes(v.script.split('/').pop() as string)))
    .map((v) => v.id)
  const staleGate = input.registry.filter((v) => v.pnpm !== null && !(v.pnpm in input.pkgScripts)).map((v) => v.id)
  const unclassifiedVerifier = discovered.filter((f) => !known.has(f) && !NON_VERIFIER_SCRIPTS.some((n) => n.file.endsWith(f)))
  return { discovered, missingGate, staleGate, unclassifiedVerifier }
}

section('§1 门覆盖完整性（Gate Coverage Completeness）')
const pkgScripts = (JSON.parse(readFileSync(abs('package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
const realCoverage = coverage({ scriptsDir: join(ROOT, 'scripts'), registry: VERIFIERS, pkgScripts })
measure('扫到的 attribution verifier 数', realCoverage.discovered.length)
measure('注册表里的 verifier 数', VERIFIERS.length)
const discoverable = VERIFIERS.filter((v) => v.discoveryFile).length
measure('注册表里应当被扫到的 verifier 数', discoverable)
console.log(`  · 扫到：${realCoverage.discovered.join(', ')}`)
check('missingGate = 0（注册表每一条都真实存在且在断言归因）', realCoverage.missingGate.length === 0, realCoverage.missingGate.join(', ') || '0')
check('staleGate = 0（每一条的 pnpm 入口都还在 package.json）', realCoverage.staleGate.length === 0, realCoverage.staleGate.join(', ') || '0')
check('unclassifiedVerifier = 0（扫到者全部在册或已登记理由）', realCoverage.unclassifiedVerifier.length === 0, realCoverage.unclassifiedVerifier.join(', ') || '0')

const controlDir = mkdtempSync(join(tmpdir(), 'wp8-coverage-'))
const negativeControls: Record<string, unknown>[] = []
try {
  for (const f of ['verify-m5.1.1-wp4-write-path.ts', 'verify-m5.1.1-wp7-console.ts']) copyFileSync(join(ROOT, 'scripts', f), join(controlDir, f))
  writeFileSync(join(controlDir, 'verify-m5.1.1-wp8-synthetic-verifier.ts'), "export const a = 'axisB'\nexport const b = 'NECESSITY_MATRIX'\n", 'utf8')
  const injected = coverage({ scriptsDir: controlDir, registry: VERIFIERS, pkgScripts })
  const fired1 = injected.unclassifiedVerifier.includes('verify-m5.1.1-wp8-synthetic-verifier.ts')
  negativeControls.push({ probe: '注入合成 verifier', mustFire: 'unclassifiedVerifier', fired: fired1, observed: injected.unclassifiedVerifier })
  check('负控① 注入未登记的合成 verifier ⇒ unclassifiedVerifier 必响', fired1, JSON.stringify(injected.unclassifiedVerifier))

  const withGhost = [...VERIFIERS, { id: 'wp8-synthetic-ghost', script: 'scripts/verify-m5.1.1-wp8-nonexistent.ts', pnpm: 'm5.1.1:wp8:ghost', discoveryFile: true }]
  const ghost = coverage({ scriptsDir: join(ROOT, 'scripts'), registry: withGhost, pkgScripts })
  const fired2 = ghost.missingGate.includes('wp8-synthetic-ghost') && ghost.staleGate.includes('wp8-synthetic-ghost')
  negativeControls.push({ probe: '注入陈旧注册表条目', mustFire: 'missingGate + staleGate', fired: fired2, observed: { missingGate: ghost.missingGate, staleGate: ghost.staleGate } })
  check('负控② 注册表塞一条不存在的 verifier ⇒ missingGate / staleGate 必响', fired2, `missing=${JSON.stringify(ghost.missingGate)} stale=${JSON.stringify(ghost.staleGate)}`)

  const pkgWithout: Record<string, string> = { ...pkgScripts }
  delete pkgWithout['m5.1.1:wp4:verify']
  const removed = coverage({ scriptsDir: join(ROOT, 'scripts'), registry: VERIFIERS, pkgScripts: pkgWithout })
  const fired3 = removed.staleGate.includes('wp4')
  negativeControls.push({ probe: '摘掉一个 pnpm 入口', mustFire: 'staleGate', fired: fired3, observed: removed.staleGate })
  check('负控③ 摘掉 wp4 的 pnpm 入口 ⇒ staleGate 必响', fired3, JSON.stringify(removed.staleGate))
} finally {
  rmSync(controlDir, { recursive: true, force: true })
}
check(
  '恢复：真实仓库 + 真实注册表 ⇒ 重新安静（0 / 0 / 0）',
  realCoverage.missingGate.length + realCoverage.staleGate.length + realCoverage.unclassifiedVerifier.length === 0,
  `${realCoverage.missingGate.length} / ${realCoverage.staleGate.length} / ${realCoverage.unclassifiedVerifier.length}`,
)

// ---------------------------------------------------------------------------
// §2 逐门运行 + 证据快照
// ---------------------------------------------------------------------------
section('§2 逐门运行（复用既有 verifier；WP8 只读它们的 exit code 与证据）')
const runDir = mkdtempSync(join(tmpdir(), 'wp8-runs-'))
/** 只取**已跟踪且被修改**的路径（`??` 未跟踪不算；这是 AGENTS §7 的"跑之前先记状态"） */
function modifiedPaths(): string[] {
  return gitRaw('status', '--porcelain', '--', 'artifacts', 'docs')
    .split('\n')
    .filter((l) => /^ M\s/.test(l))
    .map((l) => l.trim().replace(/^M\s+/, ''))
}
const preRunModified = new Set(modifiedPaths())
console.log(`  运行前就已经被改动的路径（**不**属于本次门重写，绝不还原）：${[...preRunModified].join(', ') || '(无)'}`)
measure('运行前已存在的未提交改动数（只登记，不参与还原）', preRunModified.size, true)
/** 门的运行窗口：用来把"**门**写的东西"与"人在运行期间顺手改的东西"分开（mtime 判据） */
const runWindowStart = Date.now()
const writtenDuringRun = (p: string): boolean => {
  try {
    return statSync(abs(p)).mtimeMs >= runWindowStart - 2000
  } catch {
    return false
  }
}
interface RunResult {
  id: string
  pnpm: string
  script: string
  kind: string
  gates: readonly string[]
  exit: number
  tail: string[]
  evidenceRead: string[]
  evidenceMissing: string[]
}
const runs: RunResult[] = []
const freshEvidence = new Map<string, unknown>()
const runnable = VERIFIERS.filter((v) => v.runnable && (v.kind === 'gate' || v.kind === 'test' || v.kind === 'measurement'))
for (const v of runnable) {
  const log = join(runDir, `${v.id}.log`)
  // 与 K-19 同一套做法（仓库既有模式）：`shell: true` + 直捕 stdout/stderr，不依赖 Node 管道重定向
  const r = spawnSync('pnpm', [v.pnpm as string], { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 })
  const exit = r.status === null ? -1 : r.status
  const text = `${String(r.stdout ?? '')}\n${String(r.stderr ?? '')}`
  writeFileSync(log, text, 'utf8')
  const evidenceRead: string[] = []
  const evidenceMissing: string[] = []
  for (const p of v.evidence) {
    if (exists(p)) {
      try {
        freshEvidence.set(p, readJson(p))
        evidenceRead.push(p)
      } catch {
        evidenceMissing.push(`${p}（不是 JSON）`)
      }
    } else evidenceMissing.push(p)
  }
  runs.push({ id: v.id, pnpm: v.pnpm as string, script: v.script, kind: v.kind, gates: v.gates, exit, tail: text.split('\n').filter((l) => /通过|失败|PASS|FAIL/.test(l)).slice(-2), evidenceRead, evidenceMissing })
  console.log(`  $ pnpm ${v.pnpm}  => EXIT=${exit}`)
}
measure('跑过的 verifier 数', runs.length)
const redGates = runs.filter((r) => r.exit !== 0)
const exitRows = runs.map((r) => {
  const v = VERIFIERS.find((x) => x.id === r.id) as VerifierSpec
  return { id: r.id, pnpm: r.pnpm, kind: r.kind, gates: r.gates as string[], exit: r.exit, runnableCurrent: v.kind !== 'historical-scope-guard', tail: r.tail }
})
const postRunModified = modifiedPaths()
/** 只还原**注册表声明过**的写入面（AGENTS §7：restore whitelist only）—— 绝不碰别的文件 */
const declaredWrites = new Set(VERIFIERS.flatMap((v) => [...v.evidence, ...(v.extraWrites ?? [])]))
const regenerated = postRunModified.filter((p) => !preRunModified.has(p) && declaredWrites.has(p))
const undeclaredNew = postRunModified.filter((p) => !preRunModified.has(p) && !declaredWrites.has(p))
const unexpectedWrites = undeclaredNew.filter((p) => writtenDuringRun(p))
const concurrentEdits = undeclaredNew.filter((p) => !writtenDuringRun(p))
measure('被门重写的路径数（白名单来源：运行后才出现的改动）', regenerated.length, true)
measure('运行期间由**别的作者**（人/代理）改动的未声明路径数（只登记、不还原；mtime 早于运行窗口）', concurrentEdits.length, true)
if (concurrentEdits.length > 0) console.log(`  · 并发改动（与门无关）：${concurrentEdits.join(', ')}`)
check('没有预料之外的**门写入**面（运行窗口内新出现、且未在注册表声明）', unexpectedWrites.length === 0, unexpectedWrites.join(', ') || '0')

// ---------------------------------------------------------------------------
// §3 量具健康
// ---------------------------------------------------------------------------
section('§3 量具健康（每一道门自己的量具自检 + 计数范围非空）')
interface HealthRow {
  id: string
  kind: string
  exit: number
  verdict: string | null
  verdictSignals: { key: string; value: string }[]
  passed: number | null
  failed: number | null
  measurementInvalid: number | null
  measurementsTotal: number
  measurementsInvalidFlags: number
  zeroCountMeasurements: string[]
  scopeSignal: string | null
  primaryEvidence: string | null
  red: boolean
  notRun: boolean
}
const healthRows: HealthRow[] = []
for (const v of VERIFIERS) {
  if (!v.runnable || (v.kind !== 'gate' && v.kind !== 'test' && v.kind !== 'measurement')) continue
  const primary = v.evidence[0] ?? null
  let verdict: string | null = null
  let p: number | null = null
  let f: number | null = null
  let mi: number | null = null
  let total = 0
  let invalidFlags = 0
  const zeros: string[] = []
  const verdictSignals: { key: string; value: string }[] = []
  let scopeSignal: string | null = null
  const present = primary !== null && (freshEvidence.has(primary) || exists(primary))
  const source = present ? ((freshEvidence.get(primary as string) ?? readJson(primary as string)) as Record<string, unknown>) : null
  if (source !== null) {
    if (typeof source.verdict === 'string') verdict = source.verdict
    for (const [key, value] of Object.entries(source)) if (/(Verdict|verdict)$/.test(key) && typeof value === 'string') verdictSignals.push({ key, value })
    if (typeof source.passed === 'number') p = source.passed
    if (typeof source.failed === 'number') f = source.failed
    if (typeof source.measurementInvalid === 'number') mi = source.measurementInvalid
    const ms = Array.isArray(source.measurements) ? (source.measurements as { label?: string; count?: number; valid?: boolean }[]) : []
    total = ms.length
    invalidFlags = ms.filter((m) => m.valid === false).length
    for (const m of ms) if (m.count === 0) zeros.push(m.label ?? '(未命名)')
    const biggestArray = Object.entries(source).filter(([, x]) => Array.isArray(x)).sort((a, b) => (b[1] as unknown[]).length - (a[1] as unknown[]).length)[0]
    scopeSignal =
      total > 0
        ? `measurements[${total}]`
        : p !== null && p > 0
          ? `passed=${p}`
          : verdictSignals.length > 0
            ? `${verdictSignals[0]?.key}=${verdictSignals[0]?.value}`
            : biggestArray !== undefined && (biggestArray[1] as unknown[]).length > 0
              ? `array:${biggestArray[0]}[${(biggestArray[1] as unknown[]).length}]`
              : null
  }
  const red = (f ?? 0) > 0 || (mi ?? 0) !== 0 || verdictSignals.some((s) => /FAIL|BLOCKED|PARTIAL/.test(s.value))
  const evidenceFree = v.evidence.length === 0
  healthRows.push({ id: v.id, kind: v.kind, exit: runs.find((r) => r.id === v.id)?.exit ?? -1, verdict, verdictSignals, passed: p, failed: f, measurementInvalid: mi, measurementsTotal: total, measurementsInvalidFlags: invalidFlags, zeroCountMeasurements: zeros, scopeSignal, primaryEvidence: primary, red, notRun: !evidenceFree && !present })
}
const healthMeasured = healthRows.filter((h) => !h.notRun)
measure('有规范证据可比对的 verifier 数', healthMeasured.length)
const gatesWithVerdict = healthMeasured.filter((h) => h.verdict !== null || h.verdictSignals.length > 0).length
measure('证据里带 verdict 信号的 verifier 数', gatesWithVerdict)
const invalidTotal = healthMeasured.reduce((s, h) => s + (h.measurementInvalid ?? 0), 0)
const invalidFlagsTotal = healthMeasured.reduce((s, h) => s + h.measurementsInvalidFlags, 0)
check('measurementInvalid = 0（逐门相加）', invalidTotal === 0, `Σ measurementInvalid = ${invalidTotal}`)
check('没有 measurements[].valid === false 的条目', invalidFlagsTotal === 0, `invalid 条数 = ${invalidFlagsTotal}`)
const noScope = healthMeasured.filter((h) => h.primaryEvidence !== null && h.scopeSignal === null)
check('每一条**写证据**的门都报了一个非空的测量范围（计数型判据不得是空测量）', noScope.length === 0, noScope.map((h) => h.id).join(', ') || '0')
const redHealth = healthMeasured.filter((h) => h.red)
check('没有一条门的证据报红（failed > 0 / measurementInvalid ≠ 0 / 非 PASS 的 verdict 信号）', redHealth.length === 0, redHealth.map((h) => `${h.id}(failed=${String(h.failed)} mi=${String(h.measurementInvalid)} verdict=${String(h.verdict)})`).join(', ') || '0')
const notRunHealth = healthRows.filter((h) => h.notRun)
check('每一条可运行的 verifier 都留下了证据（缺证据 = not-run，不是 PASS）', notRunHealth.length === 0, notRunHealth.map((h) => h.id).join(', ') || '0')
measure('按门统计的 zero-count 测量数（只登记：0 是结论，不是空测量）', healthMeasured.reduce((s, h) => s + h.zeroCountMeasurements.length, 0), true)

// ---------------------------------------------------------------------------
// §4 跨门一致性
// ---------------------------------------------------------------------------
section('§4 跨门一致性（同一事实在不同 WP 独立跑出的副本里必须逐字相同）')
interface EchoRow {
  fact: string
  fresh: string | null
  echoes: { file: string; value: string | null; agree: boolean }[]
}
const echoRows: EchoRow[] = []
const echoSources: Record<string, { file: string; path: string }> = {
  'agentAsUserD01.row.actor': { file: `${M511}wp6.1-conversation-ingress.json`, path: 'agentAsUserD01.row.actor' },
  'agentAsUserD01.row.contentOriginator': { file: `${M511}wp6.1-conversation-ingress.json`, path: 'agentAsUserD01.row.contentOriginator' },
  d01CrossLedger: { file: `${M511}wp5.1-k27-causal-initiator.json`, path: 'd01CrossLedger.actionInitiator' },
  positiveControls: { file: `${M511}wp4.1-k22-action-axis-b.json`, path: 'positiveControls.0.eventType' },
}
let echoViolations = 0
for (const [key, echoes] of Object.entries(HISTORICAL_ECHOES)) {
  const src = echoSources[key]
  if (src === undefined) continue
  const fresh = freshEvidence.has(src.file) ? resolvePath(freshEvidence.get(src.file), src.path) : resolvePath(readJson(src.file), src.path)
  const freshStr = fresh === undefined ? null : String(fresh)
  const rows = echoes.map((file) => {
    const val = exists(file) ? resolvePath(readJson(file), src.path) : undefined
    const value = val === undefined ? null : String(val)
    const agree = value !== null && value === freshStr
    if (!agree) echoViolations += 1
    return { file, value, agree }
  })
  echoRows.push({ fact: src.path, fresh: freshStr, echoes: rows })
}
measure('比对的跨时间事实数', echoRows.length)
measure('比对的独立历史副本数', echoRows.reduce((s, r) => s + r.echoes.length, 0))
check('crossGateConsistencyViolations = 0（D01 / K-27 的事实跨时间稳定）', echoViolations === 0, `violations = ${echoViolations}`)

const k27Surfaces = (freshEvidence.get(`${M511}wp6.1-conversation-ingress.json`) ?? readJson(`${M511}wp6.1-conversation-ingress.json`)) as Record<string, unknown>
const surfaces = ((resolvePath(k27Surfaces, 'crossLedgerK27.surfaces') as { label: string; value: string }[] | undefined) ?? [])
const serviceSurfaces = surfaces.filter((s) => s.value.includes('SERVICE')).length
measure('K-27 agent 行动在展示面上的读数个数', surfaces.length)
check('K-27：agent-as-user 的行动在**每一个**展示面上都是 SERVICE', surfaces.length > 0 && serviceSurfaces === surfaces.length, `${serviceSurfaces}/${surfaces.length}`)

const schemaBoundary = (file: string): Record<string, unknown> => ((freshEvidence.get(file) ?? readJson(file)) as Record<string, unknown>).schemaBoundary as Record<string, unknown>
const sb61 = schemaBoundary(`${M511}wp6.1-conversation-ingress.json`)
const sb51 = schemaBoundary(`${M511}wp5.1-k27-causal-initiator.json`)
check('schema 边界：两门独立报告的 v7/v8 指纹与冻结值逐字相同', sb61.migration0007Sha256 === FROZEN_0007 && sb61.migration0008Sha256 === FROZEN_0008 && sb51.migration0007Sha256 === FROZEN_0007 && sb51.migration0008Sha256 === FROZEN_0008, `v7=${String(sb61.migration0007Sha256).slice(0, 12)}… v8=${String(sb61.migration0008Sha256).slice(0, 12)}…`)
check(
  'schema 边界：两门独立报告的 latestSchemaVersion 都是 9（WP9-B1 起；v7/v8 指纹判据一字未改）',
  sb61.latestSchemaVersion === 9 && sb51.latestSchemaVersion === 9,
  `${String(sb61.latestSchemaVersion)} / ${String(sb51.latestSchemaVersion)}`
)

const k17 = (freshEvidence.get(`${M511}wp2.2-k17-consumer-impact.json`) ?? readJson(`${M511}wp2.2-k17-consumer-impact.json`)) as Record<string, unknown>
const k17All = (k17.classifications as { file: string; klass: string }[]).map((c) => c.file)
const declaredScripts = VERIFIERS.map((v) => v.script)
// K-17 的辖区 = 命中它自己声明的 Axis B 名字的文件。**针表从 K-17 源码里读**（不在这里复制字面量：
// 量具一旦把判据文本抄进自己，就会把自己的文本当成被测对象 —— K-17 §1b 那一课的同型问题）。
// 只有**落在辖区内**的 manifest verifier 才必须已被 K-17 分类；辖区外的 verifier 不属于 K-17 的判据。
const k17Source = readFileSync(abs('scripts/verify-m5.1.1-k17-consumer-impact.ts'), 'utf8')
const k17NeedleBlock = k17Source.match(/const NEEDLES[^=]*=\s*\[([\s\S]*?)\]/)
const K17_NEEDLES = k17NeedleBlock === null ? [] : [...(k17NeedleBlock[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
measure('从 K-17 源码里读到的针表长度', K17_NEEDLES.length)
const inK17Scope = declaredScripts.filter((s) => K17_NEEDLES.some((n) => readFileSync(abs(s), 'utf8').includes(n)))
const notClassifiedByK17 = inK17Scope.filter((s) => !k17All.includes(s))
measure('K-17 分类表里被分类的文件数', k17All.length)
measure('manifest 里落在 K-17 辖区内的 verifier 数', inK17Scope.length)
measure('manifest 里 K-17 针表够不着的 verifier 数（只登记，不算违规）', declaredScripts.length - inK17Scope.length, true)
check('K-17 辖区内每一个 attribution verifier 都已被 K-17 分类表覆盖（两侧不漂移）', notClassifiedByK17.length === 0, notClassifiedByK17.join(', ') || '0')
const k17ScriptEntries = k17All.filter((f) => f.startsWith('scripts/') && (/verify-/.test(f) || /kernel-tests/.test(f)))
const k17Only = k17ScriptEntries.filter((f) => !declaredScripts.includes(f))
measure('K-17 表里未出现在 manifest 的脚本数（Axis-B 名字消费者，非归因 verifier —— 只登记，不算违规）', k17Only.length, true)
console.log(`  · K-17 表里只作为消费者存在的脚本：${k17Only.join(', ') || '(无)'}`)

const openConflicts: { file: string; where: string; status: string }[] = []
for (const [file, obj] of freshEvidence.entries()) {
  const conflicts = resolvePath(obj, 'transcriptionFidelity.registeredClassificationConflicts')
  if (Array.isArray(conflicts)) {
    for (const c of conflicts as { family: string; slot: string; status: string }[]) openConflicts.push({ file, where: `${c.family}.${c.slot}`, status: c.status })
  }
}
measure('证据里登记的"OPEN 分类冲突"数（只登记，不在本 WP 裁定）', openConflicts.length, true)
console.log(`  · OPEN 冲突：${openConflicts.map((c) => `${c.where} ← ${c.file}`).join(' | ') || '(无)'}`)

// ---------------------------------------------------------------------------
// §5 / §6 不变量 + mutation（逐条锚到真实证据字段）
// ---------------------------------------------------------------------------
interface AnchorResult {
  file: string
  path: string
  expect: string
  expected: string | number | boolean | undefined
  observed: string | number | boolean | null
  provenance: 'fresh-run' | 'committed-evidence'
  ok: boolean
  note: string
}
function evalAnchor(a: EvidenceAnchor): AnchorResult {
  const source = freshEvidence.has(a.file) ? freshEvidence.get(a.file) : exists(a.file) ? readJson(a.file) : undefined
  const provenance: 'fresh-run' | 'committed-evidence' = freshEvidence.has(a.file) ? 'fresh-run' : 'committed-evidence'
  if (source === undefined) return { file: a.file, path: a.path, expect: a.expect, expected: a.value, observed: null, provenance, ok: false, note: '证据文件不存在' }
  const raw = resolvePath(source, a.path)
  if (raw === undefined) return { file: a.file, path: a.path, expect: a.expect, expected: a.value, observed: null, provenance, ok: false, note: 'MEASUREMENT INVALID：字段解析不到' }
  let ok = false
  let observed: string | number | boolean | null
  if (a.expect === 'allEqual') {
    const arr = raw as Record<string, unknown>[]
    if (!Array.isArray(arr) || arr.length === 0) return { file: a.file, path: a.path, expect: a.expect, expected: a.value, observed: null, provenance, ok: false, note: 'MEASUREMENT INVALID：不是非空数组' }
    const values = arr.map((e) => (a.field === undefined ? e : (e as Record<string, unknown>)[a.field]))
    observed = values.length
    ok = values.every((v) => (a.value === undefined ? v !== undefined && v !== null : v === a.value))
    return { file: a.file, path: a.path, expect: a.expect, expected: a.value, observed, provenance, ok, note: `${values.length} 条逐条通过` }
  }
  observed = typeof raw === 'object' ? JSON.stringify(raw) : (raw as string | number | boolean)
  switch (a.expect) {
    case 'equals':
      ok = raw === a.value
      break
    case 'isFalse':
      ok = raw === false
      break
    case 'isTrue':
      ok = raw === true
      break
    case 'contains':
      ok = typeof raw === 'string' && raw.includes(String(a.value))
      break
  }
  return { file: a.file, path: a.path, expect: a.expect, expected: a.value, observed, provenance, ok, note: ok ? 'ok' : `期望 ${String(a.value)}，实测 ${String(observed)}` }
}
function evalClaim(c: FactClaim): { id: string; statement: string; gates: readonly string[]; kind: string; ok: boolean; anchors: AnchorResult[]; sourceAnchors: { file: string; ok: boolean; detail: string }[] } {
  const anchors = c.anchors.map(evalAnchor)
  const sourceAnchors = (c.sourceAnchors ?? []).map((s) => {
    if (!exists(s.file)) return { file: s.file, ok: false, detail: '源文件不存在' }
    const text = readFileSync(abs(s.file), 'utf8')
    const missingContains = (s.contains ?? []).filter((needle) => !text.includes(needle))
    const presentNotContains = (s.notContains ?? []).filter((needle) => text.includes(needle))
    return { file: s.file, ok: missingContains.length === 0 && presentNotContains.length === 0, detail: [...missingContains.map((m) => `缺 ${m}`), ...presentNotContains.map((m) => `不该有 ${m}`)].join(' | ') || 'ok' }
  })
  return { id: c.id, statement: c.statement, gates: c.gates, kind: c.kind, ok: anchors.every((a) => a.ok) && sourceAnchors.every((a) => a.ok), anchors, sourceAnchors }
}

section('§5 十条核心不变量 + 两个跨层反例（逐条锚到真实证据字段）')
const claimResults = FACT_CLAIMS.map(evalClaim)
const invariants = claimResults.filter((c) => c.kind === 'invariant' || c.kind === 'counterexample')
for (const c of invariants) {
  check(`${c.id} ${c.statement}`, c.ok, c.anchors.filter((a) => !a.ok).map((a) => `${a.file}:${a.path} → ${a.note}`).join(' ; ') || `${c.anchors.length} 条锚全部成立`)
}
measure('被逐条验证的不变量 / 反例数', invariants.length)
measure('锚点总数（解析到真实字段的断言数）', invariants.reduce((s, c) => s + c.anchors.length + c.sourceAnchors.length, 0))

section('§6 七个 mutation（每个都必须锚到"某个既有门真的响过"）')
const mutationResults = claimResults.filter((c) => c.kind === 'mutation')
for (const c of mutationResults) {
  check(`${c.id} ${c.statement}`, c.ok, c.anchors.filter((a) => !a.ok).map((a) => `${a.file}:${a.path} → ${a.note}`).join(' ; ') || `${c.anchors.length} 条锚全部成立`)
}
measure('逐条锚定的 mutation 数', mutationResults.length)
check('计划要求的七个 mutation 一个不少', mutationResults.length === 7, `实测 ${mutationResults.length}`)

// ---------------------------------------------------------------------------
// §7 M511-G9 旧 Gate 兼容性
// ---------------------------------------------------------------------------
section('§7 M511-G9 旧 Gate 兼容性（compatibility rule ①–⑤）')
const recordsDir = 'docs/m5.1.1'
const compatRecords = readdirSync(abs(recordsDir)).filter((f) => /Compatible-Assertion-Record/i.test(f) || /WP8-Compatible/i.test(f))
measure('兼容性记录（Compatible-Assertion-Record）数', compatRecords.length)
const changedScripts = git('diff', '--name-status', `${M5L_FREEZE.targetCommitId}..HEAD`, '--', 'scripts')
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split('\t'))
const changedExistingScripts = changedScripts.filter(([, p]) => /^M/.test(changedScripts.find(([s, q]) => q === p)?.[0] ?? ''))
const recordText = compatRecords.map((f) => readFileSync(abs(`${recordsDir}/${f}`), 'utf8')).join('\n')
const unrecorded = changedExistingScripts.map(([, p]) => p).filter((p) => !recordText.includes(p.split('/').pop() as string))
measure('自冻结以来被改动的既有 script 数', changedExistingScripts.length)
check('约束①：每个被改动的既有 M5.1 script 都在兼容性记录里被逐条写到', unrecorded.length === 0, unrecorded.join(', ') || '0')
const addedUnderFrozen = git('diff', '--name-status', `${M5L_FREEZE.targetCommitId}..HEAD`, '--', ...M5L_FREEZE.frozenDirs)
  .split('\n')
  .filter((l) => l.startsWith('A'))
const frozenChanged = git('diff', '--name-status', `${M5L_FREEZE.targetCommitId}..HEAD`, '--', ...M5L_FREEZE.frozenDirs)
  .split('\n')
  .filter((l) => /^[MD]/.test(l))
measure('冻结目录（artifacts/m5.1 + artifacts/m4.5）里的文件数', readdirSync(abs('artifacts/m5.1')).length + readdirSync(abs('artifacts/m4.5')).length)
check('约束③：自冻结以来没有**新增**文件落进冻结目录', addedUnderFrozen.length === 0, addedUnderFrozen.join(' ; ') || '0')
check('约束④：`artifacts/m5.1/**` 与 `artifacts/m4.5/**` 一字未动', frozenChanged.length === 0, frozenChanged.join(' ; ') || '0')
const tagStillThere = git('rev-parse', M5L_FREEZE.tagName) === M5L_FREEZE.tagObjectId && git('rev-list', '-n', '1', M5L_FREEZE.tagName) === M5L_FREEZE.targetCommitId
check('约束⑤：M5.1 的标签仍指向冻结点，且 M5.1 判决文档未被改', tagStillThere, `${M5L_FREEZE.tagName} → tag object ${M5L_FREEZE.tagObjectId.slice(0, 8)}… → commit ${M5L_FREEZE.targetCommitId.slice(0, 8)}…`)
const g9Ok = unrecorded.length === 0 && addedUnderFrozen.length === 0 && frozenChanged.length === 0 && tagStillThere

// ---------------------------------------------------------------------------
// §8 还原历史证据 + 落盘 + 判定
// ---------------------------------------------------------------------------
section('§8 历史证据还原（run → fork → restore → hash 对照）')
// 还原面 = 注册表声明过的写入面 ∩ **当前与 HEAD 不同** 的路径。
// 这样即使某个门的写发生在 §8 快照之后（子进程拖延等），也仍然会被还原；
// 而未声明的路径**永远不碰**（AGENTS §7：restore whitelist only —— 绝不无差别 checkout）。
const declaredAndDirty = [...declaredWrites].filter((p) => modifiedPaths().includes(p))
const regeneratedPaths = [...new Set([...modifiedPaths().filter((p) => !preRunModified.has(p) && declaredWrites.has(p)), ...declaredAndDirty])]
/**
 * 还原来源（WP8-C3 硬化，落实 C1 不变量）：
 *   · 落在**永久冻结**目录（`artifacts/m5.1` / `artifacts/m4.5`）的路径 ⇒ 内容**只能**取自
 *     immutable 标签 `m5.1-complete:<path>`（`git checkout <tag> -- <path>`）。
 *     绝不从"运行前 HEAD"还原 —— WP7 的教训正是 HEAD 自己已经被污染。
 *   · 其余声明过的路径 ⇒ 还原到 HEAD（它们不属于冻结面）。
 */
interface RestoreRow {
  path: string
  source: 'immutable-tag' | 'HEAD'
  expectedBlob: string
  blobAfter: string
  byteExact: boolean
  regeneratedSha256: string
}
const isFrozenPath = (p: string): boolean => M5L_FREEZE.frozenDirs.some((d) => p.startsWith(`${d}/`))
const restoreRows: RestoreRow[] = []
for (const p of regeneratedPaths) {
  const frozen = isFrozenPath(p)
  const expectedBlob = frozen ? git('rev-parse', `${M5L_FREEZE.tagName}:${p}`) : git('rev-parse', `HEAD:${p}`)
  const regeneratedSha256 = sha256(p)
  execFileSync('git', frozen ? ['checkout', M5L_FREEZE.tagName, '--', p] : ['checkout', '--', p], { cwd: ROOT })
  const blobAfter = git('hash-object', p)
  restoreRows.push({ path: p, source: frozen ? 'immutable-tag' : 'HEAD', expectedBlob, blobAfter, byteExact: expectedBlob === blobAfter, regeneratedSha256 })
}
measure('被重写并按白名单还原的历史证据数', restoreRows.length, true)
measure('其中从 immutable 标签还原的冻结路径数', restoreRows.filter((r) => r.source === 'immutable-tag').length, true)
const restoreMismatches = restoreRows.filter((r) => !r.byteExact)
check('还原后逐路径 blob id 与**其还原来源**相同（冻结面 = immutable 标签 blob，其余 = HEAD blob）', restoreMismatches.length === 0, restoreMismatches.map((r) => r.path).join(', ') || `mismatches = ${restoreMismatches.length}`)
const residualModified = [...declaredWrites].filter((p) => modifiedPaths().includes(p))
check('第三段（恢复后重新安静）：所有被门重写的声明路径都已还原、没有残留', residualModified.length === 0, residualModified.join(', ') || '0')

const dbAfter = dbFingerprint('data/pglite')
check('真实库未被动过（mtime / 文件数 / 字节数三项一致）', dbAfter.mtime === dbBefore.mtime && dbAfter.files === dbBefore.files && dbAfter.bytes === dbBefore.bytes, `mtime ${dbBefore.mtime === dbAfter.mtime ? 'same' : `${dbBefore.mtime} → ${dbAfter.mtime}`} files ${dbBefore.files}/${dbAfter.files} bytes ${dbBefore.bytes}/${dbAfter.bytes}`)
check('K-31 未被触碰（没有 reply-confirmation 语义改动）', !git('status', '--porcelain', '--', 'src/infrastructure/persistence/conversation-store.ts').includes('M'), 'source-authority 映射未动')

// ---- 逐门判定 ----
const runOk = (ids: readonly string[]): boolean => ids.every((id) => (runs.find((r) => r.id === id)?.exit ?? -1) === 0)
const claimsOkFor = (gate: string): boolean => claimResults.filter((c) => c.gates.includes(gate as never)).every((c) => c.ok)
const gateVerdict = new Map<string, { verdict: string; reason: string }>()
for (const g of M511_GATES) {
  if (g.status === 'NOT_RUN') {
    gateVerdict.set(g.id, { verdict: 'NOT RUN', reason: g.notRunReason ?? '' })
    continue
  }
  const ids = g.verifiers
  const gatesPart = runOk(ids)
  const invariantsPart = claimsOkFor(g.id)
  const g9Part = g.id === 'M511-G9' ? g9Ok : true
  const ok = gatesPart && invariantsPart && g9Part
  const reasons: string[] = []
  if (!gatesPart) reasons.push(`红门=${ids.filter((id) => (runs.find((r) => r.id === id)?.exit ?? -1) !== 0).join(',')}`)
  if (!invariantsPart) reasons.push(`不变量未过=${claimResults.filter((c) => c.gates.includes(g.id as never) && !c.ok).map((c) => c.id).join(',')}`)
  if (!g9Part) reasons.push(`兼容性约束未过（§7）`)
  gateVerdict.set(g.id, { verdict: ok ? 'PASS' : 'FAIL', reason: ok ? `${ids.length} 道门全绿 · 相关不变量全过` : reasons.join(' · ') })
}
const allPass = M511_GATES.every((g) => gateVerdict.get(g.id)?.verdict !== 'FAIL')
const wp8Verdict = allPass ? 'PASS' : 'PARTIAL / BLOCKED'

console.log('\n  ── M511 门判定 ──')
for (const g of M511_GATES) {
  const v = gateVerdict.get(g.id) as { verdict: string; reason: string }
  console.log(`   ${g.id}  ${v.verdict.padEnd(16)} ${g.name}  ${v.reason}`)
}

// ---- 落盘 ----
writeJson('wp8-gate-manifest.json', {
  testId: 'M5.1.1 / WP8-B Full Attribution Measurement & Gate Harness',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp8:verify',
  gates: M511_GATES.map((g) => ({ ...g, verdict: gateVerdict.get(g.id)?.verdict, reason: gateVerdict.get(g.id)?.reason })),
  verifiers: VERIFIERS.map((v) => ({ ...v, run: runs.find((r) => r.id === v.id) ?? null })),
  coverage: { ...realCoverage, registeredVerifiers: VERIFIERS.length, registeredDiscoverable: discoverable },
  compatibility: { legacyGateConstraints: { records: compatRecords, changedExistingScripts: changedExistingScripts.map(([, p]) => p), unrecorded, addedUnderFrozen, frozenChanged }, freeze: M5L_FREEZE },
  registeredOpenConflicts: openConflicts,
  summary: { passed, failed, failures, measurementInvalid: invalidTotal, unexpectedWrites, redGates: redGates.map((r) => `${r.id}:${r.exit}`), wp8Verdict },
})
writeJson('wp8-measurement-health.json', { testId: 'M5.1.1 / WP8-B measurement health', rows: healthRows, totals: { measurementInvalid: invalidTotal, invalidFlags: invalidFlagsTotal, rowsWithPrimaryEvidence: healthMeasured.length } })
writeJson('wp8-cross-gate-consistency.json', {
  testId: 'M5.1.1 / WP8-B cross-gate consistency',
  crossGateConsistencyViolations: echoViolations,
  echoRows,
  k27Surfaces: { count: surfaces.length, serviceCount: serviceSurfaces, rows: surfaces },
  schemaBoundary: { wp61: sb61, wp51: sb51 },
  k17ToManifest: { declaredVerifiers: declaredScripts.length, notClassifiedByK17, k17OnlyConsumers: k17Only },
  registeredOpenConflicts: openConflicts,
})
writeJson('wp8-negative-controls.json', { testId: 'M5.1.1 / WP8-B coverage negative controls', negativeControls, restored: realCoverage.missingGate.length + realCoverage.staleGate.length + realCoverage.unclassifiedVerifier.length === 0 })
writeJson('wp8-invariants.json', { testId: 'M5.1.1 / WP8-B core invariants', claims: claimResults })
writeJson('wp8-mutations.json', {
  testId: 'M5.1.1 / WP8-B seven frozen mutation controls',
  count: mutationResults.length,
  mutations: mutationResults.map((m) => ({ id: m.id, statement: m.statement, ok: m.ok, anchors: m.anchors, sourceAnchors: m.sourceAnchors })),
})
const exitsText = [
  '# WP8-B 逐门 exit code',
  '#',
  '# 跑法：pnpm m5.1.1:wp8:verify（WP8 复用既有 verifier，不重新实现任何 WP4–WP7 的测试逻辑）',
  `# 结果：${runs.filter((r) => r.exit === 0).length} / ${runs.length} 绿 · 红门 = ${redGates.map((r) => `${r.id}(EXIT=${r.exit})`).join(', ') || '(无)'}`,
  '',
  ...exitRows.map((r) => `${r.pnpm.padEnd(32)} => EXIT=${r.exit}  ${r.gates.join(',') || '-'}  ${r.tail.join(' ')}`),
  '',
  '# 未跑（理由）',
  '#   M511-G8 Break-Glass：规则已冻结、入口未实现 ⇒ NOT RUN（不得伪造 PASS）',
  '#   m5.1.1:wp7:preflight：WP7 期的作用域护栏，基线早于 K-29 的受权改动 ⇒ 分类 historical-scope-guard，不计入当前 correctness claim',
  '#   WP9 的真实运行时 E2E（E1–E8）：下一个 WP',
].join('\n')
writeFileSync(join(ART, 'wp8-gate-exits.txt'), `${exitsText}\n`, 'utf8')
console.log('  ↳ 证据：artifacts/m5.1.1/wp8-gate-exits.txt')
const whitelist = [
  '# WP8-B restore whitelist',
  '#',
  '# 逐门运行会重写各门自己的规范证据（artifacts/m5.1.1/<name>.json），wp3 门还会重写 Phase-4 半径文档。',
  '# 按 AGENTS §7 / M5.1.1 计划：历史证据一律不重新提交 ⇒ 逐路径记录 + 逐路径 git checkout --。',
  '# blob_head = git rev-parse HEAD:<path> ; blob_after = git hash-object <path>',
  '#',
  '# WP8-C3 硬化：冻结面（artifacts/m5.1 · artifacts/m4.5）的还原来源是 **immutable 标签**',
  '# `m5.1-complete:<path>`，不是"运行前 HEAD"；表里 `source` 列逐行写明用了哪一种。',
  '# 列：path|source|expected_blob|blob_after_restore|byte_exact|regenerated_sha256',
  '#',
  `# 运行前就已存在的未提交改动（**不**属于本次门重写，一律不还原）：${[...preRunModified].join(', ') || '(无)'}`,
  '#',
  'path|blob_head|blob_after_restore|byte_exact|regenerated_sha256',
  ...restoreRows.map((r) => [r.path, r.source, r.expectedBlob, r.blobAfter, String(r.byteExact), r.regeneratedSha256].join('|')),
  '',
  `restored = ${restoreRows.length}`,
  `byte_exact_mismatches = ${restoreMismatches.length}`,
].join('\n')
writeFileSync(join(ART, 'wp8-restore-whitelist.txt'), `${whitelist}\n`, 'utf8')
console.log('  ↳ 证据：artifacts/m5.1.1/wp8-restore-whitelist.txt')

console.log('\n' + '='.repeat(78))
console.log(`M5.1.1 WP8-B —— Attribution Measurement & Gate Harness：${passed} 通过 / ${failed} 失败`)
console.log(`  K-17 分类完整性 = ${realCoverage.unclassifiedVerifier.length === 0 ? 'PASS' : 'FAIL'} ｜ 门覆盖 = ${realCoverage.missingGate.length === 0 && realCoverage.staleGate.length === 0 ? 'PASS' : 'FAIL'} ｜ 量具 = ${invalidTotal === 0 ? 'PASS' : 'FAIL'} ｜ 跨门一致性 = ${echoViolations === 0 ? 'PASS' : 'FAIL'}`)
console.log(`  **WP8-B = ${wp8Verdict}**`)
if (failed > 0) console.log(`  失败项：\n${failures.map((f) => `    - ${f}`).join('\n')}`)
console.log('='.repeat(78))
if (measurements.some((m) => !m.valid)) {
  console.log('MEASUREMENT INVALID：有计数器的对象数为 0 —— 结论无效')
  process.exit(2)
}
process.exit(failed === 0 ? 0 : 1)
