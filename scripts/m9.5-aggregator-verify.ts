/**
 * M9.5 WP11 —— **聚合门自检**（`pnpm m9.5:aggregator:verify`）。
 *
 * ============================================================================
 *  它防的是哪一类错
 * ============================================================================
 * ```text
 * `pnpm m9.5:gates` 的"取最新档"规则（按 manifest 里**封存的** `startedAt`）**自己没有判据**：
 *   规则一旦坏成"按目录名排序"或"取第一个"，它会**静默取到旧档并报 PASS** ——
 *   而那正是聚合门存在的理由（"缺文件是 NOT RUN，不是 PASS"的同一族错误）。
 * ⇒ 本门**独立重演**一次选取（自己遍历 `artifacts/m9.5/<runId>/manifest.json`、
 *    按 `gateVersion` 归组、取 `startedAt` 最大者），再与聚合门的**实际选择**对账。
 *    ⚠️ 关键：这不是"读聚合门的输出再抄一遍" —— 是**两条独立路径**得到同一个答案。
 * ```
 * 另外两条：封存哈希**真的被算了**（`checked > 0` 且 `mismatched === 0`，防"0 检查 0 不一致"）、
 * 以及"取档规则**被真的行使过**"（有 ≥2 个候选的门才算数，否则判据是空转的）。
 * 用法：`pnpm m9.5:aggregator:verify`
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

import { sha256 } from './m4-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const GATE_VERSION = 'm9.5-aggregator@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const ARTIFACTS = join(REPO_ROOT, 'artifacts/m9.5')

let passed = 0
const failures: string[] = []
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` —— ${detail}`}`)
}

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function safeTreeDigest(): Record<string, unknown> | null {
  try {
    const digest = digestTree(REAL_DB_DIR)
    return { dir: 'data/pglite', measuredCount: digest.measuredCount, treeSha256: digest.treeSha256 }
  } catch (error) {
    return { dir: 'data/pglite', error: (error as Error).message }
  }
}

/** 聚合门**自己**的报告（它是一条 JSON 行） */
interface AggregatorReading {
  readonly gate: string
  readonly requiredNow: boolean
  readonly verdict: string
  readonly runId: string | null
  readonly detail?: {
    readonly startedAt?: string
    readonly candidates?: number
    readonly artifactHashesChecked?: number
    readonly artifactHashesMismatched?: readonly string[]
  }
}

function readAggregator(): AggregatorReading[] {
  /* ⚠️ Windows 上 `pnpm` 是 shim，`execFileSync('pnpm', …)` 起不来 ⇒ 走 shell 形式 */
  /*
   * ⚠️ **2026-09-29 修（发布档实测）**：聚合门在 **Hard Gates = FAIL** 时**会正常演出退出码 1**，
   *    而原先这里**直接抛错** ⇒ 本门**不落档** + 留下**悬空档** ⇒ 再去拖红
   *    `m9.5:regression:verify` 的 `no-dangling` 检查（级联）。
   *    ⚠️ 但**本门的职责是验证"取最新档"规则**（按封存的 `startedAt`），
   *    **不是**要求聚合判决为 PASS —— 别的门红导致聚合门 FAIL 是**正确行为**，不是本门要判的错。
   *    ⇒ 因此：**接受非零退出**，只要它仍然输出了那行 JSON（判决内容本身就是本门的输入）。
   */
  let output = ''
  try {
    output = execFileSync('pnpm m9.5:gates', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: true,
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    /* 非零退出：把 stdout 取出来继续用（JSON 行在退出前已经打出） */
    const stdout = (error as { stdout?: unknown }).stdout
    output = typeof stdout === 'string' ? stdout : ''
    if (output.trim() === '') throw error
  }
  const line = output
    .split(/\r?\n/)
    .filter((row) => row.trim().startsWith('{"schemaVersion":"m9.5-gates@1"'))
    .pop()
  if (line === undefined) throw new Error('聚合门没有输出 JSON 行')
  return (JSON.parse(line) as { readings: AggregatorReading[] }).readings
}

interface SealedManifest {
  readonly dir: string
  readonly gateVersion: string
  readonly startedAt: string
  readonly runId: string
}

/**
 * **独立**遍历档案，按 `gateVersion` 归组。
 *
 * ⚠️ 只读 `manifest.json` 的封存字段，**不读聚合门的输出** —— 这样两条路径才有对账价值。
 */
function sealedManifests(): SealedManifest[] {
  if (!existsSync(ARTIFACTS)) return []
  const out: SealedManifest[] = []
  const entries = readdirSync(ARTIFACTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  for (const name of entries) {
    const manifestPath = join(ARTIFACTS, name, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      if (typeof raw.gateVersion !== 'string' || typeof raw.startedAt !== 'string' || typeof raw.runId !== 'string') continue
      out.push({ dir: name, gateVersion: raw.gateVersion, startedAt: raw.startedAt, runId: raw.runId })
    } catch {
      /* 坏档不计入（聚合门另有 NOT RUN/INVALID 的判断） */
    }
  }
  return out
}

/** 「按封存 `startedAt` 取最新」——**本门自己的**实现，与聚合门各写一遍 */
function latestOf(
  manifests: readonly SealedManifest[]
): { readonly chosen: SealedManifest | null; readonly candidates: number } {
  const sorted = [...manifests].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.dir < b.dir ? 1 : -1))
  return { chosen: sorted[0] ?? null, candidates: sorted.length }
}

