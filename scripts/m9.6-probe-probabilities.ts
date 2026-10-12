/**
 * M9.6 WP1/§12 待定项 —— **官方 `probabilities` 归一精度的实测探针**
 * （`pnpm m9.6:probe:probability`）。
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 * ```text
 * 官方文档说 Choice/Score 的 `probabilities` "和为 1"。我方严格归一化按 1e-4 容差校验，
 * 于是 WP4 试点里**间歇**出现 `probabilities_not_normalized`（约 1/4 的调用）。
 *
 * ⚠️ 容差该定多少**不能靠猜**（那是"猜填"）：必须**量**出实际的偏差分布，
 *    再据此定一个有依据的容差，同时**继续拒绝**实质性不归一（例如和 0.8）。
 *    本探针只做这件事：发 N 次同样的 Choice 调用，记录每次的**概率和**。
 * ```
 *
 * ⚠️ 真实出站（默认 12 次）。只发我们自己写的合成文本与选项，不含任何真实内容。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  JEV_MODEL_VAR,
  JEV_TEST_KEY_VAR,
  PROBABILITY_SUM_TOLERANCE,
  callSystemOne,
  redactSecrets,
  type JevQuestions,
} from './m9.6-jev-protocol.ts'

const ROOT = resolve('.')

function readTestEnvFile(path: string): Record<string, string> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    console.error(`REFUSED：找不到 ${path}`)
    process.exit(2)
  }
  const vars: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const equals = trimmed.indexOf('=')
    if (equals <= 0) continue
    let value = trimmed.slice(equals + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    vars[trimmed.slice(0, equals).trim()] = value
  }
  return vars
}

const env = readTestEnvFile(join(ROOT, '.env.test'))
const apiKey = (env[JEV_TEST_KEY_VAR] ?? '').trim()
const model = (env[JEV_MODEL_VAR] ?? '').trim()
if (apiKey === '' || model === '') {
  console.error(`REFUSED：${JEV_TEST_KEY_VAR} / ${JEV_MODEL_VAR} 未配置`)
  process.exit(2)
}
const SECRETS = [apiKey]

const iterationsArg = process.argv.indexOf('--iterations')
const ITERATIONS = iterationsArg >= 0 ? Number(process.argv[iterationsArg + 1]) : 12

/** 两类问题各测：**13 选项**（长分布，舍入误差最大）与 **4 选项**（短分布） */
const MANY: JevQuestions = {
  reason: {
    type: 'choice',
    instructions: '给出结论的最贴近理由。',
    criteria: {
      time_sensitive_fact: '时效性事实',
      latest_news: '最新消息',
      explicit_public_sourcing: '用户要求查公开资料',
      stable_knowledge: '稳定常识',
      chitchat_or_creative: '闲聊或创作',
      private_object: '私人对象',
      negated_or_forbidden: '禁止联网',
      quoted_or_metalinguistic: '引用或讨论字句本身',
      self_reported: '用户自述',
      missing_subject: '没有可检索对象',
      ambiguous_scope: '范围不清',
      local_action_preferred: '更适合本地动作',
      adversarial_input: '对抗输入',
    },
  },
}
const FEW: JevQuestions = {
  decision: {
    type: 'choice',
    instructions: '这条发言是否需要联网查证？',
    criteria: { search: '需要查', answer: '不需要查', clarify: '对象不明', deny_search: '明确禁止联网' },
  },
}

const STATE = '帮我查一下明天北京的天气'

interface Sample {
  readonly kind: string
  readonly ok: boolean
  readonly code: string | null
  readonly sum: number | null
  readonly deviation: number | null
  readonly confidencePresent: boolean
}

const samples: Sample[] = []

async function one(kind: string, questions: JevQuestions): Promise<void> {
  const result = await callSystemOne({ state: STATE, questions }, { config: { ok: true, apiKey, model } })
  if (result.ok) {
    const answer = Object.values(result.answers)[0]
    const probabilities = answer !== undefined && 'probabilities' in answer ? answer.probabilities : null
    const sum = probabilities === null ? null : Object.values(probabilities).reduce((total, value) => total + value, 0)
    const confidencePresent = answer !== undefined && 'confidence' in answer && answer.confidence !== null
    samples.push({
      kind,
      ok: true,
      code: null,
      sum,
      deviation: sum === null ? null : Math.abs(sum - 1),
      confidencePresent,
    })
    return
  }
  samples.push({
    kind,
    ok: false,
    code: result.code,
    sum: result.observed,
    deviation: result.observed === null ? null : Math.abs(result.observed - 1),
    confidencePresent: false,
  })
}

