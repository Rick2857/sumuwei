/**
 * Lv2 —— **正式候选 run 的选择与适用性**（`lv2:gates` 的判据核心）。
 *
 * ============================================================================
 *  它为什么必须先被单独验一遍（`TD-23` 的直接产物）
 * ============================================================================
 * WP0 在当前 HEAD 重取各门读数时量到三处**同族**缺陷（`Tech-Debt-Register` §0m / R-34·R-35·R-36）：
 * 既有聚合门用 **`statSync(dir).mtimeMs`** 选"最新一份档"——
 * ```text
 * · `m10.1:gates`  四份 200 轮真模型档 mtime **全等** ⇒ 并列落到**目录名字典序**最后
 *                  ⇒ 选中**更早的 FAIL**（cf6d314c），而更新的两份是 PASS
 * · `m5.5.1:gates` 语义门取到 TD-11 的**小样本诊断档**（三份 mtime 同秒）
 * · `m4.5:gates`   G14 量到 2026-09-30 的失败档（PASS 档被"历史证据还原"留在别处）
 * ```
 * 计划 §11.1 对新聚合器的要求逐字是：
 *   「只读证据，按**正式结束时间/身份**先选最新正式候选 run，再验证适用性；
 *     最新 run 为 FAIL 或 INVALID 时**保持该状态**，不退选旧 PASS。零分母 INVALID」
 *
 * ⇒ 本模块就是那一条要求的**唯一实现**，并刻意做成可被 `lv2:measurement:verify`
 *   用**合成夹具**做三段式（正控 / 缺陷负控 / 恢复）的对象 ——
 *   否则"选档正确"只是一句没有人测过的话。
 *
 * 硬边界（判据不是注释）：
 *   · 选档**只看清单里的身份**（`ended` → `runId`），**绝不**看 `mtime`、目录名顺序或"最新 PASS"；
 *   · `ended` 缺失 / 不可解析 / `counts.total = 0` / 清单不合契约 / 带 `injection` 标记的 run
 *     **一律不进候选**（失败关闭 + 具名理由）；
 *   · 候选为空 ⇒ 返回 `null`（调用方必须把它当 **NOT RUN**，不是 PASS）；
 *   · 适用性 = **源指纹是否仍与当前文件一致**；`checked = 0` ⇒ 明确报"测了 0 项"（AGENTS §6.8）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { LV2_RUN_ID_PATTERN, validateLv2Manifest } from './lv2-evidence.ts'

export interface Lv2RunReading {
  readonly runId: string
  /** run 目录的绝对路径 */
  readonly dir: string
  /** 清单（解析失败 ⇒ null） */
  readonly manifest: Record<string, unknown> | null
  /** 是否可作**正式候选** */
  readonly eligible: boolean
  /** 不可作候选的**具名**理由（可空） */
  readonly reasons: readonly string[]
  /** 清单里的正式结束时间（ISO；不可解析 ⇒ null） */
  readonly ended: string | null
  /** 清单里的自报判定（`PASS` / `FAIL` / …；缺失 ⇒ null） */
  readonly verdict: string | null
  readonly counts: { total: number; passed: number; failed: number } | null
  /** 目录 mtime —— **只作读数记录**，不参与选档（`TD-23` 的教训） */
  readonly mtimeMs: number
}

/** 读一个 `artifacts/lv2/` 父目录下的全部 run（**只读**，不抛）。 */
export function readLv2Runs(runsParent: string): Lv2RunReading[] {
  if (!existsSync(runsParent)) return []
  const rows: Lv2RunReading[] = []
  for (const entry of readdirSync(runsParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'local') continue
    const dir = join(runsParent, entry.name)
    const manifestPath = join(dir, 'manifest.json')
    const reasons: string[] = []
    let manifest: Record<string, unknown> | null = null
    if (!LV2_RUN_ID_PATTERN.test(entry.name)) reasons.push('runId 形状非法')
    if (!existsSync(manifestPath)) {
      reasons.push('manifest.json 缺失（只有它才算完整 —— TD-04①）')
    } else {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reasons.push('manifest 不是 JSON 对象')
        } else {
          manifest = parsed as Record<string, unknown>
          for (const problem of validateLv2Manifest(manifest)) {
            reasons.push(`清单不合约：${problem.field}: ${problem.problem}`)
          }
        }
      } catch (error) {
        reasons.push(`manifest 解析失败：${(error as Error).message}`)
      }
    }
    if (manifest !== null) {
      if (manifest.runId !== entry.name) reasons.push('清单里的 runId 与目录名不一致')
      if ('injection' in manifest) reasons.push(`带注入标记（${String(manifest.injection)}）⇒ 不是正式候选`)
      const counts = manifest.counts as { total?: unknown; passed?: unknown; failed?: unknown } | undefined
      if (counts === undefined || !Number.isInteger(counts.total)) reasons.push('counts 缺失或非整数')
      else if (Number(counts.total) <= 0) reasons.push('counts.total = 0 ⇒ 零分母（INVALID，不是 PASS）')
      const ended = typeof manifest.ended === 'string' ? manifest.ended : null
      if (ended === null || Number.isNaN(Date.parse(ended))) reasons.push('ended 缺失或不可解析')
    }
    const counts =
      manifest !== null && typeof manifest.counts === 'object' && manifest.counts !== null
        ? (manifest.counts as { total: number; passed: number; failed: number })
        : null
    rows.push({
      runId: entry.name,
      dir,
      manifest,
      eligible: reasons.length === 0,
      reasons,
      ended: manifest !== null && typeof manifest.ended === 'string' ? manifest.ended : null,
      verdict: manifest !== null && typeof manifest.verdict === 'string' ? manifest.verdict : null,
      counts,
      mtimeMs: statSync(dir).mtimeMs,
    })
  }
  return rows
}

