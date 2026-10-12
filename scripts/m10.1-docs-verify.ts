/**
 * M10.1 WP8 —— **文档自洽门**（`m10.1:docs:verify`）。
 *
 * ============================================================================
 *  它判什么（**只读**：git + 文件；不开库、不出网、不调模型）
 * ============================================================================
 * ```text
 * D1 收口文件齐全（判定表 / 验收报告 / 已知局限 / 激活候选 / 激活记录 / 各 WP 交接单）
 * D2 判定表**分槽齐全**（14 槽，每槽有值 —— 不许出现空槽）
 * D3 ⭐ **A13「只追加」**：`docs/m10/**` 在 M10.1 期间**一个字节没动**；
 *    `ADR-076` 以 M10.1 **之前**的版本为**逐字节前缀**（只允许在后面追加）
 * D4 判定表点名的 `m10.1:*` 命令**都在 `package.json` 里**（不许写不存在的门）
 * D5 「不主张」清单在场（`D12` 的四条逐字）
 * D6 `L-M10.1-04…-12` **都在** `Known-Limitations` 里有条目
 * D7 非零分母
 * ```
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6-command-surface.ts'

const REPO_ROOT = resolve(process.cwd())
const DOCS = join(REPO_ROOT, 'docs/m10.1')
const read = (relative: string): string =>
  existsSync(join(REPO_ROOT, relative)) ? readFileSync(join(REPO_ROOT, relative), 'utf8') : ''
const git = (args: readonly string[]): string =>
  execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()

/** M10 的文档在 M10.1 开始**之前**的最后一个提交（冻结基线） */
const M10_DOCS_FROZEN_AT = '207b873046d32da716682191314462b79d9a3f2e'
/** M10.1 的第一个提交（里程碑起点） */
const M10_1_START = '3132ebf4'

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

/* ---------------------------------------------------------------------------
 * D1 收口文件齐全
 * ------------------------------------------------------------------------- */
const REQUIRED_DOCS = [
  'M10.1-Execution-Plan.md',
  'M10.1-Acceptance-Contract.md',
  'M10.1-WP0-Baseline.md',
  'M10.1-WP1-Handoff.md',
  'M10.1-WP2-Handoff.md',
  'M10.1-WP3-Handoff.md',
  'M10.1-WP4a-Handoff.md',
  'M10.1-WP4b-Handoff.md',
  'M10.1-WP4c-Handoff.md',
  'M10.1-WP5-Handoff.md',
  'M10.1-WP6-Handoff.md',
  'M10.1-WP6a-Handoff.md',
  'M10.1-WP6b-Handoff.md',
  'M10.1-WP2b-Handoff.md',
  'M10.1-Gate-Decision.md',
  'M10.1-Acceptance-Report.md',
  'M10.1-Known-Limitations.md',
  'M10.1-Activation-Candidate.md',
  'M10.1-Activation-Record.md',
] as const
const missingDocs = REQUIRED_DOCS.filter((name) => !existsSync(join(DOCS, name)))
record(
  'D1',
  '【收口文件齐全】执行计划 / 验收契约 / WP0–WP6b 交接单 / 判定表 / 验收报告 / 已知局限 / 激活候选 / 激活记录 **都在**',
  missingDocs.length === 0,
  `应有 ${String(REQUIRED_DOCS.length)} 份 · 缺=${JSON.stringify(missingDocs)}`
)

/* ---------------------------------------------------------------------------
 * D2 判定表分槽齐全（14 槽）
 * ------------------------------------------------------------------------- */
const gateDecision = read('docs/m10.1/M10.1-Gate-Decision.md')
const slotRows = gateDecision
  .split(/\r?\n/)
  .filter((line) => /^\|\s*\d+\s*\|/.test(line))
  .map((line) => line.split('|').map((cell) => cell.trim()))
const emptySlots = slotRows.filter((cells) => (cells[3] ?? '') === '' || (cells[2] ?? '') === '')
record(
  'D2',
  '【判定表分槽齐全】**14 槽**都在，且每槽都有"槽名 + 判定"（**不许空槽**，也不许合成一个总分）',
  slotRows.length === 14 && emptySlots.length === 0,
  `槽数=${String(slotRows.length)} · 空槽=${JSON.stringify(emptySlots.map((cells) => cells[1]))}`
)