async function main(): Promise<void> {
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId = createM95RunId({ wpId: 'wp11-aggregator', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()

  const readings = readAggregator()
  const manifests = sealedManifests()
  const required = readings.filter((row) => row.requiredNow)

  /* ---- ① 选取规则：两条独立路径必须得到**同一个**答案 ---- */
  const mismatches: { gate: string; aggregator: string | null; independent: string | null }[] = []
  let gatesWithChoice = 0
  for (const row of required) {
    const own = manifests.filter((manifest) => manifest.gateVersion === row.gate)
    if (own.length === 0) continue
    const independent = latestOf(own).chosen
    gatesWithChoice += 1
    if (independent?.runId !== row.runId) {
      mismatches.push({ gate: row.gate, aggregator: row.runId, independent: independent?.runId ?? null })
    }
  }
  check(
    '① 取档规则对账：聚合门选的档 = 独立重演的最新的档',
    mismatches.length === 0 && gatesWithChoice > 0,
    mismatches.length > 0 ? JSON.stringify(mismatches.slice(0, 3)) : `参与对账的门=${String(gatesWithChoice)}`
  )

  /* ---- ② ★ 规则必须**被真的行使过**：有 ≥2 候选的门才算数 ---- */
  const multi = required.filter((row) => (row.detail?.candidates ?? 0) >= 2)
  const exercised = multi.map((row) => ({
    gate: row.gate,
    candidates: row.detail?.candidates ?? 0,
    picked: row.runId,
    /** 选中的确实是最新的吗（同 ①，但只在多候选中断言） */
    isLatest: (() => {
      const own = manifests.filter((manifest) => manifest.gateVersion === row.gate)
      return latestOf(own).chosen?.runId === row.runId
    })(),
  }))
  check(
    '② ★ 取档规则**被真的行使过**（存在 ≥2 候选的门，且每个都选中了最新的那份）',
    exercised.length > 0 && exercised.every((item) => item.isLatest),
    `多候选门=${String(exercised.length)}`
  )

  /* ---- ③ 负控：本门的比较器**必须**能认出"旧档" ---- */
  const older: SealedManifest = { dir: 'z-20260101-aaaa', gateVersion: 'x@1', startedAt: '2026-01-01T00:00:00.000Z', runId: 'z' }
  const newer: SealedManifest = { dir: 'a-20260202-bbbb', gateVersion: 'x@1', startedAt: '2026-02-02T00:00:00.000Z', runId: 'a' }
  check(
    '③ ★ 负控：比较器按 **startedAt** 取最新，**不是**按目录名（`z…` 是旧档，却排在名字前面）',
    latestOf([older, newer]).chosen?.runId === 'a',
    JSON.stringify(latestOf([older, newer]).chosen)
  )
  check(
    '③ ★ 负控：反向注入（最新那份名字在后）也必须取最新',
    latestOf([{ ...newer, dir: 'z-new' }, { ...older, dir: 'a-old' }]).chosen?.startedAt === newer.startedAt
  )

  /* ---- ④ 封存哈希**真的被算了**（防"0 检查 0 不一致"） ---- */
  const weakSeal = required
    .filter((row) => (row.detail?.artifactHashesChecked ?? 0) <= 0 || (row.detail?.artifactHashesMismatched ?? []).length > 0)
    .map((row) => ({ gate: row.gate, checked: row.detail?.artifactHashesChecked ?? 0 }))
  check(
    '④ ★ 每道必选门的封存哈希都被**真的核对**（passed>0 且 mismatched=0 ⇒ 不是"0 检查 0 不一致"）',
    weakSeal.length === 0,
    JSON.stringify(weakSeal.slice(0, 3))
  )

  /* ---- ⑤ 独立复算一份哈希，与封存值对账（不靠聚合门的自述） ---- */
  const sample = required.find((row) => row.runId !== null && row.gate !== 'm9.5-aggregator@1')
  const recomputed = (() => {
    if (sample?.runId == null) return { ok: false, why: '无可复算样本' }
    const dir = join(ARTIFACTS, sample.runId)
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) return { ok: false, why: '样本清单不存在' }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      artifactHashes?: Record<string, string>
    }
    const hashes = manifest.artifactHashes ?? {}
    const names = Object.keys(hashes)
    if (names.length === 0) return { ok: false, why: '样本清单里没有 artifactHashes' }
    const bad: string[] = []
    for (const name of names) {
      const filePath = join(dir, name)
      if (!existsSync(filePath)) {
        bad.push(`${name}:缺文件`)
        continue
      }
      if (sha256(readFileSync(filePath, 'utf8')) !== hashes[name]) bad.push(`${name}:哈希不符`)
    }
    return { ok: bad.length === 0, why: bad.length === 0 ? `${String(names.length)} 个产物逐字相符` : bad.join(',') }
  })()
  check('⑤ 独立复算样本档的封存哈希（与清单里记的值逐字比对）', recomputed.ok === true, recomputed.why)

  check('⑥ 计数自检：必选门数 > 0', required.length > 0, String(required.length))

  const total = passed + failures.length
  const selfCheck = selfCheckMeasurement({ measuredCount: total, notRunCount: 0, failedCount: failures.length })
  const realDbAfter = safeTreeDigest()

  const payload = {
    schemaVersion: 'm9.5-aggregator@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '**聚合门自己**的取档规则（两条独立路径对账 + 规则被真的行使 + 比较器负控）· 封存哈希真被核对（防 0 检查 0 不一致）· ' +
        '独立复算一份样本哈希',
      notProves:
        '**不**验证各门断言的内容对不对（那由各门自己负责）；也**不**替代 `m9.5:regression@1` 的准入判定',
      why: '取档规则一旦坏成"按目录名/取第一个"，聚合门会**静默取旧档并报 PASS** —— 那是它存在理由的反面',
    },
    readings: {
      requiredGates: required.length,
      gatesWithChoice,
      multiCandidateGates: exercised,
      mismatches,
      comparatorNegativeControl: latestOf([older, newer]).chosen?.runId ?? null,
      hashRecomputation: recomputed,
    },
    checks: { passed, failed: failures.length, total },
    failures,
    realDbProtection: { before: realDbBefore, after: realDbAfter, note: '本门只读档案与聚合门输出' },
  }
  const evidencePath = join(runDir, 'aggregator-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp11',
    lane: 'offline',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: GATE_VERSION,
    dbKind: 'not-applicable',
    isolationProof: { dbTouched: false, method: '**构造属性**：本门只读 `artifacts/` 与聚合门输出' },
    configHash: { requiredGates: required.length, multiCandidateGates: exercised.length },
    command: [{ cmd: 'pnpm m9.5:aggregator:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: total,
    notRunCount: 0,
    counts: { total, passed, failed: failures.length },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'aggregator-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      'M9.5 聚合门自检：取档规则对账 · 封存哈希 · 比较器负控',
      `  通过 ${String(passed)} / 失败 ${String(failures.length)}（共 ${String(total)} 项）`,
      ...failures.map((line) => `  ✗ ${line}`),
      `  必选门 ${String(required.length)} · 参与对账 ${String(gatesWithChoice)} · 多候选门 ${String(exercised.length)}`,
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (failures.length > 0 || total === 0) process.exitCode = 3
}

await main()
