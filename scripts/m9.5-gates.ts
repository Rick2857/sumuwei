/**
 * M9.5 门结果汇总（`pnpm m9.5:gates`）—— **只读**。
 *
 * ============================================================================
 *  它做什么、绝不做什麼
 * ============================================================================
 * ```text
 * 做：读 `artifacts/m9.5/<runId>/manifest.json`，按 `m9.5-manifest@1` 校验，
 *     同一道门取**最新一档**，给出分列判定（PASS / INVALID / REFUSED / NOT RUN）。
 * 不做：**不**启动模型 · **不**重跑任何门 · **不**写任何文件 · **不**打开任何数据库。
 *      （"只读汇总"是它的契约；要新读数就去跑那道门。）
 * ```
 *
 * ============================================================================
 *  「哪一档是最新」的主键 —— 这是本文件最需要说清楚的一件事
 * ============================================================================
 * ```text
 * 两条**已经踩过**的路都不能走：
 *   ① 目录名的字典序：runId 尾段是 4 位 hex ⇒ 与时间序**无关**。
 *   ② 工作树 mtime：一次 `git checkout` / `ff 合并`会重写文件、把全部 mtime 拉平
 *      ⇒ 排序退化成字典序（M9.1 的聚合器就是这样一度把旧档当成最新）。
 *   ③ 提交顺序：本次 6 个语料档**都在同一个提交里**，提交时间相同 ⇒ 仍然只能按名字兜底。
 *
 * ⇒ 主键 = **清单里的 `startedAt`**（运行开始时刻，ISO 串）。
 *   它之所以可信，是因为 `m9.5-manifest@1` **把 `startedAt` 列为必填**，
 *   而且整份清单被 `payloadSha256` 封印 —— 想伪造它就会让自摘要不符（校验即报 INVALID）。
 *   兜底顺序：`startedAt` 降序 → `completedAt` 降序 → 目录名。
 * ```
 *
 * ============================================================================
 *  判定规则（计划 §16.4 的"聚合器要拒绝什么"）
 * ============================================================================
 * ```text
 * INVALID   清单不满足 `m9.5-manifest@1`（缺字段/类型错/**自摘要不符**）
 *           · `usable !== true`（读数自己声明不可用）
 *           · `measuredCount <= 0`（**0 检查 0 失败 = 无效，不是 PASS**，AGENTS §6.8）
 * REFUSED   `completion !== 'complete'`
 *           · `dbKind === 'production'`（真实库读数需当轮显式授权；聚合器一律拒收）
 *           · 代码归属不符：清单 `head` 不是当前 HEAD 的祖先
 *           · 证据完整性：`artifactHashes` 与磁盘文件重算不符（**清单被事后改过**）
 * PASS      以上全过
 * NOT RUN   该门在 `artifacts/m9.5/` 下**没有任何档** —— 缺文件是 NOT RUN，**不是 PASS**
 * ```
 *
 * 退出码：`0` = 本阶段**必选门**全 PASS 且无任何 INVALID/REFUSED；`1` = 否则。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { validateM95Manifest, type M95ManifestProblem } from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const ARTIFACTS = join(REPO_ROOT, 'artifacts/m9.5')

// ---------------------------------------------------------------------------
// 门登记表：计划 §16.1 的 22 条 + 本阶段**必选**子集
// ---------------------------------------------------------------------------

interface GateSpec {
  readonly id: string
  readonly wp: string
  readonly what: string
  /** 本阶段（WP2 收口时）**必须已有**的档 */
  readonly requiredNow: boolean
}

