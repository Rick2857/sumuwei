/**
 * PostgreSQL 迁移：**`PG-G10` 切换就绪（只读审查）**。
 *
 * 契约逐字：`PG-G01…09 全 PASS；旧后端回归适用；恢复演练成功；Runbook、目标身份、停机估计与回滚条件完整`
 *
 * ============================================================================
 *  它是**只读聚合器**：不跑任何门、不连数据库、不改任何东西
 * ============================================================================
 * ```text
 *   它做的事：读**已落盘的证据** + 读**WP6 的四份文档**，然后把"切换就绪"这件事
 *             拆成可判定的条目，逐条给出 PASS / FAIL / **具名 notRun**。
 *   它不做的事：重跑门（那是 `gates:run --lane postgresql` 的事）。
 * ```
 *
 *  ⚠️ **选档不看 mtime**（仓库既有纪律，见 `m10.1-gate-select.ts` 与 `TD-23`）：
 *     按 `runId` 里的时间戳**字典序**取最新那一份。mtime 会被复制/检出/同步改掉，
 *     拿它选档等于"让文件系统决定用哪份证据"。
 *
 *  ⚠️ **两代证据形态**（如实区分，不假装一样）：
 *     · 新形态（G04/G05/G06/G07/G08/G09/bench/live-smoke）：有 `counts{measured,passed,failed,notRun}`
 *       ⇒ 可以直接断言"全过且分母非零"。
 *     · 旧形态（WP2/WP3 期的 G02/G03）：**逐场景一个 JSON**、没有 `counts`
 *       ⇒ 本门只断言"证据文件在案"，并在报告里**明说**这一条比新形态弱。
 *
 * 跑法：pnpm postgresql:g10:verify
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const EVIDENCE_ROOT = resolve('artifacts/post-lv2/postgresql-migration')
const DOCS = {
  activationCandidate: resolve('docs/post-lv2/PostgreSQL-Migration-Activation-Candidate.md'),
  runbook: resolve('docs/post-lv2/PostgreSQL-Migration-Runbook.md'),
  knownLimitations: resolve('docs/post-lv2/PostgreSQL-Migration-Known-Limitations.md'),
  gateDecision: resolve('docs/post-lv2/PostgreSQL-Migration-Gate-Decision.md'),
}

const checks: { name: string; pass: boolean; detail?: string }[] = []
const notRun: { id: string; what: string; why: string }[] = []
const observations: Record<string, unknown> = {}

function check(name: string, fn: () => void): void {
  try {
    fn()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

interface Evidence {
  dir: string
  file: string
  json: Record<string, unknown>
}

/** 按 `runId` 时间戳字典序取最新（**不看 mtime**） */
function newestEvidence(prefix: string, file: string): Evidence | undefined {
  if (!existsSync(EVIDENCE_ROOT)) return undefined
  const dirs = readdirSync(EVIDENCE_ROOT)
    .filter((name) => name.startsWith(prefix))
    .sort() // runId 里带 ISO 时间戳（`…-20261013T123856Z`）⇒ 字典序 = 时间序
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const full = resolve(EVIDENCE_ROOT, dirs[i], file)
    if (!existsSync(full)) continue
    try {
      return { dir: dirs[i], file, json: JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown> }
    } catch {
      /* 坏档跳过（下面按缺档报） */
    }
  }
  return undefined
}

function countsOf(evidence: Evidence | undefined): { measured: number; passed: number; failed: number; notRun: number } | undefined {
  const counts = evidence?.json.counts as { measured?: number; passed?: number; failed?: number; notRun?: number } | undefined
  if (counts === undefined) return undefined
  return {
    measured: Number(counts.measured ?? 0),
    passed: Number(counts.passed ?? 0),
    failed: Number(counts.failed ?? 0),
    notRun: Number(counts.notRun ?? 0),
  }
}

