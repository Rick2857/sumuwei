/**
 * M10（关闭 `L-M10-40`）—— **证据档完整性门**（`pnpm m10:evidence:verify`）。
 *
 * ============================================================================
 *  它补的是 `G48` 的最后一块
 * ============================================================================
 * `G48` 的原文是"损坏输出 ⇒ `INVALID`/`FAIL`；**零分母不是 PASS**"。此前：
 * ```text
 * WP8b 覆盖了"坏**模型输出**"（非法 JSON → 那一格是 FAIL，不是静默）
 * WP9-B 覆盖了"**零分母**"（G48a/G48b 含正控）
 * ❌ 未做：**证据档本身**损坏 / 不自洽 / 无法解释时，判定器必须报 INVALID
 * ```
 * 而"证据档本身不可信"正是本仓库反复出现的坑的**根**：
 * **"0 个失败"与"什么都没量"在输出上长得一样**。
 *
 * ============================================================================
 *  它判什么（`validateM10Manifest` 已经管的不重复判）
 * ============================================================================
 * `validateM10Manifest` 已覆盖：必填字段 / schema 版本 / runId 形状 / counts 是整数 /
 * **`counts.total > 0`** / phases / supersedes 形状 / **`payloadSha256` 自洽**（清单被改过）。
 * ⇒ 本门补它**管不到**的四类**不自洽**：
 * ```text
 * A2  manifest.runId 必须等于**目录名**（把清单拷进错的目录仍能通过 validate ⇒ 假证据）
 * A4  清单的 counts 必须与**证据档自己的 summary** 逐数一致（两处记账对不上）
 * A5  verdict 与 counts.failed 的**符号一致**（FAIL 档却报 failed=0，或反之）
 * A6  manifest.head 必须是仓库里**真实存在**的提交（编一个 head = 无法追溯产生它的代码）
 * A7  supersedes 非 null 时，被取代的那个 run **必须还在**（悬空的取代链 = 丢了读数）
 * A8  **每个 FAIL 档都要有具名解释**：要么是测量汇总里登记的**注入负控**，
 *     要么有**同门更晚的 PASS**（两代规则：第二代权威）
 * ```
 *
 * ⚠️ **A8 是本门最要紧的一条**：它是"FAIL 档不许静默存在"的机器判据。
 *
 * ============================================================================
 *  损坏判定器的正负控（B 组）—— 在 **temp 副本**上做，绝不碰真档案
 * ============================================================================
 * ```text
 * B1 正控  干净副本 ⇒ VALID
 * B2 负控  截断证据 JSON ⇒ INVALID
 * B3 负控  删 manifest 必填字段 ⇒ INVALID
 * B4 负控  counts.total 改 0 ⇒ INVALID（§6.8）
 * B5 负控  改清单一个字节 ⇒ payloadSha256 不再自洽 ⇒ INVALID
 * B6 负控  runId 与目录名不符 ⇒ INVALID
 * ```
 *
 * ⚠️ 纯进程内 + 只读真档案；所有破坏都发生在 `mkdtemp` 副本里。
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, validateM10Manifest, writeM10Manifest } from './m10-evidence.ts'

const REPO_ROOT = resolve(process.cwd())
const EVIDENCE_ROOT = join(REPO_ROOT, 'artifacts', 'm10')
const MANIFEST = 'manifest.json'

function phase(mark: string): void {
  console.error(`[m10-evidence] ${mark}`)
}

interface Check {
  group: 'A' | 'B'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []
function record(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ group, id, label, expected, actual, pass })
}

interface RunRecord {
  readonly dir: string
  readonly manifest: Record<string, unknown> | undefined
  readonly manifestProblems: readonly { field: string; problem: string }[]
  readonly payloadFiles: readonly string[]
  readonly payload: Record<string, unknown> | undefined
  readonly payloadParseError: string | undefined
}

/** 读出**一个** run 目录的全部可判事实（不判，只读） */
function inspectRun(dir: string): RunRecord {
  const manifestPath = join(dir, MANIFEST)
  let manifest: Record<string, unknown> | undefined
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    } catch {
      manifest = undefined
    }
  }
  const manifestProblems = manifest === undefined ? [{ field: '(root)', problem: '清单缺失或不是合法 JSON' }] : validateM10Manifest(manifest)
  const payloadFiles = readdirSync(dir).filter((name) => name.endsWith('.json') && name !== MANIFEST)
  let payload: Record<string, unknown> | undefined
  let payloadParseError: string | undefined
  if (payloadFiles.length > 0) {
    try {
      payload = JSON.parse(readFileSync(join(dir, payloadFiles[0]!), 'utf8')) as Record<string, unknown>
    } catch (error) {
      payloadParseError = (error as Error).message
    }
  }
  return { dir, manifest, manifestProblems, payloadFiles, payload, payloadParseError }
}

