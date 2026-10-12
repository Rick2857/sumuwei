/**
 * M10（WP11）—— **回归运行清单 / 退出码只读核验门**（`pnpm m10:regression:verify`）。
 *
 * ============================================================================
 *  计划 §16.1 点名了它，而它此前不存在
 * ============================================================================
 * 原文：`m10:regression:verify` —— 「**只读核验回归运行清单 / 退出码**」（WP11）。
 *
 * §16.3 还给了**受影响的回归至少覆盖**哪 19 条命令（`kernel:test` / `m4.5:*` / `m9:*` /
 * `m9.1:*` / `m9.5:*` / `inc-01:gates`），并逐字提醒：
 * 「聚合命令**读取历史证据不代替**子门在本次实现上的运行」。
 *
 * ============================================================================
 *  它读什么、断言什么
 * ============================================================================
 * 读 `artifacts/.fast/<runId>/run.json`（`gates:run` 写的**运行清单**：
 * `lane` / `mode` / `verdict` / `counts` / `results[{id,status,exitCode,…}]`）。
 *
 * ```text
 * ① 缺记录            ⇒ NOT RUN（**不是** PASS）
 * ② 非零退出码         ⇒ 如实报出，**不因"别的门绿了"而抹掉**
 * ③ 记录身份不全       ⇒ INVALID（lane/mode/verdict 缺一个就没法读）
 * ④ **正式档与快跑档分列**：AGENTS §9.1 逐字「发布证据仍只能来自冻结命令清单 + 串行档 + 干净树」
 *    ⇒ `mode=release` 与 `mode=fast` **分开报**；只有快跑档时必须如实说"没有发布档"
 * ⑤ 清单**不回腐烂**：§16.3 那 19 条从**计划书本身**解析出来，与脚本里的常量**逐字对账**
 *    （"文档里的清单"与"代码里的清单"必须一致；漂了就红）
 * ⑥ **只读**：本门不跑任何子门（`A8` 判结构钉住）
 * ```
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'

const REPO_ROOT = resolve(process.cwd())
const RUN_ROOT = join(REPO_ROOT, 'artifacts', '.fast')
const PLAN = 'docs/m10/M10-Execution-Plan.md'
const SELF_ENTRY = 'scripts/m10-regression-verify.ts'

/**
 * §16.3「受影响回归至少覆盖」的清单。
 *
 * ⚠️ 它**不是**手抄的权威源 —— `A2` 会从 `docs/m10/M10-Execution-Plan.md` §16.3 的
 *    ```text 块里**解析**出同一份清单，与本常量**逐字对账**。漂了就红。
 */
const REQUIRED_REGRESSIONS: readonly string[] = [
  'kernel:test',
  'm4.5:test',
  'm4.5:verify',
  'm4.5:measurement:verify',
  'm9:test',
  'm9:source:verify',
  'm9:invalidation:verify',
  'm9:context:verify',
  'm9:e2e:verify',
  'm9.1:test',
  'm9.1:verify',
  'm9.1:e2e:verify',
  'm9.5:compat:verify',
  'm9.5:lifecycle:verify',
  'm9.5:assembly:verify',
  'm9.5:context:verify',
  'm9.5:modes:verify',
  'm9.5:privacy:verify',
  'inc-01:gates',
]

function phase(mark: string): void {
  console.error(`[m10-regression] ${mark}`)
}

interface Check {
  group: 'A' | 'C'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
  /**
   * **`true` = 这一行是"登记"，不是断言**（`L-M10-65`）。
   *
   * ⚠️ 为什么要有这个字段：本门有 3 条检查的 `expected` 逐字写着"如实报出（数量不作断言）"
   *    —— 它们**本来就是登记**，却**被计进 `N/N PASS` 的总数**。
   *    于是 `11/11` 读起来像"11 件事被验证了"，而其中 3 件什么都没断言。
   * ⇒ 现在：`recordNote()` 记的登记**不进** `passed/total`，另报 `notes: N`。
   *   ⚠️ **靠类型而不是靠"我记得别写"**（与 `U-11` 的 `DeclarativeScore` 没有 `rate` 字段同一条纪律）。
   */
  note: boolean
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
  checks.push({ group, id, label, expected, actual, pass, note: false })
}