/* ---------------------------------------------------------------------------
 * D3 ⭐ A13「只追加」
 * ------------------------------------------------------------------------- */
const m10DocDiff = git(['diff', '--stat', M10_DOCS_FROZEN_AT, 'HEAD', '--', 'docs/m10'])
const frozenBeforeStart =
  ((): boolean => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', M10_DOCS_FROZEN_AT, M10_1_START], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  })()
record(
  'D3a',
  '【⭐ A13 只追加·M10 冻结文档】`docs/m10/**` 自冻结基线起**一个字节没动**，且那个基线在 M10.1 **起点之前**',
  m10DocDiff === '' && frozenBeforeStart,
  `diff 行数=${String(m10DocDiff === '' ? 0 : m10DocDiff.split('\n').length)} · 冻结早于起点=${String(frozenBeforeStart)}`
)

/* `ADR-076` 只允许**在后面追加**：现行文件必须以"**里程碑之前**最后一版"为逐字节前缀。
 * ⚠️ 第一版拿"起点那一刻的版本"当基线 ⇒ 必然红：`ADR-076` 在里程碑**期间**被追加过
 *    （`U-03-a` 的 §10）⇒ 起点版本**不是**现行版本的前缀，而是它前缀的**前缀**。
 *    正确基线 = **不属于**里程碑提交范围（`M10_1_START..HEAD`）的那一版里最新的一个。 */
const ADR = 'docs/adr/ADR-076-m10-goals-and-commitments.md'
const milestoneCommits = new Set(
  git(['log', '--format=%H', `${M10_1_START}..HEAD`])
    .split('\n')
    .filter((line) => line !== '')
)
const adrHistory = git(['log', '--format=%H', '--', ADR])
  .split('\n')
  .filter((line) => line !== '')
const adrPreMilestone = adrHistory.find((hash) => !milestoneCommits.has(hash))
const adrPrev =
  adrPreMilestone === undefined
    ? ''
    : execFileSync('git', ['show', `${adrPreMilestone}:${ADR}`], { cwd: REPO_ROOT, encoding: 'utf8' })
const adrNow = read(ADR)
/*
 * ⚠️ **换行风格必须归一**：工作树里是 CRLF（`core.autocrlf` 检出的），而 `git show` 给的是 LF
 *    ⇒ 不归一的话"逐字节前缀"在**每一行边界**都断，判据会假红。
 */
const normalizeNewlines = (text: string): string => text.replace(/\r\n/g, '\n')
record(
  'D3b',
  '【⭐ A13 只追加·ADR-076】现行 `ADR-076` 以"**里程碑之前**最后一版"为**逐字节前缀**（修订只许追加，改写会被这条抓住）',
  adrPrev !== '' &&
    normalizeNewlines(adrNow).startsWith(normalizeNewlines(adrPrev)) &&
    adrNow.length > adrPrev.length,
  `基线提交=${String(adrPreMilestone ?? '(找不到)').slice(0, 12)} · 前缀成立=${String(
    adrPrev !== '' && normalizeNewlines(adrNow).startsWith(normalizeNewlines(adrPrev))
  )} · 新增 ${String(adrNow.length - adrPrev.length)} 字符`
)

/* ---------------------------------------------------------------------------
 * D4 点名的命令都真的存在
 * ------------------------------------------------------------------------- */
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
const cited = [...gateDecision.matchAll(/`(m10\.1:[a-z0-9:.-]+)`/g)].map((match) => match[1]!)
const uniqueCited = [...new Set(cited)]
/*
 * ⚠️ **在判定表里"点名说 NOT RUN"的命令允许尚不存在**（例如 `m10.1:long:live`）——
 *    判据是"**要么已实现，要么被明示为未跑**"，不是"凡是提到的都得建好"。
 */
const declaredNotRunCommands = uniqueCited.filter((name) =>
  gateDecision
    .split(/\r?\n/)
    .some((line) => line.includes(name) && /NOT RUN|未跑|未做/.test(line))
)
const unknownCommands = uniqueCited.filter(
  (name) => pkg.scripts[name] === undefined && !declaredNotRunCommands.includes(name)
)
record(
  'D4',
  '【点名的命令都在】判定表里写到的每条 `m10.1:*` **要么**在 `package.json` 里，**要么**被同一行明示为 `NOT RUN`（不许写不存在的门而不声明）',
  unknownCommands.length === 0 && uniqueCited.length > 0,
  `点名 ${String(uniqueCited.length)} 条 · 已实现 ${String(uniqueCited.length - declaredNotRunCommands.length)} 条 ·` +
    ` 明示未跑=${JSON.stringify(declaredNotRunCommands)} · 找不到且未声明=${JSON.stringify(unknownCommands)}`
)

/* ---------------------------------------------------------------------------
 * D5 「不主张」清单在场（D12 四条逐字）
 * ------------------------------------------------------------------------- */
/*
 * ⚠️ 文档里那些词被 `**` 加粗过（`**不**主张"…"`）⇒ 先**去掉星号**再比子串，
 *    否则判据量的是"加粗与否"，不是"那句话在不在"。
 */
const stripMarks = (text: string): string => text.replace(/\*/g, '')
const NO_CLAIM_KEYS = ['不主张"她不再重复', '不主张"她能判断他', '不主张"到期=失约', '不主张"约定一定被识别']
const knownLimits = read('docs/m10.1/M10.1-Known-Limitations.md')
const missingClaims = NO_CLAIM_KEYS.filter(
  (key) => !stripMarks(knownLimits).includes(key) || !stripMarks(gateDecision).includes(key)
)
record(
  'D5',
  '【「不主张」清单在场】`D12` 的四条在**判定表**与**已知局限**里都在（激活时照抄，不许只剩一处）',
  missingClaims.length === 0,
  `缺=${JSON.stringify(missingClaims)}`
)

/* ---------------------------------------------------------------------------
 * D6 L-M10.1-04…-12 覆盖齐全
 * ------------------------------------------------------------------------- */
const expectedIds = Array.from({ length: 14 }, (_, index) => `L-M10.1-${String(index + 4).padStart(2, '0')}`)
const missingIds = expectedIds.filter((id) => !knownLimits.includes(id))
record(
  'D6',
  '【残余覆盖齐全】`L-M10.1-04`…`-17` **逐条**在已知局限里有条目（含已 RESOLVED 的：不删，只改状态）',
  missingIds.length === 0,
  `应有 ${String(expectedIds.length)} 条 · 缺=${JSON.stringify(missingIds)}`
)

/* ---------------------------------------------------------------------------
 * D7 非零分母 + 顺手确认守卫常量在场
 * ------------------------------------------------------------------------- */
const denominators = {
  requiredDocs: REQUIRED_DOCS.length,
  slots: slotRows.length,
  citedCommands: uniqueCited.length,
  limitationIds: expectedIds.length,
}
record(
  'D7',
  '【非零分母】四类计数全部 > 0（`0 检查 / 0 不一致` 不算 PASS）',
  Object.values(denominators).every((value) => value > 0) &&
    TEST_MODEL_WRAPPER_MARKER.length > 0,
  JSON.stringify(denominators)
)

/* ---------------------------------------------------------------------------
 * 证据
 * ------------------------------------------------------------------------- */
const failed = checks.filter((check) => !check.pass)
const head = git(['rev-parse', 'HEAD'])
const runId = createM11RunId({ wpId: 'm10-1-wp8-docs', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-docs-verify@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  frozenBaselines: { m10Docs: M10_DOCS_FROZEN_AT, milestoneStart: M10_1_START },
  citedCommands: uniqueCited,
  limitationIds: expectedIds,
  denominators,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer:
    '本门只判**文档的自洽与"只追加"**（含 A13 的两条前缀判据）。它**不**重跑任何门，也**不**主张任何语义结论。',
}
writeFileSync(join(dir, 'docs-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp8-docs',
  head,
  headShort: head.slice(0, 12),
  branch: git(['branch', '--show-current']),
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'docs-verify',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['offline'],
  supersedes: null,
  notes: `m10.1:docs:verify（收口文件 / 14 槽 / A13 只追加 / 点名命令 / 不主张 / 残余覆盖）`,
})
console.log(`runId: ${runId}`)
console.log(
  `verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`
)
process.exit(failed.length === 0 ? 0 : 1)