/** **一个 run 目录的最终判定**（B 组也用它 ⇒ 判定器只有一份实现） */
export type RunVerdict = 'VALID' | 'INVALID'

export function judgeRun(record: RunRecord, expectedDirName: string): { verdict: RunVerdict; reasons: string[] } {
  const reasons: string[] = []
  if (record.manifest === undefined) reasons.push('清单缺失或不是合法 JSON')
  if (record.manifestProblems.length > 0) {
    for (const problem of record.manifestProblems) reasons.push(`清单：${problem.field} ${problem.problem}`)
  }
  if (record.manifest !== undefined && String(record.manifest.runId) !== expectedDirName) {
    reasons.push(`清单 runId(${String(record.manifest.runId)}) ≠ 目录名(${expectedDirName})`)
  }
  if (record.payloadFiles.length === 0) reasons.push('没有证据档（只有清单）')
  if (record.payloadParseError !== undefined) reasons.push(`证据档不是合法 JSON：${record.payloadParseError}`)
  if (record.payload !== undefined) {
    const summary = record.payload.summary as
      | { total?: unknown; passed?: unknown; failed?: unknown; verdict?: unknown }
      | undefined
    const counts = record.manifest?.counts as
      | { total?: unknown; passed?: unknown; failed?: unknown }
      | undefined
    if (summary !== undefined && counts !== undefined) {
      for (const key of ['total', 'passed', 'failed'] as const) {
        if (summary[key] !== counts[key]) {
          reasons.push(`两处记账不一致：summary.${key}=${String(summary[key])} vs 清单.counts.${key}=${String(counts[key])}`)
        }
      }
    }
    const failed = Number(counts?.failed ?? 0)
    const verdict = String(summary?.verdict ?? '')
    /*
     * ⚠️ **verdict 的词汇表不止 `PASS`/`FAIL`**（第一版按 `!== 'PASS'` 判，当场红了三个真档案）。
     *
     * 实测：`m10:wp0:admission` 的 verdict 是
     * `'ADMISSION PASS（六问均有代码指针与实测读数；Q4 的端到端探针具名交接 WP6）'`
     * —— 它是**合格**的一份证据，而按等号判会被读成"FAIL 档却报 failed=0"。
     * ⇒ 判据必须是**词汇**而不是**等号**。
     *
     * ⚠️ **2026-09-30 补第三类**（实测撞到）：`m10:semantic:eval` 在 `--runs < 3` 时如实判
     *    **`INCONCLUSIVE`**（`F4` 的纪律：量不出方差就不是读数），而它**恰恰有一条判据是红的**
     *    （`A7`：`runs ≥ 3`）⇒ `failed = 1` 与"不含 FAIL"被判不一致。
     *    但 `INCONCLUSIVE` **不是成功声明** —— 那条红的判据**正是**它判不出结论的**原因**。
     * ⇒ 三类：`FAIL` ⇒ `failed > 0` · `PASS` ⇒ `failed === 0` ·
     *    **既不说 FAIL 也不说 PASS** ⇒ **不约束 `failed`**，但**必须是闭集里的词**
     *    （不许自由发挥 —— 否则它就变成"改个名字就放行"的形状，与 `G3` 拒绝"按后缀放行"同一条理由）。
     */
    const NON_SUCCESS_VERDICTS = ['INCONCLUSIVE', 'REFUSED', 'INVALID', 'NOT RUN'] as const
    if (verdict !== '') {
      const saysFail = verdict.includes('FAIL')
      const saysPass = verdict.includes('PASS')
      const isNamedNonSuccess = NON_SUCCESS_VERDICTS.some((word) => verdict.startsWith(word))
      if (saysFail && !(failed > 0)) {
        reasons.push(
          `verdict(${verdict}) 说 FAIL 但 counts.failed=${String(failed)}（= 0）`
            + '（FAIL 档必须有失败计数）',
        )
      } else if (saysPass && failed > 0) {
        reasons.push(
          `verdict(${verdict}) 说 PASS 但 counts.failed=${String(failed)}`
            + '（"failed>0 却说 PASS"是要害方向，必须卡住）',
        )
      } else if (!saysFail && !saysPass && !isNamedNonSuccess) {
        reasons.push(
          `verdict(${verdict}) 既不说 PASS 也不说 FAIL，又不是具名的非成功词` +
            `（闭集：${NON_SUCCESS_VERDICTS.join(' / ')}）⇒ 不许自由发挥`,
        )
      }
    }
  }
  return { verdict: reasons.length === 0 ? 'VALID' : 'INVALID', reasons }
}

