/**
 * M10（`L-M10-56`）—— **真实库不变量的可诊断读数**（`pnpm m10:realdb:invariant`）。
 *
 * ============================================================================
 *  它为什么存在：一次**说不清**的读数
 * ============================================================================
 * WP11 轮次收尾时读到过一次 `identical=false`（真实库树摘要），**无法复现**。
 * 当时的读数只有两个东西：`identical=false` 与 `files=1211`。
 * **它没有告诉我"哪个文件变了"** —— 于是一条真实的异常变成了一句"解释不了"。
 *
 * ⇒ 本工具把那条读数做成**可诊断**的：
 * ```text
 * 读两遍（或 N 遍），**逐文件**比对 sha256
 * 一致   ⇒ 报聚合摘要（并与 --expected 比对，若给了）
 * 不一致 ⇒ **逐条列出哪个文件变了**，判定 MEASUREMENT INVALID（不是 PASS 也不是 FAIL）
 * ```
 *
 * ============================================================================
 *  它与 `digestTree` 的关系
 * ============================================================================
 * 聚合公式**逐字相同**（`rel\tsize\tcontentHash\n` 排序后 sha256，排除
 * `VOLATILE_EXCLUDED_PATHS`）⇒ 本工具报的聚合与 `digestTree('data/pglite')` **可比**。
 * 差别只有一个：本工具**保留每文件的哈希**，因此能回答"哪个文件变了"。
 *
 * ⚠️ **它不开库**：只读字节，不取租约（取租约是"打开"的前置，而打开会写
 * `pg_control`/WAL）。⇒ 它**不**能替代 `verify-m4-real-db` 那类**只读验收脚本**的租约纪律；
 * 它的用途是"在我没开库的前提下，证明这棵树在我观察窗口内**没变**"。
 *
 * ⚠️ 它**不**修改任何东西：零写入、零数据库打开、零出网。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { VOLATILE_EXCLUDED_PATHS } from '../src/infrastructure/persistence/production-db-safety.ts'

const REPO_ROOT = resolve(process.cwd())

function phase(mark: string): void {
  console.error(`[m10-realdb] ${mark}`)
}

interface Check {
  group: 'V'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []
function record(
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ group: 'V', id, label, expected, actual, pass })
}

/** 递归列出相对路径（与 `digestTree` 同形：相对、排序、排除易失文件） */
function walkFiles(root: string, exclude: readonly string[], base = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = join(root, entry.name)
    const rel = relative(base, abs).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs, exclude, base))
    } else if (entry.isFile() && !exclude.includes(rel)) {
      out.push(rel)
    }
  }
  return out.sort()
}

interface Reading {
  readonly files: Map<string, { size: number; hash: string }>
  readonly aggregate: string
}

/** 一次读数：逐文件 sha256 + 与 `digestTree` 同公式的聚合 */
function readTree(root: string): Reading {
  const files = new Map<string, { size: number; hash: string }>()
  const lines: string[] = []
  for (const rel of walkFiles(root, VOLATILE_EXCLUDED_PATHS)) {
    const bytes = readFileSync(join(root, rel))
    const hash = createHash('sha256').update(bytes).digest('hex')
    files.set(rel, { size: bytes.length, hash })
    lines.push(`${rel}\t${String(bytes.length)}\t${hash}\n`)
  }
  return {
    files,
    aggregate: createHash('sha256').update(lines.join(''), 'utf8').digest('hex'),
  }
}

/** 两次读数之间的**逐文件**差异（这正是当初缺的那条读数） */
function diffReadings(
  a: Reading,
  b: Reading,
): { readonly onlyInA: string[]; readonly onlyInB: string[]; readonly changed: string[] } {
  const onlyInA: string[] = []
  const onlyInB: string[] = []
  const changed: string[] = []
  for (const [rel, info] of a.files) {
    const other = b.files.get(rel)
    if (other === undefined) onlyInA.push(rel)
    else if (other.hash !== info.hash) changed.push(`${rel}（${String(info.size)}B→${String(other.size)}B）`)
  }
  for (const rel of b.files.keys()) if (!a.files.has(rel)) onlyInB.push(rel)
  return { onlyInA, onlyInB, changed }
}

function argOf(flag: string): string | undefined {
  const hit = process.argv.find((arg) => arg.startsWith(`${flag}=`))
  return hit === undefined ? undefined : hit.slice(flag.length + 1)
}

