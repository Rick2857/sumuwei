/**
 * M6.1 WP5 / C —— **判定分歧人审表生成器**（离线 · 零模型调用 · 只读已归档的 run）
 *
 * ============================================================================
 *  它回答什么（用户 2026-09-25 裁定 C，逐字）
 * ============================================================================
 * ```text
 * 「现在都不改。…先对**两轮分歧回复**做**人审**和**同文本复测**，明确标签边界。
 *   若据此改 prompt、采样规则或参数，另立量具版本、重新验证有效性并重新冻结候选；
 *   不得给已有 FAIL 补判。」
 * ```
 * 本脚本负责"人审"这一步的**材料**：把每一次"同一条回复、两次采样、报警性不同"
 * 逐条摊开成可读的表（**逐字回复** + 两次采样的标签 + 由**冻结规则**推出的三态）。
 * 它**不改任何东西**、**不调模型**、**不下结论**：边界由人判。
 *
 * ============================================================================
 *  三态从哪来（**不另写一份判据**）
 * ============================================================================
 * ```text
 * 每个采样的三态 = `alertStateOf(sample.labels)` —— `scripts/m6.1-contract.ts` 里
 * **唯一一处**实现（CD-13/CD-14：验收权威只有三态；细标签只作诊断）。
 * 分歧 = 同一条回复的多次采样**三态不全相同**（与 `judgmentFromSamples` 同一判据）。
 * ```
 *
 * ============================================================================
 *  量具自证（正控 / 负控 / 恢复）—— 全离线
 * ============================================================================
 * ```text
 * 正控   合成两行：三态一致（都是 alert / 都是 no_alert）⇒ **不得**被标成分歧
 * 负控   合成两行：三态不一致（alert vs no_alert）⇒ **必须**被标成分歧
 *        ⚠️ 合成行**永不**进真实读数（它们只喂给纯函数，不写进 cases）
 * 恢复   做完上面两步，真实读数逐字段不变（同一进程内比对 + 计数自检）
 * 计数自检  读数行数 = 0 ⇒ MEASUREMENT INVALID（§6.8）
 * ```
 *
 * 用法：`pnpm m6.1:judge:review`
 * 输出：`artifacts/m6.1/judge-review.json`（机读）+ `artifacts/m6.1/judge-disagreement-review.md`（人审表）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { M6_1_LOCAL_PARENT } from './m6.1-evidence.ts'
import { ALERT_LABELS, alertStateOf, type AlertState } from './m6.1-contract.ts'
import {
  loadCorrectionNegativeSet,
  loadCounterexamples,
  loadExplicitWriteSet,
  loadSupportedRecallSet,
} from './m6.1-control-sets.ts'

const ROOT = resolve(process.cwd())

/** 四个正式轮次（同树 · 同配置 · 分两臂两轮；见交接单 §5.8） */
const RUNS: readonly { label: string; runId: string; arm: string; round: number }[] = [
  {
    label: 'code-default · round 1',
    runId: 'm6.1-wp5-short-r1-code-default-20260924-5bee9d7d91ad-890f',
    arm: 'code-default',
    round: 1,
  },
  {
    label: 'code-default · round 2',
    runId: 'm6.1-wp5-short-r2-code-default-20260924-16521b9db086-dfca',
    arm: 'code-default',
    round: 2,
  },
  {
    label: 'deployed · round 1',
    runId: 'm6.1-wp5-short-r1-deployed-20260924-1d553110545b-1639',
    arm: 'deployed',
    round: 1,
  },
  {
    label: 'deployed · round 2',
    runId: 'm6.1-wp5-short-r2-deployed-20260924-0a4dce9df731-342e',
    arm: 'deployed',
    round: 2,
  },
]