const GATES: readonly GateSpec[] = [
  { id: 'm9.5-wp0-baseline@1', wp: 'WP0', what: '基线与旧缺口归因', requiredNow: true },
  { id: 'm9.5-poc@1', wp: 'WP1', what: '向量组件能力（§6.3 第 1–2 条）', requiredNow: true },
  { id: 'm9.5-embedding@1#download', wp: 'WP1', what: '安装出站（来源/字节/sha256）', requiredNow: true },
  { id: 'm9.5-embedding@1#verify', wp: 'WP1', what: '真实本地编码器（离线边界）', requiredNow: true },
  { id: 'm9.5-corpus@1', wp: 'WP2', what: '语料与清单（600 + 200）', requiredNow: true },
  { id: 'm9.5-measurement@1', wp: 'WP2', what: '量具有效性（正控/负控/恢复）', requiredNow: true },
  { id: 'm9.5-calibration@1', wp: 'WP1/2', what: '校准链①：A0/A1/A2 **开发集**对照（真编码器）', requiredNow: true },
  { id: 'm9.5-validation@1', wp: 'WP1/2', what: '校准链②：**独立验证集**确认（val 自己的隔离库 + 读 dev 证据做方向对照）', requiredNow: true },
  { id: 'm9.5-legacy-strength@1', wp: 'WP1/2', what: '校准链③：**旧强项回归**（字面命中不被挤掉/名次不退化 · 新近度兜底 · 不丢旧路径命中）', requiredNow: true },
  { id: 'm9.5-lexical-calibration@1', wp: 'WP2', what: '`L-M95-18` A：**有限词面权重校准**（4 候选 × dev/val · 真店+真编码器 · 判据先于读数）', requiredNow: true },
  { id: 'm9.5-a3@1', wp: 'WP2', what: '计划 §277 **A3**：换 embedding 模型的库外对照（同一 dev/val 集 · 错配负控）', requiredNow: true },
  { id: 'm9.5-a3@1#download', wp: 'WP2', what: 'A3 的**来源证据**：镜像/不可变 sha/每文件字节与 sha256（与 E5 下载同规格）', requiredNow: true },
  { id: 'm9.5-test@1', wp: 'WP3–8', what: '纯契约（通道登记/策略模式版本/R3 降级/schema 版本与 D28 向量校验/排序纯函数）', requiredNow: true },
  { id: 'm9.5-encoder@1', wp: 'WP3', what: '可终止执行单元 / 硬截止 / 回收两端证据 / 清单与资产（D27·D30）', requiredNow: true },
  { id: 'm9.5-index@1', wp: 'WP4', what: '分页/版本/覆盖/generation/精确检索', requiredNow: true },
  { id: 'm9.5-migration@1', wp: 'WP4', what: '派生 schema 建/升/失败关闭/无半成（D31，非 kernel 链）', requiredNow: true },
  { id: 'm9.5-lifecycle@1', wp: 'WP5', what: '连续水位/缺口不推进/重试终态/断电点重放/换代拒混排', requiredNow: true },
  { id: 'm9.5-retrieval@1', wp: 'WP6', what: '通道登记如实性/R3 伪启用/D26 禁绝对阈值/策略版本化', requiredNow: true },
  { id: 'm9.5-hybrid@1', wp: 'WP6', what: '真店接线：legacy 缺口复现 / off 等价 / hybrid 保住词面命中（D25 的 N1）', requiredNow: true },
  { id: 'm9.5-semantic@1', wp: 'WP6', what: '语义分数真进链路：R3 伪启用防线 / 具名降级 / off 零调用（N1 语义半边）', requiredNow: true },
  { id: 'm9.5-probe@1', wp: 'WP6', what: '探针适配器五道具名失败 / 只服务已发布代 / 没索引不加载模型', requiredNow: true },
  { id: 'm9.5-assembly@1', wp: 'WP6', what: '生产装配：开关缺省 off / 两个半边同一开关控制（静态锁）', requiredNow: true },
  { id: 'm9.5-context@1', wp: 'WP7', what: '逐层计数守恒（11 条不变式逐条负控）/ 候选去向 / 语义用量可见', requiredNow: true },
  { id: 'm9.5-compat@1', wp: 'WP7/8', what: '§4.4 交给 M10/M11 的稳定边界（两个纯 fixture consumer）', requiredNow: true },
  { id: 'm9.5-privacy@1', wp: 'WP8', what: '无私人文本出站（结构性守卫两向）/ 诊断不泄漏（哨兵）/ 查询零写', requiredNow: true },
  { id: 'm9.5-modes@1', wp: 'WP8', what: 'off 零语义调用 / shadow 有对照但输出与 off 逐位相同 / on 改变顺序 / 失败降级', requiredNow: true },
  { id: 'm9.5-e2e@1', wp: 'WP9', what: '真 Gateway 全链：`on` 下目标进 prompt / 旧路径丢掉（两侧对照）/ shadow 选择不变', requiredNow: true },
  { id: 'm9.5-scale@1', wp: 'WP9', what: '候选上限 200（实测）/ 查询边界 / 扫描上限边界 / 新鲜度 / 时延 / 语义开销', requiredNow: true },
    { id: 'm9.5-long@1', wp: 'WP9', what: '三条 500 轮轨迹：零失败 / S47 规模版逐轮相同 / on 真的不同 / 无漂移', requiredNow: true },
  { id: 'm9.5-recovery@1', wp: 'WP9', what: '故障注入/恢复不留楔子/切换·回滚·两代并存拒服务/重启', requiredNow: true },
    { id: 'm9.5-quality@1', wp: 'WP10', what: '人审材料：可复现抽样 / 盲化（答案键零泄漏+正控）/ gauge 样本在案 / 材料完整', requiredNow: true },
  { id: 'm9.5-live-judge@1', wp: 'WP10', what: '真模型档判定器：**三控**（正/负/恢复）+ 确定性范围如实声明', requiredNow: true },
  { id: 'm9.5-smoke-live@1', wp: 'WP10', what: '真回复模型 + 真实编码', requiredNow: false },
  { id: 'm9.5-long-live@1', wp: 'WP10', what: '至少一条 500 轮真实回复链', requiredNow: false },
  { id: 'm9.5-gatelist@1', wp: 'WP11', what: '门清单对账：计划 §16.1 vs 实际脚本 / 缺席必须已申报 / 差集两向控制', requiredNow: true },
  { id: 'm9.5-aggregator@1', wp: 'WP11', what: '聚合门自检：取档规则两路对账 / 规则被真的行使 / 比较器负控 / 封存哈希', requiredNow: true },
  { id: 'm9.5-regression@1', wp: 'WP11', what: '准入前置：除本门外的必选门全 PASS / 无悬空档 / 基线回归真跑 / 工作树干净', requiredNow: true },
]

