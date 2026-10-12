/**
 * M11 WP11 —— **文档与状态纪律门**（`m11:docs:verify`，计划 §12.1）。
 *
 * ============================================================================
 *  计划 §12.1 对它的要求
 * ============================================================================
 * ```text
 * 「`m11:docs:verify` | **文件 / 状态 / 链接纪律** | **实现归属**、**旧证据未回写**」
 * ```
 *
 * ============================================================================
 *  七条判据（口径写死，再看读数）
 * ============================================================================
 * ```text
 * D1 **计划书不可改**：`M11-Execution-Plan.md` 的 sha256 必须等于 WP0 冻结的那个值
 *    （计划书是权威源；改了它，后面所有"按计划"的说法都失去参照）。
 * D2 **文件齐全**：WP0–WP11 交接单 + 契约 + ADR-085 + 未决项 + OSS 借用登记册都在。
 * D3 **链接可达**：`docs/m11/*.md` 里所有**相对**链接都能解析到真实文件（89 条）。
 * D4 **头部齐全**：每份交接单都有「日期 / 状态 / 设计权威」三行（人读得懂"这份是什么"）。
 * D5 **失败不被藏起来**：聚合门（`m11:gates`）报 FAIL 的门，其命令名必须**至少出现在一份文档里**
 *    —— "旧证据未回写"的反面：**坏消息也要在案**。
 * D6 **实现归属**：`scripts/m11-*.ts` 与 `evals/m11/*` 必须**至少被一份文档点名**
 *    —— 没有归属的实现文件是"孤儿"（别人不知道它属于哪个工作包）。
 * D7 **私密材料不得被当成入库物**：文档里出现 `artifacts/m11/local` 时必须写明 gitignored/不入库。
 * ```
 *
 * ⚠️ 只读：不开库、不调模型、不写任何 `src/` 或 `docs/` 文件；只写自己的证据目录。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'

const REPO_ROOT = resolve(process.cwd())
const DOCS_DIR = join(REPO_ROOT, 'docs', 'm11')
const ARTIFACTS = join(REPO_ROOT, 'artifacts', 'm11')

/** WP0 冻结的计划书指纹（本门**只**认这一个值；它变 ⇒ 计划书被动过） */
const FROZEN_PLAN_SHA256 =
  '12318E897FA204D29C5571717E5F8876664F01D15DBB3A5AFAB4D7CE56B6B8C8'

const REQUIRED_DOCS = [
  'M11-Execution-Plan.md',
  'M11-Acceptance-Contract.md',
  'M11-Unresolved-Decisions.md',
  'M11-OSS-Borrowing-Register.md',
  'M11-WP0-Baseline.md',
  ...Array.from({ length: 12 }, (_, index) => `M11-WP${String(index)}-Handoff.md`),
  'M11-WP11-Observability-Handoff.md',
]

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function record(id: string, label: string, pass: boolean, detail: string): void {
  checks.push({ id, label, pass, detail })
}

/** 取出 markdown 里的相对链接目标（跳过 http / 锚点 / 绝对路径） */
function relativeLinks(markdown: string): string[] {
  const out: string[] = []
  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]!
    if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue
    out.push(target.split('#')[0]!)
  }
  return out
}

