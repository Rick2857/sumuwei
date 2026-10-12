/**
 * `browser.read` / `browser.operate` 适配器（第二批计划 §3.4）。
 *
 * ============================================================================
 *  它连接的是**一个固定版本的 sidecar**，不是一个"任意 MCP 服务器"
 * ============================================================================
 * ```text
 * 地址：装配层注入的单一常量（`CHARACTER_BROWSER_SIDECAR_URL`）
 * 协议：MCP over HTTP（JSON-RPC 2.0；`initialize` → `tools/call`）
 * 工具：**只**调 `browser-operations.ts` 的白名单名字
 * ```
 * 计划书 §3.4：「LG 专用适配器只连接这个固定 sidecar、只允许已映射的操作和参数；
 * 不向模型暴露任意 MCP 工具入口。」
 * ⇒ 本文件里**没有**"按名字调用任意工具"的入口：每一个 `tools/call` 都来自
 *    `BROWSER_ACTION_MAPPINGS` 或 `snapshot` 这两个来源。
 *
 * ============================================================================
 *  四条如实性要求
 * ============================================================================
 * ```text
 * ① 连接不上 / sidecar 没起 ⇒ `execution_failed` 且**点名**（"sidecar 没在监听 <url>"），
 *    绝不静默返回空页面（那会被回复层读成"页面是空的"）
 * ② 过期元素引用 ⇒ sidecar 报错原样转达（"请重新取快照"），**不猜一个元素**
 * ③ 焦点/窗口影响：本适配器**不做**任何激活调用；上游扩展是否抢焦点是
 *    一个**实测项**（见 WP5 的静态核对与 live 读数），不在这里假装已解决
 * ④ token / cookie **不进**任何证据：只记"连接到了 sidecar"这一事实与页面 URL 的 host
 * ```
 */

import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import type {
  AdapterExecuteInput,
  AdapterOutcome,
  CapabilityAdapter,
} from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import {
  BROWSER_MCP,
  BROWSER_MCP_OPERATION,
  BROWSER_OPERATE,
  BROWSER_OPERATE_OPERATION,
  BROWSER_READ,
  BROWSER_READ_OPERATION,
  type BrowserActionKind,
} from '../../../kernel/action/browser-capability.ts'
import {
  BROWSER_ACTION_MAPPINGS,
  isAllowedMcpTool,
  isBrowserAction,
  type BrowserActionInput,
} from '../../../kernel/action/browser-operations.ts'
import { TURN_CONTENT_LIMITS } from '../../../kernel/contracts/turn-content.ts'
import type { LocalTextTurnContent, TurnContent } from '../../../kernel/contracts/turn-content.ts'
import { fnv1a64Hex } from '../../../kernel/action/idempotency.ts'
import { createHash } from 'node:crypto'

export const BROWSER_LIMITS = {
  timeoutMs: 30_000,
  /** 一次快照最多带多少字符进当轮内容 */
  maxSnapshotChars: 40_000,
  /** 只记 host 不记完整 URL（查询串里可能有 token） */
} as const

export interface BrowserAdapterOptions {
  sidecarUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => number
}

interface JsonRpcResponse {
  jsonrpc?: unknown
  id?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown }
}

/** MCP `tools/call` 的结果形状（**只取我们认识的字段**） */
export interface McpToolResult {
  /** 文本内容拼接（`content[].type === 'text'`） */
  text: string
  isError: boolean
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 从 MCP 响应里抽出文本（**不认识的一律忽略**，不把它当成页面内容）。
 *
 * ⚠️ 只收 `type === 'text'` 的项：`image` / `resource` 那些形状在首版没有消费者，
 *    把它们拼进正文等于把一份我们没解析过的字节当作"页面文字"给模型。
 */
export function extractToolResult(result: unknown): McpToolResult {
  const record = result as { content?: unknown; isError?: unknown } | null
  if (record === null || typeof record !== 'object') return { text: '', isError: false }
  const isError = record.isError === true
  const content = Array.isArray(record.content) ? record.content : []
  const parts: string[] = []
  for (const item of content) {
    const entry = item as { type?: unknown; text?: unknown }
    if (entry.type === 'text' && typeof entry.text === 'string') parts.push(entry.text)
  }
  return { text: parts.join('\n'), isError }
}

/** 只保留 URL 的 origin（**查询串与片段一律丢掉** —— 那里可能有 token） */
export function originOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '(无法解析的地址)'
  }
}

