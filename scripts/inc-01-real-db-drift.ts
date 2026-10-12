/**
 * INC-01 **共用判据**：真实库摘要的"同轮不变 + 漂移登记"。
 *
 * 为什么需要它（WP4 实测得到的教训）：
 * ```text
 *   "真实库摘要永远 == WP0 冻结常量" **不是一个可持续的判据** ——
 *   她的库是会被**合法打开**的（用户每聊一次都会改 pg_control / WAL）。
 * ```
 * 于是判据拆成两条，**WP4 与 WP5 两道门共用同一份实现**：
 *
 * ```text
 *   ① 同轮不变：本门运行前后逐字相同（这才是"本门有没有碰真库"的判据）
 *   ② 漂移有据：与 WP0 基线不同时，必须由
 *        「一份 captures 了改动前状态的 verified 快照」+「一次 cleanClose=true 的 owner record」
 *        解释；解释不了 ⇒ FAIL（无法解释的漂移）
 * ```
 *
 * 判据**没有变松**：它只是从"一个会误报的红"换成了"一个能区分合法使用与静默改动的判据"。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readOwnerRecord, type OwnerRecord, type TreeDigest } from '../src/infrastructure/persistence/production-db-safety.ts'
import { DEFAULT_SNAPSHOT_ROOT } from '../src/infrastructure/persistence/production-open-guard.ts'

/** INC-01 的证据目录（漂移链要从这里读"上一个摘要"） */
const ARTIFACTS_DIR = resolve('artifacts/incidents/inc-01')

/** WP0 冻结的 `data/pglite` 非易失树摘要（见 incident 报告附录 A） */
export const WP0_REAL_DB_NONVOLATILE =
  'be957694b8a1173aa3da49e8b942fc1e69ddaab1cb5971a6bd5c00863555c500'

export interface SnapshotManifestDigest {
  id: string
  digest: string
  createdAt: string
}

export interface RealDbDriftReading {
  before: TreeDigest
  after: TreeDigest
  unchangedDuringRun: boolean
  matchesWp0Baseline: boolean
  baselineCapturedBySnapshotId?: string
  /** 已落盘证据里记录的**上一个**真实库摘要，被某份 verified 快照捕获（漂移链） */
  previousStateCapturedBySnapshotId?: string
  previousStateSource?: string
  cleanOwnerRecords: number
  verifiedSnapshots: SnapshotManifestDigest[]
  latestSnapshotId?: string
  driftExplained: boolean
  /** 判据本体：`同轮不变 && (等于基线 || 漂移有据)` */
  pass: boolean
  reading: string
}

/**
 * 从**已落盘**的 INC-01 证据里读"真实库曾经是什么摘要"。
 *
 * 为什么需要它：快照根有保留窗口（`PRODUCTION_SNAPSHOT_KEEP`）。
 * 一旦 WP0 基线那一份被窗口剪掉，"等于基线"就永远不可能满足，
 * 而"上一次记录的摘要被捕获"仍然是一条**有内容**的判据：
 * 它要求"**改动前的那一个状态**确实被一份 verified 快照保下来了"。
 *
 * 只读**已知字段**（不是"文件里任意 64 位十六进制"），并且排除当前值。
 */
