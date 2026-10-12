/**
 * M6.1 —— **证据与运行目录的共享判据**（WP0 / WP1 / 汇总 / 组件门共用同一份）。
 *
 * ============================================================================
 *  它修的是 TD-04，所以它的形状与 M6 的那一份**故意不同**
 * ============================================================================
 * M6 的证据纪律里有两处已被登记为技术债（`M6-Known-Limitations` §6.1/6.2）：
 *
 * ```text
 *   TD-04① 同 HEAD 的两次运行**共用/覆盖**同一个 runId 目录 ⇒ 先前的读数被抹掉
 *   TD-04② 汇总按"最新 PASS"或固定旧路径挑证据 ⇒ 旧绿冒充本次结论
 * ```
 *
 * 因此本模块提供两件 M6 没有的东西：
 *
 * ```text
 *   openRunDir()            目录已存在 ⇒ **抛**（绝不 recursive:true 静默复用）
 *   writeManifestAtomic()   先写 .manifest.tmp 再 rename 晋升
 *                           ⇒ 读者**永远**看不到半份清单；中断运行只留下 INCOMPLETE
 *   sealManifest()          payloadSha256（去掉自身后的稳定序列化摘要）
 *                           ⇒ 清单被事后改动是**可机器判定**的
 * ```
 *
 * ============================================================================
 *  为什么清单校验要**复用** M6 的那一份
 * ============================================================================
 * `validateManifest()`（`scripts/m6-evidence.ts`）已经把六类**真实事故形态**写成判据
 * （缺字段 / 零计数 / 无声跳过 / 旧提交 / 无归属证据 / 失败轮次被丢弃）。
 * 重写一遍会让"M6.1 说它能抓 X、却按另一套规则读"重新长出来 —— 那正是那个模块
 * 头部注释要防的分歧。M6.1 的字段集是它的**超集**（追加契约/语料/量具版本与取代关系），
 * 所以先跑 M6 的通用检查，再跑 M6.1 的追加检查。
 *
 * ⚠️ 本模块**不读 `process.argv`、不读 `process.env`、不 spawn、不 exit**：
 * 所有输入都是参数，所有输出都是返回值或显式异常 —— 于是它可以被穷举断言。
 * （唯一的副作用集中在那三个显式的 FS 函数里，且都以 `runDir` 为参数。）
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

import { MeasurementInvalidError } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  M6_MANIFEST_REQUIRED_FIELDS,
  validateManifest,
  type ManifestProblem,
} from './m6-evidence.ts'

// ---------------------------------------------------------------------------
// 异常
// ---------------------------------------------------------------------------

/** runId 目录已存在 —— **拒绝覆盖**（TD-04①）。 */
export class RunDirExistsError extends Error {}

/** runId 形状非法（含路径分隔符 / `..` / 空段）—— 直接拒绝，不做路径归一化猜测。 */
export class RunIdInvalidError extends Error {}

/** 标准契约清单缺字段 —— **拒绝落盘**（失败关闭；L-M61-14）。 */
export class ManifestIncompleteError extends Error {}

/**
 * 标准契约清单的 `schemaVersion`。
 *
 * ⚠️ 只有它受"字段齐全"闸约束：`m6.1-live-long.ts` 写的是
 * `m6.1-long-manifest@1`（**另一套**形状，供人审包用），故意不受此闸管辖。
 */
export const STANDARD_MANIFEST_SCHEMA = 'm6.1-manifest@1'

// ---------------------------------------------------------------------------
// 门登记表（`m6.1:gates` 的唯一输入）
// ---------------------------------------------------------------------------

export interface M6_1GateSpec {
  readonly id: string
  readonly label: string
  /** 产出它的命令（**只用于展示与人工复核**，汇总不会执行它） */
  readonly command: string
  /** 证据 `schemaVersion`（用来把落盘 JSON 归到某个门） */
  readonly schemaVersion: string
  /**
   * 这个门的**可接受判决**。
   *
   * ⚠️ `wp1-corpus` 只接受 `FROZEN`：本段交付的是**待真人审核**的材料，
   *    它的 verdict 是 `AWAITING HUMAN REVIEW` ⇒ 汇总会如实显示"未审"，
   *    而**不是**把它混进一个绿色的总数（与 M6 对 G1 的处理同形）。
   */
  readonly acceptVerdicts: readonly string[]
  /** 必选门：缺失 ⇒ overall 不能是 PASS */
  readonly required: boolean
}