/**
 * 记一条**登记**（如实报出一个读数，**不对它作断言**）。
 *
 * ⚠️ 它**没有 `pass` 参数** —— 这正是重点：调用点连"传个恒真的表达式"都做不到，
 *   所以"空量具混进断言计数"在这条路径上**是类型上不可能的**（`L-M10-65` 的修法）。
 * ⚠️ 它仍**留在 `checks` 数组里**（读数不丢），只是**不进** `passed/total`。
 */
function recordNote(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
): void {
  checks.push({ group, id, label, expected, actual, pass: true, note: true })
}

/** 从计划书 §16.3 解析"受影响回归至少覆盖"的清单 */
export function parseRequiredFromPlan(text: string): string[] {
  const anchor = text.indexOf('受影响回归至少覆盖')
  if (anchor < 0) return []
  const after = text.slice(anchor)
  const block = /```text\r?\n([\s\S]*?)```/.exec(after)
  if (block === null) return []
  return block[1]!
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('pnpm '))
    .map((line) => line.slice('pnpm '.length).trim())
}

interface RunRecord {
  readonly runId: string
  readonly lane: string
  readonly mode: string
  readonly verdict: string
  readonly finishedAt: string
  readonly results: readonly { id: string; status: string; exitCode: number }[]
  readonly invalid: boolean
}

function readRecords(): RunRecord[] {
  if (!existsSync(RUN_ROOT)) return []
  const out: RunRecord[] = []
  for (const name of readdirSync(RUN_ROOT).sort()) {
    const file = join(RUN_ROOT, name, 'run.json')
    if (!existsSync(file)) continue
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    const lane = typeof raw.lane === 'string' ? raw.lane : ''
    const mode = typeof raw.mode === 'string' ? raw.mode : ''
    const verdict = typeof raw.verdict === 'string' ? raw.verdict : ''
    const results = Array.isArray(raw.results)
      ? (raw.results as { id?: unknown; status?: unknown; exitCode?: unknown }[]).map((item) => ({
          id: typeof item.id === 'string' ? item.id : '',
          status: typeof item.status === 'string' ? item.status : '',
          exitCode: typeof item.exitCode === 'number' ? item.exitCode : -1,
        }))
      : []
    out.push({
      runId: name,
      lane,
      mode,
      verdict,
      finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : '',
      results,
      /* 身份不全 ⇒ 这份记录读不了（不是"没问题"） */
      invalid: lane === '' || mode === '' || verdict === '' || results.length === 0,
    })
  }
  return out
}

/** 某条命令**在记录里的最佳读数**（新记录覆盖旧记录） */
function readingOf(
  command: string,
  records: readonly RunRecord[],
): { status: string; exitCode: number; lane: string; mode: string; runId: string } | null {
  let best: { status: string; exitCode: number; lane: string; mode: string; runId: string } | null = null
  for (const record of records) {
    if (record.invalid) continue
    const hit = record.results.find((item) => item.id === command)
    if (hit === undefined) continue
    /* 记录按目录名升序 ⇒ 后遍历到的更新 */
    best = {
      status: hit.status,
      exitCode: hit.exitCode,
      lane: record.lane,
      mode: record.mode,
      runId: record.runId,
    }
  }
  return best
}

