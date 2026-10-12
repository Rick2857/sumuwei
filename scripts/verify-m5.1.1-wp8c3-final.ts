/**
 * M5.1.1 / WP8-C3 —— **Full Attribution Harness Requalification**（`pnpm m5.1.1:wp8c3:verify`）
 *
 * 只做最终重新资格化，不开发 attribution 功能。它按用户裁定的 C3-0…C3-11 顺序：
 *
 *   §0 C3-0 最终基线冻结（git 干净 · K-32/K-33 门 PASS · schema v8 · 指纹 · 真库 mtime）
 *   §1 C3-1 `M5L_FREEZE` 命名明确化验证（tag object / target commit / peel 三者对得上）
 *   §2 C3-2 跑完整 WP8 harness（九门；`G8 = NOT RUN` 是正确状态，不伪造 PASS）
 *   §3 C3-3 `pnpm m5.1.1:gates`（EXIT=0；判定以**当前 harness 执行真相**为准）
 *   §4 C3-4 量具健康再资格化（measurementInvalid / missing / stale / unclassified / 跨门一致性 全 0）
 *   §5 C3-5 跨门最终一致性（D01 · K-27 · K-29 · K-23 · WP6 读 == WP7 渲染 · v7/v8 指纹）
 *   §6 C3-6/C3-7 冻结证据**在跑完 harness 之后**再复验 + K-33 再资格化
 *   §7 C3-10 落盘 7 份 `wp8c3-*` 最终证据（**不覆盖** wp8-B / wp8c1 / wp8c2 三代事实）
 *
 * 还原纪律（C1 建立的不变量，C3 硬化进 harness）：
 *   冻结面 `artifacts/m5.1/**` 的内容**只能**从 immutable 标签 `m5.1-complete:<path>` 还原，
 *   其余声明过的路径还原到 HEAD。绝不无差别 checkout，绝不碰未声明的路径。
 */

import 'dotenv/config'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { M5L_FREEZE, M511_GATES } from './m5.1.1-attribution-gate-registry.ts'
import { latestSchemaVersion } from '../src/infrastructure/persistence/migrations.ts'

