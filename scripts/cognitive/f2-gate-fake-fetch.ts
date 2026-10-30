/**
 * **⚠️ 门专用假 fetch（零网络）**——只在 `F2_GATE_TEST_HARNESS=1 && F2_GATE_FAKE_FETCH=1` 时由 CLI **动态**加载。
 *
 * 单独成模块的理由：`f2-live-runner.ts` 的"零请求结构保证"静态检查要求源码里**不出现** `网络调用括号`；
 * 假 fetch 只服务门，不应混进运行入口。真实路径永不加载本模块。
 */
export function gateFixtureTransport (env: NodeJS.ProcessEnv = process.env): typeof fetch | undefined {
  if (env.F2_GATE_TEST_HARNESS !== '1' || env.F2_GATE_FAKE_FETCH !== '1') return undefined
  const usageMode = (env.F2_GATE_FAKE_USAGE ?? 'present').trim()
  const abortMode = (env.F2_GATE_FAKE_ABORT ?? '').trim() === '1'
  return (async (_input: unknown, init?: unknown) => {
    if (abortMode) {
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      throw error
    }
    const body = JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? '{}')) as { messages?: { content?: unknown }[] }
    const text = (body.messages ?? []).map(item => String(item.content ?? '')).join(' ')
    const object = /(obj-[a-z]?\d+)/.exec(text)?.[1] ?? 'obj-31'
    const family = /(f\d+\/a)/.exec(text)?.[1] ?? 'f2/a'
    const plan = {
      goal: 'gate', done: true, steps: [
        { capability: 'sandbox.file.write', operation: 'write', args: { path: `${family}/${object}.txt`, content: `auth:${object}` } },
        { capability: 'sandbox.file.read', operation: 'read', args: { path: `${family}/${object}.txt` } },
      ],
    }
    const payload = {
      choices: [{ message: { content: JSON.stringify({ candidates: [plan] }) } }],
      ...(usageMode === 'absent' ? {} : { usage: { total_tokens: 120, prompt_tokens: 100, completion_tokens: 20 } }),
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response
  }) as unknown as typeof fetch
}