export const M6_1_GATE_SPECS: readonly M6_1GateSpec[] = [
  {
    id: 'component',
    label: 'L1 部件门（证据判据 / 语料判据 / 入口守卫，离线、无 DB、无 key）',
    command: 'pnpm m6.1:test',
    schemaVersion: 'm6.1-component@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'measurement',
    label: 'L0 量具自证（冻结语料上的三段式：正控 / 负控 / 恢复；夹具判定器）',
    command: 'pnpm m6.1:measurement:verify',
    schemaVersion: 'm6.1-measurement@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp0-baseline',
    label: 'WP0 基线与前置核对（只读：不跑模型、不打开真实库）',
    command: 'pnpm m6.1:wp0:baseline --out artifacts/m6.1/<runId>',
    schemaVersion: 'm6.1-wp0-baseline@1',
    acceptVerdicts: ['BASELINE CAPTURED'],
    required: true,
  },
  {
    id: 'wp1-corpus',
    label: 'WP1 判定契约与人工标注集（待真人审核 ⇒ 未批准时不得算 PASS）',
    command: 'pnpm m6.1:wp1:verify',
    schemaVersion: 'm6.1-wp1-corpus@1',
    acceptVerdicts: ['FROZEN'],
    required: true,
  },
]

// ---------------------------------------------------------------------------
// manifest 必填字段：M6 的通用集 ∪ M6.1 的追加集
// ---------------------------------------------------------------------------

/** M6.1 相对 M6 追加的字段（契约/语料/量具版本、取代关系、清单自摘要）。 */
export const M6_1_EXTRA_MANIFEST_FIELDS: readonly string[] = [
  'contractVersion',
  'corpusVersion',
  'instrumentVersion',
  'supersedes',
  'phases',
  'payloadSha256',
]

export const M6_1_MANIFEST_REQUIRED_FIELDS: readonly string[] = [
  ...M6_MANIFEST_REQUIRED_FIELDS,
  ...M6_1_EXTRA_MANIFEST_FIELDS,
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// 稳定序列化 + 清单自摘要（"清单被事后改过"是可机器判定的）
// ---------------------------------------------------------------------------

/**
 * 键序稳定的 JSON 序列化（对象键按 ordinal 排序；数组保序）。
 *
 * 为什么需要它：`payloadSha256` 要能**重算**。若直接用 `JSON.stringify`，
 * 键序一变（例如人工格式化）摘要就变，而内容其实没变 —— 那会制造假红。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? 'null' : encoded
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
}

/** 去掉 `payloadSha256` 自身之后的稳定摘要。 */
export function computeManifestPayloadSha256(manifest: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'payloadSha256') continue
    rest[key] = value
  }
  return createHash('sha256').update(stableStringify(rest), 'utf8').digest('hex')
}

/** 加上 `payloadSha256`。**幂等**：重复调用结果相同。 */
export function sealManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  return { ...manifest, payloadSha256: computeManifestPayloadSha256(manifest) }
}

// ---------------------------------------------------------------------------
// runId
// ---------------------------------------------------------------------------

/**
 * `m6.1-<wp>[-<sub>…]-<YYYYMMDD>-<headShort12>-<suffix4>`
 *
 * 例：`m6.1-wp0-20260922-958c6be6a213-a1b2`
 *
 * ⚠️ 后缀（4 位 hex）是 M6 没有的那一段：同一天、同一个 HEAD 上跑两次，
 *    目录名**仍然不同** ⇒ 第二次不会覆盖第一次（TD-04①）。
 */
export const M6_1_RUN_ID_PATTERN = /^m6\.1-[a-z0-9]+(?:-[a-z0-9]+)*-\d{8}-[0-9a-f]{12}-[0-9a-f]{4}$/

export function assertValidRunId(runId: string): void {
  if (!M6_1_RUN_ID_PATTERN.test(runId)) {
    throw new RunIdInvalidError(
      `runId 形状非法：${JSON.stringify(runId)}（要求 ${String(M6_1_RUN_ID_PATTERN)}）`
    )
  }
}

/** 把任意 head 写法归一成 12 位小写 hex（不足右补 0；无 hex 字符 ⇒ 抛）。 */
export function normalizeHeadShort(head: string): string {
  const hex = head.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (hex === '') throw new RunIdInvalidError(`head 里没有任何 hex 字符：${JSON.stringify(head)}`)
  return hex.slice(0, 12).padEnd(12, '0')
}