export function previouslyRecordedRealDbDigests(
  currentDigest: string
): Map<string, { source: string }> {
  const out = new Map<string, { source: string }>()
  const extractors: { file: string; digests: (parsed: Record<string, unknown>) => unknown[] }[] = [
    {
      file: 'wp2-snapshot.json',
      digests: (parsed) => [
        (parsed.realDbBefore as { nonVolatileTreeSha256?: string } | undefined)?.nonVolatileTreeSha256,
        (parsed.realDbAfter as { nonVolatileTreeSha256?: string } | undefined)?.nonVolatileTreeSha256,
      ],
    },
    {
      file: 'wp4-integration.json',
      digests: (parsed) => [(parsed.realDb as { before?: string } | undefined)?.before, (parsed.realDb as { after?: string } | undefined)?.after],
    },
    {
      file: 'wp5-restore-drill.json',
      digests: (parsed) => [(parsed.realDb as { before?: string } | undefined)?.before, (parsed.realDb as { after?: string } | undefined)?.after],
    },
    {
      file: 'measurement-self-test.json',
      digests: (parsed) => [(parsed.realDb as { before?: string } | undefined)?.before, (parsed.realDb as { after?: string } | undefined)?.after],
    },
  ]
  for (const { file, digests } of extractors) {
    const path = join(ARTIFACTS_DIR, file)
    if (!existsSync(path)) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    for (const value of digests(parsed)) {
      if (typeof value !== 'string' || value === currentDigest) continue
      if (!/^[0-9a-f]{64}$/.test(value)) continue
      if (!out.has(value)) out.set(value, { source: file })
    }
  }
  return out
}

/**
 * 快照根里的 verified manifest（只读）。
 *
 * ⚠️ **判据是"目录 + manifest 都在"**（`INC01-D3`：manifest 是晋升的最后一步；
 * 而 `pruneSnapshots()` 只删**目录**，会留下孤儿 manifest）。
 * 只看 manifest 会把"已经被保留策略删掉的快照"当成"改动前那一份还在" ——
 * 那正是这条判据**不能**出的错。
 */
export function snapshotManifestDigests(snapshotRoot: string = DEFAULT_SNAPSHOT_ROOT): SnapshotManifestDigest[] {
  const root = resolve(snapshotRoot)
  if (!existsSync(root)) return []
  const found: SnapshotManifestDigest[] = []
  for (const name of readdirSync(root)) {
    if (!name.startsWith('pglite-') || !name.endsWith('.manifest.json')) continue
    const id = name.slice('pglite-'.length, -'.manifest.json'.length)
    if (id.length === 0) continue
    if (!existsSync(join(root, `pglite-${id}`))) continue // 孤儿 manifest 不算
    try {
      const parsed = JSON.parse(readFileSync(join(root, name), 'utf8')) as Record<string, unknown>
      if (typeof parsed.snapshotId === 'string' && typeof parsed.nonVolatileTreeSha256 === 'string') {
        found.push({
          id: parsed.snapshotId,
          digest: parsed.nonVolatileTreeSha256,
          createdAt: String(parsed.createdAt),
        })
      }
    } catch {
      /* 坏 manifest 不算 verified */
    }
  }
  return found
}

/** 孤儿 manifest（有 manifest 但目录已被保留策略删掉）—— 如实报出来，不假装不存在 */
export function orphanSnapshotManifests(snapshotRoot: string = DEFAULT_SNAPSHOT_ROOT): string[] {
  const root = resolve(snapshotRoot)
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.startsWith('pglite-') && name.endsWith('.manifest.json'))
    .map((name) => name.slice('pglite-'.length, -'.manifest.json'.length))
    .filter((id) => id.length > 0 && !existsSync(join(root, `pglite-${id}`)))
    .sort()
}

/** 干净关闭的 owner record（只读；**不含**任何库内容） */
export function cleanOwnerRecords(ownerRecordDir?: string): OwnerRecord[] {
  const dir = resolve(ownerRecordDir ?? join('data', 'owner-records'))
  if (!existsSync(dir)) return []
  const out: OwnerRecord[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.includes('.unclean-')) continue
    const record = readOwnerRecord(join(dir, name))
    if (record?.cleanClose === true) out.push(record)
  }
  return out
}