console.log(`M9.6 概率归一精度探针 · ${String(ITERATIONS)} × 2 类问题 = 最多 ${String(ITERATIONS * 2)} 次真实调用`)
console.log(`  当前容差 ${String(PROBABILITY_SUM_TOLERANCE)} · 模型 ${model}\n`)

for (let index = 0; index < ITERATIONS; index += 1) {
  await one('choice-13-options', MANY)
  await one('choice-4-options', FEW)
  const last = samples[samples.length - 1]
  process.stdout.write(
    `  ${String(index + 1).padStart(2)}/${String(ITERATIONS)} 13选项 sum=${samples[samples.length - 2]?.sum?.toFixed(6) ?? '-'} · 4选项 sum=${last?.sum?.toFixed(6) ?? '-'}\n`
  )
}

const deviations = samples.map((sample) => sample.deviation).filter((value): value is number => value !== null)
deviations.sort((a, b) => a - b)
const maxDeviation = deviations.length === 0 ? null : (deviations[deviations.length - 1] as number)
const exactOnes = deviations.filter((value) => value === 0).length
const failures = samples.filter((sample) => !sample.ok)

const proposedTolerance = maxDeviation === null ? null : Math.max(PROBABILITY_SUM_TOLERANCE, maxDeviation * 2)

const evidence = {
  testId: 'M9.6 / probability normalization precision probe',
  note:
    '真实出站到官方端点，只发合成文本与自写选项；证据不含 Key、不含真实内容。' +
    '目的：把"容差该定多少"从猜改成读数。',
  requestedModel: model,
  iterations: ITERATIONS,
  calls: samples.length,
  currentTolerance: PROBABILITY_SUM_TOLERANCE,
  samples,
  deviationStats: {
    count: deviations.length,
    exactSumEqualsOne: exactOnes,
    min: deviations.length === 0 ? null : (deviations[0] as number),
    median: deviations.length === 0 ? null : (deviations[Math.floor(deviations.length / 2)] as number),
    max: maxDeviation,
  },
  failuresByCode: Object.fromEntries(
    [...new Map(failures.map((sample) => [String(sample.code), 0])).keys()].map((code) => [
      code,
      failures.filter((sample) => sample.code === code).length,
    ])
  ),
  proposedTolerance,
  proposedToleranceBasis: 'max 实测偏差 × 2，且不低于现容差 —— 只放宽到"能容纳舍入"的程度',
  mustStillReject: '实质性不归一（例如和 0.8 / 概率越界 / 未声明的键）仍必须判 invalid_output',
}

mkdirSync(join(ROOT, 'artifacts', 'm9.6'), { recursive: true })
const text = `${JSON.stringify(evidence, null, 2)}\n`
if (SECRETS.some((secret) => text.includes(secret))) {
  console.error('REFUSED：证据里出现秘密 ⇒ 拒写')
  process.exit(3)
}
writeFileSync(join(ROOT, 'artifacts', 'm9.6', 'probability-precision.json'), text, 'utf8')

console.log(`\n  偏差统计：n=${String(deviations.length)} · 精确为 1 的 ${String(exactOnes)} 条 · min ${deviations[0]?.toExponential(3) ?? '-'} · median ${deviations.length === 0 ? '-' : (deviations[Math.floor(deviations.length / 2)] as number).toExponential(3)} · max ${maxDeviation?.toExponential(3) ?? '-'}`)
console.log(`  失败：${failures.length === 0 ? '无' : failures.map((sample) => `${String(sample.code)}×1`).join(' ')}`)
console.log(`  建议容差：${proposedTolerance === null ? 'NOT RUN' : proposedTolerance.toExponential(3)}（依据：实测 max 偏差 ×2）`)
console.log('  证据：artifacts/m9.6/probability-precision.json')
console.log(`  ⚠️ 改动容差必须同步改 ${redactSecrets('PROBABILITY_SUM_TOLERANCE', SECRETS)} 的值与离线负控，且**不得**放过实质性不归一。`)
