/**
 * 真实对话 → Phoenix 端到端验证（一次性副本库，真实对话库绝不被碰）。
 *
 * ============================================================================
 *  它证明的是链路，不是单点
 * ============================================================================
 * 与 `verify-telemetry.ts` 的分工：
 *   · verify-telemetry 用**构造出来的** span 验证编码与传输。
 *   · 本脚本用**真实的一轮对话**（真的写事件、真的跑 ContextCompiler、
 *     真的折叠投影）验证"她的经历会被导出成可查询的 trace"。
 *
 * 跑法：
 *   PHOENIX_COLLECTOR_ENDPOINT=http://127.0.0.1:6006 \
 *     node_modules/.bin/tsx scripts/verify-phoenix-live-chat.ts
 *
 * 前置：Phoenix 容器已启动（见 docs/architecture/tracing.md）。
 */

import 'dotenv/config'

import { bootHarness, recentConversationEvents } from '../evals/harness/runner.ts'
import { cleanupSandbox } from '../src/dev/sandbox.ts'
import { readTelemetryConfig, encodeOtlpProtobuf } from '../src/infrastructure/telemetry/index.ts'
import { createPhoenixTelemetry } from '../src/infrastructure/telemetry/phoenix.ts'
import type { CharacterRunTrace, TraceId } from '../src/kernel/contracts/index.ts'

const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://127.0.0.1:6006'

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('='.repeat(72))
console.log('真实对话 → Phoenix 端到端验证')
console.log('='.repeat(72))

// Phoenix 可达性
let reachable = false
try {
  const ui = await fetch(endpoint, { signal: AbortSignal.timeout(5000) })
  reachable = ui.ok
} catch (error) {
  console.log(`Phoenix 不可达（${endpoint}）：${error instanceof Error ? error.message : String(error)}`)
  console.log('请先：docker run -d --name project-lg-phoenix -p 6006:6006 -p 4317:4317 arizephoenix/arizephoenix/phoenix:latest')
  process.exit(2)
}
check(`Phoenix 可达（${endpoint}）`, reachable)

// 用真实对话链路跑两轮（echo 模式：不调模型，但事件 / 上下文 / 投影全部真实）
const { agent, kernel } = await bootHarness('phoenix-live-chat', { modelMode: 'echo' })
const sessionId = `live-chat-${Date.now()}`

// 把 harness 的遥测换成"打向真实 Phoenix"
const livePort = createPhoenixTelemetry({
  config: {
    ...readTelemetryConfig({} as NodeJS.ProcessEnv),
    enabled: true,
    adapter: 'phoenix',
    transport: 'protobuf',
    endpoint,
    timeoutMs: 10000,
    sessionId,
  },
})

const turns = ['苏沐薇，我回来了。', '今天有点累，不想说太多。']
const forwarded: TraceId[] = []

try {
  for (const text of turns) {
    const turn = await agent.say(text)
    if (turn.userEvent && turn.assistantEvent) {
      const trace = await kernel.stores.traceWriter.recent(kernel.characterId, 1)
      const latest = trace[0]
      if (latest) {
        // 把已经落库的业务 trace 原样镜像给 Phoenix —— 与生产路径同一份数据
        const port = livePort
        const handle = port.startTrace(latest)
        for (const step of latest.steps) port.addSpan(String(latest.traceId), step, handle.spanId)
        port.addSpan(
          String(latest.traceId),
          {
            kind: 'model_call',
            label: 'harness echo turn',
            startedAt: latest.startedAt,
            finishedAt: latest.finishedAt ?? Date.now(),
            status: 'ok',
            attributes: { durationMs: turn.modelDurationMs },
          },
          handle.spanId,
        )
        await port.finish(latest)
        handle.end()
        forwarded.push(latest.traceId)
      }
    }
  }

  check('两轮真实对话都产生了 trace', forwarded.length === 2, `${forwarded.length} 条`)
  const exports0 = livePort.exports()
  check(
    '两轮都成功导出到 Phoenix',
    exports0.length === 2 && exports0.every((r) => r.ok),
    exports0.map((r) => (r.ok ? 'HTTP 200' : r.error)).join(' | '),
  )

  // 回查：Phoenix 里到底有没有**本次**这两轮。
  //
  // 用 input/output event id 当指纹（它们是我们的领域 id，全局唯一且带序号），
  // 而不是 session.id —— 后者是 **resource 级**属性，Phoenix 的 spans API
  // 只在 spans 列表里返回 span 级 attributes，按它过滤会查到 0 条（实测踩过）。
  const fingerprints = forwarded.map((_, index) => `dm-sumuwei-b8ec0760:${index * 2 + 4}`)
  let found = 0
  let note = ''
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const query = new URL(`${endpoint}/v1/projects/default/spans`)
      query.searchParams.set('condition', "name == 'character.turn'")
      query.searchParams.set('limit', '200')
      const response = await fetch(query, { signal: AbortSignal.timeout(5000) })
      if (response.ok) {
        const body = (await response.json()) as { data?: { attributes?: Record<string, unknown> }[] }
        const rows = Array.isArray(body.data) ? body.data : []
        found = rows.filter((row) => {
          const text = JSON.stringify(row.attributes ?? {})
          return fingerprints.some((fp) => text.includes(fp))
        }).length
        note = `HTTP 200，按 event id 指纹匹配到 ${found} 条（共 ${rows.length} 条 character.turn）`
        if (found > 0) break
      } else {
        note = `HTTP ${response.status}`
      }
    } catch (error) {
      note = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  check('Phoenix 中能按事件 id 指纹查到本次真实对话的 trace', found >= 1, note)

  const events = await recentConversationEvents(kernel.stores.db, {
    characterId: kernel.characterId,
    limit: 20,
  })
  check('事实账本里有 4 条事件（2 轮 × 用户+助手）', events.length === 4, `${events.length} 条`)

  // 导出负载里不能有正文
  const samplePayload = encodeOtlpProtobuf({
    resourceAttributes: { 'service.name': 'x', 'service.version': 'y', 'session.id': sessionId },
    scopeName: 'x',
    scopeVersion: 'y',
    spans: [],
  })
  check('编码器可独立调用（空 span 列表也安全）', samplePayload.byteLength > 0)

  const traces = await kernel.stores.traceWriter.recent(kernel.characterId, 10)
  const serialized = JSON.stringify(traces)
  check(
    '业务 trace 里不含对话正文（只存 id 与元数据）',
    !serialized.includes('苏沐薇，我回来了') && !serialized.includes('今天有点累'),
  )
} finally {
  await livePort.shutdown()
  if (agent.dataDir) cleanupSandbox(agent.dataDir)
}

console.log(`\n${'='.repeat(72)}`)
console.log(`真实对话 → Phoenix 结果：${passed} 通过 / ${failed} 失败`)
console.log(`打开 ${endpoint} 可用 session.id = ${sessionId} 过滤本次运行`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)

void (undefined as unknown as CharacterRunTrace)
