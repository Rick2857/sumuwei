/**
 * M10.1 WP4a —— **结清事实块门**（`m10.1:context:verify`）。
 *
 * ============================================================================
 *  它证明什么（**全部离线**：不连模型、不连数据库）
 * ============================================================================
 * ```text
 * C1 ⭐ **已结清 ⇒ 不要再提**：终态（fulfilled / cancelled / superseded）渲染出
 *    「已结清，**不要再提**」——这就是 R-26 的修法核心（用**程序事实**压过窗口里的历史锚）。
 * C2 ⭐ **已过期 ⇒ 不要再提，但措辞不含指控**：`expired` 档说"**时间到了**"，
 *    **不得**出现"失约/违约/你没做到/没履行"之类词（词表冻结）。
 * C3 **未结清 ⇒ 正常列出**（不误伤）：pending 渲染出"未结清的约定"+判据人话 + 截止状态。
 * C4 **顺序**：结清行**排在未结清行前面** ⇒ 额度紧时"不要再提"优先保住。
 * C5 **失败关闭**：额度 0 ⇒ 0 个 section；额度连"块头 + 第一条行"都放不下 ⇒ **整块不渲染**。
 * C6 **程序渲染**：正文只由模板拼出 —— 断言正文里**没有**内部 id / revision（它们只进 `sourceRefs`）。
 * C7 **确定性**：同一输入两次 ⇒ 逐字段相同。
 * C8 **非零分母**。
 * ```
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import {
  COMMITMENT_BLOCK_HEADER,
  COMMITMENT_CLOSED_CONTENT_OMITTED,
  COMMITMENT_CRITERION_LABELS,
  COMMITMENT_DO_NOT_RAISE,
  renderCommitmentStateBlock,
  type CommitmentFactRow,
} from '../src/kernel/app/goal/commitment-facts.ts'

const REPO_ROOT = resolve(process.cwd())
const quantify = (text: string): number => [...text].length
/** 读源码（静态锁用；只读文件） */
const readSrc = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8')

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

/** 指控词表（**冻结**：到期档出现其中任何一个 ⇒ 红） */
const ACCUSATION_WORDS = ['失约', '违约', '没做到', '没履行', '不守约', '失信'] as const

const fulfilled: CommitmentFactRow = {
  goalId: 'gol:met',
  scope: '下次继续时给你三个步骤',
  status: 'fulfilled',
  criterionKind: 'conversation_output',
}
const expired: CommitmentFactRow = {
  goalId: 'gol:overdue',
  scope: '明天十点二十五楼下见',
  status: 'expired',
  criterionKind: 'user_report',
  dueAt: 1_960_000_000_000,
}
const pending: CommitmentFactRow = {
  goalId: 'gol:pending',
  scope: '投稿前先把稿子发给她看',
  status: 'active',
  criterionKind: 'action_result',
}

// ---------------------------------------------------------------------------
// C1 已结清 ⇒ 不要再提（**且不复述内容** —— `L-M10.1-15` 的修法）
// ---------------------------------------------------------------------------
const closedBlock = renderCommitmentStateBlock({ rows: [fulfilled], maxTokens: 400, quantify })[0]
const closedText = closedBlock?.content ?? ''
record(
  'C1',
  '【⭐ 已结清 ⇒ 不要再提，且**不复述内容**】终态渲染出「已结清，不要再提」+「内容从略」，**且块里一个字都不出现那条 `scope`**' +
    '（判据变更：2026-10-02 前这条要求"含 scope"，实测把内容摆出来**不会**降低她再提 ⇒ 反过来要求"不含 scope"）',
  closedBlock !== undefined &&
    closedText.includes('已结清') &&
    closedText.includes(COMMITMENT_DO_NOT_RAISE) &&
    closedText.includes(COMMITMENT_CLOSED_CONTENT_OMITTED) &&
    !closedText.includes(fulfilled.scope),
  `含"已结清"=${String(closedText.includes('已结清'))} · 含"不要再提"=${String(closedText.includes(COMMITMENT_DO_NOT_RAISE))} · ` +
    `含"内容从略"=${String(closedText.includes(COMMITMENT_CLOSED_CONTENT_OMITTED))} · **含 scope=${String(closedText.includes(fulfilled.scope))}**（必须 false）`
)