export function createRunId(input: {
  /** 工作包 id，例如 `wp0` / `wp1` / `seg1` */
  readonly wpId: string
  /** 候选提交短 hash（任意写法，会被归一化） */
  readonly headShort: string
  /** 注入时钟以便测试确定性；缺省 = now */
  readonly now?: Date
  /** 注入后缀以便测试确定性；缺省 = 2 字节随机 */
  readonly suffix?: string
}): string {
  /*
   * ⚠️ 这里**不做**"把可疑字符悄悄替换掉"的归一化。
   *
   * 第一版用 `replace(/[^a-z0-9]+/g,'-')` 清洗 wpId，于是 `'wp0/../..'` 被
   * **静默改写**成合法的 `wp0` —— 结果是"一个看起来像路径穿越的输入"被
   * 接受成了一个**别的** id。那正是本仓库登记过的形态：输入错了，输出却正常，
   * 于是没有任何人会发现调用方写错了。⇒ 失败关闭：只允许 `[a-z0-9-]`，
   *   且不得以 `-` 开头/结尾。
   */
  const wp = input.wpId.toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(wp)) {
    throw new RunIdInvalidError(
      `wpId 非法：${JSON.stringify(input.wpId)}（只允许 [a-z0-9] 与内部连字符；` +
        '不做静默替换——那会把写错的调用方藏起来）'
    )
  }
  const head = normalizeHeadShort(input.headShort)
  const date = (input.now ?? new Date()).toISOString().slice(0, 10).replace(/-/g, '')
  const suffix = (input.suffix ?? randomBytes(2).toString('hex')).toLowerCase()
  if (!/^[0-9a-f]{4}$/.test(suffix)) {
    throw new RunIdInvalidError(`后缀必须是 4 位 hex：${JSON.stringify(input.suffix)}`)
  }
  const runId = `m6.1-${wp}-${date}-${head}-${suffix}`
  assertValidRunId(runId)
  return runId
}

/** M6.1 运行目录的父目录（仓库相对路径，供门登记表与文档引用）。 */
export const M6_1_RUN_PARENT = 'artifacts/m6.1'
/** 正文/人审材料目录前缀 —— **必须**被 gitignore（本模块提供一个可判定的检查）。 */
export const M6_1_LOCAL_PARENT = 'artifacts/m6.1/local'
export const MANIFEST_FILE = 'manifest.json'
export const MANIFEST_TMP_FILE = '.manifest.tmp'

/**
 * 从 `--out` 反解 runId。
 *
 * `--out` **只接受** `artifacts/m6.1/<runId>` 这一种形状：运行目录的形状本身是判据的一部分
 * （`m6.1:gates` 要能按 runId 追到目录），不允许放到别处，也不允许用别的命名。
 */
export function runIdFromOutPath(root: string, out: string): string {
  const abs = resolve(root, out)
  const parent = resolve(root, 'artifacts', 'm6.1')
  const runId = basename(abs)
  if (resolve(abs, '..') !== parent) {
    throw new RunIdInvalidError(
      `--out 必须是 artifacts/m6.1/<runId>（收到 ${out}）—— 运行目录的形状是判据的一部分，` +
        '不允许放到别处'
    )
  }
  assertValidRunId(runId)
  return runId
}

/**
 * 建立一次新运行。
 *
 * ```text
 *   artifacts/m6.1/            （recursive:true —— 父目录可以不存在）
 *   artifacts/m6.1/<runId>/    （recursive:**false** —— 已存在 ⇒ 抛，绝不复用）
 * ```
 */
export function openRunDir(root: string, runId: string): string {
  assertValidRunId(runId)
  const parent = join(root, 'artifacts', 'm6.1')
  mkdirSync(parent, { recursive: true })
  const dir = join(parent, runId)
  if (existsSync(dir)) {
    throw new RunDirExistsError(`runId 目录已存在，拒绝覆盖（TD-04①）：${dir}`)
  }
  try {
    mkdirSync(dir, { recursive: false })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RunDirExistsError(`runId 目录已存在，拒绝覆盖（TD-04①）：${dir}`)
    }
    throw error
  }
  return dir
}

/**
 * **原子晋升**清单：写 `.manifest.tmp` → `rename`。
 *
 * 读者的判据因此是二值的：`manifest.json` 在 ⇒ 这份运行的清单是完整的；
 * 不在（只留下 `.manifest.tmp`）⇒ `INCOMPLETE`，**不是**"还没有清单所以先当通过"。
 */
