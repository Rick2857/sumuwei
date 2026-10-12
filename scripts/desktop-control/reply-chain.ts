/** 真 main.ts + 新建隔离库 + 模拟模型/桌面；不触碰用户桌面或生产库。 */
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { isolateDatabase } from '../../src/dev/sandbox.ts'
import { EntryShell, startCoexistHost } from '../coexist/harness.ts'

export async function verifyDesktopReplyChain(): Promise<{
  cases: { id: string; title: string; passed: boolean; observed: unknown }[]
  prompts: { role: string; content: string }[][]
}> {
  const prompts: { role: string; content: string }[][] = []
  let launchPending = false
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(200); response.end('{}'); return }
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const data = JSON.parse(body)
    const instruction = String(data.messages?.[0]?.content ?? '')
    const input = String(data.messages?.[1]?.content ?? '')
    let content = '就绪'
    if (instruction.includes('要不要用工具')) {
      const launch = input.includes('验证新增启动动作')
      launchPending = launch
      content = JSON.stringify(/^本轮原话：「[^」]*仅回答/u.test(input) ? { branch: 'answer' } : launch ? {
        branch: 'tools', goal: '验证新增启动动作', done: false,
        steps: [{ capability: 'desktop.inspect', operation: 'apps', args: { query: 'Edge' } }],
      } : {
        /*
         * 这一档要验的是"**操作被拒**之后，回复仍拿到能力状态与本次失败事实"。
         * ⚠️ 用作"非法动作"的必须是**闭集之外**的取值：2026-10-09 之前这里写的是
         *    `right_click`（那时它确实不在闭集里）；右键补进闭集之后它就**合法**了，
         *    这一档会在日志上去找一条永远不会出现的 `rejected/validation_failed`。
         *    ⇒ 换成仍然未登记的 `scroll`，判据的**意思**不变。
         */
        branch: 'tools', goal: '通过桌面打开 Edge', done: false,
        steps: [
          { capability: 'desktop.inspect', operation: 'state', args: {} },
          { capability: 'desktop.operate', operation: 'act', args: {
            action: 'scroll', window: '夹具窗口', index: 0, name: '确定',
          } },
        ],
      })
    } else if (instruction.includes('把用户任务拆成有限动作步骤')) {
      content = JSON.stringify(launchPending ? {
        goal: '按应用目录中的完整名称启动', done: false,
        steps: [{ capability: 'desktop.operate', operation: 'act', args: { action: 'launch_app', name: 'microsoft edge' } }],
      } : { goal: '依据已有结果停止', steps: [], done: true })
      launchPending = false
    } else if ((instruction + input).includes('# 对方刚刚说')) {
      // 第一轮故意留下旧的错误自述，检验下一轮仍收到独立的程序能力事实。
      content = prompts.length === 0
        ? '<response><text>桌面操控那一层我够不着，我能碰的只有浏览器。</text></response>'
        : '<response><text>这是隔离回复夹具。</text></response>'
      prompts.push(data.messages)
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content } }] }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const cases: { id: string; title: string; passed: boolean; observed: unknown }[] = []
  try {
    for (const enabled of [true, false]) {
      const sandbox = isolateDatabase(`desktop-reply-${String(enabled)}`)
      const host = await startCoexistHost({
        dbDir: sandbox.dir, modelPort: (server.address() as { port: number }).port,
        env: {
          CHARACTER_ACTION_ENABLED: 'true', CHARACTER_TASK_AUTONOMY_ENABLED: 'true',
          CHARACTER_TOOL_DECISION_MODE: 'role', CHARACTER_MEMORY_EXPLICIT_ENABLED: 'false',
          CHARACTER_DESKTOP_INSPECT_ENABLED: String(enabled),
          CHARACTER_DESKTOP_OPERATE_ENABLED: String(enabled),
          PROJECT_LG_DESKTOP_WORKER: resolve('scripts/desktop-control/fixtures/fake-desktop-worker.py'),
          DESKTOP_FIXTURE_SCENARIO: 'state-reply',
        },
      })
      let client: EntryShell | undefined
      try {
        await host.ready
        client = new EntryShell(host.avatarPort, host.avatarToken)
        await client.ready
        const before = prompts.length
        const answer = await client.submit(`desktop-answer-${String(enabled)}`, '你有什么桌面能力？仅回答')
        const answerPrompt = (prompts[before] ?? []).map(message => message.content).join('\n')
        cases.push({
          id: enabled ? 'dc-main-answer-capabilities' : 'dc-main-off-prompt',
          title: enabled ? '真入口无动作轮也收到桌面能力事实' : '桌面全关时真入口不注入能力事实',
          passed: answer.outcome === 'replied' && (enabled
            ? answerPrompt.includes('desktop.operate.act：已启用')
            : !answerPrompt.includes('# 当前桌面能力（程序事实）')),
          observed: { enabled, replied: answer.outcome === 'replied', facts: answerPrompt.includes('# 当前桌面能力（程序事实）') },
        })
        if (enabled) {
          const beforeTools = prompts.length
          const tools = await client.submit('desktop-edge', '那能不能通过桌面操控打开一下edge浏览器')
          const toolPrompt = (prompts[beforeTools] ?? []).map(message => message.content).join('\n')
          const logs = [...host.stdout, ...host.stderr].join('\n')
          const rejected = logs.includes('desktop.operate.act=rejected/validation_failed')
          cases.push({
            id: 'dc-main-failed-operation-facts',
            title: '真入口查看成功、操作拒绝后，回复同时收到能力状态与本次失败事实',
            passed: tools.outcome === 'replied' && rejected &&
              logs.includes('desktop.inspect.state=success') &&
              toolPrompt.includes('desktop.operate.act：已启用') &&
              toolPrompt.includes('validation_failed') && toolPrompt.includes('夹具窗口') &&
              toolPrompt.includes('我能碰的只有浏览器'),
            observed: { replied: tools.outcome === 'replied', rejected, hasFailure: toolPrompt.includes('validation_failed') },
          })
          const beforeLaunch = prompts.length
          const launched = await client.submit('desktop-launch', '帮我验证新增启动动作，先查应用目录再启动 Edge')
          const launchPrompt = (prompts[beforeLaunch] ?? []).map(message => message.content).join('\n')
          const launchLogs = [...host.stdout, ...host.stderr].join('\n')
          cases.push({ id: 'dc-main-app-discovery-launch', title: '真入口通过目录查询、重新规划、任务授权、适配器与最终回复',
            passed: launched.outcome === 'replied' && launchLogs.includes('desktop.inspect.apps=success') &&
              launchPrompt.includes('launch_app') && launchPrompt.includes('启动请求已提交') &&
              launchPrompt.includes('microsoft edge'),
            observed: { replied: launched.outcome === 'replied', apps: launchLogs.includes('desktop.inspect.apps=success'),
              launchResult: launchPrompt.includes('启动请求已提交') } })
        }
      } finally {
        client?.close()
        const code = await host.stop()
        cases.push({ id: `dc-main-clean-close-${String(enabled)}`, title: '隔离核心有序关闭',
          passed: code === 0, observed: { enabled, exitCode: code } })
      }
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  return { cases, prompts }
}
