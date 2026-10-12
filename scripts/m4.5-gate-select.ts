/**
 * M4.5 **G14 选档器** —— 按**身份**（清单自报结束时间 / head 提交时刻 / 证据提交时刻）选
 * "Production-copy Live Smoke 的**当期读数**"，**mtime 永不参与**。
 *
 * ============================================================================
 *  为什么需要它（登记册 §0m `R-36`）
 * ============================================================================
 * ```text
 * 旧形状：G14 读**固定路径** `artifacts/m4.5/smoke/smoke-result.json`。
 *   ⇒ 那份是 2026-09-30 被**刻意留下**的失败档（26 通过 / 18 失败，且 S11.1-3 全红 = **量具空转档**），
 *     而此后 M11.1 的长回归又出过多次 **52 通过 / 0 失败**的当期读数（归档在
 *     `artifacts/m11.1/m111-full-live-regression-<runId>/` 里，带 manifest 的 `endedAt` + `head`）。
 *   ⇒ 于是聚合门**长期显示 FAIL**，而"当期真实读数"在别处 —— 这与 `TD-23` 是同一族缺陷。
 * ```
 *
 * ============================================================================
 *  取值（先到先得；并列按 runId 降序；**刻意不看 verdict**）
 * ============================================================================
 * ```text
 * ① `reported-time`         清单自报的 `endedAt`（M11.1 的 manifest 用的就是这个键）
 * ② `head-commit-time`      清单 `head` / `headStarted` 那个提交的提交时刻
 * ③ `evidence-commit-time`  该证据文件在 git 里的提交时刻
 * ④ `manifest-date`         清单只有 `date`（日粒度，最弱）
 * ⑤ `none`                  **具名降级**：什么时间戳都没有 ⇒ 只按 runId 字典序，调用方必须打印出来
 * ```
 *
 * ⚠️ 证据来源有**优先级**（都记进 `source`，调用方原样落盘）：
 * ```text
 * 1. `archived-smoke`    归档目录里的原始 smoke 档（tracked）
 * 2. `archived-gates`    归档目录里的 `artifacts/m4.5/gate-results.json` 的 **G14 行**
 * 3. `local-hash-verified`  gitignored 的 `local/<runId>/smoke-result.json`，
 *                        **但必须** sha256 与清单的 `privateSmokeSha256` **逐字相符**才采用
 * ```
 * ⚠️ 只读文件与 git；不起数据库、不出网、不写任何东西。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type SelectionBasis =
  | 'reported-time'
  | 'head-commit-time'
  | 'evidence-commit-time'
  | 'manifest-date'
  | 'none'

export type ReadingSource = 'archived-smoke' | 'archived-gates' | 'local-hash-verified'

export interface G14Reading {
  readonly status: 'PASS' | 'FAIL' | 'not-run'
  readonly passed?: number
  readonly failed?: number
}

export interface G14Selection {
  /** 选中的归档 run 目录（`source === 'fixed-path'` 时为空串） */
  readonly runDir: string
  /** 读数来自哪里（调用方原样落盘） */
  readonly source: ReadingSource | 'fixed-path'
  /** 读数文件的**仓库相对路径**（失败关闭时为空串） */
  readonly evidencePath: string
  readonly reading: G14Reading
  readonly time: number
  readonly basis: SelectionBasis
  /** 与选中档**时间并列**的其它 runId（升序） */
  readonly tiedWith: readonly string[]
  /** 并列档里判定不同 ⇒ 调用方失败关闭 */
  readonly conflictingVerdicts: boolean
  /** 具名降级：没有任何时间戳，只按 runId 裁决 */
  readonly degraded: boolean
}

const READ_TIME_KEYS = ['endedAt', 'ended', 'finishedAt', 'generatedAt', 'started'] as const

const toMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e11 ? value : value * 1000
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const readJson = (path: string): Record<string, unknown> | undefined => {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

const gitTimeCache = new Map<string, number | null>()
const gitRefTime = (ref: string, repoRoot: string): number | null => {
  const key = `ref:${ref}`
  if (gitTimeCache.has(key)) return gitTimeCache.get(key) ?? null
  let result: number | null = null
  try {
    const seconds = execFileSync('git', ['log', '-1', '--format=%ct', ref], { cwd: repoRoot, encoding: 'utf8' }).trim()
    if (seconds !== '' && Number.isFinite(Number(seconds))) result = Number(seconds) * 1000
  } catch {
    result = null
  }
  gitTimeCache.set(key, result)
  return result
}
const gitPathTime = (path: string, repoRoot: string): number | null => {
  const key = `path:${path}`
  if (gitTimeCache.has(key)) return gitTimeCache.get(key) ?? null
  let result: number | null = null
  try {
    const rel = path.replace(`${repoRoot}\\`, '').replace(`${repoRoot}/`, '').replace(/\\/g, '/')
    /* 仓库外的路径（三段式夹具就在 %TEMP%）⇒ 直接不问：`git` 只会往 stderr 喷 "outside repository" */
    if (!rel.startsWith('..') && !/^([a-zA-Z]:|\/|\\)/.test(rel)) {
      const seconds = execFileSync('git', ['log', '-1', '--format=%ct', '--', rel], { cwd: repoRoot, encoding: 'utf8' }).trim()
      if (seconds !== '' && Number.isFinite(Number(seconds))) result = Number(seconds) * 1000
    }
  } catch {
    result = null
  }
  gitTimeCache.set(key, result)
  return result
}

const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** 从清单里读出一个候选读数（原始档 → 归档聚合档 → hash 校验过的 local 档） */
function candidateReading(
  manifest: Record<string, unknown>,
  runDir: string
): { source: ReadingSource; path: string; reading: G14Reading } | undefined {
  const archivedSmoke = join(runDir, 'artifacts__m4.5__smoke__smoke-result.json')
  const archivedGates = join(runDir, 'artifacts', 'm4.5', 'gate-results.json')

  const direct = readJson(archivedSmoke)
  if (direct !== undefined && typeof direct.status === 'string') {
    const checks = (direct.checks ?? {}) as { passed?: number; failed?: number }
    return {
      source: 'archived-smoke',
      path: archivedSmoke,
      reading: {
        status: direct.status === 'PASS' ? 'PASS' : 'FAIL',
        ...(checks.passed !== undefined ? { passed: checks.passed } : {}),
        ...(checks.failed !== undefined ? { failed: checks.failed } : {}),
      },
    }
  }

  const archived = readJson(archivedGates)
  if (archived !== undefined && Array.isArray(archived.gates)) {
    const g14 = (archived.gates as Record<string, unknown>[]).find((gate) => gate.gate === 'G14')
    if (g14 !== undefined && typeof g14.status === 'string') {
      return {
        source: 'archived-gates',
        path: archivedGates,
        reading: {
          status: g14.status === 'PASS' ? 'PASS' : 'FAIL',
          ...(typeof g14.passed === 'number' ? { passed: g14.passed } : {}),
          ...(typeof g14.failed === 'number' ? { failed: g14.failed } : {}),
        },
      }
    }
  }

  /* ③ gitignored 的 local 原始档：**必须**与清单里的 sha256 逐字相符才采用（否则不猜） */
  const expected = typeof manifest.privateSmokeSha256 === 'string' ? manifest.privateSmokeSha256.toUpperCase() : ''
  const local = join(runDir, '..', 'local', runDir.split(/[\\/]/).pop() ?? '', 'smoke-result.json')
  if (expected !== '' && existsSync(local)) {
    if (sha256File(local).toUpperCase() === expected) {
      const json = readJson(local)
      if (json !== undefined && typeof json.status === 'string') {
        const checks = (json.checks ?? {}) as { passed?: number; failed?: number }
        return {
          source: 'local-hash-verified',
          path: local,
          reading: {
            status: json.status === 'PASS' ? 'PASS' : 'FAIL',
            ...(checks.passed !== undefined ? { passed: checks.passed } : {}),
            ...(checks.failed !== undefined ? { failed: checks.failed } : {}),
          },
        }
      }
    }
  }
  return undefined
}

export interface SelectOptions {
  /** 归档父目录（`artifacts/m11.1`） */
  readonly archiveParent: string
  readonly repoRoot: string
  /** 固定路径兜底（历史档；只在没有任何归档候选时使用） */
  readonly fixedPath: string
  /** 固定路径的仓库相对路径（落盘用） */
  readonly fixedRelative: string
}

/**
 * 选 G14 的**当期**读数。没有任何归档候选时**回落到固定路径**并如实标注 `source: 'fixed-path'`。
 */
export function selectM45G14Reading(options: SelectOptions): G14Selection {
  const dirs = existsSync(options.archiveParent)
    ? readdirSync(options.archiveParent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('m111-full-live-regression-'))
        .map((entry) => entry.name)
        .sort()
    : []

  interface Candidate {
    runId: string
    runDir: string
    source: ReadingSource
    path: string
    reading: G14Reading
    time: number
    basis: SelectionBasis
  }
  const candidates: Candidate[] = []

  for (const runId of dirs) {
    const runDir = join(options.archiveParent, runId)
    const manifest = readJson(join(runDir, 'manifest.json'))
    if (manifest === undefined || manifest.liveSmoke === undefined) continue
    const found = candidateReading(manifest, runDir)
    if (found === undefined) continue

    let time = READ_TIME_KEYS.map((key) => toMs(manifest[key])).find((value) => value !== null) ?? null
    let basis: SelectionBasis = time === null ? 'none' : 'reported-time'
    if (time === null) {
      const head = typeof manifest.head === 'string' && manifest.head !== '' ? manifest.head : undefined
      const headStarted = typeof manifest.headStarted === 'string' && manifest.headStarted !== '' ? manifest.headStarted : undefined
      for (const ref of [head, headStarted]) {
        if (ref === undefined) continue
        const refTime = gitRefTime(ref, options.repoRoot)
        if (refTime !== null) {
          time = refTime
          basis = 'head-commit-time'
          break
        }
      }
    }
    if (time === null) {
      const pathTime = gitPathTime(found.path, options.repoRoot)
      if (pathTime !== null) {
        time = pathTime
        basis = 'evidence-commit-time'
      }
    }
    if (time === null) {
      const day = toMs(manifest.date)
      if (day !== null) {
        time = day
        basis = 'manifest-date'
      }
    }
    candidates.push({ runId, runDir, source: found.source, path: found.path, reading: found.reading, time: time ?? -1, basis })
  }

  if (candidates.length === 0) {
    /* 失败关闭：没有归档候选时**回落到固定路径**，并如实标注来源（调用方必须把它打印出来） */
    const fixed = readJson(options.fixedPath)
    const checks = (fixed?.checks ?? {}) as { passed?: number; failed?: number }
    return {
      runDir: '',
      source: 'fixed-path',
      evidencePath: options.fixedRelative,
      reading:
        fixed === undefined
          ? { status: 'not-run' }
          : {
              status: fixed.status === 'PASS' ? 'PASS' : 'FAIL',
              ...(checks.passed !== undefined ? { passed: checks.passed } : {}),
              ...(checks.failed !== undefined ? { failed: checks.failed } : {}),
            },
      time: gitPathTime(options.fixedPath, options.repoRoot) ?? -1,
      basis: 'none',
      tiedWith: [],
      conflictingVerdicts: false,
      degraded: true,
    }
  }

  const ordered = [...candidates].sort((a, b) => a.time - b.time || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
  const picked = ordered[ordered.length - 1] as Candidate
  const tied = ordered.filter((candidate) => candidate.time === picked.time)
  const conflictingVerdicts = tied.some((candidate) => candidate.reading.status !== picked.reading.status)

  return {
    runDir: picked.runDir,
    source: picked.source,
    evidencePath: picked.path.replace(`${options.repoRoot}\\`, '').replace(`${options.repoRoot}/`, '').replace(/\\/g, '/'),
    reading: picked.reading,
    time: picked.time,
    basis: picked.basis,
    tiedWith: tied.filter((candidate) => candidate.runId !== picked.runId).map((candidate) => candidate.runId).sort(),
    conflictingVerdicts,
    degraded: picked.basis === 'none',
  }
}