function main(): void {
  phase('A: 只读核验回归运行清单 / 退出码')
  const records = readRecords()
  const valid = records.filter((record) => !record.invalid)
  const invalidRecords = records.filter((record) => record.invalid)
  const releaseRecords = valid.filter((record) => record.mode === 'release')
  const fastRecords = valid.filter((record) => record.mode !== 'release')

  /* ------------------------------------------------------------------ A1 */
  record(
    'A',
    'A1',
    '**材料在场**：`artifacts/.fast` 存在 · 读到 ≥1 份**可读**运行清单 · ≥1 份带 `results`'
      + '（"读到 0 份、0 个问题"与"全部通过"在输出上长得一样）',
    '根在 · 可读清单 ≥1',
    existsSync(RUN_ROOT)
      ? `根在 · 清单 ${String(records.length)} 份（可读 ${String(valid.length)} · 身份不全 ${String(invalidRecords.length)}）`
      : '**根缺**（没有任何 `gates:run` 记录）',
    existsSync(RUN_ROOT) && valid.length > 0,
  )

  /* ------------------------------------------------------------------ A2 */
  const fromPlan = parseRequiredFromPlan(readFileSync(join(REPO_ROOT, PLAN), 'utf8'))
  const sameSet =
    fromPlan.length === REQUIRED_REGRESSIONS.length &&
    fromPlan.every((item, index) => item === REQUIRED_REGRESSIONS[index])
  record(
    'A',
    'A2',
    '**清单不回腐烂**：§16.3 的「受影响回归至少覆盖」清单从**计划书本身**解析出来，'
      + '与脚本里的常量**逐字相同**（顺序也算）—— 计划改了而脚本没改 ⇒ 红',
    `${String(REQUIRED_REGRESSIONS.length)} 条逐字一致`,
    sameSet
      ? `${String(fromPlan.length)} 条逐字一致`
      : `计划 ${String(fromPlan.length)} 条 vs 脚本 ${String(REQUIRED_REGRESSIONS.length)} 条` +
        ` · 差异=${fromPlan.filter((item) => !REQUIRED_REGRESSIONS.includes(item)).join(',') || '（顺序不同）'}`,
    sameSet && fromPlan.length > 0,
  )

  /* ------------------------------------------------------------------ A3 */
  const readings = REQUIRED_REGRESSIONS.map((command) => ({ command, reading: readingOf(command, valid) }))
  const covered = readings.filter((item) => item.reading !== null && item.reading.exitCode === 0)
  const failed = readings.filter((item) => item.reading !== null && item.reading.exitCode !== 0)
  const notRun = readings.filter((item) => item.reading === null)
  record(
    'A',
    'A3',
    '**§16.3 的 19 条逐条有归属**：**通过（exit 0）** / **非零退出** / **NOT RUN**'
      + '（缺记录 ⇒ NOT RUN，**不是** PASS）；三类的和必须等于 19',
    `通过 + 非零 + NOT RUN = ${String(REQUIRED_REGRESSIONS.length)}`,
    `通过 ${String(covered.length)} · 非零 ${String(failed.length)} · NOT RUN ${String(notRun.length)}`,
    covered.length + failed.length + notRun.length === REQUIRED_REGRESSIONS.length &&
      REQUIRED_REGRESSIONS.length > 0,
  )

  /* ------------------------------------------------------------------ A4 */
  recordNote(
    'A',
    'A4',
    '**非零退出码如实报出**，不因"别的门绿了"而抹掉（与 `m10:evidence:verify` 的 `A8` 同一条纪律：'
      + '失败档分列保留、不回写）',
    '如实报出（数量不作断言）',
    failed.length === 0
      ? '记录里没有非零退出的必跑项'
      : `${String(failed.length)} 条非零：${failed.map((item) => `${item.command}=${String(item.reading!.exitCode)}`).join(' · ')}`,
  )

  /* ------------------------------------------------------------------ A5 */
  recordNote(
    'A',
    'A5',
    '**身份不全的记录 ⇒ INVALID，不计入读数**：`lane` / `mode` / `verdict` / 非空 `results`'
      + ' 缺任何一个，那份清单就读不了 —— 读不了不等于没问题',
    '身份不全的清单不参与判定（数量如实报出）',
    invalidRecords.length === 0
      ? '全部清单身份完整'
      : `${String(invalidRecords.length)} 份身份不全：${invalidRecords.slice(0, 3).map((item) => item.runId).join(' · ')}`,
  )

  /* ------------------------------------------------------------------ A6 */
  recordNote(
    'A',
    'A6',
    '**正式档与快跑档分列**（AGENTS §9.1 逐字：「发布证据仍只能来自冻结命令清单 + **串行档** + 干净树」）'
      + '—— 只有快跑档时必须如实说"**没有发布档**"，不许拿 fast 档当发布证据',
    '两档分列报出',
    `release 档 ${String(releaseRecords.length)} 份 · fast 档 ${String(fastRecords.length)} 份 · ` +
      (releaseRecords.length === 0
        ? '**没有发布档**（当前所有回归读数都来自快跑档）'
        : `最近发布档 ${releaseRecords[releaseRecords.length - 1]!.runId}`),
  )

  /* ------------------------------------------------------------------ A7 */
  record(
    'A',
    'A7',
    '**覆盖率如实报出**：19 条里有多少条有 exit 0 的**记录**'
      + '（⚠️ 记录 ≠ 本次实现上的运行：§16.3 逐字"聚合命令**读取历史证据不代替**子门在本次实现上的运行"）',
    '如实报出（不作断言）',
    `${String(covered.length)}/${String(REQUIRED_REGRESSIONS.length)} 条有 exit 0 记录`,
    covered.length > 0,
  )

  /* ------------------------------------------------------------------ A8 */
  /*
   * ⚠️ 与 `m10:gates` 的 `A8` 同一条纪律、同一处陷阱：判结构时**必须把模板串剥掉**，
   *    而**不能**把单引号字符串也剥掉（`'git'` 是判据要读的实参）。
   */
  const stripProse = (text: string): string =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/`[\s\S]*?`/g, '``')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
  const selfText = stripProse(readFileSync(join(REPO_ROOT, SELF_ENTRY), 'utf8'))
  const spawnCalls = [...selfText.matchAll(/(execFileSync|spawnSync|execSync|spawn)\s*\(/g)]
  const nonGitSpawns = spawnCalls.filter((match) => {
    const after = selfText.slice(match.index + match[0].length, match.index + match[0].length + 6)
    return !after.startsWith("'git'")
  })
  record(
    'A',
    'A8',
    '**【只读、不跑子门】** 判结构（剥注释与模板串）：每个进程启动调用的第一个实参都必须是 `git`',
    '全部启动调用都只读 git',
    spawnCalls.length === 0
      ? '**一处启动都没有**'
      : `${String(spawnCalls.length)} 处启动 · 非 git 的 ${String(nonGitSpawns.length)} 处`,
    spawnCalls.length > 0 && nonGitSpawns.length === 0,
  )

  /* ------------------------------------------------------------------ A9 */
  /*
   * ⚠️ **区分两种 NOT RUN**（这一条是本轮真的撞出来的）：
   * ```text
   * ① 命令**不存在**        ⇒ 那是"清单写错了"，属配置缺陷
   * ② 命令存在、但**没有记录** ⇒ 那是"没被登记进任何 lane / 没跑过"，
   *                            是可解释的状态（本轮实测：§16.3 的 M9.1 三条
   *                            在 `package.json` 里有、但**没有 `m9.1` lane** ⇒
   *                            `gates:run` 从没跑过它们 ⇒ 盘上没有运行记录）
   * ```
   * 把两者混成一句 "NOT RUN" 会让读者以为清单坏了 —— 而它们的原因完全不同。
   */
  const packageScripts = (
    JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
  ).scripts ?? {}
  const notRunMissing = notRun.filter((item) => !(item.command in packageScripts))
  const notRunExisting = notRun.filter((item) => item.command in packageScripts)
  record(
    'A',
    'A9',
    '**两种 NOT RUN 分开**：命令**不存在**（清单写错）vs 命令**存在但没记录**'
      + '（没被登记进 lane / 没跑过）。混成一句会让读者以为清单坏了',
    '0 条命令不存在',
    notRunMissing.length === 0
      ? `${String(notRun.length)} 条 NOT RUN **都存在**（= 没记录，不是清单错）`
      : `**清单里有 ${String(notRunMissing.length)} 条命令根本不存在**：${notRunMissing.map((item) => item.command).join(', ')}`,
    notRunMissing.length === 0,
  )
  void notRunExisting

  /* ==================================================================== C */
  phase('C: 正负控')
  record(
    'C',
    'C1',
    '【正控】真实记录里**至少有一条** §16.3 的命令拿到了读数'
      + '（否则下面的负控可以靠"永远报 NOT RUN"通过）',
    '≥1 条有读数',
    covered.length + failed.length === 0
      ? '**一条都没有**'
      : `${String(covered.length + failed.length)} 条有读数（例：${readings.find((item) => item.reading !== null)!.command}）`,
    covered.length + failed.length > 0,
  )
  const fakeReading = readingOf('m10:definitely-not-a-command', valid)
  record(
    'C',
    'C2',
    '【负控】**一条不存在的命令**必须得到 `null`（⇒ 报 NOT RUN）——'
      + '若它也能"读到"什么，那"缺记录⇒NOT RUN"就是假的',
    'null',
    fakeReading === null ? 'null' : `**读到了**：${JSON.stringify(fakeReading)}`,
    fakeReading === null,
  )

  /* ================================================================== 落盘 */
  /*
   * ⚠️ **分母只算断言**（`L-M10-65`）：登记（`recordNote`）不进 `passed/total`，
   *    只另报 `notes: N` —— 否则"N/N PASS"会把"什么都没断言的行"也算成"验证过的事"。
   */
  const assertions = checks.filter((check) => !check.note)
  const notes = checks.length - assertions.length
  const passed = assertions.filter((check) => check.pass).length
  const failedChecks = assertions.length - passed
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp11-regression', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm10-regression-verify@1',
    runId,
    head,
    mode: 'offline' as const,
    semanticClaim: 'none' as const,
    runRecords: {
      total: records.length,
      valid: valid.length,
      invalid: invalidRecords.length,
      release: releaseRecords.length,
      fast: fastRecords.length,
    },
    required: REQUIRED_REGRESSIONS.map((command) => ({
      command,
      /** null ⇒ 记录里没有它 ⇒ NOT RUN */
      reading: readingOf(command, valid),
    })),
    coverage: { covered: covered.length, failed: failed.length, notRun: notRun.length },
    checks,
    summary: {
      total: assertions.length,
      passed,
      failed: failedChecks,
      /** **登记**条数（不进 `total/passed`）—— `L-M10-65` */
      notes,
      verdict: failedChecks === 0 ? 'PASS' : 'FAIL',
    },
    disclaimer:
      '**只读**核验回归运行清单与退出码（不跑任何子门）。缺记录 ⇒ NOT RUN；身份不全的记录 ⇒ INVALID。' +
      '⚠️ §16.3 逐字：「聚合命令**读取历史证据不代替**子门在本次实现上的运行」' +
      '—— 本门报的是**记录**，不是"这些门在本次改动上跑过了"。',
  }
  writeFileSync(join(dir, 'regression-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp11',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'regression-verify',
    counts: { total: assertions.length, passed, failed: failedChecks, notes },
    phases: ['single'],
    supersedes: null,
    notes:
      '**只读回归清单核验**（计划 §16.1 的 `m10:regression:verify`）：读 `artifacts/.fast/*/run.json`，' +
      '逐条核 §16.3 的 19 条必跑项（通过/非零/NOT RUN 分列）；清单从计划书解析并对账；' +
      '正式档与快跑档分列。⚠️ 不跑子门（A8 判结构钉住）。',
    databaseScope: 'not-applicable',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} [${check.group}] ${check.label}`)
    console.log(`      期望 ${check.expected} · 实测 ${check.actual}`)
  }
  console.log(
    `verdict: ${payload.summary.verdict}（断言 ${String(passed)}/${String(assertions.length)}` +
      `${notes > 0 ? ` · 登记 ${String(notes)} 条` : ''}）`,
  )
  console.log(
    `§16.3 覆盖率：通过 ${String(covered.length)} · 非零退出 ${String(failed.length)} · ` +
      `NOT RUN ${String(notRun.length)} / ${String(REQUIRED_REGRESSIONS.length)}`,
  )
  if (notRun.length > 0) console.log(`NOT RUN：${notRun.map((item) => item.command).join(' · ')}`)
  if (failed.length > 0) {
    console.log(`非零退出：${failed.map((item) => `${item.command}=${String(item.reading!.exitCode)}`).join(' · ')}`)
  }
  process.exit(failedChecks === 0 ? 0 : 1)
}

main()
