/**
 * **假 fetch 验证：reasoning_effort 是否真的进入请求体**（零网络、零请求）。
 * 断言：low 变体 ⇒ body 含 `"reasoning_effort":"low"`；其余字段与不变项逐项一致；
 *      缺省（current）⇒ body **不含**该键（旧行为逐字不变）。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const materialPath = process.env.F2_CAL_MATERIAL ?? 'docs/architecture/f2-preregistration-20261025/output-calibration-low-2026-10-28.json'
const material = JSON.parse(readFileSync(materialPath, 'utf8')) as {
  id: string, digest: string
  inputs: { inputId: string, text: string }[]
  variant: { reasoningEffort: 'low' | 'medium' | 'high' }
  scale: { maxPhysicalRequests: number }
  unchanged: string[]
}
const { createOpenAiTaskPlanner } = await import('../../src/infrastructure/model/openai-task-planner.ts')
const { createCapabilityRegistry, createDefaultCapabilityDefinitions } = await import('../../src/kernel/action/capability-registry.ts')

const out = resolve('artifacts/local/f2-calibration-low-gate', `run-${Date.now()}`)
mkdirSync(out, { recursive: true })
const checks: string[] = []
const check = (name: string, value: unknown, detail = ''): void => {
  if (!value) throw new Error(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

process.env.OPENAI_API_KEY = 'gate-fake-key'
process.env.OPENAI_BASE_URL = 'https://api.minimax.cn/v1'
process.env.OPENAI_SMALL_MODEL = 'MiniMax-M3.1-Flash-Preview'
const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())

const capture = () => {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_input: unknown, init?: unknown) => {
    const body = JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? '{}')) as Record<string, unknown>
    bodies.push(body)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [] }) }, finish_reason: 'stop' }], usage: { total_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, bodies }
}

const input = { task: material.inputs[0]!.text, allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'], executed: [], failures: [] } as never

/* ① low 变体：请求体必须含 reasoning_effort=low，且其余不变项一致 */
{
  const { fetchImpl, bodies } = capture()
  const planner = createOpenAiTaskPlanner({ registry, candidateCount: 3, maxTokens: 8_000, fetchImpl, reasoningEffort: material.variant.reasoningEffort })
  await planner.plan(input)
  const body = bodies[0] ?? {}
  check('① 实际请求体含 `"reasoning_effort":"low"`', body.reasoning_effort === 'low', JSON.stringify(body.reasoning_effort))
  check('① 模型 ID / 上限 / 温度 / 输出契约不变',
    body.model === 'MiniMax-M3.1-Flash-Preview' && body.max_tokens === 8_000 && body.temperature === 0
    && JSON.stringify(body.response_format) === JSON.stringify({ type: 'json_object' })
    && body.stream === false,
    JSON.stringify({ model: body.model, max_tokens: body.max_tokens, temperature: body.temperature }))
  const messages = body.messages as { role: string, content: string }[]
  check('① 提示为 **current**（默认系统提示，未用 slim）且任务输入未改写',
    messages.length === 2 && messages[0]!.role === 'system'
    && messages[0]!.content.includes('只输出 JSON：{"candidates":[plan,...]}')
    && messages[1]!.content.includes(material.inputs[0]!.text.slice(0, 24)),
    messages[0]?.content.slice(0, 40))
}

/* ② 缺省（current）：请求体**不含** reasoning_effort（旧行为逐字不变） */
{
  const { fetchImpl, bodies } = capture()
  const planner = createOpenAiTaskPlanner({ registry, candidateCount: 3, maxTokens: 8_000, fetchImpl })
  await planner.plan(input)
  const body = bodies[0] ?? {}
  check('② 缺省调用：请求体**不含** `reasoning_effort`（旧行为逐字不变）',
    !('reasoning_effort' in body), JSON.stringify(Object.keys(body)))
}

/* ③ 规模上限与材料一致（3 次；不跑 slim） */
check('③ 冻结材料：最多 3 次请求、单一 low 变体、无 slim',
  material.scale.maxPhysicalRequests === 3 && material.variant.reasoningEffort === 'low'
  && !JSON.stringify(material).includes('"slim"'), JSON.stringify(material.scale))

writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
  status: 'PASS', schema: 'f2-calibration-low-gate@1', measuredAt: new Date().toISOString(), checks,
  material: { id: material.id, digest: material.digest },
  boundary: ['零网络：假 fetch 只捕获请求体，不发出任何请求', '只验证参数进入请求体；真实接受/拒绝需另行授权的 3 次真实请求'],
}, null, 2) + '\n', 'utf8')
console.log(`reasoning_effort 门：${String(checks.length)}/${String(checks.length)}；${out}`)
