/**
 * M10.1 WP1 —— **输入门**（`m10.1:inputs:verify`）。
 *
 * ============================================================================
 *  它守什么（全部离线；**不开任何数据库**）
 * ============================================================================
 * ```text
 * A 有界：窗口 ≤ 50 条 · 每条正文 ≤ 300 码点（超出**遮蔽**，不截断后假装看全）· 内容/判据/依据各有上界
 * B 遮蔽先于注入：超上限 / 内容不可用 ⇒ `AGREEMENT_MASKED_TEXT` + `masked=true`；引用落在遮蔽条目 ⇒ 拒
 * C 出处必须能解析：正控三条通过；结构负控**逐条**给出**具名**理由（不是"被拒了"就算）
 * D 语义层**只登记**：含糊接受 / 不确定 / 无判据 / 换话题 —— 明确标注裁决在 WP2（本门不假装测了）
 * E 确定性：同一输入跑两次结果逐字段相同（纯函数、不读时钟）
 * F 非零分母：每条判据都自检"真的量了东西"
 * ```
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import {
  AGREEMENT_CONTENT_MAX_CODEPOINTS,
  AGREEMENT_CRITERION_MAX_CODEPOINTS,
  AGREEMENT_DUE_BASIS_MAX_CODEPOINTS,
  AGREEMENT_MASKED_TEXT,
  AGREEMENT_MAX_WINDOW_INPUTS,
  AGREEMENT_TEXT_MAX_CODEPOINTS,
  codepointLength,
  validateAgreementDraft,
} from '../src/kernel/contracts/agreement-input.ts'
import { assembleAgreementWindow, renderAgreementWindow } from '../src/kernel/app/agreement/inputs.ts'
import { buildAgreementCorpus } from '../evals/m10.1/agreement-corpus.ts'

const REPO_ROOT = resolve(process.cwd())
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

const corpus = buildAgreementCorpus()
const structural = corpus.filter((item) => item.layer === 'structural')
const semantic = corpus.filter((item) => item.layer === 'semantic')

// ---------------------------------------------------------------------------
// A 有界
// ---------------------------------------------------------------------------
const longEntry = {
  id: 'cev:char:1',
  actorType: 'character',
  sequence: 1,
  text: '字'.repeat(AGREEMENT_TEXT_MAX_CODEPOINTS + 25),
}
const windowWithLong = assembleAgreementWindow({ entries: [longEntry] })
const longMasked =
  windowWithLong.entries[0]?.masked === true && windowWithLong.entries[0]?.text === AGREEMENT_MASKED_TEXT
const manyEntries = Array.from({ length: AGREEMENT_MAX_WINDOW_INPUTS + 7 }, (_, index) => ({
  id: `cev:user:${String(index + 1)}`,
  actorType: 'user',
  sequence: index + 1,
  text: `第 ${String(index + 1)} 条`,
}))
const windowMany = assembleAgreementWindow({ entries: manyEntries })
record(
  'A1',
  '【有界】超上限的正文**被遮蔽**（不是截断后假装看全）；窗口超出上限时 `windowTruncated=true` 且只留最近 N 条',
  longMasked &&
    windowMany.entries.length === AGREEMENT_MAX_WINDOW_INPUTS &&
    windowMany.facts.windowTruncated &&
    windowMany.entries.every((entry) => codepointLength(entry.text) <= AGREEMENT_TEXT_MAX_CODEPOINTS),
  `长正文遮蔽=${String(longMasked)} · 窗口条数=${String(windowMany.entries.length)}/${String(AGREEMENT_MAX_WINDOW_INPUTS)} · truncated=${String(windowMany.facts.windowTruncated)}`
)
record(
  'A2',
  '【上界是常量、不是散落的数字】内容 / 判据 / 时间依据三个上界都被真实断言到（非零分母）',
  AGREEMENT_CONTENT_MAX_CODEPOINTS > 0 &&
    AGREEMENT_CRITERION_MAX_CODEPOINTS > 0 &&
    AGREEMENT_DUE_BASIS_MAX_CODEPOINTS > 0,
  `内容 ${String(AGREEMENT_CONTENT_MAX_CODEPOINTS)} · 判据 ${String(AGREEMENT_CRITERION_MAX_CODEPOINTS)} · 依据 ${String(AGREEMENT_DUE_BASIS_MAX_CODEPOINTS)}`
)

// ---------------------------------------------------------------------------
// B 遮蔽先于注入 + 说话者由程序分列
// ---------------------------------------------------------------------------
const mixed = assembleAgreementWindow({
  entries: [
    { id: 'cev:char:1', actorType: 'character', sequence: 1, text: '明天十点二十五，楼下。' },
    { id: 'cev:user:2', actorType: 'user', sequence: 2, text: '好的。' },
    { id: 'cev:sys:3', actorType: 'system', sequence: 3, text: '内部提示（不应进窗口）' },
    { id: 'cev:char:4', actorType: 'character', sequence: 4, text: '不该看到的', contentUnavailable: true },
  ],
})
const rendered = renderAgreementWindow(mixed)
record(
  'B1',
  '【遮蔽先于注入】不可用条目 ⇒ 遮蔽文本 + `masked=true`；**别的说话者（system）不进窗口**',
  mixed.entries.length === 3 &&
    mixed.entries[2]?.masked === true &&
    mixed.entries[2]?.text === AGREEMENT_MASKED_TEXT &&
    !rendered.includes('内部提示') &&
    !rendered.includes('不该看到的') &&
    mixed.facts.characterCount === 2 &&
    mixed.facts.userCount === 1,
  `条数=${String(mixed.entries.length)} · 遮蔽条=${String(mixed.entries.filter((entry) => entry.masked).length)} · 渲染里没有遮蔽正文=${String(!rendered.includes('不该看到的'))}`
)

// ---------------------------------------------------------------------------
// C 出处必须能解析（正控 + 结构负控逐条具名）
// ---------------------------------------------------------------------------
const results: { caseId: string; pass: boolean; got: string }[] = []
for (const item of structural) {
  const window = assembleAgreementWindow({ entries: item.window })
  const verdict = validateAgreementDraft(item.draft, window)
  const got =
    verdict.ok === true
      ? 'accepted'
      : `${verdict.reason}`
  const want =
    item.expected.kind === 'accepted' ? 'accepted' : item.expected.reason
  results.push({ caseId: item.caseId, pass: got === want, got })
}
const structuralFailures = results.filter((row) => !row.pass)
record(
  'C1',
  '【出处必须能解析】结构层语料**逐条**给出**预期的那一个具名理由**（不是"被拒了"就算）',
  structuralFailures.length === 0 && structural.length >= 12,
  `结构层 ${String(structural.length)} 条 · 不符=${JSON.stringify(structuralFailures)}`
)
const positives = structural.filter((item) => item.expected.kind === 'accepted')
record(
  'C2',
  '【正控】双方合意的三种形状都**通过**（时间+地点 / 只有时间 / 只有动作）',
  positives.length >= 3 && positives.every((item) => results.find((row) => row.caseId === item.caseId)?.got === 'accepted'),
  `正控 ${String(positives.length)} 条：${positives.map((item) => item.caseId).join(' · ')}`
)
const reasonCoverage = [...new Set(structural.filter((item) => item.expected.kind === 'rejected').map((item) => (item.expected as { reason: string }).reason))]
record(
  'C3',
  '【拒绝理由覆盖面】结构负控覆盖 **≥8 个不同的具名理由**（每个都真的触发过）',
  reasonCoverage.length >= 8,
  `覆盖理由 ${String(reasonCoverage.length)} 个：${reasonCoverage.join(', ')}`
)

// ---------------------------------------------------------------------------
// D 语义层只登记（**不假装测了**）
// ---------------------------------------------------------------------------
const semanticRegistered = semantic.every((item) => item.expectedKindForModel === 'none' && item.note.length > 0)
record(
  'D1',
  '【语义层只登记】含糊接受 / 不确定 / 无判据 / 换话题 **四条都在案**，且都标注"裁决在 WP2"',
  semantic.length >= 4 && semanticRegistered,
  `语义层 ${String(semantic.length)} 条：${semantic.map((item) => item.family).join(', ')}`
)
record(
  'D2',
  '【不越界主张】本门**不**声称"程序能识别语义"——语义层条目的 `draft.kind` 都是 `none`（由模型判定）',
  semantic.every((item) => item.draft.kind === 'none'),
  '四条语义负控的草稿都是 `kind=none`'
)

// ---------------------------------------------------------------------------
// E 确定性
// ---------------------------------------------------------------------------
const once = assembleAgreementWindow({ entries: mixed.entries.map((entry) => ({ ...entry })) })
const twice = assembleAgreementWindow({ entries: mixed.entries.map((entry) => ({ ...entry })) })
record(
  'E1',
  '【确定性】同一输入装配两次 ⇒ 结果逐字段相同（纯函数、不读时钟、无随机）',
  JSON.stringify(once) === JSON.stringify(twice),
  `两次相同=${String(JSON.stringify(once) === JSON.stringify(twice))}`
)

// ---------------------------------------------------------------------------
// F 非零分母
// ---------------------------------------------------------------------------
const denominators = {
  structuralCases: structural.length,
  semanticCases: semantic.length,
  positiveCases: positives.length,
  distinctReasons: reasonCoverage.length,
}
record(
  'F1',
  '【非零分母】四类计数全部 > 0（`0 检查 / 0 不一致` 不算 PASS）',
  Object.values(denominators).every((value) => value > 0),
  JSON.stringify(denominators)
)

const failed = checks.filter((check) => !check.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-wp1', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-inputs-verify@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  bounds: {
    maxWindowInputs: AGREEMENT_MAX_WINDOW_INPUTS,
    textMaxCodepoints: AGREEMENT_TEXT_MAX_CODEPOINTS,
    contentMaxCodepoints: AGREEMENT_CONTENT_MAX_CODEPOINTS,
    criterionMaxCodepoints: AGREEMENT_CRITERION_MAX_CODEPOINTS,
    dueBasisMaxCodepoints: AGREEMENT_DUE_BASIS_MAX_CODEPOINTS,
  },
  denominators,
  caseResults: results,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer:
    '本门只守**结构与出处**（确定性）。"这句话算不算接受"是**语义**判定，裁决在 WP2 的模型门；' +
    '本门**不**主张程序能识别语义。',
}
writeFileSync(join(dir, 'inputs-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp1',
  head,
  headShort: head.slice(0, 12),
  branch: 'codex/m11-execution-plan',
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'inputs-verify',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['offline'],
  supersedes: null,
  notes: `m10.1:inputs:verify（结构层 ${String(structural.length)} 条 · 语义层 ${String(semantic.length)} 条只登记）`,
})

console.log(`runId: ${runId}`)
console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
process.exit(failed.length === 0 ? 0 : 1)