export function writeManifestAtomic(runDir: string, manifest: Record<string, unknown>): string {
  const sealed = sealManifest(manifest)
  /*
   * L-M61-14：标准契约清单缺字段 ⇒ **拒绝落盘**（失败关闭）。
   * 旧读数按 TD-16 纪律不回写；非标准 schema（`m6.1-long-manifest@1`）不受此闸约束。
   */
  if (sealed.schemaVersion === STANDARD_MANIFEST_SCHEMA) assertStandardManifestComplete(sealed)
  const tmp = join(runDir, MANIFEST_TMP_FILE)
  const final = join(runDir, MANIFEST_FILE)
  writeFileSync(tmp, `${JSON.stringify(sealed, null, 2)}\n`, 'utf8')
  renameSync(tmp, final)
  return final
}

export interface ManifestReading {
  readonly present: boolean
  readonly path: string
  readonly manifest: Record<string, unknown> | null
  readonly problems: readonly ManifestProblem[]
  /**
   * `ABSENT`     —— 没有 `manifest.json`（中断的运行；只可能留下 `.manifest.tmp`）
   * `INCOMPLETE` —— 清单在，但 `counts.executed <= 0`（"检查了 0 项"不是结论）
   * `COMPLETE`   —— 清单在且执行数 > 0
   */
  readonly completion: 'ABSENT' | 'INCOMPLETE' | 'COMPLETE'
}