// ---------------------------------------------------------------------------
// 读档
// ---------------------------------------------------------------------------

interface RunRecord {
  readonly dir: string
  readonly runId: string
  readonly manifest: Record<string, unknown> | null
  readonly readError: string | null
  readonly problems: readonly M95ManifestProblem[]
}

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function isAncestorOfHead(head: unknown): 'ancestor' | 'not-ancestor' | 'unknown' {
  if (typeof head !== 'string' || head.length === 0) return 'unknown'
  if (gitOrNull(['cat-file', '-e', `${head}^{commit}`]) === null) return 'unknown'
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', head, 'HEAD'], { cwd: REPO_ROOT })
    return 'ancestor'
  } catch {
    return 'not-ancestor'
  }
}

function verifyArtifactHashes(
  dir: string,
  hashes: unknown
): { checked: number; mismatched: string[]; missing: string[] } {
  if (typeof hashes !== 'object' || hashes === null) return { checked: 0, mismatched: [], missing: [] }
  const mismatched: string[] = []
  const missing: string[] = []
  let checked = 0
  for (const [rel, expected] of Object.entries(hashes as Record<string, unknown>)) {
    const path = join(dir, rel)
    if (!existsSync(path)) {
      missing.push(rel)
      continue
    }
    checked += 1
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (typeof expected !== 'string' || actual !== expected) mismatched.push(rel)
  }
  return { checked, mismatched, missing }
}