function main(): void {
  const dbDir = join(REPO_ROOT, 'data', 'pglite')
  const expected = argOf('--expected')
  const reads = Number(argOf('--reads') ?? '2')

  phase(`read ${String(reads)}x: ${dbDir}`)

  /* 材料在场：目录不存在 ⇒ MEASUREMENT INVALID（不是"没有变化"） */
  record(
    'V0',
    '**材料在场**：真实库目录存在（不存在时"没有变化"没有意义）',
    '目录存在',
    existsSync(dbDir) ? '存在' : '**缺失**',
    existsSync(dbDir),
  )

  const readings: Reading[] = []
  for (let index = 0; index < Math.max(2, reads); index += 1) readings.push(readTree(dbDir))

  /* V1 · 文件集合在观察窗口内不变 */
  const setDiffs = readings.slice(1).map((reading) => diffReadings(readings[0]!, reading))
  const setChanged = setDiffs.some(
    (diff) => diff.onlyInA.length > 0 || diff.onlyInB.length > 0,
  )
  record(
    'V1',
    '**观察窗口内文件集合不变**：N 次读数的相对路径集合**完全相同**'
      + '（多一个/少一个文件 = 目录被写过）',
    `${String(readings[0]!.files.size)} 个文件 · N 次一致`,
    setChanged
      ? `**集合发生变化**：${setDiffs
          .flatMap((diff) => [...diff.onlyInA.map((r) => `-${r}`), ...diff.onlyInB.map((r) => `+${r}`)])
          .slice(0, 5)
          .join(', ')}`
      : `${String(readings[0]!.files.size)} 个文件 · ${String(readings.length)} 次一致`,
    !setChanged && readings[0]!.files.size > 0,
  )

  /* V2 · **逐文件内容**在观察窗口内不变 —— 不一致时报 MEASUREMENT INVALID 并列出差异 */
  const changed = [...new Set(setDiffs.flatMap((diff) => diff.changed))]
  record(
    'V2',
    '**观察窗口内逐文件内容不变**（`L-M10-56` 缺的就是这条读数）：'
      + '不一致时**逐条列出哪个文件变了**，并判 `MEASUREMENT INVALID`'
      + ' —— **不报** `true` 也不报 `false`',
    '0 个文件变化',
    changed.length === 0
      ? `${String(readings[0]!.files.size)} 个文件全部未变（${String(readings.length)} 次读数）`
      : `**变化 ${String(changed.length)} 个**：${changed.slice(0, 6).join(', ')}`,
    changed.length === 0,
  )

  /* V3 · 非空泛 */
  record(
    'V3',
    '**`measured_count > 0` 自检**（"读了 0 个文件、0 处变化"与"全部未变"在输出上长得一样）',
    '文件数 > 0',
    `${String(readings[0]!.files.size)} 个文件`,
    readings[0]!.files.size > 0,
  )

  /* V4 · 与期望值比对（给了才判） */
  const aggregate = readings[0]!.aggregate
  if (expected === undefined) {
    record(
      'V4',
      '**与期望值比对**：未提供 `--expected=…` ⇒ 本门只判**不变性**，不判"等于某个值"'
        + '（如实登记，不假装判过）',
      '（未提供）',
      `聚合 = ${aggregate.slice(0, 16)}… · 只判不变性`,
      true,
    )
  } else {
    record(
      'V4',
      '**与期望值比对**：聚合摘要等于 `--expected`',
      expected.slice(0, 16) + '…',
      aggregate.slice(0, 16) + '…',
      aggregate === expected,
    )
  }

  const passed = checks.filter((check) => check.pass).length
  const failed = checks.length - passed
  /* 不一致 = MEASUREMENT INVALID（不是"失败"）—— 见 `L-M10-56` 的处置 */
  const verdict = !checks[0]!.pass || changed.length > 0 ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp11-realdb', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm10-realdb-invariant@1',
    runId,
    head,
    mode: 'offline' as const,
    semanticClaim: 'none' as const,
    /** ⚠️ 它**不开库**：只读字节、不取租约 */
    openedDatabase: false,
    reads: readings.length,
    files: readings[0]!.files.size,
    aggregate,
    expected: expected ?? null,
    changedFiles: changed,
    setDiff: setDiffs[0] ?? { onlyInA: [], onlyInB: [], changed: [] },
    checks,
    summary: { total: checks.length, passed, failed, verdict },
    disclaimer:
      '本工具只证明"这棵树在**我的观察窗口内**没变"。它不开库、不取租约，' +
      '因此**不**能替代只读验收脚本的租约纪律。',
  }
  writeFileSync(join(dir, 'realdb-invariant.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp11',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'realdb-invariant',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'L-M10-56 的处置：真实库不变量改成**连读 N 次 + 逐文件比对**，' +
      '不一致时列出哪个文件变了并判 MEASUREMENT INVALID。⚠️ 不开库、不取租约、不主张语义。',
    databaseScope: 'read-only-bytes',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label}`)
    console.log(`      期望 ${check.expected} · 实测 ${check.actual}`)
  }
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  console.log(`聚合 = ${aggregate}`)
  if (changed.length > 0) console.log(`⚠️ 变化的文件：${changed.join(', ')}`)
  process.exit(verdict === 'PASS' ? 0 : 1)
}

main()
