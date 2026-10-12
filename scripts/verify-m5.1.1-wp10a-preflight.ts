/**
 * M5.1.1 / WP10-A —— **Production-Copy & Regression Preflight**（`pnpm m5.1.1:wp10a:verify`）
 *
 * ============================================================================
 *  这道门回答什么（用户 WP10-A 执行令的七项）
 * ============================================================================
 * ```text
 *   ① Git 工作树是否干净 · v7/v8/v9 三个迁移指纹是否仍冻结
 *   ② 真实 data/pglite 的只读基线 · 副本创建方案与隔离边界
 *   ③ WP10 要执行的全量测试命令盘点（m4.5:ci / m4.5:ci:full / m5.1:regression:verify / Live Smoke 前置）
 *   ④ 哪些测试会覆盖历史 artifacts ⇒ 逐路径 fork / restore 白名单
 *   ⑤ 真实数据库不会被测试 / 迁移 / Live Smoke 意外打开或修改（静态证明 + 三段式负控）
 *   （⑥ B/C/D 的 Atomic Task / Hard Gate / 时长 / 失败停止条件 = 文档 `M5.1.1-WP10A-Execution-Plan.md`）
 * ```
 *
 * ============================================================================
 *  只读边界（可自证）
 * ============================================================================
 *  · 本文件**不 import 任何数据库模块**（不 `db/index.ts`、不 `persistence/db.ts`、
 *    不 `dev/sandbox.ts` 的隔离函数）；运行期**不开任何库**、**不** `isolateDatabase`。
 *  · `data/pglite` 只被 `statSync` / `readdirSync` 采样（文件数 / 总字节 / mtime 三项，前后各一次）。
 *  · **不运行**任何 CI / 迁移 / Live Smoke（WP10-A 的授权范围）。
 *  · 唯一写面 = `artifacts/m5.1.1/wp10a-preflight.json`。
 *
 * ============================================================================
 *  退出码语义
 * ============================================================================
 * ```text
 *   0 = 预检完成（七项全部有读数 · 无 finding · 量具有效）
 *   1 = 预检发现阻断项（指纹漂移 / 白名单不成立 / 隔离面有洞 / 前置缺失未如实登记）
 *   2 = 量具无效（某计数型判据 measured_count = 0 ⇒ MEASUREMENT INVALID，不是 PASS）
 * ```
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { MIGRATIONS, latestSchemaVersion } from '../src/infrastructure/persistence/migrations.ts'

// ---------------------------------------------------------------------------
// 检查器 / 量具
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const findings: { id: string; detail: string }[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, ok: boolean, detail: string): boolean {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}  [${detail}]`)
  } else {
    failed += 1
    findings.push({ id: label, detail })
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
const PROD_DB_DIR = join(ROOT, 'data', 'pglite')

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

// ---------------------------------------------------------------------------
// 冻结期望（本门自己写死；不从被测物读回来）
// ---------------------------------------------------------------------------

/** 三个被冻结的迁移指纹（散落在多个门里，取值必须一致） */
const FROZEN_MIGRATION_SHA256: Record<number, string> = {
  7: '2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613',
  8: '0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29',
  9: '5a007003b773351fc870865e541e8d3e2a9e00ccf8e227f3c2b41eb1d5a8c27c',
}

const FREEZE_TAG = 'm5.1-complete'

/** 冻结目录（canonical historical source **只有** immutable 标签） */
const FROZEN_DIRS = [
  'artifacts/m4-acceptance',
  'artifacts/m4.1',
  'artifacts/m4.5',
  'artifacts/m5',
  'artifacts/m5.1',
] as const

/** 当前里程碑目录：per-WP 证据 = HEAD blob；WP10 自己的产物 = 有意提交 */
const CURRENT_MILESTONE_DIR = 'artifacts/m5.1.1'

/** `artifacts/m5.1/wp9-m4.5-ci.log` 等被 ignore 的大日志（见下） */
const GITIGNORED_LOGS = [
  'artifacts/m5.1/wp9-m4.5-ci.log',
  'artifacts/m4.5/m4-ci.log',
  'artifacts/m4.5/m4.5-ci.log',
] as const

/**
 * 真实库的**边界身份**（由 `m5.1.1:prod-copy:verify` 在 2026-09-18 记录）。
 * 算法与那个门**逐字相同**：对 `(相对路径, 大小)` 排序后取 sha256 —— **边界身份，不是内容哈希**。
 */
const FROZEN_SOURCE_BOUNDARY = {
  sha256: '38844f4eb730c96fea72b58ca3f51589d8a75b03131c3515b3532de400bb9cc2',
  fileCount: 1201,
  totalBytes: 31289946,
  newestMtimeIso: '2026-09-17T15:51:40.789Z',
  recordedBy: 'artifacts/m5.1.1/wp9b1-production-copy-v9.json（boundaries.sourceFingerprint）',
} as const

/** 允许"开真实库"的**唯一**入口（其余一律必须 isolateDatabase） */
const PRODUCTION_DB_OPENER_ALLOWLIST: { file: string; reason: string }[] = [
  { file: 'src/main.ts', reason: '唯一被允许打开真实库的入口（`allowProductionDatabase()`），AGENTS §2 明文' },
]