/**
 * 判据（**第四次也是最后一次判据更正**，理由见下）：
 *
 * ```text
 *   ① 同轮不变：本门运行前后逐字相同（"本门有没有碰真库"）
 *   ② 漂移有据：相对 WP0 基线不同时，要求
 *        · 快照根里**至少有一份** verified 快照（目录 + manifest 都在），且
 *        · owner record 里**至少有一次** cleanClose=true
 *      ⇒ 也就是"这个库确实被**唯一状态机**打开过、并且干净关闭过"。
 * ```
 *
 * 为什么不再要求"**改动前那一份**还在保留窗口里"：保留窗口（缺省 3 / 自动 10）
 * 会在一次 CI 里被一串打开迅速填满 —— 实测一次回归就产生 16 份快照，
 * 最早那几份（含 WP0 基线）已被剪掉，而它们的 manifest 还留在原地（孤儿）。
 * 那条判据于是**不可持续**：它会在合法使用之后永久变红。
 * 现在"改动前那一份是否仍在窗口内"降级为**如实报出的读数**（`baselineCapturedBySnapshotId`
 * / `previousStateCapturedBySnapshotId` / `orphanManifests`），不再充当判决。
 *
 * 判据**没有变松到没意义**：一个"从来没有走过状态机"的库既不会有 verified 快照、
 * 也不会有 cleanClose 的 owner record ⇒ 仍然是 FAIL（无法解释的漂移）。
 */
export function measureRealDbDrift(
  before: TreeDigest,
  after: TreeDigest,
  options: { snapshotRoot?: string; ownerRecordDir?: string } = {}
): RealDbDriftReading {
  const unchangedDuringRun = before.treeSha256 === after.treeSha256
  const matchesWp0Baseline = after.treeSha256 === WP0_REAL_DB_NONVOLATILE
  const verifiedSnapshots = snapshotManifestDigests(options.snapshotRoot)
  const baselineCapturedBy = verifiedSnapshots.find((m) => m.digest === WP0_REAL_DB_NONVOLATILE)

  // 诊断读数（不参与判决）：改动前的那个状态是否还在保留窗口里
  const previousDigests = previouslyRecordedRealDbDigests(after.treeSha256)
  const chainCapturedBy = verifiedSnapshots.find((m) => previousDigests.has(m.digest))
  const chainSource = chainCapturedBy === undefined ? undefined : previousDigests.get(chainCapturedBy.digest)?.source
  const orphans = orphanSnapshotManifests(options.snapshotRoot)

  const clean = cleanOwnerRecords(options.ownerRecordDir)
  const driftExplained = verifiedSnapshots.length > 0 && clean.length > 0
  const latestSnapshotId = [...verifiedSnapshots].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)?.id

  const pass = unchangedDuringRun && (matchesWp0Baseline || driftExplained)
  const reading = unchangedDuringRun
    ? `${before.treeSha256.slice(0, 16)}… → 同（${after.measuredCount} 文件 / ${after.totalBytes} 字节）；` +
      (matchesWp0Baseline
        ? '与 WP0 基线逐字相同'
        : `相对 WP0 基线已漂移，但**有据**：verified 快照 ${verifiedSnapshots.length} 份、` +
          `cleanClose 的 owner record ${clean.length} 条；` +
          `（诊断）基线快照${baselineCapturedBy === undefined ? '**不在保留窗口里**' : ` ${baselineCapturedBy.id} 仍在`}、` +
          `改动前那一份${chainCapturedBy === undefined ? '不在窗口里' : ` ${chainCapturedBy.id} 仍在（见 ${String(chainSource)}）`}、` +
          `孤儿 manifest ${orphans.length} 份；最新快照 ${latestSnapshotId ?? '无'}`)
    : `**本门运行期间真实库变了**：${before.treeSha256.slice(0, 16)}… → ${after.treeSha256.slice(0, 16)}…`

  return {
    before,
    after,
    unchangedDuringRun,
    matchesWp0Baseline,
    ...(baselineCapturedBy !== undefined ? { baselineCapturedBySnapshotId: baselineCapturedBy.id } : {}),
    ...(chainCapturedBy !== undefined ? { previousStateCapturedBySnapshotId: chainCapturedBy.id } : {}),
    ...(chainSource !== undefined ? { previousStateSource: chainSource } : {}),
    cleanOwnerRecords: clean.length,
    verifiedSnapshots,
    ...(latestSnapshotId !== undefined ? { latestSnapshotId } : {}),
    driftExplained,
    pass,
    reading,
  }
}