export function readManifest(runDir: string): ManifestReading {
  const path = join(runDir, MANIFEST_FILE)
  if (!existsSync(path)) {
    return { present: false, path, manifest: null, problems: [], completion: 'ABSENT' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return {
      present: true,
      path,
      manifest: null,
      problems: [
        { code: 'manifest_not_object', detail: `清单不是合法 JSON：${String(error)}` },
      ],
      completion: 'INCOMPLETE',
    }
  }
  const problems = validateM6_1Manifest(parsed)
  const manifest = isRecord(parsed) ? parsed : null
  const counts = manifest !== null && isRecord(manifest.counts) ? manifest.counts : undefined
  const executed = counts === undefined ? 0 : Number(counts.executed ?? 0)
  return {
    present: true,
    path,
    manifest,
    problems,
    completion: executed > 0 ? 'COMPLETE' : 'INCOMPLETE',
  }
}

// ---------------------------------------------------------------------------
// manifest 校验（M6 通用集 + M6.1 追加集）
// ---------------------------------------------------------------------------

/**
 * 校验一份 M6.1 清单。
 *
 * ```text
 *   ① 先跑 scripts/m6-evidence.ts 的 validateManifest() —— 六类通用事故形态
 *   ② 再查 M6.1 追加字段（契约/语料/量具版本、取代关系、清单自摘要）
 *   ③ 最后重算 payloadSha256 —— 不匹配 ⇒ 清单被事后改过
 * ```
 */
export function validateM6_1Manifest(manifest: unknown): ManifestProblem[] {
  const problems: ManifestProblem[] = [...validateManifest(manifest)]
  if (!isRecord(manifest)) return problems

  for (const field of M6_1_EXTRA_MANIFEST_FIELDS) {
    if (!(field in manifest)) {
      problems.push({ code: 'manifest_missing_field', detail: `缺 M6.1 字段 ${field}` })
    }
  }

  if (!Array.isArray(manifest.supersedes)) {
    problems.push({
      code: 'manifest_supersedes_not_list',
      detail: 'supersedes 必须是数组（没有可取代的旧读数时写 []，不得省略）',
    })
  }

  const recorded = manifest.payloadSha256
  if (typeof recorded !== 'string' || recorded === '') {
    problems.push({
      code: 'manifest_unsealed',
      detail: '缺 payloadSha256 ⇒ 无法判定这份清单有没有被事后改动',
    })
  } else {
    const actual = computeManifestPayloadSha256(manifest)
    if (actual !== recorded) {
      problems.push({
        code: 'manifest_payload_hash_mismatch',
        detail: `payloadSha256 不匹配（记录 ${recorded.slice(0, 12)}… / 实算 ${actual.slice(0, 12)}…）`,
      })
    }
  }

  return problems
}

/**
 * 写盘前的**失败关闭**判据（L-M61-14）。
 *
 * ```text
 *   标准契约清单（`m6.1-manifest@1`）缺任何一个必填字段 ⇒ 抛，**不写盘**
 * ```
 *
 * 为什么是失败关闭而不是"写下去再说"：缺字段的读数**在聚合器眼里等于不存在**
 * （`m6.1:gates` 只读 `--manifest` 指名的清单），而它看起来又是一份完整证据 ——
 * "看起来有、其实读不进来"正是本仓库反复登记的那类缺陷。宁可运行器在收尾时响亮地失败，
 * 也不要静静地产出一份用不上的清单。
 *
 * ⚠️ 与 `readManifest()` 的分工：读侧的 `validateM6_1Manifest()` 是**报告**问题
 *    （历史清单不回写，允许被读成"有问题的旧读数"）；本函数是**写侧**的闸。
 */
export function assertStandardManifestComplete(manifest: Record<string, unknown>): void {
  const missing = M6_1_MANIFEST_REQUIRED_FIELDS.filter((field) => !(field in manifest))
  if (missing.length > 0) {
    throw new ManifestIncompleteError(
      `标准契约清单缺 ${missing.length} 个字段：${missing.join(', ')} —— ` +
        '`m6.1-manifest@1` 不允许缺字段落盘；' +
        '公共字段请用 `scripts/m6.1-run-manifest.ts` 的 `standardManifestFields()` 补齐。'
    )
  }
}

// ---------------------------------------------------------------------------
// 证据归属（每条证据必须能核出"它是哪来的"）
// ---------------------------------------------------------------------------

export interface EvidenceEntry {
  readonly path: string
  readonly sha256: string
  readonly schemaVersion?: string
  readonly note?: string
}

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 算一个文件的证据条目。
 *
 * ⚠️ 文件不存在 ⇒ **抛** `MeasurementInvalidError`，绝不返回空串冒充"算过了"
 *    （AGENTS §6.8 的形态；M6 WP0 的 `N2` 负控测的就是这一条）。
 */
export function evidenceEntry(root: string, absPath: string): EvidenceEntry {
  if (!existsSync(absPath)) {
    throw new MeasurementInvalidError(`MEASUREMENT INVALID：证据文件不存在 ${absPath}`)
  }
  return {
    path: relative(root, absPath).split(/[\\/]/).join('/'),
    sha256: createHash('sha256').update(readFileSync(absPath)).digest('hex'),
  }
}

/**
 * 复核一组证据条目：路径存在、`sha256` 与实际一致。
 *
 * 与 M6 的 `validateManifest` 的 `manifest_unresolved_evidence` 是**两层**：
 * 那一层查"字段在不在"，这一层查"**内容对不对**"（缺一层就会允许一条
 * 复制粘贴来的 hash 混进汇总）。
 */
export function verifyEvidenceEntries(
  root: string,
  entries: readonly unknown[]
): ManifestProblem[] {
  const problems: ManifestProblem[] = []
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      problems.push({
        code: 'evidence_unresolved',
        detail: '有一条证据缺 path 或 sha256 ⇒ 无法核验"这份读数是哪来的"',
      })
      continue
    }
    const abs = join(root, entry.path)
    if (!existsSync(abs)) {
      problems.push({
        code: 'evidence_missing',
        detail: `证据文件不存在：${entry.path}`,
      })
      continue
    }
    if (statSync(abs).size === 0) {
      problems.push({
        code: 'evidence_empty',
        detail: `证据文件是 0 字节：${entry.path}（"没读到东西"不是"没有不一致"）`,
      })
      continue
    }
    const actual = createHash('sha256').update(readFileSync(abs)).digest('hex')
    if (actual !== entry.sha256) {
      problems.push({
        code: 'evidence_hash_mismatch',
        detail: `${entry.path} 的 sha256 与清单记录不一致（记录 ${entry.sha256.slice(0, 12)}… / 实算 ${actual.slice(0, 12)}…）`,
      })
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// 如实读一份落盘证据（汇总与组件门共用）
// ---------------------------------------------------------------------------

export interface LandedGateEvidence {
  readonly path: string
  readonly schemaVersion: string
  readonly verdict: string
  readonly passed: number
  readonly failed: number
  readonly measurementInvalid: number
  readonly generatedAt: string | null
  readonly payload: Record<string, unknown>
}

/**
 * 读一份落盘证据并**如实**报出结论。
 *
 * 缺 `verdict` ⇒ 返回空串（调用方按 `NOT RUN` 处理），**不是**默认 PASS。
 */
export function readLandedGateEvidence(path: string, text: string): LandedGateEvidence | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(payload)) return undefined
  return {
    path,
    schemaVersion: String(payload.schemaVersion ?? ''),
    verdict: String(payload.verdict ?? ''),
    passed: Number(payload.passed ?? 0),
    failed: Number(payload.failed ?? 0),
    measurementInvalid: Number(payload.measurementInvalid ?? 0),
    generatedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : null,
    payload,
  }
}