function readRuns(): RunRecord[] {
  if (!existsSync(ARTIFACTS)) return []
  const records: RunRecord[] = []
  for (const entry of readdirSync(ARTIFACTS)) {
    if (entry === 'local') continue
    const dir = join(ARTIFACTS, entry)
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) {
      records.push({
        dir: entry,
        runId: entry,
        manifest: null,
        readError: 'manifest.json 缺失（未完成的 run）',
        problems: [],
      })
      continue
    }
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      records.push({
        dir: entry,
        runId: String(manifest.runId ?? entry),
        manifest,
        readError: null,
        problems: validateM95Manifest(manifest),
      })
    } catch (error) {
      records.push({ dir: entry, runId: entry, manifest: null, readError: (error as Error).message, problems: [] })
    }
  }
  return records
}

/** 主键 = 清单里**被封印的** `startedAt`（见文件头）；逐级兜底到目录名。 */
function latestKey(record: RunRecord): string {
  const manifest = record.manifest ?? {}
  const started = typeof manifest.startedAt === 'string' ? manifest.startedAt : ''
  const completed = typeof manifest.completedAt === 'string' ? manifest.completedAt : ''
  return `${started}|${completed}|${record.dir}`
}

type Verdict = 'PASS' | 'INVALID' | 'REFUSED' | 'NOT RUN'

interface GateReading {
  readonly spec: GateSpec
  readonly verdict: Verdict
  readonly runId: string | null
  readonly reasons: string[]
  readonly detail: Record<string, unknown>
}

function evaluate(spec: GateSpec, runs: readonly RunRecord[]): GateReading {
  const mine = runs
    .filter((record) => (record.manifest ?? {}).gateVersion === spec.id)
    .sort((a, b) => latestKey(b).localeCompare(latestKey(a)))
  const chosen = mine[0]
  if (chosen === undefined) {
    return {
      spec,
      verdict: 'NOT RUN',
      runId: null,
      reasons: ['artifacts/m9.5/ 下没有任何档 —— 缺文件是 NOT RUN，不是 PASS'],
      detail: { candidates: 0 },
    }
  }
  /*
   * ⚠️ 每条理由**自带严重度**，不用"理由文本里有没有某个词"来推断判定
   *    —— 那种字符串匹配正是本仓库反复出现的"判据脆弱"形态。
   */
  const reasons: { severity: 'invalid' | 'refused'; text: string }[] = []
  const manifest = chosen.manifest
  if (manifest === null) {
    return {
      spec,
      verdict: 'INVALID',
      runId: chosen.runId,
      reasons: [chosen.readError ?? '清单不可读'],
      detail: { dir: chosen.dir },
    }
  }
  for (const problem of chosen.problems) {
    reasons.push({ severity: 'invalid', text: `${problem.field}: ${problem.problem}` })
  }
  if (manifest.usable !== true) {
    reasons.push({ severity: 'invalid', text: '清单自报 usable=false（读数不可用）' })
  }
  if (typeof manifest.measuredCount === 'number' && manifest.measuredCount <= 0) {
    reasons.push({
      severity: 'invalid',
      text: 'measuredCount<=0（0 检查 0 失败 = 无效，不是 PASS）',
    })
  }
  if (manifest.completion !== 'complete') {
    reasons.push({ severity: 'refused', text: `completion=${String(manifest.completion)}（未完成）` })
  }
  if (manifest.dbKind === 'production') {
    reasons.push({
      severity: 'refused',
      text: 'dbKind=production（真实库读数需当轮显式授权；聚合器一律拒收）',
    })
  }
  const ownership = isAncestorOfHead(manifest.head)
  if (ownership === 'not-ancestor') {
    reasons.push({
      severity: 'refused',
      text: `代码归属不符：head=${String(manifest.head)} 不是当前 HEAD 的祖先`,
    })
  }
  if (ownership === 'unknown') {
    reasons.push({
      severity: 'refused',
      text: `代码归属不可判：head=${String(manifest.head)} 在本仓库里不存在`,
    })
  }

  const integrity = verifyArtifactHashes(join(ARTIFACTS, chosen.dir), manifest.artifactHashes)
  if (integrity.mismatched.length > 0) {
    reasons.push({ severity: 'invalid', text: `证据被改过：${integrity.mismatched.join(', ')}` })
  }
  if (integrity.missing.length > 0) {
    reasons.push({ severity: 'invalid', text: `证据文件缺失：${integrity.missing.join(', ')}` })
  }
  if (integrity.checked === 0) {
    reasons.push({
      severity: 'invalid',
      text: 'artifactHashes 检查了 0 个文件（计数型自检：0 检查 ≠ 完整）',
    })
  }

  const verdict: Verdict = reasons.some((reason) => reason.severity === 'invalid')
    ? 'INVALID'
    : reasons.length > 0
      ? 'REFUSED'
      : 'PASS'
  return {
    spec,
    verdict,
    runId: chosen.runId,
    reasons: reasons.map((reason) => `${reason.severity === 'invalid' ? 'INVALID' : 'REFUSED'} · ${reason.text}`),
    detail: {
      dir: chosen.dir,
      candidates: mine.length,
      startedAt: manifest.startedAt,
      headShort: manifest.headShort,
      completion: manifest.completion,
      usable: manifest.usable,
      measuredCount: manifest.measuredCount,
      dbKind: manifest.dbKind,
      lane: manifest.lane,
      ownership,
      artifactHashesChecked: integrity.checked,
      artifactHashesMismatched: integrity.mismatched,
    },
  }
}

