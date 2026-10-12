/**
 * INC-01 **WP5** —— 恢复工具（`AT5.1`…`AT5.4`）。
 *
 * ============================================================================
 *  它证明什么、以及**不**证明什么
 * ============================================================================
 * 它证明"快照**真的能恢复**"，而不只是"有一堆目录"：
 *
 * ```text
 *   snapshot（永不原地打开）
 *     → <dataDir>.restore-staging-<ts>      复制 + 校验（摘要 == manifest）
 *     → <dataDir>.quarantine-<ts>           当前库**原子改名**挪开（绝不原地覆盖）
 *     → <dataDir>                            staging **原子改名**就位
 * ```
 *
 * 任何一步失败都**保留** quarantine 与 staging，并且**绝不**说"恢复成功"。
 *
 * ============================================================================
 *  三条硬边界
 * ============================================================================
 * 1. **只认 snapshot ID，不认路径**（`AT5.1`）：`--from` 只接受
 *    `<ISO 时间戳>-<12 位摘要>` 形状的 ID；任何路径分隔符 / `..` / 绝对路径一律拒绝，
 *    因此"把 `--from` 指向任意目录"在形状校验这一层就做不到。
 * 2. **永不打开快照本体**（`INC01-D3`）：打开会改 `pg_control` / WAL，
 *    于是健康探针只对 snapshot 的**一次性副本**做。
 * 3. **真实库上的 `--apply` 需要当轮授权**（计划书 §WP5 Authorization Boundary）：
 *    `PROJECT_LG_ALLOW_RESTORE_APPLY` 必须**逐字**等于 `'<snapshotId>@<解析后的 dataDir>'`。
 *    布尔式开关**不是**授权 —— 它挡不住"授权一个别的库/别的快照"。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { isProductionDir } from '../../dev/sandbox.ts'
import {
  digestTree,
  isLeaseHeld,
  runHealthProbe,
  type HealthProbeResult,
  type SnapshotManifest,
  type TreeDigest,
} from './production-db-safety.ts'

// ---------------------------------------------------------------------------
// 失败码（闭集：每一条都对应一个**可判**的现场）
// ---------------------------------------------------------------------------

export type RestoreFailure =
  | 'snapshot_id_invalid'
  | 'snapshot_not_found'
  | 'manifest_missing'
  | 'manifest_unreadable'
  | 'manifest_mismatch'
  | 'snapshot_digest_mismatch'
  | 'snapshot_health_failed'
  | 'data_dir_missing'
  | 'lease_held'
  | 'target_exists'
  | 'same_path'
  | 'path_escape'
  | 'apply_not_authorized'
  | 'staging_digest_mismatch'
  | 'quarantine_failed'
  | 'promote_failed'

export const RESTORE_FAILURES: readonly RestoreFailure[] = [
  'snapshot_id_invalid',
  'snapshot_not_found',
  'manifest_missing',
  'manifest_unreadable',
  'manifest_mismatch',
  'snapshot_digest_mismatch',
  'snapshot_health_failed',
  'data_dir_missing',
  'lease_held',
  'target_exists',
  'same_path',
  'path_escape',
  'apply_not_authorized',
  'staging_digest_mismatch',
  'quarantine_failed',
  'promote_failed',
]

/** 恢复过程的每一步（`AT5.1`：dry-run 要把"将发生的原子改名"逐条打出来） */
export interface RestoreStep {
  ordinal: number
  action: string
  detail: string
  /** dry-run 时为 `'planned'`；apply 时为 `'done'` 或 `'failed'` */
  status: 'planned' | 'done' | 'failed' | 'skipped'
}

