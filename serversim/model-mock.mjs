// ============================================================================
//  服务器仿真环境 · 假模型端点（2026-10-20）
// ============================================================================
//
//  它扮演的角色：**服务器机房的外部 API**（api.deepseek.com / 测试端点）。
//  仿真里没有真实出站，于是给它一个本地的 OpenAI 兼容端点。
//
//  ---------------------------------------------------------------------------
//  为什么必须有它
//  ---------------------------------------------------------------------------
//  · 核心启动前会**真的发一次** `/chat/completions` 探连通性
//    （src/main.ts:1005-1022）⇒ 没有这个端点，核心**根本起不来**。
//  · 让 agent 测试时**不烧真钱**、**不依赖外网**、**结果可复现**。
//
//  ---------------------------------------------------------------------------
//  ⚠️ 它**不**能证明的事
//  ---------------------------------------------------------------------------
//  · 不证明真实模型的**能力**（措辞质量、语义理解、抽取质量一律测不到）。
//  · 不证明真实端点的**延迟与限流**（这里恒定 < 1 ms）。
//  · 所有回复是**同一句固定文本** ⇒ 任何"靠模型措辞通过"的断言在仿真里
//    **不成立**。要做语义断言，必须切到真实测试端点（`--live`）。
//
//  ---------------------------------------------------------------------------
//  响应形状（抄自仓库既有夹具 scripts/qq/group-verify.ts:50-61）
//  ---------------------------------------------------------------------------
//  · `GET  {base}/models`          ⇒ `{ data: [{ id, object: 'model' }] }`
//  · `POST {base}/chat/completions` ⇒ `{ choices: [{ message: { content: '…' } }] }`
//    其中 `content` 是 `<response><text>…</text></response>`（仓库既有约定）。
// ============================================================================

import { createServer } from 'node:http'

const PORT = Number(process.env.SIM_MODEL_PORT ?? 18080)
const REPLY = process.env.SIM_MODEL_REPLY ?? '<response><text>我在（服务器仿真环境）。</text></response>'
/** 记录调用次数；**默认不记录 prompt**（可能含用户原话）。 */
const RECORD = process.env.SIM_MODEL_RECORD_PROMPTS === '1'
const calls = []

function log (event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'model-mock', event, ...extra }))
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')

  const json = (code, body) => {
    response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }

  if (url.pathname === '/health') { json(200, { ok: true, calls: calls.length }); return }
  if (url.pathname === '/sim/calls') { json(200, { calls, recordPrompts: RECORD }); return }
  if (url.pathname === '/sim/reset' && request.method === 'POST') { calls.length = 0; json(200, { ok: true }); return }

  if (url.pathname.endsWith('/models') && request.method === 'GET') {
    json(200, { data: [{ id: process.env.OPENAI_LARGE_MODEL ?? 'serversim-model', object: 'model' }] })
    return
  }

  if (url.pathname.endsWith('/chat/completions') && request.method === 'POST') {
    let body = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
    const record = { at: new Date().toISOString(), model: body.model ?? null, messages: Array.isArray(body.messages) ? body.messages.length : 0 }
    if (RECORD && Array.isArray(body.messages)) {
      const last = body.messages[body.messages.length - 1]
      record.lastUserChars = String(last?.content ?? '').length
    }
    calls.push(record)
    log('chat_completion', { model: record.model, messages: record.messages })
    json(200, {
      id: 'chatcmpl-serversim',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'serversim-model',
      choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    return
  }

  json(404, { error: { message: `model-mock: no route for ${request.method} ${url.pathname}`, type: 'invalid_request_error' } })
})

// ⚠️ 监听 0.0.0.0：仿真主机里的环回转发器按 compose 网络的 DNS 名连过来
//    （`model:18080`），必须能连上容器的实际地址。
server.listen(PORT, '0.0.0.0', () => log('listening', { port: PORT }))

const shutdown = () => { log('stopping'); process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