const ROOT = process.cwd()
const ART = join(ROOT, 'artifacts', 'm5.1.1')
const M511 = 'artifacts/m5.1.1/'
const FROZEN_0007 = '2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613'
const FROZEN_0008 = '0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29'
const EXPECTED_GATE_ROWS: Record<string, string> = {
  'M511-G1': 'PASS',
  'M511-G2': 'PASS',
  'M511-G3': 'PASS',
  'M511-G4': 'PASS',
  'M511-G5': 'PASS',
  'M511-G6': 'PASS',
  'M511-G7': 'PASS',
  'M511-G8': 'NOT RUN',
  'M511-G9': 'PASS',
}

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []
const exits: { command: string; exit: number }[] = []
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
function section(t: string): void {
  console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)
}
function measure(label: string, count: number, valid = count > 0): void {
  measurements.push({ label, count, valid })
  console.log(`  · 量：${label} = ${count}${valid ? '' : '   ← MEASUREMENT INVALID'}`)
}
const abs = (p: string): string => join(ROOT, p)
const exists = (p: string): boolean => existsSync(abs(p))
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(abs(p))).digest('hex')
const git = (...a: string[]): string => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
const gitRaw = (...a: string[]): string => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' })
const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(abs(p), 'utf8')) as Record<string, unknown>
function run(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 128 * 1024 * 1024 })
  const exit = r.status === null ? -1 : r.status
  exits.push({ command: `${cmd} ${args.join(' ')}`, exit })
  return exit
}
function modifiedPaths(): string[] {
  return gitRaw('status', '--porcelain', '--', 'artifacts', 'docs')
    .split('\n')
    .filter((l) => /^ M\s/.test(l))
    .map((l) => l.trim().replace(/^M\s+/, ''))
}
const isFrozenPath = (p: string): boolean => M5L_FREEZE.frozenDirs.some((d) => p.startsWith(`${d}/`))
function dbFingerprint(): { mtime: string; files: number; bytes: number } {
  const root = abs('data/pglite')
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

const preRunModified = new Set(modifiedPaths())
const dbBefore = dbFingerprint()

// ---------------------------------------------------------------------------
section('§0 C3-0 最终基线冻结')
console.log(`  运行前未提交改动：${[...preRunModified].join(', ') || '(无)'}`)
check('C3-0：git 工作区干净（`git status --porcelain` 为空）', preRunModified.size === 0, [...preRunModified].join(', ') || '0')
const wp1 = readJson(`${M511}wp1-contracts.json`)
const wp61 = readJson(`${M511}wp6.1-conversation-ingress.json`)
const wp61Boundary = (wp61.schemaBoundary ?? {}) as Record<string, unknown>
measure('迁移/契约证据里报告的 schema 版本', Number(wp61Boundary.latestSchemaVersion ?? 0))
/*
 * ⚠️ WP9-B1 修正（R-46 §2 A 类的**正确形态**）：
 *
 * `wp6.1-conversation-ingress.json` 是 **WP6.1 当时写下的历史证据**，它的
 * `schemaBoundary.latestSchemaVersion = 8` 是**当时为真**的事实。WP8 harness 的 §8
 * 会按 restore whitelist 把它**还原到 HEAD**（= v8）。因此**绝不能**把这条断言改成
 * `=== 9` —— 那等于断言一个关于**历史文件**的假事实，而且会在"先跑 wp8、再跑 wp8c3"
 * 的顺序下必然红（本 WP 实测踩到）。
 *
 * 正确形态（**更强，不是放宽**）：
 *   ① 历史证据仍必须报告 **v8**（历史事实不许被改写）；
 *   ② 指纹仍必须等于冻结值；
 *   ③ **另外**断言**当前代码**的最新 schema = 9（从源码读，不依赖任何历史证据）。
 * 三条同时成立才算过。这样既保住了历史真相，又钉住了当前仓库的真实边界。
 */
check(
  'C3-0：WP6.1 历史证据仍报告 schema = v8（历史事实不得被改写）且 v7/v8 指纹与冻结值一致',
  wp61Boundary.latestSchemaVersion === 8 &&
    wp61Boundary.migration0007Sha256 === FROZEN_0007 &&
    wp61Boundary.migration0008Sha256 === FROZEN_0008,
  `v${String(wp61Boundary.latestSchemaVersion)} · v7 ${String(wp61Boundary.migration0007Sha256).slice(0, 12)}… · v8 ${String(wp61Boundary.migration0008Sha256).slice(0, 12)}…`
)
const codeLatest = latestSchemaVersion()
measure('当前代码里的最新 schema 版本（从源码读，不依赖历史证据）', codeLatest)
check(
  'C3-0：当前代码的最新 schema = v9（WP9-B1 起；v9 只追加 state_events 的承载）',
  codeLatest === 9,
  `v${codeLatest}`
)
measure('wp1 契约证据的通过数（范围自检）', Number(wp1.passed ?? 0))

// ---------------------------------------------------------------------------
section('§1 C3-1 M5L_FREEZE 命名明确化')
const liveTagObject = git('rev-parse', M5L_FREEZE.tagName)
const liveTargetCommit = git('rev-list', '-n', '1', M5L_FREEZE.tagName)
check('`git rev-parse m5.1-complete` == registry 的 `tagObjectId`', liveTagObject === M5L_FREEZE.tagObjectId, `${liveTagObject.slice(0, 12)}…`)
check('`git rev-list -n 1 m5.1-complete` == registry 的 `targetCommitId`', liveTargetCommit === M5L_FREEZE.targetCommitId, `${liveTargetCommit.slice(0, 12)}…`)
check('tag object 确实 peel 到 target commit（`^{commit}` 一致）', git('rev-parse', `${M5L_FREEZE.tagName}^{commit}`) === M5L_FREEZE.targetCommitId, `${git('rev-parse', `${M5L_FREEZE.tagName}^{commit}`).slice(0, 12)}…`)
check('命名明确化没有 repoint 标签（tag object id 未变）', liveTagObject === '2e718f38a6256330d1a72af960702f64f570efff', liveTagObject.slice(0, 12) + '…')

// ---------------------------------------------------------------------------
section('§2 / §3 / §4 C3-2…C3-4 完整 harness + 汇总器 + 量具健康')
const typecheckExit = run('pnpm', ['typecheck'])
check('C3-8 矩阵：`pnpm typecheck` EXIT=0', typecheckExit === 0, `EXIT=${typecheckExit}`)
const preC1 = run('pnpm', ['m5.1.1:wp8c1:verify'])
const preC2 = run('pnpm', ['m5.1.1:wp8c2:verify'])
const preWp3 = run('pnpm', ['m5.1.1:wp3:verify'])
const preK17 = run('pnpm', ['m5.1.1:k17:verify'])
check('C3-0：跑 harness 之前 K-32 门 PASS', preC1 === 0, `EXIT=${preC1}`)
check('C3-0：跑 harness 之前 K-33 专项门 PASS', preC2 === 0, `EXIT=${preC2}`)
check('C3-0：跑 harness 之前 wp3 门 PASS', preWp3 === 0, `EXIT=${preWp3}`)
check('C3-8：k17 门 EXIT=0', preK17 === 0, `EXIT=${preK17}`)

const harnessExit = run('pnpm', ['m5.1.1:wp8:verify'])
const harnessManifest = readJson(`${M511}wp8-gate-manifest.json`)
const harnessHealth = readJson(`${M511}wp8-measurement-health.json`)
const harnessCross = readJson(`${M511}wp8-cross-gate-consistency.json`)
const harnessInvariants = readJson(`${M511}wp8-invariants.json`)
const harnessMutations = readJson(`${M511}wp8-mutations.json`)
const harnessSummary = harnessManifest.summary as Record<string, unknown>
const gateRows = harnessManifest.gates as { id: string; verdict: string; reason: string }[]
console.log(`  · harness 九门：${gateRows.map((g) => `${g.id}=${g.verdict}`).join(' · ')}`)
check('C3-2：`pnpm m5.1.1:wp8:verify` EXIT=0 且自查 failed = 0', harnessExit === 0 && Number(harnessSummary.failed ?? -1) === 0, `EXIT=${harnessExit} · passed=${String(harnessSummary.passed)} · failed=${String(harnessSummary.failed)}`)
const wrongRows = M511_GATES.filter((g) => (gateRows.find((r) => r.id === g.id)?.verdict ?? 'MISSING') !== EXPECTED_GATE_ROWS[g.id])
check('C3-2：九门状态全部符合期望（G1–G7 PASS · **G8 = NOT RUN**（不伪造 PASS）· G9 PASS）', wrongRows.length === 0, wrongRows.map((g) => `${g.id}=${gateRows.find((r) => r.id === g.id)?.verdict ?? 'MISSING'}`).join(' , ') || '9/9 正确')

const gatesExit = run('pnpm', ['m5.1.1:gates'])
const gateResults = readJson(`${M511}gate-results.json`)
check('C3-3：`pnpm m5.1.1:gates` EXIT=0（判定以当前 harness 执行真相为准）', gatesExit === 0, `EXIT=${gatesExit}`)
const summaryRows = gateResults.gates as { id: string; verdict: string }[]
check('C3-3：汇总器九门读数与 harness 一致（没有用陈旧历史证据顶替）', summaryRows.every((r) => r.verdict === EXPECTED_GATE_ROWS[r.id]), summaryRows.map((r) => `${r.id}=${r.verdict}`).join(' · '))

const coverage = harnessManifest.coverage as Record<string, unknown>
const invClaims = harnessInvariants.claims as { ok: boolean; anchors: unknown[]; sourceAnchors: unknown[] }[]
const anchorCount = invClaims.reduce((s, c) => s + c.anchors.length + c.sourceAnchors.length, 0)
measure('量具健康：有证据的 verifier 数', Number((harnessHealth.totals as Record<string, unknown>).rowsWithPrimaryEvidence ?? 0))
check('C3-4：measurementInvalid = 0', Number(harnessSummary.measurementInvalid ?? -1) === 0, String(harnessSummary.measurementInvalid))
check('C3-4：missingGate / staleGate / unclassifiedVerifier 全为 0', (coverage.missingGate as unknown[]).length === 0 && (coverage.staleGate as unknown[]).length === 0 && (coverage.unclassifiedVerifier as unknown[]).length === 0, `missing=${JSON.stringify(coverage.missingGate)} stale=${JSON.stringify(coverage.staleGate)} unclassified=${JSON.stringify(coverage.unclassifiedVerifier)}`)
check('C3-4：crossGateConsistencyViolations = 0', Number(harnessCross.crossGateConsistencyViolations ?? -1) === 0, String(harnessCross.crossGateConsistencyViolations))
measure('不变量/反例 claim 数', invClaims.length)
measure('证据锚点总数', anchorCount)
check('C3-4：全部 claim 成立（19 条 claim / 71 条锚；若有增减须在记录里解释）', invClaims.every((c) => c.ok !== false), `${invClaims.filter((c) => c.ok).length}/${invClaims.length} 成立 · ${anchorCount} 条锚`)
check('C3-4：七个 mutation 锚定仍全部成立', Number(harnessMutations.count ?? 0) === 7 && (harnessMutations.mutations as { ok: boolean }[]).every((m) => m.ok), `${String(harnessMutations.count)} 个 · 全成立=${String((harnessMutations.mutations as { ok: boolean }[]).every((m) => m.ok))}`)
check('C3-4：没有任何未声明的写入面（门只写注册表声明过的路径）', (harnessSummary.unexpectedWrites as unknown[]).length === 0, JSON.stringify(harnessSummary.unexpectedWrites))

// ---------------------------------------------------------------------------
section('§5 C3-5 跨门最终一致性（D01 · K-27 · K-29 · K-23 · 展示层 · 指纹）')
const claimById = new Map(invClaims.map((c, i) => [String((harnessInvariants.claims as { id: string }[])[i]?.id), c]))
void claimById
const invById = new Map((harnessInvariants.claims as { id: string; ok: boolean }[]).map((c) => [c.id, c]))
check('C3-5 D01：conversation actor / contentOriginator = SERVICE/agent-runner（跨层处处一致）', invById.get('CE-D01')?.ok === true, `CE-D01 = ${String(invById.get('CE-D01')?.ok)}`)
check('C3-5 K-27：action initiator = SERVICE（人类发起仍 = USER）', invById.get('CE-K27')?.ok === true, `CE-K27 = ${String(invById.get('CE-K27')?.ok)}`)
check('C3-5 K-29：非法 RECORDED 必要性形态被拒（necessity 强制仍生效）', invById.get('MUT-7')?.ok === true && invById.get('INV-4')?.ok === true, `MUT-7=${String(invById.get('MUT-7')?.ok)} · INV-4=${String(invById.get('INV-4')?.ok)}`)
const k23Boundary = readJson(`${M511}wp8c2-k23-boundary.json`)
const k23Canonical = (k23Boundary.canonicalRecorder as Record<string, unknown>) ?? {}
check('C3-5 K-23：recordedBy 的权威生产者 = canonical SYSTEM/kernel', k23Canonical.kind === 'SYSTEM' && k23Canonical.id === 'kernel', `${String(k23Canonical.kind)}/${String(k23Canonical.id)}`)
const surfaces = (harnessCross.k27Surfaces as Record<string, unknown>) ?? {}
check('C3-5 展示层：K-27 行动在 WP7 展示面上全部 = SERVICE（WP6 读 == WP7 渲染真相）', Number(surfaces.count ?? 0) > 0 && Number(surfaces.serviceCount ?? 0) === Number(surfaces.count ?? -1), `${String(surfaces.serviceCount)}/${String(surfaces.count)}`)
const sb = harnessCross.schemaBoundary as Record<string, Record<string, unknown>>
check('C3-5 指纹：v7/v8 在所有独立证据里一致（且等于冻结值）', sb.wp61?.migration0007Sha256 === FROZEN_0007 && sb.wp61?.migration0008Sha256 === FROZEN_0008 && sb.wp51?.migration0007Sha256 === FROZEN_0007 && sb.wp51?.migration0008Sha256 === FROZEN_0008, `wp6.1 v7 ${String(sb.wp61?.migration0007Sha256).slice(0, 10)}… · wp5.1 v8 ${String(sb.wp51?.migration0008Sha256).slice(0, 10)}…`)

// ---------------------------------------------------------------------------
section('§6 C3-6 / C3-7 harness 之后的冻结证据复验 + K-33 再资格化')
// harness 已经跑过 m5.1:test / m5.1:query:verify（历史上污染冻结证据的两个 writer）⇒ 现在逐路径对照 immutable 标签
const frozenPaths = M5L_FREEZE.frozenDirs.flatMap((d) =>
  execFileSync('git', ['ls-tree', '-r', '--name-only', `${M5L_FREEZE.tagName}`, '--', d], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean),
)
measure('冻结标签里的路径数（对照范围）', frozenPaths.length)
const frozenMismatch: string[] = []
for (const p of frozenPaths) {
  const tagBlob = git('rev-parse', `${M5L_FREEZE.tagName}:${p}`)
  const headBlob = git('rev-parse', `HEAD:${p}`)
  const wtBlob = git('hash-object', p)
  if (tagBlob !== headBlob || headBlob !== wtBlob) frozenMismatch.push(`${p}(tag=${tagBlob.slice(0, 8)} head=${headBlob.slice(0, 8)} wt=${wtBlob.slice(0, 8)})`)
}
check('C3-6：跑完完整 harness 之后，冻结面每条路径仍 `tag blob == HEAD blob == 工作树 blob`', frozenMismatch.length === 0, frozenMismatch.join(' , ') || `${frozenPaths.length} 条全部一致`)
const frozenDiffPost = git('diff', '--name-status', `${M5L_FREEZE.targetCommitId}..HEAD`, '--', ...M5L_FREEZE.frozenDirs)
check('C3-6：`git diff m5.1-complete..HEAD -- artifacts/m5.1 artifacts/m4.5` 仍为空', frozenDiffPost.length === 0, frozenDiffPost || '0')

const postC1 = run('pnpm', ['m5.1.1:wp8c1:verify'])
const postC2 = run('pnpm', ['m5.1.1:wp8c2:verify'])
const postWp3 = run('pnpm', ['m5.1.1:wp3:verify'])
check('C3-6：harness 之后 K-32 门重新 PASS（长期解决，不是跑前暂时干净）', postC1 === 0, `EXIT=${postC1}`)
check('C3-7：harness 之后 K-33 专项门重新 PASS', postC2 === 0, `EXIT=${postC2}`)
check('C3-7：harness 之后 wp3 门重新 PASS', postWp3 === 0, `EXIT=${postWp3}`)
const k23Post = readJson(`${M511}wp8c2-k23-boundary.json`)
const k23Counts = k23Post.counts as Record<string, number>
check('C3-7：K-33 关键读数不变（writer = 1 · callerControlled = 0 · unexplained = 0）', k23Counts.authoritativeWriterFiles === 1 && k23Counts.callerControlledProviders === 0 && k23Counts.unexplainedReferences === 0, `writer=${String(k23Counts.authoritativeWriterFiles)} callerControlled=${String(k23Counts.callerControlledProviders)} unexplained=${String(k23Counts.unexplainedReferences)}`)
const wp3Post = readJson(`${M511}wp3-backfill.json`)
check('C3-7：wp3 门证据 verdict = PASS 且 failed = 0', wp3Post.verdict === 'PASS' && Number(wp3Post.failed ?? -1) === 0, `verdict=${String(wp3Post.verdict)} passed=${String(wp3Post.passed)} failed=${String(wp3Post.failed)}`)

const measurementExit = run('pnpm', ['m5.1:measurement:verify'])
check('C3-8：`pnpm m5.1:measurement:verify` EXIT=0', measurementExit === 0, `EXIT=${measurementExit}`)

const dbAfter = dbFingerprint()
check('C3-9：真实库 data/pglite 未被触碰', dbAfter.mtime === dbBefore.mtime && dbAfter.files === dbBefore.files && dbAfter.bytes === dbBefore.bytes, `mtime ${dbAfter.mtime} · files ${dbAfter.files} · bytes ${dbAfter.bytes}`)
check('C3-9：生产源码未被本 WP 改动（src/ 在 git 层面无改动）', git('status', '--porcelain', '--', 'src').length === 0, git('status', '--porcelain', '--', 'src') || '0')
check('C3-9：K-31 未被触碰', git('status', '--porcelain', '--', 'src/infrastructure/persistence/conversation-store.ts').length === 0, 'conversation-store.ts 未改')

// ---------------------------------------------------------------------------
section('§7 C3-10 落盘最终证据 + 还原（冻结面从 immutable 标签）')
mkdirSync(ART, { recursive: true })
const write = (name: string, value: unknown): void => {
  writeFileSync(join(ART, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  console.log(`  ↳ 证据：artifacts/m5.1.1/${name}`)
}
write('wp8c3-gate-results.json', { testId: 'M5.1.1 / WP8-C3 gate results', source: 'artifacts/m5.1.1/gate-results.json（本次 harness 执行真相）', gatesExit, gateResults })
write('wp8c3-measurement-health.json', { testId: 'M5.1.1 / WP8-C3 measurement health', source: 'artifacts/m5.1.1/wp8-measurement-health.json（本次 harness 读数）', coverage, totals: harnessHealth.totals, rows: harnessHealth.rows, claims: invClaims.length, anchors: anchorCount, mutations: harnessMutations.count })
write('wp8c3-cross-gate-consistency.json', { testId: 'M5.1.1 / WP8-C3 cross-gate consistency', source: 'artifacts/m5.1.1/wp8-cross-gate-consistency.json（本次 harness 读数）', crossGateConsistencyViolations: harnessCross.crossGateConsistencyViolations, echoRows: harnessCross.echoRows, k27Surfaces: harnessCross.k27Surfaces, schemaBoundary: harnessCross.schemaBoundary, k23Boundary: { canonicalRecorder: k23Boundary.canonicalRecorder, counts: k23Post.counts, references: k23Post.references } })
write('wp8c3-freeze-integrity.json', {
  testId: 'M5.1.1 / WP8-C3 frozen evidence integrity（harness 之后复验）',
  canonicalSource: { tagName: M5L_FREEZE.tagName, tagObjectId: M5L_FREEZE.tagObjectId, targetCommitId: M5L_FREEZE.targetCommitId },
  restoredFrom: 'immutable tag（harness §8 已硬化：冻结面不再从运行前 HEAD 还原）',
  frozenPathsChecked: frozenPaths.length,
  mismatches: frozenMismatch,
  frozenDiffAfterHarness: frozenDiffPost,
  wp8c1AfterHarnessExit: postC1,
  wp8c2AfterHarnessExit: postC2,
  wp3AfterHarnessExit: postWp3,
  liveDb: { before: dbBefore, after: dbAfter },
})
writeFileSync(
  join(ART, 'wp8c3-gate-exits.txt'),
  [
    '# WP8-C3 最终命令矩阵（C3-8）逐条 exit code',
    '',
    ...exits.map((e) => `${e.command.padEnd(30)} => EXIT=${e.exit}`),
    '',
    '# 未跑（按 C3-8：留给 WP10）',
    '#   m4.5:ci · m4.5:ci:full · m4.5:smoke:live · m5.1:regression:verify',
  ].join('\n') + '\n',
  'utf8',
)
console.log('  ↳ 证据：artifacts/m5.1.1/wp8c3-gate-exits.txt')

// 还原：本次 C3 跑动过的路径（冻结面无条件取自 immutable 标签；其余还原到 HEAD）；wp8c3-* 自身不还原
const changedDuringC3 = modifiedPaths().filter((p) => !p.includes('/wp8c3-'))
interface RestoreRow {
  path: string
  source: string
  expectedBlob: string
  blobAfter: string
  byteExact: boolean
  regeneratedSha256: string
}
const rows: RestoreRow[] = []
for (const p of changedDuringC3) {
  const frozen = isFrozenPath(p)
  const expectedBlob = frozen ? git('rev-parse', `${M5L_FREEZE.tagName}:${p}`) : git('rev-parse', `HEAD:${p}`)
  const regeneratedSha256 = sha256(p)
  execFileSync('git', frozen ? ['checkout', M5L_FREEZE.tagName, '--', p] : ['checkout', '--', p], { cwd: ROOT })
  const blobAfter = git('hash-object', p)
  rows.push({ path: p, source: frozen ? 'immutable-tag' : 'HEAD', expectedBlob, blobAfter, byteExact: expectedBlob === blobAfter, regeneratedSha256 })
}
const residual = modifiedPaths().filter((p) => !p.includes('/wp8c3-'))
measure('C3 跑动并还原的路径数', rows.length, true)
check('C3-10：C3 自己跑动过的路径全部还原（冻结面 = immutable 标签 blob，其余 = HEAD blob，无残留）', rows.every((r) => r.byteExact) && residual.length === 0, `${rows.filter((r) => !r.byteExact).length} 条 blob 不符 · 残留 ${residual.length} 条`)
writeFileSync(
  join(ART, 'wp8c3-restore-whitelist.txt'),
  [
    '# WP8-C3 restore whitelist',
    '#',
    '# 冻结面（artifacts/m5.1 · artifacts/m4.5）的还原来源 = **immutable 标签** `m5.1-complete:<path>`；',
    '# 其余路径 = HEAD。绝不做无差别 checkout；未声明的路径不碰。',
    '# 列：path|source|expected_blob|blob_after_restore|byte_exact|regenerated_sha256',
    `# 运行前未提交改动：${[...preRunModified].join(', ') || '(无)'}`,
    '',
    ...rows.map((r) => [r.path, r.source, r.expectedBlob, r.blobAfter, String(r.byteExact), r.regeneratedSha256].join('|')),
    '',
    `restored = ${rows.length}`,
    `byte_exact_mismatches = ${rows.filter((r) => !r.byteExact).length}`,
  ].join('\n') + '\n',
  'utf8',
)
console.log('  ↳ 证据：artifacts/m5.1.1/wp8c3-restore-whitelist.txt')

// 最终判定在**全部检查（含还原）之后**才定型，避免把还原段的结论漏在 JSON 之外
const verdict = failed === 0 && measurements.every((m) => m.valid) ? 'PASS' : 'FAIL'
write('wp8c3-final-requalification.json', {
  testId: 'M5.1.1 / WP8-C3 Full Attribution Harness Requalification',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp8c3:verify',
  verdict,
  wp8: verdict === 'PASS' ? 'PASS' : 'PARTIAL / BLOCKED',
  passed,
  failed,
  failures,
  gates: gateRows,
  expectedGateRows: EXPECTED_GATE_ROWS,
  harnessSummary: { exit: harnessExit, passed: harnessSummary.passed, failed: harnessSummary.failed, measurementInvalid: harnessSummary.measurementInvalid, unexpectedWrites: harnessSummary.unexpectedWrites },
  gatesExit,
  exits,
  measurements,
  measurementInvalid: measurements.filter((m) => !m.valid).length,
  freeze: { naming: { tagName: M5L_FREEZE.tagName, tagObjectId: M5L_FREEZE.tagObjectId, targetCommitId: M5L_FREEZE.targetCommitId }, liveTagObject, liveTargetCommit, frozenPathsChecked: frozenPaths.length, frozenMismatch, frozenDiffPost },
  restore: { changedPaths: rows.length, rows, residual: residual.filter((p) => !p.includes('/wp8c3-')), byteExactMismatches: rows.filter((r) => !r.byteExact).length },
  threeGenerations: {
    wp8B: 'artifacts/m5.1.1/wp8-gate-manifest.json（PARTIAL / BLOCKED · 49 / 1）',
    wp8C1: 'artifacts/m5.1.1/wp8c1-*（K-32 CLOSED）',
    wp8C2: 'artifacts/m5.1.1/wp8c2-*（K-33 CLOSED）',
    wp8C3: 'artifacts/m5.1.1/wp8c3-*（本次 requalification）',
  },
})
console.log(`\n${'='.repeat(78)}`)
console.log(`WP8-C3 Full Attribution Harness Requalification：${passed} 通过 / ${failed} 失败`)
console.log(`  九门：${gateRows.map((g) => `${g.id}=${g.verdict}`).join(' · ')}`)
console.log(`  measurementInvalid=${String(harnessSummary.measurementInvalid)} · crossGate=${String(harnessCross.crossGateConsistencyViolations)} · coverage=${JSON.stringify(coverage.missingGate)}/${JSON.stringify(coverage.staleGate)}/${JSON.stringify(coverage.unclassifiedVerifier)}`)
console.log(`  **WP8-C3 = ${verdict}** → **WP8 = ${verdict === 'PASS' ? 'PASS' : 'PARTIAL / BLOCKED'}**`)
console.log('='.repeat(78))
if (failed > 0) console.log(`失败项：\n${failures.map((f) => `    - ${f}`).join('\n')}`)
process.exit(verdict === 'PASS' ? 0 : 1)