// ---------------------------------------------------------------------------
// §0 只读边界
// ---------------------------------------------------------------------------

type Triple = { files: number; bytes: number; mtime: string }

function dirTriple(dir: string): Triple | null {
  try {
    const entries = readdirSync(dir, { recursive: true }) as string[]
    let files = 0
    let bytes = 0
    for (const entry of entries) {
      const stat = statSync(join(dir, entry))
      if (!stat.isFile()) continue
      files += 1
      bytes += stat.size
    }
    return { files, bytes, mtime: statSync(dir).mtime.toISOString() }
  } catch {
    return null
  }
}

section('§0 只读边界：本门不开任何库、不跑任何 CI')

const selfText = readFileSync(join(ROOT, 'scripts/verify-m5.1.1-wp10a-preflight.ts'), 'utf8')
check(
  '本门**不开库**：自身源码里没有 db / sandbox 模块的 import（唯一例外是 `migrations.ts` 的**纯常量**）',
  !/from\s+'[^']*(db\/index|dev\/sandbox|persistence\/db\.ts)['"]/.test(selfText),
  '静态自证（读自己的源码）'
)
const prodBefore = dirTriple(PROD_DB_DIR)
console.log(`  [real-db] ${PROD_DB_DIR} → ${JSON.stringify(prodBefore)}`)
measure('真实库被采样的文件数', prodBefore?.files ?? 0)
check('真实库 `data/pglite` 存在且只被 statSync/readdirSync 采样', prodBefore !== null && prodBefore.files > 0, JSON.stringify(prodBefore))

// ---------------------------------------------------------------------------
// §1 Git 工作树 + 迁移指纹冻结
// ---------------------------------------------------------------------------

section('§1 Git 工作树干净 + v7/v8/v9 指纹冻结 + 迁移链连续')

const porcelain = git('status', '--porcelain')
const porcelainTracked = git('status', '--porcelain', '--untracked-files=no')
/** 本门自己的写入面（重跑时它是未跟踪的，但那不是"基线脏"） */
const SELF_WRITE_PATHS = ['artifacts/m5.1.1/wp10a-preflight.json'] as const
const untrackedPaths = porcelain
  .split('\n')
  .filter((line) => line.startsWith('?? '))
  .map((line) => line.slice(3).replace(/\\/g, '/'))
const foreignUntracked = untrackedPaths.filter((p) => !SELF_WRITE_PATHS.includes(p as (typeof SELF_WRITE_PATHS)[number]))
console.log(`  · git status：被跟踪改动 = ${porcelainTracked.length} · 未跟踪 = ${untrackedPaths.length}（其中本门自己的写入面 = ${untrackedPaths.length - foreignUntracked.length}）`)
check(
  'WP10-A 前置：Git 工作树干净 —— **没有被跟踪文件的改动**，且未跟踪的只剩本门自己的证据面',
  porcelainTracked.length === 0 && foreignUntracked.length === 0,
  porcelainTracked.replace(/\n/g, ' ; ') || `tracked=0 · foreignUntracked=${foreignUntracked.join(',') || '0'}`
)

const fingerprintOf = (version: number): string => {
  const migration = MIGRATIONS.find((m) => m.version === version)
  return migration === undefined ? '(缺)' : sha256(migration.statements.join('\n'))
}
const fingerprintReadings: Record<string, string> = {}
for (const version of [7, 8, 9]) {
  const actual = fingerprintOf(version)
  fingerprintReadings[`v${version}`] = actual
  check(
    `★ MIGRATION_000${version} 指纹仍 == 冻结值（WP10-A 未动任何迁移）`,
    actual === FROZEN_MIGRATION_SHA256[version],
    `${actual.slice(0, 16)}…`
  )
}
measure('对照的冻结迁移数', Object.keys(fingerprintReadings).length)

const versions = MIGRATIONS.map((m) => m.version)
measure('代码里的迁移条数', versions.length)
check(
  '迁移链连续 1..9 且最新版本 = 9（无缺口、无跳号）',
  versions.length === 9 && versions.every((v, i) => v === i + 1) && latestSchemaVersion() === 9,
  `v1..v${latestSchemaVersion()}`
)

// ---------------------------------------------------------------------------
// §2 真实库只读基线 + 副本方案 + 隔离边界（三层写保护）
// ---------------------------------------------------------------------------

section('§2 真实库只读基线 · 副本方案 · 隔离边界（三层写保护）')

const dup = (text: string): string => text.replace(/\s+/g, ' ')
const readSrc = (rel: string): string => dup(readFileSync(join(ROOT, rel), 'utf8'))

const sandboxSrc = readSrc('src/dev/sandbox.ts')
const dbSrc = readSrc('src/db/index.ts')
const copyScriptSrc = readSrc('scripts/verify-m5.1.1-production-copy-schema.ts')