// ---------------------------------------------------------------------------
// C2 ⭐ 已过期 ⇒ 不要再提，且**不含指控**
// ---------------------------------------------------------------------------
const expiredBlock = renderCommitmentStateBlock({ rows: [expired], maxTokens: 400, quantify })[0]
const expiredText = expiredBlock?.content ?? ''
const accusationHits = ACCUSATION_WORDS.filter((word) => expiredText.includes(word))
record(
  'C2',
  '【⭐ 已过期 ⇒ 不要再提，措辞**不含指控**】到期档说"时间到了"；冻结词表里的指控词**一个都不许出现**',
  expiredBlock !== undefined &&
    expiredText.includes('已过期') &&
    expiredText.includes(COMMITMENT_DO_NOT_RAISE) &&
    accusationHits.length === 0,
  `含"已过期"=${String(expiredText.includes('已过期'))} · 含"不要再提"=${String(expiredText.includes(COMMITMENT_DO_NOT_RAISE))} · 指控词命中=${JSON.stringify(accusationHits)}`
)

// ---------------------------------------------------------------------------
// C3 未结清 ⇒ 正常列出（不误伤）
// ---------------------------------------------------------------------------
const pendingBlock = renderCommitmentStateBlock({ rows: [pending], maxTokens: 400, quantify })[0]
const pendingText = pendingBlock?.content ?? ''
record(
  'C3',
  '【未结清 ⇒ 正常列出】pending 渲染出「未结清的约定」+ 判据人话 + 截止状态（**不**出现"不要再提"）',
  pendingBlock !== undefined &&
    pendingText.includes('未结清的约定') &&
    pendingText.includes(COMMITMENT_CRITERION_LABELS.action_result) &&
    pendingText.includes('没有截止时间') &&
    !pendingText.includes(COMMITMENT_DO_NOT_RAISE),
  `含"未结清的约定"=${String(pendingText.includes('未结清的约定'))} · 含"不要再提"=${String(pendingText.includes(COMMITMENT_DO_NOT_RAISE))}`
)

// ---------------------------------------------------------------------------
// C4 顺序：结清行在前
// ---------------------------------------------------------------------------
const mixedBlock = renderCommitmentStateBlock({
  rows: [pending, expired, fulfilled],
  maxTokens: 400,
  quantify,
})[0]
const mixedLines = (mixedBlock?.content ?? '').split('\n').slice(1)
const firstClosedIndex = mixedLines.findIndex((line) => line.includes(COMMITMENT_DO_NOT_RAISE))
const firstPendingIndex = mixedLines.findIndex((line) => line.includes('未结清的约定'))
record(
  'C4',
  '【顺序】结清行**排在未结清行之前** ⇒ 额度紧时"不要再提"优先保住',
  firstClosedIndex >= 0 && firstPendingIndex >= 0 && firstClosedIndex < firstPendingIndex,
  `结清行 idx=${String(firstClosedIndex)} · 未结清 idx=${String(firstPendingIndex)}`
)

// ---------------------------------------------------------------------------
// C5 失败关闭
// ---------------------------------------------------------------------------
const zeroBlock = renderCommitmentStateBlock({ rows: [expired], maxTokens: 0, quantify })
const headerOnly = quantify(`${COMMITMENT_BLOCK_HEADER}\n`)
const tooTight = renderCommitmentStateBlock({ rows: [expired], maxTokens: headerOnly, quantify })
record(
  'C5',
  '【失败关闭】额度 0 ⇒ 0 个 section；额度连"块头 + 第一条行"都放不下 ⇒ **整块不渲染**（不印半条）',
  zeroBlock.length === 0 && tooTight.length === 0,
  `额度0=${String(zeroBlock.length)} · 额度只够块头=${String(tooTight.length)}`
)