function main(): void {
  const docNames = existsSync(DOCS_DIR)
    ? readdirSync(DOCS_DIR).filter((name) => name.endsWith('.md'))
    : []
  const docTexts = new Map<string, string>(
    docNames.map((name) => [name, readFileSync(join(DOCS_DIR, name), 'utf8')])
  )
  const allText = [...docTexts.values()].join('\n')

  // ---- D1 计划书不可改 ----
  const planPath = join(DOCS_DIR, 'M11-Execution-Plan.md')
  const planHash = execFileSync('certutil', ['-hashfile', planPath, 'SHA256'], {
    encoding: 'utf8',
  })
    .split('\n')[1]
    ?.replace(/\s+/g, '')
    .toUpperCase()
  record(
    'D1',
    '【计划书不可改】`M11-Execution-Plan.md` 的 sha256 等于 WP0 冻结值（权威源一个字节都没动）',
    planHash === FROZEN_PLAN_SHA256,
    `实测=${String(planHash).slice(0, 16)}… · 冻结=${FROZEN_PLAN_SHA256.slice(0, 16)}…`
  )

  // ---- D2 文件齐全 ----
  const missing = REQUIRED_DOCS.filter((name) => !docNames.includes(name))
  record(
    'D2',
    '【文件齐全】WP0–WP11 交接单 + 契约 + 未决项 + OSS 登记册 + 可观测性交接单都在',
    missing.length === 0,
    `在案=${String(docNames.length)} 份 · 缺=${JSON.stringify(missing)}`
  )

  // ---- D3 链接可达 ----
  const broken: { from: string; target: string }[] = []
  let linkCount = 0
  for (const [name, text] of docTexts) {
    for (const target of relativeLinks(text)) {
      linkCount += 1
      const resolved = resolve(dirname(join(DOCS_DIR, name)), target)
      if (!existsSync(resolved)) broken.push({ from: name, target })
    }
  }
  record(
    'D3',
    '【链接可达】`docs/m11/*.md` 里所有相对链接都能解析到真实文件',
    broken.length === 0 && linkCount > 0,
    `检查=${String(linkCount)} 条 · 断链=${JSON.stringify(broken.slice(0, 6))}`
  )

  // ---- D4 头部齐全 ----
  const handoffs = docNames.filter((name) => /-Handoff\.md$/.test(name))
  const headerless = handoffs.filter((name) => {
    const text = docTexts.get(name)!
    return !/日期/.test(text) || !/状态/.test(text) || !/(设计权威|权威)/.test(text)
  })
  record(
    'D4',
    '【头部齐全】每份交接单都有「日期 / 状态 / 权威」三行（人读得懂"这份是什么"）',
    headerless.length === 0 && handoffs.length > 0,
    `交接单=${String(handoffs.length)} 份 · 缺行=${JSON.stringify(headerless)}`
  )

  // ---- D5 失败不被藏起来 ----
  const gateFiles = existsSync(ARTIFACTS)
    ? readdirSync(ARTIFACTS, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('m11-wp11-gates-'))
        .map((entry) => join(ARTIFACTS, entry.name, 'gates.json'))
        .filter((path) => existsSync(path))
        .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    : []
  const latestGates = gateFiles.length === 0 ? undefined : JSON.parse(readFileSync(gateFiles[gateFiles.length - 1]!, 'utf8'))
  const failing: { wp: string; detail: string }[] = (latestGates?.readings ?? [])
    .filter((row: { verdict: string }) => row.verdict === 'FAIL' || row.verdict === 'INVALID')
    .map((row: { wp: string; detail: string }) => ({ wp: row.wp, detail: row.detail }))
  const undocumented = failing.filter((row) => {
    // 门名（wp）或其命令名（m11:xxx）出现在任意一份文档里 ⇒ 认为"在案"
    const needles = [row.wp, row.wp.replace(/^wp/, 'm11:')]
    return !needles.some((needle) => allText.includes(needle))
  })
  record(
    'D5',
    '【失败不被藏起来】聚合门报 FAIL/INVALID 的门，其名字**至少出现在一份文档里**（坏消息也要在案）',
    latestGates !== undefined && undocumented.length === 0,
    latestGates === undefined
      ? '**没有聚合证据**（先跑 `m11:gates`）'
      : `FAIL/INVALID=${JSON.stringify(failing.map((row) => row.wp))} · 未在案=${JSON.stringify(undocumented.map((row) => row.wp))}`
  )

  // ---- D6 实现归属 ----
  const implementationFiles = [
    ...readdirSync(join(REPO_ROOT, 'scripts'))
      .filter((name) => name.startsWith('m11-') && name.endsWith('.ts'))
      .map((name) => `scripts/${name}`),
    ...(existsSync(join(REPO_ROOT, 'evals', 'm11'))
      ? readdirSync(join(REPO_ROOT, 'evals', 'm11')).map((name) => `evals/m11/${name}`)
      : []),
  ]
  /*
   * ⚠️ **归属按"公开名或内部名"两选一**（第一版只认文件 basename ⇒ 报了 18 个"孤儿"，
   *    而它们其实**都**被文档点名了 —— 点的是**命令名**（`m11:inputs:verify`），
   *    那正是计划 §12.1 命令表用的名字）。
   *    ⇒ 从 `package.json` 建一张 `命令 → 入口文件` 的表，两者命中其一即算有归属。
   *    （判据的"对象"又错了一次：我把"实现文件"与"公开命令"当成了同一个名字空间。）
   */
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const commandByEntry = new Map<string, string>()
  for (const [command, argv] of Object.entries(packageJson.scripts ?? {})) {
    const match = /(?:^|\s)(scripts\/[\w.-]+\.ts)/.exec(argv)
    if (match !== null) commandByEntry.set(match[1]!, command)
  }
  const orphanFiles = implementationFiles.filter((file) => {
    const base = file.split('/').pop()!
    const command = commandByEntry.get(file)
    return !allText.includes(base) && (command === undefined || !allText.includes(command))
  })
  record(
    'D6',
    '【实现归属】每个 `scripts/m11-*.ts` / `evals/m11/*` 都被**至少一份文档**点名（**公开命令名或文件名**命中其一即算）',
    orphanFiles.length === 0,
    `实现文件=${String(implementationFiles.length)} 个 · 孤儿=${JSON.stringify(orphanFiles)}`
  )

  // ---- D7 私密材料不得被当成入库物 ----
  const privateMentions = docNames.filter((name) => docTexts.get(name)!.includes('artifacts/m11/local'))
  const unmarked = privateMentions.filter((name) => {
    const text = docTexts.get(name)!
    const around = text
      .split('\n')
      .filter((line) => line.includes('artifacts/m11/local'))
      .join('\n')
    return !/gitignore|不入库|私密/i.test(around)
  })
  record(
    'D7',
    '【私密材料】提到 `artifacts/m11/local` 的文档**必须**写明"gitignored / 不入库 / 私密"',
    unmarked.length === 0,
    `提及=${String(privateMentions.length)} 份 · 未标注=${JSON.stringify(unmarked)}`
  )

  /*
   * ---- D8 文档承诺的命令必须真的存在 ----
   *
   * ⚠️ 这一条是 **D6 抓出来的**：`m11:semantic:eval` / `m11:smoke:live` / `m11:docs:verify`
   *    在交接单里被引用了 5–6 次，而 `package.json` 里**从来没有注册过它们** ——
   *    文档承诺了一个跑不起来的命令。这正是"文档/实现漂移"最典型的形态。
   * ⚠️ 扫描范围**排除计划书本身**：它是规格，允许列出**尚未实现**的命令（WP12 的 activation 两条）。
   */
  /*
   * ⚠️ **边界要排除 `:` 与词字符**：第一版用 `\bm11:…` ⇒ 把 `m10:m11:verify`（**M10** 的门）
   *    里的 `m11:verify` 也抓了出来 ⇒ 报了一个根本不存在的"未注册命令"。
   *    （又一次"判据的对象错了"：这次是把**别人家的命令**当成了我们的。）
   */
  /*
   * ⚠️ **只扫"清单/表格项"的行**（`^\s*[-|]`）—— 这是本仓库写"门与命令"的位置。
   *
   * 这条判据改了**三版**，每次都是"作用域/对象"错，记在这里免得再犯：
   *   ① 第一版扫全文 + `\bm11:…` ⇒ 把 `m10:m11:verify`（**M10** 的门）当成了我们的；
   *   ② 第二版加负向后顾 ⇒ 又被**我自己解释这个缺陷的那句话**绊倒（散文里的 `m11:verify`）；
   *   ③ 第三版只认 `|` 与 `pnpm ` 行 ⇒ 太窄（只剩 1 个"承诺"，等于没查）；
   *   ④ 本版认**清单项与表格行**：既覆盖"门/命令"的实际书写位置，又不吃散文。
   */
  const handoffTexts = [...docTexts.entries()].filter(([name]) => /-Handoff\.md$/.test(name))
  const promised = new Set<string>()
  for (const [, text] of handoffTexts) {
    for (const line of text.split('\n')) {
      if (!/^\s*[-|]/.test(line)) continue
      for (const match of line.matchAll(/(?<![\w:])m11:[\w.:-]+/g)) promised.add(match[0]!)
    }
  }
  /**
   * **已登记但尚未实现**的命令（显式白名单 + 归属）。
   *
   * ⚠️ 白名单**必须短且有名有姓**：它存在是为了让 D8 抓"漂移"，而不是让漂移合法化。
   */
  const PENDING_COMMANDS: Readonly<Record<string, string>> = {
    'm11:regression:verify': 'WP11 剩余（消费已跑回归证据）',
    'm11:activation:verify': 'WP12（需独立授权）',
    'm11:activation:readback': 'WP12（需独立授权）',
  }
  const unregistered = [...promised].filter(
    (command) => (packageJson.scripts ?? {})[command] === undefined
  )
  const drifted = unregistered.filter((command) => PENDING_COMMANDS[command] === undefined)
  record(
    'D8',
    '【命令存在】交接单承诺的 `m11:*` 命令要么**已注册**，要么在**显式待实现白名单**里（白名单外 = 漂移）',
    promised.size > 0 && drifted.length === 0,
    `承诺=${String(promised.size)} 个 · 待实现=${JSON.stringify(unregistered.filter((c) => PENDING_COMMANDS[c] !== undefined))} · **漂移=${JSON.stringify(drifted)}**`
  )

  const failed = checks.filter((check) => !check.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'wp11-docs', headShort: head })
  const dir = openM11RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm11-docs-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    planSha256: planHash,
    frozenPlanSha256: FROZEN_PLAN_SHA256,
    docCount: docNames.length,
    linkCount,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'docs-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp11-docs',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'docs',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: 'm11:docs:verify（计划书不可改 · 链接可达 · 头部齐全 · 失败在案 · 实现归属 · 私密材料标注）',
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label} —— ${check.detail}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main()
