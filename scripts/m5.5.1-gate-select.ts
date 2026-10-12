/**
 * M5.5.1 **语义证据选档器** —— 从 `artifacts/m5.5.1/wp7/*` 里选"最新一份**正式**观测"。
 *
 * ============================================================================
 *  为什么单独一个模块
 * ============================================================================
 * 原先它是 `m5.5.1-gates.ts` 里的一个局部函数，**没有专属的三段式控制**：
 * `R-35`（登记册 §0m）量出的"小样本诊断档被当成最新观测"这个口径问题，
 * 在 2026-10-03 的 `4005f360` 里被顺手修掉了（按 `ended ?? started` → 该证据文件的
 * **git 提交时刻** → `runId` 并列裁决，并跳过 `smallSample === true`），
 * 但**没有任何机器判据**守着它 —— 源码注释与一次读数不足以证明它下次还这么选。
 * ⇒ 抽到这里，`scripts/verify-m5.5.1-measurement.ts` 用 `%TEMP%` 夹具驱动**同一个函数**。
 *
 * ============================================================================
 *  选档规则（先到先得；并列按 runId 降序）
 * ============================================================================
 * ```text
 * ① 只考虑 `wp7/<runId>/observations.json` 存在、且**不是** `smallSample: true` 的档
 *    （诊断档 = 工具，不是正式观测；把它当"最新"是 `R-35` 那次的形态）
 * ② 时间取 `ended`（否则 `started`）**自报时刻**；缺失 ⇒ 退到**该证据文件的 git 提交时刻**
 * ③ 仍缺失 ⇒ `time = -1`（并列 ⇒ 按 runId 降序裁决）
 * ```
 * ⚠️ **刻意不优先取 PASS 的那一份**：归属必须如实，"挑一份好看的"正是本门要防的事。
 * ⚠️ 只读文件与 git；不起数据库、不出网、不写任何东西。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface SemanticsEvidenceSelection {
  /** `observations.json` 的**绝对路径** */
  readonly file: string
  readonly runId: string
  /** 选中档的时间（毫秒）；取不到任何时间时为 `-1` */
  readonly time: number
  /** 与选中档**时间并列**的其它档（runId 升序）；空数组 = 无并列 */
  readonly tiedWith: readonly string[]
  /** 被跳过的**小样本诊断档**（runId 升序） */
  readonly skippedSmallSample: readonly string[]
  /** 时间来源：自报时刻 / git 提交时刻 / 都没有（并列裁决） */
  readonly basis: 'reported' | 'git-commit-time' | 'none'
}

const readJson = (path: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

const toMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || value === '') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * @param evidenceRoot `artifacts/m5.5.1`（或 `%TEMP%` 夹具根）
 * @param repoRoot     用于把证据路径换算成 git 路径；缺省 = `process.cwd()`
 */
export function newestSemanticsEvidence(
  evidenceRoot: string,
  repoRoot: string = process.cwd()
): SemanticsEvidenceSelection | null {
  const wp7 = join(evidenceRoot, 'wp7')
  if (!existsSync(wp7)) return null

  interface Candidate {
    file: string
    runId: string
    time: number
    basis: SemanticsEvidenceSelection['basis']
  }
  const candidates: Candidate[] = []
  const skippedSmallSample: string[] = []

  for (const entry of readdirSync(wp7, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(wp7, entry.name, 'observations.json')
    if (!existsSync(candidate)) continue
    const observation = readJson(candidate)
    /* ① 诊断档（`smallSample`）= 工具，不是正式观测 —— 跳过并记名 */
    if (observation.smallSample === true) {
      skippedSmallSample.push(entry.name)
      continue
    }

    /* ② 自报时刻优先 */
    let time = toMs(observation.ended) ?? toMs(observation.started)
    let basis: Candidate['basis'] = time === null ? 'none' : 'reported'

    /* ③ 缺失 ⇒ 退到**该证据文件在 git 里的提交时刻**（不是目录 mtime） */
    if (time === null) {
      const rel = join('artifacts', 'm5.5.1', 'wp7', entry.name, 'observations.json')
      /* 夹具在 `%TEMP%` 里 ⇒ `git log` 只会往 stderr 喷 "outside repository"，直接不问 */
      if (existsSync(join(repoRoot, rel))) {
        try {
          const seconds = execFileSync('git', ['log', '-1', '--format=%ct', '--', rel], {
            cwd: repoRoot,
            encoding: 'utf8',
          }).trim()
          if (seconds !== '' && Number.isFinite(Number(seconds))) {
            time = Number(seconds) * 1000
            basis = 'git-commit-time'
          }
        } catch {
          /* 未入库 ⇒ 保持 none */
        }
      }
    }

    candidates.push({ file: candidate, runId: entry.name, time: time ?? -1, basis })
  }

  if (candidates.length === 0) return null

  const ordered = [...candidates].sort((a, b) =>
    a.time - b.time || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)
  )
  const picked = ordered[ordered.length - 1]
  if (picked === undefined) return null

  const tiedWith = ordered
    .filter((candidate) => candidate.runId !== picked.runId && candidate.time === picked.time)
    .map((candidate) => candidate.runId)
    .sort()

  return {
    file: picked.file,
    runId: picked.runId,
    time: picked.time,
    tiedWith,
    skippedSmallSample: skippedSmallSample.sort(),
    basis: picked.basis,
  }
}