// ---------------------------------------------------------------------------
// C6 程序渲染：正文不含内部 id / revision
// ---------------------------------------------------------------------------
const allText = [closedBlock, expiredBlock, pendingBlock, mixedBlock]
  .map((section) => section?.content ?? '')
  .join('\n')
record(
  'C6',
  '【程序渲染】正文里**没有**内部 id（`gol:`）与 revision（它们只进 `sourceRefs`）',
  !allText.includes('gol:') && !/revision/i.test(allText) && (mixedBlock?.sourceRefs?.length ?? 0) === 3,
  `正文含 gol:=${String(allText.includes('gol:'))} · refs=${String(mixedBlock?.sourceRefs?.length ?? 0)}`
)

// ---------------------------------------------------------------------------
// C7 确定性
// ---------------------------------------------------------------------------
const twice = renderCommitmentStateBlock({ rows: [pending, expired, fulfilled], maxTokens: 400, quantify })
record(
  'C7',
  '【确定性】同一输入两次 ⇒ 逐字段相同（纯函数、不读挂钟）',
  JSON.stringify([mixedBlock]) === JSON.stringify(twice),
  `两次相同=${String(JSON.stringify([mixedBlock]) === JSON.stringify(twice))}`
)

// ---------------------------------------------------------------------------
// C8 非零分母
// ---------------------------------------------------------------------------
const denominators = {
  closedCases: 1,
  expiredCases: 1,
  pendingCases: 1,
  accusationWords: ACCUSATION_WORDS.length,
  sectionsRendered: [closedBlock, expiredBlock, pendingBlock, mixedBlock].filter(Boolean).length,
}
record(
  'C8',
  '【非零分母】五类计数全部 > 0（`0 检查 / 0 不一致` 不算 PASS）',
  Object.values(denominators).every((value) => value > 0),
  JSON.stringify(denominators)
)

/*
 * ---------------------------------------------------------------------------
 * C9 ⭐ **注入接线**（静态锁）：光有渲染器与额度**不够**，必须有人真的调用它 ——
 *    否则就是 `L-M11-10` 的形状（契约齐、装配缺）重演。
 * ---------------------------------------------------------------------------
 */
const gatewaySrc = readSrc('src/kernel/app/turn-gateway.ts')
const mainSrc = readSrc('src/main.ts')
const gatewayRegisters = gatewaySrc.includes('createCommitmentStateProvider')
const gatewayGatesOnBudget = /commitmentTokens\s*>\s*0/.test(gatewaySrc)
const mainWiresPort = /commitmentFactRows:/.test(mainSrc)
record(
  'C9',
  '【⭐ 注入接线】网关**注册**了 provider 且**按额度门控**（`commitmentTokens > 0`）· 装配层**真的**传了只读端口（`main.ts` 含 `commitmentFactRows:`）',
  gatewayRegisters && gatewayGatesOnBudget && mainWiresPort,
  `网关注册=${String(gatewayRegisters)} · 按额度门控=${String(gatewayGatesOnBudget)} · 装配层传端口=${String(mainWiresPort)}`
)

const failed = checks.filter((check) => !check.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-wp4-context', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-context-verify@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  accusationWordList: ACCUSATION_WORDS,
  doNotRaiseWording: COMMITMENT_DO_NOT_RAISE,
  denominators,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer:
    '本门只证明**事实块的渲染语义**（已结清/已过期 ⇒ 不要再提；未结清照常；措辞不含指控；失败关闭）。' +
    '它**不**证明生产里已经注入 —— 注入需要额度接线（WP4b：`commitmentTokens` + 销账 `goalTokens`），' +
    '以及"结清后真的不再提"的**对照读数**（WP5 的 e2e）。',
}
writeFileSync(join(dir, 'context-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp4-context',
  head,
  headShort: head.slice(0, 12),
  branch: 'codex/m11-execution-plan',
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'context-verify',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['offline'],
  supersedes: null,
  notes: 'm10.1:context:verify（结清事实块：已结清/已过期 ⇒ 不要再提；到期措辞不含指控）',
})

console.log(`runId: ${runId}`)
console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
process.exit(failed.length === 0 ? 0 : 1)
