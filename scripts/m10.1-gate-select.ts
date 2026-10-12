/**
 * M10.1 **选档器** —— 只按**身份 / 正式结束时间**选"最新一份读数"，**mtime 永不参与**。
 *
 * ============================================================================
 *  为什么单独一个模块（登记册 §0m `R-34` / `TD-23`）
 * ============================================================================
 * ```text
 * 旧实现：`readdirSync(...).sort((a,b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1)`
 *   ⇒ 实测反例：`artifacts/m10.1/` 下同一道门 `m11-m10-1-wp6-long-live-200-*` 有四份档，
 *     **目录 mtime 完全相同**（2026-10-02 16:29:08）⇒ 并列落到目录名字典序最后 = 那份 **FAIL**，
 *     而按提交先后更新的两份都是 **PASS** ⇒ 聚合门报 NOT PASS，抬头那句"更晚的 PASS 取代更早的 FAIL"
 *     在 mtime 并列时**不成立**。
 * ```
 *
 * ⚠️ **2026-10-05（`AUD-20261005-02`）**：五段判据（自报时间 → head 提交时刻 →
 * 证据提交时刻 → 清单日期 → 具名降级）已**抽到共享模块** `scripts/gate-evidence-select.ts`，
 * 与 `scripts/m10-gates.ts` / `scripts/m11.1-gates.ts` 是**同一份实现** ——
 * 同一缺陷在三个聚合门上各出现过一次，不该再靠三份互不相同的代码去堵。
 * 本文件保留它自己的两件**局部**语义（聚合门之间不共用）：
 * ```text
 * ① **非权威档过滤**：`dryRun === true` / `authoritative === false`
 *    ⇒ 干跑档不许当权威（实测：m10.1:activate 的干跑档与正式档**同 head、同提交时刻**）
 * ② **按目录名前缀扫描**：本门的证据布局是"一门一前缀 + 一个固定文件名"
 * ```
 *
 * ⚠️ 本模块**只读**文件与 git，不起数据库、不出网、不写任何东西。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  headFromRunId,
  parseJsonObject,
  pickLatest,
  rankReadings,
  type RankInput,
  type SelectionBasis,
} from './gate-evidence-select.ts'

export type { SelectionBasis }
export { headFromRunId }

export interface Selection {
  readonly dir: string
  readonly json: string
  readonly runId: string
  /** 选定档的时间（毫秒）；`none` 时为 `-Infinity` */
  readonly time: number
  readonly basis: SelectionBasis
  /** 与选定档**时间并列**的其它档（runId 升序）；空数组 = 无并列 */
  readonly tiedWith: readonly string[]
  /** 被滤掉的**非权威档**（干跑 / 显式声明非权威），按 runId 升序 */
  readonly skipped: readonly string[]
  /** 并列组里**判定不同**（有 PASS 也有非 PASS）⇒ 调用方必须失败关闭 */
  readonly conflictingVerdicts: boolean
}

/**
 * **非权威档**判据（要求"读数自己声明"，与 `m5.5.1-gates.ts` 的 `smallSample === true` 同一条纪律）：
 * ```text
 * · `dryRun === true`          干跑（实测：`m10.1:activate` 的干跑档与正式档**同 head、同提交时刻**，
 *                              只有这个字段能区分 —— 而 mtime 时代被选中的那份**正是干跑档**）
 * · `authoritative === false`  显式声明"本份不是权威读数"
 * ```
 * ⚠️ 过滤**只在过滤后仍有候选时**生效；全被滤掉 ⇒ 保留全部并把这些档名记进 `skipped`（具名，不静默）。
 */
const isNonAuthoritative = (reading: Record<string, unknown>): boolean =>
  reading.dryRun === true || reading.authoritative === false

interface Candidate {
  readonly dir: string
  readonly json: string
  readonly runId: string
  readonly manifest: Record<string, unknown>
  readonly reading: Record<string, unknown>
  readonly evidencePath: string
  readonly verdict: string
  readonly nonAuthoritative: boolean
}

/**
 * 在 `root` 下取目录名前缀为 `prefix`、且含 `file` 的候选中**最新的一份**。
 * 没有候选 ⇒ `undefined`（调用方按 `NOT RUN` 处理，**不是** PASS）。
 */
export function selectLatestReading(root: string, prefix: string, file: string): Selection | undefined {
  if (!existsSync(root)) return undefined

  const candidates: Candidate[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const dir = join(root, entry.name)
    const path = join(dir, file)
    if (!existsSync(path)) continue
    const json = readFileSync(path, 'utf8')
    const reading = parseJsonObject(path)
    const manifestPath = join(dir, 'manifest.json')
    const manifest = existsSync(manifestPath) ? parseJsonObject(manifestPath) : {}

    candidates.push({
      dir,
      json,
      runId: entry.name,
      manifest,
      reading,
      evidencePath: path,
      verdict: String(reading.verdict ?? '(无 verdict)'),
      nonAuthoritative: isNonAuthoritative(reading),
    })
  }

  if (candidates.length === 0) return undefined

  const authoritative = candidates.filter((candidate) => !candidate.nonAuthoritative)
  const kept = authoritative.length > 0 ? authoritative : candidates
  const skipped = (authoritative.length > 0 ? candidates.filter((c) => c.nonAuthoritative) : [])
    .map((candidate) => candidate.runId)
    .sort()

  /* ⚠️ 排序、并列、冲突判定**全部**走共享实现（`TD-23` / `AUD-20261005-02` 的唯一一份） */
  const ranked = rankReadings<Candidate>(
    kept.map(
      (candidate): RankInput<Candidate> => ({
        item: candidate,
        dir: candidate.dir,
        runId: candidate.runId,
        manifest: candidate.manifest,
        reading: candidate.reading,
        evidencePath: candidate.evidencePath,
        verdict: candidate.verdict,
      })
    )
  )
  const latest = pickLatest(ranked)
  if (latest === undefined) return undefined

  return {
    dir: latest.picked.dir,
    json: latest.picked.item.json,
    runId: latest.picked.runId,
    time: latest.picked.time,
    basis: latest.picked.basis,
    tiedWith: latest.tiedWith,
    skipped,
    conflictingVerdicts: latest.conflictingVerdicts,
  }
}