/** 一份"新形态"证据必须：分母非零 · 0 失败 · 0 未运行 */
function assertClean(label: string, evidence: Evidence | undefined): void {
  if (evidence === undefined) throw new Error(`${label}：找不到证据档`)
  const counts = countsOf(evidence)
  if (counts === undefined) throw new Error(`${label}：证据档没有 counts（旧形态？）`)
  if (counts.measured === 0) throw new Error(`${label}：measured_count = 0 ⇒ INVALID`)
  if (counts.failed > 0) throw new Error(`${label}：${counts.failed} 条失败（最新一份是 ${evidence.dir}）`)
  if (counts.notRun > 0) throw new Error(`${label}：${counts.notRun} 条未运行 ⇒ 不报 PASS`)
}

function main(): void {
  mkdirSync(EVIDENCE_ROOT, { recursive: true })

  // ---------------------------------------------------------------------
  // ① PG-G01…09（+ bench + 有限真模型）全 PASS
  // ---------------------------------------------------------------------
  const modern: { id: string; label: string; prefix: string; file: string }[] = [
    { id: 'PG-G04', label: 'SQL/仓储兼容', prefix: 'pg-migration-g04-', file: 'g04-evidence.json' },
    { id: 'PG-G05', label: '迁移完整性', prefix: 'pg-migration-g05-', file: 'g05-evidence.json' },
    { id: 'PG-G06', label: '投影与语义召回', prefix: 'pg-migration-g06-', file: 'g06-evidence.json' },
    { id: 'PG-G07', label: '在线备份恢复', prefix: 'pg-migration-g07-', file: 'g07-evidence.json' },
    { id: 'PG-G08', label: '功能整链与回归', prefix: 'pg-migration-g08-', file: 'g08-evidence.json' },
    { id: 'PG-G09', label: '量具有效性', prefix: 'pg-migration-g09-', file: 'g09-evidence.json' },
    { id: 'S8', label: '资源读数', prefix: 'pg-migration-bench-', file: 'bench-evidence.json' },
    { id: 'LIVE', label: '有限真模型 smoke', prefix: 'pg-migration-live-smoke-', file: 'live-smoke-evidence.json' },
  ]
  const seen: Record<string, { dir: string; counts: ReturnType<typeof countsOf> }> = {}
  for (const gate of modern) {
    const evidence = newestEvidence(gate.prefix, gate.file)
    seen[gate.id] = { dir: evidence?.dir ?? '(missing)', counts: countsOf(evidence) }
    check(`G10.1-${gate.id} ★ ${gate.id} ${gate.label}：最新证据全过且分母非零`, () => {
      assertClean(`${gate.id} ${gate.label}`, evidence)
    })
  }
  observations.modernGates = seen

  // 旧形态（G02/G03）：只断言"证据在案"，并**明说**这一条比新形态弱
  const legacy = [
    { id: 'PG-G02', dir: 'pg-migration-wp2-20261013T130636', files: ['real-postgres-init.json', 'account-separation.json', 'image-resolution.json', 'identity-mismatch-and-init-failure.json'] },
    { id: 'PG-G03', dir: 'pg-migration-wp3-20261013T134718', files: ['single-core-qualification.json', 'second-postgres-target-guard.json', 'server-restart-and-qualification.json', 'defect-fixes-verified.json'] },
  ]
  for (const gate of legacy) {
    const present = gate.files.filter((file) => existsSync(resolve(EVIDENCE_ROOT, gate.dir, file)))
    observations[`${gate.id}_evidence`] = { dir: gate.dir, present, expected: gate.files.length }
    check(`G10.2-${gate.id} ${gate.id}：证据在案（⚠️ **旧形态**：逐场景 JSON、无 counts ⇒ 本条只证"有档"）`, () => {
      if (present.length !== gate.files.length) {
        throw new Error(`${gate.id} 的证据缺档：${gate.files.filter((f) => !present.includes(f)).join(', ')}`)
      }
    })
  }

  // ---------------------------------------------------------------------
  // ② 源指纹一致（run 归属）：所有新形态证据必须记**同一个**来源快照
  // ---------------------------------------------------------------------
  const sources = new Set<string>()
  for (const gate of modern) {
    const evidence = newestEvidence(gate.prefix, gate.file)
    const source = evidence?.json.sourceSnapshot
    if (typeof source === 'string') sources.add(source)
  }
  observations.sourceSnapshots = [...sources]

  check('G10.3 ★ run 归属：所有门记的**来源快照**是同一个（不许"这份绿、那份比的是别的库"）', () => {
    if (sources.size === 0) throw new Error('一条来源快照都没读到')
    if (sources.size > 1) throw new Error(`出现了 ${sources.size} 个不同的来源快照：${[...sources].join(' / ')}`)
  })

  // ---------------------------------------------------------------------
  // ③ 恢复演练成功（读 G07 的证据，而不是重跑）
  // ---------------------------------------------------------------------
  const g07 = newestEvidence('pg-migration-g07-', 'g07-evidence.json')
  const restoreChecks = ((g07?.json.checks ?? []) as { name?: string; pass?: boolean }[]).filter((c) =>
    /恢复|备份/.test(String(c.name ?? ''))
  )
  observations.restoreDrill = { evidenceDir: g07?.dir ?? '(missing)', restoreChecks: restoreChecks.length, allPassed: restoreChecks.every((c) => c.pass === true) }

  check('G10.4 ★ 恢复演练成功：G07 证据里"备份/恢复"那一族判据**全部通过**', () => {
    if (g07 === undefined) throw new Error('找不到 G07 证据')
    if (restoreChecks.length < 5) throw new Error(`只找到 ${restoreChecks.length} 条备份/恢复判据 ⇒ 太少，判据没量到东西`)
    const failed = restoreChecks.filter((c) => c.pass !== true).map((c) => String(c.name))
    if (failed.length > 0) throw new Error(`有未通过的：${failed.join(' / ')}`)
  })

  // ---------------------------------------------------------------------
  // ④ WP6 的四份文档：存在 + 必需要素齐（"无待猜测生产命令"）
  // ---------------------------------------------------------------------
  const docSpecs: { key: keyof typeof DOCS; label: string; required: { what: string; pattern: RegExp }[] }[] = [
    {
      key: 'activationCandidate',
      label: 'Activation-Candidate',
      required: [
        { what: '冻结的镜像 digest', pattern: /sha256:[0-9a-f]{12,}/ },
        { what: '目标身份（库/用户/主机/端口）', pattern: /lg_trial|lg_test_|127\.0\.0\.1|55432/ },
        { what: '停机窗口估计（含实测构成）', pattern: /停机|窗口/ },
        { what: '回滚路线 R1', pattern: /R1/ },
        { what: '回滚路线 R2', pattern: /R2/ },
        { what: '前后验证', pattern: /验证/ },
      ],
    },
    {
      key: 'runbook',
      label: 'Runbook',
      required: [
        { what: '可复制粘贴的实际命令', pattern: /```(bash|powershell|sh)/ },
        { what: '绝对路径目标', pattern: /data[\\/]pglite|artifacts[\\/]/ },
        { what: '操作者检查项', pattern: /检查|核对/ },
        { what: '失败处置', pattern: /失败|拒收|回滚/ },
      ],
    },
    {
      key: 'knownLimitations',
      label: 'Known-Limitations',
      required: [
        { what: '不主张清单', pattern: /不主张|未证|NOT/ },
        { what: 'RPO / 备份周期如实记录', pattern: /RPO|备份周期|pg_dump/ },
      ],
    },
    {
      key: 'gateDecision',
      label: 'Gate-Decision',
      required: [
        { what: '门读数汇总', pattern: /PG-G0[1-9]|lane/ },
        { what: '判定与条件', pattern: /PASS|判定|条件/ },
      ],
    },
  ]
  const docReadings: Record<string, unknown> = {}
  for (const spec of docSpecs) {
    const path = DOCS[spec.key]
    const exists = existsSync(path)
    const text = exists ? readFileSync(path, 'utf8') : ''
    const missing = spec.required.filter((r) => !r.pattern.test(text)).map((r) => r.what)
    docReadings[spec.label] = { exists, bytes: text.length, missing }
    check(`G10.5-${spec.label} ★ ${spec.label}：存在且必需要素齐（缺一个就具名）`, () => {
      if (!exists) throw new Error(`文档不存在：${path}`)
      if (missing.length > 0) throw new Error(`缺这些要素：${missing.join(' · ')}`)
    })
  }
  observations.documents = docReadings

  // ---------------------------------------------------------------------
  // ⑤ 旧后端回归适用（PGlite 归属）—— 找不到证据就**具名 notRun**，不猜
  // ---------------------------------------------------------------------
  const legacyRegression = [
    resolve('artifacts/m4'),
    resolve('artifacts/m4.5'),
  ].filter((dir) => existsSync(dir))
  observations.legacyBackendEvidence = legacyRegression
  if (legacyRegression.length === 0) {
    notRun.push({
      id: 'g10.legacy-regression',
      what: '旧后端回归适用（PGlite 归属：`m4:restore:verify` 那一路）',
      why:
        '本门**没有**找到旧后端的证据目录（`artifacts/m4*`）⇒ 不猜、不当过。' +
        '要么在 WP6 里指明该证据的实际路径，要么显式裁定"由 m4.5:ci 的绿承担"',
    })
  } else {
    check('G10.6 旧后端回归适用：证据目录在案（⚠️ 本轮只证"在案"，具体门读数在 Runbook 里逐条列）', () => {
      if (legacyRegression.length === 0) throw new Error('没有旧后端证据目录')
    })
  }

  // ---------------------------------------------------------------------
  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const evidence = {
    gate: 'postgresql:g10:verify',
    scope: 'PG-G10 切换就绪（只读审查：G01…09 全 PASS · 旧后端回归适用 · 恢复演练 · WP6 文档完整）',
    atUtc: new Date().toISOString(),
    atUtc8: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`,
    selection: 'by-runId-lexicographic（**不看 mtime**）',
    checks,
    notRun,
    observations,
    counts: { measured: checks.length, passed, failed, notRun: notRun.length },
  }
  const outDir = resolve(EVIDENCE_ROOT, `pg-migration-g10-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, 'g10-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  JSON.parse(readFileSync(resolve(outDir, 'g10-evidence.json'), 'utf8'))

  console.log('')
  console.log('PG-G10 切换就绪（只读审查）')
  console.log('─'.repeat(86))
  console.log(`  选档：按 runId 字典序（**不看 mtime**）`)
  console.log(`  证据：${outDir.replace(`${process.cwd()}\\`, '')}`)
  console.log('─'.repeat(86))
  for (const c of checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (!c.pass && c.detail !== undefined) console.log(`        └─ ${c.detail}`)
  }
  console.log('─'.repeat(86))
  console.log(`  来源快照一致 : ${JSON.stringify([...sources])}`)
  console.log(`  恢复演练     : ${JSON.stringify(observations.restoreDrill)}`)
  console.log(`  文档         : ${JSON.stringify(observations.documents)}`)
  console.log('─'.repeat(86))
  console.log(`  断言        : ${passed}/${checks.length}`)
  console.log(`  未运行      : ${notRun.length}`)
  for (const entry of notRun) console.log(`      · ${entry.id} —— ${entry.what}（${entry.why}）`)
  console.log(`  measured_count = ${checks.length}`)
  console.log(`  失败总数 = ${failed}`)
  console.log('')

  if (checks.length === 0) {
    console.error('measured_count = 0 ⇒ INVALID（不得当绿用）')
    process.exitCode = 1
  } else if (failed > 0) {
    process.exitCode = 1
  } else if (notRun.length > 0) {
    console.error(`\n${notRun.length} 项未运行 ⇒ 本门**不报 PASS**。`)
    process.exitCode = 1
  }
}

main()