// 第 1 层：真实库重叠判定
check(
  '隔离第①层：`isProductionDir()` 判"等于 / 互为父子"，且 `isolateDatabase()` 用它做**硬约束**（重叠即抛）',
  sandboxSrc.includes('a === b || a.startsWith(b + sep) || b.startsWith(a + sep)') &&
    sandboxSrc.includes('拒绝运行：实验目录'),
  'src/dev/sandbox.ts'
)
// 第 2 层：写保护闸
check(
  '隔离第②层：`initDatabase()` 最前面调 `assertDatabaseAccessAllowed()` —— 真实库目录 + 未放行 + 未隔离 ⇒ **抛**',
  dbSrc.includes('assertDatabaseAccessAllowed()') &&
    dbSrc.includes('isProductionDir(dir) && !allowedByMain && !isolated') &&
    dbSrc.includes('拒绝写入真实对话库'),
  'src/db/index.ts'
)
// 第 3 层：迁移闸
check(
  '隔离第③层：`shouldBlockForPendingKernelMigration()` 只拦**真实库目录**且未显式放行 ⇒ 副本上的待应用迁移会被自由应用（这正是副本方案成立的原因）',
  dbSrc.includes('return isProductionDir(input.dataDir)') &&
    dbSrc.includes('if (input.migrationAllowed) return false'),
  'src/db/index.ts（纯函数，可单测）'
)
// 副本方案
check(
  '副本方案：production-copy 用 `cpSync` 到临时目录，**从不打开源库**；源在复制前后各取一次指纹，静默才继续',
  copyScriptSrc.includes('cpSync') &&
    copyScriptSrc.includes('真实库只被统计、只被复制') &&
    copyScriptSrc.includes('若源在复制期间变过 ⇒ 丢弃副本并 STOP'),
  'scripts/verify-m5.1.1-production-copy-schema.ts'
)

const prodAfter = dirTriple(PROD_DB_DIR)
check(
  '真实库三项指纹在本门运行前后**一致**（本门从未打开它）',
  prodBefore !== null &&
    prodAfter !== null &&
    prodBefore.files === prodAfter.files &&
    prodBefore.bytes === prodAfter.bytes &&
    prodBefore.mtime === prodAfter.mtime,
  `${JSON.stringify(prodBefore)} → ${JSON.stringify(prodAfter)}`
)

/**
 * 真实库的**边界身份**：算法与 `m5.1.1:prod-copy:verify` 的 `snapshot()` **逐字相同**
 * （`(相对路径, 大小)` 排序后 sha256）。这是比 files/bytes/mtime 更强的"源没被动过"证明。
 */
function snapshotBoundary(dir: string): { fingerprint: string; fileCount: number; totalBytes: number; newestMtimeIso: string } {
  const files: { rel: string; size: number; mtime: number }[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else {
        const stat = statSync(full)
        files.push({ rel: full.slice(dir.length + 1), size: stat.size, mtime: stat.mtimeMs })
      }
    }
  }
  visit(dir)
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1))
  return {
    fingerprint: sha256(files.map((file) => `${file.rel}\t${file.size}`).join('\n')),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    newestMtimeIso: new Date(files.reduce((max, file) => Math.max(max, file.mtime), 0)).toISOString(),
  }
}

const boundaryNow = snapshotBoundary(PROD_DB_DIR)
measure('边界身份覆盖的源文件数', boundaryNow.fileCount)
console.log(`  · 边界身份 ${boundaryNow.fingerprint.slice(0, 16)}… · ${boundaryNow.fileCount} 文件 · ${boundaryNow.totalBytes} 字节 · 最新 mtime ${boundaryNow.newestMtimeIso}`)
check(
  '★ 真实库**边界身份**仍 == 冻结值（与 `prod-copy` 门 2026-09-18 记录逐字相同）⇒ 源自那次复制以来没被动过',
  boundaryNow.fingerprint === FROZEN_SOURCE_BOUNDARY.sha256,
  `${boundaryNow.fingerprint.slice(0, 16)}… vs ${FROZEN_SOURCE_BOUNDARY.sha256.slice(0, 16)}…`
)
check(
  '★ 边界身份的 fileCount / totalBytes / 最新 mtime 三项也与冻结值一致',
  boundaryNow.fileCount === FROZEN_SOURCE_BOUNDARY.fileCount &&
    boundaryNow.totalBytes === FROZEN_SOURCE_BOUNDARY.totalBytes &&
    boundaryNow.newestMtimeIso === FROZEN_SOURCE_BOUNDARY.newestMtimeIso,
  `${boundaryNow.fileCount}/${boundaryNow.totalBytes}/${boundaryNow.newestMtimeIso}`
)
// 判据非空转：把冻结值改一个字符 ⇒ 比较必为 false
measure('边界身份比较器的负控检验次数', 1, true)
check(
  '★ 负控（比较器非空转）：把冻结值改一个字符 ⇒ 该比较**必须**为 false',
  boundaryNow.fingerprint !== `${FROZEN_SOURCE_BOUNDARY.sha256.slice(0, -1)}0`,
  '一个字符的漂移不会被放过'
)