export interface RestoreReading {
  ok: boolean
  mode: 'dry-run' | 'apply'
  failure?: RestoreFailure
  detail?: string
  snapshotId?: string
  snapshotPath?: string
  manifestPath?: string
  manifest?: SnapshotManifest
  dataDir?: string
  stagingPath?: string
  quarantinePath?: string
  /** 源（当前库）在动它之前的摘要 */
  dataDirDigestBefore?: TreeDigest
  /** 快照此刻的摘要（与 manifest 比过） */
  snapshotDigestNow?: TreeDigest
  /** 就位后的 dataDir 摘要（应逐字等于 manifest） */
  restoredDigest?: TreeDigest
  health?: HealthProbeResult
  steps: RestoreStep[]
  /** 失败后**什么东西被保留下来**（现场不许被清理掉） */
  quarantineRetained: boolean
  stagingRetained: boolean
  snapshotRetained: boolean
  /** 给人看的下一步（**恢复成功时也写**：它不代表"已经能聊天了"） */
  nextAction: string
}

// ---------------------------------------------------------------------------
// `AT5.1` 只认 ID
// ---------------------------------------------------------------------------

/**
 * 快照 ID 的形状：`<ISO 时间戳（`:`/`.` 换成 `-`）>-<源摘要前 12 位>`。
 *
 * 判据刻意**白名单式**（只允许数字/大写字母/`-`），因此
 * `..`、`/`、`\\`、盘符、UNC 一律在形状层就被拒 —— 不依赖"事后检查路径"。
 */
const SNAPSHOT_ID_PATTERN = /^[0-9A-Za-z]+(?:-[0-9A-Za-z]+)*$/

export function isSnapshotIdShaped(snapshotId: string): boolean {
  if (snapshotId.length === 0 || snapshotId.length > 120) return false
  if (snapshotId.includes('/') || snapshotId.includes('\\') || snapshotId.includes(':')) return false
  if (snapshotId.startsWith('.') || snapshotId.includes('..')) return false
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) return false
  // 末尾 12 位十六进制（`createVerifiedSnapshot` 的算法）
  return /-[0-9a-f]{12}$/.test(snapshotId)
}

export function snapshotPathsOf(
  snapshotRoot: string,
  snapshotId: string
): { snapshotPath: string; manifestPath: string } {
  const root = resolve(snapshotRoot)
  return {
    snapshotPath: join(root, `pglite-${snapshotId}`),
    manifestPath: join(root, `pglite-${snapshotId}.manifest.json`),
  }
}

