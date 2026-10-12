/**
 * 诊断：判分用的 rubric 到底长什么样、模型回了什么。
 *
 * 为什么需要它：live 档跑出来 PC 只有 0.10，而报告里只写"score 0.10"。
 * 那有两种可能，而**不能靠猜**：
 *
 *   · rubric 没被正确渲染（变量没替换 → judge 在给一段残句打分）
 *   · rubric 渲染正确，但模型（或 rubric 本身）有问题
 *
 * 这个脚本把**实际发给模型的完整 prompt** 与**模型的原始回复**一起打出来。
 * 排查评测问题时，第一步永远是"看它到底看到了什么" —— 与
 * `--dump-prompt` 对主链路的意义相同。
 *
 * 跑法：tsx scripts/diag-m3-judge.ts M3-VAL-001
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

import { M3_SUITES } from '../evals/m3/index.ts'
import { runM3 } from '../evals/m3/runtime/engine.ts'

isolateDatabase('diag-m3-judge')

const wanted = process.argv[2] ?? 'M3-VAL-001'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error('需要 OPENAI_API_KEY（.env 里配）—— judge 必须真的调模型。')
  process.exit(2)
}
const MODEL_ID = process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash'
const BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com'

const captured: string[] = []
const raws: string[] = []
/** 她自己的 prompt 与回复（用于核对"judge 到底在评什么"） */
const characterPrompts: string[] = []

/**
 * 角色自己的模型调用 —— **这个诊断脚本也必须注入它**。
 *
 * 第一版只注入了 judge 的口，于是宿主退回 echo 模式，
 * 她"说"的是合成串 `<m3-echo …>`，judge 诚实地给出 0.05 并说
 * "回答只有一段系统编译标记，没有任何实际内容"。
 *
 * 排查时看到的那个 0.05 是**诊断脚本自己的缺陷**造成的，
 * 而不是被测系统的问题 —— 这类"排查工具本身在骗人"的情况
 * 会让整个排查方向跑偏。因此两个口都必须注入。
 */
async function invokeCharacterModel(prompt: string): Promise<{ raw: string; durationMs: number }> {
  characterPrompts.push(prompt)
  const started = Date.now()
  const response = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 600,
    }),
  })
  if (!response.ok) {
    throw new Error(`角色模型调用失败 (HTTP ${response.status})`)
  }
  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  return { raw: payload.choices?.[0]?.message?.content ?? '', durationMs: Date.now() - started }
}

async function invokeModel(prompt: string): Promise<{ raw: string; durationMs: number }> {
  captured.push(prompt)
  const started = Date.now()
  const response = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: [
        {
          role: 'system',
          content:
            '你是一个严格的角色人格评测员。只输出 JSON，形如 {"score": 0.8, "reason": "…"}。' +
            'score 必须在 0 到 1 之间。不要输出任何其它内容。',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 400,
    }),
  })
  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  const raw = payload.choices?.[0]?.message?.content ?? ''
  raws.push(raw)
  return { raw, durationMs: Date.now() - started }
}

const { report } = await runM3({
  suites: M3_SUITES,
  live: true,
  // ⚠️ 两个口都要注入：judge 的口给她打分，**角色**的口让她真的说话。
  // 少了后者，judge 评的是引擎合成的 `<m3-echo …>` 串 ——
  // 那样这个诊断脚本本身就在骗人（见 invokeCharacterModel 的说明）。
  invokeModel,
  invokeCharacterModel,
  filter: wanted,
  modelProfile: MODEL_ID,
  thresholds: { hardZero: [], minimums: {} },
  // 从引擎那一侧拿 prompt（比在自己的 invokeModel 里记更可靠：
  // 它记的是**引擎真正交出去**的那一段，而不是我以为它交出去的）
  onJudgePrompt: (prompt) => {
    if (!captured.includes(prompt)) captured.push(prompt)
  },
})

console.log('='.repeat(78))
console.log(`judge 诊断：${wanted}`)
console.log('='.repeat(78))

for (const result of report.results) {
  console.log(`\n用例 ${result.caseId}（${result.suiteId}）passed=${result.passed}`)
  for (const entry of result.judged) {
    console.log(`  ${entry.id}  status=${entry.status}  score=${entry.score ?? '—'}`)
    console.log(`    detail: ${entry.detail ?? ''}`)
  }
  for (const entry of result.deterministic.filter((item) => !item.pass)) {
    console.log(`  ❌ [${entry.id}] ${entry.detail ?? ''}`)
  }
}

console.log('\n' + '='.repeat(78))
console.log(`实际发给 judge 的 prompt（${captured.length} 次调用）`)
console.log('='.repeat(78))
characterPrompts.forEach((prompt, index) => {
  console.log(`\n--- 她的 prompt #${index + 1}（${prompt.length} 字符）---`)
  console.log(prompt.slice(0, 1500))
})

console.log('\n' + '='.repeat(78))
console.log('实际发给 judge 的 prompt')
console.log('='.repeat(78))
captured.forEach((prompt, index) => {
  console.log(`\n--- 调用 #${index + 1}（${prompt.length} 字符）---`)
  console.log(prompt)
})

console.log('\n' + '='.repeat(78))
console.log('模型的原始回复')
console.log('='.repeat(78))
raws.forEach((raw, index) => {
  console.log(`\n--- 回复 #${index + 1} ---`)
  console.log(raw)
})

process.exit(0)