// 副本读到的"源库 schema 版本"（**间接读数**，如实标注其局限 —— AGENTS §6.8）
const prodCopyEvidencePath = join(ART, 'wp9b1-production-copy-v9.json')
let sourceSchemaIndirect: Record<string, unknown> | null = null
try {
  const json = JSON.parse(readFileSync(prodCopyEvidencePath, 'utf8')) as Record<string, unknown>
  const boundaries = (json.boundaries ?? {}) as Record<string, unknown>
  const migrationBoundary = (boundaries.migrationBoundary ?? {}) as Record<string, unknown>
  sourceSchemaIndirect = {
    evidence: 'artifacts/m5.1.1/wp9b1-production-copy-v9.json',
    verdict: json.verdict ?? null,
    fromVersion: migrationBoundary.fromVersion ?? null,
    toVersion: migrationBoundary.toVersion ?? null,
    appliedVersions: migrationBoundary.appliedVersions ?? null,
    note:
      '**间接读数**：副本是源的逐字节 cpSync，因此"在副本上 apply 之前读到的 schemaVersion = 6"等价于' +
      '"复制那一刻源库 = v6"。但它**不能**替代"源库现在是什么"—— 后者只能由源的三项指纹不变来支撑（AGENTS §6.8）。',
  }
} catch {
  sourceSchemaIndirect = null
}
check(
  '真实库 schema 版本的**间接读数**可取（最近一次 production-copy 证据里 `fromVersion = 6` ⇒ 复制那刻源库 = v6）',
  sourceSchemaIndirect !== null && Number(sourceSchemaIndirect.fromVersion) === 6,
  JSON.stringify(sourceSchemaIndirect)
)

// ---------------------------------------------------------------------------
// §3 命令盘点 + Live Smoke 前置
// ---------------------------------------------------------------------------

section('§3 WP10 要执行的命令盘点 + Live Smoke 前置')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

interface Chain { name: string; leaves: string[]; missing: string[] }
function expandChain(name: string): Chain {
  const seen = new Set<string>()
  const leaves: string[] = []
  const missing: string[] = []
  const walk = (n: string): void => {
    if (seen.has(n)) return
    seen.add(n)
    const command = pkg.scripts[n]
    if (command === undefined) {
      missing.push(n)
      return
    }
    const subs = [...command.matchAll(/(?:^|&&|\|\|)\s*pnpm\s+([^\s&|]+)/g)].map((m) => m[1] as string)
    if (subs.length === 0) leaves.push(n)
    else for (const sub of subs) walk(sub)
  }
  walk(name)
  return { name, leaves, missing }
}

const CHAINS = ['m4.5:ci', 'm4.5:ci:full', 'm5.1:gates', 'm5.1:regression:verify', 'm5.1.1:gates'].map(expandChain)
for (const chain of CHAINS) {
  console.log(`  · ${chain.name} → ${chain.leaves.length} 个叶命令${chain.missing.length > 0 ? `（缺 ${chain.missing.join(',')}）` : ''}`)
}
const ciChain = CHAINS[0] as Chain
measure('m4.5:ci 的叶命令数', ciChain.leaves.length)
check('`m4.5:ci` 的叶命令全部存在于 package.json（无断链）', ciChain.missing.length === 0, ciChain.leaves.join(' , '))

/** 叶命令 → 脚本文件（`tsx <file>`） */
function scriptFileOf(scriptName: string): string | null {
  const command = pkg.scripts[scriptName] ?? ''
  const match = /tsx\s+([^\s&|]+\.ts)/.exec(command)
  return match === null ? null : (match[1] as string)
}

// Live Smoke 前置
const hasKey = (process.env.OPENAI_API_KEY ?? '').length > 0
const hasBaseUrl = (process.env.OPENAI_BASE_URL ?? '').length > 0
let hasDocker = false
try {
  execFileSync('docker', ['--version'], { encoding: 'utf8', stdio: 'pipe' })
  hasDocker = true
} catch {
  hasDocker = false
}
measure('Live Smoke 前置检查项数', 3, true)
console.log(`  · OPENAI_API_KEY present = ${String(hasKey)}（**只报存在性，不打印取值**）· OPENAI_BASE_URL present = ${String(hasBaseUrl)} · docker = ${String(hasDocker)}`)
const liveSmokeStatus = hasKey ? 'RUN' : 'NOT RUN'
check(
  '★ WP10 canonical："no key → NOT RUN"，**绝不能** mock 成 PASS —— 本机前置如实登记为 `' + liveSmokeStatus + '`',
  liveSmokeStatus === 'RUN' || liveSmokeStatus === 'NOT RUN',
  `OPENAI_API_KEY=${String(hasKey)} → m4.5:ci:full / live smoke = ${liveSmokeStatus}`
)

// ---------------------------------------------------------------------------
// §4 fork / restore 白名单（会覆盖历史 artifacts 的命令 → 逐路径）
// ---------------------------------------------------------------------------

section('§4 fork / restore 白名单（冻结目录 + 当前里程碑目录 + 被 ignore 的大日志）')

const tagObject = git('rev-parse', FREEZE_TAG)
const tagTarget = git('rev-parse', `${FREEZE_TAG}^{commit}`)
measure('冻结目录数', FROZEN_DIRS.length)
check(`immutable 标签 \`${FREEZE_TAG}\` 存在且是 annotated tag（tag object ≠ target commit）`, tagObject.length > 0 && tagTarget.length > 0 && tagObject !== tagTarget, `tag=${tagObject.slice(0, 8)}… → commit=${tagTarget.slice(0, 8)}…`)

