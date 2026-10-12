/**
 * M8.5 指令迭代探针（Corpus-Spec §1/§8：gate 开发集用于指令迭代；blind 永不进迭代）
 *
 * 用途：指令修订（如 @1→@2）后的**格式合规**验证——从 gate 层按类目抽样，
 * 真模型直连评估，断言解析零失败（格式面 100% 合规）。语义面只出信息性
 * 读数（gate 金标是开发集，不设阈值——阈值在 blind 层）。
 *
 * `pnpm with-test-model pnpm m8.5:instruction:probe`
 */
import 'dotenv/config'

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  buildSemanticOutbound,
  evaluateSemanticResponse,
} from '../src/kernel/app/affect/semantic-evaluator.ts'
import { createOpenAiAffectSemanticProvider } from '../src/infrastructure/model/affect-semantic-provider.ts'
import { AFFECT_SEMANTIC_INSTRUCTION_VERSION } from '../src/kernel/app/affect/semantic-instruction.ts'

if ((process.env.OPENAI_API_KEY ?? '').trim() === '') {
  console.error('OPENAI_API_KEY 缺失：探针需要测试端点（pnpm with-test-model pnpm m8.5:instruction:probe）')
  process.exit(2)
}

interface CorpusEntry {
  id: string
  category: string
  tags?: string[]
  context?: Array<{ role: string; text: string }>
  message: string
  gold: { decision: string; family?: string }
  status?: string
}

const CORPUS_ROOT = join(process.cwd(), 'evals', 'm8.5', 'corpus')
const gateFiles = readdirSync(join(CORPUS_ROOT, 'gate'), { withFileTypes: true })
  .filter((d) => d.name.endsWith('.jsonl'))
  .map((d) => d.name)
  .sort()
const gate: CorpusEntry[] = gateFiles.flatMap((name) =>
  readFileSync(join(CORPUS_ROOT, 'gate', name), 'utf8')
    .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as CorpusEntry),
)
const scored = gate.filter((e) => e.status !== 'pending-ruling')
if (scored.length === 0) {
  console.error('measured_count 自检失败：gate 计分条目为 0')
  process.exit(2)
}

// 按类目均衡抽样：每类目 ≤3 条（操纵/混合类目多抽——它们是格式+免疫的高危面）；
// `--full` = 全量计分 gate（指令**语义校准**迭代的全套开发集读数：弃权率/类目吻合表）；
// `--category=<name>` = 只跑一个类目（校准迭代的定点诊断面）
const FULL = process.argv.includes('--full')
const CATEGORY_ARG = process.argv.find((a) => a.startsWith('--category='))
const CATEGORY = CATEGORY_ARG === undefined ? undefined : CATEGORY_ARG.slice('--category='.length)
const PER_CATEGORY = 3
const sample: CorpusEntry[] = FULL
  ? scored
  : CATEGORY !== undefined
    ? scored.filter((e) => e.category === CATEGORY)
    : (() => {
        const byCategory = new Map<string, CorpusEntry[]>()
        for (const entry of scored) {
          const list = byCategory.get(entry.category) ?? []
          if (list.length < PER_CATEGORY) list.push(entry)
          byCategory.set(entry.category, list)
        }
        return [...byCategory.values()].flat()
      })()
console.log(`指令探针（${AFFECT_SEMANTIC_INSTRUCTION_VERSION}${FULL ? ' · 全量开发集' : ''}${CATEGORY !== undefined ? ` · 类目=${CATEGORY}` : ''}）：gate ${FULL ? '计分全量' : '抽样'} ${String(sample.length)} 条`)

const provider = createOpenAiAffectSemanticProvider()
let parseFailures = 0
let decisionMatch = 0
const failureSamples: string[] = []
const mismatches: string[] = []
/** 开发集校准读数：NEUTRAL 金标的弃权构成 + 类目吻合表（--full 时报告） */
const neutralGold = sample.filter((e) => e.gold.decision === 'NEUTRAL')
const abstained: Array<{ id: string; decision: string }> = []
const categoryTally = new Map<string, { total: number; match: number }>()

for (const entry of sample) {
  const tally = categoryTally.get(entry.category) ?? { total: 0, match: 0 }
  tally.total += 1
  categoryTally.set(entry.category, tally)
  const context = entry.context === undefined
    ? []
    : [...entry.context].reverse().slice(0, 6).map((c, index) => ({
      role: (c.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
      text: c.text,
      alias: `m-${String(index + 1)}`,
    })) as never
  const request = { characterAlias: '苏沐薇', context, currentMessage: entry.message }
  const outbound = buildSemanticOutbound(request)
  if (!outbound.ok) {
    parseFailures += 1
    failureSamples.push(`${entry.id}: input_budget_exceeded`)
    continue
  }
  const outcome = await provider.call({ outboundText: outbound.outbound.text })
  if (!outcome.ok) {
    parseFailures += 1
    failureSamples.push(`${entry.id}: transport ${outcome.failure}`)
    continue
  }
  const evaluated = evaluateSemanticResponse(outcome.envelope, request)
  if (evaluated.kind !== 'judgment') {
    parseFailures += 1
    if (failureSamples.length < 8) {
      failureSamples.push(`${entry.id}: ${evaluated.failure} ← ${JSON.stringify(typeof outcome.envelope.content === 'string' ? outcome.envelope.content.slice(0, 160) : outcome.envelope.content)}`)
    }
    continue
  }
  const decision = evaluated.judgment.decision
  if (decision === entry.gold.decision) {
    decisionMatch += 1
    tally.match += 1
  } else if (FULL || CATEGORY !== undefined) {
    mismatches.push(`${entry.id} [${entry.category}] gold=${entry.gold.decision}${entry.gold.family ? '/' + entry.gold.family : ''} → pred=${decision}${evaluated.judgment.decision === 'IMPACT' ? '/' + String(evaluated.mapping.dominantFamily) : ''}`)
  }
  if (entry.gold.decision === 'NEUTRAL' && (decision === 'UNCERTAIN' || decision === 'OUT_OF_SCOPE')) {
    abstained.push({ id: entry.id, decision })
  }
}

const compliance = 1 - parseFailures / sample.length
console.log('========================================================================')
console.log(`指令探针：格式合规 ${compliance.toFixed(4)}（${String(sample.length - parseFailures)}/${String(sample.length)}；判据 = 1.00）`)
console.log(`  信息性读数（开发集，无阈值）：判定吻合 ${String(decisionMatch)}/${String(sample.length)}`)
if (neutralGold.length > 0) {
  console.log(`  弃权构成（NEUTRAL 金标 ${String(neutralGold.length)} 条 → UNCERTAIN/OOS）：${String(abstained.length)} 条`)
  for (const a of abstained) console.log(`    ${a.id} → ${a.decision}`)
}
if (mismatches.length > 0) {
  console.log(`  未吻合逐条（gold → pred）：`)
  for (const s of mismatches) console.log(`    ${s}`)
}
if (FULL) {
  console.log('  类目吻合表（开发集校准地图）：')
  for (const [category, t] of [...categoryTally.entries()].sort()) {
    console.log(`    ${category}: ${String(t.match)}/${String(t.total)}`)
  }
}
if (failureSamples.length > 0) {
  console.log('  失败样本：')
  for (const s of failureSamples) console.log(`    ${s}`)
}
console.log('========================================================================')
if (parseFailures > 0) process.exit(1)