export function createBrowserAdapter(options: BrowserAdapterOptions): {
  snapshot: CapabilityAdapter
  operate: CapabilityAdapter
  call: CapabilityAdapter
} {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? BROWSER_LIMITS.timeoutMs
  const now = options.now ?? (() => Date.now())
  let sessionId: string | undefined
  let requestId = 0
  /**
   * ★ 2026-10-09（真机事故逼出来的；`L-PS-63` / ADR-125 后补节）：会话失效后**重建过几次**。
   * 它让"这次结果是在一次重建之后拿到的"成为**可读的事实**（见 `callTool` 的程序附注）。
   */
  let sessionRebuilds = 0

  /**
   * 一次 JSON-RPC。
   *
   * ★ `retryOnExpiredSession`（缺省 true）：**会话失效 ⇒ 重建一次并重试一次**。
   *
   * ============================================================================
   *  为什么需要它（2026-10-09 真机事故）
   * ============================================================================
   * ```text
   * 适配器把 mcp-session-id 缓存在 `sessionId` 里，而 `ensureSession()` 只要它非空就直接返回。
   * sidecar 一旦重启（本机 2026-10-09 就重启过 3 次以上），会话在服务端**已经不存在**：
   * 之后每一次 tools/call 都拿 404，LG 如实转成 execution_failed ⇒ 用户看到的是
   * "她一直说访问不了"，而浏览器与标签侧看上去全都是对的。
   * ```
   * ⚠️ 判据是从上游**两层**代码里读出来的（不是猜）：
   * ```text
   * playwright-core/lib/coreBundle.js:73786-73791   未知 mcp-session-id ⇒ 404 + "Session not found"
   * playwright-core/lib/utilsBundle.js:84913-84914  同上（JSON-RPC -32001 "Session not found"）
   * ```
   * ⚠️ 边界（三条，都是刻意的）：
   * ```text
   * ① 只有 HTTP 404 **且我们确实带了会话 id** 才算"会话失效"（首次 initialize 没有会话可失效）
   * ② 每次动作**最多重建一次**（往下传 `false`）—— 不无限重试、不用重试掩盖真故障
   * ③ 重建**有代价**：新会话 = 扩展里**新的连接页与新的标签组**，旧绑定的标签随旧 sidecar
   *    一起没了 ⇒ 必须在结果里**如实**说出来（见 `callTool` 的程序附注）
   * ```
   */
  async function rpc(
    method: string,
    params: Record<string, unknown>,
    retryOnExpiredSession = true
  ): Promise<unknown> {
    requestId += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      }
      if (sessionId !== undefined) headers['Mcp-Session-Id'] = sessionId
      const response = await doFetch(options.sidecarUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: controller.signal,
      })
      const sentSessionId = headers['Mcp-Session-Id']
      const returnedSession = response.headers.get('mcp-session-id')
      if (returnedSession !== null && returnedSession !== '') sessionId = returnedSession
      if (!response.ok) {
        const sessionExpired =
          response.status === 404 &&
          sentSessionId !== undefined &&
          method !== 'initialize' &&
          retryOnExpiredSession
        if (sessionExpired) {
          sessionId = undefined
          sessionRebuilds += 1
          await ensureSession()
          return await rpc(method, params, false)
        }
        throw new ActionFailureError(
          actionFailure(
            'execution_failed',
            `浏览器 sidecar 在 ${options.sidecarUrl} 返回 HTTP ${String(response.status)}`
          )
        )
      }
      const text = await response.text()
      /*
       * Streamable HTTP 允许 `text/event-stream` 回应。
       * ⚠️ 只解析 `data:` 行里的 JSON 对象；解析不出来就如实失败 —— 不猜。
       */
      const payload = text.includes('data:')
        ? text
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .filter((line) => line.startsWith('{'))
            .pop()
        : text
      if (payload === undefined || payload.trim() === '') {
        throw new ActionFailureError(
          actionFailure('execution_failed', '浏览器 sidecar 返回了空响应')
        )
      }
      let parsed: JsonRpcResponse
      try {
        parsed = JSON.parse(payload) as JsonRpcResponse
      } catch {
        throw new ActionFailureError(
          actionFailure('execution_failed', '浏览器 sidecar 的响应不是 JSON（协议不符）')
        )
      }
      if (parsed.error !== undefined) {
        const message =
          typeof parsed.error.message === 'string' ? parsed.error.message : '未命名的协议错误'
        throw new ActionFailureError(
          actionFailure('execution_failed', `浏览器 sidecar 报错：${message}`.slice(0, 400))
        )
      }
      return parsed.result
    } catch (error) {
      if (error instanceof ActionFailureError) throw error
      throw new ActionFailureError(
        actionFailure(
          'execution_failed',
          `连不上浏览器 sidecar（${options.sidecarUrl}）：` +
            `${error instanceof Error ? error.message.slice(0, 200) : String(error)} —— ` +
            'sidecar 需要单独启动（见使用与回滚说明）'
        )
      )
    } finally {
      clearTimeout(timer)
    }
  }

  async function ensureSession(): Promise<void> {
    if (sessionId !== undefined) return
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'project-lg', version: '2.0.0' },
    })
    /*
     * MCP 的 `initialized` 通知（无 id）。
     *
     * ⚠️ **`Accept` 头必须与请求一致**（2026-10-04 读真实 sidecar 的源码发现的缺陷）。
     *    官方 MCP SDK 的 Streamable HTTP 传输对**每一个 POST** 都要：
     * ```text
     * accept 必须**同时**含 application/json 与 text/event-stream，否则 406 Not Acceptable
     * ```
     * 第一版这条通知只发了 `Content-Type` ⇒ 真 sidecar 会回 **406**，而受控假 sidecar
     * （browser-01/02/03）什么都收 ⇒ **离线三组照不到它**。
     * 通知的失败在本适配器里**不阻断**（见下面那个 catch），所以表现会是
     * "连接看起来建立了、工具调用却拿不到东西"这种最难查的形态。
     */
    try {
      const notifyHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      }
      if (sessionId !== undefined) notifyHeaders['Mcp-Session-Id'] = sessionId
      await doFetch(options.sidecarUrl, {
        method: 'POST',
        headers: notifyHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      })
    } catch {
      /* 通知失败不是致命错误：真正的判据是下面的 tools/call 有没有结果 */
    }
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!isAllowedMcpTool(name)) {
      // 结构性闸：白名单之外的名字**连请求都不发**
      throw new ActionFailureError(
        actionFailure('unsupported', `LG 不调用这个浏览器工具：${name}（不在白名单里）`)
      )
    }
    await ensureSession()
    const rebuildsBefore = sessionRebuilds
    const result = await rpc('tools/call', { name, arguments: args })
    const extracted = extractToolResult(result)
    if (sessionRebuilds === rebuildsBefore) return extracted
    /*
     * ⚠️ 这一段是**程序附注**（不是页面内容）：会话在这次调用里失效过 ⇒ 就已经**重建并重试**，
     *    而重建意味着扩展里出现了**新的连接页**、旧的标签绑定已经没了。
     *    不说出来，下一个人会把"新连接页里的内容"当成"原来那个页面的内容"。
     */
    return {
      ...extracted,
      text:
        `${extracted.text}\n\n[程序附注] 浏览器会话在这次调用里失效（sidecar 重启过）⇒ ` +
        '已重建一次并重试。**旧的标签绑定随旧 sidecar 一起没了**：' +
        '请在**新弹出的那张连接页标签**里重新打开你要给她看的网址。',
    }
  }

  function snapshotAdapter(): CapabilityAdapter {
    return {
      capabilityId: BROWSER_READ,
      async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
        const snapshot = await callTool('browser_snapshot', {})
        if (snapshot.isError) {
          throw new ActionFailureError(
            actionFailure('execution_failed', `取页面快照失败：${snapshot.text.slice(0, 300)}`)
          )
        }
        const text = snapshot.text
        if (text.trim() === '') {
          throw new ActionFailureError(
            actionFailure(
              'target_not_found',
              '快照是空的 —— 可能没有打开任何页面（先 navigate 打开一个），或页面还没加载出内容'
            )
          )
        }
        const shaped = text.slice(0, BROWSER_LIMITS.maxSnapshotChars)
        const fetchedAt = now()
        const content: LocalTextTurnContent = {
          contentId: `${String(input.actionId)}:browser-snapshot`,
          kind: 'local-text',
          capability: BROWSER_READ,
          operation: BROWSER_READ_OPERATION,
          sourceKind: 'remote-article',
          resourceRef: options.sidecarUrl,
          resultFingerprint: fnv1a64Hex(text),
          scope: {
            totalChars: text.length,
            includedChars: shaped.length,
            truncated: shaped.length < text.length,
          },
          facts: [
            '来源：**用户已登录的浏览器**（通过 Playwright MCP sidecar 的已绑定标签）',
            `快照字符数：${String(text.length)}`,
            `抓取时间：${new Date(fetchedAt).toISOString()}`,
            '登录态与 cookie **不进**证据：这里只有页面可见文字与元素引用',
          ],
          text: shaped,
          mediaType: 'text/x-page-snapshot',
          lineCount: shaped.split('\n').length,
          sourceBytes: Buffer.byteLength(text, 'utf8'),
        }
        const turnContent: TurnContent[] = [content]
        return {
          effect: {
            kind: 'content_read',
            detail: `浏览器页面快照（${String(text.length)} 字符）`,
            fingerprint: content.resultFingerprint,
          },
          evidence: [
            {
              kind: 'adapter',
              detail: `browser.read 快照 via ${options.sidecarUrl} · 字符 ${String(text.length)}`,
              ref: options.sidecarUrl,
            },
          ],
          turnContent,
        }
      },
    }
  }

  function operateAdapter(): CapabilityAdapter {
    return {
      capabilityId: BROWSER_OPERATE,
      async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
        const actionRaw = stringArg(input.args, 'action') ?? ''
        if (!isBrowserAction(actionRaw)) {
          throw new ActionFailureError(
            actionFailure(
              'validation_failed',
              `浏览器操作只支持闭集里的那几种，收到「${actionRaw === '' ? '(空)' : actionRaw}」—— ` +
                '不暴露任意 MCP 工具入口'
            )
          )
        }
        const tabActionRaw = stringArg(input.args, 'tab')
        const tabIndexRaw = input.args.tabIndex
        const actionInput: BrowserActionInput = {
          action: actionRaw as BrowserActionKind,
          ...(stringArg(input.args, 'url') !== undefined ? { url: stringArg(input.args, 'url')! } : {}),
          ...(stringArg(input.args, 'ref') !== undefined ? { ref: stringArg(input.args, 'ref')! } : {}),
          ...(stringArg(input.args, 'text') !== undefined ? { text: stringArg(input.args, 'text')! } : {}),
          ...(stringArg(input.args, 'value') !== undefined
            ? { value: stringArg(input.args, 'value')! }
            : {}),
          ...(typeof input.args.waitMs === 'number' ? { waitMs: input.args.waitMs } : {}),
          ...(tabActionRaw === 'list' || tabActionRaw === 'new' || tabActionRaw === 'select'
            ? { tabAction: tabActionRaw }
            : {}),
          ...(typeof tabIndexRaw === 'number' ? { tabIndex: tabIndexRaw } : {}),
        }
        const mapping = BROWSER_ACTION_MAPPINGS[actionInput.action]
        let args: Record<string, unknown>
        try {
          args = mapping.args(actionInput)
        } catch (error) {
          throw new ActionFailureError(
            actionFailure(
              'validation_failed',
              error instanceof Error ? error.message : String(error)
            )
          )
        }
        const result = await callTool(mapping.tool, args)
        if (result.isError) {
          /*
           * ⚠️ 过期引用 / 多匹配都在这里 —— 如实转达 sidecar 的话，**不**自动重试、
           *    **不**猜另一个元素（计划书 §3.4："过期引用刷新后重判，多匹配不猜"；
           *    "刷新后重判"是**再取一次快照**这件事，由下一个步骤显式做）。
           */
          throw new ActionFailureError(
            actionFailure(
              'execution_failed',
              `浏览器操作 ${actionInput.action} 失败：${result.text.slice(0, 300)}（` +
                '若提示元素失效，请重新取快照再定位；不猜目标）'
            )
          )
        }

        const summary = result.text === '' ? `（${actionInput.action} 完成，sidecar 没有返回文本）` : result.text
        const shaped = summary.slice(0, 8_000)
        const facts = [
          `操作：${actionInput.action} → MCP 工具 ${mapping.tool}`,
          actionInput.url !== undefined ? `目标 origin：${originOf(actionInput.url)}` : '目标：当前标签',
          '程序检查了 sidecar 的返回（不看"点击成功"这句话，看它实际回了什么）',
        ]
        const content: LocalTextTurnContent = {
          contentId: `${String(input.actionId)}:browser-act`,
          kind: 'local-text',
          capability: BROWSER_OPERATE,
          operation: BROWSER_OPERATE_OPERATION,
          sourceKind: 'remote-article',
          resourceRef: options.sidecarUrl,
          resultFingerprint: fnv1a64Hex(summary),
          scope: { totalChars: summary.length, includedChars: shaped.length, truncated: shaped.length < summary.length },
          facts,
          text: shaped,
          mediaType: 'text/x-browser-action-result',
          lineCount: shaped.split('\n').length,
          sourceBytes: Buffer.byteLength(summary, 'utf8'),
        }
        const turnContent: TurnContent[] = [content]
        return {
          effect: {
            kind: 'no_change',
            detail: `浏览器操作 ${actionInput.action}（${mapping.tool}）`,
            fingerprint: sha256(summary),
          },
          evidence: [
            {
              kind: 'adapter',
              detail: `browser.operate ${actionInput.action} via ${mapping.tool}`,
              ref: options.sidecarUrl,
            },
          ],
          turnContent,
        }
      },
    }
  }

  /**
   * ★ 2026-10-09 / `ADR-125`：**全工具档**（用户 C 档授权）。
   *
   * ```text
   * tool     ：上游工具名，必须**逐字**在 ALLOWED_MCP_TOOLS 里（72 个）
   * toolArgs ：原样转交给上游的 arguments 对象（这里**不做**逐工具参数校验）
   * ```
   *
   * ⚠️ 这条路的诚实边界（**不许**被读成"它做了什么 LG 都知道"）：
   *    · 上游 `type: readOnly/input` 那类标注**不构成**跳过我方风险判断的理由；
   *    · 因此它整条声明为 **destructive / R3**，并且**不支持 dryRun**
   *      （"什么都可能做"的入口没有诚实的干跑语义）；
   *    · 结果**可能含凭据**（cookie / localStorage / 网络正文 / 控制台）——
   *      LG 只做一件事：把它当成**当轮内容**如实交出去，并在 facts 里点名说过。
   */
  function callAdapter(): CapabilityAdapter {
    return {
      capabilityId: BROWSER_MCP,
      async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
        const tool = stringArg(input.args, 'tool') ?? ''
        if (tool === '') {
          throw new ActionFailureError(
            actionFailure(
              'validation_failed',
              'browser.mcp 需要 tool（上游工具名，逐字取自工具表），例如 browser_cookie_list。'
            )
          )
        }
        /*
         * ⚠️ 这一道闸与下面 `callTool()` 里那道**不是**重复：这里在**发请求之前**就拒，
         *    因此"名字不在工具表里"这件事不会产生任何出站流量（离线可断言，见 browser-05）。
         */
        if (!isAllowedMcpTool(tool)) {
          throw new ActionFailureError(
            actionFailure(
              'unsupported',
              `LG 的工具表里没有这个浏览器工具：${tool}（不在白名单里，一个包都不会发）`
            )
          )
        }
        /*
         * ⚠️ `toolArgs` 是**JSON 对象字符串**（不是对象）：`task-plan.ts` 的 args 值只接受
         *    `string | number | boolean`（对象会让**整条计划**作废）。这里解析，且**失败关闭**：
         *    解析不出来 / 解析出来不是对象 ⇒ `validation_failed`，**一个包都不发**。
         */
        const rawArgs = input.args.toolArgs
        let toolArgs: Record<string, unknown> = {}
        if (rawArgs !== undefined && rawArgs !== '') {
          if (typeof rawArgs !== 'string') {
            throw new ActionFailureError(
              actionFailure(
                'validation_failed',
                'toolArgs 必须是 **JSON 对象字符串**（例如 {"expression":"document.title"}）'
              )
            )
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(rawArgs)
          } catch {
            throw new ActionFailureError(
              actionFailure('validation_failed', `toolArgs 不是合法 JSON：${rawArgs.slice(0, 120)}`)
            )
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new ActionFailureError(
              actionFailure('validation_failed', 'toolArgs 解析出来**不是对象**（要的是键值对）')
            )
          }
          toolArgs = parsed as Record<string, unknown>
        }
        const result = await callTool(tool, toolArgs)
        if (result.isError) {
          throw new ActionFailureError(
            actionFailure(
              'execution_failed',
              `上游工具 ${tool} 报错：${result.text.slice(0, 300)}（原样转达，不重试、不换参数）`
            )
          )
        }
        const summary =
          result.text === '' ? `（${tool} 完成，sidecar 没有返回文本）` : result.text
        const shaped = summary.slice(0, BROWSER_LIMITS.maxSnapshotChars)
        const facts = [
          `⚠️ 全工具档（ADR-125）：直接调用上游工具 ${tool}，toolArgs 原样转交`,
          '返回内容**可能含凭据**（cookie / 本地存储 / 网络正文 / 控制台输出）——按本次授权如实进当轮内容',
          '程序检查了 sidecar 的返回（不把"调用成功"当成结果内容）',
        ]
        const content: LocalTextTurnContent = {
          contentId: `${String(input.actionId)}:browser-mcp`,
          kind: 'local-text',
          capability: BROWSER_MCP,
          operation: BROWSER_MCP_OPERATION,
          sourceKind: 'remote-article',
          resourceRef: options.sidecarUrl,
          resultFingerprint: sha256(summary),
          scope: {
            totalChars: summary.length,
            includedChars: shaped.length,
            truncated: shaped.length < summary.length,
          },
          facts,
          text: shaped,
          mediaType: 'text/x-browser-tool-result',
          lineCount: shaped.split('\n').length,
          sourceBytes: Buffer.byteLength(summary, 'utf8'),
        }
        const turnContent: TurnContent[] = [content]
        return {
          effect: {
            /*
             * ⚠️ `ActionEffect.kind` 的词汇表里没有"我调了一个什么都可能做的工具"这一档
             *    （与 `browser.operate` 的 `no_change` 同源）。这里**不假装**它是 read：
             *    选择 `no_change` 只表示"LG 自己不声称世界变成了什么"，
             *    真实影响面由**上游工具的返回值**承载（那正是它进当轮内容的理由）。
             */
            kind: 'no_change',
            detail: `browser.mcp ${tool}（全工具档）`,
            fingerprint: sha256(summary),
          },
          evidence: [
            {
              kind: 'adapter',
              detail: `browser.mcp ${tool} via ${options.sidecarUrl} · 字符 ${String(summary.length)}`,
              ref: options.sidecarUrl,
            },
          ],
          turnContent,
        }
      },
    }
  }

  /*
   * ⚠️ 三个能力三个适配器对象，但**共用同一个闭包状态**（同一个 session / requestId）
   *    ⇒ 只有一条连接。多条连接会让"哪个标签被绑定了"出现两个答案。
   */
  return { snapshot: snapshotAdapter(), operate: operateAdapter(), call: callAdapter() }
}

/**
 * 装配层用：一次构造，拿到三个适配器。
 *
 * ⚠️ 白名单闸在 `callTool()` 里，三个适配器都过它 —— 不存在"读那条路松一点"。
 */
export function createBrowserAdapters(options: BrowserAdapterOptions): CapabilityAdapter[] {
  const runtime = createBrowserAdapter(options)
  return [runtime.snapshot, runtime.operate, runtime.call]
}

export { TURN_CONTENT_LIMITS }
