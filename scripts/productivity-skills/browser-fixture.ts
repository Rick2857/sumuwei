/**
 * 受控的**假 sidecar**（浏览器四组的离线前提）。
 *
 * ============================================================================
 *  它是什么、不是什么
 * ============================================================================
 * 是什么：一个真的 HTTP 服务器，说真的 MCP JSON-RPC（`initialize` / `tools/call`），
 *        内部维护一个**受控页面**（URL、元素 ref、标签列表）。
 * 不是什么：**不是**真实已登录的浏览器 profile。真实登录态继承、桌面焦点影响
 *        那两条在计划书 §6C 的 C 集里验证；本文件**不替代**它们
 *        （计划书 §6A 末段："现有 profile 的登录态、桌面影响在 C 集中验证"）。
 *
 * ⚠️ 它记录**每一次到达的请求**（`requestLog`）：于是"白名单之外的工具连请求
 *    都不发"这条判据可以被机器核对，而不是只看我们自己的话。
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

interface FakeElement {
  ref: string
  kind: 'link' | 'textbox' | 'button' | 'select'
  label: string
  value?: string
  /** 点击这个元素会跳到哪（link/button 才有） */
  navigatesTo?: string
}

export interface FakeSidecar {
  readonly url: string
  readonly requestLog: readonly { method: string; tool?: string }[]
  /** 让后续所有工具调用返回 isError（模拟"元素失效 / 页面被关掉"） */
  setErrorMode(error: string | undefined): void
  /** 当前页面 URL */
  currentUrl(): string
  /** 某个输入框的当前值（"页面读回"用） */
  valueOf(ref: string): string | undefined
  /** 断连：直接关掉服务器（后续请求会 ECONNREFUSED） */
  close(): Promise<void>
  /** 重开（用于"断连后恢复"） */
  restart(): Promise<void>
  /**
   * ★ 2026-10-09：让后续**带会话 id** 的请求失效 N 次
   * （照上游契约回 `404` + `Session not found`，见 `coreBundle.js:73786-73791`）。
   * 用于照"sidecar 重启后原会话在服务端已不存在"这条真机事故（`L-PS-63`）。
   * 传 0 = 恢复正常。
   */
  expireSession(times: number): void
}

export interface FakeSidecarOptions {
  /** 初始页面 */
  readonly startUrl?: string
  readonly title?: string
  /** 允许的域名（超范围导航会被**夹具**拒绝，模拟 LG 侧范围校验之外的一层） */
  readonly allowedHosts?: readonly string[]
}

function pageSnapshot(input: {
  url: string
  title: string
  elements: readonly FakeElement[]
}): string {
  const lines = [
    `# 受控页面：${input.title}`,
    `URL: ${input.url}`,
    '',
    '## 可见文字',
    '这是受控测试页面。标记 PAGE-MARK-1。',
    '',
    '## 可交互元素',
    ...input.elements.map((element) =>
      element.value !== undefined
        ? `- ${element.ref} ${element.kind} 「${element.label}」 value=${element.value}`
        : `- ${element.ref} ${element.kind} 「${element.label}」`
    ),
  ]
  return lines.join('\n')
}