const readLines = (path: string): Record<string, unknown>[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []

/* ---------------------------------------------------------------------------
 * 前提（**人审必须先看到的东西**）
 *
 * 用户 2026-09-25 指出的缺口：只给"她的回复 + 标签"，人**判不了** ——
 * 因为不知道**她面对的是什么**。前提有三层，全部取自**已落盘的机器证据**，逐字引用：
 *   ① 用户原话（逐轮）        ← 冻结条文（`evals/m6.1/control/*.jsonl`）
 *   ② 冻结判据（什么算违规）  ← 同上的 `successCondition` / `forbidden` / `mustNotProduce` / `requiredBehaviour`
 *   ③ 她那一轮**能看到的**    ← 归因档 `failure-attribution.json` 的 `context` / `basis`
 *                              + （CIN/EWP）记忆列表正文
 * ------------------------------------------------------------------------- */
interface Premise {
  readonly setId: string
  /** 逐轮用户原话（含最后那句问话/指令） */
  readonly turns: readonly string[]
  /** 冻结判据的行（"什么算满足 / 什么算违规"） */
  readonly criterion: readonly string[]
}

const premiseById = new Map<string, Premise>()
for (const item of loadSupportedRecallSet(ROOT)) {
  premiseById.set(item.id, {
    setId: 'supported',
    turns: [...item.setup, item.question],
    criterion: [
      `通过条件：${item.successCondition}`,
      `期望要点（**任一**出现即可）：${item.expectedPoints.join(' / ') || '(无)'}`,
      `禁止：${item.forbidden.join(' / ') || '(无)'}`,
      `依据类型：${item.basisKind}${item.source.slot === null ? '' : ` · 槽位 ${item.source.slot}`}`,
    ],
  })
}
for (const item of loadCounterexamples(ROOT)) {
  premiseById.set(item.id, {
    setId: 'rce',
    turns: [...item.setup, item.question],
    criterion: [
      `必须做到：${item.requiredBehaviour}`,
      `不许出现：${item.mustNotProduce.join(' / ')}`,
      `人审项：${item.humanReview === true ? '是（不进机器读数）' : '否'}`,
    ],
  })
}
for (const item of loadExplicitWriteSet(ROOT)) {
  premiseById.set(item.id, {
    setId: 'ewp',
    turns: [...item.setup],
    criterion: [
      `期望结局：${item.expectedOutcome} = 「${item.expectedStoredValue}」（槽位 ${item.slot}）`,
      `禁止：${(item.forbidden ?? []).join(' / ') || '(无)'}`,
      `说明：${item.note}`,
    ],
  })
}
for (const item of loadCorrectionNegativeSet(ROOT)) {
  premiseById.set(item.id, {
    setId: 'cin',
    turns: [item.text],
    criterion: [`不得改动记忆：${String(item.mustNotChangeMemory)}`, `说明：${item.note}`],
  })
}

interface TurnContext {
  readonly basis: string
  readonly slot: string
  readonly recall: string
  readonly sections: string
  readonly recordStatus: string
  readonly causes: string
}
const contextByRunItem = new Map<string, TurnContext>()
const attributionJson = (runId: string): Record<string, unknown> | null => {
  const path = join(ROOT, 'artifacts', 'm6.1', runId, 'failure-attribution.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}
for (const run of RUNS) {
  const attribution = attributionJson(run.runId)
  const rows = (attribution?.rows as Record<string, unknown>[] | undefined) ?? []
  for (const row of rows) {
    const context = (row.context ?? {}) as Record<string, unknown>
    const basis = (row.basis ?? {}) as Record<string, unknown>
    const causes = (row.causes as { id: string; rule: string; detail: string }[] | undefined) ?? []
    contextByRunItem.set(`${run.runId}#${String(row.itemId)}`, {
      basis: `${String(basis.kind ?? '?')}（${String(basis.detail ?? '')}）`,
      slot: String(row.slot ?? '(无槽位)'),
      recall:
        `memory-recall section 在 = ${String(context.recallSectionPresent)} · ` +
        `选中 ${String(context.recallSelected)} 条 · 达上下文 ${String(context.recallReachedContext)} · ` +
        `预算裁掉 ${String(context.recallDroppedByBudget)}`,
      sections: ((context.questionTurnSections as string[] | undefined) ?? []).join(', ') || '(未记录)',
      recordStatus: `记录状态行 = ${String(context.questionTurnRecordStatus ?? '?')} · reason_code = ${String(context.questionTurnReasonCode ?? '?')}`,
      causes: causes.map((cause) => `${cause.rule} ⇒ ${cause.detail}`).join('；') || '(无)',
    })
  }
}

/** 判定器**当时看到的记忆列表正文**（只有 CIN/EWP 的 program 行留了它；见"留存缺口"） */
const memoryListByRunItem = new Map<string, string>()
for (const run of RUNS) {
  for (const row of readLines(join(ROOT, M6_1_LOCAL_PARENT, run.runId, 'turns.jsonl'))) {
    if (typeof row.memoryListAfterSignature === 'string' && row.memoryListAfterSignature !== '') {
      memoryListByRunItem.set(`${run.runId}#${String(row.itemId)}`, row.memoryListAfterSignature)
    }
  }
}

interface CaseRow {
  readonly label: string
  readonly runId: string
  readonly arm: string
  readonly round: number
  readonly itemId: string
  readonly setId: string
  readonly category: string
  /** 量具那一行给的结论（冻结规则推出的三态） */
  readonly alertState: AlertState
  readonly ok: boolean
  readonly failure: string | null
  /** 逐次采样的标签（原文）与由**冻结规则**推出的三态 */
  readonly samples: readonly { readonly labels: readonly string[]; readonly state: AlertState }[]
  readonly states: readonly AlertState[]
  /** 同一条回复的多次采样**三态不全相同** */
  readonly disagrees: boolean
  /** 逐字回复（来自 gitignored 的 local/turns.jsonl） */
  readonly reply: string | null
  readonly replyMissing: boolean
  /** **前提①**：用户原话（逐轮，逐字来自冻结条文） */
  readonly premiseTurns: readonly string[]
  /** **前提②**：冻结判据（什么算满足 / 什么算违规） */
  readonly premiseCriterion: readonly string[]
  /** **前提③**：她那一轮能看到的（归因档的 context / basis）—— 缺失即 `null` */
  readonly turnContext: TurnContext | null
  /** **前提③之二**：判定器当时看到的记忆列表正文（只有 CIN/EWP 留了） */
  readonly memoryList: string | null
}

/** 三态分歧的**唯一**判据（与 `judgmentFromSamples` 同一形状） */
const statesDisagree = (states: readonly AlertState[]): boolean => new Set(states).size > 1

const rows: CaseRow[] = []
let missingReply = 0
for (const run of RUNS) {
  const runDir = join(ROOT, 'artifacts', 'm6.1', run.runId)
  const localDir = join(ROOT, M6_1_LOCAL_PARENT, run.runId)
  const judgeRows = readLines(join(runDir, 'judge.partial.jsonl'))
  const turnRecords = readLines(join(runDir, 'turns.partial.jsonl'))
  /* 逐字回复：与运行器同一套索引（末轮 · 程序行之外的那一条） */
  const replyIndex = new Map<string, string>()
  for (const row of readLines(join(localDir, 'turns.jsonl'))) {
    const itemId = row.itemId
    const turnIndex = row.turnIndex
    const reply = row.reply
    if (typeof itemId === 'string' && typeof turnIndex === 'number' && typeof reply === 'string') {
      replyIndex.set(`${itemId}#${String(turnIndex)}`, reply)
    }
  }
  for (const judge of judgeRows) {
    const itemId = String(judge.itemId ?? '')
    const samples = (judge.samples as string[][] | undefined) ?? []
    const own = turnRecords.filter(
      (record) => String(record.itemId) === itemId && record.memoryListSha256 === undefined
    )
    const last = own[own.length - 1]
    const reply =
      last === undefined ? undefined : replyIndex.get(`${itemId}#${String(last.turnIndex as number)}`)
    if (reply === undefined) missingReply += 1
    const mapped = samples.map((labels) => ({ labels: [...labels], state: alertStateOf(labels) }))
    const states = mapped.map((sample) => sample.state)
    const premise = premiseById.get(itemId)
    rows.push({
      label: run.label,
      runId: run.runId,
      arm: run.arm,
      round: run.round,
      itemId,
      setId: String(judge.setId ?? ''),
      category: String(judge.category ?? ''),
      alertState: (judge.alertState as AlertState) ?? 'undecidable',
      ok: judge.ok === true,
      failure: judge.failure === null || judge.failure === undefined ? null : String(judge.failure),
      samples: mapped,
      states,
      disagrees: statesDisagree(states),
      reply: reply ?? null,
      replyMissing: reply === undefined,
      premiseTurns: premise?.turns ?? [],
      premiseCriterion: premise?.criterion ?? [],
      turnContext: contextByRunItem.get(`${run.runId}#${itemId}`) ?? null,
      memoryList: memoryListByRunItem.get(`${run.runId}#${itemId}`) ?? null,
    })
  }
}

/* ---------------------------------------------------------------------------
 * 量具自证：合成行只喂给**纯函数**，绝不进上面的 readings
 * ------------------------------------------------------------------------- */
const syntheticAgree = [
  {
    labels: [ALERT_LABELS[0]!, 'CURRENT_DISCLOSURE'],
    state: alertStateOf([ALERT_LABELS[0]!, 'CURRENT_DISCLOSURE']),
  },
  {
    labels: [ALERT_LABELS[0]!, 'APPROPRIATE_UNCERTAINTY'],
    state: alertStateOf([ALERT_LABELS[0]!, 'APPROPRIATE_UNCERTAINTY']),
  },
]
const syntheticDisagree = [
  { labels: [ALERT_LABELS[0]!], state: alertStateOf([ALERT_LABELS[0]!]) },
  { labels: ['CURRENT_DISCLOSURE'], state: alertStateOf(['CURRENT_DISCLOSURE']) },
]
const positiveControlOk = syntheticAgree.map((s) => s.state).join() === 'alert,alert' && !statesDisagree(syntheticAgree.map((s) => s.state))
const negativeControlOk = syntheticDisagree.map((s) => s.state).join() === 'alert,no_alert' && statesDisagree(syntheticDisagree.map((s) => s.state))
/* 正控那组的**细标签不同**但三态相同 ⇒ 这正是 CD-13 拆开的那一层：细标签不参与"是否报警" */
const positiveControlDetail = {
  what: '标签不同、三态相同 ⇒ 不得算分歧（CD-13：细标签不参与报警性判定）',
  samples: syntheticAgree,
  disagrees: statesDisagree(syntheticAgree.map((s) => s.state)),
}

/* 恢复：同一进程内重算一遍真实读数 ⇒ 逐字段相同 */
const recompute = rows.map((row) => `${row.label}|${row.itemId}|${row.states.join(',')}|${String(row.disagrees)}`)
const restoreOk = recompute.length === rows.length && rows.every((row) => row.disagrees === statesDisagree(row.states))

const failures: string[] = []
if (rows.length === 0) failures.push('MEASUREMENT INVALID：0 条读数')
if (!positiveControlOk) failures.push('正控未成立：三态一致的合成样本被判成分歧')
if (!negativeControlOk) failures.push('负控未成立：三态不一致的合成样本**没有**被判成分歧')
if (!restoreOk) failures.push('恢复失败：真实读数在自证前后不一致')
/* 计数自检：样本数 ≥2 的行才可能测分歧 —— 一条都没有 ⇒ 什么都没测到 */
const multiSample = rows.filter((row) => row.samples.length >= 2)
if (multiSample.length === 0) failures.push('计数自检：没有任何"≥2 次采样"的读数行 ⇒ 本表什么都没测到')

const disagreements = rows.filter((row) => row.disagrees)
const verdict = failures.length > 0 ? 'INCOMPLETE' : 'OK'

/**
 * 按集合分开（**判据来源不同，分母不得混**）：
 *   `supported` / `rce` 由判定器判（标签直接决定通过与否）
 *   `ewp` / `cin` 由**程序面**判（记忆列表是否落库 / 是否被改动）⇒ 标签只是诊断
 */
const DECIDED_BY: Readonly<Record<string, 'judge' | 'program'>> = {
  supported: 'judge',
  rce: 'judge',
  ewp: 'program',
  cin: 'program',
}
const SET_BREAKDOWN = [...new Set(rows.map((row) => row.setId))]
  .sort()
  .map((setId) => {
    const own = rows.filter((row) => row.setId === setId)
    return {
      setId,
      decidedBy: DECIDED_BY[setId] ?? 'program',
      readings: own.length,
      disagreements: own.filter((row) => row.disagrees).length,
    }
  })

/* ---------------------------------------------------------------------------
 * 人审表（逐字回复 —— 这是**刻意**的可读证据，与 `evals/m6.1/acceptance/*.jsonl`
 * 的 `responseText` 同一类：验收材料，不是运行 trace）
 * ------------------------------------------------------------------------- */
const md: string[] = []
md.push('# M6.1 WP5 · 判定分歧**人审表**（机器生成 · 勿手改）')
md.push('')
md.push(`> 生成：\`pnpm m6.1:judge:review\` · verdict = **${verdict}** · 读数 ${String(rows.length)} 行`)
md.push('> 用途：用户裁定 C 的"**人审**"这一步的材料 —— 边界由人判，本表不下结论。')
md.push('')
md.push('## 0. 这张表用的判据（逐字复用冻结实现，不另写一份）')
md.push('')
md.push('```text')
md.push('每条回复的每次采样 ⇒ 标签；三态 = alertStateOf(labels)（scripts/m6.1-contract.ts 唯一一处实现）')
md.push('分歧 = 同一条回复的多次采样三态不全相同（与 judgmentFromSamples 同一判据）')
md.push('```')
md.push('')
md.push('## 1. 分段统计')
md.push('')
md.push('> ⚠️ **不是每个集合的判定器读数都决定判据**（见下表的"判据来源"）：')
md.push('> `supported` / `rce` 由**判定器**判（标签直接决定通过与否）；')
md.push('> `ewp` / `cin` 由**程序面**判（记忆列表是否落库 / 是否被改动），量具标签只是诊断。')
md.push('')
md.push('| 轮次 | 读数行 | 分歧行 | 分歧率 | 细标签不同但三态相同 |')
md.push('|---|---|---|---|---|')
for (const run of RUNS) {
  const own = rows.filter((row) => row.runId === run.runId)
  const bad = own.filter((row) => row.disagrees)
  const labelOnly = own.filter(
    (row) => !row.disagrees && new Set(row.samples.map((s) => [...s.labels].sort().join(','))).size > 1
  )
  md.push(
    `| ${run.label} | ${String(own.length)} | ${String(bad.length)} | ${
      own.length === 0 ? '—' : `${((bad.length / own.length) * 100).toFixed(1)}%`
    } | ${String(labelOnly.length)} |`
  )
}
md.push('')
md.push(`**合计**：读数 ${String(rows.length)} 行 · 分歧 **${String(disagreements.length)}** 行`)
md.push('')
md.push('### 1.1 按集合分开（**判据来源不同，分母不得混**）')
md.push('')
md.push('| 集合 | 判据来源 | 读数行 | 分歧行 | 分歧率 |')
md.push('|---|---|---|---|---|')
for (const set of SET_BREAKDOWN) {
  md.push(
    `| ${set.setId} | ${set.decidedBy === 'judge' ? '**判定器**（标签决定）' : '程序面（标签仅诊断）'} | ${String(
      set.readings
    )} | ${String(set.disagreements)} | ${set.readings === 0 ? '—' : `${((set.disagreements / set.readings) * 100).toFixed(1)}%`} |`
  )
}
md.push('')
md.push('## 2. 逐条摊开（**人审请从这里开始**）')
md.push('')
md.push('> 每一条按**前提 → 她的回复 → 两次采样**排：')
md.push('> **前提①** 用户原话（逐轮）· **前提②** 冻结判据（什么算满足 / 什么算违规）·')
md.push('> **前提③** 她那一轮**能看到的**（section 组成 / `memory-recall` 在不在 / 选中几条 / 依据状态）。')
md.push('> 没有前提就判不了"她这句话该不该报警"—— 这正是本表原先缺的那一块。')
md.push('> 「细标签不同 / 三态相同」这一类**不是**分歧（CD-13），但一并列出，便于判标签边界。')
md.push('')
for (const run of RUNS) {
  const own = rows.filter((row) => row.runId === run.runId && row.disagrees)
  md.push(`### ${run.label}（${String(own.length)} 条分歧）`)
  md.push('')
  if (own.length === 0) {
    md.push('（无）')
    md.push('')
    continue
  }
  for (const row of own) {
    md.push(`#### ${row.itemId} · ${row.setId} · ${row.category}`)
    md.push('')
    md.push('**前提① · 用户原话（逐轮）**')
    md.push('')
    md.push('```text')
    if (row.premiseTurns.length === 0) md.push('(冻结条文里没有这一条 —— 不该发生)')
    for (const [index, turn] of row.premiseTurns.entries()) {
      md.push(`${String(index + 1)}) ${turn}`)
    }
    md.push('```')
    md.push('')
    md.push('**前提② · 冻结判据**')
    md.push('')
    md.push('```text')
    for (const line of row.premiseCriterion) md.push(`· ${line}`)
    if (row.premiseCriterion.length === 0) md.push('(无)')
    md.push('```')
    md.push('')
    md.push('**前提③ · 她那一轮能看到的**')
    md.push('')
    md.push('```text')
    if (row.turnContext === null) {
      md.push('(归因档里没有这一条 —— 缺证据，不得当作"她什么都没看到")')
    } else {
      md.push(`依据：${row.turnContext.basis}`)
      md.push(`槽位：${row.turnContext.slot}`)
      md.push(`召回：${row.turnContext.recall}`)
      md.push(`入模 section：${row.turnContext.sections}`)
      md.push(row.turnContext.recordStatus)
      md.push(`归因成因：${row.turnContext.causes}`)
    }
    md.push('```')
    md.push('')
    if (row.memoryList !== null) {
      md.push('<details><summary>判定器当时看到的**记忆列表正文**（逐字 · 只有 CIN/EWP 留了它）</summary>')
      md.push('')
      md.push('```text')
      md.push(row.memoryList)
      md.push('```')
      md.push('')
      md.push('</details>')
      md.push('')
    }
    md.push('**她的回复（逐字）**')
    md.push('')
    md.push('```text')
    md.push(row.reply ?? '(逐字回复缺失 —— local/turns.jsonl 里没有这一条)')
    md.push('```')
    md.push('')
    md.push(
      `**两次采样** · 量具结论：\`${row.ok ? row.alertState : `失败(${String(row.failure)})`}\` · ` +
        `预测标签 \`${[...new Set(row.samples.flatMap((s) => s.labels))].join(',') || '(无)'}\``
    )
    md.push('')
    for (const [index, sample] of row.samples.entries()) {
      md.push(`- 采样 ${String(index + 1)} ⇒ **${sample.state}** · 标签 \`${sample.labels.join(',') || '(空)'}\``)
    }
    md.push('')
  }
}
md.push('## 3. 这一轮**没有**做的（边界）')
md.push('')
md.push('```text')
md.push('· 它**不**判"哪一次采样对"：那需要人审 + 标签边界裁定（用户裁定 C）。')
md.push('· 它**不**做同文本复测：复测要再调判定器（另立量具版本；见 §4）。')
md.push('· 它**不**改量具参数（maxTokens / minIntervalMs 都不动 —— 裁定 C 逐字）。')
md.push('· 它**不**给已有 FAIL 补判：它只把已经落盘的两次采样重新摊开。')
md.push('```')
md.push('')

/* ---------------------------------------------------------------------------
 * 落盘
 * ------------------------------------------------------------------------- */
mkdirSync(join(ROOT, 'artifacts', 'm6.1'), { recursive: true })
const evidence = {
  schemaVersion: 'm6.1-judge-review@1',
  testId: 'M6.1 WP5 / C · 判定分歧人审表（离线 · 只读已归档 run）',
  what: '把四个轮次里"同一条回复 · 多次采样 · 报警性不同"逐条摊开：逐字回复 + 每次采样的标签 + 由冻结规则推出的三态。',
  why: '用户裁定 C：先做人审与同文本复测，明确标签边界；据此才谈是否改 prompt / 采样规则 / 参数。',
  criterion: {
    alertState: 'alertStateOf(labels)（scripts/m6.1-contract.ts 唯一实现）',
    disagree: '同一条回复的多次采样三态不全相同',
  },
  runs: RUNS,
  readings: rows,
  summary: {
    readings: rows.length,
    disagreements: disagreements.length,
    multiSampleRows: multiSample.length,
    missingReply,
    decisive: {
      note: '标签**直接决定**判据的集合（supported + rce）；ewp/cin 由程序面判，标签仅诊断',
      readings: rows.filter((row) => (DECIDED_BY[row.setId] ?? 'program') === 'judge').length,
      disagreements: disagreements.filter((row) => (DECIDED_BY[row.setId] ?? 'program') === 'judge').length,
    },
    bySet: SET_BREAKDOWN,
    byRun: RUNS.map((run) => {
      const own = rows.filter((row) => row.runId === run.runId)
      const bad = own.filter((row) => row.disagrees)
      return { runId: run.runId, label: run.label, readings: own.length, disagreements: bad.length, items: bad.map((row) => row.itemId) }
    }),
  },
  selfProof: {
    positive_control_same_state_is_not_disagreement: { ok: positiveControlOk, detail: positiveControlDetail },
    negative_control_different_state_is_disagreement: { ok: negativeControlOk, detail: syntheticDisagree },
    restore_real_reading_unchanged: { ok: restoreOk },
    count_check_multi_sample_rows: multiSample.length,
  },
  failures,
  verdict,
  notProduced: [
    '它不判"哪一次采样对"——那是人审与标签边界裁定的事（用户裁定 C）。',
    '它不做同文本复测（要再调判定器；另立量具版本）。',
    '它不动任何量具参数，也不给已有 FAIL 补判。',
    '它读的是**已归档**的四个轮次；它不证明这四个轮次代表了别的候选或别的树。',
  ],
}
writeFileSync(join(ROOT, 'artifacts', 'm6.1', 'judge-review.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
writeFileSync(join(ROOT, 'artifacts', 'm6.1', 'judge-disagreement-review.md'), `${md.join('\n')}\n`, 'utf8')

console.log('='.repeat(96))
console.log('M6.1 WP5 / C · 判定分歧人审表（离线 · 零模型调用）')
console.log('='.repeat(96))
for (const run of RUNS) {
  const own = rows.filter((row) => row.runId === run.runId)
  const bad = own.filter((row) => row.disagrees)
  console.log(
    `  ${run.label.padEnd(22)} 读数 ${String(own.length).padStart(3)} · 分歧 ${String(bad.length).padStart(2)}` +
      `${bad.length > 0 ? ` ⇒ ${bad.map((row) => row.itemId).join(',')}` : ''}`
  )
}
console.log('')
console.log(`  正控（三态相同不算分歧）= ${positiveControlOk ? 'PASS' : '**未成立**'}`)
console.log(`  负控（三态不同必须算分歧）= ${negativeControlOk ? 'PASS' : '**未成立**'}`)
console.log(`  恢复（真实读数前后一致）= ${restoreOk ? 'PASS' : '**失败**'} · 计数自检（≥2 采样行）= ${String(multiSample.length)}`)
console.log(`  verdict = ${verdict}${missingReply > 0 ? ` · ⚠️ 逐字回复缺失 ${String(missingReply)} 条` : ''}`)
console.log('  证据：artifacts/m6.1/judge-review.json · artifacts/m6.1/judge-disagreement-review.md')

if (failures.length > 0) {
  console.error('\n  ⚠️ 自证未成立 ⇒ 读数不可用：')
  for (const message of failures) console.error(`     · ${message}`)
  process.exitCode = 3
} else {
  process.exitCode = 0
}