function main(): void {
  const runs = readRuns()
  const readings = GATES.map((spec) => evaluate(spec, runs))

  const required = readings.filter((reading) => reading.spec.requiredNow)
  const requiredPresent = required.filter((reading) => reading.verdict !== 'NOT RUN')
  const invalidOrRefused = readings.filter(
    (reading) => reading.verdict === 'INVALID' || reading.verdict === 'REFUSED'
  )
  const overall =
    requiredPresent.length === required.length && invalidOrRefused.length === 0 ? 'PASS' : 'FAIL'

  const symbol: Record<Verdict, string> = { PASS: '✅', INVALID: '⛔', REFUSED: '⚠️', 'NOT RUN': '·' }
  const lines: string[] = []
  lines.push('M9.5 门结果汇总（只读已落盘证据；不启动模型、不重跑、不写文件）')
  lines.push(`  证据根：artifacts/m9.5/ · 在案 run 目录 ${String(runs.length)} 个`)
  lines.push('')
  lines.push(`  ${'门'.padEnd(34)}${'WP'.padEnd(7)}${'判定'.padEnd(10)}最新档`)
  for (const reading of readings) {
    lines.push(
      `  ${symbol[reading.verdict]} ${reading.spec.id.padEnd(32)}${reading.spec.wp.padEnd(7)}` +
        `${reading.verdict.padEnd(10)}${reading.runId ?? '—'}` +
        (reading.spec.requiredNow ? '' : '  （本阶段非必选）')
    )
    for (const reason of reading.reasons.slice(0, 3)) lines.push(`      ↳ ${reason}`)
  }
  lines.push('')
  lines.push(
    `  本阶段必选门：${String(requiredPresent.length)}/${String(required.length)} 有档 · ` +
      `INVALID/REFUSED：${String(invalidOrRefused.length)}`
  )
  lines.push(`  Hard Gates = ${overall}`)
  process.stdout.write(lines.join('\n') + '\n')

  /* 机器可读尾块（供后续聚合或人读；本脚本不写文件） */
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 'm9.5-gates@1',
      overall,
      requiredNow: { present: requiredPresent.length, total: required.length },
      invalidOrRefused: invalidOrRefused.map((reading) => reading.spec.id),
      readings: readings.map((reading) => ({
        gate: reading.spec.id,
        wp: reading.spec.wp,
        requiredNow: reading.spec.requiredNow,
        verdict: reading.verdict,
        runId: reading.runId,
        reasons: reading.reasons,
        detail: reading.detail,
      })),
    }) + '\n'
  )

  if (overall !== 'PASS') process.exitCode = 1
}

main()