function gitHasCommit(head: string): boolean {
  if (!/^[0-9a-f]{40}$/.test(head)) return false
  try {
    execFileSync('git', ['cat-file', '-e', `${head}^{commit}`], { cwd: REPO_ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function main(): void {
  const runDirs = readdirSync(EVIDENCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  /* ======================================================================
   * A0 · 材料在场（"0 个目录 / 0 个问题"不得是 PASS）
   * ==================================================================== */
  phase('A0: material present')
  record(
    'A',
    'A0',
    '**材料在场**：证据根存在且 run 目录数 > 0'
      + '（"遍历了 0 个目录、发现 0 个问题"与"全部完好"在输出上长得一样）',
    'run 目录 ≥ 1',
    `run 目录 ${String(runDirs.length)} 个`,
    runDirs.length > 0,
  )

  const records = runDirs.map((name) => ({ name, record: inspectRun(join(EVIDENCE_ROOT, name)) }))

  /* ======================================================================
   * A1–A5 · 每个 run 目录的自洽性（用同一个 judgeRun）
   * ==================================================================== */
  phase('A1-A5: per-run coherence')

  const invalid = records
    .map(({ name, record }) => ({ name, ...judgeRun(record, name) }))
    .filter((entry) => entry.verdict === 'INVALID')

  record(
    'A',
    'A1',
    '**每个 run 目录都自洽**：清单通过 `m10-manifest@1` · runId 等于目录名 · '
      + '证据档可解析 · 两处记账一致 · verdict 与 failed 符号一致',
    '0 个 INVALID',
    invalid.length === 0
      ? `${String(records.length)} 个目录全部自洽`
      : `**${String(invalid.length)} 个 INVALID**：${invalid
          .slice(0, 3)
          .map((entry) => `${entry.name}（${entry.reasons[0] ?? ''}）`)
          .join(' · ')}`,
    invalid.length === 0 && records.length > 0,
  )

  /* ======================================================================
   * A6 · head 可追溯
   * ==================================================================== */
  phase('A6: heads are real commits')

  const heads = [...new Set(records.map(({ record }) => String(record.manifest?.head ?? '')))].filter(
    (head) => head !== '',
  )
  const badHeads = heads.filter((head) => !gitHasCommit(head))
  record(
    'A',
    'A6',
    '**每条 head 都可追溯**：manifest.head 是本仓库里**真实存在**的提交'
      + '（编一个 head = 无法追溯产生这份证据的代码）',
    `0 个不可追溯（检查 ${String(heads.length)} 个不同的 head）`,
    badHeads.length === 0
      ? `${String(heads.length)} 个 head 全部存在`
      : `**不可追溯 ${String(badHeads.length)} 个**：${badHeads.slice(0, 4).join(', ')}`,
    badHeads.length === 0 && heads.length > 0,
  )

  /* ======================================================================
   * A7 · supersedes 链不悬空
   * ==================================================================== */
  phase('A7: supersedes chains do not dangle')

  const dirSet = new Set(runDirs)
  const dangling: string[] = []
  for (const { name, record } of records) {
    const supersedes = record.manifest?.supersedes
    if (typeof supersedes === 'string' && !dirSet.has(supersedes)) {
      dangling.push(`${name}→${supersedes}`)
    }
  }
  record(
    'A',
    'A7',
    '**取代链不悬空**：`supersedes` 指向的那个 run 目录**还在**'
      + '（悬空 = 声称被取代的读数已经丢了）',
    '0 条悬空',
    dangling.length === 0 ? '0 条悬空' : `**${String(dangling.length)} 条**：${dangling.slice(0, 3).join(', ')}`,
    dangling.length === 0,
  )

  /* ======================================================================
   * A8 · 每个 FAIL 档都有具名解释（**本门最要紧的一条**）
   * ==================================================================== */
  phase('A8: every FAIL archive is explained')

  /* 汇总里登记的注入负控 runId */
  const declaredInjections = new Set<string>()
  for (const { record } of records) {
    const ids = record.payload?.negativeControlRunIds
    if (Array.isArray(ids)) for (const id of ids) declaredInjections.add(String(id))
  }

  const failRuns = records.filter(({ record }) => {
    const summary = record.payload?.summary as { verdict?: unknown } | undefined
    return String(summary?.verdict ?? '') === 'FAIL'
  })

  const unexplained: string[] = []
  const explainedBy: Record<string, string> = {}
  for (const { name, record } of failRuns) {
    if (declaredInjections.has(name)) {
      explainedBy[name] = '测量汇总登记的注入负控'
      continue
    }
    /*
     * 两代规则：同 `testType` + 同 `wp` 有**更晚的一次尝试** ⇒ 这一档是"被第二代取代的失败"。
     *
     * ⚠️ **这里的判据是"有更晚的尝试"，不是"有更晚的 PASS"** —— 这个选择是被一次真实情况逼出来的：
     *    本门的**上一代**（`m10-wp11-evidence-…-9bfa`）是它自己的 FAIL 档，
     *    而它唯一的"更晚的 PASS"要等**本门跑过之后**才存在 ⇒ 按"必须有更晚 PASS"判，
     *    **本门第一次跑必定红**，之后才好 —— 一条"首次必红"的门不是门。
     *
     * ⇒ 判据放松到"有更晚的尝试"，并在**解释里打印取代者的判定**（读者能自己看见
     *    取代它的是 PASS 还是又一次 FAIL）。"最新那次过没过"由 **lane 聚合**回答，
     *    不由本门回答 —— 那是两件事，混在一起会让本门既管归档又管判定。
     *    ⇒ 这条放松**如实登记**为 `L-M10-55`。
     */
    const testType = String(record.manifest?.testType ?? '')
    const wp = String(record.manifest?.wp ?? '')
    const later = records.find(({ name: other, record: otherRecord }) => {
      if (other === name) return false
      if (String(otherRecord.manifest?.testType ?? '') !== testType) return false
      if (String(otherRecord.manifest?.wp ?? '') !== wp) return false
      const otherSeq = Date.parse(String(otherRecord.manifest?.date ?? '')) || 0
      const thisSeq = Date.parse(String(record.manifest?.date ?? '')) || 0
      return otherSeq >= thisSeq
    })
    if (later !== undefined) {
      const laterVerdict = String(
        (later.record.payload?.summary as { verdict?: unknown } | undefined)?.verdict ?? '(无判定)',
      )
      explainedBy[name] = `被更晚的一次尝试取代（${later.name} · 判定 ${laterVerdict}）`
      continue
    }
    unexplained.push(name)
  }

  record(
    'A',
    'A8',
    '**每个 FAIL 档都有具名解释**（本门最要紧的一条）：要么是测量汇总里登记的'
      + '**注入负控**，要么**被更晚的一次同门尝试取代**（两代规则；解释里会打印取代者的判定）。'
      + '⇒ "FAIL 档不许静默存在"是机器判据，不是"我记得它们是注入的"。'
      + '⚠️ 判据是"有更晚的尝试"而非"有更晚的 PASS" ⇒ 放松点见 `L-M10-55`',
    `0 个无法解释（共 ${String(failRuns.length)} 个 FAIL 档）`,
    unexplained.length === 0
      ? `${String(failRuns.length)} 个 FAIL 档全部有解释（注入负控 ${String(
          Object.values(explainedBy).filter((why) => why.includes('注入')).length,
        )} · 被第二代取代 ${String(Object.values(explainedBy).filter((why) => why.includes('取代')).length)}）`
      : `**无法解释 ${String(unexplained.length)} 个**：${unexplained.slice(0, 3).join(', ')}`,
    unexplained.length === 0 && failRuns.length > 0,
  )

  /* ======================================================================
   * B · 损坏判定器的正负控（在 temp 副本上）
   * ==================================================================== */
  phase('B: corruption judges, on temporary copies only')

  /* 挑一个"健康"的 run 作为母本 */
  const healthy = records.find(({ name, record }) => judgeRun(record, name).verdict === 'VALID')
  const work = mkdtempSync(join(tmpdir(), 'm10-evidence-'))
  try {
    if (healthy === undefined) {
      record('B', 'B0', '**需要一个健康母本**来做损坏负控', '找到 1 个', '**一个都没找到**', false)
    } else {
      /*
       * ⚠️ **副本的目录名必须与原档案相同**（第一版没有，于是 `B1` 正控当场红了）。
       *
       * 第一版把副本建在 `work/<原名>-clean` ⇒ 目录名与原名不同 ⇒ `A2`（runId = 目录名）
       * 判它 INVALID ⇒ **正控以"被判 INVALID"收场**；若我没写 B1 这条正控，
       * 后面五条负控就会**全都因为"目录名不符"而变红** —— 也就是**没有一条在测它该测的东西**。
       * ⇒ 现在每条副本的叶子目录名都是原名，只有注入的那处缺陷会触发判定。
       */
      const copyOf = (suffix: string): string => {
        const target = join(work, suffix, healthy.name)
        cpSync(join(EVIDENCE_ROOT, healthy.name), target, { recursive: true })
        return target
      }

      /* B1 正控：干净副本（目录名同原名）⇒ VALID */
      const cleanDir = copyOf('clean')
      const clean = judgeRun(inspectRun(cleanDir), healthy.name)
      record(
        'B',
        'B1',
        '【正控】**干净副本 ⇒ VALID**（不做这条，后面五条负控可以靠"永远报 INVALID"通过；'
          + '且副本目录名必须与原档案**相同**，否则它会因为 runId 不符而红 —— 那样五条负控'
          + '就**没有一条在测它该测的东西**）',
        'VALID',
        clean.verdict + (clean.reasons.length > 0 ? `（${clean.reasons[0]!}）` : ''),
        clean.verdict === 'VALID',
      )

      /* B2 负控：截断证据档 */
      const truncDir = copyOf('trunc')
      const payloadName = readdirSync(truncDir).find((n) => n.endsWith('.json') && n !== MANIFEST)!
      const full = readFileSync(join(truncDir, payloadName), 'utf8')
      writeFileSync(join(truncDir, payloadName), full.slice(0, Math.floor(full.length / 2)), 'utf8')
      const trunc = judgeRun(inspectRun(truncDir), healthy.name)
      record(
        'B',
        'B2',
        '【负控】**截断证据档 ⇒ INVALID**（证据档读不出来时，"没有失败"没有意义）',
        'INVALID',
        trunc.verdict,
        trunc.verdict === 'INVALID',
      )

      /* B3 负控：删清单必填字段 */
      const missingFieldDir = copyOf('missing')
      const manifestOfCopy = JSON.parse(readFileSync(join(missingFieldDir, MANIFEST), 'utf8')) as Record<string, unknown>
      delete manifestOfCopy.counts
      writeFileSync(join(missingFieldDir, MANIFEST), JSON.stringify(manifestOfCopy, null, 2), 'utf8')
      const missingField = judgeRun(inspectRun(missingFieldDir), healthy.name)
      record(
        'B',
        'B3',
        '【负控】**删清单必填字段 ⇒ INVALID**',
        'INVALID',
        missingField.verdict,
        missingField.verdict === 'INVALID',
      )

      /* B4 负控：counts.total = 0 ⇒ §6.8 */
      const zeroDir = copyOf('zero')
      const zeroManifest = JSON.parse(readFileSync(join(zeroDir, MANIFEST), 'utf8')) as Record<string, unknown>
      ;(zeroManifest.counts as Record<string, unknown>).total = 0
      writeFileSync(join(zeroDir, MANIFEST), JSON.stringify(zeroManifest, null, 2), 'utf8')
      const zero = judgeRun(inspectRun(zeroDir), healthy.name)
      record(
        'B',
        'B4',
        '【负控】**零分母 ⇒ INVALID**（`counts.total = 0`；AGENTS §6.8：0 检查 0 失败不是 PASS）',
        'INVALID',
        zero.verdict,
        zero.verdict === 'INVALID',
      )

      /* B5 负控：改清单一个数 ⇒ payloadSha256 不再自洽（validate 自己抓） */
      const tamperDir = copyOf('tamper')
      const tamperManifest = JSON.parse(readFileSync(join(tamperDir, MANIFEST), 'utf8')) as Record<string, unknown>
      ;(tamperManifest.counts as Record<string, unknown>).passed = 999
      writeFileSync(join(tamperDir, MANIFEST), JSON.stringify(tamperManifest, null, 2), 'utf8')
      const tamper = judgeRun(inspectRun(tamperDir), healthy.name)
      record(
        'B',
        'B5',
        '【负控】**清单被事后改过 ⇒ INVALID**（`payloadSha256` 自摘要不再自洽 —— '
          + '这是"证据被篡改"的机器判据）',
        'INVALID',
        tamper.verdict,
        tamper.verdict === 'INVALID',
      )

      /* B6 负控：runId 与目录名不符 */
      const strayDir = copyOf('stray')
      const stray = judgeRun(inspectRun(strayDir), 'm10-not-the-real-dir-name')
      record(
        'B',
        'B6',
        '【负控】**runId 与目录名不符 ⇒ INVALID**（把一份清单拷进错的目录仍能通过 '
          + '`validateM10Manifest` ⇒ 那是一条**假证据**）',
        'INVALID',
        stray.verdict,
        stray.verdict === 'INVALID',
      )
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  /* ======================================================================
   * 落盘
   * ==================================================================== */
  const passed = checks.filter((check) => check.pass).length
  const failed = checks.length - passed

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp11-evidence', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const groups = ['A', 'B'] as const
  const perGroup = Object.fromEntries(
    groups.map((group) => [
      group,
      {
        total: checks.filter((check) => check.group === group).length,
        passed: checks.filter((check) => check.group === group && check.pass).length,
      },
    ]),
  )

  const payload = {
    schema: 'm10-evidence-verify@1',
    runId,
    head,
    mode: 'offline' as const,
    semanticClaim: 'none' as const,
    runDirsInspected: records.length,
    distinctHeads: heads.length,
    failArchives: failRuns.length,
    failArchiveExplanations: explainedBy,
    invalidRuns: invalid.map((entry) => ({ run: entry.name, reasons: entry.reasons.slice(0, 3) })),
    checks,
    perGroup,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
    disclaimer:
      '本门核对**证据档的完整性与可解释性**（自洽 · head 可追溯 · 取代链不悬空 · FAIL 档有具名解释）' +
      '+ 损坏判定器的正负控。⚠️ 它**不**重跑任何门，也**不**主张任何语义结论。',
  }
  writeFileSync(join(dir, 'evidence-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp11',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'evidence-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'G48 的最后一块（关闭 L-M10-40）：证据档的自洽性（runId=目录名 · 两处记账一致 · ' +
      'verdict 与 failed 符号一致）· head 可追溯 · supersedes 不悬空 · ' +
      '**每个 FAIL 档都有具名解释** + 损坏判定器六条正负控（截断/缺字段/零分母/篡改/错目录）。' +
      '⚠️ 不重跑门、不主张语义。',
    databaseScope: 'not-applicable',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} [${check.group}] ${check.label}`)
    console.log(`      期望 ${check.expected} · 实测 ${check.actual}`)
  }
  console.log(`verdict: ${payload.summary.verdict}（${String(passed)}/${String(checks.length)}）`)
  console.log(`分组：${groups.map((g) => `${g}=${String(perGroup[g].passed)}/${String(perGroup[g].total)}`).join(' · ')}`)
  console.log(`证据：${String(records.length)} 个 run 目录 · FAIL 档 ${String(failRuns.length)} 个（全部有具名解释）`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
