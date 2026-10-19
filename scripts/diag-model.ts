/**
 * 诊断：抓出 TEXT_LARGE 调用 "Not Found" 的真实来源。
 */
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

// ⚠️ 实验必须隔离：本脚本会 initDatabase（建库建表），因此需要独立副本。
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('diag-model')

import { ModelType } from '../src/infrastructure/runtime/eliza-vocabulary.ts'



import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'

const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
await initDatabase(runtime)
await runtime.initialize()

for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_LARGE_MODEL']) {
  const v = runtime.getSetting(k)
  const shown = k.includes('KEY') && typeof v === 'string' ? `${v.slice(0, 8)}...(${v.length})` : v
  console.log(`  getSetting(${k}) = ${String(shown)}  | process.env = ${String(k.includes('KEY') ? '***' : process.env[k])}`)
}

const baseURL = String(runtime.getSetting('OPENAI_BASE_URL') ?? '')
const apiKey = String(runtime.getSetting('OPENAI_API_KEY') ?? '')
const modelName = String(runtime.getSetting('OPENAI_LARGE_MODEL') ?? '')

console.log('\n--- A. 经 runtime.useModel(TEXT_LARGE) ---')
try {
  const out = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: '回复两个字：通了' })
  console.log('成功: ' + JSON.stringify(out))
} catch (e) {
  const err = e as Record<string, unknown>
  console.log('失败: ' + (err?.constructor as { name?: string })?.name)
  for (const k of ['message', 'statusCode', 'url', 'responseBody', 'cause', 'lastError']) {
    if (k in err) console.log(`  ${k} = ${String(err[k]).slice(0, 400)}`)
  }
  console.log('  完整键: ' + Object.keys(err).join(', '))
  if ((err as { stack?: string }).stack) console.log('  stack: ' + (err as { stack: string }).stack.split('\n').slice(0, 6).join('\n         '))
}

console.log('\n--- B. 对照：原生 fetch ---')
const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: '回复两个字：通了' }], max_tokens: 32 }),
})
console.log(`fetch status=${res.status} body=${(await res.text()).slice(0, 200)}`)

await runtime.stop()
process.exit(0)