export async function startFakeSidecar(options: FakeSidecarOptions = {}): Promise<FakeSidecar> {
  const allowedHosts = options.allowedHosts ?? ['portal.example.com', 'news.example.com']
  let currentUrl = options.startUrl ?? 'https://portal.example.com/dashboard'
  let title = options.title ?? '受控仪表盘'
  let errorMode: string | undefined
  const requestLog: { method: string; tool?: string }[] = []
  let sessionIssued = false
  /** 还剩几次"会话失效"要模拟（0 = 正常） */
  let sessionExpireRemaining = 0
  let elements: FakeElement[] = [
    { ref: 'e1', kind: 'link', label: '报表页', navigatesTo: 'https://portal.example.com/reports' },
    { ref: 'e2', kind: 'textbox', label: '备注', value: '' },
    { ref: 'e3', kind: 'button', label: '提交' },
    { ref: 'e4', kind: 'select', label: '周期', value: 'week' },
  ]
  const tabs = [
    { index: 0, url: 'https://portal.example.com/dashboard', title: '受控仪表盘' },
    { index: 1, url: 'https://portal.example.com/other', title: '用户正在用的标签' },
  ]

  function toolResult(text: string, isError = false): unknown {
    return {
      jsonrpc: '2.0',
      result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) },
    }
  }

  function handleTool(name: string, args: Record<string, unknown>): unknown {
    if (errorMode !== undefined) return toolResult(errorMode, true)
    // Installed sidecar schemas require target; accepting ref hid real-browser failures.
    if (['browser_click', 'browser_type', 'browser_select_option'].includes(name)) {
      if (typeof args.target !== 'string' || args.target === '') {
        return toolResult(`Invalid arguments for tool "${name}": target must be a string`, true)
      }
      if ('ref' in args) {
        return toolResult(`Invalid arguments for tool "${name}": ref is not an upstream parameter`, true)
      }
    }
    switch (name) {
      case 'browser_snapshot':
        return toolResult(pageSnapshot({ url: currentUrl, title, elements }))
      case 'browser_navigate': {
        const url = typeof args.url === 'string' ? args.url : ''
        let host = ''
        try {
          host = new URL(url).hostname
        } catch {
          return toolResult(`导航目标不是合法 URL：${url}`, true)
        }
        if (!allowedHosts.includes(host)) {
          /*
           * ⚠️ 夹具这一层也拒超范围导航 —— 但**判据不在它身上**：
           *    LG 侧的范围校验是适配器与任务授权的职责，这里只是不提供一个
           *    "随便去哪"的测试环境。
           */
          return toolResult(`导航被拒绝：${host} 不在允许范围内`, true)
        }
        currentUrl = url
        title = host === 'news.example.com' ? '受控新闻页' : '受控仪表盘'
        elements = host === 'news.example.com'
          ? [{ ref: 'e1', kind: 'link', label: '返回', navigatesTo: 'https://portal.example.com/dashboard' }]
          : elements
        return toolResult(pageSnapshot({ url: currentUrl, title, elements }))
      }
      case 'browser_click': {
        const ref = typeof args.target === 'string' ? args.target : ''
        const element = elements.find((item) => item.ref === ref)
        if (element === undefined) {
          return toolResult(`元素 ${ref} 不在当前页面（引用已失效，请重新取快照）`, true)
        }
        if (element.navigatesTo !== undefined) {
          currentUrl = element.navigatesTo
          title = '受控报表页'
          elements = [
            { ref: 'e1', kind: 'link', label: '返回仪表盘', navigatesTo: 'https://portal.example.com/dashboard' },
          ]
        }
        return toolResult(`已点击 ${ref}（${element.label}）\n当前 URL: ${currentUrl}`)
      }
      case 'browser_type': {
        const ref = typeof args.target === 'string' ? args.target : ''
        const text = typeof args.text === 'string' ? args.text : ''
        const element = elements.find((item) => item.ref === ref)
        if (element === undefined) return toolResult(`元素 ${ref} 不在当前页面`, true)
        element.value = text
        return toolResult(`已在 ${ref}（${element.label}）填入 ${text.length} 个字符`)
      }
      case 'browser_select_option': {
        const ref = typeof args.target === 'string' ? args.target : ''
        const element = elements.find((item) => item.ref === ref)
        if (element === undefined) return toolResult(`元素 ${ref} 不在当前页面`, true)
        const values = Array.isArray(args.values) ? args.values : []
        element.value = String(values[0] ?? '')
        return toolResult(`已在 ${ref} 选择 ${String(element.value)}`)
      }
      case 'browser_wait_for':
        return toolResult('等待结束')
      /*
       * ★ 2026-10-09 / ADR-125：**全工具档**那三类工具在夹具里的受控应答。
       *
       * ⚠️ 夹具**不真的**执行 JS、**不读**任何真实凭据：
       *    · `browser_evaluate` 只把表达式回显 + 一个固定标记；
       *    · `browser_cookie_list` 返回一条**写死的**假 cookie（名字里带 FIXTURE）；
       *    · `browser_run_code_unsafe` 只回一个固定标记。
       *    这样"全工具档真的把上游返回带进了当轮内容"可以被机器断言，
       *    而夹具里不存在任何可以被误读成"真凭据"的东西。
       */
      case 'browser_evaluate': {
        const expression = typeof args.expression === 'string' ? args.expression : ''
        return toolResult(`EVAL-MARK-1 表达式=${expression} 结果=<受控夹具值>`)
      }
      case 'browser_run_code_unsafe': {
        const code = typeof args.code === 'string' ? args.code : ''
        return toolResult(`RUN-CODE-MARK-1 代码长度=${String(code.length)} 结果=<受控夹具值>`)
      }
      case 'browser_cookie_list':
        return toolResult('FIXTURE-COOKIE-1=controlled-value (domain: .example.com, path: /)')
      case 'browser_localstorage_list':
        return toolResult('FIXTURE-KEY-1=controlled-value')
      case 'browser_pdf_save':
        return toolResult('已保存 PDF：受控夹具')
      case 'browser_take_screenshot':
        return toolResult('已截图：受控夹具')
      case 'browser_tabs': {
        const action = typeof args.action === 'string' ? args.action : 'list'
        if (action === 'list') {
          return toolResult(tabs.map((tab) => `${String(tab.index)}: ${tab.title} ${tab.url}`).join('\n'))
        }
        if (action === 'new') {
          tabs.push({ index: tabs.length, url: 'about:blank', title: '新标签' })
          return toolResult(`已新建标签 ${String(tabs.length - 1)}`)
        }
        const index = typeof args.index === 'number' ? args.index : 0
        const tab = tabs[index]
        if (tab === undefined) return toolResult(`没有第 ${String(index)} 个标签`, true)
        return toolResult(`已切到 ${String(index)}: ${tab.title}`)
      }
      default:
        /*
         * ⚠️ 未知工具**在这里报错** —— 但判据不依赖它：LG 的白名单在**发出请求之前**
         *    就拒绝了。这个分支存在只是为了"如果请求真的到了，夹具不会假装成功"。
         */
        return toolResult(`夹具没有实现这个工具：${name}`, true)
    }
  }

  function start(): Server {
    const server = createServer((request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end()
        return
      }
      /*
       * ======================================================================
       *  ⚠️ 夹具必须**照官方 SDK 的契约**拒请求，否则它就是个橡皮图章
       * ======================================================================
       * 官方 MCP Streamable HTTP 传输对**每一个 POST** 都要求：
       * ```text
       * accept 同时含 application/json 与 text/event-stream ⇒ 否则 406
       * content-type 必须含 application/json                 ⇒ 否则 415
       * ```
       * 第一版夹具什么头都收，于是适配器少发一个 `Accept` 也照样"通过" ——
       * 而真 sidecar 会回 **406**（2026-10-04 读上游源码发现）。
       * ⇒ 这里显式复刻那两条闸：**离线门才可能照到这类缺陷**。
       */
      const accept = String(request.headers.accept ?? '')
      const contentType = String(request.headers['content-type'] ?? '')
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        response.writeHead(406, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Not Acceptable: Client must accept both application/json and text/event-stream',
            },
            id: null,
          })
        )
        requestLog.push({ method: '(拒绝)', tool: undefined })
        return
      }
      if (!contentType.includes('application/json')) {
        response.writeHead(415, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Unsupported Media Type' },
            id: null,
          })
        )
        return
      }
      let raw = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        raw += chunk
      })
      request.on('end', () => {
        let payload: { id?: unknown; method?: string; params?: Record<string, unknown> } = {}
        try {
          payload = JSON.parse(raw) as typeof payload
        } catch {
          response.writeHead(400).end()
          return
        }
        const method = payload.method ?? ''
        const toolName =
          method === 'tools/call' && typeof payload.params?.name === 'string'
            ? (payload.params.name as string)
            : undefined
        requestLog.push({ method, ...(toolName !== undefined ? { tool: toolName } : {}) })

        /*
         * ★ 2026-10-09：**会话失效**模拟。
         *
         * ⚠️ 状态码与正文都**照上游**（不是我们自己发明的形状）：
         *    未知 `mcp-session-id` ⇒ HTTP 404 + "Session not found"
         *    （`coreBundle.js:73786-73791` 与 `utilsBundle.js:84913-84914` 两处一致）。
         * ⇒ 适配器的"会话失效 ⇒ 重建一次"才有**真实契约**可依，而不是猜一个状态码。
         */
        if (
          method === 'tools/call' &&
          String(request.headers['mcp-session-id'] ?? '') !== '' &&
          sessionExpireRemaining > 0
        ) {
          sessionExpireRemaining -= 1
          response.writeHead(404, { 'Content-Type': 'text/plain' })
          response.end('Session not found')
          return
        }

        if (method === 'notifications/initialized') {
          response.writeHead(202).end()
          return
        }
        if (method === 'initialize') {
          sessionIssued = true
          response.writeHead(200, {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': 'fixture-session-1',
          })
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              result: {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'fake-sidecar', version: '1.0.0' },
              },
            })
          )
          return
        }
        if (method === 'tools/call') {
          const result = handleTool(toolName ?? '', (payload.params?.arguments ?? {}) as Record<string, unknown>)
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ ...(result as object), id: payload.id }))
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: 'method not found' } })
        )
      })
    })
    server.listen(0, '127.0.0.1')
    return server
  }

  let server = start()
  await new Promise<void>((resolvePromise) => server.once('listening', () => resolvePromise()))
  const port = (server.address() as AddressInfo).port
  let url = `http://127.0.0.1:${String(port)}/mcp`

  const api: FakeSidecar = {
    get url() {
      return url
    },
    get requestLog() {
      return requestLog
    },
    setErrorMode(error) {
      errorMode = error
    },
    expireSession(times) {
      sessionExpireRemaining = Math.max(0, Math.trunc(times))
    },
    currentUrl() {
      return currentUrl
    },
    valueOf(ref) {
      return elements.find((item) => item.ref === ref)?.value
    },
    async close() {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    },
    async restart() {
      server = start()
      await new Promise<void>((resolvePromise) => server.once('listening', () => resolvePromise()))
      const newPort = (server.address() as AddressInfo).port
      url = `http://127.0.0.1:${String(newPort)}/mcp`
      void sessionIssued
    },
  }
  return api
}