export interface Lv2Selection {
  /** 最新**正式候选**；候选为空 ⇒ null（调用方必须当 NOT RUN） */
  readonly selected: Lv2RunReading | null
  /** 全部合格候选（按选档依据降序） */
  readonly eligible: readonly Lv2RunReading[]
  /** 被排除的 run 及**具名**理由 */
  readonly excluded: readonly { runId: string; reasons: readonly string[] }[]
  /** 选档依据的说明（进证据，便于复核） */
  readonly rule: string
}

/**
 * 选**最新正式候选**：先按清单里的 `ended`（ISO）降序，`ended` 相同才用 `runId` 降序打破并列。
 *
 * ⚠️ **不看 `mtime`、不看目录名顺序、不看 `verdict`**：
 *    "最新 run 是 FAIL 就保持 FAIL"这条纪律的前提正是"选的是最新那一份"——
 *    如果选档偷看 verdict，就会变成"选最新 PASS"（那是另一个性质，明令禁止）。
 *
 * `options.wp` 是把候选**限定到某一道门**（`manifest.wp`）。缺省不限 ⇒ 全部合格 run 都是候选；
 * 限定后无候选 ⇒ `selected = null`，调用方**必须**把它当 **NOT RUN**（不是 PASS）。
 */
export function selectLatestFormalRun(
  runsParent: string,
  options: { readonly wp?: string } = {},
): Lv2Selection {
  const all = readLv2Runs(runsParent)
  const eligible = all
    .filter((row) => row.eligible)
    .filter((row) => options.wp === undefined || row.manifest?.wp === options.wp)
    .slice()
    .sort((a, b) => {
      const byEnded = Date.parse(b.ended ?? '') - Date.parse(a.ended ?? '')
      if (byEnded !== 0) return byEnded
      return b.runId < a.runId ? -1 : b.runId > a.runId ? 1 : 0
    })
  return {
    selected: eligible[0] ?? null,
    eligible,
    excluded: all.filter((row) => !row.eligible).map((row) => ({ runId: row.runId, reasons: row.reasons })),
    rule:
      'ended(ISO) 降序；并列用 runId 降序；只看清单身份，不看 mtime / 目录名顺序 / verdict' +
      (options.wp === undefined ? '' : `；候选限定 wp=${options.wp}`),
  }
}

export interface Lv2Freshness {
  /** 全部指纹都对得上 */
  readonly fresh: boolean
  /** 检查了几个源指纹（0 ⇒ 测量无效，AGENTS §6.8） */
  readonly checked: number
  /** 对不上的路径（**具名**） */
  readonly stale: readonly string[]
  /** 文件不存在的路径（与"内容变了"分开记） */
  readonly missing: readonly string[]
}

/** 适用性：清单里的**源指纹**是否仍与当前文件一致。 */
export function freshnessOf(root: string, manifest: Record<string, unknown> | null): Lv2Freshness {
  const fingerprints = (manifest?.sourceFingerprints ?? null) as Record<string, string> | null
  if (fingerprints === null || typeof fingerprints !== 'object') {
    return { fresh: false, checked: 0, stale: [], missing: ['<sourceFingerprints 缺失>'] }
  }
  const stale: string[] = []
  const missing: string[] = []
  let checked = 0
  for (const [path, expected] of Object.entries(fingerprints)) {
    const abs = resolve(root, path)
    const rel = relative(root, abs)
    if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(abs)) {
      missing.push(path)
      continue
    }
    checked += 1
    const actual = createHash('sha256').update(readFileSync(abs)).digest('hex')
    if (actual !== expected) stale.push(path)
  }
  return { fresh: checked > 0 && stale.length === 0 && missing.length === 0, checked, stale, missing }
}