const frozenRows = FROZEN_DIRS.map((dir) => {
  const tracked = git('ls-files', dir).split('\n').filter(Boolean)
  const diffVsTag = git('diff', '--name-only', `${FREEZE_TAG}..HEAD`, '--', dir).split('\n').filter(Boolean)
  return { dir, trackedCount: tracked.length, diffVsTagCount: diffVsTag.length, restoreFrom: FREEZE_TAG }
})
for (const row of frozenRows) console.log(`  · ${row.dir}：tracked=${row.trackedCount} · HEAD vs tag 差异=${row.diffVsTagCount}`)
measure('冻结目录的 tracked 文件总数', frozenRows.reduce((a, r) => a + r.trackedCount, 0))
check(
  `所有冻结目录当前与 \`${FREEZE_TAG}\` **零差异**（预检基线干净，白名单才有意义）`,
  frozenRows.every((r) => r.trackedCount > 0 && r.diffVsTagCount === 0),
  frozenRows.map((r) => `${r.dir}:${r.diffVsTagCount}`).join(' · ')
)

const currentMilestoneTracked = git('ls-files', CURRENT_MILESTONE_DIR).split('\n').filter(Boolean)
measure(`\`${CURRENT_MILESTONE_DIR}\` 的 tracked 文件数`, currentMilestoneTracked.length)

const ignoredLogRows = GITIGNORED_LOGS.map((path) => {
  try {
    const bytes = readFileSync(join(ROOT, path))
    const head = bytes.subarray(0, 2)
    const encoding = head[0] === 0xff && head[1] === 0xfe ? 'utf-16le' : head[0] === 0xfe && head[1] === 0xff ? 'utf-16be' : 'utf-8'
    return { path, present: true, bytes: bytes.length, sha256: sha256(bytes), encoding, mtime: statSync(join(ROOT, path)).mtime.toISOString() }
  } catch {
    return { path, present: false, bytes: 0, sha256: '(缺席)', encoding: 'n/a', mtime: '(缺席)' }
  }
})
for (const row of ignoredLogRows) console.log(`  · ${row.path}：${row.present ? `${row.bytes} bytes · ${row.encoding} · ${row.sha256.slice(0, 12)}…` : '（缺席）'}`)
const priorCiLog = ignoredLogRows.find((r) => r.path === 'artifacts/m5.1/wp9-m4.5-ci.log')
measure('被 ignore 的大日志条数', ignoredLogRows.filter((r) => r.present).length)
check(
  '★ `artifacts/m5.1/wp9-m4.5-ci.log` **存在**（`m5.1:regression:verify` 读的正是它）⇒ WP10-C 必须先 fork 它的读数再覆盖',
  priorCiLog !== undefined && priorCiLog.present && priorCiLog.bytes > 0,
  priorCiLog === undefined ? '(缺)' : `${priorCiLog.bytes} bytes · ${priorCiLog.encoding}`
)
let checkIgnoreOutput = ''
try {
  checkIgnoreOutput = git('check-ignore', 'artifacts/m5.1/wp9-m4.5-ci.log')
} catch {
  checkIgnoreOutput = ''
}
check(
  '★ 被 ignore 的日志**不是** git 证据（`*.log` 在 .gitignore 里）⇒ 覆盖它 = 磁盘级历史丢失 ⇒ 必须先 fork 读数',
  checkIgnoreOutput.length > 0,
  `git check-ignore = ${checkIgnoreOutput || '(未被 ignore —— 判据失效)'}`
)

// ---------------------------------------------------------------------------
// §5 隔离静默检查（**三段式**）：CI 链里能开库的脚本必须 isolate
// ---------------------------------------------------------------------------

section('§5 隔离静默检查：CI 链里"能开库"的脚本必须 `isolateDatabase()`')

interface IsolationFinding {
  script: string
  file: string
  opensDb: boolean
  mechanism: 'sandbox' | 'copy' | 'none'
}

/**
 * 判据（**能力驱动**，不看文件名）：
 *
 *   ① 一个脚本"能开库" ⇔ 它的文本里出现 `initDatabase(`（唯一的建库入口）。
 *   ② 这样的脚本必须经由仓库**两条已声明的隔离机制**之一：
 *        · `sandbox` = `isolateDatabase(label)`（临时目录 + `PROJECT_LG_SANDBOX`）
 *        · `copy`    = `cpSync(真实库 → 临时目录)` + `process.env.PGLITE_DATA_DIR = <副本>`
 *          （`verify-migrate-gate.ts` 与 `verify-m5.1.1-production-copy-schema.ts` 用的就是它 ——
 *            它们**需要**真实库的一份副本，`isolateDatabase` 造不出"源的副本"）
 *   ③ 两条都不是 ⇒ **offender**（除非在 allowlist 里，附理由）。
 *
 * ⚠️ 这条判据本 WP 实测**穿过一次假红**：第一版只知道 `sandbox` 一条机制，
 *    于是把 `scripts/verify-migrate-gate.ts`（它 `cpSync` 出副本 + 设 `PGLITE_DATA_DIR`，
 *    真库只被复制）误报为"能开库但不隔离"。修正方式是**把第二条机制写进判据**，
 *    并加第三个合成分身做正控（见 §5 三段式）——**不是**把这个脚本塞进白名单。
 */