export function readSnapshotManifest(manifestPath: string): SnapshotManifest | undefined {
  if (!existsSync(manifestPath)) return undefined
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 授权（`--apply` 的真实库边界）
// ---------------------------------------------------------------------------

/** 当轮授权串：**逐字**对齐 `<snapshotId>@<解析后的 dataDir>` */
export function restoreAuthorizationValue(snapshotId: string, dataDir: string): string {
  return `${snapshotId}@${resolve(dataDir)}`
}

export function restoreAuthorizationMatches(
  value: string | undefined,
  snapshotId: string,
  dataDir: string
): boolean {
  if (value === undefined || value.trim().length === 0) return false
  return value.trim() === restoreAuthorizationValue(snapshotId, dataDir)
}

// ---------------------------------------------------------------------------
// dry-run（`AT5.1`）—— **不写任何东西**
// ---------------------------------------------------------------------------

export interface PlanRestoreOptions {
  snapshotRoot: string
  snapshotId: string
  dataDir: string
  /** 健康探针跑在一次性副本上（缺省真实现；门可注入） */
  healthProbe?: (dir: string) => Promise<HealthProbeResult>
  /** 一次性副本的父目录（缺省系统 %TEMP%） */
  disposableRoot?: string
  /** 缺省连健康探针一起做；`false` 只做只读校验（快照摘要 + 租约 + 路径） */
  verifyHealth?: boolean
  /** 测试注入：`isLeaseHeld` */
  leaseHeld?: (dataDir: string) => Promise<boolean>
}

/**
 * `AT5.1`：**默认动作**。校验 manifest、内容摘要、健康与当前租约状态，
 * 并把将要发生的原子改名逐条打出来；**一个字节都不写**（健康探针跑在 `%TEMP%` 副本上）。
 */
export async function planRestore(options: PlanRestoreOptions): Promise<RestoreReading> {
  const dataDir = resolve(options.dataDir)
  const steps: RestoreStep[] = []
  const reading: RestoreReading = {
    ok: false,
    mode: 'dry-run',
    dataDir,
    steps,
    quarantineRetained: false,
    stagingRetained: false,
    snapshotRetained: true,
    nextAction: '（未执行任何改动）',
  }
  const fail = (failure: RestoreFailure, detail: string): RestoreReading => ({
    ...reading,
    ok: false,
    failure,
    detail,
    nextAction: '修好上面这条再重来；**没有**任何东西被改动。',
  })

  /*
   * dry-run 还**不知道**时间戳（apply 时才生成），所以这里如实写成 `<ts>` 占位符 ——
   * 不编一个看起来很确定的路径。
   */
  const stagingPath = `${dataDir}.restore-staging-<ts>`
  const quarantinePath = `${dataDir}.quarantine-<ts>`
  reading.stagingPath = stagingPath
  reading.quarantinePath = quarantinePath

  // ① 形状
  if (!isSnapshotIdShaped(options.snapshotId)) {
    steps.push({ ordinal: 1, action: 'validate-id', detail: `拒绝非法 snapshot ID：${options.snapshotId}`, status: 'failed' })
    return fail('snapshot_id_invalid', 'snapshot ID 形状非法（只允许 `<时间戳>-<12 位摘要>`，不接受任何路径）')
  }
  steps.push({ ordinal: 1, action: 'validate-id', detail: `ID 形状通过：${options.snapshotId}`, status: 'done' })

  const { snapshotPath, manifestPath } = snapshotPathsOf(options.snapshotRoot, options.snapshotId)
  reading.snapshotId = options.snapshotId
  reading.snapshotPath = snapshotPath
  reading.manifestPath = manifestPath

  // ② 目录 + manifest 都在
  if (!existsSync(snapshotPath)) {
    steps.push({ ordinal: 2, action: 'read-snapshot', detail: `快照目录不存在：${snapshotPath}`, status: 'failed' })
    return fail('snapshot_not_found', `快照目录不存在：${snapshotPath}`)
  }
  if (!existsSync(manifestPath)) {
    steps.push({ ordinal: 2, action: 'read-snapshot', detail: `manifest 不存在：${manifestPath}`, status: 'failed' })
    return fail('manifest_missing', `快照缺 manifest（未完成晋升）：${manifestPath}`)
  }
  const manifest = readSnapshotManifest(manifestPath)
  if (manifest === undefined) {
    steps.push({ ordinal: 2, action: 'read-snapshot', detail: 'manifest 不可读', status: 'failed' })
    return fail('manifest_unreadable', `manifest 不可解析：${manifestPath}`)
  }
  reading.manifest = manifest
  if (manifest.snapshotId !== options.snapshotId) {
    steps.push({
      ordinal: 2,
      action: 'read-snapshot',
      detail: `manifest 的 snapshotId=${manifest.snapshotId} 与请求的 ${options.snapshotId} 不一致`,
      status: 'failed',
    })
    return fail('manifest_mismatch', 'manifest 与请求的快照 id 不一致')
  }
  steps.push({
    ordinal: 2,
    action: 'read-snapshot',
    detail: `快照 + manifest 都在（${manifest.fileCount} 文件 / ${manifest.totalBytes} 字节 / schema [${manifest.schemaVersions.join(',')}]）`,
    status: 'done',
  })

  // ③ 内容摘要必须逐字等于 manifest（改 1 字节就该响）
  const snapshotDigestNow = digestTree(snapshotPath)
  reading.snapshotDigestNow = snapshotDigestNow
  if (snapshotDigestNow.treeSha256 !== manifest.nonVolatileTreeSha256) {
    steps.push({
      ordinal: 3,
      action: 'verify-snapshot-digest',
      detail: `快照摘要 ${snapshotDigestNow.treeSha256.slice(0, 12)}… != manifest ${manifest.nonVolatileTreeSha256.slice(0, 12)}…`,
      status: 'failed',
    })
    return fail('snapshot_digest_mismatch', '快照内容与 manifest 不一致（快照被动过）')
  }
  steps.push({
    ordinal: 3,
    action: 'verify-snapshot-digest',
    detail: `快照摘要逐字等于 manifest（${snapshotDigestNow.treeSha256.slice(0, 16)}…，${snapshotDigestNow.measuredCount} 文件）`,
    status: 'done',
  })

  // ④ 目标库必须在
  if (!existsSync(dataDir)) {
    steps.push({ ordinal: 4, action: 'check-target', detail: `当前 dataDir 不存在：${dataDir}`, status: 'failed' })
    return fail('data_dir_missing', `当前 dataDir 不存在：${dataDir}`)
  }
  if (resolve(snapshotPath) === dataDir) {
    steps.push({ ordinal: 4, action: 'check-target', detail: '快照与目标库是同一个目录', status: 'failed' })
    return fail('same_path', '快照目录不能就是目标 dataDir')
  }
  /*
   * 目标库**不得**位于快照根之内：否则第 ⑧ 步会把快照仓里的东西改名走
   * （"把 `data/snapshots/pglite-<id>` 当成 dataDir" 是这条命令最危险的误用）。
   */
  const snapshotRootResolved = resolve(options.snapshotRoot)
  if (dataDir === snapshotRootResolved || dataDir.startsWith(snapshotRootResolved + sep)) {
    steps.push({
      ordinal: 4,
      action: 'check-target',
      detail: `拒绝把 dataDir 指到快照根里面：${dataDir}`,
      status: 'failed',
    })
    return fail('path_escape', `dataDir 不得位于快照根之内：${dataDir}`)
  }
  steps.push({ ordinal: 4, action: 'check-target', detail: `当前 dataDir 存在，且不是快照目录：${dataDir}`, status: 'done' })

  // ⑤ 租约：有人持有 ⇒ 拒（"恢复一个正在被打开的库"是最坏的情形之一）
  const leaseHeld = await (options.leaseHeld ?? isLeaseHeld)(dataDir)
  if (leaseHeld) {
    steps.push({ ordinal: 5, action: 'check-lease', detail: 'dataDir 上有人持有跨进程租约', status: 'failed' })
    return fail('lease_held', '目标库正被另一个进程持有（租约）⇒ 拒绝恢复')
  }
  steps.push({ ordinal: 5, action: 'check-lease', detail: '没有人持有该 dataDir 的租约', status: 'done' })

  // ⑥ 目标路径可用
  for (const [label, path] of [
    ['staging', stagingPath],
    ['quarantine', quarantinePath],
  ] as const) {
    if (existsSync(path)) {
      steps.push({ ordinal: 6, action: 'check-targets', detail: `${label} 已存在：${path}`, status: 'failed' })
      return fail('target_exists', `${label} 路径已存在（不覆盖现场）：${path}`)
    }
  }
  steps.push({
    ordinal: 6,
    action: 'check-targets',
    detail: `staging / quarantine 路径可用（都将是 dataDir 的**同级**目录 ⇒ 同卷 ⇒ rename 原子）`,
    status: 'done',
  })

  // ⑦ 健康探针：只对**一次性副本**做（快照本体永不被打开）
  if (options.verifyHealth !== false) {
    const probe = options.healthProbe ?? runHealthProbe
    /*
     * 一次性副本放到 `%TEMP%`（**绝不**放进快照根：那会污染快照仓，
     * 也会让"快照目录里有什么"这件事变得不可预测）。
     */
    const disposableParent = options.disposableRoot ?? tmpdir()
    const disposable = join(disposableParent, `inc01-restore-verify-${process.pid}-${Date.now()}`)
    try {
      mkdirSync(disposableParent, { recursive: true })
      cpSync(snapshotPath, disposable, { recursive: true })
      const health = await probe(disposable)
      reading.health = health
      if (!health.ok) {
        steps.push({
          ordinal: 7,
          action: 'verify-health',
          detail: `一次性副本健康探针失败：${String(health.reason)}`,
          status: 'failed',
        })
        return fail('snapshot_health_failed', `快照健康验证失败：${String(health.reason)}`)
      }
      steps.push({
        ordinal: 7,
        action: 'verify-health',
        detail: `一次性副本：表数 ${health.tableCount}、schema [${health.schemaVersions.join(',')}]、closed=${String(health.closed)}（**快照本体未被打开**）`,
        status: 'done',
      })
    } finally {
      rmSync(disposable, { recursive: true, force: true })
    }
  } else {
    steps.push({ ordinal: 7, action: 'verify-health', detail: '（按调用方要求跳过健康探针）', status: 'skipped' })
  }

  // ⑧ 预告将发生的原子改名（dry-run 的全部产出）
  steps.push({
    ordinal: 8,
    action: 'plan-rename',
    detail: `将执行：rename(${dataDir} → ${quarantinePath})`,
    status: 'planned',
  })
  steps.push({
    ordinal: 9,
    action: 'plan-rename',
    detail: `将执行：copy(${snapshotPath} → staging) → rename(staging → ${dataDir})`,
    status: 'planned',
  })

  return {
    ...reading,
    ok: true,
    detail: 'DRY RUN：校验全通过；**没有改动任何东西**',
    nextAction:
      `确认无误后（且这是你要的那一份）：` +
      `PROJECT_LG_ALLOW_RESTORE_APPLY='${restoreAuthorizationValue(options.snapshotId, dataDir)}' ` +
      `pnpm db:restore --from ${options.snapshotId} --data-dir ${dataDir} --apply`,
  }
}

// ---------------------------------------------------------------------------
// apply（`AT5.2`/`AT5.4`）
// ---------------------------------------------------------------------------

export interface ApplyRestoreOptions {
  /** 注入的 rename（`AT5.4` 用它注入"第二次改名失败"） */
  rename?: (from: string, to: string) => void
  /** 复制完成后、校验 staging 之前触发（注入"staging 被改"） */
  afterCopy?: () => void
  /** 当轮授权串；真实库必须逐字匹配 */
  authorization?: string
  now?: () => Date
  /** 测试注入：`isLeaseHeld` */
  leaseHeld?: (dataDir: string) => Promise<boolean>
}

/**
 * `AT5.2`：在**已经 plan 过**的读数上执行原子切换。
 *
 * 顺序**不可调换**：
 * ```text
 *   ① 授权（真实库必须逐字匹配）
 *   ② copy(snapshot → staging) + 校验 staging 摘要 == manifest
 *   ③ rename(dataDir → quarantine)      ← 当前库**挪开**，不是删、不是覆盖
 *   ④ rename(staging → dataDir)         ← 就位
 *   ⑤ 重算 dataDir 摘要 == manifest
 * ```
 * ③ 之后、⑤ 之前的任何失败都让旧库留在 quarantine、staging 留在原地，
 * 并且**绝不**返回 `ok: true`。
 */
export async function applyRestore(
  plan: RestoreReading,
  options: ApplyRestoreOptions = {}
): Promise<RestoreReading> {
  const now = options.now ?? ((): Date => new Date())
  const rename = options.rename ?? renameSync
  const stamp = now().toISOString().replace(/[:.]/g, '-')

  const dataDir = plan.dataDir
  if (dataDir === undefined || plan.snapshotId === undefined || plan.snapshotPath === undefined) {
    return { ...plan, ok: false, mode: 'apply', failure: 'data_dir_missing', detail: 'plan 读数不完整' }
  }
  const stagingPath = `${dataDir}.restore-staging-${stamp}`
  const quarantinePath = `${dataDir}.quarantine-${stamp}`
  const steps: RestoreStep[] = []
  const reading: RestoreReading = {
    ...plan,
    ok: false,
    mode: 'apply',
    stagingPath,
    quarantinePath,
    steps,
    quarantineRetained: false,
    stagingRetained: false,
    snapshotRetained: true,
    nextAction: '',
  }
  const fail = (failure: RestoreFailure, detail: string, extra: Partial<RestoreReading> = {}): RestoreReading => ({
    ...reading,
    ...extra,
    ok: false,
    failure,
    detail,
    quarantineRetained: existsSync(quarantinePath),
    stagingRetained: existsSync(stagingPath),
    snapshotRetained: existsSync(plan.snapshotPath as string),
    nextAction:
      failure === 'promote_failed'
        ? `旧库**仍在** ${quarantinePath}（没有被删）；staging 保留在 ${stagingPath}。` +
          `修好之后要么把 quarantine 改回 ${dataDir}，要么重跑本命令（**不是**"已恢复"。）`
        : `现场已保留；**没有**恢复成功。`,
  })

  // ① 授权
  if (isProductionDir(dataDir) && !restoreAuthorizationMatches(options.authorization, plan.snapshotId, dataDir)) {
    steps.push({
      ordinal: 1,
      action: 'authorize',
      detail:
        `拒绝在真实库上 apply：需要当轮授权 ` +
        `PROJECT_LG_ALLOW_RESTORE_APPLY='${restoreAuthorizationValue(plan.snapshotId, dataDir)}'`,
      status: 'failed',
    })
    return fail('apply_not_authorized', '真实库的恢复属于破坏性状态切换，必须对**这个**快照 ID 与**这个** dataDir 当轮授权')
  }
  steps.push({ ordinal: 1, action: 'authorize', detail: '授权检查通过（或目标不是真实库）', status: 'done' })

  // ② copy + 校验（这一步之前**没有任何**对 dataDir 的改动）
  if (existsSync(stagingPath) || existsSync(quarantinePath)) {
    steps.push({ ordinal: 2, action: 'stage', detail: 'staging / quarantine 路径已被占用', status: 'failed' })
    return fail('target_exists', `staging 或 quarantine 已存在：${stagingPath} / ${quarantinePath}`)
  }
  try {
    cpSync(plan.snapshotPath, stagingPath, { recursive: true })
    if (options.afterCopy !== undefined) options.afterCopy()
  } catch (error) {
    steps.push({ ordinal: 2, action: 'stage', detail: `复制失败：${String(error)}`, status: 'failed' })
    rmSync(stagingPath, { recursive: true, force: true })
    return fail('quarantine_failed', `把快照复制到 staging 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const stagingDigest = digestTree(stagingPath)
  const manifestDigest = plan.manifest?.nonVolatileTreeSha256
  if (manifestDigest !== undefined && stagingDigest.treeSha256 !== manifestDigest) {
    steps.push({
      ordinal: 2,
      action: 'stage',
      detail: `staging 摘要 ${stagingDigest.treeSha256.slice(0, 12)}… != manifest ${manifestDigest.slice(0, 12)}…`,
      status: 'failed',
    })
    return fail('staging_digest_mismatch', 'staging 内容与 manifest 不一致（复制过程中被动过）')
  }
  steps.push({
    ordinal: 2,
    action: 'stage',
    detail: `copy(${plan.snapshotPath} → staging) 完成，摘要 ${stagingDigest.treeSha256.slice(0, 16)}…`,
    status: 'done',
  })

  // ③ 当前库 → quarantine（原子改名，不删不覆盖）
  reading.dataDirDigestBefore = digestTree(dataDir)
  try {
    rename(dataDir, quarantinePath)
  } catch (error) {
    steps.push({ ordinal: 3, action: 'quarantine', detail: `rename 失败：${String(error)}`, status: 'failed' })
    return fail(
      'quarantine_failed',
      `把当前库挪到 quarantine 失败：${error instanceof Error ? error.message : String(error)}；dataDir **未被动过**`
    )
  }
  steps.push({
    ordinal: 3,
    action: 'quarantine',
    detail: `rename(${dataDir} → ${quarantinePath})：当前库已挪开（**未删除**）`,
    status: 'done',
  })

  // ④ staging → dataDir（这一步失败就是 `AT5.4` 要证明的现场）
  try {
    rename(stagingPath, dataDir)
  } catch (error) {
    steps.push({
      ordinal: 4,
      action: 'promote',
      detail: `rename(${stagingPath} → ${dataDir}) 失败：${String(error)}`,
      status: 'failed',
    })
    return fail(
      'promote_failed',
      `staging 就位失败（第二次 rename）：${error instanceof Error ? error.message : String(error)}`
    )
  }
  steps.push({ ordinal: 4, action: 'promote', detail: `rename(staging → ${dataDir}) 完成`, status: 'done' })

  // ⑤ 摘要复核
  const restoredDigest = digestTree(dataDir)
  if (manifestDigest !== undefined && restoredDigest.treeSha256 !== manifestDigest) {
    steps.push({
      ordinal: 5,
      action: 'verify-restored',
      detail: `就位后摘要 ${restoredDigest.treeSha256.slice(0, 12)}… != manifest ${manifestDigest.slice(0, 12)}…`,
      status: 'failed',
    })
    return fail('snapshot_digest_mismatch', '就位后的 dataDir 摘要与 manifest 不一致', {
      restoredDigest,
    })
  }
  steps.push({
    ordinal: 5,
    action: 'verify-restored',
    detail: `就位后摘要逐字等于 manifest（${restoredDigest.treeSha256.slice(0, 16)}…，${restoredDigest.measuredCount} 文件）`,
    status: 'done',
  })

  return {
    ...reading,
    ok: true,
    restoredDigest,
    detail: `恢复完成：${plan.snapshotId} → ${dataDir}`,
    quarantineRetained: true,
    stagingRetained: false,
    snapshotRetained: true,
    nextAction:
      `旧库保留在 ${quarantinePath}（确认新库没问题之后再自己决定删不删；本工具**永不**代删）。` +
      `下一次打开会重新走租约 + pre-open 快照状态机。`,
  }
}

/** 把现场写成人能读的一行（CLI 与门共用；**不含**任何库内容） */
export function renderRestoreReading(reading: RestoreReading): string {
  const lines = [
    `${reading.ok ? 'PASS' : 'FAIL'}  ${reading.mode}${reading.failure === undefined ? '' : `  [${reading.failure}]`}`,
    `  snapshot   : ${reading.snapshotId ?? '-'}`,
    `  dataDir    : ${reading.dataDir ?? '-'}`,
    `  staging    : ${reading.stagingPath ?? '-'}`,
    `  quarantine : ${reading.quarantinePath ?? '-'}`,
    `  detail     : ${reading.detail ?? '-'}`,
    `  retained   : quarantine=${String(reading.quarantineRetained)} staging=${String(reading.stagingRetained)} snapshot=${String(reading.snapshotRetained)}`,
    `  next       : ${reading.nextAction}`,
    '  steps:',
    ...reading.steps.map((step) => `    ${step.status === 'done' ? '✓' : step.status === 'failed' ? '✗' : '·'} [${step.ordinal}] ${step.action}: ${step.detail}`),
  ]
  return lines.join('\n')
}

/** 恢复记录（取证；**只写摘要素**，不写任何库内容） */
export function writeRestoreRecord(reading: RestoreReading, path: string): void {
  const record = {
    at: new Date().toISOString(),
    mode: reading.mode,
    ok: reading.ok,
    failure: reading.failure ?? null,
    snapshotId: reading.snapshotId ?? null,
    dataDir: reading.dataDir ?? null,
    quarantinePath: reading.quarantinePath ?? null,
    stagingPath: reading.stagingPath ?? null,
    dataDirDigestBefore: reading.dataDirDigestBefore?.treeSha256 ?? null,
    restoredDigest: reading.restoredDigest?.treeSha256 ?? null,
    manifestDigest: reading.manifest?.nonVolatileTreeSha256 ?? null,
    fileCount: reading.manifest?.fileCount ?? null,
    tableCount: reading.health?.tableCount ?? null,
    schemaVersions: reading.health?.schemaVersions ?? reading.manifest?.schemaVersions ?? [],
    steps: reading.steps.map((step) => `${step.ordinal}:${step.action}:${step.status}`),
  }
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}