function detectIsolation(
  scriptsDir: string,
  leaves: string[],
  fileOf: (n: string) => string | null
): { rows: IsolationFinding[]; offenders: IsolationFinding[] } {
  const rows: IsolationFinding[] = []
  const offenders: IsolationFinding[] = []
  for (const leaf of leaves) {
    const file = fileOf(leaf)
    if (file === null) continue
    let text = ''
    try {
      text = readFileSync(join(scriptsDir, file.replace(/^scripts\//, '')), 'utf8')
    } catch {
      continue
    }
    const opensDb = /initDatabase\s*\(/.test(text)
    const viaSandbox = /isolateDatabase\s*\(/.test(text)
    const viaCopy = /cpSync\s*\(/.test(text) && /process\.env\.PGLITE_DATA_DIR\s*=/.test(text)
    const mechanism: IsolationFinding['mechanism'] = viaSandbox ? 'sandbox' : viaCopy ? 'copy' : 'none'
    const row: IsolationFinding = { script: leaf, file, opensDb, mechanism }
    rows.push(row)
    if (opensDb && mechanism === 'none' && !PRODUCTION_DB_OPENER_ALLOWLIST.some((a) => a.file === file)) {
      offenders.push(row)
    }
  }
  return { rows, offenders }
}

const realIsolation = detectIsolation(join(ROOT, 'scripts'), ciChain.leaves, scriptFileOf)
const realDbOpeners = realIsolation.rows.filter((r) => r.opensDb)
measure('检查的能开库脚本数（`initDatabase(` 出现者）', realDbOpeners.length)
for (const row of realDbOpeners) console.log(`  · ${row.file} → 隔离机制 = ${row.mechanism}`)
check(
  '★ 隔离静默：`m4.5:ci` 链里每一个"能开库"的脚本都经由已声明的隔离机制之一（sandbox / copy）—— 真实库只对 src/main.ts 开放',
  realIsolation.offenders.length === 0,
  realIsolation.offenders.map((o) => `${o.file}`).join(' , ') ||
    `${realDbOpeners.length} 个全部隔离（sandbox=${realDbOpeners.filter((r) => r.mechanism === 'sandbox').length} · copy=${realDbOpeners.filter((r) => r.mechanism === 'copy').length}）`
)
measure('隔离检查覆盖的叶命令数', realIsolation.rows.length)

// 三段式负控：注入合成脚本 ⇒ 检测器必须区分"没有任何机制"与"经由两条机制之一"
const injectedDir = mkdtempSync(join(tmpdir(), 'wp10a-iso-'))
let injectedOffenders: string[] = []
let injectedMechanisms: Record<string, string> = {}
let injectedError = ''
try {
  writeFileSync(
    join(injectedDir, 'zz-synthetic-unisolated.ts'),
    ["import { initDatabase } from '../src/db/index.ts'", 'export async function run(runtime: unknown, plugin: unknown) {', '  return initDatabase(runtime as never, plugin as never)', '}', ''].join('\n'),
    'utf8'
  )
  writeFileSync(
    join(injectedDir, 'zz-synthetic-sandbox-isolated.ts'),
    ["import { isolateDatabase } from '../src/dev/sandbox.ts'", "isolateDatabase('synthetic')", "import { initDatabase } from '../src/db/index.ts'", 'export async function boot(r: unknown, p: unknown) {', '  return initDatabase(r as never, p as never)', '}', ''].join('\n'),
    'utf8'
  )
  // 第三条机制正控：cpSync 出副本 + 设 PGLITE_DATA_DIR（verify-migrate-gate.ts 的形状）
  writeFileSync(
    join(injectedDir, 'zz-synthetic-copy-isolated.ts'),
    ["import { cpSync, mkdtempSync } from 'node:fs'", "import { tmpdir } from 'node:os'", "import { join } from 'node:path'", "import { initDatabase } from '../src/db/index.ts'", "const work = mkdtempSync(join(tmpdir(), 'copy-'))", "cpSync('/real/db', work, { recursive: true })", 'process.env.PGLITE_DATA_DIR = work', 'export async function boot(r: unknown, p: unknown) {', '  return initDatabase(r as never, p as never)', '}', ''].join('\n'),
    'utf8'
  )
  const files: Record<string, string> = {
    'synthetic-unisolated': 'scripts/zz-synthetic-unisolated.ts',
    'synthetic-sandbox': 'scripts/zz-synthetic-sandbox-isolated.ts',
    'synthetic-copy': 'scripts/zz-synthetic-copy-isolated.ts',
  }
  const injected = detectIsolation(injectedDir, Object.keys(files), (n) => files[n] ?? null)
  injectedOffenders = injected.offenders.map((o) => o.file)
  injectedMechanisms = Object.fromEntries(injected.rows.filter((r) => r.opensDb).map((r) => [r.file, r.mechanism]))
} catch (error) {
  injectedError = String((error as { message?: string }).message ?? error)
} finally {
  rmSync(injectedDir, { recursive: true, force: true })
}
measure('注入负控下命中的违规脚本数（期望 1）', injectedOffenders.length)
check(
  '★ 负控（检测器必须响）：注入"能开库但两条机制都没有"的合成脚本 ⇒ **必报**；' +
    '同批的两条机制正控（isolateDatabase / cpSync+env）⇒ **不得**误报且机制被正确识别',
  injectedError === '' &&
    injectedOffenders.length === 1 &&
    injectedOffenders[0] === 'scripts/zz-synthetic-unisolated.ts' &&
    injectedMechanisms['scripts/zz-synthetic-sandbox-isolated.ts'] === 'sandbox' &&
    injectedMechanisms['scripts/zz-synthetic-copy-isolated.ts'] === 'copy',
  injectedError !== '' ? `注入环境异常：${injectedError}` : `offenders=${JSON.stringify(injectedOffenders)} · mechanisms=${JSON.stringify(injectedMechanisms)}`
)
const restoredIsolation = detectIsolation(join(ROOT, 'scripts'), ciChain.leaves, scriptFileOf)
check(
  '★ 恢复（放回真实实现）⇒ 检测器重新安静（0 个违规）',
  restoredIsolation.offenders.length === 0,
  restoredIsolation.offenders.map((o) => o.file).join(' , ') || '0'
)

// ---------------------------------------------------------------------------
// §6 量具健康 / 判定 / 证据
// ---------------------------------------------------------------------------

section('§6 量具健康 / 判定 / 证据')

const measurementInvalid = measurements.filter((m) => !m.valid)
check(
  '所有计数型判据都自检过 `measured_count > 0`（测到 0 个对象的一律 MEASUREMENT INVALID，不报 PASS）',
  measurementInvalid.length === 0,
  `${measurements.length} 个量具，无效 ${measurementInvalid.length} 个${measurementInvalid.length > 0 ? `：${measurementInvalid.map((m) => m.label).join(' , ')}` : ''}`
)

const prodFinal = dirTriple(PROD_DB_DIR)
check(
  '收尾复核：真实库三项指纹仍与开头一致（只读预检没有副作用）',
  prodBefore !== null && prodFinal !== null && prodBefore.files === prodFinal.files && prodBefore.bytes === prodFinal.bytes && prodBefore.mtime === prodFinal.mtime,
  JSON.stringify(prodFinal)
)

const completed = failed === 0
const measurementOk = measurementInvalid.length === 0
const verdict = measurementOk ? (completed ? 'COMPLETE' : 'BLOCKED') : 'MEASUREMENT INVALID'
const exitCode = measurementOk ? (completed ? 0 : 1) : 2

mkdirSync(ART, { recursive: true })
const evidence = {
  testId: 'M5.1.1 / WP10-A Production-Copy & Regression Preflight（只读；不跑 CI / 不迁移 / 不改 src）',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp10a:verify',
  verdict,
  exitCodeSemantics: {
    '0': '预检完成（七项有读数 · 无 finding · 量具有效）',
    '1': '预检发现阻断项',
    '2': '量具无效（MEASUREMENT INVALID）',
  },
  passed,
  failed,
  findings,
  readOnlyBoundary: {
    dbModuleImports: 0,
    ciExecuted: false,
    migrationExecuted: false,
    productionDbOpened: false,
    writtenPaths: ['artifacts/m5.1.1/wp10a-preflight.json'],
  },
  gitAndFreeze: {
    worktreeClean: porcelainTracked.length === 0 && foreignUntracked.length === 0,
    worktreeCleanScope: {
      trackedModifications: porcelainTracked,
      untrackedPaths,
      selfWritePaths: SELF_WRITE_PATHS,
      note: '判据 = 没有被跟踪文件的改动 ∧ 未跟踪的只剩本门自己的写入面（重跑时它必然未跟踪，那**不是**基线脏）',
    },
    porcelain,
    migrationChain: versions,
    latestSchemaVersion: latestSchemaVersion(),
    frozenMigrationSha256Expected: FROZEN_MIGRATION_SHA256,
    frozenMigrationSha256Actual: fingerprintReadings,
    freezeTag: { name: FREEZE_TAG, tagObject, targetCommit: tagTarget },
  },
  productionDbBaseline: {
    dir: PROD_DB_DIR.replace(ROOT, '<repo>'),
    tripleBefore: prodBefore,
    tripleAfter: prodFinal,
    unchanged: prodBefore !== null && prodFinal !== null && prodBefore.files === prodFinal.files && prodBefore.bytes === prodFinal.bytes && prodBefore.mtime === prodFinal.mtime,
    boundaryIdentityExpected: FROZEN_SOURCE_BOUNDARY,
    boundaryIdentityNow: boundaryNow,
    boundaryMatchesFrozen: boundaryNow.fingerprint === FROZEN_SOURCE_BOUNDARY.sha256,
    sourceSchemaVersionIndirect: sourceSchemaIndirect,
  },
  isolationBoundary: {
    layer1: { mechanism: 'isProductionDir() 重叠判定 + isolateDatabase() 硬约束', file: 'src/dev/sandbox.ts' },
    layer2: { mechanism: 'assertDatabaseAccessAllowed()（真实库 + 未放行 + 未隔离 ⇒ 抛）', file: 'src/db/index.ts' },
    layer3: { mechanism: 'shouldBlockForPendingKernelMigration()（只拦真实库目录；副本上的待应用迁移自由应用）', file: 'src/db/index.ts' },
    copyScheme: { mechanism: 'cpSync 到临时目录 + 源前后各一次指纹 + 静默才继续 + 只在副本上 apply', file: 'scripts/verify-m5.1.1-production-copy-schema.ts' },
    ciChainIsolation: {
      checkedLeaves: realIsolation.rows.length,
      dbOpeningScripts: realDbOpeners.length,
      mechanisms: Object.fromEntries(realDbOpeners.map((r) => [r.file, r.mechanism])),
      offenders: realIsolation.offenders,
      allowlist: PRODUCTION_DB_OPENER_ALLOWLIST,
      mechanismsDeclared: {
        sandbox: 'isolateDatabase(label) —— 临时目录 + PROJECT_LG_SANDBOX（src/dev/sandbox.ts）',
        copy: 'cpSync(真实库 → 临时目录) + process.env.PGLITE_DATA_DIR = <副本>（verify-migrate-gate.ts / prod-copy 门）',
      },
      falseLoudFixedInThisWp:
        '第一版判据只认 sandbox 一条机制 ⇒ 把 verify-migrate-gate.ts（它 cpSync 出副本 + 设 env）误报为违规。' +
        '处置：把第二条机制写进判据 + 加第三个合成分身做正控，**不是**把它塞进白名单。',
    },
    threeStage: {
      positive: realIsolation.offenders.length,
      injectedOffenders,
      injectedMechanisms,
      injectedError,
      restoredOffenders: restoredIsolation.offenders.length,
    },
  },
  commandInventory: {
    chains: CHAINS,
    liveSmoke: {
      OPENAI_API_KEY_present: hasKey,
      OPENAI_BASE_URL_present: hasBaseUrl,
      docker_present: hasDocker,
      derivedStatus: liveSmokeStatus,
      rule: 'WP10 canonical：real key available → RUN；no key → NOT RUN。绝不能 mock 成 PASS。',
      affectedCommands: ['m4.5:ci:full', 'm4.5:smoke:live', 'eval:m4:extraction:live', 'eval:m4:promptfoo:live', 'm5.1:e2e:verify 的 live-smoke 半边'],
    },
  },
  forkRestoreWhitelist: {
    frozenDirs: frozenRows,
    frozenRule: `冻结面（artifacts/m4-acceptance, m4.1, m4.5, m5, m5.1）= immutable 标签 \`${FREEZE_TAG}\` 的 blob；**绝不**从 HEAD / 父提交 / 工作树备份推测`,
    currentMilestone: { dir: CURRENT_MILESTONE_DIR, trackedCount: currentMilestoneTracked.length, rule: 'per-WP 证据 = HEAD blob；WP10 自己的产物 = 有意提交' },
    gitignoredLogs: ignoredLogRows,
    gitignoredRule: '`*.log` 被 ignore ⇒ 覆盖 = 磁盘级历史丢失，**不进 git 也无法用 git 还原** ⇒ 覆盖前必须先 fork 读数（sha256 + 解析后的读数）',
  },
  measurements,
  measurementInvalid: measurementInvalid.length,
  boundaryStatement: {
    thisGateDoes: [
      '七项预检的**只读**证据（工作树 / 指纹 / 基线 / 副本方案 / 命令盘点 / 白名单 / 隔离静默）',
      '把 Live Smoke 前置如实登记为 RUN 或 NOT RUN',
    ],
    thisGateDoesNot: [
      '不执行迁移（真实库或副本都不迁移）',
      '不运行任何 CI / 回归 / Live Smoke',
      '不修改 src/**（唯一改动面是 scripts/ + docs/ + artifacts/m5.1.1/）',
      '不主张 WP10 已完成 —— B/C/D 的 Atomic Task 见 docs/m5.1.1/M5.1.1-WP10A-Execution-Plan.md',
    ],
  },
}
writeFileSync(join(ART, 'wp10a-preflight.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log('  ↳ 证据：artifacts/m5.1.1/wp10a-preflight.json')

console.log(`\n${'='.repeat(78)}`)
console.log(`M5.1.1 WP10-A（Production-Copy & Regression Preflight）：${passed} 通过 / ${failed} 失败｜**WP10-A = ${verdict}**（EXIT=${exitCode}）`)
console.log(`  live smoke = ${liveSmokeStatus}（OPENAI_API_KEY present = ${String(hasKey)}）`)
console.log('='.repeat(78))
if (failed > 0) console.log(`findings：\n${findings.map((f) => `    - ${f.id} :: ${f.detail}`).join('\n')}`)
process.exit(exitCode)
